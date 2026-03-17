package databank

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"sync"

	_ "modernc.org/sqlite"
)

// DB wraps a SQLite connection with databank-specific helpers.
type DB struct {
	conn *sql.DB
	mu   sync.RWMutex
}

// Open creates or opens the databank SQLite database at dataDir/databank.db.
func Open(dataDir string) (*DB, error) {
	dbPath := filepath.Join(dataDir, "databank.db")
	// Ensure the data directory exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	conn, err := sql.Open("sqlite", dbPath+"?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)")
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}

	// Single writer connection for SQLite
	conn.SetMaxOpenConns(1)

	db := &DB{conn: conn}
	if err := db.migrate(); err != nil {
		conn.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	log.Printf("Databank database opened: %s", dbPath)
	return db, nil
}

// Close shuts down the database connection.
func (db *DB) Close() error {
	return db.conn.Close()
}

// Conn returns the underlying sql.DB for direct queries.
func (db *DB) Conn() *sql.DB {
	return db.conn
}

const schemaVersion = 1

func (db *DB) migrate() error {
	// Create version table if not exists
	if _, err := db.conn.Exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return err
	}

	var ver int
	err := db.conn.QueryRow(`SELECT version FROM schema_version LIMIT 1`).Scan(&ver)
	if err == sql.ErrNoRows {
		ver = 0
	} else if err != nil {
		return err
	}

	if ver < 1 {
		if err := db.migrateV1(); err != nil {
			return fmt.Errorf("v1: %w", err)
		}
	}

	return nil
}

func (db *DB) migrateV1() error {
	tx, err := db.conn.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS files (
			id            INTEGER PRIMARY KEY,
			path          TEXT NOT NULL UNIQUE,
			filename      TEXT NOT NULL,
			extension     TEXT NOT NULL,
			file_type     TEXT NOT NULL,
			size          INTEGER NOT NULL,
			mod_time      INTEGER NOT NULL,
			scan_time     INTEGER NOT NULL,
			board_number  TEXT,
			manufacturer  TEXT,
			model         TEXT,
			format_id     TEXT,
			part_count    INTEGER,
			net_count     INTEGER,
			donor_pool    INTEGER NOT NULL DEFAULT 0,
			has_preview   INTEGER NOT NULL DEFAULT 0
		)`,

		`CREATE TABLE IF NOT EXISTS bindings (
			id            INTEGER PRIMARY KEY,
			board_file_id INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			pdf_file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			auto_matched  INTEGER NOT NULL DEFAULT 1,
			UNIQUE(board_file_id, pdf_file_id)
		)`,

		`CREATE VIRTUAL TABLE IF NOT EXISTS pdf_text USING fts5(
			file_id UNINDEXED,
			page_num UNINDEXED,
			content,
			tokenize='unicode61'
		)`,

		`CREATE TABLE IF NOT EXISTS pdf_pages (
			file_id      INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			page_num     INTEGER NOT NULL,
			text_content TEXT,
			source       TEXT NOT NULL DEFAULT 'go',
			PRIMARY KEY(file_id, page_num)
		)`,

		`CREATE INDEX IF NOT EXISTS idx_files_type ON files(file_type)`,
		`CREATE INDEX IF NOT EXISTS idx_files_board_number ON files(board_number)`,
		`CREATE INDEX IF NOT EXISTS idx_files_manufacturer ON files(manufacturer)`,
		`CREATE INDEX IF NOT EXISTS idx_files_donor ON files(donor_pool)`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	// Set schema version
	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, schemaVersion); err != nil {
		return err
	}

	return tx.Commit()
}

// FileRecord represents a row in the files table.
type FileRecord struct {
	ID           int64  `json:"id"`
	Path         string `json:"path"`
	Filename     string `json:"filename"`
	Extension    string `json:"extension"`
	FileType     string `json:"file_type"`
	Size         int64  `json:"size"`
	ModTime      int64  `json:"mod_time"`
	ScanTime     int64  `json:"scan_time"`
	BoardNumber  string `json:"board_number,omitempty"`
	Manufacturer string `json:"manufacturer,omitempty"`
	Model        string `json:"model,omitempty"`
	FormatID     string `json:"format_id,omitempty"`
	PartCount    *int   `json:"part_count,omitempty"`
	NetCount     *int   `json:"net_count,omitempty"`
	DonorPool    bool   `json:"donor_pool"`
	HasPreview   bool   `json:"has_preview"`
}

// BindingRecord represents a row in the bindings table.
type BindingRecord struct {
	ID          int64 `json:"id"`
	BoardFileID int64 `json:"board_file_id"`
	PdfFileID   int64 `json:"pdf_file_id"`
	AutoMatched bool  `json:"auto_matched"`
}

// BindingDetail is a BindingRecord enriched with the linked file's name and path.
type BindingDetail struct {
	BindingRecord
	BoardFilename string `json:"board_filename"`
	BoardPath     string `json:"board_path"`
	PdfFilename   string `json:"pdf_filename"`
	PdfPath       string `json:"pdf_path"`
}

// InsertFile inserts a new file record and returns its ID.
func (db *DB) InsertFile(f *FileRecord) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()

	res, err := db.conn.Exec(
		`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.Path, f.Filename, f.Extension, f.FileType, f.Size, f.ModTime, f.ScanTime,
		nullStr(f.BoardNumber), nullStr(f.Manufacturer), nullStr(f.Model), nullStr(f.FormatID),
		f.PartCount, f.NetCount, boolToInt(f.DonorPool), boolToInt(f.HasPreview),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateFileScan updates the scan-related fields of an existing file.
func (db *DB) UpdateFileScan(id int64, size, modTime, scanTime int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.conn.Exec(
		`UPDATE files SET size = ?, mod_time = ?, scan_time = ? WHERE id = ?`,
		size, modTime, scanTime, id,
	)
	return err
}

// UpdateFileMetadata updates user-editable metadata fields.
func (db *DB) UpdateFileMetadata(id int64, boardNumber, manufacturer, model string, donorPool bool) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.conn.Exec(
		`UPDATE files SET board_number = ?, manufacturer = ?, model = ?, donor_pool = ? WHERE id = ?`,
		nullStr(boardNumber), nullStr(manufacturer), nullStr(model), boolToInt(donorPool), id,
	)
	return err
}

