<?php

function api_notifications_ensure_tables(PDO $pdo): void
{
    static $initialized = [];

    $key = spl_object_id($pdo);
    if (!empty($initialized[$key])) {
        return;
    }

    api_require_table($pdo, 'system_notification');
    api_require_table($pdo, 'system_notification_recipient');

    $initialized[$key] = true;
}

function api_notifications_normalize_level($value): string
{
    $level = strtolower(trim((string)$value));
    if (!in_array($level, ['info', 'success', 'warning', 'error'], true)) {
        return 'info';
    }

    return $level;
}

function api_notifications_encode_metadata($value): ?string
{
    if (!is_array($value) || empty($value)) {
        return null;
    }

    $json = json_encode($value, JSON_UNESCAPED_UNICODE);
    return $json !== false ? $json : null;
}

function api_notifications_decode_metadata($value): array
{
    if (!is_string($value) || trim($value) === '') {
        return [];
    }

    $decoded = json_decode($value, true);
    return is_array($decoded) ? $decoded : [];
}

function api_notifications_normalize_target(array $target): array
{
    return [
        'view' => trim((string)($target['view'] ?? '')) ?: null,
        'report' => trim((string)($target['report'] ?? '')) ?: null,
        'section' => trim((string)($target['section'] ?? '')) ?: null,
        'overlay' => trim((string)($target['overlay'] ?? '')) ?: null,
    ];
}

function api_notifications_has_target_destination(array $target): bool
{
    return ($target['view'] ?? null) !== null
        || ($target['report'] ?? null) !== null
        || ($target['section'] ?? null) !== null
        || ($target['overlay'] ?? null) !== null;
}

function api_notifications_module_label($value): ?string
{
    $moduleKey = api_normalize_permission_module_key($value);
    $labels = [
        'overview' => 'Overview',
        'dashboard' => 'Dashboard',
        'workspace' => 'Workspace',
        'users' => 'User Management',
        'student_manage' => 'Student Management',
        'departments' => 'Department Management',
        'roles' => 'Roles/Permissions',
        'courses' => 'Course Management',
        'grades' => 'Grades Management',
        'remarks' => 'Remarks Management',
        'statuses' => 'Status Management',
        'campuses' => 'Campus Management',
        'enrollment_status' => 'Enrollment Status',
        'survey' => 'Surveys',
        'survey_questions' => 'Survey Questions',
        'survey_responses' => 'Responses/Submissions',
        'survey_submissions' => 'Responses/Submissions',
        'finance_management' => 'Finance Management',
        'assignments' => 'Assignments',
        'student_contacts' => 'Student Contacts',
        'home_visits' => 'Home Visits',
        'reports' => 'Reports',
        'retention_cases' => 'Retention Cases',
        'settings' => 'Settings',
    ];

    return $labels[$moduleKey] ?? null;
}

function api_notifications_make_target_payload(array $values, ?string $label = null, ?array $fallback = null): array
{
    $target = api_notifications_normalize_target($values);
    $target['label'] = trim((string)$label) ?: null;
    $target['action_label'] = 'View';

    $normalizedFallback = null;
    if (is_array($fallback)) {
        $normalizedFallback = api_notifications_normalize_target($fallback);
        if (!api_notifications_has_target_destination($normalizedFallback)) {
            $normalizedFallback = null;
        }
    }

    $target['fallback'] = $normalizedFallback;

    return $target;
}

function api_notifications_describe_target(array $target, string $moduleKey = ''): ?string
{
    $overlay = strtolower(trim((string)($target['overlay'] ?? '')));
    $view = api_normalize_permission_module_key($target['view'] ?? '');
    $section = strtolower(trim((string)($target['section'] ?? '')));

    if ($overlay === 'profile') {
        return 'Profile';
    }
    if ($overlay === 'change_password') {
        return 'Change Password';
    }

    if ($view === 'settings' && $section === 'backup') {
        return 'Backup Logs';
    }

    if (($view === 'settings' && $section === 'roleaccess') || $view === 'roles') {
        return 'Roles/Permissions';
    }

    if ($view !== '') {
        return api_notifications_module_label($view);
    }

    if ($moduleKey !== '') {
        return api_notifications_module_label($moduleKey);
    }

    return null;
}

