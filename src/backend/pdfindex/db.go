package pdfindex

import (
	"database/sql"
	"log"
	"sync"

	_ "modernc.org/sqlite"
)

// DB owns pdfindex.db. Single-writer discipline mirrors databank.DB:
// one writer connection guarded by a mutex, a separate reader pool, WAL.
type DB struct {
	writer *sql.DB
	reader *sql.DB
	mu     sync.Mutex
}

func Open(path string) (*DB, error) {
	dsn := path + "?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)"
	writer, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	writer.SetMaxOpenConns(1) // single writer for SQLite

	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		writer.Close()
		return nil, err
	}
	reader.SetMaxOpenConns(4)

	db := &DB{writer: writer, reader: reader}
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
			file_id      INTEGER PRIMARY KEY,
			status       TEXT    NOT NULL,
			source       TEXT,
			page_count   INTEGER NOT NULL DEFAULT 0,
			attempted_at INTEGER NOT NULL,
			indexed_at   INTEGER,
			error        TEXT
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
			content,
			content='pdf_pages',
			content_rowid='rowid',
			tokenize='porter unicode61',
			prefix='2 3 4'
		)`,
		`CREATE TRIGGER IF NOT EXISTS pdf_pages_ai AFTER INSERT ON pdf_pages BEGIN
			INSERT INTO pdf_text(rowid, content) VALUES (new.rowid, new.text_content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS pdf_pages_ad AFTER DELETE ON pdf_pages BEGIN
			INSERT INTO pdf_text(pdf_text, rowid, content) VALUES('delete', old.rowid, old.text_content);
		END`,
		`CREATE TRIGGER IF NOT EXISTS pdf_pages_au AFTER UPDATE ON pdf_pages BEGIN
			INSERT INTO pdf_text(pdf_text, rowid, content) VALUES('delete', old.rowid, old.text_content);
			INSERT INTO pdf_text(rowid, content) VALUES (new.rowid, new.text_content);
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
	return tx.Commit()
}
