package backups

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/klauspost/compress/zstd"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

func manifest() protocol.BackupManifest {
	return protocol.BackupManifest{Format: protocol.BackupFormatVersion, ServerID: "0b0b0b0b-0000-4000-8000-000000000001", BackupID: 7, CreatedAt: time.Now().UTC(), SpecHash: "abc"}
}

func write(t *testing.T, file, content string, mode fs.FileMode) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), mode); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, mode); err != nil {
		t.Fatal(err)
	}
}

func TestRoundTrip(t *testing.T) {
	src := t.TempDir()
	data := filepath.Join(src, "data")
	svc := filepath.Join(src, "db")
	write(t, filepath.Join(data, "server.properties"), "motd=hi\n", 0o640)
	write(t, filepath.Join(data, "start.sh"), "#!/bin/sh\n", 0o4755) // setuid must not survive
	write(t, filepath.Join(data, "world", "level.dat"), strings.Repeat("x", 700_000), 0o600)
	write(t, filepath.Join(data, "world", "session.lock"), "lock", 0o600)
	write(t, filepath.Join(data, "logs", "latest.log"), "log", 0o644)
	write(t, filepath.Join(data, "crash.log"), "c", 0o644)
	write(t, filepath.Join(data, "plugins", "crash.log"), "kept: patterns are anchored", 0o644)
	write(t, filepath.Join(data, "cache"), "a file named like an excluded folder is kept", 0o644)
	write(t, filepath.Join(svc, "ibdata1"), "db", 0o660)
	if err := os.Symlink("world/level.dat", filepath.Join(data, "level-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(data, "abs-link")); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(filepath.Join(data, "world"), 0o750); err != nil {
		t.Fatal(err)
	}

	var before, after []string
	var buf bytes.Buffer
	var lastProgress int64
	result, err := Create(context.Background(), &buf, CreateOptions{
		Manifest: manifest(),
		Roots: []Root{
			{Name: "data", Dir: data},
			{Name: "services/db", Dir: svc,
				Before: func(context.Context) error { before = append(before, "db"); return nil },
				After:  func(context.Context) { after = append(after, "db") }},
		},
		Exclude:   []string{"logs/", "*.log", "world/session.lock", "cache/"},
		Progress:  func(n int64) { lastProgress = n },
		AfterRoot: func(name string) { after = append(after, "root:"+name) },
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 1 || strings.Join(after, ",") != "root:data,db,root:services/db" {
		t.Fatalf("hooks ran as before=%v after=%v", before, after)
	}
	if result.Files != 6 || lastProgress != result.Bytes {
		t.Fatalf("result %+v, last progress %d", result, lastProgress)
	}

	dst := t.TempDir()
	got, err := Extract(context.Background(), bytes.NewReader(buf.Bytes()), ExtractOptions{Dest: map[string]string{
		"data":        filepath.Join(dst, "data"),
		"services/db": filepath.Join(dst, "db"),
	}})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got.Roots, ",") != "data,services/db" || got.BackupID != 7 {
		t.Fatalf("manifest %+v", got)
	}
	for _, rel := range []string{"server.properties", "world/level.dat", "plugins/crash.log", "cache", "start.sh"} {
		want, _ := os.ReadFile(filepath.Join(data, rel))
		have, err := os.ReadFile(filepath.Join(dst, "data", rel))
		if err != nil || !bytes.Equal(want, have) {
			t.Fatalf("%s differs after the round trip: %v", rel, err)
		}
	}
	for _, rel := range []string{"logs", "crash.log", "world/session.lock"} {
		if _, err := os.Lstat(filepath.Join(dst, "data", rel)); !errors.Is(err, fs.ErrNotExist) {
			t.Fatalf("%s should be excluded: %v", rel, err)
		}
	}
	if target, err := os.Readlink(filepath.Join(dst, "data", "level-link")); err != nil || target != "world/level.dat" {
		t.Fatalf("relative link: %q %v", target, err)
	}
	if target, err := os.Readlink(filepath.Join(dst, "data", "abs-link")); err != nil || target != "/etc/passwd" {
		t.Fatalf("absolute link kept as a link: %q %v", target, err)
	}
	modes := map[string]fs.FileMode{"server.properties": 0o640, "start.sh": 0o755, "world": 0o750 | fs.ModeDir, "world/level.dat": 0o600}
	for rel, want := range modes {
		info, err := os.Lstat(filepath.Join(dst, "data", rel))
		if err != nil || info.Mode() != want {
			t.Fatalf("%s mode %v, want %v (%v)", rel, info.Mode(), want, err)
		}
	}
	srcInfo, _ := os.Stat(filepath.Join(data, "server.properties"))
	dstInfo, _ := os.Stat(filepath.Join(dst, "data", "server.properties"))
	if !srcInfo.ModTime().Equal(dstInfo.ModTime()) {
		t.Fatalf("mtime %v, want %v", dstInfo.ModTime(), srcInfo.ModTime())
	}
	if have, _ := os.ReadFile(filepath.Join(dst, "db", "ibdata1")); string(have) != "db" {
		t.Fatal("service volume not restored")
	}
}

func TestSkippedRootAndFailedBefore(t *testing.T) {
	src := t.TempDir()
	write(t, filepath.Join(src, "data", "a"), "a", 0o644)
	write(t, filepath.Join(src, "db", "b"), "b", 0o644)
	unpaused := false
	_, err := Create(context.Background(), &bytes.Buffer{}, CreateOptions{
		Manifest: manifest(),
		Roots: []Root{{Name: "data", Dir: filepath.Join(src, "data")}, {Name: "services/db", Dir: filepath.Join(src, "db"),
			Before: func(context.Context) error { return errors.New("pause failed") },
			After:  func(context.Context) { unpaused = true }}},
	})
	if err == nil || !unpaused {
		t.Fatalf("a failed Before must fail the backup and still run After: %v %v", err, unpaused)
	}

	var buf bytes.Buffer
	if _, err := Create(context.Background(), &buf, CreateOptions{Manifest: manifest(), Roots: []Root{{Name: "data", Dir: filepath.Join(src, "data")}, {Name: "services/db", Dir: filepath.Join(src, "db")}}}); err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	if _, err := Extract(context.Background(), bytes.NewReader(buf.Bytes()), ExtractOptions{Dest: map[string]string{"data": filepath.Join(dst, "data")}}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "data", "a")); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dst)
	if len(entries) != 1 {
		t.Fatalf("only data should be extracted, got %d entries", len(entries))
	}
}

