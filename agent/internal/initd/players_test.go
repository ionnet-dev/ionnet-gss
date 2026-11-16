package initd

import (
	"fmt"
	"slices"
	"strings"
	"testing"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

var paperPlayers = &protocol.PlayersSpec{Join: `(\w+) joined the game`, Leave: `(\w+) left the game`}

func TestPlayersPaperLines(t *testing.T) {
	p, err := newPlayers(paperPlayers)
	if err != nil {
		t.Fatal(err)
	}
	steps := []struct {
		line   string
		name   string
		action protocol.PlayerAction
		ok     bool
	}{
		{"[12:34:56 INFO]: Done (4.512s)! For help, type \"help\"", "", "", false},
		{"[12:35:01 INFO]: Steve joined the game", "Steve", protocol.PlayerActionJoin, true},
		{"[12:35:01 INFO]: Steve joined the game", "", "", false}, // Duplicate join.
		{"[12:35:20 INFO]: Alex joined the game", "Alex", protocol.PlayerActionJoin, true},
		{"[12:36:10 INFO]: Nobody left the game", "", "", false}, // Never joined.
		{"[12:36:20 INFO]: Alex left the game", "Alex", protocol.PlayerActionLeave, true},
	}
	for i, step := range steps {
		name, action, ok := p.Match(step.line)
		if name != step.name || action != step.action || ok != step.ok {
			t.Fatalf("step %d (%q): got %q %q %v, want %q %q %v", i, step.line, name, action, ok, step.name, step.action, step.ok)
		}
	}
	if got := p.List(); len(got) != 1 || got[0] != "Steve" {
		t.Fatalf("list after Alex left = %v", got)
	}
	if name, _, ok := p.Match("[12:37:00 INFO]: Steve left the game"); !ok || name != "Steve" {
		t.Fatal("Steve's leave not matched")
	}
	if got := p.List(); len(got) != 0 {
		t.Fatalf("list after everyone left = %v", got)
	}
}

func TestPlayersANSIAndSource(t *testing.T) {
	p, err := newPlayers(&protocol.PlayersSpec{
		Join:  `"(.+?)<\d+><[^>]*><[^>]*>" entered the game`,
		Leave: `"(.+?)<\d+><[^>]*><[^>]*>" disconnected`,
	})
	if err != nil {
		t.Fatal(err)
	}
	join := plainText("\x1b[1;32mL 11/16/2026 - 12:00:00: \"Dr. Alice<2><STEAM_0:1:1234><>\" entered the game\x1b[0m")
	if name, action, ok := p.Match(join); !ok || name != "Dr. Alice" || action != protocol.PlayerActionJoin {
		t.Fatalf("join: %q %q %v", name, action, ok)
	}
	leave := `L 11/16/2026 - 12:30:00: "Dr. Alice<2><STEAM_0:1:1234><Unassigned>" disconnected (reason "Disconnect by user.")`
	if name, action, ok := p.Match(leave); !ok || name != "Dr. Alice" || action != protocol.PlayerActionLeave {
		t.Fatalf("leave: %q %q %v", name, action, ok)
	}
}

func TestPlayersLimitsAndReset(t *testing.T) {
	p, err := newPlayers(&protocol.PlayersSpec{Join: `\+(\S+)`, Leave: `-(\S+)`})
	if err != nil {
		t.Fatal(err)
	}
	long := strings.Repeat("é", protocol.PlayerNameMaxChars+10)
	name, _, ok := p.Match("+" + long)
	if !ok || len([]rune(name)) != protocol.PlayerNameMaxChars {
		t.Fatalf("long name cut to %d runes, ok=%v", len([]rune(name)), ok)
	}
	for i := 1; i < protocol.PlayersMax; i++ {
		if _, _, ok := p.Match(fmt.Sprintf("+p%d", i)); !ok {
			t.Fatalf("join %d refused below the limit", i)
		}
	}
	if _, _, ok := p.Match("+overflow"); ok {
		t.Fatal("join beyond PLAYERS_MAX was accepted")
	}
	if len(p.List()) != protocol.PlayersMax {
		t.Fatalf("list has %d names", len(p.List()))
	}
	if _, _, ok := p.Match("-p1"); !ok {
		t.Fatal("leave refused")
	}
	if _, _, ok := p.Match("+overflow"); !ok {
		t.Fatal("join refused after a slot freed")
	}
	if got := p.List(); got[len(got)-1] != "overflow" || slices.Contains(got, "p1") {
		t.Fatal("list order or content wrong after leave and join")
	}
	p.Reset()
	if len(p.List()) != 0 {
		t.Fatal("reset left names")
	}
}

func TestPlayersPatternValidation(t *testing.T) {
	if _, err := newPlayers(&protocol.PlayersSpec{Join: `joined the game`}); err == nil || !strings.Contains(err.Error(), "capture group") {
		t.Fatalf("pattern without a group accepted: %v", err)
	}
	if _, err := newPlayers(&protocol.PlayersSpec{Leave: `(unclosed`}); err == nil {
		t.Fatal("invalid pattern accepted")
	}
	if p, err := newPlayers(nil); err != nil || p.join != nil {
		t.Fatalf("nil spec: %v", err)
	}
	p, _ := newPlayers(&protocol.PlayersSpec{Join: `(\w+) joined`})
	if _, _, ok := p.Match("Bob left"); ok {
		t.Fatal("leave matched with no leave pattern")
	}
}

// minecraftPlayers are the patterns of games/minecraft-java/game.yml (keep in sync).
var minecraftPlayers = &protocol.PlayersSpec{
	Join:  `^(?:\[[^\]]*\] )*\[[^\]]*INFO\]: (?:System chat: )?(\w+) joined the game\s*$`,
	Leave: `^(?:\[[^\]]*\] )*\[[^\]]*INFO\]: (?:System chat: )?(\w+) left the game\s*$`,
}

func TestPlayersMinecraftPatterns(t *testing.T) {
	cases := []struct {
		name   string
		line   string
		player string
		action protocol.PlayerAction
		ok     bool
	}{
		{"vanilla join", "[12:00:00] [Server thread/INFO]: Steve joined the game", "Steve", protocol.PlayerActionJoin, true},
		{"vanilla leave", "[12:00:00] [Server thread/INFO]: Steve left the game", "Steve", protocol.PlayerActionLeave, true},
		{"paper join", "[12:00:00 INFO]: Alex joined the game", "Alex", protocol.PlayerActionJoin, true},
		{"paper leave", "[12:00:00 INFO]: Alex left the game", "Alex", protocol.PlayerActionLeave, true},
		{"paper 26.3 join", "[23:59:44] [Server thread/INFO]: System chat: Steve joined the game", "Steve", protocol.PlayerActionJoin, true},
		{"paper 26.3 leave", "[23:59:54] [Server thread/INFO]: System chat: Steve left the game", "Steve", protocol.PlayerActionLeave, true},
		{"paper 26.3 console say", "[23:55:48] [Server thread/INFO]: [Not Secure] [Server] Steve joined the game", "", "", false},
		{"trailing spaces", "[12:00:00 INFO]: Alex_1 joined the game  ", "Alex_1", protocol.PlayerActionJoin, true},
		{"paper colours", plainText("[12:00:00 \x1b[32mINFO\x1b[m]: Kim joined the game\x1b[0m"), "Kim", protocol.PlayerActionJoin, true},
		{"vanilla chat fake", "[12:00:00] [Server thread/INFO]: <Steve> INFO]: Notch joined the game", "", "", false},
		{"paper chat fake", "[12:00:00 INFO]: <Steve> [12:00:00 INFO]: Notch joined the game", "", "", false},
		{"chat fake leave", "[12:00:00] [Server thread/INFO]: <Steve> INFO]: Notch left the game", "", "", false},
		{"say line", "[12:00:00] [Server thread/INFO]: [Server] Steve joined the game", "", "", false},
		{"paper say line", "[12:00:00 INFO]: [Server] Steve joined the game", "", "", false},
		{"not secure chat", "[12:00:00 INFO]: [Not Secure] <Steve> Bob joined the game", "", "", false},
		{"bare chat", "[Not Secure] <Steve> Bob joined the game", "", "", false},
		{"text after", "[12:00:00 INFO]: Steve joined the game and more", "", "", false},
		{"warn level", "[12:00:00 WARN]: Steve joined the game", "", "", false},
	}
	for _, tc := range cases {
		p, err := newPlayers(minecraftPlayers)
		if err != nil {
			t.Fatal(err)
		}
		if tc.action == protocol.PlayerActionLeave {
			p.online = []string{tc.player}
		}
		name, action, ok := p.Match(tc.line)
		if ok != tc.ok || name != tc.player || action != tc.action {
			t.Errorf("%s: %q gave %q %q %v, want %q %q %v", tc.name, tc.line, name, action, ok, tc.player, tc.action, tc.ok)
		}
	}
	// A chat fake of a leave must not remove a listed player either.
	p, _ := newPlayers(minecraftPlayers)
	p.online = []string{"Notch"}
	if _, _, ok := p.Match("[12:00:00] [Server thread/INFO]: <Steve> INFO]: Notch left the game"); ok || len(p.List()) != 1 {
		t.Error("a chat line removed a listed player")
	}
}

func TestCleanLineKeepsPatternAnchors(t *testing.T) {
	line := cleanLine([]byte("\x1b[K[12:00:00 INFO]: Steve joined the game\r"))
	p, _ := newPlayers(minecraftPlayers)
	if name, _, ok := p.Match(plainText(line)); !ok || name != "Steve" {
		t.Fatalf("a line with a trailing CR and a non-colour escape did not match: %q", line)
	}
}
