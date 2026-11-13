<?php

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';


try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        api_out(405, ['message' => 'Method not allowed']);
    }

    $authUser = api_get_session_user();
    if (api_session_user_has_role($authUser, ['student'])) {
        api_out(200, ['data' => [
            'total' => 0,
            'active' => 0,
            'inactive' => 0,
            'archived' => 0,
            'student_users' => 0,
            'by_role' => [],
        ]]);
    }

    $db = new Database();
    $pdo = $db->connect();

    $archivedStatusStmt = $pdo->prepare('SELECT status_id FROM status WHERE status_type = :type AND LOWER(status_name) = :name LIMIT 1');
    $archivedStatusStmt->execute([':type' => 'account', ':name' => 'archived']);
    $archivedStatusId = (int)$archivedStatusStmt->fetchColumn();

    $total = (int)$pdo->query('SELECT COUNT(*) FROM user')->fetchColumn();
    $active = (int)$pdo->query('SELECT COUNT(*) FROM user WHERE status = 1')->fetchColumn();
    $inactive = 0;

    $archivedCountSql = 'SELECT COUNT(*) FROM user WHERE status = 2';
    $archivedCountParams = [];
    $archivedExpr = 'SUM(CASE WHEN u.status = 2 THEN 1 ELSE 0 END)';
    if ($archivedStatusId > 0) {
        $archivedCountSql = 'SELECT COUNT(*) FROM user WHERE status = 2 OR status = :status_id';
        $archivedCountParams[':status_id'] = $archivedStatusId;
        $archivedExpr = 'SUM(CASE WHEN u.status = 2 OR u.status = :archived_status_id THEN 1 ELSE 0 END)';
    }

    $archivedStmt = $pdo->prepare($archivedCountSql);
    foreach ($archivedCountParams as $key => $value) {
        $archivedStmt->bindValue($key, $value, PDO::PARAM_INT);
    }
    $archivedStmt->execute();
    $archived = (int)$archivedStmt->fetchColumn();

    $studentUsersStmt = $pdo->prepare("SELECT COUNT(*) FROM user u LEFT JOIN role r ON r.role_id = u.role WHERE LOWER(COALESCE(r.role_name, '')) LIKE :q");
    $studentUsersStmt->execute([':q' => '%student%']);
    $studentUsers = (int)$studentUsersStmt->fetchColumn();

    $roleSql = "SELECT r.role_id, r.role_name,
                       COUNT(u.user_id) AS total_users,
                       SUM(CASE WHEN u.status = 1 THEN 1 ELSE 0 END) AS active_users,
                       0 AS inactive_users,
                       $archivedExpr AS archived_users
                FROM role r
                LEFT JOIN user u ON u.role = r.role_id
                GROUP BY r.role_id, r.role_name
                ORDER BY r.role_name ASC";
    $roleStmt = $pdo->prepare($roleSql);
    if ($archivedStatusId > 0) {
        $roleStmt->bindValue(':archived_status_id', $archivedStatusId, PDO::PARAM_INT);
    }
    $roleStmt->execute();
    $byRole = $roleStmt->fetchAll(PDO::FETCH_ASSOC);
    $byRole = array_map(function ($row) {
        return [
            'role_id' => isset($row['role_id']) ? (int)$row['role_id'] : null,
            'role_name' => $row['role_name'] ?? 'Unknown',
            'total_users' => (int)($row['total_users'] ?? 0),
            'active_users' => (int)($row['active_users'] ?? 0),
            'inactive_users' => (int)($row['inactive_users'] ?? 0),
            'archived_users' => (int)($row['archived_users'] ?? 0),
        ];
    }, $byRole);

    api_out(200, ['data' => [
        // Existing fields used by dashboard
        'total' => $total,
        'active' => $active,
        'inactive' => $inactive,
        // Additional report fields
        'archived' => $archived,
        'student_users' => $studentUsers,
        'by_role' => $byRole,
    ]]);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
