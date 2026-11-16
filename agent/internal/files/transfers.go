package files

import (
	"encoding/base64"
	"errors"
	"io"
	"log/slog"
	"os"
	"sort"
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
	// idle is TRANSFER_IDLE_SEC (shorter in tests); the sweep runs while any transfer is open.
	idle     time.Duration
	sweeping bool
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

	// io is held shared by every ReadAt/WriteAt and exclusively by commit and close, so neither runs under a chunk.
	io sync.RWMutex
	// spanMu guards written, failed and lastUsed (several writes hold io shared at once).
	spanMu sync.Mutex
	// failed: a write failed after its range was reserved; the upload can't be committed any more.
	failed bool
}

type span struct{ from, to int64 }

// NewTransfers returns an empty table; its idle sweep runs while transfers are open.
func NewTransfers() *Transfers {
	return &Transfers{open: map[string]*transfer{}, now: time.Now, idle: time.Duration(protocol.TransferIdleSec) * time.Second}
}

// OpenDownload registers a download of an open file (from FS.OpenRead or Manager.BackupArchive). On an error the
// caller still owns file.
func (t *Transfers) OpenDownload(id, serverID string, file *os.File, size int64) error {
	return t.add(&transfer{id: id, serverID: serverID, direction: protocol.TransferDirectionDownload, file: file, size: size})
}

// OpenUpload registers an upload whose temporary file FS.CreateUpload created; fs stays open until it closes. On an
// error the caller still owns fs and file (and discards the temporary file).
func (t *Transfers) OpenUpload(id, serverID string, fs *FS, file *os.File, path string, size int64, overwrite bool) error {
	return t.add(&transfer{id: id, serverID: serverID, direction: protocol.TransferDirectionUpload, file: file, size: size, fs: fs, path: path, overwrite: overwrite})
}

