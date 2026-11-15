package configs

import (
	"fmt"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// propertiesApplier edits Java .properties files (server.properties) in place: managed keys get their value where
// they already are (comments, order and unmanaged keys stay), missing ones are appended in key order. Values are
// escaped like java.util.Properties.store, including \uXXXX for non-ASCII, because Minecraft loads the file as
// ISO-8859-1.
type propertiesApplier struct{}

func (propertiesApplier) Apply(env Env, name string, mapping protocol.ConfigMapping) error {
	current, err := datafs.ReadFileIfExists(env.Data, name)
	if err != nil {
		return err
	}
	next := setProperties(string(current), mapping.Set)
	if next == string(current) {
		return nil
	}
	if err := datafs.WriteFile(env.Data, name, []byte(next), 0o644, env.UID); err != nil {
		return fmt.Errorf("write: %w", err)
	}
	return nil
}

// setProperties returns content with every key in set assigned; the rest of the text is unchanged.
func setProperties(content string, set map[string]string) string {
	if len(set) == 0 {
		return content
	}
	eol := "\n"
	if strings.Contains(content, "\r\n") {
		eol = "\r\n"
	}
	physical := strings.Split(strings.ReplaceAll(content, "\r\n", "\n"), "\n")
	trailingNewline := strings.HasSuffix(content, "\n")
	if trailingNewline {
		physical = physical[:len(physical)-1]
	}
	if content == "" {
		physical = nil
	}

	seen := map[string]bool{}
	out := make([]string, 0, len(physical)+len(set))
	for i := 0; i < len(physical); i++ {
		line := physical[i]
		trimmed := strings.TrimLeft(line, " \t\f")
		if trimmed == "" || trimmed[0] == '#' || trimmed[0] == '!' {
			out = append(out, line)
			continue
		}
		// A logical line continues while a physical line ends in an odd number of backslashes.
		end := i
		for end < len(physical)-1 && continues(physical[end]) {
			end++
		}
		key := propertyKey(trimmed)
		if value, ok := set[key]; ok {
			out = append(out, escapeProperty(key, true)+"="+escapeProperty(value, false))
			seen[key] = true
		} else {
			out = append(out, physical[i:end+1]...)
		}
		i = end
	}

	missing := make([]string, 0, len(set))
	for key := range set {
		if !seen[key] {
			missing = append(missing, key)
		}
	}
	sort.Strings(missing)
	for _, key := range missing {
		out = append(out, escapeProperty(key, true)+"="+escapeProperty(set[key], false))
	}
	if len(out) == 0 {
		return ""
	}
	return strings.Join(out, eol) + eol
}

func continues(line string) bool {
	n := 0
	for i := len(line) - 1; i >= 0 && line[i] == '\\'; i-- {
		n++
	}
	return n%2 == 1
}

// propertyKey reads the (unescaped) key at the start of a trimmed logical line: up to the first unescaped `=`, `:`
// or whitespace.
func propertyKey(line string) string {
	var b strings.Builder
	runes := []rune(line)
	for i := 0; i < len(runes); i++ {
		r := runes[i]
		if r == '=' || r == ':' || r == ' ' || r == '\t' || r == '\f' {
			break
		}
		if r != '\\' || i == len(runes)-1 {
			b.WriteRune(r)
			continue
		}
		i++
		switch runes[i] {
		case 't':
			b.WriteRune('\t')
		case 'n':
			b.WriteRune('\n')
		case 'r':
			b.WriteRune('\r')
		case 'f':
			b.WriteRune('\f')
		case 'u':
			if i+4 < len(runes) {
				var code rune
				if _, err := fmt.Sscanf(string(runes[i+1:i+5]), "%04x", &code); err == nil {
					b.WriteRune(code)
					i += 4
					continue
				}
			}
			b.WriteRune('u')
		default:
			b.WriteRune(runes[i])
		}
	}
	return b.String()
}

// escapeProperty escapes like Properties.saveConvert: keys escape every space, values only a leading one.
func escapeProperty(s string, isKey bool) string {
	var b strings.Builder
	for i, r := range s {
		switch r {
		case ' ':
			if isKey || i == 0 {
				b.WriteString(`\ `)
			} else {
				b.WriteRune(' ')
			}
		case '\\':
			b.WriteString(`\\`)
		case '\t':
			b.WriteString(`\t`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\f':
			b.WriteString(`\f`)
		case '=', ':', '#', '!':
			b.WriteRune('\\')
			b.WriteRune(r)
		default:
			if r < 0x20 || r > 0x7e {
				for _, unit := range utf16.Encode([]rune{r}) {
					fmt.Fprintf(&b, `\u%04X`, unit)
				}
			} else {
				b.WriteRune(r)
			}
		}
	}
	return b.String()
}
