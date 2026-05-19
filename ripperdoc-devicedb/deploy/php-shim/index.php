<?php
/**
 * ripperdoc-devicedb PHP reverse-proxy shim
 *
 * Forwards every request under https://www.ripperdoc.de/devicedb/* to the
 * Go service running on the NAS at $UPSTREAM. Used when the website's host
 * only provides "basic PHP" — i.e. mod_proxy / mod_proxy_http aren't
 * available so we can't do `RewriteRule [P]` proxying.
 *
 * Drop this file into  /public_html/devicedb/index.php  alongside the
 * .htaccess in the same directory. Adjust $UPSTREAM and $SHARED_SECRET
 * for your install.
 *
 * Forwards:
 *   - request method (GET, POST, DELETE, OPTIONS …)
 *   - request body (streamed via php://input)
 *   - query string
 *   - relevant request headers (auth, content-type, accept, user-agent,
 *     X-BoardRipper-Install-Token)
 *   - response status code
 *   - response headers (filtered — drops Transfer-Encoding, Connection,
 *     Server, X-Powered-By)
 *   - response body (streamed via curl WRITEFUNCTION so multi-MB tarballs
 *     don't blow the PHP memory_limit)
 *
 * NOT a Layer-7 reverse proxy in the strict sense — websockets, server-sent
 * events, chunked uploads >32 MB are NOT supported. The devicedb wire
 * surface is simple JSON + one tarball, so this is sufficient.
 */

// ─── Config ──────────────────────────────────────────────────────────────
// Edit this to your actual upstream. With the recommended Cloudflare
// Tunnel setup (see DEPLOY.md), this is the CF-issued hostname for the
// tunnel. Without CF Tunnel, point at your NAS DDNS + port.
$UPSTREAM       = getenv('DEVICEDB_UPSTREAM')
                  ?: 'https://devicedb-bridge.example.com';   // <-- edit me
$ALLOW_ORIGINS  = '*';                                          // CORS for browser fetches
$TIMEOUT_S      = 30;                                           // per-request budget
// Optional shared secret — useful when NAS is exposed directly via
// DDNS+port-forward (no CF Tunnel). Set it here AND on the Go service
// (a 6-line middleware addition; not yet implemented). Empty disables.
$SHARED_SECRET  = getenv('DEVICEDB_SHARED_SECRET') ?: '';

// ─── Request reconstruction ──────────────────────────────────────────────
// PATH_INFO is the URI minus the script path. With the .htaccess shipped
// alongside, /devicedb/api/v1/foo arrives here as PATH_INFO=/api/v1/foo
// (or REQUEST_URI tail after /devicedb/index.php/...). Be defensive about
// both styles.
$path = '';
if (isset($_SERVER['PATH_INFO']) && $_SERVER['PATH_INFO'] !== '') {
    $path = $_SERVER['PATH_INFO'];
} else {
    $reqUri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
    // Strip the /devicedb/ prefix; everything left is what we forward.
    $path = preg_replace('#^/devicedb#', '', $reqUri);
    if ($path === '' || $path === false) $path = '/';
}

// The Go server aliases /devicedb/api/v1/* to /v1/*, so we forward
// requests under the canonical /v1/ + /devicedb/ trees and the upstream
// resolves them correctly. We don't rewrite — keep the path as the
// browser asked for it.
$queryString = $_SERVER['QUERY_STRING'] ?? '';
$upstreamURL = rtrim($UPSTREAM, '/') . '/devicedb' . $path
             . ($queryString !== '' ? '?' . $queryString : '');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

// ─── Header pass-through ─────────────────────────────────────────────────
// Whitelist of inbound headers we forward. Everything else is dropped to
// avoid leaking PHP-host metadata (X-Forwarded-*, Cookie:, etc.).
$forwardHeaders = [];
$allowedIn = [
    'content-type', 'accept', 'accept-encoding', 'user-agent',
    'authorization', 'x-boardripper-install-token',
    'if-none-match', 'if-modified-since',
];
foreach ($allowedIn as $name) {
    $envKey = 'HTTP_' . strtoupper(str_replace('-', '_', $name));
    if (isset($_SERVER[$envKey])) {
        $forwardHeaders[] = $name . ': ' . $_SERVER[$envKey];
    } else if ($name === 'content-type' && isset($_SERVER['CONTENT_TYPE'])) {
        $forwardHeaders[] = 'content-type: ' . $_SERVER['CONTENT_TYPE'];
    }
}
if ($SHARED_SECRET !== '') {
    $forwardHeaders[] = 'x-devicedb-shim-secret: ' . $SHARED_SECRET;
}

// ─── CORS preflight short-circuit ────────────────────────────────────────
if ($method === 'OPTIONS') {
    header('Access-Control-Allow-Origin: ' . $ALLOW_ORIGINS);
    header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-BoardRipper-Install-Token, If-None-Match');
    header('Access-Control-Max-Age: 600');
    http_response_code(204);
    exit;
}

// ─── Body capture for write methods ──────────────────────────────────────
$body = null;
if (in_array($method, ['POST', 'PUT', 'PATCH', 'DELETE'], true)) {
    $body = file_get_contents('php://input');
}

// ─── cURL → upstream, streaming the response back ────────────────────────
$ch = curl_init($upstreamURL);
curl_setopt_array($ch, [
    CURLOPT_CUSTOMREQUEST  => $method,
    CURLOPT_HTTPHEADER     => $forwardHeaders,
    CURLOPT_RETURNTRANSFER => false,
    CURLOPT_HEADER         => false,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT        => $TIMEOUT_S,
]);
if ($body !== null && $body !== '') {
    curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
}

$headersSent = false;
$statusSet   = false;

// Status + headers handler — fires once for every response header line.
curl_setopt($ch, CURLOPT_HEADERFUNCTION, function ($ch, $hdr) use (&$headersSent, &$statusSet) {
    $len = strlen($hdr);
    $trim = trim($hdr);
    if ($trim === '') {
        $headersSent = true;
        // Always inject CORS on the way out.
        header('Access-Control-Allow-Origin: *');
        return $len;
    }
    // First line is "HTTP/1.1 200 OK"
    if (!$statusSet && stripos($trim, 'HTTP/') === 0) {
        $parts = explode(' ', $trim, 3);
        if (isset($parts[1])) {
            http_response_code((int)$parts[1]);
        }
        $statusSet = true;
        return $len;
    }
    // Drop hop-by-hop and PHP-host-leaky headers.
    $low = strtolower($trim);
    if (preg_match('#^(transfer-encoding|connection|keep-alive|server|x-powered-by):#i', $low)) {
        return $len;
    }
    header($trim, /*replace*/ true);
    return $len;
});

// Body handler — write straight to the client without buffering.
curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) {
    echo $chunk;
    // Flushing here keeps the response streaming when output_buffering is on.
    if (function_exists('ob_get_level') && ob_get_level() > 0) { @ob_flush(); }
    @flush();
    return strlen($chunk);
});

$ok = curl_exec($ch);
if ($ok === false) {
    // Upstream unreachable / timeout. Tell BoardRipper to back off.
    if (!headers_sent()) {
        http_response_code(502);
        header('Content-Type: application/json');
        header('X-Boardripper-Error-Code: shim_upstream_unreachable');
        echo json_encode([
            'error'   => 'upstream_unreachable',
            'message' => 'devicedb service did not respond — ' . curl_error($ch),
        ]);
    }
}
curl_close($ch);
