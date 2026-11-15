package configs

import (
	"fmt"
	"sort"
	"strings"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// iniApplier edits INI files in place. A key is `section.key`, split at the last dot so section names may hold
// dots (Unreal's `/Script/Engine.GameSession.MaxPlayers`); a key without a dot lives above the first section.
// Sections and keys match case-insensitively and keep their spelling in the file. Comments (`;`, `#`), blank
// lines, order, the `=` spacing of the line and every unmanaged line stay. A replaced value loses an inline comment
// on its own line (INI has no portable inline comment syntax). Missing keys go after the last key of their
// section, missing sections are appended. INI has no escaping, so values are written verbatim and must be one
// line; every occurrence of a duplicated key is set.
type iniApplier struct{}

func (iniApplier) Apply(env Env, name string, mapping protocol.ConfigMapping) error {
	current, err := readConfig(env, name)
	if err != nil {
		return err
	}
	next, err := setINI(string(current), mapping.Set)
	if err != nil {
		return err
	}
	return writeConfig(env, name, current, []byte(next))
}

// iniKey is one managed key, addressed by its lowercased section and key.
type iniKey struct {
	section, key string // as written in the mapping
	value        string
}

func (k iniKey) id() string { return strings.ToLower(k.section) + "\x00" + strings.ToLower(k.key) }

// splitINIKey splits `section.key` at the last dot and checks both parts can be written without changing the
// file's structure.
func splitINIKey(full, value string) (iniKey, error) {
	k := iniKey{key: full, value: value}
	if i := strings.LastIndexByte(full, '.'); i >= 0 {
		k.section, k.key = full[:i], full[i+1:]
		if k.section == "" {
			return k, fmt.Errorf("key %q has an empty section name", full)
		}
		if strings.ContainsAny(k.section, "[]\r\n\x00") || strings.TrimSpace(k.section) != k.section {
			return k, fmt.Errorf("section %q of key %q must not contain brackets or line breaks or start or end with spaces", k.section, full)
		}
	}
	if k.key == "" || strings.ContainsAny(k.key, "=\r\n\x00") || strings.TrimSpace(k.key) != k.key || strings.ContainsAny(k.key[:1], ";#[") {
		return k, fmt.Errorf("key %q is not a valid INI key (no `=`, line breaks or surrounding spaces, and it must not start with `;`, `#` or `[`)", full)
	}
	if err := singleLine(full, value); err != nil {
		return k, err
	}
	return k, nil
}

// iniHeader returns the section name of a `[name]` line.
func iniHeader(trimmed string) (string, bool) {
	if !strings.HasPrefix(trimmed, "[") {
		return "", false
	}
	end := strings.IndexByte(trimmed, ']')
	if end < 0 {
		return "", false
	}
	return strings.TrimSpace(trimmed[1:end]), true
}

// setINI returns content with every key in set assigned.
func setINI(content string, set map[string]string) (string, error) {
	keys := make([]iniKey, 0, len(set)) // capacity fixed up front: wanted points into it
	wanted := map[string]*iniKey{}
	for full, value := range set {
		k, err := splitINIKey(full, value)
		if err != nil {
			return "", err
		}
		if other, ok := wanted[k.id()]; ok {
			return "", fmt.Errorf("keys %q and %q name the same INI key", other.section+"."+other.key, full)
		}
		keys = append(keys, k)
		wanted[k.id()] = &keys[len(keys)-1]
	}
	if len(keys) == 0 && content != "" {
		return content, nil
	}

	t := splitText(content)
	seen := map[string]bool{}
	lastLine := map[string]int{} // lowercased section → last key line (or its header)
	firstHeader := -1
	spaced := false
	styled := false
	section := ""
	lastLine[""] = -1
	for i, line := range t.lines {
		trimmed := strings.TrimSpace(line)
		if trimmed == "" || trimmed[0] == ';' || trimmed[0] == '#' {
			continue
		}
		if name, ok := iniHeader(trimmed); ok {
			section = strings.ToLower(name)
			if firstHeader < 0 {
				firstHeader = i
			}
			if _, ok := lastLine[section]; !ok {
				lastLine[section] = i
			}
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq < 0 {
			continue
		}
		if !styled {
			spaced = eq > 0 && (line[eq-1] == ' ' || line[eq-1] == '\t')
			styled = true
		}
		lastLine[section] = i
		id := section + "\x00" + strings.ToLower(strings.TrimSpace(line[:eq]))
		k, ok := wanted[id]
		if !ok {
			continue
		}
		start := eq + 1
		for start < len(line) && (line[start] == ' ' || line[start] == '\t') {
			start++
		}
		t.lines[i] = line[:start] + k.value
		seen[id] = true
	}

	sep := "="
	if spaced {
		sep = " = "
	}
	// Missing keys, grouped by section, in key order.
	missing := map[string][]iniKey{}
	var newSections []string
	for _, k := range keys {
		if seen[k.id()] {
			continue
		}
		s := strings.ToLower(k.section)
		if _, ok := lastLine[s]; !ok && missing[s] == nil {
			newSections = append(newSections, s)
		}
		missing[s] = append(missing[s], k)
	}
	lineOf := func(k iniKey) string { return k.key + sep + k.value }
	type insertion struct {
		at    int
		lines []string
	}
	var inserts []insertion
	for s, list := range missing {
		at, ok := lastLine[s]
		if !ok {
			continue
		}
		sort.Slice(list, func(i, j int) bool { return list[i].key < list[j].key })
		lines := make([]string, 0, len(list)+1)
		for _, k := range list {
			lines = append(lines, lineOf(k))
		}
		if s == "" && at < 0 {
			// No top-level keys yet: before the first section, separated from it by a blank line.
			at = len(t.lines)
			if firstHeader >= 0 {
				at = firstHeader
				lines = append(lines, "")
			}
		} else {
			at++
		}
		inserts = append(inserts, insertion{at: at, lines: lines})
	}
	sort.Slice(inserts, func(i, j int) bool { return inserts[i].at > inserts[j].at })
	for _, ins := range inserts {
		t.lines = insertLines(t.lines, ins.at, ins.lines...)
	}

	sort.Slice(newSections, func(i, j int) bool { return newSections[i] < newSections[j] })
	for _, s := range newSections {
		list := missing[s]
		sort.Slice(list, func(i, j int) bool { return list[i].key < list[j].key })
		if n := len(t.lines); n > 0 && strings.TrimSpace(t.lines[n-1]) != "" {
			t.lines = append(t.lines, "")
		}
		t.lines = append(t.lines, "["+list[0].section+"]")
		for _, k := range list {
			t.lines = append(t.lines, lineOf(k))
		}
	}
	return t.String(), nil
}
