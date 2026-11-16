package updater

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// fixture is a fake panel serving one build, a temp folder holding the "running" binary and a recorder of events.
type fixture struct {
	t        *testing.T
	exe      string
	events   chan protocol.AgentUpdateStatus
	restarts atomic.Int32
	requests atomic.Int32

	mu      sync.Mutex
	build   []byte
	chunked bool
	headers http.Header // of the last request
	server  *httptest.Server
}

func digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func newFixture(t *testing.T, build []byte) *fixture {
	f := &fixture{t: t, events: make(chan protocol.AgentUpdateStatus, 64), build: build}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.requests.Add(1)
		f.mu.Lock()
		f.headers = r.Header.Clone()
		f.mu.Unlock()
		if r.URL.Path != "/api/agent/download/linux/"+runtime.GOARCH {
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte(`{"message":"No such build."}`))
			return
		}
		f.mu.Lock()
		data, chunked := f.build, f.chunked
		f.mu.Unlock()
		if chunked {
			w.(http.Flusher).Flush() // no Content-Length: the size cap must hold while reading
		}
		_, _ = w.Write(data)
	}))
	t.Cleanup(f.server.Close)
	f.exe = filepath.Join(t.TempDir(), "gss-agent")
	if err := os.WriteFile(f.exe, []byte("old build"), 0o755); err != nil {
		t.Fatal(err)
	}
	return f
}

func (f *fixture) serve(build []byte) {
	f.mu.Lock()
	f.build = build
	f.mu.Unlock()
}

func (f *fixture) updater(opts Options) *Updater {
	opts.PanelURL = f.server.URL
	if opts.Executable == "" {
		opts.Executable = f.exe
	}
	if opts.Build == nil {
		opts.Build = ReadBuild(opts.Executable)
	}
	opts.Report = func(status protocol.AgentUpdateStatus) { f.events <- status }
	opts.Restart = func() { f.restarts.Add(1) }
	opts.PollInterval = 10 * time.Millisecond
	u := New(opts)
	f.t.Cleanup(u.Close)
	return u
}

// next returns the next event, failing after a timeout.
func (f *fixture) next() protocol.AgentUpdateStatus {
	f.t.Helper()
	select {
	case status := <-f.events:
		return status
	case <-time.After(5 * time.Second):
		f.t.Fatal("no agent.updateStatus event within 5s")
		return protocol.AgentUpdateStatus{}
	}
}

// expect reads events until one has state, failing on a different terminal state.
func (f *fixture) expect(state protocol.AgentUpdateState, sha string) protocol.AgentUpdateStatus {
	f.t.Helper()
	for {
		status := f.next()
		if status.Sha256 != sha {
			f.t.Fatalf("event for %s, want %s: %+v", status.Sha256, sha, status)
		}
		if status.State == state {
			return status
		}
		if status.State == protocol.AgentUpdateStateFailed || status.State == protocol.AgentUpdateStateRestarting {
			f.t.Fatalf("got %s (%s), want %s", status.State, status.Message, state)
		}
	}
}

// waitRestarts waits until Restart ran n times: tryCommit reports `restarting`, then run calls Restart after it.
func (f *fixture) waitRestarts(n int32) {
	f.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for f.restarts.Load() < n && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if got := f.restarts.Load(); got != n {
		f.t.Fatalf("restart called %d times, want %d", got, n)
	}
}

func (f *fixture) exeContent() string {
	data, err := os.ReadFile(f.exe)
	if err != nil {
		f.t.Fatal(err)
	}
	return string(data)
}

// staged lists leftover staged builds next to the binary.
func (f *fixture) staged() []string {
	matches, _ := filepath.Glob(filepath.Join(filepath.Dir(f.exe), stagePrefix+"*"))
	return matches
}

