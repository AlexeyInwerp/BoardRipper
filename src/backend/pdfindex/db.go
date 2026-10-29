package pdfindex

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log"
	"os"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// DB owns pdfindex.db. Single-writer discipline mirrors databank.DB:
// one writer connection guarded by a mutex, a separate reader pool, WAL.
type DB struct {
	path   string
	writer *sql.DB
	reader *sql.DB
	mu     sync.Mutex
	// connMu guards the reader handle against the swap in Compact/ResetAll;
	// read paths take it through r().
	connMu sync.RWMutex
	// compaction state, under mu
	compacting bool
	compact    CompactState
}

// ErrCompacting is returned by every write while Compact rewrites the file:
// a write landing in the old file during the copy would be lost.
var ErrCompacting = errors.New("pdfindex: index file is being compacted")

// CompactState reports the running or last compaction.
type CompactState struct {
	Running    bool   `json:"running"`
	StartedAt  int64  `json:"started_at,omitempty"`
	FinishedAt int64  `json:"finished_at,omitempty"`
	SizeBefore int64  `json:"size_before,omitempty"`
	SizeAfter  int64  `json:"size_after,omitempty"`
	Error      string `json:"error,omitempty"`
}

// r returns the reader pool (stable for the duration of one call).
func (db *DB) r() *sql.DB {
	db.connMu.RLock()
	defer db.connMu.RUnlock()
	return db.reader
}

// lockWrite takes the writer lock, or refuses while the file is being
// compacted. Every write method goes through it.
func (db *DB) lockWrite() error {
	db.mu.Lock()
	if db.compacting {
		db.mu.Unlock()
		return ErrCompacting
	}
	return nil
}

// openConns opens the writer (single conn) + reader (pooled) handles for path.
func openConns(path string) (writer, reader *sql.DB, err error) {
	// journal_size_limit: after a checkpoint resets the WAL, SQLite truncates
	// the file back to this size. Without it a sweep that overlaps searches
	// grew the WAL by ~27 MB/s and the file never shrank again (measured
	// 2026-10-14, docs/specs/2026-10-14-pdf-index-search-review.md S5).
	dsn := path + "?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)&_pragma=journal_size_limit(67108864)"
	writer, err = sql.Open("sqlite", dsn)
	if err != nil {
		return nil, nil, err
	}
	writer.SetMaxOpenConns(1) // single writer for SQLite
	reader, err = sql.Open("sqlite", dsn)
	if err != nil {
		writer.Close()
		return nil, nil, err
	}
	reader.SetMaxOpenConns(4)
	return writer, reader, nil
}

func Open(path string) (*DB, error) {
	// A new index file is created without copy-on-write (btrfs), so it never
	// fragments; an existing one is left as is — Compact rewrites it.
	if _, err := os.Stat(path); os.IsNotExist(err) {
		if err := setNoCOW(path); err != nil {
			log.Printf("pdfindex: copy-on-write stays on for %s: %v", path, err)
		}
	}
	// A compaction interrupted by a restart leaves its copy behind.
	_ = os.Remove(path + compactSuffix)
	writer, reader, err := openConns(path)
	if err != nil {
		return nil, err
	}
	db := &DB{path: path, writer: writer, reader: reader}
	if err := db.createSchema(); err != nil {
		writer.Close()
		reader.Close()
		return nil, err
	}
	log.Printf("pdfindex database opened: %s (WAL, separate read/write pools)", path)
	return db, nil
}

func (db *DB) Close() error {
	db.reader.Close()
	return db.writer.Close()
}

