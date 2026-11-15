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

// TestUpdate installs a server whose install has a hook step, then sends `update`: only the update hook may run
// (there are no steamcmd steps), the state goes installing → stopped, and update is refused while installing and
// for a definition with nothing to update.
func TestUpdate(t *testing.T) {
	root := t.TempDir()
	files := filepath.Join(root, "files")
	data := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(files, "hooks"), 0o755); err != nil {
		t.Fatal(err)
	}
	hooks := map[string]string{
		"install.sh": "#!/bin/sh\necho install >> runs.log\nsleep 0.3\n",
		"update.sh":  "#!/bin/sh\necho update >> runs.log\n",
	}
	for name, script := range hooks {
		if err := os.WriteFile(filepath.Join(files, "hooks", name), []byte(script), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	spec := protocol.InitSpec{
		ServerID: "00000000-0000-4000-8000-000000000002",
		Install:  []protocol.InstallStep{{Hook: "hooks/install.sh"}},
		Hooks:    protocol.HookDecl{Update: "hooks/update.sh"},
		Configs:  []protocol.ConfigMapping{},
		Start:    "true",
		Console:  protocol.ConsoleSpec{Input: protocol.ConsoleInputStdin},
		Env:      map[string]string{},
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
		DataPath:   data,
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

	request := func(kind string) (protocol.InitStatus, *opError) {
		result, opErr := s.dispatch(protocol.Envelope{Kind: protocol.MessageKindRequest, ID: "t", Type: kind})
		if opErr != nil {
			return protocol.InitStatus{}, opErr
		}
		return result.(protocol.InitStatus), nil
	}
	waitFor := func(state protocol.ServerState) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			s.mu.Lock()
			current, reason := s.state, deref(s.reason)
			s.mu.Unlock()
			if current == state {
				return
			}
			if current == protocol.ServerStateInstallFailed {
				t.Fatalf("install_failed: %s", reason)
			}
			time.Sleep(50 * time.Millisecond)
		}
		t.Fatalf("state did not reach %s", state)
	}

	// The boot install is running: update must wait for it.
	time.Sleep(100 * time.Millisecond)
	if _, opErr := request(protocol.InitMsgUpdate); opErr == nil || opErr.code != protocol.ErrorCodeConflict {
		t.Fatalf("update during the install answered %v, want a conflict", opErr)
	}
	waitFor(protocol.ServerStateStopped)

	status, opErr := request(protocol.InitMsgUpdate)
	if opErr != nil {
		t.Fatalf("update: %v", opErr.message)
	}
	if status.State != protocol.ServerStateInstalling || status.InstallProgress == nil || status.InstallProgress.Total != 1 || status.InstallProgress.Name != "hook" {
		t.Fatalf("update answered %+v (progress %+v)", status, status.InstallProgress)
	}
	waitFor(protocol.ServerStateStopped)
	log, err := os.ReadFile(filepath.Join(data, "runs.log"))
	if err != nil || string(log) != "install\nupdate\n" {
		t.Fatalf("runs.log = %q (%v), want install then update", log, err)
	}

	// Nothing to update once the hook is gone.
	s.mu.Lock()
	s.spec.Hooks.Update = ""
	s.mu.Unlock()
	if _, opErr := request(protocol.InitMsgUpdate); opErr == nil || opErr.code != protocol.ErrorCodeBadRequest || !strings.Contains(opErr.message, "nothing to update") {
		t.Fatalf("update without steps answered %v, want bad_request", opErr)
	}
}
