<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Cookie-session login backed by contributors.password_hash (argon2id).
 *
 * Endpoints:
 *   POST /v1/auth/login   {handle, password}   → 200 + Set-Cookie + identity
 *   POST /v1/auth/logout                       → 204
 *   GET  /v1/auth/me                           → 200 identity | 401
 *
 * Token-based auth still works exactly as before; this is additive. When
 * Auth::fromRequest finds a logged-in session, it treats the user the same
 * way as a bearer-token user. See Auth.php for precedence rules.
 *
 * Bad-password constant-time-ish defence: any failed login sleeps ≥ 50 ms
 * regardless of which step (lookup, password_verify) actually failed.
 */
final class AuthSession
{
    /**
     * Open a PHP session ONLY when the request carries a session cookie.
     * Called at the top of api.php so we don't issue an empty cookie on
     * every GET /entities — that would pollute downstream caches.
     */
    public static function bootstrapIfCookiePresent(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        $name = self::sessionName();
        if (empty($_COOKIE[$name])) {
            return;
        }
        self::configureCookie();
        @session_start();
    }

    /** Force-start (used by /auth/login when minting a fresh session). */
    public static function start(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        self::configureCookie();
        @session_start();
    }

    /** Returns ['contributor_uuid' => ..., 'handle' => ...] | null. */
    public static function current(): ?array
    {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            return null;
        }
        $uuid = $_SESSION['contributor_uuid'] ?? null;
        if (!is_string($uuid) || $uuid === '') {
            return null;
        }
        return [
            'contributor_uuid' => $uuid,
            'handle'           => (string) ($_SESSION['handle'] ?? ''),
        ];
    }

    /** POST /v1/auth/login. */
    public static function login(): void
    {
        $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        RateLimit::checkHour("auth:login:ip:$ip", 10);

        $body     = Json::readBody();
        $handle   = trim(Json::str($body, 'handle'));
        $password = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';
        if ($handle === '' || $password === '') {
            // Same error code as a real verify failure: don't leak which is
            // missing. Still constant-time-ish.
            self::sleepMinDelay();
            Json::err(401, 'bad_credentials', 'invalid handle or password');
            return;
        }

        $pdo = Db::pdo();
        $stmt = $pdo->prepare(
            "SELECT uuid, handle, password_hash, blocked
             FROM contributors
             WHERE kind='user' AND lower(handle) = lower(?)
             LIMIT 1"
        );
        $stmt->execute([$handle]);
        $row = $stmt->fetch();

        $ok = false;
        if ($row && (int) ($row['blocked'] ?? 0) === 0
            && is_string($row['password_hash'] ?? null)
            && $row['password_hash'] !== ''
        ) {
            $ok = password_verify($password, (string) $row['password_hash']);
        } else {
            // Throwaway verify against a fixed hash to keep timing similar
            // regardless of whether the row exists.
            @password_verify($password, '$argon2id$v=19$m=65536,t=4,p=1$WkkrcVB5UnVvVmM4emRrUw$8sZqVDsx9pJxCs+kAY7nxIeshqfL6ETD+8K/4mTwYRY');
        }

        self::sleepMinDelay();

        if (!$ok) {
            Json::err(401, 'bad_credentials', 'invalid handle or password');
            return;
        }

        // Re-issue session id on successful auth (session fixation defence).
        self::start();
        @session_regenerate_id(true);

        $_SESSION['contributor_uuid'] = (string) $row['uuid'];
        $_SESSION['handle']           = (string) $row['handle'];

        // Update last_seen.
        $pdo->prepare("UPDATE contributors SET last_seen=? WHERE uuid=?")
            ->execute([Time::nowUtc(), (string) $row['uuid']]);

        // Scopes for a session-authed user mirror what a freshly-minted user
        // token gets: contributions:submit. Moderator scope must come from
        // a bearer token explicitly.
        Json::ok(200, [
            'user_uuid' => (string) $row['uuid'],
            'handle'    => (string) $row['handle'],
            'scopes'    => [Auth::SCOPE_SUBMIT],
        ]);
    }

    /** POST /v1/auth/logout — destroys session, clears cookie. */
    public static function logout(): void
    {
        self::bootstrapIfCookiePresent();
        if (session_status() === PHP_SESSION_ACTIVE) {
            $_SESSION = [];
            // Expire the cookie on the client. Match the original cookie
            // attrs so the browser actually deletes it.
            $name = self::sessionName();
            if (ini_get('session.use_cookies')) {
                $params = session_get_cookie_params();
                setcookie($name, '', [
                    'expires'  => time() - 42000,
                    'path'     => $params['path']     ?? '/',
                    'domain'   => $params['domain']   ?? '',
                    'secure'   => true,
                    'httponly' => true,
                    'samesite' => 'Strict',
                ]);
            }
            @session_destroy();
        }
        if (function_exists('http_response_code')) {
            http_response_code(204);
        }
        header('Access-Control-Allow-Origin: *');
        // No body for 204.
    }

    /** GET /v1/auth/me. */
    public static function me(): void
    {
        self::bootstrapIfCookiePresent();
        $cur = self::current();
        if ($cur === null) {
            Json::err(401, 'not_logged_in', 'no active session');
            return;
        }
        Json::ok(200, [
            'user_uuid' => $cur['contributor_uuid'],
            'handle'    => $cur['handle'],
            'scopes'    => [Auth::SCOPE_SUBMIT],
        ]);
    }

    private static function configureCookie(): void
    {
        $name = self::sessionName();
        if (session_name() !== $name) {
            @session_name($name);
        }
        // Cookie path strategy: in production the app is mounted at
        // /devicedb/ (LiteSpeed maps /devicedb/api/v1/* → api.php), so
        // path=/devicedb/ scopes the cookie correctly. For `php -S` dev
        // and tests, requests hit /v1/* directly, so we fall back to '/'.
        // The detector is "is /devicedb/ a prefix of REQUEST_URI?".
        $reqUri = $_SERVER['REQUEST_URI'] ?? '/';
        $path = (strpos($reqUri, '/devicedb/') === 0) ? '/devicedb/' : '/';
        // Auto-Secure based on request scheme: dev server runs plain HTTP,
        // production behind LiteSpeed terminates TLS. Spec says "MUST be
        // Secure"; in dev we relax it so the cookie can actually be set —
        // browsers reject Secure-on-HTTP and curl drops it from the jar.
        $secure = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
            || ($_SERVER['SERVER_PORT'] ?? '') === '443';
        @session_set_cookie_params([
            'lifetime' => 0,
            'path'     => $path,
            'domain'   => '',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
    }

    private static function sessionName(): string
    {
        return 'devicedb_sess';
    }

    /** Constant-time-ish: ≥ 50 ms on any failure path. */
    private static function sleepMinDelay(): void
    {
        usleep(50_000);
    }
}
