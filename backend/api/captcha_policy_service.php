<?php

const API_LOGIN_CAPTCHA_DEFAULT_ENABLED = false;

function api_login_captcha_storage_dir(): string
{
    return dirname(__DIR__) . '/storage/security';
}

function api_login_captcha_policy_path(): string
{
    return api_login_captcha_storage_dir() . '/login_captcha_policy.json';
}

function api_login_captcha_ensure_storage_dir(): void
{
    $directory = api_login_captcha_storage_dir();
    if (!is_dir($directory)) {
        @mkdir($directory, 0750, true);
    }
}

function api_login_captcha_write_json(string $path, array $payload): void
{
    api_login_captcha_ensure_storage_dir();

    $handle = @fopen($path, 'c+b');
    if (!$handle) {
        throw new RuntimeException('CAPTCHA policy storage is not writable.');
    }

    try {
        if (!@flock($handle, LOCK_EX)) {
            throw new RuntimeException('CAPTCHA policy storage is locked.');
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

function api_login_captcha_default_policy(): array
{
    return [
        'enabled' => API_LOGIN_CAPTCHA_DEFAULT_ENABLED,
        'updated_at' => null,
        'updated_by' => null,
    ];
}

function api_login_captcha_normalize_policy(array $raw): array
{
    $default = api_login_captcha_default_policy();
    $enabledValue = $raw['enabled']
        ?? $raw['login_captcha_enabled']
        ?? $raw['loginCaptchaEnabled']
        ?? $raw['captcha_enabled']
        ?? $default['enabled'];

    return [
        'enabled' => api_parse_bool($enabledValue, (bool)$default['enabled']),
        'updated_at' => $raw['updated_at'] ?? null,
        'updated_by' => isset($raw['updated_by']) ? (int)$raw['updated_by'] : null,
    ];
}

function api_login_captcha_get_policy(): array
{
    return api_login_captcha_normalize_policy(
        api_read_json_file(
            api_login_captcha_policy_path(),
            api_login_captcha_default_policy()
        )
    );
}

function api_login_captcha_format_datetime(DateTimeInterface $dateTime): string
{
    return $dateTime->format('Y-m-d H:i:s');
}

function api_login_captcha_save_policy(array $payload, ?array $actor = null): array
{
    $current = api_login_captcha_get_policy();
    $enabledValue = $payload['enabled']
        ?? $payload['login_captcha_enabled']
        ?? $payload['loginCaptchaEnabled']
        ?? $payload['captcha_enabled']
        ?? $current['enabled'];

    $policy = [
        'enabled' => api_parse_bool($enabledValue, (bool)$current['enabled']),
        'updated_at' => api_login_captcha_format_datetime(new DateTimeImmutable('now')),
        'updated_by' => isset($actor['user_id']) ? (int)$actor['user_id'] : null,
    ];

    api_login_captcha_write_json(api_login_captcha_policy_path(), $policy);

    return $policy;
}
