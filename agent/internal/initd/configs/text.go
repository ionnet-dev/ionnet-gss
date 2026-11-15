package configs

import (
	"bytes"
	"errors"
	"fmt"
	"regexp"
	"strings"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
)

// MAX_CONFIG_BYTES is the largest config file an applier loads; a bigger one is refused instead of read whole.
const MAX_CONFIG_BYTES = 16 << 20

// readConfig returns the file's content, or nil when it does not exist yet.
func readConfig(env Env, name string) ([]byte, error) {
	if info, err := env.Data.Stat(name); err == nil {
		if !info.Mode().IsRegular() {
			return nil, fmt.Errorf("%s is not a regular file", name)
		}
		if info.Size() > MAX_CONFIG_BYTES {
			return nil, fmt.Errorf("the file is %d bytes; managed config files are limited to %d", info.Size(), MAX_CONFIG_BYTES)
		}
	}
	data, err := datafs.ReadFileIfExists(env.Data, name)
	if err != nil {
		return nil, fmt.Errorf("read: %w", err)
	}
	return data, nil
}

// writeConfig writes next unless the file already holds exactly it (an unchanged file is never rewritten, so its
// mtime and formatting stay). A missing file is always created.
func writeConfig(env Env, name string, current, next []byte) error {
	if current != nil && bytes.Equal(current, next) {
		return nil
	}
	if err := datafs.WriteFile(env.Data, name, next, 0o644, env.UID); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// textFile is a line-based file split for editing. The line ending (CRLF when the file uses it anywhere) and a
// UTF-8 byte order mark survive; the result always ends with a newline.
type textFile struct {
	lines []string
	eol   string
	bom   bool
}

const utf8BOM = "\ufeff"

func splitText(content string) textFile {
	t := textFile{eol: "\n"}
	if strings.HasPrefix(content, utf8BOM) {
		t.bom = true
		content = content[len(utf8BOM):]
	}
	if strings.Contains(content, "\r\n") {
		t.eol = "\r\n"
	}
	if content == "" {
		return t
	}
	content = strings.TrimSuffix(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	t.lines = strings.Split(content, "\n")
	return t
}

func (t textFile) String() string {
	var b strings.Builder
	if t.bom {
		b.WriteString(utf8BOM)
	}
	for _, line := range t.lines {
		b.WriteString(line)
		b.WriteString(t.eol)
	}
	return b.String()
}

// insertLines returns lines with extra inserted before index at.
func insertLines(lines []string, at int, extra ...string) []string {
	out := make([]string, 0, len(lines)+len(extra))
	out = append(out, lines[:at]...)
	out = append(out, extra...)
	return append(out, lines[at:]...)
}

// singleLine refuses values that would end the line they are written on (and so could add keys of their own).
func singleLine(key, value string) error {
	if strings.ContainsAny(value, "\r\n\x00") {
		return fmt.Errorf("the value of %q contains a line break or NUL byte; this format only takes single-line values", key)
	}
	return nil
}

// scalarKind is how a json/yaml value is written.
type scalarKind int

const (
	kindString scalarKind = iota
	kindNumber
	kindBool
	kindNone // no existing scalar (missing key, null, an object or a list): the value decides
)

var jsonNumber = regexp.MustCompile(`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`)

// kindFor picks the kind a value is written as. `set` values are strings, so an existing scalar keeps its kind
// while the value fits it (a string stays a string even when the new value looks like a number); a new key, or one
// whose kind the value does not fit, is typed by the value: true/false → bool, a JSON number → number, else string.
func kindFor(existing scalarKind, value string) scalarKind {
	fitsBool := value == "true" || value == "false"
	fitsNumber := jsonNumber.MatchString(value)
	switch existing {
	case kindString:
		return kindString
	case kindBool:
		if fitsBool {
			return kindBool
		}
	case kindNumber:
		if fitsNumber {
			return kindNumber
		}
	}
	switch {
	case fitsBool:
		return kindBool
	case fitsNumber:
		return kindNumber
	}
	return kindString
}

// splitPath splits a dotted json/yaml key into its segments.
func splitPath(key string) ([]string, error) {
	if key == "" {
		return nil, errors.New("a key is empty")
	}
	segments := strings.Split(key, ".")
	for _, s := range segments {
		if s == "" {
			return nil, fmt.Errorf("key %q has an empty path segment; use dots only between names", key)
		}
	}
	return segments, nil
}
