package servers

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/backups"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/stacks"
)

// Backups and restore (M4, backup.json). One operation per server (s.operation, under s.mu); it runs in its own
// goroutine with a context detached from the panel connection and reports through Sink.BackupProgress (at most every
// BACKUP_PROGRESS_INTERVAL_SEC) and exactly one Sink.BackupFinished.
//
// Create (game may run): refuse while installing/creating, while an operation runs, or when free disk on the backups
// folder is below the usage + UPLOAD_DISK_RESERVE_BYTES (no_space; the disk check's recent figure before answering,
// else a fresh measurement once it runs, so the answer never waits for a walk). Game running: send
// spec.backup.before through the supervisor, wait BACKUP_SETTLE_SEC, archive data/ (backups.Create), send
// spec.backup.after (also on failure); each services/<name> root: pause its running container (docker.ContainerPause)
// for the walk, then unpause. Write `<id>.tar.zst.partial`, fsync, rename, write the sidecar.
//
// Restore (game stopped/crashed/install_failed): hold s.op for the whole run; free disk ≥ sidecar bytes + reserve;
// opts.Transfers.CloseServer; extract into Layout.ServerRestoreDir (data/, services/<name>/); stop the stack's
// services and the game container; journal (Layout.ServerRestoreJournal) then rename data → restore-<id>/old/data and
// restore-<id>/data → data (same for each service volume in the archive); start the game container again
// (ensureContainer path; gss-init reads the restored install marker, the game stays stopped); remove the journal and
// the old folders. Any failure before the swap leaves the live folders untouched.
//
// While an operation runs, provision/start/restart/update/reinstall answer conflict (checkIdleLocked); stop is
// allowed during a backup (the archive goes on). Delete cancels a running backup (finished: "The server was
// deleted.") and is refused (conflict) during a restore. Restore (restore.go) at startup: rolls an interrupted swap
// back from the journal, removes restore-* folders, `.partial` archives and files.UploadTempDir leftovers.

// checkIdleLocked answers conflict when an operation runs (what names it: "start", "update"…). Caller holds s.mu.
func (s *server) checkIdleLocked(what string) error {
	if s.operation == nil {
		return nil
	}
	kind := "backup"
	if s.operation.Operation == protocol.BackupOperationRestore {
		kind = "restore"
	}
	return remoteError(protocol.ErrorCodeConflict, "A %s of this server is running, so it can't %s now. Try again when it finishes.", kind, what)
}

// checkIdle is checkIdleLocked taking s.mu. Lifecycle requests call it before they wait for s.op (a restore holds
// s.op for its whole run, so they answer at once instead of queueing behind it) and again once they hold it.
func (s *server) checkIdle(what string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkIdleLocked(what)
}

// currentOperation is a copy of the running operation, or nil.
func (s *server) currentOperation() *protocol.BackupOperationStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.operation == nil {
		return nil
	}
	op := *s.operation
	return &op
}

// opLockWait bounds how long a backup or restore request waits for a lifecycle operation (a start, a stop) to
// finish before it answers conflict.
const opLockWait = 10 * time.Second

// restoreSwapDelayEnv makes a restore wait between its renames (seconds), so crash-recovery tests can kill the
// agent mid-swap. Unset in production.
const restoreSwapDelayEnv = "GSS_TEST_RESTORE_SWAP_DELAY_SEC"

// errServerDeleted is the cancel cause of a backup whose server is being deleted.
var errServerDeleted = errors.New("The server was deleted.")

// opHandle lets Delete cancel a running backup and wait for it.
type opHandle struct {
	cancel context.CancelCauseFunc
	done   chan struct{}
}

// opHandles maps *server → *opHandle while a backup runs.
var opHandles sync.Map

// lockOp takes s.op, waiting at most opLockWait.
func (m *manager) lockOp(ctx context.Context, s *server) error {
	deadline := time.Now().Add(opLockWait)
	for !s.op.TryLock() {
		if time.Now().After(deadline) {
			return remoteError(protocol.ErrorCodeConflict, "Server %s is busy with another operation (a start, stop or settings change). Try again in a moment.", s.id)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(50 * time.Millisecond):
		}
	}
	return nil
}

func validBackupRef(req protocol.BackupRef) error {
	if req.BackupID <= 0 {
		return remoteError(protocol.ErrorCodeBadRequest, "backupId must be a positive whole number.")
	}
	return nil
}

//#region Create

