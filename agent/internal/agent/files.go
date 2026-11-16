package agent

import (
	"context"
	"encoding/base64"
	"fmt"
	"os"
	"path"
	"strconv"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/files"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/panel"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// fileHandlers are the M4 file manager and transfer requests (files.json). files.*: Servers.Files(serverId) → the
// FS method → Close. transfer.open: download of a file (FS.OpenRead) or a backup (Servers.BackupArchive), or an
// upload (FS.CreateUpload) → Transfers.Open*; transfer.read/write/commit/close → Transfers. Text content is base64
// decoded and encoded here; chunks are by Transfers (a chunk over TRANSFER_CHUNK_BYTES answers too_large).
func (a *Agent) fileHandlers() map[string]panel.RequestHandler {
	return map[string]panel.RequestHandler{
		protocol.MsgFilesList: serve(fileTimeout, func(ctx context.Context, req protocol.FilesPathRequest) (any, error) {
			return withFS(a, req.ServerID, func(fs *files.FS) (any, error) { return fs.List(req.Path) })
		}),
		protocol.MsgFilesStat: serve(fileTimeout, func(ctx context.Context, req protocol.FilesPathRequest) (any, error) {
			return withFS(a, req.ServerID, func(fs *files.FS) (any, error) { return fs.Stat(req.Path) })
		}),
		protocol.MsgFilesRead: serve(fileTimeout, func(ctx context.Context, req protocol.FilesPathRequest) (any, error) {
			return withFS(a, req.ServerID, func(fs *files.FS) (any, error) {
				entry, content, binary, err := fs.ReadText(req.Path)
				if err != nil {
					return nil, err
				}
				return protocol.FilesReadResponse{Entry: entry, Binary: binary, ContentBase64: base64.StdEncoding.EncodeToString(content)}, nil
			})
		}),
		protocol.MsgFilesWrite: serve(fileTimeout, tracked(a.ops, "file save", func(req protocol.FilesWriteRequest) string { return req.ServerID }, func(ctx context.Context, req protocol.FilesWriteRequest) (any, error) {
			if base64.StdEncoding.DecodedLen(len(req.ContentBase64)) > protocol.FileTextMaxBytes+2 {
				return nil, &protocol.RemoteError{Code: protocol.ErrorCodeTooLarge, Message: fmt.Sprintf("The editor saves files of at most %d MB. Upload larger files instead.", protocol.FileTextMaxBytes>>20)}
			}
			content, err := base64.StdEncoding.DecodeString(req.ContentBase64)
			if err != nil {
				return nil, &protocol.RemoteError{Code: protocol.ErrorCodeBadRequest, Message: "The file content is not valid base64."}
			}
			var expected *time.Time
			if req.ExpectedModifiedAt != nil {
				at, err := time.Parse(time.RFC3339Nano, *req.ExpectedModifiedAt)
				if err != nil {
					return nil, &protocol.RemoteError{Code: protocol.ErrorCodeBadRequest, Message: "expectedModifiedAt is not an RFC 3339 time; pass back the modifiedAt the file was loaded with."}
				}
				expected = &at
			}
			return withFS(a, req.ServerID, func(fs *files.FS) (any, error) { return fs.WriteText(req.Path, content, expected) })
		})),
		protocol.MsgFilesMkdir: serve(fileTimeout, tracked(a.ops, "folder creation", func(req protocol.FilesPathRequest) string { return req.ServerID }, func(ctx context.Context, req protocol.FilesPathRequest) (any, error) {
			return withFS(a, req.ServerID, func(fs *files.FS) (any, error) { return fs.Mkdir(req.Path) })
		})),
		protocol.MsgFilesRename: serve(fileTimeout, tracked(a.ops, "file rename", func(req protocol.FilesRenameRequest) string { return req.ServerID }, func(ctx context.Context, req protocol.FilesRenameRequest) (any, error) {
			return withFS(a, req.ServerID, func(fs *files.FS) (any, error) { return fs.Rename(req.From, req.To, req.Overwrite) })
		})),
		protocol.MsgFilesDelete: serve(fileTimeout, tracked(a.ops, "file deletion", func(req protocol.FilesDeleteRequest) string { return req.ServerID }, func(ctx context.Context, req protocol.FilesDeleteRequest) (any, error) {
			return withFS(a, req.ServerID, func(fs *files.FS) (any, error) { return protocol.Empty{}, fs.Delete(req.Paths) })
		})),
		protocol.MsgTransferOpen: serve(fileTimeout, tracked(a.ops, "file transfer", func(req protocol.TransferOpenRequest) string { return req.ServerID }, func(ctx context.Context, req protocol.TransferOpenRequest) (any, error) {
			return a.openTransfer(req)
		})),
		protocol.MsgTransferRead: serve(fileTimeout, func(ctx context.Context, req protocol.TransferReadRequest) (any, error) {
			return a.Transfers.Read(req)
		}),
		protocol.MsgTransferWrite: serve(fileTimeout, func(ctx context.Context, req protocol.TransferWriteRequest) (any, error) {
			return protocol.Empty{}, a.Transfers.Write(req)
		}),
		protocol.MsgTransferCommit: serve(fileTimeout, tracked(a.ops, "upload", a.transferServer, func(ctx context.Context, req protocol.TransferRef) (any, error) {
			return a.Transfers.Commit(req.TransferID)
		})),
		protocol.MsgTransferClose: serve(fileTimeout, func(ctx context.Context, req protocol.TransferRef) (any, error) {
			a.Transfers.Close(req.TransferID)
			return protocol.Empty{}, nil
		}),
	}
}

// transferServer names the server of an open transfer for an operation label ("unknown" once it is gone).
func (a *Agent) transferServer(req protocol.TransferRef) string {
	if serverID, ok := a.Transfers.ServerOf(req.TransferID); ok {
		return serverID
	}
	return "unknown"
}

// withFS opens a server's data folder for one request and closes it afterwards.
func withFS(a *Agent, serverID string, fn func(fs *files.FS) (any, error)) (any, error) {
	fs, err := a.Servers.Files(serverID)
	if err != nil {
		return nil, err
	}
	defer fs.Close()
	res, err := fn(fs)
	if err != nil {
		return nil, err
	}
	return res, nil
}

// openTransfer answers `transfer.open`.
func (a *Agent) openTransfer(req protocol.TransferOpenRequest) (protocol.TransferOpenResponse, error) {
	switch {
	case req.Direction == protocol.TransferDirectionDownload && req.Source == protocol.TransferSourceFile:
		fs, err := a.Servers.Files(req.ServerID)
		if err != nil {
			return protocol.TransferOpenResponse{}, err
		}
		file, entry, err := fs.OpenRead(req.Path)
		fs.Close() // The open file stays valid without the root.
		if err != nil {
			return protocol.TransferOpenResponse{}, err
		}
		return a.registerDownload(req, file, entry.Name, entry.Size)
	case req.Direction == protocol.TransferDirectionDownload && req.Source == protocol.TransferSourceBackup:
		file, size, err := a.Servers.BackupArchive(req.ServerID, req.BackupID)
		if err != nil {
			return protocol.TransferOpenResponse{}, err
		}
		return a.registerDownload(req, file, strconv.FormatInt(req.BackupID, 10)+protocol.BackupExtension, size)
	case req.Direction == protocol.TransferDirectionUpload && req.Source == protocol.TransferSourceFile:
		fs, err := a.Servers.Files(req.ServerID)
		if err != nil {
			return protocol.TransferOpenResponse{}, err
		}
		file, err := fs.CreateUpload(req.TransferID, req.Path, req.Size, req.Overwrite)
		if err != nil {
			fs.Close()
			return protocol.TransferOpenResponse{}, err
		}
		if err := a.Transfers.OpenUpload(req.TransferID, req.ServerID, fs, file, req.Path, req.Size, req.Overwrite); err != nil {
			file.Close()
			_ = fs.DiscardUpload(req.TransferID)
			fs.Close()
			return protocol.TransferOpenResponse{}, err
		}
		return protocol.TransferOpenResponse{TransferID: req.TransferID, Name: path.Base(req.Path), Size: req.Size}, nil
	}
	return protocol.TransferOpenResponse{}, &protocol.RemoteError{Code: protocol.ErrorCodeBadRequest, Message: "Transfers are downloads of a file or a backup, or uploads of a file."}
}

// registerDownload puts an opened file into the transfer table (closing it when that is refused).
func (a *Agent) registerDownload(req protocol.TransferOpenRequest, file *os.File, name string, size int64) (protocol.TransferOpenResponse, error) {
	if err := a.Transfers.OpenDownload(req.TransferID, req.ServerID, file, size); err != nil {
		file.Close()
		return protocol.TransferOpenResponse{}, err
	}
	return protocol.TransferOpenResponse{TransferID: req.TransferID, Name: name, Size: size}, nil
}
