package store

import "time"

// nowUTC returns the current time as an RFC3339 string with a Z suffix.
// All timestamps in the canonical DB and in API responses use this format
// (spec §9 invariant #7).
func nowUTC() string {
	return time.Now().UTC().Format(time.RFC3339)
}