function api_notifications_resolve_target_payload(array $row): array
{
    $eventKey = strtolower(trim((string)($row['event_key'] ?? '')));
    $moduleKey = api_normalize_permission_module_key($row['module_key'] ?? '');
    $entityType = strtolower(trim((string)($row['entity_type'] ?? '')));
    $storedTarget = api_notifications_make_target_payload([
        'view' => $row['target_view'] ?? null,
        'report' => $row['target_report'] ?? null,
        'section' => $row['target_section'] ?? null,
        'overlay' => $row['target_overlay'] ?? null,
    ]);

    /*
     * The student's own "you have already answered" receipt. It gets no
     * destination at all.
     *
     * Clearing target_view on the row was not enough: the survey_submissions
     * branch below keys off module_key and entity_type, so it overrode the
     * stored target and handed back "Go to Responses/Submissions" — a staff
     * module the student cannot open. And there is nowhere useful to send them
     * anyway; the survey is finished and cannot be changed.
     */
    if ($eventKey === 'survey_submission_confirmed') {
        return api_notifications_make_target_payload([]);
    }

    if (in_array($eventKey, ['profile_updated_personal', 'account_created_personal', 'account_restored_personal', 'account_status_changed_personal'], true)) {
        return api_notifications_make_target_payload(['overlay' => 'profile'], 'Profile');
    }

    if (in_array($eventKey, ['password_expiration_warning', 'password_expiration_expired'], true)) {
        return api_notifications_make_target_payload(['overlay' => 'change_password'], 'Change Password');
    }

    if (in_array($eventKey, ['role_permissions_changed_personal', 'access_updated_personal', 'access_cleared_personal'], true)) {
        return api_notifications_make_target_payload(
            ['view' => 'settings', 'section' => 'roleAccess'],
            'Roles/Permissions',
            ['overlay' => 'profile']
        );
    }

    if (in_array($eventKey, ['role_permissions_updated', 'user_permissions_updated', 'user_permissions_cleared'], true)) {
        return api_notifications_make_target_payload(['view' => 'settings', 'section' => 'roleAccess'], 'Roles/Permissions');
    }

    if (in_array($eventKey, ['backup_completed', 'backup_failed', 'backup_restored', 'backup_restore_failed'], true)) {
        return api_notifications_make_target_payload(['view' => 'settings', 'section' => 'backup'], 'Backup Logs');
    }

    if ($eventKey === 'survey_submission_received' || $moduleKey === 'survey_submissions' || $entityType === 'survey_submission') {
        return api_notifications_make_target_payload(['view' => 'survey_submissions'], 'Responses/Submissions');
    }

    if ($moduleKey === 'survey_responses') {
        return api_notifications_make_target_payload(['view' => 'survey_responses'], 'Responses/Submissions');
    }

    if (in_array($eventKey, ['role_created', 'role_updated', 'role_archived', 'role_restored'], true) || $moduleKey === 'roles') {
        return api_notifications_make_target_payload(['view' => 'roles'], 'Roles/Permissions');
    }

    if ($eventKey === 'profile_updated' || $moduleKey === 'users') {
        return api_notifications_make_target_payload(['view' => 'users'], 'User Management');
    }

    if (!api_notifications_has_target_destination($storedTarget) && $moduleKey !== '') {
        $fallbackValues = ['view' => $moduleKey];
        if ($moduleKey === 'settings') {
            $fallbackValues['section'] = $row['target_section'] ?? null;
        }

        return api_notifications_make_target_payload(
            $fallbackValues,
            api_notifications_describe_target($fallbackValues, $moduleKey)
        );
    }

    $storedTarget['label'] = api_notifications_describe_target($storedTarget, $moduleKey);
    return $storedTarget;
}

function api_notifications_fetch_active_users(PDO $pdo): array
{
    static $cache = [];
    $key = spl_object_id($pdo);
    if (isset($cache[$key])) {
        return $cache[$key];
    }

    $stmt = $pdo->query(
        // role_name is joined rather than derived from api_role_slug_from_id(),
        // because that map is a *permission* alias: it points role 9
        // (Secretary) at the 'ssg' slug. Fine for deciding access, wrong for
        // deciding who gets told — "notify SSG" would quietly also mean
        // Secretary. Recipients match on the role a user actually holds.
        'SELECT u.user_id, u.role AS role_id, u.department AS department_id,
                u.email, u.first_name, u.last_name, u.status, r.role_name
           FROM user u
           LEFT JOIN role r ON r.role_id = u.role
          WHERE u.status = 1
          ORDER BY u.user_id ASC'
    );

    $rows = $stmt ? ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [];
    $cache[$key] = array_values(array_filter(array_map(static function (array $row): array {
        return [
            'user_id' => (int)($row['user_id'] ?? 0),
            'role_id' => (int)($row['role_id'] ?? 0),
            'role_name' => $row['role_name'] ?? null,
            'department_id' => (int)($row['department_id'] ?? 0),
            'email' => $row['email'] ?? null,
            'first_name' => $row['first_name'] ?? null,
            'last_name' => $row['last_name'] ?? null,
            'status' => (int)($row['status'] ?? 0),
        ];
    }, $rows), static function (array $row): bool {
        return (int)($row['user_id'] ?? 0) > 0;
    }));

    return $cache[$key];
}

