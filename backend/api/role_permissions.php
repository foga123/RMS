<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/permissions_response.php';

function fetch_assigned_users(PDO $pdo, int $roleId): array
{
    if ($roleId <= 0) {
        return [];
    }

    if (api_user_table_has_campus_column($pdo)) {
        $campusSelect = 'COALESCE(u.campus_id, d.campus_id) AS campus_id,';
        $campusJoin = 'LEFT JOIN campus c ON c.campus_id = COALESCE(u.campus_id, d.campus_id)';
    } else {
        $campusSelect = 'd.campus_id AS campus_id,';
        $campusJoin = 'LEFT JOIN campus c ON c.campus_id = d.campus_id';
    }

    $sql = "SELECT
                u.user_id,
                u.first_name,
                u.last_name,
                u.email,
                u.status,
                -- Overrides live in the RBAC store, not a table this can join;
                -- resolved per row below.
                0 AS custom_permission_count,
                d.department_name,
                $campusSelect
                c.campus_name,
                s.status_name,
                s.status_type
            FROM user u
            LEFT JOIN department d ON d.department_id = u.department
            $campusJoin
            LEFT JOIN status s ON s.status_id = u.status
            WHERE u.role = :role_id
            ORDER BY u.last_name ASC, u.first_name ASC, u.user_id ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':role_id' => $roleId]);

    // Which users carry a permission delta, from the RBAC store.
    $overrideUserIds = array_flip(api_rbac_store_user_ids_with_overrides());

    return array_map(static function (array $row) use ($overrideUserIds): array {
        return [
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
    }, $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
}

/**
 * Would anybody still be able to open this screen after the save?
 *
 * A permission map that is PRESENT but empty means "configured with nothing"
 * -- a deliberate rule (see api_rbac_store_role_snapshot), and the right one
 * for an ordinary role: an administrator who unticks everything has made a
 * choice and it should survive a reload.
 *
 * Applied to the administrator’s own role it is a brick. Verified against the
 * live API on 2026-09-22: storing an empty map for role 1 answered 403 on
 * student.php, roles.php and role_permissions.php itself -- the one screen
 * that could undo it. me.php still answered 200, so an admin could still log
 * in and see an empty portal, which reads as a broken system rather than a
 * locked one. The only way back was editing storage/rbac/permissions.json by
 * hand on the server.
 *
 * The rule is not "role 1 is special". It is that a change must not remove
 * the ability to undo it, which is also the honest answer when somebody
 * renames the admin role, adds a second one, or moves Access Management to a
 * different module. So the targets are read from this endpoint’s own PUT
 * entry rather than named here: whatever gates the save is what has to
 * survive it, and the two cannot drift apart.
 *
 * Conservative by construction -- it looks for ONE surviving account and
 * stops. An archived or inactive account does not count: it cannot sign in,
 * so it cannot undo anything.
 */
function role_permissions_editor_would_remain(PDO $pdo, int $roleId, array $proposed): bool
{
    $targets = api_get_endpoint_permission_targets('role_permissions.php', 'PUT');
    if (empty($targets)) {
        // Nothing gates the endpoint, so nothing can be locked out of it.
        return true;
    }

    /*
     * What the role would resolve to once saved, by the same two steps the
     * read path takes -- api_store_role_permissions_map() writes the raw map
     * and api_fetch_role_permissions_record() merges it over the code preset,
     * so checking the unmerged map here would test something the resolver
     * never sees.
     */
    $proposedRoleMap = api_normalize_permissions_map(
        api_merge_role_permissions_with_schema_defaults(
            api_get_default_role_permissions_map($pdo, $roleId),
            $proposed
        )
    );

    $accounts = $pdo->query(
        'SELECT u.user_id, u.role'
        . '  FROM user u JOIN status s ON s.status_id = u.status'
        . " WHERE s.status_type = 'account' AND s.status_name = 'Active'"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    /*
     * One resolution per ROLE, not per account. Only a user carrying an
     * override can differ from their role, and the store can name those
     * outright -- so this is a dozen resolutions plus however many overrides
     * exist, rather than one per user across the whole roster.
     */
    $overrideUsers = array_flip(api_rbac_store_user_ids_with_overrides());
    $rolesSeen = [];

    foreach ($accounts as $account) {
        $accountRole = (int)($account['role'] ?? 0);
        $accountUser = (int)($account['user_id'] ?? 0);
        $hasOverride = isset($overrideUsers[$accountUser]);

        if (!$hasOverride) {
            if (isset($rolesSeen[$accountRole])) {
                continue;
            }
            $rolesSeen[$accountRole] = true;
        }

        if ($accountRole !== $roleId) {
            $record = api_fetch_effective_permissions_record($pdo, $accountRole, $accountUser);
            $effective = $record['permissions'] ?? [];
        } else {
            // The role being changed: resolve against the PROPOSED map, with
            // the same admin-skips-overrides rule the resolver applies.
            $userRecord = api_fetch_user_permissions_record($pdo, $accountUser, $proposedRoleMap);
            $useUser = $accountRole !== 1 && !empty($userRecord['has_saved_permissions']);
            $effective = api_normalize_permissions_map(
                $useUser ? ($userRecord['permissions'] ?? []) : $proposedRoleMap
            );
        }

        if (!empty($effective) && api_can_any($effective, $targets)) {
            return true;
        }
    }

    return false;
}
function fetch_role_payload(PDO $pdo, int $roleId): array
{
    if ($roleId <= 0) {
        permissions_out(400, ['message' => 'Valid role_id is required']);
    }

    $roleStmt = $pdo->prepare('SELECT role_id, role_name, description, archived_at FROM role WHERE role_id = :role_id LIMIT 1');
    $roleStmt->execute([':role_id' => $roleId]);
    $role = $roleStmt->fetch(PDO::FETCH_ASSOC);
    if (!$role) {
        permissions_out(404, ['message' => 'Role not found']);
    }

    $record = api_fetch_role_permissions_record($pdo, $roleId);
    $summary = api_summarize_permissions_map($record['permissions']);
    $assignedUsers = fetch_assigned_users($pdo, $roleId);

    return [
        'role_id' => $roleId,
        'permissions' => $record['permissions'],
        'has_saved_permissions' => !empty($record['has_saved_permissions']),
        'role' => [
            'role_id' => (int)($role['role_id'] ?? 0),
            'role_name' => $role['role_name'] ?? '',
            'description' => $role['description'] ?? null,
            'archived_at' => $role['archived_at'] ?? null,
            'permissions_configured' => !empty($record['has_saved_permissions']),
            'module_permissions' => $record['permissions'],
            'enabled_module_count' => (int)($summary['module_count'] ?? 0),
            'enabled_action_count' => (int)($summary['action_count'] ?? 0),
            'accessible_modules' => $summary['modules'] ?? [],
            'user_count' => count($assignedUsers),
            'custom_user_count' => count(array_filter($assignedUsers, static function (array $user): bool {
                return !empty($user['custom_permissions_configured']);
            })),
            'assigned_users' => $assignedUsers,
            'assigned_users_preview' => array_slice($assignedUsers, 0, 6),
        ],
    ];
}

try {
    $db = new Database();
    $pdo = $db->connect();
    api_require_column($pdo, 'role', 'archived_at');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET') {
        $roleId = isset($_GET['role_id']) ? (int)$_GET['role_id'] : 0;
        permissions_out(200, fetch_role_payload($pdo, $roleId));
    }

    if ($method === 'PUT') {
        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) permissions_out(400, ['message' => 'Invalid JSON']);

        $roleId = isset($payload['role_id']) ? (int)$payload['role_id'] : 0;
        $permissions = $payload['permissions'] ?? null;

        if ($roleId <= 0) permissions_out(400, ['message' => 'Valid role_id is required']);
        if (!is_array($permissions)) permissions_out(400, ['message' => 'permissions object is required']);
        $permissions = api_sanitize_access_management_permissions_map($permissions);

        $roleCheck = $pdo->prepare('SELECT role_id, role_name FROM role WHERE role_id = :role_id LIMIT 1');
        $roleCheck->execute([':role_id' => $roleId]);
        $roleRow = $roleCheck->fetch(PDO::FETCH_ASSOC);
        if (!$roleRow) {
            permissions_out(404, ['message' => 'Role not found']);
        }

        $actor = api_get_session_user();
        $before = api_fetch_role_permissions_record($pdo, $roleId);

        /*
         * Refused before anything is written, and before the transaction is
         * opened -- there is no partial state to undo, and the caller gets a
         * sentence rather than a portal that has stopped answering.
         */
        if (!role_permissions_editor_would_remain($pdo, $roleId, $permissions)) {
            permissions_out(409, [
                'success' => false,
                'message' => 'This would leave no active account able to open Access Management, '
                    . 'including yours — and this screen is the only way to undo it. '
                    . 'Grant the Roles module to another role first, or keep it on this one.',
            ]);
        }


        /*
         * What the store held before this save, so the catch can put it back.
         *
         * The permissions are a file now, and a PDO rollback cannot undo a file
         * write. Everything after the write here - the audit entry and two
         * notifications - still runs inside the transaction, so without this a
         * failure in any of them would roll back the audit trail, report a 500,
         * and leave the permission change applied and unrecorded. Restoring it
         * by hand in the catch gives the write back the all-or-nothing property
         * it had when it was a pair of INSERTs.
         */
        $rbacRollback = api_rbac_store_role_snapshot($roleId);

        $pdo->beginTransaction();
        $record = api_store_role_permissions_map($pdo, $roleId, $permissions);
        api_write_audit_log(
            $pdo,
            $actor,
            'role_permissions_updated',
            // The sentence says what moved, not just that something did. The
            // full before/after maps stay in the metadata below.
            'Role "' . (string)($roleRow['role_name'] ?? ('Role #' . $roleId)) . '": '
                . api_permission_change_summary($pdo, $before['permissions'] ?? [], $record['permissions'] ?? []),
            [
                'role_id' => $roleId,
                'role_name' => $roleRow['role_name'] ?? null,
                'before' => $before['permissions'] ?? [],
                'after' => $record['permissions'] ?? [],
            ]
        );
        api_notifications_try_create($pdo, [
            'event_key' => 'role_permissions_updated',
            'level' => 'warning',
            'title' => 'Role permissions updated',
            'message' => 'Access rules for role "' . (string)($roleRow['role_name'] ?? ('Role #' . $roleId)) . '" were updated.',
            'module_key' => 'settings',
            'entity_type' => 'role',
            'entity_id' => $roleId,
            'actor_user_id' => (int)($actor['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'view' => 'settings',
                'section' => 'roleAccess',
            ],
            'metadata' => [
                'role_id' => $roleId,
                'role_name' => $roleRow['role_name'] ?? null,
            ],
            'recipients' => [
                'module_targets' => [
                    ['module' => 'settings', 'action' => 'view'],
                    ['module' => 'roles', 'action' => 'view'],
                ],
            ],
        ], [
            'endpoint' => 'role_permissions.php',
            'event_key' => 'role_permissions_updated',
            'role_id' => $roleId,
        ]);
        api_notifications_try_create($pdo, [
            'event_key' => 'role_permissions_changed_personal',
            'level' => 'warning',
            'title' => 'Your role access changed',
            'message' => 'Permissions for your assigned role were updated. Review your available modules after refresh.',
            'entity_type' => 'role',
            'entity_id' => $roleId,
            'actor_user_id' => (int)($actor['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'overlay' => 'profile',
            ],
            'metadata' => [
                'role_id' => $roleId,
                'role_name' => $roleRow['role_name'] ?? null,
            ],
            'recipients' => [
                'role_ids' => [$roleId],
            ],
        ], [
            'endpoint' => 'role_permissions.php',
            'event_key' => 'role_permissions_changed_personal',
            'role_id' => $roleId,
        ]);
        if ($pdo->inTransaction()) {
            $pdo->commit();
        }

        if (isset($actor['role_id']) && (int)$actor['role_id'] === $roleId) {
            api_refresh_authenticated_user($pdo, false);
        }

        $response = fetch_role_payload($pdo, $roleId);
        $response['success'] = true;
        $response['message'] = 'Permissions updated successfully';
        permissions_out(200, $response);
    }

    permissions_out(405, ['message' => 'Method not allowed']);
} catch (InvalidArgumentException $invalid) {
    /*
     * A rejected payload, not a broken server.
     *
     * api_store_role_permissions_map() throws this with a sentence naming the
     * modules it refused and why. Falling into the Throwable branch below
     * turned that sentence into "Server error", so an administrator whose save
     * was refused for a stateable reason was told only that something had gone
     * wrong -- and the panel prints exactly what it is given.
     *
     * Nothing has been written when this fires: the throw happens before the
     * store write, so there is no file state to compensate and no transaction
     * open yet.
     */
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    permissions_out(400, ['success' => false, 'message' => $invalid->getMessage()]);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    // Undo the permission file write, since the rollback above cannot. Absent
    // before means the role was answering from its code preset, so the way back
    // is to remove the entry rather than to store an empty one.
    if (isset($rbacRollback, $roleId)) {
        try {
            if (!empty($rbacRollback['has_saved_permissions'])) {
                api_rbac_store_save_role((int)$roleId, $rbacRollback['permissions'] ?? []);
            } else {
                api_rbac_store_clear_role((int)$roleId);
            }
        } catch (Throwable $restoreError) {
            api_log_exception($restoreError, [
                'endpoint' => 'role_permissions.php',
                'note' => 'permission store could not be rolled back',
                'role_id' => (int)$roleId,
            ]);
        }
    }
    api_log_exception($e, [
        'endpoint' => 'role_permissions.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
        'role_id' => isset($roleId) ? (int)$roleId : null,
    ]);
    permissions_out(500, ['success' => false, 'message' => 'Server error']);
}
