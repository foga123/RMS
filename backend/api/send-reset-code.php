<?php

require_once __DIR__ . '/middleware/auth.php';

api_start_session();
api_send_headers(['GET', 'POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/mail_config.php';
require_once __DIR__ . '/mail_template.php';
require_once __DIR__ . '/password_reset_codes.php';
require_once __DIR__ . '/lib/turnstile.php';

if (($_SERVER['REQUEST_METHOD'] ?? '') === 'GET') {
    header('Cache-Control: no-store');
    api_json_response(200, ['captcha' => api_turnstile_public_config()]);
}

// Same status, message and public deadlines for an absent account, an active
// cooldown, and an accepted/uncertain delivery. Provider failures are logged.
function password_reset_public_receipt(): array
{
    return [
        'message' => 'If this email is registered, a verification code was requested. Check your inbox and spam folder. Delivery may take a moment.',
        'cooldown_ends_at' => gmdate('c', time() + 60),
        'expires_at' => gmdate('c', time() + 600),
    ];
}

// PHPMailer is loaded on demand by api_mail_send().

function password_reset_user_display_name(array $user): string
{
    $fullName = trim((string)($user['first_name'] ?? '') . ' ' . (string)($user['last_name'] ?? ''));
    return $fullName !== '' ? $fullName : trim((string)($user['email'] ?? ''));
}

function password_reset_send_email(string $email, string $code, array $user): void
{
    $displayName = password_reset_user_display_name($user);

    $result = api_mail_send([
        'to' => $email,
        'to_name' => $displayName,
        'from_name' => 'Password Reset',
        'subject' => 'Your password reset code',
        'log_event' => 'password_reset_code_send_failed',
        'heading' => 'Reset your password',
        'preheader' => 'Your password reset code expires in 10 minutes.',
        'greeting' => 'Hello ' . ($displayName !== '' ? $displayName : 'there') . ',',
        'intro' => ['Use the code below to reset your portal password.'],
        'code' => $code,
        'code_note' => 'This code expires in 10 minutes.',
        'note' => 'If you did not request a password reset you can ignore this email. '
            . 'If you do not see the message right away, check your spam or junk folder.',
        'alt' => 'Your password reset verification code is ' . $code
            . '. It expires in 10 minutes. Check spam or junk if you do not see it.',
    ]);

    // This endpoint's contract is to throw so the caller can surface a 5xx.
    if (empty($result['sent'])) {
        throw new RuntimeException(
            api_mail_user_friendly_error_message((string)($result['error'] ?? ''), api_mail_config('Password Reset'))
        );
    }
}

try {
    $payload = api_read_json_body();
    $email = trim((string)($payload['email'] ?? ''));

    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        api_json_response(400, ['message' => 'A valid email address is required']);
    }

    $db = new Database();
    $pdo = $db->connect();

    /*
     * Every request is counted against the browser and the network before the
     * account is looked up, so asking about addresses that have no account
     * costs exactly what asking about real ones does.
     *
     * These, and the per-recipient bucket below, exist because the only limit
     * this endpoint had was the 60-second cooldown - and that lives in the
     * session. A client that drops its cookie gets a new session with no
     * cooldown, so it could have the portal mail one address as often as the
     * flood throttle allowed, spending the Gmail quota that every other
     * password reset in the institution depends on.
     */
    $network = api_rate_limit_reserve($pdo, [
        ['reset_send_device', api_client_device_key()],
        ['reset_send_ip', api_client_ip()],
    ]);
    if (!$network['allowed']) {
        $refused = $network['refused'];
        $minutes = max(1, (int)ceil($refused['retry_after'] / 60));
        api_rate_limit_respond($refused, sprintf(
            'Too many password reset requests from this %s. Try again in %d minute%s.',
            $refused['bucket'] === 'reset_send_device' ? 'device' : 'network',
            $minutes,
            $minutes === 1 ? '' : 's'
        ), [
            // What ResetPasswordModal already counts the resend button down from.
            'cooldown_ends_at' => gmdate('c', time() + $refused['retry_after']),
        ]);
    }

    api_require_turnstile($payload, 'password_reset');

    if (!api_mail_service_is_configured()) {
        api_json_response(503, ['message' => api_mail_configuration_error_message('Password reset email service')]);
    }

    // Per recipient, and not sheddable with a cookie: this is the bucket that
    // stops one inbox being flooded however many devices ask.
    $recipient = password_reset_codes_normalize_email($email);
    $recipientHit = api_rate_limit_hit($pdo, 'reset_send_email', $recipient);
    if (!$recipientHit['allowed']) {
        $minutes = max(1, (int)ceil($recipientHit['retry_after'] / 60));
        api_rate_limit_respond($recipientHit, sprintf(
            'Too many verification codes have been requested for this email. Try again in %d minute%s.',
            $minutes,
            $minutes === 1 ? '' : 's'
        ), [
            'cooldown_ends_at' => gmdate('c', time() + $recipientHit['retry_after']),
        ]);
    }


    $stmt = $pdo->prepare(
        'SELECT user_id, first_name, last_name, email
         FROM user
         WHERE LOWER(REPLACE(REPLACE(TRIM(email), CHAR(13), \'\'), CHAR(10), \'\')) =
               LOWER(REPLACE(REPLACE(TRIM(:email), CHAR(13), \'\'), CHAR(10), \'\'))
         LIMIT 1'
    );
    $stmt->execute([':email' => $email]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        api_json_response(200, password_reset_public_receipt());
    }

    $email = trim((string)($user['email'] ?? $email));

    password_reset_codes_ensure_table($pdo);
    password_reset_codes_cleanup_expired($pdo);
    password_reset_verification_clear($email);

    $existingCode = password_reset_codes_fetch_latest($pdo, $email);
    $remainingCooldown = password_reset_codes_remaining_cooldown($existingCode);
    if ($remainingCooldown > 0) {
        api_json_response(200, password_reset_public_receipt());
    }

    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);
    password_reset_codes_delete_for_identity($pdo, (int)$user['user_id'], $email);
    $issuedCode = password_reset_codes_store($pdo, (int)$user['user_id'], $email, $code);

    try {
        password_reset_send_email($email, $code, $user);
    } catch (Throwable $throwable) {
        // A provider may have accepted the message before its response timed out.
        // Preserve the issued code and the recipient limit in that case.
        api_log_exception($throwable, ['endpoint' => 'send-reset-code.php', 'scope' => 'delivery_unconfirmed']);
        api_json_response(200, password_reset_public_receipt());
    }

    api_json_response(200, password_reset_public_receipt());
} catch (Throwable $throwable) {
    api_json_response(500, ['message' => 'Server error']);
}
