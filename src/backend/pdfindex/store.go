package pdfindex

import (
	"errors"
	"database/sql"
	"time"
)

// StatusRow mirrors pdf_index_status.
type StatusRow struct {
	FileID      int64  `json:"file_id"`
	Status      string `json:"status"` // pending|indexing|indexed|empty|failed
	Source      string `json:"source"`
	PageCount   int    `json:"page_count"`
	AttemptedAt int64  `json:"attempted_at"`
	IndexedAt   int64  `json:"indexed_at"`
	Error       string `json:"error"`
}

// Page is one extracted page (text > 0 chars only).
type Page struct {
	Num  int
	Text string
}

// Claim atomically transitions a file to 'indexing' iff it has no row or is
// pending/failed. Returns true if THIS caller won the claim.
// Uses RowsAffected() from the same Exec — never a separate SELECT changes().
func (db *DB) Claim(fileID int64, source string) (bool, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	now := time.Now().Unix()
	res, err := db.writer.Exec(
		`INSERT INTO pdf_index_status(file_id, status, source, attempted_at)
		 VALUES(?, 'indexing', ?, ?)
		 ON CONFLICT(file_id) DO UPDATE SET
		   status='indexing', source=excluded.source, attempted_at=excluded.attempted_at
		 WHERE pdf_index_status.status IN ('pending','failed')`,
		fileID, source, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return false, err
	}
	return n == 1, nil
}

// Heartbeat refreshes attempted_at so the watchdog won't reclaim a live job.
func (db *DB) Heartbeat(fileID int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.writer.Exec(
		`UPDATE pdf_index_status SET attempted_at = ? WHERE file_id = ?`,
		time.Now().Unix(), fileID)
	return err
}

// UpsertPages inserts/updates page text. ON CONFLICT DO UPDATE (NOT REPLACE) so
// the FTS5 _au trigger runs, never _ad+_ai (which can desync external content).
func (db *DB) UpsertPages(fileID int64, pages []Page) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, p := range pages {
		if p.Text == "" {
			continue
		}
		if _, err := tx.Exec(
			`INSERT INTO pdf_pages(file_id, page_num, text_content)
			 VALUES(?, ?, ?)
			 ON CONFLICT(file_id, page_num) DO UPDATE SET text_content = excluded.text_content`,
			fileID, p.Num, p.Text); err != nil {
			return err
		}
	}
	if _, err := tx.Exec(
		`UPDATE pdf_index_status SET attempted_at = ? WHERE file_id = ?`,
		time.Now().Unix(), fileID); err != nil {
		return err
	}
	return tx.Commit()
}

// Finalize sets terminal status by counting stored pages.
func (db *DB) Finalize(fileID int64) (StatusRow, error) {
	db.mu.Lock()
	var n int
	if err := db.writer.QueryRow(
		`SELECT COUNT(*) FROM pdf_pages WHERE file_id = ?`, fileID).Scan(&n); err != nil {
		db.mu.Unlock()
		return StatusRow{}, err
	}
	status := "indexed"
	if n == 0 {
		status = "empty"
	}
	_, err := db.writer.Exec(
		`UPDATE pdf_index_status SET status = ?, page_count = ?, indexed_at = ? WHERE file_id = ?`,
		status, n, time.Now().Unix(), fileID)
	db.mu.Unlock()
	if err != nil {
		return StatusRow{}, err
	}
	return db.Status(fileID)
}

// MarkDuplicate records fileID as a non-canonical duplicate of canonicalID:
// terminal status 'duplicate', no pages extracted. Search resolves its hits
// via the canonical. Works whether or not a row already exists.
func (db *DB) MarkDuplicate(fileID, canonicalID int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	now := time.Now().Unix()
	_, err := db.writer.Exec(
		`INSERT INTO pdf_index_status(file_id, status, source, page_count, attempted_at, indexed_at, canonical_file_id)
		 VALUES(?, 'duplicate', 'dedup', 0, ?, ?, ?)
		 ON CONFLICT(file_id) DO UPDATE SET
		   status='duplicate', source='dedup', page_count=0,
		   canonical_file_id=excluded.canonical_file_id, indexed_at=excluded.indexed_at`,
		fileID, now, now, canonicalID)
	return err
}

// Fail marks the file failed with an error message (retryable on next claim).
func (db *DB) Fail(fileID int64, msg string) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.writer.Exec(
		`UPDATE pdf_index_status SET status='failed', error=?, attempted_at=? WHERE file_id=?`,
		msg, time.Now().Unix(), fileID)
	return err
}

type Stats struct {
	Indexed  int `json:"indexed"`
	Empty    int `json:"empty"`
	Failed   int `json:"failed"`
	Pending  int `json:"pending"`
	Indexing int `json:"indexing"`
	Pages    int `json:"pages"`
}

