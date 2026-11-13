<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/student_fields.php';
// The PDO segment matrix. The assignment board ranks students by the same
// Priority 1-4 the contact workspace and the prioritization screen use, so the
// same student never reads as two different levels of urgent on two screens the
// same caller works in.
require_once __DIR__ . '/pdo_priority_lib.php';
require_once __DIR__ . '/lib/follow_up_queue.php';
// When a student may be put onto a team: Periodical 3 only. The calendar is
// the authority, as it is for every import and for the faculty board.
require_once __DIR__ . '/lib/academic_calendar.php';
require_once __DIR__ . '/lib/assignment_window.php';
// The Enrollment Status column reads the term AFTER the current one, and the
// Survey Status column reads what the student's survey answer implied.
require_once __DIR__ . '/lib/school_year_window.php';
require_once __DIR__ . '/lib/survey_enrollment_status.php';
// A student's coach and coaching unit, and the reassign rule. Shared with
// student.php, which shows the same two columns on Student Management.
require_once __DIR__ . '/lib/student_coach.php';
// CSV / Excel 2003 XML parsing for the coach import - the same reader the
// grades and attendance imports use.
require_once __DIR__ . '/lib/spreadsheet_import.php';

// The role ids this file used to hardcode now come from API_FOLLOW_UP_TEAMS in
// middleware/auth.php, which knows both members of both teams rather than only
// the two workers. retention_case.php still declares its own copies; they are
// file-scoped constants, so the two do not collide.
//
// Its caller list is a separate, deliberately narrower question -- see
// fetch_case_owner_candidates() there. Both functions were called
// fetch_ssp_callers() until 2026-09-14, which was safe only for as long as no
// request loaded both files: PHP has no file scope for functions, so a single
// require_once of one from the other would have been a fatal redeclare.


function ensure_ssp_assignment_table(PDO $pdo): void {
    api_require_table($pdo, 'ssp_assignment');
}

/**
 * Everyone who can hold an assignment: the coaches.
 *
 * A student has one assignee, their coach - an SSP Caller for Non-STAR, a
 * KASAMA for STAR. From 2026-08-10 the supervisors were listed too, because the
 * board stored a coach and supervisor PAIR per student; Francis ended that on
 * 2026-10-01 ("all students should only have one assigned coach"), and a
 * supervisor already sees every student of their cohort without a row.
 *
 * A supervisor gets their own unit's coaches only. The SSP Coordinator has no
 * use for the KASAMA roster and cannot open a STAR student to assign it anyway;
 * Admin, with no cohort, gets both units.
 */
function fetch_follow_up_team_members(PDO $pdo, ?array $authUser = null): array {
    $scope = api_student_type_scope_for_user($authUser);
    $roleIds = $scope !== null
        ? array_filter([student_coach_role_for_type($scope)])
        : student_coach_role_ids();
    if (!$roleIds) {
        return [];
    }
    $roleIds = array_values($roleIds);
    $placeholders = implode(', ', array_fill(0, count($roleIds), '?'));

    $sql = "SELECT
                u.user_id,
                u.role AS role_id,
                u.first_name,
                u.last_name,
                u.email,
                u.status,
                s.status_name,
                r.role_name
            FROM user u
            LEFT JOIN role r ON r.role_id = u.role
            LEFT JOIN status s ON s.status_id = u.status
            WHERE u.role IN ($placeholders)
            ORDER BY CASE WHEN u.status = 1 THEN 0 ELSE 1 END, u.role ASC, u.first_name ASC, u.last_name ASC, u.user_id ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($roleIds);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Tagged from the team mapping. Since 2026-09-24 the access scope gives the
    // same answer for every team role, but this is the question the dropdown is
    // asking - "whose team is this person on" - so it reads the mapping for it.
    foreach ($rows as &$row) {
        $row['handles_student_type'] = api_follow_up_team_type_for_role_id((int)($row['role_id'] ?? 0));
    }
    unset($row);

    return $rows;
}

/**
 * Reject an assignment whose caller is not on that student's team.
 *
 * Two separate failures this prevents. For the worker roles it is visibility: a
 * KSH Coach saved onto an Nonstar student stores fine and is then filtered out
 * of every read the coach makes, leaving a student who looks assigned and is
 * invisible to the person assigned to them. For the supervisor roles it is
 * simply the wrong team — a KSH TL can see an Nonstar student perfectly well,
 * they just have no business being on it.
 */
function assignment_type_mismatch(?string $studentType, ?string $callerHandles): ?string {
    $student = strtolower(trim((string)$studentType));
    $caller = strtolower(trim((string)$callerHandles));

    if ($student === '' || $caller === '' || $student === $caller) {
        return null;
    }

    return sprintf(
        'This user is on the %s follow-up team, but the selected student is %s.',
        ucfirst($caller),
        ucfirst($student)
    );
}

/**
 * The coach auto-assign gives a student: the least-loaded active coach of the
 * student's unit, or null when that unit has no active coach.
 *
 * Least-loaded first so a second SSP Caller actually shares the queue instead of
 * the board stacking everything on whoever sorts first; user_id breaks ties so
 * the choice is repeatable rather than dependent on row order. Inactive accounts
 * are never chosen — an assignment to a disabled user is an unworked student.
 *
 * One coach and nobody else: until 2026-10-01 this filled a PAIR, the coach and
 * their supervisor, which is how supervisors came to be listed on students.
 */
