package databank

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

// DB wraps a SQLite connection with databank-specific helpers.
// Uses separate read and write connection pools so readers never block on writes
// (WAL mode allows concurrent reads alongside a single writer).
type DB struct {
	writer *sql.DB // single-connection pool for writes
	reader *sql.DB // multi-connection pool for reads
	mu     sync.Mutex // serialises writes at the Go level
}

// Open creates or opens the databank SQLite database at dataDir/databank.db.
func Open(dataDir string) (*DB, error) {
	dbPath := filepath.Join(dataDir, "databank.db")
	// Ensure the data directory exists
	if err := os.MkdirAll(dataDir, 0755); err != nil {
		return nil, fmt.Errorf("create data dir: %w", err)
	}

	dsn := dbPath + "?_pragma=journal_mode(wal)&_pragma=foreign_keys(on)&_pragma=busy_timeout(5000)"

	writer, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open writer database: %w", err)
	}
	writer.SetMaxOpenConns(1) // single writer for SQLite

	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		writer.Close()
		return nil, fmt.Errorf("open reader database: %w", err)
	}
	reader.SetMaxOpenConns(4) // concurrent readers via WAL

	db := &DB{writer: writer, reader: reader}
	if err := db.migrate(); err != nil {
		writer.Close()
		reader.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}

	log.Printf("Databank database opened: %s (WAL mode, separate read/write pools)", dbPath)
	return db, nil
}

// Close shuts down the database connections.
func (db *DB) Close() error {
	db.reader.Close()
	return db.writer.Close()
}

// Conn returns the read connection pool for direct queries.
func (db *DB) Conn() *sql.DB {
	return db.reader
}

const schemaVersion = 5

func (db *DB) migrate() error {
	// Create version table if not exists
	if _, err := db.writer.Exec(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return err
	}

	var ver int
	err := db.writer.QueryRow(`SELECT version FROM schema_version LIMIT 1`).Scan(&ver)
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
	if ver < 2 {
		if err := db.migrateV2(); err != nil {
			return fmt.Errorf("v2: %w", err)
		}
	}
	if ver < 3 {
		if err := db.migrateV3(); err != nil {
			return fmt.Errorf("v3: %w", err)
		}
	}
	if ver < 4 {
		if err := db.migrateV4(); err != nil {
			return fmt.Errorf("v4: %w", err)
		}
	}
	if ver < 5 {
		if err := db.migrateV5(); err != nil {
			return fmt.Errorf("v5: %w", err)
		}
	}

	return nil
}

func (db *DB) migrateV1() error {
	tx, err := db.writer.Begin()
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

func (db *DB) migrateV2() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS config (
			key   TEXT PRIMARY KEY,
			value TEXT NOT NULL
		)`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 2); err != nil {
		return err
	}

	return tx.Commit()
}

func (db *DB) migrateV3() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`CREATE TABLE IF NOT EXISTS pdf_scan_errors (
			id          INTEGER PRIMARY KEY,
			file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
			file_path   TEXT NOT NULL,
			error_msg   TEXT NOT NULL,
			error_detail TEXT,
			created_at  INTEGER NOT NULL,
			UNIQUE(file_id, error_msg)
		)`,
		`CREATE INDEX IF NOT EXISTS idx_pdf_scan_errors_file ON pdf_scan_errors(file_id)`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 3); err != nil {
		return err
	}

	return tx.Commit()
}

func (db *DB) migrateV4() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE files ADD COLUMN board_manufacturer TEXT`,
		`ALTER TABLE files ADD COLUMN resolution_status TEXT NOT NULL DEFAULT 'unresolved'`,
		`CREATE INDEX IF NOT EXISTS idx_files_resolution ON files(resolution_status)`,
		`CREATE INDEX IF NOT EXISTS idx_files_board_mfg ON files(board_manufacturer)`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 4); err != nil {
		return err
	}

	return tx.Commit()
}

// migrateV5 adds a covering composite index that matches the ListFiles
// ORDER BY clause (manufacturer, board_number, filename). Without it the
// query plan does a 100k+ row sort on every full list fetch.
func (db *DB) migrateV5() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`CREATE INDEX IF NOT EXISTS idx_files_listing ON files(manufacturer, board_number, filename)`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 5); err != nil {
		return err
	}

	return tx.Commit()
}

// PdfScanError represents a row in the pdf_scan_errors table.
type PdfScanError struct {
	ID          int64  `json:"id"`
	FileID      int64  `json:"file_id"`
	FilePath    string `json:"file_path"`
	ErrorMsg    string `json:"error_msg"`
	ErrorDetail string `json:"error_detail,omitempty"`
	CreatedAt   int64  `json:"created_at"`
}

