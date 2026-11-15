// Package paths names every file and folder the agent uses on a host. Container-side paths are in the protocol
// package (InitSpecPath, InitSocketPath, InitDataPath).
package paths

import "path/filepath"

const (
	// ConfigFile holds the panel URL, host id and credential (root:root 0600). Override with --config or
	// GSS_AGENT_CONFIG.
	ConfigFile = "/etc/ionnet-gss/agent.json"
	// DefaultDataRoot is the agent's data root unless the config sets another.
	DefaultDataRoot = "/var/lib/ionnet-gss"
	// DefaultDockerHost is the Docker Engine API endpoint unless the config sets another.
	DefaultDockerHost = "unix:///var/run/docker.sock"
	// DefaultHelperImage runs the agent's short-lived helper containers (nft for egress filtering) unless the
	// config sets another. It must contain `nft`.
	DefaultHelperImage = "ghcr.io/ionnet-dev/ionnet-gss-base:latest"
)

// Layout resolves paths below one data root.
type Layout struct {
	Root string
}

// StateFile is the agent's own record of its servers (M2): last state, spec hash, autostart, was-running.
func (l Layout) StateFile() string { return filepath.Join(l.Root, "state.json") }

// ServersDir holds one folder per game server.
func (l Layout) ServersDir() string { return filepath.Join(l.Root, "servers") }

// ServerDir is /var/lib/ionnet-gss/servers/<uuid>.
func (l Layout) ServerDir(serverID string) string { return filepath.Join(l.ServersDir(), serverID) }

// ServerData is mounted at /data in the container.
func (l Layout) ServerData(serverID string) string {
	return filepath.Join(l.ServerDir(serverID), "data")
}

// ServerManifest is the agent's copy of the last ProvisionRequest (spec + hash), root-only and never mounted: Restore
// rebuilds the container from it.
func (l Layout) ServerManifest(serverID string) string {
	return filepath.Join(l.ServerDir(serverID), "server.json")
}

// ServerSpec is mounted read-only at /gss/spec (spec.json + files/).
func (l Layout) ServerSpec(serverID string) string {
	return filepath.Join(l.ServerDir(serverID), "spec")
}

// ServerInitSpec is the host-side INIT_SPEC_PATH (spec/spec.json).
func (l Layout) ServerInitSpec(serverID string) string {
	return filepath.Join(l.ServerSpec(serverID), "spec.json")
}

// ServerFiles is the host-side INIT_FILES_DIR (spec/files): definition files under their definition-relative path.
func (l Layout) ServerFiles(serverID string) string {
	return filepath.Join(l.ServerSpec(serverID), "files")
}

// ServerRun is mounted read-write at /gss/run; gss-init creates init.sock in it.
func (l Layout) ServerRun(serverID string) string { return filepath.Join(l.ServerDir(serverID), "run") }

// ServerSocket is the host-side path of the supervisor socket.
func (l Layout) ServerSocket(serverID string) string {
	return filepath.Join(l.ServerRun(serverID), "init.sock")
}

// ServerServiceVolume persists one stack service's volume.
func (l Layout) ServerServiceVolume(serverID, service string) string {
	return filepath.Join(l.ServerDir(serverID), "services", service)
}

// ServerBackups holds the server's backup archives (M4).
func (l Layout) ServerBackups(serverID string) string {
	return filepath.Join(l.ServerDir(serverID), "backups")
}

// SteamcmdCache is the per-host steamcmd install shared by every steamcmd game (M3).
func (l Layout) SteamcmdCache() string { return filepath.Join(l.Root, "cache", "steamcmd") }

// NetfilterDir holds the last nftables script the agent applied (bind-mounted read-only into the nft helper).
func (l Layout) NetfilterDir() string { return filepath.Join(l.Root, "netfilter") }
