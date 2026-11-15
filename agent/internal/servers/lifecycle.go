package servers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/supervisor"
)

// up makes sure the container runs (recreating it from the manifest if it vanished) and returns a connection to
// its gss-init.
func (m *manager) up(ctx context.Context, s *server) (supervisor.Client, error) {
	if client := s.connected(); client != nil {
		return client, nil
	}
	if err := m.ensureContainer(ctx, s, false); err != nil {
		return nil, err
	}
	s.startWatching()
	return s.waitConnected(ctx, readyTimeout)
}

// reachable returns a connection to gss-init without starting anything: errNotRunning when the container is down.
func (m *manager) reachable(ctx context.Context, s *server) (supervisor.Client, error) {
	if client := s.connected(); client != nil {
		return client, nil
	}
	info, exists, err := m.opts.Docker.ContainerInspect(ctx, ContainerName(s.id))
	if err != nil {
		return nil, err
	}
	if !exists || !info.Running {
		return nil, s.errNotRunning()
	}
	s.startWatching()
	return s.waitConnected(ctx, requestTimeout)
}

func (m *manager) Start(ctx context.Context, serverID string) (protocol.ServerStatus, error) {
	s, err := m.lookup(serverID)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	s.op.Lock()
	defer s.op.Unlock()
	return m.start(ctx, s)
}

// start is Start with s.op held.
func (m *manager) start(ctx context.Context, s *server) (protocol.ServerStatus, error) {
	req := s.request()
	if limit := req.Spec.Limits.DiskMB; limit > 0 {
		if used := dirSize(m.opts.Layout.ServerData(s.id)); used > limit<<20 {
			return protocol.ServerStatus{}, remoteError(protocol.ErrorCodeConflict, "Server %s uses %d MB of its %d MB disk limit. Delete files or raise the limit before starting it.", s.id, used>>20, limit)
		}
	}
	client, err := m.up(ctx, s)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	st, err := client.Start(reqCtx)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	s.setWantRunning(true)
	m.saveStateLogged()
	return statusFrom(s.id, req.SpecHash, st), nil
}

func (m *manager) Stop(ctx context.Context, serverID string, kill bool) (protocol.ServerStatus, error) {
	s, err := m.lookup(serverID)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	s.op.Lock()
	defer s.op.Unlock()
	s.setWantRunning(false)
	m.saveStateLogged()
	client, err := m.reachable(ctx, s)
	if isRemoteCode(err, protocol.ErrorCodeConflict) {
		return s.Status(), nil // The container is down, so the game is not running either.
	}
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	st, err := client.Stop(reqCtx, kill, "")
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	return statusFrom(s.id, s.request().SpecHash, st), nil
}

func (m *manager) Restart(ctx context.Context, serverID string) (protocol.ServerStatus, error) {
	s, err := m.lookup(serverID)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	s.op.Lock()
	defer s.op.Unlock()
	client, err := m.up(ctx, s)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	st, err := client.Status(reqCtx)
	cancel()
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	switch st.State {
	case protocol.ServerStateInstalling:
		return protocol.ServerStatus{}, remoteError(protocol.ErrorCodeConflict, "Server %s is installing; wait for the install to finish.", serverID)
	case protocol.ServerStateStarting, protocol.ServerStateRunning:
		reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
		_, err := client.Stop(reqCtx, false, "")
		cancel()
		if err != nil {
			return protocol.ServerStatus{}, err
		}
	}
	// gss-init kills the game after the stop timeout; allow for the post-stop hook on top.
	waitCtx, cancel := context.WithTimeout(ctx, s.stopTimeout()+30*time.Second)
	err = s.waitState(waitCtx, func(state protocol.ServerState) bool {
		return state == protocol.ServerStateStopped || state == protocol.ServerStateCrashed || state == protocol.ServerStateInstallFailed
	})
	cancel()
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	return m.start(ctx, s)
}