func (db *DB) Stats() (Stats, error) {
	var s Stats
	err := db.reader.QueryRow(`
		SELECT
			COALESCE(SUM(CASE WHEN status='indexed'  THEN 1 ELSE 0 END),0),
			COALESCE(SUM(CASE WHEN status='empty'    THEN 1 ELSE 0 END),0),
			COALESCE(SUM(CASE WHEN status='failed'   THEN 1 ELSE 0 END),0),
			COALESCE(SUM(CASE WHEN status='pending'  THEN 1 ELSE 0 END),0),
			COALESCE(SUM(CASE WHEN status='indexing' THEN 1 ELSE 0 END),0)
		FROM pdf_index_status`).
		Scan(&s.Indexed, &s.Empty, &s.Failed, &s.Pending, &s.Indexing)
	if err != nil {
		return s, err
	}
	if err := db.reader.QueryRow(`SELECT COUNT(*) FROM pdf_pages`).Scan(&s.Pages); err != nil {
		return s, err
	}
	return s, nil
}

func (db *DB) DeleteFile(fileID int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	if _, err := db.writer.Exec(`DELETE FROM pdf_pages WHERE file_id = ?`, fileID); err != nil {
		return err
	}
	_, err := db.writer.Exec(`DELETE FROM pdf_index_status WHERE file_id = ?`, fileID)
	return err
}

// ResetAll wipes ALL extracted PDF text and index status so extraction can be
// re-run from scratch. Donors/bindings (in databank.db) are untouched.
//
// It DROPs the content + FTS tables and triggers rather than DELETEing rows:
// the pdf_pages AD trigger re-tokenises every row's text to remove its FTS
// terms, so a row-by-row DELETE of a large index takes minutes. DROP is O(1).
// createSchema() then recreates everything empty (idempotent).
func (db *DB) ResetAll() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	stmts := []string{
		`DROP TRIGGER IF EXISTS pdf_pages_ai`,
		`DROP TRIGGER IF EXISTS pdf_pages_ad`,
		`DROP TRIGGER IF EXISTS pdf_pages_au`,
		`DROP TABLE IF EXISTS pdf_text`,
		`DROP TABLE IF EXISTS pdf_pages`,
		`DELETE FROM pdf_index_status`,
	}
	for _, s := range stmts {
		if _, err := db.writer.Exec(s); err != nil {
			return err
		}
	}
	return db.createSchema()
}

func (db *DB) ListFailed() ([]StatusRow, error) {
	rows, err := db.reader.Query(
		`SELECT file_id, status, COALESCE(error,'') FROM pdf_index_status WHERE status='failed'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []StatusRow
	for rows.Next() {
		var r StatusRow
		if err := rows.Scan(&r.FileID, &r.Status, &r.Error); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ResetForReindex sets matching rows to 'pending'. scope ∈ {"all","failed","empty"}.
func (db *DB) ResetForReindex(scope string) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	q := `UPDATE pdf_index_status SET status='pending'`
	switch scope {
	case "failed":
		q += ` WHERE status='failed'`
	case "empty":
		q += ` WHERE status='empty'`
	case "all", "":
		q += ` WHERE status IN ('indexed','empty','failed')`
	}
	res, err := db.writer.Exec(q)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// DoneOrActiveFileIDs returns file_ids whose status is terminal-or-active
// (indexed|empty|duplicate|indexing) — the set the sweep should SKIP. Used to
// pre-filter the work list so Progress.Total reflects only pending work.
// 'duplicate' is terminal (resolved via its canonical), so it is skipped too.
func (db *DB) DoneOrActiveFileIDs() (map[int64]bool, error) {
	rows, err := db.reader.Query(`SELECT file_id FROM pdf_index_status WHERE status IN ('indexed','empty','duplicate','indexing')`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := make(map[int64]bool)
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out[id] = true
	}
	return out, rows.Err()
}

// ReclaimStale flips 'indexing' rows whose last heartbeat (attempted_at) is
// older than maxAgeSeconds back to 'pending'. Returns count reclaimed.
func (db *DB) ReclaimStale(maxAgeSeconds int64) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()
	cutoff := time.Now().Unix() - maxAgeSeconds
	res, err := db.writer.Exec(
		`UPDATE pdf_index_status SET status='pending'
		 WHERE status='indexing' AND attempted_at < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// Status returns the row, or a zero row with Status="" if absent.
func (db *DB) Status(fileID int64) (StatusRow, error) {
	var s StatusRow
	var indexedAt, attemptedAt *int64
	var source, errMsg *string
	err := db.reader.QueryRow(
		`SELECT file_id, status, source, page_count, attempted_at, indexed_at, error
		 FROM pdf_index_status WHERE file_id = ?`, fileID).
		Scan(&s.FileID, &s.Status, &source, &s.PageCount, &attemptedAt, &indexedAt, &errMsg)
	if err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return StatusRow{FileID: fileID}, nil
		}
		return StatusRow{}, err
	}
	if source != nil {
		s.Source = *source
	}
	if attemptedAt != nil {
		s.AttemptedAt = *attemptedAt
	}
	if indexedAt != nil {
		s.IndexedAt = *indexedAt
	}
	if errMsg != nil {
		s.Error = *errMsg
	}
	return s, nil
}
