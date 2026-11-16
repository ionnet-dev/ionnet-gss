package servers

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/backups"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

// restoreFixture lays out a server folder with live data/ and services/db plus their restored copies.
func restoreFixture(t *testing.T) (string, restoreJournal) {
	t.Helper()
	dir := t.TempDir()
	for file, content := range map[string]string{
		"data/world.dat":                    "old",
		"services/db/ibdata1":               "old-db",
		"restore-3/data/world.dat":          "new",
		"restore-3/services/db/ibdata1":     "new-db",
		"restore-3/services/cache/dump.rdb": "new-cache",
		"services/redis/dump.rdb":           "old-redis", // the archive has no services/redis: a Clear swap
	} {
		path := filepath.Join(dir, file)
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	journal := restoreJournal{BackupID: 3, Phase: journalSwapping, Swaps: []restoreSwap{
		{Live: "data", New: "restore-3/data", Old: "restore-3/old/data", HadLive: true},
		{Live: "services/db", New: "restore-3/services/db", Old: "restore-3/old/services/db", HadLive: true},
		{Live: "services/cache", New: "restore-3/services/cache", Old: "restore-3/old/services/cache", HadLive: false},
		{Live: "services/redis", New: "restore-3/services/redis", Old: "restore-3/old/services/redis", HadLive: true, Clear: true},
	}}
	return dir, journal
}

func read(t *testing.T, file string) string {
	t.Helper()
	raw, err := os.ReadFile(file)
	if err != nil {
		return "<missing>"
	}
	return string(raw)
}

func TestSwapFolders(t *testing.T) {
	dir, journal := restoreFixture(t)
	if err := swapFolders(dir, journal.Swaps); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(dir, "data/world.dat")) != "new" || read(t, filepath.Join(dir, "services/db/ibdata1")) != "new-db" || read(t, filepath.Join(dir, "services/cache/dump.rdb")) != "new-cache" {
		t.Fatal("the restored folders are not in place")
	}
	if read(t, filepath.Join(dir, "restore-3/old/data/world.dat")) != "old" {
		t.Fatal("the old data was not kept aside")
	}
	if exists(filepath.Join(dir, "services/redis")) || read(t, filepath.Join(dir, "restore-3/old/services/redis/dump.rdb")) != "old-redis" {
		t.Fatal("a volume the backup has no copy of must move aside and not be replaced")
	}
}

