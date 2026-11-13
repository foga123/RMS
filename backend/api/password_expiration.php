<?php

require_once __DIR__ . '/connection-pdo.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

function password_expiration_require_admin(?array $user): void
{
    if (!api_session_user_has_role($user, ['admin'])) {
        api_json_response(403, ['message' => 'Forbidden']);
    }
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $user = api_get_session_user();
    if (!$user || empty($user['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();
    $userId = (int)$user['user_id'];

    if ($method === 'GET') {
        $scope = strtolower(trim((string)($_GET['scope'] ?? 'self')));

        if ($scope === 'users') {
            password_expiration_require_admin($user);
            api_json_response(200, [
                'message' => 'Password expiration users loaded.',
                'policy' => api_password_expiration_get_policy(),
                'data' => api_password_expiration_list_users($pdo, [
                    'search' => $_GET['search'] ?? '',
                    'filter' => $_GET['filter'] ?? 'all',
                    'page' => $_GET['page'] ?? 1,
                    'limit' => $_GET['limit'] ?? 50,
                ]),
            ]);
        }

        $status = api_password_expiration_sync_notifications_for_user($pdo, $userId)
            ?: api_password_expiration_status_for_user_id($pdo, $userId);

        api_json_response(200, [
            'message' => 'Password expiration status loaded.',
            'password_expiration' => $status,
        ]);
    }

    if ($method === 'PUT') {
        password_expiration_require_admin($user);
        $payload = api_read_json_body();
        $action = strtolower(trim((string)($payload['action'] ?? '')));
        $targetUserId = isset($payload['user_id']) ? (int)$payload['user_id'] : 0;
        if ($targetUserId <= 0) {
            api_json_response(400, ['message' => 'A valid user_id is required']);
        }

        if ($action === 'reset') {
            $status = api_password_expiration_record_password_changed($pdo, $targetUserId);
            if (!$status) {
                api_json_response(404, ['message' => 'User not found']);
            }

            api_write_audit_log($pdo, $user, 'password_expiration_reset', 'Password expiration reset for user #' . $targetUserId . '.', [
                'target_user_id' => $targetUserId,
            ]);

            api_json_response(200, [
                'message' => 'Password expiration reset.',
                'password_expiration' => $status,
            ]);
        }

        if ($action === 'set_user_disabled') {
            $disabled = api_parse_bool($payload['disabled'] ?? false, false);
            $status = api_password_expiration_set_user_disabled($pdo, $targetUserId, $disabled, $user);
            if (!$status) {
                api_json_response(404, ['message' => 'User not found']);
            }

            api_write_audit_log($pdo, $user, $disabled ? 'password_expiration_disabled' : 'password_expiration_enabled', ($disabled ? 'Disabled' : 'Enabled') . ' password expiration for user #' . $targetUserId . '.', [
                'target_user_id' => $targetUserId,
                'disabled' => $disabled,
            ]);

            api_json_response(200, [
                'message' => $disabled ? 'Password expiration disabled for user.' : 'Password expiration enabled for user.',
                'password_expiration' => $status,
            ]);
        }

        api_json_response(400, ['message' => 'Unsupported password expiration action']);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (Throwable $throwable) {
    api_log_exception($throwable, [
        'endpoint' => 'password_expiration.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    ]);
    api_json_response(500, ['message' => 'Server error']);
}
