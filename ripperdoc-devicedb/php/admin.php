#!/usr/bin/env php
<?php
declare(strict_types=1);

/**
 * Admin CLI — mirrors the Go reference's `ripperdoc-db-cli`.
 *
 * Usage:
 *   php admin.php queue list [--status submitted] [--limit 50]
 *   php admin.php queue show <uuid>
 *   php admin.php accept <uuid>
 *   php admin.php reject <uuid> --reason "..."
 *   php admin.php block <contributor_uuid> --reason "..."
 *   php admin.php token issue --handle H --email E --scopes "contributions:moderate"
 *   php admin.php snapshot regenerate
 */

if (PHP_SAPI !== 'cli') {
    fwrite(STDERR, "admin.php must be run from CLI\n");
    exit(1);
}

require __DIR__ . '/bootstrap.php';

use DeviceDB\Auth;
use DeviceDB\Db;
use DeviceDB\Snapshot;
use DeviceDB\Time;
use DeviceDB\Users;
use DeviceDB\Uuid;

$args = array_slice($argv, 1);
if (empty($args)) { usage(); exit(1); }

$cmd = array_shift($args);
$opts = parseFlags($args);
$pos  = $opts['__pos'];

try {
    switch ($cmd) {
        case 'queue':
            $sub = array_shift($pos) ?? 'list';
            if ($sub === 'list') queueList($opts);
            elseif ($sub === 'show') queueShow($pos[0] ?? '');
            else { fwrite(STDERR, "unknown queue subcommand: $sub\n"); exit(1); }
            break;
        case 'accept':
            accept($pos[0] ?? '', $opts);
            break;
        case 'reject':
            reject($pos[0] ?? '', $opts);
            break;
        case 'block':
            block($pos[0] ?? '', $opts);
            break;
        case 'token':
            $sub = array_shift($pos) ?? '';
            if ($sub !== 'issue') { fwrite(STDERR, "only `token issue` is supported\n"); exit(1); }
            tokenIssue($opts);
            break;
        case 'snapshot':
            $sub = array_shift($pos) ?? '';
            if ($sub !== 'regenerate') { fwrite(STDERR, "only `snapshot regenerate` is supported\n"); exit(1); }
            $r = Snapshot::regenerate();
            echo "snapshot regenerated counter={$r['counter']} sha256={$r['sha256']} size={$r['size_bytes']}\n";
            break;
        case 'photo':
            $sub = array_shift($pos) ?? '';
            if ($sub === 'delete')      photoDelete($pos[0] ?? '');
            elseif ($sub === 'list')    photoList($pos[0] ?? '');
            else { fwrite(STDERR, "unknown photo subcommand: $sub (use delete|list)\n"); exit(1); }
            break;
        case '--help':
        case '-h':
        case 'help':
            usage();
            break;
        default:
            fwrite(STDERR, "unknown command: $cmd\n");
            usage();
            exit(1);
    }
} catch (\Throwable $e) {
    fwrite(STDERR, "admin: " . $e->getMessage() . "\n");
    exit(1);
}

function usage(): void
{
    echo <<<TXT
ripperdoc-devicedb admin CLI

  php admin.php queue list [--status submitted] [--limit 50]
  php admin.php queue show <uuid>
  php admin.php accept <uuid> --moderator <contributor_uuid>
  php admin.php reject <uuid> --reason "..." --moderator <contributor_uuid>
  php admin.php block <contributor_uuid> --reason "..." --moderator <contributor_uuid>
  php admin.php token issue --handle H [--email E] [--scopes contributions:moderate]
  php admin.php snapshot regenerate
  php admin.php photo delete <photo_uuid>
  php admin.php photo list <board_uuid|model_uuid>

--moderator can be omitted; the CLI then accepts using the first kind='user'
contributor with the moderator scope.

TXT;
}

function parseFlags(array $args): array
{
    $out = ['__pos' => []];
    for ($i = 0; $i < count($args); $i++) {
        $a = $args[$i];
        if (strpos($a, '--') === 0) {
            $key = substr($a, 2);
            $val = ($i + 1 < count($args) && strpos($args[$i + 1], '--') !== 0)
                ? $args[++$i] : '1';
            $out[$key] = $val;
        } else {
            $out['__pos'][] = $a;
        }
    }
    return $out;
}

