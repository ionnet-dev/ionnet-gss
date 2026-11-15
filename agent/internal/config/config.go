// Package config loads and saves the agent's config file: which panel, which host, which credential.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/egress"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
)

// ErrNotEnrolled is returned by Load when the file does not exist yet. `gss-agent run` tells the operator to run
// `gss-agent enrol` first.
var ErrNotEnrolled = errors.New("not enrolled yet: run `gss-agent enrol --panel <url> --token <token>` first")

// Config is the agent's config file (JSON, 0600).
type Config struct {
	// PanelURL is the panel's public URL, e.g. https://gss.ionnet.dev. The agent dials <PanelURL>/ws/agent.
	PanelURL string `json:"panelUrl"`
	// HostID is the host's UUID from the enrol response.
	HostID string `json:"hostId"`
	// Credential is the long-lived gss_host_… secret from the enrol response.
	Credential string `json:"credential"`
	// Insecure allows a plain http:// PanelURL on a non-loopback host (enrolled with --insecure).
	Insecure bool `json:"insecure,omitempty"`
	// DataRoot defaults to paths.DefaultDataRoot.
	DataRoot string `json:"dataRoot,omitempty"`
	// DockerHost defaults to paths.DefaultDockerHost.
	DockerHost string `json:"dockerHost,omitempty"`
	// HelperImage defaults to paths.DefaultHelperImage: the image of the nft helper container that applies the
	// egress filtering table. It is pulled only when missing.
	HelperImage string `json:"helperImage,omitempty"`
	// EgressTable defaults to egress.TableName (`ionnet_gss`): the nftables table (family inet) this agent owns.
	// Only one agent may manage a given table, so a second agent on the same host (a test instance) needs its own.
	EgressTable string `json:"egressTable,omitempty"`
}

// WithDefaults returns a copy with empty optional fields filled in.
func (c Config) WithDefaults() Config {
	if c.DataRoot == "" {
		c.DataRoot = paths.DefaultDataRoot
	}
	if c.DockerHost == "" {
		c.DockerHost = paths.DefaultDockerHost
	}
	if c.HelperImage == "" {
		c.HelperImage = paths.DefaultHelperImage
	}
	if c.EgressTable == "" {
		c.EgressTable = egress.TableName
	}
	return c
}

// Store reads and writes the config file.
type Store interface {
	// Load returns ErrNotEnrolled when the file is missing.
	Load() (Config, error)
	// Save writes atomically (temp file + rename) with mode 0600, creating the folder (0700).
	Save(Config) error
	// Path is the file location, for messages.
	Path() string
}

// FileStore is the Store on disk.
type FileStore struct {
	path string
}

// NewFileStore uses path, or paths.ConfigFile when empty.
func NewFileStore(path string) *FileStore {
	if path == "" {
		path = paths.ConfigFile
	}
	return &FileStore{path: path}
}

// Path implements Store.
func (s *FileStore) Path() string { return s.path }

// Load implements Store.
func (s *FileStore) Load() (Config, error) {
	raw, err := os.ReadFile(s.path)
	if errors.Is(err, os.ErrNotExist) {
		return Config{}, ErrNotEnrolled
	}
	if err != nil {
		return Config{}, fmt.Errorf("read config %s: %w", s.path, err)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return Config{}, fmt.Errorf("config %s is not valid JSON (%w): fix it or re-enrol with --force", s.path, err)
	}
	if c.PanelURL == "" || c.HostID == "" || c.Credential == "" {
		return Config{}, fmt.Errorf("config %s is missing panelUrl, hostId or credential: re-enrol with --force", s.path)
	}
	if c.EgressTable != "" {
		if err := egress.ValidTable(c.EgressTable); err != nil {
			return Config{}, fmt.Errorf("config %s: egressTable: %w", s.path, err)
		}
	}
	return c, nil
}

// Save implements Store.
func (s *FileStore) Save(c Config) error {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	tmp, err := s.createTemp()
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name()) // No-op once renamed.
	if _, err := tmp.Write(append(raw, '\n')); err != nil {
		tmp.Close()
		return fmt.Errorf("write config %s: %w", tmp.Name(), err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("write config %s: %w", tmp.Name(), err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write config %s: %w", tmp.Name(), err)
	}
	if err := os.Rename(tmp.Name(), s.path); err != nil {
		return fmt.Errorf("replace config %s: %w", s.path, err)
	}
	return nil
}

// CheckWritable fails when the config file cannot be created, so `enrol` can stop before it spends the one-time token.
func (s *FileStore) CheckWritable() error {
	tmp, err := s.createTemp()
	if err != nil {
		return err
	}
	tmp.Close()
	return os.Remove(tmp.Name())
}

// createTemp makes the config folder (0700) and a 0600 temp file next to the config file.
func (s *FileStore) createTemp() (*os.File, error) {
	dir := filepath.Dir(s.path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, fmt.Errorf("create config folder %s: %w (run as root, or pass --config)", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".agent-*.tmp") // CreateTemp uses mode 0600.
	if err != nil {
		return nil, fmt.Errorf("write config in %s: %w (run as root, or pass --config)", dir, err)
	}
	return tmp, nil
}