// add puts a new transfer into the table within TRANSFER_MAX_OPEN and starts the idle sweep when needed.
func (t *Transfers) add(tr *transfer) error {
	if _, err := uploadTemp(tr.id); err != nil {
		return err
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if _, taken := t.open[tr.id]; taken {
		return remote(protocol.ErrorCodeConflict, "A transfer with id %s is already open.", tr.id)
	}
	if len(t.open) >= protocol.TransferMaxOpen {
		return remote(protocol.ErrorCodeConflict, "The host already has %d transfers open, its limit. Wait for one to finish and try again.", protocol.TransferMaxOpen)
	}
	tr.lastUsed = t.now()
	t.open[tr.id] = tr
	if !t.sweeping {
		t.sweeping = true
		go t.sweep()
	}
	return nil
}

// get looks a transfer up and marks it used.
func (t *Transfers) get(id string, direction protocol.TransferDirection) (*transfer, error) {
	t.mu.Lock()
	tr := t.open[id]
	now := t.now()
	t.mu.Unlock()
	if tr == nil {
		return nil, remote(protocol.ErrorCodeNotFound, "The transfer %s isn't open (it finished, was cancelled or sat idle too long). Start it again.", id)
	}
	if tr.direction != direction {
		return nil, remote(protocol.ErrorCodeBadRequest, "The transfer %s is a %s.", id, tr.direction)
	}
	tr.spanMu.Lock()
	tr.lastUsed = now
	tr.spanMu.Unlock()
	return tr, nil
}

// take removes a transfer from the table (nil when unknown).
func (t *Transfers) take(id string) *transfer {
	t.mu.Lock()
	defer t.mu.Unlock()
	tr := t.open[id]
	delete(t.open, id)
	return tr
}

// Read answers `transfer.read`.
func (t *Transfers) Read(req protocol.TransferReadRequest) (protocol.TransferChunk, error) {
	if req.Length <= 0 {
		return protocol.TransferChunk{}, remote(protocol.ErrorCodeBadRequest, "A chunk must be at least one byte long.")
	}
	if req.Length > protocol.TransferChunkBytes {
		return protocol.TransferChunk{}, remote(protocol.ErrorCodeTooLarge, "A chunk is at most %d bytes.", protocol.TransferChunkBytes)
	}
	tr, err := t.get(req.TransferID, protocol.TransferDirectionDownload)
	if err != nil {
		return protocol.TransferChunk{}, err
	}
	if req.Offset < 0 || req.Offset > tr.size {
		return protocol.TransferChunk{}, remote(protocol.ErrorCodeBadRequest, "The offset %d is outside the file (%d bytes).", req.Offset, tr.size)
	}
	n := min(req.Length, tr.size-req.Offset)
	buf := make([]byte, n)
	tr.io.RLock()
	read, err := tr.file.ReadAt(buf, req.Offset)
	tr.io.RUnlock()
	if err != nil && !(errors.Is(err, io.EOF) && int64(read) == n) {
		if errors.Is(err, io.EOF) || errors.Is(err, os.ErrClosed) {
			return protocol.TransferChunk{}, remote(protocol.ErrorCodeConflict, "The file shrank or was closed during the download. Download it again.")
		}
		return protocol.TransferChunk{}, mapError(tr.file.Name(), err)
	}
	return protocol.TransferChunk{Offset: req.Offset, DataBase64: base64.StdEncoding.EncodeToString(buf), Eof: req.Offset+n >= tr.size}, nil
}

// Write answers `transfer.write`.
func (t *Transfers) Write(req protocol.TransferWriteRequest) error {
	if base64.StdEncoding.DecodedLen(len(req.DataBase64)) > protocol.TransferChunkBytes+2 {
		return remote(protocol.ErrorCodeTooLarge, "A chunk is at most %d bytes.", protocol.TransferChunkBytes)
	}
	data, err := base64.StdEncoding.DecodeString(req.DataBase64)
	if err != nil {
		return remote(protocol.ErrorCodeBadRequest, "The chunk is not valid base64: %v.", err)
	}
	if len(data) == 0 {
		return remote(protocol.ErrorCodeBadRequest, "A chunk must be at least one byte long.")
	}
	if len(data) > protocol.TransferChunkBytes {
		return remote(protocol.ErrorCodeTooLarge, "A chunk is at most %d bytes.", protocol.TransferChunkBytes)
	}
	tr, err := t.get(req.TransferID, protocol.TransferDirectionUpload)
	if err != nil {
		return err
	}
	s := span{from: req.Offset, to: req.Offset + int64(len(data))}
	if s.from < 0 || s.to > tr.size {
		return remote(protocol.ErrorCodeBadRequest, "The chunk [%d, %d) is outside the announced size of %d bytes.", s.from, s.to, tr.size)
	}
	tr.io.RLock()
	defer tr.io.RUnlock()
	tr.spanMu.Lock()
	failed := tr.failed
	var reserved bool
	if !failed {
		tr.written, reserved = insertSpan(tr.written, s)
	}
	tr.spanMu.Unlock()
	if failed {
		return remote(protocol.ErrorCodeConflict, "An earlier chunk of this upload failed. Start the upload again.")
	}
	if !reserved {
		return remote(protocol.ErrorCodeBadRequest, "The chunk [%d, %d) overlaps one already written.", s.from, s.to)
	}
	if _, err := tr.file.WriteAt(data, req.Offset); err != nil {
		tr.spanMu.Lock()
		tr.failed = true
		tr.spanMu.Unlock()
		if errors.Is(err, os.ErrClosed) {
			return remote(protocol.ErrorCodeNotFound, "The transfer %s was closed during the write.", tr.id)
		}
		return mapError(tr.path, err)
	}
	return nil
}

// Commit answers `transfer.commit`. The transfer ends either way; a failed commit discards the upload.
func (t *Transfers) Commit(id string) (protocol.FileEntry, error) {
	t.mu.Lock()
	tr := t.open[id]
	if tr != nil && tr.direction == protocol.TransferDirectionUpload {
		delete(t.open, id)
	}
	t.mu.Unlock()
	if tr == nil {
		return protocol.FileEntry{}, remote(protocol.ErrorCodeNotFound, "The transfer %s isn't open (it finished, was cancelled or sat idle too long). Start it again.", id)
	}
	if tr.direction != protocol.TransferDirectionUpload {
		return protocol.FileEntry{}, remote(protocol.ErrorCodeBadRequest, "The transfer %s is a download; only uploads are committed.", id)
	}
	tr.io.Lock() // Waits for writes still running.
	defer tr.io.Unlock()
	defer tr.fs.Close()
	discard := func() {
		_ = tr.file.Close()
		if err := tr.fs.DiscardUpload(tr.id); err != nil {
			slog.Warn("could not remove an upload's temporary file", "transfer", tr.id, "error", err)
		}
	}
	if tr.failed {
		discard()
		return protocol.FileEntry{}, remote(protocol.ErrorCodeConflict, "A chunk of this upload failed. Start the upload again.")
	}
	if !covers(tr.written, tr.size) {
		discard()
		return protocol.FileEntry{}, remote(protocol.ErrorCodeBadRequest, "The upload is incomplete: the chunks written don't cover all %d bytes.", tr.size)
	}
	if err := tr.file.Sync(); err != nil {
		discard()
		return protocol.FileEntry{}, mapError(tr.path, err)
	}
	if err := tr.file.Close(); err != nil {
		_ = tr.fs.DiscardUpload(tr.id)
		return protocol.FileEntry{}, mapError(tr.path, err)
	}
	entry, err := tr.fs.CommitUpload(tr.id, tr.path, tr.overwrite)
	if err != nil {
		_ = tr.fs.DiscardUpload(tr.id)
		return protocol.FileEntry{}, err
	}
	return entry, nil
}

// Close answers `transfer.close`; unknown ids are fine.
func (t *Transfers) Close(id string) {
	if tr := t.take(id); tr != nil {
		tr.close()
	}
}

// CloseServer closes every transfer of one server (servers.TransferCloser).
func (t *Transfers) CloseServer(serverID string) {
	t.closeWhere(func(tr *transfer) bool { return tr.serverID == serverID })
}

// CloseAll closes every transfer (a new panel connection).
func (t *Transfers) CloseAll() {
	t.closeWhere(func(*transfer) bool { return true })
}

// closeWhere removes and closes the transfers match picks.
func (t *Transfers) closeWhere(match func(tr *transfer) bool) {
	t.mu.Lock()
	var picked []*transfer
	for id, tr := range t.open {
		if match(tr) {
			picked = append(picked, tr)
			delete(t.open, id)
		}
	}
	t.mu.Unlock()
	for _, tr := range picked {
		tr.close()
	}
}

// sweep closes transfers idle for longer than t.idle, and ends once the table is empty.
func (t *Transfers) sweep() {
	interval := min(t.idle/4, 10*time.Second)
	if interval <= 0 {
		interval = time.Second
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for range ticker.C {
		now := t.now()
		t.mu.Lock()
		var idle []*transfer
		for id, tr := range t.open {
			tr.spanMu.Lock()
			last := tr.lastUsed
			tr.spanMu.Unlock()
			if now.Sub(last) > t.idle {
				idle = append(idle, tr)
				delete(t.open, id)
			}
		}
		done := len(t.open) == 0
		if done {
			t.sweeping = false
		}
		t.mu.Unlock()
		for _, tr := range idle {
			slog.Info("closed an idle transfer", "transfer", tr.id, "server", tr.serverID, "direction", tr.direction)
			tr.close()
		}
		if done {
			return
		}
	}
}

// close releases a transfer that is already out of the table: the file, and for an upload its temporary file and
// FS. It waits for chunks still running.
func (tr *transfer) close() {
	tr.io.Lock()
	defer tr.io.Unlock()
	_ = tr.file.Close()
	if tr.direction != protocol.TransferDirectionUpload {
		return
	}
	if err := tr.fs.DiscardUpload(tr.id); err != nil {
		slog.Warn("could not remove an upload's temporary file", "transfer", tr.id, "error", err)
	}
	_ = tr.fs.Close()
}

// insertSpan adds s to the sorted, non-overlapping, merged list spans; ok is false (and spans unchanged) when s
// overlaps a range already in it. Touching ranges are merged, so an in-order upload keeps a single span.
func insertSpan(spans []span, s span) ([]span, bool) {
	if s.to <= s.from {
		return spans, false
	}
	i := sort.Search(len(spans), func(i int) bool { return spans[i].from >= s.from })
	if i > 0 && spans[i-1].to > s.from {
		return spans, false
	}
	if i < len(spans) && spans[i].from < s.to {
		return spans, false
	}
	mergeLeft := i > 0 && spans[i-1].to == s.from
	mergeRight := i < len(spans) && spans[i].from == s.to
	switch {
	case mergeLeft && mergeRight:
		spans[i-1].to = spans[i].to
		return append(spans[:i], spans[i+1:]...), true
	case mergeLeft:
		spans[i-1].to = s.to
		return spans, true
	case mergeRight:
		spans[i].from = s.from
		return spans, true
	}
	spans = append(spans, span{})
	copy(spans[i+1:], spans[i:])
	spans[i] = s
	return spans, true
}

// covers reports whether the merged spans are exactly [0, size).
func covers(spans []span, size int64) bool {
	if size == 0 {
		return len(spans) == 0
	}
	return len(spans) == 1 && spans[0].from == 0 && spans[0].to == size
}
