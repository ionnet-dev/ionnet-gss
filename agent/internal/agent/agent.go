// Package agent wires `gss-agent run`: the panel session, the heartbeat loop and the panel → agent request handlers.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/config"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/hostfacts"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/servers"
)

// Agent is one running gss-agent.
type Agent struct {
	Config  config.Config
	Docker  docker.Client
	Facts   hostfacts.Collector
	Servers servers.Manager // nil in M1.
}

// New builds an agent from a loaded config (defaults applied).
func New(cfg config.Config) (*Agent, error) {
	cfg = cfg.WithDefaults()
	dockerClient, err := docker.New(cfg.DockerHost)
	if err != nil {
		return nil, err
	}
	return &Agent{
		Config: cfg,
		Docker: dockerClient,
		Facts:  hostfacts.New(cfg.DataRoot, dockerClient),
	}, nil
}

// Run connects and stays connected until ctx ends or the panel revokes the host.
func (a *Agent) Run(ctx context.Context) error {
	session := &panel.Session{
		PanelURL:    a.Config.PanelURL,
		HostID:      a.Config.HostID,
		Credential:  a.Config.Credential,
		Insecure:    a.Config.Insecure,
		Hello:       a.hello,
		OnConnected: a.onConnected,
		Handlers:    a.handlers(),
	}
	return session.Run(ctx)
}

// defaultHeartbeat is used when the panel does not name a usable interval.
const defaultHeartbeat = 15 * time.Second

// hello builds the hello request: fresh facts and (M2) every server's status.
func (a *Agent) hello(ctx context.Context) (protocol.HelloRequest, error) {
	facts, err := a.Facts.Collect(ctx)
	if err != nil {
		return protocol.HelloRequest{}, fmt.Errorf("collect host facts: %w", err)
	}
	return protocol.HelloRequest{
		HostID:          a.Config.HostID,
		Credential:      a.Config.Credential,
		ProtocolVersion: protocol.ProtocolVersion,
		Facts:           facts,
		Servers:         []protocol.ServerStatus{},
	}, nil
}

// onConnected starts the heartbeat loop (every hello.HeartbeatSec, until conn.Done()).
func (a *Agent) onConnected(ctx context.Context, conn panel.Conn, hello protocol.HelloResponse) {
	interval := time.Duration(hello.HeartbeatSec) * time.Second
	if interval <= 0 {
		interval = defaultHeartbeat
	}
	go a.heartbeatLoop(ctx, conn, interval)
}

// heartbeatLoop sends fresh facts every interval until the connection or ctx ends. A failed send ends the loop:
// the connection is gone and the session reconnects.
func (a *Agent) heartbeatLoop(ctx context.Context, conn panel.Conn, interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-conn.Done():
			return
		case <-ticker.C:
		}
		facts, err := a.Facts.Collect(ctx)
		if err != nil {
			slog.Warn("could not collect host facts for the heartbeat", "error", err)
			continue
		}
		sendCtx, cancel := context.WithTimeout(ctx, panel.RequestTimeout)
		err = conn.Notify(sendCtx, protocol.MsgHeartbeat, protocol.Heartbeat{At: time.Now().UTC(), Facts: facts})
		cancel()
		if err != nil {
			slog.Warn("could not send the heartbeat", "error", err)
			return
		}
	}
}

// handlers maps panel → agent request types to their handlers. A new panel → agent request: schema in protocol/,
// `deno task protocol`, a method on Agent, one entry here.
func (a *Agent) handlers() panel.Handlers {
	return panel.Handlers{
		Requests: map[string]panel.RequestHandler{
			// M2: protocol.MsgServerProvision, MsgServerStart, MsgServerStop, MsgServerDelete, MsgServerInput,
			// MsgServerBacklog → a.Servers.
			protocol.MsgServerProvision: unsupported,
			protocol.MsgServerStart:     unsupported,
			protocol.MsgServerRestart:   unsupported,
			protocol.MsgServerStop:      unsupported,
			protocol.MsgServerDelete:    unsupported,
			protocol.MsgServerInput:     unsupported,
			protocol.MsgServerBacklog:   unsupported,
		},
	}
}

// unsupported answers requests this agent version cannot handle yet.
func unsupported(ctx context.Context, data json.RawMessage) (any, error) {
	return nil, &protocol.RemoteError{Code: protocol.ErrorCodeUnsupported, Message: "this gss-agent version does not run game servers yet; update the agent"}
}
