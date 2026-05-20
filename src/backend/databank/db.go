package databank

import (
	"context"
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

const schemaVersion = 10

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
	if ver < 6 {
		if err := db.migrateV6(); err != nil {
			return fmt.Errorf("v6: %w", err)
		}
	}
	if ver < 7 {
		if err := db.migrateV7(); err != nil {
			return fmt.Errorf("v7: %w", err)
		}
	}
	if ver < 8 {
		if err := db.migrateV8(); err != nil {
			return fmt.Errorf("v8: %w", err)
		}
	}
	if ver < 9 {
		if err := db.migrateV9(); err != nil {
			return fmt.Errorf("v9: %w", err)
		}
	}
	if ver < 10 {
		if err := db.migrateV10(); err != nil {
			return fmt.Errorf("v10: %w", err)
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
			has_preview   INTEGER NOT NULL DEFAULT 0,
			content_hash  BLOB
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
		`CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash) WHERE content_hash IS NOT NULL`,
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

// migrateV6 adds board_uuid and board_color columns to the files table.
// These are denormalized from boards.db at scan time so the frontend can
// render them without an extra resolver fetch.
func (db *DB) migrateV6() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmts := []string{
		`ALTER TABLE files ADD COLUMN board_uuid TEXT`,
		`ALTER TABLE files ADD COLUMN board_color TEXT`,
	}

	for _, stmt := range stmts {
		if _, err := tx.Exec(stmt); err != nil {
			return fmt.Errorf("exec %q: %w", stmt[:40], err)
		}
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 6); err != nil {
		return err
	}

	return tx.Commit()
}

// migrateV8 adds binding categorization fields. `category` is open-vocabulary
// text (v1 dropdown: schematic / datasheet / other) so future curated sources
// can add labels without schema churn. `auto_open` gates the Auto-PDF flow:
// schematics open with the board, datasheets are listed-only by default.
// Existing rows take the defaults (schematic + auto_open=true), preserving
// today's behavior.
func (db *DB) migrateV8() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`ALTER TABLE bindings ADD COLUMN category TEXT NOT NULL DEFAULT 'schematic'`); err != nil {
		return fmt.Errorf("add bindings.category: %w", err)
	}
	if _, err := tx.Exec(`ALTER TABLE bindings ADD COLUMN auto_open INTEGER NOT NULL DEFAULT 1`); err != nil {
		return fmt.Errorf("add bindings.auto_open: %w", err)
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 8); err != nil {
		return err
	}

	return tx.Commit()
}

