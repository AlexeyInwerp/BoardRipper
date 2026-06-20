package mcpserver

// ConfigReader is the subset of *databank.DB the MCP server needs. GetConfig
// returns ("", nil) for missing keys (matches databank.DB.GetConfig).
type ConfigReader interface {
	GetConfig(key string) (string, error)
}

// State exposes live feature flags backed by the config table. Flags are read
// on every access so the Settings toggles take effect without a restart.
type State struct{ cfg ConfigReader }

func NewState(cfg ConfigReader) *State { return &State{cfg: cfg} }

func (s *State) flag(key string) bool {
	if s == nil || s.cfg == nil {
		return false
	}
	v, err := s.cfg.GetConfig(key)
	if err != nil {
		return false
	}
	return v == "1" || v == "true"
}

// Enabled reports whether the MCP server should serve requests.
func (s *State) Enabled() bool { return s.flag("mcp_enabled") }

// DriveUI reports whether mutating drive-UI tools may act.
func (s *State) DriveUI() bool { return s.flag("mcp_drive_ui") }

// AuthMode reports the configured auth scheme: "oauth" or "token" (default).
func (s *State) AuthMode() string {
	if s == nil || s.cfg == nil {
		return "token"
	}
	if v, _ := s.cfg.GetConfig("mcp_auth_mode"); v == "oauth" {
		return "oauth"
	}
	return "token"
}
