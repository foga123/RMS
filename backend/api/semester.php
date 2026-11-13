<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';


// semester table schema (from capstone_db.sql):
// semester_id (PK, auto)
// semester_name (varchar)
// semester_status (int FK -> status.status_id)

/**
 * The terms this endpoint will accept a name for.
 *
 * Written once and read by both POST and PUT, which each carried their own copy
 * of the list AND their own copy of the error message spelling it out. Adding
 * Summer meant changing four places, and the pair that gets missed is the error
 * text — it goes on naming the two terms it used to allow while the check
 * beside it allows three.
 */
function semester_allowed_names(): array {
    return ['1st Semester', '2nd Semester', 'Summer'];
}

function semester_allowed_names_message(): string {
    return 'semester_name must be one of: ' . implode(', ', semester_allowed_names());
}

try {
    $db = new Database();
    $pdo = $db->connect();

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT * FROM semester WHERE semester_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Semester not found']);
            api_out(200, ['data' => $row]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $status = (isset($_GET['semester_status']) && $_GET['semester_status'] !== '') ? (int)$_GET['semester_status'] : null;

        $whereParts = [];
        $params = [];
        if ($search !== '') {
            $whereParts[] = 'semester_name LIKE :q';
            $params[':q'] = "%$search%";
        }
        if ($status !== null) {
            $whereParts[] = 'semester_status = :st';
            $params[':st'] = $status;
        }
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT * FROM semester $where ORDER BY semester_id DESC LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = 'SELECT COUNT(*) FROM semester ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) {
            $countStmt->bindValue($k, $v);
        }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        if (!isset($p['semester_name']) || trim((string)$p['semester_name']) === '') api_out(400, ['message' => 'semester_name is required']);
        $allowedNames = semester_allowed_names();
        $semesterName = trim((string)$p['semester_name']);
        if (!in_array($semesterName, $allowedNames, true)) {
            api_out(400, ['message' => semester_allowed_names_message()]);
        }
        // One row per semester name (uq_semester_name). Said here, before the
        // insert, so the refusal is a sentence rather than a database error.
        $dup = $pdo->prepare('SELECT semester_id FROM semester WHERE semester_name = :n LIMIT 1');
        $dup->execute([':n' => $semesterName]);
        if ($dup->fetch()) api_out(409, ['message' => 'That semester already exists']);

        $sql = 'INSERT INTO semester (semester_name, semester_status) VALUES (:semester_name, :semester_status)';
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            ':semester_name' => $semesterName,
            ':semester_status' => isset($p['semester_status']) && $p['semester_status'] !== '' ? (int)$p['semester_status'] : null,
        ]);

        $newId = (int)$pdo->lastInsertId();
        $sel = $pdo->prepare('SELECT * FROM semester WHERE semester_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(201, ['message' => 'Semester created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;

        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) {
            $id = isset($p['semester_id']) ? (int)$p['semester_id'] : 0;
        }
        if ($id <= 0) api_out(400, ['message' => 'Valid semester id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $chk = $pdo->prepare('SELECT * FROM semester WHERE semester_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Semester not found']);

        $fields = [];
        $params = [':id' => $id];
        $editable = ['semester_name', 'semester_status'];

        $allowedNames = semester_allowed_names();

        foreach ($editable as $col) {
            if (array_key_exists($col, $p)) {
                $fields[] = "$col = :$col";
                if ($col === 'semester_status') {
                    $params[":$col"] = ($p[$col] !== null && $p[$col] !== '') ? (int)$p[$col] : null;
                } elseif ($col === 'semester_name') {
                    $name = $p[$col] !== null ? trim((string)$p[$col]) : '';
                    if ($name !== '' && !in_array($name, $allowedNames, true)) {
                        api_out(400, ['message' => semester_allowed_names_message()]);
                    }
                    if ($name !== '') {
                        $dup = $pdo->prepare('SELECT semester_id FROM semester WHERE semester_name = :n AND semester_id <> :id LIMIT 1');
                        $dup->execute([':n' => $name, ':id' => $id]);
                        if ($dup->fetch()) api_out(409, ['message' => 'Another semester already has that name']);
                    }
                    $params[":$col"] = $name === '' ? null : $name;
                } else {
                    $params[":$col"] = ($p[$col] !== null) ? trim((string)$p[$col]) : null;
                }
            }
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE semester SET ' . implode(', ', $fields) . ' WHERE semester_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare('SELECT * FROM semester WHERE semester_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(200, ['message' => 'Semester updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid semester id is required']);

        $del = $pdo->prepare('DELETE FROM semester WHERE semester_id = :id');
        $del->execute([':id' => $id]);

        api_out(200, ['message' => 'Semester deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
