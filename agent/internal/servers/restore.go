package servers

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/stacks"
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
		status := s.status
		status.Services = s.servicesSnapshotLocked()
		state.Servers[s.id] = savedServer{Status: status, LastSeq: s.lastSeq, InitStartedAt: s.initStarted, WantRunning: s.wantRunning, Installed: s.installed}
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
// starts autostart servers whose game was meant to be running. Game containers have no restart policy (an older
// agent's `unless-stopped` is removed here), so after a reboot nothing ran before the table. When the table can't be
// applied, restricted servers are held back: a running container is stopped, a stopped one isn't started, and the
// state says why; the watcher starts them once the rules work. Containers labelled for servers this agent has no
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
			if saved.Status.Services != nil {
				s.svc = saved.Status.Services
			}
			s.status.Services = []protocol.ServiceStatus{}
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

	// `du` containers of a measurement an earlier agent didn't finish.
	if leftovers, err := m.opts.Docker.ContainerList(ctx, LabelMeasure); err == nil {
		for _, info := range leftovers {
			if err := m.opts.Docker.ContainerRemove(ctx, info.Name); err != nil {
				slog.Warn("could not remove a leftover measuring container", "container", info.Name, "error", err)
			}
		}
	}

	egressReady := make(chan struct{})
	var blocked map[string]string
	go func() {
		defer close(egressReady)
		syncCtx, cancel := context.WithTimeout(ctx, restoreTimeout)
		defer cancel()
		blocked = m.syncEgress(syncCtx, restored)
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
			m.restoreOne(ctx, s, blocked[s.id])
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
// blocked is why a restricted server must stay down (syncEgress), or empty.
func (m *manager) restoreOne(ctx context.Context, s *server, blocked string) {
	s.op.Lock()
	defer s.op.Unlock()
	ctx, cancel := context.WithTimeout(ctx, restoreTimeout)
	defer cancel()
	if err := secureServerFolder(m.opts.Layout, s.id); err != nil {
		slog.Warn("could not make the server folder private", "server", s.id, "error", err)
	}
	// Before the container starts: an interrupted restore swap is rolled back first.
	interruptedBackup := m.recoverOperations(ctx, s)
	m.migrateRestart(ctx, s)
	if blocked != "" {
		m.holdBack(ctx, s, blocked)
		m.refreshServices(ctx, s, false)
		s.startWatching()
		return
	}
	if err := m.ensureContainer(ctx, s, false); err != nil {
		slog.Warn("could not bring the game container back", "server", s.id, "error", err)
	}
	// Hello carries the services as Docker has them now; changes after it go out as events.
	m.refreshServices(ctx, s, false)
	s.startWatching()
	if _, err := s.waitConnected(ctx, restoreWait); err != nil {
		slog.Warn("gss-init did not answer yet; the agent keeps trying in the background", "server", s.id, "error", err)
		return
	}
	if interruptedBackup {
		m.resumeAfterInterruptedBackup(s)
	}

	s.mu.Lock()
	autostart := s.req.Spec.Autostart && s.wantRunning && s.installed && s.status.State == protocol.ServerStateStopped
	wanted := s.wantRunning
	s.mu.Unlock()
	if !autostart {
		if !wanted {
			// Services left running by an agent that went away before the game had stopped.
			m.stopServicesLater(s)
		}
		return
	}
	slog.Info("starting the game again (autostart)", "server", s.id)
	if _, err := m.start(ctx, s); err != nil {
		slog.Warn("autostart failed", "server", s.id, "error", err)
	}
}

//#region Backup and restore recovery (M4)

// recoverOperations cleans up after backups and restores an earlier agent didn't finish, and reports each as failed
// (backup.finished is kept until the panel has it): a restore journal in phase "swapping" is rolled back (the old
// folders return; "done" only needs the cleanup), leftover restore-<id> folders and `.partial` archives are removed,
// paused service containers are unpaused (unpauseServices), and the data folder's upload temp files go. It reports whether a
// backup was interrupted (its `after` commands are owed to a game that still runs).
func (m *manager) recoverOperations(ctx context.Context, s *server) (interruptedBackup bool) {
	layout := m.opts.Layout
	serverDir := layout.ServerDir(s.id)
	reported := map[int64]bool{}
	report := func(operation protocol.BackupOperation, backupID int64, ok bool, message string) {
		finished := protocol.BackupFinished{ServerID: s.id, BackupID: backupID, Operation: operation, Ok: ok, At: time.Now().UTC()}
		if !ok {
			finished.Error = &message
		}
		m.opts.Sink.BackupFinished(finished)
	}

	journalFile := layout.ServerRestoreJournal(s.id)
	if raw, err := os.ReadFile(journalFile); err == nil {
		var journal restoreJournal
		if err := json.Unmarshal(raw, &journal); err != nil {
			slog.Error("the restore journal is unreadable; leaving it and the restore folders for an operator", "server", s.id, "file", journalFile, "error", err)
			return false
		}
		reported[journal.BackupID] = true
		dir := layout.ServerRestoreDir(s.id, journal.BackupID)
		if journal.Phase == journalDone {
			slog.Info("finishing a restore whose swap was complete when the agent stopped", "server", s.id, "backup", journal.BackupID)
			report(protocol.BackupOperationRestore, journal.BackupID, true, "")
		} else {
			if err := rollbackSwaps(serverDir, journal); err != nil {
				slog.Error("could not roll an interrupted restore back; leaving the journal and restore folders for an operator", "server", s.id, "backup", journal.BackupID, "error", err)
				report(protocol.BackupOperationRestore, journal.BackupID, false, fmt.Sprintf("The host's agent stopped during the restore and could not put the previous data back (%v). An operator has to fix %s by hand.", err, serverDir))
				return false
			}
			slog.Warn("rolled an interrupted restore back to the previous data", "server", s.id, "backup", journal.BackupID)
			report(protocol.BackupOperationRestore, journal.BackupID, false, "The host's agent stopped during the restore; the server's previous data was put back.")
		}
		removeJournal(layout, s.id, dir)
	} else if !errors.Is(err, os.ErrNotExist) {
		slog.Warn("could not read the restore journal", "server", s.id, "error", err)
	}

	if entries, err := os.ReadDir(serverDir); err == nil {
		for _, entry := range entries {
			raw, ok := strings.CutPrefix(entry.Name(), "restore-")
			backupID, err := strconv.ParseInt(raw, 10, 64)
			if !ok || !entry.IsDir() || err != nil {
				continue
			}
			if !reported[backupID] {
				reported[backupID] = true
				report(protocol.BackupOperationRestore, backupID, false, "The host's agent stopped while it extracted the backup; the server's data was not changed.")
			}
			if err := os.RemoveAll(filepath.Join(serverDir, entry.Name())); err != nil {
				slog.Warn("could not remove a leftover restore folder", "server", s.id, "dir", entry.Name(), "error", err)
			}
		}
	}

	if entries, err := os.ReadDir(layout.ServerBackups(s.id)); err == nil {
		for _, entry := range entries {
			raw, ok := strings.CutSuffix(entry.Name(), protocol.BackupExtension+".partial")
			backupID, err := strconv.ParseInt(raw, 10, 64)
			if !ok || err != nil {
				continue
			}
			interruptedBackup = true
			slog.Warn("removing the partial archive of a backup an earlier agent didn't finish", "server", s.id, "backup", backupID)
			if err := os.Remove(filepath.Join(layout.ServerBackups(s.id), entry.Name())); err != nil {
				slog.Warn("could not remove a partial archive", "server", s.id, "file", entry.Name(), "error", err)
			}
			report(protocol.BackupOperationCreate, backupID, false, "The host's agent restarted while the backup ran.")
		}
	}
	m.unpauseServices(ctx, s)

	if fsys, err := m.Files(s.id); err == nil {
		if err := fsys.ClearUploads(); err != nil {
			slog.Warn("could not remove leftover upload files", "server", s.id, "error", err)
		}
		fsys.Close()
	}
	return interruptedBackup
}

// unpauseServices thaws every paused service container of the server. Only a backup pauses them (for its walk of the
// volume), so a paused one at startup is left over from an agent that died mid-backup or whose unpause failed; a
// frozen database would hang the game, and `docker start` refuses a paused container.
func (m *manager) unpauseServices(ctx context.Context, s *server) {
	for _, name := range sortedServiceNames(s.services()) {
		container := stacks.ContainerName(s.id, name)
		info, exists, err := m.opts.Docker.ContainerInspect(ctx, container)
		if err != nil {
			slog.Warn("could not check a service container at startup", "server", s.id, "container", container, "error", err)
			continue
		}
		if !exists || info.Status != "paused" {
			continue
		}
		if err := m.opts.Docker.ContainerUnpause(ctx, container); err != nil {
			slog.Error("could not unpause a service a backup left paused; run `docker unpause` on it", "server", s.id, "container", container, "error", err)
			continue
		}
		slog.Warn("unpaused a service a backup had left paused", "server", s.id, "container", container)
	}
}

// resumeAfterInterruptedBackup sends the `backup.after` commands an interrupted backup owed a game that is still
// running (otherwise it would stay in save-off).
func (m *manager) resumeAfterInterruptedBackup(s *server) {
	req := s.request()
	if req.Spec.Backup == nil || len(req.Spec.Backup.After) == 0 || s.Status().State != protocol.ServerStateRunning {
		return
	}
	slog.Info("sending the backup's after commands an interrupted backup didn't send", "server", s.id)
	m.console(s, "A backup was interrupted when the host's agent restarted; sending the game its after-backup commands.")
	m.sendCommands(s, req.Spec.Backup.After)
}

//#endregion
