-- Board Database — Full Build from Research
-- Sources: LogiWiki, Badcaps, eBay, repair forums, schematic sites
-- Generated: 2026-04-03

PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- Drop existing data for clean rebuild
DELETE FROM model_aliases;
DELETE FROM board_aliases;
DELETE FROM boards;
DELETE FROM sqlite_sequence;

-- ============================================================
-- APPLE BOARDS (from samples folder + LogiWiki)
-- ============================================================

-- 820-00165: MacBook Air 13" 2015-2017
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Air 13" Early 2015 - Mid 2017', 'A1466', '820-00165-A', 'J113', 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00165', 'apple_820_no_rev');
INSERT INTO model_aliases (board_id, model_name) VALUES
    (last_insert_rowid(), 'MacBookAir7,2');

-- 820-00239: MacBook Pro 13" Touch Bar Late 2016
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 13" Touch Bar Late 2016', 'A1706', '820-00239-A', 'X362 MLB', 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00239', 'apple_820_no_rev');

-- 820-00244: MacBook 12" Early 2016
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook 12" Early 2016', 'A1534', '820-00244-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00244', 'apple_820_no_rev');

-- 820-00281: MacBook Pro 15" Touch Bar Late 2016
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 15" Touch Bar Late 2016 / Mid 2017', 'A1707', '820-00281-A', NULL, 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00281', 'apple_820_no_rev');

-- 820-00291: iMac 27" 5K Late 2015 (lower GPU)
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'iMac 27" Retina 5K Late 2015', 'A1419', '820-00291-A', NULL, 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00291', 'apple_820_no_rev');

-- 820-00292: iMac 27" 5K Late 2015 (higher GPU)
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'iMac 27" Retina 5K Late 2015 (R9 M395/M395X)', 'A1419', '820-00292-A', NULL, 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00292', 'apple_820_no_rev');

-- 820-00939: Mac mini 2018
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'Mac mini 2018', 'A1993', '820-00939-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00939', 'apple_820_no_rev'),
    (last_insert_rowid(), '820.00939', 'apple_820_typo');

-- 820-00967: iMac Pro 2017
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'iMac Pro 27" 2017', 'A1862', '820-00967-A', NULL, 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-00967', 'apple_820_no_rev');

-- 820-01598: MacBook Pro 13" 2TB3 2019
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 13" Two TB3 2019', 'A2159', '820-01598-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-01598', 'apple_820_no_rev');

-- 820-01700: MacBook Pro 16" 2019
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 16" 2019', 'A2141', '820-01700-A', NULL, 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-01700', 'apple_820_no_rev');

-- 820-01779: iMac 27" 5K 2019/2020 (lower GPU)
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'iMac 27" Retina 5K 2019/2020', 'A2115', '820-01779-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-01779', 'apple_820_no_rev');

-- 820-01814: MacBook Pro 15" 2019
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 15" Touch Bar 2019', 'A1990', '820-01814-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-01814', 'apple_820_no_rev');

-- 820-01823: iMac 27" 5K 2019/2020 (higher GPU)
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'iMac 27" Retina 5K 2019/2020 (5700/5700XT)', 'A2115', '820-01823-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-01823', 'apple_820_no_rev');

-- 820-01949: MacBook Pro 13" 4TB3 2020
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 13" Four TB3 2020', 'A2251', '820-01949-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-01949', 'apple_820_no_rev');

-- 820-01987: MacBook Pro 13" 2TB3 2020
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 13" Two TB3 2020', 'A2289', '820-01987-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-01987', 'apple_820_no_rev');

-- 820-02016: MacBook Air 13" M1 2020
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Air 13" M1 Late 2020', 'A2337', '820-02016-A', 'X1757', 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02016', 'apple_820_no_rev');
INSERT INTO model_aliases (board_id, model_name) VALUES
    (last_insert_rowid(), 'MacBookAir10,1');

-- 820-02020: MacBook Pro 13" M1 2020
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 13" M1 Late 2020', 'A2338', '820-02020-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02020', 'apple_820_no_rev');
INSERT INTO model_aliases (board_id, model_name) VALUES
    (last_insert_rowid(), 'MacBookPro17,1');

-- 820-02098: MacBook Pro 14" M1 Pro 2021
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 14" 2021 (M1 Pro)', 'A2442', '820-02098-A', NULL, 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02098', 'apple_820_no_rev'),
    (last_insert_rowid(), '820-02098-07', 'apple_820_rev');