function queueList(array $opts): void
{
    $status = $opts['status'] ?? 'submitted';
    $limit  = (int) ($opts['limit'] ?? 50);
    $pdo = Db::pdo();
    $stmt = $pdo->prepare(
        "SELECT uuid, target_type, target_uuid, target_field, value_to, value_from, status, contributor_uuid, submitted_at
         FROM contributions WHERE status=? ORDER BY submitted_at ASC LIMIT ?"
    );
    $stmt->bindValue(1, $status, PDO::PARAM_STR);
    $stmt->bindValue(2, $limit,  PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll();
    if (empty($rows)) { echo "(no rows)\n"; return; }
    foreach ($rows as $r) {
        printf("%s  %-12s %s.%s  '%s' -> '%s'  by=%s  at=%s\n",
            $r['uuid'], $r['status'],
            $r['target_type'], $r['target_field'],
            (string) ($r['value_from'] ?? ''), (string) ($r['value_to'] ?? ''),
            substr($r['contributor_uuid'], 0, 8), $r['submitted_at']);
    }
}

function queueShow(string $uuid): void
{
    if ($uuid === '') { fwrite(STDERR, "uuid required\n"); exit(1); }
    $pdo = Db::pdo();
    $stmt = $pdo->prepare("SELECT * FROM contributions WHERE uuid=?");
    $stmt->execute([$uuid]);
    $row = $stmt->fetch();
    if (!$row) { fwrite(STDERR, "not found\n"); exit(1); }
    echo json_encode($row, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n";
    $aud = $pdo->prepare("SELECT * FROM contribution_audit WHERE contribution_uuid=? ORDER BY id");
    $aud->execute([$uuid]);
    echo "audit:\n" . json_encode($aud->fetchAll(), JSON_PRETTY_PRINT) . "\n";
}

function moderatorUuid(array $opts): string
{
    if (!empty($opts['moderator'])) return (string) $opts['moderator'];
    $pdo = Db::pdo();
    $row = $pdo->query(
        "SELECT c.uuid FROM contributors c
           JOIN user_tokens t ON t.contributor_uuid=c.uuid
          WHERE c.kind='user' AND c.blocked=0 AND instr(t.scopes,'contributions:moderate')>0
          LIMIT 1"
    )->fetch();
    if (!$row) {
        throw new RuntimeException('no moderator contributor exists; pass --moderator <uuid>');
    }
    return $row['uuid'];
}

function accept(string $uuid, array $opts): void
{
    if ($uuid === '') { fwrite(STDERR, "uuid required\n"); exit(1); }
    $mod = moderatorUuid($opts);
    $ctx = ['contributor_uuid' => $mod, 'scopes' => [Auth::SCOPE_MODERATE]];
    // Reuse Contribs::adminAccept by emulating HTTP context.
    $_SERVER['REQUEST_METHOD'] = 'POST';
    DeviceDB\Contribs::adminAccept($ctx, $uuid);
    echo "\n";
}

function reject(string $uuid, array $opts): void
{
    if ($uuid === '') { fwrite(STDERR, "uuid required\n"); exit(1); }
    $reason = (string) ($opts['reason'] ?? '');
    if ($reason === '') { fwrite(STDERR, "--reason required\n"); exit(1); }
    $mod = moderatorUuid($opts);
    // Synthesise a request body for adminReject.
    $stream = fopen('php://temp', 'r+');
    fwrite($stream, json_encode(['reason' => $reason]));
    rewind($stream);
    $GLOBALS['__cli_body'] = stream_get_contents($stream);
    fclose($stream);

    // Monkey-patch php://input via stream wrapper isn't trivial; instead,
    // call the SQL path directly here for CLI.
    $pdo = Db::pdo();
    $r = $pdo->prepare("SELECT status FROM contributions WHERE uuid=?");
    $r->execute([$uuid]);
    $row = $r->fetch();
    if (!$row) { fwrite(STDERR, "not_found\n"); exit(1); }
    if ($row['status'] !== 'submitted') { fwrite(STDERR, "not_pending (status={$row['status']})\n"); exit(1); }
    $now = Time::nowUtc();
    Db::tx(function (PDO $pdo) use ($uuid, $mod, $now, $reason) {
        $pdo->prepare("UPDATE contributions SET status='rejected', reviewer_uuid=?, reviewed_at=?, reject_reason=? WHERE uuid=?")
            ->execute([$mod, $now, $reason, $uuid]);
        $pdo->prepare(
            "INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note)
             VALUES (?, 'submitted', 'rejected', ?, ?, ?)"
        )->execute([$uuid, $mod, $now, $reason]);
    });
    echo "rejected $uuid\n";
}

function block(string $uuid, array $opts): void
{
    if ($uuid === '') { fwrite(STDERR, "uuid required\n"); exit(1); }
    $reason = (string) ($opts['reason'] ?? '');
    if ($reason === '') { fwrite(STDERR, "--reason required\n"); exit(1); }
    $pdo = Db::pdo();
    $r = $pdo->prepare("SELECT uuid FROM contributors WHERE uuid=?");
    $r->execute([$uuid]);
    if (!$r->fetch()) { fwrite(STDERR, "contributor not found: $uuid\n"); exit(1); }
    $pdo->prepare("UPDATE contributors SET blocked=1, blocked_reason=? WHERE uuid=?")
        ->execute([$reason, $uuid]);
    echo "blocked $uuid\n";
}

function tokenIssue(array $opts): void
{
    $handle = (string) ($opts['handle'] ?? '');
    $email  = (string) ($opts['email']  ?? '');
    $scopes = (string) ($opts['scopes'] ?? 'contributions:submit');
    if ($handle === '') { fwrite(STDERR, "--handle required\n"); exit(1); }
    $pdo = Db::pdo();

    $row = $pdo->prepare("SELECT uuid FROM contributors WHERE kind='user' AND lower(handle)=lower(?) LIMIT 1");
    $row->execute([$handle]);
    $existing = $row->fetch();
    $uuid = $existing ? $existing['uuid'] : Uuid::v4();
    $now  = Time::nowUtc();
    if (!$existing) {
        $pdo->prepare("INSERT INTO contributors (uuid, kind, handle, email, created_at, last_seen)
                       VALUES (?, 'user', ?, ?, ?, ?)")
            ->execute([$uuid, $handle, $email !== '' ? $email : null, $now, $now]);
    }
    $plaintext = Users::mintToken();
    $scopesJson = json_encode(array_values(array_filter(array_map('trim', explode(',', $scopes)))));
    $pdo->prepare(
        "INSERT INTO user_tokens (contributor_uuid, token_hash, token_lookup, name, created_at, scopes)
         VALUES (?, ?, ?, ?, ?, ?)"
    )->execute([$uuid, Auth::hash($plaintext), Auth::lookup($plaintext), 'cli', $now, $scopesJson]);
    echo "user_uuid=$uuid\n";
    echo "token=$plaintext\n";
    echo "scopes=$scopesJson\n";
}

function photoDelete(string $photoUuid): void
{
    if ($photoUuid === '') { fwrite(STDERR, "photo uuid required\n"); exit(1); }
    $pdo = Db::pdo();
    $deleted = 0;
    foreach (['board_photos', 'model_photos'] as $table) {
        $stmt = $pdo->prepare("DELETE FROM $table WHERE uuid=?");
        $stmt->execute([$photoUuid]);
        $deleted += $stmt->rowCount();
    }
    if ($deleted === 0) {
        fwrite(STDERR, "not_found: no photo with uuid $photoUuid\n");
        exit(1);
    }
    $pdo->exec("UPDATE snapshot_state SET dirty=1 WHERE id=1");
    echo "deleted $photoUuid (rows=$deleted)\n";
}

function photoList(string $parentUuid): void
{
    if ($parentUuid === '') { fwrite(STDERR, "parent uuid (board or model) required\n"); exit(1); }
    $pdo = Db::pdo();
    $rows = [];
    foreach ([['board_photos', 'board_uuid'], ['model_photos', 'model_uuid']] as [$table, $col]) {
        $stmt = $pdo->prepare("SELECT '$table' AS table_name, uuid, photo_url, COALESCE(caption,'') AS caption, accepted_at FROM $table WHERE $col=? ORDER BY accepted_at");
        $stmt->execute([$parentUuid]);
        foreach ($stmt->fetchAll() as $r) {
            $rows[] = $r;
        }
    }
    if (empty($rows)) { echo "(no photos)\n"; return; }
    foreach ($rows as $r) {
        printf("%s  %s  url=%s  caption=%s  at=%s\n",
            $r['table_name'], $r['uuid'], $r['photo_url'],
            $r['caption'] === '' ? '(none)' : $r['caption'],
            $r['accepted_at']);
    }
}
