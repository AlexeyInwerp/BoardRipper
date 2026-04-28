-- Board Database v2 — Schema Bootstrap
-- For fresh-environment bootstrap. Edits to data flow through migrations
-- or the future Database Editor; this file produces an empty v2-shape DB.

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);
INSERT OR IGNORE INTO schema_version (version) VALUES (2);

-- ============================================================
-- Reference palette
-- ============================================================
CREATE TABLE IF NOT EXISTS colors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hex TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO colors (id, name, sort_order) VALUES
    (1,'black',1),  (2,'red',2),    (3,'green',3),  (4,'blue',4),
    (5,'white',5),  (6,'yellow',6), (7,'purple',7), (8,'orange',8),
    (9,'pink',9),   (10,'brown',10),(11,'silver',11),(12,'gold',12);

-- ============================================================
-- Entity hierarchy
-- ============================================================
CREATE TABLE IF NOT EXISTS brands (
    uuid TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    notes TEXT
);

CREATE TABLE IF NOT EXISTS families (
    uuid TEXT PRIMARY KEY,
    brand_uuid TEXT NOT NULL REFERENCES brands(uuid) ON DELETE CASCADE,
    name TEXT NOT NULL,
    notes TEXT,
    UNIQUE (brand_uuid, name)
);
CREATE INDEX IF NOT EXISTS idx_families_brand ON families(brand_uuid);

CREATE TABLE IF NOT EXISTS models (
    uuid TEXT PRIMARY KEY,
    family_uuid TEXT NOT NULL REFERENCES families(uuid) ON DELETE CASCADE,
    model_number TEXT NOT NULL,
    display_name TEXT,
    notes TEXT,
    UNIQUE (family_uuid, model_number)
);
CREATE INDEX IF NOT EXISTS idx_models_family ON models(family_uuid);
CREATE INDEX IF NOT EXISTS idx_models_number ON models(model_number);

CREATE TABLE IF NOT EXISTS boards (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
    board_number TEXT NOT NULL,
    board_name TEXT,
    odm TEXT,
    board_number_type TEXT,
    source TEXT,
    source_url TEXT,
    notes TEXT,
    UNIQUE (board_number, model_uuid)
);
CREATE INDEX IF NOT EXISTS idx_boards_model ON boards(model_uuid);
CREATE INDEX IF NOT EXISTS idx_boards_number ON boards(board_number);

-- ============================================================
-- Aliases
-- ============================================================
CREATE TABLE IF NOT EXISTS board_aliases (
    uuid TEXT PRIMARY KEY,
    board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    alias_type TEXT,
    UNIQUE (alias, alias_type)
);
CREATE INDEX IF NOT EXISTS idx_board_aliases_alias ON board_aliases(alias);

CREATE TABLE IF NOT EXISTS model_aliases (
    uuid TEXT PRIMARY KEY,
    model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
    alias TEXT NOT NULL,
    alias_type TEXT,
    UNIQUE (alias, alias_type)
);
CREATE INDEX IF NOT EXISTS idx_model_aliases_alias ON model_aliases(alias);

-- ============================================================
-- Cascading metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS entity_color (
    scope_type TEXT NOT NULL CHECK(scope_type IN ('brand','family','model','board')),
    scope_uuid TEXT NOT NULL,
    color_id INTEGER NOT NULL REFERENCES colors(id),
    PRIMARY KEY (scope_type, scope_uuid)
);
CREATE INDEX IF NOT EXISTS idx_entity_color_uuid ON entity_color(scope_uuid);

CREATE TABLE IF NOT EXISTS board_openboarddata (
    board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
    external_id TEXT NOT NULL,
    notes TEXT,
    PRIMARY KEY (board_uuid, external_id)
);
CREATE INDEX IF NOT EXISTS idx_obd_board ON board_openboarddata(board_uuid);
