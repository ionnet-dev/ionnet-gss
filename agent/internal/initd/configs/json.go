package configs

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// jsonApplier edits JSON files by splicing text: only the bytes of a managed value change, so formatting, key order
// and every unmanaged key stay exactly as they were. A key is a dotted path into nested objects (`server.port`);
// a numeric segment indexes an existing array (`admins.0`). Missing keys and objects are created at the end of their
// parent object, indented like its other members. Values are typed as described on `kindFor`; strings are JSON
// escaped, so a value can never add keys. Comments and trailing commas (JSONC/JSON5) are not JSON and are refused.
type jsonApplier struct{}

func (jsonApplier) Apply(env Env, name string, mapping protocol.ConfigMapping) error {
	current, err := readConfig(env, name)
	if err != nil {
		return err
	}
	next, err := setJSON(current, mapping.Set)
	if err != nil {
		return err
	}
	return writeConfig(env, name, current, next)
}

// jsonNode is a parsed JSON value with its byte span in the document.
type jsonNode struct {
	start, end int
	kind       byte // 'o' object, 'a' array, 's' string, 'n' number, 'b' bool, 'z' null
	members    []jsonMember
	items      []*jsonNode
}

type jsonMember struct {
	key              string
	keyStart, keyEnd int
	value            *jsonNode
}

type jsonParser struct {
	src []byte
	pos int
}

func (p *jsonParser) space() {
	for p.pos < len(p.src) && strings.IndexByte(" \t\r\n", p.src[p.pos]) >= 0 {
		p.pos++
	}
}

// value parses one value. The document was checked with json.Valid first, so only the structure is read here.
func (p *jsonParser) value() *jsonNode {
	p.space()
	n := &jsonNode{start: p.pos}
	switch c := p.src[p.pos]; {
	case c == '{':
		n.kind = 'o'
		p.pos++
		for {
			p.space()
			if p.src[p.pos] == '}' {
				p.pos++
				break
			}
			if p.src[p.pos] == ',' {
				p.pos++
				p.space()
			}
			m := jsonMember{keyStart: p.pos}
			p.str()
			m.keyEnd = p.pos
			_ = json.Unmarshal(p.src[m.keyStart:m.keyEnd], &m.key)
			p.space()
			p.pos++ // ':'
			m.value = p.value()
			n.members = append(n.members, m)
		}
	case c == '[':
		n.kind = 'a'
		p.pos++
		for {
			p.space()
			if p.src[p.pos] == ']' {
				p.pos++
				break
			}
			if p.src[p.pos] == ',' {
				p.pos++
			}
			n.items = append(n.items, p.value())
		}
	case c == '"':
		n.kind = 's'
		p.str()
	case c == 't' || c == 'f':
		n.kind = 'b'
		p.word()
	case c == 'n':
		n.kind = 'z'
		p.word()
	default:
		n.kind = 'n'
		p.word()
	}
	n.end = p.pos
	return n
}

func (p *jsonParser) str() {
	p.pos++ // opening quote
	for p.src[p.pos] != '"' {
		if p.src[p.pos] == '\\' {
			p.pos++
		}
		p.pos++
	}
	p.pos++
}

func (p *jsonParser) word() {
	for p.pos < len(p.src) && strings.IndexByte(",]} \t\r\n", p.src[p.pos]) < 0 {
		p.pos++
	}
}

func parseJSON(src []byte) (*jsonNode, error) {
	if !json.Valid(src) {
		var probe any
		err := json.Unmarshal(src, &probe)
		return nil, fmt.Errorf("the file is not valid JSON (%v); fix or delete it (comments and trailing commas are not supported)", err)
	}
	p := &jsonParser{src: src}
	root := p.value()
	if root.kind != 'o' {
		return nil, errors.New("the top level of the file must be a JSON object")
	}
	return root, nil
}

// jsonLiteral encodes value as kind.
func jsonLiteral(kind scalarKind, value string) string {
	if kind == kindNumber || kind == kindBool {
		return value
	}
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(value)
	return strings.TrimSuffix(b.String(), "\n")
}

func jsonKind(n *jsonNode) scalarKind {
	switch n.kind {
	case 's':
		return kindString
	case 'n':
		return kindNumber
	case 'b':
		return kindBool
	}
	return kindNone
}

