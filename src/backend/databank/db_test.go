package databank

import (
	"path/filepath"
	"testing"
	"time"
)

// insertTestFile writes a row directly into `files` so migration tests can
// stage state without going through the scanner.
func insertTestFile(t *testing.T, db *DB, path, filename, fileType string) int64 {
	t.Helper()
	res, err := db.writer.Exec(
		`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time)
		 VALUES (?, ?, ?, ?, 0, ?, ?)`,
		path, filename, "."+fileType, fileType, time.Now().Unix(), time.Now().Unix(),
	)
	if err != nil {
		t.Fatalf("insert file %q: %v", path, err)
	}
	id, _ := res.LastInsertId()
	return id
}

func TestMigrateV9_PrunesStaleAutoBindings(t *testing.T) {
	tmpDir := t.TempDir()
	db, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer db.Close()

	// Stage files: a board, a few candidate PDFs in same + different folders.
	boardID := insertTestFile(t, db, "MacBookA/820-02016.bvr", "820-02016.bvr", "board")
	otherBoardID := insertTestFile(t, db, "MacBookB/NM-E231 Boardview.tvw", "NM-E231 Boardview.tvw", "board")
	legitPdfID := insertTestFile(t, db, "MacBookA/820-02016.pdf", "820-02016.pdf", "pdf") // exact (100), same folder
	junkPdfID := insertTestFile(t, db, "MacBookA/1.pdf", "1.pdf", "pdf")                  // junk basename
	purePagePdfID := insertTestFile(t, db, "MacBookA/1234.pdf", "1234.pdf", "pdf")        // pure-digit
	crossFolderWeakID := insertTestFile(t, db, "Other/something_with_2016_in_it.pdf", "something_with_2016_in_it.pdf", "pdf")

	// Stage bindings as the OLD scanner would have produced them — all
	// auto_matched. The test asserts V9 deletes the junk + weak cross-folder
	// pairs and preserves the legit same-folder strong match.
	stage := func(boardFID, pdfFID int64) int64 {
		id, err := db.InsertBinding(boardFID, pdfFID, true, "schematic", true)
		if err != nil {
			t.Fatalf("stage binding b=%d p=%d: %v", boardFID, pdfFID, err)
		}
		return id
	}
	legitID := stage(boardID, legitPdfID)
	junkID := stage(boardID, junkPdfID)
	pureDigitID := stage(otherBoardID, purePagePdfID)
	crossFolderID := stage(boardID, crossFolderWeakID)

	// Also stage a binding marked auto_matched=0 (manual) with a junk PDF —
	// V9 must NOT touch it.
	manualID, err := db.InsertBinding(otherBoardID, junkPdfID, false, "schematic", true)
	if err != nil {
		t.Fatalf("stage manual binding: %v", err)
	}

	// Re-arm V9 — downgrade the version table so migrate() re-runs V9 on next Open.
	if _, err := db.writer.Exec(`DELETE FROM schema_version`); err != nil {
		t.Fatalf("clear schema_version: %v", err)
	}
	if _, err := db.writer.Exec(`INSERT INTO schema_version (version) VALUES (8)`); err != nil {
		t.Fatalf("set version=8: %v", err)
	}
	if err := db.migrateV9(); err != nil {
		t.Fatalf("migrateV9 failed: %v", err)
	}

	// Assert: legit + manual bindings survive; junk + cross-folder-weak are gone.
	survives := func(id int64) bool {
		var got int
		err := db.reader.QueryRow(`SELECT COUNT(*) FROM bindings WHERE id = ?`, id).Scan(&got)
		if err != nil {
			t.Fatalf("count binding %d: %v", id, err)
		}
		return got == 1
	}
	if !survives(legitID) {
		t.Error("legit exact-match same-folder binding was deleted — should have been kept")
	}
	if !survives(manualID) {
		t.Error("manual (auto_matched=0) binding was deleted — V9 must not touch manual bindings")
	}
	if survives(junkID) {
		t.Error("junk-name PDF binding (1.pdf) survived — V9 should have deleted it")
	}
	if survives(pureDigitID) {
		t.Error("pure-digit PDF binding (1234.pdf) survived — V9 should have deleted it")
	}
	if survives(crossFolderID) {
		t.Error("cross-folder weak-match binding survived — V9 should have deleted it")
	}

	// Schema version must be back to 9 after the re-run.
	var ver int
	if err := db.reader.QueryRow(`SELECT version FROM schema_version LIMIT 1`).Scan(&ver); err != nil {
		t.Fatalf("read schema_version: %v", err)
	}
	if ver != 9 {
		t.Errorf("expected schema_version=9 after migrateV9, got %d", ver)
	}
}

