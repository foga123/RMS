<?php

// Password reset state is intentionally session-backed; do not add reset-table storage here.
const PASSWORD_RESET_CODE_TTL_SECONDS = 600;
const PASSWORD_RESET_CODE_COOLDOWN_SECONDS = 60;
const PASSWORD_RESET_CODE_MAX_ATTEMPTS = 5;
const PASSWORD_RESET_VERIFICATION_TTL_SECONDS = 600;

function password_reset_codes_normalize_email(string $email): string
{
    return strtolower(trim(str_replace(["\r", "\n"], '', $email)));
}

function password_reset_codes_session_keys(): array
{
    return [
        'reset_email',
        'reset_email_original',
        'reset_user_id',
        'reset_otp',
        'reset_otp_hash',
        'reset_otp_expiry',
        'reset_otp_created_at',
        'reset_attempt_count',
        'reset_code_id',
        'reset_verified',
        'reset_verified_at',
        'reset_verification_token_hash',
        'reset_verification_expiry',
    ];
}

function password_reset_codes_clear_session(): void
{
    api_start_session();

    foreach (password_reset_codes_session_keys() as $key) {
        unset($_SESSION[$key]);
    }
}

function password_reset_codes_session_row(): ?array
{
    api_start_session();

    $email = trim((string)($_SESSION['reset_email'] ?? ''));
    // Presence is judged by the hash, because the hash is now the only copy —
    // see password_reset_codes_store(). This used to test the plaintext, which
    // is why removing it has to change the guard too.
    $codeHash = (string)($_SESSION['reset_otp_hash'] ?? '');
    $expiresAt = (int)($_SESSION['reset_otp_expiry'] ?? 0);

    if ($email === '' || $codeHash === '' || $expiresAt <= 0) {
        return null;
    }

    return [
        'id' => (int)($_SESSION['reset_code_id'] ?? 1),
        'user_id' => (int)($_SESSION['reset_user_id'] ?? 0),
        'email' => (string)($_SESSION['reset_email_original'] ?? $email),
        'code_hash' => $codeHash,
        'attempt_count' => (int)($_SESSION['reset_attempt_count'] ?? 0),
        'expires_at' => gmdate('Y-m-d H:i:s', $expiresAt),
        'created_at' => gmdate('Y-m-d H:i:s', (int)($_SESSION['reset_otp_created_at'] ?? time())),
        'expires_at_unix' => $expiresAt,
        'created_at_unix' => (int)($_SESSION['reset_otp_created_at'] ?? time()),
    ];
}

function password_reset_codes_ensure_table(?PDO $pdo = null): void
{
    api_start_session();
}

function password_reset_codes_cleanup_expired(?PDO $pdo = null): void
{
    api_start_session();

    $row = password_reset_codes_session_row();
    if ($row && password_reset_codes_is_expired($row)) {
        password_reset_codes_clear_session();
        return;
    }

    $verificationExpiry = (int)($_SESSION['reset_verification_expiry'] ?? 0);
    if ($verificationExpiry > 0 && $verificationExpiry <= time()) {
        password_reset_verification_clear();
    }
}

function password_reset_codes_fetch_latest(?PDO $pdo, string $email): ?array
{
    $row = password_reset_codes_session_row();
    if (!$row) {
        return null;
    }

    if (password_reset_codes_normalize_email((string)$row['email']) !== password_reset_codes_normalize_email($email)) {
        return null;
    }

    return $row;
}

function password_reset_codes_fetch_by_id(?PDO $pdo, int $id): ?array
{
    $row = password_reset_codes_session_row();
    if (!$row || (int)$row['id'] !== $id) {
        return null;
    }

    return $row;
}

