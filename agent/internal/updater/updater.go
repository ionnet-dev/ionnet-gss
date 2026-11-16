// Package updater replaces the running gss-agent with the panel's build (host.json `agent.update`): download from the
// agent's own panel, verify the requested SHA-256, stage next to the binary, wait until the agent is idle, rename it
// over the binary and hand over to a restart.
package updater

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Defaults of Options.
const (
	// DefaultMaxBytes caps a downloaded build (the agent is ~20 MiB; anything far larger is not a gss-agent).
	DefaultMaxBytes = 256 << 20
	// DefaultDownloadTimeout bounds one download, start to finish.
	DefaultDownloadTimeout = 10 * time.Minute
	// DefaultPollInterval is how often a staged update checks whether the agent is idle.
	DefaultPollInterval = 2 * time.Second
)

// hostHeader names the host on the download request (with the credential as `Authorization: Bearer`).
const hostHeader = "X-Gss-Host"

// stagePrefix names staged builds next to the binary; leftovers of a crashed agent are removed by New.
const stagePrefix = ".gss-agent-update-"

// HoldFunc reports what still runs (labels such as `install of server <id>`). When nothing runs it returns no
// labels and a release func: the agent then refuses new operations until release is called (the swap failed) or
// it restarts.
type HoldFunc func() (busy []string, release func())

// Options configure an Updater. PanelURL, Executable and Report are required.
type Options struct {
	// PanelURL is the agent's configured panel (config.Config.PanelURL); builds come only from there.
	PanelURL string
	// Insecure allows plain http:// to a non-loopback panel, like the agent's session (panel.AgentURL).
	Insecure bool
	// HostID and Credential identify the agent to the panel's download endpoint (`X-Gss-Host`, `Authorization:
	// Bearer`), so the panel can exempt it from its per-IP rate limit. Sent only to PanelURL's origin.
	HostID     string
	Credential string
	// Executable is the binary to replace (Executable()); its folder holds the staged build, the backup of the
	// replaced binary and the update marker (rollback.go). Empty = the agent could not find itself: updates fail.
	Executable string
	// Build is the SHA-256 of the running binary (ReadBuild); nil when it could not be read.
	Build *string
	// Report sends an `agent.updateStatus` event. It is called with the updater's lock held, so it must not block
	// or call back into the Updater (outbox.Emit is the intended target).
	Report func(protocol.AgentUpdateStatus)
	// Hold checks whether the agent is idle; nil = always idle.
	Hold HoldFunc
	// Restart is called once the binary was replaced and `restarting` was reported. It makes the agent shut down
	// and re-exec; nil = nothing (tests).
	Restart func()

	// Client downloads the build; nil = a client that follows redirects only within the panel's origin.
	Client *http.Client
	// MaxBytes caps the download (DefaultMaxBytes when <= 0).
	MaxBytes int64
	// DownloadTimeout bounds one download (DefaultDownloadTimeout when <= 0).
	DownloadTimeout time.Duration
	// PollInterval is how often a staged update re-checks Hold (DefaultPollInterval when <= 0).
	PollInterval time.Duration
	// GOOS and GOARCH pick the build (runtime values when empty); only linux can update itself.
	GOOS   string
	GOARCH string
}

// Updater runs at most one update at a time. Safe for concurrent use.
type Updater struct {
	opts Options

	mu     sync.Mutex
	job    *job // the pending update (downloading, waiting or restarting); nil when none
	closed bool
}

// job is one update attempt.
type job struct {
	sha    string
	cancel context.CancelFunc
	done   chan struct{}
	status protocol.AgentUpdateStatus // guarded by Updater.mu
}

// New returns an updater and removes builds a previous run left staged next to the executable.
func New(opts Options) *Updater {
	if opts.MaxBytes <= 0 {
		opts.MaxBytes = DefaultMaxBytes
	}
	if opts.DownloadTimeout <= 0 {
		opts.DownloadTimeout = DefaultDownloadTimeout
	}
	if opts.PollInterval <= 0 {
		opts.PollInterval = DefaultPollInterval
	}
	if opts.GOOS == "" {
		opts.GOOS = runtime.GOOS
	}
	if opts.GOARCH == "" {
		opts.GOARCH = runtime.GOARCH
	}
	if opts.Client == nil {
		opts.Client = &http.Client{CheckRedirect: sameOrigin}
	}
	if opts.Executable != "" {
		leftovers, _ := filepath.Glob(filepath.Join(filepath.Dir(opts.Executable), stagePrefix+"*"))
		for _, path := range leftovers {
			_ = os.Remove(path)
		}
	}
	return &Updater{opts: opts}
}

