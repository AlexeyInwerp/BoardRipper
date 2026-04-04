package updater

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

const dockerSocket = "/var/run/docker.sock"

// isDockerAvailable checks if the Docker socket exists and is usable.
func isDockerAvailable() bool {
	info, err := os.Stat(dockerSocket)
	if err != nil {
		return false
	}
	// Must be a socket
	return info.Mode()&os.ModeSocket != 0
}

// dockerClient returns an HTTP client that talks to the Docker Engine API via Unix socket.
func dockerClient() *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", dockerSocket)
			},
		},
		Timeout: 30 * time.Second,
	}
}

// dockerLoad loads a tar.gz image into Docker via the Engine API (no CLI needed).
func dockerLoad(tarPath string) error {
	f, err := os.Open(tarPath)
	if err != nil {
		return err
	}
	defer f.Close()

	gz, err := gzip.NewReader(f)
	if err != nil {
		return fmt.Errorf("gzip decompress failed: %w", err)
	}
	defer gz.Close()

	// POST /images/load with the raw tar stream
	client := &http.Client{
		Transport: &http.Transport{
			DialContext: func(_ context.Context, _, _ string) (net.Conn, error) {
				return net.Dial("unix", dockerSocket)
			},
		},
		Timeout: 10 * time.Minute,
	}
	req, _ := http.NewRequest("POST", "http://docker/v1.41/images/load", gz)
	req.Header.Set("Content-Type", "application/x-tar")
	resp, err := client.Do(req)
	if err != nil {
		return fmt.Errorf("docker image load failed: %w", err)
	}
	defer resp.Body.Close()
	io.Copy(io.Discard, resp.Body) // drain response

	if resp.StatusCode != 200 {
		return fmt.Errorf("docker image load returned %d", resp.StatusCode)
	}
	return nil
}

// containerInfo holds the subset of Docker container inspect data we need.
type containerInfo struct {
	ID      string
	Name    string
	Image   string
	Env     []string
	Mounts  []mount
	Ports   map[string][]portBinding
	Restart string
}

type mount struct {
	Source      string `json:"Source"`
	Destination string `json:"Destination"`
	RW          bool   `json:"RW"`
}

type portBinding struct {
	HostIP   string `json:"HostIp"`
	HostPort string `json:"HostPort"`
}

