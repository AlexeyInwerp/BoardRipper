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
	Family       string   `json:"family"`
	Model        string   `json:"model"`
	ModelNumber  string   `json:"model_number,omitempty"`
	BoardName    string   `json:"board_name,omitempty"`
	ODM          string   `json:"odm"`
	Type         string   `json:"board_number_type,omitempty"`
	Color        string   `json:"color,omitempty"`
	ColorHex     string   `json:"color_hex,omitempty"`
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

// HierarchyBrand is a brand node in the Database Editor hierarchy tree.
type HierarchyBrand struct {
	UUID     string             `json:"uuid"`
	Name     string             `json:"name"`
	Notes    string             `json:"notes,omitempty"`
	Families []*HierarchyFamily `json:"families"`
}

// HierarchyFamily is a family node grouped under a brand.
type HierarchyFamily struct {
	UUID   string            `json:"uuid"`
	Name   string            `json:"name"`
	Notes  string            `json:"notes,omitempty"`
	Models []*HierarchyModel `json:"models"`
}

// HierarchyModel is a model node grouped under a family.
type HierarchyModel struct {
	UUID        string            `json:"uuid"`
	ModelNumber string            `json:"model_number"`
	DisplayName string            `json:"display_name,omitempty"`
	Notes       string            `json:"notes,omitempty"`
	Aliases     []HierarchyAlias  `json:"aliases,omitempty"`
	Boards      []*HierarchyBoard `json:"boards"`
}

// HierarchyBoard is a board node grouped under a model.
type HierarchyBoard struct {
	UUID            string           `json:"uuid"`
	BoardNumber     string           `json:"board_number"`
	BoardName       string           `json:"board_name,omitempty"`
	ODM             string           `json:"odm,omitempty"`
	BoardNumberType string           `json:"board_number_type,omitempty"`
	Source          string           `json:"source,omitempty"`
	SourceURL       string           `json:"source_url,omitempty"`
	Notes           string           `json:"notes,omitempty"`
	Aliases         []HierarchyAlias `json:"aliases,omitempty"`
}

// HierarchyAlias is a single alias attached to a board or model.
type HierarchyAlias struct {
	UUID      string `json:"uuid"`
	Alias     string `json:"alias"`
	AliasType string `json:"alias_type,omitempty"`
}

