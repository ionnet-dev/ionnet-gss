// Package initd is gss-init (M2): PID 1 in every game container. It reaps zombies, reads the spec, runs install
// steps and config appliers, runs the game on a pty as GAME_UID, keeps a console ring buffer, and serves the
// supervisor protocol on INIT_SOCKET_PATH. It keeps running and logging while the agent restarts.
package initd

import (
	"context"
	"errors"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrNotImplemented marks skeleton functions.
var ErrNotImplemented = errors.New("gss-init: not implemented")

// Options configure a Supervisor; the defaults are the protocol constants.
type Options struct {
	SpecPath   string // protocol.InitSpecPath
	FilesDir   string // protocol.InitFilesDir
	SocketPath string // protocol.InitSocketPath
	DataPath   string // protocol.InitDataPath
	GameUID    int    // protocol.GameUID
	Backlog    int    // protocol.InitBacklogLines
}

// DefaultOptions uses the paths every game container mounts.
func DefaultOptions() Options {
	return Options{
		SpecPath:   protocol.InitSpecPath,
		FilesDir:   protocol.InitFilesDir,
		SocketPath: protocol.InitSocketPath,
		DataPath:   protocol.InitDataPath,
		GameUID:    protocol.GameUID,
		Backlog:    protocol.InitBacklogLines,
	}
}

// Supervisor is the gss-init process state.
type Supervisor struct {
	Options Options
	Spec    protocol.InitSpec
}

// Run loads the spec, opens the socket and serves until ctx ends (SIGTERM from `docker stop`: stop the game
// gracefully first).
func (s *Supervisor) Run(ctx context.Context) error {
	return ErrNotImplemented // TODO(builder): M2
}