func TestUpdateReplacesBinary(t *testing.T) {
	build := []byte("new build " + strings.Repeat("x", 100000))
	f := newFixture(t, build)
	u := f.updater(Options{HostID: "host-1", Credential: "secret"})
	sha := digest(build)

	status, err := u.Request(sha, false)
	if err != nil || status.State != protocol.AgentUpdateStateDownloading || status.WaitingFor == nil {
		t.Fatalf("Request: %+v, %v", status, err)
	}
	f.expect(protocol.AgentUpdateStateDownloading, sha)
	f.expect(protocol.AgentUpdateStateRestarting, sha)
	f.waitRestarts(1)
	if f.exeContent() != string(build) {
		t.Fatal("the binary was not replaced")
	}
	info, err := os.Stat(f.exe)
	if err != nil || info.Mode().Perm() != 0o755 {
		t.Fatalf("binary mode %v, %v", info.Mode(), err)
	}
	if left := f.staged(); len(left) != 0 {
		t.Fatalf("staged files left: %v", left)
	}
	f.mu.Lock()
	auth, host := f.headers.Get("Authorization"), f.headers.Get("X-Gss-Host")
	f.mu.Unlock()
	if auth != "Bearer secret" || host != "host-1" {
		t.Fatalf("download headers: Authorization %q, X-Gss-Host %q", auth, host)
	}
	// The replaced binary is kept, and the marker names the new build for the crash-loop guard.
	if previous, err := os.ReadFile(siblingPath(f.exe, previousName)); err != nil || string(previous) != "old build" {
		t.Fatalf("previous binary: %q, %v", previous, err)
	}
	swap := readMarker(t, f.exe)
	if swap.Sha256 != sha || swap.Attempts != 0 || swap.PreviousSha256 != digest([]byte("old build")) {
		t.Fatalf("marker: %+v", swap)
	}
	// Once restarting, any request answers with that status.
	if status, _ := u.Request(digest([]byte("other")), false); status.State != protocol.AgentUpdateStateRestarting {
		t.Fatalf("request while restarting: %+v", status)
	}
}

func TestUpdateRefusesDigestMismatch(t *testing.T) {
	f := newFixture(t, []byte("tampered build"))
	u := f.updater(Options{})
	sha := digest([]byte("expected build"))

	if _, err := u.Request(sha, false); err != nil {
		t.Fatal(err)
	}
	failed := f.expect(protocol.AgentUpdateStateFailed, sha)
	if !strings.Contains(failed.Message, "not the requested "+sha) {
		t.Fatalf("message: %s", failed.Message)
	}
	if f.exeContent() != "old build" || len(f.staged()) != 0 || f.restarts.Load() != 0 {
		t.Fatalf("binary %q, staged %v, restarts %d", f.exeContent(), f.staged(), f.restarts.Load())
	}
	// A failed update can be retried.
	f.serve([]byte("expected build"))
	if status, _ := u.Request(sha, false); status.State != protocol.AgentUpdateStateDownloading {
		t.Fatalf("retry: %+v", status)
	}
	f.expect(protocol.AgentUpdateStateRestarting, sha)
}

func TestUpdateCurrentBuild(t *testing.T) {
	f := newFixture(t, []byte("unused"))
	u := f.updater(Options{})
	status, err := u.Request(digest([]byte("old build")), false)
	if err != nil || status.State != protocol.AgentUpdateStateCurrent {
		t.Fatalf("Request: %+v, %v", status, err)
	}
	if f.requests.Load() != 0 || len(f.events) != 0 {
		t.Fatalf("%d downloads, %d events", f.requests.Load(), len(f.events))
	}
}

func TestUpdateBadRequest(t *testing.T) {
	f := newFixture(t, []byte("unused"))
	u := f.updater(Options{})
	for _, sha := range []string{"", "abc", strings.Repeat("A", 64), strings.Repeat("g", 64)} {
		_, err := u.Request(sha, false)
		var remote *protocol.RemoteError
		if !errors.As(err, &remote) || remote.Code != protocol.ErrorCodeBadRequest {
			t.Fatalf("Request(%q): %v", sha, err)
		}
	}
}

func TestUpdateOnlyLinux(t *testing.T) {
	f := newFixture(t, []byte("unused"))
	u := f.updater(Options{GOOS: "darwin"})
	status, err := u.Request(digest([]byte("new")), false)
	if err != nil || status.State != protocol.AgentUpdateStateFailed || !strings.Contains(status.Message, "darwin") {
		t.Fatalf("Request: %+v, %v", status, err)
	}
}