function pick_coach(PDO $pdo, string $studentType): ?array {
    $roleId = student_coach_role_for_type($studentType);
    if ($roleId === null) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT u.user_id, u.first_name, u.last_name,
                (SELECT COUNT(*) FROM ssp_assignment sa WHERE sa.caller_user_id = u.user_id) AS caseload
           FROM user u
          WHERE u.role = :role_id AND u.status = 1
       ORDER BY caseload ASC, u.user_id ASC
          LIMIT 1'
    );
    $stmt->execute([':role_id' => $roleId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function fetch_ssp_caller(PDO $pdo, int $userId): ?array {
    $sql = "SELECT
                u.user_id,
                u.role AS role_id,
                u.first_name,
                u.last_name,
                u.email,
                u.status,
                s.status_name,
                r.role_name
            FROM user u
            LEFT JOIN role r ON r.role_id = u.role
            LEFT JOIN status s ON s.status_id = u.status
            WHERE u.user_id = :user_id
            LIMIT 1";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;

    // Membership of either team, supervisors included, so that a supervisor
    // sent here is told they are not a coach rather than that they are nobody.
    $roleId = (int)($row['role_id'] ?? 0);
    return api_follow_up_team_type_for_role_id($roleId) !== null ? $row : null;
}

/**
 * Every assignment on the given students, grouped by student.
 *
 * Separate query rather than a join on the board's own SELECT. That SELECT
 * returns one row per student, and once a student can hold two assignments a
 * LEFT JOIN silently turns into two rows for them — the board would list the
 * same student twice, once per assignee, and every count taken off it would be
 * wrong. Grouping here keeps "one row is one student" true.
 */
function fetch_assignments_by_student(PDO $pdo, array $studentIds): array {
    if (!$studentIds) {
        return [];
    }

    $placeholders = implode(', ', array_fill(0, count($studentIds), '?'));
    $sql = "SELECT
                sa.assignment_id,
                sa.student_id,
                sa.caller_user_id,
                sa.assigned_by_user_id,
                sa.notes,
                sa.created_at,
                sa.updated_at,
                u.first_name AS caller_first_name,
                u.last_name AS caller_last_name,
                u.email AS caller_email,
                u.role AS caller_role_id,
                r.role_name AS caller_role_name,
                cst.status_name AS caller_status_name,
                au.first_name AS assigned_by_first_name,
                au.last_name AS assigned_by_last_name
            FROM ssp_assignment sa
            LEFT JOIN user u ON u.user_id = sa.caller_user_id
            LEFT JOIN role r ON r.role_id = u.role
            LEFT JOIN status cst ON cst.status_id = u.status
            LEFT JOIN user au ON au.user_id = sa.assigned_by_user_id
            WHERE sa.student_id IN ($placeholders)
            ORDER BY sa.student_id ASC, sa.assignment_id ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute(array_map('intval', $studentIds));

    $grouped = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $studentId = (int)$row['student_id'];
        $grouped[$studentId][] = [
            'assignment_id' => (int)$row['assignment_id'],
            'caller_user_id' => (int)$row['caller_user_id'],
            'caller_name' => trim((string)$row['caller_first_name'] . ' ' . (string)$row['caller_last_name']),
            'caller_email' => $row['caller_email'] ?? '',
            'caller_role_id' => isset($row['caller_role_id']) ? (int)$row['caller_role_id'] : null,
            'caller_role_name' => $row['caller_role_name'] ?? '',
            'caller_status_name' => $row['caller_status_name'] ?? '',
            'handles_student_type' => api_follow_up_team_type_for_role_id((int)($row['caller_role_id'] ?? 0)),
            'assigned_by_user_id' => isset($row['assigned_by_user_id']) ? (int)$row['assigned_by_user_id'] : null,
            'assigned_by_name' => trim((string)$row['assigned_by_first_name'] . ' ' . (string)$row['assigned_by_last_name']),
            'notes' => $row['notes'] ?? '',
            'created_at' => $row['created_at'] ?? '',
            'updated_at' => $row['updated_at'] ?? '',
        ];
    }

    return $grouped;
}

/**
 * May this student be put on a team - the same membership rule the board lists by.
 *
 * Driven from `student`, like fetch_assignment_rows(): a live student whose
 * latest enrollment record is not approved, INCLUDING one with no record at all.
 * This used to start from enrollment_status and so refused every student without
 * a row - about 2,750 of the 2,776 the board offered, each answering "does not
 * need an enrollment update" when the Add button was pressed.
 */
function has_pending_enrollment_update(PDO $pdo, int $studentId): bool {
    return students_pending_enrollment_update($pdo, [$studentId]) !== [];
}

/**
 * The same rule for a batch: which of these students may be put on a team.
 * One query for the board's ticked rows rather than one per student.
 *
 * @return int[] the ids that may
 */
function students_pending_enrollment_update(PDO $pdo, array $studentIds): array {
    $studentIds = array_values(array_unique(array_filter(array_map('intval', $studentIds), static fn (int $id): bool => $id > 0)));
    if (!$studentIds) {
        return [];
    }

    $placeholders = implode(', ', array_fill(0, count($studentIds), '?'));
    $sql = "SELECT st.student_id
            FROM student st
            LEFT JOIN (
                SELECT es_inner.student_id, es_inner.decision
                FROM enrollment_status es_inner
                INNER JOIN (
                    SELECT student_id, MAX(enrollment_status_id) AS latest_id
                    FROM enrollment_status
                    GROUP BY student_id
                ) latest ON latest.latest_id = es_inner.enrollment_status_id
            ) es ON es.student_id = st.student_id
            WHERE st.student_id IN ($placeholders)
              AND st.archived_at IS NULL
              AND LOWER(COALESCE(es.decision, '')) <> 'approved'";
    $stmt = $pdo->prepare($sql);
    $stmt->execute($studentIds);
    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN) ?: []);
}

/**
 * Is this account the supervisor of a follow-up team - SSP Coordinator or KSH TL?
 *
 * Read off the team mapping ([worker, supervisor]) rather than listing 5 and 7,
 * so a third team would answer correctly without an edit here.
 */
function ssp_is_team_supervisor(?array $authUser): bool {
    $roleId = (int)($authUser['role_id'] ?? 0);
    $team = api_follow_up_team_role_ids(api_student_type_for_role_id($roleId));
    return count($team) >= 2 && (int)$team[1] === $roleId;
}

/**
 * The term whose enrollment the board reports: the next one a student enrolls
 * for after the current term. During 1st Semester that is 2nd Semester of the
 * same year - the enrollment SSG records and the coaches are working towards.
 *
 * All nulls when the calendar has no current semester, which the column shows
 * as "no term set" rather than guessing one.
 */
function ssp_enrollment_target_term(PDO $pdo): array {
    static $term = null;
    if ($term !== null) {
        return $term;
    }

    $current = academic_calendar_current($pdo);
    $next = sy_window_next_enrollment_term(
        $pdo,
        isset($current['school_year_id']) ? (int)$current['school_year_id'] : null,
        isset($current['semester_id']) ? (int)$current['semester_id'] : null
    );
    $next['label'] = $next['semester_id'] !== null
        ? trim($next['semester_name'] . ' ' . $next['schoolyear_name'])
        : null;

    return $term = $next;
}

/**
 * The id of the "Enrolled" standing. One of the four statuses status_guard.php
 * refuses to rename, so looking it up by name is safe.
 */
function ssp_enrolled_status_id(PDO $pdo): int {
    static $id = null;
    if ($id === null) {
        $id = (int)$pdo->query(
            "SELECT status_id FROM status WHERE status_type = 'enrollment' AND LOWER(status_name) = 'enrolled' LIMIT 1"
        )->fetchColumn();
    }
    return $id;
}

/**
 * Each student's survey state: whether they have answered, which survey and
 * when, and what their answer to the enrollment question was.
 *
 * "Submitted" is any submission at all - the same test the "No survey yet"
 * band uses, so a row can never sit in that band and read as submitted. The
 * answer comes from the latest submission that HAS one: a later survey that
 * asks nothing about enrollment must not hide what the student said on the
 * one that did.
 *
 * Batched for the whole board - one query for the submissions, one for their
 * answers - however many students are on it.
 */
function fetch_survey_status_by_student(PDO $pdo, array $studentIds): array {
    $studentIds = array_values(array_unique(array_filter(array_map('intval', $studentIds))));
    if (!$studentIds) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($studentIds), '?'));
    $stmt = $pdo->prepare(
        "SELECT ss.submission_id, ss.student_id, ss.survey_id, ss.submitted_at, sv.survey_title
           FROM survey_submission ss
      LEFT JOIN survey sv ON sv.survey_id = ss.survey_id
          WHERE ss.student_id IN ($placeholders)
            AND ss.archived_at IS NULL
       ORDER BY ss.student_id ASC, ss.submission_id DESC"
    );
    $stmt->execute($studentIds);
    $submissions = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    if (!$submissions) {
        return [];
    }

    $surveyBySubmission = [];
    foreach ($submissions as $row) {
        $surveyBySubmission[(int)$row['submission_id']] = (int)$row['survey_id'];
    }
    $answers = resolve_submissions_enrollment_status($pdo, $surveyBySubmission);

    $statusNames = [];
    foreach ($pdo->query("SELECT status_id, status_name FROM status WHERE status_type = 'enrollment'")->fetchAll(PDO::FETCH_ASSOC) ?: [] as $status) {
        $statusNames[(int)$status['status_id']] = (string)$status['status_name'];
    }

    $byStudent = [];
    foreach ($submissions as $row) {
        $studentId = (int)$row['student_id'];
        $submissionId = (int)$row['submission_id'];

        // Newest first, so the first row seen is the latest submission.
        if (!isset($byStudent[$studentId])) {
            $byStudent[$studentId] = [
                'submitted' => true,
                'submitted_at' => $row['submitted_at'] ?? null,
                'survey_title' => $row['survey_title'] ?? '',
                'submission_count' => 0,
                'answer' => null,
                'answer_status' => null,
                'answer_survey_title' => null,
            ];
        }
        $byStudent[$studentId]['submission_count'] += 1;

        if ($byStudent[$studentId]['answer'] === null && isset($answers[$submissionId])) {
            $option = $answers[$submissionId];
            $statusId = (int)($option['enrollment_status_id'] ?? 0);
            $byStudent[$studentId]['answer'] = (string)($option['option_text'] ?? '');
            $byStudent[$studentId]['answer_status'] = $statusNames[$statusId] ?? null;
            $byStudent[$studentId]['answer_survey_title'] = $row['survey_title'] ?? '';
        }
    }

    return $byStudent;
}

