package servers

import (
	"context"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/supervisor"
)

// Container conventions (M2). Every container and network carries LabelServer so Restore can find them.
const (
	LabelServer  = "ionnet-gss.server"  // value: server UUID
	LabelSpec    = "ionnet-gss.spec"    // value: spec hash
	LabelName    = "ionnet-gss.name"    // value: display name (informational)
	LabelService = "ionnet-gss.service" // value: stack service key; absent on the game container
	LabelCleanup = "ionnet-gss.cleanup" // value: server UUID; short-lived file cleanup container
)

// InitCapabilities are added back on top of "drop all" for gss-init (root in the container): CHOWN, DAC_OVERRIDE
// and FOWNER to manage /data files owned by GAME_UID, SETUID/SETGID to drop to GAME_UID, KILL to signal the game.
// The game loses them all when gss-init switches to GAME_UID; no-new-privileges keeps setuid binaries inert.
var InitCapabilities = []string{"CHOWN", "DAC_OVERRIDE", "FOWNER", "KILL", "SETGID", "SETUID"}

// ContainerName is the game container: gss-<uuid>.
func ContainerName(serverID string) string { return "gss-" + serverID }

// NetworkName is the per-server bridge network: gss-<uuid>.
func NetworkName(serverID string) string { return "gss-" + serverID }

// DialSupervisor opens a supervisor client; swappable for tests and a fake gss-init.
type DialSupervisor = func(socketPath string) (supervisor.Client, error)

// Options are the Manager's dependencies.
type Options struct {
	Layout paths.Layout
	Docker docker.Client
	Sink   Sink
	Dial   DialSupervisor // nil = supervisor.Dial with a 5 s timeout.
}

// Timing (M2).
const (
	// readyTimeout bounds the wait for gss-init's socket after the container starts.
	readyTimeout = 60 * time.Second
	// requestTimeout bounds one supervisor request.
	requestTimeout = 15 * time.Second
	// defaultStopTimeout is used when the spec sets no stop timeout.
	defaultStopTimeout = 30 * time.Second
	// stopGrace is added to the spec's stop timeout for `docker stop`: gss-init stops the game (up to the timeout)
	// and runs the post-stop hook before it exits.
	stopGrace = 15 * time.Second
	// consoleFlush is the longest a console line waits before its batch goes to the Sink.
	consoleFlush = 100 * time.Millisecond
	// saveInterval is how often runtime state (console positions) is written when it changed.
	saveInterval = 5 * time.Second
)

// New returns the Manager. Call Restore before serving requests.
//
// Provision, in order: validate spec (paths, ports, limits), write <server>/spec/spec.json (InitSpec) and
// spec/files/** (0755 for executable), create data/ and run/ (see ownership in fs.go), ensure the image (inspect,
// pull only when missing; non-empty `packages` → unsupported until derived builds land), ensure the network,
// (re)create the container when the spec hash label differs: memory/CPU/PID limits, CapDrop ALL + InitCapabilities,
// no Docker socket, binds data→/data, spec→/gss/spec:ro, run→/gss/run, published ports host=container, Tty off
// (gss-init owns the pty). Then start it so gss-init runs install (reinstall or first provision) and stays idle.
// The container keeps running while the game is stopped: it is gss-init's lifetime, not the game's.
func New(opts Options) Manager {
	if opts.Dial == nil {
		opts.Dial = func(socketPath string) (supervisor.Client, error) {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			return supervisor.Dial(ctx, socketPath)
		}
	}
	m := &manager{
		opts:    opts,
		servers: map[string]*server{},
		dirty:   make(chan struct{}, 1),
		quit:    make(chan struct{}),
		saved:   make(chan struct{}),
	}
	go m.saveLoop()
	go m.diskLoop()
	return m
}

type manager struct {
	opts Options

	mu      sync.Mutex
	servers map[string]*server
	closed  bool

	saveMu sync.Mutex // serialises state file writes
	dirty  chan struct{}
	quit   chan struct{}
	saved  chan struct{} // closed when saveLoop has written the final state
}

// get returns a managed server, or nil.
func (m *manager) get(serverID string) *server {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.servers[serverID]
}

// lookup returns a managed server or a not_found error.
func (m *manager) lookup(serverID string) (*server, error) {
	if s := m.get(serverID); s != nil {
		return s, nil
	}
	return nil, notFound(serverID)
}

func (m *manager) Statuses() []protocol.ServerStatus {
	m.mu.Lock()
	list := make([]*server, 0, len(m.servers))
	for _, s := range m.servers {
		list = append(list, s)
	}
	m.mu.Unlock()
	out := make([]protocol.ServerStatus, 0, len(list))
	for _, s := range list {
		out = append(out, s.Status())
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ServerID < out[j].ServerID })
	return out
}

func (m *manager) Close() error {
	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return nil
	}
	m.closed = true
	list := make([]*server, 0, len(m.servers))
	for _, s := range m.servers {
		list = append(list, s)
	}
	m.mu.Unlock()
	for _, s := range list {
		s.stopWatching()
	}
	close(m.quit)
	<-m.saved
	return nil
}

// markDirty asks saveLoop to write the state file soon.
func (m *manager) markDirty() {
	select {
	case m.dirty <- struct{}{}:
	default:
	}
}

// saveLoop writes the state file at most every saveInterval while something changed, and once more on Close.
func (m *manager) saveLoop() {
	defer close(m.saved)
	ticker := time.NewTicker(saveInterval)
	defer ticker.Stop()
	pending := false
	for {
		select {
		case <-m.quit:
			if err := m.saveState(); err != nil {
				slog.Warn("could not write the agent state file", "error", err)
			}
			return
		case <-m.dirty:
			pending = true
		case <-ticker.C:
			if !pending {
				continue
			}
			pending = false
			if err := m.saveState(); err != nil {
				slog.Warn("could not write the agent state file", "error", err)
			}
		}
	}
}
