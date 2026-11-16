package files

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

func TestInsertSpanAndCovers(t *testing.T) {
	var spans []span
	var ok bool
	for _, s := range []span{{10, 20}, {30, 40}, {0, 10}, {20, 30}} {
		if spans, ok = insertSpan(spans, s); !ok {
			t.Fatalf("insert %v refused into %v", s, spans)
		}
	}
	if !covers(spans, 40) || covers(spans, 41) || len(spans) != 1 {
		t.Fatalf("spans = %v", spans)
	}
	for _, s := range []span{{5, 15}, {39, 41}, {0, 40}, {10, 10}, {20, 19}} {
		if _, ok := insertSpan(spans, s); ok {
			t.Fatalf("overlapping or empty %v accepted into %v", s, spans)
		}
	}
	gap, _ := insertSpan(nil, span{0, 10})
	gap, _ = insertSpan(gap, span{20, 30})
	if covers(gap, 30) || len(gap) != 2 {
		t.Fatalf("a gap counted as covered: %v", gap)
	}
	if !covers(nil, 0) || covers(nil, 1) {
		t.Fatal("empty upload coverage wrong")
	}
}

func uuid(i int) string { return fmt.Sprintf("00000000-0000-0000-0000-%012d", i) }

// reopen opens another FS on the test's data folder: a transfer closes the FS it owns.
func reopen(t *testing.T, base string) *FS {
	t.Helper()
	fs, err := Open(filepath.Join(base, "data"), Options{Owner: -1})
	must(t, err)
	t.Cleanup(func() { fs.Close() })
	return fs
}

// TestUploadOutOfOrderAndDownload writes a file in shuffled, concurrent chunks, commits it and downloads it back.
func TestUploadOutOfOrderAndDownload(t *testing.T) {
	fs, base := setup(t)
	tr := NewTransfers()
	size := int64(3*protocol.TransferChunkBytes + 1234)
	payload := make([]byte, size)
	_, _ = rand.Read(payload)
	id := uuid(1)
	file, err := fs.CreateUpload(id, "world/upload.bin", size, false)
	must(t, err)
	must(t, tr.OpenUpload(id, "srv", fs, file, "world/upload.bin", size, false))

	var offsets []int64
	for off := int64(0); off < size; off += protocol.TransferChunkBytes {
		offsets = append(offsets, off)
	}
	order := []int{3, 1, 0, 2}
	var wg sync.WaitGroup
	errs := make(chan error, len(order))
	for _, i := range order {
		off := offsets[i]
		end := min(off+protocol.TransferChunkBytes, size)
		wg.Add(1)
		go func() {
			defer wg.Done()
			errs <- tr.Write(protocol.TransferWriteRequest{TransferID: id, Offset: off, DataBase64: base64.StdEncoding.EncodeToString(payload[off:end])})
		}()
	}
	wg.Wait()
	close(errs)
	for err := range errs {
		must(t, err)
	}
	// An overlapping chunk is refused.
	if err := tr.Write(protocol.TransferWriteRequest{TransferID: id, Offset: 1, DataBase64: base64.StdEncoding.EncodeToString([]byte("x"))}); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("overlap: %v; want bad_request", err)
	}
	entry, err := tr.Commit(id)
	must(t, err)
	if entry.Size != size {
		t.Fatalf("committed size %d; want %d", entry.Size, size)
	}

	// Download it back.
	dl := uuid(2)
	fs = reopen(t, base)
	readFile, readEntry, err := fs.OpenRead("world/upload.bin")
	must(t, err)
	must(t, tr.OpenDownload(dl, "srv", readFile, readEntry.Size))
	var got bytes.Buffer
	for off := int64(0); ; off += protocol.TransferChunkBytes {
		chunk, err := tr.Read(protocol.TransferReadRequest{TransferID: dl, Offset: off, Length: protocol.TransferChunkBytes})
		must(t, err)
		raw, _ := base64.StdEncoding.DecodeString(chunk.DataBase64)
		got.Write(raw)
		if chunk.Eof {
			break
		}
	}
	tr.Close(dl)
	if !bytes.Equal(got.Bytes(), payload) {
		t.Fatal("downloaded bytes differ from the upload")
	}
	if _, err := tr.Read(protocol.TransferReadRequest{TransferID: dl, Offset: 0, Length: 1}); code(err) != protocol.ErrorCodeNotFound {
		t.Fatalf("read after close: %v; want not_found", err)
	}
	if entries, _ := os.ReadDir(filepath.Join(base, "data", protocol.UploadTempDir)); len(entries) != 0 {
		t.Fatalf("temp files left: %v", entries)
	}
}

