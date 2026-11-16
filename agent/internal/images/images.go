// Package images resolves the image a game container runs (M3): the definition's image as is, or a derived image with
// the definition's `packages:` installed, built once per (base image, sorted package list) and cached.
package images

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
)

// PackageName is the only accepted package spelling (Debian names, optional :i386). Same rule as the panel's.
var PackageName = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{0,62}(:i386)?$`)

// MaxPackages bounds one derived image.
const MaxPackages = 50

// DerivedRepo is the local repository of derived images: ionnet-gss-derived:<hash16>, where hash16 is the first
// 16 hex characters of sha256(base image ID + "\n" + sorted packages joined by "\n"). Labels: ionnet-gss.derived-from
// (base ref), ionnet-gss.packages (comma list). Never pushed.
const DerivedRepo = "ionnet-gss-derived"

// Labels set on derived images (through the build API, never the Dockerfile).
const (
	LabelDerivedFrom = "ionnet-gss.derived-from" // value: the base image reference as the definition names it
	LabelBaseID      = "ionnet-gss.base-id"      // value: the base image id the derived image was built on
	LabelPackages    = "ionnet-gss.packages"     // value: the sorted package list, comma separated
)

// BuildTimeout bounds one derived build (apt-get update + install). It is shorter than protocol.ProvisionTimeoutSec,
// so a provision that waits for a build still answers in time.
const BuildTimeout = 10 * time.Minute

// pruneGrace keeps a derived image that Ensure returned recently: the container that uses it may not exist yet
// (internal/servers creates it right after Ensure).
const pruneGrace = 2 * time.Minute

// userPattern is what a base image's USER may look like to be copied into the generated Dockerfile: a user name or
// uid, optionally with a group name or gid.
var userPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9_.-]{0,31}(:[A-Za-z0-9_][A-Za-z0-9_.-]{0,31})?$`)

// Resolver returns the image ref to run for a spec.
type Resolver interface {
	// Ensure makes sure the image exists locally (pull only when missing) and, with packages, that the derived image is
	// built. Build output goes to progress as console lines (seq 0, stream system). The Dockerfile is generated, never
	// taken from the definition:
	//   FROM <base image ID>
	//   USER root
	//   RUN [ i386 in list ] dpkg --add-architecture i386; apt-get update && apt-get install -y --no-install-recommends
	//       <packages> && rm -rf /var/lib/apt/lists/*
	//   USER <the base image's user>
	// Concurrent calls for the same hash share one build. A failed build is not cached.
	Ensure(ctx context.Context, image string, packages []string, progress io.Writer) (ref string, err error)
	// Refresh pulls image even when it is on the host already, so a moved tag (java21, latest) brings the newer image
	// before an install. When the pull fails, an image already on the host is used as it is (a warning goes to
	// progress); without one the error is returned.
	Refresh(ctx context.Context, image string, progress io.Writer) error
	// Prune removes derived images no container uses any more (called after Delete).
	Prune(ctx context.Context) error
}

// NetworkFunc returns the network a build runs on, ready and filtered (the agent's restricted build network); an
// error fails the build.
type NetworkFunc func(ctx context.Context) (string, error)

// New returns the Resolver. Builds run on the network that network returns; nil = Docker's default bridge (tests).
func New(client docker.Client, network NetworkFunc) Resolver {
	return &resolver{docker: client, network: network, builds: map[string]*build{}, used: map[string]time.Time{}}
}

type resolver struct {
	docker  docker.Client
	network NetworkFunc

	mu     sync.Mutex
	builds map[string]*build    // tag → the build in progress
	used   map[string]time.Time // tag → when Ensure last returned it
}

// build is one derived build that every Ensure for the same tag waits for.
type build struct {
	done chan struct{}
	err  error
}

