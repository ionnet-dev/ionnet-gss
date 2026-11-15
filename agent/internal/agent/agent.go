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
	"github.com/ionnet-dev/ionnet-gss/agent/internal/egress"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/files"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/hostfacts"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/servers"
)

// Agent is one running gss-agent.
type Agent struct {
	Config  config.Config
	Docker  docker.Client
	Facts   hostfacts.Collector
	Servers servers.Manager
	// Outbox carries server events to the panel and buffers state changes while it is away.
	Outbox *panel.Outbox
	// Transfers holds the open file transfers (M4, files.go); all are closed when a new panel connection starts.
	Transfers *files.Transfers
}

// New builds an agent from a loaded config (defaults applied). Servers live below Config.DataRoot.
func New(cfg config.Config) (*Agent, error) {
	cfg = cfg.WithDefaults()
	dockerClient, err := docker.New(cfg.DockerHost)
	if err != nil {
		return nil, err
	}
	outbox := panel.NewOutbox(panel.DefaultOutboxLimit, panel.DefaultOutboxBytes)
	layout := paths.Layout{Root: cfg.DataRoot}
	transfers := files.NewTransfers()
	firewall := egress.New(egress.Options{Docker: dockerClient, Image: cfg.HelperImage, Dir: layout.NetfilterDir(), Table: cfg.EgressTable})
	return &Agent{
		Config: cfg,
		Docker: dockerClient,
		Facts:  hostfacts.New(cfg.DataRoot, dockerClient, firewall.Facts),
		Servers: servers.New(servers.Options{
			Layout:    layout,
			Docker:    dockerClient,
			Sink:      panelSink{outbox: outbox},
			Egress:    firewall,
			Transfers: transfers,
		}),
		Outbox:    outbox,
		Transfers: transfers,
	}, nil
}

// Run restores the servers on this host, then connects and stays connected until ctx ends or the panel revokes
// the host. Servers keep running when it returns.
func (a *Agent) Run(ctx context.Context) error {
	go a.Outbox.Run(ctx)
	defer a.Servers.Close()
	if hostfacts.IsMemoryBacked(a.Config.DataRoot) {
		slog.Warn("the data root is on tmpfs or ramfs: game files count against each server's memory limit, so large installs get OOM-killed; use a disk-backed folder", "dataRoot", a.Config.DataRoot)
	}
	if err := a.Servers.Restore(ctx); err != nil {
		return fmt.Errorf("restore servers: %w", err)
	}
	session := &panel.Session{
		PanelURL:    a.Config.PanelURL,
		HostID:      a.Config.HostID,
		Credential:  a.Config.Credential,
		Insecure:    a.Config.Insecure,
		Hello:       a.hello,
		OnConnected: a.onConnected,
		Handlers:    a.handlers(),
		Outbox:      a.Outbox,
	}
	return session.Run(ctx)
}

// defaultHeartbeat is used when the panel does not name a usable interval.
const defaultHeartbeat = 15 * time.Second

// hello builds the hello request: fresh facts and every server's status (the inventory the panel reconciles).
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
		Servers:         a.Servers.Statuses(),
	}, nil
}

