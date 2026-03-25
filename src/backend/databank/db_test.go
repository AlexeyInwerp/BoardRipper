package databank

import (
	"testing"
)

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
