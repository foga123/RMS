<?php

function backup_json(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    header('Content-Type: application/json');
    echo json_encode($payload);
    exit;
}

function backup_read_json_body(): array
{
    $raw = file_get_contents('php://input');
    $decoded = json_decode($raw ?: '', true);
    return is_array($decoded) ? $decoded : [];
}

function backup_bool($value, bool $default = false): bool
{
    if (is_bool($value)) {
        return $value;
    }
    if (is_numeric($value)) {
        return (int)$value === 1;
    }

    $normalized = strtolower(trim((string)$value));
    if ($normalized === '') {
        return $default;
    }

    return in_array($normalized, ['1', 'true', 'yes', 'on'], true);
}

function backup_now(): DateTimeImmutable
{
    return new DateTimeImmutable('now');
}

function backup_timezone_name(): string
{
    $timezone = trim((string)date_default_timezone_get());
    return $timezone !== '' ? $timezone : 'UTC';
}

function backup_datetime_string(?DateTimeImmutable $value): ?string
{
    return $value ? $value->format('Y-m-d H:i:s') : null;
}

function backup_storage_root(): string
{
    return dirname(__DIR__) . DIRECTORY_SEPARATOR . 'storage';
}

function backup_default_storage_directory(): string
{
    return backup_storage_root() . DIRECTORY_SEPARATOR . 'backups';
}

function backup_global_lock_path(): string
{
    return backup_storage_root() . DIRECTORY_SEPARATOR . 'backup-system.lock';
}

function backup_is_absolute_path(string $path): bool
{
    return (bool)preg_match('/^(?:[A-Za-z]:[\\\\\\/]|[\\\\\\/]{2}|[\\\\\\/])/', $path);
}

function backup_normalize_path(string $path): string
{
    return str_replace(['/', '\\'], DIRECTORY_SEPARATOR, $path);
}

function backup_protect_directory(string $directory): void
{
    $htaccessPath = $directory . DIRECTORY_SEPARATOR . '.htaccess';
    if (!is_file($htaccessPath)) {
        @file_put_contents($htaccessPath, "Require all denied\nDeny from all\n");
    }

    $indexPath = $directory . DIRECTORY_SEPARATOR . 'index.html';
    if (!is_file($indexPath)) {
        @file_put_contents($indexPath, '');
    }
}

function backup_resolve_storage_directory(?string $configuredPath, bool $createIfMissing = true): string
{
    $storageRoot = backup_storage_root();
    if (!is_dir($storageRoot) && !@mkdir($storageRoot, 0775, true) && !is_dir($storageRoot)) {
        throw new RuntimeException('Unable to prepare backup storage root.');
    }

    $raw = trim((string)$configuredPath);
    if ($raw === '') {
        $target = backup_default_storage_directory();
    } elseif (backup_is_absolute_path($raw)) {
        $target = $raw;
    } else {
        $target = $storageRoot . DIRECTORY_SEPARATOR . trim($raw, "\\/ \t\n\r\0\x0B");
    }

    $target = backup_normalize_path($target);
    if (!is_dir($target)) {
        if (!$createIfMissing || (!@mkdir($target, 0775, true) && !is_dir($target))) {
            throw new RuntimeException('Unable to create backup storage directory.');
        }
    }

    if (!is_dir($target)) {
        throw new RuntimeException('Backup storage path is not a directory.');
    }

    if (!is_writable($target)) {
        throw new RuntimeException('Backup storage directory is not writable.');
    }

    backup_protect_directory($target);

    $resolved = realpath($target);
    return $resolved !== false ? $resolved : $target;
}

function backup_resolve_binary(string $envKey, array $candidates, string $fallback): string
{
    $envPath = trim((string)getenv($envKey));
    if ($envPath !== '' && file_exists($envPath)) {
        return $envPath;
    }

    foreach ($candidates as $candidate) {
        if ($candidate !== '' && file_exists($candidate)) {
            return $candidate;
        }
    }

    return $fallback;
}

function backup_resolve_mysqldump(): string
{
    return backup_resolve_binary(
        'MYSQLDUMP_PATH',
        [
            'C:\\xampp\\mysql\\bin\\mysqldump.exe',
            'C:\\xampp\\mysql\\bin\\mysqldump',
        ],
        'mysqldump'
    );
}

function backup_resolve_mysql_client(): string
{
    return backup_resolve_binary(
        'MYSQL_PATH',
        [
            'C:\\xampp\\mysql\\bin\\mysql.exe',
            'C:\\xampp\\mysql\\bin\\mysql',
        ],
        'mysql'
    );
}

function backup_get_database_config(): array
{
    $db = new Database();
    $config = method_exists($db, 'getConfig') ? $db->getConfig() : [];

    return [
        'host' => $config['host'] ?? '127.0.0.1',
        'port' => (int)($config['port'] ?? 3306),
        'db_name' => $config['db_name'] ?? 'rms_public_demo',
        'username' => $config['username'] ?? 'root',
        'password' => $config['password'] ?? '',
        'ssl_ca' => (string)($config['ssl_ca'] ?? ''),
    ];
}

/**
 * Port and TLS options for the mysql/mysqldump command line, matching how PHP
 * connects (api_db_settings() in middleware/env.php). A managed database such
 * as Aiven refuses plain-text connections, so the tools need the same CA file
 * the PDO connection verifies against.
 */
function backup_connection_args(array $dbConfig): array
{
    $args = ['--port=' . (int)($dbConfig['port'] ?? 3306)];
    $ca = (string)($dbConfig['ssl_ca'] ?? '');
    if ($ca !== '') {
        $args[] = '--ssl-ca=' . $ca;
        $args[] = '--ssl-verify-server-cert';
    }
    return $args;
}

