package agent

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/files"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/servers"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/updater"
)

// fakeServers answers Statuses; every other Manager method is unused here.
type fakeServers struct {
	servers.Manager
	statuses []protocol.ServerStatus
}

func (f *fakeServers) Statuses() []protocol.ServerStatus { return f.statuses }

func TestOperationsHoldFreezeRelease(t *testing.T) {
	ops := newOperations()
	end, err := ops.begin("install of server a")
	if err != nil {
		t.Fatal(err)
	}
	if running := ops.hold(); !slices.Equal(running, []string{"install of server a"}) {
		t.Fatalf("hold while running: %v", running)
	}
	end()
	if running := ops.hold(); running != nil {
		t.Fatalf("hold while idle: %v", running)
	}

	// While held, begin waits; freeze then refuses it.
	result := make(chan error, 1)
	go func() {
		_, err := ops.begin("start of server a")
		result <- err
	}()
	select {
	case err := <-result:
		t.Fatalf("begin did not wait for the hold: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	ops.freeze()
	var remote *protocol.RemoteError
	if err := <-result; !errors.As(err, &remote) || remote.Code != protocol.ErrorCodeConflict {
		t.Fatalf("begin while frozen: %v", err)
	}

	ops.release()
	end, err = ops.begin("start of server a")
	if err != nil {
		t.Fatalf("begin after release: %v", err)
	}
	end()
}

func TestHoldForUpdate(t *testing.T) {
	fake := &fakeServers{statuses: []protocol.ServerStatus{
		{ServerID: "a", State: protocol.ServerStateRunning, Operation: &protocol.BackupOperationStatus{Operation: protocol.BackupOperationCreate}},
		{ServerID: "b", State: protocol.ServerStateInstalling},
		{ServerID: "c", State: protocol.ServerStateStopped},
	}}
	transfers := files.NewTransfers()
	a := &Agent{Servers: fake, Transfers: transfers, ops: newOperations()}
	end, err := a.ops.begin("install of server b")
	if err != nil {
		t.Fatal(err)
	}
	busy, release := a.holdForUpdate()
	if want := []string{"backup of server a", "install of server b"}; !slices.Equal(busy, want) || release != nil {
		t.Fatalf("busy %v, want %v", busy, want)
	}
	end()

	// An open transfer keeps it busy, and the failed hold leaves operations open.
	file, err := os.Create(filepath.Join(t.TempDir(), "download"))
	if err != nil {
		t.Fatal(err)
	}
	if err := transfers.OpenDownload("3f2a6c1e-0b5d-4c3a-9e8f-1a2b3c4d5e6f", "c", file, 0); err != nil {
		t.Fatal(err)
	}
	fake.statuses = fake.statuses[2:]
	if busy, _ := a.holdForUpdate(); !slices.Equal(busy, []string{"file transfer of server c"}) {
		t.Fatalf("busy %v", busy)
	}
	if end, err := a.ops.begin("start of server c"); err != nil {
		t.Fatalf("operations refused after a busy hold: %v", err)
	} else {
		end()
	}

	transfers.CloseAll()
	busy, release = a.holdForUpdate()
	if len(busy) != 0 || release == nil {
		t.Fatalf("idle: busy %v", busy)
	}
	if _, err := a.ops.begin("start of server c"); err == nil {
		t.Fatal("an operation started after the agent committed to restarting")
	}
	release()
	if _, err := a.ops.begin("start of server c"); err != nil {
		t.Fatalf("after release: %v", err)
	}
}

// TestRestartForUpdate flushes the restarting event and ends Run's context.
func TestRestartForUpdate(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a := &Agent{Outbox: panel.NewOutbox(0, 0), stop: cancel}
	a.restartForUpdate() // nothing queued: the flush returns at once
	if ctx.Err() == nil || !a.restarting {
		t.Fatal("restartForUpdate did not stop the agent")
	}
}

// TestEndedPrefersStop: a restarting agent re-execs only while its caller still wants it running.
func TestEndedPrefersStop(t *testing.T) {
	a := &Agent{}
	parent, cancel := context.WithCancel(context.Background())
	if err := a.ended(parent, nil); err != nil {
		t.Fatalf("normal end: %v", err)
	}
	a.restarting = true
	if err := a.ended(parent, nil); !errors.Is(err, ErrRestart) {
		t.Fatalf("restart: %v", err)
	}
	cancel()
	if err := a.ended(parent, nil); err != nil {
		t.Fatalf("SIGTERM during the restart: %v", err)
	}
}

// TestFileMutationsTracked: file changes and upload commits count as running operations.
func TestFileMutationsTracked(t *testing.T) {
	a := &Agent{Servers: &fakeServers{}, Transfers: files.NewTransfers(), ops: newOperations()}
	handlers := a.fileHandlers()
	for _, msg := range []string{protocol.MsgFilesWrite, protocol.MsgFilesMkdir, protocol.MsgFilesRename, protocol.MsgFilesDelete, protocol.MsgTransferCommit, protocol.MsgTransferOpen} {
		a.ops.hold()
		a.ops.freeze()
		_, err := handlers[msg](context.Background(), []byte(`{"serverId":"a","transferId":"00000000-0000-0000-0000-000000000001","path":"x","paths":["x"],"from":"x","to":"y","contentBase64":""}`))
		var remote *protocol.RemoteError
		if !errors.As(err, &remote) || remote.Message != errRestarting.Message {
			t.Fatalf("%s while frozen: %v", msg, err)
		}
		a.ops.release()
	}
}

// fakeConn is a panel.Conn whose end the test controls.
type fakeConn struct{ done chan struct{} }

func (c *fakeConn) Request(ctx context.Context, msgType string, req, res any) error { return nil }
func (c *fakeConn) Notify(ctx context.Context, msgType string, data any) error      { return nil }
func (c *fakeConn) Done() <-chan struct{}                                           { return c.done }
func (c *fakeConn) Err() error                                                      { return nil }
func (c *fakeConn) Close() error                                                    { return nil }

// TestConfirmWhenStable: an update is confirmed only after the connection stayed up; an early disconnect cancels it.
func TestConfirmWhenStable(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gss-agent")
	if err := os.WriteFile(exe, []byte("new build"), 0o755); err != nil {
		t.Fatal(err)
	}
	self := updater.Self{Executable: exe, Build: updater.ReadBuild(exe)}
	marker := filepath.Join(dir, ".gss-agent-update")
	raw, _ := json.Marshal(map[string]any{"sha256": *self.Build, "attempts": 1})
	if err := os.WriteFile(marker, raw, 0o644); err != nil {
		t.Fatal(err)
	}
	a := &Agent{
		Updater:      updater.New(updater.Options{PanelURL: "http://localhost:1", Executable: exe, Build: self.Build, Report: func(protocol.AgentUpdateStatus) {}}),
		confirmAfter: 100 * time.Millisecond,
	}

	// The connection drops before confirmAfter: the marker stays.
	early := &fakeConn{done: make(chan struct{})}
	finished := make(chan struct{})
	go func() {
		a.confirmWhenStable(context.Background(), early)
		close(finished)
	}()
	time.Sleep(20 * time.Millisecond)
	close(early.done)
	<-finished
	time.Sleep(150 * time.Millisecond)
	// Only process starts count (updater.Startup); a disconnect leaves the count alone.
	var swap struct {
		Attempts int `json:"attempts"`
	}
	if raw, err := os.ReadFile(marker); err != nil || json.Unmarshal(raw, &swap) != nil || swap.Attempts != 1 {
		t.Fatalf("after an early disconnect: marker %+v, %v", swap, err)
	}

	// A connection that lasts confirms it.
	stable := &fakeConn{done: make(chan struct{})}
	defer close(stable.done)
	a.confirmWhenStable(context.Background(), stable)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("a stable connection did not confirm the update: %v", err)
	}
}