function fetch_assignment_rows(PDO $pdo, ?int $callerUserId = null, ?array $authUser = null, string $queue = FOLLOW_UP_QUEUE_PRIORITY): array {
    $params = [];
    $callerWhere = '';
    if ($callerUserId !== null) {
        // EXISTS rather than a join condition: the assignments are no longer
        // joined into this SELECT, and a student one of whose two assignees is
        // this caller should appear once, not once per matching row.
        $callerWhere = ' AND EXISTS (SELECT 1 FROM ssp_assignment mine
                                      WHERE mine.student_id = st.student_id
                                        AND mine.caller_user_id = :caller_user_id)';
        $params[':caller_user_id'] = $callerUserId;
    }

    $typeWhere = '';
    $studentTypeScope = api_student_type_scope_for_user($authUser);
    if ($studentTypeScope !== null) {
        $typeWhere = ' AND st.`star e-profile` = :student_type_scope';
        $params[':student_type_scope'] = $studentTypeScope;
    }

    /*
     * Driven from `student`, not from `enrollment_status`.
     *
     * The old query started at enrollment_status and INNER JOINed the student, so
     * the board could only ever show someone a decision had already been recorded
     * for — 20 rows against 509 students. A follow-up queue that requires the
     * follow-up to have happened is empty by construction, which is exactly how it
     * behaved. enrollment_status is now a LEFT JOIN supplying display fields, and
     * the risk bands in follow_up_queue.php decide membership.
     */
    $band = follow_up_queue_where($queue);
    foreach ($band['params'] as $key => $value) {
        $params[$key] = $value;
    }

    // Unknown term binds NULL, which matches no row: the column then says the
    // term is not set instead of reporting some other term's standing.
    $targetTerm = ssp_enrollment_target_term($pdo);
    $params[':next_school_year_id'] = $targetTerm['school_year_id'];
    $params[':next_semester_id'] = $targetTerm['semester_id'];

    $sql = "SELECT
                st.student_id,
                st.student_number,
                st.first_name,
                st.last_name,
                st.email_address,
                st.mobile_number,
                st.facebook_name,
                st.mother_number,
                st.father_number,
                st.`star e-profile` AS student_type,
                st.year_level,
                st.section,
                c.course_name,
                c.course_code,
                d.department_name,
                es.enrollment_status_id,
                es.decision,
                es.status_type,
                es.date AS enrollment_date,
                es.reason,
                es.response,
                stt.status_name AS enrollment_status_name,
                sem.semester_name,
                sy.schoolyear_name,
                nx.status_type AS next_status_id,
                nxs.status_name AS next_status_name,"
                . follow_up_queue_select_sql() . ",
                COALESCE(ac.assignment_count, 0) AS assignment_count
            FROM student st
            LEFT JOIN (
                SELECT es_inner.*
                FROM enrollment_status es_inner
                INNER JOIN (
                    SELECT student_id, MAX(enrollment_status_id) AS latest_id
                    FROM enrollment_status
                    GROUP BY student_id
                ) latest ON latest.latest_id = es_inner.enrollment_status_id
            ) es ON es.student_id = st.student_id
            LEFT JOIN course c ON c.course_id = st.course_id
            LEFT JOIN department d ON d.department_id = c.department_id
            LEFT JOIN status stt ON stt.status_id = es.status_type
            LEFT JOIN semester sem ON sem.semester_id = es.semester_id
            LEFT JOIN school_year sy ON sy.school_year_id = es.school_year_id
            -- The upcoming term's row: what SSG has recorded about enrolling for
            -- it. One row at most, by uq_enrollment_student_term.
            LEFT JOIN enrollment_status nx
                   ON nx.student_id = st.student_id
                  AND nx.school_year_id = :next_school_year_id
                  AND nx.semester_id = :next_semester_id
                  AND nx.archived_at IS NULL
            LEFT JOIN status nxs ON nxs.status_id = nx.status_type"
            . follow_up_queue_join_sql('st') . "
            LEFT JOIN (
                SELECT student_id, COUNT(*) AS assignment_count
                FROM ssp_assignment
                GROUP BY student_id
            ) ac ON ac.student_id = st.student_id
            WHERE st.archived_at IS NULL
              AND LOWER(COALESCE(es.decision, '')) <> 'approved'
              AND {$band['sql']}{$callerWhere}{$typeWhere}
            ORDER BY COALESCE(ac.assignment_count, 0) ASC,
                     " . follow_up_queue_order_sql('st');

    $stmt = $pdo->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    /*
     * The band, decided here rather than in the WHERE above.
     *
     * The PDO matrix is five branches over grades, attendance and balance, and
     * no WHERE clause can evaluate it without becoming a second copy of rules
     * that pdo_priority_lib exists to keep in one place. So the SQL fetches the
     * caller's scope and this classifies it and keeps the requested priority.
     *
     * It also sorts, because priority is not a column and therefore cannot be
     * an ORDER BY -- the fewest-assignments-first ordering the query applied
     * survives as the tie-break inside each band.
     */
    $rows = follow_up_queue_apply($pdo, $rows, $queue);

    $assignmentsByStudent = fetch_assignments_by_student(
        $pdo,
        array_map(static fn ($row) => (int)($row['student_id'] ?? 0), $rows)
    );

    $surveyByStudent = fetch_survey_status_by_student(
        $pdo,
        array_map(static fn ($row) => (int)($row['student_id'] ?? 0), $rows)
    );
    $enrolledStatusId = ssp_enrolled_status_id($pdo);

    $mapped = array_map(function ($row) use ($assignmentsByStudent, $surveyByStudent, $enrolledStatusId) {
        $studentId = isset($row['student_id']) ? (int)$row['student_id'] : null;
        $assignments = $assignmentsByStudent[$studentId] ?? [];

        // Complete means the student has their coach - the one role a student
        // is assigned since 2026-10-01. Supervisors are not assigned students:
        // they already see every student of their cohort.
        $coachRoleId = student_coach_role_for_type((string)($row['student_type'] ?? ''));
        $requiredRoleIds = $coachRoleId !== null ? [$coachRoleId] : [];
        $filledRoleIds = array_column($assignments, 'caller_role_id');
        $missingRoleIds = array_values(array_diff($requiredRoleIds, $filledRoleIds));

        // Legacy singular fields, kept pointing at the coach so the coordinator
        // dashboard's unassigned tile and anything else reading one caller off
        // a student keeps working.
        $primary = $assignments[0] ?? null;
        $assignedByName = $primary['assigned_by_name'] ?? '';

        // The coach: the assignment held by the unit's coach role, not by the
        // supervisor who may also be on the team.
        $coachRole = student_coach_role_for_type((string)($row['student_type'] ?? ''));
        $coach = null;
        foreach ($assignments as $assignment) {
            if ($coachRole !== null && (int)($assignment['caller_role_id'] ?? 0) === $coachRole) {
                $coach = $assignment;
                break;
            }
        }
        $callerName = $primary['caller_name'] ?? '';
        $courseLabel = trim((string)($row['course_name'] ?? ''));
        if ($courseLabel === '') {
            $courseLabel = trim((string)($row['course_code'] ?? ''));
        }

        return [
            'student_id' => isset($row['student_id']) ? (int)$row['student_id'] : null,
            'student_number' => $row['student_number'] ?? '',
            'first_name' => $row['first_name'] ?? '',
            'last_name' => $row['last_name'] ?? '',
            'email_address' => $row['email_address'] ?? '',
            'mobile_number' => $row['mobile_number'] ?? '',
            'facebook_name' => $row['facebook_name'] ?? '',
            'mother_number' => $row['mother_number'] ?? '',
            'father_number' => $row['father_number'] ?? '',
            'year_level' => $row['year_level'] ?? null,
            'section' => $row['section'] ?? '',
            'course_name' => $courseLabel,
            // The short form, for the board's Program column.
            'course_code' => $row['course_code'] ?? '',
            'department_name' => $row['department_name'] ?? '',
            'enrollment_status_id' => isset($row['enrollment_status_id']) ? (int)$row['enrollment_status_id'] : null,
            'decision' => $row['decision'] ?? '',
            'status_type' => isset($row['status_type']) ? (int)$row['status_type'] : null,
            'enrollment_status_name' => $row['enrollment_status_name'] ?? '',
            'enrollment_date' => $row['enrollment_date'] ?? '',
            'reason' => $row['reason'] ?? '',
            'response' => $row['response'] ?? '',
            'semester_name' => $row['semester_name'] ?? '',
            'schoolyear_name' => $row['schoolyear_name'] ?? '',
            'student_type' => $row['student_type'] ?? '',

            /*
             * Survey Status: have they answered, and what did they say about
             * enrolling. Absent from the lookup means never submitted.
             */
            'survey' => $surveyByStudent[$studentId] ?? [
                'submitted' => false,
                'submitted_at' => null,
                'survey_title' => '',
                'submission_count' => 0,
                'answer' => null,
                'answer_status' => null,
                'answer_survey_title' => null,
            ],

            /*
             * Enrollment Status: the standing recorded for the upcoming term -
             * set by SSG on Student Migration or Enrollment Status, or by the
             * student's own survey answer until SSG changes it. Only "Enrolled"
             * counts as enrolled; anything else is reported by name.
             */
            'next_enrollment' => [
                'status_id' => isset($row['next_status_id']) ? (int)$row['next_status_id'] : null,
                'status_name' => $row['next_status_name'] ?? null,
                'is_enrolled' => $enrolledStatusId > 0
                    && isset($row['next_status_id'])
                    && (int)$row['next_status_id'] === $enrolledStatusId,
            ],

            /*
             * Why this student is on the list at all. Carried to the caller so the
             * reason for the call is on screen before they dial, rather than being
             * something they have to go and look up in another module.
             *
             * risk_* is the retention evaluator's own scale. It no longer decides
             * queue membership - the PDO priority does, as of 2026-09-18 - but it
             * is still carried, because evaluation_reason is the sentence a caller
             * reads before dialling and other readers consume the level.
             */
            'risk_level' => $row['risk_level'] ?? 'low',
            'risk_score' => isset($row['risk_score']) ? (float)$row['risk_score'] : 0.0,
            'risk_reason' => $row['risk_reason'] ?? '',
            'missing_survey' => !empty($row['missing_survey']),
            'queue_band' => $row['queue_band'] ?? FOLLOW_UP_QUEUE_PRIORITY,

            /*
             * The PDO priority, set by follow_up_queue_apply() on the way in.
             * Same matrix as the prioritization list and the case board, so one
             * student reads the same on all three.
             */
            'priority' => $row['priority'] ?? null,
            'priority_label' => $row['priority_label'] ?? '',
            'priority_owner' => $row['priority_owner'] ?? '',
            'segment' => $row['segment'] ?? '',

            // SSP or KASAMA, from the student's cohort; and who their coach is.
            'coaching_unit' => student_coaching_unit((string)($row['student_type'] ?? '')),
            'coach' => $coach === null ? null : [
                'assignment_id' => $coach['assignment_id'] ?? null,
                'user_id' => $coach['caller_user_id'] ?? null,
                'name' => $coach['caller_name'] ?? '',
                'email' => $coach['caller_email'] ?? '',
                'updated_at' => $coach['updated_at'] ?? null,
            ],

            // Who holds the student: the coach, one row once
            // migrations/2026_10_01_ssp_assignment_one_coach.sql has run.
            'assignments' => $assignments,
            'assignment_count' => count($assignments),
            'team_complete' => $requiredRoleIds !== [] && $missingRoleIds === [],
            'missing_role_ids' => $missingRoleIds,

            'assignment_id' => $primary['assignment_id'] ?? null,
            'caller_user_id' => $primary['caller_user_id'] ?? null,
            'assigned_by_user_id' => $primary['assigned_by_user_id'] ?? null,
            'assignment_notes' => $primary['notes'] ?? '',
            'assignment_created_at' => $primary['created_at'] ?? '',
            'assignment_updated_at' => $primary['updated_at'] ?? '',
            'caller_name' => $callerName,
            'caller_email' => $primary['caller_email'] ?? '',
            'caller_status_name' => $primary['caller_status_name'] ?? '',
            'assigned_by_name' => $assignedByName,
        ];
    }, $rows);

    /*
     * The priority is no longer attached here.
     *
     * This used to be a second classification pass over $mapped -- three more
     * queries and a second call to pdo_classify_student() for every student
     * already classified a moment earlier. follow_up_queue_apply() does it
     * once, on the rows it has to classify anyway to decide the band, and the
     * map above carries the result through.
     */
    return $mapped;
}