func (m *manager) CreateBackup(ctx context.Context, req protocol.BackupRef) (protocol.BackupOperationStatus, error) {
	s, err := m.lookup(req.ServerID)
	if err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	if err := validBackupRef(req); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	if op := s.currentOperation(); op != nil && op.Operation == protocol.BackupOperationCreate && op.BackupID == req.BackupID {
		return *op, nil // A retry after a reconnect.
	}
	if err := s.checkIdle("be backed up"); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	if err := m.lockOp(ctx, s); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	defer s.op.Unlock()
	if m.get(s.id) != s {
		return protocol.BackupOperationStatus{}, notFound(s.id)
	}

	s.mu.Lock()
	idleErr := s.checkIdleLocked("be backed up")
	state := s.status.State
	spec := s.req.Spec
	specHash := s.req.SpecHash
	s.mu.Unlock()
	if idleErr != nil {
		return protocol.BackupOperationStatus{}, idleErr
	}
	if state == protocol.ServerStateCreating || state == protocol.ServerStateInstalling || specHash == "" {
		return protocol.BackupOperationStatus{}, remoteError(protocol.ErrorCodeConflict, "Server %s is %s. Wait until the install finishes.", s.id, state)
	}
	var exclude []string
	if spec.Backup != nil {
		exclude = spec.Backup.Exclude
	}
	if _, err := backups.NewMatcher(exclude); err != nil {
		return protocol.BackupOperationStatus{}, err
	}

	layout := m.opts.Layout
	archive := layout.ServerBackupArchive(s.id, req.BackupID)
	if _, err := os.Lstat(archive); err == nil {
		return protocol.BackupOperationStatus{}, remoteError(protocol.ErrorCodeConflict, "Backup %d already exists on the host.", req.BackupID)
	}
	if err := os.MkdirAll(layout.ServerBackups(s.id), 0o700); err != nil {
		return protocol.BackupOperationStatus{}, fmt.Errorf("create the backups folder: %w", err)
	}
	// The answer must come well within the panel's request timeout, so a fresh walk of data/ and services/ waits for
	// runBackup: a recent disk-check figure is used here when there is one (no_space refuses right away), otherwise
	// the estimate and the free-space check come once the backup runs (a full disk then fails it).
	var total *int64
	if used, at := s.lastDisk(); !at.IsZero() && time.Since(at) < 2*diskInterval {
		if err := checkFreeDisk(layout.ServerBackups(s.id), used); err != nil {
			return protocol.BackupOperationStatus{}, err
		}
		total = &used
	}

	op := &protocol.BackupOperationStatus{ServerID: s.id, BackupID: req.BackupID, Operation: protocol.BackupOperationCreate, StartedAt: time.Now().UTC(), TotalBytes: total}
	runCtx, cancel := context.WithCancelCause(context.Background())
	handle := &opHandle{cancel: cancel, done: make(chan struct{})}
	opHandles.Store(s, handle)
	s.mu.Lock()
	s.operation = op
	status := *op
	s.mu.Unlock()
	slog.Info("backup started", "server", s.id, "backup", req.BackupID, "running", state == protocol.ServerStateRunning)
	go m.runBackup(runCtx, s, handle, status, spec, specHash, state == protocol.ServerStateRunning)
	return status, nil
}

// runBackup writes the archive and reports the end. It never holds s.op: stop stays possible meanwhile.
func (m *manager) runBackup(ctx context.Context, s *server, handle *opHandle, op protocol.BackupOperationStatus, spec protocol.ServerSpec, specHash string, running bool) {
	defer close(handle.done)
	defer handle.cancel(nil)
	var err error
	if op.TotalBytes == nil {
		used := m.measureDisk(s)
		op.TotalBytes = &used
		s.mu.Lock()
		if s.operation != nil && s.operation.BackupID == op.BackupID {
			s.operation.TotalBytes = &used
		}
		s.mu.Unlock()
		err = checkFreeDisk(m.opts.Layout.ServerBackups(s.id), used)
	}
	var result backups.Result
	var size int64
	if err == nil {
		result, size, err = m.writeBackup(ctx, s, op, spec, specHash, running)
	}
	message := m.readableError(ctx, s, err, op)
	m.finishOperation(s, op, err == nil, sizeOrNil(err, size), message)
	if err != nil {
		slog.Warn("backup failed", "server", s.id, "backup", op.BackupID, "error", err)
		m.console(s, fmt.Sprintf("Backup %d failed: %s", op.BackupID, message))
		return
	}
	slog.Info("backup finished", "server", s.id, "backup", op.BackupID, "files", result.Files, "bytes", result.Bytes, "sizeBytes", size, "changed", result.Changed)
	note := ""
	if result.Changed > 0 {
		note = fmt.Sprintf(" (%d files changed while they were read)", result.Changed)
	}
	m.console(s, fmt.Sprintf("Backup %d finished: %d files, %s archived as %s%s.", op.BackupID, result.Files, formatBytes(result.Bytes), formatBytes(size), note))
}

func sizeOrNil(err error, size int64) *int64 {
	if err != nil {
		return nil
	}
	return &size
}

