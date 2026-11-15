package servers

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"regexp"
	"strings"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

var uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)

// validServerID guards every path and container name built from a server id.
func validServerID(serverID string) error {
	if !uuidPattern.MatchString(serverID) {
		return remoteError(protocol.ErrorCodeBadRequest, "Server id %q is not a UUID.", serverID)
	}
	return nil
}

// validateRequest checks what the agent relies on; policy (quota, port pool) is the panel's.
func validateRequest(req *protocol.ProvisionRequest) error {
	spec := &req.Spec
	if err := validServerID(spec.ServerID); err != nil {
		return err
	}
	if spec.Init.ServerID == "" {
		spec.Init.ServerID = spec.ServerID
	}
	if spec.Init.ServerID != spec.ServerID {
		return remoteError(protocol.ErrorCodeBadRequest, "spec.init.serverId %q differs from spec.serverId %q.", spec.Init.ServerID, spec.ServerID)
	}
	if req.SpecHash == "" {
		return remoteError(protocol.ErrorCodeBadRequest, "specHash is empty.")
	}
	if len(spec.Packages) > 0 {
		return remoteError(protocol.ErrorCodeUnsupported, "Definitions with `packages` need derived images, which this gss-agent version can't build yet; use an image that already has them.")
	}
	if len(spec.Services) > 0 {
		return remoteError(protocol.ErrorCodeUnsupported, "Definitions with `services` (stacks) are not supported by this gss-agent version yet.")
	}
	if spec.Image == "" || strings.ContainsAny(spec.Image, " \t\n") {
		return remoteError(protocol.ErrorCodeBadRequest, "spec.image %q is not an image reference.", spec.Image)
	}
	if spec.Limits.MemoryMB <= 0 || spec.Limits.CPUMillis <= 0 || spec.Limits.Pids <= 0 || spec.Limits.DiskMB < 0 {
		return remoteError(protocol.ErrorCodeBadRequest, "spec.limits must set memoryMb, cpuMillis and pids above 0 (got %+v).", spec.Limits)
	}
	seen := map[string]bool{}
	for _, port := range spec.Ports {
		if port.Port < 1 || port.Port > 65535 {
			return remoteError(protocol.ErrorCodeBadRequest, "Port %q has number %d, outside 1-65535.", port.Name, port.Port)
		}
		if port.Proto != protocol.PortProtoTCP && port.Proto != protocol.PortProtoUDP {
			return remoteError(protocol.ErrorCodeBadRequest, "Port %q has protocol %q; use tcp or udp.", port.Name, port.Proto)
		}
		key := fmt.Sprintf("%d/%s", port.Port, port.Proto)
		if seen[key] {
			return remoteError(protocol.ErrorCodeBadRequest, "Port %s is listed twice.", key)
		}
		seen[key] = true
	}
	files := map[string]bool{}
	for _, file := range spec.Files {
		if !validFilePath(file.Path) {
			return remoteError(protocol.ErrorCodeBadRequest, "File path %q must be relative to the definition folder, without `..` or a leading `/`.", file.Path)
		}
		if files[file.Path] {
			return remoteError(protocol.ErrorCodeBadRequest, "File %q is listed twice.", file.Path)
		}
		files[file.Path] = true
	}
	return nil
}

func (m *manager) Provision(ctx context.Context, req protocol.ProvisionRequest) (protocol.ServerStatus, error) {
	if err := validateRequest(&req); err != nil {
		return protocol.ServerStatus{}, err
	}
	id := req.Spec.ServerID

	m.mu.Lock()
	if m.closed {
		m.mu.Unlock()
		return protocol.ServerStatus{}, remoteError(protocol.ErrorCodeConflict, "The agent is shutting down.")
	}
	s := m.servers[id]
	if s == nil {
		s = newServer(m, req)
		s.req.SpecHash = "" // Nothing provisioned yet.
		m.servers[id] = s
	}
	m.mu.Unlock()

	s.op.Lock()
	defer s.op.Unlock()
	if m.get(id) != s {
		return protocol.ServerStatus{}, remoteError(protocol.ErrorCodeConflict, "Server %s was deleted while this provision waited; send it again.", id)
	}

	current := s.Status()
	previousHash := s.request().SpecHash
	s.mu.Lock()
	wasInstalled := s.installed
	s.mu.Unlock()
	changed := previousHash != req.SpecHash
	info, exists, err := m.opts.Docker.ContainerInspect(ctx, ContainerName(id))
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	recreate := !exists || info.Labels[LabelSpec] != req.SpecHash
	if (changed || recreate || req.Reinstall) && exists && info.Running && isActive(current.State) {
		return protocol.ServerStatus{}, remoteError(protocol.ErrorCodeConflict, "Server %s is %s. Stop it before changing its settings or reinstalling.", id, current.State)
	}

	if changed || recreate {
		if err := writeServerFolder(m.opts.Layout, req); err != nil {
			return protocol.ServerStatus{}, err
		}
	}
	s.mu.Lock()
	s.req = req
	s.req.Reinstall = false
	s.status.SpecHash = req.SpecHash
	s.mu.Unlock()
	m.markDirty()

	if err := m.ensureContainer(ctx, s, recreate); err != nil {
		return protocol.ServerStatus{}, err
	}
	s.startWatching()
	client, err := s.waitConnected(ctx, readyTimeout)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	reqCtx, cancel := context.WithTimeout(ctx, requestTimeout)
	defer cancel()
	st, err := client.Status(reqCtx)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	// gss-init installs on its own when it boots without an install marker, so a freshly created container over
	// data that never finished an install needs nothing more. Otherwise install on a reinstall, or when this
	// gss-init never installed (a failed install waits for an explicit reinstall unless the spec changed).
	var install bool
	switch {
	case st.State == protocol.ServerStateInstalling:
		install = false
	case recreate && !wasInstalled:
		install = !st.Installed && st.State == protocol.ServerStateStopped
	case req.Reinstall:
		install = true
	default:
		install = !st.Installed && (st.State == protocol.ServerStateStopped || (st.State == protocol.ServerStateInstallFailed && changed))
	}
	if install {
		if st, err = client.Install(reqCtx); err != nil {
			return protocol.ServerStatus{}, err
		}
	}
	slog.Info("provisioned server", "server", id, "specHash", short(req.SpecHash), "recreated", recreate, "install", install, "state", st.State)
	if err := m.saveState(); err != nil {
		slog.Warn("could not write the agent state file", "error", err)
	}
	return statusFrom(id, req.SpecHash, st), nil
}

