package files

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// setup builds <tmp>/outside/secret.txt and <tmp>/data (the root) with files, folders and planted symlinks.
func setup(t *testing.T) (*FS, string) {
	t.Helper()
	base := t.TempDir()
	data := filepath.Join(base, "data")
	outside := filepath.Join(base, "outside")
	must(t, os.MkdirAll(filepath.Join(data, "world", "region"), 0o755))
	must(t, os.MkdirAll(outside, 0o755))
	must(t, os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("secret"), 0o644))
	must(t, os.WriteFile(filepath.Join(data, "server.properties"), []byte("motd=hi\n"), 0o640))
	must(t, os.WriteFile(filepath.Join(data, "world", "level.dat"), []byte{0, 1, 2, 0xff}, 0o644))
	must(t, os.Symlink(filepath.Join(outside, "secret.txt"), filepath.Join(data, "abs-link")))
	must(t, os.Symlink("../outside/secret.txt", filepath.Join(data, "rel-out")))
	must(t, os.Symlink("../../outside", filepath.Join(data, "world", "out-dir")))
	must(t, os.Symlink("server.properties", filepath.Join(data, "in-link")))
	must(t, os.Symlink("in-link", filepath.Join(data, "chain")))
	must(t, os.Symlink("world/out-dir", filepath.Join(data, "chain-out")))
	must(t, os.Symlink("world", filepath.Join(data, "world-link")))
	fs, err := Open(data, Options{Owner: -1})
	must(t, err)
	t.Cleanup(func() { fs.Close() })
	return fs, base
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func code(err error) protocol.ErrorCode {
	var remote *protocol.RemoteError
	if errors.As(err, &remote) {
		return remote.Code
	}
	if err == nil {
		return ""
	}
	return "internal"
}

