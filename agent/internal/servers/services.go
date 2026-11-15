package servers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Stack services (M3) follow the game, not gss-init's container: they start (and pass their healthchecks) before
// the game starts, keep running across a restart of the game, and stop once the game stopped and the operator
// doesn't want it running. Their status is cached on the server (ServerStatus.services in every answer and in
// hello) and refreshed after every operation and every servicesInterval; a change goes out as `server.services`.

// servicesInterval is how often the services of every stack server are looked at.
const servicesInterval = 10 * time.Second

func (s *server) services() map[string]protocol.ServiceSpec {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.req.Spec.Services
}

func (s *server) hasServices() bool { return len(s.services()) > 0 }

// servicesSnapshotLocked is a copy of the cached service statuses, never nil. Caller holds s.mu.
func (s *server) servicesSnapshotLocked() []protocol.ServiceStatus {
	out := make([]protocol.ServiceStatus, len(s.svc))
	copy(out, s.svc)
	return out
}

// withServices puts the cached service statuses into a status answered to the panel.
func (s *server) withServices(status protocol.ServerStatus) protocol.ServerStatus {
	s.mu.Lock()
	status.Services = s.servicesSnapshotLocked()
	s.mu.Unlock()
	return status
}

// refreshServices asks Docker for the services' state and records it; with emit, a change is sent as
// `server.services`.
func (m *manager) refreshServices(ctx context.Context, s *server, emit bool) {
	services := s.services()
	list, err := m.opts.Stacks.Status(ctx, s.id, services)
	if err != nil {
		slog.Warn("could not read the state of the server's services", "server", s.id, "error", err)
		return
	}
	s.mu.Lock()
	changed := !slices.EqualFunc(s.svc, list, sameService)
	if changed {
		s.svc = list
	}
	s.mu.Unlock()
	if !changed {
		return
	}
	m.markDirty()
	if emit && m.get(s.id) == s { // Not for a server deleted while Docker answered.
		m.opts.Sink.Services(protocol.ServicesChange{ServerID: s.id, Services: list})
	}
}

func sameService(a, b protocol.ServiceStatus) bool {
	if a.Name != b.Name || a.Image != b.Image || a.State != b.State {
		return false
	}
	if a.ExitCode == nil || b.ExitCode == nil {
		return a.ExitCode == b.ExitCode
	}
	return *a.ExitCode == *b.ExitCode
}

// servicesLoop refreshes the services of every stack server and starts services that exited while their game should
// be running (a crash or an OOM kill), once per servicesInterval.
func (m *manager) servicesLoop() {
	ticker := time.NewTicker(servicesInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.quit:
			return
		case <-ticker.C:
		}
		m.mu.Lock()
		list := make([]*server, 0, len(m.servers))
		for _, s := range m.servers {
			list = append(list, s)
		}
		m.mu.Unlock()
		for _, s := range list {
			if !s.hasServices() {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
			m.reviveServices(ctx, s)
			m.refreshServices(ctx, s, true)
			cancel()
		}
	}
}

// reviveServices starts exited services of a running game. It skips servers another operation owns right now.
func (m *manager) reviveServices(ctx context.Context, s *server) {
	s.mu.Lock()
	running := s.wantRunning && s.status.State == protocol.ServerStateRunning
	s.mu.Unlock()
	if !running || !s.op.TryLock() {
		return
	}
	defer s.op.Unlock()
	restarted, err := m.opts.Stacks.Restart(ctx, s.id, s.services())
	for _, name := range restarted {
		slog.Warn("a service of a running server had exited; started it again", "server", s.id, "service", name)
		m.console(s, fmt.Sprintf("Service %s had stopped while the server was running; started it again.", name))
	}
	if err != nil {
		slog.Warn("could not start an exited service again", "server", s.id, "error", err)
	}
}

