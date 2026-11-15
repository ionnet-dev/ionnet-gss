package configs

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// yamlApplier edits YAML files through yaml.v3 nodes. A key is a dotted path into nested mappings (`server.port`);
// a numeric segment indexes an existing sequence. Missing keys and mappings are appended to their parent. Only the
// first document of a multi-document file is edited. When nothing changes the file is not touched; when something
// does, comments, key order, quoting styles, anchors and the other documents stay, while blank lines are dropped and
// indentation is normalised (the file's own indent width is kept). Values are typed as described on `kindFor`;
// strings are quoted by the encoder whenever needed, so a value can never add keys.
type yamlApplier struct{}

func (yamlApplier) Apply(env Env, name string, mapping protocol.ConfigMapping) error {
	current, err := readConfig(env, name)
	if err != nil {
		return err
	}
	next, err := setYAML(current, mapping.Set)
	if err != nil {
		return err
	}
	return writeConfig(env, name, current, next)
}

const (
	yamlStr   = "!!str"
	yamlInt   = "!!int"
	yamlFloat = "!!float"
	yamlBool  = "!!bool"
)

// setYAML returns src with every key in set assigned; src itself when nothing changes.
func setYAML(src []byte, set map[string]string) ([]byte, error) {
	var docs []*yaml.Node
	dec := yaml.NewDecoder(bytes.NewReader(src))
	for {
		var doc yaml.Node
		err := dec.Decode(&doc)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, fmt.Errorf("the file is not valid YAML: %w", err)
		}
		docs = append(docs, &doc)
	}
	if len(docs) == 0 {
		docs = []*yaml.Node{{Kind: yaml.DocumentNode, Content: []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}}}
	}
	if len(docs[0].Content) == 0 {
		docs[0].Content = []*yaml.Node{{Kind: yaml.MappingNode, Tag: "!!map"}}
	}
	root := docs[0].Content[0]
	if root.Kind == yaml.ScalarNode && root.Tag == "!!null" {
		*root = yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", HeadComment: root.HeadComment, LineComment: root.LineComment, FootComment: root.FootComment}
	}
	if root.Kind != yaml.MappingNode {
		return nil, errors.New("the top level of the file must be a mapping")
	}

	keys := make([]string, 0, len(set))
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	changed := len(src) == 0
	for _, key := range keys {
		path, err := splitPath(key)
		if err != nil {
			return nil, err
		}
		c, err := yamlSet(root, path, set[key])
		if err != nil {
			return nil, fmt.Errorf("key %q: %w", key, err)
		}
		changed = changed || c
	}
	if !changed {
		return src, nil
	}

	for _, doc := range docs {
		untagMerges(doc)
	}
	var b bytes.Buffer
	enc := yaml.NewEncoder(&b)
	enc.SetIndent(yamlIndent(src))
	for _, doc := range docs {
		if err := enc.Encode(doc); err != nil {
			return nil, fmt.Errorf("encode: %w", err)
		}
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("encode: %w", err)
	}
	out := b.Bytes()
	if bytes.Contains(src, []byte("\r\n")) {
		out = bytes.ReplaceAll(out, []byte("\n"), []byte("\r\n"))
	}
	return out, nil
}

// yamlIndent guesses the file's indent width from the first indented line (2 when there is none).
func yamlIndent(src []byte) int {
	for _, line := range strings.Split(string(src), "\n") {
		trimmed := strings.TrimLeft(line, " ")
		if trimmed == "" || trimmed == "\r" || strings.HasPrefix(trimmed, "#") || strings.HasPrefix(trimmed, "- ") {
			continue
		}
		if n := len(line) - len(trimmed); n >= 2 && n <= 8 {
			return n
		}
	}
	return 2
}

