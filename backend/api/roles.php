<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';



function build_role_assignment_map(PDO $pdo, array $roleIds, int $previewLimit = 5): array
{
    $roleIds = array_values(array_unique(array_filter(array_map('intval', $roleIds), static function (int $roleId): bool {
        return $roleId > 0;
    })));
    if (empty($roleIds)) {
        return [];
    }

    $placeholders = implode(', ', array_fill(0, count($roleIds), '?'));
    if (api_user_table_has_campus_column($pdo)) {
        $campusSelect = 'COALESCE(u.campus_id, d.campus_id) AS campus_id,';
        $campusJoin = 'LEFT JOIN campus c ON c.campus_id = COALESCE(u.campus_id, d.campus_id)';
    } else {
        $campusSelect = 'd.campus_id AS campus_id,';
        $campusJoin = 'LEFT JOIN campus c ON c.campus_id = d.campus_id';
    }

    $sql = "SELECT
                u.user_id,
                u.role AS role_id,
                u.first_name,
                u.last_name,
                u.email,
                u.status,
                -- Overrides live in the RBAC store, not a table this can join;
                -- resolved per row below.
                0 AS custom_permission_count,
                d.department_id,
                d.department_name,
                $campusSelect
                c.campus_name,
                s.status_name,
                s.status_type
            FROM user u
            LEFT JOIN department d ON d.department_id = u.department
            $campusJoin
            LEFT JOIN status s ON s.status_id = u.status
            WHERE u.role IN ($placeholders)
            ORDER BY u.role ASC, u.last_name ASC, u.first_name ASC, u.user_id ASC";

    $stmt = $pdo->prepare($sql);
    foreach ($roleIds as $index => $roleId) {
        $stmt->bindValue($index + 1, $roleId, PDO::PARAM_INT);
    }
    $stmt->execute();

    $map = [];
    foreach ($roleIds as $roleId) {
        $map[$roleId] = [
            'user_count' => 0,
            'assigned_users' => [],
            'assigned_users_preview' => [],
        ];
    }

    // Which users carry a permission delta, from the RBAC store.
    $overrideUserIds = array_flip(api_rbac_store_user_ids_with_overrides());

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $roleId = (int)($row['role_id'] ?? 0);
        if ($roleId <= 0) {
            continue;
        }

        $userSummary = [
            'user_id' => (int)($row['user_id'] ?? 0),
            'name' => api_user_display_name($row),
            'email' => $row['email'] ?? null,
            'department_name' => $row['department_name'] ?? null,
            'campus_name' => $row['campus_name'] ?? null,
            'status' => (int)($row['status'] ?? 0),
            'status_name' => $row['status_name'] ?? null,
            'status_type' => $row['status_type'] ?? null,
            'custom_permissions_configured' => isset($overrideUserIds[(int)($row['user_id'] ?? 0)]),
        ];

        $map[$roleId]['user_count'] += 1;
        $map[$roleId]['assigned_users'][] = $userSummary;
        if (count($map[$roleId]['assigned_users_preview']) < $previewLimit) {
            $map[$roleId]['assigned_users_preview'][] = $userSummary;
        }
    }

    return $map;
}

