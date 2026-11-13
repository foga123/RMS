<?php

const API_PASSWORD_EXPIRATION_DEFAULT_ENABLED = false;
const API_PASSWORD_EXPIRATION_DEFAULT_DAYS = 90;
const API_PASSWORD_EXPIRATION_MIN_DAYS = 1;
const API_PASSWORD_EXPIRATION_MAX_DAYS = 3650;

function api_password_expiration_storage_dir(): string
{
    return dirname(__DIR__) . '/storage/security';
}

function api_password_expiration_policy_path(): string
{
    return api_password_expiration_storage_dir() . '/password_expiration_policy.json';
}

function api_password_expiration_state_path(): string
{
    return api_password_expiration_storage_dir() . '/password_expiration_state.json';
}

function api_password_expiration_ensure_storage_dir(): void
{
    $directory = api_password_expiration_storage_dir();
    if (!is_dir($directory)) {
        @mkdir($directory, 0750, true);
    }
}

function api_password_expiration_write_json(string $path, array $payload): void
{
    api_password_expiration_ensure_storage_dir();

    $handle = @fopen($path, 'c+b');
    if (!$handle) {
        throw new RuntimeException('Password expiration storage is not writable.');
    }

    try {
        if (!@flock($handle, LOCK_EX)) {
            throw new RuntimeException('Password expiration storage is locked.');
        }
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        fflush($handle);
        @flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }
}

function api_password_expiration_clamp_days($value, int $fallback = API_PASSWORD_EXPIRATION_DEFAULT_DAYS): int
{
    $days = (int)round((float)$value);
    if ($days <= 0) {
        $days = $fallback;
    }

    return min(API_PASSWORD_EXPIRATION_MAX_DAYS, max(API_PASSWORD_EXPIRATION_MIN_DAYS, $days));
}

function api_password_expiration_default_policy(): array
{
    return [
        'enabled' => API_PASSWORD_EXPIRATION_DEFAULT_ENABLED,
        'days' => API_PASSWORD_EXPIRATION_DEFAULT_DAYS,
        'updated_at' => null,
        'updated_by' => null,
    ];
}

function api_password_expiration_normalize_policy(array $raw): array
{
    $default = api_password_expiration_default_policy();
    $daysValue = $raw['days']
        ?? $raw['password_expiration_days']
        ?? $raw['passwordExpiryDays']
        ?? $default['days'];

    $enabledValue = $raw['enabled']
        ?? $raw['password_expiration_enabled']
        ?? $raw['passwordExpirationEnabled']
        ?? $default['enabled'];

    return [
        'enabled' => api_parse_bool($enabledValue, (bool)$default['enabled']),
        'days' => api_password_expiration_clamp_days($daysValue, (int)$default['days']),
        'updated_at' => $raw['updated_at'] ?? null,
        'updated_by' => isset($raw['updated_by']) ? (int)$raw['updated_by'] : null,
    ];
}

function api_password_expiration_get_policy(): array
{
    return api_password_expiration_normalize_policy(
        api_read_json_file(
            api_password_expiration_policy_path(),
            api_password_expiration_default_policy()
        )
    );
}

function api_password_expiration_format_datetime(DateTimeInterface $dateTime): string
{
    return $dateTime->format('Y-m-d H:i:s');
}

function api_password_expiration_format_display_date(?DateTimeInterface $dateTime): ?string
{
    return $dateTime ? $dateTime->format('F j, Y') : null;
}

function api_password_expiration_now(): DateTimeImmutable
{
    return new DateTimeImmutable('now');
}

function api_password_expiration_parse_datetime($value): ?DateTimeImmutable
{
    $raw = trim((string)$value);
    if ($raw === '') {
        return null;
    }

    try {
        return new DateTimeImmutable($raw);
    } catch (Throwable $throwable) {
        return null;
    }
}

