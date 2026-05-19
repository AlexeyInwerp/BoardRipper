package store

import "fmt"

// FieldAllowlist is the canonical mapping of (target_type → writable fields).
// Hard-coded per spec §9 invariant #8: this is the single source of truth.
// The OpenAPI document is generated from this map so API consumers see the
// same set the server enforces. Adding a new writable field requires a code
// change here AND a corresponding write path in store/contribs.go.
//
// entity_color is special: target_uuid is the compound "scope_type:scope_uuid"
// and target_field is always "color_id".
var FieldAllowlist = map[string]map[string]bool{
	"brand": {
		"notes": true,
	},
	"family": {
		"name":  true,
		"notes": true,
	},
	"model": {
		"display_name": true,
		"notes":        true,
	},
	"board": {
		"odm":         true,
		"board_name":  true,
		"notes":       true,
		"source":      true,
		"source_url":  true,
	},
	"entity_color": {
		"color_id": true,
	},
	// board_alias / model_alias: insert/delete-only via dedicated future fields.
	// Phase 2: not exposed.
}

// tableColForField maps (target_type, target_field) to the canonical SQL
// (table_name, column_name) pair used by direct reads + accept-apply.
//
// Validates against FieldAllowlist; returns an error if (type, field) is not
// writable. The caller MUST do this lookup; it is the choke point that
// guarantees no rogue patch hits an off-allowlist column.
func tableColForField(targetType, field string) (table, col string, err error) {
	fields, ok := FieldAllowlist[targetType]
	if !ok {
		return "", "", fmt.Errorf("unknown target_type: %q", targetType)
	}
	if !fields[field] {
		return "", "", fmt.Errorf("field_not_writable: %s.%s", targetType, field)
	}
	switch targetType {
	case "brand":
		return "brands", field, nil
	case "family":
		return "families", field, nil
	case "model":
		return "models", field, nil
	case "board":
		return "boards", field, nil
	case "entity_color":
		// Column lookup goes through EntityFieldValue's special path; the
		// generic tableCol can't reach the compound primary key.
		return "entity_color", field, nil
	}
	return "", "", fmt.Errorf("unhandled target_type: %q", targetType)
}

// IsFieldWritable is the public façade for the API layer to short-circuit
// invalid (type, field) combos before opening a transaction.
func IsFieldWritable(targetType, field string) bool {
	fields, ok := FieldAllowlist[targetType]
	if !ok {
		return false
	}
	return fields[field]
}