// writeBackup does the work of a backup: commands, archive, sidecar. A failure leaves no archive behind.
func (m *manager) writeBackup(ctx context.Context, s *server, op protocol.BackupOperationStatus, spec protocol.ServerSpec, specHash string, running bool) (backups.Result, int64, error) {
	layout := m.opts.Layout
	archive := layout.ServerBackupArchive(s.id, op.BackupID)
	partial := archive + ".partial"
	if err := os.Remove(partial); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return backups.Result{}, 0, fmt.Errorf("remove an old partial archive: %w", err)
	}
	f, err := os.OpenFile(partial, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return backups.Result{}, 0, fmt.Errorf("create the archive: %w", err)
	}
	complete := false
	defer func() {
		if !complete {
			f.Close()
			if err := os.Remove(partial); err != nil && !errors.Is(err, fs.ErrNotExist) {
				slog.Warn("could not remove a partial archive", "file", partial, "error", err)
			}
		}
	}()

	var before, after, exclude []string
	if spec.Backup != nil {
		before, after, exclude = spec.Backup.Before, spec.Backup.After, spec.Backup.Exclude
	}
	commanded := running && len(before) > 0
	sendAfter := sync.OnceFunc(func() {
		if commanded && len(after) > 0 {
			m.sendCommands(s, after)
		}
	})
	defer sendAfter() // Also after a failure: the game must not stay in save-off.
	if commanded {
		m.console(s, fmt.Sprintf("Backup %d: sending the save commands, then waiting %d s for the game to write its files.", op.BackupID, protocol.BackupSettleSec))
		m.sendCommands(s, before)
		select {
		case <-ctx.Done():
			return backups.Result{}, 0, context.Cause(ctx)
		case <-time.After(protocol.BackupSettleSec * time.Second):
		}
	}

	roots := []backups.Root{{Name: backups.DataRoot, Dir: layout.ServerData(s.id)}}
	for _, name := range sortedServiceNames(spec.Services) {
		dir := layout.ServerServiceVolume(s.id, name)
		if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
			continue // Never started, so there is nothing to keep.
		}
		roots = append(roots, m.serviceRoot(s, op.BackupID, name, dir))
	}
	progress := m.progressReporter(s, op)
	w := bufio.NewWriterSize(f, 1<<20)
	result, err := backups.Create(ctx, w, backups.CreateOptions{
		Manifest: protocol.BackupManifest{
			Format:     protocol.BackupFormatVersion,
			ServerID:   s.id,
			BackupID:   op.BackupID,
			CreatedAt:  op.StartedAt,
			Definition: spec.Definition,
			SpecHash:   specHash,
			Running:    commanded,
		},
		Roots:    roots,
		Exclude:  exclude,
		Progress: progress,
		AfterRoot: func(name string) {
			if name == backups.DataRoot {
				sendAfter()
			}
		},
	})
	if err != nil {
		return result, 0, err
	}
	if err := w.Flush(); err != nil {
		return result, 0, fmt.Errorf("write the archive: %w", err)
	}
	if err := f.Sync(); err != nil {
		return result, 0, fmt.Errorf("write the archive: %w", err)
	}
	if err := f.Close(); err != nil {
		return result, 0, fmt.Errorf("write the archive: %w", err)
	}
	info, err := os.Stat(partial)
	if err != nil {
		return result, 0, fmt.Errorf("read the archive: %w", err)
	}
	if err := ctx.Err(); err != nil {
		return result, 0, context.Cause(ctx)
	}
	if err := os.Rename(partial, archive); err != nil {
		return result, 0, fmt.Errorf("finish the archive: %w", err)
	}
	complete = true
	sidecar := protocol.BackupSidecar{Bytes: result.Bytes, Files: result.Files, SizeBytes: info.Size(), FinishedAt: time.Now().UTC()}
	sidecar.Manifest = protocol.BackupManifest{Format: protocol.BackupFormatVersion, ServerID: s.id, BackupID: op.BackupID, CreatedAt: op.StartedAt, Definition: spec.Definition, SpecHash: specHash, Roots: rootNames(roots), Running: commanded}
	raw, err := json.MarshalIndent(sidecar, "", "  ")
	if err == nil {
		err = writeFileAtomic(layout.ServerBackupSidecar(s.id, op.BackupID), append(raw, '\n'), 0o600)
	}
	if err == nil {
		err = syncDir(layout.ServerBackups(s.id))
	}
	if err != nil {
		// Without its sidecar the archive can't be restored; don't keep half a backup.
		os.Remove(archive)
		return result, 0, fmt.Errorf("write the backup's sidecar: %w", err)
	}
	return result, info.Size(), nil
}