function backup_ensure_tables(PDO $pdo): void
{
    static $initialized = false;
    if ($initialized) {
        return;
    }

    api_require_table($pdo, 'system_backup_config');
    api_require_table($pdo, 'system_backup_history');

    $initialized = true;
}

function backup_normalize_config_row(array $row): array
{
    $scheduleType = strtolower(trim((string)($row['schedule_type'] ?? 'daily')));
    if (!in_array($scheduleType, ['daily', 'weekly', 'monthly', 'custom'], true)) {
        $scheduleType = 'daily';
    }

    $storagePath = trim((string)($row['storage_path'] ?? ''));
    if ($storagePath === '') {
        $storagePath = backup_default_storage_directory();
    }

    return [
        'config_id' => isset($row['config_id']) ? (int)$row['config_id'] : 0,
        'is_enabled' => !empty($row['is_enabled']),
        'schedule_type' => $scheduleType,
        'backup_hour' => max(0, min(23, (int)($row['backup_hour'] ?? 2))),
        'backup_minute' => max(0, min(59, (int)($row['backup_minute'] ?? 0))),
        'weekly_day' => max(0, min(6, (int)($row['weekly_day'] ?? 1))),
        'monthly_day' => max(1, min(31, (int)($row['monthly_day'] ?? 1))),
        'custom_at' => !empty($row['custom_at']) ? (string)$row['custom_at'] : null,
        'storage_path' => $storagePath,
        'updated_by_user_id' => isset($row['updated_by_user_id']) ? (int)$row['updated_by_user_id'] : null,
        'created_at' => $row['created_at'] ?? null,
        'updated_at' => $row['updated_at'] ?? null,
    ];
}

function backup_fetch_config(PDO $pdo): array
{
    backup_ensure_tables($pdo);

    $stmt = $pdo->query('SELECT * FROM system_backup_config ORDER BY config_id ASC LIMIT 1');
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        throw new RuntimeException(
            'No row was found in `system_backup_config`. Configure backups for this separate empty demo database.'
        );
    }

    return backup_normalize_config_row($row);
}

function backup_parse_custom_datetime($value): ?string
{
    $raw = trim((string)$value);
    if ($raw === '') {
        return null;
    }

    $formats = ['Y-m-d\TH:i', 'Y-m-d H:i:s', 'Y-m-d H:i'];
    foreach ($formats as $format) {
        $parsed = DateTimeImmutable::createFromFormat($format, $raw);
        if ($parsed instanceof DateTimeImmutable) {
            return $parsed->format('Y-m-d H:i:s');
        }
    }

    try {
        return (new DateTimeImmutable($raw))->format('Y-m-d H:i:s');
    } catch (Throwable $e) {
        return null;
    }
}

function backup_update_config(PDO $pdo, array $payload, ?array $user): array
{
    backup_ensure_tables($pdo);
    $existing = backup_fetch_config($pdo);

    $scheduleType = strtolower(trim((string)($payload['schedule_type'] ?? $existing['schedule_type'])));
    if (!in_array($scheduleType, ['daily', 'weekly', 'monthly', 'custom'], true)) {
        throw new InvalidArgumentException('Invalid backup schedule type.');
    }

    $backupHour = isset($payload['backup_hour']) ? (int)$payload['backup_hour'] : (int)$existing['backup_hour'];
    $backupMinute = isset($payload['backup_minute']) ? (int)$payload['backup_minute'] : (int)$existing['backup_minute'];
    $weeklyDay = isset($payload['weekly_day']) ? (int)$payload['weekly_day'] : (int)$existing['weekly_day'];
    $monthlyDay = isset($payload['monthly_day']) ? (int)$payload['monthly_day'] : (int)$existing['monthly_day'];
    $isEnabled = array_key_exists('is_enabled', $payload) ? backup_bool($payload['is_enabled'], true) : (bool)$existing['is_enabled'];
    $customAt = array_key_exists('custom_at', $payload) ? backup_parse_custom_datetime($payload['custom_at']) : $existing['custom_at'];
    $storagePath = trim((string)($payload['storage_path'] ?? $existing['storage_path']));
    if ($storagePath === '') {
        $storagePath = backup_default_storage_directory();
    }

    if ($backupHour < 0 || $backupHour > 23) {
        throw new InvalidArgumentException('Backup hour must be between 0 and 23.');
    }
    if ($backupMinute < 0 || $backupMinute > 59) {
        throw new InvalidArgumentException('Backup minute must be between 0 and 59.');
    }
    if ($weeklyDay < 0 || $weeklyDay > 6) {
        throw new InvalidArgumentException('Weekly backup day must be between Sunday and Saturday.');
    }
    if ($monthlyDay < 1 || $monthlyDay > 31) {
        throw new InvalidArgumentException('Monthly backup day must be between 1 and 31.');
    }
    if ($scheduleType === 'custom' && $customAt === null) {
        throw new InvalidArgumentException('Custom backup schedule requires a valid date and time.');
    }

    $resolvedStorage = backup_resolve_storage_directory($storagePath, true);
    $update = $pdo->prepare(
        'UPDATE system_backup_config
         SET is_enabled = :is_enabled,
             schedule_type = :schedule_type,
             backup_hour = :backup_hour,
             backup_minute = :backup_minute,
             weekly_day = :weekly_day,
             monthly_day = :monthly_day,
             custom_at = :custom_at,
             storage_path = :storage_path,
             updated_by_user_id = :updated_by_user_id
         WHERE config_id = :config_id'
    );

    $update->execute([
        ':is_enabled' => $isEnabled ? 1 : 0,
        ':schedule_type' => $scheduleType,
        ':backup_hour' => $backupHour,
        ':backup_minute' => $backupMinute,
        ':weekly_day' => $weeklyDay,
        ':monthly_day' => $monthlyDay,
        ':custom_at' => $customAt,
        ':storage_path' => $resolvedStorage,
        ':updated_by_user_id' => $user['user_id'] ?? null,
        ':config_id' => $existing['config_id'],
    ]);

    return backup_fetch_config($pdo);
}

