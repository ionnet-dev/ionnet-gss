package cli

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/updater"
)

// TestStartupGuardBeforeConfig: a start counts against a pending update even when the config can't be loaded, so a
// build that fails there is rolled back too. Uses the test binary as the "updated" build.
func TestStartupGuardBeforeConfig(t *testing.T) {
	self, err := updater.ReadSelf()
	if err != nil || self.Build == nil {
		t.Skipf("the test binary can't be read: %v", err)
	}
	marker := filepath.Join(filepath.Dir(self.Executable), ".gss-agent-update")
	raw, _ := json.Marshal(map[string]any{"sha256": *self.Build, "attempts": 0})
	if err := os.WriteFile(marker, raw, 0o644); err != nil {
		t.Skipf("can't write next to the test binary: %v", err)
	}
	t.Cleanup(func() { _ = os.Remove(marker) })

	if err := RunAgent(context.Background(), []string{"--config", filepath.Join(t.TempDir(), "missing.json")}); err == nil {
		t.Fatal("RunAgent started without a config")
	}
	var swap struct {
		Attempts int `json:"attempts"`
	}
	if raw, err := os.ReadFile(marker); err != nil || json.Unmarshal(raw, &swap) != nil || swap.Attempts != 1 {
		t.Fatalf("the start was not counted before the config load: %+v, %v", swap, err)
	}
}
