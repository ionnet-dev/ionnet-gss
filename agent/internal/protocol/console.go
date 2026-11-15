package protocol

import (
	"bytes"
	"encoding/json"
	"unicode/utf8"
)

// Hand-written helpers for console data, shared by gss-init (backlog answers) and the agent (server.console
// batches), so both sides cut by the same CONSOLE_* limits.

// Marshal is json.Marshal without HTML escaping: `<`, `>` and `&` stay one byte instead of six (`<`), which
// matters for console lines full of `<player>` chat. Every frame on either channel is encoded with it.
func Marshal(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(buf.Bytes(), []byte("\n")), nil
}

// LineSize is the encoded size of one console line as an element of a JSON array, the separating comma included.
func LineSize(line ConsoleLine) int {
	raw, err := Marshal(line)
	if err != nil {
		return ConsoleBatchMaxBytes // Can't happen for these field types; counts as a full batch.
	}
	return len(raw) + 1
}

// TruncateText cuts text to at most max bytes without splitting a UTF-8 character.
func TruncateText(text string, max int) string {
	if len(text) <= max {
		return text
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(text[cut]) {
		cut--
	}
	return text[:cut]
}

// LineBatch collects console lines up to CONSOLE_BATCH_MAX_LINES and CONSOLE_BATCH_MAX_BYTES of encoded JSON.
type LineBatch struct {
	Lines []ConsoleLine
	Bytes int
}

// Fits reports whether a line of size bytes (LineSize) can join the batch. An empty batch takes any line.
func (b *LineBatch) Fits(size int) bool {
	if len(b.Lines) == 0 {
		return true
	}
	return len(b.Lines) < ConsoleBatchMaxLines && b.Bytes+size <= ConsoleBatchMaxBytes
}

// Add appends a line of size bytes (LineSize).
func (b *LineBatch) Add(line ConsoleLine, size int) {
	b.Lines = append(b.Lines, line)
	b.Bytes += size
}

// Take returns the collected lines and empties the batch.
func (b *LineBatch) Take() []ConsoleLine {
	lines := b.Lines
	b.Lines, b.Bytes = nil, 0
	return lines
}

// SplitLines cuts lines into batches within the CONSOLE_BATCH_* limits, in order.
func SplitLines(lines []ConsoleLine) [][]ConsoleLine {
	var out [][]ConsoleLine
	var batch LineBatch
	for _, line := range lines {
		size := LineSize(line)
		if !batch.Fits(size) {
			out = append(out, batch.Take())
		}
		batch.Add(line, size)
	}
	if len(batch.Lines) > 0 {
		out = append(out, batch.Take())
	}
	return out
}
