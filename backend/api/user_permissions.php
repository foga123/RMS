<?php

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/permissions_response.php';

function fetch_user_permissions_payload(PDO $pdo, int $userId): array
{
    if ($userId <= 0) {
        permissions_out(400, ['message' => 'Valid user_id is required']);
    }

    $userRow = api_fetch_user_context($pdo, $userId, false);
    if (!$userRow) {
        permissions_out(404, ['message' => 'User not found']);
    }

    $roleId = (int)($userRow['role_id'] ?? 0);
    $effectiveRecord = api_fetch_effective_permissions_record($pdo, $roleId, $userId);
    $rolePermissions = $effectiveRecord['role_permissions'] ?? [];
    $userPermissions = $effectiveRecord['user_permissions'] ?? [];
    $userOverrideGrants = $effectiveRecord['user_override_grants'] ?? [];
    $userOverrideRestrictions = $effectiveRecord['user_override_restrictions'] ?? [];

    $roleSummary = api_summarize_permissions_map($rolePermissions);
    $userSummary = api_summarize_permissions_map($userPermissions);
    $effectiveSummary = api_summarize_permissions_map($effectiveRecord['permissions'] ?? []);
    $userGrantSummary = api_summarize_permissions_map($userOverrideGrants);
    $userRestrictionSummary = api_summarize_permissions_map($userOverrideRestrictions);

    $rolePayload = null;
    if ($roleId > 0) {
        $roleStmt = $pdo->prepare('SELECT role_id, role_name, description FROM role WHERE role_id = :role_id LIMIT 1');
        $roleStmt->execute([':role_id' => $roleId]);
        $roleRow = $roleStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        $rolePayload = [
            'role_id' => $roleId,
            'role_name' => $roleRow['role_name'] ?? ($userRow['role_name'] ?? ''),
            'description' => $roleRow['description'] ?? null,
            'permissions_configured' => !empty($effectiveRecord['has_saved_role_permissions']),
            'module_permissions' => $rolePermissions,
            'enabled_module_count' => (int)($roleSummary['module_count'] ?? 0),
            'enabled_action_count' => (int)($roleSummary['action_count'] ?? 0),
            'accessible_modules' => $roleSummary['modules'] ?? [],
        ];
    }

    return [
        'user_id' => $userId,
        'permissions' => $effectiveRecord['permissions'] ?? [],
        'effective_permissions' => $effectiveRecord['permissions'] ?? [],
        'role_permissions' => $rolePermissions,
        'user_permissions' => $userPermissions,
        'user_override_grants' => $userOverrideGrants,
        'user_override_restrictions' => $userOverrideRestrictions,
        'user_override_storage_mode' => $effectiveRecord['user_override_storage_mode'] ?? null,
        'has_saved_permissions' => !empty($effectiveRecord['has_saved_permissions']),
        'has_saved_role_permissions' => !empty($effectiveRecord['has_saved_role_permissions']),
        'has_saved_user_permissions' => !empty($effectiveRecord['has_saved_user_permissions']),
        'permission_source' => $effectiveRecord['permission_source'] ?? 'default',
        'summaries' => [
            'effective' => $effectiveSummary,
            'role' => $roleSummary,
            'user' => $userSummary,
            'user_grants' => $userGrantSummary,
            'user_restrictions' => $userRestrictionSummary,
        ],
        'role' => $rolePayload,
        'user' => [
            'user_id' => (int)($userRow['user_id'] ?? 0),
            'name' => api_user_display_name($userRow),
            'first_name' => $userRow['first_name'] ?? null,
            'last_name' => $userRow['last_name'] ?? null,
            'email' => $userRow['email'] ?? null,
            'role_id' => $roleId > 0 ? $roleId : null,
            'role_name' => $userRow['role_name'] ?? null,
            'department_id' => isset($userRow['department_id']) ? (int)$userRow['department_id'] : null,
            'department_name' => $userRow['department_name'] ?? null,
            'campus_id' => isset($userRow['campus_id']) ? (int)$userRow['campus_id'] : null,
            'campus_name' => $userRow['campus_name'] ?? null,
            'status' => isset($userRow['status']) ? (int)$userRow['status'] : null,
            'status_name' => $userRow['status_name'] ?? null,
            'status_type' => $userRow['status_type'] ?? null,
            'permissions_configured' => !empty($effectiveRecord['has_saved_permissions']),
            'role_permissions_configured' => !empty($effectiveRecord['has_saved_role_permissions']),
            'custom_permissions_configured' => !empty($effectiveRecord['has_saved_user_permissions']),
            'module_permissions' => $effectiveRecord['permissions'] ?? [],
            'role_permissions' => $rolePermissions,
            'user_permissions' => $userPermissions,
            'user_override_grants' => $userOverrideGrants,
            'user_override_restrictions' => $userOverrideRestrictions,
            'enabled_module_count' => (int)($effectiveSummary['module_count'] ?? 0),
            'enabled_action_count' => (int)($effectiveSummary['action_count'] ?? 0),
            'accessible_modules' => $effectiveSummary['modules'] ?? [],
            'permission_source' => $effectiveRecord['permission_source'] ?? 'default',
        ],
    ];
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET') {
        $userId = isset($_GET['user_id']) ? (int)$_GET['user_id'] : 0;
        permissions_out(200, fetch_user_permissions_payload($pdo, $userId));
    }

    if ($method === 'PUT') {
        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            permissions_out(400, ['message' => 'Invalid JSON']);
        }

        $userId = isset($payload['user_id']) ? (int)$payload['user_id'] : 0;
        $permissions = $payload['permissions'] ?? null;

        if ($userId <= 0) {
            permissions_out(400, ['message' => 'Valid user_id is required']);
        }
        if (!is_array($permissions)) {
            permissions_out(400, ['message' => 'permissions object is required']);
        }
        $permissions = api_sanitize_access_management_permissions_map($permissions);

        $targetUser = api_fetch_user_context($pdo, $userId, false);
        if (!$targetUser) {
            permissions_out(404, ['message' => 'User not found']);
        }

        $roleId = (int)($targetUser['role_id'] ?? 0);
        $actor = api_get_session_user();
        $beforeEffective = api_fetch_effective_permissions_record($pdo, $roleId, $userId);
        $beforeUser = api_fetch_user_permissions_record($pdo, $userId, $beforeEffective['role_permissions'] ?? []);
        $baseRolePermissions = $beforeEffective['role_permissions'] ?? [];

        $pdo->beginTransaction();
        $record = api_store_user_permissions_map($pdo, $userId, $permissions, $baseRolePermissions);
        $hasCustomPermissions = !empty($record['has_saved_permissions']);
        api_write_audit_log(
            $pdo,
            $actor,
            $hasCustomPermissions ? 'user_permissions_updated' : 'user_permissions_cleared',
            ($hasCustomPermissions ? 'Updated' : 'Cleared') . ' custom access permissions for user "' . api_user_display_name($targetUser) . '".',
            [
                'user_id' => $userId,
                'email' => $targetUser['email'] ?? null,
                'role_id' => $roleId > 0 ? $roleId : null,
                'role_name' => $targetUser['role_name'] ?? null,
                'role_permissions' => $baseRolePermissions,
                'before_effective' => $beforeEffective['permissions'] ?? [],
                'before_custom' => $beforeUser['permissions'] ?? [],
                'before_override_grants' => $beforeUser['grants'] ?? [],
                'before_override_restrictions' => $beforeUser['restrictions'] ?? [],
                'after_custom' => $record['permissions'] ?? [],
                'after_override_grants' => $record['grants'] ?? [],
                'after_override_restrictions' => $record['restrictions'] ?? [],
            ]
        );
        api_notifications_try_create($pdo, [
            'event_key' => $hasCustomPermissions ? 'user_permissions_updated' : 'user_permissions_cleared',
            'level' => 'warning',
            'title' => $hasCustomPermissions ? 'User permissions updated' : 'User permissions cleared',
            'message' => ($hasCustomPermissions ? 'Custom access rules were updated for ' : 'Custom access rules were cleared for ') . api_user_display_name($targetUser) . '.',
            'module_key' => 'settings',
            'entity_type' => 'user',
            'entity_id' => $userId,
            'actor_user_id' => (int)($actor['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'view' => 'settings',
                'section' => 'roleAccess',
            ],
            'metadata' => [
                'user_id' => $userId,
                'email' => $targetUser['email'] ?? null,
                'role_id' => $roleId > 0 ? $roleId : null,
                'role_name' => $targetUser['role_name'] ?? null,
                'custom_permissions_enabled' => $hasCustomPermissions,
            ],
            'recipients' => [
                'module_targets' => [
                    ['module' => 'settings', 'action' => 'view'],
                    ['module' => 'users', 'action' => 'view'],
                ],
            ],
        ], [
            'endpoint' => 'user_permissions.php',
            'event_key' => $hasCustomPermissions ? 'user_permissions_updated' : 'user_permissions_cleared',
            'user_id' => $userId,
        ]);
        api_notifications_try_create($pdo, [
            'event_key' => $hasCustomPermissions ? 'access_updated_personal' : 'access_cleared_personal',
            'level' => 'warning',
            'title' => $hasCustomPermissions ? 'Your access was updated' : 'Your custom access was cleared',
            'message' => $hasCustomPermissions
                ? 'Your module permissions were updated. Review your available modules after refresh.'
                : 'Your custom module permissions were cleared and reverted to role defaults.',
            'entity_type' => 'user',
            'entity_id' => $userId,
            'actor_user_id' => (int)($actor['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'overlay' => 'profile',
            ],
            'metadata' => [
                'user_id' => $userId,
                'custom_permissions_enabled' => $hasCustomPermissions,
            ],
            'recipients' => [
                'user_ids' => [$userId],
            ],
        ], [
            'endpoint' => 'user_permissions.php',
            'event_key' => $hasCustomPermissions ? 'access_updated_personal' : 'access_cleared_personal',
            'user_id' => $userId,
        ]);
        if ($pdo->inTransaction()) {
            $pdo->commit();
        }

        if (isset($actor['user_id']) && (int)$actor['user_id'] === $userId) {
            api_refresh_authenticated_user($pdo, false);
        }

        $response = fetch_user_permissions_payload($pdo, $userId);
        $response['success'] = true;
        $response['message'] = 'Permissions updated successfully';
        permissions_out(200, $response);
    }

    permissions_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    api_log_exception($e, [
        'endpoint' => 'user_permissions.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
        'user_id' => isset($userId) ? (int)$userId : null,
    ]);
    permissions_out(500, ['success' => false, 'message' => 'Server error']);
}
