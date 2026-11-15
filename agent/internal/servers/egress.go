package servers

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/egress"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Egress filtering: a server without `allowPrivateNetwork` has its bridge in the agent's nftables table before its
// container or its game starts, and doesn't start when that fails (a conflict with the reason, also sent as the
// state reason). Restore rebuilds the whole table from the servers on disk before it starts anything.

// healInterval is how often the egress table is checked (and rebuilt when it is missing, differs or broke).
const healInterval = time.Minute

// Derived-image builds (`packages:`) run on one agent-owned bridge network that is always restricted, so apt-get
// reaches the public mirrors but not the host's private networks. It is kept between builds (an idle bridge costs
// nothing) and its bridge is in the egress table like a server's.
const (
	BuildNetwork   = "gss-build"
	buildEgressKey = "build" // its key among the restricted bridges (server ids are UUIDs, so it can't collide)
	// LabelBuild marks the build network.
	LabelBuild = "ionnet-gss.build"
)

// buildNetwork makes the build network exist with its bridge filtered and returns its name (images.NetworkFunc).
func (m *manager) buildNetwork(ctx context.Context) (string, error) {
	network, err := m.opts.Docker.NetworkEnsure(ctx, BuildNetwork, map[string]string{LabelBuild: "1"}, map[string]string{docker.BridgeNameOption: BuildNetwork})
	if err != nil {
		return "", err
	}
	err = errors.New("egress filtering is not set up in this agent")
	if m.opts.Egress != nil {
		err = m.opts.Egress.Restrict(ctx, buildEgressKey, network.Bridge)
	}
	if err != nil {
		return "", remoteError(protocol.ErrorCodeConflict, "Derived images (packages) are built on a filtered network, and egress filtering doesn't work on this host (%v). Fix it (see the host page) and provision again.", err)
	}
	return BuildNetwork, nil
}

// BridgeName is the host interface of the server's network: gss- and the first 11 hex digits of its id (15
// characters, the kernel's limit). Networks an older agent created keep Docker's `br-<id>` name.
func BridgeName(serverID string) string {
	return "gss-" + strings.ReplaceAll(serverID, "-", "")[:11]
}

// ensureNetwork makes the server's network exist and returns it.
func (m *manager) ensureNetwork(ctx context.Context, serverID string) (docker.NetworkInfo, error) {
	return m.opts.Docker.NetworkEnsure(ctx, NetworkName(serverID), map[string]string{LabelServer: serverID}, map[string]string{docker.BridgeNameOption: BridgeName(serverID)})
}

// applyEgress puts the server's bridge into or out of the filtered set, as its spec says. A restricted server whose
// rules can't be applied gets a conflict naming the reason.
func (m *manager) applyEgress(ctx context.Context, s *server, bridge string) error {
	if s.request().Spec.AllowPrivateNetwork {
		if m.opts.Egress != nil {
			if err := m.opts.Egress.Release(ctx, s.id); err != nil {
				slog.Warn("could not take the server out of the egress table; it may stay cut off from private networks until the table is rebuilt", "server", s.id, "error", err)
			}
		}
		return nil
	}
	err := errors.New("egress filtering is not set up in this agent")
	if m.opts.Egress != nil {
		err = m.opts.Egress.Restrict(ctx, s.id, bridge)
	}
	if err == nil {
		return nil
	}
	reason := egressReason(err)
	m.reportReason(s, reason)
	return remoteError(protocol.ErrorCodeConflict, "%s", reason)
}

// egressReason is the state reason of a restricted server that doesn't run because of err.
func egressReason(err error) string {
	return fmt.Sprintf("Not started: this server may not reach private networks, and egress filtering doesn't work on this host (%v). Fix it (see the host page), or let an admin allow private network access for this server.", err)
}

// guardEgress checks a restricted server's rules before its game starts, when the container already exists (when
// it doesn't, ensureContainer creates the network and applies them).
func (m *manager) guardEgress(ctx context.Context, s *server) error {
	network, ok, err := m.opts.Docker.NetworkInspect(ctx, NetworkName(s.id))
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	return m.applyEgress(ctx, s, network.Bridge)
}

