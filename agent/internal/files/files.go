// Package files is the agent's file manager (M4): every operation on one server's data folder goes through an
// os.Root opened on it, so `..`, absolute paths and symlinks that lead out of the folder are refused by the kernel
// walk (openat beneath the root's fd, Go's os.Root), not by string checks alone; symlinks inside the folder are
// followed. Stdlib only; no knowledge of servers, Docker or the panel.
//
// Ownership: with the agent as root, everything it creates is handed to protocol.GameUID (Lchown), so the game can
// change it; as the game uid nothing needs handing over; any other uid may get permission errors (`forbidden`).
//
// Errors are *protocol.RemoteError with a sentence for the user: bad_request (a path that leaves the folder, a
// malformed path, a folder where a file is needed), not_found, conflict (exists, changed since loaded, a folder moved
// into itself), too_large (over FILE_TEXT_MAX_BYTES), no_space (ENOSPC, EDQUOT), forbidden (EACCES, EPERM).
package files

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// maxLinkHops bounds how many final-component symlinks WriteText follows (the kernel's own limit is 40).
const maxLinkHops = 40

// FS is one server's data folder.
type FS struct {
	root *os.Root
	dir  string
	// owner is the uid new files and folders are handed to (protocol.GameUID; -1 = leave as created).
	owner int
	// diskLimit is the server's soft limit in bytes and used the last measured usage (servers/disk.go); an upload
	// that would pass the limit answers no_space. 0 = no limit check.
	diskLimit int64
	used      func() int64
}

// Options for Open.
type Options struct {
	// Owner gets new files and folders when the agent runs as root. 0 = protocol.GameUID (root never needs a
	// hand-over), -1 = leave them as created.
	Owner int
	// DiskLimitBytes is the server's soft disk limit (0 = none); UsedBytes returns its current usage.
	DiskLimitBytes int64
	UsedBytes      func() int64
}

// Open opens dir (a server's data folder) as an os.Root.
func Open(dir string, opts Options) (*FS, error) {
	root, err := os.OpenRoot(dir)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return nil, remote(protocol.ErrorCodeNotFound, "The server's data folder doesn't exist yet. Wait until the server is provisioned.")
		}
		return nil, fmt.Errorf("open data folder %s: %w", dir, err)
	}
	owner := opts.Owner
	if owner == 0 {
		owner = protocol.GameUID
	}
	if os.Geteuid() != 0 {
		owner = -1
	}
	return &FS{root: root, dir: dir, owner: owner, diskLimit: opts.DiskLimitBytes, used: opts.UsedBytes}, nil
}

// Close releases the root's file descriptor.
func (f *FS) Close() error {
	if f == nil || f.root == nil {
		return nil
	}
	return f.root.Close()
}

// Clean turns a protocol path ("", "world/level.dat") into the name used with the root: "" → ".", no leading slash,
// no `.`/`..` segments, no NUL or backslash. bad_request otherwise.
func Clean(p string) (string, error) {
	if p == "" {
		return ".", nil
	}
	if strings.ContainsRune(p, 0) {
		return "", remote(protocol.ErrorCodeBadRequest, "The path contains a NUL byte.")
	}
	if strings.Contains(p, "\\") {
		return "", remote(protocol.ErrorCodeBadRequest, "The path %q contains a backslash; use / between folders.", p)
	}
	if strings.HasPrefix(p, "/") {
		return "", remote(protocol.ErrorCodeBadRequest, "The path %q is absolute; paths are relative to the server's folder.", p)
	}
	for _, segment := range strings.Split(p, "/") {
		switch segment {
		case "":
			return "", remote(protocol.ErrorCodeBadRequest, "The path %q has an empty folder name (a doubled or trailing /).", p)
		case ".", "..":
			return "", remote(protocol.ErrorCodeBadRequest, "The path %q contains %q; name every folder explicitly.", p, segment)
		}
	}
	return p, nil
}

// display is how a root name appears in messages.
func display(name string) string {
	if name == "." || name == "" {
		return "the server's folder"
	}
	return "\"" + name + "\""
}