function api_notifications_fetch_permission_map(PDO $pdo, int $roleId, int $userId): array
{
    static $cache = [];
    $key = spl_object_id($pdo) . ':' . $roleId . ':' . $userId;
    if (isset($cache[$key])) {
        return $cache[$key];
    }

    $record = api_fetch_effective_permissions_record($pdo, $roleId, $userId);
    $cache[$key] = $record['permissions'] ?? [];

    return $cache[$key];
}

function api_notifications_user_matches_module_targets(PDO $pdo, array $userRow, array $targets): bool
{
    if (empty($targets)) {
        return false;
    }

    $permissions = api_notifications_fetch_permission_map(
        $pdo,
        (int)($userRow['role_id'] ?? 0),
        (int)($userRow['user_id'] ?? 0)
    );

    foreach ($targets as $target) {
        $moduleKey = api_normalize_permission_module_key($target['module'] ?? '');
        $action = api_normalize_permission_action($target['action'] ?? '');
        if ($moduleKey === '' || $action === '') {
            continue;
        }
        if (api_can($permissions, $moduleKey, $action)) {
            return true;
        }
    }

    return false;
}

function api_notifications_resolve_recipient_user_ids(PDO $pdo, array $spec): array
{
    $activeUsers = api_notifications_fetch_active_users($pdo);
    $recipients = [];
    $recipientSpec = is_array($spec['recipients'] ?? null) ? $spec['recipients'] : [];
    $actorUserId = isset($spec['actor_user_id']) ? (int)$spec['actor_user_id'] : 0;

    if (!empty($recipientSpec['all_active'])) {
        foreach ($activeUsers as $userRow) {
            $recipients[(int)$userRow['user_id']] = true;
        }
    }

    $userIds = array_map('intval', is_array($recipientSpec['user_ids'] ?? null) ? $recipientSpec['user_ids'] : []);
    foreach ($userIds as $userId) {
        if ($userId > 0) {
            $recipients[$userId] = true;
        }
    }

    $roleIds = array_map('intval', is_array($recipientSpec['role_ids'] ?? null) ? $recipientSpec['role_ids'] : []);
    if (!empty($recipientSpec['include_admins'])) {
        $roleIds[] = 1;
    }
    if (!empty($roleIds)) {
        $roleSet = array_fill_keys(array_filter($roleIds, static function (int $roleId): bool {
            return $roleId > 0;
        }), true);
        foreach ($activeUsers as $userRow) {
            $roleId = (int)($userRow['role_id'] ?? 0);
            if ($roleId > 0 && isset($roleSet[$roleId])) {
                $recipients[(int)$userRow['user_id']] = true;
            }
        }
    }

    /*
     * Roles named by slug, so a caller can say 'dean' rather than memorise an
     * id — and so a reader can tell who is being notified without a lookup.
     */
    /*
     * A plain slug, deliberately NOT api_normalize_role_token(): that applies
     * an alias map where 'secretary' resolves to 'ssg', and the id map points
     * role 9 at 'ssg' too. Treating Secretary as an SSG is right for deciding
     * access — they do the same work — but wrong for deciding who is told
     * about a student by name. "Notify SSG" has to mean SSG.
     */
    $plainSlug = static function ($value): string {
        $token = strtolower(trim((string)$value));
        if ($token === '') {
            return '';
        }
        $token = str_replace(['_', ' '], '-', $token);
        return preg_replace('/[^a-z0-9-]+/', '', $token) ?? '';
    };

    $slugsOf = static function ($value) use ($plainSlug): array {
        $list = is_array($value) ? $value : [];
        $slugs = [];
        foreach ($list as $entry) {
            $slug = $plainSlug($entry);
            if ($slug !== '') {
                $slugs[$slug] = true;
            }
        }
        return $slugs;
    };

    $roleSlugSet = $slugsOf($recipientSpec['role_slugs'] ?? null);
    if (!empty($roleSlugSet)) {
        foreach ($activeUsers as $userRow) {
            $slug = $plainSlug($userRow['role_name'] ?? '');
            if ($slug !== '' && isset($roleSlugSet[$slug])) {
                $recipients[(int)$userRow['user_id']] = true;
            }
        }
    }

    /*
     * Roles that only hear about their own department. A dean answers for their
     * department rather than the institution, so the scope is part of who the
     * recipient is — not a filter someone has to remember to apply afterwards.
     *
     * A missing or zero department_id matches nobody. Falling back to "every
     * dean" would leak one department's students to another, which is the
     * failure this exists to prevent.
     */
    $departmentSlugSet = $slugsOf($recipientSpec['department_role_slugs'] ?? null);
    $departmentId = (int)($recipientSpec['department_id'] ?? 0);
    if (!empty($departmentSlugSet) && $departmentId > 0) {
        foreach ($activeUsers as $userRow) {
            $slug = $plainSlug($userRow['role_name'] ?? '');
            if ($slug !== '' && isset($departmentSlugSet[$slug])
                && (int)($userRow['department_id'] ?? 0) === $departmentId) {
                $recipients[(int)$userRow['user_id']] = true;
            }
        }
    }

    $moduleTargets = is_array($recipientSpec['module_targets'] ?? null) ? $recipientSpec['module_targets'] : [];
    if (!empty($moduleTargets)) {
        foreach ($activeUsers as $userRow) {
            if (api_notifications_user_matches_module_targets($pdo, $userRow, $moduleTargets)) {
                $recipients[(int)$userRow['user_id']] = true;
            }
        }
    }

    $excludeUserIds = array_map('intval', is_array($recipientSpec['exclude_user_ids'] ?? null) ? $recipientSpec['exclude_user_ids'] : []);
    if (!empty($recipientSpec['exclude_actor']) && $actorUserId > 0) {
        $excludeUserIds[] = $actorUserId;
    }
    foreach ($excludeUserIds as $userId) {
        unset($recipients[$userId]);
    }

    $resolved = array_keys($recipients);
    sort($resolved);

    return $resolved;
}

