// Package hostfacts collects what the panel shows about a host: OS, CPU, memory, disk, Docker, uptime.
package hostfacts

import (
	"context"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Collector gathers facts. A missing piece (no Docker) is reported in the facts, not as an error.
type Collector interface {
	Collect(ctx context.Context) (protocol.HostFacts, error)
}

// EgressSource reports the egress filtering state (egress.Firewall.Facts); nil until it is known.
type EgressSource func() *protocol.EgressFacts

// New returns the collector for this OS. dataRoot is the folder whose filesystem DiskFacts describes; egress may be
// nil (facts then carry egress: null). agentBuild is the running binary's SHA-256, read once at start
// (updater.ReadBuild); nil = agentBuild: null.
func New(dataRoot string, dockerClient docker.Client, egress EgressSource, agentBuild *string) Collector {
	return &collector{dataRoot: dataRoot, docker: dockerClient, egress: egress, agentBuild: agentBuild}
}

type collector struct {
	dataRoot   string
	docker     docker.Client
	egress     EgressSource
	agentBuild *string
}

// Collect implements Collector; the OS-specific parts live in hostfacts_<os>.go.
func (c *collector) Collect(ctx context.Context) (protocol.HostFacts, error) {
	facts, err := collect(ctx, c.dataRoot, c.docker)
	if err != nil {
		return facts, err
	}
	if c.egress != nil {
		facts.Egress = c.egress()
	}
	facts.AgentBuild = c.agentBuild
	return facts, nil
}
