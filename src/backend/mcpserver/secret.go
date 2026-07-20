// Package mcpserver hosts BoardRipper's Model Context Protocol (MCP) server and
// the WebSocket bridge that proxies live-board tools to the open browser tab.
//
// The MCP server is off by default; it is enabled via Settings > Integrations
// (config keys mcp_enabled / mcp_drive_ui). When enabled it serves Streamable
// HTTP at /api/mcp gated by a per-install bearer secret. Live-board tools fan a
// request over /api/mcp/bridge to the focused browser page, which answers from
// the in-memory BoardData or drives the existing stores.
package mcpserver

import (
	"crypto/rand"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const secretFile = ".mcp-secret"

// EnsureSecret loads, or generates and persists, the per-install MCP bearer
// secret at <dataDir>/.mcp-secret (mode 0600). Mirrors updater.EnsureSecret.
func EnsureSecret(dataDir string) (string, error) {
	p := filepath.Join(dataDir, secretFile)
	if b, err := os.ReadFile(p); err == nil {
		if s := strings.TrimSpace(string(b)); len(s) >= 32 {
			return s, nil
		}
	}
	return writeSecret(p)
}

// RotateSecret forces a new secret, overwriting any existing file.
func RotateSecret(dataDir string) (string, error) {
	return writeSecret(filepath.Join(dataDir, secretFile))
}

// secretResetMarker records that the one-time install-token reset for the
// per-browser session-separation update has run. Bump the suffix if a future
// update needs another forced reset.
const secretResetMarker = ".mcp-secret-reset-v1"

// ResetSecretOnce invalidates the pre-separation install token exactly once
// per install: on the first boot after the update, an existing .mcp-secret is
// rotated (logging out every agent still configured with the old shared
// token), and a marker file prevents any repeat. A fresh install just gets
// the marker — there is nobody to log out. Returns whether a rotation
// actually happened so the caller can log it.
func ResetSecretOnce(dataDir string) (bool, error) {
	marker := filepath.Join(dataDir, secretResetMarker)
	if _, err := os.Stat(marker); err == nil {
		return false, nil // already reset
	} else if !os.IsNotExist(err) {
		return false, err
	}
	_, hadSecret := readExistingSecret(dataDir)
	if hadSecret {
		if _, err := RotateSecret(dataDir); err != nil {
			return false, err
		}
	}
	if err := os.WriteFile(marker, []byte(time.Now().UTC().Format(time.RFC3339)+"\n"), 0o600); err != nil {
		return false, err
	}
	return hadSecret, nil
}

// readExistingSecret reports whether a valid persisted secret already exists
// (mirrors EnsureSecret's validity rule without minting one).
func readExistingSecret(dataDir string) (string, bool) {
	b, err := os.ReadFile(filepath.Join(dataDir, secretFile))
	if err != nil {
		return "", false
	}
	s := strings.TrimSpace(string(b))
	return s, len(s) >= 32
}

func writeSecret(p string) (string, error) {
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	s := hex.EncodeToString(buf)
	if err := os.WriteFile(p, []byte(s), 0o600); err != nil {
		return "", err
	}
	return s, nil
}
