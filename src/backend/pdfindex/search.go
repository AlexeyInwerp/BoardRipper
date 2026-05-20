package pdfindex

import "strings"

type SearchHit struct {
	FileID  int64  `json:"file_id"`
	PageNum int    `json:"page_num"`
	Snippet string `json:"snippet"`
}

// SearchPages runs the FTS5 query. If restrictTo is non-empty, only those
// file_ids are considered (donor scope). No ATTACH — enrichment is separate.
//
func (db *DB) SearchPages(query string, restrictTo []int64, limit int) ([]SearchHit, error) {
	fts := buildFTS5Query(query)
	if fts == "" {
		return []SearchHit{}, nil
	}

	// Build the inner WHERE clause. For content= FTS5 tables the MATCH
	// predicate must reference the virtual table by name (not an alias), and
	// any extra filter is best expressed as an additional rowid restriction
	// via a correlated sub-select on pdf_pages.
	innerWhere := `pdf_text MATCH ?`
	args := []interface{}{fts}
	if len(restrictTo) > 0 {
		ph := make([]string, len(restrictTo))
		for i, id := range restrictTo {
			ph[i] = "?"
			args = append(args, id)
		}
		innerWhere += ` AND pdf_text.rowid IN (SELECT rowid FROM pdf_pages WHERE file_id IN (` +
			strings.Join(ph, ",") + `))`
	}
	args = append(args, limit)

	// snippet() must be called in the SELECT that has pdf_text in scope (the
	// MATCH query). We select it alongside the rowid from the FTS5 table, then
	// join to pdf_pages for file_id/page_num.
	q := `WITH ranked AS (
		SELECT pdf_text.rowid, rank, snippet(pdf_text, 0, '<b>', '</b>', '...', 32) AS snip
		FROM pdf_text WHERE ` + innerWhere + ` ORDER BY rank LIMIT ?
	)
	SELECT p.file_id, p.page_num, r.snip
	FROM ranked r JOIN pdf_pages p ON p.rowid = r.rowid
	ORDER BY r.rank`

	rows, err := db.reader.Query(q, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []SearchHit
	for rows.Next() {
		var h SearchHit
		if err := rows.Scan(&h.FileID, &h.PageNum, &h.Snippet); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	if out == nil {
		out = []SearchHit{}
	}
	return out, rows.Err()
}

// buildFTS5Query converts each whitespace-separated term to a quoted FTS5 term;
// implicit AND (space-separated quoted terms). Returns "" for blank input.
func buildFTS5Query(query string) string {
	terms := strings.Fields(query)
	quoted := make([]string, 0, len(terms))
	for _, t := range terms {
		t = strings.Trim(t, `"'`)
		if t == "" {
			continue
		}
		t = strings.ReplaceAll(t, `"`, `""`)
		quoted = append(quoted, `"`+t+`"`)
	}
	return strings.Join(quoted, " ")
}
