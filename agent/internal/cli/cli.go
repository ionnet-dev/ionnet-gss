// Package cli implements the gss-agent subcommands: enrol, run, version.
package cli

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/version"
)

// Command is one subcommand.
type Command struct {
	Name    string
	Args    string // Shown in help, e.g. "--panel <URL> --token <TOKEN>".
	Summary string
	Run     func(ctx context.Context, args []string) error
}

// Commands lists every subcommand in help order. A new subcommand: a file here and one entry below.
// Exit codes: 0 success, 1 failure, 2 bad arguments (ErrUsage), 3 the panel doesn't know this host (panel.ErrRevoked:
// removed or wrong credential; a disabled host keeps retrying instead).
var Commands []Command

func init() {
	Commands = []Command{
		{Name: "enrol", Args: "--panel <URL> (--token <TOKEN> | --token-stdin | GSS_ENROL_TOKEN) [--insecure] [--force]", Summary: "Enrol this host with a panel using a one-time token", Run: Enrol},
		{Name: "run", Args: "[--config <PATH>]", Summary: "Connect to the panel and manage game servers (the systemd service)", Run: RunAgent},
		{Name: "version", Summary: "Print the agent version", Run: Version},
		{Name: "help", Args: "[command]", Summary: "Show this help, or a command's options", Run: Help},
	}
}

// ErrUsage is returned for bad arguments; main exits 2.
var ErrUsage = errors.New("usage")

// Usage prints the command table.
func Usage(w io.Writer) {
	fmt.Fprintf(w, "gss-agent %s, the Ionnet GSS host agent\n\nCommands:\n", version.Version)
	for _, c := range Commands {
		fmt.Fprintf(w, "  %-52s %s\n", c.Name+" "+c.Args, c.Summary)
	}
	fmt.Fprintln(w, "\nRun \"gss-agent help <command>\" for more information on a command.")
}

// Help implements `gss-agent help [command]`.
func Help(ctx context.Context, args []string) error {
	if len(args) == 0 {
		Usage(os.Stdout)
		return nil
	}
	cmd, ok := Find(args[0])
	if !ok || cmd.Name == "help" {
		Usage(os.Stdout)
		return nil
	}
	return cmd.Run(ctx, []string{"-h"})
}

// commandUsage sets fs.Usage to the per-command form: description, Usage line, Options.
func commandUsage(fs *flag.FlagSet, cmd string) {
	fs.Usage = func() {
		c, _ := Find(cmd)
		out := fs.Output()
		fmt.Fprintf(out, "%s\n\nUsage: gss-agent %s %s\n\nOptions:\n", c.Summary, c.Name, c.Args)
		fs.PrintDefaults()
	}
}

// Find returns the command named name.
func Find(name string) (Command, bool) {
	for _, c := range Commands {
		if c.Name == name {
			return c, true
		}
	}
	return Command{}, false
}

// configFlag adds the shared --config flag (default: GSS_AGENT_CONFIG, else paths.ConfigFile).
func configFlag(fs *flag.FlagSet) *string {
	return fs.String("config", os.Getenv("GSS_AGENT_CONFIG"), "config file (default /etc/ionnet-gss/agent.json)")
}

// Version prints the version.
func Version(ctx context.Context, args []string) error {
	fmt.Println(version.Version)
	return nil
}
