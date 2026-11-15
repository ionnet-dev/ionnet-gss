// Package panel is the agent's side of the panel WebSocket: dial, the envelope request/response bookkeeping,
// enrolment, and the reconnecting session used by `gss-agent run`.
package panel

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/version"
)

// ErrRevoked is returned when the panel answered hello with `unauthorized`: it does not know this host id and
// credential (the host was removed, or the config belongs to another panel). Retrying can't help: stop and re-enrol.
var ErrRevoked = errors.New("the panel does not know this host's id and credential (removed, or enrolled with another panel): create an enrol token on the panel's Hosts page and run `gss-agent enrol --force`")

// errDisabled marks a hello refused with `forbidden` (the host is disabled) or a CLOSE_REVOKED close: the session
// retries every DisabledRetryInterval until the host is enabled again (or the next hello says it was removed).
var errDisabled = errors.New("the host is disabled (or was just removed) in the panel: enable it on its page there; this agent retries every minute and reconnects on its own")

// ErrInsecureURL is returned for a plain http:// panel URL on a non-loopback host without the insecure opt-in.
var ErrInsecureURL = errors.New("refusing to send credentials over plain http:// to a non-loopback panel: use https://, or pass --insecure if this network is trusted")

const (
	// BackoffMin and BackoffMax bound the reconnect delay (doubling, with jitter).
	BackoffMin = time.Second
	BackoffMax = 60 * time.Second
	// PingInterval is how often the agent sends a WebSocket ping (keeps proxies from timing out the socket).
	PingInterval = 30 * time.Second
	// RequestTimeout bounds the agent's own requests (enrol, hello).
	RequestTimeout = 30 * time.Second
	// DisabledRetryInterval is how often a disabled host tries its hello again.
	DisabledRetryInterval = 60 * time.Second
)

// RequestHandler answers one panel → agent request. Return a *protocol.RemoteError to choose the error code;
// any other error is sent as "internal".
type RequestHandler func(ctx context.Context, data json.RawMessage) (any, error)

// EventHandler handles one panel → agent event (none are defined yet).
type EventHandler func(ctx context.Context, data json.RawMessage)

// Handlers maps message types (protocol.Msg…) to handlers. Unknown request types are answered "unsupported".
type Handlers struct {
	Requests map[string]RequestHandler
	Events   map[string]EventHandler
}

// Conn is one open, authenticated panel connection.
type Conn interface {
	// Request sends a request and decodes the response data into res (may be nil).
	Request(ctx context.Context, msgType string, req, res any) error
	// Notify sends an event.
	Notify(ctx context.Context, msgType string, data any) error
	// Done is closed when the connection ends; Err then says why.
	Done() <-chan struct{}
	Err() error
	// Close closes with a normal close code.
	Close() error
}

// AgentURL turns the panel URL into the agent WebSocket URL: https://x → wss://x/ws/agent, http://x → ws://x/ws/agent.
// Plain http:// is accepted for loopback hosts (localhost, 127.0.0.0/8, ::1) and otherwise only with insecure
// (ErrInsecureURL), because the enrol token and the host credential travel over this socket.
func AgentURL(panelURL string, insecure bool) (string, error) {
	u, err := url.Parse(strings.TrimRight(panelURL, "/"))
	if err != nil {
		return "", fmt.Errorf("panel URL %q: %w", panelURL, err)
	}
	if u.Hostname() == "" {
		return "", fmt.Errorf("panel URL %q has no host; use the form https://gss.example.com", panelURL)
	}
	switch u.Scheme {
	case "https":
		u.Scheme = "wss"
	case "http":
		if !insecure && !IsLoopbackHost(u.Hostname()) {
			return "", fmt.Errorf("panel URL %q: %w", panelURL, ErrInsecureURL)
		}
		u.Scheme = "ws"
	default:
		return "", fmt.Errorf("panel URL %q must start with https:// (or http:// for a panel on this machine)", panelURL)
	}
	u.Path += "/ws/agent"
	return u.String(), nil
}