// Hierarchy returns the full Brand → Family → Model → Board hierarchy with
// aliases attached at the appropriate scope. Suitable for the Database Editor
// panel — small payload (~150 entities at v2 scale), single fetch on demand.
//
// Implementation: 6 simple queries (4 entity tables + 2 alias tables) and
// build the tree in memory. No joins; all linking happens client-side via
// flat UUID lookups. Read-only.
func (db *DB) Hierarchy() []*HierarchyBrand {
	if !db.Available() {
		return nil
	}
	db.mu.RLock()
	defer db.mu.RUnlock()

	// --- Brands ---
	brandByUUID := map[string]*HierarchyBrand{}
	var brands []*HierarchyBrand
	rows, _ := db.reader.Query("SELECT uuid, name, notes FROM brands ORDER BY name")
	if rows != nil {
		for rows.Next() {
			b := &HierarchyBrand{}
			var notes *string
			if err := rows.Scan(&b.UUID, &b.Name, &notes); err != nil {
				continue
			}
			if notes != nil {
				b.Notes = *notes
			}
			brandByUUID[b.UUID] = b
			brands = append(brands, b)
		}
		rows.Close()
	}

	// --- Families ---
	familyByUUID := map[string]*HierarchyFamily{}
	rows2, _ := db.reader.Query("SELECT uuid, brand_uuid, name, notes FROM families ORDER BY name")
	if rows2 != nil {
		for rows2.Next() {
			f := &HierarchyFamily{}
			var brandUUID string
			var notes *string
			if err := rows2.Scan(&f.UUID, &brandUUID, &f.Name, &notes); err != nil {
				continue
			}
			if notes != nil {
				f.Notes = *notes
			}
			familyByUUID[f.UUID] = f
			if parent, ok := brandByUUID[brandUUID]; ok {
				parent.Families = append(parent.Families, f)
			}
		}
		rows2.Close()
	}

	// --- Models ---
	modelByUUID := map[string]*HierarchyModel{}
	rows3, _ := db.reader.Query(`
		SELECT uuid, family_uuid, model_number, display_name, notes
		FROM models ORDER BY model_number`)
	if rows3 != nil {
		for rows3.Next() {
			m := &HierarchyModel{}
			var familyUUID string
			var displayName, notes *string
			if err := rows3.Scan(&m.UUID, &familyUUID, &m.ModelNumber, &displayName, &notes); err != nil {
				continue
			}
			if displayName != nil {
				m.DisplayName = *displayName
			}
			if notes != nil {
				m.Notes = *notes
			}
			modelByUUID[m.UUID] = m
			if parent, ok := familyByUUID[familyUUID]; ok {
				parent.Models = append(parent.Models, m)
			}
		}
		rows3.Close()
	}

	// --- Boards ---
	boardByUUID := map[string]*HierarchyBoard{}
	rows4, _ := db.reader.Query(`
		SELECT uuid, model_uuid, board_number, board_name, odm,
		       board_number_type, source, source_url, notes
		FROM boards ORDER BY board_number`)
	if rows4 != nil {
		for rows4.Next() {
			b := &HierarchyBoard{}
			var modelUUID string
			var boardName, odm, btype, source, sourceURL, notes *string
			if err := rows4.Scan(&b.UUID, &modelUUID, &b.BoardNumber, &boardName, &odm,
				&btype, &source, &sourceURL, &notes); err != nil {
				continue
			}
			if boardName != nil {
				b.BoardName = *boardName
			}
			if odm != nil {
				b.ODM = *odm
			}
			if btype != nil {
				b.BoardNumberType = *btype
			}
			if source != nil {
				b.Source = *source
			}
			if sourceURL != nil {
				b.SourceURL = *sourceURL
			}
			if notes != nil {
				b.Notes = *notes
			}
			boardByUUID[b.UUID] = b
			if parent, ok := modelByUUID[modelUUID]; ok {
				parent.Boards = append(parent.Boards, b)
			}
		}
		rows4.Close()
	}

	// --- Board aliases ---
	rowsBA, _ := db.reader.Query("SELECT uuid, board_uuid, alias, alias_type FROM board_aliases ORDER BY alias")
	if rowsBA != nil {
		for rowsBA.Next() {
			var aliasUUID, boardUUID, alias string
			var aliasType *string
			if err := rowsBA.Scan(&aliasUUID, &boardUUID, &alias, &aliasType); err != nil {
				continue
			}
			if board, ok := boardByUUID[boardUUID]; ok {
				a := HierarchyAlias{UUID: aliasUUID, Alias: alias}
				if aliasType != nil {
					a.AliasType = *aliasType
				}
				board.Aliases = append(board.Aliases, a)
			}
		}
		rowsBA.Close()
	}

	// --- Model aliases ---
	rowsMA, _ := db.reader.Query("SELECT uuid, model_uuid, alias, alias_type FROM model_aliases ORDER BY alias")
	if rowsMA != nil {
		for rowsMA.Next() {
			var aliasUUID, modelUUID, alias string
			var aliasType *string
			if err := rowsMA.Scan(&aliasUUID, &modelUUID, &alias, &aliasType); err != nil {
				continue
			}
			if model, ok := modelByUUID[modelUUID]; ok {
				a := HierarchyAlias{UUID: aliasUUID, Alias: alias}
				if aliasType != nil {
					a.AliasType = *aliasType
				}
				model.Aliases = append(model.Aliases, a)
			}
		}
		rowsMA.Close()
	}

	return brands
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

	rows, _ := db.reader.Query(`
		SELECT br.name, count(*)
		FROM boards b
		JOIN models m   ON b.model_uuid  = m.uuid
		JOIN families f ON m.family_uuid = f.uuid
		JOIN brands br  ON f.brand_uuid  = br.uuid
		GROUP BY br.name
		ORDER BY count(*) DESC
	`)
	if rows != nil {
		defer rows.Close()
		for rows.Next() {
			var brand string
			var cnt int
			rows.Scan(&brand, &cnt)
			s.ByBrand[brand] = cnt
		}
	}
	rows2, _ := db.reader.Query(`
		SELECT odm, count(*) FROM boards
		WHERE odm IS NOT NULL AND odm != ''
		GROUP BY odm ORDER BY count(*) DESC
	`)
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
