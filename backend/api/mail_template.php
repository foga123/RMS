<?php
/**
 * Branded email layout + a single send entry point.
 *
 * Before this file, each of the four senders (password reset, profile OTP,
 * password-change OTP, student welcome) hand-rolled its own `<p>` soup, its own
 * PHPMailer bootstrap and its own error handling. They looked different from
 * each other and none of them looked like the portal. Everything now renders
 * through `api_mail_render()` and sends through `api_mail_send()`.
 *
 * Markup rules are dictated by email clients, not by preference:
 *   - tables for layout (Outlook ignores flex/grid),
 *   - inline styles only (Gmail strips <style> blocks),
 *   - 600px max width, and a hidden preheader so the inbox preview is useful.
 */

require_once __DIR__ . '/mail_config.php';

const MAIL_BRAND_GREEN = '#065f46';
const MAIL_BRAND_ACCENT = '#059669';
const MAIL_BRAND_SUBTLE = '#ecfdf5';
const MAIL_BORDER = '#e2e8f0';
const MAIL_TEXT = '#0f172a';
const MAIL_TEXT_BODY = '#475569';
const MAIL_TEXT_MUTED = '#64748b';
const MAIL_SURFACE_SOFT = '#f8fafc';

/**
 * Outlook does not inherit font-family into nested tables, so every text node
 * has to name it. Repeating a constant is the least error-prone way to do that.
 */
const MAIL_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const MAIL_FONT_MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace";

function api_mail_e(?string $value): string
{
    return htmlspecialchars((string)$value, ENT_QUOTES, 'UTF-8');
}

/**
 * Render the branded shell around whatever blocks the caller asked for.
 *
 * @param array $opts heading, preheader, greeting, intro[], code, code_note,
 *                    rows[[label,value,mono?]], button[label,url], note, footer_note
 */