// SetHasPreview updates the has_preview flag for a file.
func (db *DB) SetHasPreview(id int64, has bool) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.conn.Exec(`UPDATE files SET has_preview = ? WHERE id = ?`, boolToInt(has), id)
	return err
}

// DeleteFile removes a file record by ID. Cascades to bindings and pdf_pages.
func (db *DB) DeleteFile(id int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	// Delete FTS5 entries (no cascade support for virtual tables)
	if _, err := db.conn.Exec(`DELETE FROM pdf_text WHERE file_id = ?`, id); err != nil {
		return err
	}
	_, err := db.conn.Exec(`DELETE FROM files WHERE id = ?`, id)
	return err
}

// GetFileByPath returns a file record by its relative path.
func (db *DB) GetFileByPath(path string) (*FileRecord, error) {
	return db.scanFile(db.conn.QueryRow(
		`SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
		        board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview
		 FROM files WHERE path = ?`, path,
	))
}

// GetFileByID returns a file record by its ID.
func (db *DB) GetFileByID(id int64) (*FileRecord, error) {
	return db.scanFile(db.conn.QueryRow(
		`SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
		        board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview
		 FROM files WHERE id = ?`, id,
	))
}

// ListFiles returns all files, optionally filtered.
func (db *DB) ListFiles(fileType string, manufacturer string, donorOnly bool) ([]FileRecord, error) {
	query := `SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
	                 board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview
	          FROM files WHERE 1=1`
	args := []interface{}{}

	if fileType != "" {
		query += ` AND file_type = ?`
		args = append(args, fileType)
	}
	if manufacturer != "" {
		query += ` AND manufacturer = ?`
		args = append(args, manufacturer)
	}
	if donorOnly {
		query += ` AND donor_pool = 1`
	}

	query += ` ORDER BY manufacturer, board_number, filename`

	rows, err := db.conn.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []FileRecord
	for rows.Next() {
		f, err := db.scanFileRow(rows)
		if err != nil {
			return nil, err
		}
		files = append(files, *f)
	}
	return files, rows.Err()
}

