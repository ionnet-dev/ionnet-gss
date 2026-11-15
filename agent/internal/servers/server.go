package servers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/supervisor"
)

// server is one managed game server: its last provision, what the agent last heard from gss-init, and the watcher
// goroutine that keeps a supervisor connection open.
type server struct {
	id string
	m  *manager

	op sync.Mutex // one lifecycle operation (provision, start, stop, restart, delete) at a time

	mu          sync.Mutex
	req         protocol.ProvisionRequest
	status      protocol.ServerStatus
	installed   bool
	lastSeq     int64  // newest console seq forwarded to the Sink
	initStarted string // container StartedAt that lastSeq belongs to; a new gss-init restarts seq at 1
	wantRunning bool   // the operator's intent, for autostart after a reboot
	client      supervisor.Client
	changed     chan struct{} // closed and replaced on every status or connection change
	downNoticed bool          // the "container is gone" state change was sent for this outage
	dialWarned  bool
	dialErr     error // why the last connection attempt failed

	watching  bool
	kick      chan struct{}
	quit      chan struct{}
	watchDone chan struct{}
}

func newServer(m *manager, req protocol.ProvisionRequest) *server {
	return &server{
		id:      req.Spec.ServerID,
		m:       m,
		req:     req,
		status:  protocol.ServerStatus{ServerID: req.Spec.ServerID, State: protocol.ServerStateCreating, Since: time.Now().UTC(), SpecHash: req.SpecHash},
		changed: make(chan struct{}),
		kick:    make(chan struct{}, 1),
		quit:    make(chan struct{}),
	}
}

// Status is the server's last known status with the spec hash it runs.
func (s *server) Status() protocol.ServerStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

func (s *server) request() protocol.ProvisionRequest {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.req
}

// notifyLocked wakes everyone waiting for a change. Caller holds s.mu.
func (s *server) notifyLocked() {
	close(s.changed)
	s.changed = make(chan struct{})
}

func (s *server) setWantRunning(want bool) {
	s.mu.Lock()
	s.wantRunning = want
	s.mu.Unlock()
}

// resetConsole forgets the console position: the next gss-init is a new process whose seq starts again.
func (s *server) resetConsole() {
	s.mu.Lock()
	s.lastSeq = 0
	s.initStarted = ""
	s.mu.Unlock()
}

// stopTimeout is how long gss-init may take to stop the game (spec stop.timeout).
func (s *server) stopTimeout() time.Duration {
	s.mu.Lock()
	defer s.mu.Unlock()
	if t := s.req.Spec.Init.Stop.Timeout; t > 0 {
		return time.Duration(t) * time.Second
	}
	return defaultStopTimeout
}

// statusFrom converts gss-init's status to the panel's.
func statusFrom(serverID, specHash string, st protocol.InitStatus) protocol.ServerStatus {
	return protocol.ServerStatus{
		ServerID:        serverID,
		State:           st.State,
		Since:           st.Since,
		ExitCode:        st.ExitCode,
		SpecHash:        specHash,
		InstallProgress: st.InstallProgress,
		Reason:          st.Reason,
	}
}

// isActive reports whether the game is busy (install, start, run or stop in progress).
func isActive(state protocol.ServerState) bool {
	switch state {
	case protocol.ServerStateInstalling, protocol.ServerStateStarting, protocol.ServerStateRunning, protocol.ServerStateStopping:
		return true
	}
	return false
}

// applyChange records a state change and forwards it. Changes older than the current status (a queued event that
// predates the Status call of a reattach) are dropped.
func (s *server) applyChange(change protocol.StateChange) {
	s.mu.Lock()
	if change.At.Before(s.status.Since) {
		s.mu.Unlock()
		return
	}
	s.status.State = change.State
	s.status.Since = change.At
	s.status.ExitCode = change.ExitCode
	s.status.Reason = change.Reason
	s.status.InstallProgress = change.InstallProgress
	switch change.State {
	case protocol.ServerStateRunning:
		s.wantRunning = true
	case protocol.ServerStateStopped:
		if change.Previous == protocol.ServerStateInstalling {
			s.installed = true
		}
	case protocol.ServerStateCrashed, protocol.ServerStateInstallFailed:
		s.wantRunning = false
	}
	s.notifyLocked()
	s.mu.Unlock()
	s.m.markDirty()
	s.m.opts.Sink.State(change)
}

