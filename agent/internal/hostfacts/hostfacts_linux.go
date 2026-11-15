package hostfacts

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/version"
)

// dockerProbeTimeout bounds the Docker version call so a hung socket cannot stall a heartbeat.
const dockerProbeTimeout = 3 * time.Second

// collect reads /etc/os-release, uname, /proc/cpuinfo, /proc/loadavg, /proc/meminfo, /proc/uptime, statfs(dataRoot)
// (the nearest existing parent when dataRoot does not exist yet), /proc/net/{tcp,udp}{,6} (bound ports) and
// docker.Version (nil facts on error).
func collect(ctx context.Context, dataRoot string, dockerClient docker.Client) (protocol.HostFacts, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return protocol.HostFacts{}, fmt.Errorf("read hostname: %w", err)
	}
	memory, err := readMemory()
	if err != nil {
		return protocol.HostFacts{}, err
	}
	disk, err := readDisk(dataRoot)
	if err != nil {
		return protocol.HostFacts{}, err
	}

	facts := protocol.HostFacts{
		Hostname:     hostname,
		AgentVersion: version.Version,
		UptimeSec:    readUptime(),
		OS:           readOS(),
		CPU: protocol.CpuFacts{
			Model:   readCPUModel(),
			Threads: int64(runtime.NumCPU()),
			Load1:   readLoad1(),
		},
		Memory:     memory,
		Disk:       disk,
		BoundPorts: readBoundPorts(),
	}

	if dockerClient != nil {
		probeCtx, cancel := context.WithTimeout(ctx, dockerProbeTimeout)
		defer cancel()
		if info, err := dockerClient.Version(probeCtx); err == nil {
			facts.Docker = &protocol.DockerFacts{Version: info.Version, APIVersion: info.APIVersion}
		}
	}
	return facts, nil
}

// readOS combines /etc/os-release with the kernel release and GOARCH.
func readOS() protocol.OsFacts {
	osFacts := protocol.OsFacts{Name: "Linux", ID: "linux", Arch: runtime.GOARCH}
	if kernel, err := os.ReadFile("/proc/sys/kernel/osrelease"); err == nil {
		osFacts.Kernel = strings.TrimSpace(string(kernel))
	}
	file, err := os.Open("/etc/os-release")
	if err != nil {
		return osFacts
	}
	defer file.Close()
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), "=")
		if !ok {
			continue
		}
		value = strings.Trim(value, `"'`)
		switch key {
		case "PRETTY_NAME":
			osFacts.Name = value
		case "ID":
			osFacts.ID = value
		case "VERSION_ID":
			osFacts.Version = value
		}
	}
	return osFacts
}

// readCPUModel returns the first "model name" (x86) or "Model"/"Hardware" (ARM) line of /proc/cpuinfo.
func readCPUModel() string {
	file, err := os.Open("/proc/cpuinfo")
	if err != nil {
		return "unknown"
	}
	defer file.Close()
	fallback := ""
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		switch strings.TrimSpace(key) {
		case "model name":
			return strings.TrimSpace(value)
		case "Model", "Hardware":
			if fallback == "" {
				fallback = strings.TrimSpace(value)
			}
		}
	}
	if fallback != "" {
		return fallback
	}
	return "unknown"
}

func readLoad1() float64 {
	raw, err := os.ReadFile("/proc/loadavg")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0
	}
	load, _ := strconv.ParseFloat(fields[0], 64)
	return load
}

func readUptime() int64 {
	raw, err := os.ReadFile("/proc/uptime")
	if err != nil {
		return 0
	}
	fields := strings.Fields(string(raw))
	if len(fields) == 0 {
		return 0
	}
	seconds, _ := strconv.ParseFloat(fields[0], 64)
	return int64(seconds)
}

// readMemory reads MemTotal and MemAvailable (kB in /proc/meminfo) as bytes.
func readMemory() (protocol.MemoryFacts, error) {
	file, err := os.Open("/proc/meminfo")
	if err != nil {
		return protocol.MemoryFacts{}, fmt.Errorf("read /proc/meminfo: %w", err)
	}
	defer file.Close()
	var memory protocol.MemoryFacts
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		key, value, ok := strings.Cut(scanner.Text(), ":")
		if !ok {
			continue
		}
		fields := strings.Fields(value)
		if len(fields) == 0 {
			continue
		}
		kilobytes, err := strconv.ParseInt(fields[0], 10, 64)
		if err != nil {
			continue
		}
		switch key {
		case "MemTotal":
			memory.TotalBytes = kilobytes * 1024
		case "MemAvailable":
			memory.AvailableBytes = kilobytes * 1024
		}
	}
	return memory, nil
}

// readDisk stats the filesystem holding dataRoot, or its nearest existing parent while the folder is not created yet.
func readDisk(dataRoot string) (protocol.DiskFacts, error) {
	path := dataRoot
	for {
		var stat syscall.Statfs_t
		err := syscall.Statfs(path, &stat)
		if err == nil {
			block := int64(stat.Bsize)
			return protocol.DiskFacts{
				Path:       dataRoot,
				TotalBytes: int64(stat.Blocks) * block,
				FreeBytes:  int64(stat.Bavail) * block,
			}, nil
		}
		parent := filepath.Dir(path)
		if parent == path {
			return protocol.DiskFacts{}, fmt.Errorf("stat the filesystem of %s: %w", dataRoot, err)
		}
		path = parent
	}
}

// Filesystem magic numbers (statfs f_type) of memory-backed filesystems.
const (
	tmpfsMagic = 0x01021994
	ramfsMagic = 0x858458f6
)

// IsMemoryBacked reports whether dataRoot (or its nearest existing parent) is on tmpfs or ramfs. Files written there
// are charged to the writing container's memory cgroup, so a large game install is OOM-killed at the memory limit.
func IsMemoryBacked(dataRoot string) bool {
	path := dataRoot
	for {
		var stat syscall.Statfs_t
		if err := syscall.Statfs(path, &stat); err == nil {
			return stat.Type == tmpfsMagic || stat.Type == ramfsMagic
		}
		parent := filepath.Dir(path)
		if parent == path {
			return false
		}
		path = parent
	}
}
