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

// healInterval is how often a broken egress table is retried.
const healInterval = time.Minute

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
	reason := fmt.Sprintf("Not started: this server may not reach private networks, and egress filtering doesn't work on this host (%v). Fix it (see the host page), or let an admin allow private network access for this server.", err)
	m.reportReason(s, reason)
	return remoteError(protocol.ErrorCodeConflict, "%s", reason)
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

// syncEgress rebuilds the table from the restored servers whose networks exist. Servers without a network yet are
// added when ensureContainer creates it.
func (m *manager) syncEgress(ctx context.Context, restored []*server) {
	if m.opts.Egress == nil {
		return
	}
	egress.RemoveLeftovers(ctx, m.opts.Docker)
	restricted := map[string]string{}
	for _, s := range restored {
		if s.request().Spec.AllowPrivateNetwork {
			continue
		}
		network, ok, err := m.opts.Docker.NetworkInspect(ctx, NetworkName(s.id))
		if err != nil {
			slog.Warn("could not inspect the server's network for egress filtering", "server", s.id, "error", err)
			continue
		}
		if ok {
			restricted[s.id] = network.Bridge
		}
	}
	if err := m.opts.Egress.Sync(ctx, restricted); err != nil {
		slog.Warn("could not apply the egress table (nftables inet "+egress.TableName+"); servers that may not reach private networks won't start until it works", "error", err)
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
