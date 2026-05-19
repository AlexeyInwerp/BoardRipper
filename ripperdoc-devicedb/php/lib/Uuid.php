<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * RFC 4122 v4 UUID generation. random_bytes is cryptographically-secure on
 * any host with /dev/urandom (Linevast has).
 */
final class Uuid
{
    public static function v4(): string
    {
        $d = random_bytes(16);
        $d[6] = chr((ord($d[6]) & 0x0f) | 0x40);
        $d[8] = chr((ord($d[8]) & 0x3f) | 0x80);
        return vsprintf('%s%s-%s-%s-%s-%s%s%s', str_split(bin2hex($d), 4));
    }

    public static function isValid(string $s): bool
    {
        return (bool) preg_match('/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/', $s);
    }
}
