<?php
/**
 * Retention matrix — where last term's enrolled students ended up.
 *
 * Rows are enrollment outcomes (Enrolled, Will Enroll, To Transfer, To Stop,
 * ...), columns are year levels. The baseline row is the cohort: students who
 * held an "Enrolled" status in the previous term. Every percentage is that
 * cohort's column total as the denominator, which is what "vs 100% retention"
 * means — 100% would be every student from last term still enrolled.
 *
 * GET                       the matrix
 *   ?school_year_id=&semester_id=   the CURRENT term (defaults to the latest)
 *   ?department_id=&course_id=      optional scoping; deans are forced to their
 *                                   own department regardless of what is sent
 *
 * GET ?action=students      the students behind one cell
 *   &status_id=             omit for the baseline row
 *   &year_level=            omit for the row total
 *
 * The drill-down is the point: a count nobody can open is a number you have to
 * take on faith.
 */

require_once __DIR__ . '/connection-pdo.php';
// The per-student drill-down reads grades, finance and attendance through the
// evaluator's own collector, so the panel and the risk score can never quote
// different numbers for the same student.
require_once __DIR__ . '/risk_model_service.php';
// The survey card reports what the student actually answered about enrolling,
// which this file already resolves for the migration board.
require_once __DIR__ . '/lib/survey_enrollment_status.php';
require_once __DIR__ . '/lib/school_year_window.php';
require_once __DIR__ . '/lib/academic_calendar.php';
// One definition of "which term do we open on", shared with
// student_migration.php so the page header and the grid inside it agree.
require_once __DIR__ . '/lib/retention_term_default.php';

/**
 * NOTE: the default term now lives in lib/retention_term_default.php, so
 * that this screen and student_migration.php -- which renders this matrix
 * inside itself -- cannot disagree about which term is current.
 *
 * What follows is the reasoning, kept here because this is where a reader
 * looking for it will come.
 *
 * The semester this screen opens on when the caller names none.
 *
 * Pinned, NOT taken from the academic calendar. The calendar still decides
 * the school YEAR, so the matrix moves forward each year on its own, but the
 * semester is fixed here because retention is a second-semester question at
 * this College: the decision the grid reports -- who continues, transfers or
 * stops -- is made on the way out of the year, not on the way into it.
 *
 * This deliberately overrides the calendar for the semester alone. An
 * explicit ?semester_id= still wins, and the semester dropdown on the board
 * still reaches every term.
 */
// (value: RETENTION_DEFAULT_SEMESTER in lib/retention_term_default.php)

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

function matrix_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * The term immediately before the given one.
 *
 * There is no explicit sequence column, and school_year_id is NOT one: the
 * ids are insertion order. lib/school_year_window.php compares the year names
 * instead, and its header explains why at length. The default-term picker
 * below was already reading names; this was the half of the file that was not.
 */
function matrix_previous_term(PDO $pdo, int $schoolYearId, int $semesterId): array
{
    return sy_window_previous_term($pdo, $schoolYearId, $semesterId);
}

