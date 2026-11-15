package docker

import (
	"context"
	"fmt"
	"net/http"
)

func (c *unixClient) NetworkEnsure(ctx context.Context, name string, labels map[string]string) (string, error) {
	id, err := c.networkID(ctx, name)
	if err != nil || id != "" {
		return id, err
	}
	body := map[string]any{
		"Name":           name,
		"Driver":         "bridge",
		"CheckDuplicate": true,
		"Labels":         labels,
	}
	var res struct {
		ID string `json:"Id"`
	}
	err = c.call(ctx, http.MethodPost, "/networks/create", nil, body, &res)
	if IsConflict(err) { // Created concurrently: use that one.
		return c.networkID(ctx, name)
	}
	if err != nil {
		return "", fmt.Errorf("create network %s: %w", name, err)
	}
	return res.ID, nil
}

// networkID returns the network's id, or "" when it does not exist.
func (c *unixClient) networkID(ctx context.Context, name string) (string, error) {
	var res struct {
		ID   string `json:"Id"`
		Name string `json:"Name"`
	}
	err := c.get(ctx, "/networks/"+name, &res)
	if IsNotFound(err) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("inspect network %s: %w", name, err)
	}
	// GET /networks/{id} also matches id prefixes; only an exact name counts.
	if res.Name != name {
		return "", nil
	}
	return res.ID, nil
}

func (c *unixClient) NetworkRemove(ctx context.Context, name string) error {
	err := c.call(ctx, http.MethodDelete, "/networks/"+name, nil, nil, nil)
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("remove network %s: %w", name, err)
	}
	return nil
}
