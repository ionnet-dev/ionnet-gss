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
	"errors"
	"io"
	"os"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

var errNotImplemented = &protocol.RemoteError{Code: protocol.ErrorCodeUnsupported, Message: "The file manager is not implemented in this agent yet."}

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
	// Owner gets new files and folders when the agent runs as root. Default protocol.GameUID.
	Owner int
	// DiskLimitBytes is the server's soft disk limit (0 = none); UsedBytes returns its current usage.
	DiskLimitBytes int64
	UsedBytes      func() int64
}

// Open opens dir (a server's data folder) as an os.Root.
func Open(dir string, opts Options) (*FS, error) {
	return nil, errNotImplemented // TODO(builder)
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
func Clean(path string) (string, error) {
	return "", errNotImplemented // TODO(builder)
}

// List lists one folder, folders first then by name, at most FILES_LIST_MAX_ENTRIES (truncated reports more).
func (f *FS) List(path string) (protocol.FilesListResponse, error) {
	return protocol.FilesListResponse{}, errNotImplemented // TODO(builder)
}

// Stat reports one entry without following a final symlink.
func (f *FS) Stat(path string) (protocol.FileEntry, error) {
	return protocol.FileEntry{}, errNotImplemented // TODO(builder)
}

// ReadText reads a whole regular file of at most FILE_TEXT_MAX_BYTES; binary = not valid UTF-8 or holds a NUL.
func (f *FS) ReadText(path string) (entry protocol.FileEntry, content []byte, binary bool, err error) {
	return protocol.FileEntry{}, nil, false, errNotImplemented // TODO(builder)
}

// WriteText replaces or creates a regular file atomically (temporary file in the same folder, fsync, rename),
// keeping an existing file's mode. expected (non-nil) must equal the file's current modification time.
func (f *FS) WriteText(path string, content []byte, expected *time.Time) (protocol.FileEntry, error) {
	return protocol.FileEntry{}, errNotImplemented // TODO(builder)
}

// Mkdir creates one folder (0755); the parent must exist.
func (f *FS) Mkdir(path string) (protocol.FileEntry, error) {
	return protocol.FileEntry{}, errNotImplemented // TODO(builder)
}

// Rename renames or moves within the folder. overwrite replaces a file (never a folder).
func (f *FS) Rename(from, to string, overwrite bool) (protocol.FileEntry, error) {
	return protocol.FileEntry{}, errNotImplemented // TODO(builder)
}

// Delete removes files and folders (recursively, symlinks as links). "" is refused.
func (f *FS) Delete(paths []string) error {
	return errNotImplemented // TODO(builder)
}

// OpenRead opens a regular file for a download: the file (read with ReadAt) and its entry.
func (f *FS) OpenRead(path string) (*os.File, protocol.FileEntry, error) {
	return nil, protocol.FileEntry{}, errNotImplemented // TODO(builder)
}

// CreateUpload checks free disk (UPLOAD_DISK_RESERVE_BYTES) and the disk limit for size more bytes, checks that
// path's folder exists (and that path doesn't, unless overwrite), and creates the temporary file
// UPLOAD_TEMP_DIR/<transferId> inside the root.
func (f *FS) CreateUpload(transferID, path string, size int64, overwrite bool) (*os.File, error) {
	return nil, errNotImplemented // TODO(builder)
}

// CommitUpload renames the finished temporary file into place, hands it to the owner and returns its entry.
func (f *FS) CommitUpload(transferID, path string, overwrite bool) (protocol.FileEntry, error) {
	return protocol.FileEntry{}, errNotImplemented // TODO(builder)
}

// DiscardUpload removes an unfinished upload's temporary file (missing is fine).
func (f *FS) DiscardUpload(transferID string) error {
	return errNotImplemented // TODO(builder)
}

// ClearUploads empties UPLOAD_TEMP_DIR (agent startup: leftovers of a crash).
func (f *FS) ClearUploads() error {
	return errNotImplemented // TODO(builder)
}

// mapError turns an os/syscall error into the RemoteError the panel shows (see the package doc).
func mapError(path string, err error) error {
	if err == nil {
		return nil
	}
	var remote *protocol.RemoteError
	if errors.As(err, &remote) {
		return err
	}
	return err // TODO(builder)
}

var _ io.ReaderAt = (*os.File)(nil)
