<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * PDO/SQLite singleton with WAL mode and busy-timeout, parallel to the Go
 * reference's `file:...?_pragma=busy_timeout(5000)&_pragma=foreign_keys(on)&_pragma=journal_mode(wal)`.
 */
final class Db
{
    private static ?\PDO $pdo = null;

    public static function pdo(): \PDO
    {
        if (self::$pdo !== null) return self::$pdo;
        $dsn = 'sqlite:' . Config::dbPath();
        $pdo = new \PDO($dsn, null, null, [
            \PDO::ATTR_ERRMODE            => \PDO::ERRMODE_EXCEPTION,
            \PDO::ATTR_DEFAULT_FETCH_MODE => \PDO::FETCH_ASSOC,
            \PDO::ATTR_EMULATE_PREPARES   => false,
        ]);
        $pdo->exec('PRAGMA journal_mode=WAL');
        $pdo->exec('PRAGMA busy_timeout=5000');
        $pdo->exec('PRAGMA foreign_keys=ON');
        $pdo->exec('PRAGMA synchronous=NORMAL');
        self::$pdo = $pdo;
        return $pdo;
    }

    /** Run $fn inside an IMMEDIATE transaction; rolls back on throw. */
    public static function tx(callable $fn)
    {
        $pdo = self::pdo();
        $pdo->exec('BEGIN IMMEDIATE');
        try {
            $r = $fn($pdo);
            $pdo->exec('COMMIT');
            return $r;
        } catch (\Throwable $e) {
            $pdo->exec('ROLLBACK');
            throw $e;
        }
    }

    public static function reset(): void
    {
        self::$pdo = null;
    }
}
