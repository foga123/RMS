<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';



function ensure_department_archive_column(PDO $pdo): void {
    api_require_column($pdo, 'department', 'archived_at');
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $actor = api_get_session_user();
    ensure_department_archive_column($pdo);
    $hasArchivedAt = api_column_exists($pdo, 'department', 'archived_at');

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        // Optional single department by id
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT d.department_id, d.department_code, d.department_name, d.campus_id, c.campus_name FROM department d LEFT JOIN campus c ON c.campus_id = d.campus_id WHERE d.department_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Department not found']);
            api_out(200, ['data' => $row]);
        }

        // List departments with pagination + search by name
        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $includeArchived = isset($_GET['include_archived']) ? api_bool_like($_GET['include_archived'], false) : false;
        $archivedOnly = isset($_GET['archived']) ? api_bool_like($_GET['archived'], false) : false;
        $whereParts = [];
        $params = [];
        if ($hasArchivedAt) {
            if ($archivedOnly) {
                $whereParts[] = 'd.archived_at IS NOT NULL';
            } elseif (!$includeArchived) {
                $whereParts[] = 'd.archived_at IS NULL';
            }
        }
        if ($search !== '') {
            $whereParts[] = '(d.department_name LIKE :q OR d.department_code LIKE :q)';
            $params[':q'] = "%$search%";
        }
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT d.department_id, d.department_code, d.department_name, d.campus_id, d.archived_at AS archived_at, c.campus_name FROM department d LEFT JOIN campus c ON c.campus_id = d.campus_id $where ORDER BY d.department_id ASC LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = 'SELECT COUNT(*) FROM department d LEFT JOIN campus c ON c.campus_id = d.campus_id ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) { $countStmt->bindValue($k, $v); }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);


        /*
         * Injection guard. See api_reject_unsafe_text() in middleware/auth.php
         * for the two levels and why refusing on input beats escaping on output.
         * Names and codes are identifiers ('strict'); anything that is a
         * sentence is 'prose', which allows the brackets and question marks real
         * writing contains.
         */
        $unsafe = api_reject_unsafe_fields($payload, [
            'department_name' => 'Department name',
            'department_code' => 'Department code',
        ], 'strict');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        $name = isset($payload['department_name']) ? trim((string)$payload['department_name']) : '';
        $code = isset($payload['department_code']) ? trim((string)$payload['department_code']) : '';
        // campus_id optional in UI for now; default null
        $campusId = isset($payload['campus_id']) ? (int)$payload['campus_id'] : null;
        if ($name === '') api_out(400, ['message' => 'department_name is required']);
        if ($code === '') api_out(400, ['message' => 'department_code is required']);

        /*
         * A department is unique per campus, not per institution.
         *
         * The same college runs on more than one campus - CITE exists on both
         * Carmen and Puerto - and those are two department rows, not one. The
         * check used to be institution-wide, which made the second campus's
         * copy impossible to create at all. It is scoped to the campus now, and
         * the uq_department_code_campus index enforces the same rule underneath.
         *
         * NULL campus is compared with <=> so unassigned departments still
         * collide with each other rather than slipping past on a NULL compare.
         */
        $chkSql = 'SELECT department_id FROM department
                    WHERE (department_name = :n OR department_code = :d)
                      AND (campus_id <=> :c)';
        if ($hasArchivedAt) {
            $chkSql .= ' AND archived_at IS NULL';
        }
        $chkSql .= ' LIMIT 1';
        $chk = $pdo->prepare($chkSql);
        $chk->execute([':n' => $name, ':d' => $code, ':c' => ($campusId ?: null)]);
        if ($chk->fetch()) api_out(409, ['message' => 'That department name or code is already used on this campus']);

        $ins = $pdo->prepare('INSERT INTO department (department_name, department_code, campus_id) VALUES (:n, :d, :c)');
        $ins->execute([':n' => $name, ':d' => $code, ':c' => ($campusId ?: null)]);
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare('SELECT d.department_id, d.department_code, d.department_name, d.campus_id, c.campus_name FROM department d LEFT JOIN campus c ON c.campus_id = d.campus_id WHERE d.department_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            api_notifications_try_create($pdo, [
                'event_key' => 'department_created',
                'level' => 'success',
                'title' => 'Department created',
                'message' => 'Department "' . (string)($row['department_name'] ?? ('Department #' . $newId)) . '" was added.',
                'module_key' => 'departments',
                'entity_type' => 'department',
                'entity_id' => $newId,
                'actor_user_id' => (int)($actor['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'view' => 'departments',
                ],
                'metadata' => [
                    'department_id' => $newId,
                    'department_name' => $row['department_name'] ?? null,
                    'department_code' => $row['department_code'] ?? null,
                ],
                'recipients' => [
                    'module_targets' => [
                        ['module' => 'departments', 'action' => 'view'],
                    ],
                ],
            ], [
                'endpoint' => 'department.php',
                'event_key' => 'department_created',
                'department_id' => $newId,
            ]);
        }

        api_out(201, ['message' => 'Department created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (is_array($payload) && !$id) { $id = isset($payload['department_id']) ? (int)$payload['department_id'] : 0; }
        if ($id <= 0) api_out(400, ['message' => 'Valid department id is required']);

        // campus_id is read too: the duplicate checks below are scoped per
        // campus, so they need the campus this row is on today.
        $chk = $pdo->prepare('SELECT department_id, department_name, department_code, campus_id FROM department WHERE department_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Department not found']);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        // The same refusal POST makes. Update had none, so anything create
        // turned away could be PUT onto the row a moment later.
        $unsafe = api_reject_unsafe_fields($payload, [
            'department_name' => 'Department name',
            'department_code' => 'Department code',
        ], 'strict');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $name = array_key_exists('department_name', $payload) ? trim((string)$payload['department_name']) : null;
        $campusId = array_key_exists('campus_id', $payload) ? (int)$payload['campus_id'] : null;
        $code = array_key_exists('department_code', $payload) ? trim((string)$payload['department_code']) : null;
        $restoreRequested = $hasArchivedAt && array_key_exists('archived', $payload) && !api_bool_like($payload['archived'], false);

        $fields = [];
        $params = [':id' => $id];

        if ($name !== null && $name === '') api_out(400, ['message' => 'department_name cannot be empty']);
        if ($code !== null && $code === '') api_out(400, ['message' => 'department_code cannot be empty']);

        $effectiveName = $name !== null ? $name : $existing['department_name'];
        $effectiveCode = $code !== null ? $code : ($existing['department_code'] ?? '');

        /*
         * Both checks run against the campus this row will sit on *after* the
         * edit, not the one it sits on now - moving CITE Carmen to Puerto has
         * to collide with a CITE that is already on Puerto.
         */
        $effectiveCampusId = $campusId !== null ? ($campusId ?: null) : ($existing['campus_id'] ?? null);

        if ($restoreRequested || $effectiveName !== $existing['department_name']) {
            $dupSql = 'SELECT department_id FROM department
                        WHERE department_name = :n AND (campus_id <=> :c) AND department_id <> :id';
            if ($hasArchivedAt) {
                $dupSql .= ' AND archived_at IS NULL';
            }
            $dupSql .= ' LIMIT 1';
            $dup = $pdo->prepare($dupSql);
            $dup->execute([':n' => $effectiveName, ':c' => $effectiveCampusId, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'That department name is already used on this campus']);
        }

        if ($restoreRequested || $effectiveCode !== ($existing['department_code'] ?? '')) {
            $dupSql = 'SELECT department_id FROM department
                        WHERE department_code = :d AND (campus_id <=> :c) AND department_id <> :id';
            if ($hasArchivedAt) {
                $dupSql .= ' AND archived_at IS NULL';
            }
            $dupSql .= ' LIMIT 1';
            $dup = $pdo->prepare($dupSql);
            $dup->execute([':d' => $effectiveCode, ':c' => $effectiveCampusId, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'That department code is already used on this campus']);
        }

        if ($name !== null) {
            $fields[] = 'department_name = :n';
            $params[':n'] = $name;
        }
        if ($code !== null) {
            $fields[] = 'department_code = :d';
            $params[':d'] = $code;
        }
        if ($campusId !== null) { $fields[] = 'campus_id = :c'; $params[':c'] = $campusId ?: null; }
        if ($hasArchivedAt && array_key_exists('archived', $payload)) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($payload['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE department SET ' . implode(', ', $fields) . ' WHERE department_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare('SELECT d.department_id, d.department_code, d.department_name, d.campus_id, c.campus_name FROM department d LEFT JOIN campus c ON c.campus_id = d.campus_id WHERE d.department_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            $eventKey = 'department_updated';
            $title = 'Department updated';
            $message = 'Department "' . (string)($row['department_name'] ?? ('Department #' . $id)) . '" was updated.';
            if ($hasArchivedAt && array_key_exists('archived', $payload)) {
                if (api_bool_like($payload['archived'], false)) {
                    $eventKey = 'department_archived';
                    $title = 'Department archived';
                    $message = 'Department "' . (string)($row['department_name'] ?? ('Department #' . $id)) . '" was archived.';
                } else {
                    $eventKey = 'department_restored';
                    $title = 'Department restored';
                    $message = 'Department "' . (string)($row['department_name'] ?? ('Department #' . $id)) . '" was restored.';
                }
            }

            api_notifications_try_create($pdo, [
                'event_key' => $eventKey,
                'level' => $eventKey === 'department_archived' ? 'warning' : 'success',
                'title' => $title,
                'message' => $message,
                'module_key' => 'departments',
                'entity_type' => 'department',
                'entity_id' => $id,
                'actor_user_id' => (int)($actor['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'view' => 'departments',
                ],
                'metadata' => [
                    'department_id' => $id,
                    'department_name' => $row['department_name'] ?? null,
                    'department_code' => $row['department_code'] ?? null,
                ],
                'recipients' => [
                    'module_targets' => [
                        ['module' => 'departments', 'action' => 'view'],
                    ],
                ],
            ], [
                'endpoint' => 'department.php',
                'event_key' => $eventKey,
                'department_id' => $id,
            ]);
        }

        api_out(200, ['message' => 'Department updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid department id is required']);

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE department SET archived_at = :archived_at WHERE department_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
        } else {
            $del = $pdo->prepare('DELETE FROM department WHERE department_id = :id');
            $del->execute([':id' => $id]);
        }

        api_notifications_try_create($pdo, [
            'event_key' => 'department_archived',
            'level' => 'warning',
            'title' => 'Department archived',
            'message' => 'A department record was archived.',
            'module_key' => 'departments',
            'entity_type' => 'department',
            'entity_id' => $id,
            'actor_user_id' => (int)($actor['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'view' => 'departments',
            ],
            'metadata' => [
                'department_id' => $id,
            ],
            'recipients' => [
                'module_targets' => [
                    ['module' => 'departments', 'action' => 'view'],
                ],
            ],
        ], [
            'endpoint' => 'department.php',
            'event_key' => 'department_archived',
            'department_id' => $id,
        ]);

        api_out(200, ['message' => 'Department archived']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
