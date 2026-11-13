<?php
require_once __DIR__ . '/connection-pdo.php';

// Use centralized secure headers instead of manual CORS
api_send_headers(['GET', 'POST', 'PUT', 'OPTIONS']);
api_handle_preflight();
require_once __DIR__ . '/backup_service.php';

/**
 * Record a backup action, without ever failing it.
 *
 * Backups and restores had their own history table and nothing in the audit log,
 * so the Audit Logs screen could not answer "who restored the database on
 * Tuesday" — the one act that can undo every other act it records.
 *
 * Same never-throws contract as the other audit wrappers: a restore that worked
 * must not report failure because the line describing it could not be written.
 */
function backup_audit(PDO $pdo, ?array $actor, string $action, string $detail, array $metadata = []): void
{
    try {
        api_write_audit_log($pdo, $actor, $action, $detail, $metadata);
    } catch (Throwable $auditError) {
        api_log_exception($auditError, ['endpoint' => 'backup.php', 'audit_action' => $action]);
    }
}

try {
    $user = api_get_session_user();
    if (!$user) {
        backup_json(401, ['message' => 'Authentication required.']);
    }

    $pdo = (new Database())->connect();
    if (!$pdo instanceof PDO) {
        backup_json(500, ['message' => 'Database connection failed.']);
    }

    backup_ensure_tables($pdo);
    $dbConfig = backup_get_database_config();
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $permissionRecord = api_fetch_effective_permissions_record(
        $pdo,
        (int)($user['role_id'] ?? 0),
        (int)($user['user_id'] ?? 0)
    );
    $settingsPermissions = $permissionRecord['permissions'] ?? [];
    $canViewSettings = api_can($settingsPermissions, 'settings', 'view');
    $canEditSettings = api_can($settingsPermissions, 'settings', 'edit');

    if (!$canViewSettings) {
        backup_json(403, ['message' => 'You do not have permission to view backup settings.']);
    }

    if ($method === 'GET' && isset($_GET['download_id'])) {
        backup_handle_download($pdo, (int)$_GET['download_id']);
    }

    if ($method === 'GET') {
        $config = backup_fetch_config($pdo);
        $mode = strtolower(trim((string)($_GET['mode'] ?? '')));
        $scheduler = backup_run_due_schedule($pdo, $dbConfig, $config, $user);
        if (($config['schedule_type'] ?? '') === 'custom' && ($scheduler['status'] ?? '') === 'success') {
            $config = backup_fetch_config($pdo);
        }

        if ($mode === 'heartbeat') {
            backup_json(200, [
                'message' => 'Scheduler heartbeat processed.',
                'data' => [
                    'server_time' => backup_datetime_string(backup_now()),
                    'timezone' => backup_timezone_name(),
                    'next_run_at' => backup_datetime_string(backup_compute_next_run($config)),
                ],
                'scheduler' => $scheduler,
            ]);
        }

        $historyRows = array_map('backup_format_history_row', backup_fetch_history($pdo, 80));
        backup_json(200, [
            'message' => 'Backup data loaded.',
            'data' => [
                'config' => backup_format_config_response($config),
                'history' => $historyRows,
                'stats' => backup_history_stats($historyRows),
            ],
            'scheduler' => $scheduler,
        ]);
    }

    if ($method === 'PUT') {
        if (!$canEditSettings) {
            backup_json(403, ['message' => 'No permission for this action.']);
        }
        $payload = backup_read_json_body();
        $config = backup_update_config($pdo, $payload, $user);
        backup_audit($pdo, $user, 'settings_update', 'Changed the database backup schedule.', [
            'frequency' => $config['frequency'] ?? null,
            'retention_days' => $config['retention_days'] ?? null,
        ]);
        backup_json(200, [
            'message' => 'Backup schedule saved successfully.',
            'data' => [
                'config' => backup_format_config_response($config),
            ],
        ]);
    }

    if ($method === 'POST') {
        if (!$canEditSettings) {
            backup_json(403, ['message' => 'No permission for this action.']);
        }
        $payload = backup_read_json_body();
        $action = strtolower(trim((string)($payload['action'] ?? 'backup_now')));
        $config = backup_fetch_config($pdo);

        if ($action === 'backup_now') {
            $result = backup_create_backup($pdo, $dbConfig, $config, [
                'trigger_type' => 'manual',
                'initiated_by_user_id' => $user['user_id'] ?? null,
                'success_message' => 'Backup completed successfully.',
            ]);

            backup_audit($pdo, $user, 'backup_created', 'Created a manual database backup: '
                . ($result['file_name'] ?? 'unnamed file') . '.', [
                    'history_id' => $result['history_id'] ?? null,
                    'file_name' => $result['file_name'] ?? '',
                    'file_size' => $result['file_size'] ?? null,
                ]);

            backup_json(200, [
                'message' => $result['message'] ?? 'Backup completed successfully.',
                'data' => [
                    'history_id' => $result['history_id'] ?? null,
                    'file_name' => $result['file_name'] ?? '',
                    'file_size' => $result['file_size'] ?? null,
                ],
            ]);
        }

        if ($action === 'restore') {
            $historyId = isset($payload['history_id']) ? (int)$payload['history_id'] : 0;
            if ($historyId <= 0) {
                backup_json(422, ['message' => 'A valid backup record is required for restore.']);
            }

            $historyRow = backup_fetch_history_entry($pdo, $historyId);
            if (!$historyRow || ($historyRow['event_type'] ?? '') !== 'backup' || ($historyRow['status'] ?? '') !== 'success') {
                backup_json(404, ['message' => 'Selected backup record is not available for restore.']);
            }

            $result = backup_restore_snapshot($pdo, $dbConfig, $historyRow, $user);

            /*
             * The single most consequential act in the application: it replaces
             * every table with the contents of a file. Written after the restore
             * rather than before, so the row survives — the restore overwrites
             * api_audit_log along with everything else, so anything logged first
             * is wiped by the very operation it was describing.
             */
            backup_audit($pdo, $user, 'backup_restored', 'Restored the database from backup "'
                . ($historyRow['file_name'] ?? ('#' . $historyId)) . '".', [
                    'history_id' => $historyId,
                    'file_name' => $historyRow['file_name'] ?? null,
                    'backup_taken_at' => $historyRow['created_at'] ?? null,
                ]);

            backup_json(200, [
                'message' => $result['message'] ?? 'Restore completed successfully.',
                'data' => [
                    'history_id' => $result['history_id'] ?? null,
                ],
            ]);
        }

        if ($action === 'run_due') {
            $scheduler = backup_run_due_schedule($pdo, $dbConfig, $config, $user);
            backup_json(200, [
                'message' => 'Scheduler run processed.',
                'scheduler' => $scheduler,
                'data' => [
                    'config' => backup_format_config_response(backup_fetch_config($pdo)),
                ],
            ]);
        }

        backup_json(400, ['message' => 'Unsupported backup action.']);
    }

    backup_json(405, ['message' => 'Method not allowed.']);
} catch (InvalidArgumentException $e) {
    backup_json(422, ['message' => $e->getMessage()]);
} catch (RuntimeException $e) {
    backup_json(409, ['message' => $e->getMessage()]);
} catch (Throwable $e) {
    backup_json(500, ['message' => 'Server error.']);
}
