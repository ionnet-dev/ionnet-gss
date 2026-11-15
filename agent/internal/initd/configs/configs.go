// Package configs applies `configs` mappings before every start (M2/M3): only the managed keys change; everything
// else in the file stays the user's. One applier per ConfigFormat.
package configs

import (
	"fmt"
	"os"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/initd/datafs"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Env is what every applier gets.
type Env struct {
	// Data is the data folder; files are read and written only through it.
	Data *os.Root
	// UID owns files the applier creates (GAME_UID); -1 = keep.
	UID int
}

// Applier rewrites one file format.
type Applier interface {
	// Apply sets the mapping's keys in mapping.File (below /data, already checked with `datafs.Rel` and passed as
	// name), creating it when missing. For the template format, Apply writes mapping.Content whole.
	Apply(env Env, name string, mapping protocol.ConfigMapping) error
}

// Registry maps formats to appliers. A new format: a value in ConfigFormat (protocol/schema/definition.json),
// `deno task protocol`, an <format>.go applier here, one entry below.
var Registry = map[protocol.ConfigFormat]Applier{
	protocol.ConfigFormatProperties: propertiesApplier{},
	protocol.ConfigFormatTemplate:   templateApplier{},
}

// Find returns the applier for format, or nil.
func Find(format protocol.ConfigFormat) Applier {
	return Registry[format]
}

// ApplyAll applies every mapping in order and stops at the first failure, naming the file.
func ApplyAll(env Env, mappings []protocol.ConfigMapping) error {
	for _, m := range mappings {
		name, err := datafs.Rel(m.File)
		if err != nil {
			return fmt.Errorf("config %s: %w", m.File, err)
		}
		applier := Find(m.Format)
		if applier == nil {
			return fmt.Errorf("config %s: format %q is not supported yet (M2 supports properties and template; ini, json, yaml and cfg land in M3)", m.File, m.Format)
		}
		if err := applier.Apply(env, name, m); err != nil {
			return fmt.Errorf("config %s: %w", m.File, err)
		}
	}
	return nil
}

// templateApplier writes the panel-rendered file whole.
type templateApplier struct{}

func (templateApplier) Apply(env Env, name string, mapping protocol.ConfigMapping) error {
	data := []byte(mapping.Content)
	if datafs.SameContent(env.Data, name, data) {
		return nil
	}
	return datafs.WriteFile(env.Data, name, data, 0o644, env.UID)
}