function password_reset_codes_delete_for_identity(?PDO $pdo, int $userId, string $email): void
{
    $row = password_reset_codes_session_row();
    if (!$row) {
        return;
    }

    $rowUserId = (int)($row['user_id'] ?? 0);
    $rowEmail = password_reset_codes_normalize_email((string)($row['email'] ?? ''));
    $requestedEmail = password_reset_codes_normalize_email($email);

    if (($userId > 0 && $rowUserId === $userId) || ($requestedEmail !== '' && $rowEmail === $requestedEmail)) {
        password_reset_codes_clear_session();
    }
}

function password_reset_codes_store(?PDO $pdo, int $userId, string $email, string $code): array
{
    api_start_session();

    $now = time();
    $codeId = random_int(1, PHP_INT_MAX);

    $_SESSION['reset_email'] = password_reset_codes_normalize_email($email);
    $_SESSION['reset_email_original'] = trim($email);
    $_SESSION['reset_user_id'] = $userId;
    /*
     * The hash is the only copy kept.
     *
     * This used to store $_SESSION['reset_otp'] = $code alongside the hash,
     * which made the hash decorative: session data is a plain file in
     * session.save_path, and on this deployment that is C:\xampp\tmp — shared,
     * readable, and (until the gc fix) holding files for days. Anyone who could
     * read one had the live six-digit code for an account they had not
     * authenticated to, and the reset flow hands over a password change.
     *
     * Nothing needs the plaintext after this point. send-reset-code.php emails
     * it from its own local $code, and verification is password_verify()
     * against this hash.
     */
    $_SESSION['reset_otp_hash'] = password_hash($code, PASSWORD_DEFAULT);
    // Any plaintext left by a session created before this change.
    unset($_SESSION['reset_otp']);
    $_SESSION['reset_otp_expiry'] = $now + PASSWORD_RESET_CODE_TTL_SECONDS;
    $_SESSION['reset_otp_created_at'] = $now;
    $_SESSION['reset_attempt_count'] = 0;
    $_SESSION['reset_code_id'] = $codeId;
    $_SESSION['reset_verified'] = false;
    unset(
        $_SESSION['reset_verified_at'],
        $_SESSION['reset_verification_token_hash'],
        $_SESSION['reset_verification_expiry']
    );

    return password_reset_codes_session_row() ?? [
        'id' => $codeId,
        'user_id' => $userId,
        'email' => $email,
        'code_hash' => $_SESSION['reset_otp_hash'],
        'attempt_count' => 0,
        'expires_at' => gmdate('Y-m-d H:i:s', $now + PASSWORD_RESET_CODE_TTL_SECONDS),
        'created_at' => gmdate('Y-m-d H:i:s', $now),
        'expires_at_unix' => $now + PASSWORD_RESET_CODE_TTL_SECONDS,
        'created_at_unix' => $now,
    ];
}

function password_reset_codes_row_unix(array $row, string $key): ?int
{
    $value = $row[$key] ?? null;
    if ($value === null || $value === '') {
        return null;
    }

    return (int)$value;
}

function password_reset_codes_expires_at_unix(array $row): ?int
{
    return password_reset_codes_row_unix($row, 'expires_at_unix');
}

function password_reset_codes_created_at_unix(array $row): ?int
{
    return password_reset_codes_row_unix($row, 'created_at_unix');
}

function password_reset_codes_is_expired(array $row): bool
{
    $expiresAt = password_reset_codes_expires_at_unix($row);
    return !$expiresAt || $expiresAt <= time();
}

function password_reset_codes_cooldown_ends_at(?array $row): ?int
{
    if (!$row) {
        return null;
    }

    $createdAt = password_reset_codes_created_at_unix($row);
    if (!$createdAt) {
        return null;
    }

    return $createdAt + PASSWORD_RESET_CODE_COOLDOWN_SECONDS;
}

function password_reset_codes_remaining_cooldown(?array $row): int
{
    $cooldownEndsAt = password_reset_codes_cooldown_ends_at($row);
    if (!$cooldownEndsAt) {
        return 0;
    }

    return max(0, $cooldownEndsAt - time());
}

