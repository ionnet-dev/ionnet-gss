// Package stacks runs a server's extra service containers (M3, `services:` in game.yml). It is used by
// internal/servers: services come up before the game container starts and go down after it stops.
package stacks

import (
	"context"
	"errors"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrNotImplemented marks skeleton functions.
var ErrNotImplemented = errors.New("stacks: not implemented")

// MaxServices bounds one stack (the panel enforces the same).
const MaxServices = 4

// ContainerName is gss-<server uuid>-<service>.
func ContainerName(serverID, service string) string { return "gss-" + serverID + "-" + service }

// Stack manages the services of one server.
//
// Containers: name ContainerName, labels ionnet-gss.server=<id> and ionnet-gss.service=<name>, on the server's
// bridge (servers.NetworkName) with alias <name>, no published ports, CapDrop ALL plus only what the image needs
// (start with none; MariaDB needs CHOWN, SETUID, SETGID, DAC_OVERRIDE), no-new-privileges, no Docker socket,
// limits from ServiceSpec.limits, volume bind <server>/services/<name> → ServiceSpec.volume (created 0700, owned
// by the image's user on first start), egress rules of the server apply (the bridge is shared, so intra-bridge
// traffic must stay allowed: see internal/egress).
type Stack interface {
	// Ensure (re)creates service containers whose spec changed (label ionnet-gss.spec) and removes ones no longer in
	// the spec. Does not start them.
	Ensure(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) error
	// Start starts every service and waits until each with a healthcheck is healthy (startTimeout) or running.
	// On timeout it returns an error naming the service; the game is not started.
	Start(ctx context.Context, serverID string) error
	// Stop stops services after the game stopped (10 s each, then kill).
	Stop(ctx context.Context, serverID string) error
	// Remove removes the containers; keepData keeps the service volumes.
	Remove(ctx context.Context, serverID string, keepData bool) error
	// Status reports every declared service (missing ones as "missing"), for ServerStatus.services and the
	// server.services event.
	Status(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) ([]protocol.ServiceStatus, error)
}

// New returns the Stack implementation.
func New(layout paths.Layout, client docker.Client) Stack {
	return &stack{layout: layout, docker: client}
}

type stack struct {
	layout paths.Layout
	docker docker.Client
}

func (s *stack) Ensure(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) error {
	return ErrNotImplemented // TODO(builder): B
}

func (s *stack) Start(ctx context.Context, serverID string) error { return ErrNotImplemented }

func (s *stack) Stop(ctx context.Context, serverID string) error { return ErrNotImplemented }

func (s *stack) Remove(ctx context.Context, serverID string, keepData bool) error {
	return ErrNotImplemented
}

func (s *stack) Status(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) ([]protocol.ServiceStatus, error) {
	return []protocol.ServiceStatus{}, ErrNotImplemented
}