func TestCancel(t *testing.T) {
	src := t.TempDir()
	write(t, filepath.Join(src, "a"), "a", 0o644)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Create(ctx, &bytes.Buffer{}, CreateOptions{Manifest: manifest(), Roots: []Root{{Name: "data", Dir: src}}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("want context.Canceled, got %v", err)
	}
}

// hostile builds an archive by hand: the manifest (roots data) plus the given entries.
func hostile(t *testing.T, entries []tar.Header, format int64) []byte {
	t.Helper()
	var buf bytes.Buffer
	enc, _ := zstd.NewWriter(&buf)
	tw := tar.NewWriter(enc)
	m := manifest()
	m.Format = format
	m.Roots = []string{"data"}
	raw, _ := json.Marshal(m)
	tw.WriteHeader(&tar.Header{Name: protocol.BackupManifestName, Typeflag: tar.TypeReg, Mode: 0o644, Size: int64(len(raw))})
	tw.Write(raw)
	for _, h := range entries {
		h := h
		if err := tw.WriteHeader(&h); err != nil {
			t.Fatal(err)
		}
		if h.Typeflag == tar.TypeReg {
			tw.Write(bytes.Repeat([]byte("p"), int(h.Size)))
		}
	}
	tw.Close()
	enc.Close()
	return buf.Bytes()
}

func TestHostileArchives(t *testing.T) {
	dir := func(name string) tar.Header { return tar.Header{Name: name, Typeflag: tar.TypeDir, Mode: 0o755} }
	file := func(name string) tar.Header {
		return tar.Header{Name: name, Typeflag: tar.TypeReg, Mode: 0o644, Size: 4}
	}
	cases := []struct {
		name    string
		entries []tar.Header
	}{
		{"dotdot", []tar.Header{dir("data/"), file("data/../x")}},
		{"dotdot root", []tar.Header{file("../x")}},
		{"absolute", []tar.Header{file("/tmp/x")}},
		{"outside roots", []tar.Header{file("services/db/x")}},
		{"symlink then file", []tar.Header{dir("data/"), {Name: "data/link", Typeflag: tar.TypeSymlink, Linkname: "/tmp"}, file("data/link/x")}},
		{"in-folder symlink then file", []tar.Header{dir("data/"), dir("data/sub/"), {Name: "data/link", Typeflag: tar.TypeSymlink, Linkname: "sub"}, file("data/link/x")}},
		{"symlink then dir", []tar.Header{dir("data/"), {Name: "data/link", Typeflag: tar.TypeSymlink, Linkname: "/tmp"}, dir("data/link/")}},
		{"symlink replaced by file", []tar.Header{dir("data/"), {Name: "data/link", Typeflag: tar.TypeSymlink, Linkname: "/tmp/x"}, file("data/link")}},
		{"hard link", []tar.Header{dir("data/"), file("data/a"), {Name: "data/b", Typeflag: tar.TypeLink, Linkname: "data/a"}}},
		{"char device", []tar.Header{dir("data/"), {Name: "data/null", Typeflag: tar.TypeChar, Devmajor: 1, Devminor: 3}}},
		{"block device", []tar.Header{dir("data/"), {Name: "data/sda", Typeflag: tar.TypeBlock, Devmajor: 8}}},
		{"fifo", []tar.Header{dir("data/"), {Name: "data/pipe", Typeflag: tar.TypeFifo}}},
		{"duplicate file", []tar.Header{dir("data/"), file("data/a"), file("data/a")}},
		{"not clean", []tar.Header{file("data/./a")}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			parent := t.TempDir()
			dst := filepath.Join(parent, "data")
			raw := hostile(t, tc.entries, protocol.BackupFormatVersion)
			_, err := Extract(context.Background(), bytes.NewReader(raw), ExtractOptions{Dest: map[string]string{"data": dst}})
			var unsafe *UnsafeEntryError
			if !errors.As(err, &unsafe) {
				t.Fatalf("want an UnsafeEntryError, got %v", err)
			}
			if entries, _ := os.ReadDir(parent); len(entries) != 1 {
				t.Fatalf("something was written beside the restore folder: %v", entries)
			}
		})
	}
}

