package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrRestart is returned by Agent.Run after an agent update replaced the binary and the agent shut down cleanly:
// the caller re-execs the executable (cli.RunAgent).
var ErrRestart = errors.New("the gss-agent binary was updated; restart into it")

// defaultConfirmAfter is how long an updated build must stay connected before its update is confirmed (the backup
// of the previous binary and the marker go). A build that crashes sooner keeps counting starts and is rolled back.
const defaultConfirmAfter = 60 * time.Second

// confirmWhenStable confirms a pending update once conn has stayed up for confirmAfter; a disconnect first cancels
// it (the next connection tries again; only process starts count against the marker).
func (a *Agent) confirmWhenStable(ctx context.Context, conn panel.Conn) {
	wait := a.confirmAfter
	if wait <= 0 {
		wait = defaultConfirmAfter
	}
	timer := time.NewTimer(wait)
	defer timer.Stop()
	select {
	case <-ctx.Done():
	case <-conn.Done():
	case <-timer.C:
		a.Updater.Confirm()
	}
}

// restartFlushTimeout bounds how long the `restarting` event may take to reach the panel before the agent closes
// the connection anyway (it reconnects with its new agentBuild either way).
const restartFlushTimeout = 5 * time.Second

// operations tracks in-flight mutating panel requests (installs, starts, backups, transfer opens…), so an agent
// update restarts only when none runs. Safe for concurrent use.
//
// The update checks the rest of the agent under hold (new operations wait, briefly), then freezes (new operations
// are refused) or releases. So nothing can start between "the agent is idle" and the restart.
type operations struct {
	mu      sync.Mutex
	cond    *sync.Cond
	next    uint64
	running map[uint64]string
	holding bool // holdForUpdate is checking servers and transfers: begin waits
	frozen  bool // committed to restarting: begin refuses
}

func newOperations() *operations {
	o := &operations{running: map[uint64]string{}}
	o.cond = sync.NewCond(&o.mu)
	return o
}

// errRestarting answers requests that arrive after the agent committed to restarting.
var errRestarting = &protocol.RemoteError{Code: protocol.ErrorCodeConflict, Message: "The agent is restarting into a new build; try again once it reconnects (a few seconds)."}

// begin registers an operation labelled label; call end when it finishes. It waits out a hold and is refused once
// frozen.
func (o *operations) begin(label string) (end func(), err error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	for o.holding {
		o.cond.Wait()
	}
	if o.frozen {
		return nil, errRestarting
	}
	o.next++
	id := o.next
	o.running[id] = label
	return func() {
		o.mu.Lock()
		delete(o.running, id)
		o.mu.Unlock()
	}, nil
}

// hold makes new operations wait and returns nil when none runs; otherwise it returns what runs and holds nothing.
// A successful hold ends with freeze or release.
func (o *operations) hold() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	if len(o.running) > 0 {
		labels := make([]string, 0, len(o.running))
		for _, label := range o.running {
			labels = append(labels, label)
		}
		return labels
	}
	o.holding = true
	return nil
}

// freeze turns a hold into refusing new operations (the agent restarts).
func (o *operations) freeze() {
	o.mu.Lock()
	o.holding = false
	o.frozen = true
	o.mu.Unlock()
	o.cond.Broadcast()
}

// release ends a hold or a freeze: operations are accepted again.
func (o *operations) release() {
	o.mu.Lock()
	o.holding = false
	o.frozen = false
	o.mu.Unlock()
	o.cond.Broadcast()
}

// tracked runs fn as an operation labelled `<what> of server <id>` (id from serverID), refused while frozen.
func tracked[T any](ops *operations, what string, serverID func(T) string, fn func(ctx context.Context, req T) (any, error)) func(ctx context.Context, req T) (any, error) {
	return func(ctx context.Context, req T) (any, error) {
		end, err := ops.begin(fmt.Sprintf("%s of server %s", what, serverID(req)))
		if err != nil {
			return nil, err
		}
		defer end()
		return fn(ctx, req)
	}
}

// busyStates maps transitional server states to what an update waits for.
var busyStates = map[protocol.ServerState]string{
	protocol.ServerStateCreating:   "creation",
	protocol.ServerStateInstalling: "install",
	protocol.ServerStateStarting:   "start",
	protocol.ServerStateStopping:   "stop",
	protocol.ServerStateDeleting:   "deletion",
}

// holdForUpdate is the updater's HoldFunc: what runs (servers in a transitional state or with a backup/restore
// running, open file transfers, in-flight mutating requests), or, when nothing does, a frozen operations tracker.
func (a *Agent) holdForUpdate() ([]string, func()) {
	running := a.ops.hold()
	busy := map[string]bool{}
	for _, status := range a.Servers.Statuses() {
		if what, ok := busyStates[status.State]; ok {
			busy[fmt.Sprintf("%s of server %s", what, status.ServerID)] = true
		}
		if op := status.Operation; op != nil {
			what := "backup"
			if op.Operation == protocol.BackupOperationRestore {
				what = "restore"
			}
			busy[fmt.Sprintf("%s of server %s", what, status.ServerID)] = true
		}
	}
	for serverID, count := range a.Transfers.OpenByServer() {
		if count == 1 {
			busy[fmt.Sprintf("file transfer of server %s", serverID)] = true
		} else {
			busy[fmt.Sprintf("%d file transfers of server %s", count, serverID)] = true
		}
	}
	for _, label := range running {
		busy[label] = true
	}
	if len(busy) == 0 {
		a.ops.freeze()
		return nil, a.ops.release
	}
	if len(running) == 0 {
		a.ops.release() // the hold succeeded, but servers or transfers are still busy
	}
	list := make([]string, 0, len(busy))
	for label := range busy {
		list = append(list, label)
	}
	return labels(list), nil
}

// labels sorts a busy list, so an unchanged list compares equal between polls.
func labels(list []string) []string {
	slices.Sort(list)
	return list
}

// restartForUpdate is the updater's Restart: let the `restarting` event reach the panel, then end Run with
// ErrRestart (Run's normal shutdown closes the connection and the servers' watchers).
func (a *Agent) restartForUpdate() {
	ctx, cancel := context.WithTimeout(context.Background(), restartFlushTimeout)
	defer cancel()
	if err := a.Outbox.Flush(ctx); err != nil {
		slog.Warn("the panel did not receive the restarting event in time; restarting anyway", "error", err)
	}
	a.mu.Lock()
	a.restarting = true
	stop := a.stop
	a.mu.Unlock()
	if stop != nil {
		stop()
	}
}

// reportUpdate sends an `agent.updateStatus` event; never dropped while the panel is away.
func (a *Agent) reportUpdate(status protocol.AgentUpdateStatus) {
	a.Outbox.Emit(protocol.MsgAgentUpdateStatus, status, panel.DeliverAlways)
}