function backup_day_label(int $day): string
{
    $labels = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    return $labels[$day] ?? 'Unknown';
}

function backup_compute_next_run(array $config, ?DateTimeImmutable $from = null): ?DateTimeImmutable
{
    if (empty($config['is_enabled'])) {
        return null;
    }

    $now = $from ?: backup_now();
    $hour = (int)$config['backup_hour'];
    $minute = (int)$config['backup_minute'];
    $scheduleType = $config['schedule_type'] ?? 'daily';

    if ($scheduleType === 'daily') {
        $candidate = $now->setTime($hour, $minute, 0);
        if ($candidate <= $now) {
            $candidate = $candidate->modify('+1 day');
        }
        return $candidate;
    }

    if ($scheduleType === 'weekly') {
        $targetDay = (int)$config['weekly_day'];
        $currentDay = (int)$now->format('w');
        $daysAhead = ($targetDay - $currentDay + 7) % 7;
        $candidate = $now->modify("+{$daysAhead} day")->setTime($hour, $minute, 0);
        if ($candidate <= $now) {
            $candidate = $candidate->modify('+7 day');
        }
        return $candidate;
    }

    if ($scheduleType === 'monthly') {
        $candidate = $now->setDate(
            (int)$now->format('Y'),
            (int)$now->format('m'),
            min((int)$config['monthly_day'], (int)$now->format('t'))
        )->setTime($hour, $minute, 0);
        if ($candidate <= $now) {
            $nextMonth = $now->modify('first day of next month');
            $candidate = $nextMonth->setDate(
                (int)$nextMonth->format('Y'),
                (int)$nextMonth->format('m'),
                min((int)$config['monthly_day'], (int)$nextMonth->format('t'))
            )->setTime($hour, $minute, 0);
        }
        return $candidate;
    }

    if ($scheduleType === 'custom') {
        $customAt = !empty($config['custom_at']) ? new DateTimeImmutable((string)$config['custom_at']) : null;
        return ($customAt instanceof DateTimeImmutable && $customAt > $now) ? $customAt : null;
    }

    return null;
}

function backup_compute_due_slot(array $config, DateTimeImmutable $now): ?array
{
    if (empty($config['is_enabled'])) {
        return null;
    }

    $hour = (int)$config['backup_hour'];
    $minute = (int)$config['backup_minute'];
    $scheduleType = $config['schedule_type'] ?? 'daily';

    if ($scheduleType === 'daily') {
        $scheduledFor = $now->setTime($hour, $minute, 0);
        if ($scheduledFor > $now) {
            return null;
        }
        return [
            'run_key' => 'daily-' . $scheduledFor->format('YmdHi'),
            'scheduled_for' => $scheduledFor,
            'schedule_type' => 'daily',
        ];
    }

    if ($scheduleType === 'weekly') {
        $targetDay = (int)$config['weekly_day'];
        $currentDay = (int)$now->format('w');
        $daysBack = ($currentDay - $targetDay + 7) % 7;
        $scheduledFor = $now->modify("-{$daysBack} day")->setTime($hour, $minute, 0);
        if ($scheduledFor > $now) {
            return null;
        }
        return [
            'run_key' => 'weekly-' . $scheduledFor->format('YmdHi'),
            'scheduled_for' => $scheduledFor,
            'schedule_type' => 'weekly',
        ];
    }

    if ($scheduleType === 'monthly') {
        $scheduledFor = $now->setDate(
            (int)$now->format('Y'),
            (int)$now->format('m'),
            min((int)$config['monthly_day'], (int)$now->format('t'))
        )->setTime($hour, $minute, 0);
        if ($scheduledFor > $now) {
            return null;
        }
        return [
            'run_key' => 'monthly-' . $scheduledFor->format('YmdHi'),
            'scheduled_for' => $scheduledFor,
            'schedule_type' => 'monthly',
        ];
    }

    if ($scheduleType === 'custom') {
        if (empty($config['custom_at'])) {
            return null;
        }
        $scheduledFor = new DateTimeImmutable((string)$config['custom_at']);
        if ($scheduledFor > $now) {
            return null;
        }
        return [
            'run_key' => 'custom-' . $scheduledFor->format('YmdHi'),
            'scheduled_for' => $scheduledFor,
            'schedule_type' => 'custom',
        ];
    }

    return null;
}

function backup_config_summary(array $config): string
{
    $hour = str_pad((string)((int)$config['backup_hour']), 2, '0', STR_PAD_LEFT);
    $minute = str_pad((string)((int)$config['backup_minute']), 2, '0', STR_PAD_LEFT);
    $timeLabel = "{$hour}:{$minute}";

    switch ($config['schedule_type']) {
        case 'weekly':
            return 'Weekly on ' . backup_day_label((int)$config['weekly_day']) . " at {$timeLabel}";
        case 'monthly':
            return 'Monthly on day ' . (int)$config['monthly_day'] . " at {$timeLabel}";
        case 'custom':
            return !empty($config['custom_at'])
                ? 'Custom at ' . (new DateTimeImmutable((string)$config['custom_at']))->format('M d, Y h:i A')
                : 'Custom schedule';
        case 'daily':
        default:
            return "Daily at {$timeLabel}";
    }
}

