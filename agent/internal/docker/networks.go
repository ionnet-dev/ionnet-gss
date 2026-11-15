package docker

import (
	"context"
	"fmt"
	"net/http"
)

// BridgeNameOption is the bridge driver option that names the network's host interface (at most 15 characters).
const BridgeNameOption = "com.docker.network.bridge.name"

// NetworkInfo is the subset of a network inspect the agent uses.
type NetworkInfo struct {
	ID string
	// Bridge is the host interface of a bridge network: the BridgeNameOption when set, else Docker's default
	// `br-<first 12 characters of the id>`.
	Bridge string
}

func (c *unixClient) NetworkEnsure(ctx context.Context, name string, labels, options map[string]string) (NetworkInfo, error) {
	info, ok, err := c.NetworkInspect(ctx, name)
	if err != nil || ok {
		return info, err
	}
	body := map[string]any{
		"Name":           name,
		"Driver":         "bridge",
		"CheckDuplicate": true,
		"Labels":         labels,
	}
	if len(options) > 0 {
		body["Options"] = options
	}
	var res struct {
		ID string `json:"Id"`
	}
	err = c.call(ctx, http.MethodPost, "/networks/create", nil, body, &res)
	if err != nil && !IsConflict(err) { // A conflict: created concurrently, use that one.
		return NetworkInfo{}, fmt.Errorf("create network %s: %w", name, err)
	}
	info, ok, err = c.NetworkInspect(ctx, name)
	if err == nil && !ok {
		err = fmt.Errorf("network %s vanished right after it was created", name)
	}
	return info, err
}

func (c *unixClient) NetworkInspect(ctx context.Context, name string) (NetworkInfo, bool, error) {
	var res struct {
		ID      string            `json:"Id"`
		Name    string            `json:"Name"`
		Options map[string]string `json:"Options"`
	}
	err := c.get(ctx, "/networks/"+name, &res)
	if IsNotFound(err) {
		return NetworkInfo{}, false, nil
	}
	if err != nil {
		return NetworkInfo{}, false, fmt.Errorf("inspect network %s: %w", name, err)
	}
	// GET /networks/{id} also matches id prefixes; only an exact name counts.
	if res.Name != name {
		return NetworkInfo{}, false, nil
	}
	bridge := res.Options[BridgeNameOption]
	if bridge == "" && len(res.ID) >= 12 {
		bridge = "br-" + res.ID[:12]
	}
	return NetworkInfo{ID: res.ID, Bridge: bridge}, true, nil
}

func (c *unixClient) NetworkRemove(ctx context.Context, name string) error {
	err := c.call(ctx, http.MethodDelete, "/networks/"+name, nil, nil, nil)
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("remove network %s: %w", name, err)
	}
	return nil
}
