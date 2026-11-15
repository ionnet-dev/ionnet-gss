package initd

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"sync"
	"syscall"
	"time"
	"unsafe"

	"github.com/creack/pty"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/steps"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// STDIN_QUEUE is how many console input lines may wait for a game that is not reading its stdin.
const STDIN_QUEUE = 256

// OUTPUT_DRAIN is how long Wait waits for the last output after the process exited.
const OUTPUT_DRAIN = 2 * time.Second

// DEFAULT_TERM is the game's TERM unless the spec sets one; the panel console renders SGR colours.
const DEFAULT_TERM = "xterm-256color"

// ptyLauncher runs the start command under a fresh pty, in its own session (so the pty is its controlling terminal
// and its process group can be signalled as a whole), as GAME_UID in the data folder.
type ptyLauncher struct {
	reaper   *reaper
	dataPath string
	uid      int
}

var _ Launcher = (*ptyLauncher)(nil)

func (l *ptyLauncher) Launch(ctx context.Context, spec protocol.InitSpec, console Console) (Game, error) {
	ptmx, tty, err := pty.Open()
	if err != nil {
		return nil, fmt.Errorf("open pty: %w", err)
	}
	_ = pty.Setsize(ptmx, &pty.Winsize{Rows: 50, Cols: 200})
	// The panel shows input lines itself; the pty echoing them back would print every command twice.
	_ = disableEcho(tty)

	vars := map[string]string{"TERM": DEFAULT_TERM}
	for k, v := range spec.Env {
		vars[k] = v
	}
	cmd := exec.Command("/bin/sh", "-c", spec.Start)
	cmd.Dir = l.dataPath
	cmd.Env = steps.Environ(l.dataPath, vars)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = tty, tty, tty
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true, Ctty: 0, Credential: steps.Credential(l.uid)}

	wait, err := l.reaper.start(cmd)
	tty.Close()
	if err != nil {
		ptmx.Close()
		return nil, fmt.Errorf("start the game: %w", err)
	}
	g := &ptyGame{
		pid:        cmd.Process.Pid,
		ptmx:       ptmx,
		input:      make(chan string, STDIN_QUEUE),
		wait:       wait,
		outputDone: make(chan struct{}),
	}
	go g.readOutput(console)
	go g.writeInput()
	return g, nil
}

// ptyGame is one run of the start command.
type ptyGame struct {
	pid        int
	ptmx       *os.File
	input      chan string
	inputMu    sync.Mutex
	inputShut  bool
	wait       func() syscall.WaitStatus
	outputDone chan struct{}
	once       sync.Once
	code       int
}

var _ Game = (*ptyGame)(nil)

func (g *ptyGame) PID() int { return g.pid }

func (g *ptyGame) Stdin() io.Writer { return stdinWriter{g} }

func (g *ptyGame) Signal(name string) error {
	sig, ok := parseSignal(name)
	if !ok {
		return fmt.Errorf("unknown signal %q", name)
	}
	return g.signal(sig)
}

// signal sends sig to the game's whole process group (the shell and everything it started).
func (g *ptyGame) signal(sig syscall.Signal) error {
	if err := syscall.Kill(-g.pid, sig); err != nil && !errors.Is(err, syscall.ESRCH) {
		return err
	}
	return nil
}

// Wait blocks until the game exits, kills what is left of its process group, waits briefly for the last output
// and returns the exit code (128+signal when killed).
func (g *ptyGame) Wait() (int, error) {
	g.once.Do(func() {
		g.code = exitCode(g.wait())
		_ = g.signal(syscall.SIGKILL)
		select {
		case <-g.outputDone:
		case <-time.After(OUTPUT_DRAIN):
		}
		g.inputMu.Lock()
		g.inputShut = true
		close(g.input)
		g.inputMu.Unlock()
		g.ptmx.Close()
	})
	return g.code, nil
}

func (g *ptyGame) readOutput(console Console) {
	defer close(g.outputDone)
	lines := newLineWriter(func(text string) { console.Append(protocol.ConsoleStreamOutput, text) })
	buf := make([]byte, 32<<10)
	for {
		n, err := g.ptmx.Read(buf)
		if n > 0 {
			_, _ = lines.Write(buf[:n])
		}
		if err != nil { // EIO once every holder of the pty slave is gone
			break
		}
	}
	lines.Flush()
}

func (g *ptyGame) writeInput() {
	for line := range g.input {
		if _, err := g.ptmx.Write([]byte(line)); err != nil {
			return
		}
	}
}

// stdinWriter queues input for the game without ever blocking the caller.
type stdinWriter struct{ g *ptyGame }

// ErrInputQueueFull means the game has not read its console input for a while.
var ErrInputQueueFull = errors.New("the game is not reading console input; try again later")

// ErrGameExited means input arrived after the game exited.
var ErrGameExited = errors.New("the game has exited")

func (w stdinWriter) Write(p []byte) (int, error) {
	w.g.inputMu.Lock()
	defer w.g.inputMu.Unlock()
	if w.g.inputShut {
		return 0, ErrGameExited
	}
	select {
	case w.g.input <- string(p):
		return len(p), nil
	default:
		return 0, ErrInputQueueFull
	}
}

// disableEcho clears ECHO on the pty's line discipline (the game may change it again, e.g. jline raw mode).
func disableEcho(tty *os.File) error {
	var t syscall.Termios
	fd := tty.Fd()
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCGETS, uintptr(unsafe.Pointer(&t))); errno != 0 {
		return errno
	}
	t.Lflag &^= syscall.ECHO | syscall.ECHONL
	if _, _, errno := syscall.Syscall(syscall.SYS_IOCTL, fd, syscall.TCSETS, uintptr(unsafe.Pointer(&t))); errno != 0 {
		return errno
	}
	return nil
}

// watchConsole forwards appends to the real console and then to after (outside the console's lock), so the
// supervisor can match ready and player patterns without lock-order trouble.
type watchConsole struct {
	Console
	after func(line protocol.ConsoleLine)
}

func (w watchConsole) Append(stream protocol.ConsoleStream, text string) protocol.ConsoleLine {
	line := w.Console.Append(stream, text)
	w.after(line)
	return line
}
