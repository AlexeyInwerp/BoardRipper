<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Canonical schema, copied verbatim from the Go reference's compiled-in DDL
 * (recovered by inspecting the running server's sqlite_master and the binary
 * string table). Use CREATE TABLE IF NOT EXISTS so ensure() is idempotent on
 * every boot.
 *
 * The `token_lookup` columns on install_tokens / user_tokens are not in the
 * spec proper but are present in the Go reference: argon2id hashes can't be
 * indexed by token value, so a fast lookup column (hex SHA-256 prefix of the
 * plaintext token) is stored alongside and indexed. We follow that.
 */
final class Schema
{
    public const VERSION = 2;

    public static function ensure(): void
    {
        $pdo = Db::pdo();
        foreach (self::statements() as $stmt) {
            $pdo->exec($stmt);
        }
        Log::info('schema', 'applied');
    }

    /** @return string[] */
    private static function statements(): array
    {
        return [
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)",
            "INSERT OR IGNORE INTO schema_version (version) VALUES (" . self::VERSION . ")",

            "CREATE TABLE IF NOT EXISTS colors (
                id INTEGER PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                hex TEXT,
                sort_order INTEGER NOT NULL DEFAULT 0
            )",

            "CREATE TABLE IF NOT EXISTS brands (
                uuid TEXT PRIMARY KEY,
                name TEXT NOT NULL UNIQUE,
                notes TEXT
            )",

            "CREATE TABLE IF NOT EXISTS families (
                uuid TEXT PRIMARY KEY,
                brand_uuid TEXT NOT NULL REFERENCES brands(uuid) ON DELETE CASCADE,
                name TEXT NOT NULL,
                notes TEXT,
                UNIQUE (brand_uuid, name)
            )",
            "CREATE INDEX IF NOT EXISTS idx_families_brand ON families(brand_uuid)",

            "CREATE TABLE IF NOT EXISTS models (
                uuid TEXT PRIMARY KEY,
                family_uuid TEXT NOT NULL REFERENCES families(uuid) ON DELETE CASCADE,
                model_number TEXT NOT NULL,
                display_name TEXT,
                notes TEXT,
                UNIQUE (family_uuid, model_number)
            )",
            "CREATE INDEX IF NOT EXISTS idx_models_family ON models(family_uuid)",
            "CREATE INDEX IF NOT EXISTS idx_models_number ON models(model_number)",

            "CREATE TABLE IF NOT EXISTS boards (
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
            )",
            "CREATE INDEX IF NOT EXISTS idx_boards_model ON boards(model_uuid)",
            "CREATE INDEX IF NOT EXISTS idx_boards_number ON boards(board_number)",

            "CREATE TABLE IF NOT EXISTS board_aliases (
                uuid TEXT PRIMARY KEY,
                board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                alias_type TEXT,
                UNIQUE (alias, alias_type)
            )",
            "CREATE INDEX IF NOT EXISTS idx_board_aliases_alias ON board_aliases(alias)",

            "CREATE TABLE IF NOT EXISTS model_aliases (
                uuid TEXT PRIMARY KEY,
                model_uuid TEXT NOT NULL REFERENCES models(uuid) ON DELETE CASCADE,
                alias TEXT NOT NULL,
                alias_type TEXT,
                UNIQUE (alias, alias_type)
            )",
            "CREATE INDEX IF NOT EXISTS idx_model_aliases_alias ON model_aliases(alias)",

            "CREATE TABLE IF NOT EXISTS entity_color (
                scope_type TEXT NOT NULL CHECK(scope_type IN ('brand','family','model','board')),
                scope_uuid TEXT NOT NULL,
                color_id INTEGER NOT NULL REFERENCES colors(id),
                PRIMARY KEY (scope_type, scope_uuid)
            )",
            "CREATE INDEX IF NOT EXISTS idx_entity_color_uuid ON entity_color(scope_uuid)",

            "CREATE TABLE IF NOT EXISTS board_openboarddata (
                board_uuid TEXT NOT NULL REFERENCES boards(uuid) ON DELETE CASCADE,
                external_id TEXT NOT NULL,
                notes TEXT,
                PRIMARY KEY (board_uuid, external_id)
            )",
            "CREATE INDEX IF NOT EXISTS idx_obd_board ON board_openboarddata(board_uuid)",

            "CREATE TABLE IF NOT EXISTS contributors (
                uuid           TEXT PRIMARY KEY,
                kind           TEXT NOT NULL CHECK (kind IN ('install', 'user')),
                handle         TEXT,
                email          TEXT,
                github_login   TEXT,
                created_at     TEXT NOT NULL,
                last_seen      TEXT NOT NULL,
                blocked        INTEGER NOT NULL DEFAULT 0,
                blocked_reason TEXT
            )",
            "CREATE INDEX IF NOT EXISTS idx_contributors_kind ON contributors(kind)",
            "CREATE INDEX IF NOT EXISTS idx_contributors_github ON contributors(github_login) WHERE github_login IS NOT NULL",

            "CREATE TABLE IF NOT EXISTS install_tokens (
                contributor_uuid TEXT NOT NULL REFERENCES contributors(uuid),
                token_hash       TEXT NOT NULL UNIQUE,
                token_lookup     TEXT,
                created_at       TEXT NOT NULL,
                last_used_at     TEXT,
                version_hint     TEXT,
                revoked          INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (contributor_uuid, token_hash)
            )",
            "CREATE INDEX IF NOT EXISTS idx_install_tokens_lookup ON install_tokens(token_lookup)",

            "CREATE TABLE IF NOT EXISTS user_tokens (
                contributor_uuid TEXT NOT NULL REFERENCES contributors(uuid),
                token_hash       TEXT NOT NULL UNIQUE,
                token_lookup     TEXT,
                name             TEXT NOT NULL,
                created_at       TEXT NOT NULL,
                last_used_at     TEXT,
                scopes           TEXT NOT NULL DEFAULT '[\"contributions:submit\"]',
                revoked          INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (contributor_uuid, token_hash)
            )",
            "CREATE INDEX IF NOT EXISTS idx_user_tokens_lookup ON user_tokens(token_lookup)",

            "CREATE TABLE IF NOT EXISTS contributions (
                uuid                 TEXT PRIMARY KEY,
                target_type          TEXT NOT NULL CHECK (target_type IN ('brand','family','model','board','board_alias','model_alias','entity_color')),
                target_uuid          TEXT NOT NULL,
                target_field         TEXT NOT NULL,
                value_to             TEXT,
                value_from           TEXT,
                evidence_source_url  TEXT,
                evidence_in_hand     INTEGER NOT NULL DEFAULT 0,
                evidence_in_hand_ctx TEXT,
                evidence_rationale   TEXT,
                confidence           TEXT CHECK (confidence IN ('low','medium','high') OR confidence IS NULL),
                status               TEXT NOT NULL CHECK (status IN ('submitted','accepted','rejected','withdrawn','superseded')),
                reviewer_uuid        TEXT REFERENCES contributors(uuid),
                reviewed_at          TEXT,
                reject_reason        TEXT,
                contributor_uuid     TEXT NOT NULL REFERENCES contributors(uuid),
                install_uuid         TEXT REFERENCES contributors(uuid),
                submitted_at         TEXT NOT NULL,
                client_ts            TEXT NOT NULL,
                CHECK (
                    evidence_source_url IS NOT NULL
                    OR evidence_in_hand = 1
                    OR (evidence_rationale IS NOT NULL AND length(evidence_rationale) >= 4)
                )
            )",
            "CREATE INDEX IF NOT EXISTS idx_contributions_queue       ON contributions(status, submitted_at)",
            "CREATE INDEX IF NOT EXISTS idx_contributions_target      ON contributions(target_type, target_uuid)",
            "CREATE INDEX IF NOT EXISTS idx_contributions_contributor ON contributions(contributor_uuid, status)",
            "CREATE INDEX IF NOT EXISTS idx_contributions_install     ON contributions(install_uuid, submitted_at)",

            "CREATE TABLE IF NOT EXISTS contribution_audit (
                id                INTEGER PRIMARY KEY AUTOINCREMENT,
                contribution_uuid TEXT NOT NULL REFERENCES contributions(uuid),
                from_status       TEXT NOT NULL,
                to_status         TEXT NOT NULL,
                actor_uuid        TEXT REFERENCES contributors(uuid),
                at                TEXT NOT NULL,
                note              TEXT
            )",
            "CREATE INDEX IF NOT EXISTS idx_audit_contribution ON contribution_audit(contribution_uuid)",

            "CREATE TABLE IF NOT EXISTS snapshot_state (
                id                 INTEGER PRIMARY KEY CHECK (id = 1),
                counter            INTEGER NOT NULL DEFAULT 0,
                dirty              INTEGER NOT NULL DEFAULT 0,
                last_generated_at  TEXT
            )",
            "INSERT OR IGNORE INTO snapshot_state (id, counter, dirty) VALUES (1, 0, 0)",

            "CREATE TABLE IF NOT EXISTS seed_state (
                id        INTEGER PRIMARY KEY CHECK (id = 1),
                seeded    INTEGER NOT NULL DEFAULT 0,
                seeded_at TEXT
            )",
            "INSERT OR IGNORE INTO seed_state (id, seeded) VALUES (1, 0)",

            // Best-effort rate-limit buckets (SQLite-backed since shared host
            // has no shared memory). install_uuid OR a hashed IP for register.
            "CREATE TABLE IF NOT EXISTS rate_limit_buckets (
                key          TEXT NOT NULL,
                window_start INTEGER NOT NULL,
                count        INTEGER NOT NULL,
                PRIMARY KEY (key, window_start)
            )",
            "CREATE INDEX IF NOT EXISTS idx_rate_limit_window ON rate_limit_buckets(window_start)",
        ];
    }

    /**
     * First-boot seeding from an existing v2 boards.db (entity rows only).
     * Idempotent — checks seed_state and skips on subsequent boots.
     */
    public static function seedIfNeeded(): void
    {
        $pdo = Db::pdo();
        $row = $pdo->query("SELECT seeded FROM seed_state WHERE id=1")->fetch();
        if ($row && (int) $row['seeded'] === 1) {
            return;
        }
        $seedPath = Config::seedDbPath();
        if ($seedPath === null) {
            Log::info('seed', 'no seed DB configured, skipping');
            $pdo->exec("UPDATE seed_state SET seeded=1, seeded_at='" . Time::nowUtc() . "' WHERE id=1");
            return;
        }

        Log::info('seed', 'seeding from ' . $seedPath);
        $abs = realpath($seedPath) ?: $seedPath;
        $pdo->exec("ATTACH DATABASE " . $pdo->quote($abs) . " AS seed");
        try {
            // INSERT OR IGNORE preserves existing rows (idempotent on partial seeds).
            $tables = [
                ['brands',              'uuid, name, notes'],
                ['families',            'uuid, brand_uuid, name, notes'],
                ['models',              'uuid, family_uuid, model_number, display_name, notes'],
                ['boards',              'uuid, model_uuid, board_number, board_name, odm, board_number_type, source, source_url, notes'],
                ['board_aliases',       'uuid, board_uuid, alias, alias_type'],
                ['model_aliases',       'uuid, model_uuid, alias, alias_type'],
                ['entity_color',        'scope_type, scope_uuid, color_id'],
                ['colors',              'id, name, hex, sort_order'],
                ['board_openboarddata', 'board_uuid, external_id, notes'],
            ];
            foreach ($tables as [$t, $cols]) {
                // Check the seed actually has that table before attempting INSERT,
                // otherwise SQLite raises "no such table" on a partial seed source.
                $exists = $pdo->query("SELECT 1 FROM seed.sqlite_master WHERE type='table' AND name=" . $pdo->quote($t))->fetch();
                if (!$exists) continue;
                $sql = "INSERT OR IGNORE INTO main.$t ($cols) SELECT $cols FROM seed.$t";
                $pdo->exec($sql);
            }
            $pdo->exec("UPDATE seed_state SET seeded=1, seeded_at='" . Time::nowUtc() . "' WHERE id=1");
            // Mark snapshot dirty so the first cron run regenerates with seed data.
            $pdo->exec("UPDATE snapshot_state SET dirty=1 WHERE id=1");
            Log::info('seed', 'seed complete');
        } finally {
            $pdo->exec('DETACH DATABASE seed');
        }
    }
}
