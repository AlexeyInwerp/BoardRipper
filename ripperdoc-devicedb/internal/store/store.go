// Package store is the SQLite persistence layer for ripperdoc-devicedb.
//
// One Store wraps one *sql.DB handle pointed at the canonical database.
// All entity reads (entities.go), contribution CRUD (contribs.go), and
// contributor / token operations (users.go) live in this package so the
// HTTP and CLI layers depend on a single concrete type.
package store

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"

	"ripperdoc.de/devicedb/internal/schema"
)

// Store owns the SQLite connection and the on-disk DB path.
type Store struct {
	DB   *sql.DB
	Path string
}

// Open opens (and creates) the canonical SQLite DB at dbPath, runs schema
// migrations, and returns a ready-to-use Store. WAL mode is enabled in
// schema.sql so concurrent readers don't block the writer.
func Open(dbPath string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(dbPath), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir db dir: %w", err)
	}
	dsn := fmt.Sprintf("file:%s?_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)&_pragma=journal_mode(wal)", dbPath)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("sql.Open: %w", err)
	}
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping: %w", err)
	}
	if err := schema.Apply(db); err != nil {
		db.Close()
		return nil, err
	}
	log.Printf("[devicedb] [store] opened %s", dbPath)
	return &Store{DB: db, Path: dbPath}, nil
}

// Close releases the underlying SQLite handle.
func (s *Store) Close() error {
	if s == nil || s.DB == nil {
		return nil
	}
	return s.DB.Close()
}

// SeedIfNeeded copies all entity-table rows from a v2-shaped boards.db at
// seedPath into the canonical store, but only if (a) `seed_state.seeded`
// is 0 and (b) seedPath exists. On subsequent boots this is a no-op even
// if seedPath is still present.
//
// Idempotent by design: a successful copy flips `seed_state.seeded=1`.
// Tables copied (entity tables only — never contributions/tokens):
//
//	brands, families, models, boards, board_aliases, model_aliases,
//	entity_color, board_openboarddata, colors (rows beyond defaults).
func (s *Store) SeedIfNeeded(seedPath string) error {
	if seedPath == "" {
		return nil
	}
	var seeded int
	if err := s.DB.QueryRow("SELECT seeded FROM seed_state WHERE id=1").Scan(&seeded); err == nil {
		if seeded == 1 {
			return nil
		}
	}
	if _, err := os.Stat(seedPath); os.IsNotExist(err) {
		log.Printf("[devicedb] [seed] no seed DB at %s, skipping", seedPath)
		return nil
	}

	abs, err := filepath.Abs(seedPath)
	if err != nil {
		return fmt.Errorf("seed path abs: %w", err)
	}
	log.Printf("[devicedb] [seed] importing entity tables from %s", abs)

	tx, err := s.DB.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(fmt.Sprintf("ATTACH DATABASE 'file:%s?mode=ro&immutable=1' AS seed", abs)); err != nil {
		return fmt.Errorf("attach seed: %w", err)
	}
	// detach on the way out — even on error
	defer func() {
		_, _ = s.DB.Exec("DETACH DATABASE seed")
	}()

	// Copy in dependency order. INSERT OR IGNORE so re-seeding never overwrites
	// hand-edited canonical rows that share a UUID with a seed row.
	copies := []struct {
		table string
		cols  string
	}{
		{"brands", "uuid, name, notes"},
		{"families", "uuid, brand_uuid, name, notes"},
		{"models", "uuid, family_uuid, model_number, display_name, notes"},
		{"boards", "uuid, model_uuid, board_number, board_name, odm, board_number_type, source, source_url, notes"},
		{"board_aliases", "uuid, board_uuid, alias, alias_type"},
		{"model_aliases", "uuid, model_uuid, alias, alias_type"},
		{"entity_color", "scope_type, scope_uuid, color_id"},
		{"board_openboarddata", "board_uuid, external_id, notes"},
	}
	for _, c := range copies {
		// tableExists tolerates older seed DBs missing one of the optional tables.
		if !tableExistsTx(tx, "seed", c.table) {
			continue
		}
		stmt := fmt.Sprintf("INSERT OR IGNORE INTO %s (%s) SELECT %s FROM seed.%s",
			c.table, c.cols, c.cols, c.table)
		res, err := tx.Exec(stmt)
		if err != nil {
			return fmt.Errorf("seed copy %s: %w", c.table, err)
		}
		n, _ := res.RowsAffected()
		log.Printf("[devicedb] [seed] copied %d rows into %s", n, c.table)
	}

	if _, err := tx.Exec("UPDATE seed_state SET seeded=1, seeded_at=? WHERE id=1", nowUTC()); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	log.Printf("[devicedb] [seed] done")
	return nil
}

func tableExistsTx(tx *sql.Tx, schemaName, table string) bool {
	q := fmt.Sprintf("SELECT 1 FROM %s.sqlite_master WHERE type='table' AND name=?", schemaName)
	var x int
	err := tx.QueryRow(q, table).Scan(&x)
	return err == nil
}
