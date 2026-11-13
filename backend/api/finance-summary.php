<?php
/**
 * Per-student finance standing for the Finance Report.
 *
 * finance.php is row CRUD over the finance table — it joins nothing, so it can
 * say a balance exists but not whose, in which course, or whether it moved.
 * This answers the question the report is for: who is carrying a balance the
 * retention model is scoring, and where are they.
 *
 * The latest row per student is picked with `ORDER BY date DESC, finance_id
 * DESC`, which is the ordering risk_model_service.php uses. Picking by
 * MAX(finance_id) instead would disagree with the engine whenever rows were
 * entered out of date order, and a report that names a different balance than
 * the score was computed from is worse than no report.
 *
 * Read-only.
 */
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';

function finance_summary_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        finance_summary_out(405, ['message' => 'Method not allowed. This endpoint is read-only.']);
    }

    $pdo = (new Database())->connect();
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        finance_summary_out(401, ['message' => 'Not authenticated']);
    }

    foreach (['student', 'course', 'finance'] as $table) {
        api_require_table($pdo, $table);
    }

    // ---- scope -------------------------------------------------------------
    // Same rule as overview_analytics.php: a dean is pinned to their own
    // department whatever the query string claims; admin and SSG see all.
    $seesAllDepartments = api_session_user_has_role($authUser, ['admin', 'ssg']);
    $isDepartmentPinned = api_user_is_department_pinned($authUser);

    $departmentId = isset($_GET['department_id']) && $_GET['department_id'] !== ''
        ? (int)$_GET['department_id']
        : null;

    /*
     * Is $departmentId this account's OWN department, or one it asked for?
     *
     * Only the first widens across campuses. A dean is appointed to the
     * department and must see all of it; an admin who picks one row out of the
     * chooser means that row, and silently widening their filter would take
     * away the only way to look at a single campus.
     */
    $departmentScopeIsOwn = false;

    if ($isDepartmentPinned && !$seesAllDepartments) {
        $departmentId = (int)($authUser['department_id'] ?? 0);
        if ($departmentId <= 0) {
            finance_summary_out(400, ['message' => 'This account is not linked to a department']);
        }
        $departmentScopeIsOwn = true;
    } elseif (!$seesAllDepartments && $departmentId === null) {
        $ownDepartment = (int)($authUser['department_id'] ?? 0);
        $departmentId = $ownDepartment > 0 ? $ownDepartment : null;
        $departmentScopeIsOwn = $departmentId !== null;
    }

    $scope = ['s.archived_at IS NULL'];
    $params = [];
    if ($departmentId !== null && $departmentId > 0) {
        $scope[] = api_department_filter_sql('c.department_id', $departmentScopeIsOwn);
        $params[':department_id'] = $departmentId;
    }

    /*
     * Campus, the step above department in the Reports scope chain.
     *
     * Narrowing only, never widening: it is applied on top of whatever
     * department rule already ran, so a pinned viewer asking for another
     * campus gets nothing rather than a way across the boundary. Expressed
     * through department because this query joins course, not department.
     */
    $campusId = isset($_GET['campus_id']) && $_GET['campus_id'] !== '' ? (int)$_GET['campus_id'] : null;
    if ($campusId !== null && $campusId > 0) {
        $scope[] = 'c.department_id IN (SELECT department_id FROM department WHERE campus_id = :campus_id)';
        $params[':campus_id'] = $campusId;
    }

    $courseId = isset($_GET['course_id']) && $_GET['course_id'] !== '' ? (int)$_GET['course_id'] : null;
    if ($courseId !== null && $courseId > 0) {
        $scope[] = 's.course_id = :course_id';
        $params[':course_id'] = $courseId;
    }

    // Last step of the Reports scope chain. Department and course were already
    // handled above; this completes it.
    $yearLevel = isset($_GET['year_level']) && $_GET['year_level'] !== '' ? (int)$_GET['year_level'] : null;
    if ($yearLevel !== null && $yearLevel > 0) {
        $scope[] = 's.year_level = :year_level';
        $params[':year_level'] = $yearLevel;
    }

    api_apply_student_type_scope($scope, $params, $authUser, 's.`star e-profile`', ':student_type_scope');
    $scopeSql = implode(' AND ', $scope);

    /*
     * LEFT JOIN, deliberately: a student with no finance row at all must come
     * back with a null balance rather than being dropped. "No record" is not
     * "owes nothing" — the first is a gap in the data and the second is a fact,
     * and a report that silently merges them tells a dean everyone is settled.
     */
    $sql = "
        SELECT
            s.student_id            AS student_record_id,
            COALESCE(NULLIF(TRIM(s.student_number), ''), CAST(s.student_id AS CHAR)) AS student_id,
            COALESCE(NULLIF(TRIM(CONCAT_WS(' ', s.first_name, s.middle_name, s.last_name)), ''), s.student_number) AS student_name,
            s.year_level,
            s.section,
            s.course_id,
            c.course_code,
            c.course_name,
            c.department_id,
            d.department_name,
            f.finance_id,
            f.balance_to_data       AS balance,
            f.balance_range         AS tier_id,
            st.status_name          AS tier_name,
            f.`date`                AS recorded_on,
            prev.balance_to_data    AS previous_balance
          FROM student s
          JOIN course c ON c.course_id = s.course_id
     LEFT JOIN department d ON d.department_id = c.department_id
     LEFT JOIN finance f ON f.finance_id = (
               SELECT f2.finance_id FROM finance f2
                WHERE f2.student_id = s.student_id
             ORDER BY f2.`date` DESC, f2.finance_id DESC LIMIT 1)
     LEFT JOIN status st ON st.status_id = f.balance_range
     LEFT JOIN finance prev ON prev.finance_id = (
               SELECT f3.finance_id FROM finance f3
                WHERE f3.student_id = s.student_id AND f3.`date` < f.`date`
             ORDER BY f3.`date` DESC, f3.finance_id DESC LIMIT 1)
         WHERE $scopeSql
      ORDER BY (f.balance_to_data IS NULL), f.balance_to_data DESC, s.last_name ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $data = [];
    $withRecord = 0;
    $totalOwed = 0.0;
    foreach ($rows as $row) {
        $hasRecord = $row['finance_id'] !== null;
        $balance = $hasRecord ? round((float)$row['balance'], 2) : null;
        $previous = $row['previous_balance'] !== null ? round((float)$row['previous_balance'], 2) : null;

        if ($hasRecord) {
            $withRecord += 1;
            $totalOwed += $balance;
        }

        $data[] = [
            'student_record_id' => (int)$row['student_record_id'],
            'student_id' => (string)$row['student_id'],
            'student_name' => (string)($row['student_name'] ?? ''),
            'year_level' => $row['year_level'] !== null ? (int)$row['year_level'] : null,
            'section' => $row['section'],
            'course_id' => $row['course_id'] !== null ? (int)$row['course_id'] : null,
            'course_code' => $row['course_code'],
            'course_name' => $row['course_name'],
            'department_name' => $row['department_name'],
            'has_record' => $hasRecord,
            'balance' => $balance,
            'tier_id' => $row['tier_id'] !== null ? (int)$row['tier_id'] : null,
            'tier_name' => $row['tier_name'],
            'recorded_on' => $row['recorded_on'],
            'previous_balance' => $previous,
            // The engine's own test: a balance that did not go down since the
            // previous snapshot. Null when there is no earlier row to compare
            // against, which is not the same as "it went down".
            'balance_unchanged' => $previous === null ? null : ($balance >= $previous),
        ];
    }

    $courseStmt = $pdo->prepare(
        'SELECT DISTINCT c.course_id, c.course_code, c.course_name
           FROM course c
           JOIN student s ON s.course_id = c.course_id AND s.archived_at IS NULL
          WHERE ' . ($departmentId ? api_department_filter_sql('c.department_id', $departmentScopeIsOwn) : '1=1') . '
       ORDER BY c.course_code ASC'
    );
    $courseStmt->execute($departmentId ? [':department_id' => $departmentId] : []);

    finance_summary_out(200, [
        'data' => $data,
        'stats' => [
            'students' => count($data),
            'with_record' => $withRecord,
            // Surfaced rather than left to be inferred: this is the count the
            // report has to caveat, because they are invisible in every total.
            'without_record' => count($data) - $withRecord,
            'total_owed' => round($totalOwed, 2),
        ],
        'filters' => ['courses' => $courseStmt->fetchAll(PDO::FETCH_ASSOC) ?: []],
        'scope' => [
            'department_id' => $departmentId,
            'course_id' => $courseId,
            'can_choose_department' => $seesAllDepartments,
        ],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'finance_summary']);
    finance_summary_out(500, ['message' => 'Server error while loading the finance report.']);
}
