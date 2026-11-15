// Command gss-init is PID 1 in every Ionnet GSS game container (M2). It ships in the ionnet-gss-base image.
package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/version"
)

func main() {
	if len(os.Args) > 1 && (os.Args[1] == "version" || os.Args[1] == "--version") {
		fmt.Println(version.Version)
		return
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	supervisor := &initd.Supervisor{Options: initd.DefaultOptions()}
	if err := supervisor.Run(ctx); err != nil {
		fmt.Fprintf(os.Stderr, "gss-init: %v\n", err)
		os.Exit(1)
	}
}