func TestPlanSwaps(t *testing.T) {
	swaps := planSwaps("restore-4", []string{"data", "services/db", "services/gone"}, []string{"db", "redis"})
	var got []string
	for _, swap := range swaps {
		got = append(got, fmt.Sprintf("%s>%s clear=%v", swap.Live, swap.New, swap.Clear))
	}
	want := "data>restore-4/data clear=false,services/db>restore-4/services/db clear=false,services/redis>restore-4/services/redis clear=true"
	if strings.Join(got, ",") != want {
		t.Fatalf("swaps %q, want %q", strings.Join(got, ","), want)
	}
	dir := t.TempDir()
	for _, rel := range []string{"data", "services/db"} {
		if err := os.MkdirAll(filepath.Join(dir, rel), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	// services/redis has no live volume: nothing to clear.
	if kept := withLiveState(dir, swaps); len(kept) != 2 || !kept[0].HadLive || !kept[1].HadLive {
		t.Fatalf("withLiveState kept %+v", kept)
	}
}

// TestRollback interrupts the swap after every rename (as a crash would) and checks the rollback brings back the
// old folders, also when the rollback itself runs twice.
func TestRollback(t *testing.T) {
	type step func(dir string) error
	rename := func(from, to string) step {
		return func(dir string) error {
			if err := os.MkdirAll(filepath.Dir(filepath.Join(dir, to)), 0o700); err != nil {
				return err
			}
			return os.Rename(filepath.Join(dir, from), filepath.Join(dir, to))
		}
	}
	steps := []step{
		rename("data", "restore-3/old/data"),
		rename("restore-3/data", "data"),
		rename("services/db", "restore-3/old/services/db"),
		rename("restore-3/services/db", "services/db"),
		rename("restore-3/services/cache", "services/cache"),
		rename("services/redis", "restore-3/old/services/redis"),
	}
	for done := 0; done <= len(steps); done++ {
		dir, journal := restoreFixture(t)
		for _, s := range steps[:done] {
			if err := s(dir); err != nil {
				t.Fatal(err)
			}
		}
		for run := 0; run < 2; run++ {
			if err := rollbackSwaps(dir, journal); err != nil {
				t.Fatalf("after %d renames, rollback %d: %v", done, run, err)
			}
		}
		if got := read(t, filepath.Join(dir, "data/world.dat")); got != "old" {
			t.Fatalf("after %d renames: data is %q", done, got)
		}
		if got := read(t, filepath.Join(dir, "services/db/ibdata1")); got != "old-db" {
			t.Fatalf("after %d renames: db is %q", done, got)
		}
		if got := read(t, filepath.Join(dir, "services/redis/dump.rdb")); got != "old-redis" {
			t.Fatalf("after %d renames: cleared volume is %q", done, got)
		}
		if _, err := os.Lstat(filepath.Join(dir, "services/cache")); !os.IsNotExist(err) {
			t.Fatalf("after %d renames: a volume that didn't exist before is still there", done)
		}
	}
}

func TestRollbackRefusesPathsOutside(t *testing.T) {
	dir := t.TempDir()
	journal := restoreJournal{Swaps: []restoreSwap{{Live: "../etc", New: "restore-1/data", Old: "restore-1/old/data"}}}
	if err := rollbackSwaps(dir, journal); err == nil {
		t.Fatal("a journal path outside the server folder must be refused")
	}
}

// pauseDocker records the pause calls; other docker.Client methods are not used by the hooks.
type pauseDocker struct {
	docker.Client
	status   string
	pauseErr error
	calls    []string
}

func (d *pauseDocker) ContainerInspect(_ context.Context, name string) (docker.ContainerInfo, bool, error) {
	return docker.ContainerInfo{Name: name, Status: d.status, Running: d.status == "running" || d.status == "paused"}, true, nil
}

func (d *pauseDocker) ContainerPause(_ context.Context, name string) error {
	d.calls = append(d.calls, "pause "+name)
	return d.pauseErr
}

func (d *pauseDocker) ContainerUnpause(_ context.Context, name string) error {
	d.calls = append(d.calls, "unpause "+name)
	return nil
}

// consoleSink keeps console lines; the hooks only write to the console.
type consoleSink struct {
	Sink
	lines []string
}

func (c *consoleSink) Console(batch protocol.ConsoleBatch) {
	for _, line := range batch.Lines {
		c.lines = append(c.lines, line.Text)
	}
}

// TestServiceRootPause archives a service volume through backups.Create with the real hooks: a running service is
// paused for the walk and unpaused after it, also when the pause fails (the backup fails then); a stopped or
// already paused one is left alone.
func TestServiceRootPause(t *testing.T) {
	const id = "0b0b0b0b-0000-4000-8000-000000000002"
	cases := []struct {
		status   string
		pauseErr error
		want     string
		fails    bool
	}{
		{"running", nil, "pause gss-" + id + "-db,walk,unpause gss-" + id + "-db", false},
		{"running", errors.New("cgroup freezer unavailable"), "pause gss-" + id + "-db,unpause gss-" + id + "-db", true},
		{"exited", nil, "walk", false},
		{"paused", nil, "walk,unpause gss-" + id + "-db", false}, // left paused by an earlier backup
	}
	for _, tc := range cases {
		dir := t.TempDir()
		if err := os.WriteFile(filepath.Join(dir, "ibdata1"), []byte("db"), 0o600); err != nil {
			t.Fatal(err)
		}
		fake := &pauseDocker{status: tc.status, pauseErr: tc.pauseErr}
		m := &manager{opts: Options{Docker: fake, Sink: &consoleSink{}}}
		s := &server{id: id, m: m}
		root := m.serviceRoot(s, 9, "db", dir)
		before := root.Before
		root.Before = func(ctx context.Context) error {
			if err := before(ctx); err != nil {
				return err
			}
			fake.calls = append(fake.calls, "walk")
			return nil
		}
		_, err := backups.Create(context.Background(), &bytes.Buffer{}, backups.CreateOptions{Manifest: protocol.BackupManifest{Format: 1}, Roots: []backups.Root{root}})
		if (err != nil) != tc.fails {
			t.Fatalf("%s: error %v, want failure %v", tc.status, err, tc.fails)
		}
		if got := strings.Join(fake.calls, ","); got != tc.want {
			t.Fatalf("%s: calls %q, want %q", tc.status, got, tc.want)
		}
	}
}

// statusDocker answers inspect from a map of container statuses and records unpauses.
type statusDocker struct {
	docker.Client
	status   map[string]string
	unpaused []string
}

func (d *statusDocker) ContainerInspect(_ context.Context, name string) (docker.ContainerInfo, bool, error) {
	status, ok := d.status[name]
	return docker.ContainerInfo{Name: name, Status: status, Running: status == "running" || status == "paused"}, ok, nil
}

func (d *statusDocker) ContainerUnpause(_ context.Context, name string) error {
	d.unpaused = append(d.unpaused, name)
	return nil
}

// TestUnpauseServicesAtStartup: a service container left paused (a failed unpause, an agent killed mid-backup) is
// thawed at startup, whether or not a partial archive is left; running, stopped and missing ones are not touched.
func TestUnpauseServicesAtStartup(t *testing.T) {
	const id = "0b0b0b0b-0000-4000-8000-000000000003"
	fake := &statusDocker{status: map[string]string{
		"gss-" + id + "-db":    "paused",
		"gss-" + id + "-cache": "running",
		"gss-" + id + "-queue": "exited",
	}}
	m := &manager{opts: Options{Docker: fake}}
	s := &server{id: id, m: m, req: protocol.ProvisionRequest{Spec: protocol.ServerSpec{Services: map[string]protocol.ServiceSpec{
		"db": {Image: "mariadb:11"}, "cache": {Image: "redis:7"}, "queue": {Image: "x"}, "missing": {Image: "y"},
	}}}}
	m.unpauseServices(context.Background(), s)
	if strings.Join(fake.unpaused, ",") != "gss-"+id+"-db" {
		t.Fatalf("unpaused %v", fake.unpaused)
	}
}
