//go:build !linux

package hostfacts

import (
	"context"
	"errors"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// collect is only implemented on Linux; hosts are Linux.
func collect(ctx context.Context, dataRoot string, dockerClient docker.Client) (protocol.HostFacts, error) {
	return protocol.HostFacts{}, errors.New("hostfacts: gss-agent runs on Linux hosts only")
}

// IsMemoryBacked is only implemented on Linux.
func IsMemoryBacked(dataRoot string) bool { return false }