/**
 * The board row for one student, so a write can answer with what it produced.
 *
 * Searches the combined queue, not the priority band: a student assigned from the
 * survey tab is not at risk, and looking only at the default band would answer a
 * successful write with "student not found".
 */
function find_student_row(PDO $pdo, ?array $authUser, int $studentId): ?array {
    foreach (fetch_assignment_rows($pdo, null, $authUser, FOLLOW_UP_QUEUE_ALL) as $row) {
        if ((int)($row['student_id'] ?? 0) === $studentId) {
            return $row;
        }
    }

    return null;
}

/** Lowercase, single-spaced, letters and digits only - for matching a typed name. */
function coach_import_name_key(string $value): string {
    $value = mb_strtolower(trim($value));
    $value = preg_replace('/[^\p{L}\p{N}]+/u', ' ', $value) ?? '';
    return trim(preg_replace('/\s+/', ' ', $value) ?? '');
}

/**
 * Read a coach file and work out, per student, who their coach becomes.
 *
 * The file needs two columns - the student number and the coach (their email,
 * or their name as it appears on their account) - and may carry a third,
 * Coaching Unit, which is checked rather than trusted. Each row lands as one of
 * three outcomes, and the dry run reports them without writing:
 *
 *   assigned     the student had no coach
 *   reassigned   they had one; it is replaced, and the old name is reported
 *   unchanged    that person is already their coach
 *
 * A row that cannot be matched is skipped with its line number and the reason,
 * and nothing is guessed: a name matching two coaches asks for the email.
 *
 * Only the caller's own students can be matched - a supervisor's file is read
 * against their cohort, so a number from the other cohort is "not found" like
 * a number that does not exist, and the coach must be from the student's unit.
 * Every write happens in one transaction, so an import is all or nothing.
 */