func TestUpdateWaitsWhileBusy(t *testing.T) {
	build := []byte("new build")
	f := newFixture(t, build)
	var mu sync.Mutex
	busy := []string{"install of server a"}
	released := 0
	u := f.updater(Options{Hold: func() ([]string, func()) {
		mu.Lock()
		defer mu.Unlock()
		if len(busy) > 0 {
			return slices.Clone(busy), nil
		}
		return nil, func() { released++ }
	}})
	sha := digest(build)
	if _, err := u.Request(sha, false); err != nil {
		t.Fatal(err)
	}
	waiting := f.expect(protocol.AgentUpdateStateWaiting, sha)
	if !slices.Equal(waiting.WaitingFor, []string{"install of server a"}) || !strings.Contains(waiting.Message, "1 running operation") {
		t.Fatalf("waiting: %+v", waiting)
	}
	if len(f.staged()) != 1 || f.exeContent() != "old build" {
		t.Fatalf("staged %v, binary %q", f.staged(), f.exeContent())
	}

	// An unchanged list is not reported again; a changed one is.
	time.Sleep(50 * time.Millisecond)
	if len(f.events) != 0 {
		t.Fatalf("%d repeated waiting events", len(f.events))
	}
	mu.Lock()
	busy = []string{"backup of server b", "install of server a"}
	mu.Unlock()
	waiting = f.expect(protocol.AgentUpdateStateWaiting, sha)
	if len(waiting.WaitingFor) != 2 {
		t.Fatalf("waiting: %+v", waiting)
	}

	// Resend repeats the pending status (a reconnect).
	u.Resend()
	if again := f.next(); again.State != protocol.AgentUpdateStateWaiting || len(again.WaitingFor) != 2 {
		t.Fatalf("resend: %+v", again)
	}

	mu.Lock()
	busy = nil
	mu.Unlock()
	f.expect(protocol.AgentUpdateStateRestarting, sha)
	f.waitRestarts(1)
	mu.Lock()
	defer mu.Unlock()
	if f.exeContent() != string(build) || released != 0 {
		t.Fatalf("binary %q, released %d", f.exeContent(), released)
	}
}

func TestUpdateRefusesOversize(t *testing.T) {
	build := bytes.Repeat([]byte("x"), 4096)
	for _, chunked := range []bool{false, true} {
		f := newFixture(t, build)
		f.chunked = chunked
		u := f.updater(Options{MaxBytes: 1024})
		sha := digest(build)
		if _, err := u.Request(sha, false); err != nil {
			t.Fatal(err)
		}
		failed := f.expect(protocol.AgentUpdateStateFailed, sha)
		if !strings.Contains(failed.Message, "1024") {
			t.Fatalf("chunked=%v: %s", chunked, failed.Message)
		}
		if f.exeContent() != "old build" || len(f.staged()) != 0 {
			t.Fatalf("chunked=%v: binary %q, staged %v", chunked, f.exeContent(), f.staged())
		}
	}
}

func TestUpdateReplacesPendingRequest(t *testing.T) {
	first, second := []byte("first build"), []byte("second build")
	f := newFixture(t, first)
	var idle atomic.Bool
	u := f.updater(Options{Hold: func() ([]string, func()) {
		if !idle.Load() {
			return []string{"stop of server a"}, nil
		}
		return nil, func() {}
	}})
	if _, err := u.Request(digest(first), false); err != nil {
		t.Fatal(err)
	}
	f.expect(protocol.AgentUpdateStateWaiting, digest(first))

	f.serve(second)
	status, err := u.Request(digest(second), false)
	if err != nil || status.State != protocol.AgentUpdateStateDownloading || status.Sha256 != digest(second) {
		t.Fatalf("Request: %+v, %v", status, err)
	}
	f.expect(protocol.AgentUpdateStateDownloading, digest(second))
	f.expect(protocol.AgentUpdateStateWaiting, digest(second))
	// The same sha again answers with the pending status and starts nothing.
	downloads := f.requests.Load()
	if again, _ := u.Request(digest(second), false); again.State != protocol.AgentUpdateStateWaiting {
		t.Fatalf("repeat: %+v", again)
	}
	if left := f.staged(); len(left) != 1 {
		t.Fatalf("staged: %v", left)
	}

	idle.Store(true)
	f.expect(protocol.AgentUpdateStateRestarting, digest(second))
	if f.exeContent() != string(second) || f.requests.Load() != downloads {
		t.Fatalf("binary %q, downloads %d → %d", f.exeContent(), downloads, f.requests.Load())
	}
}

