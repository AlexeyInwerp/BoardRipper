package contribdb

import (
	"strings"

	"boardripper/databank"
)

// Config keys persisted in the databank.config table. Match the existing
// `sync_*` convention used by librarysync — single source of truth, no new
// config mechanism.
const (
	cfgEnabled    = "contribdb_enabled"     // "1" / "0"; default ON (handler-side default)
	cfgBaseURL    = "contribdb_base_url"    // optional override; falls back to env then DefaultBaseURL
	cfgCadence    = "contribdb_cadence"     // "daily" | "hourly" | "off" | "manual"
	cfgUserToken  = "contribdb_user_token"  // user-token bearer (Phase 3 link)
	cfgUserHandle = "contribdb_user_handle" // display name returned by /v1/contributions/mine probe
)

// LoadCadence reads the user-configured pull cadence. Returns "daily" when
// unset so a fresh install starts on a reasonable schedule.
func LoadCadence(db *databank.DB) string {
	if db == nil {
		return "daily"
	}
	v, _ := db.GetConfig(cfgCadence)
	v = strings.TrimSpace(v)
	switch v {
	case "daily", "hourly", "off", "manual":
		return v
	}
	return "daily"
}

// LoadEnabled reads the user-toggleable contribdb_enabled flag. Empty value
// means "default ON" (consistent with spec §6.7).
func LoadEnabled(db *databank.DB) bool {
	if db == nil {
		return false
	}
	v, _ := db.GetConfig(cfgEnabled)
	if v == "" {
		return true
	}
	return v == "1"
}
