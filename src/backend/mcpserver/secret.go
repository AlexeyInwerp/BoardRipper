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
