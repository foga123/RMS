<?php
/**
 * How long a signed-in browser may sit idle before it is signed out.
 *
 * This number used to live only in localStorage. An admin typing "10" into
 * Settings wrote it to the admin's own browser and nowhere else, so every other
 * account fell through to the built-in default and the setting appeared to do
 * nothing for anyone but the person who set it. A timeout is one institutional
 * policy, not one preference per browser, so it belongs on the server — the
 * same reason the CAPTCHA switch and the password-expiration policy are here.
 *
 * Stored as JSON beside those two rather than in a table: it is a single scalar
 * with no history to keep, and this is the shape the neighbouring policies
 * already use. The read/write pair is duplicated from them for the same reason
 * they duplicate it from each other — each service owns its own file, and a
 * shared helper would couple four unrelated policies through one include.
 */

const API_SESSION_TIMEOUT_DEFAULT_MINUTES = 30;
const API_SESSION_TIMEOUT_MIN_MINUTES = 1;
const API_SESSION_TIMEOUT_MAX_MINUTES = 1440;

function api_session_policy_storage_dir(): string
{
    return dirname(__DIR__) . '/storage/security';
}

function api_session_policy_path(): string
{
    return api_session_policy_storage_dir() . '/session_policy.json';
}

function api_session_policy_ensure_storage_dir(): void
{
    $directory = api_session_policy_storage_dir();
    if (!is_dir($directory)) {
        @mkdir($directory, 0750, true);
    }
}

function api_session_policy_write_json(string $path, array $payload): void
{
    api_session_policy_ensure_storage_dir();

    $handle = @fopen($path, 'c+b');
    if (!$handle) {
        throw new RuntimeException('Session policy storage is not writable.');
    }

    try {
        if (!@flock($handle, LOCK_EX)) {
            throw new RuntimeException('Session policy storage is locked.');
        }
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        fflush($handle);
        @flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }
}

/**
 * Minutes, bounded.
 *
 * The same 1..1440 range the Settings form offers, enforced here as well so a
 * hand-edited file or a direct PUT cannot produce a timeout of zero — which
 * would sign every user out on their first tick — or one so long it is the same
 * as having none.
 */
function api_session_policy_clamp_minutes($value, int $fallback = API_SESSION_TIMEOUT_DEFAULT_MINUTES): int
{
    if ($value === null || $value === '' || !is_numeric($value)) {
        return $fallback;
    }

    $minutes = (int)round((float)$value);
    if ($minutes <= 0) {
        return $fallback;
    }

    return min(API_SESSION_TIMEOUT_MAX_MINUTES, max(API_SESSION_TIMEOUT_MIN_MINUTES, $minutes));
}

function api_session_policy_default_policy(): array
{
    return [
        'timeout_minutes' => API_SESSION_TIMEOUT_DEFAULT_MINUTES,
        'updated_at' => null,
        'updated_by' => null,
    ];
}

function api_session_policy_normalize_policy(array $raw): array
{
    $default = api_session_policy_default_policy();
    $minutesValue = $raw['timeout_minutes']
        ?? $raw['session_timeout_minutes']
        ?? $raw['sessionTimeoutMinutes']
        ?? $default['timeout_minutes'];

    return [
        'timeout_minutes' => api_session_policy_clamp_minutes($minutesValue, (int)$default['timeout_minutes']),
        'updated_at' => $raw['updated_at'] ?? null,
        'updated_by' => isset($raw['updated_by']) ? (int)$raw['updated_by'] : null,
    ];
}

function api_session_policy_get_policy(): array
{
    return api_session_policy_normalize_policy(
        api_read_json_file(
            api_session_policy_path(),
            api_session_policy_default_policy()
        )
    );
}

/** Just the number, for the auth payloads that carry it to every browser. */
function api_session_policy_timeout_minutes(): int
{
    return (int)api_session_policy_get_policy()['timeout_minutes'];
}

function api_session_policy_save_policy(array $payload, ?array $actor = null): array
{
    $current = api_session_policy_get_policy();
    $minutesValue = $payload['timeout_minutes']
        ?? $payload['session_timeout_minutes']
        ?? $payload['sessionTimeoutMinutes']
        ?? $current['timeout_minutes'];

    $policy = [
        'timeout_minutes' => api_session_policy_clamp_minutes($minutesValue, (int)$current['timeout_minutes']),
        'updated_at' => (new DateTimeImmutable('now'))->format('Y-m-d H:i:s'),
        'updated_by' => isset($actor['user_id']) ? (int)$actor['user_id'] : null,
    ];

    api_session_policy_write_json(api_session_policy_path(), $policy);

    return $policy;
}
