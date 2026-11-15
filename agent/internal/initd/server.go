package initd

import (
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// CONN_QUEUE is how many frames may wait for a slow agent connection before it is dropped. The agent reconnects
// and catches up with status + backlog, so dropping is always safe; blocking the game's output never is.
const CONN_QUEUE = 4096

// WRITE_TIMEOUT bounds one frame write to the agent.
const WRITE_TIMEOUT = 10 * time.Second

// hub fans events out to every connected agent socket. Events are queued in the order publish is called; the
// supervisor publishes state changes under its lock and console lines under the console's lock, so each
// connection sees a line before the state change it caused.
type hub struct {
	mu     sync.Mutex
	conns  map[*agentConn]struct{}
	nextID int
	log    func(format string, args ...any)
}

func newHub(log func(format string, args ...any)) *hub {
	return &hub{conns: map[*agentConn]struct{}{}, log: log}
}

func (h *hub) publish(env protocol.Envelope) {
	h.mu.Lock()
	defer h.mu.Unlock()
	for c := range h.conns {
		if c.isClosed() {
			delete(h.conns, c)
			continue
		}
		select {
		case c.out <- env:
		default:
			h.log("agent connection %d is %d frames behind; closing it (it reconnects and catches up)", c.id, CONN_QUEUE)
			c.close()
			delete(h.conns, c)
		}
	}
}

func (h *hub) add(nc net.Conn) *agentConn {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.nextID++
	c := &agentConn{
		id:      h.nextID,
		nc:      nc,
		out:     make(chan protocol.Envelope, CONN_QUEUE),
		done:    make(chan struct{}),
		drain:   make(chan struct{}),
		written: make(chan struct{}),
	}
	h.conns[c] = struct{}{}
	return c
}

func (h *hub) remove(c *agentConn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.conns, c)
}

// closeAll flushes what is queued (the final state events at shutdown) and closes every connection.
func (h *hub) closeAll(timeout time.Duration) {
	h.mu.Lock()
	conns := make([]*agentConn, 0, len(h.conns))
	for c := range h.conns {
		conns = append(conns, c)
	}
	h.conns = map[*agentConn]struct{}{}
	h.mu.Unlock()
	deadline := time.After(timeout)
	for _, c := range conns {
		c.drainOnce.Do(func() { close(c.drain) })
	}
	for _, c := range conns {
		select {
		case <-c.written:
		case <-deadline:
		}
		c.close()
	}
}

// agentConn is one agent connection: a reader that answers requests in order and a writer that sends responses
// and events.
type agentConn struct {
	id        int
	nc        net.Conn
	out       chan protocol.Envelope
	done      chan struct{} // closed by close()
	drain     chan struct{} // closed at shutdown: write what is queued, then stop
	drainOnce sync.Once
	written   chan struct{} // closed when the writer stopped
	closeOnce sync.Once
}

func (c *agentConn) isClosed() bool {
	select {
	case <-c.done:
		return true
	default:
		return false
	}
}

func (c *agentConn) close() {
	c.closeOnce.Do(func() {
		close(c.done)
		c.nc.Close()
	})
}

// respond queues a response, waiting for room (responses are never dropped while the connection lives).
func (c *agentConn) respond(env protocol.Envelope) {
	select {
	case c.out <- env:
	case <-c.done:
	}
}

func (c *agentConn) writer() {
	defer close(c.written)
	write := func(env protocol.Envelope) bool {
		_ = c.nc.SetWriteDeadline(time.Now().Add(WRITE_TIMEOUT))
		if err := protocol.WriteFrame(c.nc, env); err != nil {
			c.close()
			return false
		}
		return true
	}
	for {
		select {
		case env := <-c.out:
			if !write(env) {
				return
			}
		case <-c.drain:
			for {
				select {
				case env := <-c.out:
					if !write(env) {
						return
					}
				default:
					return
				}
			}
		case <-c.done:
			return
		}
	}
}

// socketOwner is who may connect to the supervisor socket: the host agent's uid and gid (InitSpec.agentUid /
// agentGid). -1 = whoever owns the run folder (the agent created it; root for a root agent).
type socketOwner struct {
	uid, gid int
}

