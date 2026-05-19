<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Install registration — one shot at first BoardRipper launch.
 *
 * Spec §5.2: body {token, version_hint}. Server stores argon2id hash and
 * creates a contributors row (kind='install'). Idempotent — re-registering
 * the same plaintext is a no-op that returns the existing contributor UUID.
 *
 * Rate limits (per spec §5.2):
 *   5 registrations / hour / source IP, 20 / day / source IP.
 */
final class Installs
{
    public static function register(): void
    {
        // Rate limit by IP first — registration is unauthenticated.
        $ip = $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
        RateLimit::checkHour("installs:register:ip:$ip", 5);
        RateLimit::checkDay("installs:register:ip:$ip", 20);

        $body  = Json::readBody();
        $token = Json::str($body, 'token');
        $vhint = Json::str($body, 'version_hint');
        if ($token === '') {
            Json::err(400, 'empty_token', 'token is required');
            return;
        }

        $look = Auth::lookup($token);
        $pdo  = Db::pdo();

        // Idempotency: if a row already exists for this lookup AND password_verify
        // confirms the same plaintext, return the existing contributor.
        $stmt = $pdo->prepare("SELECT contributor_uuid, token_hash FROM install_tokens WHERE token_lookup=?");
        $stmt->execute([$look]);
        while (($row = $stmt->fetch()) !== false) {
            if (password_verify($token, $row['token_hash'])) {
                Json::ok(200, ['contributor_uuid' => $row['contributor_uuid'], 'created' => false]);
                return;
            }
        }

        $uuid = Uuid::v4();
        $now  = Time::nowUtc();
        Db::tx(function (\PDO $pdo) use ($uuid, $token, $vhint, $now, $look) {
            $pdo->prepare("INSERT INTO contributors (uuid, kind, created_at, last_seen) VALUES (?, 'install', ?, ?)")
                ->execute([$uuid, $now, $now]);
            $pdo->prepare(
                "INSERT INTO install_tokens (contributor_uuid, token_hash, token_lookup, created_at, version_hint)
                 VALUES (?, ?, ?, ?, ?)"
            )->execute([$uuid, Auth::hash($token), $look, $now, $vhint !== '' ? $vhint : null]);
        });

        Json::ok(200, ['contributor_uuid' => $uuid, 'created' => true]);
    }
}
