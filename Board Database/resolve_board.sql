-- Board Resolution Query
-- Usage: sqlite3 boards.db < resolve_board.sql
-- Or interactively: sqlite3 boards.db then paste a query

-- Resolves a board number by checking both primary board_number AND aliases
-- Replace :query with the board number to look up

.mode column
.headers on
.width 12 30 12 18 12 10 15

-- ============================================================
-- QUERY 1: Resolve NM-A251
-- ============================================================
SELECT '--- Resolving: NM-A251 ---' AS '';

SELECT
    b.brand,
    b.model,
    b.model_number,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type
FROM boards b
WHERE b.board_number = 'NM-A251'
   OR b.id IN (SELECT board_id FROM board_aliases WHERE alias_number = 'NM-A251');

SELECT 'Aliases:' AS '';
SELECT a.alias_number, a.alias_type
FROM board_aliases a
JOIN boards b ON a.board_id = b.id
WHERE b.board_number = 'NM-A251';

SELECT 'Compatible models:' AS '';
SELECT m.model_name
FROM model_aliases m
JOIN boards b ON m.board_id = b.id
WHERE b.board_number = 'NM-A251';

-- ============================================================
-- QUERY 2: Resolve 820-02016 (without revision suffix)
-- ============================================================
SELECT '' AS '';
SELECT '--- Resolving: 820-02016 ---' AS '';

SELECT
    b.brand,
    b.model,
    b.model_number,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type
FROM boards b
WHERE b.board_number LIKE '820-02016%'
   OR b.id IN (SELECT board_id FROM board_aliases WHERE alias_number LIKE '820-02016%');

SELECT 'Aliases:' AS '';
SELECT a.alias_number, a.alias_type
FROM board_aliases a
JOIN boards b ON a.board_id = b.id
WHERE b.board_number LIKE '820-02016%';

SELECT 'Compatible models:' AS '';
SELECT m.model_name
FROM model_aliases m
JOIN boards b ON m.board_id = b.id
WHERE b.board_number LIKE '820-02016%';

-- ============================================================
-- QUERY 3: Resolve DA0R09MB6H1
-- ============================================================
SELECT '' AS '';
SELECT '--- Resolving: DA0R09MB6H1 ---' AS '';

SELECT
    b.brand,
    b.model,
    b.model_number,
    b.board_number,
    b.board_name,
    b.odm,
    b.board_number_type
FROM boards b
WHERE b.board_number = 'DA0R09MB6H1'
   OR b.id IN (SELECT board_id FROM board_aliases WHERE alias_number = 'DA0R09MB6H1');

SELECT 'Aliases:' AS '';
SELECT a.alias_number, a.alias_type
FROM board_aliases a
JOIN boards b ON a.board_id = b.id
WHERE b.board_number = 'DA0R09MB6H1';

SELECT 'Compatible models:' AS '';
SELECT m.model_name
FROM model_aliases m
JOIN boards b ON m.board_id = b.id
WHERE b.board_number = 'DA0R09MB6H1';

-- ============================================================
-- BONUS: Resolve by alias (e.g., Dell DPN or Lenovo FRU)
-- ============================================================
SELECT '' AS '';
SELECT '--- Bonus: Resolve by alias 00HN525 (Lenovo FRU) ---' AS '';

SELECT
    b.brand,
    b.model,
    b.board_number,
    b.board_name,
    a.alias_number AS matched_alias,
    a.alias_type
FROM boards b
JOIN board_aliases a ON a.board_id = b.id
WHERE a.alias_number = '00HN525';

SELECT '' AS '';
SELECT '--- Bonus: Resolve by alias 661-16819 (Apple service part) ---' AS '';

SELECT
    b.brand,
    b.model,
    b.board_number,
    b.board_name,
    a.alias_number AS matched_alias,
    a.alias_type
FROM boards b
JOIN board_aliases a ON a.board_id = b.id
WHERE a.alias_number = '661-16819';

SELECT '' AS '';
SELECT '--- Bonus: Resolve by alias 072P0M (Dell DPN) ---' AS '';

SELECT
    b.brand,
    b.model,
    b.board_number,
    b.board_name,
    a.alias_number AS matched_alias,
    a.alias_type
FROM boards b
JOIN board_aliases a ON a.board_id = b.id
WHERE a.alias_number = '072P0M';
