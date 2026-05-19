<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Read endpoints — full hierarchy tree, single-entity lookup, resolve, and
 * per-entity contribution history.
 */
final class Entities
{
    public const TYPES = ['brand', 'family', 'model', 'board'];

    /**
     * GET /v1/entities — Brand→Family→Model→Board tree.
     * Returns {"brands": [...]} matching the Go reference (`brands: null` when empty).
     */
    public static function tree(): void
    {
        $pdo = Db::pdo();

        $brands = $pdo->query("SELECT uuid, name, COALESCE(notes,'') AS notes FROM brands ORDER BY name")->fetchAll();
        if (empty($brands)) {
            // Match Go's JSON output for an empty DB.
            Json::ok(200, ['brands' => null]);
            return;
        }

        $families = $pdo->query("SELECT uuid, brand_uuid, name, COALESCE(notes,'') AS notes FROM families ORDER BY name")->fetchAll();
        $models   = $pdo->query("SELECT uuid, family_uuid, model_number, COALESCE(display_name,'') AS display_name, COALESCE(notes,'') AS notes FROM models ORDER BY model_number")->fetchAll();
        $boards   = $pdo->query(
            "SELECT uuid, model_uuid, board_number, COALESCE(board_name,'') AS board_name,
                    COALESCE(odm,'') AS odm, COALESCE(board_number_type,'') AS board_number_type,
                    COALESCE(source,'') AS source, COALESCE(source_url,'') AS source_url,
                    COALESCE(notes,'') AS notes
             FROM boards ORDER BY board_number"
        )->fetchAll();

        // Index for tree build.
        $boardsByModel  = [];
        foreach ($boards as $b)  { $boardsByModel[$b['model_uuid']][]    = $b; }
        $modelsByFamily = [];
        foreach ($models as $m) {
            $m['boards'] = $boardsByModel[$m['uuid']] ?? [];
            $modelsByFamily[$m['family_uuid']][] = $m;
        }
        $familiesByBrand = [];
        foreach ($families as $f) {
            $f['models'] = $modelsByFamily[$f['uuid']] ?? [];
            $familiesByBrand[$f['brand_uuid']][] = $f;
        }
        foreach ($brands as &$br) {
            $br['families'] = $familiesByBrand[$br['uuid']] ?? [];
        }
        unset($br);

        Json::ok(200, ['brands' => $brands]);
    }

    /** GET /v1/entities/{type}/{uuid}. */
    public static function single(string $type, string $uuid): void
    {
        if (!in_array($type, self::TYPES, true)) {
            Json::err(400, 'bad_type', 'unknown entity type: ' . $type);
            return;
        }
        $pdo = Db::pdo();

        $sql = [
            'brand'  => "SELECT uuid, name, COALESCE(notes,'') AS notes FROM brands WHERE uuid=?",
            'family' => "SELECT uuid, brand_uuid, name, COALESCE(notes,'') AS notes FROM families WHERE uuid=?",
            'model'  => "SELECT uuid, family_uuid, model_number, COALESCE(display_name,'') AS display_name, COALESCE(notes,'') AS notes FROM models WHERE uuid=?",
            'board'  => "SELECT uuid, model_uuid, board_number, COALESCE(board_name,'') AS board_name,
                              COALESCE(odm,'') AS odm, COALESCE(board_number_type,'') AS board_number_type,
                              COALESCE(source,'') AS source, COALESCE(source_url,'') AS source_url,
                              COALESCE(notes,'') AS notes
                          FROM boards WHERE uuid=?",
        ][$type];

        $stmt = $pdo->prepare($sql);
        $stmt->execute([$uuid]);
        $row = $stmt->fetch();
        if (!$row) {
            Json::err(404, 'not_found', '');
            return;
        }
        Json::ok(200, $row);
    }

    /**
     * GET /v1/entities/{type}/{uuid}/contributions — public edit history.
     * Defaults to status=accepted, can be overridden with ?status=...
     */
    public static function history(string $type, string $uuid): void
    {
        if (!Allowlist::knownType($type)) {
            Json::err(400, 'bad_type', 'unknown entity type: ' . $type);
            return;
        }
        $status = isset($_GET['status']) && is_string($_GET['status']) ? $_GET['status'] : 'accepted';
        $allowed = ['submitted', 'accepted', 'rejected', 'withdrawn', 'superseded'];
        if (!in_array($status, $allowed, true)) {
            Json::err(400, 'bad_status', 'invalid status filter');
            return;
        }
        $pdo  = Db::pdo();
        $stmt = $pdo->prepare(
            "SELECT uuid, target_type, target_uuid, target_field, value_to, value_from,
                    confidence, status, contributor_uuid, submitted_at, reviewed_at
             FROM contributions
             WHERE target_type=? AND target_uuid=? AND status=?
             ORDER BY submitted_at DESC"
        );
        $stmt->execute([$type, $uuid, $status]);
        $rows = $stmt->fetchAll();
        Json::ok(200, ['contributions' => $rows ?: null]);
    }

    /** GET /v1/resolve?q=<board-number-ish>. */
    public static function resolve(): void
    {
        $q = isset($_GET['q']) ? trim((string) $_GET['q']) : '';
        if ($q === '') {
            Json::err(400, 'missing_q', 'missing q parameter');
            return;
        }
        $pdo = Db::pdo();
        // Match the Go reference: exact-board-number first (returns `match`),
        // otherwise `{query: q}` with no match.
        $sql = "SELECT b.uuid AS board_uuid, b.board_number, COALESCE(b.board_name,'') AS board_name,
                       br.name AS brand, f.name AS family,
                       COALESCE(m.display_name,'') AS model,
                       m.model_number AS model_number,
                       COALESCE(b.source,'') AS source
                FROM boards b
                JOIN models m ON b.model_uuid = m.uuid
                JOIN families f ON m.family_uuid = f.uuid
                JOIN brands br ON f.brand_uuid = br.uuid
                WHERE b.board_number = ?
                LIMIT 1";
        $stmt = $pdo->prepare($sql);
        $stmt->execute([$q]);
        $row = $stmt->fetch();
        if ($row) {
            Json::ok(200, ['query' => $q, 'match' => $row]);
            return;
        }
        Json::ok(200, ['query' => $q]);
    }
}