function api_notifications_create(PDO $pdo, array $spec): int
{
    api_notifications_ensure_tables($pdo);

    $title = trim((string)($spec['title'] ?? ''));
    $message = trim((string)($spec['message'] ?? ''));
    if ($title === '' || $message === '') {
        return 0;
    }

    $recipientUserIds = api_notifications_resolve_recipient_user_ids($pdo, $spec);
    if (empty($recipientUserIds)) {
        return 0;
    }

    $target = api_notifications_normalize_target(is_array($spec['target'] ?? null) ? $spec['target'] : []);
    $insertNotification = $pdo->prepare(
        'INSERT INTO system_notification (
            event_key,
            level,
            title,
            message,
            module_key,
            entity_type,
            entity_id,
            actor_user_id,
            target_view,
            target_report,
            target_section,
            target_overlay,
            toast,
            metadata
        ) VALUES (
            :event_key,
            :level,
            :title,
            :message,
            :module_key,
            :entity_type,
            :entity_id,
            :actor_user_id,
            :target_view,
            :target_report,
            :target_section,
            :target_overlay,
            :toast,
            :metadata
        )'
    );
    $insertNotification->execute([
        ':event_key' => trim((string)($spec['event_key'] ?? 'notification')),
        ':level' => api_notifications_normalize_level($spec['level'] ?? 'info'),
        ':title' => $title,
        ':message' => $message,
        ':module_key' => ($moduleKey = api_normalize_permission_module_key($spec['module_key'] ?? '')) !== '' ? $moduleKey : null,
        ':entity_type' => trim((string)($spec['entity_type'] ?? '')) ?: null,
        ':entity_id' => isset($spec['entity_id']) && (int)$spec['entity_id'] > 0 ? (int)$spec['entity_id'] : null,
        ':actor_user_id' => isset($spec['actor_user_id']) && (int)$spec['actor_user_id'] > 0 ? (int)$spec['actor_user_id'] : null,
        ':target_view' => $target['view'],
        ':target_report' => $target['report'],
        ':target_section' => $target['section'],
        ':target_overlay' => $target['overlay'],
        ':toast' => !empty($spec['toast']) ? 1 : 0,
        ':metadata' => api_notifications_encode_metadata(is_array($spec['metadata'] ?? null) ? $spec['metadata'] : []),
    ]);

    $notificationId = (int)$pdo->lastInsertId();
    if ($notificationId <= 0) {
        return 0;
    }

    $insertRecipient = $pdo->prepare(
        'INSERT INTO system_notification_recipient (notification_id, user_id, is_read, read_at)
         VALUES (:notification_id, :user_id, 0, NULL)'
    );
    foreach ($recipientUserIds as $userId) {
        $insertRecipient->execute([
            ':notification_id' => $notificationId,
            ':user_id' => $userId,
        ]);
    }

    return $notificationId;
}