// yamlSet assigns value at path below node and reports whether anything changed.
func yamlSet(node *yaml.Node, path []string, value string) (bool, error) {
	seg, rest := path[0], path[1:]
	var targets []*yaml.Node
	switch node.Kind {
	case yaml.SequenceNode:
		i, err := strconv.Atoi(seg)
		if err != nil || i < 0 || i >= len(node.Content) {
			return false, fmt.Errorf("%q does not index the list there (it has %d items; lists are not extended)", seg, len(node.Content))
		}
		targets = append(targets, node.Content[i])
	case yaml.MappingNode:
		for i := 0; i+1 < len(node.Content); i += 2 {
			if k := node.Content[i]; k.Kind == yaml.ScalarNode && k.Value == seg {
				targets = append(targets, node.Content[i+1])
			}
		}
		if len(targets) == 0 {
			node.Content = append(node.Content, yamlScalar(kindString, seg), yamlNew(rest, value))
			return true, nil
		}
	case yaml.AliasNode:
		return false, fmt.Errorf("the value above %q is an alias (*anchor); set the anchored value instead", seg)
	default:
		return false, fmt.Errorf("the value above %q is not a mapping", seg)
	}

	changed := false
	for _, target := range targets {
		if len(rest) > 0 {
			if target.Kind == yaml.ScalarNode && target.Tag == "!!null" {
				*target = *yamlNew(rest, value)
				changed = true
				continue
			}
			c, err := yamlSet(target, rest, value)
			if err != nil {
				return false, err
			}
			changed = changed || c
			continue
		}
		kind := kindFor(yamlKind(target), value)
		if target.Kind == yaml.ScalarNode && target.Value == value && yamlKind(target) == kind {
			continue
		}
		next := yamlScalar(kind, value)
		next.HeadComment, next.LineComment, next.FootComment = target.HeadComment, target.LineComment, target.FootComment
		if target.Kind == yaml.ScalarNode && kind == kindString && target.Style&(yaml.SingleQuotedStyle|yaml.DoubleQuotedStyle) != 0 && !strings.Contains(value, "\n") {
			next.Style = target.Style
		}
		*target = *next
		changed = true
	}
	return changed, nil
}

func yamlKind(n *yaml.Node) scalarKind {
	if n.Kind != yaml.ScalarNode {
		return kindNone
	}
	switch n.ShortTag() {
	case yamlStr:
		return kindString
	case yamlInt, yamlFloat:
		return kindNumber
	case yamlBool:
		return kindBool
	}
	return kindNone
}

// yamlOldBools are plain words YAML 1.1 parsers (PyYAML, SnakeYAML, many game servers) read as booleans; strings
// with these values are written quoted.
var yamlOldBools = map[string]bool{
	"y": true, "Y": true, "yes": true, "Yes": true, "YES": true, "n": true, "N": true, "no": true, "No": true, "NO": true,
	"on": true, "On": true, "ON": true, "off": true, "Off": true, "OFF": true,
}

// untagMerges drops the `!!merge` tag yaml.v3 would otherwise print in front of every `<<` key it re-encodes.
func untagMerges(n *yaml.Node) {
	if n.Kind == yaml.ScalarNode && n.Value == "<<" && n.ShortTag() == "!!merge" {
		n.Tag = ""
	}
	for _, c := range n.Content {
		untagMerges(c)
	}
}

func yamlScalar(kind scalarKind, value string) *yaml.Node {
	n := &yaml.Node{Kind: yaml.ScalarNode, Tag: yamlStr, Value: value}
	if kind == kindString && yamlOldBools[value] {
		n.Style = yaml.DoubleQuotedStyle
	}
	switch kind {
	case kindBool:
		n.Tag = yamlBool
	case kindNumber:
		n.Tag = yamlFloat
		if _, err := strconv.ParseInt(value, 10, 64); err == nil {
			n.Tag = yamlInt
		}
	}
	return n
}

// yamlNew builds the value for a missing key: the scalar, wrapped in one mapping per remaining segment.
func yamlNew(rest []string, value string) *yaml.Node {
	n := yamlScalar(kindFor(kindNone, value), value)
	for i := len(rest) - 1; i >= 0; i-- {
		n = &yaml.Node{Kind: yaml.MappingNode, Tag: "!!map", Content: []*yaml.Node{yamlScalar(kindString, rest[i]), n}}
	}
	return n
}
