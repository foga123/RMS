<?php

require_once __DIR__ . '/middleware/auth.php';

api_start_session();
api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

/*
 * Called by hand because nothing else here would call it.
 *
 * The flood throttle runs from api_bootstrap_auth(), which runs when
 * connection-pdo.php is included - and this endpoint needs no database, so it
 * never includes it. That made it the one anonymous endpoint with no flood
 * control at all (no RateLimit-* headers on the wire, where its two siblings
 * had them). Each code still allows only five guesses; this bounds how fast
 * anyone can ask.
 */
api_throttle_request('verify-reset-code.php');

require_once __DIR__ . '/password_reset_codes.php';

try {
    $payload = api_read_json_body();

    $email = trim((string)($payload['email'] ?? ''));
    $code = trim((string)($payload['code'] ?? ''));

    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        api_json_response(400, ['message' => 'A valid email address is required']);
    }

    if (!preg_match('/^\d{6}$/', $code)) {
        api_json_response(400, ['message' => 'Enter the 6-digit verification code']);
    }

    password_reset_codes_ensure_table();
    password_reset_codes_cleanup_expired();

    $row = password_reset_codes_fetch_latest(null, $email);
    if (!$row) {
        password_reset_verification_clear($email);
        api_json_response(400, ['message' => 'Request a new verification code before continuing']);
    }

    if (password_reset_codes_is_expired($row)) {
        password_reset_codes_delete_for_identity(null, (int)($row['user_id'] ?? 0), $email);
        password_reset_verification_clear($email);
        api_json_response(400, ['message' => 'Verification code expired. Request a new code and try again.']);
    }

    $attemptCount = (int)($row['attempt_count'] ?? 0);
    if ($attemptCount >= PASSWORD_RESET_CODE_MAX_ATTEMPTS) {
        password_reset_codes_delete_for_identity(null, (int)($row['user_id'] ?? 0), $email);
        password_reset_verification_clear($email);
        api_json_response(429, ['message' => 'Too many incorrect verification attempts. Request a new code and try again.']);
    }

    if (!password_reset_codes_verify($code, $row)) {
        $attemptCount = password_reset_codes_increment_attempt(null, (int)$row['id']);
        password_reset_verification_clear($email);

        if ($attemptCount >= PASSWORD_RESET_CODE_MAX_ATTEMPTS) {
            password_reset_codes_delete_for_identity(null, (int)($row['user_id'] ?? 0), $email);
            api_json_response(429, ['message' => 'Too many incorrect verification attempts. Request a new code and try again.']);
        }

        $remainingAttempts = PASSWORD_RESET_CODE_MAX_ATTEMPTS - $attemptCount;
        $attemptLabel = $remainingAttempts === 1 ? 'attempt' : 'attempts';
        api_json_response(422, [
            'message' => 'Incorrect verification code. ' . $remainingAttempts . ' ' . $attemptLabel . ' remaining.',
        ]);
    }

    $verification = password_reset_verification_issue($email, $row);

    api_json_response(200, [
        'message' => 'Verification code confirmed. You can now reset your password.',
        'verification' => $verification,
        'expires_at' => password_reset_codes_expires_at_iso($row),
    ]);
} catch (Throwable $throwable) {
    api_json_response(500, ['message' => 'Server error']);
}
