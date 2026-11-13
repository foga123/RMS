<?php
// user.php: Unified CRUD for user management
// Supports: GET (list/show), POST (create), PUT/PATCH (update), DELETE (remove)

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/middleware/auth_tokens.php';
// A student's login and student record are one person - see the PUT branch.
require_once __DIR__ . '/lib/student_fields.php';
require_once __DIR__ . '/lib/student_account.php';

// Use centralized secure headers instead of manual CORS
api_send_headers(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
api_handle_preflight();



function get_archived_status_id(PDO $pdo, $createIfMissing = false) {
    $sel = $pdo->prepare('SELECT status_id FROM status WHERE status_type = :type AND LOWER(status_name) = :name LIMIT 1');
    $sel->execute([':type' => 'account', ':name' => 'archived']);
    $statusId = (int)$sel->fetchColumn();
    if ($statusId > 0 || !$createIfMissing) return $statusId;

    return 0;
}

function user_display_name(array $row): string {
    $fullName = trim(((string)($row['first_name'] ?? '')) . ' ' . ((string)($row['last_name'] ?? '')));
    if ($fullName !== '') {
        return $fullName;
    }

    $email = trim((string)($row['email'] ?? ''));
    if ($email !== '') {
        return $email;
    }

    $userId = (int)($row['user_id'] ?? 0);
    return $userId > 0 ? ('User #' . $userId) : 'User';
}

/**
 * Is this account the administrator?
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * There is one Admin account and the whole system hangs off it. Access
 * Management, Settings, the risk model, both remark policy editors and every
 * RBAC screen are gated on it, and login.php refuses any account whose status is
 * not 1 (api_user_is_active). So archiving, deactivating, deleting or demoting
 * that one account locks every one of those screens for good -- and there is no
 * way back through the UI, because the screen that could undo it is the screen
 * that just became unreachable. Recovery means hand-editing the database.
 *
 * None of the four routes was guarded. A plain `PUT {"status": 2}` archived it,
 * and `DELETE ?id=` removed it permanently.
 *
 * Checked by ROLE, not by user id. Hardcoding user_id 3 would protect this
 * database and silently protect nothing in a fresh one, which is the worst
 * possible outcome for a guard: it looks tested.
 * ---------------------------------------------------------------------------
 *
 * Resolved from the id map first and the role NAME second. The map is how the
 * rest of the codebase resolves a role, and the name is a fallback for a
 * database where somebody renumbered roles -- if either says admin, the account
 * is protected. A guard that fails open is not a guard.
 */
function user_row_is_admin(?array $row): bool {
    if (!$row) {
        return false;
    }

    $roleId = (int)($row['role_id'] ?? $row['role'] ?? 0);
    if ($roleId > 0 && api_role_slug_from_id($roleId) === 'admin') {
        return true;
    }

    return api_normalize_role_token($row['role_name'] ?? '') === 'admin';
}

/** The account with its role, enough for user_row_is_admin() to judge it. */
function user_fetch_role_row(PDO $pdo, int $userId): ?array {
    $stmt = $pdo->prepare(
        'SELECT u.user_id, u.role AS role_id, u.status, u.email, u.first_name, u.last_name,
                r.role_name
           FROM user u
           LEFT JOIN role r ON r.role_id = u.role
          WHERE u.user_id = :id
          LIMIT 1'
    );
    $stmt->execute([':id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

/**
 * Refuse anything that would take the administrator out of service.
 *
 * One function for all four routes rather than a check at each, because the
 * routes do not look alike -- a status field, an `archived` boolean, a role
 * change and a DELETE -- and four separately-written guards is four chances to
 * miss one. The next route added to this file gets the guard by calling this.
 *
 * 409 rather than 403: the caller has permission, and saying "forbidden" invites
 * them to go looking for the permission that would allow it. There isn't one.
 */
function user_guard_admin(PDO $pdo, int $userId, string $what): void {
    $row = user_fetch_role_row($pdo, $userId);
    if (!user_row_is_admin($row)) {
        return;
    }

    api_out(409, [
        // One sentence for the reason, phrased so it reads correctly after any of
        // the four verbs. "an inactive account cannot sign in" was true of two
        // of them and nonsense after "deleted".
        'message' => 'The administrator account cannot be ' . $what . '. It is the only account that can reach '
            . 'Access Management and Settings, so this would lock the system with no way back in.',
        'code' => 'admin_account_protected',
    ]);
}

function user_status_label(array $row): string {
    $statusName = trim((string)($row['status_name'] ?? ''));
    if ($statusName !== '') {
        return $statusName;
    }

    $statusId = isset($row['status']) ? (int)$row['status'] : 0;
    if ($statusId === 1) return 'Active';
    if ($statusId === 2) return 'Inactive';
    if ($statusId > 0) return 'Archived';

    return 'Unknown';
}

function user_is_archived_like_status(int $statusId, int $archivedStatusId = 0): bool {
    if ($statusId === 2) {
        return true;
    }

    return $archivedStatusId > 0 && $statusId === $archivedStatusId;
}

function user_archived_status_filter(PDO $pdo, string $column = 'u.status', string $paramPrefix = 'user_archived'): array {
    $archivedStatusId = get_archived_status_id($pdo, false);
    $conditions = ["$column = :{$paramPrefix}_legacy_inactive_status"];
    $params = [
        ":{$paramPrefix}_legacy_inactive_status" => 2,
    ];

    if ($archivedStatusId > 0) {
        $conditions[] = "$column = :{$paramPrefix}_archived_status_id";
        $params[":{$paramPrefix}_archived_status_id"] = $archivedStatusId;
    }

    return [
        'condition' => '(' . implode(' OR ', $conditions) . ')',
        'params' => $params,
        'archived_status_id' => $archivedStatusId,
    ];
}

function user_write_audit_log_safe(PDO $pdo, ?array $actor, string $action, string $detail, array $metadata = []): void {
    try {
        api_write_audit_log($pdo, $actor, $action, $detail, $metadata);
    } catch (Throwable $auditError) {
        api_log_exception($auditError, [
            'endpoint' => 'user.php',
            'audit_action' => $action,
        ]);
    }
}

function user_delete_blocked_message(PDO $pdo, int $userId): string {
    // Only called after a DELETE already failed with a foreign-key violation,
    // so these lookups cost nothing on the normal path. Each one names the
    // relationship that is holding the row so the caller knows what to fix.
    $checks = [
        ['SELECT 1 FROM student WHERE user_id = :id LIMIT 1',
            'This user is linked to a student record. Archive or unlink that student first.'],
        ['SELECT 1 FROM ssp_assignment WHERE caller_user_id = :id LIMIT 1',
            'This user is the assigned caller for one or more students. Reassign those students first.'],
        ['SELECT 1 FROM ssp_assignment WHERE assigned_by_user_id = :id LIMIT 1',
            'This user assigned one or more SSP callers. Reassign those students first.'],
        ['SELECT 1 FROM coaching_unit WHERE user_id = :id LIMIT 1',
            'This user is linked to a coaching unit. Remove that link first.'],
    ];

    foreach ($checks as [$sql, $message]) {
        try {
            $stmt = $pdo->prepare($sql);
            $stmt->execute([':id' => $userId]);
            if ($stmt->fetchColumn() !== false) {
                return $message;
            }
        } catch (Throwable $ignored) {
            // A missing table here must not turn a 409 into a 500.
        }
    }

    return 'Cannot delete this user because other records still reference it.';
}

function user_table_has_campus_column(PDO $pdo): bool {
    return function_exists('api_user_table_has_campus_column')
        ? api_user_table_has_campus_column($pdo)
        : false;
}

function user_table_has_phone_column(PDO $pdo): bool {
    return function_exists('api_user_table_has_phone_column')
        ? api_user_table_has_phone_column($pdo)
        : false;
}

function user_table_has_updated_at_column(PDO $pdo): bool {
    static $hasColumn = null;

    if ($hasColumn !== null) {
        return $hasColumn;
    }

    $stmt = $pdo->query("SHOW COLUMNS FROM `user` LIKE 'updated_at'");
    $hasColumn = (bool)$stmt->fetch(PDO::FETCH_ASSOC);

    return $hasColumn;
}

function resolved_user_campus_expr(PDO $pdo, string $userAlias = 'u', string $departmentAlias = 'd'): string {
    if (user_table_has_campus_column($pdo)) {
        return "COALESCE($userAlias.campus_id, $departmentAlias.campus_id)";
    }

    return "$departmentAlias.campus_id";
}

function user_campus_join_sql(PDO $pdo, string $campusAlias = 'c', string $userAlias = 'u', string $departmentAlias = 'd'): string {
    return "LEFT JOIN campus $campusAlias ON $campusAlias.campus_id = " . resolved_user_campus_expr($pdo, $userAlias, $departmentAlias);
}

function user_select_sql(PDO $pdo): string {
    $campusExpr = resolved_user_campus_expr($pdo);
    $campusJoin = user_campus_join_sql($pdo);
    $phoneExpr = user_table_has_phone_column($pdo)
        ? "COALESCE(NULLIF(TRIM(u.phone_number), ''), NULLIF(TRIM(st.mobile_number), ''))"
        : "NULLIF(TRIM(st.mobile_number), '')";
    $updatedAtExpr = user_table_has_updated_at_column($pdo)
        ? 'u.updated_at'
        : 'u.created_at';

    return "SELECT u.user_id, u.first_name, u.last_name, u.email, u.status,
                   NULLIF(TRIM(SUBSTRING_INDEX(COALESCE(u.email, ''), '@', 1)), '') AS username,
                   $phoneExpr AS phone_number,
                   u.created_at,
                   $updatedAtExpr AS updated_at,
                   u.role AS role_id, r.role_name,
                   u.department AS department_id, d.department_name, $campusExpr AS campus_id, c.campus_name,
                   -- Filled in by normalize_user_row() from the RBAC store,
                   -- which is a file now rather than a table this could join.
                   0 AS custom_permissions_configured,
                   CASE
                       WHEN u.status = 2 OR LOWER(COALESCE(s.status_name, '')) = 'archived' THEN 1
                       ELSE 0
                   END AS archived,
                   s.status_name,
                   s.status_type
             FROM user u
             LEFT JOIN role r ON r.role_id = u.role
             LEFT JOIN department d ON d.department_id = u.department
             $campusJoin
             LEFT JOIN status s ON s.status_id = u.status
             LEFT JOIN student st ON st.user_id = u.user_id";
}

function user_count_from_sql(PDO $pdo): string {
    $campusJoin = user_campus_join_sql($pdo);

    return "FROM user u
            LEFT JOIN department d ON d.department_id = u.department
            $campusJoin";
}

function normalize_user_row(array $row): array {
    /*
     * Whether this user carries a permission delta. Read from the RBAC store
     * rather than joined, since the overrides moved out of the database - the
     * id set is small and the store is parsed once per request, so doing it per
     * row costs nothing.
     */
    static $overrideIds = null;
    if ($overrideIds === null) {
        $overrideIds = array_flip(api_rbac_store_user_ids_with_overrides());
    }
    $row['custom_permissions_configured'] = isset($overrideIds[(int)($row['user_id'] ?? 0)]);
    $row['archived'] = !empty($row['archived']);
    return $row;
}

function fetch_department_row(PDO $pdo, int $departmentId): ?array {
    $stmt = $pdo->prepare('SELECT department_id, campus_id FROM department WHERE department_id = :id LIMIT 1');
    $stmt->execute([':id' => $departmentId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

function normalize_user_campus_id(PDO $pdo, $campusValue, ?array $departmentRow) {
    if ($campusValue === '' || $campusValue === null) {
        $departmentCampusId = (int)($departmentRow['campus_id'] ?? 0);
        return $departmentCampusId > 0 ? $departmentCampusId : null;
    }

    $campusId = (int)$campusValue;
    if ($campusId <= 0) {
        api_out(400, ['message' => 'Valid campus_id is required']);
    }

    $campusChk = $pdo->prepare('SELECT campus_id FROM campus WHERE campus_id = :id LIMIT 1');
    $campusChk->execute([':id' => $campusId]);
    if (!$campusChk->fetch()) {
        api_out(400, ['message' => 'Selected campus does not exist']);
    }

    $departmentCampusId = (int)($departmentRow['campus_id'] ?? 0);
    if ($departmentCampusId > 0 && $departmentCampusId !== $campusId) {
        api_out(400, ['message' => 'Selected campus does not match the selected department']);
    }

    return $campusId;
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();
    $isAdmin = api_session_user_has_role($authUser, ['admin']);
    $permissionRecord = null;
    $permissionsConfigured = false;
    $canViewUsersByPermission = false;
    if (!empty($authUser['role_id']) || !empty($authUser['user_id'])) {
        $permissionRecord = api_fetch_effective_permissions_record(
            $pdo,
            (int)($authUser['role_id'] ?? 0),
            (int)($authUser['user_id'] ?? 0)
        );
        $permissionsConfigured = !empty($permissionRecord['has_saved_permissions']);
        if ($permissionsConfigured) {
            $canViewUsersByPermission = api_can($permissionRecord['permissions'], 'users', 'view');
        }
    }

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        // If id is provided, return single user; else return list (with optional basic search/pagination)
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        $canBrowseUsers = $isAdmin || ($permissionsConfigured && $canViewUsersByPermission);
        if (!$canBrowseUsers) {
            if ($id <= 0) api_out(403, ['message' => 'Forbidden']);
            if ($id !== (int)($authUser['user_id'] ?? 0)) api_out(403, ['message' => 'Forbidden']);
        }
        if ($id > 0) {
            $sel = $pdo->prepare(user_select_sql($pdo) . ' WHERE u.user_id = :id LIMIT 1');
            $sel->execute([':id' => $id]);
            $row = $sel->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'User not found']);
            api_out(200, ['data' => normalize_user_row($row)]);
        }

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $roleId = isset($_GET['role_id']) ? (int)$_GET['role_id'] : 0;
        $departmentId = isset($_GET['department_id']) ? (int)$_GET['department_id'] : 0;
        $campusId = isset($_GET['campus_id']) ? (int)$_GET['campus_id'] : 0;
        $statusRaw = isset($_GET['status']) ? trim((string)$_GET['status']) : '';
        $archivedOnly = api_bool_like($_GET['archived'] ?? null, false);
        $includeArchived = api_bool_like($_GET['include_archived'] ?? null, false);
        $archivedStatusId = get_archived_status_id($pdo, false);
        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(100, (int)$_GET['limit'])) : 1000; // default large to mimic get-all
        $offset = ($page - 1) * $limit;

        $whereParts = [];
        $params = [];
        if ($search !== '') {
            $whereParts[] = '(u.email LIKE :q OR u.first_name LIKE :q OR u.last_name LIKE :q OR d.department_name LIKE :q OR c.campus_name LIKE :q)';
            $params[':q'] = "%$search%";
        }
        if ($roleId > 0) {
            $whereParts[] = 'u.role = :role_id';
            $params[':role_id'] = $roleId;
        }
        if ($departmentId > 0) {
            $whereParts[] = 'u.department = :department_id';
            $params[':department_id'] = $departmentId;
        }
        if ($campusId > 0) {
            $whereParts[] = resolved_user_campus_expr($pdo) . ' = :campus_id';
            $params[':campus_id'] = $campusId;
        }
        if ($statusRaw !== '') {
            $statusId = (int)$statusRaw;
            if ($statusId === 0) $statusId = 2; // legacy inactive mapping
            $allowedStatuses = [1, 2];
            if ($archivedStatusId > 0) $allowedStatuses[] = $archivedStatusId;
            if (in_array($statusId, $allowedStatuses, true)) {
                $whereParts[] = 'u.status = :status_id';
                $params[':status_id'] = $statusId;
            }
        }
        if ($archivedOnly) {
            $archivedFilter = user_archived_status_filter($pdo, 'u.status', 'archived_only');
            $whereParts[] = $archivedFilter['condition'];
            $params = array_merge($params, $archivedFilter['params']);
        } elseif (!$includeArchived && $statusRaw === '') {
            $archivedFilter = user_archived_status_filter($pdo, 'u.status', 'active_list');
            $whereParts[] = 'NOT ' . $archivedFilter['condition'];
            $params = array_merge($params, $archivedFilter['params']);
        }
        $where = !empty($whereParts) ? ('WHERE ' . implode(' AND ', $whereParts)) : '';

        $sql = user_select_sql($pdo) . "
                $where
                ORDER BY u.user_id ASC
                LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = array_map('normalize_user_row', $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

        // Total count
        $countSql = 'SELECT COUNT(*) ' . user_count_from_sql($pdo) . ' ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) { $countStmt->bindValue($k, $v); }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => [ 'page' => $page, 'limit' => $limit, 'total' => $total ]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        /*
         * The same refusal the PUT branch makes, which create did not make at
         * all: POST /user.php accepted <script>alert(1)</script> as a first name
         * and stored it. Editing that same user afterwards was refused, so the
         * two routes disagreed about what a name may contain, and the one with
         * no guard was the one that decides what goes into the table.
         *
         * 'strict' for all three, matching the update path: a name and an email
         * are identifiers, not prose, so the looser rule that exists for
         * sentences would be the wrong one to apply here.
         */
        $unsafe = api_reject_unsafe_fields($payload, [
            'first_name' => 'First name',
            'last_name' => 'Last name',
            'email' => 'Email',
        ], 'strict');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $first = trim((string)($payload['first_name'] ?? ''));
        $last = trim((string)($payload['last_name'] ?? ''));
        $email = trim((string)($payload['email'] ?? ''));
        $roleId = $payload['role_id'] ?? null;
        $departmentId = null;
        if (array_key_exists('department_id', $payload)) {
            $departmentId = (int)$payload['department_id'];
        } elseif (array_key_exists('department', $payload)) {
            $departmentId = (int)$payload['department'];
        }
        $campusId = array_key_exists('campus_id', $payload) ? $payload['campus_id'] : null;
        $status = $payload['status'] ?? 1; // UI default Active

        if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
            api_out(400, ['message' => 'Valid email is required']);
        }
        if (!$departmentId || $departmentId <= 0) {
            api_out(400, ['message' => 'department_id is required']);
        }

        $departmentRow = fetch_department_row($pdo, $departmentId);
        if (!$departmentRow) {
            api_out(400, ['message' => 'Selected department does not exist']);
        }

        $persistedCampusId = null;
        if (user_table_has_campus_column($pdo)) {
            $persistedCampusId = normalize_user_campus_id($pdo, $campusId, $departmentRow);
        }

        // Normalize status: 1=Active, 2=Inactive/Archive intent (map 0->2 for legacy UI)
        $status = (int)$status;
        if ($status === 0) $status = 2;
        if ($status === 2) {
            $status = get_archived_status_id($pdo, true);
            if ($status <= 0) {
                api_out(500, ['message' => 'Failed to resolve archived status']);
            }
        } else {
            $archivedStatusId = get_archived_status_id($pdo, false);
            if ($status !== 1 && ($archivedStatusId <= 0 || $status !== $archivedStatusId)) {
                $status = 1;
            }
        }

        // Prevent duplicate emails
        $chk = $pdo->prepare('SELECT user_id FROM user WHERE email = :email LIMIT 1');
        $chk->execute([':email' => $email]);
        if ($chk->fetch()) api_out(409, ['message' => 'Email already exists']);

        // Generate a secure random temporary password instead of the insecure default "123".
        $passwordRaw = array_key_exists('password', $payload) ? trim((string)$payload['password']) : '';
        if ($passwordRaw !== '') {
            $passwordError = api_validate_password_strength($passwordRaw);
            if ($passwordError !== null) {
                api_out(400, ['message' => $passwordError]);
            }
            $passwordPlain = $passwordRaw;
        } else {
            // Generate a random 12-character temporary password
            $passwordPlain = bin2hex(random_bytes(6));
        }
        $passwordHash = password_hash($passwordPlain, PASSWORD_DEFAULT);
        $roleCol = is_null($roleId) || $roleId === '' ? null : (int)$roleId;

        if (user_table_has_campus_column($pdo)) {
            $ins = $pdo->prepare('INSERT INTO user (first_name, last_name, role, department, campus_id, status, email, password) VALUES (:first, :last, :role, :department, :campus_id, :status, :email, :pwd)');
            $ins->execute([
                ':first' => $first !== '' ? $first : null,
                ':last' => $last !== '' ? $last : null,
                ':role' => $roleCol,
                ':department' => $departmentId,
                ':campus_id' => $persistedCampusId,
                ':status' => $status,
                ':email' => $email,
                ':pwd' => $passwordHash,
            ]);
        } else {
            $ins = $pdo->prepare('INSERT INTO user (first_name, last_name, role, department, status, email, password) VALUES (:first, :last, :role, :department, :status, :email, :pwd)');
            $ins->execute([
                ':first' => $first !== '' ? $first : null,
                ':last' => $last !== '' ? $last : null,
                ':role' => $roleCol,
                ':department' => $departmentId,
                ':status' => $status,
                ':email' => $email,
                ':pwd' => $passwordHash,
            ]);
        }

        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare(user_select_sql($pdo) . ' WHERE u.user_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);
        $normalizedRow = $row ? normalize_user_row($row) : null;
        if ($normalizedRow) {
            $normalizedRow['password_expiration'] = api_password_expiration_record_password_changed(
                $pdo,
                $newId,
                $normalizedRow['created_at'] ?? null
            );
        }

        if ($normalizedRow) {
            $createdName = user_display_name($normalizedRow);
            api_notifications_try_create($pdo, [
                'event_key' => 'user_created',
                'level' => 'success',
                'title' => 'New account created',
                'message' => $createdName . ' was added to the system.',
                'module_key' => 'users',
                'entity_type' => 'user',
                'entity_id' => $newId,
                'actor_user_id' => (int)($authUser['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'view' => 'users',
                ],
                'metadata' => [
                    'user_id' => $newId,
                    'email' => $normalizedRow['email'] ?? null,
                    'role_id' => isset($normalizedRow['role_id']) ? (int)$normalizedRow['role_id'] : null,
                    'role_name' => $normalizedRow['role_name'] ?? null,
                ],
                'recipients' => [
                    'module_targets' => [
                        ['module' => 'users', 'action' => 'view'],
                    ],
                ],
            ], [
                'endpoint' => 'user.php',
                'event_key' => 'user_created',
                'target_user_id' => $newId,
            ]);

            api_notifications_try_create($pdo, [
                'event_key' => 'account_created_personal',
                'level' => 'success',
                'title' => 'Your account is ready',
                'message' => 'Your account has been created. You can review your profile information after signing in.',
                'entity_type' => 'user',
                'entity_id' => $newId,
                'actor_user_id' => (int)($authUser['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'overlay' => 'profile',
                ],
                'recipients' => [
                    'user_ids' => [$newId],
                ],
            ], [
                'endpoint' => 'user.php',
                'event_key' => 'account_created_personal',
                'target_user_id' => $newId,
            ]);
        }

        // Named with the role, because "an account was created" and "an Admin
        // account was created" are not the same event to whoever reads this later.
        user_write_audit_log_safe(
            $pdo,
            $authUser,
            'user_created',
            'Created user "' . user_display_name($normalizedRow ?: []) . '"'
                . (!empty($normalizedRow['role_name']) ? ' with the role ' . $normalizedRow['role_name'] : '')
                . '.',
            [
                'target_user_id' => $newId,
                'target_email' => $normalizedRow['email'] ?? null,
                'role_id' => $normalizedRow['role_id'] ?? null,
            ]
        );

        api_out(201, ['message' => 'User created', 'data' => $normalizedRow]);
    }

    if ($method === 'PUT' || $method === 'PATCH') {
        // Accept id via query string (?id=) or body { user_id }
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (is_array($payload) && !$id) {
            $id = isset($payload['user_id']) ? (int)$payload['user_id'] : 0;
        }
        if ($id <= 0) api_out(400, ['message' => 'Valid user id is required']);

        // Ensure user exists
        $existingSelectSql = user_table_has_campus_column($pdo)
            ? 'SELECT u.user_id, u.email, u.first_name, u.last_name, u.role, u.department, u.campus_id, u.status, s.status_name
               FROM user u
               LEFT JOIN status s ON s.status_id = u.status
               WHERE u.user_id = :id
               LIMIT 1'
            : 'SELECT u.user_id, u.email, u.first_name, u.last_name, u.role, u.department, u.status, s.status_name
               FROM user u
               LEFT JOIN status s ON s.status_id = u.status
               WHERE u.user_id = :id
               LIMIT 1';
        $chk = $pdo->prepare($existingSelectSql);
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'User not found']);

        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);


        /*
         * Injection guard. See api_reject_unsafe_text() in middleware/auth.php
         * for the two levels and why refusing on input beats escaping on output.
         * Names and codes are identifiers ('strict'); anything that is a
         * sentence is 'prose', which allows the brackets and question marks real
         * writing contains.
         */
        $unsafe = api_reject_unsafe_fields($payload, [
            'first_name' => 'First name',
            'last_name' => 'Last name',
            'email' => 'Email',
        ], 'strict');
        /*
         * This line read `out(400, ...)`, and no out() has ever existed in this
         * file - every other response here went through json_out(), now api_out().
         * So instead of the 400 it looks like, it was a fatal "call to undefined
         * function", on the path taken whenever a name or email contains
         * something api_reject_unsafe_fields refuses. The request most likely to
         * be hostile was the one getting a 500 instead of a clean refusal.
         */
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        $email = isset($payload['email']) ? trim((string)$payload['email']) : null;
        $first = isset($payload['first_name']) ? trim((string)$payload['first_name']) : null;
        $last = isset($payload['last_name']) ? trim((string)$payload['last_name']) : null;
        $roleId = array_key_exists('role_id', $payload) ? $payload['role_id'] : null;
        $departmentId = null;
        if (array_key_exists('department_id', $payload)) {
            $departmentId = $payload['department_id'];
        } elseif (array_key_exists('department', $payload)) {
            $departmentId = $payload['department'];
        }
        $campusId = array_key_exists('campus_id', $payload) ? $payload['campus_id'] : null;
        $status = array_key_exists('status', $payload) ? (int)$payload['status'] : null;
        $password = array_key_exists('password', $payload) ? (string)$payload['password'] : null;
        $passwordChanged = false;
        $archivedProvided = array_key_exists('archived', $payload);
        $archived = $archivedProvided ? api_bool_like($payload['archived'], false) : null;
        $existingStatus = (int)($existing['status'] ?? 0);
        $archivedStatusId = get_archived_status_id($pdo, false);
        $statusChangeAction = null;
        $inactiveRequested = false;
        $resolvedStatus = null;

        if ($archivedProvided) {
            if ($archived) {
                $archivedStatusId = get_archived_status_id($pdo, true);
                if ($archivedStatusId <= 0) api_out(500, ['message' => 'Failed to resolve archived status']);
                $resolvedStatus = $archivedStatusId;
                $statusChangeAction = 'archive';
            } else {
                $resolvedStatus = 1;
                if (user_is_archived_like_status($existingStatus, $archivedStatusId)) {
                    $statusChangeAction = 'restore';
                }
            }
        } elseif ($status !== null) {
            if ($status === 0) $status = 2; // map 0->2 per UI
            if ($status === 2) {
                $inactiveRequested = true;
                $archivedStatusId = get_archived_status_id($pdo, true);
                if ($archivedStatusId <= 0) api_out(500, ['message' => 'Failed to resolve archived status']);
                $resolvedStatus = $archivedStatusId;
                $statusChangeAction = 'archive';
            } elseif ($status === 1) {
                $resolvedStatus = 1;
                if (user_is_archived_like_status($existingStatus, $archivedStatusId)) {
                    $statusChangeAction = 'restore';
                }
            } elseif ($archivedStatusId > 0 && $status === $archivedStatusId) {
                $resolvedStatus = $archivedStatusId;
                $statusChangeAction = 'archive';
            } else {
                api_out(400, ['message' => 'Unsupported status value']);
            }
        }

        /*
         * The administrator may not be taken out of service.
         *
         * Checked against the RESOLVED intent rather than the raw payload, so
         * both spellings are covered: `{"archived": true}` and `{"status": 2}`
         * arrive as different fields and both end up here as 'archive'.
         * Restoring is always allowed -- that direction only ever helps.
         */
        if ($statusChangeAction === 'archive') {
            user_guard_admin($pdo, $id, 'archived or set inactive');
        }

        if ($statusChangeAction !== null && (!empty($authUser['role_id']) || !empty($authUser['user_id']))) {
            $permissionRecord = api_fetch_effective_permissions_record(
                $pdo,
                (int)($authUser['role_id'] ?? 0),
                (int)($authUser['user_id'] ?? 0)
            );
            if (!empty($permissionRecord['has_saved_permissions'])) {
                $requiredAction = $statusChangeAction === 'restore' ? 'restore' : 'archive';
                if (!api_can($permissionRecord['permissions'], 'users', $requiredAction)) {
                    api_out(403, ['message' => $requiredAction === 'archive'
                        ? 'You do not have permission to archive users.'
                        : 'You do not have permission to restore users.']);
                }
            }
        }

        $fields = [];
        $params = [':id' => $id];
        $effectiveDepartmentId = (int)($existing['department'] ?? 0);

        if ($email !== null) {
            if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) api_out(400, ['message' => 'Valid email is required']);
            // unique email if changed
            if ($email !== $existing['email']) {
                $dup = $pdo->prepare('SELECT user_id FROM user WHERE email = :email AND user_id <> :id LIMIT 1');
                $dup->execute([':email' => $email, ':id' => $id]);
                if ($dup->fetch()) api_out(409, ['message' => 'Email already exists']);
            }
            $fields[] = 'email = :email';
            $params[':email'] = $email;
        }

        if ($first !== null) { $fields[] = 'first_name = :first'; $params[':first'] = ($first !== '' ? $first : null); }
        if ($last !== null)  { $fields[] = 'last_name = :last';  $params[':last']  = ($last !== '' ? $last : null); }
        /*
         * Demoting the administrator empties the Admin role as completely as
         * archiving the account does, and locks exactly the same screens. The
         * account survives; the access does not. Same guard, different field.
         */
        if ($roleId !== null) {
            $nextRoleId = ($roleId === '' || $roleId === null) ? 0 : (int)$roleId;
            if ($nextRoleId <= 0 || api_role_slug_from_id($nextRoleId) !== 'admin') {
                user_guard_admin($pdo, $id, 'moved to another role');
            }
            $fields[] = 'role = :role';
            $params[':role'] = $nextRoleId > 0 ? $nextRoleId : null;
        }
        if ($departmentId !== null) {
            if ($departmentId === '' || $departmentId === null) api_out(400, ['message' => 'Valid department_id is required']);
            $departmentIdInt = (int)$departmentId;
            if ($departmentIdInt <= 0) api_out(400, ['message' => 'Valid department_id is required']);
            $departmentRow = fetch_department_row($pdo, $departmentIdInt);
            if (!$departmentRow) api_out(400, ['message' => 'Selected department does not exist']);
            $fields[] = 'department = :department';
            $params[':department'] = $departmentIdInt;
            $effectiveDepartmentId = $departmentIdInt;
        }
        if (user_table_has_campus_column($pdo) && ($campusId !== null || $departmentId !== null)) {
            $effectiveDepartmentRow = $effectiveDepartmentId > 0 ? fetch_department_row($pdo, $effectiveDepartmentId) : null;
            if ($effectiveDepartmentId > 0 && !$effectiveDepartmentRow) {
                api_out(400, ['message' => 'Selected department does not exist']);
            }
            $fields[] = 'campus_id = :campus_id';
            $params[':campus_id'] = normalize_user_campus_id($pdo, $campusId, $effectiveDepartmentRow);
        }
        if ($resolvedStatus !== null) {
            $fields[] = 'status = :status';
            $params[':status'] = (int)$resolvedStatus;
        }
        if ($password !== null) {
            $password = trim($password);
            if ($password !== '') {
                $passwordError = api_validate_password_strength($password);
                if ($passwordError !== null) {
                    api_out(400, ['message' => $passwordError]);
                }
                $fields[] = 'password = :pwd';
                $params[':pwd'] = password_hash($password, PASSWORD_DEFAULT);
                $passwordChanged = true;
            }
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE user SET ' . implode(', ', $fields) . ' WHERE user_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        /*
         * A student's login and their student record are one person, and the
         * record is where the name lives. A rename made here is written to the
         * record - in capitals, the record's rule - and copied back from it, so
         * the two cannot disagree. A blank name is not carried across: the
         * record requires one.
         */
        if ($first !== null || $last !== null) {
            $linked = $pdo->prepare(
                'SELECT s.student_id FROM student s JOIN user u ON u.user_id = s.user_id
                  WHERE s.user_id = :id AND u.role = :role LIMIT 1'
            );
            $linked->execute([':id' => $id, ':role' => student_role_id($pdo)]);
            $linkedStudentId = $linked->fetchColumn();
            if ($linkedStudentId !== false) {
                $studentFields = [];
                $studentParams = [':sid' => (int)$linkedStudentId];
                if ($first !== null && $first !== '') {
                    $studentFields[] = 'first_name = :sf';
                    $studentParams[':sf'] = normalize_student_name($first);
                }
                if ($last !== null && $last !== '') {
                    $studentFields[] = 'last_name = :sl';
                    $studentParams[':sl'] = normalize_student_name($last);
                }
                if ($studentFields) {
                    $pdo->prepare('UPDATE student SET ' . implode(', ', $studentFields) . ' WHERE student_id = :sid')
                        ->execute($studentParams);
                }
                student_sync_account_names($pdo, [(int)$linkedStudentId]);
            }
        }

        /*
         * An admin resetting someone's password, or archiving them, has to reach
         * the sessions that person already has open — otherwise "deactivated" is
         * only true of future logins, and the account keeps working from a tab
         * that never signs out.
         *
         * Restoring an account revokes too, and that is on purpose: it forces a
         * sign-in with the current password instead of quietly reviving whatever
         * cookie was live when the account was archived, possibly weeks ago.
         */
        $statusChanged = $resolvedStatus !== null && $resolvedStatus !== $existingStatus;
        if ($passwordChanged || $statusChanged) {
            api_auth_revoke_all_sessions($pdo, $id);
        }

        // Return updated row
        $sel = $pdo->prepare(user_select_sql($pdo) . ' WHERE u.user_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);
        $normalizedRow = $row ? normalize_user_row($row) : null;
        if ($passwordChanged && $normalizedRow) {
            $normalizedRow['password_expiration'] = api_password_expiration_record_password_changed($pdo, $id);
        }

        if ($resolvedStatus !== null && $resolvedStatus !== $existingStatus) {
            $targetSnapshot = $normalizedRow ?: array_merge($existing, ['status' => $resolvedStatus]);
            $targetName = user_display_name($targetSnapshot);
            $auditMetadata = [
                'target_user_id' => $id,
                'target_email' => $targetSnapshot['email'] ?? null,
                'target_name' => $targetName,
                'before_status' => user_status_label($existing),
                'after_status' => user_status_label($targetSnapshot),
            ];

            if ($inactiveRequested) {
                user_write_audit_log_safe(
                    $pdo,
                    $authUser,
                    'user_inactivated',
                    'Set user "' . $targetName . '" to Inactive and moved the account to archive.',
                    $auditMetadata + ['archive_source' => 'inactive_status']
                );
            }

            if ($statusChangeAction === 'archive') {
                user_write_audit_log_safe(
                    $pdo,
                    $authUser,
                    'user_archived',
                    'Archived user "' . $targetName . '".',
                    $auditMetadata + ['archive_source' => $inactiveRequested ? 'inactive_status' : 'archive_action']
                );
            } elseif ($statusChangeAction === 'restore') {
                user_write_audit_log_safe(
                    $pdo,
                    $authUser,
                    'user_restored',
                    'Restored user "' . $targetName . '" to Active.',
                    $auditMetadata
                );
            }

            $statusTitle = $statusChangeAction === 'restore'
                ? 'User restored'
                : ($inactiveRequested ? 'User set to Inactive' : 'User archived');
            $statusMessage = $statusChangeAction === 'restore'
                ? ($targetName . ' is active again.')
                : ($targetName . ' was moved to Archived Users.');
            api_notifications_try_create($pdo, [
                'event_key' => $statusChangeAction === 'restore' ? 'user_restored' : 'user_status_changed',
                'level' => $statusChangeAction === 'restore' ? 'success' : 'warning',
                'title' => $statusTitle,
                'message' => $statusMessage,
                'module_key' => 'users',
                'entity_type' => 'user',
                'entity_id' => $id,
                'actor_user_id' => (int)($authUser['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'view' => 'users',
                ],
                'metadata' => $auditMetadata + [
                    'status_change_action' => $statusChangeAction,
                ],
                'recipients' => [
                    'module_targets' => [
                        ['module' => 'users', 'action' => 'view'],
                    ],
                ],
            ], [
                'endpoint' => 'user.php',
                'event_key' => $statusChangeAction === 'restore' ? 'user_restored' : 'user_status_changed',
                'target_user_id' => $id,
            ]);

            api_notifications_try_create($pdo, [
                'event_key' => $statusChangeAction === 'restore' ? 'account_restored_personal' : 'account_status_changed_personal',
                'level' => $statusChangeAction === 'restore' ? 'success' : 'warning',
                'title' => $statusChangeAction === 'restore' ? 'Your account was restored' : 'Your account status changed',
                'message' => $statusChangeAction === 'restore'
                    ? 'Your account is active again.'
                    : 'Your account was moved to Archived Users.',
                'entity_type' => 'user',
                'entity_id' => $id,
                'actor_user_id' => (int)($authUser['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'overlay' => 'profile',
                ],
                'metadata' => $auditMetadata + [
                    'status_change_action' => $statusChangeAction,
                ],
                'recipients' => [
                    'user_ids' => [$id],
                ],
            ], [
                'endpoint' => 'user.php',
                'event_key' => $statusChangeAction === 'restore' ? 'account_restored_personal' : 'account_status_changed_personal',
                'target_user_id' => $id,
            ]);
        }

        /*
         * The edit itself, named field by field.
         *
         * Archiving and restoring were audited; every other change to an account
         * was not. Someone's role could be raised to Admin, or their password
         * reset by another administrator, and the audit log held no trace of it —
         * which is the one question an audit log exists to answer.
         *
         * `status` is excluded because the block above already recorded it under
         * a name that says what happened ("Archived user X"). Listing it here as
         * well would put two rows in the log for one act.
         *
         * The new value is deliberately NOT recorded for the password. That it
         * was changed, by whom, and when is the audit fact; the value is not.
         */
        $changedColumns = array_map(
            static function (string $assignment): string {
                return trim(strtok($assignment, '='));
            },
            $fields
        );
        $reportedColumns = array_values(array_diff($changedColumns, ['status']));

        if (!empty($reportedColumns)) {
            $columnLabels = [
                'email' => 'email',
                'first_name' => 'first name',
                'last_name' => 'last name',
                'role' => 'role',
                'department' => 'department',
                'campus_id' => 'campus',
                'password' => 'password',
            ];
            $changedLabels = array_map(
                static function (string $column) use ($columnLabels): string {
                    return $columnLabels[$column] ?? $column;
                },
                $reportedColumns
            );

            $editedName = user_display_name($normalizedRow ?: $existing);
            user_write_audit_log_safe(
                $pdo,
                $authUser,
                $passwordChanged && $reportedColumns === ['password'] ? 'user_password_changed' : 'user_updated',
                'Changed ' . implode(', ', $changedLabels) . ' for user "' . $editedName . '".',
                [
                    'target_user_id' => $id,
                    'target_email' => $normalizedRow['email'] ?? ($existing['email'] ?? null),
                    'changed' => $reportedColumns,
                ]
            );
        }

        if ($id === (int)($authUser['user_id'] ?? 0)) {
            $sessionRow = api_fetch_user_context($pdo, $id, false);
            if ($sessionRow) {
                api_store_authenticated_user($sessionRow, false);
            }
        }

        $responseMessage = 'User updated';
        if ($statusChangeAction === 'archive') {
            $responseMessage = $inactiveRequested ? 'User moved to archive' : 'User archived';
        } elseif ($statusChangeAction === 'restore') {
            $responseMessage = 'User restored';
        }

        api_out(200, ['message' => $responseMessage, 'data' => $normalizedRow]);
    }

    if ($method === 'DELETE') {
        // Accept id via query string (?id=) or body { user_id }
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) {
            $raw = file_get_contents('php://input');
            $payload = json_decode($raw, true);
            if (is_array($payload)) {
                $id = isset($payload['user_id']) ? (int)$payload['user_id'] : 0;
            }
        }
        if ($id <= 0) api_out(400, ['message' => 'Valid user id is required']);

        /*
         * Ensure the user exists — and read enough of the row to describe it
         * afterwards. Reading it BEFORE the delete is the whole point: this is a
         * hard delete, so once it succeeds there is nothing left to look up, and
         * an audit entry reading "deleted user #47" names a row nobody can
         * resolve to a person any more.
         */
        $chk = $pdo->prepare('SELECT user_id, email, first_name, last_name FROM user WHERE user_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $doomed = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$doomed) api_out(404, ['message' => 'User not found']);

        // The worst of the four routes: this is a hard delete, so unlike an
        // archive there is no row left to restore afterwards.
        user_guard_admin($pdo, $id, 'deleted');

        // Hard delete (no archive column known). If you prefer soft delete, add an is_archived column and replace with an UPDATE.
        $del = $pdo->prepare('DELETE FROM user WHERE user_id = :id');
        try {
            $del->execute([':id' => $id]);
        } catch (PDOException $e) {
            if ($e->getCode() === '23000') {
                api_out(409, ['message' => user_delete_blocked_message($pdo, $id)]);
            }
            throw $e;
        }

        user_write_audit_log_safe(
            $pdo,
            $authUser,
            'user_deleted',
            'Permanently deleted user "' . user_display_name($doomed) . '" (' . ($doomed['email'] ?: 'no email') . ').',
            [
                'target_user_id' => $id,
                'target_email' => $doomed['email'] ?? null,
            ]
        );

        api_out(200, ['message' => 'User deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_log_exception($e, [
        'endpoint' => 'user.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    ]);
    api_out(500, ['message' => 'Server error']);
}
