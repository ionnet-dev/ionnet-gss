package initd

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// TestInstallTimeout runs a Supervisor (not as PID 1) whose only install step hangs: the install must end
// install_failed with the timeout as the reason instead of hanging forever.
func TestInstallTimeout(t *testing.T) {
	root := t.TempDir()
	files := filepath.Join(root, "files")
	if err := os.MkdirAll(filepath.Join(files, "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(files, "hooks", "hang.sh"), []byte("#!/bin/sh\nsleep 30\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	spec := protocol.InitSpec{
		ServerID:          "00000000-0000-4000-8000-000000000001",
		Install:           []protocol.InstallStep{{Hook: "hooks/hang.sh"}},
		Configs:           []protocol.ConfigMapping{},
		Start:             "true",
		Console:           protocol.ConsoleSpec{Input: protocol.ConsoleInputStdin},
		Env:               map[string]string{},
		InstallTimeoutSec: 1,
	}
	raw, err := json.Marshal(spec)
	if err != nil {
		t.Fatal(err)
	}
	specPath := filepath.Join(root, "spec.json")
	if err := os.WriteFile(specPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}

	s := &Supervisor{Options: Options{
		SpecPath:   specPath,
		FilesDir:   files,
		SocketPath: filepath.Join(root, "run", "init.sock"),
		DataPath:   filepath.Join(root, "data"),
		GameUID:    -1,
		Backlog:    100,
	}}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- s.Run(ctx) }()
	defer func() {
		cancel()
		<-done
	}()

	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
		s.mu.Lock()
		state, reason := s.state, deref(s.reason)
		s.mu.Unlock()
		if state != protocol.ServerStateInstallFailed {
			continue
		}
		if !strings.Contains(reason, "took longer than 1s") {
			t.Fatalf("install_failed with reason %q, want the timeout", reason)
		}
		info, err := os.Stat(filepath.Join(root, "run"))
		if err != nil || info.Mode().Perm() != 0o700 {
			t.Fatalf("run folder mode %v (%v), want 0700", info.Mode().Perm(), err)
		}
		return
	}
	t.Fatal("the hanging install did not time out")
}
