package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/agent"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/config"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/updater"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/version"
)

// RunAgent implements `gss-agent run [--config <path>]`: load the config (config.ErrNotEnrolled → tell the operator
// to enrol), build agent.New, Run until SIGINT/SIGTERM (ctx). panel.ErrRevoked exits non-zero with its message so
// systemd's restart doesn't hammer the panel (the unit uses RestartPreventExitStatus). agent.ErrRestart (an
// update replaced the binary) re-execs it in place: same PID, so systemd and a shell see the same process; when that
// fails the previous binary is restored and the error exits non-zero. updater.Startup runs first, before the config
// is even loaded: it rolls back a new build that keeps failing to reach the panel.
func RunAgent(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	configPath := configFlag(fs)
	commandUsage(fs, "run")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return ErrUsage
	}

	// Crash-loop guard of an agent update, before anything a bad build could fail on (the config load included): a new
	// build that keeps failing before it stays connected to the panel is rolled back.
	self, err := updater.ReadSelf()
	if err != nil {
		slog.Warn("could not find the gss-agent binary: the agent cannot report its build or update itself", "error", err)
	}
	if updater.Startup(self) {
		if err := reexec(self.Executable); err != nil {
			return fmt.Errorf("restart into the restored previous binary %s: %w; start gss-agent again (systemd does it on its own)", self.Executable, err)
		}
	}

	store := config.NewFileStore(*configPath)
	cfg, err := store.Load()
	if err != nil {
		return err
	}
	a, err := agent.New(cfg, self)
	if err != nil {
		return fmt.Errorf("start agent: %w", err)
	}
	slog.Info("gss-agent starting", "version", version.Version, "panel", cfg.PanelURL, "host", cfg.HostID)
	if err := a.Run(ctx); err != nil {
		if errors.Is(err, agent.ErrRestart) {
			slog.Info("gss-agent restarting into the updated binary", "path", a.Executable)
			if err := reexec(a.Executable); err != nil {
				if restoreErr := updater.Restore(a.Executable); restoreErr != nil {
					return fmt.Errorf("restart into the updated binary %s: %w; restoring the previous binary failed too (%v): re-run the install command on the host", a.Executable, err, restoreErr)
				}
				return fmt.Errorf("restart into the updated binary %s: %w; the previous binary was restored, start gss-agent again (systemd does it on its own)", a.Executable, err)
			}
		}
		return err
	}
	slog.Info("gss-agent stopped")
	return nil
}
