package servers

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log/slog"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// File ownership between the host and GAME_UID (uid 1000 in the container, no user namespace):
//
//   - The server folder and run/ are the agent's, mode 0700: no other host user can reach the data, the spec (it
//     carries secrets) or the supervisor socket. gss-init hands run/ (0700) and init.sock (0600) to the agent's
//     uid/gid from InitSpec.agentUid/agentGid, so only the agent (and root) can connect.
//   - The agent as root (production): data/ is chowned to GAME_UID:GAME_UID 0750, so the game owns its files.
//     gss-init (root in the container) reads the 0600 spec.json as its owner.
//   - The agent as uid 1000 (a normal dev user in the docker group; the first user on most installs): the agent's
//     own files already are GAME_UID's, nothing to chown. gss-init needs DAC_OVERRIDE (in InitCapabilities) to read
//     spec.json and to create init.sock in the agent-owned run/. The game (also uid 1000) could open run/ inside the
//     container, but gss-init refuses every peer inside its pid namespace.
//   - Any other non-root uid: data/ becomes 0777 so GAME_UID can write it (logged once). Files the game creates
//     there belong to uid 1000, so Delete without keepData may need root to finish.
var warnDataMode sync.Once

// prepareDataDir creates data/ and makes it writable for GAME_UID.
func prepareDataDir(dir string) error {
	if err := os.MkdirAll(dir, 0o750); err != nil {
		return fmt.Errorf("create data folder %s: %w", dir, err)
	}
	switch euid := os.Geteuid(); euid {
	case 0:
		if err := os.Chown(dir, protocol.GameUID, protocol.GameUID); err != nil {
			return fmt.Errorf("hand data folder %s to uid %d: %w", dir, protocol.GameUID, err)
		}
		return os.Chmod(dir, 0o750)
	case protocol.GameUID:
		return os.Chmod(dir, 0o750)
	default:
		warnDataMode.Do(func() {
			slog.Warn("the agent runs neither as root nor as the game uid: server data folders are made world-writable so the game can write them; run the agent as root in production", "uid", euid, "gameUid", protocol.GameUID)
		})
		return os.Chmod(dir, 0o777)
	}
}

// validFilePath reports whether p is a clean definition-relative path (no `..`, no leading `/`).
func validFilePath(p string) bool {
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, "\\") || strings.ContainsRune(p, 0) {
		return false
	}
	if path.Clean(p) != p {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." || part == "." {
			return false
		}
	}
	return true
}

// writeServerFolder lays out <root>/servers/<id>: data/, run/, spec/spec.json and spec/files/** (replaced as a
// whole), plus the agent's manifest. spec/ itself is never replaced, because a running container's bind mount
// holds on to the folder: only its contents change.
func writeServerFolder(layout paths.Layout, req protocol.ProvisionRequest) error {
	id := req.Spec.ServerID
	for _, dir := range []string{layout.Root, layout.ServersDir()} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("create %s: %w", dir, err)
		}
	}
	if err := secureServerFolder(layout, id); err != nil {
		return err
	}
	if err := os.MkdirAll(layout.ServerSpec(id), 0o755); err != nil {
		return fmt.Errorf("create %s: %w", layout.ServerSpec(id), err)
	}
	if err := prepareDataDir(layout.ServerData(id)); err != nil {
		return err
	}

	initSpec := req.Spec.Init
	initSpec.AgentUID, initSpec.AgentGID = int64(os.Geteuid()), int64(os.Getegid())
	spec, err := json.MarshalIndent(initSpec, "", "  ")
	if err != nil {
		return fmt.Errorf("encode spec.json: %w", err)
	}
	if err := writeFileAtomic(layout.ServerInitSpec(id), append(spec, '\n'), 0o600); err != nil {
		return err
	}
	if err := replaceFiles(layout.ServerFiles(id), req.Spec.Files); err != nil {
		return err
	}
	return writeManifest(layout, req)
}

// secureServerFolder creates the server folder and run/ with mode 0700 and tightens folders an older agent made
// 0755. run/ may already belong to gss-init's chown (the agent's own uid), so a failed chmod there is only logged.
func secureServerFolder(layout paths.Layout, serverID string) error {
	dir := layout.ServerDir(serverID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", dir, err)
	}
	if err := os.Chmod(dir, 0o700); err != nil {
		return fmt.Errorf("chmod %s: %w", dir, err)
	}
	run := layout.ServerRun(serverID)
	if err := os.MkdirAll(run, 0o700); err != nil {
		return fmt.Errorf("create %s: %w", run, err)
	}
	if err := os.Chmod(run, 0o700); err != nil {
		slog.Warn("could not make the run folder private", "folder", run, "error", err)
	}
	return nil
}

