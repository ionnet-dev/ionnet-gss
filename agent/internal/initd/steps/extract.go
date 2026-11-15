package steps

import (
	"archive/tar"
	"archive/zip"
	"compress/bzip2"
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

type extractStep struct{}

func (extractStep) Name() string { return "extract" }

func (extractStep) Matches(step protocol.InstallStep) bool { return step.Extract != nil }

func (extractStep) Describe(step protocol.InstallStep) string {
	to := step.Extract.To
	if to == "" {
		to = "/data"
	}
	return fmt.Sprintf("%s into %s", step.Extract.File, to)
}

// archiveKind is the archive format, picked by file name.
type archiveKind int

const (
	archiveZip archiveKind = iota
	archiveTar
	archiveTarGz
	archiveTarXz
	archiveTarBz2
)

func kindOf(name string) (archiveKind, error) {
	lower := strings.ToLower(name)
	switch {
	case strings.HasSuffix(lower, ".zip"):
		return archiveZip, nil
	case strings.HasSuffix(lower, ".tar"):
		return archiveTar, nil
	case strings.HasSuffix(lower, ".tar.gz"), strings.HasSuffix(lower, ".tgz"):
		return archiveTarGz, nil
	case strings.HasSuffix(lower, ".tar.xz"), strings.HasSuffix(lower, ".txz"):
		return archiveTarXz, nil
	case strings.HasSuffix(lower, ".tar.bz2"), strings.HasSuffix(lower, ".tbz2"):
		return archiveTarBz2, nil
	}
	return 0, fmt.Errorf("cannot tell the archive type of %s; use .zip, .tar, .tar.gz, .tar.xz or .tar.bz2", name)
}

func (extractStep) Run(ctx context.Context, step protocol.InstallStep, env Env) error {
	x := step.Extract
	archive, err := datafs.Rel(x.File)
	if err != nil {
		return err
	}
	to := "."
	if x.To != "" {
		if to, err = datafs.Rel(x.To); err != nil {
			return err
		}
	}
	if x.Strip < 0 {
		return fmt.Errorf("strip must not be negative")
	}
	kind, err := kindOf(archive)
	if err != nil {
		return err
	}
	if err := datafs.MkdirAll(env.Data, to, env.UID); err != nil {
		return err
	}
	f, err := env.Data.Open(archive)
	if err != nil {
		return fmt.Errorf("open archive: %w", err)
	}
	defer f.Close()

	w := &extractor{root: env.Data, to: to, strip: int(x.Strip), uid: env.UID}
	switch kind {
	case archiveZip:
		err = w.zip(ctx, f)
	case archiveTar:
		err = w.tar(ctx, f)
	case archiveTarGz:
		var gz *gzip.Reader
		if gz, err = gzip.NewReader(f); err == nil {
			err = w.tar(ctx, gz)
		}
	case archiveTarBz2:
		err = w.tar(ctx, bzip2.NewReader(f))
	case archiveTarXz:
		err = w.tarXz(ctx, f, env)
	}
	if err != nil {
		return fmt.Errorf("extract %s: %w", archive, err)
	}
	fmt.Fprintf(env.Output, "Extracted %d files from %s.\n", w.files, archive)
	if x.Remove {
		if err := env.Data.Remove(archive); err != nil {
			return fmt.Errorf("remove archive: %w", err)
		}
	}
	return nil
}

// extractor writes archive entries below root/to. os.Root refuses entries (or symlinks) that lead outside the data
// folder; setuid/setgid/sticky bits are dropped and everything is owned by uid.
type extractor struct {
	root  *os.Root
	to    string
	strip int
	uid   int
	files int
}

// target maps an entry name to its path below the data folder, or "" to skip it (stripped away).
func (e *extractor) target(name string) (string, error) {
	name = strings.TrimPrefix(path.Clean("/"+strings.ReplaceAll(name, "\\", "/")), "/")
	if name == "" {
		return "", nil
	}
	parts := strings.Split(name, "/")
	if len(parts) <= e.strip {
		return "", nil
	}
	return path.Join(e.to, path.Join(parts[e.strip:]...)), nil
}

func (e *extractor) tar(ctx context.Context, r io.Reader) error {
	tr := tar.NewReader(r)
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		name, err := e.target(h.Name)
		if err != nil || name == "" {
			continue
		}
		mode := fs.FileMode(h.Mode).Perm()
		switch h.Typeflag {
		case tar.TypeDir:
			err = e.dir(name, mode)
		case tar.TypeReg:
			err = e.file(name, mode, h.ModTime, tr)
		case tar.TypeSymlink:
			err = e.symlink(name, h.Linkname)
		case tar.TypeLink:
			var old string
			if old, err = e.target(h.Linkname); err == nil && old != "" {
				err = e.hardlink(old, name)
			}
		default: // devices, fifos, pax/gnu metadata: nothing to write
		}
		if err != nil {
			return fmt.Errorf("%s: %w", h.Name, err)
		}
	}
}