function api_notifications_try_create(PDO $pdo, array $spec, array $context = []): int
{
    try {
        return api_notifications_create($pdo, $spec);
    } catch (Throwable $throwable) {
        api_log_exception($throwable, ['scope' => 'notifications'] + $context);
        return 0;
    }
}

function api_notifications_format_row(array $row): array
{
    return [
        'notification_id' => (int)($row['notification_id'] ?? 0),
        'event_key' => (string)($row['event_key'] ?? 'notification'),
        'level' => api_notifications_normalize_level($row['level'] ?? 'info'),
        'title' => (string)($row['title'] ?? ''),
        'message' => (string)($row['message'] ?? ''),
        'module_key' => $row['module_key'] ?? null,
        'entity_type' => $row['entity_type'] ?? null,
        'entity_id' => isset($row['entity_id']) ? (int)$row['entity_id'] : null,
        'actor_user_id' => isset($row['actor_user_id']) ? (int)$row['actor_user_id'] : null,
        'toast' => !empty($row['toast']),
        'created_at' => $row['created_at'] ?? null,
        'read' => !empty($row['is_read']),
        'read_at' => $row['read_at'] ?? null,
        'target' => api_notifications_resolve_target_payload($row),
        'metadata' => api_notifications_decode_metadata($row['metadata'] ?? null),
    ];
}

function api_notifications_fetch_for_user(PDO $pdo, int $userId, int $page = 1, int $limit = 10): array
{
    api_notifications_ensure_tables($pdo);

    $page = max(1, $page);
    $limit = max(1, min(50, $limit));
    $offset = ($page - 1) * $limit;

    $countStmt = $pdo->prepare(
        'SELECT COUNT(*)
         FROM system_notification_recipient
         WHERE user_id = :user_id'
    );
    $countStmt->execute([':user_id' => $userId]);
    $total = (int)$countStmt->fetchColumn();

    $unreadStmt = $pdo->prepare(
        'SELECT COUNT(*)
         FROM system_notification_recipient
         WHERE user_id = :user_id AND is_read = 0'
    );
    $unreadStmt->execute([':user_id' => $userId]);
    $unreadCount = (int)$unreadStmt->fetchColumn();

    $listStmt = $pdo->prepare(
        'SELECT
            n.notification_id,
            n.event_key,
            n.level,
            n.title,
            n.message,
            n.module_key,
            n.entity_type,
            n.entity_id,
            n.actor_user_id,
            n.target_view,
            n.target_report,
            n.target_section,
            n.target_overlay,
            n.toast,
            n.metadata,
            n.created_at,
            nr.is_read,
            nr.read_at
         FROM system_notification_recipient nr
         INNER JOIN system_notification n ON n.notification_id = nr.notification_id
         WHERE nr.user_id = :user_id
         ORDER BY n.created_at DESC, n.notification_id DESC
         LIMIT :limit OFFSET :offset'
    );
    $listStmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $listStmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $listStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $listStmt->execute();

    $rows = $listStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    return [
        'items' => array_map('api_notifications_format_row', $rows),
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
            'has_more' => ($offset + $limit) < $total,
        ],
        'unread_count' => $unreadCount,
    ];
}

function api_notifications_mark_read(PDO $pdo, int $userId, int $notificationId): bool
{
    api_notifications_ensure_tables($pdo);
    if ($userId <= 0 || $notificationId <= 0) {
        return false;
    }

    $stmt = $pdo->prepare(
        'UPDATE system_notification_recipient
         SET is_read = 1, read_at = NOW()
         WHERE user_id = :user_id
           AND notification_id = :notification_id'
    );
    $stmt->execute([
        ':user_id' => $userId,
        ':notification_id' => $notificationId,
    ]);

    return $stmt->rowCount() > 0;
}

function api_notifications_mark_all_read(PDO $pdo, int $userId): int
{
    api_notifications_ensure_tables($pdo);
    if ($userId <= 0) {
        return 0;
    }

    $stmt = $pdo->prepare(
        'UPDATE system_notification_recipient
         SET is_read = 1, read_at = NOW()
         WHERE user_id = :user_id
           AND is_read = 0'
    );
    $stmt->execute([':user_id' => $userId]);

    return $stmt->rowCount();
}

function api_notifications_delete_read(PDO $pdo, int $userId): int
{
    api_notifications_ensure_tables($pdo);
    if ($userId <= 0) {
        return 0;
    }

    $stmt = $pdo->prepare(
        'DELETE FROM system_notification_recipient
         WHERE user_id = :user_id
           AND is_read = 1'
    );
    $stmt->execute([':user_id' => $userId]);

    return $stmt->rowCount();
}