// startServices brings the stack up before the game starts. Caller holds s.op. A service that doesn't get ready
// fails the start with its reason and log tail (also sent as the state reason); the stack goes down again.
func (m *manager) startServices(ctx context.Context, s *server) error {
	services := s.services()
	if len(services) == 0 {
		return nil
	}
	progress := m.consoleWriter(s)
	defer progress.Close()
	err := m.opts.Stacks.Ensure(ctx, s.id, services, progress)
	if err == nil {
		err = m.opts.Stacks.Start(ctx, s.id, services, progress)
	}
	m.refreshServices(ctx, s, true)
	if err == nil {
		return nil
	}
	reason := fmt.Sprintf("Not started: %v", err)
	if first, _, _ := strings.Cut(reason, "\n"); first != reason {
		m.console(s, reason)
	}
	slog.Warn("a service did not get ready; the game is not started", "server", s.id, "error", err)
	if stopErr := m.opts.Stacks.Stop(context.WithoutCancel(ctx), s.id); stopErr != nil {
		slog.Warn("could not stop the services after a failed start", "server", s.id, "error", stopErr)
	}
	m.refreshServices(context.WithoutCancel(ctx), s, true)
	m.reportReason(s, reason)
	return remoteError(protocol.ErrorCodeConflict, "%s", reason)
}

// stopServicesLater stops the stack once the game is no longer busy, unless the operator wants it running again by
// then (a restart, or a start that came in meanwhile). It runs in the background and takes s.op itself.
func (m *manager) stopServicesLater(s *server) {
	if !s.hasServices() {
		return
	}
	s.mu.Lock()
	if s.servicesStopping {
		s.mu.Unlock()
		return
	}
	s.servicesStopping = true
	s.mu.Unlock()
	go func() {
		defer func() {
			s.mu.Lock()
			s.servicesStopping = false
			s.mu.Unlock()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), s.stopTimeout()+stopGrace+time.Minute)
		defer cancel()
		if err := s.waitState(ctx, func(state protocol.ServerState) bool { return !isActive(state) }); err != nil {
			return
		}
		s.op.Lock()
		defer s.op.Unlock()
		if m.get(s.id) != s {
			return // Deleted meanwhile: Delete removed the stack.
		}
		s.mu.Lock()
		keep := s.wantRunning || isActive(s.status.State)
		s.mu.Unlock()
		if keep {
			return
		}
		if err := m.opts.Stacks.Stop(ctx, s.id); err != nil {
			slog.Warn("could not stop the server's services", "server", s.id, "error", err)
		}
		m.refreshServices(ctx, s, true)
		slog.Info("stopped the server's services after the game", "server", s.id)
	}()
}

// removeServices removes the stack's containers (and with !keepData its volumes). A volume the agent may not
// delete is left for the folder removal, which falls back to a cleanup container.
func (m *manager) removeServices(ctx context.Context, serverID string, keepData bool) error {
	err := m.opts.Stacks.Remove(ctx, serverID, keepData)
	if errors.Is(err, fs.ErrPermission) {
		return nil
	}
	return err
}

// console sends one agent line (seq 0, stream system) to the server's console.
func (m *manager) console(s *server, text string) {
	lines := make([]protocol.ConsoleLine, 0, 4)
	now := time.Now().UTC()
	for _, line := range strings.Split(strings.TrimRight(text, "\n"), "\n") {
		lines = append(lines, protocol.ConsoleLine{Seq: 0, At: now, Stream: protocol.ConsoleStreamSystem, Text: line})
	}
	m.opts.Sink.Console(protocol.ConsoleBatch{ServerID: s.id, Lines: lines})
}

// consoleWriter turns progress output (an image build, a pull, service starts) into console lines. Writes after
// Close still go out: a shared derived build may outlive the provision that started it.
func (m *manager) consoleWriter(s *server) *consoleWriter {
	return &consoleWriter{m: m, s: s}
}

type consoleWriter struct {
	m       *manager
	s       *server
	mu      sync.Mutex
	partial []byte
}

func (w *consoleWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	w.partial = append(w.partial, p...)
	end := bytes.LastIndexByte(w.partial, '\n')
	var text string
	if end >= 0 {
		text = string(w.partial[:end])
		w.partial = append([]byte(nil), w.partial[end+1:]...)
	}
	w.mu.Unlock()
	if text != "" {
		w.m.console(w.s, text)
	}
	return len(p), nil
}

// Close flushes a last line without a newline.
func (w *consoleWriter) Close() error {
	w.mu.Lock()
	text := string(w.partial)
	w.partial = nil
	w.mu.Unlock()
	if text != "" {
		w.m.console(w.s, text)
	}
	return nil
}
