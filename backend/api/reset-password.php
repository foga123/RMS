<?php

require_once __DIR__ . '/middleware/auth.php';

api_start_session();
api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/middleware/auth_tokens.php';
require_once __DIR__ . '/password_reset_codes.php';

function password_reset_resolve_verified_code_row(PDO $pdo, string $email, array $payload): array
{
    $verificationToken = trim((string)($payload['verification_token'] ?? ''));
    $code = trim((string)($payload['code'] ?? ''));

    if ($verificationToken !== '') {
        $verification = password_reset_verification_get($email, $verificationToken);
        if (!$verification) {
            api_json_response(400, ['message' => 'Verify your latest code again before resetting your password.']);
        }

        $row = password_reset_codes_fetch_by_id($pdo, (int)($verification['code_id'] ?? 0));
        if (
            !$row
            || password_reset_codes_normalize_email((string)($row['email'] ?? '')) !== password_reset_codes_normalize_email($email)
        ) {
            password_reset_verification_clear($email);
            api_json_response(400, ['message' => 'Request a new verification code before resetting your password.']);
        }

        if (password_reset_codes_is_expired($row)) {
            password_reset_codes_delete_for_identity($pdo, (int)($row['user_id'] ?? 0), $email);
            password_reset_verification_clear($email);
            api_json_response(400, ['message' => 'Verification code expired. Request a new code and try again.']);
        }

        return $row;
    }

    if (!preg_match('/^\d{6}$/', $code)) {
        api_json_response(400, ['message' => 'Enter the 6-digit verification code']);
    }

    $row = password_reset_codes_fetch_latest($pdo, $email);
    if (!$row) {
        api_json_response(400, ['message' => 'Request a new verification code before resetting your password.']);
    }

    if (password_reset_codes_is_expired($row)) {
        password_reset_codes_delete_for_identity($pdo, (int)($row['user_id'] ?? 0), $email);
        password_reset_verification_clear($email);
        api_json_response(400, ['message' => 'Verification code expired. Request a new code and try again.']);
    }

    $attemptCount = (int)($row['attempt_count'] ?? 0);
    if ($attemptCount >= PASSWORD_RESET_CODE_MAX_ATTEMPTS) {
        password_reset_codes_delete_for_identity($pdo, (int)($row['user_id'] ?? 0), $email);
        password_reset_verification_clear($email);
        api_json_response(429, ['message' => 'Too many incorrect verification attempts. Request a new code and try again.']);
    }

    if (!password_reset_codes_verify($code, $row)) {
        $attemptCount = password_reset_codes_increment_attempt($pdo, (int)$row['id']);
        password_reset_verification_clear($email);

        if ($attemptCount >= PASSWORD_RESET_CODE_MAX_ATTEMPTS) {
            password_reset_codes_delete_for_identity($pdo, (int)($row['user_id'] ?? 0), $email);
            api_json_response(429, ['message' => 'Too many incorrect verification attempts. Request a new code and try again.']);
        }

        $remainingAttempts = PASSWORD_RESET_CODE_MAX_ATTEMPTS - $attemptCount;
        $attemptLabel = $remainingAttempts === 1 ? 'attempt' : 'attempts';
        api_json_response(422, [
            'message' => 'Incorrect verification code. ' . $remainingAttempts . ' ' . $attemptLabel . ' remaining.',
        ]);
    }

    return $row;
}

try {
    $payload = api_read_json_body();

    $email = trim((string)($payload['email'] ?? ''));
    $newPassword = (string)($payload['new_password'] ?? '');

    if ($email === '' || $newPassword === '') {
        api_json_response(400, ['message' => 'Email and new password are required']);
    }

    if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
        api_json_response(400, ['message' => 'A valid email address is required']);
    }

    // Server-side password complexity enforcement (Fix #8)
    $passwordError = api_validate_password_strength($newPassword);
    if ($passwordError !== null) {
        api_json_response(400, ['message' => $passwordError]);
    }

    $db = new Database();
    $pdo = $db->connect();

    password_reset_codes_ensure_table($pdo);
    password_reset_codes_cleanup_expired($pdo);

    $row = password_reset_resolve_verified_code_row($pdo, $email, $payload);

    $userId = (int)($row['user_id'] ?? 0);
    if ($userId <= 0) {
        $userStmt = $pdo->prepare(
            'SELECT user_id
             FROM user
             WHERE LOWER(REPLACE(REPLACE(TRIM(email), CHAR(13), \'\'), CHAR(10), \'\')) =
                   LOWER(REPLACE(REPLACE(TRIM(:email), CHAR(13), \'\'), CHAR(10), \'\'))
             LIMIT 1'
        );
        $userStmt->execute([':email' => $email]);
        $userRow = $userStmt->fetch(PDO::FETCH_ASSOC);
        if (!$userRow) {
            api_json_response(404, ['message' => 'User not found']);
        }

        $userId = (int)$userRow['user_id'];
    }

    /*
     * A reset must not quietly re-set the password already in use.
     *
     * change-password.php can compare the two plaintexts because it asks for
     * the current one. This flow never does — the account is proved by the
     * emailed code — so the only way to tell is to check the new password
     * against what is stored.
     */
    $currentStmt = $pdo->prepare('SELECT password FROM user WHERE user_id = :user_id LIMIT 1');
    $currentStmt->execute([':user_id' => $userId]);
    $currentPasswordHash = (string)($currentStmt->fetchColumn() ?: '');

    if (api_password_matches_stored($currentPasswordHash, $newPassword)) {
        api_json_response(400, ['message' => 'New password must be different from the current password']);
    }

    $update = $pdo->prepare('UPDATE user SET password = :password WHERE user_id = :user_id LIMIT 1');
    $update->execute([
        ':password' => password_hash($newPassword, PASSWORD_DEFAULT),
        ':user_id' => $userId,
    ]);
    api_password_expiration_record_password_changed($pdo, $userId);

    /*
     * The reason this matters more here than on change-password.php: a reset is
     * the flow someone runs precisely because the account may already be in the
     * wrong hands. Leaving the attacker's live token and week-long refresh cookie
     * working would make the reset a formality — the legitimate owner regains the
     * password while the intruder keeps the session.
     *
     * No token is re-issued: this caller is anonymous by construction, and they
     * sign in with the new password like anyone else.
     */
    api_auth_revoke_all_sessions($pdo, $userId);

    password_reset_codes_delete_for_identity($pdo, $userId, $email);
    password_reset_verification_clear($email);

    api_json_response(200, ['message' => 'Password updated']);
} catch (Throwable $throwable) {
    api_json_response(500, ['message' => 'Server error']);
}