// replaceFiles writes files into a fresh sibling folder and swaps it in for dir.
func replaceFiles(dir string, files []protocol.SpecFile) error {
	fresh := filepath.Join(filepath.Dir(dir), ".files-new")
	old := filepath.Join(filepath.Dir(dir), ".files-old")
	for _, stale := range []string{fresh, old} {
		if err := os.RemoveAll(stale); err != nil {
			return fmt.Errorf("clear %s: %w", stale, err)
		}
	}
	if err := os.MkdirAll(fresh, 0o755); err != nil {
		return fmt.Errorf("create %s: %w", fresh, err)
	}
	for _, file := range files {
		target := filepath.Join(fresh, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return fmt.Errorf("create folder for %s: %w", file.Path, err)
		}
		mode := fs.FileMode(0o644)
		if file.Executable {
			mode = 0o755
		}
		if err := os.WriteFile(target, []byte(file.Content), mode); err != nil {
			return fmt.Errorf("write %s: %w", file.Path, err)
		}
		if err := os.Chmod(target, mode); err != nil { // WriteFile's mode is subject to the umask.
			return fmt.Errorf("chmod %s: %w", file.Path, err)
		}
	}
	if err := os.Rename(dir, old); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("move old %s aside: %w", dir, err)
	}
	if err := os.Rename(fresh, dir); err != nil {
		return fmt.Errorf("install %s: %w", dir, err)
	}
	return os.RemoveAll(old)
}

// writeManifest keeps the provision request for Restore (0600: the spec carries generated secrets).
func writeManifest(layout paths.Layout, req protocol.ProvisionRequest) error {
	req.Reinstall = false
	raw, err := json.MarshalIndent(req, "", "  ")
	if err != nil {
		return fmt.Errorf("encode server manifest: %w", err)
	}
	return writeFileAtomic(layout.ServerManifest(req.Spec.ServerID), append(raw, '\n'), 0o600)
}

// readManifest loads a server's last provision request.
func readManifest(file string) (protocol.ProvisionRequest, error) {
	var req protocol.ProvisionRequest
	raw, err := os.ReadFile(file)
	if err != nil {
		return req, err
	}
	if err := json.Unmarshal(raw, &req); err != nil {
		return req, fmt.Errorf("server manifest %s is not valid JSON: %w", file, err)
	}
	return req, nil
}

// writeFileAtomic replaces file with content through a temp file and rename, so readers never see half a file.
func writeFileAtomic(file string, content []byte, mode fs.FileMode) error {
	tmp, err := os.CreateTemp(filepath.Dir(file), "."+filepath.Base(file)+"-*.tmp")
	if err != nil {
		return fmt.Errorf("write %s: %w", file, err)
	}
	defer os.Remove(tmp.Name()) // No-op once renamed.
	if _, err := tmp.Write(content); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", file, err)
	}
	if err := tmp.Chmod(mode); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", file, err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()
		return fmt.Errorf("write %s: %w", file, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("write %s: %w", file, err)
	}
	if err := os.Rename(tmp.Name(), file); err != nil {
		return fmt.Errorf("replace %s: %w", file, err)
	}
	return nil
}

// dirSize is the apparent size of every regular file below dir. Unreadable entries are skipped.
func dirSize(dir string) int64 {
	total, _ := walkSize(dir)
	return total
}

// walkSize is dirSize that also reports whether an entry below dir could not be read (a folder another uid owns
// with mode 0700, such as a stack service's volume for a non-root agent). A missing dir is 0, not denied.
func walkSize(dir string) (total int64, denied bool) {
	_ = filepath.WalkDir(dir, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			if errors.Is(err, fs.ErrPermission) {
				denied = true
			}
			return nil
		}
		if entry.Type().IsRegular() {
			if info, err := entry.Info(); err == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total, denied
}

// removeServerFolder deletes the server's folder, or with keepData everything but data/, backups/ and services/
// (a stack's database is the server's data too), so Restore no longer finds a manifest there.
func removeServerFolder(layout paths.Layout, serverID string, keepData bool) error {
	dir := layout.ServerDir(serverID)
	var err error
	if keepData {
		for _, part := range []string{layout.ServerManifest(serverID), layout.ServerSpec(serverID), layout.ServerRun(serverID)} {
			if removeErr := os.RemoveAll(part); removeErr != nil {
				err = removeErr
			}
		}
	} else {
		err = os.RemoveAll(dir)
	}
	if err != nil {
		return fmt.Errorf("remove %s: %w (files the game created belong to uid %d; run the agent as root, or remove the folder with sudo)", dir, err, protocol.GameUID)
	}
	return nil
}
