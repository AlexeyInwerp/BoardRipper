<?php
declare(strict_types=1);

/**
 * Common bootstrap — autoloader, schema ensure, seed.
 * Included by api.php (HTTP), admin.php (CLI), cron-snapshot.php (cron).
 */

// Hard-suppress PHP error output for HTTP requests. A PHP warning
// inlined into a JSON response (e.g. `<br /><b>Warning</b>: ...`) makes
// the response unparseable for clients. Errors still flow to the log
// via error_log() once Log::init() runs.
if (PHP_SAPI !== 'cli') {
    @ini_set('display_errors', '0');
    @ini_set('html_errors',    '0');
    @ini_set('display_startup_errors', '0');
}
error_reporting(E_ALL);

// PSR-4-ish autoloader for the DeviceDB\ namespace.
spl_autoload_register(static function (string $class): void {
    if (strpos($class, 'DeviceDB\\') !== 0) return;
    $rel = substr($class, strlen('DeviceDB\\'));
    $path = __DIR__ . '/lib/' . str_replace('\\', '/', $rel) . '.php';
    if (is_file($path)) {
        require_once $path;
    }
});

// Required PHP extensions — fail loud at boot rather than mid-request.
foreach (['pdo_sqlite', 'sodium', 'phar', 'fileinfo'] as $ext) {
    if (!extension_loaded($ext)) {
        if (PHP_SAPI === 'cli') {
            fwrite(STDERR, "[devicedb] missing required PHP extension: $ext\n");
        } else {
            header('Content-Type: application/json');
            http_response_code(500);
            echo json_encode(['error' => 'misconfigured', 'message' => "missing PHP extension: $ext"]);
        }
        exit(1);
    }
}

DeviceDB\Log::init();
DeviceDB\Schema::ensure();
DeviceDB\Schema::seedIfNeeded();
