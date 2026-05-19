<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Scoped logging — mirrors the Go reference's "[devicedb] [<scope>] ..." line
 * format. Writes to data/logs/devicedb.log; also echoes to PHP error log when
 * the CLI runs admin.php or cron-snapshot.php.
 */
final class Log
{
    private static ?string $path = null;

    public static function init(): void
    {
        if (self::$path !== null) return;
        self::$path = Config::logsDir() . '/devicedb.log';
    }

    public static function info(string $scope, string $msg, array $kv = []): void
    {
        self::write('INFO', $scope, $msg, $kv);
    }

    public static function warn(string $scope, string $msg, array $kv = []): void
    {
        self::write('WARN', $scope, $msg, $kv);
    }

    public static function err(string $scope, string $msg, array $kv = []): void
    {
        self::write('ERROR', $scope, $msg, $kv);
    }

    private static function write(string $level, string $scope, string $msg, array $kv): void
    {
        self::init();
        $ts = gmdate('Y/m/d H:i:s.') . substr((string) (int) (microtime(true) * 1e6), -6);
        $line = "$ts [devicedb] [$scope] $msg";
        if (!empty($kv)) {
            $extras = [];
            foreach ($kv as $k => $v) {
                $extras[] = $k . '=' . (is_scalar($v) ? (string) $v : json_encode($v));
            }
            $line .= ' ' . implode(' ', $extras);
        }
        $line .= "\n";
        @file_put_contents(self::$path, $line, FILE_APPEND | LOCK_EX);
        if (PHP_SAPI === 'cli') {
            fwrite(STDERR, $line);
        }
    }
}
