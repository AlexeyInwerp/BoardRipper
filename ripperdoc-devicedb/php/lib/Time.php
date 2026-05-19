<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * ISO-8601 UTC with Z suffix — same wire format as the Go reference.
 */
final class Time
{
    public static function nowUtc(): string
    {
        return gmdate('Y-m-d\TH:i:s\Z');
    }

    /** Parse an ISO-8601 timestamp; null on failure. */
    public static function parse(string $s): ?\DateTimeImmutable
    {
        if ($s === '') return null;
        try {
            return new \DateTimeImmutable($s);
        } catch (\Throwable $e) {
            return null;
        }
    }

    /**
     * Clock-skew clamp matching spec §9 #7: client_ts must be within
     * [server_now - 7d, server_now + 1h].
     */
    public static function clientTsInBounds(string $clientTs): bool
    {
        $t = self::parse($clientTs);
        if ($t === null) return false;
        $now = time();
        $ts  = $t->getTimestamp();
        return $ts >= ($now - 7 * 24 * 3600) && $ts <= ($now + 3600);
    }
}
