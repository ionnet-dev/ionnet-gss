package servers

import (
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// statsInterval is how often running servers are sampled (STATS_INTERVAL_SEC); diskEvery how many samples apart
// diskBytes is filled in (STATS_DISK_INTERVAL_SEC / STATS_INTERVAL_SEC), from usedBytes (disk.go, data/ + services/).
var (
	statsInterval = time.Duration(protocol.StatsIntervalSec) * time.Second
	diskEvery     = protocol.StatsDiskIntervalSec / protocol.StatsIntervalSec
)

// statsLoop samples every server whose game is starting or running each statsInterval and sends one
// protocol.StatsBatch through Sink.Stats (nothing when no server runs). Per server: docker.ContainerStats of the game
// container, plus every running service container (stacks: CPU, memory, memory limit and pids summed; network from
// the game container only). Samples run in parallel with a per-sample timeout below statsInterval; a failed sample
// leaves the server out of that batch. Stops when m.quit closes.
func (m *manager) statsLoop() {
	// TODO(builder)
}
