// Command gss-agent is the Ionnet GSS host agent: it dials out to the panel and drives Docker.
package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/cli"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
)

func main() {
	if len(os.Args) < 2 {
		cli.Usage(os.Stderr)
		os.Exit(2)
	}
	name := os.Args[1]
	if name == "-h" || name == "--help" {
		name = "help"
	}
	cmd, ok := cli.Find(name)
	if !ok {
		fmt.Fprintf(os.Stderr, "Command not found: %s\n\n", name)
		cli.Usage(os.Stderr)
		os.Exit(2)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if err := cmd.Run(ctx, os.Args[2:]); err != nil {
		if errors.Is(err, cli.ErrUsage) {
			os.Exit(2)
		}
		fmt.Fprintf(os.Stderr, "gss-agent %s: %v\n", cmd.Name, err)
		if errors.Is(err, panel.ErrRevoked) {
			os.Exit(3) // systemd: RestartPreventExitStatus=3
		}
		os.Exit(1)
	}
}