func TestUpdateCancelledByCurrentBuild(t *testing.T) {
	build := []byte("new build")
	f := newFixture(t, build)
	u := f.updater(Options{Hold: func() ([]string, func()) { return []string{"start of server a"}, nil }})
	if _, err := u.Request(digest(build), false); err != nil {
		t.Fatal(err)
	}
	f.expect(protocol.AgentUpdateStateWaiting, digest(build))
	if status, _ := u.Request(digest([]byte("old build")), false); status.State != protocol.AgentUpdateStateCurrent {
		t.Fatalf("Request: %+v", status)
	}
	deadline := time.Now().Add(5 * time.Second)
	for len(f.staged()) != 0 && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if left := f.staged(); len(left) != 0 {
		t.Fatalf("staged files left: %v", left)
	}
}

func TestUpdateSwapFailureReleases(t *testing.T) {
	build := []byte("new build")
	f := newFixture(t, build)
	// A non-empty directory where the binary should be: the rename fails.
	exe := filepath.Join(filepath.Dir(f.exe), "occupied")
	if err := os.MkdirAll(filepath.Join(exe, "inside"), 0o755); err != nil {
		t.Fatal(err)
	}
	var released atomic.Int32
	u := f.updater(Options{Executable: exe, Hold: func() ([]string, func()) {
		return nil, func() { released.Add(1) }
	}})
	if _, err := u.Request(digest(build), false); err != nil {
		t.Fatal(err)
	}
	failed := f.expect(protocol.AgentUpdateStateFailed, digest(build))
	if !strings.Contains(failed.Message, ".gss-agent-previous") || released.Load() != 1 || f.restarts.Load() != 0 {
		t.Fatalf("message %q, released %d, restarts %d", failed.Message, released.Load(), f.restarts.Load())
	}
	if left := f.staged(); len(left) != 0 {
		t.Fatalf("staged files left: %v", left)
	}
	for _, name := range []string{previousName, markerName} {
		if _, err := os.Lstat(siblingPath(exe, name)); !os.IsNotExist(err) {
			t.Fatalf("%s left after a failed swap: %v", name, err)
		}
	}
}

func TestUpdateRefusesInsecurePanel(t *testing.T) {
	f := newFixture(t, []byte("unused"))
	u := New(Options{
		PanelURL:   "http://gss.example.com",
		Executable: f.exe,
		Report:     func(status protocol.AgentUpdateStatus) { f.events <- status },
	})
	defer u.Close()
	sha := digest([]byte("new"))
	if _, err := u.Request(sha, false); err != nil {
		t.Fatal(err)
	}
	failed := f.expect(protocol.AgentUpdateStateFailed, sha)
	if !strings.Contains(failed.Message, "plain http://") {
		t.Fatalf("message: %s", failed.Message)
	}
}

func TestUpdatePanelError(t *testing.T) {
	f := newFixture(t, []byte("unused"))
	u := f.updater(Options{GOARCH: "mips"})
	sha := digest([]byte("new"))
	if _, err := u.Request(sha, false); err != nil {
		t.Fatal(err)
	}
	failed := f.expect(protocol.AgentUpdateStateFailed, sha)
	if !strings.Contains(failed.Message, "404 Not Found") || !strings.HasSuffix(failed.Message, ": No such build.") {
		t.Fatalf("message: %s", failed.Message)
	}
}

func readMarker(t *testing.T, exe string) pendingSwap {
	t.Helper()
	raw, err := os.ReadFile(siblingPath(exe, markerName))
	if err != nil {
		t.Fatalf("marker: %v", err)
	}
	var swap pendingSwap
	if err := json.Unmarshal(raw, &swap); err != nil {
		t.Fatal(err)
	}
	return swap
}