// AllFilePaths returns all paths currently in the database (for incremental scan diff).
func (db *DB) AllFilePaths() (map[string]struct{ ID, Size, ModTime int64 }, error) {
	rows, err := db.conn.Query(`SELECT id, path, size, mod_time FROM files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]struct{ ID, Size, ModTime int64 })
	for rows.Next() {
		var id, size, modTime int64
		var path string
		if err := rows.Scan(&id, &path, &size, &modTime); err != nil {
			return nil, err
		}
		result[path] = struct{ ID, Size, ModTime int64 }{id, size, modTime}
	}
	return result, rows.Err()
}

// GetBindingsForBoard returns all PDF bindings for a board file.
func (db *DB) GetBindingsForBoard(boardFileID int64) ([]BindingRecord, error) {
	rows, err := db.conn.Query(
		`SELECT id, board_file_id, pdf_file_id, auto_matched FROM bindings WHERE board_file_id = ?`,
		boardFileID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bindings []BindingRecord
	for rows.Next() {
		var b BindingRecord
		var auto int
		if err := rows.Scan(&b.ID, &b.BoardFileID, &b.PdfFileID, &auto); err != nil {
			return nil, err
		}
		b.AutoMatched = auto != 0
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// GetBindingsForFile returns all bindings involving a file (as board or PDF), with filenames.
func (db *DB) GetBindingsForFile(fileID int64) ([]BindingDetail, error) {
	rows, err := db.conn.Query(
		`SELECT b.id, b.board_file_id, b.pdf_file_id, b.auto_matched,
		        bf.filename, bf.path, pf.filename, pf.path
		 FROM bindings b
		 JOIN files bf ON bf.id = b.board_file_id
		 JOIN files pf ON pf.id = b.pdf_file_id
		 WHERE b.board_file_id = ? OR b.pdf_file_id = ?`,
		fileID, fileID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bindings []BindingDetail
	for rows.Next() {
		var bd BindingDetail
		var auto int
		if err := rows.Scan(&bd.ID, &bd.BoardFileID, &bd.PdfFileID, &auto,
			&bd.BoardFilename, &bd.BoardPath, &bd.PdfFilename, &bd.PdfPath); err != nil {
			return nil, err
		}
		bd.AutoMatched = auto != 0
		bindings = append(bindings, bd)
	}
	return bindings, rows.Err()
}

// InsertBinding creates a board-PDF binding.
func (db *DB) InsertBinding(boardFileID, pdfFileID int64, autoMatched bool) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()

	res, err := db.conn.Exec(
		`INSERT OR IGNORE INTO bindings (board_file_id, pdf_file_id, auto_matched) VALUES (?, ?, ?)`,
		boardFileID, pdfFileID, boolToInt(autoMatched),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// DeleteBinding removes a binding by ID.
func (db *DB) DeleteBinding(id int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.conn.Exec(`DELETE FROM bindings WHERE id = ?`, id)
	return err
}

// --- helpers ---

func (db *DB) scanFile(row *sql.Row) (*FileRecord, error) {
	f := &FileRecord{}
	var boardNum, mfr, model, fmtID sql.NullString
	var partCount, netCount sql.NullInt64
	var donor, preview int

	err := row.Scan(
		&f.ID, &f.Path, &f.Filename, &f.Extension, &f.FileType, &f.Size, &f.ModTime, &f.ScanTime,
		&boardNum, &mfr, &model, &fmtID, &partCount, &netCount, &donor, &preview,
	)
	if err != nil {
		return nil, err
	}

	f.BoardNumber = boardNum.String
	f.Manufacturer = mfr.String
	f.Model = model.String
	f.FormatID = fmtID.String
	if partCount.Valid {
		v := int(partCount.Int64)
		f.PartCount = &v
	}
	if netCount.Valid {
		v := int(netCount.Int64)
		f.NetCount = &v
	}
	f.DonorPool = donor != 0
	f.HasPreview = preview != 0
	return f, nil
}

type scannable interface {
	Scan(dest ...interface{}) error
}

func (db *DB) scanFileRow(row scannable) (*FileRecord, error) {
	f := &FileRecord{}
	var boardNum, mfr, model, fmtID sql.NullString
	var partCount, netCount sql.NullInt64
	var donor, preview int

	err := row.Scan(
		&f.ID, &f.Path, &f.Filename, &f.Extension, &f.FileType, &f.Size, &f.ModTime, &f.ScanTime,
		&boardNum, &mfr, &model, &fmtID, &partCount, &netCount, &donor, &preview,
	)
	if err != nil {
		return nil, err
	}

	f.BoardNumber = boardNum.String
	f.Manufacturer = mfr.String
	f.Model = model.String
	f.FormatID = fmtID.String
	if partCount.Valid {
		v := int(partCount.Int64)
		f.PartCount = &v
	}
	if netCount.Valid {
		v := int(netCount.Int64)
		f.NetCount = &v
	}
	f.DonorPool = donor != 0
	f.HasPreview = preview != 0
	return f, nil
}

func nullStr(s string) interface{} {
	if s == "" {
		return nil
	}
	return s
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}