function api_mail_render(array $opts): string
{
    $heading = api_mail_e($opts['heading'] ?? 'RMS PHINMA-COC Student Portal');
    $preheader = api_mail_e($opts['preheader'] ?? '');
    $greeting = trim((string)($opts['greeting'] ?? ''));
    $intro = $opts['intro'] ?? [];
    if (is_string($intro)) {
        $intro = [$intro];
    }

    // Outlook needs the rule stated explicitly or it collapses line-height.
    $textBase = 'font-family:' . MAIL_FONT . ';mso-line-height-rule:exactly;';

    $body = '';

    if ($greeting !== '') {
        $body .= '<p style="' . $textBase . 'margin:0 0 16px;font-size:16px;line-height:24px;color:'
            . MAIL_TEXT . ';">' . api_mail_e($greeting) . '</p>';
    }

    foreach ($intro as $paragraph) {
        $text = trim((string)$paragraph);
        if ($text === '') {
            continue;
        }
        $body .= '<p style="' . $textBase . 'margin:0 0 14px;font-size:15px;line-height:24px;color:'
            . MAIL_TEXT_BODY . ';">' . api_mail_e($text) . '</p>';
    }

    // One-time code: the single most-scanned element, so it gets the most weight.
    if (!empty($opts['code'])) {
        $body .= '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"'
            . ' style="margin:24px 0;"><tr><td align="center" bgcolor="' . MAIL_BRAND_SUBTLE . '"'
            . ' style="background:' . MAIL_BRAND_SUBTLE . ';border:1px solid #a7f3d0;border-radius:12px;padding:24px 16px;">'
            . '<div style="' . $textBase . 'font-size:11px;font-weight:700;letter-spacing:1.4px;'
            . 'text-transform:uppercase;color:' . MAIL_BRAND_ACCENT . ';line-height:16px;">Verification code</div>'
            // padding-left offsets the trailing gap letter-spacing adds after the
            // final digit, which otherwise pushes the code left of true centre.
            . '<div style="font-family:' . MAIL_FONT_MONO . ';mso-line-height-rule:exactly;margin-top:12px;'
            . 'padding-left:8px;font-size:32px;font-weight:700;letter-spacing:8px;word-break:break-all;color:'
            . MAIL_BRAND_GREEN . ';line-height:38px;">'
            . api_mail_e((string)$opts['code']) . '</div>';
        if (!empty($opts['code_note'])) {
            $body .= '<div style="' . $textBase . 'margin-top:12px;font-size:13px;line-height:18px;color:#047857;">'
                . api_mail_e((string)$opts['code_note']) . '</div>';
        }
        $body .= '</td></tr></table>';
    }

    // Label/value rows — used for credentials on the student welcome mail.
    if (!empty($opts['rows']) && is_array($opts['rows'])) {
        $body .= '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"'
            . ' style="margin:8px 0 22px;border:1px solid ' . MAIL_BORDER . ';border-radius:12px;overflow:hidden;">';
        $index = 0;
        foreach ($opts['rows'] as $row) {
            $label = api_mail_e((string)($row[0] ?? $row['label'] ?? ''));
            $value = api_mail_e((string)($row[1] ?? $row['value'] ?? ''));
            $mono = !empty($row[2]) || !empty($row['mono']);
            $background = $index % 2 === 0 ? MAIL_SURFACE_SOFT : '#ffffff';
            $valueFont = $mono
                ? 'font-family:' . MAIL_FONT_MONO . ';font-size:15px;font-weight:700;letter-spacing:0.5px;'
                : 'font-family:' . MAIL_FONT . ';font-size:14px;';
            $body .= '<tr>'
                . '<td bgcolor="' . $background . '" style="' . $textBase . 'padding:12px 16px;background:'
                . $background . ';font-size:13px;line-height:18px;color:' . MAIL_TEXT_MUTED . ';width:42%;'
                . 'vertical-align:top;">' . $label . '</td>'
                . '<td bgcolor="' . $background . '" style="' . $valueFont . 'mso-line-height-rule:exactly;'
                . 'padding:12px 16px;background:' . $background . ';line-height:20px;word-break:break-all;color:'
                . MAIL_TEXT . ';vertical-align:top;">' . $value . '</td>'
                . '</tr>';
            $index++;
        }
        $body .= '</table>';
    }

    if (!empty($opts['button']['url']) && !empty($opts['button']['label'])) {
        // bgcolor duplicates the background so Outlook, which drops the CSS
        // shorthand here, still fills the button.
        $body .= '<table role="presentation" cellpadding="0" cellspacing="0" border="0"'
            . ' style="margin:8px 0 24px;"><tr><td align="center" bgcolor="' . MAIL_BRAND_ACCENT . '"'
            . ' style="border-radius:8px;background:' . MAIL_BRAND_ACCENT . ';">'
            . '<a href="' . api_mail_e((string)$opts['button']['url']) . '"'
            . ' style="font-family:' . MAIL_FONT . ';display:inline-block;padding:14px 32px;font-size:15px;'
            . 'font-weight:600;line-height:20px;color:#ffffff;text-decoration:none;border-radius:8px;">'
            . api_mail_e((string)$opts['button']['label']) . '</a></td></tr></table>';
    }

    if (!empty($opts['note'])) {
        $body .= '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"'
            . ' style="margin:20px 0 0;"><tr><td bgcolor="' . MAIL_SURFACE_SOFT . '"'
            . ' style="' . $textBase . 'border-left:3px solid ' . MAIL_BRAND_ACCENT . ';background:'
            . MAIL_SURFACE_SOFT . ';border-radius:0 8px 8px 0;padding:14px 16px;'
            . 'font-size:13px;line-height:20px;color:' . MAIL_TEXT_MUTED . ';">'
            . api_mail_e((string)$opts['note']) . '</td></tr></table>';
    }

    $footerNote = api_mail_e((string)($opts['footer_note'] ?? 'This is an automated message — replies are not monitored.'));
    $year = date('Y');

    return '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
        . '<meta name="viewport" content="width=device-width,initial-scale=1">'
        // Without these, Apple Mail and Outlook.com invert the card in dark mode
        // and iOS turns the verification code into a tappable phone number.
        . '<meta name="color-scheme" content="light">'
        . '<meta name="supported-color-schemes" content="light">'
        . '<meta name="x-apple-disable-message-reformatting">'
        . '<meta name="format-detection" content="telephone=no,date=no,address=no,email=no">'
        . '<title>' . $heading . '</title></head>'
        . '<body style="margin:0;padding:0;width:100%;background:#f1f5f9;">'
        . '<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">' . $preheader
        // Spacer entities stop the body copy bleeding into the inbox preview
        // after the preheader runs out.
        . str_repeat('&#847;&zwnj;&nbsp;', 60) . '</div>'
        . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"'
        . ' style="background:#f1f5f9;padding:32px 12px;"><tr><td align="center">'
        . '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600"'
        . ' style="max-width:600px;width:100%;background:#ffffff;border:1px solid ' . MAIL_BORDER . ';'
        . 'border-radius:14px;overflow:hidden;">'
        // Header
        . '<tr><td bgcolor="' . MAIL_BRAND_GREEN . '" style="background:' . MAIL_BRAND_GREEN . ';padding:26px 32px;">'
        . '<div style="font-family:' . MAIL_FONT . ';mso-line-height-rule:exactly;font-size:11px;font-weight:700;'
        . 'letter-spacing:2.2px;text-transform:uppercase;line-height:16px;color:#6ee7b7;">RMS PHINMA-COC</div>'
        . '<div style="font-family:' . MAIL_FONT . ';mso-line-height-rule:exactly;margin-top:6px;font-size:19px;'
        . 'font-weight:700;line-height:26px;color:#ffffff;">Student Retention Portal</div>'
        . '</td></tr>'
        // Accent rule: separates the header from the card without a second block.
        . '<tr><td bgcolor="' . MAIL_BRAND_ACCENT . '" style="background:' . MAIL_BRAND_ACCENT
        . ';height:3px;font-size:0;line-height:0;">&nbsp;</td></tr>'
        // Title + body share one cell so the vertical rhythm is set in one place.
        . '<tr><td style="padding:32px;">'
        . '<h1 style="font-family:' . MAIL_FONT . ';mso-line-height-rule:exactly;margin:0 0 18px;font-size:21px;'
        . 'line-height:28px;font-weight:700;color:' . MAIL_TEXT . ';">' . $heading . '</h1>'
        . $body . '</td></tr>'
        // Footer
        . '<tr><td bgcolor="' . MAIL_SURFACE_SOFT . '" style="background:' . MAIL_SURFACE_SOFT
        . ';border-top:1px solid ' . MAIL_BORDER . ';padding:20px 32px;">'
        . '<div style="font-family:' . MAIL_FONT . ';mso-line-height-rule:exactly;font-size:12px;line-height:18px;'
        . 'color:' . MAIL_TEXT_MUTED . ';">' . $footerNote . '</div>'
        . '<div style="font-family:' . MAIL_FONT . ';mso-line-height-rule:exactly;margin-top:8px;font-size:11px;'
        . 'line-height:16px;color:' . MAIL_TEXT_MUTED . ';">&copy; ' . $year . ' RMS PHINMA-COC</div>'
        . '</td></tr>'
        . '</table></td></tr></table></body></html>';
}