function backup_format_config_response(array $config, ?DateTimeImmutable $now = null): array
{
    $currentTime = $now ?: backup_now();
    return [
        'config_id' => (int)$config['config_id'],
        'is_enabled' => (bool)$config['is_enabled'],
        'schedule_type' => $config['schedule_type'],
        'backup_hour' => (int)$config['backup_hour'],
        'backup_minute' => (int)$config['backup_minute'],
        'weekly_day' => (int)$config['weekly_day'],
        'monthly_day' => (int)$config['monthly_day'],
        'custom_at' => $config['custom_at'],
        'storage_path' => $config['storage_path'],
        'summary' => backup_config_summary($config),
        'next_run_at' => backup_datetime_string(backup_compute_next_run($config, $currentTime)),
        'server_time' => backup_datetime_string($currentTime),
        'timezone' => backup_timezone_name(),
    ];
}

function backup_find_history_by_run_key(PDO $pdo, string $runKey): ?array
{
    if ($runKey === '') {
        return null;
    }

    $stmt = $pdo->prepare('SELECT * FROM system_backup_history WHERE run_key = :run_key LIMIT 1');
    $stmt->execute([':run_key' => $runKey]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

function backup_fetch_history_entry(PDO $pdo, int $historyId): ?array
{
    $stmt = $pdo->prepare('SELECT * FROM system_backup_history WHERE history_id = :history_id LIMIT 1');
    $stmt->execute([':history_id' => $historyId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

function backup_insert_history(PDO $pdo, array $payload): int
{
    $stmt = $pdo->prepare(
        'INSERT INTO system_backup_history
            (event_type, trigger_type, status, run_key, scheduled_for, file_name, file_path, file_size, storage_path, message, related_backup_id, initiated_by_user_id, completed_at)
         VALUES
            (:event_type, :trigger_type, :status, :run_key, :scheduled_for, :file_name, :file_path, :file_size, :storage_path, :message, :related_backup_id, :initiated_by_user_id, :completed_at)'
    );

    $stmt->execute([
        ':event_type' => $payload['event_type'] ?? 'backup',
        ':trigger_type' => $payload['trigger_type'] ?? 'manual',
        ':status' => $payload['status'] ?? 'running',
        ':run_key' => $payload['run_key'] ?? null,
        ':scheduled_for' => $payload['scheduled_for'] ?? null,
        ':file_name' => $payload['file_name'] ?? null,
        ':file_path' => $payload['file_path'] ?? null,
        ':file_size' => $payload['file_size'] ?? null,
        ':storage_path' => $payload['storage_path'] ?? null,
        ':message' => $payload['message'] ?? null,
        ':related_backup_id' => $payload['related_backup_id'] ?? null,
        ':initiated_by_user_id' => $payload['initiated_by_user_id'] ?? null,
        ':completed_at' => $payload['completed_at'] ?? null,
    ]);

    return (int)$pdo->lastInsertId();
}

function backup_update_history(PDO $pdo, int $historyId, array $payload): void
{
    if ($historyId <= 0 || empty($payload)) {
        return;
    }

    $allowedFields = [
        'event_type',
        'trigger_type',
        'status',
        'run_key',
        'scheduled_for',
        'file_name',
        'file_path',
        'file_size',
        'storage_path',
        'message',
        'related_backup_id',
        'initiated_by_user_id',
        'completed_at',
    ];

    $segments = [];
    $params = [':history_id' => $historyId];
    foreach ($allowedFields as $field) {
        if (!array_key_exists($field, $payload)) {
            continue;
        }
        $segments[] = "{$field} = :{$field}";
        $params[":{$field}"] = $payload[$field];
    }

    if (empty($segments)) {
        return;
    }

    $sql = 'UPDATE system_backup_history SET ' . implode(', ', $segments) . ' WHERE history_id = :history_id';
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
}

function backup_fetch_history(PDO $pdo, int $limit = 60): array
{
    $limit = max(1, min(200, $limit));
    $stmt = $pdo->query(
        'SELECT history_id, event_type, trigger_type, status, run_key, scheduled_for, file_name, file_path, file_size, storage_path, message, related_backup_id, initiated_by_user_id, created_at, completed_at
         FROM system_backup_history
         ORDER BY created_at DESC
         LIMIT ' . $limit
    );

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    return is_array($rows) ? $rows : [];
}

function backup_format_history_row(array $row): array
{
    $filePath = (string)($row['file_path'] ?? '');
    $isAvailable = $filePath !== '' && is_file($filePath);

    return [
        'history_id' => (int)$row['history_id'],
        'event_type' => (string)($row['event_type'] ?? 'backup'),
        'trigger_type' => (string)($row['trigger_type'] ?? 'manual'),
        'status' => (string)($row['status'] ?? 'unknown'),
        'run_key' => $row['run_key'] ?? null,
        'scheduled_for' => $row['scheduled_for'] ?? null,
        'file_name' => $row['file_name'] ?? '',
        'file_size' => isset($row['file_size']) ? (int)$row['file_size'] : null,
        'message' => $row['message'] ?? '',
        'related_backup_id' => isset($row['related_backup_id']) ? (int)$row['related_backup_id'] : null,
        'created_at' => $row['created_at'] ?? null,
        'completed_at' => $row['completed_at'] ?? null,
        'is_available' => $isAvailable,
        'can_download' => $isAvailable && ($row['event_type'] ?? '') === 'backup' && ($row['status'] ?? '') === 'success',
        'can_restore' => $isAvailable && ($row['event_type'] ?? '') === 'backup' && ($row['status'] ?? '') === 'success',
    ];
}

function backup_history_stats(array $rows): array
{
    $stats = [
        'successful_backups' => 0,
        'failed_backups' => 0,
        'successful_restores' => 0,
        'failed_restores' => 0,
        'last_success_at' => null,
    ];

    foreach ($rows as $row) {
        $eventType = $row['event_type'] ?? '';
        $status = $row['status'] ?? '';

        if ($eventType === 'backup' && $status === 'success') {
            $stats['successful_backups'] += 1;
            if ($stats['last_success_at'] === null) {
                $stats['last_success_at'] = $row['completed_at'] ?? $row['created_at'] ?? null;
            }
        } elseif ($eventType === 'backup' && $status === 'failed') {
            $stats['failed_backups'] += 1;
        } elseif ($eventType === 'restore' && $status === 'success') {
            $stats['successful_restores'] += 1;
        } elseif ($eventType === 'restore' && $status === 'failed') {
            $stats['failed_restores'] += 1;
        }
    }

    return $stats;
}

function backup_emit_notification(PDO $pdo, array $payload, array $context = []): void
{
    api_notifications_try_create($pdo, [
        'event_key' => $payload['event_key'] ?? 'backup_event',
        'level' => $payload['level'] ?? 'info',
        'title' => $payload['title'] ?? 'Backup event',
        'message' => $payload['message'] ?? 'A backup event was recorded.',
        'module_key' => 'settings',
        'entity_type' => $payload['entity_type'] ?? 'backup',
        'entity_id' => isset($payload['entity_id']) ? (int)$payload['entity_id'] : null,
        'actor_user_id' => isset($payload['actor_user_id']) ? (int)$payload['actor_user_id'] : null,
        'toast' => true,
        'target' => [
            'view' => 'settings',
            'section' => 'backup',
        ],
        'metadata' => is_array($payload['metadata'] ?? null) ? $payload['metadata'] : [],
        'recipients' => [
            'module_targets' => [
                ['module' => 'settings', 'action' => 'view'],
            ],
        ],
    ], $context);
}

function backup_acquire_lock()
{
    $storageRoot = backup_storage_root();
    if (!is_dir($storageRoot) && !@mkdir($storageRoot, 0775, true) && !is_dir($storageRoot)) {
        throw new RuntimeException('Unable to prepare backup system storage.');
    }

    $handle = @fopen(backup_global_lock_path(), 'c+');
    if ($handle === false) {
        throw new RuntimeException('Unable to allocate backup system lock file.');
    }

    if (!@flock($handle, LOCK_EX | LOCK_NB)) {
        fclose($handle);
        return null;
    }

    return $handle;
}

function backup_release_lock($handle): void
{
    if (!is_resource($handle)) {
        return;
    }

    @flock($handle, LOCK_UN);
    @fclose($handle);
}

/**
 * Write a [client] password file for mysql/mysqldump, or null for no password.
 *
 * Both the dump and the restore need this, and until now only the dump had it:
 * the restore appended '--password=' . $password to its argument list, which
 * puts the database password in the process list where any local account can
 * read it with `tasklist` or `wmic process get commandline`. That copy stayed
 * wrong for as long as the password was empty, because the branch that leaked
 * it never ran -- so setting a password on the server is what would have armed
 * it. Both callers now build the file here so the two cannot drift again.
 *
 * The caller owns the returned file and must unlink it in a `finally`.
 */
function backup_temp_credentials_file(string $password): ?string
{
    if ($password === '') {
        return null;
    }

    $tempCnf = tempnam(sys_get_temp_dir(), 'mysql_cnf_');
    if ($tempCnf === false) {
        throw new RuntimeException('Failed to create temporary MySQL config file.');
    }

    /*
     * QUOTED, and it has to be.
     *
     * This wrote the password bare: `password=` followed by the value. MySQL's
     * option-file parser treats `#` as beginning a comment ANYWHERE on a line,
     * not only at the start, so a password containing one was silently cut at
     * that character and mysqldump was handed a different password than the one
     * configured -- failing with "Access denied" and no hint that the config
     * file was the reason. `;` behaves the same way, and a trailing space would
     * be trimmed off too.
     *
     * Inside double quotes all three are literal. The escaping order matters:
     * backslash first, or the backslashes added for the quotes get escaped a
     * second time and land in the password.
     *
     * The existing str_replace() for `"` was already the correct escaping for a
     * QUOTED value -- the quotes themselves were just never written.
     */
    $escaped = str_replace(['\\', '"'], ['\\\\', '\\"'], $password);
    $cnfContent = "[client]\npassword=\"" . $escaped . "\"\n";
    file_put_contents($tempCnf, $cnfContent);
    if (PHP_OS_FAMILY !== 'Windows') {
        chmod($tempCnf, 0600);
    }

    return $tempCnf;
}

function backup_stream_dump_to_file(array $dbConfig, string $targetFile): int
{
    $mysqldump = backup_resolve_mysqldump();
    // Keeps the password out of the process list (Fix #15).
    $tempCnf = backup_temp_credentials_file($dbConfig['password'] ?? '');

    try {
        $args = [$mysqldump];

        if ($tempCnf !== null) {
            $args[] = '--defaults-extra-file=' . $tempCnf;
        }

        $args = array_merge($args, [
            '--host=' . ($dbConfig['host'] ?? '127.0.0.1'),
        ], backup_connection_args($dbConfig), [
            '--user=' . ($dbConfig['username'] ?? 'root'),
            '--default-character-set=utf8mb4',
            '--single-transaction',
            '--quick',
            '--routines',
            '--triggers',
            '--events',
            '--databases',
            $dbConfig['db_name'] ?? 'rms_public_demo',
        ]);

        $command = implode(' ', array_map('escapeshellarg', $args));
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $process = proc_open($command, $descriptors, $pipes);
        if (!is_resource($process)) {
            throw new RuntimeException('Failed to start the database backup process.');
        }

        fclose($pipes[0]);
        $fh = fopen($targetFile, 'wb');
        if ($fh === false) {
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
            throw new RuntimeException('Unable to write the backup output file.');
        }

        while (!feof($pipes[1])) {
            $chunk = fread($pipes[1], 8192);
            if ($chunk === false || $chunk === '') {
                continue;
            }
            fwrite($fh, $chunk);
        }

        $stderr = trim((string)stream_get_contents($pipes[2]));
        fclose($pipes[1]);
        fclose($pipes[2]);
        fclose($fh);

        $status = proc_close($process);
        $fileSize = @filesize($targetFile);
        if ($status !== 0 || !$fileSize) {
            @unlink($targetFile);
            $message = $stderr !== '' ? "Database backup failed: {$stderr}" : 'Database backup failed.';
            throw new RuntimeException($message);
        }

        return (int)$fileSize;
    } finally {
        // Clean up temp credentials file
        if ($tempCnf !== null && is_file($tempCnf)) {
            @unlink($tempCnf);
        }
    }
}

function backup_restore_from_file(array $dbConfig, string $sourceFile): void
{
    if (!is_file($sourceFile)) {
        throw new RuntimeException('Selected backup file does not exist on the server.');
    }

    $mysql = backup_resolve_mysql_client();
    // Same reason as the dump path: never '--password=' on the command line.
    $tempCnf = backup_temp_credentials_file($dbConfig['password'] ?? '');

    try {
        $args = [$mysql];
        // --defaults-extra-file has to be the first argument; mysql rejects it
        // anywhere else, which is why this is built up rather than inlined.
        if ($tempCnf !== null) {
            $args[] = '--defaults-extra-file=' . $tempCnf;
        }
        $args = array_merge($args, [
            '--host=' . ($dbConfig['host'] ?? '127.0.0.1'),
        ], backup_connection_args($dbConfig), [
            '--user=' . ($dbConfig['username'] ?? 'root'),
            '--default-character-set=utf8mb4',
            '--database=' . ($dbConfig['db_name'] ?? 'rms_public_demo'),
        ]);

        $command = implode(' ', array_map('escapeshellarg', $args));
        /*
         * Descriptor 0 is the child's stdin, so it opens 'r' — the mode is the
         * child's, not ours. It said 'w' here, which is why no restore has ever
         * worked: fwrite() to that pipe returns false, mysql receives nothing on
         * stdin and exits 1 with "Error reading file 'UNKNOWN' (Errcode: 13)".
         * backup_create_backup() has always had this right; only this copy was
         * wrong, and the error it produced named a file rather than a pipe, which
         * sent the reader looking at permissions on the dump.
         */
        $descriptors = [
            0 => ['pipe', 'r'],
            1 => ['pipe', 'w'],
            2 => ['pipe', 'w'],
        ];

        $process = proc_open($command, $descriptors, $pipes);
        if (!is_resource($process)) {
            throw new RuntimeException('Failed to start the database restore process.');
        }

        $fh = fopen($sourceFile, 'rb');
        if ($fh === false) {
            fclose($pipes[0]);
            fclose($pipes[1]);
            fclose($pipes[2]);
            proc_close($process);
            throw new RuntimeException('Unable to open the selected backup file.');
        }

        /*
         * Every byte, or fail loudly.
         *
         * fwrite() on a pipe can accept fewer bytes than it was given, and the
         * return value was being discarded — a short write would have fed mysql a
         * dump cut off mid-statement and left the database half restored, which is
         * worse than not restoring at all. The read side is guarded too: fread()
         * returning false was `continue`d inside a !feof() loop, which spins
         * forever on a read error rather than reporting one.
         */
        while (!feof($fh)) {
            $chunk = fread($fh, 8192);
            if ($chunk === false) {
                fclose($fh);
                fclose($pipes[0]);
                fclose($pipes[1]);
                fclose($pipes[2]);
                proc_close($process);
                throw new RuntimeException('Failed while reading the backup file.');
            }
            if ($chunk === '') {
                break;
            }

            $offset = 0;
            $length = strlen($chunk);
            while ($offset < $length) {
                $written = fwrite($pipes[0], substr($chunk, $offset));
                if ($written === false || $written === 0) {
                    fclose($fh);
                    fclose($pipes[0]);
                    fclose($pipes[1]);
                    fclose($pipes[2]);
                    proc_close($process);
                    throw new RuntimeException('The restore stopped early: the database process stopped accepting input.');
                }
                $offset += $written;
            }
        }

        fclose($fh);
        fclose($pipes[0]);
        $stdout = trim((string)stream_get_contents($pipes[1]));
        $stderr = trim((string)stream_get_contents($pipes[2]));
        fclose($pipes[1]);
        fclose($pipes[2]);

        $status = proc_close($process);
        if ($status !== 0) {
            $detail = $stderr !== '' ? $stderr : $stdout;
            $message = $detail !== '' ? "Database restore failed: {$detail}" : 'Database restore failed.';
            throw new RuntimeException($message);
        }
    } finally {
        // The credentials file must go even when the restore threw, and the
        // restore throws in five places.
        if ($tempCnf !== null && is_file($tempCnf)) {
            @unlink($tempCnf);
        }
    }
}

function backup_create_backup(PDO $pdo, array $dbConfig, array $config, array $options): array
{
    set_time_limit(0);
    $lock = backup_acquire_lock();
    if ($lock === null) {
        throw new RuntimeException('Another backup or restore operation is already running.');
    }

    $historyId = 0;
    $filePath = null;

    try {
        if (!empty($options['run_key'])) {
            $existing = backup_find_history_by_run_key($pdo, (string)$options['run_key']);
            if ($existing) {
                return [
                    'status' => 'already_completed',
                    'history_id' => (int)$existing['history_id'],
                    'message' => 'The scheduled backup for this slot has already been processed.',
                ];
            }
        }

        $storageDirectory = backup_resolve_storage_directory($config['storage_path'] ?? null, true);
        $safeName = preg_replace('/[^a-z0-9_-]+/i', '', (string)($dbConfig['db_name'] ?? 'database'));
        if ($safeName === '') {
            $safeName = 'database';
        }

        $triggerType = (string)($options['trigger_type'] ?? 'manual');
        $fileName = sprintf(
            '%s_%s_backup_%s.sql',
            $safeName,
            preg_replace('/[^a-z0-9_-]+/i', '_', strtolower($triggerType)),
            date('Ymd_His')
        );
        $filePath = $storageDirectory . DIRECTORY_SEPARATOR . $fileName;

        $historyId = backup_insert_history($pdo, [
            'event_type' => 'backup',
            'trigger_type' => $triggerType,
            'status' => 'running',
            'run_key' => $options['run_key'] ?? null,
            'scheduled_for' => $options['scheduled_for'] ?? null,
            'file_name' => $fileName,
            'file_path' => $filePath,
            'storage_path' => $storageDirectory,
            'message' => $options['message'] ?? null,
            'initiated_by_user_id' => $options['initiated_by_user_id'] ?? null,
        ]);

        $fileSize = backup_stream_dump_to_file($dbConfig, $filePath);

        backup_update_history($pdo, $historyId, [
            'status' => 'success',
            'file_size' => $fileSize,
            'completed_at' => date('Y-m-d H:i:s'),
            'message' => $options['success_message'] ?? 'Backup completed successfully.',
        ]);
        backup_emit_notification($pdo, [
            'event_key' => 'backup_completed',
            'level' => 'success',
            'title' => (($options['trigger_type'] ?? 'manual') === 'scheduled') ? 'Scheduled backup completed' : 'Backup completed',
            'message' => $options['success_message'] ?? 'Backup completed successfully.',
            'entity_type' => 'backup',
            'entity_id' => $historyId,
            'actor_user_id' => isset($options['initiated_by_user_id']) ? (int)$options['initiated_by_user_id'] : null,
            'metadata' => [
                'history_id' => $historyId,
                'trigger_type' => $options['trigger_type'] ?? 'manual',
                'file_name' => $fileName,
                'file_size' => $fileSize,
            ],
        ], [
            'endpoint' => 'backup_service.php',
            'event_key' => 'backup_completed',
            'history_id' => $historyId,
        ]);

        return [
            'status' => 'success',
            'history_id' => $historyId,
            'file_name' => $fileName,
            'file_size' => $fileSize,
            'message' => $options['success_message'] ?? 'Backup completed successfully.',
        ];
    } catch (Throwable $e) {
        if ($historyId > 0) {
            backup_update_history($pdo, $historyId, [
                'status' => 'failed',
                'completed_at' => date('Y-m-d H:i:s'),
                'message' => $e->getMessage(),
            ]);
            backup_emit_notification($pdo, [
                'event_key' => 'backup_failed',
                'level' => 'error',
                'title' => (($options['trigger_type'] ?? 'manual') === 'scheduled') ? 'Scheduled backup failed' : 'Backup failed',
                'message' => $e->getMessage(),
                'entity_type' => 'backup',
                'entity_id' => $historyId,
                'actor_user_id' => isset($options['initiated_by_user_id']) ? (int)$options['initiated_by_user_id'] : null,
                'metadata' => [
                    'history_id' => $historyId,
                    'trigger_type' => $options['trigger_type'] ?? 'manual',
                    'file_name' => $filePath ? basename($filePath) : null,
                ],
            ], [
                'endpoint' => 'backup_service.php',
                'event_key' => 'backup_failed',
                'history_id' => $historyId,
            ]);
        }
        if ($filePath && is_file($filePath) && @filesize($filePath) === 0) {
            @unlink($filePath);
        }
        throw $e;
    } finally {
        backup_release_lock($lock);
    }
}

function backup_restore_snapshot(PDO $pdo, array $dbConfig, array $historyRow, ?array $user): array
{
    set_time_limit(0);
    $lock = backup_acquire_lock();
    if ($lock === null) {
        throw new RuntimeException('Another backup or restore operation is already running.');
    }

    $historyId = 0;
    try {
        $backupFilePath = (string)($historyRow['file_path'] ?? '');
        if ($backupFilePath === '' || !is_file($backupFilePath)) {
            throw new RuntimeException('The selected backup file is no longer available on the server.');
        }

        $historyId = backup_insert_history($pdo, [
            'event_type' => 'restore',
            'trigger_type' => 'manual',
            'status' => 'running',
            'file_name' => $historyRow['file_name'] ?? basename($backupFilePath),
            'file_path' => $backupFilePath,
            'file_size' => isset($historyRow['file_size']) ? (int)$historyRow['file_size'] : (@filesize($backupFilePath) ?: null),
            'storage_path' => $historyRow['storage_path'] ?? dirname($backupFilePath),
            'message' => 'Restore started.',
            'related_backup_id' => (int)($historyRow['history_id'] ?? 0),
            'initiated_by_user_id' => $user['user_id'] ?? null,
        ]);

        backup_restore_from_file($dbConfig, $backupFilePath);

        backup_update_history($pdo, $historyId, [
            'status' => 'success',
            'completed_at' => date('Y-m-d H:i:s'),
            'message' => 'Restore completed successfully.',
        ]);
        backup_emit_notification($pdo, [
            'event_key' => 'backup_restored',
            'level' => 'success',
            'title' => 'Backup restored',
            'message' => 'Restore completed successfully.',
            'entity_type' => 'backup_restore',
            'entity_id' => $historyId,
            'actor_user_id' => isset($user['user_id']) ? (int)$user['user_id'] : null,
            'metadata' => [
                'history_id' => $historyId,
                'related_backup_id' => isset($historyRow['history_id']) ? (int)$historyRow['history_id'] : null,
                'file_name' => $historyRow['file_name'] ?? null,
            ],
        ], [
            'endpoint' => 'backup_service.php',
            'event_key' => 'backup_restored',
            'history_id' => $historyId,
        ]);

        return [
            'status' => 'success',
            'history_id' => $historyId,
            'message' => 'Restore completed successfully.',
        ];
    } catch (Throwable $e) {
        if ($historyId > 0) {
            backup_update_history($pdo, $historyId, [
                'status' => 'failed',
                'completed_at' => date('Y-m-d H:i:s'),
                'message' => $e->getMessage(),
            ]);
            backup_emit_notification($pdo, [
                'event_key' => 'backup_restore_failed',
                'level' => 'error',
                'title' => 'Backup restore failed',
                'message' => $e->getMessage(),
                'entity_type' => 'backup_restore',
                'entity_id' => $historyId,
                'actor_user_id' => isset($user['user_id']) ? (int)$user['user_id'] : null,
                'metadata' => [
                    'history_id' => $historyId,
                    'related_backup_id' => isset($historyRow['history_id']) ? (int)$historyRow['history_id'] : null,
                    'file_name' => $historyRow['file_name'] ?? null,
                ],
            ], [
                'endpoint' => 'backup_service.php',
                'event_key' => 'backup_restore_failed',
                'history_id' => $historyId,
            ]);
        }
        throw $e;
    } finally {
        backup_release_lock($lock);
    }
}

function backup_run_due_schedule(PDO $pdo, array $dbConfig, array $config, ?array $user): array
{
    $now = backup_now();
    $dueSlot = backup_compute_due_slot($config, $now);
    if ($dueSlot === null) {
        return [
            'status' => 'idle',
            'message' => '',
            'next_run_at' => backup_datetime_string(backup_compute_next_run($config, $now)),
        ];
    }

    $existing = backup_find_history_by_run_key($pdo, (string)$dueSlot['run_key']);
    if ($existing) {
        return [
            'status' => 'already_completed',
            'history_id' => (int)$existing['history_id'],
            'message' => 'Scheduled backup already exists for the current schedule slot.',
            'next_run_at' => backup_datetime_string(backup_compute_next_run($config, $now)),
        ];
    }

    try {
        $result = backup_create_backup($pdo, $dbConfig, $config, [
            'trigger_type' => 'scheduled',
            'run_key' => $dueSlot['run_key'],
            'scheduled_for' => backup_datetime_string($dueSlot['scheduled_for']),
            'initiated_by_user_id' => $user['user_id'] ?? null,
            'success_message' => 'Scheduled backup completed successfully.',
        ]);

        if (($config['schedule_type'] ?? '') === 'custom' && $result['status'] === 'success') {
            $stmt = $pdo->prepare('UPDATE system_backup_config SET is_enabled = 0 WHERE config_id = :config_id');
            $stmt->execute([':config_id' => (int)$config['config_id']]);
            $config['is_enabled'] = false;
        }

        return [
            'status' => $result['status'],
            'history_id' => $result['history_id'] ?? null,
            'message' => $result['message'] ?? 'Scheduled backup completed successfully.',
            'next_run_at' => backup_datetime_string(backup_compute_next_run($config, $now)),
        ];
    } catch (Throwable $e) {
        return [
            'status' => 'failed',
            'message' => $e->getMessage(),
            'next_run_at' => backup_datetime_string(backup_compute_next_run($config, $now)),
        ];
    }
}

function backup_handle_download(PDO $pdo, int $historyId): void
{
    $entry = backup_fetch_history_entry($pdo, $historyId);
    if (
        !$entry ||
        ($entry['event_type'] ?? '') !== 'backup' ||
        ($entry['status'] ?? '') !== 'success'
    ) {
        backup_json(404, ['message' => 'Backup file not found.']);
    }

    $filePath = (string)($entry['file_path'] ?? '');
    if ($filePath === '' || !is_file($filePath)) {
        backup_json(404, ['message' => 'Backup file is no longer available on the server.']);
    }

    // Path traversal protection — ensure the file is within the storage root (Fix #16)
    $realFilePath = realpath($filePath);
    $realStorageRoot = realpath(backup_storage_root());
    if (
        $realFilePath === false
        || $realStorageRoot === false
        || strpos($realFilePath, $realStorageRoot . DIRECTORY_SEPARATOR) !== 0
    ) {
        backup_json(403, ['message' => 'Access denied.']);
    }

    $fileName = trim((string)($entry['file_name'] ?? ''));
    if ($fileName === '') {
        $fileName = basename($filePath);
    }

    // Sanitize filename for Content-Disposition to prevent header injection
    $safeFileName = preg_replace('/[^a-zA-Z0-9._-]/', '_', basename($fileName));

    $fileSize = @filesize($filePath);
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . $safeFileName . '"');
    if ($fileSize !== false) {
        header('Content-Length: ' . (string)$fileSize);
    }
    header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
    header('Pragma: no-cache');
    header('Expires: 0');
    readfile($filePath);
    exit;
}
