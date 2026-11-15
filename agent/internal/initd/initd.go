// Package initd is gss-init (M2): PID 1 in every game container. It reaps zombies, reads the spec, runs install
// steps and config appliers, runs the game on a pty as GAME_UID, keeps a console ring buffer, and serves the
// supervisor protocol on INIT_SOCKET_PATH. It keeps running and logging while the agent restarts.
package initd

import (
	"context"
	"errors"
	"fmt"
	"log"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/configs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/steps"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Options configure a Supervisor; the defaults are the protocol constants.
type Options struct {
	SpecPath   string // protocol.InitSpecPath
	FilesDir   string // protocol.InitFilesDir
	SocketPath string // protocol.InitSocketPath
	DataPath   string // protocol.InitDataPath
	GameUID    int    // protocol.GameUID; -1 = run as gss-init's own user (local development)
	Backlog    int    // protocol.InitBacklogLines
	// EchoConsole copies every console line to stdout, so `docker logs` shows the game.
	EchoConsole bool
}

// DefaultOptions uses the paths every game container mounts.
func DefaultOptions() Options {
	return Options{
		SpecPath:    protocol.InitSpecPath,
		FilesDir:    protocol.InitFilesDir,
		SocketPath:  protocol.InitSocketPath,
		DataPath:    protocol.InitDataPath,
		GameUID:     protocol.GameUID,
		Backlog:     protocol.InitBacklogLines,
		EchoConsole: true,
	}
}

// Timing of the lifecycle.
const (
	AUTO_RESTART_DELAY = 5 * time.Second
	POST_STOP_TIMEOUT  = 2 * time.Minute
	MAX_INPUT_BYTES    = 4096
)

// Supervisor is the gss-init process state. Everything lives only as long as the container; what must survive a
// container restart (the install result) is the marker file on the data volume.
type Supervisor struct {
	Options Options
	// Spec is the last spec that loaded successfully.
	Spec protocol.InitSpec

	logger   *log.Logger
	data     *os.Root
	reaper   *reaper
	console  *ringConsole
	hub      *hub
	launcher Launcher
	rcon     RconClient

	mu         sync.Mutex
	spec       *compiledSpec // nil until a spec loaded
	specErr    error         // why the spec file could not be loaded; state is install_failed while set
	marker     *installMarker
	state      protocol.ServerState
	since      time.Time
	exitCode   *int64
	reason     *string
	progress   *protocol.InstallProgress
	installed  bool
	install    *installRun
	run        *gameRun
	restarts   []time.Time // auto-restarts, pruned to the window
	restartJob *time.Timer
	shutdown   bool
}

// installRun is the install (or update) in progress.
type installRun struct {
	update   bool                   // an `update` request: only the steamcmd steps and the update hook
	steps    []protocol.InstallStep // what this run executes
	cancel   context.CancelFunc
	done     chan struct{}
	byStop   bool // cancelled by a stop request (not by shutdown)
	timeout  time.Duration
	previous *time.Time
}

// gameRun is one start: from `starting` until the post-stop hook finished.
type gameRun struct {
	spec          *compiledSpec
	ctx           context.Context
	cancel        context.CancelFunc
	game          Game // nil while the pre-start hook runs
	stopRequested bool
	stopReason    string // why the agent stopped it (the reason of the final `stopped`); "" = an ordinary stop
	stopTimer     *time.Timer
	ready         atomic.Bool
	oomBefore     int64
	done          chan struct{}
}

// opError is a request failure with its protocol error code.
type opError struct {
	code    protocol.ErrorCode
	message string
}

func (e *opError) Error() string { return e.message }

func conflict(format string, args ...any) *opError {
	return &opError{code: protocol.ErrorCodeConflict, message: fmt.Sprintf(format, args...)}
}

// Run loads the spec, opens the socket and serves until ctx ends (SIGTERM from `docker stop`: stop the game
// gracefully first).
func (s *Supervisor) Run(ctx context.Context) error {
	s.logger = log.New(os.Stderr, "gss-init: ", log.LstdFlags)
	if s.Options.Backlog <= 0 {
		s.Options.Backlog = protocol.InitBacklogLines
	}
	if err := os.MkdirAll(s.Options.DataPath, 0o755); err != nil {
		return fmt.Errorf("create the data folder %s: %w", s.Options.DataPath, err)
	}
	data, err := os.OpenRoot(s.Options.DataPath)
	if err != nil {
		return fmt.Errorf("open the data folder %s: %w", s.Options.DataPath, err)
	}
	defer data.Close()
	s.data = data
	s.reaper = processReaper()
	s.hub = newHub(s.logf)
	s.console = newConsole(s.Options.Backlog, s.onConsoleLine)
	s.launcher = &ptyLauncher{reaper: s.reaper, dataPath: s.Options.DataPath, uid: s.Options.GameUID}
	s.rcon = unsupportedRcon{}

	s.mu.Lock()
	s.state = protocol.ServerStateStopped
	s.since = time.Now().UTC()
	if spec, err := loadSpec(s.Options.SpecPath); err != nil {
		s.specErr = err
	} else {
		s.spec = spec
		s.Spec = spec.InitSpec
	}
	if m, err := readMarker(data); err != nil {
		s.logf("%v; treating the server as not installed", err)
	} else {
		s.marker = m
	}
	s.mu.Unlock()

	// The agent's ids from the spec; absent (an older spec, or none loaded) = the run folder's owner, which is the
	// agent that created it.
	owner := socketOwner{uid: -1, gid: -1}
	if s.spec != nil && s.spec.AgentUID > 0 {
		owner.uid = int(s.spec.AgentUID)
	}
	if s.spec != nil && s.spec.AgentGID > 0 {
		owner.gid = int(s.spec.AgentGID)
	}
	l, err := listen(s.Options.SocketPath, owner, s.logf)
	if err != nil {
		return err
	}
	go s.serve(l)
	go s.forwardSignals()
	s.logf("serving on %s (pid %d)", s.Options.SocketPath, os.Getpid())

	s.mu.Lock()
	s.decideLocked()
	s.mu.Unlock()

	<-ctx.Done()
	s.logf("shutting down")
	s.stopAll()
	l.Close()
	s.hub.closeAll(2 * time.Second)
	s.logf("bye")
	return nil
}

// decideLocked picks the state after boot or after a reload that fixed the spec, from the install marker.
func (s *Supervisor) decideLocked() {
	if s.specErr != nil {
		s.sysf("The spec could not be loaded: %v", s.specErr)
		s.setStateLocked(protocol.ServerStateInstallFailed, ptr(fmt.Sprintf("The spec could not be loaded: %v", s.specErr)), nil)
		return
	}
	m := s.marker
	switch {
	case m == nil:
		s.sysf("Not installed yet; installing.")
		s.beginInstallLocked(false)
	case m.Result == installOK:
		s.installed = true
		s.setStateLocked(protocol.ServerStateStopped, nil, nil)
	case m.Result == installFailed:
		s.installed = m.InstalledAt != nil
		s.setStateLocked(protocol.ServerStateInstallFailed, ptr(m.Reason), nil)
	case m.InstalledAt == nil: // the first install was interrupted (container stopped): try again
		s.sysf("The first install was interrupted; installing again.")
		s.beginInstallLocked(false)
	default:
		s.installed = true
		s.setStateLocked(protocol.ServerStateInstallFailed, ptr("The last install was interrupted; run install again."), nil)
	}
}

//#region State

func (s *Supervisor) setStateLocked(state protocol.ServerState, reason *string, exitCode *int64) {
	previous := s.state
	if state == previous && state != protocol.ServerStateInstalling && deref(reason) == deref(s.reason) && equalCode(exitCode, s.exitCode) {
		return // nothing changed (e.g. the boot decision confirming `stopped`)
	}
	now := time.Now().UTC()
	if state != previous {
		s.since = now
	}
	s.state = state
	s.reason = reason
	s.exitCode = exitCode
	if state != protocol.ServerStateInstalling {
		s.progress = nil
	}
	s.publishStateLocked(previous, now)
}

func (s *Supervisor) publishStateLocked(previous protocol.ServerState, at time.Time) {
	change := protocol.StateChange{
		ServerID:        s.serverIDLocked(),
		State:           s.state,
		Previous:        previous,
		At:              at,
		ExitCode:        s.exitCode,
		Reason:          s.reason,
		InstallProgress: s.progress,
	}
	detail := ""
	if s.progress != nil {
		detail = fmt.Sprintf(" (step %d/%d %s)", s.progress.Step, s.progress.Total, s.progress.Name)
	}
	if s.reason != nil {
		detail += ": " + *s.reason
	}
	s.logf("state %s → %s%s", previous, s.state, detail)
	if env, err := protocol.NewEvent(protocol.InitMsgState, change); err == nil {
		s.hub.publish(env)
	}
}

func (s *Supervisor) serverIDLocked() string {
	if s.spec != nil {
		return s.spec.ServerID
	}
	return ""
}

func (s *Supervisor) statusLocked() protocol.InitStatus {
	st := protocol.InitStatus{
		State:           s.state,
		Since:           s.since,
		ExitCode:        s.exitCode,
		Installed:       s.installed,
		Restarts:        int64(len(s.recentRestartsLocked())),
		LastSeq:         s.console.LastSeq(),
		InstallProgress: s.progress,
		Reason:          s.reason,
	}
	if s.run != nil && s.run.game != nil && s.isLiveLocked() {
		pid := int64(s.run.game.PID())
		st.PID = &pid
	}
	return st
}

// isLiveLocked reports whether a game run is between start and exit.
func (s *Supervisor) isLiveLocked() bool {
	switch s.state {
	case protocol.ServerStateStarting, protocol.ServerStateRunning, protocol.ServerStateStopping:
		return true
	}
	return false
}

func (s *Supervisor) recentRestartsLocked() []time.Time {
	if s.spec == nil {
		return nil
	}
	window := time.Duration(s.spec.AutoRestart.WindowSec) * time.Second
	kept := s.restarts[:0]
	for _, t := range s.restarts {
		if time.Since(t) < window {
			kept = append(kept, t)
		}
	}
	s.restarts = kept
	return kept
}

//#endregion

//#region Requests

// handle answers one request envelope.
func (s *Supervisor) handle(req protocol.Envelope) protocol.Envelope {
	result, opErr := s.dispatch(req)
	if opErr != nil {
		return protocol.NewErrorResponse(req, opErr.code, opErr.message)
	}
	resp, err := protocol.NewResponse(req, result)
	if err != nil {
		return protocol.NewErrorResponse(req, protocol.ErrorCodeInternal, err.Error())
	}
	return resp
}

func (s *Supervisor) dispatch(req protocol.Envelope) (any, *opError) {
	switch req.Type {
	case protocol.InitMsgStatus:
		s.mu.Lock()
		defer s.mu.Unlock()
		return s.statusLocked(), nil
	case protocol.InitMsgInstall:
		return s.requestInstall()
	case protocol.InitMsgStart:
		return s.requestStart()
	case protocol.InitMsgUpdate:
		return s.requestUpdate()
	case protocol.InitMsgStop:
		var body protocol.InitStopRequest
		if len(req.Data) > 0 {
			decoded, err := protocol.DecodeData[protocol.InitStopRequest](req)
			if err != nil {
				return nil, &opError{code: protocol.ErrorCodeBadRequest, message: err.Error()}
			}
			body = decoded
		}
		return s.requestStop(body.Kill, body.Reason), nil
	case protocol.InitMsgInput:
		body, err := protocol.DecodeData[protocol.InputLine](req)
		if err != nil {
			return nil, &opError{code: protocol.ErrorCodeBadRequest, message: err.Error()}
		}
		if opErr := s.requestInput(body.Line); opErr != nil {
			return nil, opErr
		}
		return protocol.Empty{}, nil
	case protocol.InitMsgBacklog:
		var body protocol.InitBacklogRequest
		if len(req.Data) > 0 {
			decoded, err := protocol.DecodeData[protocol.InitBacklogRequest](req)
			if err != nil {
				return nil, &opError{code: protocol.ErrorCodeBadRequest, message: err.Error()}
			}
			body = decoded
		}
		lines, more := s.console.Page(body.AfterSeq, body.BeforeSeq, body.Limit, body.Tail)
		return protocol.BacklogResponse{Lines: lines, More: more}, nil
	case protocol.InitMsgReload:
		if opErr := s.requestReload(); opErr != nil {
			return nil, opErr
		}
		return protocol.Empty{}, nil
	}
	return nil, &opError{code: protocol.ErrorCodeUnsupported, message: fmt.Sprintf("gss-init does not handle %q", req.Type)}
}

func (s *Supervisor) requestInstall() (any, *opError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if opErr := s.refuseLocked(); opErr != nil {
		return nil, opErr
	}
	switch {
	case s.state == protocol.ServerStateInstalling:
		return s.statusLocked(), nil // already installing from the start
	case s.isLiveLocked():
		return nil, conflict("The server is %s; stop it before installing.", s.state)
	case s.run != nil:
		return nil, conflict("The post-stop hook is still running; try again in a moment.")
	}
	s.cancelRestartLocked()
	s.beginInstallLocked(false)
	return s.statusLocked(), nil
}

// requestUpdate runs the steamcmd steps and the update hook, like an install, while the server is stopped, or after
// a failed install or update when the game was installed before (so a failed update can be retried).
func (s *Supervisor) requestUpdate() (any, *opError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if opErr := s.refuseLocked(); opErr != nil {
		return nil, opErr
	}
	switch {
	case s.state == protocol.ServerStateInstalling && s.install != nil && s.install.update:
		return s.statusLocked(), nil // already updating
	case s.state == protocol.ServerStateInstalling:
		return nil, conflict("The server is installing; update it once the install finished.")
	case s.state == protocol.ServerStateInstallFailed && !s.installed:
		return nil, conflict("The game was never installed (%s); run install again instead of update.", deref(s.reason))
	case s.state != protocol.ServerStateStopped && s.state != protocol.ServerStateCrashed && s.state != protocol.ServerStateInstallFailed:
		return nil, conflict("The server is %s; stop it before updating.", s.state)
	case s.run != nil:
		return nil, conflict("The post-stop hook is still running; try again in a moment.")
	case !s.installed:
		return nil, conflict("The server is not installed yet; run install first.")
	}
	if len(updateSteps(s.spec)) == 0 {
		return nil, &opError{code: protocol.ErrorCodeBadRequest, message: "This game has nothing to update: its definition has no steamcmd install steps and no update hook."}
	}
	s.cancelRestartLocked()
	s.beginInstallLocked(true)
	return s.statusLocked(), nil
}

func (s *Supervisor) requestStart() (any, *opError) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if opErr := s.refuseLocked(); opErr != nil {
		return nil, opErr
	}
	switch s.state {
	case protocol.ServerStateStarting, protocol.ServerStateRunning:
		return s.statusLocked(), nil
	case protocol.ServerStateStopping:
		return nil, conflict("The server is stopping; start it again once it is stopped.")
	case protocol.ServerStateInstalling:
		return nil, conflict("The server is still installing.")
	case protocol.ServerStateInstallFailed:
		return nil, conflict("The install did not finish (%s); run install again first.", deref(s.reason))
	}
	if !s.installed {
		return nil, conflict("The server is not installed yet; run install first.")
	}
	if s.run != nil {
		return nil, conflict("The post-stop hook is still running; try again in a moment.")
	}
	s.cancelRestartLocked()
	if err := s.startLocked(); err != nil {
		return nil, &opError{code: protocol.ErrorCodeBadRequest, message: err.Error()}
	}
	return s.statusLocked(), nil
}