// migrateV9 prunes stale auto-matched bindings created by the pre-fix
// scanner — most notably PDFs with junk basenames ("1.pdf", "4.pdf",
// pure-digit names) that substring-matched any board whose name happened
// to contain that digit, and cross-folder bindings that wouldn't satisfy
// the new same-folder-or-strong-match rule. Only `auto_matched = 1` rows
// are evaluated; manual bindings created via the Library UI are untouched.
func (db *DB) migrateV9() error {
	// Phase 1: read all auto-matched bindings (reader pool — no writer lock).
	rows, err := db.reader.Query(`
		SELECT b.id, fb.filename, fb.path, fp.filename, fp.path
		  FROM bindings b
		  JOIN files fb ON fb.id = b.board_file_id
		  JOIN files fp ON fp.id = b.pdf_file_id
		 WHERE b.auto_matched = 1`)
	if err != nil {
		return fmt.Errorf("list auto-bindings: %w", err)
	}
	type autoRow struct {
		id           int64
		bFile, bPath string
		pFile, pPath string
	}
	var auto []autoRow
	for rows.Next() {
		var r autoRow
		if err := rows.Scan(&r.id, &r.bFile, &r.bPath, &r.pFile, &r.pPath); err != nil {
			rows.Close()
			return fmt.Errorf("scan auto-binding: %w", err)
		}
		auto = append(auto, r)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	// Phase 2: re-apply the new auto-bind criteria. Mirror scanner.autoMatchBindings.
	var toDelete []int64
	for _, r := range auto {
		if IsLikelyJunkPdfName(r.pFile) {
			toDelete = append(toDelete, r.id)
			continue
		}
		score := MatchScore(r.bFile, r.pFile)
		if score < 50 {
			toDelete = append(toDelete, r.id)
			continue
		}
		if filepath.Dir(r.bPath) != filepath.Dir(r.pPath) && score < 80 {
			toDelete = append(toDelete, r.id)
		}
	}

	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if len(toDelete) > 0 {
		// Chunked DELETE — SQLite defaults to a 999-parameter limit; 500 is a
		// comfortable margin and keeps each DELETE short enough to log on errors.
		const chunk = 500
		for i := 0; i < len(toDelete); i += chunk {
			end := i + chunk
			if end > len(toDelete) {
				end = len(toDelete)
			}
			placeholders := strings.Repeat("?,", end-i-1) + "?"
			args := make([]any, end-i)
			for j, id := range toDelete[i:end] {
				args[j] = id
			}
			if _, err := tx.Exec(`DELETE FROM bindings WHERE id IN (`+placeholders+`)`, args...); err != nil {
				return fmt.Errorf("delete stale bindings: %w", err)
			}
		}
		log.Printf("Bindings cleanup (migrateV9): removed %d stale auto-bindings (of %d auto-matched total)", len(toDelete), len(auto))
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 9); err != nil {
		return err
	}

	return tx.Commit()
}

func (db *DB) migrateV10() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	// content_hash is already present on fresh installs (added to V1 CREATE TABLE).
	// Only ALTER on upgrade paths where the column doesn't exist yet.
	var colCount int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM pragma_table_info('files') WHERE name='content_hash'`).Scan(&colCount); err != nil {
		return fmt.Errorf("check content_hash column: %w", err)
	}
	if colCount == 0 {
		if _, err := tx.Exec(`ALTER TABLE files ADD COLUMN content_hash BLOB`); err != nil {
			return fmt.Errorf("exec %q: %w", "ALTER TABLE files ADD COLUMN content_hash BLOB"[:40], err)
		}
	}
	if _, err := tx.Exec(`CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash) WHERE content_hash IS NOT NULL`); err != nil {
		return fmt.Errorf("exec %q: %w", "CREATE INDEX IF NOT EXISTS idx_files_content_hash ON"[:40], err)
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 10); err != nil {
		return err
	}
	return tx.Commit()
}

// migrateV7 adds the board_color_hex column to the files table.
// Hex is denormalized from boards.db colors.hex at scan time so the renderer
// can apply per-board fill colors without a per-file resolver fetch.
func (db *DB) migrateV7() error {
	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	if _, err := tx.Exec(`ALTER TABLE files ADD COLUMN board_color_hex TEXT`); err != nil {
		return fmt.Errorf("add board_color_hex: %w", err)
	}

	if _, err := tx.Exec(`DELETE FROM schema_version`); err != nil {
		return err
	}
	if _, err := tx.Exec(`INSERT INTO schema_version (version) VALUES (?)`, 7); err != nil {
		return err
	}

	return tx.Commit()
}

// DatabankStats holds aggregate database info.
type DatabankStats struct {
	Boards         int   `json:"boards"`
	Pdfs           int   `json:"pdfs"`
	Bindings       int   `json:"bindings"`
	DbSizeBytes    int64 `json:"db_size_bytes"`
	LastFileScanAt int64 `json:"last_file_scan_at"`
}

// Stats returns aggregate database statistics.
func (db *DB) Stats(dataDir string) (*DatabankStats, error) {
	s := &DatabankStats{}

	row := db.reader.QueryRow(`
		SELECT
			(SELECT COUNT(*) FROM files WHERE file_type='board'),
			(SELECT COUNT(*) FROM files WHERE file_type='pdf'),
			(SELECT COUNT(*) FROM bindings)
	`)
	if err := row.Scan(&s.Boards, &s.Pdfs, &s.Bindings); err != nil {
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
		`DELETE FROM bindings`,
		`DELETE FROM files`,
	}
	for _, stmt := range stmts {
		if _, err := db.writer.Exec(stmt); err != nil {
			return fmt.Errorf("reset %s: %w", stmt, err)
		}
	}

	for _, key := range []string{"last_scan_status", "last_file_scan_at"} {
		db.writer.Exec(`DELETE FROM config WHERE key = ?`, key)
	}

	previewDir := filepath.Join(dataDir, ".previews")
	os.RemoveAll(previewDir)

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
	BoardUUID         string `json:"board_uuid,omitempty"`
	BoardColor        string `json:"board_color,omitempty"`
	BoardColorHex     string `json:"board_color_hex,omitempty"`
}

// BindingRecord represents a row in the bindings table.
type BindingRecord struct {
	ID          int64  `json:"id"`
	BoardFileID int64  `json:"board_file_id"`
	PdfFileID   int64  `json:"pdf_file_id"`
	AutoMatched bool   `json:"auto_matched"`
	Category    string `json:"category"`
	AutoOpen    bool   `json:"auto_open"`
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
		`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status, board_uuid, board_color, board_color_hex)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.Path, f.Filename, f.Extension, f.FileType, f.Size, f.ModTime, f.ScanTime,
		nullStr(f.BoardNumber), nullStr(f.Manufacturer), nullStr(f.Model), nullStr(f.FormatID),
		f.PartCount, f.NetCount, boolToInt(f.DonorPool), boolToInt(f.HasPreview),
		nullStr(f.BoardManufacturer), coalesceStr(f.ResolutionStatus, "unresolved"),
		nullStr(f.BoardUUID), nullStr(f.BoardColor), nullStr(f.BoardColorHex),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// InsertFileTx inserts a file inside an existing transaction (no mutex — caller holds it via WriteTx).
