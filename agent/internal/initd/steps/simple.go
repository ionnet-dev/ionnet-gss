package steps

import (
	"context"
	"errors"
	"fmt"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// writeStep writes a file below /data (content is already rendered by the panel).
type writeStep struct{}

func (writeStep) Name() string { return "write" }

func (writeStep) Matches(step protocol.InstallStep) bool { return step.Write != nil }

func (writeStep) Describe(step protocol.InstallStep) string { return step.Write.File }

func (writeStep) Run(ctx context.Context, step protocol.InstallStep, env Env) error {
	name, err := datafs.Rel(step.Write.File)
	if err != nil {
		return err
	}
	if err := datafs.WriteFile(env.Data, name, []byte(step.Write.Content), 0o644, env.UID); err != nil {
		return fmt.Errorf("write %s: %w", name, err)
	}
	fmt.Fprintf(env.Output, "Wrote %s (%d bytes).\n", name, len(step.Write.Content))
	return nil
}

// hookStep runs a hook script from the definition files as the game user.
type hookStep struct{}

func (hookStep) Name() string { return "hook" }

func (hookStep) Matches(step protocol.InstallStep) bool { return step.Hook != "" }

func (hookStep) Describe(step protocol.InstallStep) string { return step.Hook }

func (hookStep) Run(ctx context.Context, step protocol.InstallStep, env Env) error {
	return RunHook(ctx, step.Hook, env)
}

// steamcmdStep is part of the schema already; the steamcmd runner lands in M3.
type steamcmdStep struct{}

func (steamcmdStep) Name() string { return "steamcmd" }

func (steamcmdStep) Matches(step protocol.InstallStep) bool { return step.Steamcmd != nil }

func (steamcmdStep) Describe(step protocol.InstallStep) string {
	return fmt.Sprintf("app %d", step.Steamcmd.App)
}

func (steamcmdStep) Run(ctx context.Context, step protocol.InstallStep, env Env) error {
	return ErrSteamcmdUnsupported
}

// ErrSteamcmdUnsupported is the steamcmd step's error until M3.
var ErrSteamcmdUnsupported = errors.New("steamcmd install steps are not supported until M3; use a download or hook step for now")
