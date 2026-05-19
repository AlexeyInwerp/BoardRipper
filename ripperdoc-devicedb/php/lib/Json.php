<?php
declare(strict_types=1);

namespace DeviceDB;

/**
 * Wire-shape helpers for JSON responses and structured errors.
 *
 * The Go reference returns:
 *   { "error": "<code>", "message": "<text>", "details": { ... } }
 * The X-BoardRipper-Error-Code header mirrors `error`. We follow the same
 * convention so existing clients don't see drift.
 */
final class Json
{
    public static function ok(int $status, $payload): void
    {
        if (function_exists('http_response_code')) {
            http_response_code($status);
        }
        if (!headers_sent()) {
            header('Content-Type: application/json');
            header('Access-Control-Allow-Origin: *');
            header('Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS');
            header('Access-Control-Allow-Headers: Content-Type, Authorization, X-BoardRipper-Install-Token');
        }
        // JSON_UNESCAPED_SLASHES matches Go's encoding/json default closer
        // than the PHP default, which escapes /.
        echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    }

    public static function err(int $status, string $code, string $message, array $details = []): void
    {
        if (!headers_sent()) {
            header('X-BoardRipper-Error-Code: ' . $code);
        }
        $body = ['error' => $code, 'message' => $message];
        if (!empty($details)) {
            $body['details'] = $details;
        }
        self::ok($status, $body);
    }

    /**
     * Decode a request body or fail with HTTP 400 bad_json.
     * Mirrors the Go server's exact error message format on bad JSON.
     */
    public static function readBody(): array
    {
        $raw = file_get_contents('php://input') ?: '';
        if ($raw === '') {
            return [];
        }
        $v = json_decode($raw, true);
        if ($v === null && json_last_error() !== JSON_ERROR_NONE) {
            self::err(400, 'bad_json', json_last_error_msg());
            exit;
        }
        if (!is_array($v)) {
            self::err(400, 'bad_json', 'expected JSON object');
            exit;
        }
        return $v;
    }

    /** Extract string field or empty. */
    public static function str(array $body, string $key): string
    {
        return isset($body[$key]) && is_string($body[$key]) ? $body[$key] : '';
    }
}