// ValidatePackages checks every name against PackageName and MaxPackages and returns the sorted, deduplicated list.
// A trailing `-` is refused too: apt-get reads `name-` as "remove name".
func ValidatePackages(packages []string) ([]string, error) {
	seen := map[string]bool{}
	out := make([]string, 0, len(packages))
	for _, name := range packages {
		if !PackageName.MatchString(name) || strings.HasSuffix(strings.TrimSuffix(name, ":i386"), "-") {
			return nil, fmt.Errorf("package %q is not a Debian package name (lowercase letters, digits, `+`, `-` and `.`, starting with a letter or digit, at most 63 characters, optionally with `:i386`)", name)
		}
		if !seen[name] {
			seen[name] = true
			out = append(out, name)
		}
	}
	if len(out) > MaxPackages {
		return nil, fmt.Errorf("%d packages are listed; a definition may install at most %d", len(out), MaxPackages)
	}
	sort.Strings(out)
	return out, nil
}

// DerivedTag is the derived image's reference for a base image id and a validated, sorted package list.
func DerivedTag(baseID string, packages []string) string {
	sum := sha256.Sum256([]byte(baseID + "\n" + strings.Join(packages, "\n")))
	return DerivedRepo + ":" + hex.EncodeToString(sum[:])[:16]
}

// Dockerfile is the generated build file. baseID must be an image id and packages validated; user is checked here.
func Dockerfile(baseID, user string, packages []string) (string, error) {
	if !strings.HasPrefix(baseID, "sha256:") || strings.ContainsAny(baseID, " \t\r\n") {
		return "", fmt.Errorf("base image id %q is not a sha256 id", baseID)
	}
	if user != "" && !userPattern.MatchString(user) {
		return "", fmt.Errorf("the base image's USER %q can't be carried over into a derived image; set a plain user or uid in the image", user)
	}
	var b strings.Builder
	fmt.Fprintf(&b, "FROM %s\nUSER root\nRUN ", baseID)
	for _, name := range packages {
		if strings.HasSuffix(name, ":i386") {
			b.WriteString("dpkg --add-architecture i386 && ")
			break
		}
	}
	fmt.Fprintf(&b, "apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends %s && rm -rf /var/lib/apt/lists/*\n", strings.Join(packages, " "))
	if user != "" {
		fmt.Fprintf(&b, "USER %s\n", user)
	}
	return b.String(), nil
}

func (r *resolver) Ensure(ctx context.Context, image string, packages []string, progress io.Writer) (string, error) {
	if progress == nil {
		progress = io.Discard
	}
	names, err := ValidatePackages(packages)
	if err != nil {
		return "", err
	}
	base, err := r.ensureBase(ctx, image, progress)
	if err != nil {
		return "", err
	}
	if len(names) == 0 {
		return image, nil
	}
	tag := DerivedTag(base.ID, names)
	for {
		_, exists, err := r.docker.ImageInspect(ctx, tag)
		if err != nil {
			return "", err
		}
		if exists {
			r.markUsed(tag)
			return tag, nil
		}

		r.mu.Lock()
		current := r.builds[tag]
		owner := current == nil
		if owner {
			current = &build{done: make(chan struct{})}
			r.builds[tag] = current
		}
		r.mu.Unlock()

		if owner {
			// Detached from the caller: a provision that gives up doesn't cancel a build another server waits for,
			// and the next attempt finds the finished image.
			go r.build(current, tag, image, base, names, progress)
		} else {
			fmt.Fprintf(progress, "Waiting for the build of %s (packages: %s) that is already running.\n", tag, strings.Join(names, ", "))
		}
		select {
		case <-current.done:
		case <-ctx.Done():
			return "", fmt.Errorf("gave up waiting for the derived image %s (it keeps building in the background): %w", tag, ctx.Err())
		}
		if current.err != nil {
			return "", current.err
		}
		// Built: the next round finds it (or, if it vanished meanwhile, builds again).
	}
}

