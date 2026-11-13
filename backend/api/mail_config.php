<?php

function api_mail_env_file_candidates(): array
{
    return [
        dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env.local',
        dirname(__DIR__) . DIRECTORY_SEPARATOR . '.env',
        dirname(dirname(__DIR__)) . DIRECTORY_SEPARATOR . '.env.local',
        dirname(dirname(__DIR__)) . DIRECTORY_SEPARATOR . '.env',
        dirname(dirname(dirname(__DIR__))) . DIRECTORY_SEPARATOR . '.env.local',
        dirname(dirname(dirname(__DIR__))) . DIRECTORY_SEPARATOR . '.env',
    ];
}

function api_mail_parse_env_file(string $path): array
{
    if (!is_file($path) || !is_readable($path)) {
        return [];
    }

    $values = [];
    $lines = @file($path, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
    if (!is_array($lines)) {
        return [];
    }

    foreach ($lines as $line) {
        $trimmed = trim($line);
        if ($trimmed === '' || strpos($trimmed, '#') === 0) {
            continue;
        }

        if (stripos($trimmed, 'export ') === 0) {
            $trimmed = trim(substr($trimmed, 7));
        }

        $separatorPos = strpos($trimmed, '=');
        if ($separatorPos === false) {
            continue;
        }

        $key = trim(substr($trimmed, 0, $separatorPos));
        $value = trim(substr($trimmed, $separatorPos + 1));
        if ($key === '') {
            continue;
        }

        if (strlen($value) >= 2) {
            $quote = $value[0];
            $last = substr($value, -1);
            if (($quote === '"' && $last === '"') || ($quote === "'" && $last === "'")) {
                $value = substr($value, 1, -1);
            }
        }

        $values[$key] = $value;
    }

    return $values;
}

function api_mail_env_values(): array
{
    static $values = null;

    if ($values !== null) {
        return $values;
    }

    $values = [];
    foreach (api_mail_env_file_candidates() as $path) {
        $values = array_merge($values, api_mail_parse_env_file($path));
    }

    return $values;
}

function api_mail_env(string $key, ?string $default = null): ?string
{
    $sources = [
        getenv($key),
        $_ENV[$key] ?? null,
        $_SERVER[$key] ?? null,
        api_mail_env_values()[$key] ?? null,
    ];

    foreach ($sources as $value) {
        if ($value === false || $value === null) {
            continue;
        }

        $text = trim((string)$value);
        if ($text !== '') {
            return $text;
        }
    }

    return $default;
}

function api_mail_parse_bool($value): bool
{
    if (is_bool($value)) {
        return $value;
    }

    $text = strtolower(trim((string)$value));
    return in_array($text, ['1', 'true', 'yes', 'on'], true);
}

function api_mail_normalize_encryption(?string $value, int $port): string
{
    $text = strtolower(trim((string)$value));
    if ($text === '' || $text === 'auto') {
        if ($port === 465) {
            return 'ssl';
        }
        if ($port === 587) {
            return 'tls';
        }
        return '';
    }

    if ($text === 'starttls') {
        return 'tls';
    }

    if (in_array($text, ['tls', 'ssl'], true)) {
        return $text;
    }

    if (in_array($text, ['smtps'], true)) {
        return 'ssl';
    }

    if (in_array($text, ['none', 'off', 'false', '0'], true)) {
        return '';
    }

    return $text;
}

/**
 * How mail leaves this server: 'smtp' (Gmail through PHPMailer) unless one of
 * the HTTPS routes is set up -
 *   'gmail_api'  any GMAIL_* variable is set: Gmail's own API, as the account
 *                the refresh token was issued for (tools/deploy/gmail-token.js);
 *   'brevo'      BREVO_API_KEY is set: Brevo's transactional API.
 *
 * Railway blocks outbound SMTP on its free and Hobby plans - every Gmail send
 * there would wait out the 20-second timeout and fail - and only allows email
 * over HTTPS. The Gmail API wins when both are set: it was chosen over Brevo
 * on 2026-10-08 because the mail then leaves from gmail.com itself. Any one
 * GMAIL_* variable selects it, so a half-finished setup is reported as such
 * (api_mail_config_errors()) instead of quietly going out some other way.
 * XAMPP sets none of them and keeps using SMTP.
 */
function api_mail_transport(): string
{
    if (api_mail_env('APPS_SCRIPT_URL', '') !== '' || api_mail_env('APPS_SCRIPT_SECRET', '') !== '') {
        return 'apps_script';
    }
    foreach (['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REFRESH_TOKEN'] as $key) {
        if (trim((string)(api_mail_env($key, '') ?? '')) !== '') {
            return 'gmail_api';
        }
    }

    return trim((string)(api_mail_env('BREVO_API_KEY', '') ?? '')) !== '' ? 'brevo' : 'smtp';
}

/**
 * True on a host that blocks outbound SMTP: Railway, unless SMTP_ALLOWED=1
 * says this plan lets it out (Railway Pro).
 *
 * There a Gmail send cannot connect and only waits out SMTP_TIMEOUT, 20
 * seconds - as long as the browser waits for any answer - so on 2026-10-08 a
 * password reset on the live site failed as "timeout of 20000ms exceeded"
 * instead of saying why. Treated as a configuration error, it is refused at
 * once with the reason (api_mail_configuration_error_message()). Railway names
 * itself in RAILWAY_PROJECT_ID and RAILWAY_ENVIRONMENT_NAME on every service.
 */
function api_mail_smtp_blocked(): bool
{
    $onRailway = api_mail_env('RAILWAY_PROJECT_ID', '') !== '' || api_mail_env('RAILWAY_ENVIRONMENT_NAME', '') !== '';
    return $onRailway && !api_mail_parse_bool(api_mail_env('SMTP_ALLOWED', '0'));
}

function api_mail_config(string $defaultFromName = 'Mailer'): array
{
    $port = (int)(api_mail_env('SMTP_PORT', '587') ?: 587);
    $username = api_mail_env('SMTP_USERNAME', '') ?: '';
    $debugEnabled = api_mail_parse_bool(api_mail_env('SMTP_DEBUG', '0'));
    $debugLevel = (int)(api_mail_env('SMTP_DEBUG_LEVEL', $debugEnabled ? '2' : '0') ?: 0);

    return [
        'host' => api_mail_env('SMTP_HOST', 'smtp.gmail.com') ?: 'smtp.gmail.com',
        'username' => $username,
        'password' => api_mail_env('SMTP_PASSWORD', '') ?: '',
        'port' => $port > 0 ? $port : 587,
        'encryption' => api_mail_normalize_encryption(api_mail_env('SMTP_ENCRYPTION', ''), $port > 0 ? $port : 587),
        'from_email' => api_mail_env('SMTP_FROM_EMAIL', $username) ?: $username,
        'from_name' => api_mail_env('SMTP_FROM_NAME', $defaultFromName) ?: $defaultFromName,
        'timeout' => max(5, (int)(api_mail_env('SMTP_TIMEOUT', '20') ?: 20)),
        'debug_enabled' => $debugEnabled,
        'debug_level' => $debugEnabled ? max(1, $debugLevel) : 0,
        'transport' => api_mail_transport(),
        'apps_script_url' => api_mail_env('APPS_SCRIPT_URL', '') ?: '',
        'apps_script_secret' => api_mail_env('APPS_SCRIPT_SECRET', '') ?: '',
        'brevo_api_key' => trim((string)(api_mail_env('BREVO_API_KEY', '') ?? '')),
        'gmail_client_id' => trim((string)(api_mail_env('GMAIL_CLIENT_ID', '') ?? '')),
        'gmail_client_secret' => trim((string)(api_mail_env('GMAIL_CLIENT_SECRET', '') ?? '')),
        'gmail_refresh_token' => trim((string)(api_mail_env('GMAIL_REFRESH_TOKEN', '') ?? '')),
    ];
}

function api_mail_config_errors(?array $config = null): array
{
    $config = $config ?? api_mail_config();
    $errors = [];

    if (($config['transport'] ?? '') === 'apps_script') {
        if (!preg_match('~^https://script\.google\.com/macros/s/[A-Za-z0-9_-]+/exec$~D', (string)($config['apps_script_url'] ?? ''))) {
            $errors[] = 'APPS_SCRIPT_URL must be a Google Apps Script deployment URL ending in /exec.';
        }
        if (trim((string)($config['apps_script_secret'] ?? '')) === '') {
            $errors[] = 'APPS_SCRIPT_SECRET is missing.';
        }
        if (!function_exists('curl_init')) {
            $errors[] = 'The PHP cURL extension is required.';
        }
        return $errors;
    }

    // Over the Gmail API the SMTP settings are not used either: the three
    // values gmail-token.js produces, plus the address the mail is from.
    if (($config['transport'] ?? 'smtp') === 'gmail_api') {
        foreach (['gmail_client_id' => 'GMAIL_CLIENT_ID', 'gmail_client_secret' => 'GMAIL_CLIENT_SECRET', 'gmail_refresh_token' => 'GMAIL_REFRESH_TOKEN'] as $field => $name) {
            if (trim((string)($config[$field] ?? '')) === '') {
                $errors[] = $name . ' is missing.';
            }
        }
        $fromEmail = trim((string)($config['from_email'] ?? ''));
        if ($fromEmail === '' || !filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
            $errors[] = 'SMTP_FROM_EMAIL must be the Gmail address the refresh token was issued for.';
        }
        return $errors;
    }

    // Over Brevo the SMTP settings are not used; the sender address is the one
    // thing that must be right, because Brevo refuses any it has not verified.
    if (($config['transport'] ?? 'smtp') === 'brevo') {
        $fromEmail = trim((string)($config['from_email'] ?? ''));
        if ($fromEmail === '' || !filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
            $errors[] = 'SMTP_FROM_EMAIL must be the sender address verified in Brevo.';
        }
        return $errors;
    }

    if (api_mail_smtp_blocked()) {
        $errors[] = 'This server blocks SMTP (Railway), so mail cannot go out through Gmail SMTP here. Set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN (or BREVO_API_KEY) to send it over HTTPS instead.';
    }

    $host = trim((string)($config['host'] ?? ''));
    if ($host === '') {
        $errors[] = 'SMTP_HOST is required.';
    } elseif (filter_var($host, FILTER_VALIDATE_EMAIL)) {
        $errors[] = 'SMTP_HOST must be an SMTP server hostname, not an email address.';
    }

    $port = (int)($config['port'] ?? 0);
    if ($port < 1 || $port > 65535) {
        $errors[] = 'SMTP_PORT must be a valid TCP port.';
    }

    $username = trim((string)($config['username'] ?? ''));
    if ($username === '') {
        $errors[] = 'SMTP_USERNAME is required.';
    }

    $password = trim((string)($config['password'] ?? ''));
    if ($password === '') {
        $errors[] = 'SMTP_PASSWORD is required.';
    }

    $encryption = strtolower(trim((string)($config['encryption'] ?? '')));
    if (!in_array($encryption, ['', 'tls', 'ssl'], true)) {
        $errors[] = 'SMTP_ENCRYPTION must be tls, ssl, or empty.';
    }

    if (stripos($host, 'gmail.com') !== false) {
        if ($port === 587 && $encryption !== 'tls') {
            $errors[] = 'Gmail SMTP on port 587 requires SMTP_ENCRYPTION=tls.';
        }
        if ($port === 465 && $encryption !== 'ssl') {
            $errors[] = 'Gmail SMTP on port 465 requires SMTP_ENCRYPTION=ssl.';
        }
    }

    $fromEmail = trim((string)($config['from_email'] ?? ''));
    if ($fromEmail === '') {
        $errors[] = 'SMTP_FROM_EMAIL is required.';
    } elseif (!filter_var($fromEmail, FILTER_VALIDATE_EMAIL)) {
        $errors[] = 'SMTP_FROM_EMAIL must be a valid email address.';
    }

    return $errors;
}

function api_mail_service_is_configured(): bool
{
    return api_mail_config_errors() === [];
}

function api_mail_configuration_error_message(string $context = 'Email service'): string
{
    // Said plainly, without the SMTP_* list below: no SMTP setting fixes this.
    $transport = api_mail_transport();
    if ($transport === 'smtp' && api_mail_smtp_blocked()) {
        return $context . ' is not available yet: this server cannot send email through Gmail SMTP (SMTP is blocked). '
            . 'An administrator must set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN so email goes out through the Gmail API over HTTPS.';
    }

    $errors = api_mail_config_errors();
    $detail = $errors !== [] ? ' ' . implode(' ', array_slice($errors, 0, 2)) : '';

    if ($transport === 'apps_script') {
        return $context . ' is not configured correctly.' . $detail . ' Set APPS_SCRIPT_URL and APPS_SCRIPT_SECRET in the backend environment.';
    }

    if ($transport === 'gmail_api') {
        return $context . ' is not configured correctly.' . $detail .
            ' Run node tools/deploy/gmail-token.js and set GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET and GMAIL_REFRESH_TOKEN from deploy/gmail.env in the server environment.';
    }

    return $context . ' is not configured correctly.' . $detail .
        ' Set SMTP_HOST, SMTP_PORT, SMTP_USERNAME, SMTP_PASSWORD, SMTP_ENCRYPTION, SMTP_FROM_EMAIL, and SMTP_FROM_NAME in the server environment or a local .env/.env.local file.';
}

function api_mail_redact_value(string $value): string
{
    $trimmed = trim($value);
    if ($trimmed === '') {
        return '';
    }

    if (filter_var($trimmed, FILTER_VALIDATE_EMAIL)) {
        [$localPart, $domain] = explode('@', $trimmed, 2);
        $localPrefix = substr($localPart, 0, 1);
        $domainPrefix = substr($domain, 0, 1);
        return $localPrefix . '***@' . $domainPrefix . '***';
    }

    if (strlen($trimmed) <= 4) {
        return str_repeat('*', strlen($trimmed));
    }

    return substr($trimmed, 0, 2) . str_repeat('*', max(1, strlen($trimmed) - 4)) . substr($trimmed, -2);
}

function api_mail_sanitized_config(array $config): array
{
    // An allow-list, so the SMTP password, the Brevo API key and the Gmail
    // client secret and refresh token never reach a log.
    return [
        'transport' => (string)($config['transport'] ?? 'smtp'),
        'host' => (string)($config['host'] ?? ''),
        'port' => (int)($config['port'] ?? 0),
        'encryption' => (string)($config['encryption'] ?? ''),
        'username' => api_mail_redact_value((string)($config['username'] ?? '')),
        'from_email' => api_mail_redact_value((string)($config['from_email'] ?? '')),
        'from_name' => (string)($config['from_name'] ?? ''),
        'timeout' => (int)($config['timeout'] ?? 0),
        'debug_enabled' => !empty($config['debug_enabled']),
    ];
}

function api_mail_log_failure(string $event, Throwable $throwable, array $config, array $debugLines = [], array $context = []): void
{
    $payload = array_merge($context, [
        'event' => $event,
        'message' => $throwable->getMessage(),
        'transport' => api_mail_sanitized_config($config),
    ]);

    if ($debugLines !== []) {
        $payload['smtp_trace'] = array_slice($debugLines, -20);
    }

    $json = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
    error_log('[mail] ' . ($json !== false ? $json : $event));
}

function api_mail_user_friendly_error_message(string $details, array $config): string
{
    $message = strtolower(trim($details));

    if (($config['transport'] ?? '') === 'apps_script') {
        if (strpos($message, 'switched off') !== false) {
            return 'Outbound email is switched off in Settings.';
        }
        if (strpos($message, 'timed out') !== false || strpos($message, 'could not reach') !== false
            || strpos($message, 'connection refused') !== false || strpos($message, 'network is unreachable') !== false) {
            return 'Unable to reach the Google Apps Script email service over HTTPS. Try again shortly. An administrator should check outbound HTTPS access to Google and the server mail log.';
        }
        return 'Google Apps Script could not confirm email delivery. An administrator should check the deployment access, APPS_SCRIPT_URL, matching APPS_SCRIPT_SECRET and sending account quota.';
    }

    if ($message === '') {
        return 'Email delivery failed. Check the SMTP server response and try again.';
    }

    if (($config['transport'] ?? '') === 'gmail_api') {
        return api_mail_gmail_api_error_message($message);
    }

    if (filter_var((string)($config['host'] ?? ''), FILTER_VALIDATE_EMAIL)) {
        return 'SMTP host is invalid. Use your mail server host name, such as smtp.gmail.com, instead of an email address.';
    }

    if (
        strpos($message, 'username and password not accepted') !== false
        || strpos($message, 'authentication failed') !== false
        || strpos($message, 'could not authenticate') !== false
    ) {
        return 'SMTP authentication failed. Verify SMTP_USERNAME and SMTP_PASSWORD, and use a valid Gmail App Password if 2-Step Verification is enabled.';
    }

    if (
        strpos($message, 'smtp connect() failed') !== false
        || strpos($message, 'could not connect to smtp host') !== false
        || strpos($message, 'connection refused') !== false
        || strpos($message, 'network is unreachable') !== false
        || strpos($message, 'timed out') !== false
    ) {
        return 'Unable to reach the SMTP server. Verify SMTP_HOST, SMTP_PORT, SMTP_ENCRYPTION, and any outbound mail firewall rules on the server.';
    }

    if (
        strpos($message, 'invalid address') !== false
        || strpos($message, 'from address') !== false
        || strpos($message, 'sender address') !== false
    ) {
        return 'The sender address was rejected. Verify SMTP_FROM_EMAIL and the authenticated SMTP account.';
    }

    if (
        strpos($message, 'recipient address rejected') !== false
        || strpos($message, 'address not allowed') !== false
    ) {
        return 'The recipient email address was rejected by the SMTP server. Verify the target email and try again.';
    }

    if (
        strpos($message, 'spam') !== false
        || strpos($message, 'junk') !== false
        || strpos($message, 'blocked') !== false
        || strpos($message, 'policy') !== false
    ) {
        return 'The SMTP server accepted the request but flagged the message. Ask the recipient to check spam/junk and verify the sender reputation.';
    }

    return 'Email delivery failed. Check the SMTP server response and try again.';
}

/**
 * The Gmail API's failures in words an administrator can act on. Google's
 * answers name the cause well (invalid_grant, "has not been used in project"),
 * but the SMTP wording above would send them to settings that do not apply.
 * Takes the lower-cased error from api_mail_send_gmail().
 */
function api_mail_gmail_api_error_message(string $message): string
{
    if (strpos($message, 'invalid_grant') !== false) {
        return 'Google no longer accepts the saved sign-in for the sending Gmail account (it expired, was revoked, or the Gmail password changed). '
            . 'An administrator must run node tools/deploy/gmail-token.js again and update GMAIL_REFRESH_TOKEN.';
    }

    if (strpos($message, 'invalid_client') !== false || strpos($message, 'unauthorized_client') !== false) {
        return 'Google did not accept GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET, or the refresh token was made with a different OAuth client. '
            . 'An administrator must copy all three values from the same run of tools/deploy/gmail-token.js.';
    }

    if (strpos($message, 'has not been used in project') !== false || strpos($message, 'is disabled') !== false || strpos($message, 'accessnotconfigured') !== false) {
        return 'The Gmail API is not enabled in the Google Cloud project. An administrator must enable it under APIs & Services > Library > Gmail API.';
    }

    if (strpos($message, 'insufficient') !== false) {
        return 'The saved Gmail sign-in is not allowed to send mail. An administrator must run node tools/deploy/gmail-token.js again and allow sending.';
    }

    if (strpos($message, 'http 429') !== false || strpos($message, 'limit exceeded') !== false) {
        return 'The sending Gmail account has reached its sending limit for now. Try again later.';
    }

    if (strpos($message, 'could not reach google') !== false) {
        return 'Could not reach Google to send the email. Try again in a moment.';
    }

    if (strpos($message, 'invalid to header') !== false || strpos($message, 'recipient address') !== false) {
        return 'Gmail rejected the recipient email address. Verify the target email and try again.';
    }

    return 'Email delivery through the Gmail API failed. The server log ([mail]) has Google\'s reason.';
}

function api_mail_apply_smtp($mailer, string $defaultFromName = 'Mailer', ?array &$debugLines = null): array
{
    $config = api_mail_config($defaultFromName);
    $errors = api_mail_config_errors($config);
    if ($errors !== []) {
        throw new RuntimeException(api_mail_configuration_error_message($defaultFromName));
    }

    $debugLines = [];

    $mailer->isSMTP();
    $mailer->Host = $config['host'];
    $mailer->SMTPAuth = true;
    $mailer->Username = $config['username'];
    $mailer->Password = $config['password'];
    $mailer->Port = (int)$config['port'];
    $mailer->Timeout = (int)$config['timeout'];
    $mailer->CharSet = 'UTF-8';

    if ($config['encryption'] !== '') {
        $mailer->SMTPSecure = $config['encryption'];
    }

    if (!empty($config['debug_enabled'])) {
        $mailer->SMTPDebug = (int)$config['debug_level'];
        $mailer->Debugoutput = static function ($line, $level) use (&$debugLines): void {
            $trimmed = trim((string)$line);
            if ($trimmed !== '') {
                $debugLines[] = '[' . $level . '] ' . $trimmed;
            }
        };
    } else {
        $mailer->SMTPDebug = 0;
    }

    $mailer->setFrom($config['from_email'], $config['from_name']);

    return $config;
}

/* -------------------------------------------------------------------------
 * Outbound email switch
 *
 * A kill switch for every outgoing message, flipped from Settings.
 *
 * It exists because sending is synchronous and talks to Gmail over SMTP with a
 * 20-second timeout, so creating a student waits on a live network handshake
 * before it returns. That is fine for one student and painful for a hundred:
 * bulk work spends nearly all of its time in the mail server, not the database.
 * Turning this off makes creation return at database speed.
 *
 * Stored as JSON beside the other security policies rather than in a table, so
 * it can be read from any endpoint without a database round trip on every send,
 * and read back even when the database is the thing being restored.
 *
 * Default is ON. A switch that silently defaults to "no email" would be a
 * support nightmare - accounts created with nobody told their password.
 * ---------------------------------------------------------------------- */

function api_mail_outbound_policy_path(): string
{
    return dirname(__DIR__) . '/storage/security/mail_outbound_policy.json';
}

function api_mail_outbound_default_policy(): array
{
    return ['enabled' => false, 'updated_at' => null, 'updated_by' => null, 'note' => null];
}

function api_mail_outbound_get_policy(): array
{
    $default = api_mail_outbound_default_policy();
    $path = api_mail_outbound_policy_path();
    if (!is_file($path)) {
        return $default;
    }

    $handle = @fopen($path, 'rb');
    if (!$handle) {
        return $default;
    }
    try {
        @flock($handle, LOCK_SH);
        $raw = stream_get_contents($handle);
        @flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }

    $decoded = json_decode((string)$raw, true);
    if (!is_array($decoded)) {
        return $default;
    }

    return [
        // Only an explicit false switches sending off, so a truncated or
        // half-written file fails safe - towards delivering mail, not silence.
        'enabled' => !array_key_exists('enabled', $decoded) || api_mail_parse_bool($decoded['enabled']),
        'updated_at' => $decoded['updated_at'] ?? null,
        'updated_by' => isset($decoded['updated_by']) ? (int)$decoded['updated_by'] : null,
        'note' => isset($decoded['note']) ? (string)$decoded['note'] : null,
    ];
}

function api_mail_outbound_enabled(): bool
{
    return (bool)api_mail_outbound_get_policy()['enabled'];
}

function api_mail_outbound_save_policy(bool $enabled, ?int $actorUserId = null, ?string $note = null): array
{
    $path = api_mail_outbound_policy_path();
    $dir = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('Mail policy storage is not writable.');
    }

    $policy = [
        'enabled' => $enabled,
        'updated_at' => date('Y-m-d H:i:s'),
        'updated_by' => $actorUserId,
        'note' => $note,
    ];

    $handle = @fopen($path, 'c+b');
    if (!$handle) {
        throw new RuntimeException('Mail policy storage is not writable.');
    }
    try {
        if (!@flock($handle, LOCK_EX)) {
            throw new RuntimeException('Mail policy storage is locked.');
        }
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($policy, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        fflush($handle);
        @flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }

    return $policy;
}
