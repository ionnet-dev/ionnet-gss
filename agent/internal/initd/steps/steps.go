// Package steps runs install steps inside the container (M2). One executor per InstallStep key.
package steps

import (
	"context"
	"errors"
	"io"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrNotImplemented marks skeleton executors.
var ErrNotImplemented = errors.New("install step: not implemented")

// Env is what every step gets.
type Env struct {
	DataPath string            // /data
	FilesDir string            // /gss/spec/files; a `hook` step runs FilesDir/<hook path>.
	UID      int               // GAME_UID; steps that run programs drop to it.
	Vars     map[string]string // InitSpec.Env
	// Output receives the step's console output (stream "output"); gss-init adds "system" lines around each step.
	Output io.Writer
}

// Executor runs one step type.
type Executor interface {
	// Name is the InstallStep key, e.g. "download".
	Name() string
	// Matches reports whether step is of this type (its field is set).
	Matches(step protocol.InstallStep) bool
	Run(ctx context.Context, step protocol.InstallStep, env Env) error
}

// Registry lists every executor. A new step type: a property on InstallStep in protocol/schema/definition.json,
// `deno task protocol`, an <name>.go executor here, one entry below.
var Registry = []Executor{
	// TODO(builder): M2 — steamcmd (M3), download, extract, write, hook.
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
