// Package docker is a small Docker Engine API client over the unix socket, with net/http only (no Docker SDK).
// M1 needs Version; the rest is the M2 contract for internal/servers.
package docker

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// ErrNotImplemented marks skeleton methods.
var ErrNotImplemented = errors.New("docker: not implemented")

// Client is everything the agent asks of Docker.
type Client interface {
	// Version reports the engine and API version (GET /version). An error means Docker is unreachable; host facts
	// then carry docker: null.
	Version(ctx context.Context) (VersionInfo, error)

	// M2

	// ImageExists reports whether ref is present locally.
	ImageExists(ctx context.Context, ref string) (bool, error)
	// ImagePull pulls ref, streaming progress lines to progress (may be nil).
	ImagePull(ctx context.Context, ref string, progress io.Writer) error
	// ImageBuild builds tag from a Dockerfile given as text (derived images for `packages:`).
	ImageBuild(ctx context.Context, tag, dockerfile string, progress io.Writer) error
	// NetworkEnsure creates the per-server bridge network if missing and returns its id.
	NetworkEnsure(ctx context.Context, name string, labels map[string]string) (string, error)
	// NetworkRemove removes a network; a missing one is not an error.
	NetworkRemove(ctx context.Context, name string) error
	// ContainerCreate creates (not starts) a container and returns its id.
	ContainerCreate(ctx context.Context, spec ContainerSpec) (string, error)
	// ContainerStart starts a created or stopped container.
	ContainerStart(ctx context.Context, name string) error
	// ContainerStop sends SIGTERM, then SIGKILL after timeout.
	ContainerStop(ctx context.Context, name string, timeout time.Duration) error
	// ContainerRemove force-removes a container; a missing one is not an error.
	ContainerRemove(ctx context.Context, name string) error
	// ContainerInspect returns the container's state, or ok=false when it does not exist.
	ContainerInspect(ctx context.Context, name string) (info ContainerInfo, ok bool, err error)
	// ContainerList lists containers with the given label (e.g. "ionnet-gss.server").
	ContainerList(ctx context.Context, label string) ([]ContainerInfo, error)
	// ContainerStats takes one stats sample (stream=false).
	ContainerStats(ctx context.Context, name string) (Stats, error)
}

// VersionInfo is the subset of GET /version the agent reports.
type VersionInfo struct {
	Version    string
	APIVersion string
}

// ContainerSpec is what internal/servers needs to create a game or service container.
type ContainerSpec struct {
	Name    string
	Image   string
	Cmd     []string // Empty = the image's default (gss-init for game containers).
	Env     map[string]string
	Labels  map[string]string
	Network string
	// Aliases are the container's names on Network (a stack service's key, e.g. "db").
	Aliases []string
	// Binds as host:container[:ro].
	Binds []string
	// Ports to publish; host and container port are the same number.
	Ports       []Port
	MemoryBytes int64
	NanoCPUs    int64 // 1e9 = one CPU.
	PidsLimit   int64
	User        string // Empty = image default. gss-init runs as root and drops to GAME_UID itself.
	// CapAdd is added on top of "drop all": gss-init needs CHOWN, SETUID, SETGID, KILL, DAC_OVERRIDE (M2 decides).
	CapAdd []string
	Tty    bool
}

// Port is one published port.
type Port struct {
	Port  int
	Proto string // "tcp" or "udp".
}

// ContainerInfo is the subset of inspect/list the agent uses.
type ContainerInfo struct {
	ID       string
	Name     string
	Image    string
	Labels   map[string]string
	Running  bool
	ExitCode int
}

// Stats is one sample, already converted from Docker's cumulative counters.
type Stats struct {
	CPUPercent       float64
	MemoryBytes      int64
	MemoryLimitBytes int64
	NetRxBytes       int64
	NetTxBytes       int64
	Pids             int64
}

// New returns a client for host (unix:///var/run/docker.sock or a tcp:// URL).
func New(host string) (Client, error) {
	c := &unixClient{host: host, baseURL: "http://docker"}
	transport := &http.Transport{}
	switch {
	case strings.HasPrefix(host, "unix://"):
		socket := strings.TrimPrefix(host, "unix://")
		transport.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", socket)
		}
	case strings.HasPrefix(host, "tcp://"):
		c.baseURL = "http://" + strings.TrimPrefix(host, "tcp://")
	default:
		return nil, fmt.Errorf("docker host %q must start with unix:// or tcp://", host)
	}
	c.http = &http.Client{Transport: transport}
	return c, nil
}

type unixClient struct {
	host    string
	baseURL string
	http    *http.Client
}

// get fetches path and decodes the JSON answer into out.
func (c *unixClient) get(ctx context.Context, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+path, nil)
	if err != nil {
		return err
	}
	res, err := c.http.Do(req)
	if err != nil {
		return fmt.Errorf("docker at %s: %w", c.host, err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Errorf("docker at %s: GET %s answered %s", c.host, path, res.Status)
	}
	return json.NewDecoder(res.Body).Decode(out)
}

func (c *unixClient) Version(ctx context.Context) (VersionInfo, error) {
	var res struct {
		Version    string `json:"Version"`
		APIVersion string `json:"ApiVersion"`
	}
	if err := c.get(ctx, "/version", &res); err != nil {
		return VersionInfo{}, err
	}
	return VersionInfo{Version: res.Version, APIVersion: res.APIVersion}, nil
}

func (c *unixClient) ImageExists(ctx context.Context, ref string) (bool, error) {
	return false, ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ImagePull(ctx context.Context, ref string, progress io.Writer) error {
	return ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ImageBuild(ctx context.Context, tag, dockerfile string, progress io.Writer) error {
	return ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) NetworkEnsure(ctx context.Context, name string, labels map[string]string) (string, error) {
	return "", ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) NetworkRemove(ctx context.Context, name string) error {
	return ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ContainerCreate(ctx context.Context, spec ContainerSpec) (string, error) {
	return "", ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ContainerStart(ctx context.Context, name string) error {
	return ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ContainerStop(ctx context.Context, name string, timeout time.Duration) error {
	return ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ContainerRemove(ctx context.Context, name string) error {
	return ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ContainerInspect(ctx context.Context, name string) (ContainerInfo, bool, error) {
	return ContainerInfo{}, false, ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ContainerList(ctx context.Context, label string) ([]ContainerInfo, error) {
	return nil, ErrNotImplemented // TODO(builder): M2
}

func (c *unixClient) ContainerStats(ctx context.Context, name string) (Stats, error) {
	return Stats{}, ErrNotImplemented // TODO(builder): M2
}
