package panel

import (
	"strings"
	"testing"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// TestOutboxBudget fills an offline outbox past its byte budget: console batches go first, state changes stay.
func TestOutboxBudget(t *testing.T) {
	o := NewOutbox(1000, 64<<10)
	line := protocol.ConsoleLine{Stream: protocol.ConsoleStreamOutput, Text: strings.Repeat("<a&b>", 1000)}
	for i := 0; i < 50; i++ {
		o.Emit(protocol.MsgServerState, protocol.StateChange{State: protocol.ServerStateRunning}, DeliverAlways)
		o.Emit(protocol.MsgServerConsole, protocol.ConsoleBatch{Lines: []protocol.ConsoleLine{line}}, DeliverBuffered)
	}
	states, consoles := 0, 0
	for _, event := range o.queue {
		if event.msgType == protocol.MsgServerState {
			states++
		} else {
			consoles++
		}
	}
	if states != 50 || o.Bytes() > 64<<10 || consoles == 0 || consoles >= 50 {
		t.Fatalf("kept %d states and %d console batches in %d bytes", states, consoles, o.Bytes())
	}
	// Encoded without HTML escaping: a 5000-byte line stays about 5000 bytes.
	if size := len(o.queue[len(o.queue)-1].data); size > 5200 {
		t.Fatalf("console batch encoded to %d bytes", size)
	}
}