/** Load PHPMailer once, from the vendored copy. */
/**
 * Make PHPMailer available.
 *
 * Composer is the only source now. A second, hand-extracted copy used to live at
 * frontend/PHPMailer-master and was preferred only when vendor/ was absent; it
 * was removed once composer.json and composer.lock were committed, because two
 * copies of a library that handles credentials and SMTP means one of them drifts
 * out of date unnoticed - and it had, by two minor versions.
 *
 * Returns false rather than throwing when the dependency is missing: callers
 * treat that as "could not send", so a checkout that has not run
 * `composer install` degrades to no email instead of a fatal error.
 */
function api_mail_bootstrap_library(): bool
{
    if (class_exists('\\PHPMailer\\PHPMailer\\PHPMailer')) {
        return true;
    }

    // frontend/backend/vendor/autoload.php - composer.json sits beside it.
    $autoload = dirname(__DIR__) . '/vendor/autoload.php';
    if (!is_file($autoload)) {
        return false;
    }

    require_once $autoload;

    return class_exists('\\PHPMailer\\PHPMailer\\PHPMailer');
}

/**
 * POST to one of the HTTPS mail services and return [HTTP status, decoded
 * JSON body]; the body is [] when it is not JSON. Throws only when the
 * service could not be reached at all, naming it ("Could not reach Google").
 * Bounded by SMTP_TIMEOUT like the SMTP path (5 to 30 seconds), so a slow
 * service still answers inside the browser's 20-second wait.
 */
function api_mail_can_retry_initial_dns(int $errorCode, array $info): bool
{
    // A redirect lookup can fail AFTER Google sends the email. Never retry it.
    return in_array($errorCode, [CURLE_COULDNT_RESOLVE_HOST, CURLE_OPERATION_TIMEDOUT], true)
        && (string)($info['primary_ip'] ?? '') === ''
        && (int)($info['request_size'] ?? 0) === 0
        && (float)($info['size_upload'] ?? 0) === 0.0
        && (int)($info['http_code'] ?? 0) === 0;
}

