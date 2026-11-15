package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// SplitImageRef splits `registry/name:tag` into name and tag (`latest` when untagged). A digest reference
// (`name@sha256:…`) is returned whole with an empty tag.
func SplitImageRef(ref string) (name, tag string) {
	if strings.Contains(ref, "@") {
		return ref, ""
	}
	slash := strings.LastIndex(ref, "/")
	if colon := strings.LastIndex(ref, ":"); colon > slash {
		return ref[:colon], ref[colon+1:]
	}
	return ref, "latest"
}

func (c *unixClient) ImageExists(ctx context.Context, ref string) (bool, error) {
	err := c.call(ctx, http.MethodGet, "/images/"+ref+"/json", nil, nil, nil)
	if IsNotFound(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (c *unixClient) ImagePull(ctx context.Context, ref string, progress io.Writer) error {
	name, tag := SplitImageRef(ref)
	query := url.Values{"fromImage": {name}}
	if tag != "" {
		query.Set("tag", tag)
	}
	res, err := c.send(ctx, http.MethodPost, "/images/create", query, nil, "")
	if err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	defer res.Body.Close()
	if err := readStream(res.Body, progress); err != nil {
		return fmt.Errorf("pull %s: %w", ref, err)
	}
	return nil
}

func (c *unixClient) ImageBuild(ctx context.Context, tag, dockerfile string, progress io.Writer) error {
	var buildContext bytes.Buffer
	archive := tar.NewWriter(&buildContext)
	header := &tar.Header{Name: "Dockerfile", Mode: 0o644, Size: int64(len(dockerfile)), ModTime: time.Now()}
	if err := archive.WriteHeader(header); err != nil {
		return fmt.Errorf("build %s: %w", tag, err)
	}
	if _, err := io.WriteString(archive, dockerfile); err != nil {
		return fmt.Errorf("build %s: %w", tag, err)
	}
	if err := archive.Close(); err != nil {
		return fmt.Errorf("build %s: %w", tag, err)
	}
	query := url.Values{"t": {tag}, "rm": {"1"}, "forcerm": {"1"}}
	res, err := c.send(ctx, http.MethodPost, "/build", query, &buildContext, "application/x-tar")
	if err != nil {
		return fmt.Errorf("build %s: %w", tag, err)
	}
	defer res.Body.Close()
	if err := readStream(res.Body, progress); err != nil {
		return fmt.Errorf("build %s: %w", tag, err)
	}
	return nil
}