function api_password_expiration_save_policy(array $payload, ?array $actor = null): array
{
    $current = api_password_expiration_get_policy();
    $enabledProvided = array_key_exists('enabled', $payload)
        || array_key_exists('password_expiration_enabled', $payload)
        || array_key_exists('passwordExpirationEnabled', $payload);

    $daysValue = $payload['days']
        ?? $payload['password_expiration_days']
        ?? $payload['passwordExpiryDays']
        ?? $current['days'];

    $enabledValue = $enabledProvided
        ? ($payload['enabled'] ?? $payload['password_expiration_enabled'] ?? $payload['passwordExpirationEnabled'])
        : ((int)$daysValue > 0 ? $current['enabled'] : false);

    $policy = [
        'enabled' => api_parse_bool($enabledValue, (bool)$current['enabled']),
        'days' => api_password_expiration_clamp_days($daysValue, (int)$current['days']),
        'updated_at' => api_password_expiration_format_datetime(api_password_expiration_now()),
        'updated_by' => isset($actor['user_id']) ? (int)$actor['user_id'] : null,
    ];

    api_password_expiration_write_json(api_password_expiration_policy_path(), $policy);
    api_password_expiration_recompute_recorded_expirations($policy);

    return $policy;
}

function api_password_expiration_default_state(): array
{
    return ['users' => []];
}

function api_password_expiration_get_state(): array
{
    $state = api_read_json_file(
        api_password_expiration_state_path(),
        api_password_expiration_default_state()
    );

    if (!isset($state['users']) || !is_array($state['users'])) {
        $state['users'] = [];
    }

    return $state;
}

function api_password_expiration_save_state(array $state): void
{
    if (!isset($state['users']) || !is_array($state['users'])) {
        $state['users'] = [];
    }

    api_password_expiration_write_json(api_password_expiration_state_path(), $state);
}

function api_password_expiration_get_user_state(int $userId): array
{
    $state = api_password_expiration_get_state();
    $userState = $state['users'][(string)$userId] ?? [];

    return is_array($userState) ? $userState : [];
}

function api_password_expiration_update_user_state(int $userId, callable $updater): array
{
    $state = api_password_expiration_get_state();
    $key = (string)$userId;
    $current = isset($state['users'][$key]) && is_array($state['users'][$key]) ? $state['users'][$key] : [];
    $next = $updater($current);
    if (!is_array($next)) {
        $next = $current;
    }

    $next['updated_at'] = api_password_expiration_format_datetime(api_password_expiration_now());
    $state['users'][$key] = $next;
    api_password_expiration_save_state($state);

    return $next;
}

function api_password_expiration_fetch_user_row(PDO $pdo, int $userId): ?array
{
    if ($userId <= 0) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT
            u.user_id,
            u.first_name,
            u.last_name,
            u.email,
            u.created_at,
            u.status,
            s.status_name,
            u.role AS role_id,
            r.role_name
         FROM user u
         LEFT JOIN status s ON s.status_id = u.status
         LEFT JOIN role r ON r.role_id = u.role
         WHERE u.user_id = :user_id
         LIMIT 1'
    );
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

function api_password_expiration_display_name(array $row): string
{
    $name = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? ''));
    if ($name !== '') {
        return $name;
    }

    $email = trim((string)($row['email'] ?? ''));
    return $email !== '' ? $email : ('User #' . (int)($row['user_id'] ?? 0));
}

function api_password_expiration_resolve_user_row(array $row): array
{
    if (!empty($row['created_at'])) {
        return $row;
    }

    $userId = (int)($row['user_id'] ?? 0);
    if ($userId <= 0 || !function_exists('api_permission_db_connect')) {
        return $row;
    }

    $pdo = api_permission_db_connect();
    if (!$pdo instanceof PDO) {
        return $row;
    }

    return api_password_expiration_fetch_user_row($pdo, $userId) ?: $row;
}

