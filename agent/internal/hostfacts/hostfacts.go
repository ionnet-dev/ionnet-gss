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

// New returns the collector for this OS. dataRoot is the folder whose filesystem DiskFacts describes.
func New(dataRoot string, dockerClient docker.Client) Collector {
	return &collector{dataRoot: dataRoot, docker: dockerClient}
}

type collector struct {
	dataRoot string
	docker   docker.Client
}

// Collect implements Collector; the OS-specific parts live in hostfacts_<os>.go.
func (c *collector) Collect(ctx context.Context) (protocol.HostFacts, error) {
	return collect(ctx, c.dataRoot, c.docker)
}
