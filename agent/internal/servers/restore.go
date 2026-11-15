package servers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// stateFile is the agent's runtime record (paths.Layout.StateFile). The spec of each server lives in its manifest;
// this holds what changes while it runs.
type stateFile struct {
	Servers map[string]savedServer `json:"servers"`
}

type savedServer struct {
	Status protocol.ServerStatus `json:"status"`
	// LastSeq is the newest console line forwarded; InitStartedAt is the container start it belongs to.
	LastSeq       int64  `json:"lastSeq"`
	InitStartedAt string `json:"initStartedAt"`
	// WantRunning is the operator's intent: set by start, cleared by stop and by a crash. With the spec's
	// autostart, Restore starts the game again after a reboot.
	WantRunning bool `json:"wantRunning"`
	// Installed: gss-init reported a finished install, so the data folder carries its install marker.
	Installed bool `json:"installed"`
}

// saveState writes the state file for every managed server.
func (m *manager) saveState() error {
	m.saveMu.Lock()
	defer m.saveMu.Unlock()
	m.mu.Lock()
	list := make([]*server, 0, len(m.servers))
	for _, s := range m.servers {
		list = append(list, s)
	}
	m.mu.Unlock()

	state := stateFile{Servers: map[string]savedServer{}}
	for _, s := range list {
		s.mu.Lock()
		state.Servers[s.id] = savedServer{Status: s.status, LastSeq: s.lastSeq, InitStartedAt: s.initStarted, WantRunning: s.wantRunning, Installed: s.installed}
		s.mu.Unlock()
	}
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return fmt.Errorf("encode state file: %w", err)
	}
	if err := os.MkdirAll(m.opts.Layout.Root, 0o755); err != nil {
		return fmt.Errorf("create data root %s: %w", m.opts.Layout.Root, err)
	}
	return writeFileAtomic(m.opts.Layout.StateFile(), append(raw, '\n'), 0o600)
}

// saveStateLogged saves now, for changes that must survive a crash (intent, inventory).
func (m *manager) saveStateLogged() {
	if err := m.saveState(); err != nil {
		slog.Warn("could not write the agent state file", "error", err)
	}
}

// loadState reads the state file; a missing one is empty, a broken one is logged and ignored.
func (m *manager) loadState() stateFile {
	state := stateFile{Servers: map[string]savedServer{}}
	raw, err := os.ReadFile(m.opts.Layout.StateFile())
	if errors.Is(err, os.ErrNotExist) {
		return state
	}
	if err == nil {
		err = json.Unmarshal(raw, &state)
	}
	if err != nil {
		slog.Warn("ignoring the unreadable agent state file; statuses come from gss-init instead", "file", m.opts.Layout.StateFile(), "error", err)
		return stateFile{Servers: map[string]savedServer{}}
	}
	if state.Servers == nil {
		state.Servers = map[string]savedServer{}
	}
	return state
}

// restoreWait bounds how long Restore waits for each server's gss-init before the agent says hello anyway; a server
// that is not back by then keeps restoring in the background and reports through state changes.
const restoreWait = 20 * time.Second

// restoreTimeout bounds bringing one container back, an image pull included.
const restoreTimeout = time.Duration(protocol.ProvisionTimeoutSec) * time.Second