function api_password_expiration_status_for_user_row(array $row, ?array $policy = null, ?DateTimeImmutable $now = null): array
{
    $row = api_password_expiration_resolve_user_row($row);
    $policy = $policy ?: api_password_expiration_get_policy();
    $now = $now ?: api_password_expiration_now();
    $userId = (int)($row['user_id'] ?? 0);
    $userState = $userId > 0 ? api_password_expiration_get_user_state($userId) : [];
    $policyEnabled = !empty($policy['enabled']);
    $userDisabled = api_parse_bool($userState['expiration_disabled'] ?? false, false);
    $createdAt = api_password_expiration_parse_datetime($row['created_at'] ?? null);
    $changedAt = api_password_expiration_parse_datetime($userState['password_changed_at'] ?? null);
    $baseAt = $changedAt ?: $createdAt;
    $days = api_password_expiration_clamp_days($policy['days'] ?? API_PASSWORD_EXPIRATION_DEFAULT_DAYS);
    $expiresAt = null;
    $remainingDays = null;
    $isExpired = false;
    $status = 'disabled';

    if ($policyEnabled && !$userDisabled && $baseAt) {
        $expiresAt = $baseAt->modify('+' . $days . ' days');
        $remainingSeconds = $expiresAt->getTimestamp() - $now->getTimestamp();
        $isExpired = $remainingSeconds <= 0;
        $remainingDays = $isExpired ? 0 : (int)ceil($remainingSeconds / 86400);

        if ($isExpired) {
            $status = 'expired';
        } elseif ($remainingDays <= 7) {
            $status = 'red';
        } elseif ($remainingDays <= 30) {
            $status = 'orange';
        } else {
            $status = 'green';
        }
    }

    $remainingLabel = 'Expiration Disabled';
    if ($policyEnabled && $userDisabled) {
        $remainingLabel = 'Disabled For User';
    } elseif ($policyEnabled && !$baseAt) {
        $remainingLabel = 'Unavailable';
    } elseif ($policyEnabled && $isExpired) {
        $remainingLabel = 'Password Expired';
    } elseif ($policyEnabled && $remainingDays !== null) {
        $remainingLabel = $remainingDays . ' Day' . ($remainingDays === 1 ? '' : 's') . ' Remaining';
    }

    return [
        'enabled' => $policyEnabled && !$userDisabled,
        'policy_enabled' => $policyEnabled,
        'user_disabled' => $userDisabled,
        'expiration_days' => $days,
        'source' => $changedAt ? 'password_changed_at' : 'created_at',
        'base_at' => $baseAt ? api_password_expiration_format_datetime($baseAt) : null,
        'base_at_display' => api_password_expiration_format_display_date($baseAt),
        'password_changed_at' => $changedAt ? api_password_expiration_format_datetime($changedAt) : null,
        'password_changed_at_display' => api_password_expiration_format_display_date($changedAt),
        'password_expires_at' => $expiresAt ? api_password_expiration_format_datetime($expiresAt) : null,
        'expires_at' => $expiresAt ? api_password_expiration_format_datetime($expiresAt) : null,
        'expires_at_display' => api_password_expiration_format_display_date($expiresAt),
        'remaining_days' => $remainingDays,
        'remaining_label' => $remainingLabel,
        'is_expired' => $isExpired,
        'force_password_change' => $isExpired,
        'status' => $status,
    ];
}

function api_password_expiration_status_for_user_id(PDO $pdo, int $userId): ?array
{
    $row = api_password_expiration_fetch_user_row($pdo, $userId);
    if (!$row) {
        return null;
    }

    return api_password_expiration_status_for_user_row($row);
}

function api_password_expiration_record_password_changed(PDO $pdo, int $userId, $changedAt = null): ?array
{
    $row = api_password_expiration_fetch_user_row($pdo, $userId);
    if (!$row) {
        return null;
    }

    $changedDate = api_password_expiration_parse_datetime($changedAt) ?: api_password_expiration_now();
    $policy = api_password_expiration_get_policy();
    $expiresAt = !empty($policy['enabled'])
        ? $changedDate->modify('+' . api_password_expiration_clamp_days($policy['days']) . ' days')
        : null;

    api_password_expiration_update_user_state($userId, static function (array $current) use ($changedDate, $expiresAt): array {
        $current['password_changed_at'] = api_password_expiration_format_datetime($changedDate);
        $current['password_expires_at'] = $expiresAt ? api_password_expiration_format_datetime($expiresAt) : null;
        $current['notification_keys'] = [];
        return $current;
    });

    return api_password_expiration_status_for_user_row($row, $policy);
}