func TestIncompleteCommitAndClose(t *testing.T) {
	fs, base := setup(t)
	tr := NewTransfers()
	temp := func(id string) string { return filepath.Join(base, "data", protocol.UploadTempDir, id) }

	id := uuid(3)
	file, err := fs.CreateUpload(id, "gap.bin", 20, false)
	must(t, err)
	must(t, tr.OpenUpload(id, "srv", fs, file, "gap.bin", 20, false))
	must(t, tr.Write(protocol.TransferWriteRequest{TransferID: id, Offset: 0, DataBase64: base64.StdEncoding.EncodeToString(make([]byte, 10))}))
	if err := tr.Write(protocol.TransferWriteRequest{TransferID: id, Offset: 15, DataBase64: base64.StdEncoding.EncodeToString(make([]byte, 10))}); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("chunk past the size: %v; want bad_request", err)
	}
	if _, err := tr.Commit(id); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("incomplete commit: %v; want bad_request", err)
	}
	if _, err := os.Stat(temp(id)); !os.IsNotExist(err) {
		t.Fatalf("temp file after a failed commit: %v", err)
	}
	if _, err := os.Stat(filepath.Join(base, "data", "gap.bin")); !os.IsNotExist(err) {
		t.Fatal("an incomplete upload was committed")
	}

	// CloseServer and CloseAll remove the temp files of their uploads.
	fs2, err := Open(filepath.Join(base, "data"), Options{Owner: -1})
	must(t, err)
	a, b := uuid(4), uuid(5)
	fa, err := fs2.CreateUpload(a, "a.bin", 5, false)
	must(t, err)
	must(t, tr.OpenUpload(a, "one", fs2, fa, "a.bin", 5, false))
	fs3, err := Open(filepath.Join(base, "data"), Options{Owner: -1})
	must(t, err)
	fb, err := fs3.CreateUpload(b, "b.bin", 5, false)
	must(t, err)
	must(t, tr.OpenUpload(b, "two", fs3, fb, "b.bin", 5, false))
	tr.CloseServer("one")
	if _, err := os.Stat(temp(a)); !os.IsNotExist(err) {
		t.Fatalf("temp of server one after CloseServer: %v", err)
	}
	if _, err := os.Stat(temp(b)); err != nil {
		t.Fatalf("temp of server two after CloseServer(one): %v", err)
	}
	tr.CloseAll()
	if _, err := os.Stat(temp(b)); !os.IsNotExist(err) {
		t.Fatalf("temp after CloseAll: %v", err)
	}
	tr.Close(b) // Unknown ids are fine.
}

func TestIdleSweepAndLimit(t *testing.T) {
	fs, base := setup(t)
	tr := NewTransfers()
	tr.idle = 50 * time.Millisecond
	id := uuid(6)
	file, err := fs.CreateUpload(id, "idle.bin", 5, false)
	must(t, err)
	must(t, tr.OpenUpload(id, "srv", fs, file, "idle.bin", 5, false))
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		tr.mu.Lock()
		n := len(tr.open)
		tr.mu.Unlock()
		if n == 0 {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(base, "data", protocol.UploadTempDir, id)); !os.IsNotExist(err) {
		t.Fatalf("temp file of an idle upload: %v", err)
	}

	tr = NewTransfers()
	fs = reopen(t, base)
	for i := range protocol.TransferMaxOpen {
		f, _, err := fs.OpenRead("server.properties")
		must(t, err)
		must(t, tr.OpenDownload(uuid(100+i), "srv", f, 1))
	}
	f, _, err := fs.OpenRead("server.properties")
	must(t, err)
	if err := tr.OpenDownload(uuid(200), "srv", f, 1); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("transfer over the limit: %v; want conflict", err)
	}
	f.Close()
	tr.CloseAll()
}

// TestCommitCountsUntilDone keeps a committing upload in OpenByServer until its commit returns (an agent update must
// not restart under it).
func TestCommitCountsUntilDone(t *testing.T) {
	fs, _ := setup(t)
	tr := NewTransfers()
	id := uuid(9)
	file, err := fs.CreateUpload(id, "commit.bin", 5, false)
	must(t, err)
	must(t, tr.OpenUpload(id, "srv", fs, file, "commit.bin", 5, false))
	must(t, tr.Write(protocol.TransferWriteRequest{TransferID: id, Offset: 0, DataBase64: base64.StdEncoding.EncodeToString([]byte("hello"))}))
	if server, ok := tr.ServerOf(id); !ok || server != "srv" {
		t.Fatalf("ServerOf: %q, %v", server, ok)
	}

	// A chunk still being written holds the commit after it left the open table.
	tr.open[id].io.RLock()
	upload := tr.open[id]
	done := make(chan error, 1)
	go func() {
		_, err := tr.Commit(id)
		done <- err
	}()
	deadline := time.Now().Add(2 * time.Second)
	for {
		tr.mu.Lock()
		_, stillOpen := tr.open[id]
		tr.mu.Unlock()
		if !stillOpen || time.Now().After(deadline) {
			break
		}
		time.Sleep(time.Millisecond)
	}
	if counts := tr.OpenByServer(); counts["srv"] != 1 {
		t.Fatalf("while committing: %v", counts)
	}
	upload.io.RUnlock()
	must(t, <-done)
	if counts := tr.OpenByServer(); len(counts) != 0 {
		t.Fatalf("after the commit: %v", counts)
	}
}
