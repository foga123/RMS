<?php
/**
 * One student, term by term — the record that used to exist only in pieces.
 *
 * Every module here already stores its data against a school year and a
 * semester, so the history has been in the database all along: 2,352 grade rows
 * for 2025-2026 and 1,030 for 2026-2027, and the same again for attendance and
 * finance. What there was no way to do was read one student across those terms.
 * Answering "how did this student do last semester" meant opening Grades,
 * filtering to the term, searching the number, then repeating it in Attendance
 * and again in Finance — three screens, three filters, and no way to see the
 * two semesters side by side at the end of it.
 *
 * There is a `student_term_snapshot` table meant for exactly this, and it holds
 * zero rows: no term has ever been closed, so nothing was ever written to it.
 * This does not wait for that. It reads the live tables and groups them by
 * term, and folds a snapshot in where one exists — so the history works today
 * and gets more accurate, not different, once terms start being closed.
 *
 * ── The numbers must match the modules they came from ──────────────────────
 *
 * A history that disagreed with the Grades screen would be worse than no
 * history, so each block applies that module's own rollup rather than a fourth
 * interpretation of "the term total":
 *
 *   grades      the LATEST PERIODICAL, or the whole-term row for a student who
 *               has none. Not a sum: a student carries the same eight subjects
 *               at P1, P2 and P3, so adding them reports twenty-four.
 *   attendance  the periodicals SUMMED, or the whole-term row for a student who
 *               has none. Classes do accumulate, so here the sum is right.
 *   finance     the latest row by date, a periodical breaking a tie against a
 *               whole-term row.
 *
 * The first two differ on purpose. See the rollup notes in grades.php and
 * attendance-summary.php, which are the authorities.
 *
 * ── Who sees which block ───────────────────────────────────────────────────
 *
 * Gated on `student_manage:view`, because that is the screen it serves. But
 * being allowed to open a student record is not the same as being allowed to
 * see what they owe, so each block is dropped for a caller whose permission map
 * does not cover its module. `visibility` says which were withheld, so the
 * screen can say "not shown" rather than draw an empty card that reads as "no
 * balance recorded".
 */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/periodic_lib.php';

function student_history_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/** null for a column that was never recorded, so the screen can say so. */
function student_history_int($value): ?int
{
    return $value === null ? null : (int)$value;
}