// IsLoopbackHost reports whether host (no port) names this machine: localhost, *.localhost or a loopback IP.
func IsLoopbackHost(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// dial opens the raw WebSocket. Shared by Enrol and Session.
func dial(ctx context.Context, panelURL string, insecure bool) (*websocket.Conn, error) {
	wsURL, err := AgentURL(panelURL, insecure)
	if err != nil {
		return nil, err
	}
	header := http.Header{}
	header.Set("User-Agent", "gss-agent/"+version.Version)
	ws, _, err := websocket.Dial(ctx, wsURL, &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		return nil, fmt.Errorf("connect to %s: %w", wsURL, err)
	}
	ws.SetReadLimit(protocol.MaxFrameBytes)
	return ws, nil
}

// Enrol dials the panel, sends the one `enrol` request and returns the host id and credential. The panel closes
// the socket with CLOSE_ENROLLED afterwards. insecure allows plain http:// to a non-loopback panel.
func Enrol(ctx context.Context, panelURL, token string, insecure bool, facts protocol.HostFacts) (protocol.EnrolResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, RequestTimeout)
	defer cancel()
	ws, err := dial(ctx, panelURL, insecure)
	if err != nil {
		return protocol.EnrolResponse{}, err
	}
	defer ws.CloseNow()

	req, err := protocol.NewRequest("a-1", protocol.MsgEnrol, protocol.EnrolRequest{
		Token:           token,
		ProtocolVersion: protocol.ProtocolVersion,
		Facts:           facts,
	})
	if err != nil {
		return protocol.EnrolResponse{}, err
	}
	if err := writeEnvelope(ctx, ws, req); err != nil {
		return protocol.EnrolResponse{}, err
	}
	for {
		env, err := readEnvelope(ctx, ws)
		if err != nil {
			return protocol.EnrolResponse{}, fmt.Errorf("enrol: %w", describeClose(err))
		}
		if env.Kind != protocol.MessageKindResponse || env.ID != req.ID {
			continue
		}
		if err := protocol.ErrorFromResponse(env); err != nil {
			var remote *protocol.RemoteError
			if errors.As(err, &remote) {
				return protocol.EnrolResponse{}, errors.New(remote.Message)
			}
			return protocol.EnrolResponse{}, err
		}
		res, err := protocol.DecodeData[protocol.EnrolResponse](env)
		if err != nil {
			return protocol.EnrolResponse{}, err
		}
		ws.Close(websocket.StatusNormalClosure, "enrolled")
		return res, nil
	}
}

// writeEnvelope sends one envelope as a text frame.
func writeEnvelope(ctx context.Context, ws *websocket.Conn, env protocol.Envelope) error {
	raw, err := json.Marshal(env)
	if err != nil {
		return fmt.Errorf("encode %s: %w", env.Type, err)
	}
	return ws.Write(ctx, websocket.MessageText, raw)
}

// readEnvelope reads one text frame and decodes it.
func readEnvelope(ctx context.Context, ws *websocket.Conn) (protocol.Envelope, error) {
	var env protocol.Envelope
	_, raw, err := ws.Read(ctx)
	if err != nil {
		return env, err
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return env, fmt.Errorf("the panel sent a frame that is not an envelope: %w", err)
	}
	return env, nil
}

// describeClose adds the meaning of the panel's close codes to a WebSocket close error.
func describeClose(err error) error {
	switch websocket.CloseStatus(err) {
	case protocol.CloseUnauthorized:
		return fmt.Errorf("the panel refused the request (unauthorized): %w", err)
	case protocol.CloseRevoked:
		return fmt.Errorf("the panel says this host was disabled or removed: %w", err)
	case protocol.CloseHelloTimeout:
		return fmt.Errorf("the panel closed the connection because no enrol or hello arrived in %d seconds: %w", protocol.HelloTimeoutSec, err)
	case protocol.CloseUnsupportedVersion:
		return fmt.Errorf("the panel does not speak this agent's protocol version, update gss-agent: %w", err)
	case protocol.CloseReplaced:
		return fmt.Errorf("another gss-agent with the same credential connected and took over: %w", err)
	case protocol.CloseProtocolError:
		return fmt.Errorf("the panel rejected a frame as malformed: %w", err)
	}
	return err
}

// Session keeps one authenticated connection up: dial, hello, run until it drops, back off, repeat.
type Session struct {
	// PanelURL, HostID and Credential come from the config file.
	PanelURL   string
	HostID     string
	Credential string
	// Insecure allows plain http:// to a non-loopback panel (set at enrolment with --insecure).
	Insecure bool
	// Hello builds the hello request for each (re)connect: fresh facts and the current server statuses.
	Hello func(ctx context.Context) (protocol.HelloRequest, error)
	// OnConnected runs after a successful hello, with the open connection (start the heartbeat loop there).
	OnConnected func(ctx context.Context, conn Conn, hello protocol.HelloResponse)
	Handlers    Handlers
}

