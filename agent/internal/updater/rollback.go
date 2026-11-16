package updater

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"os"
	"path/filepath"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Files next to the binary that make an update reversible:
//
//	.gss-agent-previous  the replaced binary (a hard link, or a copy)
//	.gss-agent-update    marker of a swap not yet confirmed by a successful hello (pendingSwap)
//	.gss-agent-rejected  a build that was rolled back, refused from then on (rejectedBuild)
const (
	previousName = ".gss-agent-previous"
	markerName   = ".gss-agent-update"
	rejectedName = ".gss-agent-rejected"
)

// MaxStartAttempts is how often a new build may start without reaching a successful hello; the next start rolls
// back to the previous binary.
const MaxStartAttempts = 3

// pendingSwap is the marker's content.
type pendingSwap struct {
	// Sha256 is the new build.
	Sha256 string `json:"sha256"`
	// Previous is the backup of the replaced binary.
	Previous string `json:"previous"`
	// PreviousSha256 is the replaced build; empty when it could not be read.
	PreviousSha256 string `json:"previousSha256,omitempty"`
	// Attempts counts the new build's starts so far.
	Attempts int `json:"attempts"`
}

// rejectedBuild records a rolled-back build.
type rejectedBuild struct {
	Sha256 string    `json:"sha256"`
	Reason string    `json:"reason"`
	At     time.Time `json:"at"`
	// Reported is set once the panel was told (a failed agent.updateStatus after the reconnect).
	Reported bool `json:"reported"`
}

func siblingPath(exe, name string) string {
	return filepath.Join(filepath.Dir(exe), name)
}

// Self is the running binary: its path (symlinks resolved; empty when unknown) and build (nil when unreadable).
type Self struct {
	Executable string
	Build      *string
}

// ReadSelf finds and hashes the running binary. An error leaves Executable empty: no build fact, no self-update.
func ReadSelf() (Self, error) {
	exe, err := Executable()
	if err != nil {
		return Self{}, err
	}
	return Self{Executable: exe, Build: ReadBuild(exe)}, nil
}

// Startup is the crash-loop guard, called early in `gss-agent run`. With no marker it does nothing. A marker for
// another build than the running one is stale and removed (with its backup). Otherwise it counts this start; past
// MaxStartAttempts it restores the previous binary, records the build as rejected and returns true: the caller
// re-execs self.Executable (now the previous build).
func Startup(self Self) bool {
	if self.Executable == "" {
		return false
	}
	markerPath := siblingPath(self.Executable, markerName)
	raw, err := os.ReadFile(markerPath)
	if errors.Is(err, fs.ErrNotExist) {
		return false
	}
	var swap pendingSwap
	if err == nil {
		err = json.Unmarshal(raw, &swap)
	}
	if err != nil {
		slog.Warn("removing an unreadable agent update marker", "path", markerPath, "error", err)
		discardSwap(self.Executable)
		return false
	}
	if self.Build == nil || *self.Build != swap.Sha256 {
		slog.Info("removing the marker of an agent update this binary is not (the update was rolled back or the binary replaced by hand)", "marker", swap.Sha256, "running", deref(self.Build))
		discardSwap(self.Executable)
		return false
	}
	swap.Attempts++
	if swap.Attempts <= MaxStartAttempts {
		if err := writeJSON(markerPath, swap); err != nil {
			slog.Warn("could not count this start of the updated agent; a crash loop would not be rolled back", "error", err)
		}
		return false
	}
	reason := fmt.Sprintf("Build %s started %d times without reaching the panel, so the agent rolled back to its previous binary.", swap.Sha256, MaxStartAttempts)
	if err := restorePrevious(self.Executable, swap.Sha256, reason); err != nil {
		slog.Error("the updated agent keeps failing and the previous binary could not be restored; re-run the install command on the host", "error", err)
		return false
	}
	slog.Error("rolled back a failed agent update: restarting into the previous binary", "rejected", swap.Sha256, "previous", swap.PreviousSha256, "path", self.Executable)
	return true
}

// Restore puts the previous binary back after the restart into a new build failed (exec error), and records the
// new build as rejected. The caller exits non-zero, so systemd starts the previous binary.
func Restore(exe string) error {
	raw, err := os.ReadFile(siblingPath(exe, markerName))
	if err != nil {
		return fmt.Errorf("read the update marker: %w", err)
	}
	var swap pendingSwap
	if err := json.Unmarshal(raw, &swap); err != nil {
		return fmt.Errorf("read the update marker: %w", err)
	}
	return restorePrevious(exe, swap.Sha256, fmt.Sprintf("Build %s could not be started, so the agent rolled back to its previous binary.", swap.Sha256))
}

