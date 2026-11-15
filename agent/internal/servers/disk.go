package servers

import (
	"context"
	"fmt"
	"log/slog"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// diskInterval is how often the data folder of every running server is measured against its disk limit.
const diskInterval = time.Minute

// diskLoop enforces the soft disk limit while games run: once per diskInterval it measures each running server's
// data folder, one server after another in this goroutine (a big world never holds up requests or other loops),
// and stops a server over its limit with the measurement as the state reason. Hard quotas are not M2.
func (m *manager) diskLoop() {
	ticker := time.NewTicker(diskInterval)
	defer ticker.Stop()
	for {
		select {
		case <-m.quit:
			return
		case <-ticker.C:
		}
		m.mu.Lock()
		list := make([]*server, 0, len(m.servers))
		for _, s := range m.servers {
			list = append(list, s)
		}
		m.mu.Unlock()
		for _, s := range list {
			select {
			case <-m.quit:
				return
			default:
			}
			m.checkDisk(s)
		}
	}
}

// checkDisk measures one running server and stops it when it is over its disk limit.
func (m *manager) checkDisk(s *server) {
	limitMB := s.request().Spec.Limits.DiskMB
	state := s.Status().State
	if limitMB <= 0 || (state != protocol.ServerStateRunning && state != protocol.ServerStateStarting) {
		return
	}
	used := dirSize(m.opts.Layout.ServerData(s.id))
	if used <= limitMB<<20 {
		return
	}
	// Another operation (stop, restart, delete) owns the server right now; measure again next round.
	if !s.op.TryLock() {
		return
	}
	defer s.op.Unlock()
	client := s.connected()
	if client == nil {
		return
	}
	reason := fmt.Sprintf("Stopped: the server uses %d MB (%d bytes) of its %d MB disk limit. Delete files or raise the limit, then start it again.", used>>20, used, limitMB)
	slog.Warn("server is over its disk limit; stopping it", "server", s.id, "diskBytes", used, "limitMb", limitMB)
	ctx, cancel := context.WithTimeout(context.Background(), requestTimeout)
	defer cancel()
	if _, err := client.Stop(ctx, false, reason); err != nil {
		slog.Warn("could not stop a server over its disk limit", "server", s.id, "error", err)
		return
	}
	s.setWantRunning(false)
	m.markDirty()
}