-- 820-02100: MacBook Pro 16" M1 Pro/Max 2021
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 16" 2021 (M1 Pro/Max)', 'A2485', '820-02100-A', NULL, 'Apple', 'apple_820', 'logiwiki');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02100', 'apple_820_no_rev');

-- 820-02443: MacBook Pro 14" M1 Max 2021
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 14" 2021 (M1 Max)', 'A2442', '820-02443-A', NULL, 'Apple', 'apple_820', 'logiwiki+badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02443', 'apple_820_no_rev');

-- 820-02652: MacBook Pro 16" M2 Max 2023
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 16" 2023 (M2 Max)', 'A2780', '820-02652-A', NULL, 'Apple', 'apple_820', 'logiwiki+ebay');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02652', 'apple_820_no_rev');

-- 820-02655: MacBook Pro 14" M2 Max 2023
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 14" 2023 (M2 Max)', 'A2779', '820-02655-A', 'X2371 MLB-C', 'Apple', 'apple_820', 'logiwiki+ebay');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02655', 'apple_820_no_rev');

-- 820-02862: MacBook Air 13" M2 daughter board
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Air 13" M2 2022 (daughter board)', 'A2681', '820-02862-A', NULL, 'Apple', 'apple_820', 'badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02862', 'apple_820_no_rev');

-- 820-02935: MacBook Pro 16" M3 Max 2023
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Apple', 'MacBook Pro 16" 2023 (M3 Max)', 'A2991', '820-02935-A', NULL, 'Apple', 'apple_820', 'badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '820-02935', 'apple_820_no_rev'),
    (last_insert_rowid(), '820-02935-05', 'apple_820_rev');

-- ============================================================
-- COMPAL / LA- BOARDS
-- ============================================================

-- LA-C381P: HP ZBook 15 G3
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'ZBook 15 G3 / ZBook 17 G3', NULL, 'LA-C381P', 'APW50', 'Compal', 'compal_la', 'badcaps+schematic');

-- LA-C881P: Dell XPS 13 9350
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Dell', 'XPS 13 9350', '9350', 'LA-C881P', 'AAZ80', 'Compal', 'compal_la', 'badcaps+schematic');

-- LA-H501P: Acer Nitro 5 AN515-54
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Acer', 'Nitro 5 AN515-54 / AN517-51', 'AN515-54', 'LA-H501P', 'EH50F', 'Compal', 'compal_la', 'badcaps+schematic');

-- LA-J481P: HP ENVY x360 13-AY
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'ENVY x360 13-AY', '13-AY', 'LA-J481P', 'GPR31', 'Compal', 'compal_la', 'badcaps+schematic');

-- LA-K453P: Dell Alienware M15 R5 / G15 5515
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Dell', 'Alienware M15 R5 / G15 5515', NULL, 'LA-K453P', 'GDL56', 'Compal', 'compal_la', 'badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), 'LA-K453', 'compal_la_no_suffix');

-- LA-L191P: Acer Predator Triton/Nitro 5
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Acer', 'Predator Triton 300 PT315-53 / Nitro 5 AN515-57', NULL, 'LA-L191P', 'GH51G', 'Compal', 'compal_la', 'badcaps+schematic');

-- ============================================================
-- LCFC / NM- BOARDS (Lenovo)
-- ============================================================

-- NM-B421: Lenovo ThinkPad X1 Carbon 6th Gen
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'ThinkPad X1 Carbon 6th Gen', NULL, 'NM-B421', NULL, 'LCFC', 'lenovo_nm', 'badcaps');

-- NM-B491: Lenovo ThinkPad T580/P52s
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'ThinkPad T580 / P52s', NULL, 'NM-B491', NULL, 'LCFC', 'lenovo_nm', 'badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), 'NM-b491', 'lenovo_nm_lowercase');

-- NM-B741: Lenovo IdeaPad S145-15IWL
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'IdeaPad S145-15IWL', NULL, 'NM-B741', 'EYG70', 'LCFC', 'lenovo_nm', 'badcaps');

-- NM-B861: Lenovo ThinkPad X1 Carbon 7th Gen / T490
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'ThinkPad X1 Carbon 7th Gen / T490', NULL, 'NM-B861', 'FX490', 'LCFC', 'lenovo_nm', 'badcaps');

-- NM-C631: Lenovo IdeaPad 3 15ADA05/15ARE05
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'IdeaPad 3 15ADA05 / 15ARE05', NULL, 'NM-C631', NULL, 'LCFC', 'lenovo_nm', 'badcaps');

