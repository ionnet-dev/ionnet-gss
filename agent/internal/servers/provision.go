package servers

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/images"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/stacks"
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
	if _, err := images.ValidatePackages(spec.Packages); err != nil {
		return remoteError(protocol.ErrorCodeBadRequest, "spec.packages: %v.", err)
	}
	if err := stacks.Validate(spec.Services); err != nil {
		return remoteError(protocol.ErrorCodeBadRequest, "spec.services: %v.", err)
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

	// A restore holds s.op for its whole run: answer now instead of queueing behind it.
	if op := s.currentOperation(); op != nil && op.Operation == protocol.BackupOperationRestore {
		return protocol.ServerStatus{}, s.checkIdle("change its settings or reinstall")
	}
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
	if changed || recreate || req.Reinstall {
		// A backup reads the folders this would rewrite; a retried provision that changes nothing may pass.
		if err := s.checkIdle("change its settings or reinstall"); err != nil {
			return protocol.ServerStatus{}, err
		}
	}
	if (changed || recreate || req.Reinstall) && exists && info.Running && isActive(current.State) {
		return protocol.ServerStatus{}, remoteError(protocol.ErrorCodeConflict, "Server %s is %s. Stop it before changing its settings or reinstalling.", id, current.State)
	}

	progress := m.consoleWriter(s)
	defer progress.Close()
	// Before an install (a new server or a reinstall), fetch the newest image for the tag, so published image updates
	// reach servers when they install, and only then.
	if req.Reinstall || !wasInstalled {
		if err := m.opts.Images.Refresh(ctx, req.Spec.Image, progress); err != nil {
			return protocol.ServerStatus{}, err
		}
	}
	// The image to run: with `packages`, a derived image that changes when its base image does. A stopped server
	// moves to it now; a running one keeps its container until it is stopped and provisioned again.
	image, err := m.opts.Images.Ensure(ctx, req.Spec.Image, req.Spec.Packages, progress)
	if err != nil {
		return protocol.ServerStatus{}, err
	}
	if exists && !recreate && (info.Image != image || m.imageMoved(ctx, image, info.ImageID)) {
		if info.Running && isActive(current.State) {
			slog.Info("the server's image changed; it moves to the new one when it is provisioned while stopped", "server", id, "image", image)
		} else {
			recreate = true
		}
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
	// Services are created (and recreated when their spec changed) now, and start with the game.
	if err := m.opts.Stacks.Ensure(ctx, id, req.Spec.Services, progress); err != nil {
		m.refreshServices(ctx, s, true)
		return protocol.ServerStatus{}, err
	}
	m.refreshServices(ctx, s, true)
	if recreate {
		m.pruneImagesLater()
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
	return s.withServices(statusFrom(id, req.SpecHash, st)), nil
}

// imageMoved reports whether the tag image now points at a different image than the container runs (a newer one was
// pulled under the same tag). Unknown (no ID, inspect failed) counts as unchanged.
func (m *manager) imageMoved(ctx context.Context, image, runningID string) bool {
	if runningID == "" {
		return false
	}
	current, ok, err := m.opts.Docker.ImageInspect(ctx, image)
	return err == nil && ok && current.ID != "" && current.ID != runningID
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
			// Already up (started earlier, by an operator, or left running by a previous agent): its rules must still be
			// in place before anything reaches gss-init (provision, reinstall, update, start).
			return m.guardEgress(ctx, s)
		}
		network, err := m.ensureNetwork(ctx, id)
		if err != nil {
			return err
		}
		if err := m.applyEgress(ctx, s, network.Bridge); err != nil {
			return err
		}
		if err := m.opts.Docker.ContainerStart(ctx, name); err != nil {
			return portError(req, err)
		}
		s.wake()
		return nil
	}

	network, err := m.ensureNetwork(ctx, id)
	if err != nil {
		return err
	}
	if err := m.applyEgress(ctx, s, network.Bridge); err != nil {
		return err
	}
	// Right before the create, so a Prune running meanwhile still sees the image as just used.
	progress := m.consoleWriter(s)
	defer progress.Close()
	image, err := m.opts.Images.Ensure(ctx, req.Spec.Image, req.Spec.Packages, progress)
	if err != nil {
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
	if _, err := m.opts.Docker.ContainerCreate(ctx, m.containerSpec(req, image)); err != nil {
		return err
	}
	s.resetConsole()
	if err := m.opts.Docker.ContainerStart(ctx, name); err != nil {
		return portError(req, err)
	}
	s.wake()
	slog.Info("created game container", "server", id, "container", name, "image", image)
	return nil
}

// containerSpec is the game container for a provision request, running image (the spec's, or its derived image).
func (m *manager) containerSpec(req protocol.ProvisionRequest, image string) docker.ContainerSpec {
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
		Image: image,
		Labels: map[string]string{
			LabelServer: id,
			LabelSpec:   req.SpecHash,
			LabelName:   spec.Name,
		},
		Network: NetworkName(id),
		// No restart policy: after a reboot or a Docker restart nothing starts before the agent has rebuilt the egress
		// table; Restore (and the watcher, for a gss-init that exits while the agent runs) starts it again.
		Restart: "no",
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

// pruneImagesLater removes derived images no container uses any more, in the background.
func (m *manager) pruneImagesLater() {
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		if err := m.opts.Images.Prune(ctx); err != nil {
			slog.Warn("could not remove unused derived images", "error", err)
		}
	}()
}

// short abbreviates a hash for logs.
func short(hash string) string {
	if len(hash) > 12 {
		return hash[:12]
	}
	return hash
}
