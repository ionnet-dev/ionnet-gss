package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/agent"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/config"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/version"
)

// RunAgent implements `gss-agent run [--config <path>]`: load the config (config.ErrNotEnrolled → tell the operator
// to enrol), build agent.New, Run until SIGINT/SIGTERM (ctx). panel.ErrRevoked exits non-zero with its message so
// systemd's restart doesn't hammer the panel (the unit uses RestartPreventExitStatus).
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

	store := config.NewFileStore(*configPath)
	cfg, err := store.Load()
	if err != nil {
		return err
	}
	a, err := agent.New(cfg)
	if err != nil {
		return fmt.Errorf("start agent: %w", err)
	}
	slog.Info("gss-agent starting", "version", version.Version, "panel", cfg.PanelURL, "host", cfg.HostID)
	if err := a.Run(ctx); err != nil {
		return err
	}
	slog.Info("gss-agent stopped")
	return nil
}