-- NM-C711: Lenovo IdeaPad 5 15ITL05
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'IdeaPad 5 15ITL05', NULL, 'NM-C711', NULL, 'LCFC', 'lenovo_nm', 'badcaps');

-- NM-D011: Lenovo ThinkPad T14 Gen 3
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'ThinkPad T14 Gen 3', NULL, 'NM-D011', NULL, 'LCFC', 'lenovo_nm', 'badcaps');

-- NM-D821: Lenovo (from HY56F_NMD821R10_View.tvw)
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'ThinkPad/IdeaPad (Alder Lake era)', NULL, 'NM-D821', 'HY56F', 'LCFC', 'lenovo_nm', 'sample_filename');

-- NM-E471: Lenovo Legion 5 (AMD Ryzen 6000)
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'Legion 5 15ARH7 / 5 Pro 16ARH7', NULL, 'NM-E471', NULL, 'LCFC', 'lenovo_nm', 'badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), 'JY575', 'lcfc_project'),
    (last_insert_rowid(), 'JY576', 'lcfc_project'),
    (last_insert_rowid(), 'JY676', 'lcfc_project'),
    (last_insert_rowid(), 'JY677', 'lcfc_project');

-- ============================================================
-- QUANTA / DA0 BOARDS
-- ============================================================

-- DA0NJJMBAG0: ASUS TUF Gaming F15 FX506HC/HE
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('ASUS', 'TUF Gaming F15 FX506HC / FX506HE', 'FX506HC', 'DA0NJJMBAG0', 'Quanta NJJ', 'Quanta', 'quanta_da0', 'badcaps+ebay');

-- DAX38CMBAG0: HP Spectre x360 15-DF
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'Spectre x360 15-DF', '15-DF', 'DAX38CMBAG0', 'Quanta X38C', 'Quanta', 'quanta_da0', 'badcaps+ebay');

-- DAZGEAMBCD0: Acer Predator Helios PH717-72
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Acer', 'Predator Helios PH717-72', 'PH717-72', 'DAZGEAMBCD0', 'Quanta ZGEA', 'Quanta', 'quanta_da0', 'thetechstall');

-- DAZGRMB2AC0: Acer Predator Helios Neo 16 PHN16-71
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Acer', 'Predator Helios Neo 16 PHN16-71', 'PHN16-71', 'DAZGRMB2AC0', 'Quanta ZGR', 'Quanta', 'quanta_da0', 'stonetaskin+indiafix');

-- DA0XW2MBAG0: HP ZBook 15 G5
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'ZBook 15 G5 / ZBook 17 G5', NULL, 'DA0XW2MBAG0', 'Quanta XW2', 'Quanta', 'quanta_da0', 'amazon+thetechstall');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), 'Da0XW2MBAG0', 'quanta_da0_mixedcase');

-- DAG37AMB8D0: HP Omen 17-W / Pavilion 17-AB
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'OMEN 17-W / Pavilion 17-AB', NULL, 'DAG37AMB8D0', 'Quanta G37A', 'Quanta', 'quanta_da0', 'ebay+newegg');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), 'dag37amb8d0', 'quanta_da0_lowercase');

-- DAG3BEMBCD0: HP Omen 17-an100
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'OMEN 17-an100', '17-an100', 'DAG3BEMBCD0', 'Quanta G3BE', 'Quanta', 'quanta_da0', 'pdhacker+vinafix');

-- DANJMMB1AA0: ASUS TUF Gaming FA507RM
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('ASUS', 'TUF Gaming FA507RM / FA707RM', 'FA507RM', 'DANJMMB1AA0', 'Quanta NJM', 'Quanta', 'quanta_da0', 'ebay+tomshardware');

-- ============================================================
-- WISTRON BOARDS
-- ============================================================

-- 203088-2: Lenovo ThinkPad L13 Gen 2
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Lenovo', 'ThinkPad L13 Gen 2 (AMD)', NULL, '203088-2', 'ARES-2', 'Wistron', 'wistron_numeric', 'badcaps');

-- 16924-2 / 16924-3M: Acer Spin 5 SP513
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Acer', 'Spin 5 SP513-51 / SP513-52N', 'SP513-52N', '16924-3M', 'WOODY KBL', 'Wistron', 'wistron_numeric', 'sample_filename');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '16924-2', 'wistron_earlier_rev');

-- 12310-1: Acer Aspire 4810T
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Acer', 'Aspire 4810T / 4810TZ', NULL, '12310-1', 'DOH40', 'Wistron', 'wistron_numeric', 'badcaps');

-- ============================================================
-- INVENTEC / 6050A BOARDS (HP numbering)
-- ============================================================

