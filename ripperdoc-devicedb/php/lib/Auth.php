<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Token verification. The Go reference uses argon2id hashes for both install
 * and user tokens, paired with a `token_lookup` column (a fast index lookup
 * derived from the plaintext) because argon2 hashes can't be looked up by
 * value. We mirror that exactly.
 *
 * token_lookup = first 16 hex chars of sha256(plaintext). Collisions inside
 * a 64-bit prefix are negligible at our population sizes, and password_verify
 * is the actual gate.
 */
final class Auth
{
    public const SCOPE_SUBMIT   = 'contributions:submit';
    public const SCOPE_MODERATE = 'contributions:moderate';

    /** Same hex prefix scheme as the Go reference. */
    public static function lookup(string $plaintext): string
    {
        return substr(hash('sha256', $plaintext), 0, 16);
    }

    public static function hash(string $plaintext): string
    {
        return password_hash($plaintext, PASSWORD_ARGON2ID);
    }

    /**
     * Read the install token from the X-BoardRipper-Install-Token header, look
     * up its row, and verify the hash. Returns the (contributor_uuid, kind,
     * scopes[]) on success or null on miss/invalid/revoked/blocked.
     *
     * @return array{contributor_uuid:string,kind:string,scopes:string[],install_uuid:?string,user_uuid:?string}|null
     */
    public static function fromRequest(): ?array
    {
        $installPlain = self::header('HTTP_X_BOARDRIPPER_INSTALL_TOKEN');
        $bearerPlain  = '';
        $authz        = self::header('HTTP_AUTHORIZATION');
        if ($authz !== '' && stripos($authz, 'Bearer ') === 0) {
            $bearerPlain = trim(substr($authz, 7));
        }
        // Session is the third auth mechanism. Only attempt to open a
        // session if the request carried a session cookie — otherwise we
        // would issue an empty cookie on every read endpoint.
        AuthSession::bootstrapIfCookiePresent();
        $sessionUser = AuthSession::current();

        if ($installPlain === '' && $bearerPlain === '' && $sessionUser === null) {
            return null;
        }

        $installUuid = null;
        $userUuid    = null;
        $scopes      = [];

        if ($installPlain !== '') {
            $r = self::verifyTokenRow('install_tokens', $installPlain);
            if ($r === null) return null;
            $installUuid = $r['contributor_uuid'];
            $scopes      = [self::SCOPE_SUBMIT];
        }

        if ($bearerPlain !== '') {
            $r = self::verifyTokenRow('user_tokens', $bearerPlain);
            if ($r === null) return null;
            $userUuid = $r['contributor_uuid'];
            $userScopes = json_decode($r['scopes'] ?? '[]', true);
            if (!is_array($userScopes)) $userScopes = [];
            $scopes = array_values(array_unique(array_merge($scopes, $userScopes)));
        }

        // Session-based identity (rank #2 in the precedence table: it wins
        // over an install token but yields to a bearer token).
        if ($userUuid === null && $sessionUser !== null) {
            // Double-check the contributor row exists and isn't blocked —
            // otherwise stale sessions could survive a block action.
            $pdo  = Db::pdo();
            $stmt = $pdo->prepare("SELECT uuid, blocked FROM contributors WHERE uuid=? AND kind='user' LIMIT 1");
            $stmt->execute([$sessionUser['contributor_uuid']]);
            $row = $stmt->fetch();
            if ($row && (int) ($row['blocked'] ?? 0) === 0) {
                $userUuid = (string) $row['uuid'];
                $scopes = array_values(array_unique(array_merge($scopes, [self::SCOPE_SUBMIT])));
            }
        }

        // Attribution rule from §4.3: when user token is present, the user is
        // the contributor; install acts only as a fingerprint. Session-auth
        // user is treated identically to a bearer-token user here.
        $contributor = $userUuid ?? $installUuid;
        if ($contributor === null) {
            return null;
        }
        $kind        = $userUuid !== null ? 'user' : 'install';
        return [
            'contributor_uuid' => $contributor,
            'kind'             => $kind,
            'scopes'           => $scopes,
            'install_uuid'     => $installUuid,
            'user_uuid'        => $userUuid,
        ];
    }

    /**
     * @return array{contributor_uuid:string,scopes:?string}|null
     */
    private static function verifyTokenRow(string $table, string $plaintext): ?array
    {
        $pdo  = Db::pdo();
        $look = self::lookup($plaintext);
        $select = $table === 'user_tokens'
            ? "SELECT t.contributor_uuid, t.token_hash, t.scopes, c.blocked
                 FROM user_tokens t JOIN contributors c ON c.uuid = t.contributor_uuid
                 WHERE t.token_lookup = ? AND t.revoked = 0"
            : "SELECT t.contributor_uuid, t.token_hash, c.blocked
                 FROM install_tokens t JOIN contributors c ON c.uuid = t.contributor_uuid
                 WHERE t.token_lookup = ? AND t.revoked = 0";
        $stmt = $pdo->prepare($select);
        $stmt->execute([$look]);
        // There can in principle be more than one row sharing the same 64-bit
        // prefix; iterate until we find the real match.
        while (($row = $stmt->fetch()) !== false) {
            if ((int) ($row['blocked'] ?? 0) === 1) {
                continue;
            }
            if (password_verify($plaintext, $row['token_hash'])) {
                $pdo->prepare("UPDATE $table SET last_used_at=? WHERE token_lookup=?")
                    ->execute([Time::nowUtc(), $look]);
                return [
                    'contributor_uuid' => $row['contributor_uuid'],
                    'scopes'           => $row['scopes'] ?? null,
                ];
            }
        }
        return null;
    }

    public static function requireAuth(): array
    {
        $r = self::fromRequest();
        if ($r === null) {
            Json::err(401, 'auth_required', 'auth required');
            exit;
        }
        return $r;
    }

    public static function requireScope(array $authCtx, string $scope): void
    {
        if (!in_array($scope, $authCtx['scopes'], true)) {
            Json::err(403, 'scope_required', 'missing scope: ' . $scope);
            exit;
        }
    }

    private static function header(string $cgiKey): string
    {
        // PHP's built-in server normalises headers to HTTP_FOO_BAR.
        if (isset($_SERVER[$cgiKey])) {
            return trim((string) $_SERVER[$cgiKey]);
        }
        // Fallback for some configurations.
        $alt = str_replace('HTTP_', '', $cgiKey);
        $alt = str_replace('_', '-', $alt);
        if (function_exists('apache_request_headers')) {
            $h = apache_request_headers();
            foreach ($h as $k => $v) {
                if (strcasecmp($k, $alt) === 0) return trim((string) $v);
            }
        }
        return '';
    }
}