function coach_import_run(PDO $pdo, ?array $authUser, string $content, bool $dryRun, int $sessionUserId, array $assignmentWindow): array {
    $rows = sheetimport_parse($content);
    if (count($rows) > SHEETIMPORT_MAX_ROWS + 1) {
        api_out(422, ['message' => 'The file has more than ' . SHEETIMPORT_MAX_ROWS . ' rows. Split it and import each part.']);
    }

    $headerMap = [
        'studentnumber' => 'student_number',
        'studentno' => 'student_number',
        'studentnum' => 'student_number',
        'idnumber' => 'student_number',
        'idno' => 'student_number',
        'coach' => 'coach',
        'coachemail' => 'coach',
        'coachname' => 'coach',
        'coachaccount' => 'coach',
        'assignedcoach' => 'coach',
        'sspadviser' => 'coach',
        'fromfacultysspadviser' => 'coach',
        'adviser' => 'coach',
        'coachingunit' => 'coaching_unit',
        'unit' => 'coaching_unit',
    ];
    [$headerIndex, $columns] = sheetimport_locate_header($rows, $headerMap, ['student_number', 'coach']);
    if ($headerIndex === null) {
        api_out(422, ['message' => 'No header row with "Student Number" and "Coach" columns was found. Download the template to see the layout.']);
    }

    // The caller's students, keyed by number - their cohort only.
    $studentWhere = ['archived_at IS NULL'];
    $studentParams = [];
    api_apply_student_type_scope($studentWhere, $studentParams, $authUser, '`star e-profile`', ':student_type_scope');
    $studentStmt = $pdo->prepare(
        'SELECT student_id, student_number, first_name, last_name, `star e-profile` AS student_type
           FROM student WHERE ' . implode(' AND ', $studentWhere)
    );
    $studentStmt->execute($studentParams);
    $studentsByNumber = [];
    foreach ($studentStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $studentsByNumber[strtoupper(trim((string)$row['student_number']))] = $row;
    }

    // Every coach account, findable by email and by name.
    $coachRoleIds = student_coach_role_ids();
    $coachStmt = $pdo->prepare(
        'SELECT user_id, first_name, last_name, email, role AS role_id, status
           FROM user WHERE role IN (' . implode(',', array_fill(0, count($coachRoleIds), '?')) . ')'
    );
    $coachStmt->execute($coachRoleIds);
    $coachesByEmail = [];
    $coachesByName = [];
    foreach ($coachStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $coach) {
        $coach['name'] = trim(((string)$coach['first_name']) . ' ' . ((string)$coach['last_name']));
        $email = mb_strtolower(trim((string)$coach['email']));
        if ($email !== '') {
            $coachesByEmail[$email] = $coach;
        }
        $keys = array_unique(array_filter([
            coach_import_name_key($coach['first_name'] . ' ' . $coach['last_name']),
            coach_import_name_key($coach['last_name'] . ' ' . $coach['first_name']),
        ]));
        foreach ($keys as $key) {
            $coachesByName[$key][(int)$coach['user_id']] = $coach;
        }
    }

    $currentCoaches = student_coaches_by_student($pdo, array_map(
        static fn (array $row): int => (int)$row['student_id'],
        array_values($studentsByNumber)
    ));

    $plan = [];
    $errors = [];
    $seenOnLine = [];
    $rowsRead = 0;

    for ($i = $headerIndex + 1; $i < count($rows); $i++) {
        $cells = $rows[$i];
        $line = $i + 1;
        $number = trim((string)($cells[$columns['student_number']] ?? ''));
        $coachText = trim((string)($cells[$columns['coach']] ?? ''));
        $unitText = isset($columns['coaching_unit']) ? trim((string)($cells[$columns['coaching_unit']] ?? '')) : '';

        if ($number === '' && $coachText === '' && $unitText === '') {
            continue;
        }
        $rowsRead++;

        if ($number === '') {
            $errors[] = "Line $line: no student number.";
            continue;
        }
        $student = $studentsByNumber[strtoupper($number)] ?? null;
        if ($student === null) {
            $errors[] = "Line $line: $number is not one of your students.";
            continue;
        }
        if (isset($seenOnLine[$number])) {
            $errors[] = "Line $line: $number is already on line {$seenOnLine[$number]}; this row was skipped.";
            continue;
        }
        $seenOnLine[$number] = $line;

        $studentId = (int)$student['student_id'];
        $unit = student_coaching_unit($student['student_type'] ?? null);
        $coachRole = student_coach_role_for_type($student['student_type'] ?? null);
        if ($unit === null || $coachRole === null) {
            $errors[] = "Line $line: $number has no STAR / Non-STAR type, so there is no coaching unit to assign from.";
            continue;
        }
        if ($unitText !== '' && strcasecmp($unitText, $unit) !== 0) {
            $errors[] = "Line $line: the file says $unitText, but $number is coached by $unit.";
            continue;
        }
        if ($coachText === '') {
            $errors[] = "Line $line: no coach given for $number.";
            continue;
        }

        if (strpos($coachText, '@') !== false) {
            $coach = $coachesByEmail[mb_strtolower($coachText)] ?? null;
            $matches = $coach ? [$coach] : [];
        } else {
            $matches = array_values($coachesByName[coach_import_name_key($coachText)] ?? []);
        }
        if (count($matches) > 1) {
            $errors[] = "Line $line: \"$coachText\" matches more than one coach. Use their email instead.";
            continue;
        }
        $coach = $matches[0] ?? null;
        if ($coach === null) {
            $errors[] = "Line $line: no coach account matches \"$coachText\".";
            continue;
        }
        if ((int)$coach['role_id'] !== $coachRole) {
            $coachUnit = STUDENT_COACHING_UNIT_BY_ROLE[(int)$coach['role_id']] ?? 'another unit';
            $errors[] = "Line $line: {$coach['name']} is a $coachUnit coach, but $number is coached by $unit.";
            continue;
        }
        if ((int)$coach['status'] !== 1) {
            $errors[] = "Line $line: {$coach['name']}'s account is inactive.";
            continue;
        }

        $current = $currentCoaches[$studentId] ?? null;
        $outcome = coach_plan_outcome($current, (int)$coach['user_id']);

        $plan[] = [
            'line' => $line,
            'student_id' => $studentId,
            'student_number' => $number,
            'student_name' => trim(((string)$student['last_name']) . ', ' . ((string)$student['first_name']), ', '),
            'coach_user_id' => (int)$coach['user_id'],
            'coach_name' => $coach['name'],
            'previous_coach' => $current['name'] ?? null,
            'outcome' => $outcome,
        ];
    }

    return coach_plan_commit($pdo, $plan, $errors, $rowsRead, $dryRun, $sessionUserId, $assignmentWindow, 'Imported from a coach file');
}

/**
 * Write a coach plan and report it - the last step of the coach import and of
 * the board's Assign for ticked rows, shared so the two cannot drift.
 *
 * Each planned row is one student and the coach they end with, already sorted
 * into assigned, reassigned or unchanged. Only rows that change something are
 * written, all in one transaction behind one window check, so a batch lands
 * whole or not at all.
 */
