package initd

import (
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// SUBSCRIBER_BUFFER is how many lines a Console subscriber may fall behind before it is dropped (its channel is
// closed; it catches up with After).
const SUBSCRIBER_BUFFER = 1024

// ringConsole is the Console: the last `capacity` lines with contiguous seq numbers starting at 1.
type ringConsole struct {
	mu       sync.Mutex
	lines    []protocol.ConsoleLine
	start    int // index of the oldest line
	count    int
	lastSeq  int64
	subs     map[int]chan protocol.ConsoleLine
	nextSub  int
	onAppend func(protocol.ConsoleLine) // called under the lock, so listeners see lines in seq order
}

var _ Console = (*ringConsole)(nil)

func newConsole(capacity int, onAppend func(protocol.ConsoleLine)) *ringConsole {
	if capacity < 1 {
		capacity = protocol.InitBacklogLines
	}
	return &ringConsole{
		lines:    make([]protocol.ConsoleLine, capacity),
		subs:     map[int]chan protocol.ConsoleLine{},
		onAppend: onAppend,
	}
}

func (c *ringConsole) Append(stream protocol.ConsoleStream, text string) protocol.ConsoleLine {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.lastSeq++
	line := protocol.ConsoleLine{Seq: c.lastSeq, At: time.Now().UTC(), Stream: stream, Text: protocol.TruncateText(text, protocol.ConsoleLineMaxBytes)}
	capacity := len(c.lines)
	if c.count < capacity {
		c.lines[(c.start+c.count)%capacity] = line
		c.count++
	} else {
		c.lines[c.start] = line
		c.start = (c.start + 1) % capacity
	}
	for id, ch := range c.subs {
		select {
		case ch <- line:
		default:
			close(ch)
			delete(c.subs, id)
		}
	}
	if c.onAppend != nil {
		c.onAppend(line)
	}
	return line
}

func (c *ringConsole) After(afterSeq, limit int64) []protocol.ConsoleLine {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.count == 0 {
		return []protocol.ConsoleLine{}
	}
	oldest := c.lastSeq - int64(c.count) + 1
	skip := int64(0)
	if afterSeq >= oldest {
		skip = afterSeq - oldest + 1
	}
	n := int64(c.count) - skip
	if n <= 0 {
		return []protocol.ConsoleLine{}
	}
	if limit > 0 && n > limit {
		// More lines than asked for: the newest ones (a console opening wants the tail; a catch-up passes no limit).
		skip += n - limit
		n = limit
	}
	out := make([]protocol.ConsoleLine, 0, n)
	capacity := len(c.lines)
	for i := skip; i < skip+n; i++ {
		out = append(out, c.lines[(c.start+int(i))%capacity])
	}
	return out
}

func (c *ringConsole) Page(afterSeq, beforeSeq, limit int64, tail bool) ([]protocol.ConsoleLine, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	oldest := c.lastSeq - int64(c.count) + 1
	lo := max(afterSeq+1, oldest)
	hi := c.lastSeq + 1
	if beforeSeq > 0 {
		hi = min(hi, beforeSeq)
	}
	if c.count == 0 || lo >= hi {
		return []protocol.ConsoleLine{}, false
	}
	maxLines := int64(protocol.ConsoleBatchMaxLines)
	if limit > 0 {
		maxLines = min(maxLines, limit)
	}
	capacity := len(c.lines)
	at := func(seq int64) protocol.ConsoleLine { return c.lines[(c.start+int(seq-oldest))%capacity] }
	var batch protocol.LineBatch
	take := func(seq int64) bool {
		line := at(seq)
		size := protocol.LineSize(line)
		if int64(len(batch.Lines)) >= maxLines || !batch.Fits(size) {
			return false
		}
		batch.Add(line, size)
		return true
	}
	if tail {
		for seq := hi - 1; seq >= lo && take(seq); seq-- {
		}
		slices.Reverse(batch.Lines)
	} else {
		for seq := lo; seq < hi && take(seq); seq++ {
		}
	}
	return batch.Lines, int64(len(batch.Lines)) < hi-lo
}

func (c *ringConsole) LastSeq() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.lastSeq
}