func exists(path string) bool {
	_, err := os.Lstat(path)
	return err == nil
}

func TestUpdateRefusesCrossOriginRedirect(t *testing.T) {
	var leaked atomic.Int32
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		leaked.Add(1)
	}))
	defer other.Close()
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, other.URL+r.URL.Path, http.StatusFound)
	}))
	defer redirector.Close()
	f := newFixture(t, []byte("unused"))
	u := New(Options{
		PanelURL: redirector.URL, Executable: f.exe, HostID: "host-1", Credential: "secret",
		Report: func(status protocol.AgentUpdateStatus) { f.events <- status },
	})
	defer u.Close()
	sha := digest([]byte("new"))
	if _, err := u.Request(sha, false); err != nil {
		t.Fatal(err)
	}
	failed := f.expect(protocol.AgentUpdateStateFailed, sha)
	if !strings.Contains(failed.Message, "outside the panel's origin") || leaked.Load() != 0 {
		t.Fatalf("message %q, requests to the other origin %d", failed.Message, leaked.Load())
	}
}

func TestUpdateWithoutExecutable(t *testing.T) {
	f := newFixture(t, []byte("unused"))
	u := New(Options{PanelURL: f.server.URL, Report: func(status protocol.AgentUpdateStatus) { f.events <- status }})
	defer u.Close()
	status, err := u.Request(digest([]byte("new")), false)
	if err != nil || status.State != protocol.AgentUpdateStateFailed || !strings.Contains(status.Message, "could not find its own binary") {
		t.Fatalf("Request: %+v, %v", status, err)
	}
	if f.requests.Load() != 0 || len(f.events) != 0 {
		t.Fatalf("%d downloads, %d events", f.requests.Load(), len(f.events))
	}
}

