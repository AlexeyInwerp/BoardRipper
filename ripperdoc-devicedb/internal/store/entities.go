package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
)

// HierarchyBrand mirrors boarddb.HierarchyBrand wire shape so a BoardRipper
// client can deserialize the same JSON regardless of whether it talks to
// the in-image boards.db handler or the canonical online service.
type HierarchyBrand struct {
	UUID      string             `json:"uuid"`
	Name      string             `json:"name"`
	Notes     string             `json:"notes,omitempty"`
	ColorID   *int               `json:"color_id,omitempty"`
	ColorName string             `json:"color_name,omitempty"`
	ColorHex  string             `json:"color_hex,omitempty"`
	Families  []*HierarchyFamily `json:"families"`
}

type HierarchyFamily struct {
	UUID      string            `json:"uuid"`
	BrandUUID string            `json:"brand_uuid"`
	Name      string            `json:"name"`
	Notes     string            `json:"notes,omitempty"`
	ColorID   *int              `json:"color_id,omitempty"`
	ColorName string            `json:"color_name,omitempty"`
	ColorHex  string            `json:"color_hex,omitempty"`
	Models    []*HierarchyModel `json:"models"`
}

type HierarchyModel struct {
	UUID        string            `json:"uuid"`
	FamilyUUID  string            `json:"family_uuid"`
	ModelNumber string            `json:"model_number"`
	DisplayName string            `json:"display_name,omitempty"`
	Notes       string            `json:"notes,omitempty"`
	ColorID     *int              `json:"color_id,omitempty"`
	ColorName   string            `json:"color_name,omitempty"`
	ColorHex    string            `json:"color_hex,omitempty"`
	Aliases     []HierarchyAlias  `json:"aliases,omitempty"`
	Boards      []*HierarchyBoard `json:"boards"`
}

type HierarchyBoard struct {
	UUID            string           `json:"uuid"`
	ModelUUID       string           `json:"model_uuid"`
	BoardNumber     string           `json:"board_number"`
	BoardName       string           `json:"board_name,omitempty"`
	ODM             string           `json:"odm,omitempty"`
	BoardNumberType string           `json:"board_number_type,omitempty"`
	Source          string           `json:"source,omitempty"`
	SourceURL       string           `json:"source_url,omitempty"`
	Notes           string           `json:"notes,omitempty"`
	ColorID         *int             `json:"color_id,omitempty"`
	ColorName       string           `json:"color_name,omitempty"`
	ColorHex        string           `json:"color_hex,omitempty"`
	Aliases         []HierarchyAlias `json:"aliases,omitempty"`
}

type HierarchyAlias struct {
	UUID      string `json:"uuid"`
	Alias     string `json:"alias"`
	AliasType string `json:"alias_type,omitempty"`
}

