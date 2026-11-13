<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
// Refuses a date MySQL would silently store as 0000-00-00.
require_once __DIR__ . '/lib/calendar_date.php';
// A closed semester's standings are read-only. See lib/term_closure.php.
require_once __DIR__ . '/lib/term_closure.php';
require_once __DIR__ . '/lib/academic_calendar.php';



function ensure_enrollment_status_archive_column(PDO $pdo): void {
    api_require_column($pdo, 'enrollment_status', 'archived_at');
}

/**
 * Refuse a row whose student is outside the caller's STAR / Non-STAR cohort.
 *
 * The same rule student.php and the contact workspace enforce, applied to the
 * one student-keyed module that had none: the KSH TL holds enrollment_status and
 * could list and edit every Non-STAR student's standing through it. A student
 * that no longer exists passes, so the existing 404s still answer for it.
 */
function enrollment_status_assert_student_in_scope(PDO $pdo, ?array $authUser, $studentId): void {
    $studentId = (int)$studentId;
    if ($studentId <= 0 || api_student_type_scope_for_user($authUser) === null) {
        return;
    }

    $student = api_fetch_student_access_row($pdo, $studentId);
    if ($student && !api_student_type_is_allowed($authUser, $student['student_type'] ?? null)) {
        api_out(403, ['message' => api_student_type_access_denied_message()]);
    }
}

/**
 * Refuse a standing nobody may give a student any more.
 *
 * The status list was replaced on 2026-10-06 (latest.xlsx) and six statuses
 * were retired - archived, not deleted, because records still carry them. A
 * record keeps its retired status through any edit that leaves the status
 * alone; what is refused is setting one, or a status of another type (a
 * finance band, say), which the screens never offer but this endpoint used to
 * store without asking. `$currentId` is the record's present status on PUT.
 */
function enrollment_status_assert_choice(PDO $pdo, ?int $statusId, ?int $currentId = null): void {
    if ($statusId === null || $statusId === $currentId) {
        return;
    }

    $stmt = $pdo->prepare('SELECT status_name, status_type, archived_at FROM status WHERE status_id = :id LIMIT 1');
    $stmt->execute([':id' => $statusId]);
    $status = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$status || strtolower(trim((string)$status['status_type'])) !== 'enrollment') {
        api_out(400, ['message' => 'Choose one of the enrollment statuses.']);
    }
    if ($status['archived_at'] !== null) {
        api_out(409, ['message' => '"' . $status['status_name'] . '" has been retired from the enrollment statuses. Choose one of the current ones.']);
    }
}