// findSelfContainer finds the current BoardRipper container by matching hostname to container ID.
func findSelfContainer() (*containerInfo, error) {
	client := dockerClient()

	hostname, err := os.Hostname()
	if err != nil {
		return nil, fmt.Errorf("cannot get hostname: %w", err)
	}

	// List all containers, find ours by hostname (Docker sets hostname = short container ID)
	resp, err := client.Get("http://docker/v1.41/containers/json?all=true")
	if err != nil {
		return nil, fmt.Errorf("Docker API error: %w", err)
	}
	defer resp.Body.Close()

	var containers []struct {
		ID    string   `json:"Id"`
		Names []string `json:"Names"`
		Image string   `json:"Image"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&containers); err != nil {
		return nil, fmt.Errorf("failed to parse container list: %w", err)
	}

	var containerID string
	for _, c := range containers {
		if strings.HasPrefix(c.ID, hostname) {
			containerID = c.ID
			break
		}
	}
	if containerID == "" {
		return nil, fmt.Errorf("cannot find own container (hostname=%s)", hostname)
	}

	// Inspect the container for full config
	resp2, err := client.Get(fmt.Sprintf("http://docker/v1.41/containers/%s/json", containerID))
	if err != nil {
		return nil, fmt.Errorf("container inspect failed: %w", err)
	}
	defer resp2.Body.Close()

	var inspect struct {
		ID     string `json:"Id"`
		Name   string `json:"Name"`
		Config struct {
			Image string   `json:"Image"`
			Env   []string `json:"Env"`
		} `json:"Config"`
		HostConfig struct {
			Binds       []string                       `json:"Binds"`
			PortBindings map[string][]portBinding       `json:"PortBindings"`
			RestartPolicy struct {
				Name string `json:"Name"`
			} `json:"RestartPolicy"`
		} `json:"HostConfig"`
		Mounts []mount `json:"Mounts"`
	}
	if err := json.NewDecoder(resp2.Body).Decode(&inspect); err != nil {
		return nil, fmt.Errorf("failed to parse container inspect: %w", err)
	}

	return &containerInfo{
		ID:      inspect.ID,
		Name:    strings.TrimPrefix(inspect.Name, "/"),
		Image:   inspect.Config.Image,
		Env:     inspect.Config.Env,
		Mounts:  inspect.Mounts,
		Ports:   inspect.HostConfig.PortBindings,
		Restart: inspect.HostConfig.RestartPolicy.Name,
	}, nil
}

// orchestrateRestart stops the current container, creates a new one with the updated image,
// and starts it. On failure, it attempts to restart the old container.
func orchestrateRestart(newVersion string, logFn func(string, string)) error {
	self, err := findSelfContainer()
	if err != nil {
		return fmt.Errorf("cannot identify self: %w", err)
	}

	logFn(fmt.Sprintf("Found container: %s (image: %s)", self.Name, self.Image), "info")

	newImage := fmt.Sprintf("boardripper:%s", newVersion)

	client := dockerClient()

	// Build the create body from existing config, but with the new image
	createBody := map[string]interface{}{
		"Image":    newImage,
		"Env":      self.Env,
		"Hostname": "",
		"HostConfig": map[string]interface{}{
			"Binds":         bindsFromMounts(self.Mounts),
			"PortBindings":  self.Ports,
			"RestartPolicy": map[string]string{"Name": self.Restart},
		},
	}

	bodyJSON, _ := json.Marshal(createBody)

	// Stop current container
	logFn("Stopping current container...", "info")
	stopReq, _ := http.NewRequest("POST",
		fmt.Sprintf("http://docker/v1.41/containers/%s/stop?t=10", self.ID), nil)
	if resp, err := client.Do(stopReq); err == nil {
		resp.Body.Close()
	}

	// Rename current container to -old
	oldName := self.Name + "-old"
	logFn(fmt.Sprintf("Renaming %s → %s", self.Name, oldName), "info")

	// Delete any existing -old container first
	delReq, _ := http.NewRequest("DELETE",
		fmt.Sprintf("http://docker/v1.41/containers/%s?force=true", oldName), nil)
	if resp, err := client.Do(delReq); err == nil {
		resp.Body.Close()
	}

	renameReq, _ := http.NewRequest("POST",
		fmt.Sprintf("http://docker/v1.41/containers/%s/rename?name=%s", self.ID, oldName), nil)
	if resp, err := client.Do(renameReq); err == nil {
		resp.Body.Close()
	}

	// Create new container with same name + new image
	logFn(fmt.Sprintf("Creating new container: %s (image: %s)", self.Name, newImage), "info")
	createReq, _ := http.NewRequest("POST",
		fmt.Sprintf("http://docker/v1.41/containers/create?name=%s", self.Name),
		bytes.NewReader(bodyJSON))
	createReq.Header.Set("Content-Type", "application/json")
	createResp, err := client.Do(createReq)
	if err != nil {
		logFn("Container create failed — rolling back", "error")
		rollback(client, self.ID, self.Name)
		return fmt.Errorf("create failed: %w", err)
	}
	defer createResp.Body.Close()

	if createResp.StatusCode != 201 {
		respBody, _ := io.ReadAll(io.LimitReader(createResp.Body, 512))
		logFn(fmt.Sprintf("Create returned %d: %s — rolling back", createResp.StatusCode, string(respBody)), "error")
		rollback(client, self.ID, self.Name)
		return fmt.Errorf("create returned %d", createResp.StatusCode)
	}

	var created struct {
		ID string `json:"Id"`
	}
	json.NewDecoder(createResp.Body).Decode(&created)

	// Start new container
	logFn("Starting new container...", "info")
	startReq, _ := http.NewRequest("POST",
		fmt.Sprintf("http://docker/v1.41/containers/%s/start", created.ID), nil)
	startResp, err := client.Do(startReq)
	if err != nil {
		logFn("Start failed — rolling back", "error")
		// Remove new container, rollback old
		delNew, _ := http.NewRequest("DELETE",
			fmt.Sprintf("http://docker/v1.41/containers/%s?force=true", created.ID), nil)
		if resp, err := client.Do(delNew); err == nil {
			resp.Body.Close()
		}
		rollback(client, self.ID, self.Name)
		return fmt.Errorf("start failed: %w", err)
	}
	startResp.Body.Close()

	if startResp.StatusCode != 204 && startResp.StatusCode != 304 {
		logFn(fmt.Sprintf("Start returned %d — rolling back", startResp.StatusCode), "error")
		delNew, _ := http.NewRequest("DELETE",
			fmt.Sprintf("http://docker/v1.41/containers/%s?force=true", created.ID), nil)
		if resp, err := client.Do(delNew); err == nil {
			resp.Body.Close()
		}
		rollback(client, self.ID, self.Name)
		return fmt.Errorf("start returned %d", startResp.StatusCode)
	}

	logFn("New container started successfully", "info")

	// Clean up old container (non-blocking)
	go func() {
		time.Sleep(10 * time.Second)
		delOld, _ := http.NewRequest("DELETE",
			fmt.Sprintf("http://docker/v1.41/containers/%s?force=true", self.ID), nil)
		if resp, err := client.Do(delOld); err == nil {
			resp.Body.Close()
		}
	}()

	return nil
}

// rollback restores the old container name and restarts it.
func rollback(client *http.Client, oldID, originalName string) {
	// Rename back
	renameReq, _ := http.NewRequest("POST",
		fmt.Sprintf("http://docker/v1.41/containers/%s/rename?name=%s", oldID, originalName), nil)
	if resp, err := client.Do(renameReq); err == nil {
		resp.Body.Close()
	}
	// Start old container
	startReq, _ := http.NewRequest("POST",
		fmt.Sprintf("http://docker/v1.41/containers/%s/start", oldID), nil)
	if resp, err := client.Do(startReq); err == nil {
		resp.Body.Close()
	}
}

// bindsFromMounts converts Docker mount objects to bind strings.
func bindsFromMounts(mounts []mount) []string {
	var binds []string
	for _, m := range mounts {
		b := m.Source + ":" + m.Destination
		if !m.RW {
			b += ":ro"
		}
		binds = append(binds, b)
	}
	return binds
}