func InsertFileTx(tx *sql.Tx, f *FileRecord) (int64, error) {
	res, err := tx.Exec(
		`INSERT INTO files (path, filename, extension, file_type, size, mod_time, scan_time, board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview, board_manufacturer, resolution_status, board_uuid, board_color, board_color_hex)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		f.Path, f.Filename, f.Extension, f.FileType, f.Size, f.ModTime, f.ScanTime,
		nullStr(f.BoardNumber), nullStr(f.Manufacturer), nullStr(f.Model), nullStr(f.FormatID),
		f.PartCount, f.NetCount, boolToInt(f.DonorPool), boolToInt(f.HasPreview),
		nullStr(f.BoardManufacturer), coalesceStr(f.ResolutionStatus, "unresolved"),
		nullStr(f.BoardUUID), nullStr(f.BoardColor), nullStr(f.BoardColorHex),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateFileScan updates the scan-related fields of an existing file.
// content_hash is reset to NULL so the next dedup pass re-hashes the changed file.
func (db *DB) UpdateFileScan(id int64, size, modTime, scanTime int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.writer.Exec(
		`UPDATE files SET size = ?, mod_time = ?, scan_time = ?, content_hash = NULL WHERE id = ?`,
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
		        board_manufacturer, resolution_status, board_uuid, board_color, board_color_hex
		 FROM files WHERE path = ?`, path,
	))
}

// GetFileByID returns a file record by its ID.
func (db *DB) GetFileByID(ctx context.Context, id int64) (*FileRecord, error) {
	return db.scanFile(db.reader.QueryRowContext(ctx,
		`SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
		        board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview,
		        board_manufacturer, resolution_status, board_uuid, board_color, board_color_hex
		 FROM files WHERE id = ?`, id,
	))
}