function api_password_expiration_recompute_recorded_expirations(?array $policy = null): void
{
    $policy = $policy ?: api_password_expiration_get_policy();
    $state = api_password_expiration_get_state();
    $changed = false;

    foreach ($state['users'] as $userId => $userState) {
        if (!is_array($userState)) {
            continue;
        }
        $changedAt = api_password_expiration_parse_datetime($userState['password_changed_at'] ?? null);
        if (!$changedAt) {
            continue;
        }

        $expiresAt = !empty($policy['enabled'])
            ? $changedAt->modify('+' . api_password_expiration_clamp_days($policy['days']) . ' days')
            : null;
        $nextExpiresAt = $expiresAt ? api_password_expiration_format_datetime($expiresAt) : null;
        if (($userState['password_expires_at'] ?? null) !== $nextExpiresAt) {
            $state['users'][$userId]['password_expires_at'] = $nextExpiresAt;
            $state['users'][$userId]['notification_keys'] = [];
            $changed = true;
        }
    }

    if ($changed) {
        api_password_expiration_save_state($state);
    }
}

function api_password_expiration_set_user_disabled(PDO $pdo, int $userId, bool $disabled, ?array $actor = null): ?array
{
    $row = api_password_expiration_fetch_user_row($pdo, $userId);
    if (!$row) {
        return null;
    }

    api_password_expiration_update_user_state($userId, static function (array $current) use ($disabled, $actor): array {
        $current['expiration_disabled'] = $disabled;
        $current['expiration_disabled_at'] = $disabled ? api_password_expiration_format_datetime(api_password_expiration_now()) : null;
        $current['expiration_disabled_by'] = $disabled && isset($actor['user_id']) ? (int)$actor['user_id'] : null;
        $current['notification_keys'] = [];
        return $current;
    });

    return api_password_expiration_status_for_user_row($row);
}

function api_password_expiration_list_users(PDO $pdo, array $options = []): array
{
    $search = trim((string)($options['search'] ?? ''));
    $filter = strtolower(trim((string)($options['filter'] ?? 'all')));
    $page = max(1, (int)($options['page'] ?? 1));
    $limit = max(1, min(200, (int)($options['limit'] ?? 50)));

    $where = '';
    $params = [];
    if ($search !== '') {
        $where = 'WHERE u.email LIKE :q OR u.first_name LIKE :q OR u.last_name LIKE :q';
        $params[':q'] = '%' . $search . '%';
    }

    $stmt = $pdo->prepare(
        'SELECT
            u.user_id,
            u.first_name,
            u.last_name,
            u.email,
            u.created_at,
            u.status,
            s.status_name,
            u.role AS role_id,
            r.role_name
         FROM user u
         LEFT JOIN status s ON s.status_id = u.status
         LEFT JOIN role r ON r.role_id = u.role
         ' . $where . '
         ORDER BY u.user_id ASC'
    );
    $stmt->execute($params);

    $policy = api_password_expiration_get_policy();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    $items = [];

    foreach ($rows as $row) {
        $expiration = api_password_expiration_status_for_user_row($row, $policy);
        if ($filter === 'expired' && empty($expiration['is_expired'])) {
            continue;
        }
        if ($filter === 'disabled' && empty($expiration['user_disabled'])) {
            continue;
        }
        if ($filter === 'expiring_30' && (!isset($expiration['remaining_days']) || $expiration['remaining_days'] === null || $expiration['remaining_days'] > 30 || !empty($expiration['is_expired']))) {
            continue;
        }

        $items[] = [
            'user_id' => (int)($row['user_id'] ?? 0),
            'name' => api_password_expiration_display_name($row),
            'email' => $row['email'] ?? null,
            'role_id' => isset($row['role_id']) ? (int)$row['role_id'] : null,
            'role_name' => $row['role_name'] ?? null,
            'status' => isset($row['status']) ? (int)$row['status'] : null,
            'status_name' => $row['status_name'] ?? null,
            'created_at' => $row['created_at'] ?? null,
            'password_expiration' => $expiration,
        ];
    }

    $total = count($items);
    $offset = ($page - 1) * $limit;
    $pagedItems = array_slice($items, $offset, $limit);

    return [
        'items' => $pagedItems,
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
            'has_more' => ($offset + $limit) < $total,
        ],
    ];
}

