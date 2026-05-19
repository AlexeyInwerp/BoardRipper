<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Best-effort rate limiter, SQLite-backed.
 *
 * The Go reference uses in-memory token buckets. PHP shared hosting has no
 * shared memory between requests, so we count fixed-window hits in a small
 * table. Not as smooth as a token bucket but bounded above, which is what
 * the spec actually cares about.
 *
 * Windows are aligned to wall clock (start of hour / start of day). On limit
 * hit we 429 with Retry-After.
 */
final class RateLimit
{
    /** Hourly bucket. */
    public static function checkHour(string $key, int $maxPerHour, string $errCode = 'rate_limited'): void
    {
        self::check($key, 3600, $maxPerHour, $errCode);
    }

    /** Daily bucket. */
    public static function checkDay(string $key, int $maxPerDay, string $errCode = 'rate_limited'): void
    {
        self::check($key, 86400, $maxPerDay, $errCode);
    }

    private static function check(string $key, int $windowSec, int $max, string $errCode): void
    {
        $pdo  = Db::pdo();
        $now  = time();
        $win  = (int) ($now / $windowSec) * $windowSec;

        // Periodically prune old buckets (1 in 100 requests).
        if (random_int(1, 100) === 1) {
            $pdo->prepare("DELETE FROM rate_limit_buckets WHERE window_start < ?")
                ->execute([$now - 86400 * 2]);
        }

        $bk = "$key|$windowSec";
        $pdo->prepare("INSERT INTO rate_limit_buckets (key, window_start, count) VALUES (?, ?, 1)
                       ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1")
            ->execute([$bk, $win]);

        $row = $pdo->prepare("SELECT count FROM rate_limit_buckets WHERE key=? AND window_start=?");
        $row->execute([$bk, $win]);
        $r = $row->fetch();
        if ($r !== false && (int) $r['count'] > $max) {
            $retryAfter = ($win + $windowSec) - $now;
            if (!headers_sent()) {
                header('Retry-After: ' . max(1, $retryAfter));
            }
            Json::err(429, $errCode, 'too many registrations');
            exit;
        }
    }
}
