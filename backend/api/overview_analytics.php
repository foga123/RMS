<?php
/**
 * Chart data for the role overviews.
 *
 * One endpoint feeding three charts, because they share a scope and a term and
 * splitting them would mean three round trips that could disagree with each
 * other mid-refresh.
 *
 * Scope follows the same rule as student_migration.php: a dean is pinned to
 * their own department whatever the query string claims; admin and SSG read
 * every department and may narrow with ?department_id=.
 *
 * Read-only.
 */
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';

/** Roles that read every department rather than just their own. */
const OVERVIEW_ALL_DEPARTMENT_ROLES = ['admin', 'ssg'];

function overview_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        overview_out(405, ['message' => 'Method not allowed. This endpoint is read-only.']);
    }

    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        overview_out(401, ['message' => 'Not authenticated']);
    }

    foreach (['student', 'course', 'department'] as $table) {
        api_require_table($pdo, $table);
    }

    // ---- scope ------------------------------------------------------------
    $seesAllDepartments = api_session_user_has_role($authUser, OVERVIEW_ALL_DEPARTMENT_ROLES);
    $isDepartmentPinned = api_user_is_department_pinned($authUser);

    $departmentId = isset($_GET['department_id']) && $_GET['department_id'] !== ''
        ? (int)$_GET['department_id']
        : null;

    // A dean is pinned to their own department whatever the query string asks for.
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
            overview_out(400, ['message' => 'This account is not linked to a department']);
        }
        $departmentScopeIsOwn = true;
    } elseif (!$seesAllDepartments && $departmentId === null) {
        $ownDepartment = (int)($authUser['department_id'] ?? 0);
        $departmentId = $ownDepartment > 0 ? $ownDepartment : null;
        $departmentScopeIsOwn = $departmentId !== null;
    }

    /*
     * Campus, the step above department in the same chain.
     *
     * Narrowing only — it can reduce what the caller may already see, never
     * widen it. Offered only to viewers who may choose a department, because a
     * dean is pinned inside one department of one campus and the control would
     * have a single meaningful setting for them. The department clause below
     * still runs either way, so a mismatched pair returns nothing rather than
     * reaching across a boundary.
     */
    $campusId = $seesAllDepartments && isset($_GET['campus_id']) && $_GET['campus_id'] !== ''
        ? (int)$_GET['campus_id']
        : null;

    $scopeSql = 's.archived_at IS NULL';
    $scopeParams = [];
    if ($campusId !== null && $campusId > 0) {
        // Through department rather than a join: every query built from
        // $scopeSql joins course, and none of them joins department.
        $scopeSql .= ' AND c.department_id IN (SELECT department_id FROM department WHERE campus_id = :campus_id)';
        $scopeParams[':campus_id'] = $campusId;
    }
    if ($departmentId !== null && $departmentId > 0) {
        $scopeSql .= ' AND ' . api_department_filter_sql('c.department_id', $departmentScopeIsOwn);
        $scopeParams[':department_id'] = $departmentId;
    }

    /*
     * Course narrows the same scope every card is already built from, so one
     * filter reaches the students, attendance, grades and balance queries alike
     * and they cannot disagree about who is in view.
     *
     * Unlike department this is not a permission boundary — it only narrows what
     * the caller may already see, so a dean picking a course is fine while a
     * dean picking a department is not. The department clause above still runs
     * either way, so a course from another department returns nothing rather
     * than leaking it.
     */
    $courseId = isset($_GET['course_id']) && $_GET['course_id'] !== ''
        ? (int)$_GET['course_id']
        : null;

    /*
     * A course must belong to the department in scope. Without this check the
     * two clauses simply intersect to nothing and every card renders empty --
     * which reads as "this department has no data" rather than "that course is
     * not in this department". Dropping the filter and reporting it is the
     * honest answer, and it matters because a dean is pinned to a department
     * they did not choose.
     */
    $courseDropped = false;
    if ($courseId !== null && $courseId > 0) {
        $ownerStmt = $pdo->prepare('SELECT department_id FROM course WHERE course_id = :id LIMIT 1');
        $ownerStmt->execute([':id' => $courseId]);
        $courseDepartment = $ownerStmt->fetchColumn();

        $courseExists = $courseDepartment !== false;
        $inScope = $courseExists
            && ($departmentId === null || $departmentId <= 0 || (int)$courseDepartment === $departmentId);

        if ($inScope) {
            $scopeSql .= ' AND s.course_id = :course_id';
            $scopeParams[':course_id'] = $courseId;
        } else {
            $courseDropped = true;
            $courseId = null;
        }
    } else {
        $courseId = null;
    }

    /*
     * Year level narrows the same scope again.
     *
     * Attendance is grouped by term and finance by balance tier, so neither
     * shows year level at all -- this is the only way to ask "what does second
     * year owe" or "how is third year attending". The two cards that already
     * split by year collapse to a single category when it is set, which is
     * consistent rather than broken: every card keeps describing one population.
     *
     * Validated against the years actually present in scope, for the same
     * reason as course: an out-of-scope value would render four empty cards
     * and read as "no data" instead of "nobody is in that year here".
     */
    // Captured before the year clause is appended: the chooser must offer every
    // year in the department/course, not just the one already selected.
    $scopeSqlBeforeYear = $scopeSql;
    $scopeParamsBeforeYear = $scopeParams;

    $yearLevel = isset($_GET['year_level']) && $_GET['year_level'] !== ''
        ? (int)$_GET['year_level']
        : null;

    $yearDropped = false;
    if ($yearLevel !== null && $yearLevel > 0) {
        $yearProbe = $pdo->prepare("
            SELECT COUNT(*) FROM student s
              JOIN course c ON c.course_id = s.course_id
             WHERE $scopeSql AND s.year_level = :probe_year");
        $yearProbe->execute(array_merge($scopeParams, [':probe_year' => $yearLevel]));

        if ((int)$yearProbe->fetchColumn() > 0) {
            $scopeSql .= ' AND s.year_level = :year_level';
            $scopeParams[':year_level'] = $yearLevel;
        } else {
            $yearDropped = true;
            $yearLevel = null;
        }
    } else {
        $yearLevel = null;
    }

    // Resolved here rather than beside the scope echo it also feeds: the
    // attendance split below names the department in its total bar.
    $departmentName = null;
    if ($departmentId) {
        $deptStmt = $pdo->prepare('SELECT department_name FROM department WHERE department_id = :id LIMIT 1');
        $deptStmt->execute([':id' => $departmentId]);
        $departmentName = $deptStmt->fetchColumn() ?: null;
    }

    // ---- 1. students per year level (bar) ---------------------------------
    // Grouped by year level rather than by course: 30 courses would produce an
    // unreadable axis, and year level is what a dean actually acts on.
    $studentsStmt = $pdo->prepare("
        SELECT s.year_level, COUNT(*) AS student_count,
               SUM(CASE WHEN s.`star e-profile` = 'STAR' THEN 1 ELSE 0 END) AS star_count,
               SUM(CASE WHEN s.`star e-profile` = 'Non-STAR' THEN 1 ELSE 0 END) AS nonstar_count
          FROM student s
          JOIN course c ON c.course_id = s.course_id
         WHERE $scopeSql
      GROUP BY s.year_level
      ORDER BY s.year_level ASC");
    $studentsStmt->execute($scopeParams);

    $studentsByYear = [];
    $totalStudents = 0;
    foreach ($studentsStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $count = (int)$row['student_count'];
        $totalStudents += $count;
        $studentsByYear[] = [
            'year_level' => $row['year_level'] !== null ? (int)$row['year_level'] : null,
            'label' => $row['year_level'] !== null ? 'Year ' . (int)$row['year_level'] : 'Unassigned',
            'students' => $count,
            'star' => (int)$row['star_count'],
            'nonstar' => (int)$row['nonstar_count'],
        ];
    }

    // ---- 2. attendance rate per term (line) -------------------------------
    // A rate, not a raw count: cohorts differ in size between terms, so totals
    // would trend with enrolment rather than with attendance.
    $attendance = [];
    if (api_table_exists($pdo, 'attendance')) {
        $attendanceStmt = $pdo->prepare("
            SELECT a.schoolyear_id, a.semester_id,
                   sy.schoolyear_name, sem.semester_name,
                   COUNT(*) AS student_count,
                   SUM(a.total_classes_conducted) AS total_conducted,
                   SUM(a.present) AS total_present,
                   SUM(a.absent) AS total_absent
              FROM attendance a
              JOIN student s ON s.student_id = a.student_id
              JOIN course c ON c.course_id = s.course_id
              LEFT JOIN school_year sy ON sy.school_year_id = a.schoolyear_id
              LEFT JOIN semester sem ON sem.semester_id = a.semester_id
             WHERE $scopeSql
          GROUP BY a.schoolyear_id, a.semester_id, sy.schoolyear_name, sem.semester_name
          ORDER BY a.schoolyear_id ASC, a.semester_id ASC");
        $attendanceStmt->execute($scopeParams);

        foreach ($attendanceStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $conducted = (int)$row['total_conducted'];
            $present = (int)$row['total_present'];
            $attendance[] = [
                'label' => trim(($row['schoolyear_name'] ?? '') . ' ' . ($row['semester_name'] ?? '')) ?: 'Unknown term',
                'school_year_id' => $row['schoolyear_id'] !== null ? (int)$row['schoolyear_id'] : null,
                'semester_id' => $row['semester_id'] !== null ? (int)$row['semester_id'] : null,
                'students' => (int)$row['student_count'],
                'present' => $present,
                'absent' => (int)$row['total_absent'],
                'rate' => $conducted > 0 ? round($present / $conducted * 100, 1) : 0,
            ];
        }
    }

    /* ---- 2b. attendance one level down, plus that level's total ----------
     *
     * "Attendance by sem" answers how the whole scope is trending; it cannot
     * answer which part of it is dragging, because every department is folded
     * into the same bar. Split one level down, the same card answers both — one
     * bar per part, then the scope's own total at the end to compare them
     * against.
     *
     * Which level depends on where the reader already is, and that is what
     * turns clicking a bar into a drill rather than a dead end: with no
     * department chosen the parts are the departments, and inside one
     * department they are that department's courses. Inside a single course
     * there is nothing left to split, so the card falls back to the per-term
     * shape.
     */
    $attendanceByDepartment = [];
    $attendanceByCourse = [];
    $attendanceTotal = null;

    $attendanceSplit = null;
    if (api_table_exists($pdo, 'attendance')) {
        if ($departmentId === null) {
            $attendanceSplit = 'department';
        } elseif ($courseId === null) {
            $attendanceSplit = 'course';
        }
    }

    if ($attendanceSplit !== null) {
        $splitByDepartment = $attendanceSplit === 'department';

        // Both shapes select the same generic column names, so the summing
        // below is written once. Only the grouping column and its join differ.
        $splitColumns = $splitByDepartment
            ? 'd.department_id AS group_id, d.department_code AS group_code, d.department_name AS group_name'
            : 'c.course_id AS group_id, c.course_code AS group_code, c.course_name AS group_name';
        $splitJoin = $splitByDepartment
            ? 'LEFT JOIN department d ON d.department_id = c.department_id'
            : '';
        $splitGroup = $splitByDepartment
            ? 'd.department_id, d.department_code, d.department_name'
            : 'c.course_id, c.course_code, c.course_name';
        $splitOrder = $splitByDepartment
            ? 'd.department_code ASC, d.department_name ASC'
            : 'c.course_code ASC, c.course_name ASC';

        $splitStmt = $pdo->prepare("
            SELECT $splitColumns,
                   COUNT(*) AS student_count,
                   SUM(a.total_classes_conducted) AS total_conducted,
                   SUM(a.present) AS total_present,
                   SUM(a.absent) AS total_absent
              FROM attendance a
              JOIN student s ON s.student_id = a.student_id
              JOIN course c ON c.course_id = s.course_id
              $splitJoin
             WHERE $scopeSql
          GROUP BY $splitGroup
          ORDER BY $splitOrder");
        $splitStmt->execute($scopeParams);

        // The key the browser drills on: a bar carrying a department_id sets the
        // department filter, one carrying a course_id sets the course filter.
        $idKey = $splitByDepartment ? 'department_id' : 'course_id';

        $split = [];
        $sumConducted = 0;
        $sumPresent = 0;
        $sumAbsent = 0;
        $sumStudents = 0;

        foreach ($splitStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $conducted = (int)$row['total_conducted'];
            $present = (int)$row['total_present'];
            $absent = (int)$row['total_absent'];
            $students = (int)$row['student_count'];

            $sumConducted += $conducted;
            $sumPresent += $present;
            $sumAbsent += $absent;
            $sumStudents += $students;

            $split[] = [
                $idKey => $row['group_id'] !== null ? (int)$row['group_id'] : null,
                // The code where there is one: department and course names are
                // long enough to rotate an axis label, and the full name rides
                // in the tooltip.
                'label' => (string)($row['group_code'] ?: $row['group_name'] ?: 'Unassigned'),
                'name' => (string)($row['group_name'] ?: 'Unassigned'),
                'students' => $students,
                'present' => $present,
                'absent' => $absent,
                'rate' => $conducted > 0 ? round($present / $conducted * 100, 1) : 0,
            ];
        }

        // The scope's own total, summed here rather than in the browser so the
        // last bar cannot disagree with the bars it is summarising.
        if (!empty($split)) {
            $attendanceTotal = [
                'department_id' => null,
                'course_id' => null,
                'label' => 'ALL',
                'name' => $splitByDepartment
                    ? 'All departments'
                    : 'All courses in ' . ($departmentName ?: 'this department'),
                'students' => $sumStudents,
                'present' => $sumPresent,
                'absent' => $sumAbsent,
                'rate' => $sumConducted > 0 ? round($sumPresent / $sumConducted * 100, 1) : 0,
                'is_total' => true,
            ];
        }

        if ($splitByDepartment) {
            $attendanceByDepartment = $split;
        } else {
            $attendanceByCourse = $split;
        }
    }

    // ---- 3. grade outcomes per year level (stacked bar) -------------------
    // Stacked rather than grouped: these five parts sum to the subjects taken,
    // so the bar height is meaningful and the segments are shares of it.
    $grades = [];
    if (api_table_exists($pdo, 'grades')) {
        $gradesStmt = $pdo->prepare("
            SELECT s.year_level,
                   SUM(g.passed) AS passed,
                   SUM(g.failed) AS failed,
                   SUM(g.incomplete) AS incomplete,
                   SUM(g.no_credit) AS no_credit,
                   SUM(g.no_grade) AS no_grade,
                   SUM(g.total_subject) AS total_subject,
                   COUNT(DISTINCT g.student_id) AS student_count
              FROM grades g
              JOIN student s ON s.student_id = g.student_id
              JOIN course c ON c.course_id = s.course_id
             WHERE $scopeSql AND g.archived_at IS NULL
          GROUP BY s.year_level
          ORDER BY s.year_level ASC");
        $gradesStmt->execute($scopeParams);

        foreach ($gradesStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $total = (int)$row['total_subject'];
            $passed = (int)$row['passed'];
            $grades[] = [
                'year_level' => $row['year_level'] !== null ? (int)$row['year_level'] : null,
                'label' => $row['year_level'] !== null ? 'Year ' . (int)$row['year_level'] : 'Unassigned',
                'passed' => $passed,
                'failed' => (int)$row['failed'],
                'incomplete' => (int)$row['incomplete'],
                'no_credit' => (int)$row['no_credit'],
                'no_grade' => (int)$row['no_grade'],
                'total_subject' => $total,
                'students' => (int)$row['student_count'],
                'pass_rate' => $total > 0 ? round($passed / $total * 100, 1) : 0,
            ];
        }
    }

    // ---- 4. outstanding balance by tier (waterfall) -----------------------
    // Each student's LATEST finance row, not every row they have. Finance is
    // recorded per term, so summing the lot would count a student once per term
    // they have ever been billed and overstate what is actually owed today.
    //
    // Grouped by balance_range, which points at the finance rows of the status
    // table (No Balance / 3k Below / 3k Above / 10k Above). Ordered by that id
    // because the seed defines them smallest-first, which is also the order the
    // waterfall reads in.
    $finance = [];
    $financeTotal = 0.0;
    if (api_table_exists($pdo, 'finance')) {
        $financeStmt = $pdo->prepare("
            SELECT f.balance_range,
                   COALESCE(st.status_name, 'Unclassified') AS tier_name,
                   COUNT(*) AS student_count,
                   COALESCE(SUM(f.balance_to_data), 0) AS total_balance
              FROM (SELECT student_id, MAX(finance_id) AS latest_id
                      FROM finance GROUP BY student_id) latest
              JOIN finance f ON f.finance_id = latest.latest_id
              JOIN student s ON s.student_id = f.student_id
              JOIN course c ON c.course_id = s.course_id
         LEFT JOIN status st ON st.status_id = f.balance_range
             WHERE $scopeSql
          GROUP BY f.balance_range, st.status_name
          ORDER BY (f.balance_range IS NULL), f.balance_range ASC");
        $financeStmt->execute($scopeParams);

        foreach ($financeStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $amount = (float)$row['total_balance'];
            $financeTotal += $amount;
            $finance[] = [
                'tier_id' => $row['balance_range'] !== null ? (int)$row['balance_range'] : null,
                'label' => (string)$row['tier_name'],
                'students' => (int)$row['student_count'],
                'amount' => round($amount, 2),
            ];
        }
    }

    // ---- campuses and departments a chooser may pick ----------------------
    // Departments carry campus_id so the chooser can narrow itself to the
    // selected campus client-side, without a second request per campus change.
    $campuses = [];
    $departments = [];
    if ($seesAllDepartments) {
        $campuses = $pdo->query(
            'SELECT campus_id, campus_code, campus_name FROM campus ORDER BY campus_name ASC'
        )->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $departments = $pdo->query(
            'SELECT department_id, department_code, department_name, campus_id
               FROM department WHERE archived_at IS NULL ORDER BY department_name ASC'
        )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    // ---- courses a chooser may pick ---------------------------------------
    // Only courses that actually have students, and only within the department
    // in scope: offering an empty course would just be a way to blank the page,
    // and offering another department's courses would imply access that the
    // scope clause is going to deny anyway.
    $courseWhere = [];
    $courseParams = [];
    if ($campusId) {
        $courseWhere[] = 'c.department_id IN (SELECT department_id FROM department WHERE campus_id = :campus_id)';
        $courseParams[':campus_id'] = $campusId;
    }
    if ($departmentId) {
        $courseWhere[] = api_department_filter_sql('c.department_id', $departmentScopeIsOwn);
        $courseParams[':department_id'] = $departmentId;
    }
    /*
     * The campus comes back so the chooser can tell two BSITs apart.
     *
     * A department runs on more than one campus and each campus's is its own
     * row, so CITE Carmen and CITE Puerto both offer a course coded BSIT.
     * Across departments that is two options spelled identically; the list
     * that draws them appends the campus only when a code is ambiguous, and
     * needs these fields to do it.
     */
    $courseStmt = $pdo->prepare(
        'SELECT DISTINCT c.course_id, c.course_code, c.course_name,
                cam.campus_code, cam.campus_name
           FROM course c
           JOIN student s ON s.course_id = c.course_id AND s.archived_at IS NULL
           LEFT JOIN department d ON d.department_id = c.department_id
           LEFT JOIN campus cam ON cam.campus_id = d.campus_id
          WHERE ' . ($courseWhere ? implode(' AND ', $courseWhere) : '1=1') . '
       ORDER BY c.course_code ASC, cam.campus_code ASC'
    );
    $courseStmt->execute($courseParams);
    $courses = $courseStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Only years that actually hold students in the department/course in scope,
    // so the chooser can never offer a step that leads to an empty page.
    $yearStmt = $pdo->prepare("
        SELECT DISTINCT s.year_level
          FROM student s
          JOIN course c ON c.course_id = s.course_id
         WHERE $scopeSqlBeforeYear AND s.year_level IS NOT NULL
      ORDER BY s.year_level ASC");
    $yearStmt->execute($scopeParamsBeforeYear);
    $yearLevels = array_map('intval', $yearStmt->fetchAll(PDO::FETCH_COLUMN) ?: []);

    $courseName = null;
    if ($courseId) {
        foreach ($courses as $course) {
            if ((int)$course['course_id'] === $courseId) {
                $courseName = (string)($course['course_code'] ?: $course['course_name']);
                break;
            }
        }
    }

    overview_out(200, [
        'scope' => [
            'campus_id' => $campusId,
            'department_id' => $departmentId,
            'department_name' => $departmentName ?? ($departmentId ? null : 'All Departments'),
            'can_choose_department' => $seesAllDepartments,
            'sees_all_departments' => $seesAllDepartments && $departmentId === null,
            // Echoed back so the client can tell "no course chosen" from "a
            // course was chosen but is not in this department".
            'course_id' => $courseId,
            'course_name' => $courseName,
            'course_dropped' => $courseDropped,
            'year_level' => $yearLevel,
            'year_dropped' => $yearDropped,
            // Lets the client render the chain without guessing which step the
            // server has already decided for it.
            'department_locked' => $isDepartmentPinned && !$seesAllDepartments,
        ],
        'totals' => [
            'students' => $totalStudents,
            'departments' => $seesAllDepartments && $departmentId === null ? count($departments) : 1,
        ],
        'students_by_year' => $studentsByYear,
        'attendance_by_term' => $attendance,
        'attendance_by_department' => $attendanceByDepartment,
        'attendance_by_course' => $attendanceByCourse,
        'attendance_total' => $attendanceTotal,
        'grades_by_year' => $grades,
        'balance_by_tier' => $finance,
        'balance_total' => round($financeTotal, 2),
        'filters' => ['campuses' => $campuses, 'departments' => $departments, 'courses' => $courses, 'year_levels' => $yearLevels],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'overview_analytics']);
    overview_out(500, ['message' => 'Server error while loading overview analytics.']);
}
