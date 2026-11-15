package initd

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"sync"
	"syscall"
	"time"
)

// reaper is PID 1's child handling. It is the only caller of wait4: it reaps every exited child (orphans that
// re-parent to PID 1 included) and hands the status to whoever started that child. Children are started under the
// same lock, so a child that exits instantly cannot be reaped before its waiter exists. Nothing in gss-init may
// call cmd.Wait/Run/Output, which would race with it.
type reaper struct {
	mu      sync.Mutex
	waiters map[int]chan syscall.WaitStatus
	reaped  int // orphans reaped (not started by gss-init), for the log
}

// PR_SET_CHILD_SUBREAPER makes orphans re-parent to gss-init when it is not PID 1 (local runs).
const PR_SET_CHILD_SUBREAPER = 36

func newReaper() *reaper {
	return &reaper{waiters: map[int]chan syscall.WaitStatus{}}
}

// run reaps on every SIGCHLD (and every few seconds, in case a signal was coalesced away) until the process exits.
func (r *reaper) run() {
	if os.Getpid() != 1 {
		_, _, _ = syscall.RawSyscall(syscall.SYS_PRCTL, PR_SET_CHILD_SUBREAPER, 1, 0)
	}
	signals := make(chan os.Signal, 8)
	signal.Notify(signals, syscall.SIGCHLD)
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	r.reap()
	for {
		select {
		case <-signals:
		case <-ticker.C:
		}
		r.reap()
	}
}

func (r *reaper) reap() {
	r.mu.Lock()
	defer r.mu.Unlock()
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if errors.Is(err, syscall.EINTR) {
			continue
		}
		if err != nil || pid <= 0 {
			return
		}
		if ch, ok := r.waiters[pid]; ok {
			ch <- status
			delete(r.waiters, pid)
		} else {
			r.reaped++
		}
	}
}

// start starts cmd and returns a function that blocks until it exits. The *os.Process handle is released once the
// child is reaped.
func (r *reaper) start(cmd *exec.Cmd) (func() syscall.WaitStatus, error) {
	r.mu.Lock()
	if err := cmd.Start(); err != nil {
		r.mu.Unlock()
		return nil, err
	}
	ch := make(chan syscall.WaitStatus, 1)
	r.waiters[cmd.Process.Pid] = ch
	r.mu.Unlock()

	var once sync.Once
	var status syscall.WaitStatus
	return func() syscall.WaitStatus {
		once.Do(func() {
			status = <-ch
			_ = cmd.Process.Release()
		})
		return status
	}, nil
}

// spawn adapts start to steps.Spawner (exit codes).
func (r *reaper) spawn(cmd *exec.Cmd) (func() int, error) {
	wait, err := r.start(cmd)
	if err != nil {
		return nil, err
	}
	return func() int { return exitCode(wait()) }, nil
}

// exitCode is the shell convention: the exit status, or 128+signal when killed.
func exitCode(status syscall.WaitStatus) int {
	if status.Signaled() {
		return 128 + int(status.Signal())
	}
	return status.ExitStatus()
}

// signalNames maps the names a spec may use (with or without SIG) to signals.
var signalNames = map[string]syscall.Signal{
	"HUP": syscall.SIGHUP, "INT": syscall.SIGINT, "QUIT": syscall.SIGQUIT, "KILL": syscall.SIGKILL,
	"USR1": syscall.SIGUSR1, "USR2": syscall.SIGUSR2, "TERM": syscall.SIGTERM, "CONT": syscall.SIGCONT,
	"STOP": syscall.SIGSTOP, "WINCH": syscall.SIGWINCH,
}

// parseSignal reads "SIGTERM", "TERM" or "sigint".
func parseSignal(name string) (syscall.Signal, bool) {
	upper := ""
	for _, r := range name {
		if r >= 'a' && r <= 'z' {
			r -= 'a' - 'A'
		}
		upper += string(r)
	}
	if len(upper) > 3 && upper[:3] == "SIG" {
		upper = upper[3:]
	}
	sig, ok := signalNames[upper]
	return sig, ok
}

// signalName is the SIG-prefixed name, for messages.
func signalName(sig syscall.Signal) string {
	for name, s := range signalNames {
		if s == sig {
			return "SIG" + name
		}
	}
	return "signal " + sig.String()
}
