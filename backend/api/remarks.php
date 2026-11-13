<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';



function ensure_remarks_archive_column(PDO $pdo): void {
    api_require_column($pdo, 'remarks', 'archived_at');
}

/**
 * Which rule engine may assign this remark: any | grades | attendance.
 *
 * Guarded rather than assumed. This endpoint predates the column and has to keep
 * answering on a database where 2026_08_29_attendance_remark_policy.sql has not
 * been applied -- a management screen that 500s because a migration is pending
 * is a worse failure than one that cannot classify a remark yet.
 */
function remarks_applies_to_column(PDO $pdo): bool {
    static $exists = null;
    if ($exists === null) {
        $exists = (bool)$pdo->query("SHOW COLUMNS FROM `remarks` LIKE 'applies_to'")->fetchAll();
    }
    return $exists;
}

function remarks_normalize_applies_to($value): string {
    $normalized = strtolower(trim((string)$value));
    return in_array($normalized, ['any', 'grades', 'attendance'], true) ? $normalized : 'any';
}

function remarks_select_columns(PDO $pdo): string {
    return remarks_applies_to_column($pdo)
        ? 'remark_id, remark_name, description, risk_level, applies_to, status'
        : "remark_id, remark_name, description, risk_level, 'any' AS applies_to, status";
}

function fetch_remark(PDO $pdo, int $id) {
    $sel = $pdo->prepare('SELECT ' . remarks_select_columns($pdo) . ' FROM remarks WHERE remark_id = :id LIMIT 1');
    $sel->execute([':id' => $id]);
    return $sel->fetch(PDO::FETCH_ASSOC);
}

