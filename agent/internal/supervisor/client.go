// Package supervisor is the agent's client for gss-init's unix socket (M2). One Client per running server; the agent
// reconnects whenever it restarts, then calls Status and Backlog(lastSeq) to catch up.
package supervisor

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrClosed is returned by requests on a client whose socket has closed.
var ErrClosed = errors.New("the gss-init socket is closed")

// Event is one event from gss-init. Exactly one field is set.
type Event struct {
	Console *protocol.ConsoleLine
	State   *protocol.StateChange
	Player  *protocol.PlayerEvent
	// Gap marks where console lines were dropped because the consumer fell behind: catch up with Backlog from the
	// last line seen.
	Gap bool
}

// Queue bounds: console events beyond either are dropped (replaced by one Gap event); state and player events are
// always kept.
const (
	MAX_QUEUED_CONSOLE       = 10000
	MAX_QUEUED_CONSOLE_BYTES = 8 << 20
)

// Client talks to one gss-init.
type Client interface {
	Status(ctx context.Context) (protocol.InitStatus, error)
	Install(ctx context.Context) (protocol.InitStatus, error)
	Start(ctx context.Context) (protocol.InitStatus, error)
	// Stop stops the game; a non-empty reason becomes the reason of the final `stopped` state.
	Stop(ctx context.Context, kill bool, reason string) (protocol.InitStatus, error)
	Input(ctx context.Context, line string) error
	// Backlog pages through gss-init's ring buffer (see InitBacklogRequest); answers are within the CONSOLE_BATCH_*
	// limits, and More says lines were left out.
	Backlog(ctx context.Context, req protocol.InitBacklogRequest) (protocol.BacklogResponse, error)
	Reload(ctx context.Context) error
	// Events delivers events until the socket closes; then the channel is closed. Events queue up to
	// MAX_QUEUED_CONSOLE / MAX_QUEUED_CONSOLE_BYTES of console lines (then a Gap), so a slow reader never stalls
	// responses and never grows memory without bound.
	Events() <-chan Event
	Close() error
}

// Dial connects to the socket at path (paths.Layout.ServerSocket). Paths longer than a unix socket address allows
// (108 bytes on Linux, easy to reach with a deep data root) are reached through the folder's file descriptor.
func Dial(ctx context.Context, path string) (Client, error) {
	address, release, err := socketAddress(path)
	if err != nil {
		return nil, fmt.Errorf("connect to gss-init at %s: %w", path, err)
	}
	conn, err := (&net.Dialer{}).DialContext(ctx, "unix", address)
	release()
	if err != nil {
		return nil, fmt.Errorf("connect to gss-init at %s: %w", path, err)
	}
	c := &client{
		conn:    conn,
		path:    path,
		pending: map[string]chan protocol.Envelope{},
		queued:  make(chan Event),
		events:  make(chan Event),
		done:    make(chan struct{}),
		closed:  make(chan struct{}),
	}
	go c.readLoop()
	go c.deliver()
	return c, nil
}

type client struct {
	conn net.Conn
	path string

	writeMu sync.Mutex

	mu      sync.Mutex
	nextID  int
	pending map[string]chan protocol.Envelope
	err     error

	queued chan Event // readLoop → deliver
	events chan Event // deliver → Events()
	// done is closed when the socket ends for any reason; closed only when Close was called (nobody reads Events()).
	done      chan struct{}
	closed    chan struct{}
	closeOnce sync.Once
}

func (c *client) Status(ctx context.Context) (protocol.InitStatus, error) {
	var res protocol.InitStatus
	err := c.request(ctx, protocol.InitMsgStatus, protocol.Empty{}, &res)
	return res, err
}

func (c *client) Install(ctx context.Context) (protocol.InitStatus, error) {
	var res protocol.InitStatus
	err := c.request(ctx, protocol.InitMsgInstall, protocol.Empty{}, &res)
	return res, err
}

func (c *client) Start(ctx context.Context) (protocol.InitStatus, error) {
	var res protocol.InitStatus
	err := c.request(ctx, protocol.InitMsgStart, protocol.Empty{}, &res)
	return res, err
}

func (c *client) Stop(ctx context.Context, kill bool, reason string) (protocol.InitStatus, error) {
	var res protocol.InitStatus
	err := c.request(ctx, protocol.InitMsgStop, protocol.InitStopRequest{Kill: kill, Reason: reason}, &res)
	return res, err
}

func (c *client) Input(ctx context.Context, line string) error {
	return c.request(ctx, protocol.InitMsgInput, protocol.InputLine{Line: line}, nil)
}

func (c *client) Backlog(ctx context.Context, req protocol.InitBacklogRequest) (protocol.BacklogResponse, error) {
	var res protocol.BacklogResponse
	if err := c.request(ctx, protocol.InitMsgBacklog, req, &res); err != nil {
		return protocol.BacklogResponse{}, err
	}
	if res.Lines == nil {
		res.Lines = []protocol.ConsoleLine{}
	}
	return res, nil
}

func (c *client) Reload(ctx context.Context) error {
	return c.request(ctx, protocol.InitMsgReload, protocol.Empty{}, nil)
}

func (c *client) Events() <-chan Event { return c.events }

func (c *client) Close() error {
	err := c.conn.Close()
	c.finish(ErrClosed)
	c.closeOnce.Do(func() { close(c.closed) })
	return err
}

