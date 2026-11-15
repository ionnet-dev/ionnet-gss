package docker

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

// createBody is the subset of POST /containers/create the agent sends.
type createBody struct {
	Image            string              `json:"Image"`
	Entrypoint       []string            `json:"Entrypoint,omitempty"`
	Cmd              []string            `json:"Cmd,omitempty"`
	Env              []string            `json:"Env,omitempty"`
	Labels           map[string]string   `json:"Labels,omitempty"`
	User             string              `json:"User,omitempty"`
	Tty              bool                `json:"Tty"`
	ExposedPorts     map[string]struct{} `json:"ExposedPorts,omitempty"`
	HostConfig       hostConfig          `json:"HostConfig"`
	NetworkingConfig *networkingConfig   `json:"NetworkingConfig,omitempty"`
}

type hostConfig struct {
	Binds         []string                 `json:"Binds,omitempty"`
	PortBindings  map[string][]portBinding `json:"PortBindings,omitempty"`
	NetworkMode   string                   `json:"NetworkMode,omitempty"`
	RestartPolicy restartPolicy            `json:"RestartPolicy"`
	Memory        int64                    `json:"Memory,omitempty"`
	MemorySwap    int64                    `json:"MemorySwap,omitempty"`
	NanoCPUs      int64                    `json:"NanoCpus,omitempty"`
	PidsLimit     *int64                   `json:"PidsLimit,omitempty"`
	CapDrop       []string                 `json:"CapDrop"`
	CapAdd        []string                 `json:"CapAdd,omitempty"`
	SecurityOpt   []string                 `json:"SecurityOpt"`
	Init          bool                     `json:"Init"`
	LogConfig     logConfig                `json:"LogConfig"`
}

type logConfig struct {
	Type   string            `json:"Type"`
	Config map[string]string `json:"Config"`
}

// Log rotation for every container the agent creates.
var containerLogs = logConfig{Type: "json-file", Config: map[string]string{"max-size": "10m", "max-file": "3"}}

type portBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

type restartPolicy struct {
	Name string `json:"Name"`
}

type networkingConfig struct {
	EndpointsConfig map[string]endpointConfig `json:"EndpointsConfig"`
}

type endpointConfig struct {
	Aliases []string `json:"Aliases,omitempty"`
}

func (c *unixClient) ContainerCreate(ctx context.Context, spec ContainerSpec) (string, error) {
	restart := spec.Restart
	if restart == "" {
		restart = "no"
	}
	body := createBody{
		Image:      spec.Image,
		Entrypoint: spec.Entrypoint,
		Cmd:        spec.Cmd,
		Labels:     spec.Labels,
		User:       spec.User,
		Tty:        spec.Tty,
		HostConfig: hostConfig{
			Binds:         spec.Binds,
			NetworkMode:   spec.Network,
			RestartPolicy: restartPolicy{Name: restart},
			CapDrop:       []string{"ALL"},
			CapAdd:        spec.CapAdd,
			SecurityOpt:   []string{"no-new-privileges:true"},
			Init:          false, // gss-init is PID 1 itself.
			LogConfig:     containerLogs,
		},
	}
	keys := make([]string, 0, len(spec.Env))
	for key := range spec.Env {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		body.Env = append(body.Env, key+"="+spec.Env[key])
	}
	if spec.MemoryBytes > 0 {
		body.HostConfig.Memory = spec.MemoryBytes
		body.HostConfig.MemorySwap = spec.MemoryBytes // Same value = no swap on top of the limit.
	}
	if spec.NanoCPUs > 0 {
		body.HostConfig.NanoCPUs = spec.NanoCPUs
	}
	if spec.PidsLimit > 0 {
		body.HostConfig.PidsLimit = &spec.PidsLimit
	}
	if len(spec.Ports) > 0 {
		body.ExposedPorts = map[string]struct{}{}
		body.HostConfig.PortBindings = map[string][]portBinding{}
		for _, port := range spec.Ports {
			key := fmt.Sprintf("%d/%s", port.Port, port.Proto)
			body.ExposedPorts[key] = struct{}{}
			body.HostConfig.PortBindings[key] = []portBinding{{HostPort: strconv.Itoa(port.Port)}}
		}
	}
	if spec.Network != "" && spec.Network != "none" {
		body.NetworkingConfig = &networkingConfig{EndpointsConfig: map[string]endpointConfig{
			spec.Network: {Aliases: spec.Aliases},
		}}
	}

	var res struct {
		ID       string   `json:"Id"`
		Warnings []string `json:"Warnings"`
	}
	if err := c.call(ctx, http.MethodPost, "/containers/create", url.Values{"name": {spec.Name}}, body, &res); err != nil {
		return "", fmt.Errorf("create container %s: %w", spec.Name, err)
	}
	return res.ID, nil
}

func (c *unixClient) ContainerStart(ctx context.Context, name string) error {
	if err := c.call(ctx, http.MethodPost, "/containers/"+name+"/start", nil, nil, nil); err != nil {
		return fmt.Errorf("start container %s: %w", name, err)
	}
	return nil
}

func (c *unixClient) ContainerStop(ctx context.Context, name string, timeout time.Duration) error {
	seconds := int(math.Ceil(timeout.Seconds()))
	err := c.call(ctx, http.MethodPost, "/containers/"+name+"/stop", url.Values{"t": {strconv.Itoa(seconds)}}, nil, nil)
	if err != nil && !IsNotFound(err) {
		return fmt.Errorf("stop container %s: %w", name, err)
	}
	return nil
}