function api_mail_https_post(string $url, string $body, array $headers, array $config, string $service): array
{
    $timeout = min(30, max(5, (int)($config['timeout'] ?? 20)));
    $started = microtime(true);
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_POST => true,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => array_merge(['accept: application/json'], $headers),
        CURLOPT_POSTFIELDS => $body,
        // Apps Script returns its JSON through a Google ContentService redirect.
        CURLOPT_FOLLOWLOCATION => $service === 'Google Apps Script',
        CURLOPT_MAXREDIRS => 3,
        CURLOPT_REDIR_PROTOCOLS => CURLPROTO_HTTPS,
        CURLOPT_CONNECTTIMEOUT => $service === 'Google Apps Script' ? min(10, max(1, (int)floor($timeout / 2))) : 10,
        CURLOPT_TIMEOUT => $timeout,
    ]);
    $response = curl_exec($ch);
    if ($response === false && $service === 'Google Apps Script'
        && api_mail_can_retry_initial_dns(curl_errno($ch), curl_getinfo($ch))) {
        $remainingMs = (int)floor(($timeout - (microtime(true) - $started)) * 1000);
        if ($remainingMs >= 1000) {
            // Stay inside the original request's time budget. No email was sent.
            curl_setopt_array($ch, [
                CURLOPT_FRESH_CONNECT => true,
                CURLOPT_DNS_CACHE_TIMEOUT => 0,
                CURLOPT_CONNECTTIMEOUT_MS => min(10000, $remainingMs),
                CURLOPT_TIMEOUT_MS => $remainingMs,
            ]);
            $response = curl_exec($ch);
        }
    }
    $status = (int)curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($response === false) {
        throw new RuntimeException('Could not reach ' . $service . ': ' . $curlError);
    }

    $decoded = json_decode((string)$response, true);
    return [$status, is_array($decoded) ? $decoded : []];
}

/**
 * Send one rendered message through Brevo's transactional email API.
 *
 * The HTTPS twin of the PHPMailer path in api_mail_send(): same subject, same
 * rendered HTML, same plain-text fallback, same result shape, and failures are
 * logged the same way (with the API key never included - see
 * api_mail_sanitized_config()). Used where SMTP is blocked; see
 * api_mail_transport().
 */
function api_mail_send_apps_script(array $opts, string $to): array
{
    $config = api_mail_config((string)($opts['from_name'] ?? 'Student Portal'));
    try {
        $html = api_mail_render($opts);
        $payload = json_encode([
            'secret' => $config['apps_script_secret'],
            'to' => $to,
            'subject' => (string)($opts['subject'] ?? 'RMS PHINMA-COC Student Portal'),
            'body' => (string)($opts['alt'] ?? html_entity_decode(strip_tags($html), ENT_QUOTES | ENT_HTML5, 'UTF-8')),
            'from_name' => $config['from_name'],
            'html_body' => $html,
        ], JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR);
        [$status, $decoded] = api_mail_https_post($config['apps_script_url'], $payload,
            ['content-type: application/json'], $config, 'Google Apps Script');
        if ($status < 200 || $status >= 300 || ($decoded['status'] ?? '') !== 'success') {
            // Do not expose remote response bodies: they may echo credentials or message data.
            throw new RuntimeException('Google Apps Script did not confirm email delivery (HTTP ' . $status . '). Check deployment access, the shared secret and the sending account quota.');
        }
        return ['sent' => true, 'error' => null];
    } catch (Throwable $error) {
        api_mail_log_failure((string)($opts['log_event'] ?? 'mail_send_failed'), $error, $config,
            [], ['recipient' => api_mail_redact_value($to)]);
        return ['sent' => false, 'error' => $error->getMessage()];
    }
}

