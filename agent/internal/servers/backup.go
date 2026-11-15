package servers

import (
	"context"
	"os"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Backups and restore (M4, backup.json). One operation per server (s.operation, under s.mu); it runs in its own
// goroutine with a context detached from the panel connection and reports through Sink.BackupProgress (at most every
// BACKUP_PROGRESS_INTERVAL_SEC) and exactly one Sink.BackupFinished.
//
// Create (game may run): refuse while installing/creating, while an operation runs, or when free disk on the backups
// folder is below the last measured usage (usedBytes) + UPLOAD_DISK_RESERVE_BYTES (no_space). Game running: send
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
	return remoteError(protocol.ErrorCodeConflict, "A %s of this server is running, so it can't %s now. Try again when it finishes.", s.operation.Operation, what)
}

func (m *manager) CreateBackup(ctx context.Context, req protocol.BackupRef) (protocol.BackupOperationStatus, error) {
	if _, err := m.lookup(req.ServerID); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	return protocol.BackupOperationStatus{}, remoteError(protocol.ErrorCodeUnsupported, "Backups are not implemented in this agent yet.") // TODO(builder)
}

func (m *manager) RestoreBackup(ctx context.Context, req protocol.BackupRef) (protocol.BackupOperationStatus, error) {
	if _, err := m.lookup(req.ServerID); err != nil {
		return protocol.BackupOperationStatus{}, err
	}
	return protocol.BackupOperationStatus{}, remoteError(protocol.ErrorCodeUnsupported, "Restore is not implemented in this agent yet.") // TODO(builder)
}

func (m *manager) DeleteBackup(ctx context.Context, req protocol.BackupRef) error {
	if _, err := m.lookup(req.ServerID); err != nil {
		return err
	}
	return remoteError(protocol.ErrorCodeUnsupported, "Backups are not implemented in this agent yet.") // TODO(builder)
}

func (m *manager) BackupArchive(serverID string, backupID int64) (*os.File, int64, error) {
	if _, err := m.lookup(serverID); err != nil {
		return nil, 0, err
	}
	return nil, 0, remoteError(protocol.ErrorCodeUnsupported, "Backups are not implemented in this agent yet.") // TODO(builder)
}