// protoPath turns a root name back into a protocol path ("." → "").
func protoPath(name string) string {
	if name == "." {
		return ""
	}
	return name
}

// List lists one folder, folders first then by name, at most FILES_LIST_MAX_ENTRIES (truncated reports more).
func (f *FS) List(p string) (protocol.FilesListResponse, error) {
	name, err := Clean(p)
	if err != nil {
		return protocol.FilesListResponse{}, err
	}
	dir, err := f.root.Open(name)
	if err != nil {
		return protocol.FilesListResponse{}, mapError(name, err)
	}
	defer dir.Close()
	info, err := dir.Stat()
	if err != nil {
		return protocol.FilesListResponse{}, mapError(name, err)
	}
	if !info.IsDir() {
		return protocol.FilesListResponse{}, remote(protocol.ErrorCodeBadRequest, "%s is a file, not a folder.", display(name))
	}
	// Types come from the directory entries themselves (no stat), so the order is known before anything is stat'ed;
	// the details are then read with Lstat beneath the root (DirEntry.Info would stat by path name).
	dirents, err := dir.ReadDir(-1)
	if err != nil {
		return protocol.FilesListResponse{}, mapError(name, err)
	}
	sort.Slice(dirents, func(i, j int) bool {
		if a, b := dirents[i].IsDir(), dirents[j].IsDir(); a != b {
			return a
		}
		return dirents[i].Name() < dirents[j].Name()
	})
	res := protocol.FilesListResponse{Path: protoPath(name), Entries: make([]protocol.FileEntry, 0, min(len(dirents), protocol.FilesListMaxEntries))}
	for _, dirent := range dirents {
		if len(res.Entries) == protocol.FilesListMaxEntries {
			res.Truncated = true
			break
		}
		child := path.Join(name, dirent.Name())
		entry, err := f.lstatEntry(child)
		if err != nil {
			if errors.Is(err, fs.ErrNotExist) {
				continue // Removed since the folder was read.
			}
			return protocol.FilesListResponse{}, mapError(child, err)
		}
		res.Entries = append(res.Entries, entry)
	}
	return res, nil
}

// Stat reports one entry without following a final symlink.
func (f *FS) Stat(p string) (protocol.FileEntry, error) {
	name, err := Clean(p)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	entry, err := f.lstatEntry(name)
	if err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	return entry, nil
}

// ReadText reads a whole regular file of at most FILE_TEXT_MAX_BYTES; binary = not valid UTF-8 or holds a NUL.
func (f *FS) ReadText(p string) (entry protocol.FileEntry, content []byte, binary bool, err error) {
	name, err := Clean(p)
	if err != nil {
		return protocol.FileEntry{}, nil, false, err
	}
	file, info, err := f.openRegular(name)
	if err != nil {
		return protocol.FileEntry{}, nil, false, err
	}
	defer file.Close()
	if info.Size() > protocol.FileTextMaxBytes {
		return protocol.FileEntry{}, nil, false, tooLarge(name)
	}
	content, err = io.ReadAll(io.LimitReader(file, protocol.FileTextMaxBytes+1))
	if err != nil {
		return protocol.FileEntry{}, nil, false, mapError(name, err)
	}
	if len(content) > protocol.FileTextMaxBytes {
		return protocol.FileEntry{}, nil, false, tooLarge(name) // Grew while it was read.
	}
	entry = fileEntry(name, info, nil)
	entry.Size = int64(len(content))
	binary = !utf8.Valid(content) || bytes.IndexByte(content, 0) >= 0
	if binary {
		content = nil
	}
	return entry, content, binary, nil
}

