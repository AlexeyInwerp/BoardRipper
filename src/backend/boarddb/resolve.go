package boarddb

import (
	"regexp"
	"strings"
)

// appleRevisionRe strips the revision suffix from Apple board numbers:
// 820-02098-H → 820-02098, 820-02935-05 → 820-02935
var appleRevisionRe = regexp.MustCompile(`^(820-\d{4,5})-[A-Z0-9]+$`)

// nmNoHyphenRe normalizes LCFC board numbers without hyphens: NMD821 → NM-D821
var nmNoHyphenRe = regexp.MustCompile(`^NM([A-Z]\d{3,4})$`)

const boardQuery = `
SELECT
    b.uuid AS board_uuid,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type,
    b.source,
    m.uuid AS model_uuid,
    m.model_number,
    m.display_name AS model_display,
    f.name AS family_name,
    br.name AS brand_name,
    c.name AS color_name,
    c.hex AS color_hex
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
LEFT JOIN entity_color ec_b  ON ec_b.scope_type='board'  AND ec_b.scope_uuid = b.uuid
LEFT JOIN entity_color ec_m  ON ec_m.scope_type='model'  AND ec_m.scope_uuid = m.uuid
LEFT JOIN entity_color ec_f  ON ec_f.scope_type='family' AND ec_f.scope_uuid = f.uuid
LEFT JOIN entity_color ec_br ON ec_br.scope_type='brand' AND ec_br.scope_uuid = br.uuid
LEFT JOIN colors c
    ON c.id = COALESCE(ec_b.color_id, ec_m.color_id, ec_f.color_id, ec_br.color_id)
`

// Resolve looks up a board number in the reference database.
// Checks: exact → prefix → base number (strip revision) → alias.
// Returns nil if not found.
func (db *DB) Resolve(boardNumber string) *BoardMatch {
	if !db.Available() {
		return nil
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	upper := strings.ToUpper(strings.TrimSpace(boardNumber))
	if upper == "" {
		return nil
	}

	// 1. Exact match on canonical board_number
	if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) = ?", upper); m != nil {
		return m
	}

	// 2. Prefix match (820-02016 matches 820-02016-A)
	if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) LIKE ? LIMIT 1", upper+"-%"); m != nil {
		return m
	}

	// 3. Strip Apple revision suffix (820-02098-H → 820-02098%)
	if base := appleRevisionRe.FindStringSubmatch(upper); base != nil {
		if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) LIKE ? LIMIT 1", base[1]+"%"); m != nil {
			return m
		}
	}

	// 4. Normalize LCFC no-hyphen format (NMD821 → NM-D821)
	if nm := nmNoHyphenRe.FindStringSubmatch(upper); nm != nil {
		normalized := "NM-" + nm[1]
		if m := db.queryBoard(boardQuery+" WHERE upper(b.board_number) = ?", normalized); m != nil {
			return m
		}
	}

	// 5. Alias match (board_aliases is now keyed by board_uuid)
	var boardUUID string
	err := db.reader.QueryRow(
		"SELECT board_uuid FROM board_aliases WHERE upper(alias) = ? LIMIT 1",
		upper,
	).Scan(&boardUUID)
	if err != nil {
		return nil
	}
	return db.queryBoard(boardQuery+" WHERE b.uuid = ?", boardUUID)
}

// ResolveByAlias looks up a string directly against the board_aliases table.
func (db *DB) ResolveByAlias(alias string) *BoardMatch {
	if !db.Available() || alias == "" {
		return nil
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	upper := strings.ToUpper(strings.TrimSpace(alias))
	var boardUUID string
	err := db.reader.QueryRow(
		"SELECT board_uuid FROM board_aliases WHERE upper(alias) = ? LIMIT 1",
		upper,
	).Scan(&boardUUID)
	if err != nil {
		return nil
	}
	return db.queryBoard(boardQuery+" WHERE b.uuid = ?", boardUUID)
}

// ResolveFilename extracts board numbers from a filename and resolves the best match.
// Returns the extracted numbers, the best match (if any), and the ODM from the pattern.
func (db *DB) ResolveFilename(filename string) ([]ExtractedNumber, *BoardMatch) {
	extracted := ExtractBoardNumbers(filename)
	if len(extracted) == 0 || !db.Available() {
		return extracted, nil
	}

	for _, e := range extracted {
		match := db.Resolve(e.Number)
		if match != nil {
			return extracted, match
		}
	}
	return extracted, nil
}

func (db *DB) queryBoard(query string, args ...any) *BoardMatch {
	m := &BoardMatch{}
	var modelUUID string
	var boardName, odm, boardType, source, modelNumber, modelDisplay, color, colorHex *string

	err := db.reader.QueryRow(query, args...).Scan(
		&m.UUID,
		&m.BoardNumber,
		&boardName,
		&odm,
		&boardType,
		&source,
		&modelUUID,
		&modelNumber,
		&modelDisplay,
		&m.Family,
		&m.Brand,
		&color,
		&colorHex,
	)
	if err != nil {
		return nil
	}
	if boardName != nil {
		m.BoardName = *boardName
	}
	if odm != nil {
		m.ODM = *odm
	}
	if boardType != nil {
		m.Type = *boardType
	}
	if source != nil {
		m.Source = *source
	}
	if modelNumber != nil {
		m.ModelNumber = *modelNumber
	}
	if modelDisplay != nil {
		m.Model = *modelDisplay
	}
	if color != nil {
		m.Color = *color
	}
	if colorHex != nil {
		m.ColorHex = *colorHex
	}

	// Load board aliases (now keyed by board_uuid)
	rows, _ := db.reader.Query("SELECT alias FROM board_aliases WHERE board_uuid = ?", m.UUID)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var a string
			rows.Scan(&a)
			m.Aliases = append(m.Aliases, a)
		}
	}

	// Load model aliases (semantic fix: keyed by model_uuid, deduplicated)
	rows2, _ := db.reader.Query("SELECT alias FROM model_aliases WHERE model_uuid = ?", modelUUID)
	if rows2 != nil {
		defer rows2.Close()
		for rows2.Next() {
			var a string
			rows2.Scan(&a)
			m.ModelAliases = append(m.ModelAliases, a)
		}
	}
	return m
}
