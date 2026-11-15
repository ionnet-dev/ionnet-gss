package servers

import (
	"context"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/supervisor"
)

// Container conventions (M2). Every container and network carries LabelServer so Restore can find them.
const (
	LabelServer  = "ionnet-gss.server"  // value: server UUID
	LabelSpec    = "ionnet-gss.spec"    // value: spec hash
	LabelService = "ionnet-gss.service" // value: stack service key; absent on the game container
)

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
	Dial   DialSupervisor
}

// New returns the Manager. Call Restore before serving requests.
//
// Provision, in order: validate spec (paths, ports, limits), write <server>/spec/spec.json (InitSpec) and
// spec/files/** (0755 for executable), create data/ and run/ owned by GAME_UID, ensure the image (inspect, pull only
// when missing; non-empty `packages` → unsupported until derived builds land), ensure the network, (re)create the
// container when the spec hash label differs: memory/CPU/PID limits, CapDrop ALL + the caps gss-init needs, no
// Docker socket, binds data→/data, spec→/gss/spec:ro, run→/gss/run, published ports host=container, Tty off
// (gss-init owns the pty). Then start it so gss-init runs install (reinstall or first provision) and stays idle.
func New(opts Options) Manager {
	return &manager{opts: opts}
}

type manager struct {
	opts Options
}

// TODO(builder): B — every method below.

func (m *manager) Restore(ctx context.Context) error { return ErrNotImplemented }

func (m *manager) Statuses() []protocol.ServerStatus { return nil }

func (m *manager) Provision(ctx context.Context, req protocol.ProvisionRequest) (protocol.ServerStatus, error) {
	return protocol.ServerStatus{}, ErrNotImplemented
}

func (m *manager) Start(ctx context.Context, serverID string) (protocol.ServerStatus, error) {
	return protocol.ServerStatus{}, ErrNotImplemented
}

func (m *manager) Restart(ctx context.Context, serverID string) (protocol.ServerStatus, error) {
	return protocol.ServerStatus{}, ErrNotImplemented
}

func (m *manager) Stop(ctx context.Context, serverID string, kill bool) (protocol.ServerStatus, error) {
	return protocol.ServerStatus{}, ErrNotImplemented
}

func (m *manager) Delete(ctx context.Context, serverID string, keepData bool) error {
	return ErrNotImplemented
}

func (m *manager) Input(ctx context.Context, serverID, line string) error { return ErrNotImplemented }

func (m *manager) Backlog(ctx context.Context, serverID string, limit int64) ([]protocol.ConsoleLine, error) {
	return nil, ErrNotImplemented
}

func (m *manager) Close() error { return nil }