func TestClean(t *testing.T) {
	good := map[string]string{"": ".", "a": "a", "world/level.dat": "world/level.dat", ".hidden": ".hidden", "a..b": "a..b"}
	for in, want := range good {
		got, err := Clean(in)
		if err != nil || got != want {
			t.Errorf("Clean(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"..", "../x", "a/../b", "a/./b", ".", "/etc/passwd", "/", "a//b", "a/", "a\\b", "a\x00b"} {
		if _, err := Clean(in); code(err) != protocol.ErrorCodeBadRequest {
			t.Errorf("Clean(%q) error %v; want bad_request", in, err)
		}
	}
}

func TestEscapesRefused(t *testing.T) {
	fs, base := setup(t)
	for _, p := range []string{"abs-link", "rel-out", "world/out-dir/secret.txt", "chain-out/secret.txt", "../outside/secret.txt", "/etc/passwd"} {
		if _, _, _, err := fs.ReadText(p); code(err) != protocol.ErrorCodeBadRequest {
			t.Errorf("ReadText(%q) error %v; want bad_request", p, err)
		}
		if _, _, err := fs.OpenRead(p); code(err) != protocol.ErrorCodeBadRequest {
			t.Errorf("OpenRead(%q) error %v; want bad_request", p, err)
		}
		if _, err := fs.WriteText(p, []byte("pwned"), nil); code(err) != protocol.ErrorCodeBadRequest {
			t.Errorf("WriteText(%q) error %v; want bad_request", p, err)
		}
	}
	for _, p := range []string{"world/out-dir", "chain-out", "../outside"} {
		if _, err := fs.List(p); code(err) != protocol.ErrorCodeBadRequest {
			t.Errorf("List(%q) error %v; want bad_request", p, err)
		}
		if _, err := fs.Mkdir(p + "/new"); code(err) != protocol.ErrorCodeBadRequest {
			t.Errorf("Mkdir(%q/new) error %v; want bad_request", p, err)
		}
		if _, err := fs.CreateUpload("00000000-0000-0000-0000-000000000001", p+"/up.bin", 1, false); code(err) != protocol.ErrorCodeBadRequest {
			t.Errorf("CreateUpload(%q/up.bin) error %v; want bad_request", p, err)
		}
	}
	if _, err := fs.Rename("server.properties", "world/out-dir/stolen", false); code(err) != protocol.ErrorCodeBadRequest {
		t.Errorf("Rename into an escaping folder: %v; want bad_request", err)
	}
	if err := fs.Delete([]string{"world/out-dir/secret.txt"}); code(err) != protocol.ErrorCodeBadRequest {
		t.Errorf("Delete through an escaping folder: %v; want bad_request", err)
	}
	raw, err := os.ReadFile(filepath.Join(base, "outside", "secret.txt"))
	if err != nil || string(raw) != "secret" {
		t.Fatalf("the file outside changed: %q, %v", raw, err)
	}
	if _, err := os.Stat(filepath.Join(base, "outside", "new")); err == nil {
		t.Fatal("a folder was created outside")
	}
}

func TestSymlinksInside(t *testing.T) {
	fs, _ := setup(t)
	entry, content, binary, err := fs.ReadText("chain")
	must(t, err)
	if binary || string(content) != "motd=hi\n" || entry.Type != protocol.FileTypeFile {
		t.Fatalf("ReadText(chain) = %+v %q %v", entry, content, binary)
	}
	list, err := fs.List("world-link")
	must(t, err)
	if len(list.Entries) != 3 || list.Entries[0].Name != "region" {
		t.Fatalf("List(world-link) = %+v", list.Entries)
	}
	link, err := fs.Stat("abs-link")
	must(t, err)
	if link.Type != protocol.FileTypeSymlink || link.LinkTarget == nil || *link.LinkTarget == "" {
		t.Fatalf("Stat(abs-link) = %+v", link)
	}
	// Writing through a link replaces the target and keeps the link.
	_, err = fs.WriteText("chain", []byte("motd=new\n"), nil)
	must(t, err)
	if entry, err := fs.Stat("in-link"); err != nil || entry.Type != protocol.FileTypeSymlink {
		t.Fatalf("in-link after the write: %+v %v", entry, err)
	}
	if _, content, _, _ := fs.ReadText("server.properties"); string(content) != "motd=new\n" {
		t.Fatalf("server.properties = %q", content)
	}
	// Deleting a link to a folder removes the link, never the folder's content.
	must(t, fs.Delete([]string{"world-link"}))
	if _, err := fs.Stat("world/level.dat"); err != nil {
		t.Fatalf("delete of a folder link removed its target: %v", err)
	}
}

func TestSymlinkSwappedBetweenCalls(t *testing.T) {
	fs, base := setup(t)
	data := filepath.Join(base, "data")
	must(t, os.Symlink("world", filepath.Join(data, "swap")))
	if _, err := fs.List("swap"); err != nil {
		t.Fatalf("List(swap) inside: %v", err)
	}
	// The game swaps the link to point out of the folder between two calls.
	must(t, os.Remove(filepath.Join(data, "swap")))
	must(t, os.Symlink(filepath.Join(base, "outside"), filepath.Join(data, "swap")))
	if _, err := fs.List("swap"); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("List(swap) after the swap: %v; want bad_request", err)
	}
	if _, err := fs.WriteText("swap/secret.txt", []byte("x"), nil); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("WriteText(swap/secret.txt) after the swap: %v; want bad_request", err)
	}
}

func TestListOrderAndTypes(t *testing.T) {
	fs, _ := setup(t)
	list, err := fs.List("")
	must(t, err)
	if list.Path != "" || list.Truncated {
		t.Fatalf("List() = %+v", list)
	}
	if list.Entries[0].Name != "world" || list.Entries[0].Type != protocol.FileTypeDir || list.Entries[0].Size != 0 {
		t.Fatalf("first entry = %+v; folders come first", list.Entries[0])
	}
	for i := 2; i < len(list.Entries); i++ {
		if list.Entries[i-1].Name > list.Entries[i].Name {
			t.Fatalf("entries not sorted: %q > %q", list.Entries[i-1].Name, list.Entries[i].Name)
		}
	}
	if _, err := fs.List("server.properties"); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("List(file): %v; want bad_request", err)
	}
	if _, err := fs.List("missing"); code(err) != protocol.ErrorCodeNotFound {
		t.Fatalf("List(missing): %v; want not_found", err)
	}
}

