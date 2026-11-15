// Package servers runs game servers on this host (M2): folders, images, networks, containers, the supervisor
// sockets, stats sampling, and the state file. The panel decides; this package carries it out.
package servers

import (
	"context"
	"errors"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrNotImplemented marks skeleton functions.
var ErrNotImplemented = errors.New("servers: not implemented")

// Sink receives what servers report, for forwarding to the panel (server.console / server.state / server.stats /
// server.player events). Calls must not block for long; the panel connection buffers while offline.
type Sink interface {
	Console(batch protocol.ConsoleBatch)
	State(change protocol.StateChange)
	Stats(batch protocol.StatsBatch)
	Player(event protocol.PlayerEvent)
}

// Manager is the agent's server lifecycle. Every method is idempotent and safe to retry after a reconnect.
type Manager interface {
	// Restore runs at startup: reattach to running containers' sockets, start autostart servers that were running
	// before a reboot.
	Restore(ctx context.Context) error
	// Statuses lists every server this agent manages (the hello request's `servers`).
	Statuses() []protocol.ServerStatus
	Provision(ctx context.Context, req protocol.ProvisionRequest) (protocol.ServerStatus, error)
	Start(ctx context.Context, serverID string) (protocol.ServerStatus, error)
	// Restart stops gracefully, waits for `stopped`, then starts.
	Restart(ctx context.Context, serverID string) (protocol.ServerStatus, error)
	Stop(ctx context.Context, serverID string, kill bool) (protocol.ServerStatus, error)
	Delete(ctx context.Context, serverID string, keepData bool) error
	Input(ctx context.Context, serverID, line string) error
	Backlog(ctx context.Context, serverID string, limit int64) ([]protocol.ConsoleLine, error)
	// Close detaches from every socket; servers keep running.
	Close() error
}