// connected returns the open supervisor client, or nil.
func (s *server) connected() supervisor.Client {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.client
}

// waitConnected waits up to timeout for the watcher to connect to gss-init.
func (s *server) waitConnected(ctx context.Context, timeout time.Duration) (supervisor.Client, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	s.wake()
	for {
		s.mu.Lock()
		client, changed := s.client, s.changed
		s.mu.Unlock()
		if client != nil {
			return client, nil
		}
		select {
		case <-changed:
		case <-s.quit:
			return nil, remoteError(protocol.ErrorCodeConflict, "Server %s is being deleted.", s.id)
		case <-ctx.Done():
			s.mu.Lock()
			cause := s.dialErr
			s.mu.Unlock()
			return nil, remoteError(protocol.ErrorCodeTimeout, "gss-init in container %s did not answer within %s (%v). Check `docker logs %s`.", ContainerName(s.id), timeout, cause, ContainerName(s.id))
		}
	}
}

// waitState waits until the status satisfies done, or ctx ends.
func (s *server) waitState(ctx context.Context, done func(protocol.ServerState) bool) error {
	for {
		s.mu.Lock()
		state, changed := s.status.State, s.changed
		s.mu.Unlock()
		if done(state) {
			return nil
		}
		select {
		case <-changed:
		case <-ctx.Done():
			return remoteError(protocol.ErrorCodeTimeout, "Server %s is still %s.", s.id, state)
		}
	}
}

// wake makes the watcher try to connect now instead of after its backoff.
func (s *server) wake() {
	select {
	case s.kick <- struct{}{}:
	default:
	}
}

// startWatching starts the watcher once.
func (s *server) startWatching() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.watching {
		return
	}
	s.watching = true
	s.watchDone = make(chan struct{})
	go s.watch()
}

// stopWatching ends the watcher and closes its connection; the server keeps running.
func (s *server) stopWatching() {
	s.mu.Lock()
	select {
	case <-s.quit:
	default:
		close(s.quit)
	}
	client, watching, done := s.client, s.watching, s.watchDone
	s.mu.Unlock()
	if client != nil {
		client.Close()
	}
	if watching {
		<-done
	}
}

// Dial backoff while gss-init is unreachable.
const (
	dialMin = 250 * time.Millisecond
	dialMax = 5 * time.Second
	// downAfter failed dials, the watcher checks whether the container is gone.
	downAfter = 3
)

// watch keeps one supervisor connection open: dial, catch up, forward events, repeat until stopWatching.
func (s *server) watch() {
	defer close(s.watchDone)
	socket := s.m.opts.Layout.ServerSocket(s.id)
	delay := dialMin
	failures := 0
	for {
		select {
		case <-s.quit:
			return
		default:
		}
		client, err := s.m.opts.Dial(socket)
		if err == nil {
			err = s.attach(client)
			if err != nil {
				client.Close()
			}
		}
		if err != nil {
			failures++
			s.mu.Lock()
			s.dialErr = err
			s.mu.Unlock()
			s.dialFailed(err, failures)
			select {
			case <-s.quit:
				return
			case <-s.kick:
				delay = dialMin
			case <-time.After(delay):
				delay = min(delay*2, dialMax)
			}
			continue
		}
		failures = 0
		delay = dialMin
		s.pump(client)
		s.detach(client)
	}
}

