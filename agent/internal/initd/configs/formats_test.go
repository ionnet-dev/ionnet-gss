package configs

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// formatCase is one edit: in → want with set applied, or an error containing wantErr.
type formatCase struct {
	name    string
	in      string
	set     map[string]string
	want    string
	wantErr string
}

func runCases(t *testing.T, apply func(string, map[string]string) (string, error), cases []formatCase) {
	t.Helper()
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, err := apply(c.in, c.set)
			if c.wantErr != "" {
				if err == nil || !strings.Contains(err.Error(), c.wantErr) {
					t.Fatalf("error %v, want one containing %q (output %q)", err, c.wantErr, got)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if got != c.want {
				t.Fatalf("got\n%s\nwant\n%s\n(got %q)", got, c.want, got)
			}
			again, err := apply(got, c.set)
			if err != nil || again != got {
				t.Fatalf("not idempotent: %q (%v)", again, err)
			}
		})
	}
}

const gmodServerCfg = `// Garry's Mod server.cfg
hostname		"Old Name"   // shown in the browser
sv_password ""
"rcon_password" "old"
sv_lan 0
sbox_maxprops 200 ; sbox_maxragdolls 5
sv_loadingurl "http://example.com/load?a=1;b=2"
	sv_allowcslua "0"
exec banned_user.cfg
// HOSTNAME "commented out"
`

func TestSetCfg(t *testing.T) {
	runCases(t, setCfg, []formatCase{
		{
			name: "gmod server.cfg",
			in:   gmodServerCfg,
			set: map[string]string{
				"hostname":      "My Server // not a comment; not a command",
				"rcon_password": "s3cret",
				"sv_lan":        "1",
				"SBOX_MAXPROPS": "300",
				"sv_allowcslua": "1",
				"sv_region":     "3",
			},
			want: `// Garry's Mod server.cfg
hostname "My Server // not a comment; not a command"   // shown in the browser
sv_password ""
"rcon_password" "s3cret"
sv_lan "1"
sbox_maxprops "300" ; sbox_maxragdolls 5
sv_loadingurl "http://example.com/load?a=1;b=2"
	sv_allowcslua "1"
exec banned_user.cfg
// HOSTNAME "commented out"
sv_region "3"
`,
		},
		{
			name: "quotes can't end the argument",
			in:   "hostname \"x\"\n",
			set:  map[string]string{"hostname": `pwn" ; rcon_password "owned`},
			want: "hostname \"pwn' ; rcon_password 'owned\"\n",
		},
		{
			name:    "line breaks are refused",
			in:      "hostname \"x\"\n",
			set:     map[string]string{"hostname": "a\nrcon_password owned"},
			wantErr: "line break",
		},
		{
			name:    "keys must be one token",
			set:     map[string]string{"bad key": "1"},
			wantErr: "not a valid cvar",
		},
		{
			name: "new file, CRLF and BOM kept",
			in:   "\ufeffsv_lan 0\r\nhostname \"a\"\r\n",
			set:  map[string]string{"hostname": "b"},
			want: "\ufeffsv_lan 0\r\nhostname \"b\"\r\n",
		},
		{
			name: "missing file",
			set:  map[string]string{"sv_lan": "0", "hostname": "x"},
			want: "hostname \"x\"\nsv_lan \"0\"\n",
		},
	})
}

const ueINI = `; Unreal-style settings
[/Script/Engine.GameSession]
MaxPlayers=16

[ServerSettings]
ServerPassword = old ; inline
DifficultyOffset = 0.5
# trailing comment of the section

[SessionSettings]
SessionName=Old
`

func TestSetINI(t *testing.T) {
	runCases(t, setINI, []formatCase{
		{
			name: "unreal sections with dots",
			in:   ueINI,
			set: map[string]string{
				"/Script/Engine.GameSession.MaxPlayers": "32",
				"serversettings.serverpassword":         "new; #not a comment",
				"ServerSettings.RCONEnabled":            "True",
				"SessionSettings.SessionName":           "Ünïcode name",
				"New Section.key":                       "v",
				"toplevel":                              "1",
			},
			want: `; Unreal-style settings
toplevel=1

[/Script/Engine.GameSession]
MaxPlayers=32

[ServerSettings]
ServerPassword = new; #not a comment
DifficultyOffset = 0.5
RCONEnabled=True
# trailing comment of the section

[SessionSettings]
SessionName=Ünïcode name

[New Section]
key=v
`,
		},
		{
			name:    "values can't add lines",
			in:      "[a]\nk=1\n",
			set:     map[string]string{"a.k": "1\n[evil]\nx=1"},
			wantErr: "line break",
		},
		{
			name:    "keys can't contain =",
			set:     map[string]string{"a.k=v": "1"},
			wantErr: "not a valid INI key",
		},
		{
			name:    "sections can't contain brackets",
			set:     map[string]string{"a]x.k": "1"},
			wantErr: "must not contain brackets",
		},
		{
			name: "top-level keys stay above sections, spacing follows the file",
			in:   "a = 1\n[s]\nb=2\n",
			set:  map[string]string{"c": "3", "s.b": "4"},
			want: "a = 1\nc = 3\n[s]\nb=4\n",
		},
		{
			name: "missing file",
			set:  map[string]string{"s.b": "2", "s.a": "1"},
			want: "[s]\na=1\nb=2\n",
		},
	})
}

