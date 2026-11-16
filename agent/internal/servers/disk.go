package servers

import (
	"context"
	"fmt"
	"log/slog"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// diskInterval is how often the data folder of every running server is measured against its disk limit.
const diskInterval = time.Minute

// servicesMeasureEvery: a stack's service volumes that the agent can't read itself (another uid, 0700) are measured
// by a short-lived `du` container at most this often; checks in between use the last result.
const servicesMeasureEvery = 5 * time.Minute

// LabelMeasure marks the `du` containers that measure service volumes (value: the server id).
const LabelMeasure = "ionnet-gss.measure"

// usedBytes is what counts against a server's disk limit: its data folder plus its stack's service volumes (a
// database is the tenant's data too). atStart measures the volumes right away (a start is rare, and a stale result
// would refuse a server whose owner just freed space).
func (m *manager) usedBytes(s *server, atStart bool) int64 {
	return dirSize(m.opts.Layout.ServerData(s.id)) + m.servicesSize(s, atStart)
}

// servicesSize measures <server>/services directly when the agent can read it (root, or volumes it owns), and
// otherwise returns the last `du` container result, starting a new measurement in the background when that one is
// older than servicesMeasureEvery (0 until the first one finished). wait measures in place (a start, about a
// second; it waits for a measurement already running instead of starting a second one).
func (m *manager) servicesSize(s *server, wait bool) int64 {
	dir := filepath.Dir(m.opts.Layout.ServerServiceVolume(s.id, "x"))
	size, denied := walkSize(dir)
	if !denied {
		return size
	}
	s.mu.Lock()
	busy := s.svcMeasuring
	start := !busy && (wait || time.Since(s.svcMeasuredAt) >= servicesMeasureEvery)
	if start {
		s.svcMeasuring = true
	}
	s.mu.Unlock()
	switch {
	case start && wait:
		m.measureServices(s, dir)
	case start:
		go m.measureServices(s, dir)
	case busy && wait:
		deadline := time.Now().Add(2 * time.Minute)
		for time.Now().Before(deadline) {
			s.mu.Lock()
			busy = s.svcMeasuring
			s.mu.Unlock()
			if !busy {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.svcSize
}

// measureServices runs `du -sb` over the service volumes in a container (the game's image, root with
// DAC_READ_SEARCH only, no network, the folder mounted read-only) and stores the result.
func (m *manager) measureServices(s *server, dir string) {
	size, err := m.duWithContainer(s, dir)
	s.mu.Lock()
	s.svcMeasuring = false
	s.svcMeasuredAt = time.Now()
	if err == nil {
		s.svcSize = size
	}
	s.mu.Unlock()
	if err != nil {
		slog.Warn("could not measure the stack's service volumes; the disk check uses the last measurement", "server", s.id, "error", err)
	}
}

func (m *manager) duWithContainer(s *server, dir string) (int64, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	name := "gss-measure-" + s.id
	if err := m.opts.Docker.ContainerRemove(ctx, name); err != nil {
		return 0, err
	}
	_, err := m.opts.Docker.ContainerCreate(ctx, docker.ContainerSpec{
		Name:        name,
		Image:       s.request().Spec.Image,
		Entrypoint:  []string{"du"},
		Cmd:         []string{"-sb", "--one-file-system", "/target"},
		Labels:      map[string]string{LabelMeasure: s.id},
		Network:     "none",
		Binds:       []string{dir + ":/target:ro"},
		User:        "0:0",
		CapAdd:      []string{"DAC_READ_SEARCH"},
		MemoryBytes: 64 << 20,
		PidsLimit:   16,
	})
	if err != nil {
		return 0, err
	}
	defer func() {
		if err := m.opts.Docker.ContainerRemove(context.WithoutCancel(ctx), name); err != nil {
			slog.Warn("could not remove the measuring container", "container", name, "error", err)
		}
	}()
	if err := m.opts.Docker.ContainerStart(ctx, name); err != nil {
		return 0, err
	}
	code, err := m.opts.Docker.ContainerWait(ctx, name)
	if err != nil {
		return 0, err
	}
	output, err := m.opts.Docker.ContainerLogs(ctx, name, 5, 4096)
	if err != nil {
		return 0, err
	}
	// Example:
	// 104857600	/target
	fields := strings.Fields(output)
	if code != 0 || len(fields) < 2 || fields[len(fields)-1] != "/target" {
		return 0, fmt.Errorf("du in %s exited with code %d: %s", name, code, strings.TrimSpace(output))
	}
	return strconv.ParseInt(fields[len(fields)-2], 10, 64)
}

// diskLoop enforces the soft disk limit while games run: once per diskInterval it measures each running server's
// data folder and service volumes, one server after another in this goroutine (a big world never holds up requests or other loops),
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

// measureDisk walks the server's folders and stores the result as its last measurement.
func (m *manager) measureDisk(s *server) int64 {
	used := m.usedBytes(s, false)
	s.mu.Lock()
	s.diskBytes = used
	s.diskMeasuredAt = time.Now()
	s.mu.Unlock()
	return used
}

// lastDisk is the last stored measurement and when it was taken (zero time = never).
func (s *server) lastDisk() (int64, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.diskBytes, s.diskMeasuredAt
}

// cachedUsed is the stored measurement while it is younger than two disk checks, else a fresh walk (a stopped server
// isn't checked, so its first caller measures). A running server's figure is kept fresh by diskLoop.
func (m *manager) cachedUsed(s *server) int64 {
	if bytes, at := s.lastDisk(); !at.IsZero() && time.Since(at) < 2*diskInterval {
		return bytes
	}
	return m.measureDisk(s)
}

// checkDisk measures one running server, keeps the figure for the stats loop and the file manager, and stops the
// server when it is over its disk limit.
func (m *manager) checkDisk(s *server) {
	limitMB := s.request().Spec.Limits.DiskMB
	state := s.Status().State
	if state != protocol.ServerStateRunning && state != protocol.ServerStateStarting {
		return
	}
	used := m.measureDisk(s)
	if limitMB <= 0 || used <= limitMB<<20 {
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
	// Before the stop, so the `stopped` event takes the stack's services down too.
	s.setWantRunning(false)
	if _, err := client.Stop(ctx, false, reason); err != nil {
		s.setWantRunning(true)
		slog.Warn("could not stop a server over its disk limit", "server", s.id, "error", err)
		return
	}
	m.markDirty()
}