// InsertPdfScanError logs a PDF extraction error, skipping duplicates (same file + same error message).
func (db *DB) InsertPdfScanError(fileID int64, filePath, errorMsg, errorDetail string) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.writer.Exec(
		`INSERT OR IGNORE INTO pdf_scan_errors (file_id, file_path, error_msg, error_detail, created_at)
		 VALUES (?, ?, ?, ?, ?)`,
		fileID, filePath, errorMsg, errorDetail, time.Now().Unix(),
	)
	return err
}

// ListPdfScanErrors returns all logged PDF scan errors, newest first.
func (db *DB) ListPdfScanErrors() ([]PdfScanError, error) {
	rows, err := db.reader.Query(
		`SELECT id, file_id, file_path, error_msg, COALESCE(error_detail, ''), created_at
		 FROM pdf_scan_errors ORDER BY created_at DESC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var errors []PdfScanError
	for rows.Next() {
		var e PdfScanError
		if err := rows.Scan(&e.ID, &e.FileID, &e.FilePath, &e.ErrorMsg, &e.ErrorDetail, &e.CreatedAt); err != nil {
			return nil, err
		}
		errors = append(errors, e)
	}
	return errors, rows.Err()
}

// ClearPdfScanErrors deletes all logged PDF scan errors.
func (db *DB) ClearPdfScanErrors() error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.writer.Exec(`DELETE FROM pdf_scan_errors`)
	return err
}

// DatabankStats holds aggregate database info.
type DatabankStats struct {
	Boards         int   `json:"boards"`
	Pdfs           int   `json:"pdfs"`
	Bindings       int   `json:"bindings"`
	PdfPages       int   `json:"pdf_pages"`
	PdfErrors      int   `json:"pdf_errors"`
	DbSizeBytes    int64 `json:"db_size_bytes"`
	LastFileScanAt int64 `json:"last_file_scan_at"`
	LastPdfScanAt  int64 `json:"last_pdf_scan_at"`
}

// Stats returns aggregate database statistics.
func (db *DB) Stats(dataDir string) (*DatabankStats, error) {
	s := &DatabankStats{}

	// Single-query aggregation across files + bindings + pdf_pages + errors.
	// Five separate COUNT(*)s used to round-trip the SQLite driver five times
	// per /api/databank/stats request — visible at 100k rows.
	row := db.reader.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM files WHERE file_type='board'),
			(SELECT COUNT(*) FROM files WHERE file_type='pdf'),
			(SELECT COUNT(*) FROM bindings),
			(SELECT COUNT(*) FROM pdf_pages WHERE page_num > 0),
			(SELECT COUNT(*) FROM pdf_scan_errors)
	`)
	if err := row.Scan(&s.Boards, &s.Pdfs, &s.Bindings, &s.PdfPages, &s.PdfErrors); err != nil {
		return nil, err
	}

	// Sum DB file sizes (main + WAL + SHM)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		path := filepath.Join(dataDir, "databank.db"+suffix)
		if info, err := os.Stat(path); err == nil {
			s.DbSizeBytes += info.Size()
		}
	}

	if v, err := db.GetConfig("last_file_scan_at"); err == nil && v != "" {
		fmt.Sscanf(v, "%d", &s.LastFileScanAt)
	}
	if v, err := db.GetConfig("last_pdf_scan_at"); err == nil && v != "" {
		fmt.Sscanf(v, "%d", &s.LastPdfScanAt)
	}

	return s, nil
}

// FilesETag returns a fast-to-compute ETag for the /api/databank/files
// response, matching the client-side cache signature exactly:
// `${last_file_scan_at}:${boards+pdfs}`. Used for HTTP 304 responses so a
// client without IDB (cleared site data, different browser) can skip the
// multi-MB list transfer when it's already current.
func (db *DB) FilesETag() (string, error) {
	var total int
	if err := db.reader.QueryRow(
		`SELECT COUNT(*) FROM files WHERE file_type IN ('board','pdf')`,
	).Scan(&total); err != nil {
		return "", err
	}
	var lastScan int64
	if v, err := db.GetConfig("last_file_scan_at"); err == nil && v != "" {
		fmt.Sscanf(v, "%d", &lastScan)
	}
	return fmt.Sprintf(`"%d:%d"`, lastScan, total), nil
}