// createSchema is safe to call without holding db.mu because it runs only
// during Open, before the DB handle escapes to callers.
func (db *DB) createSchema() error {
	stmts := []string{
		`CREATE TABLE IF NOT EXISTS pdf_index_status (
			file_id           INTEGER PRIMARY KEY,
			status            TEXT    NOT NULL,
			source            TEXT,
			page_count        INTEGER NOT NULL DEFAULT 0,
			attempted_at      INTEGER NOT NULL,
			indexed_at        INTEGER,
			error             TEXT,
			canonical_file_id INTEGER
		)`,
		`CREATE INDEX IF NOT EXISTS idx_status_status ON pdf_index_status(status)`,
		`CREATE TABLE IF NOT EXISTS pdf_pages (
			rowid        INTEGER PRIMARY KEY,
			file_id      INTEGER NOT NULL,
			page_num     INTEGER NOT NULL,
			text_content TEXT    NOT NULL,
			UNIQUE(file_id, page_num)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pages_file ON pdf_pages(file_id)`,
		`CREATE VIRTUAL TABLE IF NOT EXISTS pdf_text USING fts5(
			text_content,
			content='pdf_pages',
			content_rowid='rowid',
			tokenize='porter unicode61',
			prefix='2 3 4'
		)`,
		`CREATE TRIGGER IF NOT EXISTS pdf_pages_ai AFTER INSERT ON pdf_pages BEGIN
			INSERT INTO pdf_text(rowid, text_content) VALUES (new.rowid, new.text_content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS pdf_pages_ad AFTER DELETE ON pdf_pages BEGIN
			INSERT INTO pdf_text(pdf_text, rowid, text_content) VALUES('delete', old.rowid, old.text_content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS pdf_pages_au AFTER UPDATE ON pdf_pages BEGIN
			INSERT INTO pdf_text(pdf_text, rowid, text_content) VALUES('delete', old.rowid, old.text_content);
			INSERT INTO pdf_text(rowid, text_content) VALUES (new.rowid, new.text_content);
		END`,
	}
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	for _, s := range stmts {
		if _, err := tx.Exec(s); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	// Additive columns. A pdfindex.db created before a column existed has the
	// table without it; ALTER adds it and the duplicate-column error is
	// ignored when it is already there. Never a rebuild: an index on a NAS is
	// days of extraction.
	//   canonical_file_id — dedup (non-canonical copies point at the canonical)
	//   attempts          — claims since the last success/reset; a file that
	//                       keeps failing or keeps killing the process stops
	//                       being retried by sweeps at MaxAttempts.
	for _, alter := range []string{
		`ALTER TABLE pdf_index_status ADD COLUMN canonical_file_id INTEGER`,
		`ALTER TABLE pdf_index_status ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0`,
	} {
		if _, err := db.writer.Exec(alter); err != nil {
			if !strings.Contains(err.Error(), "duplicate column name") {
				return err
			}
		}
	}
	return nil
}

// Checkpoint copies the WAL back into the database and truncates it. Called
// at the end of a sweep; a reader still open makes it partial, which is fine
// (the next one finishes the job).
func (db *DB) Checkpoint() error {
	if err := db.lockWrite(); err != nil {
		return err
	}
	defer db.mu.Unlock()
	_, err := db.writer.Exec(`PRAGMA wal_checkpoint(TRUNCATE)`)
	return err
}

const compactSuffix = ".compact"

// CompactStatus returns the running or last compaction.
func (db *DB) CompactStatus() CompactState {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.compact
}

// Compacting reports whether a compaction is running.
func (db *DB) Compacting() bool {
	db.mu.Lock()
	defer db.mu.Unlock()
	return db.compacting
}

// Path is the database file's path.
func (db *DB) Path() string { return db.path }

// FileSize is the size of the database file in bytes (0 if unknown).
func (db *DB) FileSize() int64 {
	st, err := os.Stat(db.path)
	if err != nil {
		return 0
	}
	return st.Size()
}

// Compact rewrites the index into a fresh, contiguous file (VACUUM INTO a
// copy created without copy-on-write, then swapped in) and keeps every page
// of extracted text — nothing is re-extracted. It is the cure for a file that
// btrfs copy-on-write has shredded into fragments: on the NAS such a file
// read at 4 MB/s and every query, even stats on a 70k-row table, ran past
// its deadline. Writes are refused (ErrCompacting) while it runs; reads keep
// working on the old file until the swap. The caller stops the indexer first.
// It needs free space for a second copy of the file.
func (db *DB) Compact(ctx context.Context) error {
	db.mu.Lock()
	if db.compacting {
		db.mu.Unlock()
		return ErrCompacting
	}
	db.compacting = true
	db.compact = CompactState{Running: true, StartedAt: time.Now().Unix(), SizeBefore: db.FileSize()}
	db.mu.Unlock()

	err := db.compactInto(ctx)

	db.mu.Lock()
	db.compacting = false
	db.compact.Running = false
	db.compact.FinishedAt = time.Now().Unix()
	if err != nil {
		db.compact.Error = err.Error()
	} else {
		db.compact.SizeAfter = db.FileSize()
	}
	st := db.compact
	db.mu.Unlock()
	if err != nil {
		log.Printf("pdfindex: compaction failed: %v", err)
	} else {
		log.Printf("pdfindex: compacted %d → %d bytes in %ds", st.SizeBefore, st.SizeAfter, st.FinishedAt-st.StartedAt)
	}
	return err
}

func (db *DB) compactInto(ctx context.Context) error {
	tmp := db.path + compactSuffix
	_ = os.Remove(tmp)
	if err := setNoCOW(tmp); err != nil {
		log.Printf("pdfindex: compact copy keeps copy-on-write: %v", err)
	}
	// Write everything committed so far into the main file first, so the
	// copy is taken from a settled database.
	if _, err := db.writer.ExecContext(ctx, `PRAGMA wal_checkpoint(TRUNCATE)`); err != nil {
		log.Printf("pdfindex: checkpoint before compaction: %v", err)
	}
	conn, err := db.r().Conn(ctx)
	if err != nil {
		return err
	}
	_, err = conn.ExecContext(ctx, `VACUUM INTO ?`, tmp)
	conn.Close()
	if err != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("copy: %w", err)
	}

	// Swap: close both pools (waits for in-flight reads), replace the file,
	// reopen. Under mu (no writer can start) and connMu (no reader can).
	db.mu.Lock()
	defer db.mu.Unlock()
	db.connMu.Lock()
	defer db.connMu.Unlock()
	db.reader.Close()
	db.writer.Close()
	for _, suffix := range []string{"-wal", "-shm"} {
		_ = os.Remove(db.path + suffix)
	}
	renameErr := os.Rename(tmp, db.path)
	w, r, err := openConns(db.path)
	if err != nil {
		return fmt.Errorf("reopen: %w", err)
	}
	db.writer, db.reader = w, r
	if renameErr != nil {
		_ = os.Remove(tmp)
		return fmt.Errorf("swap: %w", renameErr)
	}
	return nil
}
