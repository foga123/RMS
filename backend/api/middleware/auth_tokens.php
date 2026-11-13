<?php
/**
 * The stateful half of the token layer: the refresh-token store and its cookie.
 *
 * jwt.php is deliberately pure — it turns a user id into a signed string and
 * back. This file is everything that has to touch the database or the response,
 * which is the half that makes revocation possible at all.
 *
 * login.php, refresh.php and logout.php issue and withdraw tokens through here;
 * change-password.php, reset-password.php and user.php reach for
 * api_auth_revoke_all_sessions() when a credential stops being trusted.
 */

require_once __DIR__ . '/jwt.php';

/** Sent to the whole origin, matching the session cookie's path. */
const API_REFRESH_COOKIE = 'CAPSTONE_REFRESH';

/**
 * Issue a refresh token and record its hash.
 *
 * `$familyId` continues an existing rotation chain; omitting it starts a new
 * one, which is what a fresh login does.
 */
function api_refresh_token_issue(PDO $pdo, int $userId, ?string $familyId = null): string
{
    $token = api_refresh_token_generate();
    $stmt = $pdo->prepare(
        'INSERT INTO auth_refresh_token (user_id, token_hash, family_id, expires_at, user_agent)
         VALUES (:user_id, :token_hash, :family_id, :expires_at, :user_agent)'
    );
    $stmt->execute([
        ':user_id' => $userId,
        ':token_hash' => api_refresh_token_hash($token),
        ':family_id' => $familyId ?? api_refresh_token_family_id(),
        ':expires_at' => gmdate('Y-m-d H:i:s', time() + API_JWT_REFRESH_TTL),
        // Truncated to the column width rather than left to MySQL, which would
        // either warn or silently cut depending on strict mode.
        ':user_agent' => mb_substr((string)($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 190),
    ]);

    return $token;
}

/**
 * Validate a refresh token and rotate it, or return null.
 *
 * Rotation means the presented token is spent and a fresh one takes its place
 * in the same family. That is what makes theft detectable: a stolen token can
 * be used once, but the moment either party presents an already-spent link, the
 * whole family is revoked and both are logged out. Silent coexistence — the
 * outcome if tokens were merely long-lived and reusable — is the thing being
 * traded away here, and it is worth trading.
 *
 * Returns ['user_id' => int, 'token' => string] on success.
 */
function api_refresh_token_consume(PDO $pdo, string $token): ?array
{
    if ($token === '') {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT token_id, user_id, family_id, expires_at, revoked_at
           FROM auth_refresh_token WHERE token_hash = :token_hash LIMIT 1'
    );
    $stmt->execute([':token_hash' => api_refresh_token_hash($token)]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        return null;
    }

    // Already spent or explicitly revoked. Presenting one of these means either
    // a replay or a stolen chain, and there is no way to tell which from here —
    // so the whole family goes, which logs out the thief and the victim alike.
    // An inconvenient logout is the correct outcome; leaving a live chain in an
    // attacker's hands is not.
    if ($row['revoked_at'] !== null) {
        api_refresh_token_revoke_family($pdo, (string)$row['family_id']);
        return null;
    }

    if (strtotime((string)$row['expires_at']) <= time()) {
        return null;
    }

    $pdo->prepare('UPDATE auth_refresh_token SET revoked_at = UTC_TIMESTAMP() WHERE token_id = :id')
        ->execute([':id' => (int)$row['token_id']]);

    return [
        'user_id' => (int)$row['user_id'],
        'token' => api_refresh_token_issue($pdo, (int)$row['user_id'], (string)$row['family_id']),
    ];
}

/** Revoke one token by its plaintext value. Used by logout. */
function api_refresh_token_revoke(PDO $pdo, string $token): void
{
    if ($token === '') {
        return;
    }

    $pdo->prepare(
        'UPDATE auth_refresh_token SET revoked_at = UTC_TIMESTAMP()
          WHERE token_hash = :token_hash AND revoked_at IS NULL'
    )->execute([':token_hash' => api_refresh_token_hash($token)]);
}

/** Revoke a whole rotation chain — the response to a replayed token. */
function api_refresh_token_revoke_family(PDO $pdo, string $familyId): void
{
    $pdo->prepare(
        'UPDATE auth_refresh_token SET revoked_at = UTC_TIMESTAMP()
          WHERE family_id = :family_id AND revoked_at IS NULL'
    )->execute([':family_id' => $familyId]);
}

/**
 * Revoke every refresh token a user holds — "sign out everywhere".
 *
 * Pair this with bumping user.token_version when the reason is a credential
 * change: this closes the 7-day half, the version bump closes the 15-minute
 * half, and only both together end every live session immediately.
 */
function api_refresh_token_revoke_all_for_user(PDO $pdo, int $userId): void
{
    $pdo->prepare(
        'UPDATE auth_refresh_token SET revoked_at = UTC_TIMESTAMP()
          WHERE user_id = :user_id AND revoked_at IS NULL'
    )->execute([':user_id' => $userId]);
}

/**
 * End every live session for a user, on both halves at once.
 *
 * The two stores expire on very different clocks, and stopping at either one
 * leaves a real hole: revoking only the refresh tokens still lets a stolen
 * access token work for up to fifteen minutes, and bumping only the version
 * still lets a week-old refresh cookie mint a brand new one. Callers that mean
 * "this credential is no longer trusted" want both, so they get one function
 * rather than a pair they might half-remember.
 *
 * Returns the new token_version, which the caller needs when it is re-issuing a
 * token for the session that triggered this — a password change signs out the
 * user's *other* devices, not the tab they are typing in.
 *
 * The column guard is not decoration: api_user_table_has_token_version_column()
 * exists because the migration is idempotent and may not have run yet, and a
 * revocation path that fatals on an un-migrated database would turn a password
 * change into a 500.
 */
function api_auth_revoke_all_sessions(PDO $pdo, int $userId): int
{
    api_refresh_token_revoke_all_for_user($pdo, $userId);

    if (!function_exists('api_user_table_has_token_version_column')
        || !api_user_table_has_token_version_column($pdo)) {
        return 0;
    }

    $pdo->prepare(
        'UPDATE user SET token_version = token_version + 1 WHERE user_id = :user_id LIMIT 1'
    )->execute([':user_id' => $userId]);

    $stmt = $pdo->prepare('SELECT token_version FROM user WHERE user_id = :user_id LIMIT 1');
    $stmt->execute([':user_id' => $userId]);

    return (int)$stmt->fetchColumn();
}

/**
 * Drop rows that are long dead.
 *
 * Kept well past expiry on purpose: a spent token has to stay recognisable for
 * the replay check above to work at all. A week past expiry is far longer than
 * any realistic replay and keeps the table from growing without bound.
 */
function api_refresh_token_prune(PDO $pdo): void
{
    $pdo->exec(
        'DELETE FROM auth_refresh_token
          WHERE expires_at < (UTC_TIMESTAMP() - INTERVAL 7 DAY)'
    );
}

/** Same hardening as the session cookie: httpOnly, SameSite=Strict, secure on HTTPS. */
function api_refresh_cookie_set(string $token): void
{
    setcookie(API_REFRESH_COOKIE, $token, [
        'expires' => time() + API_JWT_REFRESH_TTL,
        'path' => '/',
        'secure' => api_request_is_secure(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
}

function api_refresh_cookie_get(): string
{
    return (string)($_COOKIE[API_REFRESH_COOKIE] ?? '');
}

function api_refresh_cookie_clear(): void
{
    setcookie(API_REFRESH_COOKIE, '', [
        'expires' => time() - 42000,
        'path' => '/',
        'secure' => api_request_is_secure(),
        'httponly' => true,
        'samesite' => 'Strict',
    ]);
    unset($_COOKIE[API_REFRESH_COOKIE]);
}

/**
 * Mirrors the detection api_start_session() already does, so the two cookies
 * cannot disagree about whether the connection is secure.
 */
function api_request_is_secure(): bool
{
    return (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['SERVER_PORT']) && (string)$_SERVER['SERVER_PORT'] === '443')
        || (function_exists('api_https_forced') && api_https_forced());
}