function coach_plan_commit(PDO $pdo, array $plan, array $errors, int $rowsRead, bool $dryRun, int $sessionUserId, array $assignmentWindow, ?string $notes): array {
    $changes = array_values(array_filter($plan, static fn (array $row): bool => $row['outcome'] !== 'unchanged'));

    if (!$dryRun && $changes) {
        // Putting someone on a student is the windowed act, as on the board.
        if ($assignmentWindow['reason'] !== null) {
            api_out(422, ['message' => $assignmentWindow['reason'], 'assignment_window' => $assignmentWindow]);
        }

        $pdo->beginTransaction();
        try {
            foreach ($changes as $change) {
                student_set_coach($pdo, $change['student_id'], $change['coach_user_id'], $sessionUserId, $notes);
            }
            $pdo->commit();
        } catch (Throwable $e) {
            $pdo->rollBack();
            throw $e;
        }
    }

    $count = static fn (string $outcome): int => count(array_filter($plan, static fn (array $row): bool => $row['outcome'] === $outcome));
    $describe = static fn (array $row): string => $row['outcome'] === 'reassigned'
        ? "{$row['student_number']} {$row['student_name']}: {$row['previous_coach']} -> {$row['coach_name']}"
        : "{$row['student_number']} {$row['student_name']}: {$row['coach_name']}";

    return [
        'dry_run' => $dryRun,
        'summary' => [
            'rows_read' => $rowsRead,
            'assigned' => $count('assigned'),
            'reassigned' => $count('reassigned'),
            'unchanged' => $count('unchanged'),
            'skipped' => count($errors),
        ],
        'details' => [
            'row_errors' => array_slice($errors, 0, SHEETIMPORT_SAMPLE_LIMIT),
            'reassigned' => array_slice(array_map($describe, array_values(array_filter($plan, static fn (array $row): bool => $row['outcome'] === 'reassigned'))), 0, SHEETIMPORT_SAMPLE_LIMIT),
            'assigned' => array_slice(array_map($describe, array_values(array_filter($plan, static fn (array $row): bool => $row['outcome'] === 'assigned'))), 0, SHEETIMPORT_SAMPLE_LIMIT),
        ],
    ];
}

/**
 * What giving this coach does to a student whose current coach is $current
 * (a student_coaches_by_student() entry, or null for none).
 */
function coach_plan_outcome(?array $current, int $coachUserId): string {
    if ($current === null) {
        return 'assigned';
    }
    return (int)$current['user_id'] === $coachUserId && (int)$current['coach_count'] === 1 ? 'unchanged' : 'reassigned';
}

/**
 * Give every ticked student on the board one coach - the row's Assign /
 * Reassign, for many rows at once.
 *
 * Each student ends with this coach and no other, whoever they had before,
 * because a student has one coach (student_set_coach()). Every student is
 * checked the way a single row is - on the board, in this account's cohort, of
 * the coach's unit - and one that fails is skipped by name while the rest go
 * ahead, written by the import's own last step.
 */
function coach_bulk_run(PDO $pdo, ?array $authUser, $studentIds, int $coachUserId, int $sessionUserId, array $assignmentWindow, ?string $notes = null): array {
    $studentIds = is_array($studentIds)
        ? array_values(array_unique(array_filter(array_map('intval', $studentIds), static fn (int $id): bool => $id > 0)))
        : [];
    if (!$studentIds) {
        api_out(400, ['message' => 'Tick the students to give a coach to.']);
    }
    // The import's ceiling, for the same reason: every change is one transaction.
    if (count($studentIds) > SHEETIMPORT_MAX_ROWS) {
        api_out(422, ['message' => 'Give a coach to at most ' . SHEETIMPORT_MAX_ROWS . ' students at a time.']);
    }

    // The coach, checked once for the whole batch.
    $coach = fetch_ssp_caller($pdo, $coachUserId);
    $coachRole = (int)($coach['role_id'] ?? 0);
    if (!$coach || !in_array($coachRole, student_coach_role_ids(), true)) {
        api_out(400, ['message' => 'Choose a coach - an SSP Caller or KASAMA account.']);
    }
    if ((int)($coach['status'] ?? 0) !== 1) {
        api_out(422, ['message' => 'That coach\'s account is inactive.']);
    }
    $coachName = trim(((string)($coach['first_name'] ?? '')) . ' ' . ((string)($coach['last_name'] ?? '')));
    $coachUnit = STUDENT_COACHING_UNIT_BY_ROLE[$coachRole] ?? 'another unit';

    // The ticked students this account may see: its own cohort, as on the board.
    // Named placeholders throughout - the cohort scope binds a named one, and
    // PDO refuses a statement that mixes the two kinds.
    $params = [];
    foreach ($studentIds as $index => $studentId) {
        $params[":student_$index"] = $studentId;
    }
    $where = ['archived_at IS NULL', 'student_id IN (' . implode(', ', array_keys($params)) . ')'];
    api_apply_student_type_scope($where, $params, $authUser, '`star e-profile`', ':student_type_scope');
    $stmt = $pdo->prepare(
        'SELECT student_id, student_number, first_name, last_name, `star e-profile` AS student_type
           FROM student WHERE ' . implode(' AND ', $where)
    );
    $stmt->execute($params);
    $students = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $students[(int)$row['student_id']] = $row;
    }

    $onBoard = array_flip(students_pending_enrollment_update($pdo, array_keys($students)));
    $currentCoaches = student_coaches_by_student($pdo, array_keys($students));

    $plan = [];
    $errors = [];
    foreach ($studentIds as $studentId) {
        $student = $students[$studentId] ?? null;
        if ($student === null) {
            $errors[] = "Student #$studentId is not one of your students.";
            continue;
        }
        $name = trim(((string)$student['last_name']) . ', ' . ((string)$student['first_name']), ', ');
        $label = trim(((string)$student['student_number']) . ' ' . $name);
        if (!isset($onBoard[$studentId])) {
            $errors[] = "$label does not need an enrollment update, so it is not on the board.";
            continue;
        }
        $unit = student_coaching_unit($student['student_type'] ?? null);
        if ($unit === null) {
            $errors[] = "$label has no STAR / Non-STAR type, so there is no coaching unit to assign from.";
            continue;
        }
        if (student_coach_role_for_type($student['student_type'] ?? null) !== $coachRole) {
            $errors[] = "$coachName is a $coachUnit coach, but $label is coached by $unit.";
            continue;
        }

        $current = $currentCoaches[$studentId] ?? null;
        $plan[] = [
            'student_id' => $studentId,
            'student_number' => (string)$student['student_number'],
            'student_name' => $name,
            'coach_user_id' => $coachUserId,
            'coach_name' => $coachName,
            'previous_coach' => $current['name'] ?? null,
            'outcome' => coach_plan_outcome($current, $coachUserId),
        ];
    }

    return coach_plan_commit($pdo, $plan, $errors, count($studentIds), false, $sessionUserId, $assignmentWindow, $notes);
}

/**
 * A supervisor's overview: how many students are theirs, and their coaches.
 *
 * "Theirs" is the whole cohort they supervise - every live Non-STAR student for
 * the SSP Coordinator, every STAR one for the KSH TL. The overview used to count
 * the board's current queue band instead, which is a different number on every
 * tab and was labelled as if it were the caseload. The coaches are the team's
 * worker role (SSP Callers, KASAMA), each with how many of the cohort's students
 * are assigned to them.
 *
 * Null for anyone who does not supervise a team, Admin included: Admin holds
 * both cohorts and has no single one to summarise.
 */
