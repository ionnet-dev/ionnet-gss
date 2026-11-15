package egress

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// LabelHelper marks the short-lived nft helper containers (value: "nft"), so a leftover from a crash is removed.
const LabelHelper = "ionnet-gss.helper"

const (
	// helperTimeout bounds one nft run, container start and removal included.
	helperTimeout = 60 * time.Second
	// pullTimeout bounds pulling a missing helper image.
	pullTimeout = 5 * time.Minute
	// freshFor: a restricted bridge applied this recently is not applied again before a start (a Restore that
	// just rebuilt the table starts many servers at once). Older than that, a start re-adds its elements, which
	// also notices a table someone removed and rebuilds it.
	freshFor = 30 * time.Second
	// logBytes is how much of nft's output goes into an error.
	logBytes = 2048
	// listBytes bounds a table listing (about 6 KiB plus 80 bytes per restricted bridge).
	listBytes = 1 << 20
)

// Firewall keeps the agent's nftables table in step with the servers it manages. Methods are safe for concurrent
// use; applies run one at a time.
type Firewall interface {
	// Sync replaces the whole table: restricted maps server id → bridge interface. Restore calls it first, so the
	// rules are in place before any container is started.
	Sync(ctx context.Context, restricted map[string]string) error
	// Restrict makes sure a server's bridge is filtered before its container or game starts.
	Restrict(ctx context.Context, serverID, bridge string) error
	// Release drops a server's entry (allowPrivateNetwork, or the server was deleted).
	Release(ctx context.Context, serverID string) error
	// Heal checks the table in the kernel (called about once a minute): it rebuilds it when the last apply failed,
	// or when the table is missing or differs from what the agent applied (an operator flushed the ruleset, an
	// older agent's table, a set edited by hand).
	Heal(ctx context.Context)
	// Facts is the host facts' `egress`, from the last apply or check; nil until the first apply finished.
	Facts() *protocol.EgressFacts
	// Table is the name of the agent's table (family inet).
	Table() string
}

// Runner runs an nft script on the host and returns nft's output: `nft -f`, or `nft -j -f` with list set (the
// script only lists, and the JSON output is returned whole).
type Runner func(ctx context.Context, script string, list bool) (string, error)

// Options configure New.
type Options struct {
	Docker docker.Client
	// Image is the helper image (must contain `nft`); pulled only when missing.
	Image string
	// Dir receives the script for the helper's bind mount (paths.Layout.NetfilterDir).
	Dir string
	// Table defaults to TableName.
	Table string
	// Run replaces the helper container (tests); nil = HelperRunner.
	Run Runner
}

// New returns the Firewall that applies its table through a helper container.
func New(opts Options) Firewall {
	if opts.Table == "" {
		opts.Table = TableName
	}
	if err := ValidTable(opts.Table); err != nil {
		panic(err) // The config is validated before; this is a programming error.
	}
	f := &firewall{table: opts.Table, run: opts.Run, desired: map[string]string{}}
	if f.run == nil {
		f.run = HelperRunner(opts.Docker, opts.Image, opts.Dir)
	}
	return f
}

type firewall struct {
	table string
	run   Runner

	mu      sync.Mutex        // one apply at a time; guards desired
	desired map[string]string // server id → bridge, restricted servers only

	factsMu   sync.Mutex
	checked   bool // an apply finished (successfully or not)
	healthy   bool // the last apply succeeded, so the kernel table matches desired
	lastErr   string
	checkedAt time.Time
	applied   map[string]time.Time // server id → when its bridge was last applied
}

