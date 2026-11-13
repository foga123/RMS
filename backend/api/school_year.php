<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';


try {
    $db = new Database();
    $pdo = $db->connect();

    $method = $_SERVER['REQUEST_METHOD'];
    $authUser = api_get_session_user();

    parse_str($_SERVER['QUERY_STRING'] ?? '', $syQuery);

    /*
     * Moving the line between what is editable and what is frozen.
     *
     * Grade remark policy applies to the current school year and later ones, so
     * this is the single setting that decides which years still recalculate and
     * which keep the records they have. It is a deliberate act with a visible
     * consequence, which is why it is its own action rather than a field on the
     * ordinary PUT: nobody should move it while editing a year's name.
     *
     * The clear and the set run in one transaction. The database allows only one
     * current year -- school_year.current_marker carries a unique key -- so a
     * failure between the two statements would otherwise leave no current year
     * at all, and every policy silently stops applying to anything.
     */
    if ($method === 'PUT' && ($syQuery['action'] ?? '') === 'set_current') {
        if (!api_session_user_has_role($authUser, ['admin'])) {
            api_out(403, ['message' => 'Only an administrator can change the current school year.']);
        }

        $p = json_decode(file_get_contents('php://input'), true);
        $targetId = is_array($p) && isset($p['school_year_id']) ? (int)$p['school_year_id'] : 0;
        if ($targetId <= 0) api_out(400, ['message' => 'Which school year?']);

        $check = $pdo->prepare('SELECT schoolyear_name FROM school_year WHERE school_year_id = :id LIMIT 1');
        $check->execute([':id' => $targetId]);
        $name = $check->fetchColumn();
        if ($name === false) api_out(404, ['message' => 'That school year does not exist.']);

        $pdo->beginTransaction();
        try {
            $pdo->prepare('UPDATE school_year SET is_current = 0 WHERE is_current = 1')->execute();
            $set = $pdo->prepare('UPDATE school_year SET is_current = 1 WHERE school_year_id = :id');
            $set->execute([':id' => $targetId]);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }

        api_write_audit_log($pdo, $authUser, 'settings_update', "Set the current school year to $name", [
            'school_year_id' => $targetId,
            'schoolyear_name' => $name,
        ]);

        api_out(200, ['message' => "$name is now the current school year.", 'data' => [
            'school_year_id' => $targetId,
            'schoolyear_name' => $name,
        ]]);
    }

    /*
     * Creating a school year.
     *
     * This endpoint was GET-only, and nothing else in the app wrote to the
     * table either - so `school_year` held exactly one row, 2025-2026, and
     * every term picker in the app offered that single option. There was no way
     * to record a second year short of editing the database by hand, which made
     * "compare this term against the last one" impossible to set up.
     *
     * Idempotent by name: asking for a year that already exists returns the
     * existing row rather than creating a duplicate. That is what lets a picker
     * offer a calendar range and resolve whichever one is chosen, without
     * having to know in advance which ones exist.
     */
    if ($method === 'POST') {
        $p = json_decode(file_get_contents('php://input'), true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $name = trim((string)($p['schoolyear_name'] ?? $p['school_year'] ?? ''));
        if ($name === '') api_out(400, ['message' => 'schoolyear_name is required']);

        // "2026-2027": two consecutive years. Rejecting anything else keeps the
        // column sortable and stops "2026 - 2027", "SY2026" and "2026-2028"
        // becoming three different names for one year.
        if (!preg_match('/^(\d{4})-(\d{4})$/', $name, $m)) {
            api_out(400, ['message' => 'School year must look like 2026-2027']);
        }
        if ((int)$m[2] !== (int)$m[1] + 1) {
            api_out(400, ['message' => 'A school year must span two consecutive years, e.g. 2026-2027']);
        }

        $existing = $pdo->prepare('SELECT school_year_id, schoolyear_name, schoolyear_status FROM school_year WHERE schoolyear_name = :name LIMIT 1');
        $existing->execute([':name' => $name]);
        if ($row = $existing->fetch(PDO::FETCH_ASSOC)) {
            api_out(200, ['message' => 'School year already exists', 'data' => $row]);
        }

        $status = isset($p['schoolyear_status']) && $p['schoolyear_status'] !== ''
            ? (int)$p['schoolyear_status']
            : null;

        $ins = $pdo->prepare('INSERT INTO school_year (schoolyear_name, schoolyear_status) VALUES (:name, :status)');
        try {
            $ins->execute([':name' => $name, ':status' => $status]);
        } catch (PDOException $duplicate) {
            // Two requests for the same new year at once: the other one won the
            // unique key (uq_school_year_name). Answer as the check above does.
            if ($duplicate->getCode() !== '23000') throw $duplicate;
            $existing->execute([':name' => $name]);
            api_out(200, ['message' => 'School year already exists', 'data' => $existing->fetch(PDO::FETCH_ASSOC)]);
        }
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare('SELECT school_year_id, schoolyear_name, schoolyear_status FROM school_year WHERE school_year_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);

        api_out(201, ['message' => 'School year created', 'data' => $sel->fetch(PDO::FETCH_ASSOC)]);
    }

    if ($method !== 'GET') {
        api_out(405, ['message' => 'Method not allowed']);
    }

    $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
    if ($id > 0) {
        $stmt = $pdo->prepare('SELECT school_year_id, schoolyear_name, schoolyear_status FROM school_year WHERE school_year_id = :id LIMIT 1');
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) api_out(404, ['message' => 'School year not found']);
        api_out(200, ['data' => $row]);
    }

    $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
    $limit = isset($_GET['limit']) ? max(1, min(1000, (int)$_GET['limit'])) : 200;
    $offset = ($page - 1) * $limit;
    $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';

    $where = '';
    $params = [];
    if ($search !== '') {
        $where = 'WHERE (schoolyear_name LIKE :q OR schoolyear_status LIKE :q)';
        $params[':q'] = "%$search%";
    }

    // By name, not by id: the ids are insertion order, so id order lists
    // 2022-2023 as though it came after 2026-2027. See lib/school_year_window.php.
    $sql = "SELECT school_year_id, schoolyear_name, schoolyear_status FROM school_year $where ORDER BY schoolyear_name DESC LIMIT :limit OFFSET :offset";
    $stmt = $pdo->prepare($sql);
    foreach ($params as $k => $v) {
        $stmt->bindValue($k, $v);
    }
    $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $countSql = 'SELECT COUNT(*) FROM school_year ' . ($where !== '' ? $where : '');
    $countStmt = $pdo->prepare($countSql);
    foreach ($params as $k => $v) {
        $countStmt->bindValue($k, $v);
    }
    $countStmt->execute();
    $total = (int)$countStmt->fetchColumn();

    api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