function fetch_team_overview(PDO $pdo, ?array $authUser): ?array {
    // Only the supervisor has a team to look over.
    if (!ssp_is_team_supervisor($authUser)) {
        return null;
    }
    $studentType = api_student_type_for_role_id((int)($authUser['role_id'] ?? 0));
    $coachRoleId = (int)api_follow_up_team_role_ids($studentType)[0];

    $total = $pdo->prepare('SELECT COUNT(*) FROM student WHERE archived_at IS NULL AND `star e-profile` = :type');
    $total->execute([':type' => $studentType]);
    $studentsTotal = (int)$total->fetchColumn();

    // Assignments are counted over the live cohort only, so an archived student,
    // or one whose type changed after assignment, is not counted as theirs.
    $cohortJoin = 'JOIN student s ON s.student_id = sa.student_id
                               AND s.archived_at IS NULL
                               AND s.`star e-profile` = :type';

    $coachStmt = $pdo->prepare(
        "SELECT u.user_id, u.first_name, u.last_name, u.email, u.status, st.status_name,
                COALESCE(a.assigned_students, 0) AS assigned_students
           FROM user u
      LEFT JOIN status st ON st.status_id = u.status
      LEFT JOIN (
                SELECT sa.caller_user_id, COUNT(DISTINCT sa.student_id) AS assigned_students
                  FROM ssp_assignment sa
                  $cohortJoin
              GROUP BY sa.caller_user_id
           ) a ON a.caller_user_id = u.user_id
          WHERE u.role = :coach_role
       ORDER BY CASE WHEN u.status = 1 THEN 0 ELSE 1 END, u.first_name, u.last_name, u.user_id"
    );
    $coachStmt->execute([':type' => $studentType, ':coach_role' => $coachRoleId]);

    $coaches = [];
    $activeCoaches = 0;
    foreach ($coachStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $active = (int)($row['status'] ?? 0) === 1;
        $activeCoaches += $active ? 1 : 0;
        $coaches[] = [
            'user_id' => (int)$row['user_id'],
            'first_name' => $row['first_name'] ?? '',
            'last_name' => $row['last_name'] ?? '',
            'email' => $row['email'] ?? '',
            'is_active' => $active,
            'status_name' => $row['status_name'] ?? '',
            'assigned_students' => (int)$row['assigned_students'],
        ];
    }

    // Distinct students, not a sum of the column above: two coaches can share a
    // student, and the sum would then count that student twice.
    $withCoachStmt = $pdo->prepare(
        "SELECT COUNT(DISTINCT sa.student_id)
           FROM ssp_assignment sa
           $cohortJoin
           JOIN user u ON u.user_id = sa.caller_user_id AND u.role = :coach_role"
    );
    $withCoachStmt->execute([':type' => $studentType, ':coach_role' => $coachRoleId]);
    $withCoach = (int)$withCoachStmt->fetchColumn();

    return [
        'student_type' => $studentType,
        'students_total' => $studentsTotal,
        'students_with_coach' => $withCoach,
        'students_without_coach' => max(0, $studentsTotal - $withCoach),
        'coaches_total' => count($coaches),
        'coaches_active' => $activeCoaches,
        'coaches' => $coaches,
    ];
}

