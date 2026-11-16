package servers

import (
	"context"
	"log/slog"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/stacks"
)

// statsInterval is how often running servers are sampled (STATS_INTERVAL_SEC). diskBytes comes from the disk check's
// last measurement (disk.go, data/ + services/, about once a minute): a sample carries it once per measurement, and
// the stats loop never walks a folder itself.
var statsInterval = time.Duration(protocol.StatsIntervalSec) * time.Second

// statsTimeout bounds one round of samples: below statsInterval so a slow Docker never stacks rounds up.
const statsTimeout = 4 * time.Second

// statsLoop samples every server whose game is starting or running each statsInterval and sends one
// protocol.StatsBatch through Sink.Stats (nothing when no server runs). Per server: docker.ContainerStats of the game
// container, plus every running service container (stacks: CPU, memory, memory limit and pids summed; network from
// the game container only). Samples run in parallel with a per-sample timeout below statsInterval; a failed sample
// leaves the server out of that batch. Stops when m.quit closes.
func (m *manager) statsLoop() {
	ticker := time.NewTicker(statsInterval)
	defer ticker.Stop()
	sentDisk := map[string]time.Time{} // The measurement time of the diskBytes each server last carried.
	for {
		select {
		case <-m.quit:
			return
		case <-ticker.C:
		}
		m.sampleAll(sentDisk)
	}
}

// sampleAll takes one round of samples and sends the batch.
func (m *manager) sampleAll(sentDisk map[string]time.Time) {
	m.mu.Lock()
	list := make([]*server, 0, len(m.servers))
	for _, s := range m.servers {
		list = append(list, s)
	}
	m.mu.Unlock()

	var active []*server
	live := map[string]bool{}
	for _, s := range list {
		state := s.Status().State
		if state != protocol.ServerStateStarting && state != protocol.ServerStateRunning {
			continue
		}
		active = append(active, s)
		live[s.id] = true
	}
	for id := range sentDisk {
		if !live[id] {
			delete(sentDisk, id) // The first sample after the next start carries the stored figure again.
		}
	}
	if len(active) == 0 {
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), statsTimeout)
	defer cancel()
	results := make(chan protocol.ServerStats, len(active))
	var wg sync.WaitGroup
	for _, s := range active {
		var disk *int64
		if bytes, at := s.lastDisk(); !at.IsZero() && at.After(sentDisk[s.id]) {
			disk = &bytes
			sentDisk[s.id] = at
		}
		wg.Add(1)
		go func() {
			defer wg.Done()
			sample, err := m.sampleServer(ctx, s, disk)
			if err != nil {
				if ctx.Err() == nil {
					slog.Debug("could not sample a server", "server", s.id, "error", err)
				}
				return
			}
			results <- sample
		}()
	}
	wg.Wait()
	close(results)

	batch := protocol.StatsBatch{At: time.Now().UTC(), Servers: []protocol.ServerStats{}}
	for sample := range results {
		batch.Servers = append(batch.Servers, sample)
	}
	if len(batch.Servers) > 0 {
		m.opts.Sink.Stats(batch)
	}
}

// sampleServer reads the game container and every running service container. A service that can't be read (it
// exited between the status refresh and now) is left out; the game container failing fails the sample.
func (m *manager) sampleServer(ctx context.Context, s *server, disk *int64) (protocol.ServerStats, error) {
	game, err := m.opts.Docker.ContainerStats(ctx, ContainerName(s.id))
	if err != nil {
		return protocol.ServerStats{}, err
	}
	out := protocol.ServerStats{
		ServerID:         s.id,
		CPUPercent:       game.CPUPercent,
		MemoryBytes:      game.MemoryBytes,
		MemoryLimitBytes: game.MemoryLimitBytes,
		NetRxBytes:       game.NetRxBytes,
		NetTxBytes:       game.NetTxBytes,
		Pids:             game.Pids,
	}
	s.mu.Lock()
	var running []string
	for _, svc := range s.svc {
		if svc.State == protocol.ServiceStateRunning || svc.State == protocol.ServiceStateHealthy || svc.State == protocol.ServiceStateUnhealthy {
			running = append(running, svc.Name)
		}
	}
	s.mu.Unlock()
	for _, name := range running {
		svc, err := m.opts.Docker.ContainerStats(ctx, stacks.ContainerName(s.id, name))
		if err != nil {
			continue
		}
		out.CPUPercent += svc.CPUPercent
		out.MemoryBytes += svc.MemoryBytes
		out.MemoryLimitBytes += svc.MemoryLimitBytes
		out.Pids += svc.Pids
	}
	out.DiskBytes = disk
	return out, nil
}
