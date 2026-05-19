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

        // Attach aliases + keywords + photos for board / model. Backwards
        // compat: `aliases` stays a flat list of names (kind='name'). New
        // arrays `aliases_typed`, `keywords`, `photos` are added beside it.
        if ($type === 'board' || $type === 'model') {
            $aliasTable = $type === 'board' ? 'board_aliases' : 'model_aliases';
            $photoTable = $type === 'board' ? 'board_photos'  : 'model_photos';
            $parentCol  = $type === 'board' ? 'board_uuid'    : 'model_uuid';

            $aStmt = $pdo->prepare("SELECT alias, COALESCE(alias_type,'') AS alias_type, kind FROM $aliasTable WHERE $parentCol=? ORDER BY alias");
            $aStmt->execute([$uuid]);
            $names = [];
            $typed = [];
            $keywords = [];
            $codenames = [];
            foreach ($aStmt->fetchAll() as $a) {
                $kind = (string) ($a['kind'] ?? 'name');
                $typed[] = [
                    'alias'      => (string) $a['alias'],
                    'kind'       => $kind,
                    'alias_type' => (string) ($a['alias_type'] ?? ''),
                ];
                if ($kind === 'keyword')      $keywords[]  = (string) $a['alias'];
                elseif ($kind === 'codename') $codenames[] = (string) $a['alias'];
                else                          $names[]     = (string) $a['alias'];
            }
            $row['aliases']       = $names;       // backwards-compat flat names list
            $row['aliases_typed'] = $typed;
            $row['keywords']      = $keywords;
            $row['codenames']     = $codenames;

            $pStmt = $pdo->prepare("SELECT uuid, photo_url, COALESCE(caption,'') AS caption, accepted_at FROM $photoTable WHERE $parentCol=? ORDER BY accepted_at");
            $pStmt->execute([$uuid]);
            $photos = [];
            foreach ($pStmt->fetchAll() as $p) {
                $photos[] = [
                    'uuid'        => (string) $p['uuid'],
                    'url'         => (string) $p['photo_url'],
                    'caption'     => (string) $p['caption'],
                    'accepted_at' => (string) $p['accepted_at'],
                ];
            }
            $row['photos'] = $photos;
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
        // 1) Exact board_number — keeps the existing wire contract.
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

        // 2) Board aliases (any kind — name/keyword/codename).
        $aliasSql = "SELECT b.uuid AS board_uuid, b.board_number, COALESCE(b.board_name,'') AS board_name,
                            br.name AS brand, f.name AS family,
                            COALESCE(m.display_name,'') AS model,
                            m.model_number AS model_number,
                            COALESCE(b.source,'') AS source,
                            ba.kind AS matched_via
                     FROM board_aliases ba
                     JOIN boards b ON b.uuid = ba.board_uuid
                     JOIN models m ON b.model_uuid = m.uuid
                     JOIN families f ON m.family_uuid = f.uuid
                     JOIN brands br ON f.brand_uuid = br.uuid
                     WHERE ba.alias = ?
                     LIMIT 1";
        $st2 = $pdo->prepare($aliasSql);
        $st2->execute([$q]);
        $r2 = $st2->fetch();
        if ($r2) {
            Json::ok(200, ['query' => $q, 'match' => $r2]);
            return;
        }

        Json::ok(200, ['query' => $q]);
    }
}
