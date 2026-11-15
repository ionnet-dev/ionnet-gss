package panel

import (
	"context"
	"encoding/json"
	"log/slog"
	"sync"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Default bounds of an Outbox: events and bytes of encoded data it holds while the panel is away (or slow).
const (
	DefaultOutboxLimit = 10000
	DefaultOutboxBytes = 64 << 20
)

// Delivery says what happens to an event while the panel is away.
type Delivery int

const (
	// DeliverOnline events are dropped while the panel is away (stats: the next sample replaces them).
	DeliverOnline Delivery = iota
	// DeliverBuffered events wait for the next connection but are the first to go when the buffer is full
	// (console lines: the panel can also fetch server.backlog).
	DeliverBuffered
	// DeliverKept events wait and go only when no buffered event is left to drop (player events).
	DeliverKept
	// DeliverAlways events are never dropped (state changes: few, small, and the panel's rows depend on them).
	DeliverAlways
)

// Outbox sends agent → panel events in order over whichever connection is up. Buffered and kept events wait while
// the panel is away and go out right after the next hello, behind its `servers` inventory. Set it as
// Session.Outbox and call Run once.
type Outbox struct {
	limit    int
	maxBytes int

	mu      sync.Mutex
	conn    Conn
	queue   []outboxEvent
	bytes   int
	nextID  uint64
	dropped int
	wake    chan struct{}
}

type outboxEvent struct {
	id       uint64
	msgType  string
	data     json.RawMessage
	delivery Delivery
}

// NewOutbox returns an outbox holding at most limit events and maxBytes of encoded data (DefaultOutboxLimit and
// DefaultOutboxBytes when <= 0). Past either bound the oldest buffered event goes first, then the oldest kept one;
// DeliverAlways events are never dropped.
func NewOutbox(limit, maxBytes int) *Outbox {
	if limit <= 0 {
		limit = DefaultOutboxLimit
	}
	if maxBytes <= 0 {
		maxBytes = DefaultOutboxBytes
	}
	return &Outbox{limit: limit, maxBytes: maxBytes, wake: make(chan struct{}, 1)}
}

// Emit queues an event and never blocks. The data is encoded now, so its size counts against the byte budget.
func (o *Outbox) Emit(msgType string, data any, delivery Delivery) {
	raw, err := protocol.Marshal(data)
	if err != nil {
		slog.Error("could not encode an event for the panel; dropping it", "type", msgType, "error", err)
		return
	}
	o.mu.Lock()
	if o.conn == nil && delivery == DeliverOnline {
		o.mu.Unlock()
		return
	}
	for (len(o.queue) >= o.limit || o.bytes+len(raw) > o.maxBytes) && o.dropOldestLocked() {
	}
	o.nextID++
	o.queue = append(o.queue, outboxEvent{id: o.nextID, msgType: msgType, data: raw, delivery: delivery})
	o.bytes += len(raw)
	o.mu.Unlock()
	o.signal()
}

// Pending is how many events wait to be sent.
func (o *Outbox) Pending() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return len(o.queue)
}

func (o *Outbox) signal() {
	select {
	case o.wake <- struct{}{}:
	default:
	}
}

// Bytes is the encoded size of the events waiting to be sent.
func (o *Outbox) Bytes() int {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.bytes
}

// dropOldestLocked makes room by dropping the oldest event of the most expendable kind: online or buffered first
// (console lines, which the panel can fetch again as server.backlog), then kept. Returns false when only
// DeliverAlways events are left. Caller holds o.mu.
func (o *Outbox) dropOldestLocked() bool {
	index := -1
	for _, kind := range []Delivery{DeliverOnline, DeliverBuffered, DeliverKept} {
		for i, event := range o.queue {
			if event.delivery == kind {
				index = i
				break
			}
		}
		if index >= 0 {
			break
		}
	}
	if index < 0 {
		return false
	}
	o.dropped++
	if o.dropped == 1 || o.dropped%1000 == 0 {
		slog.Warn("the panel is away or too slow: dropping the oldest buffered events (state changes are kept, and the hello inventory carries every server's current state)", "dropped", o.dropped, "type", o.queue[index].msgType)
	}
	o.bytes -= len(o.queue[index].data)
	o.queue = append(o.queue[:index], o.queue[index+1:]...)
	return true
}

// attach starts sending over conn (after a successful hello).
func (o *Outbox) attach(conn Conn) {
	o.mu.Lock()
	o.conn = conn
	o.dropped = 0
	waiting := len(o.queue)
	o.mu.Unlock()
	if waiting > 0 {
		slog.Info("sending events buffered while the panel was away", "count", waiting)
	}
	o.signal()
}

// detach stops using conn: online-only events still queued are discarded, the rest wait for the next connection.
func (o *Outbox) detach(conn Conn) {
	o.mu.Lock()
	defer o.mu.Unlock()
	if o.conn != conn {
		return
	}
	o.conn = nil
	kept := o.queue[:0]
	for _, event := range o.queue {
		if event.delivery != DeliverOnline {
			kept = append(kept, event)
		} else {
			o.bytes -= len(event.data)
		}
	}
	clear(o.queue[len(kept):])
	o.queue = kept
}

// Run sends queued events until ctx ends. A failed send detaches the connection (the session reconnects); the
// event stays queued unless it is online-only.
func (o *Outbox) Run(ctx context.Context) {
	for {
		o.mu.Lock()
		conn := o.conn
		var next outboxEvent
		ready := conn != nil && len(o.queue) > 0
		if ready {
			next = o.queue[0]
		}
		o.mu.Unlock()
		if !ready {
			select {
			case <-ctx.Done():
				return
			case <-o.wake:
				continue
			}
		}

		sendCtx, cancel := context.WithTimeout(ctx, RequestTimeout)
		err := conn.Notify(sendCtx, next.msgType, next.data)
		cancel()
		if err != nil {
			if ctx.Err() != nil {
				return
			}
			slog.Warn("could not send an event to the panel; keeping it for the next connection", "type", next.msgType, "error", err)
			o.detach(conn)
			continue
		}
		o.mu.Lock()
		for i, event := range o.queue {
			if event.id == next.id {
				o.bytes -= len(event.data)
				o.queue = append(o.queue[:i], o.queue[i+1:]...)
				break
			}
		}
		o.mu.Unlock()
	}
}