// serviceRoot archives a stack service's volume, pausing its container while it runs (a crash-consistent copy).
func (m *manager) serviceRoot(s *server, backupID int64, name, dir string) backups.Root {
	container := stacks.ContainerName(s.id, name)
	paused := false
	return backups.Root{
		Name: backups.ServicesPrefix + name,
		Dir:  dir,
		Before: func(ctx context.Context) error {
			info, exists, err := m.opts.Docker.ContainerInspect(ctx, container)
			if err != nil {
				return fmt.Errorf("Could not check the service %s before archiving its data: %w", name, err)
			}
			if !exists || (info.Status != "running" && info.Status != "paused") {
				return nil // Stopped: its files don't change.
			}
			// Unpause afterwards even when the pause reports an error (it may have half applied), and also when it is
			// paused already: only the agent pauses its own services, so that is a backup's pause whose unpause
			// failed, and the service must not stay frozen.
			paused = true
			if info.Status == "paused" {
				return nil
			}
			if err := m.opts.Docker.ContainerPause(ctx, container); err != nil {
				return fmt.Errorf("Could not pause the service %s, so its data can't be copied consistently: %w", name, err)
			}
			m.console(s, fmt.Sprintf("Backup %d: paused the service %s while its data is archived.", backupID, name))
			return nil
		},
		After: func(ctx context.Context) {
			if !paused {
				return
			}
			var err error
			for attempt := 0; attempt < 3; attempt++ {
				unpauseCtx, cancel := context.WithTimeout(ctx, requestTimeout)
				err = m.opts.Docker.ContainerUnpause(unpauseCtx, container)
				cancel()
				if err == nil {
					m.console(s, fmt.Sprintf("Backup %d: resumed the service %s.", backupID, name))
					return
				}
				time.Sleep(time.Second)
			}
			slog.Error("could not unpause a service after its backup; run `docker unpause` on it", "server", s.id, "container", container, "error", err)
			m.console(s, fmt.Sprintf("Backup %d: could not resume the service %s (%v). Its container stays paused until `docker unpause %s` is run on the host.", backupID, name, err, container))
		},
	}
}

// sendCommands types console commands into the running game (backup.before / backup.after). Failures are shown in
// the console and don't fail the backup.
func (m *manager) sendCommands(s *server, lines []string) {
	client := s.connected()
	if client == nil {
		m.console(s, fmt.Sprintf("Backup: could not send %q to the game: gss-init is not connected.", strings.Join(lines, "; ")))
		return
	}
	for _, line := range lines {
		ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
		err := client.Input(ctx, line)
		cancel()
		if err != nil {
			slog.Warn("could not send a backup command to the game", "server", s.id, "command", line, "error", err)
			m.console(s, fmt.Sprintf("Backup: could not send %q to the game: %v", line, err))
		}
	}
}

//#endregion

//#region Download and delete