try {
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        matrix_out(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();

    $isDepartmentPinned  = api_user_is_department_pinned($authUser);
    $isAdmin = api_session_user_has_role($authUser, ['admin']);
    // SSG reads every department, same as admin — matching
    // OVERVIEW_ALL_DEPARTMENT_ROLES in overview_analytics.php and
    // MIGRATION_ALL_DEPARTMENT_ROLES in student_migration.php. Previously only
    // admin was offered the chooser, so SSG saw every department with no way to
    // narrow to one.
    $seesAllDepartments = $isAdmin || api_session_user_has_role($authUser, ['ssg']);

    $departmentId = isset($_GET['department_id']) && $_GET['department_id'] !== '' ? (int)$_GET['department_id'] : null;
    /*
     * Is $departmentId this account's OWN department, or one it asked for?
     *
     * Only the first widens across campuses. A dean is appointed to the
     * department and must see all of it; an admin who picks one row out of the
     * chooser means that row, and silently widening their filter would take
     * away the only way to look at a single campus.
     */
    $departmentScopeIsOwn = false;

    if ($isDepartmentPinned) {
        // A dean sees their own department and nothing else, whatever the query
        // string claims.
        $departmentId = (int)($authUser['department_id'] ?? 0);
        if ($departmentId <= 0) {
            matrix_out(400, ['message' => 'This account is not linked to a department']);
        }
        $departmentScopeIsOwn = true;
    }
    $courseId = isset($_GET['course_id']) && $_GET['course_id'] !== '' ? (int)$_GET['course_id'] : null;

    /*
     * Campus sits above department in the same chain.
     *
     * It is a narrowing filter, not a permission boundary: it can only reduce
     * what the caller may already see. A dean stays pinned to their department
     * whatever campus is asked for — the department clause below still runs, so
     * naming another campus returns nothing rather than reaching into it.
     *
     * Ignored outright for anyone without the department chooser, because a
     * campus control for a viewer pinned to one department inside one campus
     * would be a filter with a single meaningful setting.
     */
    $campusId = $seesAllDepartments && isset($_GET['campus_id']) && $_GET['campus_id'] !== ''
        ? (int)$_GET['campus_id']
        : null;

    /*
     * Current term.
     *
     * The default used to be MAX(school_year_id) and MAX(semester_id), which is
     * the newest term the school_year table has heard of — not the newest one
     * anybody has recorded a decision in. This database carries school years out
     * to 2028-2029 while every enrollment_status row sits in 2025-2026, so the
     * page opened on a term three years in the future and, thanks to the
     * fallbacks below, filled it with data borrowed from the past.
     *
     * Defaulting to the newest term that actually holds rows means the page
     * opens on the term it can say something true about. An explicitly chosen
     * term is honoured exactly as asked, empty or not.
     */
    $latestRecordedTerm = $pdo->query(
        'SELECT es.school_year_id, es.semester_id
           FROM enrollment_status es
           JOIN school_year sy ON sy.school_year_id = es.school_year_id
          WHERE es.archived_at IS NULL
            AND es.school_year_id IS NOT NULL
            AND es.semester_id IS NOT NULL
       ORDER BY sy.schoolyear_name DESC, es.semester_id DESC
          LIMIT 1'
    )->fetch(PDO::FETCH_ASSOC) ?: null;

    /*
     * The academic calendar decides the school YEAR this opens on.
     *
     * It used to decide the semester too. It no longer does: the semester is
     * pinned to RETENTION_MATRIX_DEFAULT_SEMESTER above, because retention is
     * a second-semester question here regardless of which half of the year
     * the College happens to be in. The year still follows the calendar, so
     * nothing has to be re-pinned when the school year rolls over.
     *
     * The calendar is what the College means by "now": it drives every import,
     * and the Faculty Workspace and the PDO board already read it. This screen
     * did not, so with the calendar on 1st Sem 2026-2027 the matrix opened on
     * 2nd Sem 2025-2026 and two panels of the same dashboard disagreed about
     * the current term.
     *
     * THE PERIODICAL IS NOT PART OF THIS. P1, P2 and P3 are all inside one
     * semester, and a retention outcome is a decision about the NEXT semester
     * rather than a mark inside this one -- so the matrix has no periodical to
     * follow and the calendar sitting in any of the three means the same term.
     *
     * This used to prefer the calendar only when its term already held
     * enrollment rows, on the reasoning that the College is normally in a term
     * nobody has recorded decisions for yet, so the grid would open empty and
     * read as broken. That was the wrong trade, for the same reason the
     * attendance column no longer says "Attending" when nothing is recorded:
     * it answered a question about THIS term with last term's data under this
     * term's name. An empty grid is the honest answer, and the screen already
     * says so in words -- `has_records` below drives "No enrollment records
     * have been entered for <term> yet" in place of the tables.
     *
     * The fallback survives for the one case that still needs it: a calendar
     * that names no term at all.
     */
    // The calendar's year, the pinned semester. $latestRecordedTerm is
    // offered for the year only, and only if the calendar names none.
    $defaultTerm = retention_default_term($pdo, $latestRecordedTerm);

    /*
     * A caller who names a term is obeyed exactly -- that is what the
     * dropdown sends, and honouring it is what keeps every other term
     * reachable. Only the unasked-for default is pinned.
     */
    $schoolYearId = isset($_GET['school_year_id']) && $_GET['school_year_id'] !== ''
        ? (int)$_GET['school_year_id']
        : (int)$defaultTerm['school_year_id'];
    $semesterId = isset($_GET['semester_id']) && $_GET['semester_id'] !== ''
        ? (int)$_GET['semester_id']
        : (int)$defaultTerm['semester_id'];

    /*
     * The periodical the drill-down reads, when the caller names one.
     *
     * The matrix itself has no periodical: an enrollment outcome is a decision
     * about next term, not a mark inside this one, so the rows and percentages
     * are unchanged by this. It is the per-student panel that needs it - that
     * panel quotes the same numbers the risk score was computed from, so if the
     * screen is showing P1 the panel has to read P1 or the two disagree.
     *
     * An unparseable period is ignored rather than refused, matching the rest of
     * the read endpoints: a bad filter shows the wider view, it does not fail.
     */
    $period = api_normalize_period($_GET['period'] ?? null);
    if ($period === false) {
        $period = null;
    }

    /*
     * Whether anybody has recorded an enrollment decision for the term on
     * screen. Everything below hangs off this: a term with no rows has no
     * matrix, and must not borrow one.
     */
    $termProbe = $pdo->prepare(
        'SELECT COUNT(*) FROM enrollment_status
          WHERE archived_at IS NULL AND school_year_id = :sy AND semester_id = :sem'
    );
    $termProbe->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);
    $termHasRecords = (int)$termProbe->fetchColumn() > 0;

    $previous = matrix_previous_term($pdo, $schoolYearId, $semesterId);

    // ---- shared scoping ----------------------------------------------------
    $scope = [];
    $scopeParams = [];
    if ($campusId !== null && $campusId > 0) {
        // Through department rather than a join, because every query built from
        // $scopeSql already joins course and none of them joins department.
        $scope[] = 'c.department_id IN (SELECT department_id FROM department WHERE campus_id = :campus_id)';
        $scopeParams[':campus_id'] = $campusId;
    }
    if ($departmentId !== null && $departmentId > 0) {
        $scope[] = api_department_filter_sql('c.department_id', $departmentScopeIsOwn);
        $scopeParams[':department_id'] = $departmentId;
    }
    if ($courseId !== null && $courseId > 0) {
        $scope[] = 's.course_id = :course_id';
        $scopeParams[':course_id'] = $courseId;
    }
    /*
     * STAR / Non-STAR. The student_detail guard below relied on this being here
     * and it was not: every follow-up role saw both cohorts in the grid. The SSP
     * Coordinator and KSH TL reach this through Student Migration.
     */
    api_apply_student_type_scope($scope, $scopeParams, $authUser, 's.`star e-profile`', ':student_type_scope');
    $scopeSql = $scope ? (' AND ' . implode(' AND ', $scope)) : '';

    $enrolledStatusId = (int)$pdo->query(
        "SELECT status_id FROM status WHERE status_type = 'enrollment' AND status_name = 'Enrolled' LIMIT 1"
    )->fetchColumn();

    /*
     * The cohort: students holding an "Enrolled" status in the PREVIOUS term.
     * When there is no previous term (first term on record) the cohort falls
     * back to every non-archived student in scope, so the matrix still renders
     * something meaningful rather than an empty grid.
     */
    if ($previous['semester_id'] !== null) {
        $cohortSql = "
            SELECT DISTINCT s.student_id, s.year_level
              FROM student s
              JOIN course c ON c.course_id = s.course_id
              JOIN enrollment_status es ON es.student_id = s.student_id
             WHERE s.archived_at IS NULL
               AND es.archived_at IS NULL
               AND es.school_year_id = :prev_sy
               AND es.semester_id    = :prev_sem
               AND es.status_type    = :enrolled_status
               $scopeSql";
        $cohortParams = array_merge($scopeParams, [
            ':prev_sy'         => $previous['school_year_id'],
            ':prev_sem'        => $previous['semester_id'],
            ':enrolled_status' => $enrolledStatusId,
        ]);
    } else {
        $cohortSql = "
            SELECT DISTINCT s.student_id, s.year_level
              FROM student s
              JOIN course c ON c.course_id = s.course_id
             WHERE s.archived_at IS NULL
               $scopeSql";
        $cohortParams = $scopeParams;
    }

    /*
     * A student's standing for this matrix: the row recorded for the term being
     * viewed, or their most recent row when that term has none.
     *
     * Strict term equality is why decisions taken on the Student Migration
     * board never appeared here. That board resolves a standing with
     * MAX(enrollment_status_id) — its own comment says school_year_id "is not
     * reliably set", and it is right: the single Enrolled row in this database
     * has school_year_id NULL, and NULL matches nothing, so the two screens
     * disagreed about the same student. Preferring the term row and falling
     * back to the latest makes them agree without inventing data.
     */
    $effectiveStatusSql = "
        SELECT e.student_id, e.status_type
          FROM enrollment_status e
          JOIN (SELECT student_id,
                       MAX(CASE WHEN school_year_id = :sy_pref AND semester_id = :sem_pref
                                THEN enrollment_status_id END) AS term_row,
                       MAX(enrollment_status_id) AS latest_row
                  FROM enrollment_status
                 WHERE archived_at IS NULL
              GROUP BY student_id) pick
            ON pick.student_id = e.student_id
           AND e.enrollment_status_id = COALESCE(pick.term_row, pick.latest_row)
         WHERE e.archived_at IS NULL";
    $effectiveParams = [':sy_pref' => $schoolYearId, ':sem_pref' => $semesterId];

    /*
     * The cohort is "held an Enrolled status last term", which needs somebody
     * to have recorded exactly that. Where enrollment_status is barely
     * populated it comes back empty, and an empty cohort draws a grid of zeros
     * that reads as a broken page rather than as missing data — while the
     * decisions that HAVE been collected sit right there unshown.
     *
     * So the same fallback the no-previous-term case already uses now also
     * covers an empty cohort: every student in scope becomes the baseline. The
     * payload says which happened, because a matrix measured against a
     * different denominator must not look identical to one that is not.
     */
    $cohortIsFallback = $previous['semester_id'] === null;
    $fallbackReason = $cohortIsFallback ? 'no_previous_term' : null;

    if (!$termHasRecords) {
        /*
         * Nothing was recorded for the term being viewed, so the matrix is
         * empty — and stays empty.
         *
         * Both fallbacks below exist to keep a sparsely populated term from
         * rendering as a broken page, and both were doing real harm here:
         * picking a school year nobody has entered decisions for yet still drew
         * a full grid, because the cohort fell back to every student and each
         * student's status fell back to whatever they were last recorded as.
         * The result looked like next year's data. It was last year's, relabelled.
         *
         * A term with no records is not a rendering problem to paper over; it is
         * the honest answer to the question that was asked, and the payload says
         * so plainly enough for the screen to explain itself.
         */
        $cohortIsFallback = false;
        $fallbackReason = null;
        $cohortSql = "SELECT s.student_id, s.year_level FROM student s WHERE 1 = 0";
        $cohortParams = [];
    } elseif (!$cohortIsFallback) {
        $probe = $pdo->prepare("SELECT COUNT(*) FROM ($cohortSql) cohort");
        $probe->execute($cohortParams);
        if ((int)$probe->fetchColumn() === 0) {
            $cohortIsFallback = true;
            $fallbackReason = 'no_enrolled_rows';
            $cohortSql = "
                SELECT DISTINCT s.student_id, s.year_level
                  FROM student s
                  JOIN course c ON c.course_id = s.course_id
                 WHERE s.archived_at IS NULL
                   $scopeSql";
            $cohortParams = $scopeParams;
        }
    }

    // ---- drill-down --------------------------------------------------------
    /*
     * One student's academic, financial and attendance standing.
     *
     * The second click of the drill-down: a cell names a group, the student list
     * names the people, and this says why any one of them is there.
     *
     * Signals come from risk_collect_signals() rather than from fresh queries.
     * That function is what the evaluator scores, so this panel cannot show
     * "3 failed" beside a risk level computed from a different reading of the
     * same term.
     *
     * SCOPE IS ENFORCED, not assumed. The student must be inside $cohortSql,
     * which already carries dean department pinning and Star/Nonstar scoping.
     * Without that check the endpoint would return any student id handed to it in
     * the query string, which is exactly the boundary the rest of this file exists
     * to hold.
     */
    if (($_GET['action'] ?? '') === 'student_detail') {
        $studentId = isset($_GET['student_id']) ? (int)$_GET['student_id'] : 0;
        if ($studentId <= 0) {
            matrix_out(400, ['message' => 'student_id is required.']);
        }

        $guard = $pdo->prepare(
            "SELECT s.student_id, s.student_number, s.first_name, s.last_name,
                    s.year_level, s.section, s.`star e-profile` AS student_type, s.mobile_number, s.email_address,
                    c.course_code, c.course_name, d.department_name
               FROM student s
               JOIN course c ON c.course_id = s.course_id
          LEFT JOIN department d ON d.department_id = c.department_id
              WHERE s.student_id = :student_id
                AND s.student_id IN (SELECT student_id FROM ($cohortSql) cohort)
              LIMIT 1"
        );
        $guard->execute(array_merge($cohortParams, [':student_id' => $studentId]));
        $student = $guard->fetch(PDO::FETCH_ASSOC);
        if (!$student) {
            // Deliberately the same answer as a genuinely missing student, so the
            // response cannot be used to probe which ids exist outside the scope.
            matrix_out(404, ['message' => 'Student not found.']);
        }

        $signals = risk_collect_signals(
            $pdo,
            $studentId,
            $semesterId ?? null,
            $schoolYearId ?? null,
            null,
            null,
            $period
        );

        $caseStmt = $pdo->prepare(
            'SELECT combined_risk_level, evaluation_score, evaluation_reason, evaluated_at
               FROM retention_case WHERE student_id = :student_id
                AND (:year_null IS NULL OR school_year_id = :year_value)
                AND (:semester_null IS NULL OR semester_id = :semester_value)
                AND (period <=> :case_period)
           ORDER BY evaluated_at DESC, case_id DESC LIMIT 1'
        );
        $caseStmt->execute([':student_id' => $studentId, ':year_null' => $schoolYearId, ':year_value' => $schoolYearId, ':semester_null' => $semesterId, ':semester_value' => $semesterId, ':case_period' => $period]);
        $case = $caseStmt->fetch(PDO::FETCH_ASSOC) ?: null;

        $failed = $signals['grades.failed'] ?? null;

        // Latest submission for this student, so the survey card can report the
        // enrolment intent they actually chose.
        $subStmt = $pdo->prepare(
            'SELECT ss.submission_id, ss.survey_id, ss.submitted_at
               FROM survey_submission ss
              WHERE ss.student_id = :student_id AND ss.archived_at IS NULL
           ORDER BY ss.submitted_at DESC, ss.submission_id DESC LIMIT 1'
        );
        $subStmt->execute([':student_id' => $studentId]);
        $submission = $subStmt->fetch(PDO::FETCH_ASSOC) ?: null;

        $surveyCard = [
            'submitted'     => (bool)$submission,
            'submitted_at'  => $submission['submitted_at'] ?? null,
            'answer_status' => null,
            'answer_text'   => null,
            'remark'        => null,
        ];

        if ($submission) {
            $mapped = resolve_submission_enrollment_status(
                $pdo,
                (int)$submission['submission_id'],
                (int)$submission['survey_id']
            );

            if ($mapped) {
                $surveyCard['answer_text'] = $mapped['option_text'] ?? null;

                $nameStmt = $pdo->prepare('SELECT status_name FROM status WHERE status_id = :id LIMIT 1');
                $nameStmt->execute([':id' => (int)$mapped['enrollment_status_id']]);
                $surveyCard['answer_status'] = $nameStmt->fetchColumn() ?: null;

                $surveyCard['remark'] = resolve_submission_remark(
                    $pdo,
                    (int)$submission['submission_id'],
                    (int)$mapped['question_id']
                );
            }
        }


        matrix_out(200, ['data' => [
            'student' => [
                'student_id'      => (int)$student['student_id'],
                'student_number'  => $student['student_number'] ?? '',
                'full_name'       => trim(((string)$student['first_name']) . ' ' . ((string)$student['last_name'])),
                'year_level'      => $student['year_level'] !== null ? (int)$student['year_level'] : null,
                'section'         => $student['section'] ?? null,
                'student_type'    => $student['student_type'] ?? null,
                'course_code'     => $student['course_code'] ?? null,
                'course_name'     => $student['course_name'] ?? null,
                'department_name' => $student['department_name'] ?? null,
                'mobile_number'   => $student['mobile_number'] ?? null,
                'email_address'   => $student['email_address'] ?? null,
            ],
            'grades' => [
                'has_record'    => !empty($signals['grades.record']),
                'total_subject' => $signals['grades.total_subject'] ?? null,
                'passed'        => $signals['grades.passed'] ?? null,
                'failed'        => $failed,
                'incomplete'    => $signals['grades.incomplete'] ?? null,
                'no_credit'     => $signals['grades.no_credit'] ?? null,
                'no_grade'      => $signals['grades.no_grade'] ?? null,
                'pass_rate'     => $signals['grades.pass_rate'] ?? null,
                'remark_risk'   => $signals['grades.remark_risk'] ?? null,
                // The plain-language answer to "all passed, or failed?".
                'verdict'       => !empty($signals['grades.record'])
                    ? (((int)($failed ?? 0)) > 0 ? 'Has failed subjects' : 'All subjects passed')
                    : 'No grade record for this term',
            ],
            'finance' => [
                'has_record'        => !empty($signals['finance.record']),
                'balance_amount'    => $signals['finance.balance_amount'] ?? null,
                'balance_tier'      => $signals['finance.balance_tier'] ?? null,
                'balance_unchanged' => !empty($signals['finance.balance_unchanged']),
                'verdict'           => !empty($signals['finance.record'])
                    ? ((((float)($signals['finance.balance_amount'] ?? 0)) > 0)
                        ? 'Has an outstanding balance'
                        : 'No outstanding balance')
                    : 'No finance record for this term',
            ],
            'attendance' => [
                'has_record'  => !empty($signals['attendance.record']),
                'conducted'   => $signals['attendance.total_classes_conducted'] ?? null,
                'present'     => $signals['attendance.present'] ?? null,
                'absent'      => $signals['attendance.absent'] ?? null,
                'absent_rate' => $signals['attendance.absent_rate'] ?? null,
                'verdict'     => !empty($signals['attendance.record'])
                    ? ((((float)($signals['attendance.absent_rate'] ?? 0)) >= 30)
                        ? 'Frequently absent'
                        : 'Attendance within range')
                    : 'No attendance record for this term',
            ],
            /*
             * What the student SAID, not merely whether they replied.
             *
             * "Submitted" on its own is close to useless here: the point of the
             * survey is the answer, and the answer is what decides whether anyone
             * needs to ring them. survey_question_option.enrollment_status_id
             * already carries that mapping - it is what sets the standing on the
             * migration board - so this reads the same mapping rather than
             * inventing a second interpretation of the same answer.
             *
             * `remark` is the student's own words explaining the choice, which is
             * the sentence a caller most wants before dialling.
             */
            'survey' => $surveyCard,
            'risk' => $case ? [
                'level'        => $case['combined_risk_level'],
                'score'        => (float)$case['evaluation_score'],
                'reason'       => $case['evaluation_reason'],
                'evaluated_at' => $case['evaluated_at'],
            ] : null,
            // Which slice the three cards above were read for, so the panel can
            // say "P1" rather than leaving the reader to assume "the term".
            'period'       => $period,
            'period_label' => api_period_label($period),
        ]]);
    }

    if (($_GET['action'] ?? '') === 'students') {
        $statusId  = isset($_GET['status_id']) && $_GET['status_id'] !== '' ? (int)$_GET['status_id'] : null;
        $yearLevel = isset($_GET['year_level']) && $_GET['year_level'] !== '' ? (int)$_GET['year_level'] : null;
        $upperOnly = isset($_GET['upper_years']) && $_GET['upper_years'] === '1';

        $where = [];
        $params = $cohortParams;

        if ($statusId !== null) {
            // The same resolution the grid uses, so a cell and the list behind
            // it can never name different students.
            $where[] = "EXISTS (
                SELECT 1 FROM ($effectiveStatusSql) eff
                 WHERE eff.student_id = s.student_id
                   AND eff.status_type = :cur_status)";
            $params = array_merge($params, $effectiveParams);
            $params[':cur_status'] = $statusId;
        }
        if ($yearLevel !== null) {
            $where[] = 's.year_level = :year_level';
            $params[':year_level'] = $yearLevel;
        } elseif ($upperOnly) {
            $where[] = 's.year_level > 1';
        }

        $extra = $where ? (' AND ' . implode(' AND ', $where)) : '';
        $sql = "
            SELECT DISTINCT
                   s.student_id, s.student_number, s.first_name, s.last_name,
                   s.year_level, s.section, s.email_address, s.mobile_number,
                   c.course_code, c.course_name
              FROM student s
              JOIN course c ON c.course_id = s.course_id
             WHERE s.student_id IN (SELECT student_id FROM ($cohortSql) cohort)
               $extra
          ORDER BY s.year_level, s.last_name, s.first_name
             LIMIT 500";

        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        matrix_out(200, ['data' => [
            'students' => array_map(static function (array $r): array {
                return [
                    'student_id'     => (int)$r['student_id'],
                    'student_number' => $r['student_number'] ?? '',
                    'full_name'      => trim(((string)($r['first_name'] ?? '')) . ' ' . ((string)($r['last_name'] ?? ''))),
                    'year_level'     => $r['year_level'] !== null ? (int)$r['year_level'] : null,
                    'section'        => $r['section'] ?? null,
                    'course_code'    => $r['course_code'] ?? null,
                    'course_name'    => $r['course_name'] ?? null,
                    'email_address'  => $r['email_address'] ?? null,
                    'mobile_number'  => $r['mobile_number'] ?? null,
                ];
            }, $rows),
            'truncated' => count($rows) >= 500,
        ]]);
    }

    // ---- matrix ------------------------------------------------------------
    /*
     * Columns run to the longest programme IN SCOPE, not the longest the
     * institution offers. BS Architecture is the only five-year course here, so
     * a catalogue-wide MAX() printed a Year V column on every department's
     * matrix — always empty, and an empty column reads as missing data rather
     * than as a programme that department does not run.
     *
     * Measured over the course catalogue rather than over enrolled students: a
     * five-year programme with nobody in fifth year yet still has a fifth year,
     * and a column that appears the day someone reaches it would move the grid
     * under the reader.
     */
    $maxYearScope = [];
    $maxYearParams = [];
    if ($campusId !== null && $campusId > 0) {
        $maxYearScope[] = 'c.department_id IN (SELECT department_id FROM department WHERE campus_id = :max_campus_id)';
        $maxYearParams[':max_campus_id'] = $campusId;
    }
    if ($departmentId !== null && $departmentId > 0) {
        $maxYearScope[] = 'c.department_id = :max_department_id';
        $maxYearParams[':max_department_id'] = $departmentId;
    }
    if ($courseId !== null && $courseId > 0) {
        $maxYearScope[] = 'c.course_id = :max_course_id';
        $maxYearParams[':max_course_id'] = $courseId;
    }
    $maxYearStmt = $pdo->prepare(
        'SELECT COALESCE(MAX(c.year_duration), 4)
           FROM course c
          WHERE c.archived_at IS NULL'
        . ($maxYearScope ? ' AND ' . implode(' AND ', $maxYearScope) : '')
    );
    $maxYearStmt->execute($maxYearParams);
    $maxYear = (int)$maxYearStmt->fetchColumn();
    $yearLevels = range(1, max(1, $maxYear));

    /*
     * Retired statuses are read too, and kept below only if they hold records
     * in this cohort. The list was replaced on 2026-10-06 (latest.xlsx) and the
     * old statuses were archived, not deleted, so records filed under them keep
     * their names. Leaving them out would drop those students from every row
     * and silently inflate the variance - the grid would read as if nobody had
     * recorded them at all.
     */
    $statuses = $pdo->query(
        "SELECT status_id, status_name, sort_order, archived_at
           FROM status
          WHERE status_type = 'enrollment'
            AND status_name <> 'Not Enrolled'
       ORDER BY archived_at IS NOT NULL, sort_order, status_id"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Baseline: cohort size per year level.
    $baselineStmt = $pdo->prepare("
        SELECT cohort.year_level, COUNT(*) AS n
          FROM ($cohortSql) cohort
      GROUP BY cohort.year_level");
    $baselineStmt->execute($cohortParams);
    $baseline = [];
    foreach ($baselineStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $baseline[(int)$row['year_level']] = (int)$row['n'];
    }

    // Current-term status of every cohort member, by year level.
    $cellStmt = $pdo->prepare("
        SELECT eff.status_type AS status_id, cohort.year_level, COUNT(DISTINCT cohort.student_id) AS n
          FROM ($cohortSql) cohort
          JOIN ($effectiveStatusSql) eff
            ON eff.student_id = cohort.student_id
      GROUP BY eff.status_type, cohort.year_level");
    $cellStmt->execute(array_merge($cohortParams, $effectiveParams));

    $cells = [];
    foreach ($cellStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $cells[(int)$row['status_id']][(int)$row['year_level']] = (int)$row['n'];
    }

    // A retired status earns a row only while this cohort still holds it.
    $statuses = array_values(array_filter(
        $statuses,
        static fn(array $s): bool => $s['archived_at'] === null || array_sum($cells[(int)$s['status_id']] ?? []) > 0
    ));

    $sumYears = static function (array $byYear, array $years): int {
        $total = 0;
        foreach ($years as $year) {
            $total += $byYear[$year] ?? 0;
        }
        return $total;
    };
    // "Upper years" is every year level above the first — the screenshot's
    // UPPRYRS column, which sums II onward.
    $upperYears = array_values(array_filter($yearLevels, static fn(int $y): bool => $y > 1));

    $baselineRow = [
        'by_year'     => array_map(static fn(int $y): int => $baseline[$y] ?? 0, $yearLevels),
        'total'       => $sumYears($baseline, $yearLevels),
        'upper_years' => $sumYears($baseline, $upperYears),
    ];


    /*
     * The same cohort again, split by where the students are rather than by
     * what became of them.
     *
     * Built from $cohortSql, not from a query of its own, so the two tables can
     * never disagree about who counts: whatever scoping, fallback and dean
     * pinning produced the baseline above produced these rows too. Joining the
     * cohort back to course is enough -- the cohort already carries the student
     * ids, and re-deriving them here is how the two would drift.
     *
     * The dimension follows what is already in scope. With a single department
     * showing -- a dean, who is pinned to one, or an admin who picked one -- a
     * department breakdown is one row saying what the heading said, so it lists
     * that department's courses instead. Otherwise it lists departments.
     *
     * Departments are kept per campus row rather than merged by name. The same
     * college runs on more than one campus and each row is a real population
     * with its own numbers; merging them would hide the comparison this table
     * exists to make. The campus is in the label so two rows of the same college
     * can be told apart.
     */
    $groupByCourse = $isDepartmentPinned || ($departmentId !== null && $departmentId > 0);

    $groupSql = $groupByCourse
        ? "SELECT c2.course_id AS group_id,
                  c2.course_code AS group_code,
                  c2.course_name AS group_name,
                  cam.campus_name AS campus_name,
                  cam.campus_code AS campus_code,
                  cohort.year_level, COUNT(DISTINCT cohort.student_id) AS n
             FROM ($cohortSql) cohort
             JOIN student s2 ON s2.student_id = cohort.student_id
             JOIN course  c2 ON c2.course_id  = s2.course_id
        LEFT JOIN department d2 ON d2.department_id = c2.department_id
        LEFT JOIN campus cam ON cam.campus_id = d2.campus_id
         GROUP BY c2.course_id, c2.course_code, c2.course_name, cam.campus_name, cam.campus_code, cohort.year_level"
        : "SELECT d2.department_id AS group_id,
                  d2.department_code AS group_code,
                  d2.department_name AS group_name,
                  cam.campus_name AS campus_name,
                  cam.campus_code AS campus_code,
                  cohort.year_level, COUNT(DISTINCT cohort.student_id) AS n
             FROM ($cohortSql) cohort
             JOIN student s2 ON s2.student_id = cohort.student_id
             JOIN course  c2 ON c2.course_id  = s2.course_id
             JOIN department d2 ON d2.department_id = c2.department_id
        LEFT JOIN campus cam ON cam.campus_id = d2.campus_id
         GROUP BY d2.department_id, d2.department_code, d2.department_name, cam.campus_name, cam.campus_code, cohort.year_level";

    $groupStmt = $pdo->prepare($groupSql);
    $groupStmt->execute($cohortParams);

    $groupCells = [];
    $groupMeta  = [];
    foreach ($groupStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $gid = (int)$row['group_id'];
        $groupCells[$gid][(int)$row['year_level']] = (int)$row['n'];
        if (!isset($groupMeta[$gid])) {
            $name   = trim((string)($row['group_name'] ?? ''));
            $campus = trim((string)($row['campus_name'] ?? ''));
            $groupMeta[$gid] = [
                'code'   => $row['group_code'] ?? null,
                'campus_code' => ($row['campus_code'] ?? '') !== '' ? $row['campus_code'] : null,
                'name'   => $name,
                'campus' => $campus !== '' ? $campus : null,
                // One string the table can print as-is. Both dimensions repeat
                // per campus -- the same college, and the same course inside it,
                // each have a row per campus -- so without the campus a dean
                // sees two rows both reading "BSIT" and cannot tell which is
                // which. The campus is what makes the label identify a row.
                'label'  => $campus !== '' ? "$name - $campus" : $name,
            ];
        }
    }

    $groups = [];
    foreach ($groupMeta as $gid => $meta) {
        $byYear = $groupCells[$gid] ?? [];
        $counts = array_map(static fn(int $y): int => $byYear[$y] ?? 0, $yearLevels);
        $groups[] = [
            'group_id'    => $gid,
            'group_code'  => $meta['code'],
            'group_name'  => $meta['name'],
            'campus_name' => $meta['campus'],
            // The short form the tables actually print. The full name stays in
            // campus_name/label for the tooltip, because "COC-PUERTO" is only
            // useful to somebody who already knows the codes.
            'campus_code' => $meta['campus_code'],
            'label'       => $meta['label'],
            'counts'      => $counts,
            'total'       => $sumYears($byYear, $yearLevels),
            'upper_years' => $sumYears($byYear, $upperYears),
            /*
             * Share of the YEAR's cohort, so a column reads as a split of that
             * year and adds to 100%. The status rows above divide by the same
             * denominator, which is what lets a reader carry one percentage
             * from one table to the other.
             */
            'percents'    => array_map(static function (int $count, int $year) use ($baseline): float {
                $denominator = $baseline[$year] ?? 0;
                return $denominator > 0 ? round($count / $denominator * 100, 1) : 0.0;
            }, $counts, $yearLevels),
            'total_percent' => $baselineRow['total'] > 0
                ? round($sumYears($byYear, $yearLevels) / $baselineRow['total'] * 100, 1) : 0.0,
            'upper_percent' => $baselineRow['upper_years'] > 0
                ? round($sumYears($byYear, $upperYears) / $baselineRow['upper_years'] * 100, 1) : 0.0,
        ];
    }

    // Biggest population first: the table is read to find where the students
    // are, and that question is answered by the top row.
    usort($groups, static fn(array $a, array $b): int => $b['total'] <=> $a['total']);

    $rows = [];
    $columnSums = array_fill_keys($yearLevels, 0);
    $upperSum = 0;
    $grandTotal = 0;

    foreach ($statuses as $status) {
        $sid = (int)$status['status_id'];
        $byYear = $cells[$sid] ?? [];
        $counts = array_map(static fn(int $y): int => $byYear[$y] ?? 0, $yearLevels);
        $total  = $sumYears($byYear, $yearLevels);
        $upper  = $sumYears($byYear, $upperYears);

        foreach ($yearLevels as $index => $year) {
            $columnSums[$year] += $counts[$index];
        }
        $upperSum += $upper;
        $grandTotal += $total;

        $rows[] = [
            'status_id'   => $sid,
            'status_name' => $status['status_name'],
            // Archived, but records in this cohort still carry it.
            'retired'     => $status['archived_at'] !== null,
            'counts'      => $counts,
            'total'       => $total,
            'upper_years' => $upper,
            // Percentages are against the cohort, not the row — "vs 100%
            // retention" asks what share of last term's students this is.
            'percents'    => array_map(static function (int $count, int $year) use ($baseline): float {
                $denominator = $baseline[$year] ?? 0;
                return $denominator > 0 ? round($count / $denominator * 100, 1) : 0.0;
            }, $counts, $yearLevels),
            'total_percent' => $baselineRow['total'] > 0 ? round($total / $baselineRow['total'] * 100, 1) : 0.0,
            'upper_percent' => $baselineRow['upper_years'] > 0 ? round($upper / $baselineRow['upper_years'] * 100, 1) : 0.0,
        ];
    }

    /*
     * Variance is the cohort minus everything accounted for. A non-zero value
     * means students from last term have no status recorded this term — a data
     * gap worth surfacing rather than hiding behind a tidy 100%.
     */
    $variance = [
        'by_year'     => array_map(static fn(int $y): int => ($baseline[$y] ?? 0) - $columnSums[$y], $yearLevels),
        'total'       => $baselineRow['total'] - $grandTotal,
        'upper_years' => $baselineRow['upper_years'] - $upperSum,
    ];

    $termName = static function (PDO $pdo, ?int $syId, ?int $semId): ?string {
        if ($syId === null || $semId === null) return null;
        $stmt = $pdo->prepare(
            'SELECT CONCAT(COALESCE(sem.semester_name, ""), " ", COALESCE(sy.schoolyear_name, ""))
               FROM semester sem, school_year sy
              WHERE sem.semester_id = :sem AND sy.school_year_id = :sy LIMIT 1'
        );
        $stmt->execute([':sem' => $semId, ':sy' => $syId]);
        $value = $stmt->fetchColumn();
        return $value === false ? null : trim((string)$value);
    };

    matrix_out(200, ['data' => [
        'year_levels'  => $yearLevels,
        'upper_years'  => $upperYears,
        'baseline'     => $baselineRow,
        'rows'         => $rows,
        // The second table: the same cohort by department, or by course when a
        // single department is already in scope. `group_dimension` says which,
        // so the heading can name what the rows are without guessing.
        'groups'       => $groups,
        'group_dimension' => $groupByCourse ? 'course' : 'department',
        'column_totals'=> [
            'by_year'     => array_map(static fn(int $y): int => $columnSums[$y], $yearLevels),
            'total'       => $grandTotal,
            'upper_years' => $upperSum,
        ],
        'variance'     => $variance,
        'current_term' => [
            'school_year_id' => $schoolYearId,
            'semester_id'    => $semesterId,
            'label'          => $termName($pdo, $schoolYearId, $semesterId),
            // False means the grid above is all zeros because nobody has
            // recorded anything for this term yet — not because every student
            // dropped out.
            'has_records'    => $termHasRecords,
        ],
        'baseline_term' => [
            'school_year_id' => $previous['school_year_id'],
            'semester_id'    => $previous['semester_id'],
            'label'          => $termName($pdo, $previous['school_year_id'], $previous['semester_id']),
            'is_fallback'     => $cohortIsFallback,
            'fallback_reason' => $fallbackReason,
        ],
        'scope' => [
            'campus_id'     => $campusId,
            'department_id' => $departmentId,
            'course_id'     => $courseId,
            'locked'        => $isDepartmentPinned,
        ],
        'can_choose_department' => $seesAllDepartments,
        // Options for the choosers. Departments are withheld from anyone who
        // cannot choose one, so the caller never renders a control the server
        // would ignore. Term is filterable by every role, including a dean.
        // Departments carry campus_id so the chooser can narrow itself to the
        // selected campus without a second request.
        'departments' => $seesAllDepartments
            ? ($pdo->query('SELECT department_id, department_code, department_name, campus_id
                               FROM department WHERE archived_at IS NULL
                           ORDER BY department_name ASC')->fetchAll(PDO::FETCH_ASSOC) ?: [])
            : [],
        'campuses' => $seesAllDepartments
            ? ($pdo->query('SELECT campus_id, campus_code, campus_name
                              FROM campus ORDER BY campus_name ASC')->fetchAll(PDO::FETCH_ASSOC) ?: [])
            : [],
        'school_years' => $pdo->query('SELECT school_year_id, schoolyear_name
                                         FROM school_year ORDER BY schoolyear_name DESC')
            ->fetchAll(PDO::FETCH_ASSOC) ?: [],
        'semesters' => $pdo->query('SELECT semester_id, semester_name
                                      FROM semester ORDER BY semester_id ASC')
            ->fetchAll(PDO::FETCH_ASSOC) ?: [],
        // Echoed back so the controls can show what the server actually used
        // when the caller sent nothing and the defaults kicked in.
        'selected_term' => [
            'school_year_id' => $schoolYearId ?: null,
            'semester_id' => $semesterId ?: null,
        ],
    ]]);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'retention_matrix.php']);
    matrix_out(500, ['message' => 'Server error']);
}
