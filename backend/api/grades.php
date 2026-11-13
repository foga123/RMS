<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/periodic_lib.php';
// The Potential Drop Out filter. The priority rules live there and are not
// restated here — see pdo_filter_student_ids().
require_once __DIR__ . '/pdo_priority_lib.php';
require_once __DIR__ . '/grade_remark_service.php';
require_once __DIR__ . '/lib/grade_counts.php';
// A closed semester's grades are read-only. See lib/term_closure.php.
require_once __DIR__ . '/lib/term_closure.php';



function ensure_grades_archive_column(PDO $pdo): void {
    api_require_column($pdo, 'grades', 'archived_at');
}

function find_remark_id_by_name(PDO $pdo, string $name): ?int {
    $sql = 'SELECT remark_id FROM remarks WHERE remark_name = :name';
    if (api_column_exists($pdo, 'remarks', 'archived_at')) {
        $sql .= ' AND archived_at IS NULL';
    }
    $sql .= ' LIMIT 1';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([':name' => $name]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;
    return isset($row['remark_id']) ? (int)$row['remark_id'] : null;
}

/**
 * The remark columns for a grades query, and the join they need.
 *
 * Three call sites selected this, and each spelled the same conditional out by
 * hand — which is how the list query and the single-row query came to return
 * different column sets. `remark_risk` is added here once, so every path that
 * returns a grade returns the risk level with it.
 *
 * The risk level comes from the `remarks` table rather than being inferred in
 * the browser from the remark's wording. It is an editable field of the remark
 * (Remarks Management sets it), so a client-side guess would disagree with the
 * database the moment somebody edits one. The legacy free-text `remarks` column
 * has no risk level to give, so that path returns NULL and the UI falls back to
 * reading the name.
 */
function grade_remark_select(bool $hasRemarksColumn, bool $hasRemarkIdColumn): array {
    if ($hasRemarksColumn) {
        return ['g.remarks AS remarks, NULL AS remark_id, NULL AS remark_risk', ''];
    }
    if ($hasRemarkIdColumn) {
        return [
            'rm.remark_name AS remarks, g.remark_id, rm.risk_level AS remark_risk',
            'LEFT JOIN remarks rm ON rm.remark_id = g.remark_id',
        ];
    }
    return ['NULL AS remarks, NULL AS remark_id, NULL AS remark_risk', ''];
}

function grade_row(PDO $pdo, int $id, bool $hasRemarksColumn, bool $hasRemarkIdColumn) {
    [$remarkSelect, $remarkJoin] = grade_remark_select($hasRemarksColumn, $hasRemarkIdColumn);

    $sel = $pdo->prepare("SELECT g.grades_id, g.student_id, st.student_number, st.first_name, st.last_name, st.`star e-profile` AS student_type,
                                 g.semester_id, sem.semester_name,
                                 g.school_year_id, sy.schoolyear_name,
                                 g.period,
                                 g.total_subject, g.passed, g.failed, g.incomplete,
                                 g.no_credit, g.no_grade,
                                 CASE WHEN g.total_subject > 0
                                      THEN ROUND(g.passed / g.total_subject * 100, 2)
                                      ELSE 0.00 END AS passed_of_subject,
                                 $remarkSelect
                           FROM grades g
                           LEFT JOIN student st ON st.student_id = g.student_id
                           LEFT JOIN semester sem ON sem.semester_id = g.semester_id
                           LEFT JOIN school_year sy ON sy.school_year_id = g.school_year_id
                           $remarkJoin
                           WHERE g.grades_id = :id LIMIT 1");
    $sel->execute([':id' => $id]);
    $row = $sel->fetch(PDO::FETCH_ASSOC);
    return $row ? grade_row_colour($row, pdo_settings($pdo)) : $row;
}

/*
 * The row's colour on the Grades screen: green when every subject is passed,
 * yellow for one subject not passed, red for two or more.
 *
 * Taken from pdo_grade_colour(), not decided here, so a row reads the same
 * colour here as the student's grade chip on the PDO board. "Not passed" is
 * failed + incomplete + no credit + no grade, as it is there, and the yellow
 * ceiling is the board's grade_yellow_max_problems setting (1).
 */
function grade_row_colour(array $row, array $settings): array
{
    $row['grade_colour'] = pdo_grade_colour($row, $settings);
    $row['problem_subjects'] = (int)($row['failed'] ?? 0) + (int)($row['incomplete'] ?? 0)
        + (int)($row['no_credit'] ?? 0) + (int)($row['no_grade'] ?? 0);
    return $row;
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $method = $_SERVER['REQUEST_METHOD'];
    $authUser = api_get_session_user();
    ensure_grades_archive_column($pdo);
    $hasRemarksColumn = api_column_exists($pdo, 'grades', 'remarks');
    $hasRemarkIdColumn = api_column_exists($pdo, 'grades', 'remark_id');
    $hasArchivedAt = api_column_exists($pdo, 'grades', 'archived_at');
    $remarksHaveArchivedAt = api_column_exists($pdo, 'remarks', 'archived_at');
    $remarkLookupSql = $remarksHaveArchivedAt
        ? 'SELECT remark_id FROM remarks WHERE remark_id = :id AND archived_at IS NULL LIMIT 1'
        : 'SELECT remark_id FROM remarks WHERE remark_id = :id LIMIT 1';

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $row = grade_row($pdo, $id, $hasRemarksColumn, $hasRemarkIdColumn);
            if (!$row) api_out(404, ['message' => 'Grade record not found']);
            if (!api_student_type_is_allowed($authUser, $row['student_type'] ?? null)) {
                api_out(403, ['message' => api_student_type_access_denied_message()]);
            }
            api_out(200, ['data' => $row]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $studentId = (isset($_GET['student_id']) && $_GET['student_id'] !== '') ? (int)$_GET['student_id'] : null;
        $semesterId = (isset($_GET['semester_id']) && $_GET['semester_id'] !== '') ? (int)$_GET['semester_id'] : null;
        $schoolYearId = (isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '') ? (int)$_GET['school_year_id'] : null;
        $courseId = (isset($_GET['course_id']) && $_GET['course_id'] !== '') ? (int)$_GET['course_id'] : null;
        /*
         * The other two steps of the Reports scope chain. Department is reached
         * through the course, since a student carries a course and the course
         * carries the department.
         *
         * A dean is pinned to their own department whatever the query string
         * claims — the same rule finance-summary.php and overview_analytics.php
         * already apply, and the reason this cannot be left to the dropdown.
         * The chooser is not rendered for a dean, but the parameter is just a
         * URL: without this line a dean could read another department's grades
         * by editing it, and the export would hand them the file.
         */
        $seesAllDepartments = api_session_user_has_role($authUser, ['admin', 'ssg']);
        $isDepartmentPinned = api_user_is_department_pinned($authUser);

        $departmentId = (isset($_GET['department_id']) && $_GET['department_id'] !== '') ? (int)$_GET['department_id'] : null;
        // Own department, or one asked for? Only the first widens across
        // campuses -- see api_department_filter_sql().
        $departmentScopeIsOwn = false;
        if ($isDepartmentPinned && !$seesAllDepartments) {
            $departmentId = (int)($authUser['department_id'] ?? 0);
            if ($departmentId <= 0) {
                api_out(400, ['message' => 'This account is not linked to a department']);
            }
            $departmentScopeIsOwn = true;
        }
        $yearLevel = (isset($_GET['year_level']) && $_GET['year_level'] !== '') ? (int)$_GET['year_level'] : null;
        /*
         * Which periodical to show: 1, 2, 3, 'term' for the semester-total rows, or
         * absent for all of them together. Whitelisted through
         * api_period_filter_sql() rather than interpolated, and an unreadable
         * value falls back to "all" instead of erroring - a stale bookmark
         * should show the page, not a 400.
         */
        $period = isset($_GET['period']) ? trim((string)$_GET['period']) : '';
        /*
         * Campus, the step above department in the Reports scope chain.
         *
         * Narrowing only, never widening: it is applied on top of whatever
         * department rule already ran, so a pinned viewer asking for another
         * campus gets nothing rather than a way across the boundary. Expressed
         * through department because this query joins course, not department.
         */
        $campusId = (isset($_GET['campus_id']) && $_GET['campus_id'] !== '') ? (int)$_GET['campus_id'] : null;
        $includeArchived = isset($_GET['include_archived']) ? api_bool_like($_GET['include_archived'], false) : false;
        $archivedOnly = isset($_GET['archived']) ? api_bool_like($_GET['archived'], false) : false;

        $whereParts = [];
        $params = [];
        if ($hasArchivedAt) {
            if ($archivedOnly) {
                $whereParts[] = 'g.archived_at IS NOT NULL';
            } elseif (!$includeArchived) {
                $whereParts[] = 'g.archived_at IS NULL';
            }
        }

        if ($search !== '') {
            $searchParts = [
                'st.student_number LIKE :q',
                'st.first_name LIKE :q',
                'st.last_name LIKE :q',
                'sem.semester_name LIKE :q',
                'sy.schoolyear_name LIKE :q',
            ];
            if ($hasRemarksColumn) {
                $searchParts[] = 'g.remarks LIKE :q';
            } elseif ($hasRemarkIdColumn) {
                $searchParts[] = 'rm.remark_name LIKE :q';
            }
            $whereParts[] = '(' . implode(' OR ', $searchParts) . ')';
            $params[':q'] = "%$search%";
        }
        if ($studentId !== null) {
            $whereParts[] = 'g.student_id = :student_id';
            $params[':student_id'] = $studentId;
        }
        if ($semesterId !== null) {
            $whereParts[] = 'g.semester_id = :semester_id';
            $params[':semester_id'] = $semesterId;
        }
        if ($schoolYearId !== null) {
            $whereParts[] = 'g.school_year_id = :school_year_id';
            $params[':school_year_id'] = $schoolYearId;
        }
        // Course lives on the student, not on the grade row: a grade is recorded
        // per term and the student's course is what it belongs to.
        if ($courseId !== null) {
            $whereParts[] = 'st.course_id = :course_id';
            $params[':course_id'] = $courseId;
        }
        if ($departmentId !== null) {
            $whereParts[] = api_department_filter_sql('cr.department_id', $departmentScopeIsOwn);
            $params[':department_id'] = $departmentId;
        }
        if ($campusId !== null) {
            $whereParts[] = 'cr.department_id IN (SELECT department_id FROM department WHERE campus_id = :campus_id)';
            $params[':campus_id'] = $campusId;
        }
        if ($yearLevel !== null) {
            $whereParts[] = 'st.year_level = :year_level';
            $params[':year_level'] = $yearLevel;
        }
        api_apply_student_type_scope($whereParts, $params, $authUser, 'st.`star e-profile`', ':student_type_scope');

        /*
         * "Show me only the students we are worried about."
         *
         * Scoped to the term already being filtered on, so the priority is read
         * from the same records the page is showing rather than from whatever
         * the student's latest term happens to say.
         *
         * Applied before $whereWithoutPeriod is taken, so the summary tiles
         * above the table count the same students the table lists. Splitting
         * them would put a filtered table under an unfiltered total.
         */
        pdo_filter_apply($whereParts, $pdo, $_GET['pdo'] ?? '', $semesterId, $schoolYearId, 'g.student_id', $period);

        $whereWithoutPeriod = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));
        $paramsWithoutPeriod = $params;

        [$periodSql, $periodParams] = api_period_filter_sql('g.period', $period);
        if ($periodSql !== '') {
            $whereParts[] = $periodSql;
            $params += $periodParams;
        }

        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        [$remarkSelect, $remarkJoin] = grade_remark_select($hasRemarksColumn, $hasRemarkIdColumn);

        // LEFT JOIN, matching the student join above: a grade whose student row
        // is missing a course must still be returned, or the report would count
        // fewer records than the table holds.
        $sql = "SELECT g.grades_id, g.student_id, g.archived_at AS archived_at, st.student_number, st.first_name, st.last_name, st.`star e-profile` AS student_type,
                       st.course_id, cr.course_code, cr.course_name,
                       g.semester_id, sem.semester_name,
                       g.school_year_id, sy.schoolyear_name,
                       g.period,
                       g.total_subject, g.passed, g.failed, g.incomplete,
                       g.no_credit, g.no_grade,
                       CASE WHEN g.total_subject > 0
                            THEN ROUND(g.passed / g.total_subject * 100, 2)
                            ELSE 0.00 END AS passed_of_subject,
                       $remarkSelect
                FROM grades g
                LEFT JOIN student st ON st.student_id = g.student_id
                LEFT JOIN course cr ON cr.course_id = st.course_id
                LEFT JOIN semester sem ON sem.semester_id = g.semester_id
                LEFT JOIN school_year sy ON sy.school_year_id = g.school_year_id
                $remarkJoin
                $where
                ORDER BY g.grades_id DESC
                LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $colourSettings = pdo_settings($pdo);
        $rows = array_map(static fn(array $row): array => grade_row_colour($row, $colourSettings), $rows);

        // Same joins as the list query: the count has to be counting the same
        // rows the list is paging through.
        $countSql = 'SELECT COUNT(*) FROM grades g
                     LEFT JOIN student st ON st.student_id = g.student_id
                     LEFT JOIN course cr ON cr.course_id = st.course_id
                     LEFT JOIN semester sem ON sem.semester_id = g.semester_id
                     LEFT JOIN school_year sy ON sy.school_year_id = g.school_year_id
                     ' . $remarkJoin . '
                     ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) { $countStmt->bindValue($k, $v); }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        /*
         * The semester rollup shown above the table.
         *
         * Deliberately NOT a sum of the rows. A student carries the same eight
         * subjects at P1, P2 and P3, so adding the periodicals together would
         * report twenty-four subjects for someone enrolled in eight. One row per
         * student is picked instead, and that is what gets totalled.
         *
         * Which row: the LATEST PERIODICAL if the student has any, and the
         * whole-term row only when they have none.
         *
         * The precedence used to run the other way, on the reasoning that a row
         * explicitly covering the whole term is the more authoritative statement
         * about the term. Testing the real migration path showed why that is
         * wrong here: this database holds 305 legacy term rows for semester 1,
         * so importing P1, P2 and P3 over them moved the summary not at all -
         * every periodical was outranked by the row it was meant to supersede.
         * A term row that coexists with periodicals is the older import, not a
         * final result someone entered on purpose.
         *
         * When a single periodical is filtered the window already reduces to one
         * row per student, so the rollup is that periodical.
         */
        $summarySql = "SELECT
                           COUNT(*) AS student_records,
                           COALESCE(SUM(total_subject), 0) AS total_subject,
                           COALESCE(SUM(passed), 0) AS passed,
                           COALESCE(SUM(failed), 0) AS failed,
                           COALESCE(SUM(incomplete), 0) AS incomplete,
                           COALESCE(SUM(no_credit), 0) AS no_credit,
                           COALESCE(SUM(no_grade), 0) AS no_grade,
                           CASE WHEN COALESCE(SUM(total_subject), 0) = 0 THEN 0
                                ELSE ROUND(SUM(passed) / SUM(total_subject) * 100, 2)
                           END AS passed_of_subject
                       FROM (
                           SELECT g.total_subject, g.passed, g.failed, g.incomplete,
                                  g.no_credit, g.no_grade,
                                  ROW_NUMBER() OVER (
                                      PARTITION BY g.student_id, g.semester_id, g.school_year_id
                                      ORDER BY (g.period IS NULL) ASC, g.period DESC, g.grades_id DESC
                                  ) AS pick
                             FROM grades g
                             LEFT JOIN student st ON st.student_id = g.student_id
                             LEFT JOIN course cr ON cr.course_id = st.course_id
                             LEFT JOIN semester sem ON sem.semester_id = g.semester_id
                             LEFT JOIN school_year sy ON sy.school_year_id = g.school_year_id
                             $remarkJoin
                             $where
                       ) latest_per_student
                       WHERE pick = 1";
        $summaryStmt = $pdo->prepare($summarySql);
        foreach ($params as $k => $v) { $summaryStmt->bindValue($k, $v); }
        $summaryStmt->execute();
        $summary = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        /*
         * Which periodicals actually hold data in the current scope, so the
         * filter can say "P2 (411)" rather than offering three identical-looking
         * options only one of which returns anything.
         *
         * Counted against the scope WITHOUT the period filter applied - a
         * breakdown built from the filtered set could only ever report the
         * bucket already selected.
         */
        $breakdownSql = 'SELECT g.period, COUNT(*) AS records
                           FROM grades g
                           LEFT JOIN student st ON st.student_id = g.student_id
                           LEFT JOIN course cr ON cr.course_id = st.course_id
                           LEFT JOIN semester sem ON sem.semester_id = g.semester_id
                           LEFT JOIN school_year sy ON sy.school_year_id = g.school_year_id
                           ' . $remarkJoin . '
                           ' . $whereWithoutPeriod . '
                          GROUP BY g.period
                          ORDER BY (g.period IS NULL), g.period';
        $breakdownStmt = $pdo->prepare($breakdownSql);
        foreach ($paramsWithoutPeriod as $k => $v) { $breakdownStmt->bindValue($k, $v); }
        $breakdownStmt->execute();
        $breakdown = [];
        foreach ($breakdownStmt->fetchAll(PDO::FETCH_ASSOC) as $bucket) {
            $breakdown[] = [
                'period' => $bucket['period'] === null ? null : (int)$bucket['period'],
                'label' => api_period_label($bucket['period']),
                'records' => (int)$bucket['records'],
            ];
        }

        api_out(200, [
            'data' => $rows,
            'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total],
            'summary' => $summary,
            'periods' => $breakdown,
        ]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $studentId = isset($p['student_id']) && $p['student_id'] !== '' ? (int)$p['student_id'] : null;
        $semesterId = isset($p['semester_id']) && $p['semester_id'] !== '' ? (int)$p['semester_id'] : null;
        $schoolYearId = isset($p['school_year_id']) && $p['school_year_id'] !== '' ? (int)$p['school_year_id'] : null;

        if (!$studentId) api_out(400, ['message' => 'student_id is required']);
        if (!$semesterId) api_out(400, ['message' => 'semester_id is required']);
        if (!$schoolYearId) api_out(400, ['message' => 'school_year_id is required']);

        $studentAccessRow = api_fetch_student_access_row($pdo, $studentId);
        if (!$studentAccessRow) api_out(400, ['message' => 'Selected student does not exist']);
        if (!api_student_type_is_allowed($authUser, $studentAccessRow['student_type'] ?? null)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }
        if (!api_fk_exists($pdo, 'SELECT semester_id FROM semester WHERE semester_id = :id LIMIT 1', $semesterId)) api_out(400, ['message' => 'Selected semester does not exist']);
        if (!api_fk_exists($pdo, 'SELECT school_year_id FROM school_year WHERE school_year_id = :id LIMIT 1', $schoolYearId)) api_out(400, ['message' => 'Selected school year does not exist']);
        $closedTerm = term_closure_block($pdo, [$schoolYearId, $semesterId]);
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        $period = api_normalize_period($p['period'] ?? null);
        if ($period === false) {
            api_out(400, ['message' => 'period must be 1, 2 or 3, or left blank for a semester-total record']);
        }

        $totalSubject = array_key_exists('total_subject', $p) && $p['total_subject'] !== '' ? (int)$p['total_subject'] : null;
        $passed = array_key_exists('passed', $p) && $p['passed'] !== '' ? (int)$p['passed'] : null;
        $failed = array_key_exists('failed', $p) && $p['failed'] !== '' ? (int)$p['failed'] : null;
        $incomplete = array_key_exists('incomplete', $p) && $p['incomplete'] !== '' ? (int)$p['incomplete'] : null;
        $noCredit = array_key_exists('no_credit', $p) && $p['no_credit'] !== '' ? (int)$p['no_credit'] : 0;
        $noGrade = array_key_exists('no_grade', $p) && $p['no_grade'] !== '' ? (int)$p['no_grade'] : 0;
        $overTotal = grade_counts_over_total_message([
            'total_subject' => $totalSubject,
            'passed' => $passed,
            'failed' => $failed,
            'incomplete' => $incomplete,
            'no_credit' => $noCredit,
            'no_grade' => $noGrade,
        ]);
        if ($overTotal !== null) api_out(400, ['message' => $overTotal]);
        // passed_of_subject is NOT stored: it is derived from passed/total_subject
        // and computed in every SELECT. A caller-supplied value is ignored on
        // purpose so the pass rate can never disagree with the counts it comes from.
        $remarksText = array_key_exists('remarks', $p) ? trim((string)$p['remarks']) : null;
        if ($remarksText === '') $remarksText = null;
        $remarkIdInput = (array_key_exists('remark_id', $p) && $p['remark_id'] !== '' && $p['remark_id'] !== null) ? (int)$p['remark_id'] : null;

        if ($hasRemarksColumn) {
            $sql = 'INSERT INTO grades (student_id, semester_id, school_year_id, period, total_subject, passed, failed, incomplete, no_credit, no_grade, remarks)
                    VALUES (:student_id, :semester_id, :school_year_id, :period, :total_subject, :passed, :failed, :incomplete, :no_credit, :no_grade, :remarks)';
            $ins = $pdo->prepare($sql);
            $ins->execute([
                ':student_id' => $studentId,
                ':semester_id' => $semesterId,
                ':school_year_id' => $schoolYearId,
                ':period' => $period,
                ':total_subject' => $totalSubject,
                ':passed' => $passed,
                ':failed' => $failed,
                ':incomplete' => $incomplete,
                ':no_credit' => $noCredit,
                ':no_grade' => $noGrade,
                ':remarks' => $remarksText,
            ]);
        } elseif ($hasRemarkIdColumn) {
            $remarkId = $remarkIdInput;
            if ($remarkId === null && $remarksText !== null) {
                $remarkId = find_remark_id_by_name($pdo, $remarksText);
                if ($remarkId === null) api_out(400, ['message' => 'Selected remark does not exist']);
            }
            /*
             * Nobody named a remark, so the policy decides one.
             *
             * Last, so a remark someone actually chose is never overwritten by a
             * rule -- the policy fills a gap, it does not overrule a person. It
             * also returns null for a school year that has already finished, which
             * is what keeps a closed year's records exactly as they were recorded.
             */
            if ($remarkId === null) {
                $remarkId = grade_remark_for_term($pdo, $schoolYearId, [
                    'total_subject' => $totalSubject,
                    'passed' => $passed,
                    'failed' => $failed,
                    'incomplete' => $incomplete,
                    'no_credit' => $noCredit,
                    'no_grade' => $noGrade,
                ]);
            }
            if ($remarkId !== null && !api_fk_exists($pdo, $remarkLookupSql, $remarkId)) {
                api_out(400, ['message' => 'Selected remark does not exist']);
            }

            $sql = 'INSERT INTO grades (student_id, semester_id, school_year_id, period, total_subject, passed, failed, incomplete, no_credit, no_grade, remark_id)
                    VALUES (:student_id, :semester_id, :school_year_id, :period, :total_subject, :passed, :failed, :incomplete, :no_credit, :no_grade, :remark_id)';
            $ins = $pdo->prepare($sql);
            $ins->execute([
                ':student_id' => $studentId,
                ':semester_id' => $semesterId,
                ':school_year_id' => $schoolYearId,
                ':period' => $period,
                ':total_subject' => $totalSubject,
                ':passed' => $passed,
                ':failed' => $failed,
                ':incomplete' => $incomplete,
                ':no_credit' => $noCredit,
                ':no_grade' => $noGrade,
                ':remark_id' => $remarkId,
            ]);
        } else {
            $sql = 'INSERT INTO grades (student_id, semester_id, school_year_id, period, total_subject, passed, failed, incomplete, no_credit, no_grade)
                    VALUES (:student_id, :semester_id, :school_year_id, :period, :total_subject, :passed, :failed, :incomplete, :no_credit, :no_grade)';
            $ins = $pdo->prepare($sql);
            $ins->execute([
                ':student_id' => $studentId,
                ':semester_id' => $semesterId,
                ':school_year_id' => $schoolYearId,
                ':period' => $period,
                ':total_subject' => $totalSubject,
                ':passed' => $passed,
                ':failed' => $failed,
                ':incomplete' => $incomplete,
                ':no_credit' => $noCredit,
                ':no_grade' => $noGrade,
            ]);
        }

        $newId = (int)$pdo->lastInsertId();
        $row = grade_row($pdo, $newId, $hasRemarksColumn, $hasRemarkIdColumn);
        api_out(201, ['message' => 'Grade record created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) { $id = isset($p['grades_id']) ? (int)$p['grades_id'] : 0; }
        if ($id <= 0) api_out(400, ['message' => 'Valid grades_id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $existing = grade_row($pdo, $id, $hasRemarksColumn, $hasRemarkIdColumn);
        if (!$existing) api_out(404, ['message' => 'Grade record not found']);
        if (!api_student_type_is_allowed($authUser, $existing['student_type'] ?? null)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }
        // Where the row is AND where it would go: moving a record out of a
        // closed semester changes that semester as surely as editing it.
        $closedTerm = term_closure_block(
            $pdo,
            [$existing['school_year_id'] ?? null, $existing['semester_id'] ?? null],
            [
                array_key_exists('school_year_id', $p) ? $p['school_year_id'] : ($existing['school_year_id'] ?? null),
                array_key_exists('semester_id', $p) ? $p['semester_id'] : ($existing['semester_id'] ?? null),
            ]
        );
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        $fields = [];
        $params = [':id' => $id];

        if (array_key_exists('student_id', $p)) {
            $val = ($p['student_id'] !== '' && $p['student_id'] !== null) ? (int)$p['student_id'] : null;
            if ($val !== null) {
                $studentAccessRow = api_fetch_student_access_row($pdo, $val);
                if (!$studentAccessRow) api_out(400, ['message' => 'Selected student does not exist']);
                if (!api_student_type_is_allowed($authUser, $studentAccessRow['student_type'] ?? null)) {
                    api_out(403, ['message' => api_student_type_access_denied_message()]);
                }
            }
            $fields[] = 'student_id = :student_id';
            $params[':student_id'] = $val;
        }
        if (array_key_exists('semester_id', $p)) {
            $val = ($p['semester_id'] !== '' && $p['semester_id'] !== null) ? (int)$p['semester_id'] : null;
            if ($val !== null && !api_fk_exists($pdo, 'SELECT semester_id FROM semester WHERE semester_id = :id LIMIT 1', $val)) api_out(400, ['message' => 'Selected semester does not exist']);
            $fields[] = 'semester_id = :semester_id';
            $params[':semester_id'] = $val;
        }
        if (array_key_exists('school_year_id', $p)) {
            $val = ($p['school_year_id'] !== '' && $p['school_year_id'] !== null) ? (int)$p['school_year_id'] : null;
            if ($val !== null && !api_fk_exists($pdo, 'SELECT school_year_id FROM school_year WHERE school_year_id = :id LIMIT 1', $val)) api_out(400, ['message' => 'Selected school year does not exist']);
            $fields[] = 'school_year_id = :school_year_id';
            $params[':school_year_id'] = $val;
        }

        if (array_key_exists('period', $p)) {
            $periodValue = api_normalize_period($p['period']);
            if ($periodValue === false) {
                api_out(400, ['message' => 'period must be 1, 2 or 3, or left blank for a semester-total record']);
            }
            $fields[] = 'period = :period';
            $params[':period'] = $periodValue;
        }

        $numericCols = ['total_subject', 'passed', 'failed', 'incomplete', 'no_credit', 'no_grade'];
        $countsAfter = [];
        foreach ($numericCols as $col) {
            if (array_key_exists($col, $p)) {
                $fields[] = "$col = :$col";
                $params[":$col"] = ($p[$col] !== '' && $p[$col] !== null) ? (int)$p[$col] : null;
                $countsAfter[$col] = $params[":$col"];
            } else {
                $countsAfter[$col] = $existing[$col] ?? null;
            }
        }
        // Checked on the row as it will be, not on the request alone: lowering
        // just the total can push the existing counts over it.
        $overTotal = grade_counts_over_total_message($countsAfter);
        if ($overTotal !== null) api_out(400, ['message' => $overTotal]);
        // passed_of_subject is derived, never written -- see the POST branch.
        if ($hasRemarksColumn && array_key_exists('remarks', $p)) {
            $fields[] = 'remarks = :remarks';
            $remarks = ($p['remarks'] !== null) ? trim((string)$p['remarks']) : null;
            $params[':remarks'] = ($remarks === '') ? null : $remarks;
        }
        if ($hasRemarkIdColumn && (array_key_exists('remark_id', $p) || array_key_exists('remarks', $p))) {
            $remarkId = null;
            if (array_key_exists('remark_id', $p)) {
                $remarkId = ($p['remark_id'] !== '' && $p['remark_id'] !== null) ? (int)$p['remark_id'] : null;
            } elseif (array_key_exists('remarks', $p)) {
                $remarksText = ($p['remarks'] !== null) ? trim((string)$p['remarks']) : null;
                if ($remarksText !== '') {
                    $remarkId = find_remark_id_by_name($pdo, $remarksText);
                    if ($remarkId === null) api_out(400, ['message' => 'Selected remark does not exist']);
                }
            }
            if ($remarkId !== null && !api_fk_exists($pdo, $remarkLookupSql, $remarkId)) {
                api_out(400, ['message' => 'Selected remark does not exist']);
            }
            $fields[] = 'remark_id = :remark_id';
            $params[':remark_id'] = $remarkId;
        }

        /*
         * The counts moved and nobody named a remark, so the policy decides again.
         *
         * A remark describes the counts it was derived from. Leaving it alone
         * while the numbers underneath it change is how a row ends up reading
         * "Regular Standing" next to two failed subjects -- wrong in the way that
         * looks right, because nothing about the row appears stale.
         *
         * Only when the request did not name one: an explicitly chosen remark is
         * handled above and is never overruled here. Note the consequence, which
         * is deliberate -- a remark set by hand on an earlier edit IS replaced
         * once the counts move, because at that point it describes numbers the
         * row no longer holds. There is no column recording that a remark was
         * chosen by a person rather than derived, and inventing one to preserve
         * a now-inaccurate value would be the wrong trade.
         *
         * grade_remark_for_term returns null for a school year that has already
         * finished, so this cannot touch a closed year's records.
         */
        if ($hasRemarkIdColumn && !array_key_exists('remark_id', $p) && !array_key_exists('remarks', $p)) {
            $countsChanged = false;
            foreach ($numericCols as $col) {
                if (array_key_exists($col, $p)) {
                    $countsChanged = true;
                    break;
                }
            }

            if ($countsChanged) {
                // The row as it will be after this update, not as it is now: a
                // request may move the counts and the school year in one call.
                $effectiveYear = array_key_exists('school_year_id', $p)
                    ? (($p['school_year_id'] !== '' && $p['school_year_id'] !== null) ? (int)$p['school_year_id'] : null)
                    : (isset($existing['school_year_id']) ? (int)$existing['school_year_id'] : null);

                $merged = [];
                foreach ($numericCols as $col) {
                    $merged[$col] = array_key_exists($col, $p)
                        ? (($p[$col] !== '' && $p[$col] !== null) ? (int)$p[$col] : null)
                        : ($existing[$col] ?? null);
                }

                $policyRemark = grade_remark_for_term($pdo, $effectiveYear, $merged);
                if ($policyRemark !== null) {
                    $fields[] = 'remark_id = :remark_id';
                    $params[':remark_id'] = $policyRemark;
                }
            }
        }

        if ($hasArchivedAt && array_key_exists('archived', $p)) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($p['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE grades SET ' . implode(', ', $fields) . ' WHERE grades_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $row = grade_row($pdo, $id, $hasRemarksColumn, $hasRemarkIdColumn);
        api_out(200, ['message' => 'Grade record updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid grades_id is required']);

        $chk = $pdo->prepare('SELECT grades_id FROM grades WHERE grades_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        if (!$chk->fetch()) api_out(404, ['message' => 'Grade record not found']);
        $existing = grade_row($pdo, $id, $hasRemarksColumn, $hasRemarkIdColumn);
        if ($existing && !api_student_type_is_allowed($authUser, $existing['student_type'] ?? null)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }
        $closedTerm = term_closure_block($pdo, [$existing['school_year_id'] ?? null, $existing['semester_id'] ?? null]);
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE grades SET archived_at = :archived_at WHERE grades_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
        } else {
            $del = $pdo->prepare('DELETE FROM grades WHERE grades_id = :id');
            $del->execute([':id' => $id]);
        }
        api_out(200, ['message' => 'Grade record archived']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
