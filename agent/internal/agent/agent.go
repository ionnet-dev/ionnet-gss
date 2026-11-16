// Package agent wires `gss-agent run`: the panel session, the heartbeat loop and the panel → agent request handlers.
package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"sync"
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
	"github.com/ionnet-dev/ionnet-gss/agent/internal/updater"
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
	// Executable is the running binary (symlinks resolved): what an update replaces and the restart execs.
	Executable string
	// Updater runs `agent.update` (M6, update.go).
	Updater *updater.Updater

	// ops tracks in-flight mutating requests, so an update restarts only when none runs.
	ops *operations
	// confirmAfter is how long a connection must last before an updated build counts as good (defaultConfirmAfter
	// when 0).
	confirmAfter time.Duration
	// mu guards stop and restarting: Run's cancel and whether an update ended it.
	mu         sync.Mutex
	stop       context.CancelFunc
	restarting bool
}

// New builds an agent from a loaded config (defaults applied) and the running binary (updater.ReadSelf). Servers
// live below Config.DataRoot.
func New(cfg config.Config, self updater.Self) (*Agent, error) {
	cfg = cfg.WithDefaults()
	dockerClient, err := docker.New(cfg.DockerHost)
	if err != nil {
		return nil, err
	}
	outbox := panel.NewOutbox(panel.DefaultOutboxLimit, panel.DefaultOutboxBytes)
	layout := paths.Layout{Root: cfg.DataRoot}
	transfers := files.NewTransfers()
	firewall := egress.New(egress.Options{Docker: dockerClient, Image: cfg.HelperImage, Dir: layout.NetfilterDir(), Table: cfg.EgressTable})
	a := &Agent{
		Config: cfg,
		Docker: dockerClient,
		Facts:  hostfacts.New(cfg.DataRoot, dockerClient, firewall.Facts, self.Build),
		Servers: servers.New(servers.Options{
			Layout:    layout,
			Docker:    dockerClient,
			Sink:      panelSink{outbox: outbox},
			Egress:    firewall,
			Transfers: transfers,
		}),
		Outbox:     outbox,
		Transfers:  transfers,
		Executable: self.Executable,
		ops:        newOperations(),
	}
	a.Updater = updater.New(updater.Options{
		PanelURL:   cfg.PanelURL,
		Insecure:   cfg.Insecure,
		HostID:     cfg.HostID,
		Credential: cfg.Credential,
		Executable: self.Executable,
		Build:      self.Build,
		Report:     a.reportUpdate,
		Hold:       a.holdForUpdate,
		Restart:    a.restartForUpdate,
	})
	return a, nil
}

// Run restores the servers on this host, then connects and stays connected until ctx ends or the panel revokes
// the host. Servers keep running when it returns. After an agent update replaced the binary it shuts down the same
// way and returns ErrRestart, unless parent ended meanwhile (systemctl stop wins over the restart).
func (a *Agent) Run(parent context.Context) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	a.mu.Lock()
	a.stop = cancel
	a.mu.Unlock()
	go a.Outbox.Run(ctx)
	defer a.Servers.Close()
	defer a.Updater.Close()
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
	return a.ended(parent, session.Run(ctx))
}

// ended turns the session's result into Run's: ErrRestart when an update stopped the agent and the caller's context
// is still live (a SIGTERM that arrived meanwhile means stop, not restart).
func (a *Agent) ended(parent context.Context, err error) error {
	a.mu.Lock()
	restarting := a.restarting
	a.mu.Unlock()
	if restarting && parent.Err() == nil {
		return ErrRestart
	}
	return err
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
	// An updated build that stays connected for confirmAfter ends its rollback window.
	go a.confirmWhenStable(ctx, conn)
	// A pending update's earlier events may predate this panel process: report where it stands.
	a.Updater.Resend()
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
			protocol.MsgServerProvision: serve(provisionTimeout, tracked(a.ops, "install", provisionID, func(ctx context.Context, req protocol.ProvisionRequest) (any, error) {
				return a.Servers.Provision(ctx, req)
			})),
			protocol.MsgServerStart: serve(provisionTimeout, tracked(a.ops, "start", refID, func(ctx context.Context, req protocol.ServerRef) (any, error) {
				return a.Servers.Start(ctx, req.ServerID)
			})),
			protocol.MsgServerRestart: serve(restartTimeout, tracked(a.ops, "restart", refID, func(ctx context.Context, req protocol.ServerRef) (any, error) {
				return a.Servers.Restart(ctx, req.ServerID)
			})),
			protocol.MsgServerStop: serve(operationTimeout, tracked(a.ops, "stop", stopID, func(ctx context.Context, req protocol.StopRequest) (any, error) {
				return a.Servers.Stop(ctx, req.ServerID, req.Kill)
			})),
			protocol.MsgServerDelete: serve(restartTimeout, tracked(a.ops, "deletion", deleteID, func(ctx context.Context, req protocol.DeleteRequest) (any, error) {
				return protocol.Empty{}, a.Servers.Delete(ctx, req.ServerID, req.KeepData)
			})),
			protocol.MsgServerInput: serve(operationTimeout, func(ctx context.Context, req protocol.InputRequest) (any, error) {
				return protocol.Empty{}, a.Servers.Input(ctx, req.ServerID, req.Line)
			}),
			protocol.MsgServerBacklog: serve(operationTimeout, func(ctx context.Context, req protocol.BacklogRequest) (any, error) {
				return a.Servers.Backlog(ctx, req.ServerID, req.Limit, req.BeforeSeq)
			}),
			protocol.MsgServerUpdate: serve(provisionTimeout, tracked(a.ops, "update", refID, func(ctx context.Context, req protocol.ServerRef) (any, error) {
				return a.Servers.Update(ctx, req.ServerID)
			})),
			// M4: backups (servers/backup.go); files and transfers in fileHandlers (files.go). The backup or restore
			// itself runs on after the request; holdForUpdate sees it in the server's status.
			protocol.MsgBackupCreate: serve(operationTimeout, tracked(a.ops, "backup", backupID, func(ctx context.Context, req protocol.BackupRef) (any, error) {
				return a.Servers.CreateBackup(ctx, req)
			})),
			protocol.MsgBackupRestore: serve(operationTimeout, tracked(a.ops, "restore", backupID, func(ctx context.Context, req protocol.BackupRef) (any, error) {
				return a.Servers.RestoreBackup(ctx, req)
			})),
			protocol.MsgBackupDelete: serve(operationTimeout, tracked(a.ops, "backup deletion", backupID, func(ctx context.Context, req protocol.BackupRef) (any, error) {
				return protocol.Empty{}, a.Servers.DeleteBackup(ctx, req)
			})),
			// M6: self-update (update.go, internal/updater); answers at once, progress follows as events.
			protocol.MsgAgentUpdate: serve(operationTimeout, func(ctx context.Context, req protocol.AgentUpdateRequest) (any, error) {
				return a.Updater.Request(req.Sha256, req.Force)
			}),
		},
	}
	for msg, handler := range a.fileHandlers() {
		handlers.Requests[msg] = handler
	}
	return handlers
}

// Server ids of the tracked requests.
func provisionID(req protocol.ProvisionRequest) string { return req.Spec.ServerID }
func refID(req protocol.ServerRef) string              { return req.ServerID }
func stopID(req protocol.StopRequest) string           { return req.ServerID }
func deleteID(req protocol.DeleteRequest) string       { return req.ServerID }
func backupID(req protocol.BackupRef) string           { return req.ServerID }

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
