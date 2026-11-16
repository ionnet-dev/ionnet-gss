package cli

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/config"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/hostfacts"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/updater"
)

// EnrolTokenEnv is the environment variable `gss-agent enrol` reads the token from when neither --token nor
// --token-stdin is given (keeps it out of the process list and shell history).
const EnrolTokenEnv = "GSS_ENROL_TOKEN"

// Enrol implements `gss-agent enrol --panel <url> (--token <token> | --token-stdin | $GSS_ENROL_TOKEN) [--insecure]
// [--config <path>] [--force]`: collect facts, trade the token for a host id and credential (panel.Enrol), save the
// config file. Refuses to overwrite an existing config without --force, and plain http:// to a non-loopback panel
// without --insecure (remembered in the config for `run`). Prints the host name and the next step.
func Enrol(ctx context.Context, args []string) error {
	fs := flag.NewFlagSet("enrol", flag.ContinueOnError)
	panelURL := fs.String("panel", "", "panel URL, e.g. https://gss.ionnet.dev")
	tokenFlag := fs.String("token", "", "one-time enrol token (gss_enrol_…) from the panel's Hosts page (visible in the process list; prefer --token-stdin or "+EnrolTokenEnv+")")
	tokenStdin := fs.Bool("token-stdin", false, "read the enrol token from the first line of stdin")
	insecure := fs.Bool("insecure", false, "allow a plain http:// panel URL on another machine (the token and credential travel unencrypted)")
	configPath := configFlag(fs)
	force := fs.Bool("force", false, "replace an existing enrolment")
	commandUsage(fs, "enrol")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return ErrUsage
	}
	if *panelURL == "" {
		fs.Usage()
		return ErrUsage
	}
	token, err := enrolToken(*tokenFlag, *tokenStdin, os.Stdin)
	if err != nil {
		return err
	}
	panelBase := strings.TrimRight(*panelURL, "/")
	// Check the URL before the token is spent or facts are collected.
	if _, err := panel.AgentURL(panelBase, *insecure); err != nil {
		return err
	}

	store := config.NewFileStore(*configPath)
	if existing, err := store.Load(); err == nil {
		if !*force {
			return fmt.Errorf("this host is already enrolled (host %s, panel %s, config %s): pass --force to replace the enrolment", existing.HostID, existing.PanelURL, store.Path())
		}
	} else if !errors.Is(err, config.ErrNotEnrolled) && !*force {
		return err
	}
	// Fail before the one-time token is spent when the config cannot be written afterwards.
	if err := store.CheckWritable(); err != nil {
		return err
	}

	defaults := config.Config{}.WithDefaults()
	dockerClient, err := docker.New(defaults.DockerHost)
	if err != nil {
		return err
	}
	self, _ := updater.ReadSelf() // no build fact when it can't be read
	facts, err := hostfacts.New(defaults.DataRoot, dockerClient, nil, self.Build).Collect(ctx)
	if err != nil {
		return fmt.Errorf("collect host facts: %w", err)
	}

	res, err := panel.Enrol(ctx, panelBase, token, *insecure, facts)
	if err != nil {
		return err
	}
	cfg := config.Config{PanelURL: panelBase, HostID: res.HostID, Credential: res.Credential, Insecure: *insecure}
	if err := store.Save(cfg); err != nil {
		return fmt.Errorf("enrolled as %q but could not save the credential: %w; create a new enrol token and retry", res.HostName, err)
	}
	fmt.Printf("Enrolled as %q (host %s). Config written to %s.\n", res.HostName, res.HostID, store.Path())
	fmt.Println("Next: start the agent with `systemctl enable --now gss-agent` (or run `gss-agent run`).")
	return nil
}

// enrolToken picks the token from exactly one source: --token, --token-stdin, or the GSS_ENROL_TOKEN variable.
func enrolToken(flagValue string, fromStdin bool, stdin io.Reader) (string, error) {
	envValue := strings.TrimSpace(os.Getenv(EnrolTokenEnv))
	switch {
	case flagValue != "" && fromStdin:
		return "", errors.New("pass the enrol token with either --token or --token-stdin, not both")
	case fromStdin:
		line, err := bufio.NewReader(stdin).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return "", fmt.Errorf("read the enrol token from stdin: %w", err)
		}
		token := strings.TrimSpace(line)
		if token == "" {
			return "", errors.New("--token-stdin: stdin was empty; pipe the token in, e.g. `echo gss_enrol_… | gss-agent enrol --token-stdin …`")
		}
		return token, nil
	case flagValue != "":
		return strings.TrimSpace(flagValue), nil
	case envValue != "":
		return envValue, nil
	}
	return "", fmt.Errorf("no enrol token: pass --token-stdin (pipe it in), set %s, or pass --token; create one on the panel's Hosts page", EnrolTokenEnv)
}
