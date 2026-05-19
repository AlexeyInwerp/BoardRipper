<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Contribution CRUD + state transitions + admin accept/reject + supersede.
 *
 * Wire shape (spec §5.5) — body keys:
 *   target.{type, uuid, field}, to, from, evidence.{source_url,
 *     board_in_hand, board_in_hand_ctx, rationale}, confidence, client_ts
 *
 * Server stores the row, then on accept re-checks value_from against the
 * canonical (optimistic concurrency, §5.6) and applies via UPDATE.
 */
final class Contribs
{
    /** POST /v1/contributions — submit a patch. */
    public static function submit(array $authCtx): void
    {
        Auth::requireScope($authCtx, Auth::SCOPE_SUBMIT);

        // Per-install / per-user rate limits (§5.7).
        $isUser = $authCtx['kind'] === 'user';
        $rlKey  = $isUser
            ? "contrib:user:{$authCtx['user_uuid']}"
            : "contrib:install:{$authCtx['install_uuid']}";
        RateLimit::checkHour($rlKey, $isUser ? 120 : 30);
        RateLimit::checkDay($rlKey,  $isUser ? 1000 : 200);

        $body   = Json::readBody();
        $target = is_array($body['target'] ?? null) ? $body['target'] : [];
        $type   = Json::str($target, 'type');
        $tuuid  = Json::str($target, 'uuid');
        $field  = Json::str($target, 'field');
        if ($type === '' || $tuuid === '' || $field === '') {
            Json::err(400, 'bad_target', 'target.type, target.uuid, target.field required');
            return;
        }
        if (!Allowlist::knownType($type)) {
            Json::err(400, 'bad_type', 'unknown target_type: ' . $type);
            return;
        }
        if (!Allowlist::isWritable($type, $field)) {
            Json::err(400, 'field_not_writable', "field_not_writable: $type.$field");
            return;
        }

        // client_ts clamp.
        $clientTs = Json::str($body, 'client_ts');
        if (!Time::clientTsInBounds($clientTs)) {
            Json::err(400, 'bad_client_ts', 'client_ts outside [now-7d, now+1h]');
            return;
        }

        // Evidence presence.
        $ev          = is_array($body['evidence'] ?? null) ? $body['evidence'] : [];
        $sourceUrl   = Json::str($ev, 'source_url');
        $rationale   = Json::str($ev, 'rationale');
        $inHand      = !empty($ev['board_in_hand']) ? 1 : 0;
        $inHandCtx   = isset($ev['board_in_hand_ctx']) && $ev['board_in_hand_ctx'] !== null
            ? json_encode($ev['board_in_hand_ctx'])
            : null;

        if ($sourceUrl === '' && $inHand !== 1 && strlen($rationale) < 4) {
            Json::err(400, 'evidence_missing', 'submission requires at least one form of evidence');
            return;
        }

        $confidence = Json::str($body, 'confidence');
        if ($confidence !== '' && !in_array($confidence, ['low', 'medium', 'high'], true)) {
            Json::err(400, 'bad_confidence', 'confidence must be low|medium|high');
            return;
        }

        // Validate target exists. entity_color is keyed by composite —
        // accept the synthetic "scope_type:scope_uuid" form per the Go err msg
        // we saw in the binary strings ("entity_color target_uuid must be
        // scope_type:scope_uuid: %q").
        if (!self::targetExists($type, $tuuid)) {
            Json::err(404, 'target_not_found', 'target entity not found');
            return;
        }

        // value_from precondition (optimistic concurrency, §5.6).
        $valTo   = array_key_exists('to', $body)   ? self::scalarOrNull($body['to'])   : null;
        $valFrom = array_key_exists('from', $body) ? self::scalarOrNull($body['from']) : '';

        // Pseudo-field validation: keyword/codename require a non-empty `to`;
        // photo_url additionally requires an https:// URL ≤ 2048 chars.
        if (Allowlist::isPseudo($type, $field)) {
            $kind = Allowlist::pseudoKind($field);
            if ($valTo === null || $valTo === '') {
                Json::err(400, 'bad_submission', "$field requires a non-empty 'to' value");
                return;
            }
            if ($kind === 'photo') {
                if (strlen($valTo) > 2048 || stripos($valTo, 'https://') !== 0) {
                    Json::err(400, 'bad_photo_url', 'photo_url must be https:// and ≤ 2048 chars');
                    return;
                }
            }
        }

        $uuid = Uuid::v4();
        $now  = Time::nowUtc();

        try {
            Db::tx(function (\PDO $pdo) use (
                $uuid, $type, $tuuid, $field, $valTo, $valFrom,
                $sourceUrl, $inHand, $inHandCtx, $rationale,
                $confidence, $authCtx, $now, $clientTs
            ) {
                $stmt = $pdo->prepare(
                    "INSERT INTO contributions (
                        uuid, target_type, target_uuid, target_field,
                        value_to, value_from,
                        evidence_source_url, evidence_in_hand, evidence_in_hand_ctx, evidence_rationale,
                        confidence, status,
                        contributor_uuid, install_uuid,
                        submitted_at, client_ts
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?)"
                );
                $stmt->execute([
                    $uuid, $type, $tuuid, $field,
                    $valTo, $valFrom,
                    $sourceUrl !== '' ? $sourceUrl : null,
                    $inHand, $inHandCtx,
                    $rationale !== '' ? $rationale : null,
                    $confidence !== '' ? $confidence : null,
                    $authCtx['contributor_uuid'],
                    $authCtx['install_uuid'],
                    $now, $clientTs,
                ]);
                $pdo->prepare(
                    "INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note)
                     VALUES (?, '', 'submitted', ?, ?, 'submitted via API')"
                )->execute([$uuid, $authCtx['contributor_uuid'], $now]);
            });
        } catch (\PDOException $e) {
            // Most likely a CHECK constraint violation.
            Json::err(400, 'bad_submission', $e->getMessage());
            return;
        }