const minecraftLikeJSON = `{
    "server": {
        "name": "Old",
        "port": 7777,
        "public": false,
        "tags": ["a", "b"]
    },
    "admins": [{"id": "1"}],
    "motd": null
}
`

func setJSONString(in string, set map[string]string) (string, error) {
	out, err := setJSON([]byte(in), set)
	return string(out), err
}

func TestSetJSON(t *testing.T) {
	runCases(t, setJSONString, []formatCase{
		{
			name: "splice keeps formatting and types",
			in:   minecraftLikeJSON,
			set: map[string]string{
				"server.name":    "New \"quoted\" <b>",
				"server.port":    "7778",
				"server.public":  "true",
				"server.tags.1":  "c",
				"admins.0.id":    "42",
				"motd":           "hi",
				"server.extra.a": "1",
				"version":        "1.2.3",
			},
			want: `{
    "server": {
        "name": "New \"quoted\" <b>",
        "port": 7778,
        "public": true,
        "tags": ["a", "c"],
        "extra": {
            "a": 1
        }
    },
    "admins": [{"id": "42"}],
    "motd": "hi",
    "version": "1.2.3"
}
`,
		},
		{
			name: "hostile string stays one value",
			in:   "{\"a\": \"x\"}",
			set:  map[string]string{"a": "\", \"admin\": true, \"b\": \"\n"},
			want: "{\"a\": \"\\\", \\\"admin\\\": true, \\\"b\\\": \\\"\\n\"}",
		},
		{
			name: "a string that does not fit a number becomes a string",
			in:   "{\"port\": 1}",
			set:  map[string]string{"port": "auto"},
			want: "{\"port\": \"auto\"}",
		},
		{
			name: "compact object",
			in:   "{\"a\":1}",
			set:  map[string]string{"b.c": "x"},
			want: "{\"a\":1, \"b\":{\"c\":\"x\"}}",
		},
		{
			name: "missing file",
			set:  map[string]string{"a.b": "1", "c": "x"},
			want: "{\n  \"a\": {\n    \"b\": 1\n  },\n  \"c\": \"x\"\n}\n",
		},
		{
			name:    "comments are refused",
			in:      "{\n  // no\n  \"a\": 1\n}\n",
			set:     map[string]string{"a": "2"},
			wantErr: "not valid JSON",
		},
		{
			name:    "through a scalar",
			in:      "{\"a\": 1}",
			set:     map[string]string{"a.b": "2"},
			wantErr: "not an object",
		},
		{
			name:    "arrays are not extended",
			in:      "{\"a\": []}",
			set:     map[string]string{"a.0": "2"},
			wantErr: "arrays are not extended",
		},
		{
			name:    "empty segment",
			set:     map[string]string{"a..b": "2"},
			wantErr: "empty path segment",
		},
	})
}

const serverYAML = `# Server settings
server:
    name: Old   # shown in the list
    port: 7777
    motd: 'single quoted'
    tags:
        - a
        - b
defaults: &defaults
    level: 1
world:
    <<: *defaults
---
second: document
`

func setYAMLString(in string, set map[string]string) (string, error) {
	out, err := setYAML([]byte(in), set)
	return string(out), err
}