function api_mail_send_brevo(array $opts, string $to): array
{
    $config = api_mail_config((string)($opts['from_name'] ?? 'Student Portal'));
    $payload = [
        'sender' => ['email' => $config['from_email'], 'name' => $config['from_name']],
        'to' => [['email' => $to, 'name' => (string)($opts['to_name'] ?? $to)]],
        'subject' => (string)($opts['subject'] ?? 'RMS PHINMA-COC Student Portal'),
        'htmlContent' => api_mail_render($opts),
    ];
    $alt = (string)($opts['alt'] ?? strip_tags((string)($opts['heading'] ?? '')));
    if (trim($alt) !== '') {
        $payload['textContent'] = $alt;
    }

    try {
        // BREVO_API_URL exists for tests/deploy_config_check.php, which points it at a
        // local stand-in; nothing else sets it.
        [$status, $decoded] = api_mail_https_post(
            (string)(api_mail_env('BREVO_API_URL', '') ?: 'https://api.brevo.com/v3/smtp/email'),
            (string)json_encode($payload, JSON_UNESCAPED_UNICODE),
            ['content-type: application/json', 'api-key: ' . $config['brevo_api_key']],
            $config,
            'Brevo'
        );
        if ($status < 200 || $status >= 300) {
            $reason = trim((string)($decoded['message'] ?? ''));
            throw new RuntimeException('Brevo refused the message (HTTP ' . $status . ')' . ($reason !== '' ? ': ' . $reason : '') . '.');
        }

        return ['sent' => true, 'error' => null];
    } catch (Throwable $throwable) {
        api_mail_log_failure(
            (string)($opts['log_event'] ?? 'mail_send_failed'),
            $throwable,
            $config,
            [],
            ['recipient' => api_mail_redact_value($to)]
        );

        return ['sent' => false, 'error' => $throwable->getMessage()];
    }
}

/**
 * A short-lived Gmail API access token, from the long-lived refresh token.
 *
 * Google's token endpoint trades GMAIL_REFRESH_TOKEN for an access token
 * good for about an hour. It is kept for the rest of this request only, so
 * several messages sent together (welcome mail for a batch) ask once; it is
 * never written anywhere. Throws with Google's reason - invalid_grant when
 * the refresh token was revoked or expired - which
 * api_mail_gmail_api_error_message() turns into what to do about it.
 */
function api_mail_gmail_access_token(array $config): string
{
    static $tokens = [];
    $key = hash('sha256', $config['gmail_client_id'] . "\n" . $config['gmail_refresh_token']);
    if (isset($tokens[$key]) && $tokens[$key]['expires_at'] > time() + 60) {
        return $tokens[$key]['token'];
    }

    // GMAIL_TOKEN_URL exists for tests/deploy_config_check.php; nothing else sets it.
    [$status, $decoded] = api_mail_https_post(
        (string)(api_mail_env('GMAIL_TOKEN_URL', '') ?: 'https://oauth2.googleapis.com/token'),
        http_build_query([
            'client_id' => $config['gmail_client_id'],
            'client_secret' => $config['gmail_client_secret'],
            'refresh_token' => $config['gmail_refresh_token'],
            'grant_type' => 'refresh_token',
        ]),
        ['content-type: application/x-www-form-urlencoded'],
        $config,
        'Google'
    );
    $token = trim((string)($decoded['access_token'] ?? ''));
    if ($status !== 200 || $token === '') {
        $error = trim((string)($decoded['error'] ?? ''));
        $description = trim((string)($decoded['error_description'] ?? ''));
        throw new RuntimeException('Google refused the Gmail sign-in (HTTP ' . $status . ')'
            . ($error !== '' ? ': ' . $error . ($description !== '' ? ' - ' . $description : '') : '') . '.');
    }

    $tokens[$key] = ['token' => $token, 'expires_at' => time() + (int)($decoded['expires_in'] ?? 0)];
    return $token;
}

/**
 * Send one rendered message through the Gmail API, as the Gmail account the
 * refresh token belongs to.
 *
 * The other HTTPS route past Railway's SMTP block, and the one chosen
 * (2026-10-08): the mail leaves from gmail.com itself, signed by Google, so it
 * reaches inboxes the way the XAMPP SMTP mail does. PHPMailer builds the
 * message exactly as on the SMTP path - same headers, HTML and plain-text
 * parts - and only the delivery differs: users.messages.send with the whole
 * message, base64url-encoded, as `raw`. Same result shape as the other paths,
 * and failures are logged the same way, without the secrets.
 */