// WriteText replaces or creates a regular file atomically (temporary file in the same folder, fsync, rename),
// keeping an existing file's mode. expected (non-nil) must equal the file's current modification time. A final
// symlink is followed (its target is replaced, the link stays).
func (f *FS) WriteText(p string, content []byte, expected *time.Time) (protocol.FileEntry, error) {
	name, err := Clean(p)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	if name == "." {
		return protocol.FileEntry{}, remote(protocol.ErrorCodeBadRequest, "Name the file to write.")
	}
	if len(content) > protocol.FileTextMaxBytes {
		return protocol.FileEntry{}, tooLarge(name)
	}
	target, err := f.resolveLinks(name)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	mode := fs.FileMode(0o644)
	uid, gid := f.owner, f.owner
	var oldSize int64
	info, err := f.root.Lstat(target)
	switch {
	case err == nil:
		if !info.Mode().IsRegular() {
			return protocol.FileEntry{}, remote(protocol.ErrorCodeBadRequest, "%s is not a regular file, so it can't be saved as text.", display(name))
		}
		if expected != nil && !info.ModTime().Equal(*expected) {
			return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "%s changed since it was opened. Reload it, or overwrite it with your version.", display(name))
		}
		mode = info.Mode().Perm()
		oldSize = info.Size()
		if st, ok := info.Sys().(*syscall.Stat_t); ok && f.owner >= 0 {
			uid, gid = int(st.Uid), int(st.Gid)
		}
	case errors.Is(err, fs.ErrNotExist):
		if expected != nil {
			return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "%s was deleted since it was opened. Save again to create it.", display(name))
		}
		if err := f.requireFolder(path.Dir(target)); err != nil {
			return protocol.FileEntry{}, err
		}
	default:
		return protocol.FileEntry{}, mapError(name, err)
	}
	if err := f.checkSpace(int64(len(content))-oldSize, false); err != nil {
		return protocol.FileEntry{}, err
	}

	tmp := path.Join(path.Dir(target), "."+path.Base(target)+".gss-save-"+randomSuffix())
	file, err := f.root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = f.root.Remove(tmp)
		}
	}()
	if _, err := file.Write(content); err != nil {
		file.Close()
		return protocol.FileEntry{}, mapError(name, err)
	}
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return protocol.FileEntry{}, mapError(name, err)
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return protocol.FileEntry{}, mapError(name, err)
	}
	if err := file.Close(); err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	if err := f.chown(tmp, uid, gid); err != nil {
		return protocol.FileEntry{}, err
	}
	if err := f.root.Rename(tmp, target); err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	committed = true
	f.syncDir(path.Dir(target))
	info, err = f.root.Lstat(target)
	if err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	return fileEntry(name, info, nil), nil
}

// Mkdir creates one folder (0755); the parent must exist.
func (f *FS) Mkdir(p string) (protocol.FileEntry, error) {
	name, err := Clean(p)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	if name == "." {
		return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "The server's folder already exists.")
	}
	if err := f.requireFolder(path.Dir(name)); err != nil {
		return protocol.FileEntry{}, err
	}
	if err := f.root.Mkdir(name, 0o755); err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	// Mkdir's mode passes through the umask; the folder should be 0755 whatever the agent's umask is.
	if err := f.root.Chmod(name, 0o755); err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	if err := f.chown(name, f.owner, f.owner); err != nil {
		return protocol.FileEntry{}, err
	}
	return f.Stat(name)
}