func (c *unixClient) ContainerRemove(ctx context.Context, name string) error {
	query := url.Values{"force": {"1"}, "v": {"1"}}
	err := c.call(ctx, http.MethodDelete, "/containers/"+name, query, nil, nil)
	if IsNotFound(err) {
		return nil
	}
	if IsConflict(err) && strings.Contains(err.Error(), "already in progress") {
		return nil
	}
	if err != nil {
		return fmt.Errorf("remove container %s: %w", name, err)
	}
	return nil
}

func (c *unixClient) ContainerWait(ctx context.Context, name string) (int, error) {
	var res struct {
		StatusCode int `json:"StatusCode"`
		Error      *struct {
			Message string `json:"Message"`
		} `json:"Error"`
	}
	if err := c.call(ctx, http.MethodPost, "/containers/"+name+"/wait", nil, nil, &res); err != nil {
		return 0, fmt.Errorf("wait for container %s: %w", name, err)
	}
	if res.Error != nil && res.Error.Message != "" {
		return res.StatusCode, fmt.Errorf("wait for container %s: %s", name, res.Error.Message)
	}
	return res.StatusCode, nil
}

func (c *unixClient) ContainerInspect(ctx context.Context, name string) (ContainerInfo, bool, error) {
	var res struct {
		ID     string `json:"Id"`
		Name   string `json:"Name"`
		Config struct {
			Image  string            `json:"Image"`
			Labels map[string]string `json:"Labels"`
		} `json:"Config"`
		State struct {
			Status    string `json:"Status"`
			Running   bool   `json:"Running"`
			ExitCode  int    `json:"ExitCode"`
			StartedAt string `json:"StartedAt"`
		} `json:"State"`
	}
	err := c.get(ctx, "/containers/"+name+"/json", &res)
	if IsNotFound(err) {
		return ContainerInfo{}, false, nil
	}
	if err != nil {
		return ContainerInfo{}, false, fmt.Errorf("inspect container %s: %w", name, err)
	}
	return ContainerInfo{
		ID:        res.ID,
		Name:      strings.TrimPrefix(res.Name, "/"),
		Image:     res.Config.Image,
		Labels:    res.Config.Labels,
		Running:   res.State.Running,
		ExitCode:  res.State.ExitCode,
		Status:    res.State.Status,
		StartedAt: res.State.StartedAt,
	}, true, nil
}

func (c *unixClient) ContainerList(ctx context.Context, label string) ([]ContainerInfo, error) {
	filters, err := json.Marshal(map[string][]string{"label": {label}})
	if err != nil {
		return nil, err
	}
	var res []struct {
		ID     string            `json:"Id"`
		Names  []string          `json:"Names"`
		Image  string            `json:"Image"`
		Labels map[string]string `json:"Labels"`
		State  string            `json:"State"`
	}
	query := url.Values{"all": {"1"}, "filters": {string(filters)}}
	if err := c.call(ctx, http.MethodGet, "/containers/json", query, nil, &res); err != nil {
		return nil, fmt.Errorf("list containers: %w", err)
	}
	out := make([]ContainerInfo, 0, len(res))
	for _, item := range res {
		info := ContainerInfo{ID: item.ID, Image: item.Image, Labels: item.Labels, Status: item.State, Running: item.State == "running"}
		if len(item.Names) > 0 {
			info.Name = strings.TrimPrefix(item.Names[0], "/")
		}
		out = append(out, info)
	}
	return out, nil
}

func (c *unixClient) ContainerStats(ctx context.Context, name string) (Stats, error) {
	type cpuStats struct {
		CPUUsage struct {
			TotalUsage  uint64   `json:"total_usage"`
			PercpuUsage []uint64 `json:"percpu_usage"`
		} `json:"cpu_usage"`
		SystemUsage uint64 `json:"system_cpu_usage"`
		OnlineCPUs  uint64 `json:"online_cpus"`
	}
	var res struct {
		CPUStats    cpuStats `json:"cpu_stats"`
		PreCPUStats cpuStats `json:"precpu_stats"`
		MemoryStats struct {
			Usage int64            `json:"usage"`
			Limit int64            `json:"limit"`
			Stats map[string]int64 `json:"stats"`
		} `json:"memory_stats"`
		PidsStats struct {
			Current int64 `json:"current"`
		} `json:"pids_stats"`
		Networks map[string]struct {
			RxBytes int64 `json:"rx_bytes"`
			TxBytes int64 `json:"tx_bytes"`
		} `json:"networks"`
	}
	if err := c.call(ctx, http.MethodGet, "/containers/"+name+"/stats", url.Values{"stream": {"false"}}, nil, &res); err != nil {
		return Stats{}, fmt.Errorf("stats of container %s: %w", name, err)
	}

	var out Stats
	cpuDelta := float64(res.CPUStats.CPUUsage.TotalUsage) - float64(res.PreCPUStats.CPUUsage.TotalUsage)
	systemDelta := float64(res.CPUStats.SystemUsage) - float64(res.PreCPUStats.SystemUsage)
	cpus := float64(res.CPUStats.OnlineCPUs)
	if cpus == 0 {
		cpus = float64(len(res.CPUStats.CPUUsage.PercpuUsage))
	}
	if cpuDelta > 0 && systemDelta > 0 {
		out.CPUPercent = cpuDelta / systemDelta * cpus * 100
	}
	// Like `docker stats`: page cache that can be reclaimed is not counted (cgroup v2 inactive_file, v1
	// total_inactive_file).
	cache := res.MemoryStats.Stats["inactive_file"]
	if v1, ok := res.MemoryStats.Stats["total_inactive_file"]; ok {
		cache = v1
	}
	out.MemoryBytes = max(res.MemoryStats.Usage-cache, 0)
	out.MemoryLimitBytes = res.MemoryStats.Limit
	out.Pids = res.PidsStats.Current
	for _, network := range res.Networks {
		out.NetRxBytes += network.RxBytes
		out.NetTxBytes += network.TxBytes
	}
	return out, nil
}
