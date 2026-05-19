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
        'model'        => ['display_name', 'notes'],
        'board'        => ['board_name', 'odm', 'source', 'source_url', 'notes'],
        'entity_color' => ['color_id'],
        // board_alias / model_alias have no writable fields in Phase 2 — they
        // are created/removed as whole rows by reviewer accept, not edited.
        'board_alias'  => [],
        'model_alias'  => [],
    ];

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
