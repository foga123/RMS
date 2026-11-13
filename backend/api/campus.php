<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';


try {
    $db = new Database();
    $pdo = $db->connect();

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        // Optional single campus by id.
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT campus_id, campus_name, campus_code, address FROM campus WHERE campus_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Campus not found']);
            api_out(200, ['data' => $row]);
        }

        // List campuses with pagination + search by name.
        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $where = '';
        $params = [];
        if ($search !== '') {
            $where = 'WHERE (campus_name LIKE :q OR campus_code LIKE :q OR address LIKE :q)';
            $params[':q'] = "%$search%";
        }

        $sql = "SELECT campus_id, campus_name, campus_code, address FROM campus $where ORDER BY campus_id ASC LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = 'SELECT COUNT(*) FROM campus ' . ($where !== '' ? $where : '');
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
            'campus_name' => 'Campus name',
            'campus_code' => 'Campus code',
        ], 'strict');
        $unsafe = $unsafe ?? api_reject_unsafe_fields($payload, [
            'address' => 'Address',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        $name = isset($payload['campus_name']) ? trim((string)$payload['campus_name']) : '';
        $code = array_key_exists('campus_code', $payload) ? trim((string)$payload['campus_code']) : '';
        $address = array_key_exists('address', $payload) ? trim((string)$payload['address']) : '';
        $code = ($code !== '') ? $code : null;
        $address = ($address !== '') ? $address : null;
        if ($name === '') api_out(400, ['message' => 'campus_name is required']);

        $chk = $pdo->prepare('SELECT campus_id FROM campus WHERE campus_name = :n LIMIT 1');
        $chk->execute([':n' => $name]);
        if ($chk->fetch()) api_out(409, ['message' => 'Campus name already exists']);

        if ($code !== null) {
            $chkCode = $pdo->prepare('SELECT campus_id FROM campus WHERE campus_code = :c LIMIT 1');
            $chkCode->execute([':c' => $code]);
            if ($chkCode->fetch()) api_out(409, ['message' => 'Campus code already exists']);
        }

        $ins = $pdo->prepare('INSERT INTO campus (campus_name, campus_code, address) VALUES (:n, :c, :a)');
        $ins->execute([':n' => $name, ':c' => $code, ':a' => $address]);
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare('SELECT campus_id, campus_name, campus_code, address FROM campus WHERE campus_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(201, ['message' => 'Campus created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (is_array($payload) && !$id) { $id = isset($payload['campus_id']) ? (int)$payload['campus_id'] : 0; }
        if ($id <= 0) api_out(400, ['message' => 'Valid campus id is required']);

        $chk = $pdo->prepare('SELECT campus_id, campus_name, campus_code, address FROM campus WHERE campus_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Campus not found']);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        // The same refusal POST makes. Update had none, so anything create
        // turned away could be PUT onto the row a moment later. Address stays
        // 'prose' here exactly as it is on create - it is a sentence, not an
        // identifier, and the strict rule would reject real addresses.
        $unsafe = api_reject_unsafe_fields($payload, [
            'campus_name' => 'Campus name',
            'campus_code' => 'Campus code',
        ], 'strict');
        $unsafe = $unsafe ?? api_reject_unsafe_fields($payload, [
            'address' => 'Address',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $name = array_key_exists('campus_name', $payload) ? trim((string)$payload['campus_name']) : null;
        $code = array_key_exists('campus_code', $payload) ? trim((string)$payload['campus_code']) : (string)($existing['campus_code'] ?? '');
        $address = array_key_exists('address', $payload) ? trim((string)$payload['address']) : (string)($existing['address'] ?? '');
        $code = ($code !== '') ? $code : null;
        $address = ($address !== '') ? $address : null;
        if ($name === null) api_out(400, ['message' => 'campus_name is required']);
        if ($name === '') api_out(400, ['message' => 'campus_name cannot be empty']);

        if ($name !== $existing['campus_name']) {
            $dup = $pdo->prepare('SELECT campus_id FROM campus WHERE campus_name = :n AND campus_id <> :id LIMIT 1');
            $dup->execute([':n' => $name, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'Campus name already exists']);
        }

        if ($code !== null && $code !== (string)($existing['campus_code'] ?? '')) {
            $dupCode = $pdo->prepare('SELECT campus_id FROM campus WHERE campus_code = :c AND campus_id <> :id LIMIT 1');
            $dupCode->execute([':c' => $code, ':id' => $id]);
            if ($dupCode->fetch()) api_out(409, ['message' => 'Campus code already exists']);
        }

        $upd = $pdo->prepare('UPDATE campus SET campus_name = :n, campus_code = :c, address = :a WHERE campus_id = :id');
        $upd->execute([':n' => $name, ':c' => $code, ':a' => $address, ':id' => $id]);

        $sel = $pdo->prepare('SELECT campus_id, campus_name, campus_code, address FROM campus WHERE campus_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(200, ['message' => 'Campus updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid campus id is required']);

        // Prevent deleting a campus that is still used by departments.
        $ref = $pdo->prepare('SELECT department_id FROM department WHERE campus_id = :id LIMIT 1');
        $ref->execute([':id' => $id]);
        if ($ref->fetch()) api_out(409, ['message' => 'Cannot delete campus with linked departments']);

        $del = $pdo->prepare('DELETE FROM campus WHERE campus_id = :id');
        $del->execute([':id' => $id]);

        api_out(200, ['message' => 'Campus deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