// tarXz decompresses through `xz -dc` (Go has no xz in the standard library), run as the game user.
func (e *extractor) tarXz(ctx context.Context, archive *os.File, env Env) error {
	xzCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	pr, pw := io.Pipe()
	result := make(chan error, 1)
	go func() {
		var stderr strings.Builder
		code, err := RunProgram(xzCtx, env, []string{"xz", "-dc"}, archive, pw, &stderr)
		if err == nil && code != 0 {
			err = fmt.Errorf("xz exited with code %d: %s", code, strings.TrimSpace(stderr.String()))
		}
		pw.CloseWithError(err)
		result <- err
	}()
	err := e.tar(ctx, pr)
	if err == nil {
		_, _ = io.Copy(io.Discard, pr) // trailing padding after the end-of-archive blocks
	} else {
		cancel() // xz may be blocked writing the rest; it ends with the failed extraction
	}
	pr.CloseWithError(errors.New("extraction ended"))
	if xzErr := <-result; xzErr != nil && err == nil {
		err = xzErr
	}
	return err
}

func (e *extractor) zip(ctx context.Context, f *os.File) error {
	info, err := f.Stat()
	if err != nil {
		return err
	}
	zr, err := zip.NewReader(f, info.Size())
	if err != nil {
		return err
	}
	for _, zf := range zr.File {
		if err := ctx.Err(); err != nil {
			return err
		}
		name, err := e.target(zf.Name)
		if err != nil || name == "" {
			continue
		}
		mode := zf.Mode()
		switch {
		case mode.IsDir() || strings.HasSuffix(zf.Name, "/"):
			err = e.dir(name, 0o755)
		case mode&fs.ModeSymlink != 0:
			err = e.zipSymlink(zf, name)
		case mode.IsRegular():
			perm := mode.Perm()
			if perm == 0 {
				perm = 0o644
			}
			var rc io.ReadCloser
			if rc, err = zf.Open(); err == nil {
				err = e.file(name, perm, zf.Modified, rc)
				rc.Close()
			}
		}
		if err != nil {
			return fmt.Errorf("%s: %w", zf.Name, err)
		}
	}
	return nil
}

func (e *extractor) zipSymlink(zf *zip.File, name string) error {
	rc, err := zf.Open()
	if err != nil {
		return err
	}
	defer rc.Close()
	target, err := io.ReadAll(io.LimitReader(rc, 4096))
	if err != nil {
		return err
	}
	return e.symlink(name, string(target))
}

func (e *extractor) dir(name string, mode fs.FileMode) error {
	if err := datafs.MkdirAll(e.root, name, e.uid); err != nil {
		return err
	}
	if mode == 0 {
		mode = 0o755
	}
	return e.root.Chmod(name, mode|0o700)
}

// clear removes what is at name (a file or symlink from an earlier install) so writes never follow an old link.
func (e *extractor) clear(name string) error {
	info, err := e.root.Lstat(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if info.IsDir() {
		return fmt.Errorf("a folder is in the way")
	}
	return e.root.Remove(name)
}

func (e *extractor) file(name string, mode fs.FileMode, mtime time.Time, r io.Reader) error {
	if err := datafs.MkdirAll(e.root, path.Dir(name), e.uid); err != nil {
		return err
	}
	if err := e.clear(name); err != nil {
		return err
	}
	f, err := e.root.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(f, r)
	closeErr := f.Close()
	if err := errors.Join(copyErr, closeErr); err != nil {
		return err
	}
	if err := e.root.Chmod(name, mode); err != nil {
		return err
	}
	if err := datafs.Chown(e.root, name, e.uid); err != nil {
		return err
	}
	if !mtime.IsZero() {
		_ = e.root.Chtimes(name, mtime, mtime)
	}
	e.files++
	return nil
}

func (e *extractor) symlink(name, target string) error {
	if err := datafs.MkdirAll(e.root, path.Dir(name), e.uid); err != nil {
		return err
	}
	if err := e.clear(name); err != nil {
		return err
	}
	if err := e.root.Symlink(target, name); err != nil {
		return err
	}
	return datafs.Chown(e.root, name, e.uid)
}

func (e *extractor) hardlink(old, name string) error {
	if err := datafs.MkdirAll(e.root, path.Dir(name), e.uid); err != nil {
		return err
	}
	if err := e.clear(name); err != nil {
		return err
	}
	return e.root.Link(old, name)
}
