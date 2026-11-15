package initd

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

func TestRingConsole(t *testing.T) {
	c := newConsole(3, nil)
	if got := c.After(0, 10); len(got) != 0 {
		t.Fatalf("empty console returned %d lines", len(got))
	}
	for _, text := range []string{"a", "b", "c", "d", "e"} {
		c.Append(protocol.ConsoleStreamOutput, text)
	}
	texts := func(lines []protocol.ConsoleLine) string {
		out := ""
		for _, l := range lines {
			out += l.Text
		}
		return out
	}
	checks := []struct {
		after, limit int64
		want         string
	}{
		{0, 0, "cde"}, {0, 2, "de"}, {3, 0, "de"}, {4, 10, "e"}, {5, 10, ""}, {1, 10, "cde"},
	}
	for _, ck := range checks {
		if got := texts(c.After(ck.after, ck.limit)); got != ck.want {
			t.Errorf("After(%d, %d) = %q, want %q", ck.after, ck.limit, got, ck.want)
		}
	}
	if c.LastSeq() != 5 {
		t.Fatalf("LastSeq = %d", c.LastSeq())
	}
}

func TestCleanLine(t *testing.T) {
	cases := map[string]string{
		"plain\r": "plain",
		"> \r\x1b[K[12:00:00 INFO]: Done (1.2s)!": "[12:00:00 INFO]: Done (1.2s)!",
		"10%\r20%\r30%":                 "30%",
		"\x1b[33mwarn\x1b[0m":           "\x1b[33mwarn\x1b[0m",
		"\x1b]0;title\x07text\x1b[?25l": "text",
		"tail\r":                        "tail",
		"bell\x07":                      "bell",
	}
	for in, want := range cases {
		if got := cleanLine([]byte(in)); got != want {
			t.Errorf("cleanLine(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestConsolePageBytes(t *testing.T) {
	c := newConsole(protocol.InitBacklogLines, nil)
	long := strings.Repeat("<a&b>", protocol.ConsoleLineMaxBytes/5+10)
	for i := 0; i < protocol.InitBacklogLines; i++ {
		c.Append(protocol.ConsoleStreamOutput, long)
	}
	if got := len(c.After(0, 1)[0].Text); got != protocol.ConsoleLineMaxBytes {
		t.Fatalf("line kept %d bytes, want %d", got, protocol.ConsoleLineMaxBytes)
	}
	// Catch-up: pages forward until more is false, every line exactly once and in order, each page within limits.
	var after int64
	pages := 0
	for {
		lines, more := c.Page(after, 0, 0, false)
		if size := len(mustMarshal(t, protocol.BacklogResponse{Lines: lines, More: more})); size > protocol.ConsoleBatchMaxBytes+64 {
			t.Fatalf("page of %d bytes", size)
		}
		for _, line := range lines {
			if line.Seq != after+1 {
				t.Fatalf("seq %d after %d", line.Seq, after)
			}
			after = line.Seq
		}
		pages++
		if !more {
			break
		}
	}
	if after != protocol.InitBacklogLines || pages < 2 {
		t.Fatalf("caught up to %d in %d pages", after, pages)
	}
	// Tail: the newest lines, then page back with beforeSeq.
	lines, more := c.Page(0, 0, 1000, true)
	if !more || lines[len(lines)-1].Seq != protocol.InitBacklogLines {
		t.Fatalf("tail ended at %d (more %v)", lines[len(lines)-1].Seq, more)
	}
	older, _ := c.Page(0, lines[0].Seq, 1000, true)
	if older[len(older)-1].Seq != lines[0].Seq-1 {
		t.Fatalf("page back ended at %d, want %d", older[len(older)-1].Seq, lines[0].Seq-1)
	}
	// A short tail fits whole.
	if short, more := c.Page(0, 0, 3, true); len(short) != 3 || !more || short[2].Seq != protocol.InitBacklogLines {
		t.Fatalf("short tail %d lines, more %v", len(short), more)
	}
}

func TestLineWriterSplitsRunes(t *testing.T) {
	var got []string
	w := newLineWriter(func(text string) { got = append(got, text) })
	w.Write([]byte(strings.Repeat("é", protocol.ConsoleLineMaxBytes) + "\n"))
	for _, text := range got {
		if !utf8.ValidString(text) || strings.ContainsRune(text, '�') || len(text) > protocol.ConsoleLineMaxBytes {
			t.Fatalf("split line of %d bytes is not clean UTF-8", len(text))
		}
	}
	if len(got) != 2 {
		t.Fatalf("%d lines, want 2", len(got))
	}
}

func mustMarshal(t *testing.T, v any) []byte {
	raw, err := protocol.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}