func (m *manager) BackupArchive(serverID string, backupID int64) (*os.File, int64, error) {
	s, err := m.lookup(serverID)
	if err != nil {
		return nil, 0, err
	}
	if backupID <= 0 {
		return nil, 0, remoteError(protocol.ErrorCodeBadRequest, "backupId must be a positive whole number.")
	}
	if op := s.currentOperation(); op != nil && op.Operation == protocol.BackupOperationCreate && op.BackupID == backupID {
		return nil, 0, remoteError(protocol.ErrorCodeConflict, "Backup %d is still being written. Download it once it is done.", backupID)
	}
	f, err := os.Open(m.opts.Layout.ServerBackupArchive(serverID, backupID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0, remoteError(protocol.ErrorCodeNotFound, "Backup %d is not on the host (it was deleted, or never finished).", backupID)
	}
	if err != nil {
		return nil, 0, fmt.Errorf("open backup %d: %w", backupID, err)
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, 0, fmt.Errorf("read backup %d: %w", backupID, err)
	}
	return f, info.Size(), nil
}

func (m *manager) DeleteBackup(ctx context.Context, req protocol.BackupRef) error {
	s, err := m.lookup(req.ServerID)
	if err != nil {
		return err
	}
	if err := validBackupRef(req); err != nil {
		return err
	}
	if op := s.currentOperation(); op != nil && op.BackupID == req.BackupID {
		verb := "created"
		if op.Operation == protocol.BackupOperationRestore {
			verb = "restored"
		}
		return remoteError(protocol.ErrorCodeConflict, "Backup %d is being %s right now. Delete it once that finishes.", req.BackupID, verb)
	}
	archive := m.opts.Layout.ServerBackupArchive(s.id, req.BackupID)
	var errs []error
	for _, file := range []string{archive, archive + ".partial", m.opts.Layout.ServerBackupSidecar(s.id, req.BackupID)} {
		if err := os.Remove(file); err != nil && !errors.Is(err, fs.ErrNotExist) {
			errs = append(errs, err)
		}
	}
	if err := errors.Join(errs...); err != nil {
		return fmt.Errorf("delete backup %d: %w", req.BackupID, err)
	}
	slog.Info("deleted backup", "server", s.id, "backup", req.BackupID)
	return nil
}

// cancelBackup is Delete's part: a running backup is cancelled and awaited (its partial archive removed), a running
// restore refuses the delete.
func (m *manager) cancelBackup(ctx context.Context, s *server) error {
	op := s.currentOperation()
	if op == nil {
		return nil
	}
	if op.Operation == protocol.BackupOperationRestore {
		return remoteError(protocol.ErrorCodeConflict, "A restore of server %s is running. Delete the server once it finishes.", s.id)
	}
	value, ok := opHandles.Load(s)
	if !ok {
		return nil
	}
	handle := value.(*opHandle)
	handle.cancel(errServerDeleted)
	select {
	case <-handle.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

//#endregion

//#region Restore

// restoreJournal is `<server>/restore.json`: the renames of a restore's swap, relative to the server folder.
type restoreJournal struct {
	BackupID int64 `json:"backupId"`
	// Phase "swapping" is rolled back at startup; "done" only needs the old folders removed.
	Phase string        `json:"phase"`
	Swaps []restoreSwap `json:"swaps"`
}

type restoreSwap struct {
	Live    string `json:"live"`    // e.g. data
	New     string `json:"new"`     // restore-<id>/data
	Old     string `json:"old"`     // restore-<id>/old/data
	HadLive bool   `json:"hadLive"` // the live folder existed before the swap
	// Clear: the backup has no such folder, so the live one is only moved aside (New is never created). See
	// planSwaps.
	Clear bool `json:"clear,omitempty"`
}

const (
	journalSwapping = "swapping"
	journalDone     = "done"
)

func (m *manager) RestoreBackup(ctx context.Context, req protocol.BackupRef) (protocol.BackupOperationStatus, error) {
	s, err := m.lookup(req.ServerID)
	if err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	if err := validBackupRef(req); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	if op := s.currentOperation(); op != nil && op.Operation == protocol.BackupOperationRestore && op.BackupID == req.BackupID {
		return *op, nil
	}
	if err := s.checkIdle("be restored"); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	sidecar, err := m.readSidecar(s.id, req.BackupID)
	if err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	if err := m.lockOp(ctx, s); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	handedOff := false
	defer func() {
		if !handedOff {
			s.op.Unlock()
		}
	}()
	if m.get(s.id) != s {
		return protocol.BackupOperationStatus{}, notFound(s.id)
	}
	s.mu.Lock()
	idleErr := s.checkIdleLocked("be restored")
	state := s.status.State
	s.mu.Unlock()
	if idleErr != nil {
		return protocol.BackupOperationStatus{}, idleErr
	}
	if state != protocol.ServerStateStopped && state != protocol.ServerStateCrashed && state != protocol.ServerStateInstallFailed {
		return protocol.BackupOperationStatus{}, remoteError(protocol.ErrorCodeConflict, "Server %s is %s. Stop the server first.", s.id, state)
	}
	if err := checkFreeDisk(m.opts.Layout.ServerDir(s.id), sidecar.Bytes); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	total := sidecar.Bytes
	op := &protocol.BackupOperationStatus{ServerID: s.id, BackupID: req.BackupID, Operation: protocol.BackupOperationRestore, StartedAt: time.Now().UTC(), TotalBytes: &total}
	s.mu.Lock()
	s.operation = op
	status := *op
	s.mu.Unlock()
	handedOff = true
	slog.Info("restore started", "server", s.id, "backup", req.BackupID)
	go m.runRestore(s, status)
	return status, nil
}

// readSidecar reads a finished backup's sidecar: not_found without the archive, conflict without the sidecar.
func (m *manager) readSidecar(serverID string, backupID int64) (protocol.BackupSidecar, error) {
	var sidecar protocol.BackupSidecar
	if _, err := os.Stat(m.opts.Layout.ServerBackupArchive(serverID, backupID)); errors.Is(err, fs.ErrNotExist) {
		return sidecar, remoteError(protocol.ErrorCodeNotFound, "Backup %d is not on the host (it was deleted, or never finished).", backupID)
	}
	raw, err := os.ReadFile(m.opts.Layout.ServerBackupSidecar(serverID, backupID))
	if err == nil {
		err = json.Unmarshal(raw, &sidecar)
	}
	if err != nil {
		return sidecar, remoteError(protocol.ErrorCodeConflict, "Backup %d is incomplete on the host (its sidecar is missing or unreadable), so it can't be restored. Make a new backup.", backupID)
	}
	return sidecar, nil
}

// runRestore runs a restore with s.op held (taken by RestoreBackup) and reports the end.
func (m *manager) runRestore(s *server, op protocol.BackupOperationStatus) {
	defer s.op.Unlock()
	ctx := context.Background()
	err := m.restore(ctx, s, op)
	message := m.readableError(ctx, s, err, op)
	m.finishOperation(s, op, err == nil, nil, message)
	if err != nil {
		slog.Warn("restore failed", "server", s.id, "backup", op.BackupID, "error", err)
		m.console(s, fmt.Sprintf("Restore of backup %d failed: %s", op.BackupID, message))
		return
	}
	slog.Info("restore finished", "server", s.id, "backup", op.BackupID)
	m.console(s, fmt.Sprintf("Restored backup %d. The server is stopped; start it when you are ready.", op.BackupID))
}

func (m *manager) restore(ctx context.Context, s *server, op protocol.BackupOperationStatus) error {
	layout := m.opts.Layout
	dir := layout.ServerRestoreDir(s.id, op.BackupID)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove an earlier restore folder: %w", err)
	}
	extracted := false
	defer func() {
		if !extracted {
			if err := os.RemoveAll(dir); err != nil {
				slog.Warn("could not remove the restore folder", "dir", dir, "error", err)
			}
		}
	}()
	if m.opts.Transfers != nil {
		m.opts.Transfers.CloseServer(s.id)
	}
	m.console(s, fmt.Sprintf("Restoring backup %d: extracting it beside the current data.", op.BackupID))

	archive := layout.ServerBackupArchive(s.id, op.BackupID)
	f, err := os.Open(archive)
	if err != nil {
		return fmt.Errorf("open backup %d: %w", op.BackupID, err)
	}
	manifest, err := backups.ReadManifest(bufio.NewReader(f))
	if err != nil {
		f.Close()
		return err
	}
	if manifest.ServerID != s.id {
		f.Close()
		return fmt.Errorf("Backup %d belongs to another server (%s).", op.BackupID, manifest.ServerID)
	}
	if _, err := f.Seek(0, 0); err != nil {
		f.Close()
		return fmt.Errorf("read backup %d: %w", op.BackupID, err)
	}
	dest := map[string]string{backups.DataRoot: filepath.Join(dir, backups.DataRoot)}
	for name := range s.services() {
		root := backups.ServicesPrefix + name
		dest[root] = filepath.Join(dir, filepath.FromSlash(root))
	}
	_, err = backups.Extract(ctx, bufio.NewReaderSize(f, 1<<20), backups.ExtractOptions{Dest: dest, Progress: m.progressReporter(s, op)})
	f.Close()
	if err != nil {
		return err
	}
	swaps := planSwaps(filepath.Base(dir), manifest.Roots, sortedServiceNames(s.services()))
	if _, ok := dest[backups.DataRoot]; ok {
		if err := prepareDataDir(dest[backups.DataRoot]); err != nil {
			return err
		}
	}
	syscall.Sync() // Every extracted file is on disk before the old ones go.

	// Containers down: gss-init's /data bind mount pins the old folder, and a database must not write while its
	// volume moves. revive and the watcher wait for s.op, which this restore holds.
	m.console(s, fmt.Sprintf("Restoring backup %d: stopping the containers and swapping the folders.", op.BackupID))
	stopCtx, cancel := context.WithTimeout(ctx, s.stopTimeout()+stopGrace+time.Minute)
	defer cancel()
	containerStopped := true
	defer func() {
		if containerStopped {
			m.restartAfterRestore(ctx, s)
		}
	}()
	if err := m.opts.Docker.ContainerStop(stopCtx, ContainerName(s.id), s.stopTimeout()+stopGrace); err != nil {
		return err
	}
	if s.hasServices() {
		if err := m.opts.Stacks.Stop(stopCtx, s.id); err != nil {
			return err
		}
	}

	serverDir := layout.ServerDir(s.id)
	swaps = withLiveState(serverDir, swaps)
	journal := restoreJournal{BackupID: op.BackupID, Phase: journalSwapping, Swaps: swaps}
	if err := writeJournal(layout.ServerRestoreJournal(s.id), journal); err != nil {
		return err
	}
	extracted = true // The restore folder now belongs to the journal (rollback or cleanup).
	if err := swapFolders(serverDir, swaps); err != nil {
		if rollbackErr := rollbackSwaps(serverDir, journal); rollbackErr != nil {
			// Keep the containers down: a bind mount would create an empty folder where the data belongs.
			containerStopped = false
			slog.Error("could not roll a failed restore back; the agent retries at its next start", "server", s.id, "error", rollbackErr)
			return fmt.Errorf("%w; rolling back failed too (%v), the agent retries when it restarts", err, rollbackErr)
		}
		removeJournal(layout, s.id, dir)
		return err
	}
	journal.Phase = journalDone
	if err := writeJournal(layout.ServerRestoreJournal(s.id), journal); err != nil {
		slog.Warn("could not mark the restore journal done", "server", s.id, "error", err)
	}
	containerStopped = false
	m.restartAfterRestore(ctx, s)
	removeJournal(layout, s.id, dir)
	return nil
}

// planSwaps lists the renames of a restore: every archive root the server still has (extracted below restoreRel), and
// a Clear swap for each current service the archive has no `services/<name>` for. A backup archives every service
// volume that exists (a volume it can't read fails the backup), so a missing one means the service had no data then:
// it was added to the server later or had never started. Leaving today's database beside an older world would mix two
// points in time, so the faithful restore is "no volume": the current one moves aside with the old data, and the
// service starts from an empty folder (stacks creates and hands it over on the next start, like a first start).
// Archive roots for services the server no longer has are skipped.
func planSwaps(restoreRel string, roots, services []string) []restoreSwap {
	have := map[string]bool{backups.DataRoot: true}
	for _, name := range services {
		have[backups.ServicesPrefix+name] = true
	}
	inArchive := map[string]bool{}
	var swaps []restoreSwap
	for _, root := range roots {
		inArchive[root] = true
		if !have[root] {
			slog.Info("skipping a folder of the backup the server no longer has", "root", root)
			continue
		}
		rel := filepath.FromSlash(root)
		swaps = append(swaps, restoreSwap{Live: rel, New: filepath.Join(restoreRel, rel), Old: filepath.Join(restoreRel, "old", rel)})
	}
	for _, name := range services {
		root := backups.ServicesPrefix + name
		if inArchive[root] {
			continue
		}
		rel := filepath.FromSlash(root)
		swaps = append(swaps, restoreSwap{Live: rel, New: filepath.Join(restoreRel, rel), Old: filepath.Join(restoreRel, "old", rel), Clear: true})
	}
	return swaps
}

// withLiveState records which live folders exist before the swap and drops Clear swaps without one (nothing to move
// aside).
func withLiveState(serverDir string, swaps []restoreSwap) []restoreSwap {
	out := swaps[:0]
	for _, swap := range swaps {
		swap.HadLive = exists(filepath.Join(serverDir, swap.Live))
		if swap.Clear && !swap.HadLive {
			continue
		}
		out = append(out, swap)
	}
	return out
}

// swapFolders moves each live folder into the restore folder's old/ and the extracted one into place.
func swapFolders(serverDir string, swaps []restoreSwap) error {
	delay := time.Duration(0)
	if raw := os.Getenv(restoreSwapDelayEnv); raw != "" {
		if sec, err := strconv.Atoi(raw); err == nil && sec > 0 {
			delay = time.Duration(sec) * time.Second
		}
	}
	for _, swap := range swaps {
		live, next, old := filepath.Join(serverDir, swap.Live), filepath.Join(serverDir, swap.New), filepath.Join(serverDir, swap.Old)
		if err := os.MkdirAll(filepath.Dir(old), 0o700); err != nil {
			return fmt.Errorf("prepare the swap of %s: %w", swap.Live, err)
		}
		if swap.HadLive {
			if err := os.Rename(live, old); err != nil {
				return fmt.Errorf("move the current %s aside: %w", swap.Live, err)
			}
		}
		if delay > 0 {
			slog.Warn("test hook: waiting between the restore's renames", "env", restoreSwapDelayEnv, "delay", delay)
			time.Sleep(delay)
		}
		if swap.Clear {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(live), 0o755); err != nil {
			return fmt.Errorf("prepare the swap of %s: %w", swap.Live, err)
		}
		if err := os.Rename(next, live); err != nil {
			return fmt.Errorf("move the restored %s into place: %w", swap.Live, err)
		}
	}
	if err := syncDir(serverDir); err != nil {
		return err
	}
	return nil
}

// rollbackSwaps undoes the renames of a journal, last first. Each step checks what is on disk, so it can run again
// after it was interrupted itself.
func rollbackSwaps(serverDir string, journal restoreJournal) error {
	var errs []error
	for i := len(journal.Swaps) - 1; i >= 0; i-- {
		swap := journal.Swaps[i]
		if !cleanRelative(swap.Live) || !cleanRelative(swap.New) || !cleanRelative(swap.Old) {
			errs = append(errs, fmt.Errorf("the restore journal names a path outside the server folder: %+v", swap))
			continue
		}
		live, next, old := filepath.Join(serverDir, swap.Live), filepath.Join(serverDir, swap.New), filepath.Join(serverDir, swap.Old)
		oldExists, liveExists, newExists := exists(old), exists(live), exists(next)
		switch {
		case oldExists:
			if liveExists {
				if newExists || swap.Clear {
					errs = append(errs, fmt.Errorf("both %s and %s exist; leaving them for an operator", live, next))
					continue
				}
				if err := os.Rename(live, next); err != nil {
					errs = append(errs, err)
					continue
				}
			}
			if err := os.Rename(old, live); err != nil {
				errs = append(errs, err)
			}
		case !swap.HadLive && liveExists && !newExists:
			if err := os.Rename(live, next); err != nil {
				errs = append(errs, err)
			}
		}
	}
	if len(errs) == 0 {
		if err := syncDir(serverDir); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// restartAfterRestore starts the game container again (gss-init re-reads the restored install marker; the game
// stays stopped). A failure is left to the watcher, which revives a stopped container.
func (m *manager) restartAfterRestore(ctx context.Context, s *server) {
	s.resetConsole()
	startCtx, cancel := context.WithTimeout(ctx, restoreTimeout)
	defer cancel()
	if err := m.ensureContainer(startCtx, s, false); err != nil {
		slog.Warn("could not start the game container after the restore; the agent retries", "server", s.id, "error", err)
		return
	}
	s.startWatching()
}

func writeJournal(file string, journal restoreJournal) error {
	raw, err := json.MarshalIndent(journal, "", "  ")
	if err != nil {
		return fmt.Errorf("encode the restore journal: %w", err)
	}
	if err := writeFileAtomic(file, append(raw, '\n'), 0o600); err != nil {
		return err
	}
	return syncDir(filepath.Dir(file))
}

// removeJournal removes the journal, then the restore folder with the old data.
func removeJournal(layout paths.Layout, serverID, dir string) {
	if err := os.Remove(layout.ServerRestoreJournal(serverID)); err != nil && !errors.Is(err, fs.ErrNotExist) {
		slog.Warn("could not remove the restore journal", "server", serverID, "error", err)
	}
	if err := os.RemoveAll(dir); err != nil {
		slog.Warn("could not remove the folders a restore replaced; the agent retries at its next start", "dir", dir, "error", err)
	}
}

//#endregion

//#region Shared

// finishOperation clears s.operation and reports the end (the panel may start the next operation right away).
func (m *manager) finishOperation(s *server, op protocol.BackupOperationStatus, ok bool, size *int64, message string) {
	s.mu.Lock()
	if s.operation != nil && s.operation.BackupID == op.BackupID {
		s.operation = nil
	}
	s.mu.Unlock()
	opHandles.Delete(s)
	finished := protocol.BackupFinished{ServerID: s.id, BackupID: op.BackupID, Operation: op.Operation, Ok: ok, SizeBytes: size, At: time.Now().UTC()}
	if !ok {
		finished.Error = &message
	}
	m.opts.Sink.BackupFinished(finished)
}

// progressReporter keeps s.operation's bytes current and sends at most one progress event per interval.
func (m *manager) progressReporter(s *server, op protocol.BackupOperationStatus) func(bytes int64) {
	var last time.Time
	return func(bytes int64) {
		s.mu.Lock()
		if s.operation != nil && s.operation.BackupID == op.BackupID {
			s.operation.Bytes = bytes
		}
		s.mu.Unlock()
		if time.Since(last) < protocol.BackupProgressIntervalSec*time.Second {
			return
		}
		last = time.Now()
		m.opts.Sink.BackupProgress(protocol.BackupProgress{ServerID: s.id, BackupID: op.BackupID, Operation: op.Operation, Bytes: bytes, TotalBytes: op.TotalBytes, At: last.UTC()})
	}
}

// readableError is the message a failed operation reports to the panel.
func (m *manager) readableError(ctx context.Context, s *server, err error, op protocol.BackupOperationStatus) string {
	if err == nil {
		return ""
	}
	if errors.Is(context.Cause(ctx), errServerDeleted) || errors.Is(err, errServerDeleted) {
		return errServerDeleted.Error()
	}
	if errors.Is(err, syscall.ENOSPC) {
		dir := m.opts.Layout.ServerBackups(s.id)
		need := int64(0)
		if op.TotalBytes != nil {
			need = *op.TotalBytes
		}
		if op.Operation == protocol.BackupOperationRestore {
			dir = m.opts.Layout.ServerDir(s.id)
		}
		free, _ := freeBytes(dir)
		return fmt.Sprintf("The host's disk is full (%s free, about %s needed). Free some space and try again.", formatBytes(free), formatBytes(need+protocol.UploadDiskReserveBytes))
	}
	if errors.Is(err, fs.ErrPermission) {
		return fmt.Sprintf("The agent may not read or write some of the server's files (%v). Run gss-agent as root to back up or restore this server.", err)
	}
	var remote *protocol.RemoteError
	if errors.As(err, &remote) {
		return remote.Message
	}
	message := err.Error()
	if message == "" || message[0] < 'a' || message[0] > 'z' {
		return message // Already a sentence written for the user.
	}
	what := "backup"
	if op.Operation == protocol.BackupOperationRestore {
		what = "restore"
	}
	return fmt.Sprintf("The %s failed: %s.", what, message)
}

// checkFreeDisk answers no_space unless dir's filesystem has need + UPLOAD_DISK_RESERVE_BYTES free.
func checkFreeDisk(dir string, need int64) error {
	free, err := freeBytes(dir)
	if err != nil {
		return fmt.Errorf("check the free disk space: %w", err)
	}
	want := need + protocol.UploadDiskReserveBytes
	if free < want {
		return remoteError(protocol.ErrorCodeNoSpace, "The host's disk is full (%s free, about %s needed). Free some space or delete old backups first.", formatBytes(free), formatBytes(want))
	}
	return nil
}

func freeBytes(dir string) (int64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(dir, &st); err != nil {
		return 0, err
	}
	return int64(st.Bavail) * int64(st.Bsize), nil
}

// formatBytes is a short readable size: 2.1 GB, 340 MB, 12 KB.
func formatBytes(n int64) string {
	const unit = 1000
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	value, suffix := float64(n), ""
	for _, s := range []string{"KB", "MB", "GB", "TB"} {
		value /= unit
		suffix = s
		if value < unit {
			break
		}
	}
	if value < 10 {
		return fmt.Sprintf("%.1f %s", value, suffix)
	}
	return fmt.Sprintf("%.0f %s", value, suffix)
}

func syncDir(dir string) error {
	f, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("sync %s: %w", dir, err)
	}
	defer f.Close()
	if err := f.Sync(); err != nil {
		return fmt.Errorf("sync %s: %w", dir, err)
	}
	return nil
}

func exists(file string) bool {
	_, err := os.Lstat(file)
	return err == nil
}

func cleanRelative(p string) bool {
	return p != "" && !filepath.IsAbs(p) && filepath.Clean(p) == p && p != ".." && !strings.HasPrefix(p, ".."+string(filepath.Separator))
}

func sortedServiceNames(services map[string]protocol.ServiceSpec) []string {
	names := make([]string, 0, len(services))
	for name := range services {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

func rootNames(roots []backups.Root) []string {
	names := make([]string, 0, len(roots))
	for _, root := range roots {
		names = append(names, root.Name)
	}
	return names
}

//#endregion