func TestReadText(t *testing.T) {
	fs, base := setup(t)
	if _, _, binary, err := fs.ReadText("world/level.dat"); err != nil || !binary {
		t.Fatalf("ReadText(level.dat) binary=%v err=%v", binary, err)
	}
	big := filepath.Join(base, "data", "big.log")
	must(t, os.WriteFile(big, make([]byte, protocol.FileTextMaxBytes+1), 0o644))
	if _, _, _, err := fs.ReadText("big.log"); code(err) != protocol.ErrorCodeTooLarge {
		t.Fatalf("ReadText(big.log): %v; want too_large", err)
	}
	if _, _, _, err := fs.ReadText("world"); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("ReadText(folder): %v; want bad_request", err)
	}
}

func TestWriteTextConflictAndMode(t *testing.T) {
	fs, base := setup(t)
	entry, _, _, err := fs.ReadText("server.properties")
	must(t, err)
	loaded := entry.ModifiedAt
	saved, err := fs.WriteText("server.properties", []byte("a=1\n"), &loaded)
	must(t, err)
	if saved.Mode != 0o640 {
		t.Fatalf("mode after save = %o; want 640 kept", saved.Mode)
	}
	// A second save with the stale time conflicts.
	stale := loaded
	if saved.ModifiedAt.Equal(stale) {
		stale = stale.Add(-time.Second)
	}
	if _, err := fs.WriteText("server.properties", []byte("b=2\n"), &stale); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("stale save: %v; want conflict", err)
	}
	// The round trip through RFC 3339 keeps the time exact.
	parsed, err := time.Parse(time.RFC3339Nano, saved.ModifiedAt.Format(time.RFC3339Nano))
	must(t, err)
	if _, err := fs.WriteText("server.properties", []byte("c=3\n"), &parsed); err != nil {
		t.Fatalf("save with the returned time: %v", err)
	}
	created, err := fs.WriteText("world/new.txt", []byte("new"), nil)
	must(t, err)
	if created.Mode != 0o644 || created.Size != 3 {
		t.Fatalf("new file = %+v", created)
	}
	if _, err := fs.WriteText("gone.txt", []byte("x"), &parsed); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("save of a deleted file: %v; want conflict", err)
	}
	if _, err := fs.WriteText("nofolder/x.txt", []byte("x"), nil); code(err) != protocol.ErrorCodeNotFound {
		t.Fatalf("save into a missing folder: %v; want not_found", err)
	}
	leftovers, _ := filepath.Glob(filepath.Join(base, "data", ".*.gss-save-*"))
	if len(leftovers) != 0 {
		t.Fatalf("temporary files left: %v", leftovers)
	}
}

