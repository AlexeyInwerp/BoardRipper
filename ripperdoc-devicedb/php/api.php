<?php
declare(strict_types=1);

/**
 * Single HTTP entrypoint. Routes by PATH_INFO via .htaccess rewrites OR by
 * the built-in PHP server (where api.php is invoked as the router script
 * via `php -S host:port api.php`).
 *
 * Recognised path prefixes:
 *   /v1/...                 (canonical)
 *   /devicedb/api/v1/...    (alias)
 *   /devicedb/v1/...        (alias)
 */

require __DIR__ . '/bootstrap.php';

use DeviceDB\Auth;
use DeviceDB\Contribs;
use DeviceDB\Entities;
use DeviceDB\Installs;
use DeviceDB\Json;
use DeviceDB\Log;
use DeviceDB\Snapshot;
use DeviceDB\Users;

// php -S router mode: when REQUEST_URI maps to an existing static file,
// return false to let the built-in server serve it.
if (PHP_SAPI === 'cli-server') {
    $reqPath = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    $abs = __DIR__ . $reqPath;
    if ($reqPath !== '/' && $reqPath !== '/api.php' && is_file($abs)) {
        return false;
    }
    // Block direct /data/ even in dev.
    if (strpos($reqPath, '/data/') === 0) {
        http_response_code(403);
        echo "Forbidden";
        exit;
    }
}

$method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

