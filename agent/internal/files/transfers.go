package files

import (
	"os"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Transfers is the agent's table of open transfers (files.json `transfer.*`), at most TRANSFER_MAX_OPEN. A transfer
// is closed by `transfer.close`, by `transfer.commit` (uploads), after TRANSFER_IDLE_SEC without a request, by
// CloseServer (a restore) and by CloseAll (a new panel connection). Closing an uncommitted upload discards its
// temporary file. Safe for concurrent use: reads and writes of one transfer may run in parallel (ReadAt/WriteAt).
type Transfers struct {
	mu   sync.Mutex
	open map[string]*transfer
	now  func() time.Time
}

// transfer is one open download or upload.
type transfer struct {
	id        string
	serverID  string
	direction protocol.TransferDirection
	file      *os.File
	size      int64
	// Uploads: the FS the temp file lives in (closed with the transfer), the final path, and the written ranges
	// (non-overlapping, checked to cover [0, size) on commit).
	fs        *FS
	path      string
	overwrite bool
	written   []span
	lastUsed  time.Time
}

type span struct{ from, to int64 }

// NewTransfers returns an empty table and starts its idle sweep.
func NewTransfers() *Transfers {
	return &Transfers{open: map[string]*transfer{}, now: time.Now} // TODO(builder): idle sweep goroutine
}

// OpenDownload registers a download of an open file (from FS.OpenRead or Manager.BackupArchive).
func (t *Transfers) OpenDownload(id, serverID string, file *os.File, size int64) error {
	return errNotImplemented // TODO(builder)
}

// OpenUpload registers an upload whose temporary file FS.CreateUpload created; fs stays open until it closes.
func (t *Transfers) OpenUpload(id, serverID string, fs *FS, file *os.File, path string, size int64, overwrite bool) error {
	return errNotImplemented // TODO(builder)
}

// Read answers `transfer.read`.
func (t *Transfers) Read(req protocol.TransferReadRequest) (protocol.TransferChunk, error) {
	return protocol.TransferChunk{}, errNotImplemented // TODO(builder)
}

// Write answers `transfer.write`.
func (t *Transfers) Write(req protocol.TransferWriteRequest) error {
	return errNotImplemented // TODO(builder)
}

// Commit answers `transfer.commit`.
func (t *Transfers) Commit(id string) (protocol.FileEntry, error) {
	return protocol.FileEntry{}, errNotImplemented // TODO(builder)
}

// Close answers `transfer.close`; unknown ids are fine.
func (t *Transfers) Close(id string) {
	// TODO(builder)
}

// CloseServer closes every transfer of one server (servers.TransferCloser).
func (t *Transfers) CloseServer(serverID string) {
	// TODO(builder)
}

// CloseAll closes every transfer (a new panel connection).
func (t *Transfers) CloseAll() {
	// TODO(builder)
}