// dialFailed logs an unreachable gss-init once per outage and, when the container is gone, marks a busy server as
// failed so the panel doesn't show a game that no longer runs.
func (s *server) dialFailed(err error, failures int) {
	if failures < downAfter {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	info, exists, inspectErr := s.m.opts.Docker.ContainerInspect(ctx, ContainerName(s.id))
	if inspectErr != nil {
		return
	}
	s.mu.Lock()
	if exists && info.Running {
		warn := !s.dialWarned && failures >= downAfter*4
		if warn {
			s.dialWarned = true
		}
		s.mu.Unlock()
		if warn {
			slog.Warn("gss-init is not answering on its socket", "server", s.id, "socket", s.m.opts.Layout.ServerSocket(s.id), "error", err)
		}
		return
	}
	if s.downNoticed || !isActive(s.status.State) {
		s.mu.Unlock()
		return
	}
	s.downNoticed = true
	previous := s.status.State
	s.mu.Unlock()

	next := protocol.ServerStateCrashed
	if previous == protocol.ServerStateInstalling {
		next = protocol.ServerStateInstallFailed
	}
	reason := fmt.Sprintf("The game container %s is not running.", ContainerName(s.id))
	if exists {
		reason = fmt.Sprintf("The game container %s stopped (gss-init exited with code %d).", ContainerName(s.id), info.ExitCode)
	}
	slog.Warn("game container is down", "server", s.id, "state", previous)
	s.applyChange(protocol.StateChange{ServerID: s.id, State: next, Previous: previous, At: time.Now().UTC(), Reason: &reason})
}

// attach catches up a fresh connection: status, console lines missed since lastSeq, and a synthetic state change
// when the state moved while the agent wasn't listening.
func (s *server) attach(client supervisor.Client) error {
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	st, err := client.Status(ctx)
	if err != nil {
		return err
	}
	info, _, err := s.m.opts.Docker.ContainerInspect(ctx, ContainerName(s.id))
	if err != nil {
		return err
	}

	s.mu.Lock()
	afterSeq := s.lastSeq
	if info.StartedAt != s.initStarted || st.LastSeq < s.lastSeq {
		afterSeq = 0 // A new gss-init process: its seq started again.
	}
	s.mu.Unlock()

	lastSeq, caughtUp, err := s.catchUp(ctx, client, afterSeq)
	if err != nil {
		return err
	}

	s.mu.Lock()
	previous := s.status
	s.status = statusFrom(s.id, s.req.SpecHash, st)
	s.installed = st.Installed
	s.lastSeq = lastSeq
	s.initStarted = info.StartedAt
	s.client = client
	s.downNoticed = false
	s.dialWarned = false
	if st.State == protocol.ServerStateRunning {
		s.wantRunning = true
	}
	s.notifyLocked()
	s.mu.Unlock()
	s.m.markDirty()

	// A fresh gss-init that never installed idles in `stopped` until Provision sends install: reporting
	// creating → stopped would flash a misleading state in the panel.
	fresh := previous.State == protocol.ServerStateCreating && st.State == protocol.ServerStateStopped && !st.Installed
	moved := previous.State != st.State || (st.State == protocol.ServerStateInstalling && !sameProgress(previous.InstallProgress, st.InstallProgress))
	if moved && !fresh {
		s.m.opts.Sink.State(protocol.StateChange{
			ServerID:        s.id,
			State:           st.State,
			Previous:        previous.State,
			At:              st.Since,
			ExitCode:        st.ExitCode,
			Reason:          st.Reason,
			InstallProgress: st.InstallProgress,
		})
	}
	slog.Info("attached to gss-init", "server", s.id, "state", st.State, "lastSeq", st.LastSeq, "caughtUp", caughtUp)
	return nil
}

// catchUp forwards every kept console line after afterSeq, one backlog page (within the CONSOLE_BATCH_* limits) per
// batch, and returns the newest seq forwarded and how many lines that was.
func (s *server) catchUp(ctx context.Context, client supervisor.Client, afterSeq int64) (int64, int, error) {
	lastSeq, count := afterSeq, 0
	for {
		page, err := client.Backlog(ctx, protocol.InitBacklogRequest{AfterSeq: lastSeq})
		if err != nil {
			return lastSeq, count, err
		}
		if len(page.Lines) == 0 {
			return lastSeq, count, nil
		}
		s.m.opts.Sink.Console(protocol.ConsoleBatch{ServerID: s.id, Lines: page.Lines})
		count += len(page.Lines)
		lastSeq = max(lastSeq, page.Lines[len(page.Lines)-1].Seq)
		if !page.More {
			return lastSeq, count, nil
		}
	}
}

func sameProgress(a, b *protocol.InstallProgress) bool {
	if a == nil || b == nil {
		return a == b
	}
	return *a == *b
}

// detach forgets a closed connection.
func (s *server) detach(client supervisor.Client) {
	client.Close()
	s.mu.Lock()
	if s.client == client {
		s.client = nil
		s.notifyLocked()
	}
	s.mu.Unlock()
	slog.Info("detached from gss-init", "server", s.id)
}

// pump forwards events until the socket closes or the watcher stops. Console lines are batched for consoleFlush
// and within the CONSOLE_BATCH_* limits; a state change flushes the batch first so the panel sees them in order. A
// Gap (the client dropped lines) is filled from the backlog.
func (s *server) pump(client supervisor.Client) {
	var batch protocol.LineBatch
	var timer *time.Timer
	var timerC <-chan time.Time
	flush := func() {
		if timer != nil {
			timer.Stop()
			timer, timerC = nil, nil
		}
		if len(batch.Lines) == 0 {
			return
		}
		s.m.opts.Sink.Console(protocol.ConsoleBatch{ServerID: s.id, Lines: batch.Take()})
		s.m.markDirty()
	}
	defer flush()

	events := client.Events()
	for {
		select {
		case <-s.quit:
			return
		case <-timerC:
			timer, timerC = nil, nil
			flush()
		case event, ok := <-events:
			if !ok {
				return
			}
			switch {
			case event.Gap:
				flush()
				s.mu.Lock()
				afterSeq := s.lastSeq
				s.mu.Unlock()
				ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
				lastSeq, count, err := s.catchUp(ctx, client, afterSeq)
				cancel()
				s.mu.Lock()
				s.lastSeq = max(s.lastSeq, lastSeq)
				s.mu.Unlock()
				s.m.markDirty()
				if err != nil {
					slog.Warn("could not catch the console up after dropped lines; reconnecting", "server", s.id, "error", err)
					return
				}
				slog.Info("caught the console up after dropped lines", "server", s.id, "lines", count)
			case event.Console != nil:
				s.mu.Lock()
				fresh := event.Console.Seq > s.lastSeq
				if fresh {
					s.lastSeq = event.Console.Seq
				}
				s.mu.Unlock()
				if !fresh {
					continue
				}
				size := protocol.LineSize(*event.Console)
				if !batch.Fits(size) {
					flush()
				}
				batch.Add(*event.Console, size)
				if timer == nil {
					timer = time.NewTimer(consoleFlush)
					timerC = timer.C
				}
			case event.State != nil:
				flush()
				change := *event.State
				change.ServerID = s.id
				s.applyChange(change)
			case event.Player != nil:
				player := *event.Player
				player.ServerID = s.id
				s.m.opts.Sink.Player(player)
			}
		}
	}
}

// errNotRunning is answered when gss-init is unreachable because the container is stopped.
func (s *server) errNotRunning() error {
	return remoteError(protocol.ErrorCodeConflict, "Server %s is not running: its container %s is stopped. Start the server first.", s.id, ContainerName(s.id))
}

// isRemoteCode reports whether err is a RemoteError with code.
func isRemoteCode(err error, code protocol.ErrorCode) bool {
	var remote *protocol.RemoteError
	return errors.As(err, &remote) && remote.Code == code
}