if ($method === 'OPTIONS') {
    http_response_code(204);
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-BoardRipper-Install-Token');
    exit;
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
// Strip the optional /devicedb/api/v1 or /devicedb/v1 or /v1 prefix.
$prefixes = ['/devicedb/api/v1', '/devicedb/v1', '/v1'];
$rest = null;
foreach ($prefixes as $p) {
    if ($path === $p) { $rest = ''; break; }
    if (strpos($path, $p . '/') === 0) {
        $rest = substr($path, strlen($p) + 1);
        break;
    }
}
if ($rest === null) {
    // Not an API path — let static handlers / index.html take over.
    http_response_code(404);
    header('Content-Type: text/plain; charset=utf-8');
    echo "404 page not found\n";
    exit;
}
$rest = trim($rest, '/');
$parts = $rest === '' ? [] : explode('/', $rest);
$start = microtime(true);

try {
    $matched = false;
    switch (true) {
        case $parts === [] || $parts === ['']:
            Json::ok(200, ['service' => 'ripperdoc-devicedb', 'api' => 'v1']);
            $matched = true;
            break;

        case $parts === ['health'] && $method === 'GET':
            Json::ok(200, ['ok' => true]);
            $matched = true;
            break;

        case $parts === ['openapi.json'] && $method === 'GET':
            require __DIR__ . '/lib/Allowlist.php';
            Json::ok(200, openapiDoc());
            $matched = true;
            break;

        case $parts === ['entities'] && $method === 'GET':
            Entities::tree();
            $matched = true;
            break;

        case count($parts) === 3 && $parts[0] === 'entities' && $method === 'GET':
            Entities::single($parts[1], $parts[2]);
            $matched = true;
            break;

        case count($parts) === 4 && $parts[0] === 'entities' && $parts[3] === 'contributions' && $method === 'GET':
            Entities::history($parts[1], $parts[2]);
            $matched = true;
            break;

        case $parts === ['resolve'] && $method === 'GET':
            Entities::resolve();
            $matched = true;
            break;

        case $parts === ['installs', 'register'] && $method === 'POST':
            Installs::register();
            $matched = true;
            break;

        case $parts === ['users', 'register'] && $method === 'POST':
            Users::register();
            $matched = true;
            break;

        case $parts === ['snapshots', 'latest'] && $method === 'GET':
            Snapshot::latest();
            $matched = true;
            break;

        case count($parts) === 3 && $parts[0] === 'snapshots' && $parts[2] === 'tarball' && $method === 'GET':
            Snapshot::tarball((int) $parts[1]);
            $matched = true;
            break;

        case $parts === ['contributions'] && $method === 'POST':
            Contribs::submit(Auth::requireAuth());
            $matched = true;
            break;

        case $parts === ['contributions'] && $method === 'GET':
            // Spec §5.3: GET /v1/contributions returns caller's own submissions.
            Contribs::mine(Auth::requireAuth());
            $matched = true;
            break;

        case $parts === ['contributions', 'mine'] && $method === 'GET':
            Contribs::mine(Auth::requireAuth());
            $matched = true;
            break;

        case count($parts) === 2 && $parts[0] === 'contributions' && $method === 'GET':
            Contribs::getOne(Auth::requireAuth(), $parts[1]);
            $matched = true;
            break;

        case count($parts) === 2 && $parts[0] === 'contributions' && $method === 'DELETE':
            Contribs::withdraw(Auth::requireAuth(), $parts[1]);
            $matched = true;
            break;

        case $parts === ['admin', 'contributions', 'queue'] && $method === 'GET':
            Contribs::adminQueue(Auth::requireAuth());
            $matched = true;
            break;

        case count($parts) === 4 && $parts[0] === 'admin' && $parts[1] === 'contributions' && $parts[3] === 'accept' && $method === 'POST':
            Contribs::adminAccept(Auth::requireAuth(), $parts[2]);
            $matched = true;
            break;

        case count($parts) === 4 && $parts[0] === 'admin' && $parts[1] === 'contributions' && $parts[3] === 'reject' && $method === 'POST':
            Contribs::adminReject(Auth::requireAuth(), $parts[2]);
            $matched = true;
            break;

        case count($parts) === 4 && $parts[0] === 'admin' && $parts[1] === 'contributors' && $parts[3] === 'block' && $method === 'POST':
            Contribs::adminBlock(Auth::requireAuth(), $parts[2]);
            $matched = true;
            break;

        case $parts === ['admin', 'snapshot', 'regenerate'] && $method === 'POST':
            $ctx = Auth::requireAuth();
            Auth::requireScope($ctx, Auth::SCOPE_MODERATE);
            $r = Snapshot::regenerate();
            Json::ok(200, ['counter' => $r['counter']]);
            $matched = true;
            break;
    }
    if (!$matched) {
        Json::err(405, 'method_not_allowed', 'method not allowed: ' . $method . ' ' . $path);
    }
} catch (\Throwable $e) {
    Log::err('api', 'unhandled', ['error' => $e->getMessage(), 'where' => $e->getFile() . ':' . $e->getLine()]);
    Json::err(500, 'internal', $e->getMessage());
}

$ms = (int) ((microtime(true) - $start) * 1000);
Log::info('api', sprintf('%s %s %dms', $method, $path, $ms));

/**
 * Live-truth OpenAPI doc — mirrors the Go reference's hand-rolled emission.
 * Kept inline so the file allowlist source of truth stays in Allowlist.php.
 */
function openapiDoc(): array
{
    $fields = DeviceDB\Allowlist::all();
    return [
        'openapi' => '3.1.0',
        'info' => [
            'title'   => 'ripperdoc-devicedb',
            'version' => '1.0.0',
            'summary' => 'Canonical online boards database — read + contribute.',
        ],
        'servers' => [
            ['url' => '/v1',              'description' => 'canonical path'],
            ['url' => '/devicedb/api/v1', 'description' => 'alias for the static frontend'],
        ],
        'paths' => [
            '/health'                                 => ['get'    => ['summary' => 'Liveness probe']],
            '/entities'                               => ['get'    => ['summary' => 'Full Brand→Family→Model→Board tree']],
            '/entities/{type}/{uuid}'                 => ['get'    => ['summary' => 'Single entity by type and UUID']],
            '/entities/{type}/{uuid}/contributions'   => ['get'    => ['summary' => 'Public edit history (default status=accepted)']],
            '/resolve'                                => ['get'    => ['summary' => "Best-effort board-number resolver"]],
            '/installs/register'                      => ['post'   => ['summary' => 'Register a new install token']],
            '/users/register'                         => ['post'   => ['summary' => 'Prototype: register a user, mint a token']],
            '/contributions'                          => [
                'post' => ['summary' => 'Submit a patch'],
                'get'  => ['summary' => "List caller's submissions"],
            ],
            '/contributions/mine'                     => ['get'    => ['summary' => "Caller's submissions"]],
            '/contributions/{uuid}'                   => [
                'get'    => ['summary' => 'Single submission'],
                'delete' => ['summary' => 'Withdraw own pending submission'],
            ],
            '/snapshots/latest'                       => ['get'    => ['summary' => 'Signed snapshot manifest']],
            '/snapshots/{counter}/tarball'            => ['get'    => ['summary' => 'Signed snapshot tarball']],
            '/admin/contributions/queue'              => ['get'    => ['summary' => 'Moderator queue (scope: contributions:moderate)']],
            '/admin/contributions/{uuid}/accept'      => ['post'   => ['summary' => 'Apply patch (scope: contributions:moderate)']],
            '/admin/contributions/{uuid}/reject'      => ['post'   => ['summary' => 'Reject with reason']],
            '/admin/contributors/{uuid}/block'        => ['post'   => ['summary' => 'Block a contributor']],
            '/admin/snapshot/regenerate'              => ['post'   => ['summary' => 'Force snapshot regeneration']],
        ],
        'components' => [
            'schemas' => [
                'FieldAllowlist' => [
                    'description' => "Per-target writable field list, hard-coded in the server (spec \u{00a7}9 #8)",
                    'type'        => 'object',
                    'properties'  => array_combine(
                        array_keys($fields),
                        array_map(static fn($v) => ['type' => 'array', 'items' => ['type' => 'string'], 'example' => $v], $fields)
                    ),
                ],
            ],
            'securitySchemes' => [
                'InstallToken' => [
                    'description' => 'Per-install secret minted on first launch.',
                    'in'          => 'header',
                    'name'        => 'X-BoardRipper-Install-Token',
                    'type'        => 'apiKey',
                ],
                'UserToken' => ['type' => 'http', 'scheme' => 'bearer'],
            ],
        ],
    ];
}