// Restore loads every server folder with a manifest, rebuilds the egress table from them (before any container is
// started), makes sure each container runs, reattaches to gss-init (which catches the console up from lastSeq) and
// starts autostart servers whose game was meant to be running. Containers labelled for servers this agent has no
// folder for are reported and left alone (and stay out of the egress table).
func (m *manager) Restore(ctx context.Context) error {
	layout := m.opts.Layout
	if err := os.MkdirAll(layout.ServersDir(), 0o755); err != nil {
		return fmt.Errorf("create %s: %w (run the agent as root, or set dataRoot in the agent config to a folder you own)", layout.ServersDir(), err)
	}
	state := m.loadState()
	entries, err := os.ReadDir(layout.ServersDir())
	if err != nil {
		return fmt.Errorf("list %s: %w", layout.ServersDir(), err)
	}

	var restored []*server
	m.mu.Lock()
	for _, entry := range entries {
		id := entry.Name()
		if !entry.IsDir() || validServerID(id) != nil || m.servers[id] != nil {
			continue
		}
		req, err := readManifest(layout.ServerManifest(id))
		if errors.Is(err, os.ErrNotExist) {
			continue // Data kept by a delete with keepData.
		}
		if err != nil || req.Spec.ServerID != id {
			slog.Warn("skipping a server folder with an unreadable manifest", "server", id, "error", err)
			continue
		}
		s := newServer(m, req)
		if saved, ok := state.Servers[id]; ok {
			s.status = saved.Status
			s.status.ServerID = id
			s.status.SpecHash = req.SpecHash
			s.lastSeq = saved.LastSeq
			s.initStarted = saved.InitStartedAt
			s.wantRunning = saved.WantRunning
			s.installed = saved.Installed
		}
		m.servers[id] = s
		restored = append(restored, s)
	}
	m.mu.Unlock()

	if containers, err := m.opts.Docker.ContainerList(ctx, LabelServer); err != nil {
		slog.Warn("could not list game containers", "error", err)
	} else {
		for _, info := range containers {
			if id := info.Labels[LabelServer]; m.get(id) == nil && info.Labels[LabelService] == "" {
				slog.Warn("found a game container this agent has no server folder for; leaving it alone", "container", info.Name, "server", id)
			}
		}
	}

	egressReady := make(chan struct{})
	go func() {
		defer close(egressReady)
		syncCtx, cancel := context.WithTimeout(ctx, restoreTimeout)
		defer cancel()
		m.syncEgress(syncCtx, restored)
	}()

	var wg sync.WaitGroup
	for _, s := range restored {
		wg.Add(1)
		go func() {
			defer wg.Done()
			select {
			case <-egressReady:
			case <-ctx.Done():
				return
			}
			m.restoreOne(ctx, s)
		}()
	}
	done := make(chan struct{})
	go func() {
		wg.Wait()
		<-egressReady // So hello carries the egress facts, also on a host without servers.
		close(done)
	}()
	select {
	case <-done:
		slog.Info("restored servers", "count", len(restored))
	case <-time.After(restoreWait + 5*time.Second):
		slog.Warn("some servers are still being restored (an image pull or a slow container); connecting to the panel meanwhile", "count", len(restored))
	case <-ctx.Done():
	}
	return nil
}

// restoreOne brings one server back; failures are logged so one broken server doesn't keep the others down.
func (m *manager) restoreOne(ctx context.Context, s *server) {
	s.op.Lock()
	defer s.op.Unlock()
	ctx, cancel := context.WithTimeout(ctx, restoreTimeout)
	defer cancel()
	if err := secureServerFolder(m.opts.Layout, s.id); err != nil {
		slog.Warn("could not make the server folder private", "server", s.id, "error", err)
	}
	if err := m.ensureContainer(ctx, s, false); err != nil {
		slog.Warn("could not bring the game container back", "server", s.id, "error", err)
	}
	s.startWatching()
	if _, err := s.waitConnected(ctx, restoreWait); err != nil {
		slog.Warn("gss-init did not answer yet; the agent keeps trying in the background", "server", s.id, "error", err)
		return
	}

	s.mu.Lock()
	autostart := s.req.Spec.Autostart && s.wantRunning && s.installed && s.status.State == protocol.ServerStateStopped
	s.mu.Unlock()
	if !autostart {
		return
	}
	slog.Info("starting the game again (autostart)", "server", s.id)
	if _, err := m.start(ctx, s); err != nil {
		slog.Warn("autostart failed", "server", s.id, "error", err)
	}
}