// Rename renames or moves within the folder. overwrite replaces a file (never a folder).
func (f *FS) Rename(from, to string, overwrite bool) (protocol.FileEntry, error) {
	src, err := Clean(from)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	dst, err := Clean(to)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	if src == "." || dst == "." {
		return protocol.FileEntry{}, remote(protocol.ErrorCodeBadRequest, "The server's folder itself can't be renamed or replaced.")
	}
	srcInfo, err := f.root.Lstat(src)
	if err != nil {
		return protocol.FileEntry{}, mapError(src, err)
	}
	if src == dst {
		return fileEntry(dst, srcInfo, f.readlink(dst, srcInfo)), nil
	}
	if srcInfo.IsDir() && strings.HasPrefix(dst+"/", src+"/") {
		return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "%s can't be moved into itself.", display(src))
	}
	if err := f.requireFolder(path.Dir(dst)); err != nil {
		return protocol.FileEntry{}, err
	}
	dstInfo, err := f.root.Lstat(dst)
	switch {
	case err == nil:
		if dstInfo.IsDir() {
			return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "%s already exists and is a folder; folders are never replaced.", display(dst))
		}
		if !overwrite {
			return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "%s already exists.", display(dst))
		}
		if srcInfo.IsDir() {
			return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "%s is a file; a folder can't replace it.", display(dst))
		}
	case !errors.Is(err, fs.ErrNotExist):
		return protocol.FileEntry{}, mapError(dst, err)
	}
	if err := f.root.Rename(src, dst); err != nil {
		if errors.Is(err, syscall.EINVAL) {
			// A move into itself through a symlinked folder: the kernel refuses what the string check above can't see.
			return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "%s can't be moved into itself.", display(src))
		}
		return protocol.FileEntry{}, mapError(dst, err)
	}
	return f.Stat(dst)
}

// Delete removes files and folders (recursively, symlinks as links). "" is refused. Every path is checked before
// anything is deleted.
func (f *FS) Delete(paths []string) error {
	if len(paths) == 0 {
		return remote(protocol.ErrorCodeBadRequest, "Name at least one file or folder to delete.")
	}
	if len(paths) > protocol.FilesDeleteMaxPaths {
		return remote(protocol.ErrorCodeBadRequest, "At most %d paths can be deleted at once.", protocol.FilesDeleteMaxPaths)
	}
	names := make([]string, 0, len(paths))
	for _, p := range paths {
		name, err := Clean(p)
		if err != nil {
			return err
		}
		if name == "." {
			return remote(protocol.ErrorCodeBadRequest, "The server's folder itself can't be deleted; delete what is in it instead.")
		}
		if _, err := f.root.Lstat(name); err != nil {
			return mapError(name, err)
		}
		names = append(names, name)
	}
	for _, name := range names {
		if err := f.root.RemoveAll(name); err != nil {
			return mapError(name, err)
		}
	}
	return nil
}

// OpenRead opens a regular file for a download: the file (read with ReadAt) and its entry.
func (f *FS) OpenRead(p string) (*os.File, protocol.FileEntry, error) {
	name, err := Clean(p)
	if err != nil {
		return nil, protocol.FileEntry{}, err
	}
	file, info, err := f.openRegular(name)
	if err != nil {
		return nil, protocol.FileEntry{}, err
	}
	return file, fileEntry(name, info, nil), nil
}

// CreateUpload checks free disk (UPLOAD_DISK_RESERVE_BYTES) and the disk limit for size more bytes, checks that
// path's folder exists (and that path doesn't, unless overwrite), and creates the temporary file
// UPLOAD_TEMP_DIR/<transferId> inside the root.
func (f *FS) CreateUpload(transferID, p string, size int64, overwrite bool) (*os.File, error) {
	tmp, err := uploadTemp(transferID)
	if err != nil {
		return nil, err
	}
	name, err := Clean(p)
	if err != nil {
		return nil, err
	}
	if size < 0 {
		return nil, remote(protocol.ErrorCodeBadRequest, "The upload's size can't be negative.")
	}
	old, err := f.checkUploadTarget(name, overwrite)
	if err != nil {
		return nil, err
	}
	if err := f.checkSpace(size-old, true); err != nil {
		return nil, err
	}
	if err := f.mkdirAll(protocol.UploadTempDir); err != nil {
		return nil, err
	}
	file, err := f.root.OpenFile(tmp, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return nil, mapError(tmp, err)
	}
	return file, nil
}