try {
    $db = new Database();
    $pdo = $db->connect();
    ensure_enrollment_status_archive_column($pdo);
    $hasArchivedAt = api_column_exists($pdo, 'enrollment_status', 'archived_at');
    $authUser = api_get_session_user();

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        // GET by id
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT es.*, s.student_number,
                                          st.status_name AS status_name,
                                          sem.semester_name AS semester_name,
                                          sy.schoolyear_name AS schoolyear_name
                                   FROM enrollment_status es
                                   LEFT JOIN student s ON s.student_id = es.student_id
                                   LEFT JOIN status st ON st.status_id = es.status_type
                                   LEFT JOIN semester sem ON sem.semester_id = es.semester_id
                                   LEFT JOIN school_year sy ON sy.school_year_id = es.school_year_id
                                   WHERE es.enrollment_status_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Enrollment status not found']);
            enrollment_status_assert_student_in_scope($pdo, $authUser, $row['student_id'] ?? 0);
            api_out(200, ['data' => $row]);
        }

        // List with optional filter and pagination
        $status = isset($_GET['status']) ? trim((string)$_GET['status']) : '';

        /*
         * The student's standing, by status_id - Enrolled, Will Enroll, To Stop.
         *
         * Separate from `status` above, which filters on `decision`: that column
         * is the Dean's approve / pending / declined workflow and answers a
         * different question. Of the 21 live rows, 19 are "Pending" on decision
         * while their standings run across seven different values, so filtering
         * one and calling it the other returns almost nothing.
         */
        $standingId = isset($_GET['status_type']) && $_GET['status_type'] !== ''
            ? (int)$_GET['status_type']
            : null;

        // The term. Both are optional and independent: a school year with no
        // semester is a whole year, which is a question worth asking.
        $filterSchoolYearId = isset($_GET['school_year_id']) && $_GET['school_year_id'] !== ''
            ? (int)$_GET['school_year_id']
            : null;
        $filterSemesterId = isset($_GET['semester_id']) && $_GET['semester_id'] !== ''
            ? (int)$_GET['semester_id']
            : null;
        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(500, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;
        $includeArchived = isset($_GET['include_archived']) ? api_bool_like($_GET['include_archived'], false) : false;
        $archivedOnly = isset($_GET['archived']) ? api_bool_like($_GET['archived'], false) : false;

        $whereParts = [];
        $params = [];
        if ($hasArchivedAt) {
            if ($archivedOnly) {
                $whereParts[] = 'es.archived_at IS NOT NULL';
            } elseif (!$includeArchived) {
                $whereParts[] = 'es.archived_at IS NULL';
            }
        }
        if ($status === 'enrolled') {
            $whereParts[] = 'es.decision = :decision';
            $params[':decision'] = 'Approved';
        } else if ($status === 'not_enrolled') {
            $whereParts[] = '(es.decision IS NULL OR es.decision <> :decision)';
            $params[':decision'] = 'Approved';
        }
        if ($standingId !== null && $standingId > 0) {
            $whereParts[] = 'es.status_type = :standing_id';
            $params[':standing_id'] = $standingId;
        }
        if ($filterSchoolYearId !== null && $filterSchoolYearId > 0) {
            $whereParts[] = 'es.school_year_id = :filter_school_year_id';
            $params[':filter_school_year_id'] = $filterSchoolYearId;
        }
        if ($filterSemesterId !== null && $filterSemesterId > 0) {
            $whereParts[] = 'es.semester_id = :filter_semester_id';
            $params[':filter_semester_id'] = $filterSemesterId;
        }
        api_apply_student_type_scope($whereParts, $params, $authUser, 's.`star e-profile`', ':student_type_scope');
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT es.*, es.archived_at AS archived_at, s.student_number,
                       st.status_name AS status_name,
                       sem.semester_name AS semester_name,
                       sy.schoolyear_name AS schoolyear_name
                FROM enrollment_status es
                LEFT JOIN student s ON s.student_id = es.student_id
                LEFT JOIN status st ON st.status_id = es.status_type
                LEFT JOIN semester sem ON sem.semester_id = es.semester_id
                LEFT JOIN school_year sy ON sy.school_year_id = es.school_year_id
                $where
                ORDER BY es.enrollment_status_id DESC LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        // Joined for the same reason the list is: the cohort clause names the student.
        $countSql = 'SELECT COUNT(*) FROM enrollment_status es LEFT JOIN student s ON s.student_id = es.student_id ' . ($where !== '' ? $where : '');
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

        $student_id = isset($p['student_id']) && $p['student_id'] !== '' ? (int)$p['student_id'] : null;
        if (!$student_id) api_out(400, ['message' => 'student_id is required']);
        enrollment_status_assert_student_in_scope($pdo, $authUser, $student_id);

        $status_type   = isset($p['status_type'])   && $p['status_type']   !== '' ? (int)$p['status_type']   : null;
        enrollment_status_assert_choice($pdo, $status_type);

        /*
         * Injection guard. See api_reject_unsafe_text() in middleware/auth.php
         * for the two levels and why refusing on input beats escaping on output.
         * Names and codes are identifiers ('strict'); anything that is a
         * sentence is 'prose', which allows the brackets and question marks real
         * writing contains.
         */
        $unsafe = api_reject_unsafe_fields($p, [
            'decision' => 'Decision',
        ], 'strict');
        $unsafe = $unsafe ?? api_reject_unsafe_fields($p, [
            'response' => 'Response',
            'reason' => 'Reason',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        /*
         * Optional, but not arbitrary. Left blank this stays NULL, which the
         * screens render as "-"; given at all it has to be a real date, because
         * this MySQL is not in strict mode and would otherwise store
         * `0000-00-00` for a typo and report success.
         */
        $dateError = api_calendar_date_error($p['date'] ?? null, 'Date', false);
        if ($dateError !== null) api_out(400, ['message' => $dateError]);
        $date          = api_calendar_date_value($p['date'] ?? null);
        $decision      = isset($p['decision'])      ? trim((string)$p['decision'])     : 'Pending';
        $response      = isset($p['response'])      ? trim((string)$p['response'])     : null;
        $semester_id   = isset($p['semester_id'])   && $p['semester_id']   !== '' ? (int)$p['semester_id']   : null;
        $reason        = isset($p['reason'])        ? trim((string)$p['reason'])       : null;
        $school_year_id= isset($p['school_year_id'])&& $p['school_year_id']!== '' ? (int)$p['school_year_id']: null;
        $import = ($p['import'] ?? false) === true;
        if ($import) {
            $current = academic_calendar_current($pdo);
            if ($school_year_id !== $current['school_year_id']) {
                api_out(400, ['message' => 'Enrollment imports must use the current Academic Calendar school year. Refresh the import dialog.']);
            }
            if ($school_year_id <= 0 || $semester_id <= 0 || $status_type <= 0) {
                api_out(400, ['message' => 'A school year, semester and enrollment status are required for import.']);
            }
            $permissionRecord = api_fetch_effective_permissions_record($pdo, (int)($authUser['role_id'] ?? 0), (int)($authUser['user_id'] ?? 0));
            if (!api_can($permissionRecord['permissions'] ?? [], 'enrollment_status', 'edit')) {
                api_out(403, ['message' => 'You need enrollment status edit permission to import updates.']);
            }
        }
        $closedTerm = term_closure_block($pdo, [$school_year_id, $semester_id]);
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        $sql = 'INSERT INTO enrollment_status (status_type, date, student_id, decision, response, semester_id, reason, school_year_id) VALUES (:status_type, :date, :student_id, :decision, :response, :semester_id, :reason, :school_year_id)';
        if ($import) {
            // The unique student/year/semester key keeps other terms intact.
            // Keep staff decisions and student responses when updating a standing.
            $sql .= ' ON DUPLICATE KEY UPDATE enrollment_status_id = LAST_INSERT_ID(enrollment_status_id), status_type = VALUES(status_type), date = VALUES(date), reason = VALUES(reason), archived_at = NULL';
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            ':status_type' => $status_type,
            ':date' => $date,
            ':student_id' => $student_id,
            ':decision' => $decision,
            ':response' => $response,
            ':semester_id' => $semester_id,
            ':reason' => $reason,
            ':school_year_id' => $school_year_id,
        ]);
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare('SELECT es.*, s.student_number,
                                       st.status_name AS status_name,
                                       sem.semester_name AS semester_name,
                                       sy.schoolyear_name AS schoolyear_name
                                FROM enrollment_status es
                                LEFT JOIN student s ON s.student_id = es.student_id
                                LEFT JOIN status st ON st.status_id = es.status_type
                                LEFT JOIN semester sem ON sem.semester_id = es.semester_id
                                LEFT JOIN school_year sy ON sy.school_year_id = es.school_year_id
                                WHERE es.enrollment_status_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(201, ['message' => $import ? 'Enrollment status imported' : 'Enrollment status created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) { $id = isset($p['enrollment_status_id']) ? (int)$p['enrollment_status_id'] : 0; }
        if ($id <= 0) api_out(400, ['message' => 'Valid enrollment_status_id is required']);

        $chk = $pdo->prepare('SELECT * FROM enrollment_status WHERE enrollment_status_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Enrollment status not found']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);
        // Both ends of a move: the row as it is, and the student it would become.
        enrollment_status_assert_student_in_scope($pdo, $authUser, $existing['student_id'] ?? 0);
        if (array_key_exists('student_id', $p)) {
            enrollment_status_assert_student_in_scope($pdo, $authUser, $p['student_id']);
        }

        // The same refusal POST makes. Update had none, so anything create
        // turned away could be PUT onto the row a moment later. The split
        // between 'strict' and 'prose' matches create exactly: a decision is an
        // identifier, a response and a reason are sentences.
        $unsafe = api_reject_unsafe_fields($p, [
            'decision' => 'Decision',
        ], 'strict');
        $unsafe = $unsafe ?? api_reject_unsafe_fields($p, [
            'response' => 'Response',
            'reason' => 'Reason',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        // Where the standing is AND where it would go. Restoring an archived
        // row is an edit too, and a closed semester keeps it archived.
        $closedTerm = term_closure_block(
            $pdo,
            [$existing['school_year_id'] ?? null, $existing['semester_id'] ?? null],
            [
                array_key_exists('school_year_id', $p) ? $p['school_year_id'] : ($existing['school_year_id'] ?? null),
                array_key_exists('semester_id', $p) ? $p['semester_id'] : ($existing['semester_id'] ?? null),
            ]
        );
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        if (array_key_exists('status_type', $p)) {
            enrollment_status_assert_choice(
                $pdo,
                ($p['status_type'] !== '' && $p['status_type'] !== null) ? (int)$p['status_type'] : null,
                isset($existing['status_type']) ? (int)$existing['status_type'] : null
            );
        }

        $fields = [];
        $params = [':id' => $id];

        if (array_key_exists('status_type', $p)) { $fields[] = 'status_type = :status_type'; $params[':status_type'] = ($p['status_type'] !== '' && $p['status_type'] !== null) ? (int)$p['status_type'] : null; }
        if (array_key_exists('date', $p)) {
            $dateError = api_calendar_date_error($p['date'] ?? null, 'Date', false);
            if ($dateError !== null) api_out(400, ['message' => $dateError]);
            $fields[] = '`date` = :date';
            $params[':date'] = api_calendar_date_value($p['date'] ?? null);
        }
        if (array_key_exists('student_id', $p)) { $fields[] = 'student_id = :student_id'; $params[':student_id'] = ($p['student_id'] !== '' && $p['student_id'] !== null) ? (int)$p['student_id'] : null; }
        if (array_key_exists('decision', $p)) { $fields[] = 'decision = :decision'; $params[':decision'] = ($p['decision'] !== null ? trim((string)$p['decision']) : null); }
        if (array_key_exists('response', $p)) { $fields[] = 'response = :response'; $params[':response'] = ($p['response'] !== null ? trim((string)$p['response']) : null); }
        if (array_key_exists('semester_id', $p)) { $fields[] = 'semester_id = :semester_id'; $params[':semester_id'] = ($p['semester_id'] !== '' && $p['semester_id'] !== null) ? (int)$p['semester_id'] : null; }
        if (array_key_exists('reason', $p)) { $fields[] = 'reason = :reason'; $params[':reason'] = ($p['reason'] !== null ? trim((string)$p['reason']) : null); }
        if (array_key_exists('school_year_id', $p)) { $fields[] = 'school_year_id = :school_year_id'; $params[':school_year_id'] = ($p['school_year_id'] !== '' && $p['school_year_id'] !== null) ? (int)$p['school_year_id'] : null; }
        if ($hasArchivedAt && array_key_exists('archived', $p)) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($p['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE enrollment_status SET ' . implode(', ', $fields) . ' WHERE enrollment_status_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare('SELECT es.*, s.student_number,
                                       st.status_name AS status_name,
                                       sem.semester_name AS semester_name,
                                       sy.schoolyear_name AS schoolyear_name
                                FROM enrollment_status es
                                LEFT JOIN student s ON s.student_id = es.student_id
                                LEFT JOIN status st ON st.status_id = es.status_type
                                LEFT JOIN semester sem ON sem.semester_id = es.semester_id
                                LEFT JOIN school_year sy ON sy.school_year_id = es.school_year_id
                                WHERE es.enrollment_status_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(200, ['message' => 'Enrollment status updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid enrollment_status_id is required']);

        $owner = $pdo->prepare('SELECT student_id FROM enrollment_status WHERE enrollment_status_id = :id LIMIT 1');
        $owner->execute([':id' => $id]);
        enrollment_status_assert_student_in_scope($pdo, $authUser, $owner->fetchColumn() ?: 0);
        $closedTerm = term_closure_block($pdo, term_closure_row_term($pdo, 'enrollment_status', $id) ?? [null, null]);
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE enrollment_status SET archived_at = :archived_at WHERE enrollment_status_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
        } else {
            $del = $pdo->prepare('DELETE FROM enrollment_status WHERE enrollment_status_id = :id');
            $del->execute([':id' => $id]);
        }

        api_out(200, ['message' => 'Enrollment status archived']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
