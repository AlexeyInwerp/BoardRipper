#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Cron entrypoint — regenerates the signed snapshot when `snapshot_state.dirty`
 * is set. Idempotent across overlapping runs via a flock() advisory mutex.
 *
 * Suggested crontab on Linevast:
 *   * /10 * * * *  php /home/USER/public_html/devicedb/cron-snapshot.php >/dev/null 2>&1
 *
 * Pass --force to regenerate even if dirty=0.
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "cron-snapshot.php must be run from CLI\n");
    exit(1);
}

require __DIR__ . '/bootstrap.php';

use DeviceDB\Config;
use DeviceDB\Db;
use DeviceDB\Log;
use DeviceDB\Snapshot;

$force = in_array('--force', array_slice($argv, 1), true);

$lockFile = Config::dataDir() . '/.cron-snapshot.lock';
$fh = fopen($lockFile, 'c');
if (!$fh) {
    fwrite(STDERR, "cannot open lock file: $lockFile\n");
    exit(1);
}
if (!flock($fh, LOCK_EX | LOCK_NB)) {
    // Another cron tick is already running — exit quietly.
    Log::info('cron', 'lock held; skipping');
    exit(0);
}

try {
    $pdo = Db::pdo();
    $row = $pdo->query("SELECT counter, dirty FROM snapshot_state WHERE id=1")->fetch();
    $dirty = (int) ($row['dirty'] ?? 0);
    $counter = (int) ($row['counter'] ?? 0);

    if (!$force && $dirty === 0 && $counter > 0) {
        Log::info('cron', 'snapshot is clean (counter=' . $counter . '); nothing to do');
        exit(0);
    }
    $r = Snapshot::regenerate();
    Log::info('cron', "regenerated snapshot counter={$r['counter']}");
} catch (\Throwable $e) {
    Log::err('cron', 'snapshot regen failed: ' . $e->getMessage());
    exit(1);
} finally {
    flock($fh, LOCK_UN);
    fclose($fh);
}