function password_reset_codes_expires_at_iso(?array $row): ?string
{
    if (!$row) {
        return null;
    }

    $expiresAt = password_reset_codes_expires_at_unix($row);
    return $expiresAt ? gmdate('c', $expiresAt) : null;
}

function password_reset_codes_cooldown_ends_at_iso(?array $row): ?string
{
    $cooldownEndsAt = password_reset_codes_cooldown_ends_at($row);
    return $cooldownEndsAt ? gmdate('c', $cooldownEndsAt) : null;
}

/**
 * Hash comparison only.
 *
 * There used to be a fallback here that compared $row['code'] directly when no
 * hash was present. Nothing can populate that key any more — the plaintext is
 * no longer stored — so the branch was unreachable in the good case and a way
 * to accept a plaintext-bearing session in the bad one. A row without a hash is
 * now simply not verifiable, which is the correct answer.
 */
function password_reset_codes_verify(string $code, array $row): bool
{
    $storedHash = trim((string)($row['code_hash'] ?? ''));
    if ($storedHash === '') {
        return false;
    }

    return password_verify($code, $storedHash);
}

function password_reset_codes_increment_attempt(?PDO $pdo, int $id): int
{
    api_start_session();

    $row = password_reset_codes_session_row();
    if (!$row || (int)$row['id'] !== $id) {
        return 0;
    }

    $attemptCount = (int)($_SESSION['reset_attempt_count'] ?? 0) + 1;
    $_SESSION['reset_attempt_count'] = $attemptCount;

    return $attemptCount;
}

function password_reset_verification_clear(?string $email = null): void
{
    api_start_session();

    if ($email !== null) {
        $sessionEmail = password_reset_codes_normalize_email((string)($_SESSION['reset_email'] ?? ''));
        if ($sessionEmail !== password_reset_codes_normalize_email($email)) {
            return;
        }
    }

    $_SESSION['reset_verified'] = false;
    unset(
        $_SESSION['reset_verified_at'],
        $_SESSION['reset_verification_token_hash'],
        $_SESSION['reset_verification_expiry']
    );
}

function password_reset_verification_issue(string $email, array $row): array
{
    api_start_session();

    $expiresAt = password_reset_codes_expires_at_unix($row);
    if (!$expiresAt || $expiresAt <= time()) {
        throw new RuntimeException('Cannot issue verification for an expired reset code.');
    }

    $verifiedUntil = min($expiresAt, time() + PASSWORD_RESET_VERIFICATION_TTL_SECONDS);
    $token = bin2hex(random_bytes(24));

    $_SESSION['reset_verified'] = true;
    $_SESSION['reset_verified_at'] = time();
    $_SESSION['reset_verification_token_hash'] = hash('sha256', $token);
    $_SESSION['reset_verification_expiry'] = $verifiedUntil;

    return [
        'verification_token' => $token,
        'verification_expires_at' => gmdate('c', $verifiedUntil),
        'verified' => true,
    ];
}

function password_reset_verification_get(string $email, string $token): ?array
{
    api_start_session();

    if (empty($_SESSION['reset_verified'])) {
        return null;
    }

    $expiresAt = (int)($_SESSION['reset_verification_expiry'] ?? 0);
    if ($expiresAt <= time()) {
        password_reset_verification_clear();
        return null;
    }

    if (password_reset_codes_normalize_email((string)($_SESSION['reset_email'] ?? '')) !== password_reset_codes_normalize_email($email)) {
        return null;
    }

    $expectedHash = (string)($_SESSION['reset_verification_token_hash'] ?? '');
    if ($expectedHash === '' || !hash_equals($expectedHash, hash('sha256', $token))) {
        return null;
    }

    return [
        'email' => (string)($_SESSION['reset_email'] ?? ''),
        'code_id' => (int)($_SESSION['reset_code_id'] ?? 0),
        'user_id' => (int)($_SESSION['reset_user_id'] ?? 0),
        'verified_at' => (int)($_SESSION['reset_verified_at'] ?? 0),
        'expires_at' => $expiresAt,
    ];
}