-- 6050A3022401: HP EliteBook 830 G6
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'EliteBook 830 G6', NULL, '6050A3022401-MB-A01', 'CATALONIA', 'Inventec', 'inventec_6050a', 'badcaps+alexlaptoprepair');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '6050A3022401', 'inventec_6050a_short');

-- 6050A3136201: HP EliteBook 830/840 G7
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('HP', 'EliteBook 830 G7 / 840 G7 / ZBook Firefly 14 G7', NULL, '6050A3136201-MB-A01', 'CAMELLIA', 'Wistron', 'inventec_6050a', 'badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), '6050A3136201', 'inventec_6050a_short');

-- ============================================================
-- ASUS BOARDS
-- ============================================================

-- G532LWS / 60NR02T0-MB7010: ASUS ROG Strix G15
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('ASUS', 'ROG Strix G15 G532LWS', 'G532LWS', '60NR02T0-MB7010', NULL, 'ASUS', 'asus_60nb', 'sample_filename');

-- GA401QE: ASUS ROG Zephyrus G14
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('ASUS', 'ROG Zephyrus G14 GA401QE', 'GA401QE', '60NR07B0-MB3020', NULL, 'ASUS', 'asus_60nb', 'badcaps+ebay');

-- G752VS: ASUS ROG G752VS
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('ASUS', 'ROG G752VS', 'G752VS', '60NB0D70-MB1130', NULL, 'ASUS', 'asus_60nb', 'badcaps');

-- X580VD: ASUS VivoBook Pro 15
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('ASUS', 'VivoBook Pro 15 X580VD / N580VD', 'X580VD', '60NB0FL0-MB2010', NULL, 'ASUS', 'asus_60nb', 'badcaps');

-- ============================================================
-- MSI BOARDS
-- ============================================================

-- MS-17G11: MSI GS75 Stealth
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('MSI', 'GS75 Stealth', 'GS75', 'MS-17G11', NULL, 'MSI', 'msi_ms', 'badcaps');

-- ============================================================
-- CLEVO BOARDS
-- ============================================================

-- NH50HPMB: Clevo/Gigabyte G5 KD
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Clevo', 'NH50HP / Gigabyte G5 KD', 'NH50HP', 'NH50HPMB', NULL, 'Clevo', 'clevo', 'badcaps');

-- VULCAN15_N18E: Dell G5 5590 / G7 7590
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Dell', 'G5 5590 / G7 7590 / G7 7790', NULL, 'VULCAN15_N18E', 'VULCAN15', 'Dell', 'dell_codename', 'badcaps');

-- ============================================================
-- RAZER
-- ============================================================

-- RZ09-0409: Razer Blade 15 Advanced 2021
INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Razer', 'Blade 15 Advanced 2021', 'RZ09-0409', 'RZ09-0409', NULL, 'Razer', 'razer_rz', 'badcaps');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), 'R09-0409', 'razer_short');

-- ============================================================
-- SAMSUNG (phone)
-- ============================================================

INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Samsung', 'Galaxy S7', 'SM-G930', 'SM-G930', NULL, 'Samsung', 'samsung_sm', 'sample_filename');
INSERT INTO board_aliases (board_id, alias_number, alias_type) VALUES
    (last_insert_rowid(), 'S7 SM-G930', 'samsung_common_name');

-- ============================================================
-- DESKTOP BOARDS (not laptops, but in samples)
-- ============================================================

INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('ASUS', 'Z590 Desktop Motherboard', NULL, 'ASUS-Z590', NULL, 'ASUS', 'desktop', 'sample_filename');

INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Gigabyte', 'Z390 AORUS', NULL, 'GA-Z390-AORUS', NULL, 'Gigabyte', 'desktop', 'sample_filename');

INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Gigabyte', 'Z170X Gaming GT', NULL, 'GA-Z170X-GAMING-GT', NULL, 'Gigabyte', 'desktop', 'sample_filename');

-- ============================================================
-- MEDION
-- ============================================================

INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Medion', 'AKOYA E15423 (MD64160)', 'MD64160', 'EM_TG819', NULL, 'Unknown', 'medion_odm', 'sample_filename');

-- ============================================================
-- TEST EQUIPMENT (not a computer board)
-- ============================================================

INSERT INTO boards (brand, model, model_number, board_number, board_name, odm, board_number_type, source)
VALUES ('Rigol', 'DSO5000P Oscilloscope', 'DSO5000P', 'DSO5000P', NULL, 'Rigol', 'test_equipment', 'sample_filename');
