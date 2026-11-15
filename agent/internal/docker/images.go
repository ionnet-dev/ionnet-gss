package docker

import (
	"archive/tar"
	"bytes"
	"context"
	"encoding/json"
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

func (c *unixClient) ImageInspect(ctx context.Context, ref string) (ImageInfo, bool, error) {
	var res struct {
		ID       string   `json:"Id"`
		RepoTags []string `json:"RepoTags"`
		Config   struct {
			User   string            `json:"User"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
	}
	err := c.get(ctx, "/images/"+ref+"/json", &res)
	if IsNotFound(err) {
		return ImageInfo{}, false, nil
	}
	if err != nil {
		return ImageInfo{}, false, fmt.Errorf("inspect image %s: %w", ref, err)
	}
	return ImageInfo{ID: res.ID, Tags: res.RepoTags, User: res.Config.User, Labels: res.Config.Labels}, true, nil
}

func (c *unixClient) ImageList(ctx context.Context, reference string) ([]ImageInfo, error) {
	filters, err := json.Marshal(map[string][]string{"reference": {reference}})
	if err != nil {
		return nil, err
	}
	var res []struct {
		ID       string            `json:"Id"`
		RepoTags []string          `json:"RepoTags"`
		Labels   map[string]string `json:"Labels"`
	}
	if err := c.call(ctx, http.MethodGet, "/images/json", url.Values{"filters": {string(filters)}}, nil, &res); err != nil {
		return nil, fmt.Errorf("list images: %w", err)
	}
	out := make([]ImageInfo, 0, len(res))
	for _, item := range res {
		out = append(out, ImageInfo{ID: item.ID, Tags: item.RepoTags, Labels: item.Labels})
	}
	return out, nil
}

func (c *unixClient) ImageRemove(ctx context.Context, ref string) error {
	err := c.call(ctx, http.MethodDelete, "/images/"+ref, nil, nil, nil)
	if IsNotFound(err) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove image %s: %w", ref, err)
	}
	return nil
}

func (c *unixClient) ImageBuild(ctx context.Context, tag, dockerfile string, labels map[string]string, network string, progress io.Writer) error {
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
	// The classic builder (API version 1): the Dockerfile only uses FROM, USER and RUN, and FROM names a local image
	// id, so nothing is pulled.
	query := url.Values{"t": {tag}, "rm": {"1"}, "forcerm": {"1"}, "pull": {"0"}}
	if network != "" {
		query.Set("networkmode", network)
	}
	if len(labels) > 0 {
		raw, err := json.Marshal(labels)
		if err != nil {
			return fmt.Errorf("build %s: encode labels: %w", tag, err)
		}
		query.Set("labels", string(raw))
	}
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
