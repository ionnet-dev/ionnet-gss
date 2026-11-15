package stacks

import (
	"context"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/paths"
	"github.com/ionnet-dev/ionnet-gss/agent/internal/protocol"
)

const serverID = "c3c3c3c3-0000-4000-8000-000000000001"

func network(id string) string { return "gss-" + id }

func TestValidate(t *testing.T) {
	good := map[string]protocol.ServiceSpec{"db": {Image: "mariadb:11.4", Env: map[string]string{"MARIADB_ROOT_PASSWORD": "x"}, Volume: "/var/lib/mysql"}}
	if err := Validate(good); err != nil {
		t.Fatal(err)
	}
	bad := []map[string]protocol.ServiceSpec{
		{"DB": {Image: "x"}},
		{"db-": {Image: "x"}},
		{"1db": {Image: "x"}},
		{"db": {Image: ""}},
		{"db": {Image: "x", Env: map[string]string{"A=B": "x"}}},
		{"db": {Image: "x", Volume: "relative"}},
		{"db": {Image: "x", Volume: "/"}},
		{"db": {Image: "x", Volume: "/a/../b"}},
		{"db": {Image: "x", Volume: "/a:ro"}},
		{"db": {Image: "x", Healthcheck: &protocol.ServiceHealthcheck{Command: " "}}},
		{"db": {Image: "x", Healthcheck: &protocol.ServiceHealthcheck{Command: "true", StartTimeout: MaxStartTimeout + 1}}},
		{"a": {Image: "x"}, "b": {Image: "x"}, "c": {Image: "x"}, "d": {Image: "x"}, "e": {Image: "x"}},
	}
	for i, services := range bad {
		if err := Validate(services); err == nil {
			t.Errorf("case %d was accepted: %+v", i, services)
		}
	}
}

func TestContainerSpec(t *testing.T) {
	s := New(paths.Layout{Root: "/srv/gss"}, nil, network).(*stack)
	spec := protocol.ServiceSpec{
		Image:       "mariadb:11.4",
		Env:         map[string]string{"MARIADB_DATABASE": "gmod"},
		Volume:      "/var/lib/mysql",
		Command:     "exec mariadbd --skip-name-resolve",
		Healthcheck: &protocol.ServiceHealthcheck{Command: "healthcheck.sh --connect"},
	}
	c := s.containerSpec(serverID, "db", spec, "hash")
	if c.Name != "gss-"+serverID+"-db" || c.Network != "gss-"+serverID || !slices.Equal(c.Aliases, []string{"db"}) {
		t.Fatalf("name/network/alias: %+v", c)
	}
	if len(c.Ports) != 0 || c.Restart != "no" || !slices.Equal(c.CapAdd, Capabilities) || c.User != "" {
		t.Fatalf("hardening: %+v", c)
	}
	if c.MemoryBytes != DefaultMemoryMB<<20 || c.NanoCPUs != DefaultCPUMillis*1_000_000 || c.PidsLimit != DefaultPids {
		t.Fatalf("default limits: %+v", c)
	}
	if !slices.Equal(c.Binds, []string{"/srv/gss/servers/" + serverID + "/services/db:/var/lib/mysql"}) {
		t.Fatalf("binds: %v", c.Binds)
	}
	if !slices.Equal(c.Cmd, []string{"/bin/sh", "-c", spec.Command}) || c.Labels[LabelService] != "db" || c.Labels[LabelServer] != serverID {
		t.Fatalf("cmd/labels: %+v", c)
	}
	if c.Healthcheck == nil || c.Healthcheck.Interval != DefaultInterval*time.Second || c.Healthcheck.Retries != DefaultRetries {
		t.Fatalf("healthcheck: %+v", c.Healthcheck)
	}
	spec.Limits = &protocol.ServiceLimits{MemoryMB: 1024, CPUMillis: 2000, Pids: 64}
	c = s.containerSpec(serverID, "db", spec, "hash")
	if c.MemoryBytes != 1024<<20 || c.NanoCPUs != 2_000_000_000 || c.PidsLimit != 64 {
		t.Fatalf("limits: %+v", c)
	}
	if s.specHash(serverID, "db", spec) == s.specHash(serverID, "db", protocol.ServiceSpec{Image: "mariadb:11.4"}) {
		t.Fatal("spec hash must change with the spec")
	}
}

func TestStateOf(t *testing.T) {
	cases := map[protocol.ServiceState]docker.ContainerInfo{
		protocol.ServiceStateStarting:  {Running: true, Health: "starting"},
		protocol.ServiceStateHealthy:   {Running: true, Health: "healthy"},
		protocol.ServiceStateUnhealthy: {Running: true, Health: "unhealthy"},
		protocol.ServiceStateRunning:   {Running: true},
		protocol.ServiceStateCreated:   {Status: "created"},
		protocol.ServiceStateExited:    {Status: "exited", ExitCode: 1},
	}
	for want, info := range cases {
		if got := stateOf(info); got != want {
			t.Errorf("%+v: %s, want %s", info, got, want)
		}
	}
}

// fakeDocker answers inspect from a fixed map; everything else panics.
type fakeDocker struct {
	docker.Client
	containers map[string]docker.ContainerInfo
	logs       string
}

func (f *fakeDocker) ContainerInspect(_ context.Context, name string) (docker.ContainerInfo, bool, error) {
	info, ok := f.containers[name]
	return info, ok, nil
}

func (f *fakeDocker) ContainerLogs(context.Context, string, int, int) (string, error) {
	return f.logs, nil
}

func TestStatusAndWait(t *testing.T) {
	fake := &fakeDocker{containers: map[string]docker.ContainerInfo{
		ContainerName(serverID, "db"):  {Running: true, Status: "running", Health: "unhealthy"},
		ContainerName(serverID, "old"): {Status: "exited", ExitCode: 137},
	}, logs: "ERROR 1045 Access denied\n"}
	s := New(paths.Layout{Root: "/srv/gss"}, fake, network).(*stack)
	list, err := s.Status(context.Background(), serverID, map[string]protocol.ServiceSpec{"db": {Image: "mariadb:11.4"}, "cache": {Image: "redis:7"}, "old": {Image: "x"}})
	if err != nil {
		t.Fatal(err)
	}
	if len(list) != 3 || list[0].Name != "cache" || list[0].State != protocol.ServiceStateMissing || list[1].State != protocol.ServiceStateUnhealthy || list[2].ExitCode == nil || *list[2].ExitCode != 137 {
		t.Fatalf("status: %+v", list)
	}
	if empty, _ := s.Status(context.Background(), serverID, nil); empty == nil {
		t.Fatal("status of no services must be an empty slice, not nil")
	}
	_, err = s.waitReady(context.Background(), serverID, "db", time.Now(), 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "did not become healthy within 2s (it is unhealthy)") || !strings.Contains(err.Error(), "Access denied") {
		t.Fatalf("wait error: %v", err)
	}
	_, err = s.waitReady(context.Background(), serverID, "old", time.Now().Add(time.Minute), time.Minute)
	if err == nil || !strings.Contains(err.Error(), "exited with code 137") {
		t.Fatalf("exit error: %v", err)
	}
}
