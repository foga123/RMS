<?php

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

// Read the caller before destroying anything, or the audit row below has nobody's
// name on it.
$sessionUser = api_get_session_user();

/*
 * Revoke the refresh token as well as the session.
 *
 * Without this, logging out would leave a week-long credential sitting in the
 * browser that could mint fresh access tokens indefinitely — the session would
 * be gone and the account would still be reachable. Best-effort: a database
 * failure must not stop the session from being destroyed below, because a
 * logout that half-fails should still log you out locally.
 */
try {
    require_once __DIR__ . '/middleware/auth_tokens.php';
    $tokenPdo = null;
    $refreshToken = api_refresh_cookie_get();
    if ($refreshToken !== '') {
        /*
         * api_permission_db_connect() rather than connection-pdo.php, and the
         * difference matters: connection-pdo.php runs api_bootstrap_auth() at
         * include time, and logout.php is not on the public list — so pulling
         * it in here made logout answer 401 for anyone whose session had
         * already expired while their refresh cookie was still live. Logout
         * has to be the one call that always succeeds, and that is exactly the
         * caller who most needs the token revoked.
         *
         * The audit block below now uses the same connection for the same
         * reason. It used to require connection-pdo.php, and because that was
         * the FIRST include to run api_bootstrap_auth(), it was the gate: a user
         * who had just tripped the rate limiter got a 429 and `exit` out of the
         * audit block, so this revoke never ran. logoutTo() swallows the error
         * and navigates to the login screen either way, so the user believed
         * they had signed out while a seven-day refresh cookie stayed live in
         * their browser. Revocation now happens before the audit write, and
         * neither one can gate the other.
         */
        $tokenPdo = api_permission_db_connect();
        if ($tokenPdo instanceof PDO) {
            api_refresh_token_revoke($tokenPdo, $refreshToken);
        }
    }

    /*
     * Kill the access tokens too, not just the refresh token.
     *
     * A JWT is stateless: revoking the refresh token stops NEW access tokens
     * being minted, but every one already issued keeps verifying on its own
     * signature until it expires. With one tab that is invisible, because the
     * tab that signed out drops its token from memory on the way to the login
     * screen. With a second tab open it is the whole bug — that tab holds its
     * own copy, never hears about the logout, and stays fully signed in for up
     * to the token's fifteen minutes. Measured: after a successful logout,
     * me.php still answered 200 to both tabs' tokens.
     *
     * Bumping token_version makes api_get_session_user() reject every token
     * issued before this moment, because it compares the token's `ver` claim
     * against the user row on every single request.
     *
     * This signs the account out everywhere, including other devices. That is
     * the deliberate reading of "log out" for a portal used on shared campus
     * machines: the surprising outcome is a session left alive somewhere the
     * user cannot see, not one closed that they did not expect.
     */
    if ($sessionUser && !empty($sessionUser['user_id'])) {
        $tokenPdo = $tokenPdo ?? api_permission_db_connect();
        if ($tokenPdo instanceof PDO) {
            api_auth_revoke_all_sessions($tokenPdo, (int)$sessionUser['user_id']);
        }
    }

    api_refresh_cookie_clear();
} catch (Throwable $throwable) {
    api_log_exception($throwable, ['scope' => 'logout_refresh_revoke']);
}

// Recorded after the credential is already dead, so a failure here can only cost
// the log entry — never the revocation.
if ($sessionUser && !empty($sessionUser['user_id'])) {
    try {
        $auditPdo = api_permission_db_connect();
        if ($auditPdo instanceof PDO) {
            api_audit_record($auditPdo, [
                'user_id' => (int)$sessionUser['user_id'],
                'actor_label' => (string)($sessionUser['email'] ?? ''),
                'action' => 'logout',
                'outcome' => 'success',
                'detail' => 'Signed out',
            ]);
        }
    } catch (Throwable $throwable) {
        // Logging out must succeed even if the audit write cannot.
        api_log_exception($throwable, ['scope' => 'logout_audit']);
    }
}

api_destroy_session();

api_json_response(200, ['message' => 'Logged out']);