function enrich_role_row(PDO $pdo, array $row, array $assignmentMap, bool $includeAllUsers = false): array
{
    $roleId = (int)($row['role_id'] ?? 0);
    $permissionRecord = api_fetch_role_permissions_record($pdo, $roleId);
    $permissionSummary = api_summarize_permissions_map($permissionRecord['permissions']);
    $assignment = $assignmentMap[$roleId] ?? [
        'user_count' => 0,
        'assigned_users' => [],
        'assigned_users_preview' => [],
    ];

    return [
        'role_id' => $roleId,
        'role_name' => $row['role_name'] ?? '',
        'description' => $row['description'] ?? null,
        'archived_at' => $row['archived_at'] ?? null,
        'permissions_configured' => !empty($permissionRecord['has_saved_permissions']),
        'module_permissions' => $permissionRecord['permissions'],
        'enabled_module_count' => (int)($permissionSummary['module_count'] ?? 0),
        'enabled_action_count' => (int)($permissionSummary['action_count'] ?? 0),
        'accessible_modules' => $permissionSummary['modules'] ?? [],
        'user_count' => (int)($assignment['user_count'] ?? 0),
        'custom_user_count' => count(array_filter($assignment['assigned_users'] ?? [], static function (array $user): bool {
            return !empty($user['custom_permissions_configured']);
        })),
        'assigned_users' => $includeAllUsers
            ? ($assignment['assigned_users'] ?? [])
            : ($assignment['assigned_users_preview'] ?? []),
        'assigned_users_preview' => $assignment['assigned_users_preview'] ?? [],
    ];
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $sessionUser = api_get_session_user();
    api_require_column($pdo, 'role', 'archived_at');
    $hasArchivedAt = api_column_exists($pdo, 'role', 'archived_at');

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT role_id, role_name, description, archived_at FROM role WHERE role_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Role not found']);

            $assignmentMap = build_role_assignment_map($pdo, [$id], 12);
            api_out(200, ['data' => enrich_role_row($pdo, $row, $assignmentMap, true)]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(500, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $includeArchived = isset($_GET['include_archived']) ? api_bool_like($_GET['include_archived'], false) : false;
        $archivedOnly = isset($_GET['archived']) ? api_bool_like($_GET['archived'], false) : false;
        $whereParts = [];
        $params = [];
        if ($hasArchivedAt) {
            if ($archivedOnly) {
                $whereParts[] = 'archived_at IS NOT NULL';
            } elseif (!$includeArchived) {
                $whereParts[] = 'archived_at IS NULL';
            }
        }
        if ($search !== '') {
            $whereParts[] = '(role_name LIKE :q OR description LIKE :q)';
            $params[':q'] = "%$search%";
        }
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT role_id, role_name, description, archived_at FROM role $where ORDER BY role_id ASC LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value);
        }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $countSql = 'SELECT COUNT(*) FROM role ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $key => $value) {
            $countStmt->bindValue($key, $value);
        }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        $assignmentMap = build_role_assignment_map($pdo, array_map(static function (array $row): int {
            return (int)($row['role_id'] ?? 0);
        }, $rows));
        $data = array_map(static function (array $row) use ($pdo, $assignmentMap): array {
            return enrich_role_row($pdo, $row, $assignmentMap, false);
        }, $rows);

        api_out(200, ['data' => $data, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        $name = isset($payload['role_name']) ? trim((string)$payload['role_name']) : '';
        $desc = isset($payload['description']) ? trim((string)$payload['description']) : null;
        if ($name === '') api_out(400, ['message' => 'role_name is required']);

        $chkSql = 'SELECT role_id FROM role WHERE role_name = :n';
        if ($hasArchivedAt) {
            $chkSql .= ' AND archived_at IS NULL';
        }
        $chkSql .= ' LIMIT 1';
        $chk = $pdo->prepare($chkSql);
        $chk->execute([':n' => $name]);
        if ($chk->fetch()) api_out(409, ['message' => 'Role name already exists']);

        $ins = $pdo->prepare('INSERT INTO role (role_name, description) VALUES (:n, :d)');
        $ins->execute([':n' => $name, ':d' => ($desc !== '' ? $desc : null)]);
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare('SELECT role_id, role_name, description, archived_at FROM role WHERE role_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        $assignmentMap = build_role_assignment_map($pdo, [$newId]);
        if ($row) {
            api_notifications_try_create($pdo, [
                'event_key' => 'role_created',
                'level' => 'success',
                'title' => 'Role created',
                'message' => 'Role "' . (string)($row['role_name'] ?? ('Role #' . $newId)) . '" was added.',
                'module_key' => 'roles',
                'entity_type' => 'role',
                'entity_id' => $newId,
                'actor_user_id' => (int)($sessionUser['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'view' => 'roles',
                ],
                'metadata' => [
                    'role_id' => $newId,
                    'role_name' => $row['role_name'] ?? null,
                ],
                'recipients' => [
                    'module_targets' => [
                        ['module' => 'roles', 'action' => 'view'],
                    ],
                ],
            ], [
                'endpoint' => 'roles.php',
                'event_key' => 'role_created',
                'role_id' => $newId,
            ]);
        }
        api_out(201, ['message' => 'Role created', 'data' => enrich_role_row($pdo, $row ?: [], $assignmentMap, true)]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (is_array($payload) && !$id) {
            $id = isset($payload['role_id']) ? (int)$payload['role_id'] : 0;
        }
        if ($id <= 0) api_out(400, ['message' => 'Valid role id is required']);

        $chk = $pdo->prepare('SELECT role_id, role_name, description, archived_at FROM role WHERE role_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Role not found']);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        $name = array_key_exists('role_name', $payload) ? trim((string)$payload['role_name']) : null;
        $desc = array_key_exists('description', $payload) ? trim((string)$payload['description']) : null;
        $restoreRequested = $hasArchivedAt && array_key_exists('archived', $payload) && !api_bool_like($payload['archived'], false);
        $archiveRequested = $hasArchivedAt && array_key_exists('archived', $payload) && api_bool_like($payload['archived'], false);

        if ($sessionUser && (!empty($sessionUser['role_id']) || !empty($sessionUser['user_id'])) && ($restoreRequested || $archiveRequested)) {
            $permissionRecord = api_fetch_effective_permissions_record(
                $pdo,
                (int)($sessionUser['role_id'] ?? 0),
                (int)($sessionUser['user_id'] ?? 0)
            );
            if (!empty($permissionRecord['has_saved_permissions'])) {
                $requiredAction = $archiveRequested ? 'archive' : 'restore';
                if (!api_can($permissionRecord['permissions'], 'roles', $requiredAction)) {
                    api_out(403, ['message' => $archiveRequested
                        ? 'You do not have permission to archive roles.'
                        : 'You do not have permission to restore roles.']);
                }
            }
        }

        $fields = [];
        $params = [':id' => $id];

        if ($name !== null && $name === '') api_out(400, ['message' => 'role_name cannot be empty']);

        $effectiveName = $name !== null ? $name : $existing['role_name'];
        if ($restoreRequested || $effectiveName !== $existing['role_name']) {
            $dupSql = 'SELECT role_id FROM role WHERE role_name = :n AND role_id <> :id';
            if ($hasArchivedAt) {
                $dupSql .= ' AND archived_at IS NULL';
            }
            $dupSql .= ' LIMIT 1';
            $dup = $pdo->prepare($dupSql);
            $dup->execute([':n' => $effectiveName, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'Role name already exists']);
        }

        if ($name !== null) {
            $fields[] = 'role_name = :n';
            $params[':n'] = $name;
        }
        if ($desc !== null) {
            $fields[] = 'description = :d';
            $params[':d'] = ($desc !== '' ? $desc : null);
        }
        if ($hasArchivedAt && array_key_exists('archived', $payload)) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($payload['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE role SET ' . implode(', ', $fields) . ' WHERE role_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare('SELECT role_id, role_name, description, archived_at FROM role WHERE role_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        $assignmentMap = build_role_assignment_map($pdo, [$id], 12);
        if ($row) {
            $eventKey = 'role_updated';
            $title = 'Role updated';
            $message = 'Role "' . (string)($row['role_name'] ?? ('Role #' . $id)) . '" was updated.';
            if ($hasArchivedAt && array_key_exists('archived', $payload)) {
                if (api_bool_like($payload['archived'], false)) {
                    $eventKey = 'role_archived';
                    $title = 'Role archived';
                    $message = 'Role "' . (string)($row['role_name'] ?? ('Role #' . $id)) . '" was archived.';
                } else {
                    $eventKey = 'role_restored';
                    $title = 'Role restored';
                    $message = 'Role "' . (string)($row['role_name'] ?? ('Role #' . $id)) . '" was restored.';
                }
            }

            api_notifications_try_create($pdo, [
                'event_key' => $eventKey,
                'level' => $eventKey === 'role_archived' ? 'warning' : 'success',
                'title' => $title,
                'message' => $message,
                'module_key' => 'roles',
                'entity_type' => 'role',
                'entity_id' => $id,
                'actor_user_id' => (int)($sessionUser['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'view' => 'roles',
                ],
                'metadata' => [
                    'role_id' => $id,
                    'role_name' => $row['role_name'] ?? null,
                ],
                'recipients' => [
                    'module_targets' => [
                        ['module' => 'roles', 'action' => 'view'],
                    ],
                ],
            ], [
                'endpoint' => 'roles.php',
                'event_key' => $eventKey,
                'role_id' => $id,
            ]);
        }
        api_out(200, ['message' => 'Role updated', 'data' => enrich_role_row($pdo, $row ?: [], $assignmentMap, true)]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid role id is required']);

        if ($sessionUser && (!empty($sessionUser['role_id']) || !empty($sessionUser['user_id']))) {
            $permissionRecord = api_fetch_effective_permissions_record(
                $pdo,
                (int)($sessionUser['role_id'] ?? 0),
                (int)($sessionUser['user_id'] ?? 0)
            );
            if (!empty($permissionRecord['has_saved_permissions']) && !api_can($permissionRecord['permissions'], 'roles', 'archive')) {
                api_out(403, ['message' => 'You do not have permission to archive roles.']);
            }
        }

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE role SET archived_at = :archived_at WHERE role_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
        } else {
            $del = $pdo->prepare('DELETE FROM role WHERE role_id = :id');
            $del->execute([':id' => $id]);
        }

        api_notifications_try_create($pdo, [
            'event_key' => 'role_archived',
            'level' => 'warning',
            'title' => 'Role archived',
            'message' => 'A role record was archived.',
            'module_key' => 'roles',
            'entity_type' => 'role',
            'entity_id' => $id,
            'actor_user_id' => (int)($sessionUser['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'view' => 'roles',
            ],
            'metadata' => [
                'role_id' => $id,
            ],
            'recipients' => [
                'module_targets' => [
                    ['module' => 'roles', 'action' => 'view'],
                ],
            ],
        ], [
            'endpoint' => 'roles.php',
            'event_key' => 'role_archived',
            'role_id' => $id,
        ]);

        api_out(200, ['message' => 'Role archived']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_log_exception($e, [
        'endpoint' => 'roles.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    ]);
    api_out(500, ['message' => 'Server error']);
}
