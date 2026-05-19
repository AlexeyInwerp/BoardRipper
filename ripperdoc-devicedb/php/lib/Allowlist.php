<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Per-target writable field allowlist — hard-coded per spec §9 #8.
 * Recovered from the Go reference's openapi.json `FieldAllowlist.example`.
 */
final class Allowlist
{
    /** @var array<string, string[]> */
    private const FIELDS = [
        'brand'        => ['notes'],
        'family'       => ['name', 'notes'],
        // Pseudo-fields (keyword/codename/photo_url) are NOT UPDATE targets
        // on the parent table; on accept they INSERT into the relevant
        // *_aliases / *_photos table. See Contribs::applyPatch.
        'model'        => ['display_name', 'notes', 'keyword', 'codename', 'photo_url'],
        'board'        => ['board_name', 'odm', 'source', 'source_url', 'notes', 'keyword', 'codename', 'photo_url'],
        'entity_color' => ['color_id'],
        // board_alias / model_alias have no writable fields in Phase 2 — they
        // are created/removed as whole rows by reviewer accept, not edited.
        'board_alias'  => [],
        'model_alias'  => [],
    ];

    /**
     * Pseudo-fields that do not UPDATE a column on the parent table on accept.
     * Instead they INSERT into a child table. Drives Contribs::applyPatch and
     * Contribs::currentValue branching.
     *
     * @var array<string,string>  field → child kind ('alias:kind' or 'photo')
     */
    private const PSEUDO_FIELDS = [
        'keyword'   => 'alias:keyword',
        'codename'  => 'alias:codename',
        'photo_url' => 'photo',
    ];

    public static function isPseudo(string $type, string $field): bool
    {
        if (!self::isWritable($type, $field)) return false;
        if ($type !== 'board' && $type !== 'model') return false;
        return array_key_exists($field, self::PSEUDO_FIELDS);
    }

    /** Returns 'alias:keyword' | 'alias:codename' | 'photo' | null. */
    public static function pseudoKind(string $field): ?string
    {
        return self::PSEUDO_FIELDS[$field] ?? null;
    }

    public static function isWritable(string $type, string $field): bool
    {
        return isset(self::FIELDS[$type]) && in_array($field, self::FIELDS[$type], true);
    }

    public static function knownType(string $type): bool
    {
        return array_key_exists($type, self::FIELDS);
    }

    /** Map target_type to the actual canonical SQL table that holds it. */
    public static function tableFor(string $type): ?string
    {
        return [
            'brand'        => 'brands',
            'family'       => 'families',
            'model'        => 'models',
            'board'        => 'boards',
            'board_alias'  => 'board_aliases',
            'model_alias'  => 'model_aliases',
            'entity_color' => 'entity_color',
        ][$type] ?? null;
    }

    /** @return array<string, string[]> */
    public static function all(): array
    {
        return self::FIELDS;
    }
}
