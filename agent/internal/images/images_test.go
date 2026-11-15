package images

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
)

func TestValidatePackages(t *testing.T) {
	got, err := ValidatePackages([]string{"jq", "lib32gcc-s1:i386", "jq", "g++", "libstdc++6"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(got, ",") != "g++,jq,lib32gcc-s1:i386,libstdc++6" {
		t.Fatalf("sorted and deduped: %v", got)
	}
	for _, bad := range []string{"", "-rf", "Jq", "jq;rm", "jq bash", "jq:amd64", "jq-", "a/b", "jq=1.6", "$(id)", "jq\n", strings.Repeat("a", 64)} {
		if _, err := ValidatePackages([]string{bad}); err == nil {
			t.Errorf("%q was accepted", bad)
		}
	}
	many := make([]string, MaxPackages+1)
	for i := range many {
		many[i] = "pkg" + strings.Repeat("x", i)
	}
	if _, err := ValidatePackages(many); err == nil {
		t.Error("more than MaxPackages were accepted")
	}
}

func TestDerivedTagAndDockerfile(t *testing.T) {
	a := DerivedTag("sha256:aaa", []string{"curl", "jq"})
	if a != DerivedTag("sha256:aaa", []string{"curl", "jq"}) || len(a) != len(DerivedRepo)+1+16 {
		t.Fatalf("tag not stable or wrong length: %s", a)
	}
	if a == DerivedTag("sha256:bbb", []string{"curl", "jq"}) || a == DerivedTag("sha256:aaa", []string{"jq"}) {
		t.Fatal("tag must change with the base id and the package list")
	}
	file, err := Dockerfile("sha256:aaa", "1000:1000", []string{"jq", "lib32gcc-s1:i386"})
	if err != nil {
		t.Fatal(err)
	}
	want := "FROM sha256:aaa\nUSER root\nRUN dpkg --add-architecture i386 && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends jq lib32gcc-s1:i386 && rm -rf /var/lib/apt/lists/*\nUSER 1000:1000\n"
	if file != want {
		t.Fatalf("Dockerfile:\n%s\nwant:\n%s", file, want)
	}
	if file, _ := Dockerfile("sha256:aaa", "", []string{"jq"}); strings.Contains(file, "i386") || strings.Count(file, "USER") != 1 {
		t.Fatalf("root base image: %s", file)
	}
	for _, user := range []string{"root\nRUN id", "a b", "x:y:z"} {
		if _, err := Dockerfile("sha256:aaa", user, []string{"jq"}); err == nil {
			t.Errorf("user %q was accepted", user)
		}
	}
	if _, err := Dockerfile("debian:12\nRUN id", "", []string{"jq"}); err == nil {
		t.Error("a base that isn't an id was accepted")
	}
}

func TestSummary(t *testing.T) {
	var out bytes.Buffer
	s := newSummary(&out)
	_, _ = io.WriteString(s, "Step 1/3 : FROM sha256:aaa\n ---> aaa\nGet:1 http://deb.debian.org bookworm InRelease\nSetting up jq (1.6)")
	_, _ = io.WriteString(s, " ...\nE: Unable to locate package nope\n")
	s.Close()
	if out.String() != "Step 1/3 : FROM sha256:aaa\nSetting up jq (1.6) ...\nE: Unable to locate package nope\n" {
		t.Fatalf("summary: %q", out.String())
	}
	out.Reset()
	s.WriteTail()
	if !strings.Contains(out.String(), "Get:1 http://deb.debian.org") {
		t.Fatalf("tail: %q", out.String())
	}
}

// fakeDocker is the part of the Docker client the resolver uses; everything else panics.
type fakeDocker struct {
	docker.Client
	mu      sync.Mutex
	images  map[string]docker.ImageInfo
	builds  atomic.Int32
	fail    bool
	gate    chan struct{}
	removed []string
	inUse   map[string]bool
}

func (f *fakeDocker) ImageInspect(_ context.Context, ref string) (docker.ImageInfo, bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	info, ok := f.images[ref]
	return info, ok, nil
}

func (f *fakeDocker) ImageBuild(_ context.Context, tag, dockerfile string, labels map[string]string, _ string, progress io.Writer) error {
	f.builds.Add(1)
	if f.gate != nil {
		<-f.gate
	}
	_, _ = io.WriteString(progress, "Step 1/3 : FROM x\nSetting up jq\n")
	if f.fail {
		return errors.New("The command returned a non-zero code: 100")
	}
	if !strings.HasPrefix(dockerfile, "FROM sha256:base\n") || labels[LabelPackages] != "jq" {
		return errors.New("unexpected build input")
	}
	f.mu.Lock()
	f.images[tag] = docker.ImageInfo{ID: "sha256:" + tag, Tags: []string{tag}}
	f.mu.Unlock()
	return nil
}

func (f *fakeDocker) ImageList(context.Context, string) ([]docker.ImageInfo, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	var out []docker.ImageInfo
	for ref, info := range f.images {
		if strings.HasPrefix(ref, DerivedRepo+":") {
			out = append(out, info)
		}
	}
	return out, nil
}

func (f *fakeDocker) ImageRemove(_ context.Context, ref string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.inUse[ref] {
		return &docker.APIError{Method: "DELETE", Path: "/images/" + ref, Status: 409, Message: "image is being used"}
	}
	delete(f.images, ref)
	f.removed = append(f.removed, ref)
	return nil
}

func newFake() *fakeDocker {
	return &fakeDocker{images: map[string]docker.ImageInfo{"base:1": {ID: "sha256:base"}}, inUse: map[string]bool{}}
}

func TestEnsureSharesOneBuild(t *testing.T) {
	fake := newFake()
	fake.gate = make(chan struct{})
	r := New(fake, nil)
	var wg sync.WaitGroup
	refs := make([]string, 3)
	errs := make([]error, 3)
	for i := range refs {
		wg.Add(1)
		go func() {
			defer wg.Done()
			refs[i], errs[i] = r.Ensure(context.Background(), "base:1", []string{"jq"}, io.Discard)
		}()
	}
	time.Sleep(50 * time.Millisecond)
	close(fake.gate)
	wg.Wait()
	for i := range refs {
		if errs[i] != nil || refs[i] != DerivedTag("sha256:base", []string{"jq"}) {
			t.Fatalf("caller %d: %q %v", i, refs[i], errs[i])
		}
	}
	if n := fake.builds.Load(); n != 1 {
		t.Fatalf("%d builds, want 1", n)
	}
	if ref, err := r.Ensure(context.Background(), "base:1", nil, nil); err != nil || ref != "base:1" {
		t.Fatalf("no packages: %q %v", ref, err)
	}
}

func TestFailedBuildIsNotCached(t *testing.T) {
	fake := newFake()
	fake.fail = true
	r := New(fake, nil)
	var out bytes.Buffer
	if _, err := r.Ensure(context.Background(), "base:1", []string{"jq"}, &out); err == nil {
		t.Fatal("a failed build succeeded")
	}
	if !strings.Contains(out.String(), "Last 2 lines of the build") {
		t.Fatalf("no tail in the progress: %q", out.String())
	}
	fake.fail = false
	if _, err := r.Ensure(context.Background(), "base:1", []string{"jq"}, nil); err != nil {
		t.Fatal(err)
	}
	if n := fake.builds.Load(); n != 2 {
		t.Fatalf("%d builds, want 2", n)
	}
}

func TestPrune(t *testing.T) {
	fake := newFake()
	fake.images[DerivedRepo+":old"] = docker.ImageInfo{Tags: []string{DerivedRepo + ":old"}}
	fake.images[DerivedRepo+":used"] = docker.ImageInfo{Tags: []string{DerivedRepo + ":used"}}
	fake.inUse[DerivedRepo+":used"] = true
	r := New(fake, nil)
	fresh, err := r.Ensure(context.Background(), "base:1", []string{"jq"}, nil)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Prune(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Join(fake.removed, ",") != DerivedRepo+":old" {
		t.Fatalf("removed %v; the in-use and the just built (%s) images must stay", fake.removed, fresh)
	}
}