// setJSON returns src with every key in set assigned. An empty or missing file starts as `{}`.
func setJSON(src []byte, set map[string]string) ([]byte, error) {
	doc := src
	if len(bytes.TrimSpace(doc)) == 0 {
		doc = []byte("{}\n")
	}
	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		path, err := splitPath(key)
		if err != nil {
			return nil, err
		}
		root, err := parseJSON(doc)
		if err != nil {
			return nil, err
		}
		if doc, err = jsonSet(doc, root, path, set[key]); err != nil {
			return nil, fmt.Errorf("key %q: %w", key, err)
		}
	}
	return doc, nil
}

// jsonSet assigns value at path below node (an object or array) and returns the new document.
func jsonSet(doc []byte, node *jsonNode, path []string, value string) ([]byte, error) {
	seg, rest := path[0], path[1:]
	if node.kind == 'a' {
		i, err := strconv.Atoi(seg)
		if err != nil || i < 0 || i >= len(node.items) {
			return nil, fmt.Errorf("%q does not index the array there (it has %d items; arrays are not extended)", seg, len(node.items))
		}
		return jsonSetIn(doc, node.items[i], rest, value)
	}
	var matches []*jsonNode
	for _, m := range node.members {
		if m.key == seg {
			matches = append(matches, m.value)
		}
	}
	if len(matches) == 0 {
		return jsonInsert(doc, node, path, value), nil
	}
	// Duplicate keys: set each, last first so earlier offsets stay valid.
	for i := len(matches) - 1; i >= 0; i-- {
		next, err := jsonSetIn(doc, matches[i], rest, value)
		if err != nil {
			return nil, err
		}
		doc = next
	}
	return doc, nil
}

func jsonSetIn(doc []byte, n *jsonNode, rest []string, value string) ([]byte, error) {
	if len(rest) == 0 {
		return splice(doc, n.start, n.end, jsonLiteral(kindFor(jsonKind(n), value), value)), nil
	}
	if n.kind != 'o' && n.kind != 'a' {
		return nil, fmt.Errorf("%q is not an object, so it has no key %q", string(doc[n.start:n.end]), rest[0])
	}
	return jsonSet(doc, n, rest, value)
}

func splice(doc []byte, start, end int, text string) []byte {
	out := make([]byte, 0, len(doc)-(end-start)+len(text))
	out = append(out, doc[:start]...)
	out = append(out, text...)
	return append(out, doc[end:]...)
}

// lineIndent is the leading whitespace of the line holding offset.
func lineIndent(doc []byte, offset int) string {
	start := bytes.LastIndexByte(doc[:offset], '\n') + 1
	end := start
	for end < len(doc) && (doc[end] == ' ' || doc[end] == '\t') {
		end++
	}
	return string(doc[start:end])
}

// jsonInsert adds `"path[0]": …` as the last member of obj, nesting new objects for the rest of the path.
func jsonInsert(doc []byte, obj *jsonNode, path []string, value string) []byte {
	eol := "\n"
	if bytes.Contains(doc, []byte("\r\n")) {
		eol = "\r\n"
	}
	base := lineIndent(doc, obj.start)
	unit := "  "
	colon := ": "
	multiline := true
	if n := len(obj.members); n > 0 {
		first, last := obj.members[0], obj.members[n-1]
		colon = string(doc[last.keyEnd:last.value.start])
		if bytes.Contains(doc[obj.start:first.keyStart], []byte("\n")) {
			if member := lineIndent(doc, first.keyStart); strings.HasPrefix(member, base) && len(member) > len(base) {
				unit = member[len(base):]
			}
		} else {
			multiline = false
		}
	} else if strings.HasPrefix(base, "\t") {
		unit = "\t"
	}

	// The new member's value: the scalar, wrapped in one new object per remaining segment.
	render := func(indent string) string {
		text := jsonLiteral(kindFor(kindNone, value), value)
		for i := len(path) - 1; i >= 1; i-- {
			inner := indent + strings.Repeat(unit, i)
			if multiline {
				text = "{" + eol + inner + unit + jsonLiteral(kindString, path[i]) + colon + text + eol + inner + "}"
			} else {
				text = "{" + jsonLiteral(kindString, path[i]) + colon + text + "}"
			}
		}
		return text
	}
	member := func(indent string) string { return jsonLiteral(kindString, path[0]) + colon + render(indent) }

	if len(obj.members) == 0 {
		inner := base + unit
		return splice(doc, obj.start, obj.end, "{"+eol+inner+member(base)+eol+base+"}")
	}
	last := obj.members[len(obj.members)-1]
	if !multiline {
		return splice(doc, last.value.end, last.value.end, ", "+member(base))
	}
	return splice(doc, last.value.end, last.value.end, ","+eol+base+unit+member(base))
}