func TestOpen_CreatesSchema(t *testing.T) {
	tmpDir := t.TempDir()

	db, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer db.Close()

	// Use the exported Conn() method to verify that all expected tables exist.
	conn := db.Conn()
	tables := []string{"schema_version", "files", "bindings", "pdf_pages", "config"}
	for _, table := range tables {
		var name string
		err := conn.QueryRow(
			`SELECT name FROM sqlite_master WHERE type='table' AND name=?`, table,
		).Scan(&name)
		if err != nil {
			t.Errorf("table %q not found: %v", table, err)
		}
	}

	// Verify the FTS5 virtual table pdf_text exists (type = 'table' in sqlite_master for virtual tables).
	var name string
	err = conn.QueryRow(
		`SELECT name FROM sqlite_master WHERE name='pdf_text'`,
	).Scan(&name)
	if err != nil {
		t.Errorf("virtual table pdf_text not found: %v", err)
	}

	// Verify schema version is at the expected level.
	var ver int
	if err := conn.QueryRow(`SELECT version FROM schema_version LIMIT 1`).Scan(&ver); err != nil {
		t.Fatalf("could not read schema_version: %v", err)
	}
	if ver != schemaVersion {
		t.Errorf("expected schema version %d, got %d", schemaVersion, ver)
	}
}

func TestOpen_Idempotent(t *testing.T) {
	tmpDir := t.TempDir()

	db1, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("first Open failed: %v", err)
	}
	db1.Close()

	db2, err := Open(tmpDir)
	if err != nil {
		t.Fatalf("second Open failed: %v", err)
	}
	defer db2.Close()

	// Verify schema is intact after re-open.
	var ver int
	if err := db2.Conn().QueryRow(`SELECT version FROM schema_version LIMIT 1`).Scan(&ver); err != nil {
		t.Fatalf("schema_version missing after re-open: %v", err)
	}
	if ver != schemaVersion {
		t.Errorf("expected schema version %d after re-open, got %d", schemaVersion, ver)
	}
}

func TestMigratePdfIndexV1(t *testing.T) {
	// Open takes a dataDir (not a full db path), so pass TempDir directly.
	dir := t.TempDir()
	db, err := Open(filepath.Join(dir)) // same as dir; explicit for clarity
	if err != nil {
		t.Fatalf("Open: %v", err)
	}

	// Simulate a v0 database: legacy pdf tables present, no version key.
	// pdf_pages and pdf_text already exist from the normal schema migration,
	// so we just ensure the scan-error table and the version key are absent.
	db.writer.Exec(`CREATE TABLE IF NOT EXISTS pdf_pages (file_id INTEGER, page_num INTEGER, text_content TEXT, source TEXT)`)
	db.writer.Exec(`CREATE VIRTUAL TABLE IF NOT EXISTS pdf_text USING fts5(file_id, page_num, content)`)
	db.writer.Exec(`INSERT OR IGNORE INTO pdf_pages(file_id,page_num,text_content,source) VALUES (1,1,'x','go')`)

	if err := db.MigratePdfIndexV1(); err != nil {
		t.Fatalf("MigratePdfIndexV1: %v", err)
	}

	// Legacy tables must be gone.
	for _, tbl := range []string{"pdf_pages", "pdf_text"} {
		var name string
		if err := db.writer.QueryRow(`SELECT name FROM sqlite_master WHERE name = ?`, tbl).Scan(&name); err == nil {
			t.Errorf("legacy table %q should be dropped", tbl)
		}
	}

	// pdf_donors must exist.
	var dn string
	if err := db.writer.QueryRow(`SELECT name FROM sqlite_master WHERE name='pdf_donors'`).Scan(&dn); err != nil {
		t.Errorf("pdf_donors not created: %v", err)
	}

	// Version key must be "1".
	v, _ := db.GetConfig("pdf_index_schema_version")
	if v != "1" {
		t.Errorf("pdf_index_schema_version = %q, want \"1\"", v)
	}

	// Re-run must be a no-op (no error).
	if err := db.MigratePdfIndexV1(); err != nil {
		t.Errorf("re-run should be no-op, got %v", err)
	}

	db.Close()
}
