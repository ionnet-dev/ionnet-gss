package initd

import (
	"context"
	"io"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// The pieces of gss-init (M2), each in its own file when implemented: reaper.go (PID 1 zombie reaping and signal
// forwarding), console.go (ring buffer), game.go (pty process), server.go (socket), and the state machine in
// initd.go. Only the interfaces are fixed here.

// Console is the ring buffer of the last protocol.InitBacklogLines lines. Append assigns seq and fans out to
// subscribers (the connected agent).
type Console interface {
	// Append records one line and returns it with seq and at set.
	Append(stream protocol.ConsoleStream, text string) protocol.ConsoleLine
	// After returns up to limit lines with seq > afterSeq, oldest first.
	After(afterSeq, limit int64) []protocol.ConsoleLine
	LastSeq() int64
	// Subscribe delivers every new line until cancel is called.
	Subscribe() (lines <-chan protocol.ConsoleLine, cancel func())
}

// Game is one run of the start command: /bin/sh -c <start> as GAME_UID in /data, under a pty, env from the spec.
type Game interface {
	// Stdin writes console input (console.input stdin).
	Stdin() io.Writer
	// Signal sends a signal by name (SIGTERM, SIGINT…).
	Signal(name string) error
	// Wait blocks until the process exits and returns its exit code.
	Wait() (int, error)
	PID() int
}

// Launcher starts a Game; output lines go to the console as stream "output".
type Launcher interface {
	Launch(ctx context.Context, spec protocol.InitSpec, console Console) (Game, error)
}

// RconClient sends console input when console.input is rcon (M2 may stub it with an error; Minecraft uses stdin).
type RconClient interface {
	Send(ctx context.Context, command string) (string, error)
}