func TestSetYAML(t *testing.T) {
	runCases(t, setYAMLString, []formatCase{
		{
			name: "comments, styles and other documents stay",
			in:   serverYAML,
			set: map[string]string{
				"server.name":    "New: name # not a comment",
				"server.port":    "7778",
				"server.motd":    "it's",
				"server.tags.0":  "true",
				"server.extra.x": "yes",
				"defaults.level": "2",
			},
			want: `# Server settings
server:
    name: 'New: name # not a comment' # shown in the list
    port: 7778
    motd: 'it''s'
    tags:
        - "true"
        - b
    extra:
        x: "yes"
defaults: &defaults
    level: 2
world:
    <<: *defaults
---
second: document
`,
		},
		{
			name: "unchanged file is returned as is",
			in:   "a:   1\n\n\nb: x # c\n",
			set:  map[string]string{"a": "1", "b": "x"},
			want: "a:   1\n\n\nb: x # c\n",
		},
		{
			name: "hostile value stays one string",
			in:   "a: x\n",
			set:  map[string]string{"a": "x\nadmin: true\n- y"},
			want: "a: |-\n  x\n  admin: true\n  - y\n",
		},
		{
			name: "missing file",
			set:  map[string]string{"a.b": "1", "c": "x"},
			want: "a:\n  b: 1\nc: x\n",
		},
		{
			name:    "not a mapping",
			in:      "- a\n",
			set:     map[string]string{"a": "1"},
			wantErr: "must be a mapping",
		},
		{
			name:    "through an alias",
			in:      "d: &d\n  x: 1\ne: *d\n",
			set:     map[string]string{"e.x": "2"},
			wantErr: "alias",
		},
	})
}

// TestHostileRoundTrip decodes what each format wrote with a real parser and checks the value came back whole and
// no other key appeared.
func TestHostileRoundTrip(t *testing.T) {
	hostile := "a\"b'c\\d: #e ,{f}[g] ü <h>&i"
	out, err := setJSON([]byte(`{"keep": 1}`), map[string]string{"x.y": hostile})
	if err != nil {
		t.Fatal(err)
	}
	var j map[string]any
	if err := json.Unmarshal(out, &j); err != nil {
		t.Fatalf("json: %v in %s", err, out)
	}
	if got := j["x"].(map[string]any)["y"]; got != hostile || len(j) != 2 {
		t.Fatalf("json round trip: %v (%s)", j, out)
	}

	out, err = setYAML([]byte("keep: 1\n"), map[string]string{"x.y": hostile + "\nz: 1"})
	if err != nil {
		t.Fatal(err)
	}
	var y map[string]any
	if err := yaml.Unmarshal(out, &y); err != nil {
		t.Fatalf("yaml: %v in %s", err, out)
	}
	if got := y["x"].(map[string]any)["y"]; got != hostile+"\nz: 1" || len(y) != 2 {
		t.Fatalf("yaml round trip: %v (%s)", y, out)
	}
}

// TestApplyAllConfinement runs the appliers through ApplyAll on a real data folder: paths outside it and symlinks
// that lead out are refused, missing files and folders are created.
func TestApplyAllConfinement(t *testing.T) {
	base := t.TempDir()
	data := filepath.Join(base, "data")
	outside := filepath.Join(base, "outside")
	for _, dir := range []string{data, outside} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Symlink(outside, filepath.Join(data, "escape")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "server.cfg"), filepath.Join(data, "link.cfg")); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(data)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	env := Env{Data: root, UID: -1}
	set := map[string]string{"hostname": "x"}

	for _, file := range []string{"../outside/server.cfg", "/etc/server.cfg", "escape/server.cfg", "link.cfg"} {
		for _, format := range []protocol.ConfigFormat{protocol.ConfigFormatCfg, protocol.ConfigFormatIni, protocol.ConfigFormatJSON, protocol.ConfigFormatYaml} {
			err := ApplyAll(env, []protocol.ConfigMapping{{File: file, Format: format, Set: set}})
			if err == nil {
				t.Errorf("%s (%s) was written", file, format)
			}
		}
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatalf("something was written outside the data folder: %v", entries)
	}

	mappings := []protocol.ConfigMapping{
		{File: "garrysmod/cfg/server.cfg", Format: protocol.ConfigFormatCfg, Set: set},
		{File: "/data/conf/game.ini", Format: protocol.ConfigFormatIni, Set: map[string]string{"Server.Name": "x"}},
		{File: "conf/game.json", Format: protocol.ConfigFormatJSON, Set: map[string]string{"name": "x"}},
		{File: "conf/game.yml", Format: protocol.ConfigFormatYaml, Set: map[string]string{"name": "x"}},
	}
	if err := ApplyAll(env, mappings); err != nil {
		t.Fatal(err)
	}
	want := map[string]string{
		"garrysmod/cfg/server.cfg": "hostname \"x\"\n",
		"conf/game.ini":            "[Server]\nName=x\n",
		"conf/game.json":           "{\n  \"name\": \"x\"\n}\n",
		"conf/game.yml":            "name: x\n",
	}
	for name, content := range want {
		got, err := os.ReadFile(filepath.Join(data, name))
		if err != nil || string(got) != content {
			t.Errorf("%s = %q (%v), want %q", name, got, err, content)
		}
	}
}
