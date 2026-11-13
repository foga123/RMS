<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';



function ensure_course_archive_column(PDO $pdo): void {
    api_require_column($pdo, 'course', 'archived_at');
}

try {
    $db = new Database();
    $pdo = $db->connect();
    ensure_course_archive_column($pdo);
    $hasArchivedAt = api_column_exists($pdo, 'course', 'archived_at');

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        // Single course by id
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT c.course_id, c.course_code, c.course_name, c.year_duration, c.department_id, d.department_name, d.department_code, d.campus_id, cam.campus_code, cam.campus_name FROM course c LEFT JOIN department d ON d.department_id = c.department_id LEFT JOIN campus cam ON cam.campus_id = d.campus_id WHERE c.course_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Course not found']);
            api_out(200, ['data' => $row]);
        }

        // List courses with pagination + search (by course name or department name)
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
                $whereParts[] = 'c.archived_at IS NOT NULL';
            } elseif (!$includeArchived) {
                $whereParts[] = 'c.archived_at IS NULL';
            }
        }
        if ($search !== '') {
            $whereParts[] = '(c.course_name LIKE :q OR c.course_code LIKE :q OR d.department_name LIKE :q)';
            $params[':q'] = "%$search%";
        }
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT c.course_id, c.course_code, c.course_name, c.year_duration, c.department_id, c.archived_at AS archived_at, d.department_name, d.department_code, d.campus_id, cam.campus_code, cam.campus_name FROM course c LEFT JOIN department d ON d.department_id = c.department_id LEFT JOIN campus cam ON cam.campus_id = d.campus_id $where ORDER BY c.course_id ASC LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = 'SELECT COUNT(*) FROM course c LEFT JOIN department d ON d.department_id = c.department_id ' . ($where !== '' ? $where : '');
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
            'course_name' => 'Course name',
            'course_code' => 'Course code',
        ], 'strict');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        $name = isset($payload['course_name']) ? trim((string)$payload['course_name']) : '';
        $code = isset($payload['course_code']) ? trim((string)$payload['course_code']) : '';
        $deptId = isset($payload['department_id']) ? (int)$payload['department_id'] : null;
        if ($name === '') api_out(400, ['message' => 'course_name is required']);
        if ($code === '') api_out(400, ['message' => 'course_code is required']);

        // Programme length. Defaults to 4; Architecture and any future ladder
        // programme carry their own value so student.year_level can be capped
        // per course instead of by a literal in the UI.
        $yearDuration = 4;
        if (array_key_exists('year_duration', $payload) && $payload['year_duration'] !== null && $payload['year_duration'] !== '') {
            $yearDuration = (int)$payload['year_duration'];
            if ($yearDuration < 1 || $yearDuration > 8) {
                api_out(400, ['message' => 'year_duration must be between 1 and 8']);
            }
        }

        // prevent duplicate name under the same department
        $chkSql = 'SELECT course_id FROM course WHERE course_name = :n AND (department_id <=> :d)';
        if ($hasArchivedAt) {
            $chkSql .= ' AND archived_at IS NULL';
        }
        $chkSql .= ' LIMIT 1';
        $chk = $pdo->prepare($chkSql);
        $chk->execute([':n' => $name, ':d' => $deptId]);
        if ($chk->fetch()) api_out(409, ['message' => 'Course already exists for this department']);

        /*
         * A course code is unique within its department, not across the school.
         *
         * CITE runs on more than one campus, and each campus's CITE is its own
         * department row - so each one has its own BSIT. A single global code
         * made the second campus's BSIT impossible to create. Scoped to the
         * department here, and to uq_course_code_department in the schema.
         */
        $dupCodeSql = 'SELECT course_id FROM course WHERE course_code = :c AND (department_id <=> :d)';
        if ($hasArchivedAt) {
            $dupCodeSql .= ' AND archived_at IS NULL';
        }
        $dupCodeSql .= ' LIMIT 1';
        $dupCode = $pdo->prepare($dupCodeSql);
        $dupCode->execute([':c' => $code, ':d' => $deptId]);
        if ($dupCode->fetch()) api_out(409, ['message' => 'That course code is already used in this department']);

        $ins = $pdo->prepare('INSERT INTO course (course_name, course_code, department_id, year_duration) VALUES (:n, :c, :d, :yd)');
        $ins->execute([':n' => $name, ':c' => $code, ':d' => $deptId, ':yd' => $yearDuration]);
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare('SELECT c.course_id, c.course_code, c.course_name, c.year_duration, c.department_id, d.department_name, d.department_code, d.campus_id, cam.campus_code, cam.campus_name FROM course c LEFT JOIN department d ON d.department_id = c.department_id LEFT JOIN campus cam ON cam.campus_id = d.campus_id WHERE c.course_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(201, ['message' => 'Course created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (is_array($payload) && !$id) { $id = isset($payload['course_id']) ? (int)$payload['course_id'] : 0; }
        if ($id <= 0) api_out(400, ['message' => 'Valid course id is required']);

        $chk = $pdo->prepare('SELECT course_id, course_name, course_code, department_id FROM course WHERE course_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Course not found']);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        /*
         * The same refusal POST makes twenty lines up, which update did not make
         * at all.
         *
         * Create rejected "<script>alert(1)</script>" as a course name and
         * update accepted the identical string into the identical column, so the
         * guard on create bought nothing: anything it turned away could be PUT
         * onto the row immediately afterwards. Confirmed against the running
         * server before this line existed, not reasoned about.
         *
         * Eight other endpoints had the same asymmetry and are fixed alongside.
         */
        $unsafe = api_reject_unsafe_fields($payload, [
            'course_name' => 'Course name',
            'course_code' => 'Course code',
        ], 'strict');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $name = array_key_exists('course_name', $payload) ? trim((string)$payload['course_name']) : null;
        $code = array_key_exists('course_code', $payload) ? trim((string)$payload['course_code']) : null;
        $deptId = array_key_exists('department_id', $payload) ? (int)$payload['department_id'] : null;
        $restoreRequested = $hasArchivedAt && array_key_exists('archived', $payload) && !api_bool_like($payload['archived'], false);

        $fields = [];
        $params = [':id' => $id];

        if ($name !== null && $name === '') api_out(400, ['message' => 'course_name cannot be empty']);
        if ($code !== null && $code === '') api_out(400, ['message' => 'course_code cannot be empty']);

        $effectiveName = $name !== null ? $name : $existing['course_name'];
        $effectiveCode = $code !== null ? $code : ($existing['course_code'] ?? '');
        $effectiveDeptId = $deptId !== null ? $deptId : (int)$existing['department_id'];

        if ($restoreRequested || $effectiveName !== $existing['course_name'] || $effectiveDeptId !== (int)$existing['department_id']) {
            $dupSql = 'SELECT course_id FROM course WHERE course_name = :n AND (department_id <=> :d) AND course_id <> :id';
            if ($hasArchivedAt) {
                $dupSql .= ' AND archived_at IS NULL';
            }
            $dupSql .= ' LIMIT 1';
            $dup = $pdo->prepare($dupSql);
            $dup->execute([':n' => $effectiveName, ':d' => $effectiveDeptId, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'Course already exists for this department']);
        }

        if ($restoreRequested || $effectiveCode !== ($existing['course_code'] ?? '')) {
            // Against the department the row will belong to after the edit, so
            // moving a course into a department that already has that code is
            // still refused.
            $dupSql = 'SELECT course_id FROM course WHERE course_code = :c AND (department_id <=> :d) AND course_id <> :id';
            if ($hasArchivedAt) {
                $dupSql .= ' AND archived_at IS NULL';
            }
            $dupSql .= ' LIMIT 1';
            $dup2 = $pdo->prepare($dupSql);
            $dup2->execute([':c' => $effectiveCode, ':d' => $effectiveDeptId, ':id' => $id]);
            if ($dup2->fetch()) api_out(409, ['message' => 'That course code is already used in this department']);
        }

        if ($name !== null) {
            $fields[] = 'course_name = :n';
            $params[':n'] = $name;
        }
        if ($code !== null) {
            $fields[] = 'course_code = :c2';
            $params[':c2'] = $code;
        }
        if ($deptId !== null) { $fields[] = 'department_id = :d'; $params[':d'] = $deptId; }
        if (array_key_exists('year_duration', $payload) && $payload['year_duration'] !== null && $payload['year_duration'] !== '') {
            $yearDuration = (int)$payload['year_duration'];
            if ($yearDuration < 1 || $yearDuration > 8) {
                api_out(400, ['message' => 'year_duration must be between 1 and 8']);
            }
            // Shortening a programme would strand students above the new cap,
            // so refuse rather than silently leave invalid rows behind.
            $tooHigh = $pdo->prepare('SELECT COUNT(*) FROM student WHERE course_id = :id AND year_level > :yd');
            $tooHigh->execute([':id' => $id, ':yd' => $yearDuration]);
            $stranded = (int)$tooHigh->fetchColumn();
            if ($stranded > 0) {
                api_out(409, ['message' => "Cannot set the programme to $yearDuration year(s): $stranded student(s) are enrolled above that year level."]);
            }
            $fields[] = 'year_duration = :yd';
            $params[':yd'] = $yearDuration;
        }
        if ($hasArchivedAt && array_key_exists('archived', $payload)) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($payload['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE course SET ' . implode(', ', $fields) . ' WHERE course_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare('SELECT c.course_id, c.course_code, c.course_name, c.year_duration, c.department_id, d.department_name, d.department_code, d.campus_id, cam.campus_code, cam.campus_name FROM course c LEFT JOIN department d ON d.department_id = c.department_id LEFT JOIN campus cam ON cam.campus_id = d.campus_id WHERE c.course_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(200, ['message' => 'Course updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid course id is required']);

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE course SET archived_at = :archived_at WHERE course_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
        } else {
            $del = $pdo->prepare('DELETE FROM course WHERE course_id = :id');
            $del->execute([':id' => $id]);
        }

        api_out(200, ['message' => 'Course archived']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