// Executable returns the path of the running binary with symlinks resolved, so the rename replaces the real file.
func Executable() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", fmt.Errorf("find the gss-agent binary: %w", err)
	}
	resolved, err := filepath.EvalSymlinks(exe)
	if err != nil {
		return "", fmt.Errorf("resolve the gss-agent binary %s: %w", exe, err)
	}
	return resolved, nil
}

// ReadBuild returns the hex SHA-256 of the file at path, or nil when it can't be read (HostFacts.AgentBuild).
func ReadBuild(path string) *string {
	if path == "" {
		return nil
	}
	file, err := os.Open(path)
	if err != nil {
		slog.Warn("could not read the gss-agent binary to report its build", "path", path, "error", err)
		return nil
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		slog.Warn("could not read the gss-agent binary to report its build", "path", path, "error", err)
		return nil
	}
	sum := hex.EncodeToString(hash.Sum(nil))
	return &sum
}

// Request starts an update to build sha (`agent.update`) and returns the status to answer with: `current` when the
// agent already runs it, the pending update's status when that sha is already pending (or the agent is already
// restarting), `failed` for a build this agent rolled back unless force is set (force clears that record),
// otherwise `downloading` (a pending update of another build is cancelled and replaced). A malformed sha is a
// bad_request RemoteError.
func (u *Updater) Request(sha string, force bool) (protocol.AgentUpdateStatus, error) {
	if !isDigest(sha) {
		return protocol.AgentUpdateStatus{}, &protocol.RemoteError{Code: protocol.ErrorCodeBadRequest, Message: fmt.Sprintf("The build %q is not a SHA-256: send 64 lowercase hex characters.", sha)}
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.closed {
		return protocol.AgentUpdateStatus{}, &protocol.RemoteError{Code: protocol.ErrorCodeConflict, Message: "The agent is shutting down; try again once it reconnects."}
	}
	prev := u.job
	if prev != nil && (prev.sha == sha || prev.status.State == protocol.AgentUpdateStateRestarting) {
		return prev.status, nil
	}
	if u.opts.Build != nil && *u.opts.Build == sha {
		if prev != nil {
			prev.cancel()
			u.job = nil
		}
		return status(protocol.AgentUpdateStateCurrent, sha, "This agent already runs that build."), nil
	}
	if u.opts.GOOS != "linux" {
		return status(protocol.AgentUpdateStateFailed, sha, fmt.Sprintf("Only Linux agents can update themselves; this one runs on %s. Replace the binary by hand.", u.opts.GOOS)), nil
	}
	if u.opts.Executable == "" {
		return status(protocol.AgentUpdateStateFailed, sha, fmt.Sprintf("The agent could not find its own binary when it started, so it cannot replace it. Restart gss-agent, or re-run the install command on the host: curl -fsSL %s/api/agent/install.sh | sudo bash", strings.TrimRight(u.opts.PanelURL, "/"))), nil
	}
	if record, ok := u.rejected(); ok && record.Sha256 == sha {
		if !force {
			return u.rejectedStatus(record), nil
		}
		if err := os.Remove(siblingPath(u.opts.Executable, rejectedName)); err != nil && !errors.Is(err, fs.ErrNotExist) {
			return status(protocol.AgentUpdateStateFailed, sha, u.writeError("clear the rollback record", siblingPath(u.opts.Executable, rejectedName), err)), nil
		}
		slog.Info("installing a build that was rolled back before, as the panel forced it", "sha256", sha)
	}
	if prev != nil {
		prev.cancel()
	}
	ctx, cancel := context.WithCancel(context.Background())
	j := &job{sha: sha, cancel: cancel, done: make(chan struct{})}
	u.job = j
	u.setLocked(j, status(protocol.AgentUpdateStateDownloading, sha, "Downloading the new build from the panel."))
	go u.run(ctx, j, prev)
	return j.status, nil
}

// Resend reports the pending update's status again (after a reconnect), when one is downloading or waiting, and
// a rollback the panel has not heard of yet as `failed`.
func (u *Updater) Resend() {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.job == nil {
		u.reportRejectedLocked()
		return
	}
	if state := u.job.status.State; state == protocol.AgentUpdateStateDownloading || state == protocol.AgentUpdateStateWaiting {
		u.opts.Report(u.job.status)
	}
}

// Close cancels a pending update that has not replaced the binary yet and waits until its staged file is removed.
// Request refuses new updates afterwards.
func (u *Updater) Close() {
	u.mu.Lock()
	u.closed = true
	j := u.job
	pending := j != nil && j.status.State != protocol.AgentUpdateStateRestarting
	if pending {
		j.cancel()
		u.job = nil
	}
	u.mu.Unlock()
	if pending {
		<-j.done
	}
}

// run downloads, waits for idle and swaps. A cancelled ctx (replaced or closed) ends it quietly.
func (u *Updater) run(ctx context.Context, j *job, prev *job) {
	defer close(j.done)
	defer j.cancel()
	if prev != nil {
		<-prev.done // its staged file is gone and it can no longer swap
	}
	if ctx.Err() != nil {
		return
	}
	staged, err := u.download(ctx, j.sha)
	if err != nil {
		if ctx.Err() == nil {
			u.fail(j, err.Error())
		}
		return
	}
	committed := false
	defer func() {
		if !committed {
			_ = os.Remove(staged)
		}
	}()

	ticker := time.NewTicker(u.opts.PollInterval)
	defer ticker.Stop()
	for {
		var done bool
		done, committed = u.tryCommit(ctx, j, staged)
		if committed && u.opts.Restart != nil {
			u.opts.Restart()
		}
		if done {
			return
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// tryCommit swaps the staged build in when the agent is idle. done ends the job (committed, failed or replaced);
// otherwise it reported `waiting` if the busy list changed.
func (u *Updater) tryCommit(ctx context.Context, j *job, staged string) (done, committed bool) {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.job != j || ctx.Err() != nil {
		return true, false
	}
	var busy []string
	var release func()
	if u.opts.Hold != nil {
		busy, release = u.opts.Hold()
	}
	if len(busy) > 0 {
		if j.status.State != protocol.AgentUpdateStateWaiting || !slices.Equal(j.status.WaitingFor, busy) {
			next := status(protocol.AgentUpdateStateWaiting, j.sha, waitingMessage(len(busy)))
			next.WaitingFor = slices.Clone(busy)
			u.setLocked(j, next)
		}
		return false, false
	}
	if err := u.prepareSwap(j.sha); err != nil {
		if release != nil {
			release()
		}
		u.failLocked(j, err.Error())
		return true, false
	}
	if err := os.Rename(staged, u.opts.Executable); err != nil {
		discardSwap(u.opts.Executable)
		if release != nil {
			release()
		}
		u.failLocked(j, u.writeError("replace", u.opts.Executable, err))
		return true, false
	}
	slog.Info("replaced the gss-agent binary; restarting into the new build", "sha256", j.sha, "path", u.opts.Executable)
	u.setLocked(j, status(protocol.AgentUpdateStateRestarting, j.sha, "Replaced the agent binary; restarting into the new build."))
	return true, true
}

// download fetches the build into a staged file next to the executable and verifies it; the staged file is removed
// on any error.
func (u *Updater) download(ctx context.Context, sha string) (string, error) {
	if _, err := panel.AgentURL(u.opts.PanelURL, u.opts.Insecure); err != nil {
		return "", fmt.Errorf("The agent will not download its update from this panel URL: %v.", err)
	}
	source := strings.TrimRight(u.opts.PanelURL, "/") + "/api/agent/download/linux/" + u.opts.GOARCH
	ctx, cancel := context.WithTimeout(ctx, u.opts.DownloadTimeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, source, nil)
	if err != nil {
		return "", fmt.Errorf("The download URL %s is invalid: %v.", source, err)
	}
	if u.opts.Credential != "" {
		req.Header.Set("Authorization", "Bearer "+u.opts.Credential)
		req.Header.Set(hostHeader, u.opts.HostID)
	}
	res, err := u.opts.Client.Do(req)
	if err != nil {
		return "", fmt.Errorf("Could not download the new build from %s: %v.", source, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("The panel answered %s for %s%s", res.Status, source, panelMessage(res.Body))
	}
	if res.ContentLength > u.opts.MaxBytes {
		return "", fmt.Errorf("The panel's build is %d bytes, more than the %d an agent build may have; check the file in the panel's AGENT_DIST_DIR.", res.ContentLength, u.opts.MaxBytes)
	}

	file, err := os.CreateTemp(filepath.Dir(u.opts.Executable), stagePrefix+"*")
	if err != nil {
		return "", errors.New(u.writeError("stage the new build in", filepath.Dir(u.opts.Executable), err))
	}
	staged := file.Name()
	ok := false
	defer func() {
		if !ok {
			file.Close()
			_ = os.Remove(staged)
		}
	}()
	hash := sha256.New()
	written, err := io.Copy(io.MultiWriter(file, hash), io.LimitReader(res.Body, u.opts.MaxBytes+1))
	if err != nil {
		if errors.Is(err, syscall.ENOSPC) {
			return "", fmt.Errorf("No space left in %s for the new build; free some space and try again.", filepath.Dir(staged))
		}
		return "", fmt.Errorf("Could not download the new build from %s: %v.", source, err)
	}
	if written > u.opts.MaxBytes {
		return "", fmt.Errorf("The panel's build is larger than the %d bytes an agent build may have; check the file in the panel's AGENT_DIST_DIR.", u.opts.MaxBytes)
	}
	if got := hex.EncodeToString(hash.Sum(nil)); got != sha {
		return "", fmt.Errorf("The panel served a build with SHA-256 %s, not the requested %s (its build changed or the download was altered); the binary was left as it is. Try again.", got, sha)
	}
	if err := file.Sync(); err != nil {
		return "", fmt.Errorf("Could not write the new build to %s: %v.", staged, err)
	}
	if err := file.Close(); err != nil {
		return "", fmt.Errorf("Could not write the new build to %s: %v.", staged, err)
	}
	if err := os.Chmod(staged, 0o755); err != nil {
		return "", errors.New(u.writeError("make the new build executable in", filepath.Dir(staged), err))
	}
	ok = true
	return staged, nil
}

// writeError explains a failure to write next to the binary; permission problems point at the install command.
func (u *Updater) writeError(action, path string, err error) string {
	if errors.Is(err, fs.ErrPermission) || errors.Is(err, syscall.EROFS) {
		return fmt.Sprintf("The agent cannot %s %s (%v): it must run as root with its binary on a writable disk. Re-run the install command on the host: curl -fsSL %s/api/agent/install.sh | sudo bash", action, path, err, strings.TrimRight(u.opts.PanelURL, "/"))
	}
	return fmt.Sprintf("Could not %s %s: %v.", action, path, err)
}

// fail reports `failed` and clears the job, unless it was replaced meanwhile.
func (u *Updater) fail(j *job, message string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.failLocked(j, message)
}

func (u *Updater) failLocked(j *job, message string) {
	if u.job != j {
		return
	}
	slog.Warn("agent update failed", "sha256", j.sha, "reason", message)
	u.setLocked(j, status(protocol.AgentUpdateStateFailed, j.sha, message))
	u.job = nil
}

// setLocked stores and reports j's status, unless j was replaced. Caller holds u.mu, which keeps events in order.
func (u *Updater) setLocked(j *job, next protocol.AgentUpdateStatus) {
	if u.job != j {
		return
	}
	j.status = next
	u.opts.Report(next)
}

func status(state protocol.AgentUpdateState, sha, message string) protocol.AgentUpdateStatus {
	return protocol.AgentUpdateStatus{State: state, Sha256: sha, Message: message, WaitingFor: []string{}}
}

func waitingMessage(count int) string {
	if count == 1 {
		return "The new build is ready; the agent restarts once 1 running operation finishes."
	}
	return fmt.Sprintf("The new build is ready; the agent restarts once %d running operations finish.", count)
}

// isDigest checks the schema's pattern ^[0-9a-f]{64}$.
func isDigest(sha string) bool {
	if len(sha) != 64 {
		return false
	}
	for _, c := range sha {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// panelMessage reads a panel error body ({ message }) into ": <message>." or ".".
func panelMessage(body io.Reader) string {
	raw, err := io.ReadAll(io.LimitReader(body, 4096))
	if err != nil || len(raw) == 0 {
		return "."
	}
	var parsed struct {
		Message string `json:"message"`
	}
	if json.Unmarshal(raw, &parsed) == nil && parsed.Message != "" {
		return ": " + strings.TrimSuffix(parsed.Message, ".") + "."
	}
	return "."
}

// sameOrigin lets the download follow redirects only within the panel's scheme and host.
func sameOrigin(req *http.Request, via []*http.Request) error {
	if len(via) >= 5 {
		return errors.New("too many redirects")
	}
	first := via[0].URL
	if !sameOriginURL(first, req.URL) {
		// The client copies the first request's headers onto redirects: never let the credential leave the panel.
		req.Header.Del("Authorization")
		req.Header.Del(hostHeader)
		return fmt.Errorf("the panel redirected the download to %s, outside the panel's origin %s://%s", req.URL.Redacted(), first.Scheme, first.Host)
	}
	return nil
}

func sameOriginURL(a, b *url.URL) bool {
	return a.Scheme == b.Scheme && strings.EqualFold(a.Host, b.Host)
}
