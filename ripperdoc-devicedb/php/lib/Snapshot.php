<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Ed25519-signed snapshot generation.
 *
 * Tarball contents (spec §6.4 / Go reference): entity tables ONLY —
 *   brands, families, models, boards, board_aliases, model_aliases,
 *   entity_color, colors, board_openboarddata, plus schema_version.
 * NEVER ships contributions / contributors / *_tokens / contribution_audit.
 *
 * The filtered SQLite is produced via VACUUM INTO into a staging file, then
 * each non-entity table is dropped. The result is `tar`-ed with metadata.json
 * and gzip-compressed via the Phar extension. The manifest is signed using
 * sodium_crypto_sign_detached.
 */
final class Snapshot
{
    private const ALLOWED_TABLES = [
        'schema_version',
        'colors',
        'brands',
        'families',
        'models',
        'boards',
        'board_aliases',
        'model_aliases',
        'entity_color',
        'board_openboarddata',
        // Phase 2+: photos are entity-side data and ship in the snapshot.
        'board_photos',
        'model_photos',
    ];

    /** @return array{counter:int,tarball:string,manifest:string,sha256:string,size_bytes:int} */
    public static function regenerate(): array
    {
        $pdo = Db::pdo();
        // Bump counter (single-row table — spec §6.4 says monotonic).
        Db::tx(function (\PDO $pdo) {
            $pdo->exec("UPDATE snapshot_state SET counter = counter + 1, dirty = 0, last_generated_at = '" . Time::nowUtc() . "' WHERE id=1");
        });
        $row = $pdo->query("SELECT counter FROM snapshot_state WHERE id=1")->fetch();
        $counter = (int) ($row['counter'] ?? 1);

        $stagingDb = Config::dataDir() . '/staging-' . $counter . '.db';
        @unlink($stagingDb);
        $pdo->exec("VACUUM INTO " . $pdo->quote($stagingDb));

        // Open staging and drop non-entity tables.
        $stage = new \PDO('sqlite:' . $stagingDb, null, null, [
            \PDO::ATTR_ERRMODE => \PDO::ERRMODE_EXCEPTION,
        ]);
        $tables = $stage->query("SELECT name FROM sqlite_master WHERE type='table'")->fetchAll(\PDO::FETCH_COLUMN);
        foreach ($tables as $t) {
            // sqlite_sequence / sqlite_stat* are managed by SQLite; just clear them.
            if (strpos($t, 'sqlite_') === 0) {
                @$stage->exec("DELETE FROM \"$t\"");
                continue;
            }
            if (!in_array($t, self::ALLOWED_TABLES, true)) {
                $stage->exec("DROP TABLE IF EXISTS \"$t\"");
            }
        }
        // Drop indexes/triggers/views that reference dropped tables.
        $stage->exec("VACUUM");
        unset($stage);

        // Build tarball via Phar.
        $tarPath = Config::snapshotsDir() . "/boards-$counter.tar";
        $gzPath  = Config::snapshotsDir() . "/boards-$counter.tar.gz";
        @unlink($tarPath);
        @unlink($gzPath);

        $metadata = [
            'counter'        => $counter,
            'generated_at'   => Time::nowUtc(),
            'schema_version' => Schema::VERSION,
        ];

        try {
            $phar = new \PharData($tarPath);
            $phar->addFile($stagingDb, 'boards.db');
            $phar->addFromString('metadata.json', json_encode($metadata, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE));
            // Compress to .tar.gz.
            $phar->compress(\Phar::GZ);
            unset($phar);
        } catch (\Throwable $e) {
            @unlink($tarPath);
            @unlink($stagingDb);
            throw $e;
        }
        // PharData::compress writes a sibling .tar.gz; original .tar can be removed.
        @unlink($tarPath);
        @unlink($stagingDb);

        $tarball = file_get_contents($gzPath);
        if ($tarball === false) {
            throw new \RuntimeException('failed to read generated tarball');
        }
        $sha256 = hash('sha256', $tarball);
        $size   = strlen($tarball);

        $releasedAt = Time::nowUtc();
        $notAfter   = gmdate('Y-m-d\TH:i:s\Z', time() + 90 * 86400);
        $baseUrl    = Config::snapshotTarballBaseUrl();
        if ($baseUrl === '') {
            // Default — same-origin URL for the .tar.gz under /v1/snapshots/{counter}/tarball.
            $baseUrl = self::publicBase() . '/v1/snapshots';
        }
        $tarballUrl = rtrim($baseUrl, '/') . "/boards-$counter.tar.gz";

        $manifest = [
            'version'               => 1,
            'counter'               => $counter,
            'released_at'           => $releasedAt,
            'not_after'             => $notAfter,
            'min_supported_version' => Config::minSupportedVersion(),
            'tarball_url'           => $tarballUrl,
            'tarball_sha256'        => $sha256,
            'size_bytes'            => $size,
        ];
        $manifestJson = json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

        // Ed25519 sign.
        [$sk, $pkHint] = self::signingKey();
        $sig = sodium_crypto_sign_detached($manifestJson, $sk);
        $manifest['signature'] = base64_encode($sig);

        $signedJson = json_encode($manifest, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        $manifestPath = Config::snapshotsDir() . '/latest-manifest.json';
        $tmp = $manifestPath . '.tmp';
        file_put_contents($tmp, $signedJson);
        rename($tmp, $manifestPath);

        // Convenience pointer for "latest.tar.gz" → counter-specific file.
        $latestGz = Config::snapshotsDir() . '/latest.tar.gz';
        @unlink($latestGz);
        @copy($gzPath, $latestGz);

        Log::info('snapshot', "regenerated counter=$counter", ['sha256' => $sha256, 'size' => $size, 'pubkey' => $pkHint]);

        return [
            'counter'    => $counter,
            'tarball'    => $gzPath,
            'manifest'   => $manifestPath,
            'sha256'     => $sha256,
            'size_bytes' => $size,
        ];
    }

    /**
     * Return [signing-secret-key, base64-pubkey-hint].
     * Production: SNAPSHOT_PRIVATE_KEY_PATH holds the raw 64-byte secret key
     *             (sodium_crypto_sign_keypair concat sk||pk format).
     * Dev: ephemeral keypair regenerated each request — emits a warning.
     */
    private static function signingKey(): array
    {
        $path = Config::snapshotPrivateKeyPath();
        if ($path !== null) {
            $raw = file_get_contents($path);
            if ($raw === false || strlen($raw) !== SODIUM_CRYPTO_SIGN_SECRETKEYBYTES) {
                throw new \RuntimeException('snapshot signing key is invalid (expected ' . SODIUM_CRYPTO_SIGN_SECRETKEYBYTES . ' bytes)');
            }
            $pk = sodium_crypto_sign_publickey_from_secretkey($raw);
            return [$raw, base64_encode($pk)];
        }
        // Dev key — persist once under data/snapshot.dev.key so the same
        // pubkey is used across requests in a dev session.
        $devKey = Config::dataDir() . '/snapshot.dev.key';
        if (!is_file($devKey)) {
            $kp = sodium_crypto_sign_keypair();
            $sk = sodium_crypto_sign_secretkey($kp);
            file_put_contents($devKey, $sk);
            @chmod($devKey, 0600);
        }
        $sk = file_get_contents($devKey);
        $pk = sodium_crypto_sign_publickey_from_secretkey($sk);
        Log::warn('snapshot', 'using ephemeral dev signing key (pubkey=' . base64_encode($pk) . '); set SNAPSHOT_PRIVATE_KEY_PATH for production');
        return [$sk, base64_encode($pk)];
    }

    /** GET /v1/snapshots/latest — returns the signed manifest. */
    public static function latest(): void
    {
        $manifestPath = Config::snapshotsDir() . '/latest-manifest.json';
        if (!is_file($manifestPath)) {
            // Regenerate on demand if dirty or never built.
            if (Config::snapshotsEnabled()) {
                self::regenerate();
            } else {
                Json::err(503, 'snapshots_disabled', 'snapshot generation disabled');
                return;
            }
        }
        // Re-read.
        $body = file_get_contents($manifestPath);
        if ($body === false) {
            Json::err(500, 'internal', 'snapshot manifest unreadable');
            return;
        }
        if (!headers_sent()) {
            header('Content-Type: application/json');
            header('Access-Control-Allow-Origin: *');
        }
        echo $body;
    }

    /** GET /v1/snapshots/{counter}/tarball. */
    public static function tarball(int $counter): void
    {
        $gz = Config::snapshotsDir() . "/boards-$counter.tar.gz";
        if (!is_file($gz)) {
            Json::err(404, 'not_found', 'snapshot not found');
            return;
        }
        if (!headers_sent()) {
            header('Content-Type: application/gzip');
            header('Access-Control-Allow-Origin: *');
            header('Content-Length: ' . filesize($gz));
        }
        readfile($gz);
    }

    private static function publicBase(): string
    {
        $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
        $host   = $_SERVER['HTTP_HOST'] ?? 'localhost';
        return "$scheme://$host";
    }
}