// listen opens the supervisor socket. A socket file left by an earlier container run is replaced. The run folder is
// handed to the agent's uid with mode 0700 and the socket with 0600, so on the host only the agent (and root) can
// reach it; inside the container gss-init refuses every peer that isn't outside its pid namespace (peerError).
func listen(path string, owner socketOwner, logf func(format string, args ...any)) (net.Listener, error) {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create %s: %w", dir, err)
	}
	if owner.uid < 0 || owner.gid < 0 {
		info, err := os.Stat(dir)
		if err != nil {
			return nil, fmt.Errorf("inspect %s: %w", dir, err)
		}
		if st, ok := info.Sys().(*syscall.Stat_t); ok {
			if owner.uid < 0 {
				owner.uid = int(st.Uid)
			}
			if owner.gid < 0 {
				owner.gid = int(st.Gid)
			}
		}
	}
	if os.Geteuid() == 0 {
		if err := os.Chown(dir, owner.uid, owner.gid); err != nil {
			logf("could not hand %s to uid %d: %v", dir, owner.uid, err)
		}
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		logf("could not chmod %s: %v", dir, err)
	}
	if info, err := os.Lstat(path); err == nil {
		if info.Mode()&fs.ModeSocket == 0 {
			return nil, fmt.Errorf("%s exists and is not a socket; remove it", path)
		}
		if err := os.Remove(path); err != nil {
			return nil, fmt.Errorf("remove stale socket %s: %w", path, err)
		}
	}
	// The socket is created 0600 from the start (umask), so there is no moment in which anyone else could connect.
	previous := syscall.Umask(0o177)
	l, err := net.Listen("unix", path)
	syscall.Umask(previous)
	if err != nil {
		return nil, fmt.Errorf("listen on %s: %w", path, err)
	}
	l.(*net.UnixListener).SetUnlinkOnClose(true)
	if os.Geteuid() == 0 {
		if err := os.Chown(path, owner.uid, owner.gid); err != nil {
			l.Close()
			return nil, fmt.Errorf("hand %s to uid %d: %w", path, owner.uid, err)
		}
	}
	if err := os.Chmod(path, 0o600); err != nil {
		l.Close()
		return nil, fmt.Errorf("chmod %s: %w", path, err)
	}
	return l, nil
}

// peerError refuses connections from processes inside this container (the game or anything it started): as PID 1
// gss-init sees the host agent with pid 0 (outside its pid namespace), and anything in the container with its pid.
func peerError(nc net.Conn) error {
	if os.Getpid() != 1 {
		return nil
	}
	uc, ok := nc.(*net.UnixConn)
	if !ok {
		return errors.New("not a unix socket connection")
	}
	raw, err := uc.SyscallConn()
	if err != nil {
		return err
	}
	var cred *syscall.Ucred
	var credErr error
	if err := raw.Control(func(fd uintptr) {
		cred, credErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if credErr != nil {
		return credErr
	}
	if cred.Pid != 0 {
		return fmt.Errorf("connection from pid %d (uid %d) inside the container refused; only the host agent may connect", cred.Pid, cred.Uid)
	}
	return nil
}

// serve accepts agent connections until the listener closes. Connections are independent: any number may come
// and go (an agent restart, a debugging client) without touching the game.
func (s *Supervisor) serve(l net.Listener) {
	for {
		nc, err := l.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return
			}
			s.logf("accept: %v", err)
			time.Sleep(100 * time.Millisecond)
			continue
		}
		if err := peerError(nc); err != nil {
			s.logf("%v", err)
			nc.Close()
			continue
		}
		c := s.hub.add(nc)
		s.logf("agent connection %d opened", c.id)
		go c.writer()
		go s.readConn(c)
	}
}

func (s *Supervisor) readConn(c *agentConn) {
	defer func() {
		s.hub.remove(c)
		c.close()
		s.logf("agent connection %d closed", c.id)
	}()
	r := protocol.NewFrameReader(c.nc)
	for {
		env, err := protocol.ReadFrame(r)
		if err != nil {
			if !errors.Is(err, io.EOF) && !errors.Is(err, net.ErrClosed) {
				s.logf("agent connection %d: %v", c.id, err)
			}
			return
		}
		if env.Kind != protocol.MessageKindRequest {
			continue
		}
		c.respond(s.handle(env))
	}
}