        // Queue position = number of submitted-or-earlier rows at the same target_field.
        $pdo = Db::pdo();
        $qp  = $pdo->prepare("SELECT count(*) AS n FROM contributions WHERE status='submitted' AND submitted_at <= ?");
        $qp->execute([$now]);
        $qrow = $qp->fetch();

        Json::ok(200, [
            'uuid'           => $uuid,
            'status'         => 'submitted',
            'queue_position' => (int) ($qrow['n'] ?? 1),
        ]);
    }

    private static function scalarOrNull($v): ?string
    {
        if ($v === null) return null;
        if (is_bool($v)) return $v ? '1' : '0';
        if (is_scalar($v)) return (string) $v;
        return json_encode($v);
    }

    private static function targetExists(string $type, string $uuid): bool
    {
        $table = Allowlist::tableFor($type);
        if ($table === null) return false;
        $pdo = Db::pdo();
        if ($type === 'entity_color') {
            // Composite key — accept "scope_type:scope_uuid".
            $parts = explode(':', $uuid, 2);
            if (count($parts) !== 2) return false;
            $stmt = $pdo->prepare("SELECT 1 FROM entity_color WHERE scope_type=? AND scope_uuid=?");
            $stmt->execute($parts);
            return (bool) $stmt->fetch();
        }
        $stmt = $pdo->prepare("SELECT 1 FROM \"$table\" WHERE uuid=?");
        $stmt->execute([$uuid]);
        return (bool) $stmt->fetch();
    }

    /** GET /v1/contributions/mine — caller's own submissions. */
    public static function mine(array $authCtx): void
    {
        $status = isset($_GET['status']) ? (string) $_GET['status'] : '';
        $where  = "contributor_uuid=? OR install_uuid=?";
        $params = [$authCtx['contributor_uuid'], $authCtx['install_uuid'] ?? $authCtx['contributor_uuid']];
        if ($status !== '' && $status !== '*') {
            $where .= " AND status=?";
            $params[] = $status;
        }
        $pdo = Db::pdo();
        $stmt = $pdo->prepare(
            "SELECT uuid, target_type, target_uuid, target_field, value_to, value_from,
                    evidence_source_url, evidence_in_hand, evidence_in_hand_ctx, evidence_rationale,
                    confidence, status, contributor_uuid, install_uuid, submitted_at, client_ts
             FROM contributions
             WHERE $where
             ORDER BY submitted_at DESC
             LIMIT 200"
        );
        $stmt->execute($params);
        $rows = self::projectRows($stmt->fetchAll());
        Json::ok(200, ['contributions' => $rows ?: null]);
    }

    /**
     * GET /v1/contributions/recent — public feed of recently-accepted edits
     * across the whole DB. No auth. Powers /devicedb/recent.html.
     *
     * Query params:
     *   status (only `accepted` is exposed publicly — other values 400)
     *   limit  (capped at 100)
     */
    public static function recent(): void
    {
        $status = isset($_GET['status']) ? (string) $_GET['status'] : 'accepted';
        if ($status !== 'accepted') {
            Json::err(400, 'bad_status', 'public feed only exposes status=accepted');
            return;
        }
        $limit = isset($_GET['limit']) ? (int) $_GET['limit'] : 50;
        if ($limit < 1) $limit = 50;
        if ($limit > 100) $limit = 100;

        $pdo = Db::pdo();
        $stmt = $pdo->prepare(
            "SELECT c.uuid, c.target_type, c.target_uuid, c.target_field,
                    c.value_to, c.value_from, c.submitted_at, c.reviewed_at,
                    ctb.handle AS contributor_handle, ctb.kind AS contributor_kind,
                    c.install_uuid
             FROM contributions c
             LEFT JOIN contributors ctb ON ctb.uuid = c.contributor_uuid
             WHERE c.status = 'accepted'
             ORDER BY COALESCE(c.reviewed_at, c.submitted_at) DESC
             LIMIT :lim"
        );
        $stmt->bindValue(':lim', $limit, \PDO::PARAM_INT);
        $stmt->execute();
        $rows = [];
        foreach ($stmt->fetchAll() as $r) {
            // Public attribution: show user handle if present; otherwise
            // a short fingerprint of the install UUID.
            $attribution = $r['contributor_handle'] !== null && $r['contributor_handle'] !== ''
                ? (string) $r['contributor_handle']
                : 'install:' . substr((string) $r['install_uuid'], 0, 8);
            $rows[] = [
                'uuid'          => (string) $r['uuid'],
                'target_type'   => (string) $r['target_type'],
                'target_uuid'   => (string) $r['target_uuid'],
                'target_field'  => (string) $r['target_field'],
                'value_to'      => $r['value_to'],
                'value_from'    => $r['value_from'],
                'submitted_at'  => (string) $r['submitted_at'],
                'reviewed_at'   => (string) ($r['reviewed_at'] ?? ''),
                'attribution'   => $attribution,
            ];
        }
        Json::ok(200, ['contributions' => $rows]);
    }

    /** GET /v1/contributions/{uuid} — single, owner-restricted. */
    public static function getOne(array $authCtx, string $uuid): void
    {
        $pdo = Db::pdo();
        $stmt = $pdo->prepare("SELECT * FROM contributions WHERE uuid=?");
        $stmt->execute([$uuid]);
        $row = $stmt->fetch();
        if (!$row) {
            Json::err(404, 'not_found', '');
            return;
        }
        if ($row['contributor_uuid'] !== $authCtx['contributor_uuid']
            && $row['install_uuid']     !== ($authCtx['install_uuid'] ?? null)
            && !in_array(Auth::SCOPE_MODERATE, $authCtx['scopes'], true)) {
            Json::err(403, 'forbidden', 'not yours');
            return;
        }
        Json::ok(200, self::projectRows([$row])[0]);
    }

    /** DELETE /v1/contributions/{uuid} — withdraw own pending submission. */
    public static function withdraw(array $authCtx, string $uuid): void
    {
        $pdo = Db::pdo();
        $stmt = $pdo->prepare("SELECT status, contributor_uuid, install_uuid FROM contributions WHERE uuid=?");
        $stmt->execute([$uuid]);
        $row = $stmt->fetch();
        if (!$row) {
            Json::err(404, 'not_found', '');
            return;
        }
        if ($row['contributor_uuid'] !== $authCtx['contributor_uuid']
            && $row['install_uuid']     !== ($authCtx['install_uuid'] ?? null)) {
            Json::err(403, 'forbidden', 'not yours');
            return;
        }
        if ($row['status'] !== 'submitted') {
            Json::err(409, 'not_pending', 'only pending submissions can be withdrawn');
            return;
        }
        $now = Time::nowUtc();
        Db::tx(function (\PDO $pdo) use ($uuid, $authCtx, $now) {
            $pdo->prepare("UPDATE contributions SET status='withdrawn' WHERE uuid=?")->execute([$uuid]);
            $pdo->prepare(
                "INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note)
                 VALUES (?, 'submitted', 'withdrawn', ?, ?, 'self-withdraw')"
            )->execute([$uuid, $authCtx['contributor_uuid'], $now]);
        });
        Json::ok(200, ['uuid' => $uuid, 'status' => 'withdrawn']);
    }

    /** GET /v1/admin/contributions/queue — reviewer queue. */
    public static function adminQueue(array $authCtx): void
    {
        Auth::requireScope($authCtx, Auth::SCOPE_MODERATE);
        $status = isset($_GET['status']) ? (string) $_GET['status'] : 'submitted';
        $order  = isset($_GET['order'])  ? (string) $_GET['order']  : 'oldest_first';
        $limit  = isset($_GET['limit'])  ? max(1, min(500, (int) $_GET['limit'])) : 50;
        $orderSql = $order === 'newest_first' ? 'DESC' : 'ASC';
        $pdo = Db::pdo();
        $stmt = $pdo->prepare(
            "SELECT * FROM contributions WHERE status=? ORDER BY submitted_at $orderSql LIMIT ?"
        );
        $stmt->bindValue(1, $status, \PDO::PARAM_STR);
        $stmt->bindValue(2, $limit, \PDO::PARAM_INT);
        $stmt->execute();
        $rows = self::projectRows($stmt->fetchAll());
        Json::ok(200, ['contributions' => $rows ?: null]);
    }

    /** POST /v1/admin/contributions/{uuid}/accept — apply patch to canonical. */
    public static function adminAccept(array $authCtx, string $uuid): void
    {
        Auth::requireScope($authCtx, Auth::SCOPE_MODERATE);
        $pdo = Db::pdo();
        $stmt = $pdo->prepare("SELECT status, target_type, target_uuid, target_field, value_to, value_from FROM contributions WHERE uuid=?");
        $stmt->execute([$uuid]);
        $c = $stmt->fetch();
        if (!$c) {
            Json::err(404, 'not_found', '');
            return;
        }
        if ($c['status'] !== 'submitted') {
            Json::err(409, 'not_pending', 'only submitted contributions can be accepted');
            return;
        }

        $type    = $c['target_type'];
        $tuuid   = $c['target_uuid'];
        $field   = $c['target_field'];
        $valTo   = $c['value_to'];
        $valFrom = $c['value_from'];
        $now     = Time::nowUtc();

        if (!Allowlist::isWritable($type, $field)) {
            Json::err(400, 'field_not_writable', "field_not_writable: $type.$field");
            return;
        }

        Db::tx(function (\PDO $pdo) use ($uuid, $type, $tuuid, $field, $valTo, $valFrom, $authCtx, $now) {
            // Re-check value_from. If canonical has moved on, auto-supersede.
            $current = self::currentValue($pdo, $type, $tuuid, $field);
            $expectedFrom = $valFrom === null ? '' : (string) $valFrom;
            $actualCurrent = $current === null ? '' : (string) $current;
            if ($expectedFrom !== '' && $actualCurrent !== $expectedFrom) {
                $pdo->prepare("UPDATE contributions SET status='superseded', reviewer_uuid=?, reviewed_at=? WHERE uuid=?")
                    ->execute([$authCtx['contributor_uuid'], $now, $uuid]);
                $pdo->prepare(
                    "INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note)
                     VALUES (?, 'submitted', 'superseded', ?, ?, ?)"
                )->execute([$uuid, $authCtx['contributor_uuid'], $now,
                    "current=$actualCurrent expected_from=$expectedFrom"]);
                Json::ok(200, [
                    'uuid'          => $uuid,
                    'status'        => 'superseded',
                    'current_value' => $actualCurrent,
                    'expected_from' => $expectedFrom,
                ]);
                return;
            }

            // Apply the patch.
            self::applyPatch($pdo, $type, $tuuid, $field, $valTo, $valFrom, $authCtx['contributor_uuid'] ?? '', $now);
            $pdo->prepare("UPDATE contributions SET status='accepted', reviewer_uuid=?, reviewed_at=? WHERE uuid=?")
                ->execute([$authCtx['contributor_uuid'], $now, $uuid]);
            $pdo->prepare(
                "INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note)
                 VALUES (?, 'submitted', 'accepted', ?, ?, 'applied to canonical')"
            )->execute([$uuid, $authCtx['contributor_uuid'], $now]);
            $pdo->exec("UPDATE snapshot_state SET dirty=1 WHERE id=1");
            Json::ok(200, ['uuid' => $uuid, 'status' => 'accepted']);
        });
    }

    /** POST /v1/admin/contributions/{uuid}/reject. */
    public static function adminReject(array $authCtx, string $uuid): void
    {
        Auth::requireScope($authCtx, Auth::SCOPE_MODERATE);
        $body = Json::readBody();
        $reason = Json::str($body, 'reason');
        if ($reason === '') {
            Json::err(400, 'missing_reason', 'reason is required');
            return;
        }
        $pdo = Db::pdo();
        $stmt = $pdo->prepare("SELECT status FROM contributions WHERE uuid=?");
        $stmt->execute([$uuid]);
        $row = $stmt->fetch();
        if (!$row) {
            Json::err(404, 'not_found', '');
            return;
        }
        if ($row['status'] !== 'submitted') {
            Json::err(409, 'not_pending', 'only submitted contributions can be rejected');
            return;
        }
        $now = Time::nowUtc();
        Db::tx(function (\PDO $pdo) use ($uuid, $authCtx, $now, $reason) {
            $pdo->prepare("UPDATE contributions SET status='rejected', reviewer_uuid=?, reviewed_at=?, reject_reason=? WHERE uuid=?")
                ->execute([$authCtx['contributor_uuid'], $now, $reason, $uuid]);
            $pdo->prepare(
                "INSERT INTO contribution_audit (contribution_uuid, from_status, to_status, actor_uuid, at, note)
                 VALUES (?, 'submitted', 'rejected', ?, ?, ?)"
            )->execute([$uuid, $authCtx['contributor_uuid'], $now, $reason]);
        });
        Json::ok(200, ['uuid' => $uuid, 'status' => 'rejected']);
    }

    /** POST /v1/admin/contributors/{uuid}/block. */
    public static function adminBlock(array $authCtx, string $uuid): void
    {
        Auth::requireScope($authCtx, Auth::SCOPE_MODERATE);
        $body = Json::readBody();
        $reason = Json::str($body, 'reason');
        if ($reason === '') {
            Json::err(400, 'missing_reason', 'reason is required');
            return;
        }
        $pdo = Db::pdo();
        $stmt = $pdo->prepare("SELECT uuid FROM contributors WHERE uuid=?");
        $stmt->execute([$uuid]);
        if (!$stmt->fetch()) {
            Json::err(404, 'not_found', 'contributor not found: ' . $uuid);
            return;
        }
        $pdo->prepare("UPDATE contributors SET blocked=1, blocked_reason=? WHERE uuid=?")
            ->execute([$reason, $uuid]);
        Json::ok(200, ['uuid' => $uuid, 'blocked' => true]);
    }

    /**
     * Apply a single field patch — matches what the Go reference does on accept.
     */
    private static function applyPatch(\PDO $pdo, string $type, string $tuuid, string $field, ?string $value, ?string $valueFrom, string $contributorUuid, string $now): void
    {
        if ($type === 'entity_color') {
            $parts = explode(':', $tuuid, 2);
            if (count($parts) !== 2) {
                throw new \RuntimeException('entity_color target_uuid must be scope_type:scope_uuid: ' . $tuuid);
            }
            if ($value === null || $value === '') {
                $pdo->prepare("DELETE FROM entity_color WHERE scope_type=? AND scope_uuid=?")
                    ->execute($parts);
                return;
            }
            $pdo->prepare(
                "INSERT INTO entity_color (scope_type, scope_uuid, color_id) VALUES (?, ?, ?)
                 ON CONFLICT(scope_type, scope_uuid) DO UPDATE SET color_id=excluded.color_id"
            )->execute([$parts[0], $parts[1], (int) $value]);
            return;
        }
        // Pseudo-fields: keyword/codename → *_aliases insert; photo_url → *_photos insert/update.
        if (Allowlist::isPseudo($type, $field)) {
            self::applyPseudoPatch($pdo, $type, $tuuid, $field, $value, $valueFrom, $contributorUuid, $now);
            return;
        }
        $table = Allowlist::tableFor($type);
        if ($table === null) {
            throw new \RuntimeException('unhandled target_type: ' . $type);
        }
        // Build UPDATE with whitelisted field name.
        $pdo->prepare("UPDATE \"$table\" SET $field=? WHERE uuid=?")
            ->execute([$value, $tuuid]);
    }

    /**
     * Pseudo-field patches: keyword/codename insert into *_aliases with the
     * matching kind; photo_url inserts into *_photos. `valueFrom` semantics:
     *   - empty   → INSERT new row (no prior value).
     *   - filled  → REPLACE the row matching that prior value.
     *
     * For aliases the match is by (alias=valueFrom, kind). For photos the
     * match is by photo uuid OR by URL.
     */
    private static function applyPseudoPatch(\PDO $pdo, string $type, string $tuuid, string $field, ?string $value, ?string $valueFrom, string $contributorUuid, string $now): void
    {
        $kind = Allowlist::pseudoKind($field);
        if ($value === null || $value === '') {
            throw new \RuntimeException("$field requires a non-empty value");
        }

        if ($kind === 'alias:keyword' || $kind === 'alias:codename') {
            $aliasKind = $kind === 'alias:keyword' ? 'keyword' : 'codename';
            $aliasTable = $type === 'board' ? 'board_aliases' : 'model_aliases';
            $parentCol  = $type === 'board' ? 'board_uuid'    : 'model_uuid';

            // REPLACE semantics: if valueFrom is set, find that alias row of
            // matching kind on the parent and rewrite it.
            if ($valueFrom !== null && $valueFrom !== '') {
                $sel = $pdo->prepare("SELECT uuid FROM $aliasTable WHERE $parentCol=? AND kind=? AND alias=? LIMIT 1");
                $sel->execute([$tuuid, $aliasKind, $valueFrom]);
                $row = $sel->fetch();
                if ($row) {
                    $pdo->prepare("UPDATE $aliasTable SET alias=? WHERE uuid=?")
                        ->execute([$value, $row['uuid']]);
                    return;
                }
                // No prior row matched — fall through to insert as a fresh alias.
            }
            // INSERT new alias. UNIQUE(alias, alias_type) means duplicates
            // raise; that surfaces as a 500 to the moderator, which is fine
            // for a prototype — the alternative (silent INSERT OR IGNORE)
            // would mask data-quality issues.
            $pdo->prepare(
                "INSERT INTO $aliasTable (uuid, $parentCol, alias, alias_type, kind) VALUES (?, ?, ?, ?, ?)"
            )->execute([Uuid::v4(), $tuuid, $value, null, $aliasKind]);
            return;
        }

        if ($kind === 'photo') {
            $photoTable = $type === 'board' ? 'board_photos' : 'model_photos';
            $parentCol  = $type === 'board' ? 'board_uuid'   : 'model_uuid';
            // valueFrom carries the photo UUID OR URL to replace.
            if ($valueFrom !== null && $valueFrom !== '') {
                $sel = $pdo->prepare("SELECT uuid FROM $photoTable WHERE $parentCol=? AND (uuid=? OR photo_url=?) LIMIT 1");
                $sel->execute([$tuuid, $valueFrom, $valueFrom]);
                $row = $sel->fetch();
                if ($row) {
                    $pdo->prepare("UPDATE $photoTable SET photo_url=?, contributor_uuid=?, accepted_at=? WHERE uuid=?")
                        ->execute([$value, $contributorUuid, $now, $row['uuid']]);
                    return;
                }
            }
            $pdo->prepare(
                "INSERT INTO $photoTable (uuid, $parentCol, photo_url, caption, contributor_uuid, accepted_at)
                 VALUES (?, ?, ?, NULL, ?, ?)"
            )->execute([Uuid::v4(), $tuuid, $value, $contributorUuid, $now]);
            return;
        }

        throw new \RuntimeException("unhandled pseudo-kind: $kind");
    }

    private static function currentValue(\PDO $pdo, string $type, string $tuuid, string $field)
    {
        if ($type === 'entity_color') {
            $parts = explode(':', $tuuid, 2);
            if (count($parts) !== 2) return null;
            $stmt = $pdo->prepare("SELECT color_id FROM entity_color WHERE scope_type=? AND scope_uuid=?");
            $stmt->execute($parts);
            $r = $stmt->fetch();
            return $r['color_id'] ?? null;
        }
        // Pseudo-fields don't have a single "current value" on the parent
        // row — they're multi-valued lists. Skip the optimistic-concurrency
        // check by returning null; the original valueFrom is still threaded
        // through to applyPseudoPatch so REPLACE-by-prior-value still works.
        if (Allowlist::isPseudo($type, $field)) {
            return null;
        }
        $table = Allowlist::tableFor($type);
        if ($table === null) return null;
        $stmt = $pdo->prepare("SELECT $field FROM \"$table\" WHERE uuid=?");
        $stmt->execute([$tuuid]);
        $r = $stmt->fetch();
        return $r[$field] ?? null;
    }

    /** Project DB rows to wire shape (booleans for evidence_in_hand). */
    private static function projectRows(array $rows): array
    {
        foreach ($rows as &$r) {
            if (isset($r['evidence_in_hand'])) {
                $r['evidence_in_hand'] = ((int) $r['evidence_in_hand']) === 1;
            }
        }
        unset($r);
        return $rows;
    }
}
