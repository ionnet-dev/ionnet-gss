package agent

import (
	"context"
	"encoding/json"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// fileHandlers are the M4 file manager and transfer requests (files.json). files.*: Servers.Files(serverId) → the
// FS method → Close. transfer.open: download of a file (FS.OpenRead) or a backup (Servers.BackupArchive), or an
// upload (FS.CreateUpload) → Transfers.Open*; transfer.read/write/commit/close → Transfers. Base64 is decoded and
// encoded here; a chunk over TRANSFER_CHUNK_BYTES answers too_large.
func (a *Agent) fileHandlers() map[string]panel.RequestHandler {
	notYet := func(ctx context.Context, data json.RawMessage) (any, error) {
		return nil, &protocol.RemoteError{Code: protocol.ErrorCodeUnsupported, Message: "The file manager is not implemented in this agent yet."}
	}
	handlers := map[string]panel.RequestHandler{}
	for _, msg := range []string{
		protocol.MsgFilesList, protocol.MsgFilesStat, protocol.MsgFilesRead, protocol.MsgFilesWrite, protocol.MsgFilesMkdir,
		protocol.MsgFilesRename, protocol.MsgFilesDelete, protocol.MsgTransferOpen, protocol.MsgTransferRead,
		protocol.MsgTransferWrite, protocol.MsgTransferCommit, protocol.MsgTransferClose,
	} {
		handlers[msg] = notYet // TODO(builder): serve(fileTimeout, …) per message
	}
	return handlers
}