func (m *manager) Delete(ctx context.Context, serverID string, keepData bool) error {
	if err := validServerID(serverID); err != nil {
		return err
	}
	s := m.get(serverID)
	stopTimeout := defaultStopTimeout
	image := ""
	if req, err := readManifest(m.opts.Layout.ServerManifest(serverID)); err == nil {
		image = req.Spec.Image
	}
	if s != nil {
		image = s.request().Spec.Image
		s.op.Lock()
		defer s.op.Unlock()
		stopTimeout = s.stopTimeout()
		s.stopWatching()
		// Forget it now: a retry after a failed delete starts from the container again, and the manifest left on
		// disk until the folder is removed brings it back on the next Restore.
		m.mu.Lock()
		delete(m.servers, serverID)
		m.mu.Unlock()
	}
	// `docker stop` lets gss-init stop the game gracefully (SIGTERM → stop command → timeout → kill).
	name := ContainerName(serverID)
	if err := m.opts.Docker.ContainerStop(ctx, name, stopTimeout+stopGrace); err != nil {
		return err
	}
	if err := m.opts.Docker.ContainerRemove(ctx, name); err != nil {
		return err
	}
	if err := m.opts.Docker.NetworkRemove(ctx, NetworkName(serverID)); err != nil {
		return err
	}
	m.saveStateLogged()

	if _, err := os.Stat(m.opts.Layout.ServerDir(serverID)); errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err := removeServerFolder(m.opts.Layout, serverID, keepData); err != nil {
		// Files gss-init (root) or the game (GAME_UID) created may be out of a non-root agent's reach.
		if image == "" || !errors.Is(err, os.ErrPermission) {
			return err
		}
		slog.Info("removing files the agent can't delete itself through a cleanup container", "server", serverID, "error", err)
		if helperErr := m.cleanupWithContainer(ctx, serverID, image, keepData); helperErr != nil {
			return fmt.Errorf("%w; the cleanup container failed too: %v", err, helperErr)
		}
		if err := removeServerFolder(m.opts.Layout, serverID, keepData); err != nil {
			return err
		}
	}
	slog.Info("deleted server", "server", serverID, "keepData", keepData)
	return nil
}

func (m *manager) Input(ctx context.Context, serverID, line string) error {
	s, err := m.lookup(serverID)
	if err != nil {
		return err
	}
	client, err := m.reachable(ctx, s)
	if err != nil {
		return err
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	return client.Input(reqCtx, line)
}

func (m *manager) Backlog(ctx context.Context, serverID string, limit, beforeSeq int64) (protocol.BacklogResponse, error) {
	s, err := m.lookup(serverID)
	if err != nil {
		return protocol.BacklogResponse{}, err
	}
	if limit <= 0 || limit > protocol.ConsoleBacklogMaxLines {
		limit = protocol.ConsoleBacklogMaxLines
	}
	client, err := m.reachable(ctx, s)
	if err != nil {
		return protocol.BacklogResponse{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	page, err := client.Backlog(reqCtx, protocol.InitBacklogRequest{BeforeSeq: max(beforeSeq, 0), Limit: limit, Tail: true})
	if err != nil {
		return protocol.BacklogResponse{}, fmt.Errorf("console backlog of %s: %w", serverID, err)
	}
	return page, nil
}

// cleanupWithContainer deletes the server's files from inside a short-lived container (root with DAC_OVERRIDE only,
// no network) running the server's own image, for a non-root agent that can't remove files owned by root or
// GAME_UID.
func (m *manager) cleanupWithContainer(ctx context.Context, serverID, image string, keepData bool) error {
	targets := []string{"/target/spec", "/target/run", "/target/services", "/target/server.json"}
	if !keepData {
		targets = append(targets, "/target/data", "/target/backups")
	}
	name := "gss-cleanup-" + serverID
	if err := m.opts.Docker.ContainerRemove(ctx, name); err != nil {
		return err
	}
	_, err := m.opts.Docker.ContainerCreate(ctx, docker.ContainerSpec{
		Name:        name,
		Image:       image,
		Entrypoint:  []string{"rm"},
		Cmd:         append([]string{"-rf", "--one-file-system"}, targets...),
		Labels:      map[string]string{LabelCleanup: serverID},
		Network:     "none",
		Binds:       []string{m.opts.Layout.ServerDir(serverID) + ":/target"},
		User:        "0:0",
		CapAdd:      []string{"DAC_OVERRIDE"},
		MemoryBytes: 64 << 20,
		PidsLimit:   32,
	})
	if err != nil {
		return err
	}
	defer func() {
		if err := m.opts.Docker.ContainerRemove(context.WithoutCancel(ctx), name); err != nil {
			slog.Warn("could not remove the cleanup container", "container", name, "error", err)
		}
	}()
	if err := m.opts.Docker.ContainerStart(ctx, name); err != nil {
		return err
	}
	waitCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	code, err := m.opts.Docker.ContainerWait(waitCtx, name)
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("rm in %s exited with code %d", name, code)
	}
	return nil
}
