// Package stacks runs a server's extra service containers (M3, `services:` in game.yml). It is used by
// internal/servers: services come up before the game starts and go down after it stopped.
package stacks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// MaxServices bounds one stack (the panel enforces the same).
const MaxServices = 4

// Container labels. internal/servers uses the same keys for the game container.
const (
	LabelServer  = "ionnet-gss.server"  // value: server UUID
	LabelService = "ionnet-gss.service" // value: the service key
	LabelSpec    = "ionnet-gss.spec"    // value: specHash of the service (recreated when it differs)
)

// Capabilities are added back on top of "drop all" for every service container. Stock database images start as
// root, take over their volume and drop to their own user: CHOWN (chown the data folder), SETUID/SETGID (gosu /
// su-exec to that user), DAC_OVERRIDE (root reads the folder the agent created, later owned by the service's user
// with mode 0700, and the image's healthcheck, run as root, reads the user's files such as mariadb's
// .my-healthcheck.cnf). Measured with mariadb:11.4: without CHOWN the entrypoint's chown fails, without
// DAC_OVERRIDE its find on the volume does, and with CHOWN/SETUID/SETGID but no DAC_OVERRIDE the server starts but
// healthcheck.sh never passes. DAC_READ_SEARCH would also do for the find but is not granted: it allows
// open_by_handle_at, a known container escape. no-new-privileges keeps setuid binaries inert.
var Capabilities = []string{"CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"}

// Defaults for what a spec leaves out (the panel normally fills limits).
const (
	DefaultMemoryMB     = 512
	DefaultCPUMillis    = 500
	DefaultPids         = 256
	DefaultInterval     = 5   // seconds between healthchecks
	DefaultRetries      = 30  // failed checks before Docker calls it unhealthy
	DefaultStartTimeout = 120 // seconds the game waits for healthy
	// MaxStartTimeout bounds startTimeout: a start request must answer within protocol.ProvisionTimeoutSec.
	MaxStartTimeout = 600
)

// StopTimeout is how long a service gets to stop before it is killed.
const StopTimeout = 10 * time.Second

// logTail is how much of a failed service's log an error carries.
const (
	logTailLines = 20
	logTailBytes = 4 << 10
)

// specVersion changes when the containers this package creates change shape, so existing ones are recreated.
const specVersion = 1

// ServiceName is a usable service key: a DNS label (it is the host name the game connects to), as the panel checks.
var ServiceName = regexp.MustCompile(`^[a-z]([a-z0-9-]{0,29}[a-z0-9])?$`)

var envKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,127}$`)

// ContainerName is gss-<server uuid>-<service>.
func ContainerName(serverID, service string) string { return "gss-" + serverID + "-" + service }

// Stack manages the services of one server.
//
// Containers: name ContainerName, labels ionnet-gss.server=<id> and ionnet-gss.service=<name>, on the server's
// bridge (servers.NetworkName) with alias <name>, no published ports, CapDrop ALL plus Capabilities,
// no-new-privileges, no Docker socket, restart policy "no" (the agent starts them with the game, so they never run
// before the egress table after a reboot), limits from ServiceSpec.limits, volume bind <server>/services/<name> →
// ServiceSpec.volume (created 0700, owned by the image's user on first start), egress rules of the server apply (the
// bridge is shared, so intra-bridge traffic must stay allowed: see internal/egress).
type Stack interface {
	// Ensure (re)creates service containers whose spec changed (label ionnet-gss.spec) and removes ones no longer in
	// the spec, pulling images that are missing (progress lines to progress). Does not start them.
	Ensure(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec, progress io.Writer) error
	// Start starts every service and waits until each with a healthcheck (the spec's or the image's own) is healthy,
	// or running for those without one, each within its startTimeout. On a timeout or an exit it returns an error
	// naming the service with its last log lines; the game is not started.
	Start(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec, progress io.Writer) error
	// Stop stops services after the game stopped (StopTimeout each, then kill).
	Stop(ctx context.Context, serverID string) error
	// Remove removes the containers; keepData keeps the service volumes. A volume the agent may not delete (files
	// a service's user created, for a non-root agent) is an error wrapping fs.ErrPermission.
	Remove(ctx context.Context, serverID string, keepData bool) error
	// Status reports every declared service (missing ones as "missing"), sorted by name, for ServerStatus.services
	// and the server.services event. Never nil.
	Status(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) ([]protocol.ServiceStatus, error)
	// Restart starts services of a running game that exited (a crash or an OOM kill) and returns their names.
	Restart(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) ([]string, error)
}

// New returns the Stack implementation. network names the server's bridge network (servers.NetworkName).
func New(layout paths.Layout, client docker.Client, network func(serverID string) string) Stack {
	return &stack{layout: layout, docker: client, network: network}
}

type stack struct {
	layout  paths.Layout
	docker  docker.Client
	network func(serverID string) string
}

// Validate checks a spec's services: what the agent relies on for names, paths and the container config.
func Validate(services map[string]protocol.ServiceSpec) error {
	if len(services) > MaxServices {
		return fmt.Errorf("%d services are declared; a server may have at most %d", len(services), MaxServices)
	}
	for name, spec := range services {
		if !ServiceName.MatchString(name) {
			return fmt.Errorf("service name %q isn't a usable host name: use lowercase letters, digits and dashes, starting with a letter, at most 31 characters", name)
		}
		if spec.Image == "" || strings.ContainsAny(spec.Image, " \t\r\n") {
			return fmt.Errorf("service %s: image %q is not an image reference", name, spec.Image)
		}
		for key, value := range spec.Env {
			if !envKey.MatchString(key) {
				return fmt.Errorf("service %s: environment variable name %q must be letters, digits and underscores, not starting with a digit", name, key)
			}
			if strings.ContainsRune(value, 0) {
				return fmt.Errorf("service %s: environment variable %s contains a NUL byte", name, key)
			}
		}
		if spec.Volume != "" && (!path.IsAbs(spec.Volume) || path.Clean(spec.Volume) != spec.Volume || spec.Volume == "/" || strings.ContainsAny(spec.Volume, ":,\x00")) {
			return fmt.Errorf("service %s: volume %q must be a clean absolute container path other than / (no `:` or `,`)", name, spec.Volume)
		}
		if strings.ContainsRune(spec.Command, 0) {
			return fmt.Errorf("service %s: command contains a NUL byte", name)
		}
		if check := spec.Healthcheck; check != nil {
			if strings.TrimSpace(check.Command) == "" || strings.ContainsRune(check.Command, 0) {
				return fmt.Errorf("service %s: healthcheck.command is empty", name)
			}
			if check.Interval < 0 || check.Interval > 300 || check.Retries < 0 || check.Retries > 1000 || check.StartTimeout < 0 || check.StartTimeout > MaxStartTimeout {
				return fmt.Errorf("service %s: healthcheck interval must be 0-300 s, retries 0-1000 and startTimeout 0-%d s", name, MaxStartTimeout)
			}
		}
		if limits := spec.Limits; limits != nil && (limits.MemoryMB < 0 || limits.CPUMillis < 0 || limits.Pids < 0) {
			return fmt.Errorf("service %s: limits must not be negative", name)
		}
	}
	return nil
}

// sortedNames lists the service keys in order, so every operation and status list is stable.
func sortedNames(services map[string]protocol.ServiceSpec) []string {
	names := make([]string, 0, len(services))
	for name := range services {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// specHash is the value of LabelSpec: everything the container is created from.
func (s *stack) specHash(serverID, name string, spec protocol.ServiceSpec) string {
	raw, _ := json.Marshal(struct {
		Version      int                  `json:"v"`
		Network      string               `json:"network"`
		Name         string               `json:"name"`
		Capabilities []string             `json:"caps"`
		Spec         protocol.ServiceSpec `json:"spec"`
	}{specVersion, s.network(serverID), name, Capabilities, spec})
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:])
}

// existing lists the server's service containers by service key.
func (s *stack) existing(ctx context.Context, serverID string) (map[string]docker.ContainerInfo, error) {
	list, err := s.docker.ContainerList(ctx, LabelServer+"="+serverID)
	if err != nil {
		return nil, err
	}
	out := map[string]docker.ContainerInfo{}
	for _, info := range list {
		if name := info.Labels[LabelService]; name != "" && info.Labels[LabelServer] == serverID {
			out[name] = info
		}
	}
	return out, nil
}

func (s *stack) Ensure(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec, progress io.Writer) error {
	if progress == nil {
		progress = io.Discard
	}
	if err := Validate(services); err != nil {
		return err
	}
	existing, err := s.existing(ctx, serverID)
	if err != nil {
		return err
	}
	for name, info := range existing {
		if _, ok := services[name]; ok {
			continue
		}
		// Its volume stays: it is the server's data, removed with the server.
		if err := s.docker.ContainerStop(ctx, info.Name, StopTimeout); err != nil {
			return err
		}
		if err := s.docker.ContainerRemove(ctx, info.Name); err != nil {
			return err
		}
		fmt.Fprintf(progress, "Removed service %s (no longer in the definition).\n", name)
		slog.Info("removed a service that left the spec", "server", serverID, "service", name)
	}

	for _, name := range sortedNames(services) {
		spec := services[name]
		container := ContainerName(serverID, name)
		hash := s.specHash(serverID, name, spec)
		info, exists, err := s.docker.ContainerInspect(ctx, container)
		if err != nil {
			return err
		}
		if exists && info.Labels[LabelSpec] == hash {
			continue
		}
		image, err := s.ensureImage(ctx, spec.Image, progress)
		if err != nil {
			return fmt.Errorf("service %s: %w", name, err)
		}
		if spec.Volume != "" {
			if err := s.prepareVolume(serverID, name, image.User); err != nil {
				return fmt.Errorf("service %s: %w", name, err)
			}
		}
		if exists {
			if err := s.docker.ContainerStop(ctx, container, StopTimeout); err != nil {
				return err
			}
			if err := s.docker.ContainerRemove(ctx, container); err != nil {
				return err
			}
		}
		if _, err := s.docker.ContainerCreate(ctx, s.containerSpec(serverID, name, spec, hash)); err != nil {
			return fmt.Errorf("service %s: %w", name, err)
		}
		verb := "Created"
		if exists {
			verb = "Recreated"
		}
		fmt.Fprintf(progress, "%s service %s (%s).\n", verb, name, spec.Image)
		slog.Info("created service container", "server", serverID, "service", name, "container", container, "image", spec.Image, "recreated", exists)
	}
	return nil
}

// containerSpec is one service container.
func (s *stack) containerSpec(serverID, name string, spec protocol.ServiceSpec, hash string) docker.ContainerSpec {
	memoryMB, cpuMillis, pids := int64(DefaultMemoryMB), int64(DefaultCPUMillis), int64(DefaultPids)
	if limits := spec.Limits; limits != nil {
		if limits.MemoryMB > 0 {
			memoryMB = limits.MemoryMB
		}
		if limits.CPUMillis > 0 {
			cpuMillis = limits.CPUMillis
		}
		if limits.Pids > 0 {
			pids = limits.Pids
		}
	}
	out := docker.ContainerSpec{
		Name:  ContainerName(serverID, name),
		Image: spec.Image,
		Env:   spec.Env,
		Labels: map[string]string{
			LabelServer:  serverID,
			LabelService: name,
			LabelSpec:    hash,
		},
		Network:     s.network(serverID),
		Aliases:     []string{name},
		MemoryBytes: memoryMB << 20,
		NanoCPUs:    cpuMillis * 1_000_000,
		PidsLimit:   pids,
		CapAdd:      Capabilities,
		Restart:     "no",
	}
	if spec.Command != "" {
		out.Cmd = []string{"/bin/sh", "-c", spec.Command}
	}
	if spec.Volume != "" {
		out.Binds = []string{s.layout.ServerServiceVolume(serverID, name) + ":" + spec.Volume}
	}
	if check := spec.Healthcheck; check != nil {
		interval, retries := check.Interval, check.Retries
		if interval <= 0 {
			interval = DefaultInterval
		}
		if retries <= 0 {
			retries = DefaultRetries
		}
		out.Healthcheck = &docker.Healthcheck{Command: check.Command, Interval: time.Duration(interval) * time.Second, Retries: int(retries)}
	}
	return out
}

// ensureImage pulls a service image only when it is missing and returns its inspect.
func (s *stack) ensureImage(ctx context.Context, ref string, progress io.Writer) (docker.ImageInfo, error) {
	info, exists, err := s.docker.ImageInspect(ctx, ref)
	if err != nil || exists {
		return info, err
	}
	fmt.Fprintf(progress, "Pulling %s (not on this host yet).\n", ref)
	started := time.Now()
	if err := s.docker.ImagePull(ctx, ref, nil); err != nil {
		fmt.Fprintf(progress, "Could not pull %s: %v\n", ref, err)
		return docker.ImageInfo{}, fmt.Errorf("image %s is not on this host and could not be pulled (check the name and that the host can reach its registry): %w", ref, err)
	}
	info, exists, err = s.docker.ImageInspect(ctx, ref)
	if err != nil {
		return docker.ImageInfo{}, err
	}
	if !exists {
		return docker.ImageInfo{}, fmt.Errorf("image %s was pulled but is not on this host", ref)
	}
	fmt.Fprintf(progress, "Pulled %s in %s.\n", ref, time.Since(started).Round(time.Second))
	return info, nil
}

// prepareVolume creates <server>/services/<name> on first use. The server folder is the agent's and 0700, so no
// other host user reaches anything below it, whatever the volume's own mode.
//   - An image that starts as root (most database images) takes the folder over itself: 0700, and its entrypoint
//     chowns it to its user (CHOWN + DAC_OVERRIDE in Capabilities).
//   - An image with a numeric non-root USER gets the folder chowned to it when the agent is root.
//   - Any other non-root USER (a name, or a non-root agent) gets mode 0777, the only way that user can write it.
//
// An existing folder is left as it is: after the first start it belongs to the service's user.
func (s *stack) prepareVolume(serverID, name, user string) error {
	dir := s.layout.ServerServiceVolume(serverID, name)
	parent := filepath.Dir(dir)
	if err := os.MkdirAll(parent, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", parent, err)
	}
	if err := os.Chmod(parent, 0o700); err != nil && !errors.Is(err, fs.ErrPermission) {
		return fmt.Errorf("chmod %s: %w", parent, err)
	}
	if _, err := os.Lstat(dir); err == nil {
		return nil
	}
	if err := os.Mkdir(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("chmod %s: %w", dir, err)
	}
	userPart, groupPart, _ := strings.Cut(user, ":")
	if userPart == "" || userPart == "root" || userPart == "0" {
		return nil
	}
	uid, uidErr := strconv.Atoi(userPart)
	gid := uid
	if groupPart != "" {
		parsed, err := strconv.Atoi(groupPart)
		if err != nil {
			uidErr = err
		}
		gid = parsed
	}
	if uidErr == nil && os.Geteuid() == 0 {
		if err := os.Chown(dir, uid, gid); err != nil {
			return fmt.Errorf("hand %s to uid %d: %w", dir, uid, err)
		}
		return nil
	}
	slog.Info("service image runs as a user the agent can't hand its volume to; making the volume folder writable for it (the server folder stays private)", "server", serverID, "service", name, "user", user)
	return os.Chmod(dir, 0o777)
}

func (s *stack) Start(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec, progress io.Writer) error {
	if progress == nil {
		progress = io.Discard
	}
	names := sortedNames(services)
	started := time.Now()
	starting := map[string]bool{}
	for _, name := range names {
		container := ContainerName(serverID, name)
		info, exists, err := s.docker.ContainerInspect(ctx, container)
		if err != nil {
			return err
		}
		if !exists {
			return fmt.Errorf("service %s has no container (%s); provision the server again", name, container)
		}
		if info.Running {
			continue
		}
		fmt.Fprintf(progress, "Starting service %s (%s).\n", name, services[name].Image)
		if err := s.docker.ContainerStart(ctx, container); err != nil {
			return fmt.Errorf("service %s: %w", name, err)
		}
		starting[name] = true
	}
	for _, name := range names {
		timeout := time.Duration(DefaultStartTimeout) * time.Second
		if check := services[name].Healthcheck; check != nil && check.StartTimeout > 0 {
			timeout = time.Duration(check.StartTimeout) * time.Second
		}
		health, err := s.waitReady(ctx, serverID, name, started.Add(timeout), timeout)
		if err != nil {
			return err
		}
		if health == "healthy" && starting[name] {
			fmt.Fprintf(progress, "Service %s is healthy (%s after start).\n", name, time.Since(started).Round(time.Second))
		}
	}
	return nil
}

// readyPoll is how often Start looks at a service it waits for.
const readyPoll = time.Second

// waitReady waits until a service is healthy (with a healthcheck) or running (without), and returns its health.
func (s *stack) waitReady(ctx context.Context, serverID, name string, deadline time.Time, timeout time.Duration) (string, error) {
	container := ContainerName(serverID, name)
	ticker := time.NewTicker(readyPoll)
	defer ticker.Stop()
	for {
		info, exists, err := s.docker.ContainerInspect(ctx, container)
		if err != nil {
			return "", err
		}
		switch {
		case !exists:
			return "", fmt.Errorf("service %s: its container %s was removed while starting", name, container)
		case !info.Running && info.Status != "created" && info.Status != "restarting":
			return "", s.failure(ctx, serverID, name, fmt.Sprintf("Service %s exited with code %d before it was ready.", name, info.ExitCode))
		case info.Running && (info.Health == "" || info.Health == "healthy"):
			return info.Health, nil
		}
		if time.Now().After(deadline) {
			state := info.Health
			if state == "" {
				state = info.Status
			}
			return "", s.failure(ctx, serverID, name, fmt.Sprintf("Service %s did not become healthy within %s (it is %s).", name, timeout, state))
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("service %s: %w", name, ctx.Err())
		case <-ticker.C:
		}
	}
}

// failure is a readable start failure with the service's last log lines.
func (s *stack) failure(ctx context.Context, serverID, name, reason string) error {
	logs, err := s.docker.ContainerLogs(ctx, ContainerName(serverID, name), logTailLines, logTailBytes)
	logs = strings.TrimRight(logs, "\n")
	if err != nil || strings.TrimSpace(logs) == "" {
		return errors.New(reason + " It wrote no log output.")
	}
	return fmt.Errorf("%s Its last log lines:\n%s", reason, logs)
}

func (s *stack) Stop(ctx context.Context, serverID string) error {
	existing, err := s.existing(ctx, serverID)
	if err != nil {
		return err
	}
	var errs []error
	for _, info := range existing {
		if !info.Running {
			continue
		}
		if err := s.docker.ContainerStop(ctx, info.Name, StopTimeout); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (s *stack) Remove(ctx context.Context, serverID string, keepData bool) error {
	existing, err := s.existing(ctx, serverID)
	if err != nil {
		return err
	}
	for _, info := range existing {
		if err := s.docker.ContainerStop(ctx, info.Name, StopTimeout); err != nil {
			return err
		}
		if err := s.docker.ContainerRemove(ctx, info.Name); err != nil {
			return err
		}
	}
	if keepData {
		return nil
	}
	dir := filepath.Dir(s.layout.ServerServiceVolume(serverID, "x"))
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("remove service volumes %s: %w", dir, err)
	}
	return nil
}

func (s *stack) Status(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) ([]protocol.ServiceStatus, error) {
	out := make([]protocol.ServiceStatus, 0, len(services))
	for _, name := range sortedNames(services) {
		info, exists, err := s.docker.ContainerInspect(ctx, ContainerName(serverID, name))
		if err != nil {
			return []protocol.ServiceStatus{}, err
		}
		status := protocol.ServiceStatus{Name: name, Image: services[name].Image, State: protocol.ServiceStateMissing}
		if exists {
			status.State = stateOf(info)
			if status.State == protocol.ServiceStateExited {
				code := int64(info.ExitCode)
				status.ExitCode = &code
			}
		}
		out = append(out, status)
	}
	return out, nil
}

// stateOf maps Docker's view of a container to a ServiceState.
func stateOf(info docker.ContainerInfo) protocol.ServiceState {
	switch {
	case info.Running && info.Health == "starting":
		return protocol.ServiceStateStarting
	case info.Running && info.Health == "healthy":
		return protocol.ServiceStateHealthy
	case info.Running && info.Health == "unhealthy":
		return protocol.ServiceStateUnhealthy
	case info.Running:
		return protocol.ServiceStateRunning
	case info.Status == "created":
		return protocol.ServiceStateCreated
	case info.Status == "restarting":
		return protocol.ServiceStateStarting
	default:
		return protocol.ServiceStateExited
	}
}

func (s *stack) Restart(ctx context.Context, serverID string, services map[string]protocol.ServiceSpec) ([]string, error) {
	var restarted []string
	var errs []error
	for _, name := range sortedNames(services) {
		container := ContainerName(serverID, name)
		info, exists, err := s.docker.ContainerInspect(ctx, container)
		if err != nil {
			return restarted, err
		}
		if !exists || info.Running || info.Status == "created" {
			continue
		}
		if err := s.docker.ContainerStart(ctx, container); err != nil {
			errs = append(errs, fmt.Errorf("service %s: %w", name, err))
			continue
		}
		restarted = append(restarted, name)
	}
	return restarted, errors.Join(errs...)
}
