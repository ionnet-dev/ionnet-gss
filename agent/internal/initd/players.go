package initd

import (
	"regexp"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// players tracks who is online from the spec's `players` patterns (M4). Supervisor wiring (initd.go, onGameOutput
// and the game's exit): Match every game output line (plainText, ANSI stripped) while the game runs, publish the
// returned event as InitMsgPlayer, put List() into InitStatus.players, and Reset() when the game process exits (no
// leave events then). Guarded by the supervisor's mutex.
type players struct {
	join, leave *regexp.Regexp // nil = not configured
	online      []string       // join order, at most PLAYERS_MAX
}

// newPlayers compiles a PlayersSpec (nil = none). A pattern without a capture group, or not RE2, is an error (the
// spec is refused at load like a bad ready pattern).
func newPlayers(spec *protocol.PlayersSpec) (*players, error) {
	return &players{}, nil // TODO(builder)
}

// Match reports the event a line causes: a join of a new name or a leave of a listed one (name = first capture group
// cut to PLAYER_NAME_MAX_CHARS); ok is false for anything else, including a join beyond PLAYERS_MAX.
func (p *players) Match(text string) (name string, action protocol.PlayerAction, ok bool) {
	return "", "", false // TODO(builder)
}

// List is a copy of the online names in join order.
func (p *players) List() []string {
	return append([]string{}, p.online...)
}

// Reset empties the list (the game exited).
func (p *players) Reset() {
	p.online = nil
}