function api_password_expiration_current_milestone(array $status): ?int
{
    if (empty($status['enabled'])) {
        return null;
    }
    if (!empty($status['is_expired'])) {
        return 0;
    }

    $remainingDays = $status['remaining_days'];
    if ($remainingDays === null) {
        return null;
    }

    foreach ([1, 3, 7, 14, 30] as $milestone) {
        if ((int)$remainingDays <= $milestone) {
            return $milestone;
        }
    }

    return null;
}

function api_password_expiration_sync_notifications_for_user(PDO $pdo, int $userId): ?array
{
    $row = api_password_expiration_fetch_user_row($pdo, $userId);
    if (!$row) {
        return null;
    }

    $status = api_password_expiration_status_for_user_row($row);
    $milestone = api_password_expiration_current_milestone($status);
    if ($milestone === null || !function_exists('api_notifications_try_create')) {
        return $status;
    }

    $expiresAt = (string)($status['expires_at'] ?? '');
    if ($expiresAt === '') {
        return $status;
    }

    $notificationKey = $expiresAt . ':' . $milestone;
    $userState = api_password_expiration_get_user_state($userId);
    $sentKeys = is_array($userState['notification_keys'] ?? null) ? $userState['notification_keys'] : [];
    if (in_array($notificationKey, $sentKeys, true)) {
        return $status;
    }

    $isExpired = $milestone === 0;
    $title = $isExpired ? 'Password expired' : 'Password expires soon';
    $message = $isExpired
        ? 'Your password has expired. Change your password to continue using the dashboard.'
        : 'Your password expires in ' . (int)$status['remaining_days'] . ' day' . ((int)$status['remaining_days'] === 1 ? '' : 's') . '.';

    $notificationId = api_notifications_try_create($pdo, [
        'event_key' => $isExpired ? 'password_expiration_expired' : 'password_expiration_warning',
        'level' => $isExpired ? 'error' : 'warning',
        'title' => $title,
        'message' => $message,
        'module_key' => 'settings',
        'entity_type' => 'user',
        'entity_id' => $userId,
        'toast' => true,
        'target' => [
            'overlay' => 'change_password',
        ],
        'metadata' => [
            'user_id' => $userId,
            'milestone' => $milestone,
            'remaining_days' => $status['remaining_days'],
            'expires_at' => $status['expires_at'],
        ],
        'recipients' => [
            'user_ids' => [$userId],
        ],
    ], [
        'endpoint' => 'password_expiration',
        'event_key' => $isExpired ? 'password_expiration_expired' : 'password_expiration_warning',
        'user_id' => $userId,
    ]);

    if ($notificationId > 0) {
        api_password_expiration_update_user_state($userId, static function (array $current) use ($notificationKey): array {
            $keys = is_array($current['notification_keys'] ?? null) ? $current['notification_keys'] : [];
            $keys[] = $notificationKey;
            $current['notification_keys'] = array_values(array_unique(array_slice($keys, -20)));
            return $current;
        });
    }

    return $status;
}

function api_password_expiration_request_allowed_while_expired(): bool
{
    $endpoint = basename($_SERVER['SCRIPT_FILENAME'] ?? '');
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

    if (in_array($endpoint, ['me.php', 'logout.php', 'notifications.php'], true)) {
        return true;
    }
    if ($endpoint === 'password_expiration.php' && $method === 'GET') {
        return true;
    }
    if ($endpoint === 'change-password.php' && in_array($method, ['GET', 'POST'], true)) {
        return true;
    }

    return false;
}

function api_password_expiration_should_block_request(array $sessionUser): bool
{
    if (api_password_expiration_request_allowed_while_expired()) {
        return false;
    }

    $userId = (int)($sessionUser['user_id'] ?? 0);
    if ($userId <= 0 || !function_exists('api_permission_db_connect')) {
        return false;
    }

    $pdo = api_permission_db_connect();
    if (!$pdo instanceof PDO) {
        return false;
    }

    $status = api_password_expiration_status_for_user_id($pdo, $userId);
    return !empty($status['is_expired']);
}
