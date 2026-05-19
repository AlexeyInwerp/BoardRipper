<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Phase 2 prototype: user registration. Creates a contributors row of
 * kind='user' and mints one user_token. Plaintext is shown exactly once
 * in the response.
 *
 * Duplicate handles → HTTP 409 'handle_taken' (matching Go reference).
 */
final class Users
{
    public static function register(): void
    {
        // Rate limit identical to installs.
        $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        RateLimit::checkHour("users:register:ip:$ip", 5);
        RateLimit::checkDay("users:register:ip:$ip", 20);

        $body   = Json::readBody();
        $handle = trim(Json::str($body, 'handle'));
        $email  = trim(Json::str($body, 'email'));
        // Optional password — when present, store argon2id hash so the user
        // can log back in via /v1/auth/login. Token is still minted and
        // returned exactly once; password and token are independent
        // credentials. Empty string / missing key means "no password set".
        $password = isset($body['password']) && is_string($body['password']) ? $body['password'] : '';
        if ($handle === '') {
            Json::err(400, 'missing_handle', 'handle is required');
            return;
        }
        if ($password !== '') {
            $plen = strlen($password);
            if ($plen < 8 || $plen > 1024) {
                Json::err(400, 'weak_password', 'password must be 8..1024 chars');
                return;
            }
        }

        $pdo = Db::pdo();
        // Case-insensitive handle uniqueness, matching the Go SELECT.
        $stmt = $pdo->prepare("SELECT uuid FROM contributors WHERE kind='user' AND lower(handle) = lower(?) LIMIT 1");
        $stmt->execute([$handle]);
        if ($stmt->fetch()) {
            Json::err(409, 'handle_taken', 'handle already registered');
            return;
        }

        $uuid      = Uuid::v4();
        $now       = Time::nowUtc();
        // Match the Go reference's mintTokenString — 32 base64url chars (≈192 bits).
        $plaintext = self::mintToken();
        $passHash  = $password !== '' ? password_hash($password, PASSWORD_ARGON2ID) : null;
        Db::tx(function (\PDO $pdo) use ($uuid, $handle, $email, $now, $plaintext, $passHash) {
            $pdo->prepare("INSERT INTO contributors (uuid, kind, handle, email, created_at, last_seen, password_hash, password_set_at)
                           VALUES (?, 'user', ?, ?, ?, ?, ?, ?)")
                ->execute([
                    $uuid, $handle,
                    $email !== '' ? $email : null,
                    $now, $now,
                    $passHash,
                    $passHash !== null ? $now : null,
                ]);
            $pdo->prepare(
                "INSERT INTO user_tokens (contributor_uuid, token_hash, token_lookup, name, created_at, scopes)
                 VALUES (?, ?, ?, ?, ?, ?)"
            )->execute([
                $uuid,
                Auth::hash($plaintext),
                Auth::lookup($plaintext),
                'default',
                $now,
                '["contributions:submit"]',
            ]);
        });

        Json::ok(200, [
            'token'     => $plaintext,
            'user_uuid' => $uuid,
            'warning'   => 'save this token now — it is shown exactly once',
        ]);
    }

    /** 32-char URL-safe base64 from 24 random bytes, matching Go's mintTokenString(). */
    public static function mintToken(): string
    {
        return rtrim(strtr(base64_encode(random_bytes(24)), '+/', '-_'), '=');
    }
}