try {
    $db = new Database();
    $pdo = $db->connect();
    ensure_remarks_archive_column($pdo);
    $hasArchivedAt = api_column_exists($pdo, 'remarks', 'archived_at');
    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $row = fetch_remark($pdo, $id);
            if (!$row) api_out(404, ['message' => 'Remark not found']);
            api_out(200, ['data' => $row]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $riskLevel = isset($_GET['risk_level']) ? trim((string)$_GET['risk_level']) : '';
        $status = (isset($_GET['status']) && $_GET['status'] !== '') ? (int)$_GET['status'] : null;
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
            $whereParts[] = '(remark_name LIKE :q OR description LIKE :q OR risk_level LIKE :q)';
            $params[':q'] = "%$search%";
        }
        if ($riskLevel !== '') {
            $whereParts[] = 'risk_level = :risk_level';
            $params[':risk_level'] = $riskLevel;
        }
        if ($status !== null) {
            $whereParts[] = 'status = :status';
            $params[':status'] = $status;
        }
        $appliesTo = isset($_GET['applies_to']) ? strtolower(trim((string)$_GET['applies_to'])) : '';
        if ($appliesTo !== '' && remarks_applies_to_column($pdo)) {
            if ($appliesTo === 'any') {
                $whereParts[] = "applies_to = 'any'";
            } else {
                // A remark marked 'any' belongs in every engine's list, so
                // filtering to one engine still has to include it.
                $whereParts[] = "applies_to IN ('any', :applies_to)";
                $params[':applies_to'] = remarks_normalize_applies_to($appliesTo);
            }
        }

        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $columns = remarks_select_columns($pdo);
        $sql = "SELECT $columns, archived_at
                FROM remarks
                $where
                ORDER BY remark_id ASC
                LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = 'SELECT COUNT(*) FROM remarks ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) { $countStmt->bindValue($k, $v); }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);


        /*
         * Injection guard. See api_reject_unsafe_text() in middleware/auth.php
         * for the two levels and why refusing on input beats escaping on output.
         * Names and codes are identifiers ('strict'); anything that is a
         * sentence is 'prose', which allows the brackets and question marks real
         * writing contains.
         */
        $unsafe = api_reject_unsafe_fields($p, [
            'remark_name' => 'Remark name',
            'risk_level' => 'Risk level',
        ], 'strict');
        $unsafe = $unsafe ?? api_reject_unsafe_fields($p, [
            'description' => 'Description',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        $name = isset($p['remark_name']) ? trim((string)$p['remark_name']) : '';
        $description = array_key_exists('description', $p) ? trim((string)$p['description']) : null;
        if ($description === '') $description = null;
        $riskLevel = isset($p['risk_level']) ? trim((string)$p['risk_level']) : '';
        $status = array_key_exists('status', $p) && $p['status'] !== '' ? (int)$p['status'] : 1;

        if ($name === '') api_out(400, ['message' => 'remark_name is required']);
        if ($riskLevel === '') api_out(400, ['message' => 'risk_level is required']);

        $dupSql = 'SELECT remark_id FROM remarks WHERE remark_name = :name';
        if ($hasArchivedAt) {
            $dupSql .= ' AND archived_at IS NULL';
        }
        $dupSql .= ' LIMIT 1';
        $dup = $pdo->prepare($dupSql);
        $dup->execute([':name' => $name]);
        if ($dup->fetch()) api_out(409, ['message' => 'Remark name already exists']);

        $insertColumns = 'remark_name, description, risk_level, status';
        $insertValues = ':name, :description, :risk_level, :status';
        $insertParams = [
            ':name' => $name,
            ':description' => $description,
            ':risk_level' => $riskLevel,
            ':status' => $status,
        ];
        if (remarks_applies_to_column($pdo)) {
            $insertColumns .= ', applies_to';
            $insertValues .= ', :applies_to';
            $insertParams[':applies_to'] = remarks_normalize_applies_to($p['applies_to'] ?? 'any');
        }

        $ins = $pdo->prepare("INSERT INTO remarks ($insertColumns) VALUES ($insertValues)");
        $ins->execute($insertParams);
        $newId = (int)$pdo->lastInsertId();

        $row = fetch_remark($pdo, $newId);
        api_out(201, ['message' => 'Remark created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) $id = isset($p['remark_id']) ? (int)$p['remark_id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid remark id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $existing = fetch_remark($pdo, $id);
        if (!$existing) api_out(404, ['message' => 'Remark not found']);

        // The same refusal POST makes. Update had none, so anything create
        // turned away could be PUT onto the row a moment later.
        $unsafe = api_reject_unsafe_fields($p, [
            'remark_name' => 'Remark name',
            'risk_level' => 'Risk level',
        ], 'strict');
        $unsafe = $unsafe ?? api_reject_unsafe_fields($p, [
            'description' => 'Description',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $fields = [];
        $params = [':id' => $id];
        $restoreRequested = $hasArchivedAt && array_key_exists('archived', $p) && !api_bool_like($p['archived'], false);

        $name = array_key_exists('remark_name', $p) ? trim((string)$p['remark_name']) : null;
        if ($name !== null && $name === '') api_out(400, ['message' => 'remark_name cannot be empty']);

        $effectiveName = $name !== null ? $name : $existing['remark_name'];
        if ($restoreRequested || $effectiveName !== $existing['remark_name']) {
            $dupSql = 'SELECT remark_id FROM remarks WHERE remark_name = :name AND remark_id <> :id';
            if ($hasArchivedAt) {
                $dupSql .= ' AND archived_at IS NULL';
            }
            $dupSql .= ' LIMIT 1';
            $dup = $pdo->prepare($dupSql);
            $dup->execute([':name' => $effectiveName, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'Remark name already exists']);
        }

        if ($name !== null) {
            $fields[] = 'remark_name = :remark_name';
            $params[':remark_name'] = $name;
        }

        if (array_key_exists('description', $p)) {
            $description = $p['description'] !== null ? trim((string)$p['description']) : null;
            if ($description === '') $description = null;
            $fields[] = 'description = :description';
            $params[':description'] = $description;
        }

        if (array_key_exists('risk_level', $p)) {
            $riskLevel = trim((string)$p['risk_level']);
            if ($riskLevel === '') api_out(400, ['message' => 'risk_level cannot be empty']);
            $fields[] = 'risk_level = :risk_level';
            $params[':risk_level'] = $riskLevel;
        }

        if (array_key_exists('status', $p)) {
            if ($p['status'] === '' || $p['status'] === null) api_out(400, ['message' => 'status cannot be empty']);
            $status = (int)$p['status'];
            $fields[] = 'status = :status';
            $params[':status'] = $status;
        }

        if (array_key_exists('applies_to', $p) && remarks_applies_to_column($pdo)) {
            $fields[] = 'applies_to = :applies_to';
            $params[':applies_to'] = remarks_normalize_applies_to($p['applies_to']);
        }
        if ($hasArchivedAt && array_key_exists('archived', $p)) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($p['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE remarks SET ' . implode(', ', $fields) . ' WHERE remark_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $row = fetch_remark($pdo, $id);
        api_out(200, ['message' => 'Remark updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid remark id is required']);

        $existing = fetch_remark($pdo, $id);
        if (!$existing) api_out(404, ['message' => 'Remark not found']);

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE remarks SET archived_at = :archived_at WHERE remark_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
        } else {
            $del = $pdo->prepare('DELETE FROM remarks WHERE remark_id = :id');
            try {
                $del->execute([':id' => $id]);
            } catch (PDOException $e) {
                if ($e->getCode() === '23000') {
                    api_out(409, ['message' => 'Cannot delete remark because it is used by other records']);
                }
                throw $e;
            }
        }

        api_out(200, ['message' => 'Remark archived']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
