-- Board Resolution Query (v2 schema)
-- Usage: sqlite3 boards.db < resolve_board.sql
-- Or interactively: sqlite3 boards.db then paste a query.
--
-- Resolves a board number against boards/models/families/brands by either
-- the canonical board_number or via board_aliases.

.mode column
.headers on
.width 12 30 12 18 12 10 15

-- ============================================================
-- QUERY 1: Resolve NM-A251
-- ============================================================
SELECT '--- Resolving: NM-A251 ---' AS '';

SELECT
    br.name AS brand,
    f.name  AS family,
    m.display_name AS model,
    m.model_number,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
WHERE b.board_number = 'NM-A251'
   OR b.uuid IN (SELECT board_uuid FROM board_aliases WHERE alias = 'NM-A251');

SELECT 'Aliases:' AS '';
SELECT a.alias, a.alias_type
FROM board_aliases a
JOIN boards b ON a.board_uuid = b.uuid
WHERE b.board_number = 'NM-A251';

SELECT 'Compatible model aliases:' AS '';
SELECT ma.alias, ma.alias_type
FROM model_aliases ma
JOIN models m ON ma.model_uuid = m.uuid
JOIN boards b ON b.model_uuid = m.uuid
WHERE b.board_number = 'NM-A251';

-- ============================================================
-- QUERY 2: Resolve 820-02016 (without revision suffix)
-- ============================================================
SELECT '' AS '';
SELECT '--- Resolving: 820-02016 ---' AS '';

SELECT
    br.name AS brand,
    f.name  AS family,
    m.display_name AS model,
    m.model_number,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
WHERE b.board_number LIKE '820-02016%'
   OR b.uuid IN (SELECT board_uuid FROM board_aliases WHERE alias LIKE '820-02016%');

SELECT 'Aliases:' AS '';
SELECT a.alias, a.alias_type
FROM board_aliases a
JOIN boards b ON a.board_uuid = b.uuid
WHERE b.board_number LIKE '820-02016%';

SELECT 'Compatible model aliases:' AS '';
SELECT ma.alias, ma.alias_type
FROM model_aliases ma
JOIN models m ON ma.model_uuid = m.uuid
JOIN boards b ON b.model_uuid = m.uuid
WHERE b.board_number LIKE '820-02016%';

-- ============================================================
-- QUERY 3: Resolve DA0R09MB6H1
-- ============================================================
SELECT '' AS '';
SELECT '--- Resolving: DA0R09MB6H1 ---' AS '';

SELECT
    br.name AS brand,
    f.name  AS family,
    m.display_name AS model,
    m.model_number,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
WHERE b.board_number = 'DA0R09MB6H1'
   OR b.uuid IN (SELECT board_uuid FROM board_aliases WHERE alias = 'DA0R09MB6H1');

-- ============================================================
-- BONUS: Resolve by alias (e.g., Dell DPN or Lenovo FRU)
-- ============================================================
SELECT '' AS '';
SELECT '--- Bonus: Resolve by alias 00HN525 (Lenovo FRU) ---' AS '';

SELECT
    br.name AS brand,
    f.name  AS family,
    m.display_name AS model,
    b.board_number,
    a.alias AS matched_alias,
    a.alias_type
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
JOIN board_aliases a ON a.board_uuid = b.uuid
WHERE a.alias = '00HN525';

SELECT '' AS '';
SELECT '--- Bonus: Resolve by alias 661-16819 (Apple service part) ---' AS '';

SELECT
    br.name AS brand,
    f.name  AS family,
    m.display_name AS model,
    b.board_number,
    a.alias AS matched_alias,
    a.alias_type
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
JOIN board_aliases a ON a.board_uuid = b.uuid
WHERE a.alias = '661-16819';

SELECT '' AS '';
SELECT '--- Bonus: Resolve by alias 072P0M (Dell DPN) ---' AS '';

SELECT
    br.name AS brand,
    f.name  AS family,
    m.display_name AS model,
    b.board_number,
    a.alias AS matched_alias,
    a.alias_type
FROM boards b
JOIN models m   ON b.model_uuid  = m.uuid
JOIN families f ON m.family_uuid = f.uuid
JOIN brands br  ON f.brand_uuid  = br.uuid
JOIN board_aliases a ON a.board_uuid = b.uuid
WHERE a.alias = '072P0M';
