package panel

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

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

// recordingConn is a Conn that records the events it was asked to send.
type recordingConn struct {
	mu   sync.Mutex
	sent []string
	done chan struct{}
}

func (c *recordingConn) Request(ctx context.Context, msgType string, req, res any) error { return nil }

func (c *recordingConn) Notify(ctx context.Context, msgType string, data any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sent = append(c.sent, msgType)
	return nil
}

func (c *recordingConn) Done() <-chan struct{} { return c.done }
func (c *recordingConn) Err() error            { return nil }
func (c *recordingConn) Close() error          { return nil }

// TestOutboxFlush waits for queued events to be sent, and gives up with ctx while no connection is attached.
func TestOutboxFlush(t *testing.T) {
	o := NewOutbox(0, 0)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go o.Run(ctx)
	o.Emit(protocol.MsgAgentUpdateStatus, protocol.AgentUpdateStatus{State: protocol.AgentUpdateStateRestarting}, DeliverAlways)

	waitCtx, cancelWait := context.WithTimeout(ctx, 50*time.Millisecond)
	defer cancelWait()
	if err := o.Flush(waitCtx); err == nil {
		t.Fatal("Flush returned nil with no connection attached")
	}

	conn := &recordingConn{done: make(chan struct{})}
	o.attach(conn)
	flushCtx, cancelFlush := context.WithTimeout(ctx, 2*time.Second)
	defer cancelFlush()
	if err := o.Flush(flushCtx); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	conn.mu.Lock()
	defer conn.mu.Unlock()
	if len(conn.sent) != 1 || conn.sent[0] != protocol.MsgAgentUpdateStatus {
		t.Fatalf("sent %v", conn.sent)
	}
}