// TestStartupGuard walks the crash-loop guard: counted starts, then the rollback on the fourth.
func TestStartupGuard(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gss-agent")
	newBuild, oldBuild := []byte("new build"), []byte("old build")
	if err := os.WriteFile(exe, newBuild, 0o755); err != nil {
		t.Fatal(err)
	}
	self := Self{Executable: exe, Build: ReadBuild(exe)}

	// No marker: a normal restart does nothing.
	if Startup(self) {
		t.Fatal("rolled back without a marker")
	}

	if err := os.WriteFile(siblingPath(exe, previousName), oldBuild, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := writeJSON(siblingPath(exe, markerName), pendingSwap{Sha256: digest(newBuild), Previous: siblingPath(exe, previousName)}); err != nil {
		t.Fatal(err)
	}
	for attempt := 1; attempt <= MaxStartAttempts; attempt++ {
		if Startup(self) {
			t.Fatalf("rolled back on start %d", attempt)
		}
		if swap := readMarker(t, exe); swap.Attempts != attempt {
			t.Fatalf("start %d counted as %d", attempt, swap.Attempts)
		}
	}
	if !Startup(self) {
		t.Fatal("no rollback after too many starts")
	}
	if content, _ := os.ReadFile(exe); string(content) != string(oldBuild) {
		t.Fatalf("binary after rollback: %q", content)
	}
	if exists(siblingPath(exe, markerName)) || exists(siblingPath(exe, previousName)) {
		t.Fatal("marker or backup left after the rollback")
	}

	// The previous build starts: the rejected build is refused and reported once.
	var events []protocol.AgentUpdateStatus
	u := New(Options{PanelURL: "http://localhost:1", Executable: exe, Build: ReadBuild(exe), Report: func(status protocol.AgentUpdateStatus) { events = append(events, status) }})
	defer u.Close()
	if Startup(Self{Executable: exe, Build: ReadBuild(exe)}) {
		t.Fatal("the restored binary rolled back again")
	}
	u.Resend()
	u.Resend()
	if len(events) != 1 || events[0].State != protocol.AgentUpdateStateFailed || events[0].Sha256 != digest(newBuild) || !strings.Contains(events[0].Message, "rolled back") {
		t.Fatalf("rollback events: %+v", events)
	}
	status, err := u.Request(digest(newBuild), false)
	if err != nil || status.State != protocol.AgentUpdateStateFailed || !strings.Contains(status.Message, rejectedName) {
		t.Fatalf("request of the rejected build: %+v, %v", status, err)
	}
}

func TestStartupRemovesStaleMarker(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gss-agent")
	if err := os.WriteFile(exe, []byte("hand-installed build"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, content := range []string{`{"sha256":"` + digest([]byte("another build")) + `","attempts":2}`, "not json"} {
		if err := os.WriteFile(siblingPath(exe, markerName), []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(siblingPath(exe, previousName), []byte("old"), 0o755); err != nil {
			t.Fatal(err)
		}
		if Startup(Self{Executable: exe, Build: ReadBuild(exe)}) {
			t.Fatalf("rolled back for a stale marker %q", content)
		}
		if exists(siblingPath(exe, markerName)) || exists(siblingPath(exe, previousName)) {
			t.Fatalf("stale marker %q or its backup left", content)
		}
		if content, _ := os.ReadFile(exe); string(content) != "hand-installed build" {
			t.Fatalf("binary changed: %q", content)
		}
	}
}

func TestConfirmAndRestore(t *testing.T) {
	dir := t.TempDir()
	exe := filepath.Join(dir, "gss-agent")
	newBuild := []byte("new build")
	setup := func() {
		if err := os.WriteFile(exe, newBuild, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(siblingPath(exe, previousName), []byte("old build"), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := writeJSON(siblingPath(exe, markerName), pendingSwap{Sha256: digest(newBuild), Attempts: 1}); err != nil {
			t.Fatal(err)
		}
	}

	// A successful hello of the new build ends the rollback window.
	setup()
	u := New(Options{PanelURL: "http://localhost:1", Executable: exe, Build: ReadBuild(exe), Report: func(protocol.AgentUpdateStatus) {}})
	u.Confirm()
	if exists(siblingPath(exe, markerName)) || exists(siblingPath(exe, previousName)) {
		t.Fatal("Confirm left the marker or the backup")
	}
	// A marker for another build is not confirmed by this one.
	setup()
	other := "x"
	New(Options{PanelURL: "http://localhost:1", Executable: exe, Build: &other, Report: func(protocol.AgentUpdateStatus) {}}).Confirm()
	if !exists(siblingPath(exe, markerName)) {
		t.Fatal("Confirm removed a marker of another build")
	}

	// A failed exec puts the previous binary back.
	setup()
	if err := Restore(exe); err != nil {
		t.Fatal(err)
	}
	if content, _ := os.ReadFile(exe); string(content) != "old build" || exists(siblingPath(exe, markerName)) || !exists(siblingPath(exe, rejectedName)) {
		t.Fatalf("after Restore: binary %q", content)
	}
}

// TestForceRejectedBuild: a manual (forced) update installs a rolled-back build and clears its record.
func TestForceRejectedBuild(t *testing.T) {
	build := []byte("new build")
	f := newFixture(t, build)
	sha := digest(build)
	record := siblingPath(f.exe, rejectedName)
	if err := writeJSON(record, rejectedBuild{Sha256: sha, Reason: "Build rolled back.", Reported: true}); err != nil {
		t.Fatal(err)
	}
	u := f.updater(Options{})
	if status, _ := u.Request(sha, false); status.State != protocol.AgentUpdateStateFailed || f.requests.Load() != 0 {
		t.Fatalf("unforced: %+v, %d downloads", status, f.requests.Load())
	}
	if !exists(record) {
		t.Fatal("an unforced request cleared the rollback record")
	}
	if status, err := u.Request(sha, true); err != nil || status.State != protocol.AgentUpdateStateDownloading {
		t.Fatalf("forced: %+v, %v", status, err)
	}
	if exists(record) {
		t.Fatal("a forced request kept the rollback record")
	}
	f.expect(protocol.AgentUpdateStateRestarting, sha)
	f.waitRestarts(1)
	if f.exeContent() != string(build) {
		t.Fatal("the forced build was not installed")
	}
}
