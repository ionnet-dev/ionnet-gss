// Package images resolves the image a game container runs (M3): the definition's image as is, or a derived image with
// the definition's `packages:` installed, built once per (base image, sorted package list) and cached.
package images

import (
	"context"
	"errors"
	"io"
	"regexp"

	"github.com/ionnet-dev/ionnet-gss/agent/internal/docker"
)

// ErrNotImplemented marks skeleton functions.
var ErrNotImplemented = errors.New("images: not implemented")

// PackageName is the only accepted package spelling (Debian names, optional :i386). Same rule as the panel's.
var PackageName = regexp.MustCompile(`^[a-z0-9][a-z0-9+.-]{0,62}(:i386)?$`)

// MaxPackages bounds one derived image.
const MaxPackages = 50

// DerivedRepo is the local repository of derived images: ionnet-gss-derived:<hash16>, where hash16 is the first
// 16 hex characters of sha256(base image ID + "\n" + sorted packages joined by "\n"). Labels: ionnet-gss.derived-from
// (base ref), ionnet-gss.packages (comma list). Never pushed.
const DerivedRepo = "ionnet-gss-derived"

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
	// Prune removes derived images no container uses any more (called after Delete).
	Prune(ctx context.Context) error
}

// New returns the Resolver.
func New(client docker.Client) Resolver {
	return &resolver{docker: client}
}

type resolver struct {
	docker docker.Client
}

func (r *resolver) Ensure(ctx context.Context, image string, packages []string, progress io.Writer) (string, error) {
	return "", ErrNotImplemented // TODO(builder): B
}

func (r *resolver) Prune(ctx context.Context) error {
	return ErrNotImplemented // TODO(builder): B
}