function student_history_float($value): ?float
{
    return $value === null ? null : (float)$value;
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        student_history_out(405, ['message' => 'Method not allowed']);
    }

    $studentId = isset($_GET['student_id']) ? (int)$_GET['student_id'] : 0;
    if ($studentId <= 0) {
        student_history_out(400, ['message' => 'A student_id is required.']);
    }

    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();

    /*
     * Which blocks this caller may read.
     *
     * A role with no saved permission map sees everything: the middleware has
     * already checked it against student.php's own reader list, and the
     * alternative is showing a dean an empty history because nobody has ticked
     * boxes for their role yet. Where a map exists it is honoured per module,
     * which is the whole point of the modules being separate.
     */
    $permissionMap = [];
    $usesPermissionMap = false;
    if (!empty($authUser['role_id']) || !empty($authUser['user_id'])) {
        $permissionRecord = api_fetch_effective_permissions_record(
            $pdo,
            (int)($authUser['role_id'] ?? 0),
            (int)($authUser['user_id'] ?? 0)
        );
        $usesPermissionMap = !empty($permissionRecord['has_saved_permissions']);
        $permissionMap = $usesPermissionMap ? ($permissionRecord['permissions'] ?? []) : [];
    }

    $may = static function (string $moduleKey) use ($usesPermissionMap, $permissionMap): bool {
        return $usesPermissionMap ? api_can($permissionMap, $moduleKey, 'view') : true;
    };

    $visibility = [
        'grades' => $may('grades'),
        'attendance' => $may('attendance_management'),
        'finance' => $may('finance_management'),
        'enrollment' => $may('enrollment_status'),
    ];

    $studentStmt = $pdo->prepare(
        'SELECT st.student_id, st.student_number, st.first_name, st.middle_name, st.last_name,
                st.extension_name, st.year_level, st.section, st.course_id, st.schoolyear_id,
                st.archived_at, st.`STAR E-Profile` AS student_type, st.modality,
                st.final_scholarship_grant,
                c.course_code, c.course_name, c.department_id,
                d.department_name,
                sy.schoolyear_name
           FROM student st
           LEFT JOIN course c ON c.course_id = st.course_id
           LEFT JOIN department d ON d.department_id = c.department_id
           LEFT JOIN school_year sy ON sy.school_year_id = st.schoolyear_id
          WHERE st.student_id = :student_id'
    );
    $studentStmt->execute([':student_id' => $studentId]);
    $student = $studentStmt->fetch(PDO::FETCH_ASSOC);
    if (!$student) {
        student_history_out(404, ['message' => 'Student not found.']);
    }

    /*
     * Every term this student appears in, from whichever module recorded them.
     *
     * A UNION rather than a walk over school_year: a student who has one finance
     * row and nothing else still has a term worth showing, and the seven rows in
     * school_year include four nobody has ever recorded anything against.
     *
     * Attendance spells the column `schoolyear_id` where the other two spell it
     * `school_year_id`. That is the table as it is; aliasing it here is cheaper
     * than a migration that would have to rewrite every query that touches it.
     */
    $termsStmt = $pdo->prepare(
        'SELECT sy.school_year_id, sy.schoolyear_name, sy.is_current,
                sem.semester_id, sem.semester_name
           FROM (
                SELECT DISTINCT school_year_id, semester_id FROM grades WHERE student_id = :sid_g
                UNION
                SELECT DISTINCT schoolyear_id, semester_id FROM attendance WHERE student_id = :sid_a
                UNION
                SELECT DISTINCT school_year_id, semester_id FROM finance WHERE student_id = :sid_f
                UNION
                SELECT DISTINCT school_year_id, semester_id FROM enrollment_status
                 WHERE student_id = :sid_e AND archived_at IS NULL
           ) t
           JOIN school_year sy ON sy.school_year_id = t.school_year_id
           LEFT JOIN semester sem ON sem.semester_id = t.semester_id
          ORDER BY sy.schoolyear_name DESC, t.semester_id DESC'
    );
    $termsStmt->execute([
        ':sid_g' => $studentId,
        ':sid_a' => $studentId,
        ':sid_f' => $studentId,
        ':sid_e' => $studentId,
    ]);
    $termRows = $termsStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    /*
     * The grade figures, one row per term.
     *
     * The same ROW_NUMBER precedence grades.php uses for its summary: latest
     * periodical first, whole-term row only where there is no periodical. A term
     * row sitting alongside periodicals is the older import, not a final result
     * somebody entered on purpose.
     */
    $gradesByTerm = [];
    if ($visibility['grades']) {
        $gradeStmt = $pdo->prepare(
            'SELECT school_year_id, semester_id, period, total_subject, passed, failed,
                    incomplete, no_credit, no_grade, remark_name
               FROM (
                    SELECT g.school_year_id, g.semester_id, g.period, g.total_subject, g.passed,
                           g.failed, g.incomplete, g.no_credit, g.no_grade,
                           r.remark_name,
                           ROW_NUMBER() OVER (
                               PARTITION BY g.school_year_id, g.semester_id
                               ORDER BY (g.period IS NULL) ASC, g.period DESC, g.grades_id DESC
                           ) AS pick
                      FROM grades g
                      LEFT JOIN remarks r ON r.remark_id = g.remark_id
                     WHERE g.student_id = :student_id AND g.archived_at IS NULL
               ) ranked
              WHERE pick = 1'
        );
        $gradeStmt->execute([':student_id' => $studentId]);
        foreach ($gradeStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $key = (int)$row['school_year_id'] . ':' . (int)$row['semester_id'];
            /*
             * The pass rate is COMPUTED, never read from passed_of_subject.
             *
             * 2,382 of the 3,382 grade rows carry 0.00 in that column while
             * recording passes — the importers never filled it in — so a
             * history that trusted it would report a student who passed all
             * eight subjects as 0%. The database itself draws this distinction:
             * the `grades_with_pass_rate` view exposes `pass_rate_computed`
             * beside `pass_rate_stored` for exactly this reason, and the Grades
             * summary computes rather than reads. So does this.
             */
            $totalSubject = student_history_int($row['total_subject']);
            $passed = student_history_int($row['passed']);

            $gradesByTerm[$key] = [
                'basis' => $row['period'] === null ? 'whole term' : api_period_label($row['period']),
                'total_subject' => $totalSubject,
                'passed' => $passed,
                'failed' => student_history_int($row['failed']),
                'incomplete' => student_history_int($row['incomplete']),
                'no_credit' => student_history_int($row['no_credit']),
                'no_grade' => student_history_int($row['no_grade']),
                'pass_rate' => ($totalSubject !== null && $totalSubject > 0 && $passed !== null)
                    ? round($passed / $totalSubject * 100, 2)
                    : null,
                'remark' => $row['remark_name'] ?? null,
            ];
        }
    }

    /*
     * Attendance, summed across periodicals where there are any.
     *
     * Different from grades on purpose: classes conducted accumulate through a
     * semester, so P1 + P2 + P3 is the semester. Adding the legacy whole-term
     * row on top of them would count the same semester twice — the bug
     * attendance-summary.php documents, where 20 + 20 + 20 alongside a 52 came
     * out at 112.
     */
    $attendanceByTerm = [];
    if ($visibility['attendance']) {
        $attendanceStmt = $pdo->prepare(
            'SELECT schoolyear_id, semester_id,
                    COUNT(CASE WHEN period IS NOT NULL THEN 1 END) AS periodical_records,
                    COALESCE(SUM(CASE WHEN period IS NOT NULL THEN total_classes_conducted END), 0) AS periodical_classes,
                    COALESCE(SUM(CASE WHEN period IS NOT NULL THEN present END), 0) AS periodical_present,
                    COALESCE(SUM(CASE WHEN period IS NOT NULL THEN absent END), 0) AS periodical_absent,
                    COALESCE(SUM(CASE WHEN period IS NULL THEN total_classes_conducted END), 0) AS term_classes,
                    COALESCE(SUM(CASE WHEN period IS NULL THEN present END), 0) AS term_present,
                    COALESCE(SUM(CASE WHEN period IS NULL THEN absent END), 0) AS term_absent
               FROM attendance
              WHERE student_id = :student_id
              GROUP BY schoolyear_id, semester_id'
        );
        $attendanceStmt->execute([':student_id' => $studentId]);
        foreach ($attendanceStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $usesPeriodicals = (int)$row['periodical_records'] > 0;
            $classes = (int)($usesPeriodicals ? $row['periodical_classes'] : $row['term_classes']);
            $present = (int)($usesPeriodicals ? $row['periodical_present'] : $row['term_present']);
            $absent = (int)($usesPeriodicals ? $row['periodical_absent'] : $row['term_absent']);

            $key = (int)$row['schoolyear_id'] . ':' . (int)$row['semester_id'];
            $attendanceByTerm[$key] = [
                'basis' => $usesPeriodicals ? 'P1 + P2 + P3' : 'whole term',
                'total_classes_conducted' => $classes,
                'present' => $present,
                'absent' => $absent,
                'present_rate' => $classes > 0 ? round($present / $classes * 100, 2) : null,
            ];
        }
    }

    /*
     * The balance as it stood at the end of the term.
     *
     * Latest by date, with a periodical breaking a tie against a whole-term row
     * on the same date — finance.php's precedence, for its reason: a term row
     * beside periodicals is the older import.
     */
    $financeByTerm = [];
    if ($visibility['finance']) {
        $financeStmt = $pdo->prepare(
            'SELECT school_year_id, semester_id, period, balance_to_data, balance_range, `date`
               FROM (
                    SELECT f.school_year_id, f.semester_id, f.period, f.balance_to_data,
                           f.balance_range, f.`date`,
                           ROW_NUMBER() OVER (
                               PARTITION BY f.school_year_id, f.semester_id
                               ORDER BY f.`date` DESC, (f.period IS NULL) ASC, f.period DESC, f.finance_id DESC
                           ) AS pick
                      FROM finance f
                     WHERE f.student_id = :student_id
               ) ranked
              WHERE pick = 1'
        );
        $financeStmt->execute([':student_id' => $studentId]);
        foreach ($financeStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $key = (int)$row['school_year_id'] . ':' . (int)$row['semester_id'];
            $financeByTerm[$key] = [
                'basis' => $row['period'] === null ? 'whole term' : api_period_label($row['period']),
                'balance' => student_history_float($row['balance_to_data']),
                'balance_range' => student_history_int($row['balance_range']),
                'date' => $row['date'] ?? null,
            ];
        }
    }

    /* The standing recorded for the term, latest first. */
    $enrollmentByTerm = [];
    if ($visibility['enrollment']) {
        $enrollmentStmt = $pdo->prepare(
            'SELECT school_year_id, semester_id, decision, reason, `date`
               FROM (
                    SELECT e.school_year_id, e.semester_id, e.decision, e.reason, e.`date`,
                           ROW_NUMBER() OVER (
                               PARTITION BY e.school_year_id, e.semester_id
                               ORDER BY e.`date` DESC, e.enrollment_status_id DESC
                           ) AS pick
                      FROM enrollment_status e
                     WHERE e.student_id = :student_id AND e.archived_at IS NULL
               ) ranked
              WHERE pick = 1'
        );
        $enrollmentStmt->execute([':student_id' => $studentId]);
        foreach ($enrollmentStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $key = (int)$row['school_year_id'] . ':' . (int)$row['semester_id'];
            $enrollmentByTerm[$key] = [
                'decision' => $row['decision'] ?? null,
                'reason' => $row['reason'] ?? null,
                'date' => $row['date'] ?? null,
            ];
        }
    }

    /*
     * Where the student stood at the time, if anyone recorded it.
     *
     * Empty today — no term has been closed — but read anyway rather than left
     * for later, because this is the one field the live tables cannot answer.
     * A student now in Year 4 has a Year 2 grade row from 2025-2026, and the
     * `student` table only knows about Year 4. Where a snapshot exists it is
     * the truth about that term; where it does not, the screen has to say so
     * instead of quietly labelling old rows with today's year level.
     */
    $snapshotByTerm = [];
    $snapshotStmt = $pdo->prepare(
        'SELECT s.school_year_id, s.semester_id, s.year_level, s.section, s.course_id,
                s.`STAR E-Profile` AS student_type, s.modality, s.final_scholarship_grant,
                s.recorded_at, c.course_code
           FROM student_term_snapshot s
           LEFT JOIN course c ON c.course_id = s.course_id
          WHERE s.student_id = :student_id'
    );
    $snapshotStmt->execute([':student_id' => $studentId]);
    foreach ($snapshotStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $key = (int)$row['school_year_id'] . ':' . (int)$row['semester_id'];
        $snapshotByTerm[$key] = [
            'year_level' => student_history_int($row['year_level']),
            'section' => $row['section'] ?? null,
            'course_code' => $row['course_code'] ?? null,
            'student_type' => $row['student_type'] ?? null,
            'modality' => $row['modality'] ?? null,
            'final_scholarship_grant' => $row['final_scholarship_grant'] ?? null,
            'recorded_at' => $row['recorded_at'] ?? null,
        ];
    }

    $terms = [];
    foreach ($termRows as $row) {
        $key = (int)$row['school_year_id'] . ':' . (int)$row['semester_id'];
        $terms[] = [
            'school_year_id' => (int)$row['school_year_id'],
            'school_year' => $row['schoolyear_name'] ?? null,
            'is_current_year' => (int)($row['is_current'] ?? 0) === 1,
            'semester_id' => (int)$row['semester_id'],
            'semester' => $row['semester_name'] ?? null,
            'snapshot' => $snapshotByTerm[$key] ?? null,
            'grades' => $gradesByTerm[$key] ?? null,
            'attendance' => $attendanceByTerm[$key] ?? null,
            'finance' => $financeByTerm[$key] ?? null,
            'enrollment' => $enrollmentByTerm[$key] ?? null,
        ];
    }

    $fullName = trim(preg_replace('/\s+/', ' ', implode(' ', array_filter([
        $student['first_name'] ?? '',
        $student['middle_name'] ?? '',
        $student['last_name'] ?? '',
        $student['extension_name'] ?? '',
    ], static function ($part): bool {
        return trim((string)$part) !== '';
    }))));

    student_history_out(200, [
        'student' => [
            'student_id' => (int)$student['student_id'],
            'student_number' => $student['student_number'] ?? null,
            'name' => $fullName,
            'course_code' => $student['course_code'] ?? null,
            'course_name' => $student['course_name'] ?? null,
            'department_name' => $student['department_name'] ?? null,
            // Today's values, named as such. The per-term ones live on each
            // term's snapshot, where there is one.
            'current_year_level' => student_history_int($student['year_level']),
            'current_section' => $student['section'] ?? null,
            'current_school_year' => $student['schoolyear_name'] ?? null,
            'student_type' => $student['student_type'] ?? null,
            'archived_at' => $student['archived_at'] ?? null,
        ],
        'visibility' => $visibility,
        'terms' => $terms,
    ]);
} catch (Throwable $e) {
    student_history_out(500, ['message' => 'Failed to load the student history.']);
}
