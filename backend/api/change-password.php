<?php

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/middleware/auth_tokens.php';
require_once __DIR__ . '/mail_config.php';
require_once __DIR__ . '/mail_template.php';

api_send_headers(['GET', 'POST', 'OPTIONS']);
api_handle_preflight();

// ---------------------------------------------------------------------------
// Email verification code for a password change.
// Deliberately uses its OWN session keys rather than the password-reset ones in
// password_reset_codes.php: a logged-in change and a logged-out reset can be in
// flight at the same time and must not clobber each other.
// ---------------------------------------------------------------------------

const CHANGE_PW_OTP_TTL = 600;        // code valid for 10 minutes
const CHANGE_PW_OTP_COOLDOWN = 60;    // min seconds between sends
const CHANGE_PW_OTP_MAX_ATTEMPTS = 5;

function change_password_otp_clear(): void
{
    api_start_session();
    foreach (['cpw_otp_hash', 'cpw_otp_expires', 'cpw_otp_sent_at', 'cpw_otp_attempts', 'cpw_otp_user'] as $key) {
        unset($_SESSION[$key]);
    }
}

function change_password_otp_remaining_cooldown(): int
{
    api_start_session();
    $sentAt = (int)($_SESSION['cpw_otp_sent_at'] ?? 0);
    if ($sentAt <= 0) {
        return 0;
    }
    $elapsed = time() - $sentAt;
    return $elapsed >= CHANGE_PW_OTP_COOLDOWN ? 0 : (CHANGE_PW_OTP_COOLDOWN - $elapsed);
}

function change_password_otp_issue(int $userId): string
{
    api_start_session();
    $code = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);

    $_SESSION['cpw_otp_hash'] = password_hash($code, PASSWORD_DEFAULT);
    $_SESSION['cpw_otp_expires'] = time() + CHANGE_PW_OTP_TTL;
    $_SESSION['cpw_otp_sent_at'] = time();
    $_SESSION['cpw_otp_attempts'] = 0;
    $_SESSION['cpw_otp_user'] = $userId;

    return $code;
}

/** @return array{ok:bool,message:?string} */
function change_password_otp_check(int $userId, string $code): array
{
    api_start_session();

    $hash = (string)($_SESSION['cpw_otp_hash'] ?? '');
    $expires = (int)($_SESSION['cpw_otp_expires'] ?? 0);
    $owner = (int)($_SESSION['cpw_otp_user'] ?? 0);

    if ($hash === '' || $expires <= 0) {
        return ['ok' => false, 'message' => 'Request a verification code first.'];
    }
    if ($owner !== $userId) {
        change_password_otp_clear();
        return ['ok' => false, 'message' => 'Request a verification code first.'];
    }
    if (time() > $expires) {
        change_password_otp_clear();
        return ['ok' => false, 'message' => 'That verification code has expired. Request a new one.'];
    }

    $attempts = (int)($_SESSION['cpw_otp_attempts'] ?? 0);
    if ($attempts >= CHANGE_PW_OTP_MAX_ATTEMPTS) {
        change_password_otp_clear();
        return ['ok' => false, 'message' => 'Too many incorrect codes. Request a new one.'];
    }

    if (!password_verify($code, $hash)) {
        $_SESSION['cpw_otp_attempts'] = $attempts + 1;
        $left = CHANGE_PW_OTP_MAX_ATTEMPTS - ($attempts + 1);
        return [
            'ok' => false,
            'message' => $left > 0
                ? "That verification code is incorrect. $left attempt" . ($left === 1 ? '' : 's') . ' left.'
                : 'That verification code is incorrect.',
        ];
    }

    return ['ok' => true, 'message' => null];
}

