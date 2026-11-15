package servers

import (
	"context"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Game containers have no Docker restart policy, so nothing runs on an unfiltered bridge after a reboot or a Docker
// restart: the agent starts them. Restore does it after the egress table is in place (or holds restricted servers
// back when it isn't), and the watcher starts a container whose gss-init exited while the agent runs.

// Backoff of the watcher's attempts to start an exited container again.
const (
	reviveMin = 10 * time.Second
	reviveMax = 5 * time.Minute
)

// holdBack keeps a restricted server's containers down because its egress rules can't be applied: the game
// container is stopped gracefully when it runs (gss-init stops the game first), the stack's services too, and the
// state says why. Caller holds s.op. The watcher starts it again once the rules can be applied.
func (m *manager) holdBack(ctx context.Context, s *server, reason string) {
	name := ContainerName(s.id)
	info, exists, err := m.opts.Docker.ContainerInspect(ctx, name)
	if err != nil {
		slog.Warn("could not inspect the game container to hold it back", "server", s.id, "error", err)
	}
	s.mu.Lock()
	s.heldBack = true
	s.downNoticed = true // The watcher must not report the stop as a crash.
	previous := s.status.State
	s.mu.Unlock()
	if exists && info.Running {
		reason = strings.Replace(reason, "Not started:", "Stopped:", 1)
		slog.Warn("stopping a server whose egress filtering can't be applied", "server", s.id, "reason", reason)
		if err := m.opts.Docker.ContainerStop(ctx, name, s.stopTimeout()+stopGrace); err != nil {
			slog.Warn("could not stop the game container", "server", s.id, "error", err)
		}
	}
	if s.hasServices() {
		if err := m.opts.Stacks.Stop(ctx, s.id); err != nil {
			slog.Warn("could not stop the stack's services", "server", s.id, "error", err)
		}
		m.refreshServices(ctx, s, true)
	}
	if !isActive(previous) {
		m.reportReason(s, reason)
		return
	}
	next := protocol.ServerStateStopped
	if previous == protocol.ServerStateInstalling {
		next = protocol.ServerStateInstallFailed
	}
	s.applyChange(protocol.StateChange{ServerID: s.id, State: next, Previous: previous, At: time.Now().UTC(), Reason: &reason})
}

// reviveLater starts an exited game container again in the background, at most once per backoff step.
func (m *manager) reviveLater(s *server) {
	s.mu.Lock()
	if time.Now().Before(s.reviveAt) {
		s.mu.Unlock()
		return
	}
	s.reviveDelay = min(max(s.reviveDelay*2, reviveMin), reviveMax)
	s.reviveAt = time.Now().Add(s.reviveDelay)
	s.mu.Unlock()
	go m.revive(s)
}

// revive starts the game container of a managed server whose gss-init exited (egress rules first, see
// ensureContainer) and, for a server that was held back, starts the game again when autostart wants it.
func (m *manager) revive(s *server) {
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	s.op.Lock()
	defer s.op.Unlock()
	if m.get(s.id) != s {
		return // Deleted meanwhile.
	}
	info, exists, err := m.opts.Docker.ContainerInspect(ctx, ContainerName(s.id))
	if err != nil || !exists || info.Running {
		return
	}
	slog.Info("starting the game container again (gss-init exited)", "server", s.id, "exitCode", info.ExitCode)
	if err := m.ensureContainer(ctx, s, false); err != nil {
		slog.Warn("could not start the game container again; the agent retries later", "server", s.id, "error", err)
		return
	}
	s.mu.Lock()
	held := s.heldBack
	s.heldBack = false
	s.mu.Unlock()
	if !held {
		return // The watcher reattaches; nothing here needs gss-init (and the op lock isn't held while it boots).
	}
	if _, err := s.waitConnected(ctx, readyTimeout); err != nil {
		return
	}
	s.mu.Lock()
	autostart := s.req.Spec.Autostart && s.wantRunning && s.installed && s.status.State == protocol.ServerStateStopped
	s.mu.Unlock()
	if autostart {
		slog.Info("starting the game again now that its egress filtering works (autostart)", "server", s.id)
		if _, err := m.start(ctx, s); err != nil {
			slog.Warn("autostart failed", "server", s.id, "error", err)
		}
	}
}

// migrateRestart drops the restart policy of a game container an older agent created with `unless-stopped`, in
// place (no restart, the game keeps running).
func (m *manager) migrateRestart(ctx context.Context, s *server) {
	info, exists, err := m.opts.Docker.ContainerInspect(ctx, ContainerName(s.id))
	if err != nil || !exists || info.RestartPolicy == "" || info.RestartPolicy == "no" {
		return
	}
	if err := m.opts.Docker.ContainerSetRestart(ctx, ContainerName(s.id), "no"); err != nil {
		slog.Warn("could not remove the game container's restart policy; Docker may start it before the egress table after a reboot", "server", s.id, "policy", info.RestartPolicy, "error", err)
		return
	}
	slog.Info("removed the game container's restart policy (the agent starts it after the egress table)", "server", s.id, "was", info.RestartPolicy)
}

// portError turns Docker's "port is already allocated / address already in use" into a port_in_use error naming the
// port, so the panel can allocate another one.
func portError(req protocol.ProvisionRequest, err error) error {
	proto, port, ok := docker.PortInUse(err)
	if !ok {
		return err
	}
	slog.Warn("a published host port is taken by other software; the panel allocates another one", "server", req.Spec.ServerID, "port", port, "proto", proto)
	if proto == "" {
		// Older Docker doesn't say: take the protocol the spec publishes the port with (tcp when it is both).
		proto = string(protocol.PortProtoTCP)
		udpOnly := false
		for _, p := range req.Spec.Ports {
			if int(p.Port) == port && !p.Internal {
				if p.Proto == protocol.PortProtoTCP {
					udpOnly = false
					break
				}
				udpOnly = true
			}
		}
		if udpOnly {
			proto = string(protocol.PortProtoUDP)
		}
	}
	return &protocol.RemoteError{
		Code:    protocol.ErrorCodePortInUse,
		Message: fmt.Sprintf("Host port %d/%s is already taken by other software on this host (Docker: %v).", port, proto, err),
		Port:    &protocol.PortInUse{Proto: protocol.PortProto(proto), Port: int64(port)},
	}
}
