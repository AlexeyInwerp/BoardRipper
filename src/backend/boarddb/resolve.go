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

const boardQuery = `SELECT b.id, b.uuid, b.brand, b.model, b.model_number, b.board_number, b.board_name, b.odm, b.board_number_type, c.name AS color, b.source FROM boards b LEFT JOIN colors c ON b.color_id = c.id`

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

	// 1. Exact match
	if m := db.queryBoard(boardQuery+` WHERE upper(b.board_number) = ?`, upper); m != nil {
		return m
	}

	// 2. Prefix match (820-02016 matches 820-02016-A)
	if m := db.queryBoard(boardQuery+` WHERE upper(b.board_number) LIKE ? LIMIT 1`, upper+"-%"); m != nil {
		return m
	}

	// 3. Strip Apple revision suffix (820-02098-H → 820-02098%)
	if base := appleRevisionRe.FindStringSubmatch(upper); base != nil {
		if m := db.queryBoard(boardQuery+` WHERE upper(b.board_number) LIKE ? LIMIT 1`, base[1]+"%"); m != nil {
			return m
		}
	}

	// 4. Normalize LCFC no-hyphen format (NMD821 → NM-D821)
	if nm := nmNoHyphenRe.FindStringSubmatch(upper); nm != nil {
		normalized := "NM-" + nm[1]
		if m := db.queryBoard(boardQuery+` WHERE upper(b.board_number) = ?`, normalized); m != nil {
			return m
		}
	}

	// 5. Alias match
	var boardID int64
	err := db.reader.QueryRow(`SELECT board_id FROM board_aliases WHERE upper(alias_number) = ? LIMIT 1`, upper).Scan(&boardID)
	if err != nil {
		return nil
	}
	return db.queryBoard(boardQuery+` WHERE b.id = ?`, boardID)
}

// ResolveByAlias looks up a string directly against the board_aliases table.
func (db *DB) ResolveByAlias(alias string) *BoardMatch {
	if !db.Available() || alias == "" {
		return nil
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	upper := strings.ToUpper(strings.TrimSpace(alias))
	var boardID int64
	err := db.reader.QueryRow(`SELECT board_id FROM board_aliases WHERE upper(alias_number) = ? LIMIT 1`, upper).Scan(&boardID)
	if err != nil {
		return nil
	}
	return db.queryBoard(boardQuery+` WHERE b.id = ?`, boardID)
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
	var id int64
	m := &BoardMatch{}
	var model, modelNum, boardName, odm, boardType, color, source *string

	err := db.reader.QueryRow(query, args...).Scan(
		&id, &m.UUID, &m.Brand, &model, &modelNum, &m.BoardNumber, &boardName, &odm, &boardType, &color, &source,
	)
	if err != nil {
		return nil
	}
	if model != nil {
		m.Model = *model
	}
	if modelNum != nil {
		m.ModelNumber = *modelNum
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
	if color != nil {
		m.Color = *color
	}
	if source != nil {
		m.Source = *source
	}

	// Load aliases
	rows, _ := db.reader.Query("SELECT alias_number FROM board_aliases WHERE board_id = ?", id)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var a string
			rows.Scan(&a)
			m.Aliases = append(m.Aliases, a)
		}
	}

	// Load model aliases
	rows2, _ := db.reader.Query("SELECT model_name FROM model_aliases WHERE board_id = ?", id)
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
