// Package backups writes and reads backup archives (M4): tar streams compressed with zstd
// (github.com/klauspost/compress/zstd, pure Go), entries `gss-backup.json` (protocol.BackupManifest) first, then
// each root (`data/…`, `services/<name>/…`). Pure: files and io only; servers/backup.go decides when and what.
//
// Create walks each root without following symlinks (they are stored as links), skips `Exclude` matches (data root
// only), stores regular files, folders and symlinks with mode, mtime and numeric uid/gid, and skips sockets, devices
// and fifos. Extract writes beneath an os.Root per root, refuses absolute names, `..`, names outside the manifest's
// roots, hard links and device entries, never follows a symlink it created (a later entry through it is refused),
// drops setuid/setgid/sticky bits, and restores uid/gid only when the agent runs as root.
package backups

import (
	"context"
	"io"

	"github.com/klauspost/compress/zstd"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Root is one top-level folder of an archive.
type Root struct {
	Name string // "data" or "services/<name>"
	Dir  string // host folder
	// Before and After run around this root's walk (servers/backup.go pauses a running service container here).
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
}

// Create writes the archive to out (the caller writes `<id>.tar.zst.partial`, fsyncs and renames).
func Create(ctx context.Context, out io.Writer, opts CreateOptions) (Result, error) {
	_ = zstd.SpeedDefault
	return Result{}, errNotImplemented // TODO(builder)
}

// ExtractOptions for Extract.
type ExtractOptions struct {
	// Dest maps each archive root name to the folder it is extracted into (the restore's temporary folders); roots
	// not listed are skipped.
	Dest     map[string]string
	Progress func(bytes int64)
}

// Extract reads an archive and returns its manifest (refused when its format is above BACKUP_FORMAT_VERSION).
func Extract(ctx context.Context, in io.Reader, opts ExtractOptions) (protocol.BackupManifest, error) {
	return protocol.BackupManifest{}, errNotImplemented // TODO(builder)
}

// Matcher reports whether a data-relative path ("logs/latest.log", "world") is excluded. Patterns: relative,
// `/`-separated; a trailing slash matches a folder (and everything below it); `*` and `?` match within one segment
// (path.Match); patterns are anchored at the data folder (`*.log` matches only top-level files).
type Matcher struct {
	patterns []string
}

// NewMatcher validates the patterns (bad_request naming the first bad one).
func NewMatcher(patterns []string) (*Matcher, error) {
	return &Matcher{patterns: patterns}, nil // TODO(builder): validate
}

// Excluded reports whether rel (isDir for folders) is excluded.
func (m *Matcher) Excluded(rel string, isDir bool) bool {
	return false // TODO(builder)
}

var errNotImplemented = &protocol.RemoteError{Code: protocol.ErrorCodeUnsupported, Message: "Backups are not implemented in this agent yet."}