// Hierarchy returns the full Brand → Family → Model → Board tree.
// Mirrors boarddb.DB.Hierarchy(); shape is byte-identical so the
// frontend can use the same parser against either source.
func (s *Store) Hierarchy() ([]*HierarchyBrand, error) {
	brandByUUID := map[string]*HierarchyBrand{}
	familyByUUID := map[string]*HierarchyFamily{}
	modelByUUID := map[string]*HierarchyModel{}
	boardByUUID := map[string]*HierarchyBoard{}

	colors, err := s.entityColorMap()
	if err != nil {
		return nil, err
	}

	var brands []*HierarchyBrand
	rows, err := s.DB.Query("SELECT uuid, name, notes FROM brands ORDER BY name")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		b := &HierarchyBrand{}
		var notes sql.NullString
		if err := rows.Scan(&b.UUID, &b.Name, &notes); err != nil {
			rows.Close()
			return nil, err
		}
		b.Notes = notes.String
		if c, ok := colors[colorKey("brand", b.UUID)]; ok {
			b.ColorID, b.ColorName, b.ColorHex = &c.id, c.name, c.hex
		}
		brandByUUID[b.UUID] = b
		brands = append(brands, b)
	}
	rows.Close()

	rows, err = s.DB.Query("SELECT uuid, brand_uuid, name, notes FROM families ORDER BY name")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		f := &HierarchyFamily{}
		var notes sql.NullString
		if err := rows.Scan(&f.UUID, &f.BrandUUID, &f.Name, &notes); err != nil {
			rows.Close()
			return nil, err
		}
		f.Notes = notes.String
		if c, ok := colors[colorKey("family", f.UUID)]; ok {
			f.ColorID, f.ColorName, f.ColorHex = &c.id, c.name, c.hex
		}
		familyByUUID[f.UUID] = f
		if parent, ok := brandByUUID[f.BrandUUID]; ok {
			parent.Families = append(parent.Families, f)
		}
	}
	rows.Close()

	rows, err = s.DB.Query("SELECT uuid, family_uuid, model_number, display_name, notes FROM models ORDER BY model_number")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		m := &HierarchyModel{}
		var disp, notes sql.NullString
		if err := rows.Scan(&m.UUID, &m.FamilyUUID, &m.ModelNumber, &disp, &notes); err != nil {
			rows.Close()
			return nil, err
		}
		m.DisplayName = disp.String
		m.Notes = notes.String
		if c, ok := colors[colorKey("model", m.UUID)]; ok {
			m.ColorID, m.ColorName, m.ColorHex = &c.id, c.name, c.hex
		}
		modelByUUID[m.UUID] = m
		if parent, ok := familyByUUID[m.FamilyUUID]; ok {
			parent.Models = append(parent.Models, m)
		}
	}
	rows.Close()

	rows, err = s.DB.Query(`SELECT uuid, model_uuid, board_number, board_name, odm,
	                              board_number_type, source, source_url, notes
	                         FROM boards ORDER BY board_number`)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		b := &HierarchyBoard{}
		var boardName, odm, btype, source, sourceURL, notes sql.NullString
		if err := rows.Scan(&b.UUID, &b.ModelUUID, &b.BoardNumber, &boardName, &odm,
			&btype, &source, &sourceURL, &notes); err != nil {
			rows.Close()
			return nil, err
		}
		b.BoardName = boardName.String
		b.ODM = odm.String
		b.BoardNumberType = btype.String
		b.Source = source.String
		b.SourceURL = sourceURL.String
		b.Notes = notes.String
		if c, ok := colors[colorKey("board", b.UUID)]; ok {
			b.ColorID, b.ColorName, b.ColorHex = &c.id, c.name, c.hex
		}
		boardByUUID[b.UUID] = b
		if parent, ok := modelByUUID[b.ModelUUID]; ok {
			parent.Boards = append(parent.Boards, b)
		}
	}
	rows.Close()

	rows, err = s.DB.Query("SELECT uuid, board_uuid, alias, alias_type FROM board_aliases ORDER BY alias")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var aliasUUID, boardUUID, alias string
		var atype sql.NullString
		if err := rows.Scan(&aliasUUID, &boardUUID, &alias, &atype); err != nil {
			rows.Close()
			return nil, err
		}
		if b, ok := boardByUUID[boardUUID]; ok {
			b.Aliases = append(b.Aliases, HierarchyAlias{UUID: aliasUUID, Alias: alias, AliasType: atype.String})
		}
	}
	rows.Close()

	rows, err = s.DB.Query("SELECT uuid, model_uuid, alias, alias_type FROM model_aliases ORDER BY alias")
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var aliasUUID, modelUUID, alias string
		var atype sql.NullString
		if err := rows.Scan(&aliasUUID, &modelUUID, &alias, &atype); err != nil {
			rows.Close()
			return nil, err
		}
		if m, ok := modelByUUID[modelUUID]; ok {
			m.Aliases = append(m.Aliases, HierarchyAlias{UUID: aliasUUID, Alias: alias, AliasType: atype.String})
		}
	}
	rows.Close()

	return brands, nil
}

type colorRow struct {
	id   int
	name string
	hex  string
}

func colorKey(scope, uuid string) string { return scope + ":" + uuid }

// entityColorMap loads the full entity_color → color join so the hierarchy
// walk can attach a resolved colour without N+1 queries.
func (s *Store) entityColorMap() (map[string]colorRow, error) {
	rows, err := s.DB.Query(`
		SELECT ec.scope_type, ec.scope_uuid, c.id, c.name, COALESCE(c.hex, '')
		FROM entity_color ec
		JOIN colors c ON c.id = ec.color_id
	`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]colorRow{}
	for rows.Next() {
		var scopeType, scopeUUID string
		var c colorRow
		if err := rows.Scan(&scopeType, &scopeUUID, &c.id, &c.name, &c.hex); err != nil {
			return nil, err
		}
		out[colorKey(scopeType, scopeUUID)] = c
	}
	return out, nil
}

// ErrNotFound is returned by single-entity getters when the UUID is unknown.
var ErrNotFound = errors.New("not found")

// EntityFieldValue returns the current canonical value of a single field on a
// single entity. Used by optimistic-concurrency checks (value_from match) and
// by the API's per-entity-field popover. Returns ("", ErrNotFound) when the
// entity does not exist.
func (s *Store) EntityFieldValue(targetType, uuid, field string) (string, error) {
	tbl, col, err := tableColForField(targetType, field)
	if err != nil {
		return "", err
	}
	if targetType == "entity_color" {
		// uuid is "scope_type:scope_uuid"; field must be color_id.
		scopeType, scopeUUID, ok := splitScope(uuid)
		if !ok {
			return "", fmt.Errorf("entity_color target_uuid must be scope_type:scope_uuid: %q", uuid)
		}
		var v sql.NullInt64
		err := s.DB.QueryRow("SELECT color_id FROM entity_color WHERE scope_type=? AND scope_uuid=?",
			scopeType, scopeUUID).Scan(&v)
		if errors.Is(err, sql.ErrNoRows) {
			return "", nil // no row = no current value (NULL)
		}
		if err != nil {
			return "", err
		}
		if !v.Valid {
			return "", nil
		}
		return fmt.Sprintf("%d", v.Int64), nil
	}

	var v sql.NullString
	q := fmt.Sprintf("SELECT %s FROM %s WHERE uuid=?", col, tbl)
	err = s.DB.QueryRow(q, uuid).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	if err != nil {
		return "", err
	}
	return v.String, nil
}

