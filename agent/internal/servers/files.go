package servers

import (
	"github.com/ionnet-dev/ionnet-gss/agent/internal/files"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// Files opens a server's data folder for the file manager (M4): files.Open on Layout.ServerData with the server's
// disk limit (limits.diskMb) and usage (usedBytes, disk.go). Refused with conflict while s.operation is a restore.
func (m *manager) Files(serverID string) (*files.FS, error) {
	s, err := m.lookup(serverID)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	restoring := s.operation != nil && s.operation.Operation == protocol.BackupOperationRestore
	limitMb := s.req.Spec.Limits.DiskMB
	s.mu.Unlock()
	if restoring {
		return nil, remoteError(protocol.ErrorCodeConflict, "A restore of this server is swapping its files right now. Try again when it finishes.")
	}
	return files.Open(m.opts.Layout.ServerData(serverID), files.Options{
		Owner:          protocol.GameUID,
		DiskLimitBytes: limitMb << 20,
		UsedBytes:      func() int64 { return m.cachedUsed(s) },
	})
}
