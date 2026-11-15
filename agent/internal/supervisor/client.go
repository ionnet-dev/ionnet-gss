// Package supervisor is the agent's client for gss-init's unix socket (M2). One Client per running server; the agent
// reconnects whenever it restarts, then calls Status and Backlog(lastSeq) to catch up.
package supervisor

import (
	"context"
	"errors"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrNotImplemented marks skeleton functions.
var ErrNotImplemented = errors.New("supervisor: not implemented")

// Event is one event from gss-init. Exactly one field is set.
type Event struct {
	Console *protocol.ConsoleLine
	State   *protocol.StateChange
	Player  *protocol.PlayerEvent
}

// Client talks to one gss-init.
type Client interface {
	Status(ctx context.Context) (protocol.InitStatus, error)
	Install(ctx context.Context) (protocol.InitStatus, error)
	Start(ctx context.Context) (protocol.InitStatus, error)
	Stop(ctx context.Context, kill bool) (protocol.InitStatus, error)
	Input(ctx context.Context, line string) error
	Backlog(ctx context.Context, afterSeq int64, limit int64) ([]protocol.ConsoleLine, error)
	Reload(ctx context.Context) error
	// Events delivers events until the socket closes; then the channel is closed.
	Events() <-chan Event
	Close() error
}

// Dial connects to the socket at path (paths.Layout.ServerSocket).
func Dial(ctx context.Context, path string) (Client, error) {
	return nil, ErrNotImplemented // TODO(builder): M2
}
