package servers

import (
	"github.com/ionnet-dev/ionnet-gss/agent/internal/files"
)

// Files opens a server's data folder for the file manager (M4): files.Open on Layout.ServerData with the server's
// disk limit (limits.diskMb) and usage (usedBytes, disk.go). Refused with conflict while s.operation is a restore.
func (m *manager) Files(serverID string) (*files.FS, error) {
	if _, err := m.lookup(serverID); err != nil {
		return nil, err
	}
	return nil, remoteError("unsupported", "The file manager is not implemented in this agent yet.") // TODO(builder)
}
