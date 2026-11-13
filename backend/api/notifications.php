<?php

require_once __DIR__ . '/connection-pdo.php';

api_send_headers(['GET', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

function notifications_out(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    echo json_encode($payload);
    exit;
}

try {
    $user = api_get_session_user();
    if (!$user || empty($user['user_id'])) {
        notifications_out(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();
    $userId = (int)$user['user_id'];
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

    if ($method === 'GET') {
        $page = isset($_GET['page']) ? (int)$_GET['page'] : 1;
        $limit = isset($_GET['limit']) ? (int)$_GET['limit'] : 10;
        $passwordExpiration = null;

        /*
         * Started explicitly. This used to come free, because resolving the
         * caller started a session as a side effect — that stopped when identity
         * moved to the bearer token. Without it the write below would land on an
         * unstarted session and be dropped, so the 5-minute guard would never
         * hold and the sync would run on every poll.
         *
         * This is the last thing here that touches $_SESSION, and it is a cache
         * marker rather than identity: worth a session, not worth a table.
         */
        api_start_session();
        $syncKey = 'notifications_password_expiration_synced_at';
        $lastPasswordSync = isset($_SESSION[$syncKey]) ? (int)$_SESSION[$syncKey] : 0;
        if ($page <= 1 && (time() - $lastPasswordSync) >= 300) {
            try {
                $passwordExpiration = api_password_expiration_sync_notifications_for_user($pdo, $userId);
                $_SESSION[$syncKey] = time();
            } catch (Throwable $syncThrowable) {
                api_log_exception($syncThrowable, [
                    'endpoint' => 'notifications.php',
                    'scope' => 'password_expiration_notification_sync',
                    'user_id' => $userId,
                ]);
            }
        }
        $data = api_notifications_fetch_for_user($pdo, $userId, $page, $limit);
        $data['password_expiration'] = $passwordExpiration;

        notifications_out(200, [
            'message' => 'Notifications loaded.',
            'data' => $data,
        ]);
    }

    if ($method === 'PUT') {
        $payload = json_decode(file_get_contents('php://input') ?: '', true);
        if (!is_array($payload)) {
            notifications_out(400, ['message' => 'Invalid JSON']);
        }

        $action = strtolower(trim((string)($payload['action'] ?? '')));
        if ($action === 'mark_read') {
            $notificationId = isset($payload['notification_id']) ? (int)$payload['notification_id'] : 0;
            if ($notificationId <= 0) {
                notifications_out(400, ['message' => 'A valid notification_id is required']);
            }

            api_notifications_mark_read($pdo, $userId, $notificationId);
            notifications_out(200, [
                'message' => 'Notification marked as read.',
                'data' => api_notifications_fetch_for_user($pdo, $userId, 1, 10),
            ]);
        }

        if ($action === 'mark_all_read') {
            $updatedCount = api_notifications_mark_all_read($pdo, $userId);
            notifications_out(200, [
                'message' => $updatedCount > 0 ? 'Notifications marked as read.' : 'No unread notifications.',
                'data' => api_notifications_fetch_for_user($pdo, $userId, 1, 10),
            ]);
        }

        notifications_out(400, ['message' => 'Unsupported notification action']);
    }

    if ($method === 'DELETE') {
        $deletedCount = api_notifications_delete_read($pdo, $userId);
        notifications_out(200, [
            'message' => $deletedCount > 0 ? 'Read notifications cleared.' : 'No read notifications to clear.',
            'data' => api_notifications_fetch_for_user($pdo, $userId, 1, 10),
        ]);
    }

    notifications_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $throwable) {
    api_log_exception($throwable, [
        'endpoint' => 'notifications.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    ]);
    notifications_out(500, ['message' => 'Server error']);
}