// CommitUpload renames the finished temporary file into place, hands it to the owner and returns its entry. An
// overwritten file keeps its mode and owner; a new one is 0644. The caller has synced and closed the file.
func (f *FS) CommitUpload(transferID, p string, overwrite bool) (protocol.FileEntry, error) {
	tmp, err := uploadTemp(transferID)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	name, err := Clean(p)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	if _, err := f.checkUploadTarget(name, overwrite); err != nil {
		return protocol.FileEntry{}, err
	}
	mode := fs.FileMode(0o644)
	uid, gid := f.owner, f.owner
	if info, err := f.root.Stat(name); err == nil && info.Mode().IsRegular() {
		mode = info.Mode().Perm()
		if st, ok := info.Sys().(*syscall.Stat_t); ok && f.owner >= 0 {
			uid, gid = int(st.Uid), int(st.Gid)
		}
	}
	if err := f.root.Chmod(tmp, mode); err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	if err := f.chown(tmp, uid, gid); err != nil {
		return protocol.FileEntry{}, err
	}
	if err := f.root.Rename(tmp, name); err != nil {
		return protocol.FileEntry{}, mapError(name, err)
	}
	f.syncDir(path.Dir(name))
	return f.Stat(name)
}

// DiscardUpload removes an unfinished upload's temporary file (missing is fine).
func (f *FS) DiscardUpload(transferID string) error {
	tmp, err := uploadTemp(transferID)
	if err != nil {
		return err
	}
	if err := f.root.Remove(tmp); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return mapError(tmp, err)
	}
	return nil
}

// ClearUploads empties UPLOAD_TEMP_DIR (agent startup: leftovers of a crash).
func (f *FS) ClearUploads() error {
	if err := f.root.RemoveAll(protocol.UploadTempDir); err != nil {
		return mapError(protocol.UploadTempDir, err)
	}
	return nil
}

// uploadTemp is the temporary file of an upload. The id becomes a file name, so only UUID characters pass.
func uploadTemp(transferID string) (string, error) {
	if len(transferID) != 36 || strings.Trim(transferID, "0123456789abcdefABCDEF-") != "" {
		return "", remote(protocol.ErrorCodeBadRequest, "The transfer id %q is not a UUID.", transferID)
	}
	return path.Join(protocol.UploadTempDir, strings.ToLower(transferID)), nil
}

// checkUploadTarget checks an upload's final path: its folder exists, it isn't the data folder or a folder, and it
// is new unless overwrite. Returns the size of the file it would replace.
func (f *FS) checkUploadTarget(name string, overwrite bool) (int64, error) {
	if name == "." {
		return 0, remote(protocol.ErrorCodeBadRequest, "Name the file to upload.")
	}
	if name == ".gss" || strings.HasPrefix(name, ".gss/") {
		return 0, remote(protocol.ErrorCodeBadRequest, "The .gss folder is the agent's own; upload somewhere else.")
	}
	if err := f.requireFolder(path.Dir(name)); err != nil {
		return 0, err
	}
	info, err := f.root.Lstat(name)
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return 0, nil
	case err != nil:
		return 0, mapError(name, err)
	case info.IsDir():
		return 0, remote(protocol.ErrorCodeConflict, "%s is a folder; folders are never replaced.", display(name))
	case !overwrite:
		return 0, remote(protocol.ErrorCodeConflict, "%s already exists. Upload again with overwrite to replace it.", display(name))
	case info.Mode().IsRegular():
		return info.Size(), nil
	}
	return 0, nil
}

// checkSpace refuses growth bytes that would leave less than UPLOAD_DISK_RESERVE_BYTES free on the disk, or (with
// limit) pass the server's disk limit.
func (f *FS) checkSpace(growth int64, limit bool) error {
	if growth <= 0 {
		return nil
	}
	if free, ok := freeBytes(f.dir); ok && free < growth+protocol.UploadDiskReserveBytes {
		return remote(protocol.ErrorCodeNoSpace, "The host's disk has %d MB free; %d MB more would leave less than the %d MB it keeps in reserve.", free>>20, growth>>20, protocol.UploadDiskReserveBytes>>20)
	}
	if limit && f.diskLimit > 0 && f.used != nil {
		if used := f.used(); used+growth > f.diskLimit {
			return remote(protocol.ErrorCodeNoSpace, "The server uses %d MB of its %d MB disk limit, so %d MB more don't fit. Delete files or raise the limit.", used>>20, f.diskLimit>>20, (growth+(1<<20)-1)>>20)
		}
	}
	return nil
}

