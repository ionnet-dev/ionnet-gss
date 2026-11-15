// Package configs applies `configs` mappings before every start (M2/M3): only the managed keys change; everything
// else in the file stays the user's. One applier per ConfigFormat.
package configs

import (
	"errors"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// ErrNotImplemented marks skeleton appliers.
var ErrNotImplemented = errors.New("config format: not implemented")

// Applier rewrites one file format.
type Applier interface {
	// Apply sets the mapping's keys in the file at path (below /data), creating it when missing. For the template
	// format, Apply writes mapping.Content whole.
	Apply(path string, mapping protocol.ConfigMapping) error
}

// Registry maps formats to appliers. A new format: a value in ConfigFormat (protocol/schema/definition.json),
// `deno task protocol`, an <format>.go applier here, one entry below.
var Registry = map[protocol.ConfigFormat]Applier{
	// TODO(builder): M2 — properties, template; M3 — ini, json, yaml, cfg.
}

// Find returns the applier for format, or nil.
func Find(format protocol.ConfigFormat) Applier {
	return Registry[format]
}