function api_mail_send_gmail(array $opts, string $to): array
{
    $config = api_mail_config((string)($opts['from_name'] ?? 'Student Portal'));
    if (!api_mail_bootstrap_library()) {
        return ['sent' => false, 'error' => 'Mailer library is unavailable.'];
    }

    try {
        $mailer = new \PHPMailer\PHPMailer\PHPMailer(true);
        $mailer->CharSet = 'UTF-8';
        $mailer->setFrom($config['from_email'], $config['from_name']);
        $mailer->addAddress($to, (string)($opts['to_name'] ?? $to));
        $mailer->isHTML(true);
        $mailer->Subject = (string)($opts['subject'] ?? 'RMS PHINMA-COC Student Portal');
        $mailer->Body = api_mail_render($opts);
        $mailer->AltBody = (string)($opts['alt'] ?? strip_tags((string)($opts['heading'] ?? '')));
        $mailer->preSend();
        $raw = rtrim(strtr(base64_encode($mailer->getSentMIMEMessage()), '+/', '-_'), '=');

        // GMAIL_API_URL exists for tests/deploy_config_check.php; nothing else sets it.
        [$status, $decoded] = api_mail_https_post(
            (string)(api_mail_env('GMAIL_API_URL', '') ?: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send'),
            (string)json_encode(['raw' => $raw]),
            ['content-type: application/json', 'authorization: Bearer ' . api_mail_gmail_access_token($config)],
            $config,
            'Google'
        );
        if ($status < 200 || $status >= 300) {
            $reason = trim((string)($decoded['error']['message'] ?? ''));
            throw new RuntimeException('The Gmail API refused the message (HTTP ' . $status . ')' . ($reason !== '' ? ': ' . $reason : '') . '.');
        }

        return ['sent' => true, 'error' => null];
    } catch (Throwable $throwable) {
        api_mail_log_failure(
            (string)($opts['log_event'] ?? 'mail_send_failed'),
            $throwable,
            $config,
            [],
            ['recipient' => api_mail_redact_value($to)]
        );

        return ['sent' => false, 'error' => $throwable->getMessage()];
    }
}

/**
 * Render and send one branded message.
 *
 * Never throws — callers get ['sent' => bool, 'error' => ?string] so a mail
 * outage degrades the surrounding request instead of failing it.
 */
function api_mail_send(array $opts): array
{
    $to = trim((string)($opts['to'] ?? ''));
    if ($to === '') {
        return ['sent' => false, 'error' => 'No recipient address.'];
    }

    // Checked before the configuration test, and before any socket is opened,
    // so switching sending off in Settings works on a box with no SMTP set up
    // at all. Every sender in the app funnels through here, so this one guard
    // covers welcome mail, reset codes and the profile OTPs alike.
    //
    // `skipped` is deliberately distinct from a failure: callers show "we could
    // not email them" on error, which would be a lie when an administrator
    // turned sending off on purpose.
    if (!api_mail_outbound_enabled()) {
        return [
            'sent' => false,
            'skipped' => true,
            'error' => 'Outbound email is switched off in Settings.',
        ];
    }

    if (!api_mail_service_is_configured()) {
        return ['sent' => false, 'error' => api_mail_configuration_error_message()];
    }

    // Same message, sent over HTTPS where SMTP is blocked (see api_mail_transport()).
    $transport = api_mail_transport();
    if ($transport === 'apps_script') {
        return api_mail_send_apps_script($opts, $to);
    }
    if ($transport === 'gmail_api') {
        return api_mail_send_gmail($opts, $to);
    }
    if ($transport === 'brevo') {
        return api_mail_send_brevo($opts, $to);
    }

    if (!api_mail_bootstrap_library()) {
        return ['sent' => false, 'error' => 'Mailer library is unavailable.'];
    }

    $mailer = new \PHPMailer\PHPMailer\PHPMailer(true);
    $debugLines = [];
    $mailConfig = [];

    try {
        $mailConfig = api_mail_apply_smtp($mailer, (string)($opts['from_name'] ?? 'Student Portal'), $debugLines);
        $mailer->addAddress($to, (string)($opts['to_name'] ?? $to));
        $mailer->isHTML(true);
        $mailer->CharSet = 'UTF-8';
        $mailer->Subject = (string)($opts['subject'] ?? 'RMS PHINMA-COC Student Portal');
        $mailer->Body = api_mail_render($opts);
        $mailer->AltBody = (string)($opts['alt'] ?? strip_tags((string)($opts['heading'] ?? '')));
        $mailer->send();

        return ['sent' => true, 'error' => null];
    } catch (Throwable $throwable) {
        $detail = trim((string)($mailer->ErrorInfo ?: $throwable->getMessage()));
        api_mail_log_failure(
            (string)($opts['log_event'] ?? 'mail_send_failed'),
            $throwable,
            $mailConfig,
            $debugLines,
            ['recipient' => api_mail_redact_value($to)]
        );

        return ['sent' => false, 'error' => $detail !== '' ? $detail : 'Failed to send the email.'];
    }
}
