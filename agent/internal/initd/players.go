package initd

import (
	"fmt"
	"regexp"
	"slices"
	"strings"

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
	p := &players{}
	if spec == nil {
		return p, nil
	}
	compile := func(key, pattern string) (*regexp.Regexp, error) {
		if pattern == "" {
			return nil, nil
		}
		re, err := regexp.Compile(pattern)
		if err != nil {
			return nil, fmt.Errorf("players.%s pattern %q is not a valid RE2 expression: %w", key, pattern, err)
		}
		if re.NumSubexp() < 1 {
			return nil, fmt.Errorf("players.%s pattern %q has no capture group; put the player name in parentheses, e.g. '(\\w+) joined the game'", key, pattern)
		}
		return re, nil
	}
	var err error
	if p.join, err = compile("join", spec.Join); err != nil {
		return nil, err
	}
	if p.leave, err = compile("leave", spec.Leave); err != nil {
		return nil, err
	}
	return p, nil
}

// Match reports the event a line causes: a join of a new name or a leave of a listed one (name = first capture group
// cut to PLAYER_NAME_MAX_CHARS); ok is false for anything else, including a join beyond PLAYERS_MAX.
func (p *players) Match(text string) (name string, action protocol.PlayerAction, ok bool) {
	if p.join != nil {
		if name, found := firstGroup(p.join, text); found && !slices.Contains(p.online, name) && len(p.online) < protocol.PlayersMax {
			p.online = append(p.online, name)
			return name, protocol.PlayerActionJoin, true
		}
	}
	if p.leave != nil {
		if name, found := firstGroup(p.leave, text); found {
			if index := slices.Index(p.online, name); index >= 0 {
				p.online = slices.Delete(p.online, index, index+1)
				return name, protocol.PlayerActionLeave, true
			}
		}
	}
	return "", "", false
}

// firstGroup is the first capture group of the first match, trimmed and cut to PLAYER_NAME_MAX_CHARS characters;
// found is false for no match or an empty name.
func firstGroup(re *regexp.Regexp, text string) (name string, found bool) {
	match := re.FindStringSubmatch(text)
	if match == nil {
		return "", false
	}
	name = strings.TrimSpace(match[1])
	if runes := []rune(name); len(runes) > protocol.PlayerNameMaxChars {
		name = string(runes[:protocol.PlayerNameMaxChars])
	}
	return name, name != ""
}

// List is a copy of the online names in join order.
func (p *players) List() []string {
	return append([]string{}, p.online...)
}

// Reset empties the list (the game exited).
func (p *players) Reset() {
	p.online = nil
}