function change_password_otp_send(string $email, string $displayName, string $code): array
{
    return api_mail_send([
        'to' => $email,
        'to_name' => $displayName !== '' ? $displayName : $email,
        'from_name' => 'Student Portal',
        'subject' => 'Your password change verification code',
        'log_event' => 'change_password_otp_failed',
        'heading' => 'Confirm your password change',
        'preheader' => 'Your password change code expires in 10 minutes.',
        'greeting' => 'Hello ' . ($displayName !== '' ? $displayName : 'there') . ',',
        'intro' => ['Enter this code on the change password screen to confirm the update.'],
        'code' => $code,
        'code_note' => 'This code expires in 10 minutes and can only be used once.',
        'note' => 'If you did not request this, someone may have your password. '
            . 'Contact your department office right away.',
        'alt' => "Use this code to confirm your password change: $code\n"
            . "It expires in 10 minutes.\n"
            . "If you did not request this, contact your department office.\n",
    ]);
}

/**
 * Thin wrapper kept for readability at the call site. The hash-format handling
 * lives in api_password_matches_stored() so this file, reset-password.php and
 * login.php cannot drift on which formats they accept — this was the third
 * copy of that bcrypt-or-legacy-SHA-256 branch.
 */
function change_password_verify_current(string $storedPassword, string $inputPassword): bool
{
    return api_password_matches_stored($storedPassword, $inputPassword);
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $sessionUser = api_get_session_user();
    if (!$sessionUser || empty($sessionUser['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();
    $userId = (int)$sessionUser['user_id'];

    if ($method === 'GET') {
        api_json_response(200, [
            'message' => 'Password change status loaded.',
            'password_expiration' => api_password_expiration_status_for_user_id($pdo, $userId),
        ]);
    }

    if ($method !== 'POST') {
        api_json_response(405, ['message' => 'Method not allowed']);
    }

    $payload = api_read_json_body();

    // ---- action: email a verification code -------------------------------
    if (($payload['action'] ?? '') === 'send_code') {
        $cooldown = change_password_otp_remaining_cooldown();
        if ($cooldown > 0) {
            header('Retry-After: ' . $cooldown);
            api_json_response(429, [
                'message' => "Please wait {$cooldown}s before requesting another code.",
                'cooldown_seconds' => $cooldown,
            ]);
        }

        $stmt = $pdo->prepare('SELECT first_name, last_name, email FROM user WHERE user_id = :id LIMIT 1');
        $stmt->execute([':id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        $email = trim((string)($row['email'] ?? ''));
        if ($email === '') {
            api_json_response(422, ['message' => 'Your account has no email address on file.']);
        }

        /*
         * The cooldown above is kept in the session, and a session is shed by
         * dropping one cookie. This bucket is keyed on the account instead,
         * which a caller cannot rotate, so it holds whatever the client does
         * with its cookies.
         */
        $sendHit = api_rate_limit_hit($pdo, 'password_otp_user', (string)$userId);
        if (!$sendHit['allowed']) {
            $minutes = max(1, (int)ceil($sendHit['retry_after'] / 60));
            api_rate_limit_respond($sendHit, sprintf(
                'Too many verification codes requested. Try again in %d minute%s.',
                $minutes,
                $minutes === 1 ? '' : 's'
            ), [
                // What ChangePasswordForm already counts the resend button down from.
                'cooldown_seconds' => $sendHit['retry_after'],
            ]);
        }

        $code = change_password_otp_issue($userId);
        $name = trim(((string)($row['first_name'] ?? '')) . ' ' . ((string)($row['last_name'] ?? '')));
        $result = change_password_otp_send($email, $name, $code);

        if (empty($result['sent'])) {
            // Do not leave a code armed that the user never received, or count
            // a send that never happened.
            change_password_otp_clear();
            api_rate_limit_refund($pdo, 'password_otp_user', (string)$userId);
            api_json_response(502, [
                'message' => 'Could not send the verification code. ' . (string)($result['error'] ?? ''),
            ]);
        }

        // Only the masked address goes back to the client.
        $masked = preg_replace('/^(.).*(@.*)$/', '$1***$2', $email);
        api_json_response(200, [
            'message' => 'Verification code sent.',
            'sent_to' => $masked,
            'expires_in' => CHANGE_PW_OTP_TTL,
            'cooldown_seconds' => CHANGE_PW_OTP_COOLDOWN,
        ]);
    }

    $currentPassword = (string)($payload['current_password'] ?? '');
    $newPassword = (string)($payload['new_password'] ?? '');
    $confirmPassword = (string)($payload['confirm_password'] ?? $newPassword);
    $otpCode = trim((string)($payload['otp'] ?? $payload['code'] ?? ''));

    if ($currentPassword === '' || $newPassword === '') {
        api_json_response(400, ['message' => 'Current password and new password are required']);
    }
    if ($newPassword !== $confirmPassword) {
        api_json_response(400, ['message' => 'Passwords do not match']);
    }
    if (hash_equals($currentPassword, $newPassword)) {
        api_json_response(400, ['message' => 'New password must be different from the current password']);
    }

    $passwordError = api_validate_password_strength($newPassword);
    if ($passwordError !== null) {
        api_json_response(400, ['message' => $passwordError]);
    }

    $stmt = $pdo->prepare(api_build_user_context_query($pdo, true) . ' WHERE u.user_id = :user_id LIMIT 1');
    $stmt->execute([':user_id' => $userId]);
    $userRow = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$userRow) {
        api_json_response(404, ['message' => 'User not found']);
    }

    if (!change_password_verify_current((string)($userRow['password'] ?? ''), $currentPassword)) {
        api_json_response(422, ['message' => 'Current password is incorrect']);
    }

    // Verified last, so a wrong current password never burns an OTP attempt.
    if ($otpCode === '') {
        api_json_response(400, [
            'message' => 'Enter the verification code we emailed you.',
            'otp_required' => true,
        ]);
    }
    $otpCheck = change_password_otp_check($userId, $otpCode);
    if (empty($otpCheck['ok'])) {
        api_json_response(422, [
            'message' => (string)$otpCheck['message'],
            'otp_required' => true,
        ]);
    }

    $update = $pdo->prepare('UPDATE user SET password = :password WHERE user_id = :user_id LIMIT 1');
    $update->execute([
        ':password' => password_hash($newPassword, PASSWORD_DEFAULT),
        ':user_id' => $userId,
    ]);

    // Single-use: the code cannot be replayed for a second change.
    change_password_otp_clear();

    /*
     * Changing the password ends every session that was opened with the old one.
     * Whoever knew the previous password — including whoever prompted this change
     * by getting hold of it — loses access at once rather than keeping a token
     * for another fifteen minutes and a refresh cookie for another week.
     *
     * The tab doing the changing is then handed a fresh pair, so "sign out
     * everywhere" does not mean "including the person who just proved they know
     * both passwords".
     */
    $tokenVersion = api_auth_revoke_all_sessions($pdo, $userId);

    $expiration = api_password_expiration_record_password_changed($pdo, $userId);
    $freshUser = api_fetch_user_context($pdo, $userId, false);
    $session = $freshUser ? api_store_authenticated_user($freshUser, false) : api_get_session_user();

    $access = api_jwt_issue_access_token($userId, $tokenVersion);
    api_refresh_cookie_set(api_refresh_token_issue($pdo, $userId));

    api_notifications_try_create($pdo, [
        'event_key' => 'password_changed_personal',
        'level' => 'success',
        'title' => 'Password changed',
        'message' => 'Your password was updated successfully.',
        'entity_type' => 'user',
        'entity_id' => $userId,
        'actor_user_id' => $userId,
        'toast' => true,
        'target' => [
            'overlay' => 'profile',
        ],
        'metadata' => [
            'user_id' => $userId,
            'password_expires_at' => $expiration['expires_at'] ?? null,
        ],
        'recipients' => [
            'user_ids' => [$userId],
        ],
    ], [
        'endpoint' => 'change-password.php',
        'event_key' => 'password_changed_personal',
        'user_id' => $userId,
    ]);

    api_json_response(200, [
        'message' => 'Password changed successfully.',
        'user' => $session,
        'password_expiration' => $expiration,
        'access_token' => $access['token'],
        'token_type' => 'Bearer',
        'expires_in' => $access['expires_in'],
    ]);
} catch (Throwable $throwable) {
    api_log_exception($throwable, [
        'endpoint' => 'change-password.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'POST',
    ]);
    api_json_response(500, ['message' => 'Server error']);
}