try {
    $db = new Database();
    $pdo = $db->connect();
    ensure_ssp_assignment_table($pdo);

    $authUser = api_get_session_user();

    // Authorisation has already happened. api_bootstrap_auth() runs on every
    // endpoint out of connection-pdo.php and is method aware, so reaching this
    // line means the caller holds assignments:view for GET, :create for POST,
    // :edit for PUT and :delete for DELETE — exactly what the Access Management
    // panel grants.
    //
    // Deciding access a second time here with a hardcoded role list is what
    // made this module unreachable: Admin is granted every action on
    // ssp-assignments in the panel, passed the gate, and was then refused by
    // this file because "admin" is not literally ssp-coordinator or ssp-caller.
    //
    // Roles still decide *which* board you get, because that is a data-scoping
    // question rather than a permission one.
    // KSH TL supervises the Star board exactly as the SSP Coordinator supervises
    // the Nonstar one, so it gets the coordinator's view rather than a caller's.
    $isCoordinator = api_session_user_has_role($authUser, ['ssp-coordinator', 'ksh-tl']);
    $isCaller = api_session_user_has_role($authUser, ['ssp-caller', 12]);
    $sessionUserId = (int)($authUser['user_id'] ?? 0);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    /*
     * Read once and used by both the GET (to describe the window) and the
     * writes (to enforce it), so the board can never be told one thing and
     * refused on another.
     */
    $currentPeriod = assignment_window_current_period($pdo);
    $assignmentWindow = assignment_window_state($currentPeriod);

    if ($method === 'GET') {
        // The overview's numbers alone, without classifying the whole queue.
        if (($_GET['view'] ?? '') === 'team_overview') {
            api_out(200, ['team_overview' => fetch_team_overview($pdo, $authUser)]);
        }

        $queue = follow_up_queue_normalize($_GET['queue'] ?? null);
        // Counts for both tabs regardless of which one is being shown, so the
        // header can say how much is waiting on the other one.
        $queueCounts = follow_up_queue_counts($pdo, api_student_type_scope_for_user($authUser));

        // A caller sees the students assigned to them and nobody else's.
        if ($isCaller && !$isCoordinator) {
            api_out(200, [
                'assignments' => fetch_assignment_rows($pdo, $sessionUserId, $authUser, $queue),
                'queue' => $queue,
                'queue_counts' => $queueCounts,
                'enrollment_term' => ssp_enrollment_target_term($pdo),
                'can_auto_assign' => false,
                // A caller cannot assign at all, but the board still says when
                // assignment happens rather than leaving the tab unexplained.
                'assignment_window' => $assignmentWindow,
            ]);
        }

        api_out(200, [
            'callers' => fetch_follow_up_team_members($pdo, $authUser),
            'students' => fetch_assignment_rows($pdo, null, $authUser, $queue),
            'queue' => $queue,
            'queue_counts' => $queueCounts,
            // The cohort this board is limited to, or null for both. Lets the
            // page drop a STAR / Non-STAR filter that could only ever match one.
            'student_type_scope' => api_student_type_scope_for_user($authUser),
            // Which term the Enrollment Status column is about, for its header.
            'enrollment_term' => ssp_enrollment_target_term($pdo),
            // Off for the two supervisors; they choose each coach themselves.
            // The POST below refuses it too, so hiding the button is not the rule.
            'can_auto_assign' => !ssp_is_team_supervisor($authUser),
            /*
             * The rule the server will apply, sent so the page describes it
             * from what was actually applied rather than from its own copy.
             * Without this the board would have to know the periodical AND
             * the rule, and the two could drift.
             */
            'assignment_window' => $assignmentWindow,
        ]);
    }

    if ($method === 'POST' || $method === 'PUT') {
        // Being assigned work is not permission to hand it out.
        if ($isCaller && !$isCoordinator) {
            api_out(403, ['message' => 'Forbidden']);
        }

        // The coach file. Multipart, so it is answered before the JSON body is read.
        if ($method === 'POST' && ($_GET['action'] ?? '') === 'import_coaches') {
            [$content, $uploadError] = sheetimport_read_upload($_FILES['file'] ?? null);
            if ($uploadError !== null) {
                api_out(400, ['message' => $uploadError]);
            }
            $dryRun = in_array(strtolower((string)($_POST['dry_run'] ?? $_GET['dry_run'] ?? '')), ['1', 'true', 'yes'], true);
            api_out(200, coach_import_run($pdo, $authUser, $content, $dryRun, $sessionUserId, $assignmentWindow));
        }

        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            api_out(400, ['message' => 'Invalid JSON']);
        }

        // Many students, one coach: the rows ticked on the board.
        if ($method === 'POST' && ($_GET['action'] ?? '') === 'set_coach') {
            api_out(200, coach_bulk_run(
                $pdo,
                $authUser,
                $payload['student_ids'] ?? null,
                (int)($payload['caller_user_id'] ?? 0),
                $sessionUserId,
                $assignmentWindow,
                as_nullable_text($payload['notes'] ?? null)
            ));
        }

        $studentId = isset($payload['student_id']) ? (int)$payload['student_id'] : 0;
        $callerUserId = isset($payload['caller_user_id']) ? (int)$payload['caller_user_id'] : 0;
        $auto = !empty($payload['auto']);
        $notes = as_nullable_text($payload['notes'] ?? null);

        /*
         * The SSP Coordinator and KSH TL assign by hand (requested 2026-09-24):
         * auto-assign picks the least-loaded coach, which is a decision these
         * supervisors make themselves. Admin keeps it. First, so the answer is
         * the same whichever student was sent.
         */
        if ($auto && ssp_is_team_supervisor($authUser)) {
            api_out(403, ['message' => 'Auto-assign is turned off for team supervisors. Choose the coach for each student.']);
        }
        if ($studentId <= 0) {
            api_out(400, ['message' => 'student_id is required']);
        }
        if (!$auto && $callerUserId <= 0) {
            api_out(400, ['message' => 'caller_user_id is required']);
        }
        if (!has_pending_enrollment_update($pdo, $studentId)) {
            api_out(400, ['message' => 'Selected student does not need an enrollment update assignment']);
        }

        $studentRow = api_fetch_student_access_row($pdo, $studentId);
        $studentType = (string)($studentRow['student_type'] ?? '');

        // The board only lists this supervisor's cohort; a student id from the
        // other one is refused here rather than trusted from the list.
        if ($studentRow && !api_student_type_is_allowed($authUser, $studentType)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }

        // ------------------------------------------------------------------
        // Automatic: the least-loaded coach of the student's unit.
        // ------------------------------------------------------------------
        if ($auto) {
            /*
             * The row this branch writes is a new assignment, so the window
             * covers it. Checked before the transaction opens: there is nothing
             * to roll back, and the caller gets the sentence rather than a 500.
             */
            if ($assignmentWindow['reason'] !== null) {
                api_out(422, ['message' => $assignmentWindow['reason'], 'assignment_window' => $assignmentWindow]);
            }
            if (student_coach_role_for_type($studentType) === null) {
                api_out(422, [
                    'message' => 'This student is neither STAR nor Non-STAR, so there is no coaching unit to assign.',
                ]);
            }
            if (isset(student_coaches_by_student($pdo, [$studentId])[$studentId])) {
                api_out(422, ['message' => 'This student already has a coach. Choose another coach to reassign them.']);
            }

            $picked = pick_coach($pdo, $studentType);
            if ($picked === null) {
                api_out(422, ['message' => 'No active ' . student_coaching_unit($studentType) . ' coach account exists to assign.']);
            }

            $pdo->beginTransaction();
            try {
                student_set_coach($pdo, $studentId, (int)$picked['user_id'], $sessionUserId, $notes);
                $pdo->commit();
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }

            $pickedName = trim(((string)($picked['first_name'] ?? '')) . ' ' . ((string)($picked['last_name'] ?? '')));
            api_out(201, [
                'message' => sprintf('%s is now this student\'s coach.', $pickedName !== '' ? $pickedName : 'The coach'),
                'data' => find_student_row($pdo, $authUser, $studentId),
            ]);
        }

        // ------------------------------------------------------------------
        // Manual: make one named coach the student's coach.
        // ------------------------------------------------------------------
        $callerRow = fetch_ssp_caller($pdo, $callerUserId);
        if (!$callerRow) {
            api_out(400, ['message' => 'Selected user is not on the SSP or KASAMA coaching team.']);
        }

        /*
         * Only a coach is assigned to a student (2026-10-01). A supervisor was
         * once added beside the coach as the second half of a pair, and the
         * board then listed them under the student as a second coach.
         */
        if (!in_array((int)($callerRow['role_id'] ?? 0), student_coach_role_ids(), true)) {
            api_out(422, [
                'message' => sprintf(
                    '%s (%s) is not a coach. A student is assigned one coach: an SSP Caller for Non-STAR, a KASAMA for STAR.',
                    trim(((string)($callerRow['first_name'] ?? '')) . ' ' . ((string)($callerRow['last_name'] ?? ''))) ?: 'This user',
                    (string)($callerRow['role_name'] ?? 'supervisor')
                ),
            ]);
        }

        // Enforced here and not only in the dropdown, because a mismatched
        // pairing saves cleanly and then hides the student from the very person
        // assigned to them.
        $mismatch = assignment_type_mismatch(
            $studentType,
            api_follow_up_team_type_for_role_id((int)($callerRow['role_id'] ?? 0))
        );
        if ($mismatch !== null) {
            api_out(422, ['message' => $mismatch]);
        }

        /*
         * A coach REPLACES the coach (requested 2026-09-24): a student has one,
         * and choosing another is a reassignment, not a second coach. The old
         * one is removed in the same transaction and named in the reply.
         */
        if ((int)($callerRow['status'] ?? 0) !== 1) {
            api_out(422, ['message' => 'That coach\'s account is inactive.']);
        }

        $pdo->beginTransaction();
        try {
            $current = student_coaches_by_student($pdo, [$studentId])[$studentId] ?? null;
            $isNoOp = $current !== null
                && (int)$current['user_id'] === $callerUserId
                && (int)$current['coach_count'] === 1;
            if (!$isNoOp && $assignmentWindow['reason'] !== null) {
                $pdo->rollBack();
                api_out(422, ['message' => $assignmentWindow['reason'], 'assignment_window' => $assignmentWindow]);
            }
            $outcome = student_set_coach($pdo, $studentId, $callerUserId, $sessionUserId, $notes);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $e;
        }

        $coachName = trim(((string)($callerRow['first_name'] ?? '')) . ' ' . ((string)($callerRow['last_name'] ?? '')));
        $message = $outcome['result'] === 'reassigned'
            ? sprintf('Reassigned from %s to %s.', implode(' and ', $outcome['previous']), $coachName)
            : ($outcome['result'] === 'unchanged'
                ? sprintf('%s is already this student\'s coach.', $coachName)
                : sprintf('%s is now this student\'s coach.', $coachName));

        api_out($outcome['result'] === 'unchanged' ? 200 : 201, [
            'message' => $message,
            'result' => $outcome['result'],
            'data' => find_student_row($pdo, $authUser, $studentId),
        ]);
    }

    if ($method === 'DELETE') {
        if ($isCaller && !$isCoordinator) {
            api_out(403, ['message' => 'Forbidden']);
        }

        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $assignmentId = isset($query['assignment_id']) ? (int)$query['assignment_id'] : 0;
        if ($assignmentId <= 0) {
            api_out(400, ['message' => 'assignment_id is required']);
        }

        // The other cohort's teams are not this supervisor's to take apart.
        $owner = $pdo->prepare(
            'SELECT s.`star e-profile` AS student_type
               FROM ssp_assignment sa
               JOIN student s ON s.student_id = sa.student_id
              WHERE sa.assignment_id = :assignment_id
              LIMIT 1'
        );
        $owner->execute([':assignment_id' => $assignmentId]);
        $ownerRow = $owner->fetch(PDO::FETCH_ASSOC);
        if ($ownerRow && !api_student_type_is_allowed($authUser, $ownerRow['student_type'] ?? null)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }

        $stmt = $pdo->prepare('DELETE FROM ssp_assignment WHERE assignment_id = :assignment_id');
        $stmt->execute([':assignment_id' => $assignmentId]);

        api_out(200, ['message' => 'Assignment removed']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
