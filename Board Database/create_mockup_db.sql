-- Board Database Mockup Schema + Seed Data
-- Tests resolution of: NM-A251, 820-02016, DA0R09MB6H1

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Color lookup (FK target for boards.color_id)
CREATE TABLE IF NOT EXISTS colors (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    hex TEXT,                                   -- nullable; populated by themes work later
    sort_order INTEGER NOT NULL DEFAULT 0
);

-- Color seed (12 entries: 4 core + 8 exceptions, hex tints populated for themes work)
INSERT OR IGNORE INTO colors (id, name, hex, sort_order) VALUES
    (1,  'black',  '#1a1a1a', 1),
    (2,  'red',    '#8a1a1a', 2),
    (3,  'green',  '#1a4a2a', 3),
    (4,  'blue',   '#1a3a8a', 4),
    (5,  'white',  '#e0e0e0', 5),
    (6,  'yellow', '#a89030', 6),
    (7,  'purple', '#5a2a8a', 7),
    (8,  'orange', '#c06030', 8),
    (9,  'pink',   '#c060a0', 9),
    (10, 'brown',  '#6a4a2a', 10),
    (11, 'silver', '#a8a8b0', 11),
    (12, 'gold',   '#a89050', 12);

-- Core boards table
CREATE TABLE IF NOT EXISTS boards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid TEXT NOT NULL UNIQUE,
    brand TEXT NOT NULL,
    model TEXT,
    model_number TEXT,
    board_number TEXT NOT NULL,
    board_name TEXT,
    odm TEXT,
    board_number_type TEXT,
    color_id INTEGER REFERENCES colors(id),
    source TEXT NOT NULL,
    source_url TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Alias board numbers (FRU, spare parts, service parts)
CREATE TABLE IF NOT EXISTS board_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    alias_number TEXT NOT NULL,
    alias_type TEXT
);

-- Multiple laptop models per board
CREATE TABLE IF NOT EXISTS model_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    model_name TEXT NOT NULL
);

-- Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_unique ON boards(board_number, brand);
CREATE INDEX IF NOT EXISTS idx_board_number ON boards(board_number);
CREATE INDEX IF NOT EXISTS idx_brand_model ON boards(brand, model);
CREATE INDEX IF NOT EXISTS idx_alias_number ON board_aliases(alias_number);
CREATE INDEX IF NOT EXISTS idx_model_alias ON model_aliases(model_name);
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_uuid ON boards(uuid);

-- ============================================================
-- SEED DATA: 3 example boards
-- ============================================================

-- 1. Lenovo ThinkPad T450 — NM-A251
INSERT INTO boards (uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source, source_url)
VALUES ('15f96acc-a128-49ef-b69d-db84fcecb2b2', 'Lenovo', 'ThinkPad T450', '20BU/20BX', 'NM-A251', 'AIVL0', 'LCFC', 'lenovo_nm', 'boardschematic', 'https://boardschematic.com/lenovo-thinkpad-t450-uma-gpu-schematic-aivl0-nm-a251/');

INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (1, '00HN525', 'lenovo_fru'),
    (1, '00HN529', 'lenovo_fru'),
    (1, '00HN501', 'lenovo_fru'),
    (1, '00HT728', 'lenovo_fru');

-- 2. Apple MacBook Air 13" M1 (Late 2020) — 820-02016-A
INSERT INTO boards (uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source, source_url)
VALUES ('609150c4-612e-41a3-a18b-971fb8c09684', 'Apple', 'MacBook Air 13" M1 Late 2020', 'A2337', '820-02016-A', 'X1757', 'Apple', 'apple_820', 'logiwiki', 'https://logi.wiki/index.php/Board_Number_by_A_Number');

INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (2, '661-16809', 'apple_service'),
    (2, '661-16810', 'apple_service'),
    (2, '661-16819', 'apple_service'),
    (2, '661-16822', 'apple_service'),
    (2, '661-16823', 'apple_service'),
    (2, '661-27558', 'apple_service'),
    (2, '661-27559', 'apple_service'),
    (2, '661-27570', 'apple_service'),
    (2, '661-27575', 'apple_service'),
    (2, '661-27576', 'apple_service'),
    (2, 'EMC 3598', 'emc');

INSERT INTO model_aliases (board_id, model_name) VALUES
    (2, 'MacBookAir10,1');

-- 3. Dell Inspiron 17R 5720/7720 — DA0R09MB6H1
INSERT INTO boards (uuid, brand, model, model_number, board_number, board_name, odm, board_number_type, source, source_url)
VALUES ('0d753a80-4a46-4e70-88f7-60c0ca039d0e', 'Dell', 'Inspiron 17R 5720', 'N5720', 'DA0R09MB6H1', 'Quanta R09', 'Quanta', 'quanta_da0', 'ebay', 'https://www.ebay.com/p/1981179302');

INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (3, '0F9C71', 'dell_dpn'),
    (3, 'F9C71', 'dell_dpn'),
    (3, '072P0M', 'dell_dpn'),
    (3, '72P0M', 'dell_dpn'),
    (3, '01040N', 'dell_dpn'),
    (3, '1040N', 'dell_dpn'),
    (3, '31R09MB00L0', 'alt_board'),
    (3, 'DA0R09MB6H3', 'board_variant');

INSERT INTO model_aliases (board_id, model_name) VALUES
    (3, 'Inspiron 17R 7720'),
    (3, 'Inspiron N7720');