// onConnected starts the heartbeat loop (every hello.HeartbeatSec, until conn.Done()).
func (a *Agent) onConnected(ctx context.Context, conn panel.Conn, hello protocol.HelloResponse) {
	// Transfer ids belong to one connection: the panel failed every request of the previous one.
	a.Transfers.CloseAll()
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

// Operation timeouts for panel requests. They run detached from the connection, so a panel that drops mid-way
// doesn't leave a provision half done.
const (
	provisionTimeout = time.Duration(protocol.ProvisionTimeoutSec) * time.Second // includes an image pull
	restartTimeout   = 10 * time.Minute                                          // includes a graceful stop
	operationTimeout = 2 * time.Minute
	fileTimeout      = time.Duration(protocol.TransferIdleSec) * time.Second // one file request or chunk
)

// handlers maps panel → agent request types to their handlers. A new panel → agent request: schema in protocol/,
// `deno task protocol`, a method on Agent, one entry here.
func (a *Agent) handlers() panel.Handlers {
	handlers := panel.Handlers{
		Requests: map[string]panel.RequestHandler{
			protocol.MsgServerProvision: serve(provisionTimeout, func(ctx context.Context, req protocol.ProvisionRequest) (any, error) {
				return a.Servers.Provision(ctx, req)
			}),
			protocol.MsgServerStart: serve(provisionTimeout, func(ctx context.Context, req protocol.ServerRef) (any, error) {
				return a.Servers.Start(ctx, req.ServerID)
			}),
			protocol.MsgServerRestart: serve(restartTimeout, func(ctx context.Context, req protocol.ServerRef) (any, error) {
				return a.Servers.Restart(ctx, req.ServerID)
			}),
			protocol.MsgServerStop: serve(operationTimeout, func(ctx context.Context, req protocol.StopRequest) (any, error) {
				return a.Servers.Stop(ctx, req.ServerID, req.Kill)
			}),
			protocol.MsgServerDelete: serve(restartTimeout, func(ctx context.Context, req protocol.DeleteRequest) (any, error) {
				return protocol.Empty{}, a.Servers.Delete(ctx, req.ServerID, req.KeepData)
			}),
			protocol.MsgServerInput: serve(operationTimeout, func(ctx context.Context, req protocol.InputRequest) (any, error) {
				return protocol.Empty{}, a.Servers.Input(ctx, req.ServerID, req.Line)
			}),
			protocol.MsgServerBacklog: serve(operationTimeout, func(ctx context.Context, req protocol.BacklogRequest) (any, error) {
				return a.Servers.Backlog(ctx, req.ServerID, req.Limit, req.BeforeSeq)
			}),
			protocol.MsgServerUpdate: serve(provisionTimeout, func(ctx context.Context, req protocol.ServerRef) (any, error) {
				return a.Servers.Update(ctx, req.ServerID)
			}),
			// M4: backups (servers/backup.go); files and transfers in fileHandlers (files.go).
			protocol.MsgBackupCreate: serve(operationTimeout, func(ctx context.Context, req protocol.BackupRef) (any, error) {
				return a.Servers.CreateBackup(ctx, req)
			}),
			protocol.MsgBackupRestore: serve(operationTimeout, func(ctx context.Context, req protocol.BackupRef) (any, error) {
				return a.Servers.RestoreBackup(ctx, req)
			}),
			protocol.MsgBackupDelete: serve(operationTimeout, func(ctx context.Context, req protocol.BackupRef) (any, error) {
				return protocol.Empty{}, a.Servers.DeleteBackup(ctx, req)
			}),
		},
	}
	for msg, handler := range a.fileHandlers() {
		handlers.Requests[msg] = handler
	}
	return handlers
}

// serve decodes a request into T and runs fn with its own timeout, detached from the connection's context.
func serve[T any](timeout time.Duration, fn func(ctx context.Context, req T) (any, error)) panel.RequestHandler {
	return func(ctx context.Context, data json.RawMessage) (any, error) {
		var req T
		if len(data) == 0 {
			return nil, &protocol.RemoteError{Code: protocol.ErrorCodeBadRequest, Message: "The request has no data."}
		}
		if err := json.Unmarshal(data, &req); err != nil {
			return nil, &protocol.RemoteError{Code: protocol.ErrorCodeBadRequest, Message: fmt.Sprintf("The request data does not match the protocol: %v.", err)}
		}
		opCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), timeout)
		defer cancel()
		res, err := fn(opCtx, req)
		if err != nil {
			return nil, err
		}
		return res, nil
	}
}

// panelSink forwards server reports through the outbox. While the panel is away state changes, service statuses,
// backup results and player events are kept, console lines are buffered (dropped first; a restarted agent's catch-up arrives this way), and stats are
// dropped (the next sample replaces them), like backup progress.
type panelSink struct {
	outbox *panel.Outbox
}

func (p panelSink) Console(batch protocol.ConsoleBatch) {
	p.outbox.Emit(protocol.MsgServerConsole, batch, panel.DeliverBuffered)
}

func (p panelSink) State(change protocol.StateChange) {
	p.outbox.Emit(protocol.MsgServerState, change, panel.DeliverAlways)
}

func (p panelSink) Stats(batch protocol.StatsBatch) {
	p.outbox.Emit(protocol.MsgServerStats, batch, panel.DeliverOnline)
}

func (p panelSink) Player(event protocol.PlayerEvent) {
	p.outbox.Emit(protocol.MsgServerPlayer, event, panel.DeliverKept)
}

func (p panelSink) Services(change protocol.ServicesChange) {
	p.outbox.Emit(protocol.MsgServerServices, change, panel.DeliverAlways)
}

func (p panelSink) BackupProgress(progress protocol.BackupProgress) {
	p.outbox.Emit(protocol.MsgBackupProgress, progress, panel.DeliverOnline)
}

func (p panelSink) BackupFinished(finished protocol.BackupFinished) {
	p.outbox.Emit(protocol.MsgBackupFinished, finished, panel.DeliverAlways)
}