func (c *ringConsole) Subscribe() (<-chan protocol.ConsoleLine, func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	id := c.nextSub
	c.nextSub++
	ch := make(chan protocol.ConsoleLine, SUBSCRIBER_BUFFER)
	c.subs[id] = ch
	return ch, func() {
		c.mu.Lock()
		defer c.mu.Unlock()
		if sub, ok := c.subs[id]; ok {
			close(sub)
			delete(c.subs, id)
		}
	}
}

// lineWriter splits a byte stream (pty, pipe) into console lines. Output is cleaned for display: CR overwrites
// (progress bars, jline redraws) keep only the final text, escape sequences other than SGR colours are dropped
// (the panel renders SGR), and invalid UTF-8 is replaced.
type lineWriter struct {
	mu   sync.Mutex
	buf  []byte
	emit func(text string)
	// split: the last line was cut at the length limit, so a newline right after it ends no new line.
	split bool
}

func newLineWriter(emit func(text string)) *lineWriter { return &lineWriter{emit: emit} }

func (w *lineWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	for _, b := range p {
		if b == '\n' {
			if !w.split || len(w.buf) > 0 {
				w.flushLocked()
			}
			w.split = false
			continue
		}
		w.split = false
		w.buf = append(w.buf, b)
		if len(w.buf) >= protocol.ConsoleLineMaxBytes {
			w.splitLocked()
		}
	}
	return len(p), nil
}

// splitLocked emits an over-long line as one console line, carrying the first bytes of a UTF-8 character that
// straddles the cut over to the next line.
func (w *lineWriter) splitLocked() {
	cut := len(w.buf)
	for i := len(w.buf) - 1; i >= 0 && i >= len(w.buf)-utf8.UTFMax; i-- {
		if utf8.RuneStart(w.buf[i]) {
			if !utf8.FullRune(w.buf[i:]) {
				cut = i
			}
			break
		}
	}
	rest := append([]byte(nil), w.buf[cut:]...)
	w.buf = w.buf[:cut]
	w.flushLocked()
	w.buf = append(w.buf, rest...)
	w.split = true
}

// Flush emits a pending partial line (at end of stream).
func (w *lineWriter) Flush() {
	w.mu.Lock()
	defer w.mu.Unlock()
	if len(w.buf) > 0 {
		w.flushLocked()
	}
}

func (w *lineWriter) flushLocked() {
	text := cleanLine(w.buf)
	w.buf = w.buf[:0]
	w.emit(text)
}

// ansiSequence matches CSI sequences, OSC sequences (BEL or ST terminated) and two-byte escapes.
var ansiSequence = regexp.MustCompile(`\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])`)

// sgrSequence matches colour/style sequences only.
var sgrSequence = regexp.MustCompile(`\x1b\[[0-9;:]*m`)

// cleanLine turns one raw line into display text.
func cleanLine(raw []byte) string {
	s := string(raw)
	if !utf8.ValidString(s) {
		s = strings.ToValidUTF8(s, "�")
	}
	s = strings.TrimRight(s, "\r")
	if strings.ContainsRune(s, '\x1b') {
		s = ansiSequence.ReplaceAllStringFunc(s, func(seq string) string {
			if sgrSequence.MatchString(seq) && len(sgrSequence.FindString(seq)) == len(seq) {
				return seq
			}
			return ""
		})
	}
	if i := strings.LastIndexByte(s, '\r'); i >= 0 {
		// Text after the last carriage return overwrote what was before it; an empty tail means nothing did.
		if tail := s[i+1:]; strings.TrimSpace(plainText(tail)) != "" {
			s = tail
		} else {
			s = s[:i]
			if j := strings.LastIndexByte(s, '\r'); j >= 0 {
				s = s[j+1:]
			}
		}
	}
	return strings.Map(func(r rune) rune {
		if r == '\t' || r == '\x1b' || r >= 0x20 && r != 0x7f {
			return r
		}
		return -1
	}, s)
}

// plainText strips SGR sequences (for pattern matching: ready, players).
func plainText(s string) string {
	if !strings.ContainsRune(s, '\x1b') {
		return s
	}
	return sgrSequence.ReplaceAllString(s, "")
}