// refuseLocked answers for the cases where no lifecycle request can run.
func (s *Supervisor) refuseLocked() *opError {
	if s.shutdown {
		return conflict("gss-init is shutting down (the container is stopping).")
	}
	if s.specErr != nil {
		return conflict("The spec could not be loaded: %v. Fix spec.json and send reload.", s.specErr)
	}
	return nil
}

func (s *Supervisor) requestStop(kill bool, reason string) protocol.InitStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	if reason != "" && s.run != nil && s.isLiveLocked() {
		s.run.stopReason = reason
		s.sysf("%s", reason)
	}
	s.stopLocked(kill)
	return s.statusLocked()
}

func (s *Supervisor) requestInput(line string) *opError {
	if strings.ContainsAny(line, "\r\n") {
		return &opError{code: protocol.ErrorCodeBadRequest, message: "Console input must be a single line."}
	}
	if len(line) > MAX_INPUT_BYTES {
		return &opError{code: protocol.ErrorCodeBadRequest, message: fmt.Sprintf("Console input is limited to %d bytes.", MAX_INPUT_BYTES)}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	r := s.run
	if r == nil || r.game == nil || !s.isLiveLocked() {
		return conflict("The server is not running.")
	}
	if r.spec.Console.Input == protocol.ConsoleInputRcon {
		if _, err := s.rcon.Send(r.ctx, line); err != nil {
			return &opError{code: protocol.ErrorCodeUnsupported, message: err.Error()}
		}
	} else if _, err := r.game.Stdin().Write([]byte(line + "\n")); err != nil {
		return conflict("%v", err)
	}
	s.console.Append(protocol.ConsoleStreamInput, line)
	return nil
}

func (s *Supervisor) requestReload() *opError {
	spec, err := loadSpec(s.Options.SpecPath)
	s.mu.Lock()
	defer s.mu.Unlock()
	if err != nil {
		return &opError{code: protocol.ErrorCodeBadRequest, message: err.Error()}
	}
	s.spec = spec
	s.Spec = spec.InitSpec
	s.sysf("Spec reloaded; it applies from the next start.")
	if s.specErr != nil {
		s.specErr = nil
		if !s.shutdown && s.state == protocol.ServerStateInstallFailed && s.install == nil {
			s.decideLocked()
		}
	}
	return nil
}

//#endregion

//#region Install

// updateSteps is what `update` runs: the steamcmd install steps in their order, then the update hook.
func updateSteps(spec *compiledSpec) []protocol.InstallStep {
	var list []protocol.InstallStep
	for _, step := range spec.Install {
		if step.Steamcmd != nil {
			list = append(list, step)
		}
	}
	if spec.Hooks.Update != "" {
		list = append(list, protocol.InstallStep{Hook: spec.Hooks.Update})
	}
	return list
}

// beginInstallLocked starts the install, or with update only the update steps. Both share the state machine:
// `installing` with progress per step, then `stopped`, or `install_failed` with the reason.
func (s *Supervisor) beginInstallLocked(update bool) {
	spec := s.spec
	timeout := time.Duration(protocol.InitInstallTimeoutSec) * time.Second
	if spec.InstallTimeoutSec > 0 {
		timeout = time.Duration(spec.InstallTimeoutSec) * time.Second
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	ir := &installRun{update: update, steps: spec.Install, cancel: cancel, done: make(chan struct{}), timeout: timeout}
	if update {
		ir.steps = updateSteps(spec)
	}
	if s.marker != nil {
		ir.previous = s.marker.InstalledAt
	}
	s.install = ir
	s.progress = nil
	if total := len(ir.steps); total > 0 {
		s.progress = &protocol.InstallProgress{Step: 1, Total: int64(total), Name: stepName(ir.steps[0])}
	}
	s.setStateLocked(protocol.ServerStateInstalling, nil, nil)
	go s.runInstall(ctx, ir, spec)
}

func stepName(step protocol.InstallStep) string {
	if e := steps.Find(step); e != nil {
		return e.Name()
	}
	return "unknown"
}

func (s *Supervisor) runInstall(ctx context.Context, ir *installRun, spec *compiledSpec) {
	defer close(ir.done)
	defer ir.cancel()
	total := len(ir.steps)
	label := ir.label()
	if err := writeMarker(s.data, installMarker{ServerID: spec.ServerID, Result: installRunning, InstalledAt: ir.previous}); err != nil {
		s.finishInstall(ir, spec, fmt.Sprintf("Could not write the install marker in the data folder: %v", err))
		return
	}
	if ir.update {
		s.sysf("Updating: %d step(s).", total)
	} else {
		s.sysf("Installing: %d step(s).", total)
	}
	output := newLineWriter(func(text string) { s.console.Append(protocol.ConsoleStreamOutput, text) })
	env := s.stepsEnv(spec, output)
	for i, step := range ir.steps {
		exec, err := steps.Validate(step)
		name := "unknown"
		if exec != nil {
			name = exec.Name()
		}
		if i > 0 {
			s.mu.Lock()
			s.progress = &protocol.InstallProgress{Step: int64(i + 1), Total: int64(total), Name: name}
			s.publishStateLocked(protocol.ServerStateInstalling, time.Now().UTC())
			s.mu.Unlock()
		}
		if err == nil {
			s.sysf("Step %d/%d: %s %s", i+1, total, name, exec.Describe(step))
			err = exec.Run(ctx, step, env)
		}
		output.Flush()
		if err != nil {
			reason := fmt.Sprintf("%s step %d (%s) failed: %v", label, i+1, name, err)
			if errors.Is(ctx.Err(), context.DeadlineExceeded) {
				reason = fmt.Sprintf("%s step %d (%s) was cancelled: the %s took longer than %s. Raise `install_timeout` in the definition if it needs longer.", label, i+1, name, strings.ToLower(label), ir.timeout)
			} else if ctx.Err() != nil {
				reason = label + " was cancelled."
			}
			s.finishInstall(ir, spec, reason)
			return
		}
	}
	s.finishInstall(ir, spec, "")
}

// label names the run in console lines and reasons.
func (ir *installRun) label() string {
	if ir.update {
		return "Update"
	}
	return "Install"
}

// finishInstall records the result; reason "" = success.
func (s *Supervisor) finishInstall(ir *installRun, spec *compiledSpec, reason string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.install = nil
	now := time.Now().UTC()
	marker := installMarker{ServerID: spec.ServerID, Result: installOK, InstalledAt: &now}
	if reason != "" {
		marker = installMarker{ServerID: spec.ServerID, Result: installFailed, InstalledAt: ir.previous, Reason: reason}
		if s.shutdown && !ir.byStop {
			marker.Result = installRunning // interrupted by the container stopping: the next boot decides
		}
	}
	if err := writeMarker(s.data, marker); err != nil && reason == "" {
		reason = fmt.Sprintf("Could not write the install marker in the data folder: %v", err)
	}
	s.marker = &marker
	if reason != "" {
		s.installed = ir.previous != nil
		s.sysf("%s", reason)
		s.setStateLocked(protocol.ServerStateInstallFailed, ptr(reason), nil)
		return
	}
	s.installed = true
	s.sysf("%s finished.", ir.label())
	s.setStateLocked(protocol.ServerStateStopped, nil, nil)
}

func (s *Supervisor) stepsEnv(spec *compiledSpec, output *lineWriter) steps.Env {
	return steps.Env{
		DataPath: s.Options.DataPath,
		FilesDir: s.Options.FilesDir,
		UID:      s.Options.GameUID,
		Vars:     spec.Env,
		Output:   output,
		Data:     s.data,
		Spawn:    s.reaper.spawn,
	}
}

//#endregion

//#region Game

// startLocked applies configs (failures answer the request; nothing changes) and begins a run.
func (s *Supervisor) startLocked() error {
	spec := s.spec
	if err := configs.ApplyAll(configs.Env{Data: s.data, UID: s.Options.GameUID}, spec.Configs); err != nil {
		s.sysf("Not starting: %v", err)
		return err
	}
	ctx, cancel := context.WithCancel(context.Background())
	r := &gameRun{spec: spec, ctx: ctx, cancel: cancel, done: make(chan struct{}), oomBefore: oomKills()}
	s.run = r
	s.setStateLocked(protocol.ServerStateStarting, nil, nil)
	go s.runGame(r)
	return nil
}

func (s *Supervisor) runGame(r *gameRun) {
	defer close(r.done)
	defer r.cancel()
	spec := r.spec

	if spec.Hooks.PreStart != "" {
		s.sysf("Running the pre-start hook %s.", spec.Hooks.PreStart)
		output := newLineWriter(func(text string) { s.console.Append(protocol.ConsoleStreamOutput, text) })
		err := steps.RunHook(r.ctx, spec.Hooks.PreStart, s.stepsEnv(spec, output))
		output.Flush()
		if err != nil {
			s.mu.Lock()
			s.run = nil
			if r.stopRequested {
				s.setStateLocked(protocol.ServerStateStopped, r.stopReasonPtr(), nil)
			} else {
				reason := fmt.Sprintf("The pre-start hook failed: %v", err)
				s.sysf("%s", reason)
				s.setStateLocked(protocol.ServerStateCrashed, &reason, nil)
				s.scheduleRestartLocked(spec)
			}
			s.mu.Unlock()
			return
		}
	}

	s.mu.Lock()
	if r.stopRequested {
		s.run = nil
		s.setStateLocked(protocol.ServerStateStopped, r.stopReasonPtr(), nil)
		s.mu.Unlock()
		return
	}
	s.sysf("Starting: %s", spec.Start)
	game, err := s.launcher.Launch(r.ctx, spec.InitSpec, watchConsole{Console: s.console, after: func(line protocol.ConsoleLine) { s.onGameOutput(r, line) }})
	if err != nil {
		s.run = nil
		reason := fmt.Sprintf("Could not start the game: %v", err)
		s.sysf("%s", reason)
		s.setStateLocked(protocol.ServerStateCrashed, &reason, nil)
		s.mu.Unlock()
		return
	}
	r.game = game
	if spec.ready == nil {
		r.ready.Store(true)
		s.setStateLocked(protocol.ServerStateRunning, nil, nil)
	}
	s.mu.Unlock()

	code, _ := game.Wait()

	s.mu.Lock()
	if r.stopTimer != nil {
		r.stopTimer.Stop()
	}
	exit := int64(code)
	crashed := !r.stopRequested && code != 0
	if crashed {
		reason := describeExit(code, oomKills() > r.oomBefore)
		s.sysf("%s", reason)
		s.setStateLocked(protocol.ServerStateCrashed, &reason, &exit)
	} else {
		if r.stopRequested {
			s.sysf("The game stopped (exit code %d).", code)
		} else {
			s.sysf("The game exited by itself (exit code 0).")
		}
		if s.state != protocol.ServerStateStopping {
			s.setStateLocked(protocol.ServerStateStopping, nil, nil)
		}
	}
	postStop := spec.Hooks.PostStop
	s.mu.Unlock()

	if postStop != "" {
		s.sysf("Running the post-stop hook %s.", postStop)
		ctx, cancel := context.WithTimeout(context.Background(), POST_STOP_TIMEOUT)
		output := newLineWriter(func(text string) { s.console.Append(protocol.ConsoleStreamOutput, text) })
		if err := steps.RunHook(ctx, postStop, s.stepsEnv(spec, output)); err != nil {
			s.sysf("The post-stop hook failed: %v", err)
		}
		output.Flush()
		cancel()
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	s.run = nil
	if crashed {
		s.scheduleRestartLocked(spec)
		return
	}
	s.setStateLocked(protocol.ServerStateStopped, r.stopReasonPtr(), &exit)
}

// stopReasonPtr is the reason for the final `stopped` state, or nil for an ordinary stop.
func (r *gameRun) stopReasonPtr() *string {
	if r.stopReason == "" {
		return nil
	}
	return ptr(r.stopReason)
}

// onGameOutput moves starting → running on the first line matching the ready pattern.
func (s *Supervisor) onGameOutput(r *gameRun, line protocol.ConsoleLine) {
	if r.ready.Load() || r.spec.ready == nil {
		return
	}
	if !r.spec.ready.MatchString(plainText(line.Text)) {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if r.ready.Swap(true) {
		return
	}
	if s.run == r && s.state == protocol.ServerStateStarting {
		s.setStateLocked(protocol.ServerStateRunning, nil, nil)
	}
}

// stopLocked begins a stop; the game goroutine finishes it.
func (s *Supervisor) stopLocked(kill bool) {
	switch s.state {
	case protocol.ServerStateInstalling:
		if s.install != nil {
			s.install.byStop = !s.shutdown
			s.sysf("Cancelling the install.")
			s.install.cancel()
		}
	case protocol.ServerStateStarting, protocol.ServerStateRunning:
		r := s.run
		if r == nil {
			return
		}
		r.stopRequested = true
		s.setStateLocked(protocol.ServerStateStopping, nil, nil)
		switch {
		case r.game == nil:
			r.cancel() // ends the pre-start hook
		case kill:
			s.sysf("Killing the game.")
			_ = r.game.Signal("SIGKILL")
		default:
			s.sendStopLocked(r)
		}
	case protocol.ServerStateStopping:
		if kill && s.run != nil && s.run.game != nil {
			s.sysf("Killing the game.")
			_ = s.run.game.Signal("SIGKILL")
		}
	default:
		s.cancelRestartLocked()
	}
}

// sendStopLocked sends the stop command or signal and arms the SIGKILL timer.
func (s *Supervisor) sendStopLocked(r *gameRun) {
	spec := r.spec
	sent := false
	if spec.Stop.Command != "" {
		var err error
		if spec.Console.Input == protocol.ConsoleInputRcon {
			_, err = s.rcon.Send(r.ctx, spec.Stop.Command)
		} else {
			_, err = r.game.Stdin().Write([]byte(spec.Stop.Command + "\n"))
		}
		if err == nil {
			s.sysf("Sent the stop command %q; killing the game if it still runs after %s.", spec.Stop.Command, spec.stopTimeout)
			sent = true
		} else {
			s.sysf("Could not send the stop command (%v); sending SIGTERM instead.", err)
		}
	}
	if !sent {
		sig := spec.Stop.Signal
		if sig == "" {
			sig = "SIGTERM"
		}
		if err := r.game.Signal(sig); err != nil {
			s.sysf("Could not send %s (%v); killing the game.", sig, err)
			_ = r.game.Signal("SIGKILL")
			return
		}
		s.sysf("Sent %s; killing the game if it still runs after %s.", sig, spec.stopTimeout)
	}
	r.stopTimer = time.AfterFunc(spec.stopTimeout, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.run == r && r.game != nil && s.state == protocol.ServerStateStopping {
			s.sysf("Still running after %s; killing it.", spec.stopTimeout)
			_ = r.game.Signal("SIGKILL")
		}
	})
}

// scheduleRestartLocked restarts a crashed server when the spec allows it and the window has room.
func (s *Supervisor) scheduleRestartLocked(spec *compiledSpec) {
	if !spec.AutoRestart.Enabled || s.shutdown || s.state != protocol.ServerStateCrashed {
		return
	}
	recent := s.recentRestartsLocked()
	if int64(len(recent)) >= spec.AutoRestart.Max {
		s.sysf("Not restarting: it already restarted %d times within %d s.", len(recent), spec.AutoRestart.WindowSec)
		return
	}
	s.restarts = append(s.restarts, time.Now())
	s.sysf("Restarting in %s (auto-restart %d of %d).", AUTO_RESTART_DELAY, len(s.restarts), spec.AutoRestart.Max)
	var job *time.Timer
	job = time.AfterFunc(AUTO_RESTART_DELAY, func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		if s.restartJob != job {
			return
		}
		s.restartJob = nil
		if s.shutdown || s.state != protocol.ServerStateCrashed || s.run != nil || s.spec == nil {
			return
		}
		if err := s.startLocked(); err != nil {
			reason := fmt.Sprintf("Auto-restart failed: %v", err)
			s.setStateLocked(protocol.ServerStateCrashed, &reason, nil)
		}
	})
	s.restartJob = job
}

func (s *Supervisor) cancelRestartLocked() {
	if s.restartJob != nil {
		s.restartJob.Stop()
		s.restartJob = nil
		s.sysf("Auto-restart cancelled.")
	}
}

// stopAll is the `docker stop` path: cancel an install or stop the game gracefully, then wait for it (Docker
// sends SIGKILL after its own timeout, so the agent should give `docker stop` at least stop.timeout + 10 s).
func (s *Supervisor) stopAll() {
	s.mu.Lock()
	s.shutdown = true
	s.cancelRestartLocked()
	var waits []chan struct{}
	timeout := 5 * time.Second
	if s.install != nil {
		waits = append(waits, s.install.done)
	}
	if s.run != nil {
		waits = append(waits, s.run.done)
		timeout = s.run.spec.stopTimeout + POST_STOP_TIMEOUT
	}
	if s.state == protocol.ServerStateInstalling || s.isLiveLocked() {
		s.sysf("The container is stopping.")
		s.stopLocked(false)
	}
	s.mu.Unlock()

	deadline := time.After(timeout)
	for _, done := range waits {
		select {
		case <-done:
		case <-deadline:
			s.logf("gave up waiting for the game to stop")
			return
		}
	}
}

// forwardSignals passes SIGHUP/SIGUSR1/SIGUSR2 sent to the container on to the game's process group.
func (s *Supervisor) forwardSignals() {
	signals := make(chan os.Signal, 4)
	signal.Notify(signals, syscall.SIGHUP, syscall.SIGUSR1, syscall.SIGUSR2)
	for sig := range signals {
		s.mu.Lock()
		if s.run != nil && s.run.game != nil {
			_ = s.run.game.Signal(signalName(sig.(syscall.Signal)))
		}
		s.mu.Unlock()
	}
}

// describeExit is the crash reason.
func describeExit(code int, oom bool) string {
	if oom {
		return fmt.Sprintf("Killed for running out of memory (the container's memory limit was reached; exit code %d).", code)
	}
	if code > 128 && code < 128+65 {
		return fmt.Sprintf("Killed by %s (exit code %d).", signalName(syscall.Signal(code-128)), code)
	}
	return fmt.Sprintf("Exited with code %d.", code)
}

// oomKills reads the container cgroup's OOM kill counter (cgroup v2), or -1.
func oomKills() int64 {
	raw, err := os.ReadFile("/sys/fs/cgroup/memory.events")
	if err != nil {
		return -1
	}
	for _, line := range strings.Split(string(raw), "\n") {
		if value, ok := strings.CutPrefix(line, "oom_kill "); ok {
			n, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
			if err == nil {
				return n
			}
		}
	}
	return -1
}

//#endregion

//#region Console and logs

// onConsoleLine runs under the console lock for every line, in seq order.
func (s *Supervisor) onConsoleLine(line protocol.ConsoleLine) {
	if env, err := protocol.NewEvent(protocol.InitMsgConsole, line); err == nil {
		s.hub.publish(env)
	}
	if s.Options.EchoConsole {
		switch line.Stream {
		case protocol.ConsoleStreamSystem:
			fmt.Fprintf(os.Stdout, "[gss] %s\n", line.Text)
		case protocol.ConsoleStreamInput:
			fmt.Fprintf(os.Stdout, "> %s\n", line.Text)
		default:
			fmt.Fprintln(os.Stdout, line.Text)
		}
	}
}

// sysf adds a system line to the console.
func (s *Supervisor) sysf(format string, args ...any) {
	s.console.Append(protocol.ConsoleStreamSystem, fmt.Sprintf(format, args...))
}

func (s *Supervisor) logf(format string, args ...any) {
	if s.logger != nil {
		s.logger.Printf(format, args...)
	}
}

func ptr[T any](v T) *T { return &v }

func equalCode(a, b *int64) bool {
	return a == nil && b == nil || a != nil && b != nil && *a == *b
}

func deref(s *string) string {
	if s == nil {
		return "no reason recorded"
	}
	return *s
}

//#endregion