func (r *resolver) Refresh(ctx context.Context, image string, progress io.Writer) error {
	if progress == nil {
		progress = io.Discard
	}
	if image == "" || strings.ContainsAny(image, " \t\r\n") {
		return fmt.Errorf("%q is not an image reference", image)
	}
	before, existed, err := r.docker.ImageInspect(ctx, image)
	if err != nil {
		return err
	}
	fmt.Fprintf(progress, "Checking for a newer %s...\n", image)
	if err := r.docker.ImagePull(ctx, image, nil); err != nil {
		if existed {
			// A pull that fails halfway can leave the tag on an image that never finished unpacking: point it back.
			if now, ok, inspectErr := r.docker.ImageInspect(ctx, image); inspectErr != nil || !ok || now.ID != before.ID {
				if tagErr := r.docker.ImageTag(ctx, before.ID, image); tagErr != nil {
					fmt.Fprintf(progress, "Could not pull %s (%v), and the copy on this host couldn't be restored: %v\n", image, err, tagErr)
					return fmt.Errorf("image %s could not be pulled, and the copy on this host couldn't be restored: %w", image, tagErr)
				}
			}
			fmt.Fprintf(progress, "Could not check for a newer %s (%v); using the one on this host.\n", image, err)
			slog.Warn("image refresh failed, using the local copy", "image", image, "error", err)
			return nil
		}
		fmt.Fprintf(progress, "Could not pull %s: %v\n", image, err)
		return fmt.Errorf("image %s is not on this host and could not be pulled (check the name and that the host can reach its registry): %w", image, err)
	}
	after, _, err := r.docker.ImageInspect(ctx, image)
	if err != nil {
		return err
	}
	if existed && after.ID == before.ID {
		fmt.Fprintf(progress, "%s is up to date.\n", image)
	} else {
		fmt.Fprintf(progress, "Pulled the newest %s.\n", image)
		slog.Info("pulled image", "image", image, "id", after.ID)
	}
	return nil
}

// ensureBase pulls the base image only when it is missing and returns its inspect.
func (r *resolver) ensureBase(ctx context.Context, image string, progress io.Writer) (docker.ImageInfo, error) {
	if image == "" || strings.ContainsAny(image, " \t\r\n") {
		return docker.ImageInfo{}, fmt.Errorf("%q is not an image reference", image)
	}
	info, exists, err := r.docker.ImageInspect(ctx, image)
	if err != nil {
		return docker.ImageInfo{}, err
	}
	if exists {
		return info, nil
	}
	fmt.Fprintf(progress, "Pulling %s (not on this host yet).\n", image)
	slog.Info("pulling image", "image", image)
	started := time.Now()
	if err := r.docker.ImagePull(ctx, image, nil); err != nil {
		fmt.Fprintf(progress, "Could not pull %s: %v\n", image, err)
		return docker.ImageInfo{}, fmt.Errorf("image %s is not on this host and could not be pulled (check the name and that the host can reach its registry): %w", image, err)
	}
	info, exists, err = r.docker.ImageInspect(ctx, image)
	if err != nil {
		return docker.ImageInfo{}, err
	}
	if !exists {
		return docker.ImageInfo{}, fmt.Errorf("image %s was pulled but is not on this host", image)
	}
	fmt.Fprintf(progress, "Pulled %s in %s.\n", image, time.Since(started).Round(time.Second))
	slog.Info("pulled image", "image", image)
	return info, nil
}