// openRegular opens name (following symlinks inside the root) and checks that it is a regular file.
func (f *FS) openRegular(name string) (*os.File, fs.FileInfo, error) {
	if name == "." {
		return nil, nil, remote(protocol.ErrorCodeBadRequest, "The server's folder is a folder, not a file.")
	}
	// O_NONBLOCK: opening a fifo the game created must not hang the agent; it is refused as not regular below.
	file, err := f.root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, mapError(name, err)
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return nil, nil, mapError(name, err)
	}
	if info.IsDir() {
		file.Close()
		return nil, nil, remote(protocol.ErrorCodeBadRequest, "%s is a folder, not a file.", display(name))
	}
	if !info.Mode().IsRegular() {
		file.Close()
		return nil, nil, remote(protocol.ErrorCodeBadRequest, "%s is not a regular file (a socket, device or pipe), so it can't be opened.", display(name))
	}
	return file, info, nil
}

// requireFolder checks that name exists (following symlinks inside the root) and is a folder.
func (f *FS) requireFolder(name string) error {
	if name == "." {
		return nil
	}
	info, err := f.root.Stat(name)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return remote(protocol.ErrorCodeNotFound, "The folder %s doesn't exist.", display(name))
		}
		return mapError(name, err)
	}
	if !info.IsDir() {
		return remote(protocol.ErrorCodeBadRequest, "%s is a file, not a folder.", display(name))
	}
	return nil
}

// resolveLinks follows symlinks in the final component of name, as paths inside the root. A link that is absolute
// or leads out of the folder is refused; os.Root resolves every folder on the way again when it is used.
func (f *FS) resolveLinks(name string) (string, error) {
	for range maxLinkHops {
		info, err := f.root.Lstat(name)
		if err != nil || info.Mode()&fs.ModeSymlink == 0 {
			return name, nil
		}
		target, err := f.root.Readlink(name)
		if err != nil {
			return "", mapError(name, err)
		}
		if path.IsAbs(target) {
			return "", escapes(name)
		}
		next := path.Join(path.Dir(name), target)
		if next == ".." || strings.HasPrefix(next, "../") {
			return "", escapes(name)
		}
		if next == "." {
			return "", remote(protocol.ErrorCodeBadRequest, "%s points at the server's folder, not a file.", display(name))
		}
		name = next
	}
	return "", remote(protocol.ErrorCodeBadRequest, "%s is a chain of more than %d symlinks.", display(name), maxLinkHops)
}

// mkdirAll creates name and its missing parents (0755) inside the root, handed to the owner.
func (f *FS) mkdirAll(name string) error {
	var made []string
	for dir := name; dir != "."; dir = path.Dir(dir) {
		if _, err := f.root.Lstat(dir); err == nil {
			break
		}
		made = append(made, dir)
	}
	if err := f.root.MkdirAll(name, 0o755); err != nil {
		return mapError(name, err)
	}
	for _, dir := range made {
		if err := f.chown(dir, f.owner, f.owner); err != nil {
			return err
		}
	}
	return nil
}

// chown hands name to uid:gid without following a final symlink; a no-op when the agent doesn't run as root.
func (f *FS) chown(name string, uid, gid int) error {
	if f.owner < 0 || uid < 0 {
		return nil
	}
	if err := f.root.Lchown(name, uid, gid); err != nil {
		return mapError(name, err)
	}
	return nil
}

// syncDir flushes a folder after a rename into it, so the new name survives a power cut. Best effort.
func (f *FS) syncDir(name string) {
	dir, err := f.root.Open(name)
	if err != nil {
		return
	}
	_ = dir.Sync()
	_ = dir.Close()
}

// lstatEntry is the entry for name, a symlink reported as itself.
func (f *FS) lstatEntry(name string) (protocol.FileEntry, error) {
	info, err := f.root.Lstat(name)
	if err != nil {
		return protocol.FileEntry{}, err
	}
	return fileEntry(name, info, f.readlink(name, info)), nil
}

