// Package backups writes and reads backup archives (M4): tar streams compressed with zstd
// (github.com/klauspost/compress/zstd, pure Go), entries `gss-backup.json` (protocol.BackupManifest) first, then
// each root (`data/…`, `services/<name>/…`). Pure: files and io only; servers/backup.go decides when and what.
//
// Create walks each root beneath an os.Root without following symlinks (they are stored as links), skips `Exclude`
// matches (data root only), stores regular files, folders and symlinks with permission bits, mtime and numeric
// uid/gid, and skips sockets, devices and fifos. An entry the game swaps between the listing and the open (a folder
// replaced by a symlink, a file by another) is skipped, so the walk never leaves the folder or follows a link.
// Extract writes beneath an os.Root per root, refuses absolute names, `..`, names outside the manifest's roots, hard
// links and device entries, never follows a symlink it created (a later entry through it is refused), drops
// setuid/setgid/sticky bits, and restores uid/gid only when the agent runs as root.
package backups

import (
	"archive/tar"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"regexp"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Root is one top-level folder of an archive.
type Root struct {
	Name string // "data" or "services/<name>"
	Dir  string // host folder
	// Before and After run around this root's walk (servers/backup.go pauses a running service container here).
	// After runs whenever Before ran, also when Before or the walk failed.
	Before func(ctx context.Context) error
	After  func(ctx context.Context)
}

// CreateOptions for Create.
type CreateOptions struct {
	Manifest protocol.BackupManifest
	Roots    []Root
	// Exclude are BackupSpec.exclude patterns, applied to the "data" root (see Matcher).
	Exclude []string
	// Progress gets the uncompressed bytes archived so far (called often; throttle on the caller's side).
	Progress func(bytes int64)
	// AfterRoot runs when a root is done (servers/backup.go sends the `after` commands once data/ is archived).
	AfterRoot func(name string)
}

// Result of Create.
type Result struct {
	Bytes int64 // uncompressed bytes of regular files
	Files int64
	// Changed counts files that changed while they were read (shrank, or were replaced): a shrunk file is padded
	// with zeros to the size it had when it was opened, a replaced one is left out.
	Changed int64
}

// DataRoot is the archive root of the server's data folder.
const DataRoot = "data"

// ServicesPrefix starts the archive root of a stack service's volume: `services/<name>`.
const ServicesPrefix = "services/"

// manifestMaxBytes bounds the manifest entry an Extract reads into memory.
const manifestMaxBytes = 1 << 20

// copyBuffer is the read size while archiving or extracting a file.
const copyBuffer = 256 << 10

var serviceName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,30}$`)

// ValidRootName reports whether name is "data" or "services/<service name>".
func ValidRootName(name string) bool {
	if name == DataRoot {
		return true
	}
	service, ok := strings.CutPrefix(name, ServicesPrefix)
	return ok && serviceName.MatchString(service)
}

// UnsafeEntryError is an archive entry Extract refuses to write.
type UnsafeEntryError struct {
	Name   string
	Reason string
}

func (e *UnsafeEntryError) Error() string {
	return fmt.Sprintf("The backup can't be restored: its entry %q %s.", e.Name, e.Reason)
}

//#region Create

// Create writes the archive to out (the caller writes `<id>.tar.zst.partial`, fsyncs and renames).
func Create(ctx context.Context, out io.Writer, opts CreateOptions) (Result, error) {
	matcher, err := NewMatcher(opts.Exclude)
	if err != nil {
		return Result{}, err
	}
	seen := map[string]bool{}
	names := make([]string, 0, len(opts.Roots))
	for _, root := range opts.Roots {
		if !ValidRootName(root.Name) || seen[root.Name] {
			return Result{}, fmt.Errorf("invalid or duplicate archive root %q", root.Name)
		}
		seen[root.Name] = true
		names = append(names, root.Name)
	}
	enc, err := zstd.NewWriter(out, zstd.WithEncoderLevel(zstd.SpeedDefault), zstd.WithEncoderConcurrency(2))
	if err != nil {
		return Result{}, fmt.Errorf("start the zstd encoder: %w", err)
	}
	w := &archiver{ctx: ctx, tw: tar.NewWriter(enc), progress: opts.Progress, buf: make([]byte, copyBuffer)}
	result, err := w.run(opts, names, matcher)
	if err != nil {
		enc.Close() // Releases the encoder; the caller discards the partial output.
		return Result{}, err
	}
	if err := w.tw.Close(); err != nil {
		enc.Close()
		return Result{}, fmt.Errorf("finish the archive: %w", err)
	}
	if err := enc.Close(); err != nil {
		return Result{}, fmt.Errorf("finish the archive: %w", err)
	}
	return result, nil
}

type archiver struct {
	ctx      context.Context
	tw       *tar.Writer
	progress func(bytes int64)
	buf      []byte
	result   Result
}

func (w *archiver) run(opts CreateOptions, names []string, matcher *Matcher) (Result, error) {
	manifest := opts.Manifest
	manifest.Roots = names
	raw, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return Result{}, fmt.Errorf("encode the backup manifest: %w", err)
	}
	if err := w.tw.WriteHeader(&tar.Header{Name: protocol.BackupManifestName, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(raw)), ModTime: manifest.CreatedAt, Format: tar.FormatPAX}); err != nil {
		return Result{}, fmt.Errorf("write the backup manifest: %w", err)
	}
	if _, err := w.tw.Write(raw); err != nil {
		return Result{}, fmt.Errorf("write the backup manifest: %w", err)
	}
	for _, root := range opts.Roots {
		var excl *Matcher
		if root.Name == DataRoot {
			excl = matcher
		}
		err := w.root(root, excl)
		if err != nil {
			return Result{}, err
		}
		if opts.AfterRoot != nil {
			opts.AfterRoot(root.Name)
		}
	}
	return w.result, nil
}

// root archives one root, with its Before/After hooks around the walk.
func (w *archiver) root(root Root, excl *Matcher) (err error) {
	if root.Before != nil {
		if root.After != nil {
			defer root.After(context.WithoutCancel(w.ctx))
		}
		if err := root.Before(w.ctx); err != nil {
			return err
		}
	}
	r, err := os.OpenRoot(root.Dir)
	if err != nil {
		return fmt.Errorf("open %s for the backup: %w", root.Name, err)
	}
	defer r.Close()
	info, err := r.Lstat(".")
	if err != nil {
		return fmt.Errorf("read %s: %w", root.Name, err)
	}
	if err := w.header(root.Name+"/", tar.TypeDir, info, "", 0); err != nil {
		return err
	}
	return w.dir(r, root.Name, "", info, excl)
}

// dir archives the entries of the folder rel (already Lstat'ed as info), sorted by name.
func (w *archiver) dir(r *os.Root, rootName, rel string, info fs.FileInfo, excl *Matcher) error {
	f, err := r.Open(orDot(rel))
	if errors.Is(err, fs.ErrNotExist) {
		return nil // Removed by the game meanwhile.
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", path.Join(rootName, rel), err)
	}
	same, err := sameAsListed(f, info)
	if err != nil || !same {
		f.Close()
		if err == nil {
			w.result.Changed++
		}
		return err
	}
	names, err := f.Readdirnames(-1)
	f.Close()
	if err != nil {
		return fmt.Errorf("list %s: %w", path.Join(rootName, rel), err)
	}
	sort.Strings(names)
	for _, name := range names {
		if err := w.ctx.Err(); err != nil {
			return err
		}
		child := path.Join(rel, name)
		childInfo, err := r.Lstat(child)
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("read %s: %w", path.Join(rootName, child), err)
		}
		mode := childInfo.Mode()
		switch {
		case mode.IsDir():
			if excl.Excluded(child, true) {
				continue
			}
			if err := w.header(path.Join(rootName, child)+"/", tar.TypeDir, childInfo, "", 0); err != nil {
				return err
			}
			if err := w.dir(r, rootName, child, childInfo, excl); err != nil {
				return err
			}
		case mode&fs.ModeSymlink != 0:
			if excl.Excluded(child, false) {
				continue
			}
			target, err := r.Readlink(child)
			if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.EINVAL) {
				continue // Gone or no longer a link.
			}
			if err != nil {
				return fmt.Errorf("read the link %s: %w", path.Join(rootName, child), err)
			}
			if err := w.header(path.Join(rootName, child), tar.TypeSymlink, childInfo, target, 0); err != nil {
				return err
			}
		case mode.IsRegular():
			if excl.Excluded(child, false) {
				continue
			}
			if err := w.file(r, rootName, child, childInfo); err != nil {
				return err
			}
		default:
			// Sockets, devices and fifos are not data.
		}
	}
	return nil
}

// file archives one regular file. Its size is taken when it is opened; a file that shrinks while it is read is
// padded with zeros, so the tar stream stays valid.
func (w *archiver) file(r *os.Root, rootName, rel string, info fs.FileInfo) error {
	f, err := r.OpenFile(rel, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if errors.Is(err, fs.ErrNotExist) || errors.Is(err, syscall.ELOOP) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("open %s: %w", path.Join(rootName, rel), err)
	}
	defer f.Close()
	opened, err := f.Stat()
	if err != nil {
		return fmt.Errorf("read %s: %w", path.Join(rootName, rel), err)
	}
	if !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		w.result.Changed++
		return nil
	}
	size := opened.Size()
	if err := w.header(path.Join(rootName, rel), tar.TypeReg, opened, "", size); err != nil {
		return err
	}
	var written int64
	for written < size {
		if err := w.ctx.Err(); err != nil {
			return err
		}
		chunk := w.buf[:min(int64(len(w.buf)), size-written)]
		n, readErr := f.Read(chunk)
		if n > 0 {
			if _, err := w.tw.Write(chunk[:n]); err != nil {
				return fmt.Errorf("write the archive: %w", err)
			}
			written += int64(n)
			w.add(int64(n))
		}
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return fmt.Errorf("read %s: %w", path.Join(rootName, rel), readErr)
		}
	}
	if written < size {
		w.result.Changed++
		clear(w.buf)
		for written < size {
			n := min(int64(len(w.buf)), size-written)
			if _, err := w.tw.Write(w.buf[:n]); err != nil {
				return fmt.Errorf("write the archive: %w", err)
			}
			written += n
		}
	}
	w.result.Files++
	return nil
}

func (w *archiver) add(n int64) {
	w.result.Bytes += n
	if w.progress != nil {
		w.progress(w.result.Bytes)
	}
}

// header writes one tar header with permission bits (no setuid/setgid/sticky), mtime and numeric owner.
func (w *archiver) header(name string, typ byte, info fs.FileInfo, link string, size int64) error {
	h := &tar.Header{
		Name:     name,
		Typeflag: typ,
		Linkname: link,
		Size:     size,
		Mode:     int64(info.Mode().Perm()),
		ModTime:  info.ModTime(),
		Format:   tar.FormatPAX,
	}
	if st, ok := info.Sys().(*syscall.Stat_t); ok {
		h.Uid = int(st.Uid)
		h.Gid = int(st.Gid)
	}
	if err := w.tw.WriteHeader(h); err != nil {
		return fmt.Errorf("write the archive entry %s: %w", name, err)
	}
	return nil
}

// sameAsListed reports whether the opened f is still the entry Lstat reported (not swapped for a link or another
// folder since).
func sameAsListed(f *os.File, listed fs.FileInfo) (bool, error) {
	opened, err := f.Stat()
	if err != nil {
		return false, fmt.Errorf("read %s: %w", f.Name(), err)
	}
	return opened.IsDir() == listed.IsDir() && os.SameFile(opened, listed), nil
}

func orDot(rel string) string {
	if rel == "" {
		return "."
	}
	return rel
}

//#endregion

//#region Extract

// ExtractOptions for Extract.
type ExtractOptions struct {
	// Dest maps each archive root name to the folder it is extracted into (the restore's temporary folders); roots
	// not listed are skipped. Each folder is created (0700) when the archive holds that root; it should not exist
	// yet.
	Dest     map[string]string
	Progress func(bytes int64)
}

// ReadManifest reads only the manifest of an archive (the first entry).
func ReadManifest(in io.Reader) (protocol.BackupManifest, error) {
	dec, err := newDecoder(in)
	if err != nil {
		return protocol.BackupManifest{}, err
	}
	defer dec.Close()
	return readManifest(tar.NewReader(dec))
}

// Extract reads an archive and returns its manifest (refused when its format is above BACKUP_FORMAT_VERSION).
func Extract(ctx context.Context, in io.Reader, opts ExtractOptions) (protocol.BackupManifest, error) {
	dec, err := newDecoder(in)
	if err != nil {
		return protocol.BackupManifest{}, err
	}
	defer dec.Close()
	tr := tar.NewReader(dec)
	manifest, err := readManifest(tr)
	if err != nil {
		return protocol.BackupManifest{}, err
	}
	x := &extractor{
		ctx:      ctx,
		known:    map[string]bool{},
		roots:    map[string]*os.Root{},
		links:    map[string]map[string]bool{},
		progress: opts.Progress,
		buf:      make([]byte, copyBuffer),
		asRoot:   os.Geteuid() == 0,
	}
	defer x.close()
	for _, name := range manifest.Roots {
		x.known[name] = true
		dir, ok := opts.Dest[name]
		if !ok {
			continue
		}
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return protocol.BackupManifest{}, fmt.Errorf("create the restore folder %s: %w", dir, err)
		}
		r, err := os.OpenRoot(dir)
		if err != nil {
			return protocol.BackupManifest{}, fmt.Errorf("open the restore folder %s: %w", dir, err)
		}
		x.roots[name] = r
		x.links[name] = map[string]bool{}
	}
	for {
		if err := ctx.Err(); err != nil {
			return protocol.BackupManifest{}, err
		}
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return protocol.BackupManifest{}, fmt.Errorf("read the archive: %w", err)
		}
		if err := x.entry(hdr, tr); err != nil {
			return protocol.BackupManifest{}, err
		}
	}
	if err := x.finish(); err != nil {
		return protocol.BackupManifest{}, err
	}
	return manifest, nil
}

func newDecoder(in io.Reader) (*zstd.Decoder, error) {
	dec, err := zstd.NewReader(in, zstd.WithDecoderConcurrency(2), zstd.WithDecoderMaxWindow(128<<20))
	if err != nil {
		return nil, fmt.Errorf("start the zstd decoder: %w", err)
	}
	return dec, nil
}

// readManifest reads and checks the first entry.
func readManifest(tr *tar.Reader) (protocol.BackupManifest, error) {
	var manifest protocol.BackupManifest
	hdr, err := tr.Next()
	if err != nil {
		return manifest, fmt.Errorf("The file is not a readable backup archive: %w", err)
	}
	if hdr.Name != protocol.BackupManifestName || (hdr.Typeflag != tar.TypeReg && hdr.Typeflag != tar.TypeRegA) || hdr.Size > manifestMaxBytes {
		return manifest, fmt.Errorf("The file is not a backup archive of this panel (its first entry is %q, not %s).", hdr.Name, protocol.BackupManifestName)
	}
	raw, err := io.ReadAll(io.LimitReader(tr, manifestMaxBytes))
	if err != nil {
		return manifest, fmt.Errorf("read the backup manifest: %w", err)
	}
	if err := json.Unmarshal(raw, &manifest); err != nil {
		return manifest, fmt.Errorf("The backup manifest is unreadable: %w", err)
	}
	if manifest.Format < 1 || manifest.Format > protocol.BackupFormatVersion {
		return manifest, fmt.Errorf("The backup has format %d; this agent reads up to format %d. Update gss-agent on the host.", manifest.Format, protocol.BackupFormatVersion)
	}
	seen := map[string]bool{}
	for _, name := range manifest.Roots {
		if !ValidRootName(name) || seen[name] {
			return manifest, fmt.Errorf("The backup manifest names an invalid or duplicate folder %q.", name)
		}
		seen[name] = true
	}
	return manifest, nil
}

type extractor struct {
	ctx      context.Context
	known    map[string]bool            // every root in the manifest
	roots    map[string]*os.Root        // the ones being extracted
	links    map[string]map[string]bool // symlinks created, per root
	dirs     []pendingDir               // folder modes and times, applied last
	progress func(bytes int64)
	buf      []byte
	bytes    int64
	asRoot   bool
}

type pendingDir struct {
	root  *os.Root
	rel   string
	mode  fs.FileMode
	mtime time.Time
}

func (x *extractor) close() {
	for _, r := range x.roots {
		r.Close()
	}
}

// split finds the root an entry name belongs to.
func (x *extractor) split(name string) (root, rel string, ok bool) {
	if x.known[name] {
		return name, "", true
	}
	for known := range x.known {
		if rest, found := strings.CutPrefix(name, known+"/"); found {
			return known, rest, true
		}
	}
	return "", "", false
}

func (x *extractor) entry(hdr *tar.Header, tr io.Reader) error {
	if hdr.Typeflag == tar.TypeXGlobalHeader {
		return nil
	}
	name := strings.TrimSuffix(hdr.Name, "/")
	unsafe := func(reason string) error { return &UnsafeEntryError{Name: hdr.Name, Reason: reason} }
	if name == "" || strings.ContainsRune(name, 0) {
		return unsafe("has an empty or invalid name")
	}
	if path.IsAbs(name) {
		return unsafe("is an absolute path")
	}
	for _, part := range strings.Split(name, "/") {
		if part == ".." {
			return unsafe("leaves its folder (`..`)")
		}
		if part == "." || part == "" {
			return unsafe("is not a clean path")
		}
	}
	rootName, rel, ok := x.split(name)
	if !ok {
		return unsafe("is outside the folders its manifest lists")
	}
	r := x.roots[rootName]
	if r == nil {
		return nil // A root the caller doesn't restore; tar skips its content.
	}
	links := x.links[rootName]
	if rel != "" {
		parts := strings.Split(rel, "/")
		for i := 1; i <= len(parts); i++ {
			if links[strings.Join(parts[:i], "/")] {
				return unsafe("goes through or replaces a symlink stored earlier in the archive")
			}
		}
	}
	mode := fs.FileMode(hdr.Mode).Perm() // setuid, setgid and sticky are dropped.
	switch hdr.Typeflag {
	case tar.TypeDir:
		if rel != "" {
			if err := x.parent(r, rel); err != nil {
				return err
			}
			if err := r.Mkdir(rel, 0o700); err != nil {
				if !errors.Is(err, fs.ErrExist) {
					return fmt.Errorf("create %s: %w", name, err)
				}
				info, statErr := r.Lstat(rel)
				if statErr != nil || !info.IsDir() {
					return unsafe("is a folder where the archive already stored something else")
				}
			}
		}
		if err := x.chown(r, rel, hdr); err != nil {
			return err
		}
		x.dirs = append(x.dirs, pendingDir{root: r, rel: rel, mode: mode, mtime: hdr.ModTime})
		return nil
	case tar.TypeReg, tar.TypeRegA:
		if rel == "" {
			return unsafe("is a file in place of its folder")
		}
		if err := x.parent(r, rel); err != nil {
			return err
		}
		return x.file(r, name, rel, hdr, mode, tr)
	case tar.TypeSymlink:
		if rel == "" {
			return unsafe("is a symlink in place of its folder")
		}
		if hdr.Linkname == "" || strings.ContainsRune(hdr.Linkname, 0) {
			return unsafe("is a symlink without a valid target")
		}
		if err := x.parent(r, rel); err != nil {
			return err
		}
		if err := r.Symlink(hdr.Linkname, rel); err != nil {
			if errors.Is(err, fs.ErrExist) {
				return unsafe("appears twice")
			}
			return fmt.Errorf("create the link %s: %w", name, err)
		}
		links[rel] = true
		return x.chown(r, rel, hdr)
	case tar.TypeLink:
		return unsafe("is a hard link (backups never contain them)")
	case tar.TypeChar, tar.TypeBlock:
		return unsafe("is a device")
	case tar.TypeFifo:
		return unsafe("is a fifo")
	default:
		return unsafe(fmt.Sprintf("has an unsupported type %q", hdr.Typeflag))
	}
}

// parent makes sure the folder holding rel exists (archives list folders first; this covers ones that don't).
func (x *extractor) parent(r *os.Root, rel string) error {
	dir := path.Dir(rel)
	if dir == "." {
		return nil
	}
	if err := r.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create the folder %s: %w", dir, err)
	}
	return nil
}

func (x *extractor) file(r *os.Root, name, rel string, hdr *tar.Header, mode fs.FileMode, tr io.Reader) error {
	f, err := r.OpenFile(rel, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if errors.Is(err, fs.ErrExist) {
		return &UnsafeEntryError{Name: hdr.Name, Reason: "appears twice"}
	}
	if err != nil {
		return fmt.Errorf("create %s: %w", name, err)
	}
	var written int64
	for written < hdr.Size {
		if err := x.ctx.Err(); err != nil {
			f.Close()
			return err
		}
		chunk := x.buf[:min(int64(len(x.buf)), hdr.Size-written)]
		n, readErr := io.ReadFull(tr, chunk)
		if n > 0 {
			if _, err := f.Write(chunk[:n]); err != nil {
				f.Close()
				return fmt.Errorf("write %s: %w", name, err)
			}
			written += int64(n)
			x.bytes += int64(n)
			if x.progress != nil {
				x.progress(x.bytes)
			}
		}
		if readErr != nil {
			f.Close()
			return fmt.Errorf("read %s from the archive: %w", name, readErr)
		}
	}
	if err := f.Close(); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	if err := x.chown(r, rel, hdr); err != nil {
		return err
	}
	if err := r.Chmod(rel, mode); err != nil {
		return fmt.Errorf("set the mode of %s: %w", name, err)
	}
	if err := r.Chtimes(rel, hdr.ModTime, hdr.ModTime); err != nil {
		return fmt.Errorf("set the time of %s: %w", name, err)
	}
	return nil
}

// chown keeps the archived owner when the agent runs as root (a non-root agent can't give files away; they stay
// the agent's).
func (x *extractor) chown(r *os.Root, rel string, hdr *tar.Header) error {
	if !x.asRoot {
		return nil
	}
	if hdr.Uid < 0 || hdr.Gid < 0 {
		return &UnsafeEntryError{Name: hdr.Name, Reason: "has a negative owner"}
	}
	if err := r.Lchown(orDot(rel), hdr.Uid, hdr.Gid); err != nil {
		return fmt.Errorf("set the owner of %s: %w", hdr.Name, err)
	}
	return nil
}

// finish applies folder modes and times, deepest first (a read-only folder is written into before it gets its
// mode).
func (x *extractor) finish() error {
	sort.SliceStable(x.dirs, func(i, j int) bool {
		return strings.Count(x.dirs[i].rel, "/")+boolInt(x.dirs[i].rel != "") > strings.Count(x.dirs[j].rel, "/")+boolInt(x.dirs[j].rel != "")
	})
	for _, d := range x.dirs {
		if err := d.root.Chmod(orDot(d.rel), d.mode); err != nil {
			return fmt.Errorf("set the mode of %s: %w", d.rel, err)
		}
		if err := d.root.Chtimes(orDot(d.rel), d.mtime, d.mtime); err != nil {
			return fmt.Errorf("set the time of %s: %w", d.rel, err)
		}
	}
	return nil
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

//#endregion

//#region Excludes

// Matcher reports whether a data-relative path ("logs/latest.log", "world") is excluded. Patterns: relative,
// `/`-separated; a trailing slash matches a folder (and everything below it); `*` and `?` match within one segment
// (path.Match); patterns are anchored at the data folder (`*.log` matches only top-level files). A nil Matcher
// excludes nothing.
type Matcher struct {
	patterns []pattern
}

type pattern struct {
	segments []string
	dirOnly  bool
}

// NewMatcher validates the patterns (bad_request naming the first bad one).
func NewMatcher(patterns []string) (*Matcher, error) {
	m := &Matcher{}
	for _, raw := range patterns {
		bad := func(why string) error {
			return &protocol.RemoteError{Code: protocol.ErrorCodeBadRequest, Message: fmt.Sprintf("The backup exclude pattern %q is invalid: %s.", raw, why)}
		}
		p := pattern{}
		text := raw
		if strings.HasSuffix(text, "/") {
			p.dirOnly = true
			text = strings.TrimSuffix(text, "/")
		}
		if text == "" || strings.ContainsRune(text, 0) {
			return nil, bad("it is empty")
		}
		if strings.HasPrefix(text, "/") {
			return nil, bad("it must be relative to the data folder (no leading `/`)")
		}
		for _, segment := range strings.Split(text, "/") {
			if segment == "" || segment == "." || segment == ".." {
				return nil, bad("it contains an empty, `.` or `..` segment")
			}
			if _, err := path.Match(segment, ""); err != nil {
				return nil, bad("its wildcards are malformed")
			}
			p.segments = append(p.segments, segment)
		}
		m.patterns = append(m.patterns, p)
	}
	return m, nil
}

// Excluded reports whether rel (isDir for folders) is excluded.
func (m *Matcher) Excluded(rel string, isDir bool) bool {
	if m == nil || rel == "" {
		return false
	}
	parts := strings.Split(rel, "/")
	for _, p := range m.patterns {
		if len(p.segments) > len(parts) {
			continue
		}
		matched := true
		for i, segment := range p.segments {
			if ok, _ := path.Match(segment, parts[i]); !ok {
				matched = false
				break
			}
		}
		if !matched {
			continue
		}
		// A shorter pattern matched a folder above rel.
		if len(p.segments) < len(parts) || isDir || !p.dirOnly {
			return true
		}
	}
	return false
}

//#endregion
