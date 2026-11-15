package configs

import (
	"fmt"
	"regexp"
	"sort"
	"strings"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// cfgApplier edits Source-engine config files (server.cfg): one `key "value"` command per line. Keys are literal
// cvar/command names matched case-insensitively (like the engine does). A managed line keeps its indentation, the
// key as spelled and whatever follows the value (`// comment`, `; other command`); its value is rewritten as one
// quoted argument. Comments, blank lines, order and every other command (`exec`, `writeid`, …) stay. Missing keys are
// appended in key order; every occurrence of a duplicated key is set (the engine runs them all, the last one wins).
//
// The engine has no escape for `"` inside a quoted argument (a quote always ends it), so `"` in a value is written
// as `'`; line breaks would start a new command and are refused. Inside the quotes `;` and `//` are plain text.
type cfgApplier struct{}

func (cfgApplier) Apply(env Env, name string, mapping protocol.ConfigMapping) error {
	current, err := readConfig(env, name)
	if err != nil {
		return err
	}
	next, err := setCfg(string(current), mapping.Set)
	if err != nil {
		return err
	}
	return writeConfig(env, name, current, []byte(next))
}

var cfgKeyPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.+\-]*$`)

// cfgValue quotes a value as one engine argument.
func cfgValue(value string) string {
	return `"` + strings.ReplaceAll(value, `"`, `'`) + `"`
}

// cfgLine finds the command on a line: the end of the key token (after its quotes, if any), the key itself and
// where the value ends (trailing spaces, an unquoted `;` or `//` and everything after belong to the suffix). ok is
// false for blank and comment lines.
func cfgLine(line string) (keyEnd int, key string, valueEnd int, ok bool) {
	i := 0
	for i < len(line) && (line[i] == ' ' || line[i] == '\t') {
		i++
	}
	if i == len(line) || strings.HasPrefix(line[i:], "//") {
		return 0, "", 0, false
	}
	if line[i] == '"' {
		end := strings.IndexByte(line[i+1:], '"')
		if end < 0 {
			return 0, "", 0, false
		}
		key = line[i+1 : i+1+end]
		keyEnd = i + end + 2
	} else {
		j := i
		for j < len(line) && !strings.ContainsRune(" \t\";", rune(line[j])) && !strings.HasPrefix(line[j:], "//") {
			j++
		}
		key, keyEnd = line[i:j], j
	}
	if key == "" {
		return 0, "", 0, false
	}
	stop := len(line)
	quoted := false
	for j := keyEnd; j < len(line); j++ {
		if line[j] == '"' {
			quoted = !quoted
			continue
		}
		if !quoted && (line[j] == ';' || strings.HasPrefix(line[j:], "//")) {
			stop = j
			break
		}
	}
	valueEnd = stop
	for valueEnd > keyEnd && (line[valueEnd-1] == ' ' || line[valueEnd-1] == '\t') {
		valueEnd--
	}
	return keyEnd, key, valueEnd, true
}

// setCfg returns content with every key in set assigned.
func setCfg(content string, set map[string]string) (string, error) {
	wanted := map[string]string{}
	for key, value := range set {
		if !cfgKeyPattern.MatchString(key) {
			return "", fmt.Errorf("key %q is not a valid cvar or command name (letters, digits, `_`, `.`, `+`, `-`)", key)
		}
		if err := singleLine(key, value); err != nil {
			return "", err
		}
		lower := strings.ToLower(key)
		if _, ok := wanted[lower]; ok {
			return "", fmt.Errorf("key %q is set twice (cfg keys are case-insensitive)", key)
		}
		wanted[lower] = value
	}
	if len(wanted) == 0 && content != "" {
		return content, nil
	}

	t := splitText(content)
	seen := map[string]bool{}
	for i, line := range t.lines {
		keyEnd, key, valueEnd, ok := cfgLine(line)
		if !ok {
			continue
		}
		lower := strings.ToLower(key)
		value, managed := wanted[lower]
		if !managed {
			continue
		}
		t.lines[i] = line[:keyEnd] + " " + cfgValue(value) + strings.TrimRight(line[valueEnd:], " \t")
		seen[lower] = true
	}

	missing := make([]string, 0, len(set))
	for key := range set {
		if !seen[strings.ToLower(key)] {
			missing = append(missing, key)
		}
	}
	sort.Strings(missing)
	for _, key := range missing {
		t.lines = append(t.lines, key+" "+cfgValue(set[key]))
	}
	return t.String(), nil
}