// splitScope splits "scope_type:scope_uuid" used as the entity_color target.
func splitScope(s string) (scopeType, scopeUUID string, ok bool) {
	i := strings.Index(s, ":")
	if i <= 0 || i == len(s)-1 {
		return "", "", false
	}
	return s[:i], s[i+1:], true
}

// SingleEntity returns one entity row as a typed Hierarchy* node (with its
// immediate children populated when applicable — e.g. a brand returns its
// families).
func (s *Store) SingleEntity(targetType, uuid string) (any, error) {
	tree, err := s.Hierarchy()
	if err != nil {
		return nil, err
	}
	switch targetType {
	case "brand":
		for _, b := range tree {
			if b.UUID == uuid {
				return b, nil
			}
		}
	case "family":
		for _, b := range tree {
			for _, f := range b.Families {
				if f.UUID == uuid {
					return f, nil
				}
			}
		}
	case "model":
		for _, b := range tree {
			for _, f := range b.Families {
				for _, m := range f.Models {
					if m.UUID == uuid {
						return m, nil
					}
				}
			}
		}
	case "board":
		for _, b := range tree {
			for _, f := range b.Families {
				for _, m := range f.Models {
					for _, bd := range m.Boards {
						if bd.UUID == uuid {
							return bd, nil
						}
					}
				}
			}
		}
	default:
		return nil, fmt.Errorf("unknown target type %q", targetType)
	}
	return nil, ErrNotFound
}

// ResolveResult is the wire shape of GET /v1/resolve.
type ResolveResult struct {
	Query   string            `json:"query"`
	Match   *ResolvedBoard    `json:"match,omitempty"`
	Matches []*ResolvedBoard  `json:"matches,omitempty"`
}

type ResolvedBoard struct {
	BoardUUID   string `json:"board_uuid"`
	BoardNumber string `json:"board_number"`
	BoardName   string `json:"board_name,omitempty"`
	ODM         string `json:"odm,omitempty"`
	Brand       string `json:"brand"`
	Family      string `json:"family"`
	Model       string `json:"model,omitempty"`
	ModelNumber string `json:"model_number,omitempty"`
	Source      string `json:"source,omitempty"`
}

// Resolve runs a best-effort match for `q` against board_number (exact),
// board_aliases (exact), and a substring fallback. Mirrors boarddb.Resolve
// closely but is simpler — the v1 API contract only promises a "result-or-empty"
// shape; the BoardRipper-side Resolve remains the source of truth for messy
// inputs like filenames.
func (s *Store) Resolve(q string) (*ResolveResult, error) {
	upper := strings.ToUpper(strings.TrimSpace(q))
	if upper == "" {
		return &ResolveResult{Query: q}, nil
	}

	row := s.DB.QueryRow(`
		SELECT b.uuid, b.board_number, COALESCE(b.board_name,''), COALESCE(b.odm,''),
		       br.name, f.name, COALESCE(m.display_name, ''), m.model_number, COALESCE(b.source,'')
		FROM boards b
		JOIN models m ON b.model_uuid = m.uuid
		JOIN families f ON m.family_uuid = f.uuid
		JOIN brands br ON f.brand_uuid = br.uuid
		WHERE upper(b.board_number) = ?
		LIMIT 1`, upper)
	hit := &ResolvedBoard{}
	if err := row.Scan(&hit.BoardUUID, &hit.BoardNumber, &hit.BoardName, &hit.ODM,
		&hit.Brand, &hit.Family, &hit.Model, &hit.ModelNumber, &hit.Source); err == nil {
		return &ResolveResult{Query: q, Match: hit}, nil
	}

	// Alias
	var boardUUID string
	if err := s.DB.QueryRow("SELECT board_uuid FROM board_aliases WHERE upper(alias)=? LIMIT 1", upper).Scan(&boardUUID); err == nil {
		row := s.DB.QueryRow(`
			SELECT b.uuid, b.board_number, COALESCE(b.board_name,''), COALESCE(b.odm,''),
			       br.name, f.name, COALESCE(m.display_name, ''), m.model_number, COALESCE(b.source,'')
			FROM boards b
			JOIN models m ON b.model_uuid = m.uuid
			JOIN families f ON m.family_uuid = f.uuid
			JOIN brands br ON f.brand_uuid = br.uuid
			WHERE b.uuid = ?`, boardUUID)
		hit := &ResolvedBoard{}
		if err := row.Scan(&hit.BoardUUID, &hit.BoardNumber, &hit.BoardName, &hit.ODM,
			&hit.Brand, &hit.Family, &hit.Model, &hit.ModelNumber, &hit.Source); err == nil {
			return &ResolveResult{Query: q, Match: hit}, nil
		}
	}

	return &ResolveResult{Query: q}, nil
}
