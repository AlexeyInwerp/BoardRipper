package boarddb

import (
	"database/sql"
	"fmt"
	"log"
	"os"
	"sync"

	_ "modernc.org/sqlite"
)

// BoardMatch is the result of resolving a board number against the reference DB.
type BoardMatch struct {
	UUID         string   `json:"uuid"`
	BoardNumber  string   `json:"board_number"`
	Brand        string   `json:"brand"`
	Model        string   `json:"model"`
	ModelNumber  string   `json:"model_number,omitempty"`
	BoardName    string   `json:"board_name,omitempty"`
	ODM          string   `json:"odm"`
	Type         string   `json:"board_number_type,omitempty"`
	Color        string   `json:"color,omitempty"`
	Aliases      []string `json:"aliases,omitempty"`
	ModelAliases []string `json:"model_aliases,omitempty"`
	Source       string   `json:"source,omitempty"`
}

// ExtractedNumber is a board number found in a filename by the regex matcher.
type ExtractedNumber struct {
	Number string `json:"number"` // e.g. "LA-K371P"
	ODM    string `json:"odm"`    // e.g. "Compal"
	Type   string `json:"type"`   // e.g. "compal_la"
}

// DB is a read-only handle to the boards.db reference database.
type DB struct {
	reader *sql.DB
	path   string
	mu     sync.RWMutex
}

// Open opens boards.db at the given path in read-only mode.
// Returns nil (not error) if the file does not exist — feature is disabled.
func Open(dbPath string) *DB {
	if _, err := os.Stat(dbPath); os.IsNotExist(err) {
		log.Printf("[boarddb] %s not found — board resolution disabled", dbPath)
		return nil
	}
	dsn := fmt.Sprintf("file:%s?mode=ro&_journal_mode=WAL", dbPath)
	reader, err := sql.Open("sqlite", dsn)
	if err != nil {
		log.Printf("[boarddb] failed to open %s: %v", dbPath, err)
		return nil
	}
	reader.SetMaxOpenConns(2)

	var count int
	if err := reader.QueryRow("SELECT count(*) FROM boards").Scan(&count); err != nil {
		log.Printf("[boarddb] invalid boards.db schema: %v", err)
		reader.Close()
		return nil
	}
	log.Printf("[boarddb] loaded %d boards from %s", count, dbPath)
	return &DB{reader: reader, path: dbPath}
}

// Available returns true if the board database is loaded and usable.
func (db *DB) Available() bool {
	return db != nil && db.reader != nil
}

// Close closes the database connection.
func (db *DB) Close() {
	if db != nil && db.reader != nil {
		db.reader.Close()
	}
}

// BoardStats holds aggregate statistics about the board database.
type BoardStats struct {
	Total      int            `json:"total"`
	ByBrand    map[string]int `json:"by_brand"`
	ByODM      map[string]int `json:"by_odm"`
	AliasCount int            `json:"alias_count"`
}

// Stats returns board count grouped by brand and ODM.
func (db *DB) Stats() BoardStats {
	if !db.Available() {
		return BoardStats{}
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	s := BoardStats{ByBrand: map[string]int{}, ByODM: map[string]int{}}
	db.reader.QueryRow("SELECT count(*) FROM boards").Scan(&s.Total)
	db.reader.QueryRow("SELECT count(*) FROM board_aliases").Scan(&s.AliasCount)

	rows, _ := db.reader.Query("SELECT brand, count(*) FROM boards GROUP BY brand ORDER BY count(*) DESC")
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var brand string
			var cnt int
			rows.Scan(&brand, &cnt)
			s.ByBrand[brand] = cnt
		}
	}
	rows2, _ := db.reader.Query("SELECT odm, count(*) FROM boards WHERE odm IS NOT NULL AND odm != '' GROUP BY odm ORDER BY count(*) DESC")
	if rows2 != nil {
		defer rows2.Close()
		for rows2.Next() {
			var odm string
			var cnt int
			rows2.Scan(&odm, &cnt)
			s.ByODM[odm] = cnt
		}
	}
	return s
}