func (f *firewall) Sync(ctx context.Context, restricted map[string]string) error {
	for _, bridge := range restricted {
		if err := ValidBridge(bridge); err != nil {
			return err
		}
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	f.desired = make(map[string]string, len(restricted))
	for id, bridge := range restricted {
		f.desired[id] = bridge
	}
	return f.rebuild(ctx)
}

func (f *firewall) Restrict(ctx context.Context, serverID, bridge string) error {
	if err := ValidBridge(bridge); err != nil {
		return err
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	healthy, fresh := f.state(serverID)
	if f.desired[serverID] == bridge && healthy && fresh {
		return nil
	}
	f.desired[serverID] = bridge
	if healthy {
		script, err := AddScript(f.table, []string{bridge})
		if err != nil {
			return err
		}
		_, err = f.run(ctx, script, false)
		if err == nil {
			f.record(nil, serverID)
			return nil
		}
		if ctx.Err() != nil {
			return f.fail(err)
		}
		slog.Info("adding to the egress table failed; rebuilding it", "error", err)
	}
	return f.rebuild(ctx)
}

func (f *firewall) Release(ctx context.Context, serverID string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, known := f.desired[serverID]
	healthy, _ := f.state("")
	if !known && healthy {
		return nil
	}
	delete(f.desired, serverID)
	return f.rebuild(ctx)
}

func (f *firewall) Heal(ctx context.Context) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.factsMu.Lock()
	checked, healthy := f.checked, f.healthy
	f.factsMu.Unlock()
	if !checked {
		return // Restore's Sync has not run yet.
	}
	if healthy {
		err := f.check(ctx)
		if err == nil {
			f.record(nil, "")
			return
		}
		if ctx.Err() != nil {
			return
		}
		slog.Warn("the egress table is not as the agent applied it; rebuilding it", "table", "inet "+f.table, "reason", err)
		f.record(fmt.Errorf("the table was changed outside the agent (%w); rebuilding it", err), "")
	}
	if err := f.rebuild(ctx); err == nil {
		slog.Info("egress filtering works again", "table", "inet "+f.table, "restricted", len(f.desired))
	}
}

// check lists the kernel's table and compares it with desired. Caller holds f.mu.
func (f *firewall) check(ctx context.Context) error {
	script, err := ListScript(f.table)
	if err != nil {
		return err
	}
	output, err := f.run(ctx, script, true)
	if err != nil {
		if strings.Contains(output, "No such file or directory") || strings.Contains(err.Error(), "No such file or directory") {
			return errTableMissing
		}
		return err
	}
	bridges := make([]string, 0, len(f.desired))
	for _, bridge := range f.desired {
		bridges = append(bridges, bridge)
	}
	return checkListing(output, f.table, bridges)
}

func (f *firewall) Table() string { return f.table }

func (f *firewall) Facts() *protocol.EgressFacts {
	f.factsMu.Lock()
	defer f.factsMu.Unlock()
	if !f.checked {
		return nil
	}
	facts := &protocol.EgressFacts{Filtering: f.healthy, CheckedAt: f.checkedAt}
	if f.healthy {
		facts.Restricted = int64(len(f.applied))
	}
	if f.lastErr != "" {
		reason := f.lastErr
		facts.Error = &reason
	}
	return facts
}

// state reports whether the last apply succeeded and whether serverID's bridge was applied within freshFor.
func (f *firewall) state(serverID string) (healthy, fresh bool) {
	f.factsMu.Lock()
	defer f.factsMu.Unlock()
	at, ok := f.applied[serverID]
	return f.healthy, ok && time.Since(at) < freshFor
}

// rebuild replaces the table with desired. Caller holds f.mu.
func (f *firewall) rebuild(ctx context.Context) error {
	bridges := make([]string, 0, len(f.desired))
	for _, bridge := range f.desired {
		bridges = append(bridges, bridge)
	}
	script, err := Ruleset(f.table, bridges)
	if err != nil {
		return f.fail(err)
	}
	if _, err := f.run(ctx, script, false); err != nil {
		return f.fail(err)
	}
	f.factsMu.Lock()
	f.applied = make(map[string]time.Time, len(f.desired))
	now := time.Now()
	for id := range f.desired {
		f.applied[id] = now
	}
	f.factsMu.Unlock()
	f.record(nil, "")
	slog.Info("applied the egress table", "table", "inet "+f.table, "restricted", len(bridges))
	return nil
}

// fail records a failed apply and returns it.
func (f *firewall) fail(err error) error {
	f.record(err, "")
	return err
}

// record stores an apply's outcome; serverID names an incremental add that succeeded.
func (f *firewall) record(err error, serverID string) {
	f.factsMu.Lock()
	defer f.factsMu.Unlock()
	now := time.Now().UTC()
	f.checked = true
	f.checkedAt = now
	if err != nil {
		if f.healthy || f.lastErr != err.Error() {
			slog.Warn("egress filtering does not work on this host; servers that may not reach private networks won't start", "error", err)
		}
		f.healthy = false
		f.lastErr = err.Error()
		f.applied = nil
		return
	}
	f.healthy = true
	f.lastErr = ""
	if serverID != "" {
		if f.applied == nil {
			f.applied = map[string]time.Time{}
		}
		f.applied[serverID] = now
	}
}

// HelperRunner applies scripts with `nft -f` in a short-lived container: the helper image, the host's network
// namespace, root with NET_ADMIN only (every other capability dropped, no-new-privileges), the script bind-mounted
// read-only. A missing image is pulled first. The container is removed afterwards, whatever happened.
func HelperRunner(client docker.Client, image, dir string) Runner {
	return func(ctx context.Context, script string, list bool) (string, error) {
		if client == nil {
			return "", errors.New("Docker is not reachable")
		}
		if image == "" {
			return "", errors.New("no helper image is configured (helperImage in the agent config)")
		}
		if err := ensureImage(ctx, client, image); err != nil {
			return "", err
		}
		file, err := writeScript(dir, script)
		if err != nil {
			return "", err
		}
		suffix := make([]byte, 4)
		if _, err := rand.Read(suffix); err != nil {
			return "", fmt.Errorf("name the helper container: %w", err)
		}
		name := "gss-nft-" + hex.EncodeToString(suffix)
		cmd, maxOutput := []string{"-f", "/gss/ruleset.nft"}, logBytes
		if list {
			cmd, maxOutput = []string{"-j", "-f", "/gss/ruleset.nft"}, listBytes
		}
		ctx, cancel := context.WithTimeout(ctx, helperTimeout)
		defer cancel()
		_, err = client.ContainerCreate(ctx, docker.ContainerSpec{
			Name:        name,
			Image:       image,
			Entrypoint:  []string{"nft"},
			Cmd:         cmd,
			Labels:      map[string]string{LabelHelper: "nft"},
			Network:     "host",
			Binds:       []string{file + ":/gss/ruleset.nft:ro"},
			User:        "0:0",
			CapAdd:      []string{"NET_ADMIN"},
			MemoryBytes: 64 << 20,
			PidsLimit:   16,
		})
		if err != nil {
			return "", fmt.Errorf("create the nft helper container from %s: %w", image, err)
		}
		defer func() {
			if err := client.ContainerRemove(context.WithoutCancel(ctx), name); err != nil {
				slog.Warn("could not remove the nft helper container", "container", name, "error", err)
			}
		}()
		if err := client.ContainerStart(ctx, name); err != nil {
			return "", fmt.Errorf("start the nft helper container: %w", err)
		}
		code, err := client.ContainerWait(ctx, name)
		if err != nil {
			return "", err
		}
		output, logErr := client.ContainerLogs(ctx, name, 50, maxOutput)
		output = strings.TrimSpace(output)
		if code != 0 {
			if output == "" && logErr != nil {
				output = logErr.Error()
			}
			if code == 127 || strings.Contains(output, "executable file not found") {
				return output, fmt.Errorf("the helper image %s has no `nft` (exit %d): %s", image, code, output)
			}
			return output, fmt.Errorf("nft refused the ruleset (exit %d): %s", code, output)
		}
		return output, nil
	}
}

// RemoveLeftovers removes helper containers a crashed agent left behind.
func RemoveLeftovers(ctx context.Context, client docker.Client) {
	containers, err := client.ContainerList(ctx, LabelHelper)
	if err != nil {
		return
	}
	for _, info := range containers {
		if err := client.ContainerRemove(ctx, info.Name); err != nil {
			slog.Warn("could not remove a leftover helper container", "container", info.Name, "error", err)
		}
	}
}

// ensureImage pulls image only when it is not present locally.
func ensureImage(ctx context.Context, client docker.Client, image string) error {
	ok, err := client.ImageExists(ctx, image)
	if err != nil {
		return err
	}
	if ok {
		return nil
	}
	slog.Info("pulling the helper image", "image", image)
	ctx, cancel := context.WithTimeout(ctx, pullTimeout)
	defer cancel()
	if err := client.ImagePull(ctx, image, io.Discard); err != nil {
		return fmt.Errorf("the helper image %s is not on this host and could not be pulled (set helperImage in the agent config to an image with `nft`): %w", image, err)
	}
	return nil
}

// writeScript stores the script as <dir>/ruleset.nft, mode 0644 so the helper's root without DAC_OVERRIDE can read
// it. It holds interface names and fixed ranges only.
func writeScript(dir, script string) (string, error) {
	if dir == "" {
		return "", errors.New("no folder for the nft script")
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", fmt.Errorf("create %s: %w", dir, err)
	}
	abs, err := filepath.Abs(filepath.Join(dir, "ruleset.nft"))
	if err != nil {
		return "", err
	}
	tmp, err := os.CreateTemp(dir, ".ruleset-*.nft")
	if err != nil {
		return "", fmt.Errorf("write the nft script: %w", err)
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.WriteString(script); err != nil {
		tmp.Close()
		return "", fmt.Errorf("write the nft script: %w", err)
	}
	if err := tmp.Chmod(0o644); err != nil {
		tmp.Close()
		return "", fmt.Errorf("write the nft script: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return "", fmt.Errorf("write the nft script: %w", err)
	}
	if err := os.Rename(tmp.Name(), abs); err != nil {
		return "", fmt.Errorf("write the nft script: %w", err)
	}
	return abs, nil
}