func TestMkdirRenameDelete(t *testing.T) {
	fs, _ := setup(t)
	dir, err := fs.Mkdir("plugins")
	must(t, err)
	if dir.Type != protocol.FileTypeDir || dir.Mode != 0o755 {
		t.Fatalf("Mkdir = %+v", dir)
	}
	if _, err := fs.Mkdir("plugins"); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("second Mkdir: %v; want conflict", err)
	}
	if _, err := fs.Mkdir("a/b"); code(err) != protocol.ErrorCodeNotFound {
		t.Fatalf("Mkdir without parent: %v; want not_found", err)
	}
	if _, err := fs.Rename("world", "world/region/world", false); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("move into itself: %v; want conflict", err)
	}
	if _, err := fs.Rename("world", "world-link/region/w", false); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("move into itself through a link: %v; want conflict", err)
	}
	must(t, os.WriteFile(filepath.Join(fs.dir, "a.txt"), []byte("a"), 0o644))
	must(t, os.WriteFile(filepath.Join(fs.dir, "b.txt"), []byte("b"), 0o644))
	if _, err := fs.Rename("a.txt", "b.txt", false); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("rename onto a file: %v; want conflict", err)
	}
	if _, err := fs.Rename("a.txt", "plugins", true); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("rename onto a folder: %v; want conflict", err)
	}
	if _, err := fs.Rename("plugins", "b.txt", true); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("folder onto a file: %v; want conflict", err)
	}
	moved, err := fs.Rename("a.txt", "b.txt", true)
	must(t, err)
	if moved.Path != "b.txt" || moved.Size != 1 {
		t.Fatalf("overwrite rename = %+v", moved)
	}
	if _, err := fs.Rename("b.txt", "plugins/b.txt", false); err != nil {
		t.Fatalf("move into a folder: %v", err)
	}
	if err := fs.Delete([]string{""}); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("Delete(root): %v; want bad_request", err)
	}
	if err := fs.Delete([]string{"plugins", "missing"}); code(err) != protocol.ErrorCodeNotFound {
		t.Fatalf("Delete with a missing path: %v; want not_found", err)
	}
	if _, err := fs.Stat("plugins/b.txt"); err != nil {
		t.Fatalf("a refused Delete removed something: %v", err)
	}
	must(t, fs.Delete([]string{"plugins", "world"}))
	if _, err := fs.Stat("world"); code(err) != protocol.ErrorCodeNotFound {
		t.Fatalf("world after Delete: %v", err)
	}
}

func TestUploadTempAndRules(t *testing.T) {
	fs, base := setup(t)
	id := "6f9619ff-8b86-d011-b42d-00cf4fc964ff"
	if _, err := fs.CreateUpload("../../x", "a.bin", 1, false); code(err) != protocol.ErrorCodeBadRequest {
		t.Fatalf("bad transfer id: %v", err)
	}
	if _, err := fs.CreateUpload(id, "server.properties", 1, false); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("upload onto an existing file: %v; want conflict", err)
	}
	if _, err := fs.CreateUpload(id, "world", 1, true); code(err) != protocol.ErrorCodeConflict {
		t.Fatalf("upload onto a folder: %v; want conflict", err)
	}
	if _, err := fs.CreateUpload(id, "missing/a.bin", 1, false); code(err) != protocol.ErrorCodeNotFound {
		t.Fatalf("upload into a missing folder: %v; want not_found", err)
	}
	limited, err := Open(filepath.Join(base, "data"), Options{Owner: -1, DiskLimitBytes: 100, UsedBytes: func() int64 { return 90 }})
	must(t, err)
	defer limited.Close()
	if _, err := limited.CreateUpload(id, "a.bin", 11, false); code(err) != protocol.ErrorCodeNoSpace {
		t.Fatalf("upload over the disk limit: %v; want no_space", err)
	}
	if _, err := fs.CreateUpload(id, "a.bin", 1<<62, false); code(err) != protocol.ErrorCodeNoSpace {
		t.Fatalf("upload larger than the disk: %v; want no_space", err)
	}
	file, err := fs.CreateUpload(id, "a.bin", 3, false)
	must(t, err)
	_, err = file.WriteAt([]byte("abc"), 0)
	must(t, err)
	must(t, file.Close())
	entry, err := fs.CommitUpload(id, "a.bin", false)
	must(t, err)
	if entry.Size != 3 || entry.Mode != 0o644 {
		t.Fatalf("committed = %+v", entry)
	}
	file, err = fs.CreateUpload(id, "b.bin", 3, false)
	must(t, err)
	file.Close()
	must(t, fs.DiscardUpload(id))
	if _, err := os.Stat(filepath.Join(base, "data", protocol.UploadTempDir, id)); !os.IsNotExist(err) {
		t.Fatalf("temp file after DiscardUpload: %v", err)
	}
	file, err = fs.CreateUpload(id, "c.bin", 3, false)
	must(t, err)
	file.Close()
	must(t, fs.ClearUploads())
	if _, err := os.Stat(filepath.Join(base, "data", protocol.UploadTempDir)); !os.IsNotExist(err) {
		t.Fatalf("upload folder after ClearUploads: %v", err)
	}
}
