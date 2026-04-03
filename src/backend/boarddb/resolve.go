package boarddb

import "strings"

// Resolve looks up a board number in the reference database.
// Checks: exact match → prefix match (820-02016 → 820-02016-A) → alias match.
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

	// 1. Exact match (case-insensitive)
	m := db.queryBoard(`SELECT id, brand, model, model_number, board_number, board_name, odm, board_number_type, source FROM boards WHERE upper(board_number) = ?`, upper)
	if m != nil {
		return m
	}

	// 2. Prefix match (820-02016 matches 820-02016-A)
	m = db.queryBoard(`SELECT id, brand, model, model_number, board_number, board_name, odm, board_number_type, source FROM boards WHERE upper(board_number) LIKE ? LIMIT 1`, upper+"-%")
	if m != nil {
		return m
	}

	// 3. Alias match
	var boardID int64
	err := db.reader.QueryRow(`SELECT board_id FROM board_aliases WHERE upper(alias_number) = ? LIMIT 1`, upper).Scan(&boardID)
	if err != nil {
		return nil
	}
	return db.queryBoard(`SELECT id, brand, model, model_number, board_number, board_name, odm, board_number_type, source FROM boards WHERE id = ?`, boardID)
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
	var model, modelNum, boardName, odm, boardType, source *string

	err := db.reader.QueryRow(query, args...).Scan(
		&id, &m.Brand, &model, &modelNum, &m.BoardNumber, &boardName, &odm, &boardType, &source,
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