// request sends one request and waits for its response. A failed response comes back as *protocol.RemoteError.
func (c *client) request(ctx context.Context, msgType string, data, out any) error {
	c.mu.Lock()
	if c.err != nil {
		err := c.err
		c.mu.Unlock()
		return err
	}
	c.nextID++
	id := fmt.Sprintf("a-%d", c.nextID)
	reply := make(chan protocol.Envelope, 1)
	c.pending[id] = reply
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
	}()

	env, err := protocol.NewRequest(id, msgType, data)
	if err != nil {
		return err
	}
	if err := c.write(ctx, env); err != nil {
		return fmt.Errorf("gss-init %s: %w", msgType, err)
	}

	select {
	case resp := <-reply:
		return decodeReply(resp, out)
	case <-c.done:
		select { // The answer may have arrived just before the socket closed.
		case resp := <-reply:
			return decodeReply(resp, out)
		default:
		}
		return fmt.Errorf("gss-init %s: %w", msgType, c.Err())
	case <-ctx.Done():
		return fmt.Errorf("gss-init %s: %w", msgType, ctx.Err())
	}
}

// decodeReply returns the response's error, or decodes its data into out (may be nil).
func decodeReply(resp protocol.Envelope, out any) error {
	if err := protocol.ErrorFromResponse(resp); err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	if len(resp.Data) == 0 {
		return fmt.Errorf("gss-init answered %s without data", resp.Type)
	}
	if err := json.Unmarshal(resp.Data, out); err != nil {
		return fmt.Errorf("decode gss-init %s response: %w", resp.Type, err)
	}
	return nil
}

// write sends one frame, bounded by ctx's deadline (or 10 s).
func (c *client) write(ctx context.Context, env protocol.Envelope) error {
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	deadline, ok := ctx.Deadline()
	if !ok {
		deadline = time.Now().Add(10 * time.Second)
	}
	if err := c.conn.SetWriteDeadline(deadline); err != nil {
		return err
	}
	return protocol.WriteFrame(c.conn, env)
}

// Err is why the socket closed, or nil while it is open.
func (c *client) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// finish records why the socket ended and wakes every waiter. Only the first call counts.
func (c *client) finish(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.err != nil {
		return
	}
	c.err = err
	close(c.done)
}

func (c *client) readLoop() {
	defer close(c.queued)
	reader := protocol.NewFrameReader(c.conn)
	for {
		env, err := protocol.ReadFrame(reader)
		if err != nil {
			c.finish(fmt.Errorf("%w (%v)", ErrClosed, err))
			c.conn.Close()
			return
		}
		switch env.Kind {
		case protocol.MessageKindResponse:
			c.mu.Lock()
			reply := c.pending[env.ID]
			c.mu.Unlock()
			if reply != nil {
				reply <- env
			}
		case protocol.MessageKindEvent:
			event, ok := decodeEvent(env)
			if !ok {
				continue
			}
			select {
			case c.queued <- event:
			case <-c.closed:
				return
			}
		default:
			slog.Warn("gss-init sent an unexpected frame", "socket", c.path, "kind", env.Kind, "type", env.Type)
		}
	}
}

// deliver moves events from readLoop to Events() through a queue, so the read loop (and with it every response)
// never waits for the consumer. Console lines past the queue bounds are dropped and one Gap event takes their place.
// Events() closes after the last queued event once the socket ended, or at once after Close.
func (c *client) deliver() {
	defer close(c.events)
	var queue []Event
	consoleCount, consoleBytes := 0, 0
	dropped := 0
	in := c.queued
	for in != nil || len(queue) > 0 {
		var out chan Event
		var next Event
		if len(queue) > 0 {
			out = c.events
			next = queue[0]
		}
		select {
		case event, ok := <-in:
			if !ok {
				in = nil
				continue
			}
			if event.Console != nil {
				size := len(event.Console.Text) + 64
				if consoleCount >= MAX_QUEUED_CONSOLE || consoleBytes+size > MAX_QUEUED_CONSOLE_BYTES {
					if dropped == 0 || len(queue) == 0 || !queue[len(queue)-1].Gap {
						queue = append(queue, Event{Gap: true})
					}
					dropped++
					if dropped == 1 || dropped%10000 == 0 {
						slog.Warn("console lines arrive faster than the agent forwards them; catching up through the backlog", "socket", c.path, "dropped", dropped)
					}
					continue
				}
				consoleCount++
				consoleBytes += size
			}
			queue = append(queue, event)
		case out <- next:
			if next.Console != nil {
				consoleCount--
				consoleBytes -= len(next.Console.Text) + 64
			}
			queue[0] = Event{}
			queue = queue[1:]
		case <-c.closed:
			return
		}
	}
}

// decodeEvent turns an event envelope into an Event. Unknown or malformed events are logged and skipped.
func decodeEvent(env protocol.Envelope) (Event, bool) {
	var event Event
	var err error
	switch env.Type {
	case protocol.InitMsgConsole:
		var line protocol.ConsoleLine
		line, err = protocol.DecodeData[protocol.ConsoleLine](env)
		event.Console = &line
	case protocol.InitMsgState:
		var change protocol.StateChange
		change, err = protocol.DecodeData[protocol.StateChange](env)
		event.State = &change
	case protocol.InitMsgPlayer:
		var player protocol.PlayerEvent
		player, err = protocol.DecodeData[protocol.PlayerEvent](env)
		event.Player = &player
	default:
		slog.Debug("ignoring an unknown gss-init event", "type", env.Type)
		return event, false
	}
	if err != nil {
		slog.Warn("gss-init sent a malformed event", "type", env.Type, "error", err)
		return event, false
	}
	return event, true
}
