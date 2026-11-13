<?php
/**
 * Exchange a refresh cookie for a new access token.
 *
 * Public in the api_is_public_endpoint() sense — it cannot require an access
 * token, since the whole point is being called when the access token has
 * expired. The credential it checks is the httpOnly refresh cookie.
 *
 * It also returns the user payload, and that is what makes a page reload cheap.
 * The access token lives in memory only, so a reload has nothing but this cookie
 * to go on; answering with the user as well means restoreAuthUser() gets both
 * halves back in one request instead of a refresh followed by a me.php.
 */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
/*
 * The idle timeout rides along with the user.
 *
 * It cannot be fetched from security_policy.php, which is gated on the
 * `settings` module — the accounts the timeout actually governs are the ones
 * without that grant. These three endpoints are the ones every browser already
 * calls to establish who it is, so the policy reaches everybody for free and is
 * re-read on every page load.
 */
require_once __DIR__ . '/session_policy_service.php';
require_once __DIR__ . '/middleware/auth_tokens.php';

if (strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    api_json_response(405, ['message' => 'Method not allowed']);
}

$presented = api_refresh_cookie_get();
if ($presented === '') {
    api_json_response(401, ['message' => 'Not authenticated', 'code' => 'NO_REFRESH_TOKEN']);
}

try {
    $pdo = (new Database())->connect();

    // Rotates on success: the presented token is spent and a new one issued in
    // the same family. A replayed token revokes the family and returns null.
    $rotated = api_refresh_token_consume($pdo, $presented);
    if ($rotated === null) {
        api_refresh_cookie_clear();
        api_json_response(401, ['message' => 'Session expired. Sign in again.', 'code' => 'REFRESH_REJECTED']);
    }

    $userId = (int)$rotated['user_id'];
    $userRow = api_fetch_user_context($pdo, $userId, false);

    /*
     * Re-checked here rather than trusted from the token, and this is the point
     * of a short access-token life: a deactivated or deleted account cannot
     * refresh, so it is fully locked out within one access-token lifetime even
     * on the endpoints that never re-read the user row.
     */
    if (!$userRow || !api_user_is_active($userRow)) {
        api_refresh_token_revoke_all_for_user($pdo, $userId);
        api_refresh_cookie_clear();
        api_json_response(401, ['message' => 'This account is no longer active.', 'code' => 'ACCOUNT_INACTIVE']);
    }

    api_refresh_cookie_set($rotated['token']);

    // Rebuilds the session too, so during the cutover both transports stay in
    // step and a refresh does not leave the session pointing at stale data.
    $responseUser = api_store_authenticated_user($userRow, false);
    $access = api_jwt_issue_access_token($userId, (int)($userRow['token_version'] ?? 0));

    api_json_response(200, [
        'user' => $responseUser,
        'access_token' => $access['token'],
        'token_type' => 'Bearer',
        'expires_in' => $access['expires_in'],
        'session_policy' => ['timeout_minutes' => api_session_policy_timeout_minutes()],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'refresh.php']);
    api_json_response(500, ['message' => 'Server error']);
}
