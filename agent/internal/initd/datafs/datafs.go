// Package datafs holds gss-init's file helpers for the data folder. Every write goes through an `os.Root` opened on
// /data, so a symlink planted by the game can never redirect a write outside it, and everything gss-init creates is
// handed to GAME_UID.
package datafs

import (
	"bytes"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path"
	"strings"
	"syscall"
)

// Rel turns a spec path ("server.properties", "/data/server.properties") into a clean path relative to the data
// folder. Absolute paths must be below /data; paths that leave it are refused.
func Rel(p string) (string, error) {
	if p == "" {
		return "", errors.New("path is empty")
	}
	if strings.ContainsRune(p, 0) {
		return "", fmt.Errorf("path %q contains a NUL byte", p)
	}
	clean := p
	if strings.HasPrefix(p, "/") {
		clean = path.Clean(p)
		if clean == "/data" {
			return ".", nil
		}
		if !strings.HasPrefix(clean, "/data/") {
			return "", fmt.Errorf("path %q is outside /data; use a path relative to /data", p)
		}
		clean = strings.TrimPrefix(clean, "/data/")
	}
	clean = path.Clean(clean)
	if clean == ".." || strings.HasPrefix(clean, "../") {
		return "", fmt.Errorf("path %q leaves /data", p)
	}
	return clean, nil
}

// Chown hands name to uid:uid without following a final symlink. It is a no-op when uid is negative or gss-init
// does not run as root (local development).
func Chown(root *os.Root, name string, uid int) error {
	if uid < 0 || os.Geteuid() != 0 {
		return nil
	}
	if err := root.Lchown(name, uid, uid); err != nil {
		return fmt.Errorf("chown %s: %w", name, err)
	}
	return nil
}

// MkdirAll creates dir and its missing parents (0755) and chowns every folder it created to uid.
func MkdirAll(root *os.Root, dir string, uid int) error {
	if dir == "." || dir == "" {
		return nil
	}
	parts := strings.Split(dir, "/")
	current := ""
	for _, part := range parts {
		current = path.Join(current, part)
		info, err := root.Stat(current)
		if err == nil {
			if !info.IsDir() {
				return fmt.Errorf("%s exists and is not a folder", current)
			}
			continue
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return err
		}
		if err := root.Mkdir(current, 0o755); err != nil && !errors.Is(err, fs.ErrExist) {
			return err
		}
		if err := Chown(root, current, uid); err != nil {
			return err
		}
	}
	return nil
}

// WriteFile replaces name with data atomically (temp file + rename) and creates its parent folders. An existing
// file keeps its mode and owner; a new one gets perm and uid.
func WriteFile(root *os.Root, name string, data []byte, perm fs.FileMode, uid int) error {
	if err := MkdirAll(root, path.Dir(name), uid); err != nil {
		return err
	}
	mode := perm
	owner, group := uid, uid
	if info, err := root.Lstat(name); err == nil {
		if info.Mode().IsRegular() {
			mode = info.Mode().Perm()
			if st, ok := info.Sys().(*syscall.Stat_t); ok {
				owner, group = int(st.Uid), int(st.Gid)
			}
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}

	tmp := path.Join(path.Dir(name), "."+path.Base(name)+".gss-tmp")
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	_, werr := f.Write(data)
	cerr := f.Close()
	if werr != nil || cerr != nil {
		_ = root.Remove(tmp)
		return errors.Join(werr, cerr)
	}
	if err := root.Chmod(tmp, mode); err != nil {
		_ = root.Remove(tmp)
		return err
	}
	if owner >= 0 && os.Geteuid() == 0 {
		if err := root.Lchown(tmp, owner, group); err != nil {
			_ = root.Remove(tmp)
			return fmt.Errorf("chown %s: %w", name, err)
		}
	}
	if err := root.Rename(tmp, name); err != nil {
		_ = root.Remove(tmp)
		return err
	}
	return nil
}

// ReadFileIfExists returns the file's content, or nil (and no error) when it does not exist.
func ReadFileIfExists(root *os.Root, name string) ([]byte, error) {
	data, err := root.ReadFile(name)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return data, err
}

// SameContent reports whether name already holds exactly data.
func SameContent(root *os.Root, name string, data []byte) bool {
	current, err := root.ReadFile(name)
	return err == nil && bytes.Equal(current, data)
}