// ensureContainer makes the server's container exist for its current spec and run (gss-init idles while the game
// is stopped). recreate replaces an existing container; it is also replaced when its spec label is stale.
func (m *manager) ensureContainer(ctx context.Context, s *server, recreate bool) error {
	req := s.request()
	id := s.id
	name := ContainerName(id)
	info, exists, err := m.opts.Docker.ContainerInspect(ctx, name)
	if err != nil {
		return err
	}
	if exists && info.Labels[LabelSpec] != req.SpecHash {
		recreate = true
	}
	if exists && !recreate {
		if info.Running {
			return nil
		}
		if err := m.opts.Docker.ContainerStart(ctx, name); err != nil {
			return err
		}
		s.wake()
		return nil
	}

	if err := m.ensureImage(ctx, req.Spec.Image); err != nil {
		return err
	}
	if _, err := m.opts.Docker.NetworkEnsure(ctx, NetworkName(id), map[string]string{LabelServer: id}); err != nil {
		return err
	}
	if exists {
		if err := m.opts.Docker.ContainerStop(ctx, name, s.stopTimeout()+stopGrace); err != nil {
			return err
		}
		if err := m.opts.Docker.ContainerRemove(ctx, name); err != nil {
			return err
		}
	}
	// A socket left by an earlier gss-init refuses connections until the new one replaces it. gss-init makes run/
	// root's, so a non-root agent may not be allowed to remove it; gss-init replaces it on boot anyway.
	if err := os.Remove(m.opts.Layout.ServerSocket(id)); err != nil && !os.IsNotExist(err) && !os.IsPermission(err) {
		return fmt.Errorf("remove stale socket: %w", err)
	}
	if _, err := m.opts.Docker.ContainerCreate(ctx, m.containerSpec(req)); err != nil {
		return err
	}
	s.resetConsole()
	if err := m.opts.Docker.ContainerStart(ctx, name); err != nil {
		return err
	}
	s.wake()
	slog.Info("created game container", "server", id, "container", name, "image", req.Spec.Image)
	return nil
}

// containerSpec is the game container for a provision request.
func (m *manager) containerSpec(req protocol.ProvisionRequest) docker.ContainerSpec {
	spec := req.Spec
	id := spec.ServerID
	layout := m.opts.Layout
	ports := make([]docker.Port, 0, len(spec.Ports))
	for _, port := range spec.Ports {
		if port.Internal {
			continue
		}
		ports = append(ports, docker.Port{Port: int(port.Port), Proto: string(port.Proto)})
	}
	return docker.ContainerSpec{
		Name:  ContainerName(id),
		Image: spec.Image,
		Labels: map[string]string{
			LabelServer: id,
			LabelSpec:   req.SpecHash,
			LabelName:   spec.Name,
		},
		Network: NetworkName(id),
		// gss-init must come back after a Docker or host restart; the agent decides whether the game starts.
		Restart: "unless-stopped",
		Binds: []string{
			layout.ServerData(id) + ":" + protocol.InitDataPath,
			layout.ServerSpec(id) + ":/gss/spec:ro",
			layout.ServerRun(id) + ":/gss/run",
		},
		Ports:       ports,
		MemoryBytes: spec.Limits.MemoryMB << 20,
		NanoCPUs:    spec.Limits.CPUMillis * 1_000_000,
		PidsLimit:   spec.Limits.Pids,
		CapAdd:      InitCapabilities,
	}
}

// ensureImage pulls ref only when it is not present locally (locally built `:dev` tags are never pulled).
func (m *manager) ensureImage(ctx context.Context, ref string) error {
	ok, err := m.opts.Docker.ImageExists(ctx, ref)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	slog.Info("pulling image", "image", ref)
	progress := newLogWriter("image", ref)
	defer progress.Close()
	if err := m.opts.Docker.ImagePull(ctx, ref, progress); err != nil {
		return fmt.Errorf("image %s is not on this host and could not be pulled (check the name and that the host can reach its registry): %w", ref, err)
	}
	slog.Info("pulled image", "image", ref)
	return nil
}

// logWriter turns progress lines into debug log records.
type logWriter struct {
	pipe *io.PipeWriter
	done chan struct{}
}

func newLogWriter(key, value string) *logWriter {
	reader, writer := io.Pipe()
	w := &logWriter{pipe: writer, done: make(chan struct{})}
	go func() {
		defer close(w.done)
		scanner := bufio.NewScanner(reader)
		for scanner.Scan() {
			slog.Debug(scanner.Text(), key, value)
		}
		_, _ = io.Copy(io.Discard, reader)
	}()
	return w
}

func (w *logWriter) Write(p []byte) (int, error) { return w.pipe.Write(p) }

func (w *logWriter) Close() error {
	err := w.pipe.Close()
	<-w.done
	return err
}

// short abbreviates a hash for logs.
func short(hash string) string {
	if len(hash) > 12 {
		return hash[:12]
	}
	return hash
}