// stableAfter is how long a connection must have been up before the next reconnect starts from BackoffMin again.
const stableAfter = 30 * time.Second

// Run blocks until ctx ends (nil), the panel no longer knows the host (ErrRevoked) or the URL is refused
// (ErrInsecureURL). A disabled host retries every DisabledRetryInterval; anything else reconnects with backoff.
func (s *Session) Run(ctx context.Context) error {
	backoff := BackoffMin
	for {
		startedAt := time.Now()
		err := s.runOnce(ctx)
		if ctx.Err() != nil {
			return nil
		}
		if errors.Is(err, ErrRevoked) || errors.Is(err, ErrInsecureURL) {
			return err
		}
		if time.Since(startedAt) >= stableAfter {
			backoff = BackoffMin
		}
		delay := jitter(backoff)
		if errors.Is(err, errDisabled) {
			delay = DisabledRetryInterval
			slog.Warn("the host is disabled in the panel, retrying", "error", err, "in", delay)
		} else {
			slog.Warn("panel connection lost, reconnecting", "error", err, "in", delay.Round(time.Millisecond))
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(delay):
		}
		backoff = min(backoff*2, BackoffMax)
	}
}

// jitter returns a delay between d/2 and d, so agents that lost the panel together don't return together.
func jitter(d time.Duration) time.Duration {
	return d/2 + time.Duration(rand.Int64N(int64(d/2)+1))
}

// runOnce makes one connection: collect the hello data, dial, hello, serve until it ends. It returns why it ended
// (nil only when ctx did). The hello data comes first so slow fact collection can't run into the panel's
// HELLO_TIMEOUT_SEC.
func (s *Session) runOnce(ctx context.Context) error {
	hello, err := s.Hello(ctx)
	if err != nil {
		return fmt.Errorf("collect hello data: %w", err)
	}

	dialCtx, cancelDial := context.WithTimeout(ctx, RequestTimeout)
	ws, err := dial(dialCtx, s.PanelURL, s.Insecure)
	cancelDial()
	if err != nil {
		return err
	}
	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	conn := newConn(connCtx, ws, s.Handlers)
	defer conn.CloseNow()

	hello.HostID = s.HostID
	hello.Credential = s.Credential
	hello.ProtocolVersion = protocol.ProtocolVersion

	var res protocol.HelloResponse
	helloCtx, cancelHello := context.WithTimeout(connCtx, RequestTimeout)
	err = conn.Request(helloCtx, protocol.MsgHello, hello, &res)
	cancelHello()
	if err != nil {
		return classify(err)
	}
	slog.Info("connected to the panel", "host", res.HostName, "panel", res.PanelVersion, "heartbeatSec", res.HeartbeatSec)
	if s.OnConnected != nil {
		s.OnConnected(connCtx, conn, res)
	}

	select {
	case <-ctx.Done():
		conn.Close()
		return nil
	case <-conn.Done():
		return classify(conn.Err())
	}
}

// classify turns a failed hello or a dropped connection into ErrRevoked only for an explicit `unauthorized` hello
// answer (the panel doesn't know the credential), into errDisabled for a `forbidden` answer or a CLOSE_REVOKED
// close (slow retry: the next hello tells disabled from removed), and into a readable, retryable error otherwise.
// Close codes alone never stop the agent: a timeout or a panel restart must not need a manual restart.
func classify(err error) error {
	var remote *protocol.RemoteError
	if errors.As(err, &remote) {
		switch remote.Code {
		case protocol.ErrorCodeUnauthorized:
			return fmt.Errorf("%w (panel: %s)", ErrRevoked, remote.Message)
		case protocol.ErrorCodeForbidden:
			return fmt.Errorf("%w (panel: %s)", errDisabled, remote.Message)
		}
	}
	if websocket.CloseStatus(err) == protocol.CloseRevoked {
		return fmt.Errorf("%w (%v)", errDisabled, describeClose(err))
	}
	return describeClose(err)
}

// wsConn is the Conn over a coder/websocket connection. A read loop dispatches incoming frames; Request waits for the
// matching response.
type wsConn struct {
	ws       *websocket.Conn
	handlers Handlers
	ctx      context.Context

	mu      sync.Mutex
	nextID  int
	pending map[string]chan protocol.Envelope
	err     error

	done chan struct{}
}

func newConn(ctx context.Context, ws *websocket.Conn, handlers Handlers) *wsConn {
	c := &wsConn{ws: ws, handlers: handlers, ctx: ctx, pending: map[string]chan protocol.Envelope{}, done: make(chan struct{})}
	go c.readLoop()
	go c.pingLoop()
	return c
}

