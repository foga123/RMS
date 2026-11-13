<?php

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
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

try {
    $sessionUser = api_get_session_user();
    if (!$sessionUser) {
        api_json_response(200, ['user' => null, 'message' => 'No active session']);
    }

    $db = new Database();
    $pdo = $db->connect();

    $user = api_refresh_authenticated_user($pdo, false);
    if (!$user) {
        api_json_response(200, ['user' => null]);
    }

    api_json_response(200, [
        'user' => $user,
        'session_policy' => ['timeout_minutes' => api_session_policy_timeout_minutes()],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, [
        'endpoint' => 'me.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    ]);
    api_json_response(500, ['message' => 'Server error']);
}