func TestSetuidDroppedOnExtract(t *testing.T) {
	dst := filepath.Join(t.TempDir(), "data")
	raw := hostile(t, []tar.Header{{Name: "data/", Typeflag: tar.TypeDir, Mode: 0o1777}, {Name: "data/su", Typeflag: tar.TypeReg, Mode: 0o6755, Size: 4}}, protocol.BackupFormatVersion)
	if _, err := Extract(context.Background(), bytes.NewReader(raw), ExtractOptions{Dest: map[string]string{"data": dst}}); err != nil {
		t.Fatal(err)
	}
	info, _ := os.Stat(filepath.Join(dst, "su"))
	if info.Mode() != 0o755 {
		t.Fatalf("mode %v", info.Mode())
	}
	info, _ = os.Stat(dst)
	if info.Mode() != fs.ModeDir|0o777 {
		t.Fatalf("root mode %v", info.Mode())
	}
}

func TestFormatAndManifest(t *testing.T) {
	raw := hostile(t, nil, protocol.BackupFormatVersion+1)
	if _, err := Extract(context.Background(), bytes.NewReader(raw), ExtractOptions{Dest: map[string]string{"data": t.TempDir()}}); err == nil || !strings.Contains(err.Error(), "format") {
		t.Fatalf("newer format must be refused: %v", err)
	}
	var buf bytes.Buffer
	enc, _ := zstd.NewWriter(&buf)
	tw := tar.NewWriter(enc)
	tw.WriteHeader(&tar.Header{Name: "data/x", Typeflag: tar.TypeReg, Size: 1})
	tw.Write([]byte("x"))
	tw.Close()
	enc.Close()
	if _, err := Extract(context.Background(), bytes.NewReader(buf.Bytes()), ExtractOptions{}); err == nil {
		t.Fatal("an archive without a manifest must be refused")
	}
	if _, err := Extract(context.Background(), strings.NewReader("not zstd"), ExtractOptions{}); err == nil {
		t.Fatal("garbage must be refused")
	}
}

func TestMatcher(t *testing.T) {
	m, err := NewMatcher([]string{"logs/", "*.log", "world/session.lock", "cache/", "w?rld_nether/DIM-1/"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		rel   string
		isDir bool
		want  bool
	}{
		{"logs", true, true},
		{"logs", false, false},
		{"logs/latest.log", false, true},
		{"latest.log", false, true},
		{"plugins/x.log", false, false},
		{"world/session.lock", false, true},
		{"world/level.dat", false, false},
		{"world", true, false},
		{"cache", true, true},
		{"world_nether/DIM-1", true, true},
		{"world_nether/DIM-1/region/r.0.0.mca", false, true},
		{"world_nether/DIM1", true, false},
	}
	for _, tc := range cases {
		if got := m.Excluded(tc.rel, tc.isDir); got != tc.want {
			t.Errorf("Excluded(%q, %v) = %v, want %v", tc.rel, tc.isDir, got, tc.want)
		}
	}
	for _, bad := range []string{"", "/abs", "../up", "a//b", "a/./b", "[", "/"} {
		if _, err := NewMatcher([]string{bad}); err == nil {
			t.Errorf("pattern %q should be refused", bad)
		}
	}
	var none *Matcher
	if none.Excluded("x", false) {
		t.Fatal("nil matcher excludes nothing")
	}
}