// ResetAll wipes all scan data from the database.
func (db *DB) ResetAll(dataDir string) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	stmts := []string{
		`DELETE FROM pdf_text`,
		`DELETE FROM pdf_pages`,
		`DELETE FROM pdf_scan_errors`,
		`DELETE FROM bindings`,
		`DELETE FROM files`,
	}
	for _, stmt := range stmts {
		if _, err := db.writer.Exec(stmt); err != nil {
			return fmt.Errorf("reset %s: %w", stmt, err)
		}
	}

	for _, key := range []string{"last_scan_status", "last_file_scan_at", "last_pdf_scan_at"} {
		db.writer.Exec(`DELETE FROM config WHERE key = ?`, key)
	}

	previewDir := filepath.Join(dataDir, ".previews")
	os.RemoveAll(previewDir)

	return nil
}

// ResetPdfText wipes PDF text and error data only.
func (db *DB) ResetPdfText() error {
	db.mu.Lock()
	defer db.mu.Unlock()

	stmts := []string{
		`DELETE FROM pdf_text`,
		`DELETE FROM pdf_pages`,
		`DELETE FROM pdf_scan_errors`,
	}
	for _, stmt := range stmts {
		if _, err := db.writer.Exec(stmt); err != nil {
			return fmt.Errorf("reset-pdf %s: %w", stmt, err)
		}
	}

	db.writer.Exec(`DELETE FROM config WHERE key = ?`, "last_pdf_scan_at")
	return nil
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
	DonorPool         bool   `json:"donor_pool"`
	HasPreview        bool   `json:"has_preview"`
	BoardManufacturer string `json:"board_manufacturer,omitempty"`
	ResolutionStatus  string `json:"resolution_status,omitempty"`
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

// WriteTx runs fn inside a write transaction.
// The caller must not hold db.mu — WriteTx acquires it for the whole transaction.
func (db *DB) WriteTx(fn func(tx *sql.Tx) error) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// InsertFile inserts a new file record and returns its ID.
func (db *DB) InsertFile(f *FileRecord) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()

	res, err := db.writer.Exec(
		`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.Path, f.Filename, f.Extension, f.FileType, f.Size, f.ModTime, f.ScanTime,
		nullStr(f.BoardNumber), nullStr(f.Manufacturer), nullStr(f.Model), nullStr(f.FormatID),
		f.PartCount, f.NetCount, boolToInt(f.DonorPool), boolToInt(f.HasPreview),
		nullStr(f.BoardManufacturer), coalesceStr(f.ResolutionStatus, "unresolved"),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// InsertFileTx inserts a file inside an existing transaction (no mutex — caller holds it via WriteTx).
func InsertFileTx(tx *sql.Tx, f *FileRecord) (int64, error) {
	res, err := tx.Exec(
		`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.Path, f.Filename, f.Extension, f.FileType, f.Size, f.ModTime, f.ScanTime,
		nullStr(f.BoardNumber), nullStr(f.Manufacturer), nullStr(f.Model), nullStr(f.FormatID),
		f.PartCount, f.NetCount, boolToInt(f.DonorPool), boolToInt(f.HasPreview),
		nullStr(f.BoardManufacturer), coalesceStr(f.ResolutionStatus, "unresolved"),
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

	_, err := db.writer.Exec(
		`UPDATE files SET size = ?, mod_time = ?, scan_time = ? WHERE id = ?`,
		size, modTime, scanTime, id,
	)
	return err
}

// UpdateFileMetadata updates user-editable metadata fields.
func (db *DB) UpdateFileMetadata(id int64, boardNumber, manufacturer, model string, donorPool bool) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.writer.Exec(
		`UPDATE files SET board_number = ?, manufacturer = ?, model = ?, donor_pool = ? WHERE id = ?`,
		nullStr(boardNumber), nullStr(manufacturer), nullStr(model), boolToInt(donorPool), id,
	)
	return err
}

// SetHasPreview updates the has_preview flag for a file.
func (db *DB) SetHasPreview(id int64, has bool) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.writer.Exec(`UPDATE files SET has_preview = ? WHERE id = ?`, boolToInt(has), id)
	return err
}

// DeleteFile removes a file record by ID. Cascades to bindings and pdf_pages.
func (db *DB) DeleteFile(id int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	// Delete FTS5 entries (no cascade support for virtual tables)
	if _, err := db.writer.Exec(`DELETE FROM pdf_text WHERE file_id = ?`, id); err != nil {
		return err
	}
	_, err := db.writer.Exec(`DELETE FROM files WHERE id = ?`, id)
	return err
}

// GetFileByPath returns a file record by its relative path.
func (db *DB) GetFileByPath(path string) (*FileRecord, error) {
	return db.scanFile(db.reader.QueryRow(
		`SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
		        board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview,
		        board_manufacturer, resolution_status
		 FROM files WHERE path = ?`, path,
	))
}

