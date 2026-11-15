// Package docker is a small Docker Engine API client over the unix socket, with net/http only (no Docker SDK).
// M1 needs Version; M2 adds images, networks and containers for internal/servers.
package docker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

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
	// ContainerStart starts a created or stopped container. An already running one is not an error.
	ContainerStart(ctx context.Context, name string) error
	// ContainerStop sends SIGTERM, then SIGKILL after timeout. A stopped or missing one is not an error.
	ContainerStop(ctx context.Context, name string, timeout time.Duration) error
	// ContainerRemove force-removes a container; a missing one is not an error.
	ContainerRemove(ctx context.Context, name string) error
	// ContainerWait blocks until the container exits and returns its exit code.
	ContainerWait(ctx context.Context, name string) (int, error)
	// ContainerInspect returns the container's state, or ok=false when it does not exist.
	ContainerInspect(ctx context.Context, name string) (info ContainerInfo, ok bool, err error)
	// ContainerList lists containers (running or not) with the given label (e.g. "ionnet-gss.server").
	ContainerList(ctx context.Context, label string) ([]ContainerInfo, error)
	// ContainerStats takes one stats sample (stream=false).
	ContainerStats(ctx context.Context, name string) (Stats, error)
}

// VersionInfo is the subset of GET /version the agent reports.
type VersionInfo struct {
	Version    string
	APIVersion string
}

// ContainerSpec is what internal/servers needs to create a game or service container. Every container is created
// with all capabilities dropped (plus CapAdd), no-new-privileges, no swap beyond MemoryBytes, and a rotated
// json-file log (gss-init copies the console to stdout).
type ContainerSpec struct {
	Name       string
	Image      string
	Entrypoint []string // Empty = the image's entrypoint.
	Cmd        []string // Empty = the image's default (gss-init for game containers).
	Env        map[string]string
	Labels     map[string]string
	// Network is the network to join ("none" for no networking).
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
	// CapAdd is added on top of "drop all" (servers.InitCapabilities for game containers).
	CapAdd []string
	Tty    bool
	// Restart is the Docker restart policy name; empty = "no".
	Restart string
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
	// Status is Docker's state word: created, running, paused, restarting, removing, exited or dead.
	Status string
	// StartedAt is when the container's current (or last) run started; it changes on every restart. Empty in lists.
	StartedAt string
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

// APIError is a Docker Engine answer outside 2xx (and 304).
type APIError struct {
	Method  string
	Path    string
	Status  int
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("docker: %s %s answered %d: %s", e.Method, e.Path, e.Status, e.Message)
}

// IsNotFound reports whether err is a Docker 404 (no such image, container or network).
func IsNotFound(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound
}

// IsConflict reports whether err is a Docker 409 (name in use, removal in progress…).
func IsConflict(err error) bool {
	var apiErr *APIError
	return errors.As(err, &apiErr) && apiErr.Status == http.StatusConflict
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
	// No client timeout: pulls and builds stream for minutes. Every call carries a context instead.
	c.http = &http.Client{Transport: transport}
	return c, nil
}

type unixClient struct {
	host    string
	baseURL string
	http    *http.Client
}

// send performs one request. body is JSON-encoded unless it is an io.Reader (sent as contentType). The caller
// closes the returned body. Statuses outside 2xx and 304 become *APIError.
func (c *unixClient) send(ctx context.Context, method, path string, query url.Values, body any, contentType string) (*http.Response, error) {
	var reader io.Reader
	switch b := body.(type) {
	case nil:
	case io.Reader:
		reader = b
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			return nil, fmt.Errorf("docker: encode %s %s: %w", method, path, err)
		}
		reader = bytes.NewReader(raw)
		contentType = "application/json"
	}
	target := c.baseURL + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	if contentType != "" {
		req.Header.Set("Content-Type", contentType)
	}
	res, err := c.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("docker at %s: %w", c.host, err)
	}
	if (res.StatusCode >= 200 && res.StatusCode < 300) || res.StatusCode == http.StatusNotModified {
		return res, nil
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	var answer struct {
		Message string `json:"message"`
	}
	message := strings.TrimSpace(string(raw))
	if json.Unmarshal(raw, &answer) == nil && answer.Message != "" {
		message = answer.Message
	}
	if message == "" {
		message = res.Status
	}
	return nil, &APIError{Method: method, Path: path, Status: res.StatusCode, Message: message}
}

// call performs one request and decodes a JSON answer into out (may be nil to discard it).
func (c *unixClient) call(ctx context.Context, method, path string, query url.Values, body, out any) error {
	res, err := c.send(ctx, method, path, query, body, "")
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if out == nil || res.StatusCode == http.StatusNoContent || res.StatusCode == http.StatusNotModified {
		_, _ = io.Copy(io.Discard, res.Body)
		return nil
	}
	if err := json.NewDecoder(res.Body).Decode(out); err != nil {
		return fmt.Errorf("docker: decode %s %s: %w", method, path, err)
	}
	return nil
}

// get fetches path and decodes the JSON answer into out.
func (c *unixClient) get(ctx context.Context, path string, out any) error {
	return c.call(ctx, http.MethodGet, path, nil, nil, out)
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

// jsonMessage is one line of the progress stream of a pull or build.
type jsonMessage struct {
	Status      string `json:"status"`
	ID          string `json:"id"`
	Progress    string `json:"progress"`
	Stream      string `json:"stream"`
	Error       string `json:"error"`
	ErrorDetail *struct {
		Message string `json:"message"`
	} `json:"errorDetail"`
}

// readStream consumes a pull/build progress stream, copies readable lines to progress (may be nil), and returns the
// error the stream ended with. Docker reports failures inside a 200 stream, so this is the only place they show.
func readStream(body io.Reader, progress io.Writer) error {
	decoder := json.NewDecoder(body)
	for {
		var msg jsonMessage
		err := decoder.Decode(&msg)
		if errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return fmt.Errorf("docker: read progress stream: %w", err)
		}
		if msg.Error != "" || msg.ErrorDetail != nil {
			text := msg.Error
			if text == "" {
				text = msg.ErrorDetail.Message
			}
			return errors.New(text)
		}
		if progress == nil {
			continue
		}
		switch {
		case msg.Stream != "":
			_, _ = io.WriteString(progress, msg.Stream)
		case msg.Status != "" && msg.Progress == "": // Skip the per-chunk progress bars.
			line := msg.Status
			if msg.ID != "" {
				line = msg.ID + ": " + line
			}
			_, _ = io.WriteString(progress, line+"\n")
		}
	}
}
