<?php
require_once __DIR__ . '/../middleware/env.php';

function api_turnstile_config(): array
{
    return [
        'site_key' => trim(api_env('TURNSTILE_SITE_KEY')),
        'secret' => trim(api_env('TURNSTILE_SECRET_KEY')),
        'hostnames' => array_values(array_filter(array_map(
            static fn($host) => strtolower(trim($host)), explode(',', api_env('TURNSTILE_HOSTNAMES'))
        ))),
    ];
}

/** Public configuration only; never expose the verification secret. */
function api_turnstile_public_config(): array
{
    $config = api_turnstile_config();
    return ['provider' => 'turnstile', 'site_key' => $config['site_key']];
}

function api_turnstile_response_valid(array $response, string $action, array $hostnames): bool
{
    return ($response['success'] ?? false) === true
        && ($response['action'] ?? null) === $action
        && is_string($response['hostname'] ?? null)
        && in_array(strtolower($response['hostname']), $hostnames, true);
}

function api_turnstile_result_status($body, int $status, string $action, array $hostnames): int
{
    if (!is_string($body) || $status !== 200) return 503;
    $response = json_decode($body, true);
    if (!is_array($response) || !array_key_exists('success', $response)) return 503;
    $errors = $response['error-codes'] ?? [];
    if (!is_array($errors)) return 503;
    if (!empty(array_intersect($errors, ['internal-error', 'invalid-input-secret', 'missing-input-secret']))) return 503;
    return api_turnstile_response_valid($response, $action, $hostnames) ? 200 : 422;
}

function api_turnstile_token_valid($token): bool
{
    return is_string($token) && trim($token) !== '' && strlen($token) <= 2048;
}

/** Shared storage closes Siteverify's short token-reuse convergence window. */
function api_turnstile_claim(string $token, ?string $path = null): bool
{
    $directory = dirname(__DIR__, 2) . '/storage/security';
    if ($path === null && !is_dir($directory) && !@mkdir($directory, 0750, true) && !is_dir($directory)) {
        throw new RuntimeException('CAPTCHA storage unavailable');
    }
    $handle = @fopen($path ?? $directory . '/turnstile-used.json', 'c+b');
    if (!$handle) throw new RuntimeException('CAPTCHA storage unavailable');
    try {
        if (!flock($handle, LOCK_EX)) throw new RuntimeException('CAPTCHA storage unavailable');
        $raw = stream_get_contents($handle);
        $used = $raw === '' ? [] : json_decode($raw, true);
        if (!is_array($used)) throw new RuntimeException('CAPTCHA storage invalid');
        $used = array_filter($used, static fn($expires) => (int)$expires > time());
        $hash = hash('sha256', $token);
        if (isset($used[$hash])) return false;
        if (count($used) >= 50000) throw new RuntimeException('CAPTCHA storage full');
        $used[$hash] = time() + 600;
        $encoded = json_encode($used, JSON_THROW_ON_ERROR);
        rewind($handle);
        if (!ftruncate($handle, 0) || fwrite($handle, $encoded) !== strlen($encoded) || !fflush($handle)) {
            throw new RuntimeException('CAPTCHA storage unavailable');
        }
        return true;
    } finally {
        flock($handle, LOCK_UN);
        fclose($handle);
    }
}

/** Returns an HTTP status; callers must reject anything other than 200. */
function api_turnstile_verify($token, string $action): int
{
    $config = api_turnstile_config();
    if ($config['site_key'] === '' || $config['secret'] === '' || !$config['hostnames'] || !function_exists('curl_init')) return 503;
    if (!api_turnstile_token_valid($token)) return 422;
    $ch = curl_init('https://challenges.cloudflare.com/turnstile/v0/siteverify');
    curl_setopt_array($ch, [
        CURLOPT_POST => true, CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POSTFIELDS => http_build_query(['secret' => $config['secret'], 'response' => $token]),
        CURLOPT_HTTPHEADER => ['Content-Type: application/x-www-form-urlencoded'],
        CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 8,
        CURLOPT_PROTOCOLS => CURLPROTO_HTTPS, CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_SSL_VERIFYPEER => true, CURLOPT_SSL_VERIFYHOST => 2,
    ]);
    $body = curl_exec($ch);
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
    $verification = api_turnstile_result_status($body, $status, $action, $config['hostnames']);
    if ($verification !== 200) return $verification;
    try { return api_turnstile_claim($token) ? 200 : 422; }
    catch (Throwable $error) { return 503; }
}

function api_require_turnstile(array $payload, string $action, ?callable $onFailure = null): void
{
    $status = api_turnstile_verify($payload['captcha_token'] ?? null, $action);
    if ($status !== 200) {
        if ($onFailure !== null) $onFailure();
        api_json_response($status, ['message' => $status === 503
            ? 'CAPTCHA verification is unavailable. An administrator must check Turnstile configuration and HTTPS access.'
            : 'Complete the CAPTCHA again. The verification may be missing, expired, or already used.']);
    }
}