// restorePrevious renames the backup over exe, removes the marker and records sha as rejected.
func restorePrevious(exe, sha, reason string) error {
	previous := siblingPath(exe, previousName)
	if err := os.Rename(previous, exe); err != nil {
		return fmt.Errorf("restore %s over %s: %w", previous, exe, err)
	}
	_ = os.Remove(siblingPath(exe, markerName))
	if err := writeJSON(siblingPath(exe, rejectedName), rejectedBuild{Sha256: sha, Reason: reason, At: time.Now().UTC()}); err != nil {
		slog.Warn("could not record the rolled-back build; the panel may offer it again", "error", err)
	}
	return nil
}

// discardSwap removes the marker and the backup.
func discardSwap(exe string) {
	_ = os.Remove(siblingPath(exe, markerName))
	_ = os.Remove(siblingPath(exe, previousName))
}

// prepareSwap keeps the running binary as the backup and writes the marker for sha, right before the rename.
func (u *Updater) prepareSwap(sha string) error {
	exe := u.opts.Executable
	previous := siblingPath(exe, previousName)
	_ = os.Remove(previous)
	if err := os.Link(exe, previous); err != nil {
		if err := copyFile(exe, previous); err != nil {
			_ = os.Remove(previous)
			return errors.New(u.writeError("keep a copy of the current binary as", previous, err))
		}
	}
	swap := pendingSwap{Sha256: sha, Previous: previous, PreviousSha256: deref(u.opts.Build)}
	if err := writeJSON(siblingPath(exe, markerName), swap); err != nil {
		_ = os.Remove(previous)
		return errors.New(u.writeError("write the update marker in", filepath.Dir(exe), err))
	}
	return nil
}

// Confirm ends an update after the first successful hello of the new build: the marker and the backup go.
func (u *Updater) Confirm() {
	exe := u.opts.Executable
	if exe == "" || u.opts.Build == nil {
		return
	}
	raw, err := os.ReadFile(siblingPath(exe, markerName))
	if err != nil {
		return
	}
	var swap pendingSwap
	if json.Unmarshal(raw, &swap) == nil && swap.Sha256 != *u.opts.Build {
		return // Startup removes a stale marker; this one belongs to a build that is not running
	}
	discardSwap(exe)
	slog.Info("the updated agent reached the panel; removed the previous binary", "sha256", *u.opts.Build)
}

// rejected returns the rolled-back build, if any.
func (u *Updater) rejected() (rejectedBuild, bool) {
	if u.opts.Executable == "" {
		return rejectedBuild{}, false
	}
	raw, err := os.ReadFile(siblingPath(u.opts.Executable, rejectedName))
	if err != nil {
		return rejectedBuild{}, false
	}
	var record rejectedBuild
	if json.Unmarshal(raw, &record) != nil || !isDigest(record.Sha256) {
		return rejectedBuild{}, false
	}
	return record, true
}

// rejectedStatus is the `failed` status for a rolled-back build.
func (u *Updater) rejectedStatus(record rejectedBuild) protocol.AgentUpdateStatus {
	message := fmt.Sprintf("%s It will not be installed again; publish a fixed build (it gets a new SHA-256), or delete %s on the host to retry this one.", record.Reason, siblingPath(u.opts.Executable, rejectedName))
	return status(protocol.AgentUpdateStateFailed, record.Sha256, message)
}

// reportRejectedLocked tells the panel about a rollback once. Caller holds u.mu.
func (u *Updater) reportRejectedLocked() {
	record, ok := u.rejected()
	if !ok || record.Reported {
		return
	}
	u.opts.Report(u.rejectedStatus(record))
	record.Reported = true
	if err := writeJSON(siblingPath(u.opts.Executable, rejectedName), record); err != nil {
		slog.Warn("could not mark the rollback as reported", "error", err)
	}
}

// writeJSON writes v to path atomically (temp file + rename in the same folder).
func writeJSON(path string, v any) error {
	raw, err := json.Marshal(v)
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), filepath.Base(path)+".tmp-*")
	if err != nil {
		return err
	}
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		_ = os.Remove(tmp.Name())
		return err
	}
	return nil
}

// copyFile copies src to dst with mode 0755 (the fallback when a hard link is not possible).
func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.OpenFile(dst, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	if err := out.Sync(); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
