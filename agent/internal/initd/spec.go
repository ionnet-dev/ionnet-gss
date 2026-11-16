package initd

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Spec defaults (definition.json): stop timeout, auto-restart limits.
const (
	DEFAULT_STOP_TIMEOUT_SEC   = 30
	DEFAULT_RESTART_MAX        = 3
	DEFAULT_RESTART_WINDOW_SEC = 600
)

// compiledSpec is a validated InitSpec with its patterns compiled and defaults filled in.
type compiledSpec struct {
	protocol.InitSpec
	ready       *regexp.Regexp // nil = running as soon as the process starts
	players     *players       // never nil; no patterns = never matches
	stopTimeout time.Duration
}

// loadSpec reads and validates the spec file.
func loadSpec(path string) (*compiledSpec, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read spec %s: %w", path, err)
	}
	var spec protocol.InitSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return nil, fmt.Errorf("spec %s is not valid JSON: %w", path, err)
	}
	return compileSpec(spec)
}

func compileSpec(spec protocol.InitSpec) (*compiledSpec, error) {
	c := &compiledSpec{InitSpec: spec}
	if strings.TrimSpace(spec.Start) == "" {
		return nil, errors.New("spec has no start command")
	}
	if spec.Ready != nil && spec.Ready.Log != "" {
		re, err := regexp.Compile(spec.Ready.Log)
		if err != nil {
			return nil, fmt.Errorf("ready pattern %q is not a valid RE2 expression: %w", spec.Ready.Log, err)
		}
		c.ready = re
	}
	tracker, err := newPlayers(spec.Players)
	if err != nil {
		return nil, err
	}
	c.players = tracker
	if spec.Stop.Signal != "" {
		if _, ok := parseSignal(spec.Stop.Signal); !ok {
			return nil, fmt.Errorf("stop signal %q is not a known signal (e.g. SIGTERM, SIGINT)", spec.Stop.Signal)
		}
	}
	timeout := spec.Stop.Timeout
	if timeout <= 0 {
		timeout = DEFAULT_STOP_TIMEOUT_SEC
	}
	c.stopTimeout = time.Duration(timeout) * time.Second
	if c.AutoRestart.Max <= 0 {
		c.AutoRestart.Max = DEFAULT_RESTART_MAX
	}
	if c.AutoRestart.WindowSec <= 0 {
		c.AutoRestart.WindowSec = DEFAULT_RESTART_WINDOW_SEC
	}
	for i, m := range spec.Configs {
		if _, err := datafs.Rel(m.File); err != nil {
			return nil, fmt.Errorf("config %d: %w", i+1, err)
		}
	}
	if c.Env == nil {
		c.Env = map[string]string{}
	}
	return c, nil
}

// INSTALL_MARKER is the install record on the data volume, so a recreated or restarted container knows whether the
// server was installed. It is root-owned; deleting it makes the next container start install again.
const INSTALL_MARKER = ".gss-install.json"

// Install results in the marker.
const (
	installRunning = "running"
	installOK      = "ok"
	installFailed  = "failed"
)

// installMarker is the content of INSTALL_MARKER.
type installMarker struct {
	ServerID    string     `json:"serverId"`
	Result      string     `json:"result"`      // running | ok | failed
	InstalledAt *time.Time `json:"installedAt"` // last successful install; null = never
	Reason      string     `json:"reason,omitempty"`
	At          time.Time  `json:"at"`
}

func readMarker(data *os.Root) (*installMarker, error) {
	raw, err := data.ReadFile(INSTALL_MARKER)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var m installMarker
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("install marker %s is damaged: %w", INSTALL_MARKER, err)
	}
	return &m, nil
}

func writeMarker(data *os.Root, m installMarker) error {
	m.At = time.Now().UTC()
	raw, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return err
	}
	return datafs.WriteFile(data, INSTALL_MARKER, append(raw, '\n'), 0o644, -1)
}

// unsupportedRcon is the M2 RconClient: console input over rcon lands with the M3 formats.
type unsupportedRcon struct{}

var _ RconClient = unsupportedRcon{}

// ErrRconUnsupported is returned for console.input rcon until M3.
var ErrRconUnsupported = errors.New("console input over rcon is not supported until M3; use console.input stdin")

func (unsupportedRcon) Send(ctx context.Context, command string) (string, error) {
	return "", ErrRconUnsupported
}
