// Package servers runs game servers on this host (M2): folders, images, networks, containers, the supervisor
// sockets, and the state file. The panel decides; this package carries it out.
package servers

import (
	"context"
	"fmt"
	"os"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/files"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Sink receives what servers report, for forwarding to the panel (server.console / server.state / server.stats /
// server.player / server.services events). Calls must not block for long; the panel connection buffers while
// offline.
type Sink interface {
	Console(batch protocol.ConsoleBatch)
	State(change protocol.StateChange)
	Stats(batch protocol.StatsBatch)
	Player(event protocol.PlayerEvent)
	// Services reports a changed list of stack service statuses (M3).
	Services(change protocol.ServicesChange)
	// BackupProgress reports a running backup or restore (M4; dropped while the panel is away).
	BackupProgress(progress protocol.BackupProgress)
	// BackupFinished reports the end of a backup or restore (M4; never dropped).
	BackupFinished(finished protocol.BackupFinished)
}

// TransferCloser closes a server's open file transfers (M4): a restore calls it before it swaps the data folder, so
// no upload commits into the old one. files.Transfers implements it.
type TransferCloser interface {
	CloseServer(serverID string)
}

// Manager is the agent's server lifecycle. Every method is idempotent and safe to retry after a reconnect. Expected
// failures are *protocol.RemoteError (bad_request, not_found, conflict, unsupported, or gss-init's own answer);
// anything else is an internal error.
type Manager interface {
	// Restore runs at startup: load every server folder, reattach to running containers' sockets, start autostart
	// servers that were running before a reboot. It returns once every server attached or after restoreWait at the
	// latest; slower ones (an image pull, a container that is slow to boot) go on in the background and report
	// through state changes.
	Restore(ctx context.Context) error
	// Statuses lists every server this agent manages (the hello request's `servers`).
	Statuses() []protocol.ServerStatus
	Provision(ctx context.Context, req protocol.ProvisionRequest) (protocol.ServerStatus, error)
	Start(ctx context.Context, serverID string) (protocol.ServerStatus, error)
	// Restart stops gracefully, waits for `stopped`, then starts.
	Restart(ctx context.Context, serverID string) (protocol.ServerStatus, error)
	Stop(ctx context.Context, serverID string, kill bool) (protocol.ServerStatus, error)
	Delete(ctx context.Context, serverID string, keepData bool) error
	// Update re-runs the game's update steps (steamcmd + the update hook) while it is stopped (M3); progress and
	// state arrive as state events, like an install.
	Update(ctx context.Context, serverID string) (protocol.ServerStatus, error)
	Input(ctx context.Context, serverID, line string) error
	// Backlog is the newest `limit` lines (before beforeSeq when it is > 0), within the CONSOLE_BATCH_* limits.
	Backlog(ctx context.Context, serverID string, limit, beforeSeq int64) (protocol.BacklogResponse, error)
	// Close detaches from every socket; servers keep running.
	Close() error

	// M4: file manager and backups (files.go, backup.go)

	// Files opens the server's data folder for the file manager. conflict while a restore of the server runs,
	// not_found for an unknown server. The caller closes it.
	Files(serverID string) (*files.FS, error)
	// BackupArchive opens a finished archive for download: the file and its size. not_found when missing, conflict
	// while that backup is still being written.
	BackupArchive(serverID string, backupID int64) (*os.File, int64, error)
	// CreateBackup starts a backup (backup.json `backup.create`) and returns once it has begun.
	CreateBackup(ctx context.Context, req protocol.BackupRef) (protocol.BackupOperationStatus, error)
	// RestoreBackup starts a restore (backup.json `backup.restore`) and returns once it has begun.
	RestoreBackup(ctx context.Context, req protocol.BackupRef) (protocol.BackupOperationStatus, error)
	// DeleteBackup removes an archive and its sidecar; a missing one is not an error.
	DeleteBackup(ctx context.Context, req protocol.BackupRef) error
}

// remoteError builds an error the panel receives with code and a readable message.
func remoteError(code protocol.ErrorCode, format string, args ...any) error {
	return &protocol.RemoteError{Code: code, Message: fmt.Sprintf(format, args...)}
}

func notFound(serverID string) error {
	return remoteError(protocol.ErrorCodeNotFound, "This agent does not manage server %s. Provision it first (the panel does this on create and on reconnect).", serverID)
}