// reportReason sends the server's current state again with reason, so the panel shows why it didn't start. Only
// for states gss-init reports itself; a server still being created gets the reason from the provision's error.
func (m *manager) reportReason(s *server, reason string) {
	s.mu.Lock()
	status := s.status
	s.mu.Unlock()
	switch status.State {
	case protocol.ServerStateStopped, protocol.ServerStateCrashed, protocol.ServerStateInstallFailed:
	default:
		return
	}
	if status.Reason != nil && *status.Reason == reason {
		return
	}
	s.applyChange(protocol.StateChange{ServerID: s.id, State: status.State, Previous: status.State, At: time.Now().UTC(), ExitCode: status.ExitCode, Reason: &reason})
}

// syncEgress rebuilds the table from the restored servers whose networks exist (and the build network). Servers
// without a network yet are added when ensureContainer creates it. It returns, per restricted server that must not
// run now, why: every one when the table couldn't be applied, or one whose network couldn't be inspected.
func (m *manager) syncEgress(ctx context.Context, restored []*server) map[string]string {
	blocked := map[string]string{}
	restrictedServers := make([]*server, 0, len(restored))
	for _, s := range restored {
		if !s.request().Spec.AllowPrivateNetwork {
			restrictedServers = append(restrictedServers, s)
		}
	}
	if m.opts.Egress == nil {
		for _, s := range restrictedServers {
			blocked[s.id] = egressReason(errors.New("egress filtering is not set up in this agent"))
		}
		return blocked
	}
	egress.RemoveLeftovers(ctx, m.opts.Docker)
	restricted := map[string]string{}
	if network, ok, err := m.opts.Docker.NetworkInspect(ctx, BuildNetwork); err == nil && ok {
		restricted[buildEgressKey] = network.Bridge
	}
	for _, s := range restrictedServers {
		network, ok, err := m.opts.Docker.NetworkInspect(ctx, NetworkName(s.id))
		if err != nil {
			slog.Warn("could not inspect the server's network for egress filtering; the server stays down", "server", s.id, "error", err)
			blocked[s.id] = egressReason(fmt.Errorf("its network could not be inspected: %w", err))
			continue
		}
		if ok {
			restricted[s.id] = network.Bridge
		}
	}
	if err := m.opts.Egress.Sync(ctx, restricted); err != nil {
		slog.Warn("could not apply the egress table (nftables inet "+m.opts.Egress.Table()+"); servers that may not reach private networks won't start until it works", "error", err)
		for _, s := range restrictedServers {
			blocked[s.id] = egressReason(err)
		}
	}
	return blocked
}

// recheckEgress makes sure a restricted server whose container (re)started has its bridge filtered; when that fails
// the container is held back (stopped) until it can be.
func (m *manager) recheckEgress(s *server) {
	if s.request().Spec.AllowPrivateNetwork {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), restoreTimeout)
	defer cancel()
	s.op.Lock()
	defer s.op.Unlock()
	if m.get(s.id) != s {
		return
	}
	network, ok, err := m.opts.Docker.NetworkInspect(ctx, NetworkName(s.id))
	if err == nil && !ok {
		return // No network, no container on it.
	}
	if err == nil && m.opts.Egress != nil {
		err = m.opts.Egress.Restrict(ctx, s.id, network.Bridge)
	} else if err == nil {
		err = errors.New("egress filtering is not set up in this agent")
	}
	if err != nil {
		m.holdBack(ctx, s, egressReason(err))
	}
}

// healLoop retries a broken egress table once per healInterval.
func (m *manager) healLoop() {
	if m.opts.Egress == nil {
		return
	}
	ticker := time.NewTicker(healInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.quit:
			return
		case <-ticker.C:
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		m.opts.Egress.Heal(ctx)
		cancel()
	}
}