// GetFileByID returns a file record by its ID.
func (db *DB) GetFileByID(id int64) (*FileRecord, error) {
	return db.scanFile(db.reader.QueryRow(
		`SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
		        board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview,
		        board_manufacturer, resolution_status
		 FROM files WHERE id = ?`, id,
	))
}

// ListFiles returns all files, optionally filtered.
func (db *DB) ListFiles(fileType string, manufacturer string, donorOnly bool) ([]FileRecord, error) {
	query := `SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
	                 board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview,
	                 board_manufacturer, resolution_status
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

	rows, err := db.reader.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []FileRecord
	for rows.Next() {
		f, err := db.scanFile(rows)
		if err != nil {
			return nil, err
		}
		files = append(files, *f)
	}
	return files, rows.Err()
}

// ListFilesByIDs returns files for the given ID set. Order is unspecified.
// Bounded by the caller to avoid unbounded SQL placeholder lists.
func (db *DB) ListFilesByIDs(ids []int64) ([]FileRecord, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	placeholders := make([]string, len(ids))
	args := make([]interface{}, len(ids))
	for i, id := range ids {
		placeholders[i] = "?"
		args[i] = id
	}
	query := `SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
	                 board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview,
	                 board_manufacturer, resolution_status
	          FROM files WHERE id IN (` + strings.Join(placeholders, ",") + `)`

	rows, err := db.reader.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var files []FileRecord
	for rows.Next() {
		f, err := db.scanFile(rows)
		if err != nil {
			return nil, err
		}
		files = append(files, *f)
	}
	return files, rows.Err()
}

// FilePathID is a thin (path, id) row used by the folder-tree builder to
// avoid loading full FileRecords just to compute directory structure.
type FilePathID struct {
	ID   int64
	Path string
}

// AllFilePathsAndIDs returns just the path+id of every file. Cheap enough
// to call on every /api/databank/tree request — only two columns scanned.
func (db *DB) AllFilePathsAndIDs() ([]FilePathID, error) {
	rows, err := db.reader.Query(`SELECT id, path FROM files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []FilePathID
	for rows.Next() {
		var r FilePathID
		if err := rows.Scan(&r.ID, &r.Path); err != nil {
			return nil, err
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// AllFilePaths returns all paths currently in the database (for incremental scan diff).
func (db *DB) AllFilePaths() (map[string]struct{ ID, Size, ModTime int64 }, error) {
	rows, err := db.reader.Query(`SELECT id, path, size, mod_time FROM files`)
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
	rows, err := db.reader.Query(
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
	rows, err := db.reader.Query(
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

	res, err := db.writer.Exec(
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

	_, err := db.writer.Exec(`DELETE FROM bindings WHERE id = ?`, id)
	return err
}

// --- helpers ---

type scannable interface {
	Scan(dest ...interface{}) error
}

// scanFile scans a single file row from any scannable source (*sql.Row or *sql.Rows).
func (db *DB) scanFile(row scannable) (*FileRecord, error) {
	f := &FileRecord{}
	var boardNum, mfr, model, fmtID, boardMfr, resStat sql.NullString
	var partCount, netCount sql.NullInt64
	var donor, preview int

	err := row.Scan(
		&f.ID, &f.Path, &f.Filename, &f.Extension, &f.FileType, &f.Size, &f.ModTime, &f.ScanTime,
		&boardNum, &mfr, &model, &fmtID, &partCount, &netCount, &donor, &preview,
		&boardMfr, &resStat,
	)
	if err != nil {
		return nil, err
	}

	f.BoardNumber = boardNum.String
	f.Manufacturer = mfr.String
	f.Model = model.String
	f.FormatID = fmtID.String
	f.BoardManufacturer = boardMfr.String
	f.ResolutionStatus = resStat.String
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

func coalesceStr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
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

// --- Config key-value store ---

// GetConfig returns a config value by key, or empty string if not set.
func (db *DB) GetConfig(key string) (string, error) {
	var val string
	err := db.reader.QueryRow(`SELECT value FROM config WHERE key = ?`, key).Scan(&val)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return val, err
}

// SetConfig upserts a config value. Pass empty string to delete.
func (db *DB) SetConfig(key, value string) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	if value == "" {
		_, err := db.writer.Exec(`DELETE FROM config WHERE key = ?`, key)
		return err
	}
	_, err := db.writer.Exec(
		`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	return err
}

// AllConfig returns all config key-value pairs.
func (db *DB) AllConfig() (map[string]string, error) {
	rows, err := db.reader.Query(`SELECT key, value FROM config`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]string)
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return nil, err
		}
		result[k] = v
	}
	return result, rows.Err()
}