// readlink is a symlink's stored target (nil for anything else, or when it can't be read).
func (f *FS) readlink(name string, info fs.FileInfo) *string {
	if info.Mode()&fs.ModeSymlink == 0 {
		return nil
	}
	target, err := f.root.Readlink(name)
	if err != nil {
		return nil
	}
	return &target
}

// fileEntry builds the protocol entry for a root name.
func fileEntry(name string, info fs.FileInfo, linkTarget *string) protocol.FileEntry {
	entry := protocol.FileEntry{
		Name:       path.Base(name),
		Path:       protoPath(name),
		Size:       info.Size(),
		ModifiedAt: info.ModTime().UTC(),
		Mode:       int64(info.Mode().Perm()),
	}
	if name == "." {
		entry.Name = ""
	}
	mode := info.Mode()
	switch {
	case mode&fs.ModeSymlink != 0:
		entry.Type = protocol.FileTypeSymlink
		entry.LinkTarget = linkTarget
		if entry.LinkTarget == nil {
			empty := ""
			entry.LinkTarget = &empty
		}
	case mode.IsDir():
		entry.Type = protocol.FileTypeDir
		entry.Size = 0
	case mode.IsRegular():
		entry.Type = protocol.FileTypeFile
	default:
		entry.Type = protocol.FileTypeOther
		entry.Size = 0
	}
	return entry
}

func randomSuffix() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}

func remote(code protocol.ErrorCode, format string, args ...any) *protocol.RemoteError {
	return &protocol.RemoteError{Code: code, Message: fmt.Sprintf(format, args...)}
}

func escapes(name string) error {
	return remote(protocol.ErrorCodeBadRequest, "The path %s leaves the server's folder.", display(name))
}

func tooLarge(name string) error {
	return remote(protocol.ErrorCodeTooLarge, "%s is larger than %d MB, too large for the editor. Download it instead.", display(name), protocol.FileTextMaxBytes>>20)
}

// mapError turns an os/syscall error into the RemoteError the panel shows (see the package doc).
func mapError(name string, err error) error {
	if err == nil {
		return nil
	}
	var remoteErr *protocol.RemoteError
	if errors.As(err, &remoteErr) {
		return err
	}
	// os.Root reports a walk that would leave the root with an unexported error; its text is stable.
	if strings.Contains(err.Error(), "path escapes from parent") {
		return escapes(name)
	}
	switch {
	case errors.Is(err, fs.ErrNotExist):
		return remote(protocol.ErrorCodeNotFound, "%s doesn't exist.", display(name))
	case errors.Is(err, fs.ErrExist), errors.Is(err, syscall.ENOTEMPTY):
		return remote(protocol.ErrorCodeConflict, "%s already exists.", display(name))
	case errors.Is(err, syscall.ENOSPC), errors.Is(err, syscall.EDQUOT):
		return remote(protocol.ErrorCodeNoSpace, "The host's disk is full, so %s couldn't be written. Free some space and try again.", display(name))
	case errors.Is(err, fs.ErrPermission), errors.Is(err, syscall.EROFS):
		return remote(protocol.ErrorCodeForbidden, "The agent isn't allowed to change %s (permission denied). Run gss-agent as root, or fix the file's owner.", display(name))
	case errors.Is(err, syscall.ENOTDIR):
		return remote(protocol.ErrorCodeBadRequest, "A part of %s is a file, not a folder.", display(name))
	case errors.Is(err, syscall.EISDIR):
		return remote(protocol.ErrorCodeBadRequest, "%s is a folder, not a file.", display(name))
	case errors.Is(err, syscall.ELOOP):
		return remote(protocol.ErrorCodeBadRequest, "%s is a symlink loop.", display(name))
	case errors.Is(err, syscall.ENAMETOOLONG):
		return remote(protocol.ErrorCodeBadRequest, "The path %s is too long.", display(name))
	}
	return fmt.Errorf("%s: %w", name, err)
}
