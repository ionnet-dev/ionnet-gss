// Package steps runs install steps inside the container (M2). One executor per InstallStep key.
package steps

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Spawner starts cmd and returns a function that blocks until it exits and returns its exit code (128+signal when
// killed). gss-init's reaper owns wait4 as PID 1, so nothing here may call cmd.Wait, cmd.Run or cmd.Output.
type Spawner func(cmd *exec.Cmd) (wait func() int, err error)

// Env is what every step gets.
type Env struct {
	DataPath string            // /data
	FilesDir string            // /gss/spec/files; a `hook` step runs FilesDir/<hook path>.
	UID      int               // GAME_UID; steps that run programs drop to it, files they write are chowned to it. -1 = keep.
	Vars     map[string]string // InitSpec.Env
	// Output receives the step's console output (stream "output"); gss-init adds "system" lines around each step.
	Output io.Writer
	// Data is the data folder; every file a step writes goes through it.
	Data *os.Root
	// Spawn starts helper processes (hooks, xz) under gss-init's reaper.
	Spawn Spawner
}

// Executor runs one step type.
type Executor interface {
	// Name is the InstallStep key, e.g. "download".
	Name() string
	// Matches reports whether step is of this type (its field is set).
	Matches(step protocol.InstallStep) bool
	// Describe is a short human summary for the console, e.g. "server.jar from https://…".
	Describe(step protocol.InstallStep) string
	Run(ctx context.Context, step protocol.InstallStep, env Env) error
}

// Registry lists every executor. A new step type: a property on InstallStep in protocol/schema/definition.json,
// `deno task protocol`, an <name>.go executor here, one entry below.
var Registry = []Executor{
	steamcmdStep{},
	downloadStep{},
	extractStep{},
	writeStep{},
	hookStep{},
}

// Find returns the executor for step, or nil.
func Find(step protocol.InstallStep) Executor {
	for _, e := range Registry {
		if e.Matches(step) {
			return e
		}
	}
	return nil
}

// Validate checks that exactly one step type is set and returns its executor.
func Validate(step protocol.InstallStep) (Executor, error) {
	var found Executor
	count := 0
	for _, e := range Registry {
		if e.Matches(step) {
			found = e
			count++
		}
	}
	switch count {
	case 0:
		return nil, fmt.Errorf("no step type is set; set exactly one of steamcmd, download, extract, write or hook")
	case 1:
		return found, nil
	default:
		return nil, fmt.Errorf("%d step types are set; set exactly one of steamcmd, download, extract, write or hook", count)
	}
}