// ListFiles returns all files, optionally filtered.
// `ctx` carries the per-request deadline so a slowloris-class slow client
// or a wedged SQLite reader can't pin the query indefinitely.
func (db *DB) ListFiles(ctx context.Context, fileType string, manufacturer string, donorOnly bool) ([]FileRecord, error) {
	query := `SELECT id, path, filename, extension, file_type, size, mod_time, scan_time,
	                 board_number, manufacturer, model, format_id, part_count, net_count, donor_pool, has_preview,
	                 board_manufacturer, resolution_status, board_uuid, board_color, board_color_hex
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

	rows, err := db.reader.QueryContext(ctx, query, args...)
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
func (db *DB) ListFilesByIDs(ctx context.Context, ids []int64) ([]FileRecord, error) {
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
	                 board_manufacturer, resolution_status, board_uuid, board_color, board_color_hex
	          FROM files WHERE id IN (` + strings.Join(placeholders, ",") + `)`

	rows, err := db.reader.QueryContext(ctx, query, args...)
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
func (db *DB) AllFilePathsAndIDs(ctx context.Context) ([]FilePathID, error) {
	rows, err := db.reader.QueryContext(ctx, `SELECT id, path FROM files`)
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
// AllFileRow is the snapshot the scanner uses to diff disk vs DB and to
// detect whether a re-resolution against an updated boards.db would improve
// an existing row's metadata.
type AllFileRow struct {
	ID        int64
	Size      int64
	ModTime   int64
	BoardUUID string // empty for unresolved or pre-v6 rows
}

func (db *DB) AllFilePaths() (map[string]AllFileRow, error) {
	rows, err := db.reader.Query(`SELECT id, path, size, mod_time, board_uuid FROM files`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	result := make(map[string]AllFileRow)
	for rows.Next() {
		var id, size, modTime int64
		var path string
		var boardUUID sql.NullString
		if err := rows.Scan(&id, &path, &size, &modTime, &boardUUID); err != nil {
			return nil, err
		}
		result[path] = AllFileRow{ID: id, Size: size, ModTime: modTime, BoardUUID: boardUUID.String}
	}
	return result, rows.Err()
}

// UpdateFileResolution refreshes all metadata fields that come out of
// ExtractMetadataWithBoardDB. Used by the scanner's unchanged-file path
// when a richer boards.db now resolves a file that was previously
// Unsorted / unresolved. The file's id, path, size, mod_time, scan_time,
// donor_pool, and has_preview are intentionally left alone.
func (db *DB) UpdateFileResolution(
	id int64,
	boardNumber, manufacturer, model, boardManufacturer, resolutionStatus,
	boardUUID, boardColor, boardColorHex string,
) error {
	db.mu.Lock()
	defer db.mu.Unlock()

	_, err := db.writer.Exec(
		`UPDATE files
		 SET board_number = ?, manufacturer = ?, model = ?, board_manufacturer = ?,
		     resolution_status = ?, board_uuid = ?, board_color = ?, board_color_hex = ?
		 WHERE id = ?`,
		nullStr(boardNumber), nullStr(manufacturer), nullStr(model),
		nullStr(boardManufacturer), coalesceStr(resolutionStatus, "unresolved"),
		nullStr(boardUUID), nullStr(boardColor), nullStr(boardColorHex),
		id,
	)
	return err
}

// GetBindingsForBoard returns all PDF bindings for a board file.
func (db *DB) GetBindingsForBoard(ctx context.Context, boardFileID int64) ([]BindingRecord, error) {
	rows, err := db.reader.QueryContext(ctx,
		`SELECT id, board_file_id, pdf_file_id, auto_matched, category, auto_open
		   FROM bindings WHERE board_file_id = ?`,
		boardFileID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var bindings []BindingRecord
	for rows.Next() {
		var b BindingRecord
		var auto, autoOpen int
		if err := rows.Scan(&b.ID, &b.BoardFileID, &b.PdfFileID, &auto, &b.Category, &autoOpen); err != nil {
			return nil, err
		}
		b.AutoMatched = auto != 0
		b.AutoOpen = autoOpen != 0
		bindings = append(bindings, b)
	}
	return bindings, rows.Err()
}

// GetBindingsForFile returns all bindings involving a file (as board or PDF), with filenames.
func (db *DB) GetBindingsForFile(ctx context.Context, fileID int64) ([]BindingDetail, error) {
	rows, err := db.reader.QueryContext(ctx,
		`SELECT b.id, b.board_file_id, b.pdf_file_id, b.auto_matched, b.category, b.auto_open,
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
		var auto, autoOpen int
		if err := rows.Scan(&bd.ID, &bd.BoardFileID, &bd.PdfFileID, &auto, &bd.Category, &autoOpen,
			&bd.BoardFilename, &bd.BoardPath, &bd.PdfFilename, &bd.PdfPath); err != nil {
			return nil, err
		}
		bd.AutoMatched = auto != 0
		bd.AutoOpen = autoOpen != 0
		bindings = append(bindings, bd)
	}
	return bindings, rows.Err()
}

// InsertBinding creates a board-PDF binding.
// `category` is open-vocabulary (v1: schematic / datasheet / other);
// `autoOpen` gates the Auto-PDF flow on the frontend.
func (db *DB) InsertBinding(boardFileID, pdfFileID int64, autoMatched bool, category string, autoOpen bool) (int64, error) {
	db.mu.Lock()
	defer db.mu.Unlock()

	if category == "" {
		category = "schematic"
	}

	res, err := db.writer.Exec(
		`INSERT OR IGNORE INTO bindings (board_file_id, pdf_file_id, auto_matched, category, auto_open)
		 VALUES (?, ?, ?, ?, ?)`,
		boardFileID, pdfFileID, boolToInt(autoMatched), category, boolToInt(autoOpen),
	)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

// UpdateBinding patches a binding's category and/or auto_open. Nil fields are
// left untouched. Returns nil even if no row matches the id (caller validates).
func (db *DB) UpdateBinding(id int64, category *string, autoOpen *bool) error {
	if category == nil && autoOpen == nil {
		return nil
	}

	db.mu.Lock()
	defer db.mu.Unlock()

	sets := make([]string, 0, 2)
	args := make([]any, 0, 3)
	if category != nil {
		sets = append(sets, "category = ?")
		args = append(args, *category)
	}
	if autoOpen != nil {
		sets = append(sets, "auto_open = ?")
		args = append(args, boolToInt(*autoOpen))
	}
	args = append(args, id)

	_, err := db.writer.Exec(
		`UPDATE bindings SET `+strings.Join(sets, ", ")+` WHERE id = ?`,
		args...,
	)
	return err
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
	var boardNum, mfr, model, fmtID, boardMfr, resStat, boardUUID, boardColor, boardColorHex sql.NullString
	var partCount, netCount sql.NullInt64
	var donor, preview int

	err := row.Scan(
		&f.ID, &f.Path, &f.Filename, &f.Extension, &f.FileType, &f.Size, &f.ModTime, &f.ScanTime,
		&boardNum, &mfr, &model, &fmtID, &partCount, &netCount, &donor, &preview,
		&boardMfr, &resStat, &boardUUID, &boardColor, &boardColorHex,
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
	f.BoardUUID = boardUUID.String
	f.BoardColor = boardColor.String
	f.BoardColorHex = boardColorHex.String
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

// CollisionFile is a size-colliding candidate for hashing.
type CollisionFile struct {
	ID      int64
	Path    string
	Size    int64
	ModTime int64
	Hashed  bool // already has a content_hash
}

// SizeCollisionFiles returns files whose exact size is shared by >= 2 files —
// the only candidates that can be duplicates. Unique-size files are skipped.
func (db *DB) SizeCollisionFiles() ([]CollisionFile, error) {
	rows, err := db.reader.Query(`
		SELECT id, path, size, mod_time, content_hash IS NOT NULL
		FROM files
		WHERE size IN (SELECT size FROM files GROUP BY size HAVING COUNT(*) > 1)
		ORDER BY size, id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []CollisionFile
	for rows.Next() {
		var c CollisionFile
		if err := rows.Scan(&c.ID, &c.Path, &c.Size, &c.ModTime, &c.Hashed); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (db *DB) SetContentHash(fileID int64, hash []byte) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.writer.Exec(`UPDATE files SET content_hash = ? WHERE id = ?`, hash, fileID)
	return err
}

func (db *DB) ContentHashOf(fileID int64) ([]byte, error) {
	var h []byte
	err := db.reader.QueryRow(`SELECT content_hash FROM files WHERE id = ?`, fileID).Scan(&h)
	return h, err
}

// CanonicalForHash returns MIN(id) among files sharing the hash (the canonical),
// or (0, nil) when no file carries the hash.
func (db *DB) CanonicalForHash(hash []byte) (int64, error) {
	var id sql.NullInt64
	err := db.reader.QueryRow(`SELECT MIN(id) FROM files WHERE content_hash = ?`, hash).Scan(&id)
	if err != nil {
		return 0, err
	}
	return id.Int64, nil
}

// DedupStats summarizes content groups (groups with >1 member = duplicates).
// BytesDedupable is the reclaimable size: per group, (members-1) * file size
// (all members of a group are byte-identical, so they share one size).
type DedupStats struct {
	Groups         int   `json:"groups"`
	DuplicateFiles int   `json:"duplicate_files"`
	BytesDedupable int64 `json:"bytes_dedupable"`
}

func (db *DB) DedupStats() (DedupStats, error) {
	var s DedupStats
	err := db.reader.QueryRow(`
		SELECT COALESCE(COUNT(*),0), COALESCE(SUM(c-1),0), COALESCE(SUM((c-1)*sz),0) FROM (
			SELECT COUNT(*) AS c, MIN(size) AS sz FROM files WHERE content_hash IS NOT NULL
			GROUP BY content_hash HAVING COUNT(*) > 1
		)`).Scan(&s.Groups, &s.DuplicateFiles, &s.BytesDedupable)
	return s, err
}

// CopyPathsForFile returns the paths of OTHER files in the same content group
// (excludes the given file). Empty if the file has no hash / no duplicates.
func (db *DB) CopyPathsForFile(fileID int64) ([]string, error) {
	rows, err := db.reader.Query(`
		SELECT path FROM files
		WHERE content_hash = (SELECT content_hash FROM files WHERE id = ?)
		  AND content_hash IS NOT NULL AND id != ?
		ORDER BY id`, fileID, fileID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var p string
		if err := rows.Scan(&p); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// MigratePdfIndexV1 performs the v0→v1 PDF-index migration on databank.db:
// drop the legacy pdf_pages/pdf_text/pdf_scan_errors tables (their content
// moves to the new pdfindex.db), create the pdf_donors membership table, and
// stamp the version. Idempotent: a re-run with version already "1" is a no-op.
func (db *DB) MigratePdfIndexV1() error {
	if v, _ := db.GetConfig("pdf_index_schema_version"); v == "1" {
		return nil
	}
	db.mu.Lock()
	defer db.mu.Unlock()

	tx, err := db.writer.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var droppedPages, droppedText int
	_ = tx.QueryRow(`SELECT COUNT(*) FROM pdf_pages`).Scan(&droppedPages)
	_ = tx.QueryRow(`SELECT COUNT(*) FROM pdf_text`).Scan(&droppedText)

	for _, s := range []string{
		`DROP TABLE IF EXISTS pdf_text`,
		`DROP TABLE IF EXISTS pdf_pages`,
		`DROP TABLE IF EXISTS pdf_scan_errors`,
		`CREATE TABLE IF NOT EXISTS pdf_donors (
			file_id  INTEGER PRIMARY KEY REFERENCES files(id) ON DELETE CASCADE,
			added_at INTEGER NOT NULL
		)`,
		`DELETE FROM config WHERE key = 'last_pdf_scan_at'`,
	} {
		if _, err := tx.Exec(s); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	if err := db.setConfigLocked("pdf_index_schema_version", "1"); err != nil {
		return err
	}
	log.Printf("[migrate] pdf-index schema v0→v1: dropped pdf_pages (%d rows), pdf_text (%d rows); created pdf_donors",
		droppedPages, droppedText)
	return nil
}

// BoardBinding is a board file linked to a PDF search result.
type BoardBinding struct {
	BoardFileID   int64  `json:"board_file_id"`
	BoardFilename string `json:"board_filename"`
	DonorPool     bool   `json:"donor_pool"`
}

// SearchMetaRow is the per-file enrichment payload returned by SearchMeta.
type SearchMetaRow struct {
	Filename string         `json:"filename"`
	Path     string         `json:"path"`
	IsDonor  bool           `json:"is_donor"`
	Bindings []BoardBinding `json:"board_bindings"`
}

// SearchMeta returns filename/path/is_donor/bindings for the given file_ids in
// one files+donor query plus one bindings query — no per-result N+1.
func (db *DB) SearchMeta(fileIDs []int64) (map[int64]SearchMetaRow, error) {
	out := make(map[int64]SearchMetaRow, len(fileIDs))
	if len(fileIDs) == 0 {
		return out, nil
	}
	ph := make([]string, len(fileIDs))
	args := make([]interface{}, len(fileIDs))
	for i, id := range fileIDs {
		ph[i] = "?"
		args[i] = id
	}
	in := strings.Join(ph, ",")

	rows, err := db.reader.Query(
		`SELECT f.id, f.filename, f.path,
		        CASE WHEN d.file_id IS NULL THEN 0 ELSE 1 END AS is_donor
		 FROM files f LEFT JOIN pdf_donors d ON d.file_id = f.id
		 WHERE f.id IN (`+in+`)`, args...)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var id int64
		var m SearchMetaRow
		var donor int
		if err := rows.Scan(&id, &m.Filename, &m.Path, &donor); err != nil {
			rows.Close()
			return nil, err
		}
		m.IsDonor = donor != 0
		m.Bindings = []BoardBinding{}
		out[id] = m
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}

	brows, err := db.reader.Query(
		`SELECT b.pdf_file_id, b.board_file_id, f.filename, f.donor_pool
		 FROM bindings b JOIN files f ON f.id = b.board_file_id
		 WHERE b.pdf_file_id IN (`+in+`)`, args...)
	if err != nil {
		return nil, err
	}
	defer brows.Close()
	for brows.Next() {
		var pdfID int64
		var b BoardBinding
		var donor int
		if err := brows.Scan(&pdfID, &b.BoardFileID, &b.BoardFilename, &donor); err != nil {
			return nil, err
		}
		b.DonorPool = donor != 0
		if m, ok := out[pdfID]; ok {
			m.Bindings = append(m.Bindings, b)
			out[pdfID] = m
		}
	}
	return out, brows.Err()
}

// --- Donor list ---

// DonorEntry is a donor-list row joined to its file.
type DonorEntry struct {
	FileID   int64  `json:"file_id"`
	Filename string `json:"filename"`
	Path     string `json:"path"`
	AddedAt  int64  `json:"added_at"`
}

// AddDonor adds a file to the donor list. Idempotent: re-adding the same
// file_id is silently ignored.
func (db *DB) AddDonor(fileID int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.writer.Exec(
		`INSERT INTO pdf_donors(file_id, added_at) VALUES(?, ?)
		 ON CONFLICT(file_id) DO NOTHING`, fileID, time.Now().Unix())
	return err
}

// RemoveDonor removes a file from the donor list. A no-op if the file was
// not in the list.
func (db *DB) RemoveDonor(fileID int64) error {
	db.mu.Lock()
	defer db.mu.Unlock()
	_, err := db.writer.Exec(`DELETE FROM pdf_donors WHERE file_id = ?`, fileID)
	return err
}

// DonorFileIDs returns the file IDs of all donor-list entries.
func (db *DB) DonorFileIDs() ([]int64, error) {
	rows, err := db.reader.Query(`SELECT file_id FROM pdf_donors`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []int64
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		out = append(out, id)
	}
	return out, rows.Err()
}

// ListDonors returns all donor-list entries joined to their file records,
// ordered newest-first.
func (db *DB) ListDonors() ([]DonorEntry, error) {
	rows, err := db.reader.Query(`
		SELECT d.file_id, f.filename, f.path, d.added_at
		FROM pdf_donors d JOIN files f ON f.id = d.file_id
		ORDER BY d.added_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []DonorEntry
	for rows.Next() {
		var e DonorEntry
		if err := rows.Scan(&e.FileID, &e.Filename, &e.Path, &e.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// setConfigLocked writes a config key-value pair without acquiring db.mu.
// Only call this when db.mu is already held by the caller.
func (db *DB) setConfigLocked(key, value string) error {
	_, err := db.writer.Exec(
		`INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	return err
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

// AllConfig returns all public config key-value pairs. Keys prefixed with
// "__" hold secrets (e.g. __sync_secret_pass — the WebDAV library-sync
// password) and are filtered out so they never appear in GET /api/config
// responses, log dumps, etc. Per-secret accessors are responsible for
// reading these by exact key when they need them.
func (db *DB) AllConfig() (map[string]string, error) {
	rows, err := db.reader.Query(`SELECT key, value FROM config WHERE key NOT LIKE '\_\_%' ESCAPE '\'`)
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