// build runs one derived build and publishes its result to everyone waiting for tag.
func (r *resolver) build(current *build, tag, image string, base docker.ImageInfo, packages []string, progress io.Writer) {
	defer func() {
		r.mu.Lock()
		delete(r.builds, tag) // A failed build is not cached: the next Ensure tries again.
		if current.err == nil {
			r.used[tag] = time.Now()
		}
		r.mu.Unlock()
		close(current.done)
	}()
	dockerfile, err := Dockerfile(base.ID, base.User, packages)
	if err != nil {
		current.err = err
		return
	}
	labels := map[string]string{
		LabelDerivedFrom: image,
		LabelBaseID:      base.ID,
		LabelPackages:    strings.Join(packages, ","),
	}
	fmt.Fprintf(progress, "Building %s from %s with packages: %s\n", tag, image, strings.Join(packages, ", "))
	slog.Info("building derived image", "image", tag, "base", image, "packages", strings.Join(packages, ","))
	ctx, cancel := context.WithTimeout(context.Background(), BuildTimeout)
	defer cancel()
	network := ""
	if r.network != nil {
		if network, err = r.network(ctx); err != nil {
			fmt.Fprintf(progress, "Building %s failed: %v\n", tag, err)
			current.err = fmt.Errorf("could not build the image with packages %s: %w", strings.Join(packages, ", "), err)
			return
		}
	}
	summary := newSummary(progress)
	started := time.Now()
	err = r.docker.ImageBuild(ctx, tag, dockerfile, labels, network, summary)
	summary.Close()
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			err = fmt.Errorf("the build took longer than %s", BuildTimeout)
		}
		summary.WriteTail()
		fmt.Fprintf(progress, "Building %s failed: %v\n", tag, err)
		slog.Warn("derived image build failed", "image", tag, "base", image, "error", err)
		current.err = fmt.Errorf("could not build the image with packages %s on top of %s (the console shows apt's output): %w", strings.Join(packages, ", "), image, err)
		return
	}
	fmt.Fprintf(progress, "Built %s in %s.\n", tag, time.Since(started).Round(time.Second))
	slog.Info("built derived image", "image", tag, "took", time.Since(started).Round(time.Second))
}

func (r *resolver) markUsed(tag string) {
	r.mu.Lock()
	r.used[tag] = time.Now()
	r.mu.Unlock()
}

func (r *resolver) Prune(ctx context.Context) error {
	list, err := r.docker.ImageList(ctx, DerivedRepo)
	if err != nil {
		return err
	}
	r.mu.Lock()
	keep := map[string]bool{}
	for tag := range r.builds {
		keep[tag] = true
	}
	for tag, at := range r.used {
		if time.Since(at) < pruneGrace {
			keep[tag] = true
		} else {
			delete(r.used, tag)
		}
	}
	r.mu.Unlock()

	var errs []error
	for _, image := range list {
		for _, tag := range image.Tags {
			if !strings.HasPrefix(tag, DerivedRepo+":") || keep[tag] {
				continue
			}
			// Docker refuses to remove an image a container uses, running or not: that is the "still used" check.
			err := r.docker.ImageRemove(ctx, tag)
			switch {
			case err == nil:
				slog.Info("removed unused derived image", "image", tag)
			case docker.IsConflict(err):
			default:
				errs = append(errs, err)
			}
		}
	}
	return errors.Join(errs...)
}

// summaryTail is how many lines of build output a failed build shows.
const summaryTail = 25

// summary forwards the readable milestones of a build (steps, packages being set up, apt errors) and keeps the last
// lines, which a failed build shows in full.
type summary struct {
	out     io.Writer
	partial []byte
	tail    []string
}

func newSummary(out io.Writer) *summary { return &summary{out: out} }

func (s *summary) Write(p []byte) (int, error) {
	s.partial = append(s.partial, p...)
	for {
		i := strings.IndexByte(string(s.partial), '\n')
		if i < 0 {
			break
		}
		s.line(string(s.partial[:i]))
		s.partial = s.partial[i+1:]
	}
	return len(p), nil
}

func (s *summary) line(text string) {
	text = strings.TrimRight(text, "\r")
	if strings.TrimSpace(text) == "" {
		return
	}
	s.tail = append(s.tail, text)
	if len(s.tail) > summaryTail {
		s.tail = s.tail[1:]
	}
	switch {
	case strings.HasPrefix(text, "Step "), strings.HasPrefix(text, "Setting up "), strings.HasPrefix(text, "E: "),
		strings.HasPrefix(text, "Successfully built"):
		fmt.Fprintln(s.out, text)
	}
}

// Close flushes a last line without a newline.
func (s *summary) Close() {
	if len(s.partial) > 0 {
		s.line(string(s.partial))
		s.partial = nil
	}
}

// WriteTail writes the kept last lines (after a failure).
func (s *summary) WriteTail() {
	if len(s.tail) == 0 {
		return
	}
	fmt.Fprintf(s.out, "Last %d lines of the build:\n", len(s.tail))
	for _, text := range s.tail {
		fmt.Fprintln(s.out, "  "+text)
	}
}