// Request implements Conn.
func (c *wsConn) Request(ctx context.Context, msgType string, req, res any) error {
	c.mu.Lock()
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

	env, err := protocol.NewRequest(id, msgType, req)
	if err != nil {
		return err
	}
	if err := writeEnvelope(ctx, c.ws, env); err != nil {
		return fmt.Errorf("send %s: %w", msgType, err)
	}
	select {
	case resp := <-reply:
		return decodeResponse(resp, res)
	case <-c.done:
		// The panel answers a refused hello and closes right after: prefer the answer when both arrived.
		select {
		case resp := <-reply:
			return decodeResponse(resp, res)
		default:
		}
		return c.Err()
	case <-ctx.Done():
		return fmt.Errorf("%s: %w", msgType, ctx.Err())
	}
}

// decodeResponse returns the response's error, or decodes its data into res (may be nil).
func decodeResponse(resp protocol.Envelope, res any) error {
	if err := protocol.ErrorFromResponse(resp); err != nil {
		return err
	}
	if res == nil {
		return nil
	}
	out, err := protocol.DecodeData[json.RawMessage](resp)
	if err != nil {
		return err
	}
	return json.Unmarshal(out, res)
}

// Notify implements Conn.
func (c *wsConn) Notify(ctx context.Context, msgType string, data any) error {
	env, err := protocol.NewEvent(msgType, data)
	if err != nil {
		return err
	}
	return writeEnvelope(ctx, c.ws, env)
}

// Done implements Conn.
func (c *wsConn) Done() <-chan struct{} { return c.done }

// Err implements Conn.
func (c *wsConn) Err() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.err
}

// Close implements Conn.
func (c *wsConn) Close() error {
	return c.ws.Close(websocket.StatusNormalClosure, "agent shutting down")
}

// CloseNow drops the socket without the closing handshake.
func (c *wsConn) CloseNow() { c.ws.CloseNow() }

// finish records why the connection ended and wakes everyone waiting on it. Only the first call counts.
func (c *wsConn) finish(err error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	select {
	case <-c.done:
		return
	default:
	}
	if err == nil {
		err = errors.New("connection closed")
	}
	c.err = err
	close(c.done)
}

func (c *wsConn) readLoop() {
	for {
		env, err := readEnvelope(c.ctx, c.ws)
		if err != nil {
			c.finish(err)
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
		case protocol.MessageKindRequest:
			go c.serve(env)
		case protocol.MessageKindEvent:
			if handler := c.handlers.Events[env.Type]; handler != nil {
				go handler(c.ctx, env.Data)
			}
		}
	}
}

// serve answers one panel → agent request.
func (c *wsConn) serve(req protocol.Envelope) {
	var resp protocol.Envelope
	handler := c.handlers.Requests[req.Type]
	if handler == nil {
		resp = protocol.NewErrorResponse(req, protocol.ErrorCodeUnsupported, fmt.Sprintf("this gss-agent does not know the request %s; update the agent", req.Type))
	} else {
		data, err := handler(c.ctx, req.Data)
		var remote *protocol.RemoteError
		switch {
		case errors.As(err, &remote):
			resp = protocol.NewErrorResponse(req, remote.Code, remote.Message)
		case err != nil:
			slog.Error("request handler failed", "type", req.Type, "error", err)
			resp = protocol.NewErrorResponse(req, protocol.ErrorCodeInternal, err.Error())
		default:
			var encodeErr error
			if resp, encodeErr = protocol.NewResponse(req, data); encodeErr != nil {
				resp = protocol.NewErrorResponse(req, protocol.ErrorCodeInternal, encodeErr.Error())
			}
		}
	}
	if err := writeEnvelope(c.ctx, c.ws, resp); err != nil {
		slog.Warn("could not answer the panel", "type", req.Type, "error", err)
	}
}

// pingLoop keeps proxies from timing the idle socket out and notices a dead one.
func (c *wsConn) pingLoop() {
	ticker := time.NewTicker(PingInterval)
	defer ticker.Stop()
	for {
		select {
		case <-c.done:
			return
		case <-c.ctx.Done():
			return
		case <-ticker.C:
			pingCtx, cancel := context.WithTimeout(c.ctx, RequestTimeout)
			err := c.ws.Ping(pingCtx)
			cancel()
			if err != nil {
				c.finish(fmt.Errorf("ping: %w", err))
				c.ws.CloseNow()
				return
			}
		}
	}
}
