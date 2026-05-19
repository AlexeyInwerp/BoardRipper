<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Centralised runtime config.
 *
 * Lookup order: getenv() → constant() → caller-supplied default. Everything
 * is resolved lazily on first ::get() so that test harnesses can putenv()
 * before bootstrap.
 */
final class Config
{
    /** @var array<string,string|null> */
    private static array $cache = [];

    public static function dataDir(): string
    {
        $d = self::get('DATA_DIR', __DIR__ . '/../data');
        if (!is_dir($d)) {
            @mkdir($d, 0755, true);
        }
        return rtrim($d, '/');
    }

    public static function dbPath(): string
    {
        return self::dataDir() . '/canonical.sqlite';
    }

    public static function snapshotsDir(): string
    {
        $d = self::dataDir() . '/snapshots';
        if (!is_dir($d)) {
            @mkdir($d, 0755, true);
        }
        return $d;
    }

    public static function logsDir(): string
    {
        $d = self::dataDir() . '/logs';
        if (!is_dir($d)) {
            @mkdir($d, 0755, true);
        }
        return $d;
    }

    public static function seedDbPath(): ?string
    {
        // Env wins; fallback to the .seed-from pointer file.
        $env = self::get('SEED_DB_PATH', '');
        if ($env !== '' && is_file($env)) {
            return $env;
        }
        $pointer = self::dataDir() . '/.seed-from';
        if (is_file($pointer)) {
            $p = trim((string) file_get_contents($pointer));
            if ($p !== '' && is_file($p)) {
                return $p;
            }
        }
        return null;
    }

    public static function snapshotPrivateKeyPath(): ?string
    {
        $env = self::get('SNAPSHOT_PRIVATE_KEY_PATH', '');
        if ($env !== '' && is_file($env)) {
            return $env;
        }
        $default = self::dataDir() . '/snapshot.key';
        return is_file($default) ? $default : null;
    }

    public static function snapshotTarballBaseUrl(): string
    {
        return self::get('SNAPSHOT_TARBALL_BASE_URL', '');
    }

    public static function minSupportedVersion(): string
    {
        return self::get('MIN_SUPPORTED_VERSION', '0.31.0');
    }

    public static function snapshotsEnabled(): bool
    {
        $v = self::get('ENABLE_SNAPSHOT', '1');
        return $v !== '0' && $v !== 'false' && $v !== '';
    }

    public static function get(string $key, string $default = ''): string
    {
        if (array_key_exists($key, self::$cache)) {
            return self::$cache[$key] ?? $default;
        }
        $v = getenv($key);
        if ($v === false || $v === '') {
            // Allow constants set in bootstrap.php for shared-host configs.
            if (defined($key)) {
                $v = (string) constant($key);
            } else {
                $v = $default;
            }
        }
        self::$cache[$key] = $v;
        return $v === '' ? $default : $v;
    }
}
