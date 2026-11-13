<?php
/**
 * What each caller on a supervisor's team has actually done.
 *
 * Two supervisors, two teams, one screen. API_FOLLOW_UP_TEAMS in auth.php
 * already pairs them:
 *
 *   Non-STAR  SSP Caller (6) works the students, SSP Coordinator (5) supervises
 *   STAR      KASAMA (12) works the students,    KSH TL (7) supervises
 *
 * The team is read from that constant rather than listed again here. It is the
 * same mapping the assignment board validates against and the contact workspace
 * scopes by, and a second copy is how the three quietly stop agreeing about who
 * works for whom.
 *
 * The one difference between the two supervisors is what they may do once they
 * have looked. A KSH TL calls students themselves - they are a working team
 * leader - while an SSP Coordinator monitors and assigns and does not make the
 * calls. That is `can_record_contact` below, and it is decided here rather than
 * in the browser: a flag the client computes is a flag the client can change.
 *
 * GET team_monitor.php                          the roster, with each worker's numbers
 * GET team_monitor.php?action=worker&user_id=   one worker's students and attempts
 */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/contact_vocabulary.php';
require_once __DIR__ . '/student_contact_workflow_lib.php';
// For monitor_department_student_count(): the academic board's context number
// has to be the same population the faculty board shows.
require_once __DIR__ . '/lib/faculty_workspace.php';

function monitor_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * Which workers this account supervises, and whether it may call as well.
 *
 * Returns null for an account that supervises nobody, which is the honest
 * answer for every role that is not a team leader - including the workers
 * themselves. A caller must not be able to open a board of their own
 * colleagues' numbers.
 *
 * Admin gets both teams. Not because an admin is a supervisor, but because an
 * admin is the account that has to be able to see the thing is working at all,
 * and showing them one team would raise a support question every time.
 */
/**
 * The academic side of the board: a Dean or Program Head over their faculty.
 *
 * A third team, and deliberately not a third entry in API_FOLLOW_UP_TEAMS. That
 * constant maps a STUDENT TYPE to the pair who chase it — Non-STAR to the SSP
 * pair, STAR to the KASAMA pair — and this supervision is not about a student
 * type at all. A Dean supervises by DEPARTMENT, over every student in it
 * regardless of cohort, so writing it into that constant would have made
 * api_student_type_for_role_id() and the assignment board answer a question
 * nobody asked them.
 */
const MONITOR_ACADEMIC_SUPERVISOR_ROLE_IDS = [3, 14]; // Dean, Program Head
const MONITOR_FACULTY_ROLE_ID = 15;

/**
 * The two boards an academic supervisor can switch between.
 *
 * Sent to the client rather than hardcoded there, so the filter shows exactly
 * the boards the server will actually serve. A key the server does not know
 * falls back to 'faculty' below rather than erroring - a stale bookmark should
 * land on a board, not on a message.
 */
const MONITOR_ACADEMIC_BOARDS = [
    ['key' => 'faculty', 'label' => 'Faculty'],
    // Key kept as 'callers' so bookmarks and the client still resolve; the
    // office calls these people coaches.
    ['key' => 'callers', 'label' => 'Coaches'],
    /*
     * The same work read from the other end. Faculty and Callers answer "what
     * has each of my staff done"; this one answers "which of my students has
     * anybody actually spoken to", which is the question a retention office is
     * really asking and which the first two can only answer one staff member at
     * a time. A dean wanting the students their faculty contacted was opening
     * every teacher in turn and adding the lists up in their head.
     */
    ['key' => 'students', 'label' => 'Students'],
];

/** [worker role, supervisor role] per cohort, straight from the constant. */
function monitor_follow_up_teams(): array
{
    $teams = [];
    foreach (API_FOLLOW_UP_TEAMS as $type => $roleIds) {
        // The constant carries the pre-2026-08-21 spellings too, mapping to the
        // same pair. Keyed by the pair so those collapse instead of producing a
        // duplicate team with an old name on it.
        $key = implode(',', $roleIds);
        $teams[$key] = [
            'worker_role_id' => (int)$roleIds[0],
            'supervisor_role_id' => (int)$roleIds[1],
            'student_type' => api_student_type_for_role_id((int)$roleIds[0]),
        ];
    }

    return array_values($teams);
}

function monitor_resolve_supervision(?array $authUser, string $board = ''): ?array
{
    $roleId = isset($authUser['role_id']) ? (int)$authUser['role_id'] : 0;
    $teams = monitor_follow_up_teams();

    if (in_array($roleId, MONITOR_ACADEMIC_SUPERVISOR_ROLE_IDS, true)) {
        /*
         * Scoped to the supervisor's own department, read the same way the
         * faculty workspace reads it. A Program Head does the dean's work on
         * the dean's department, so the two get the identical board rather than
         * a second one — the difference between them is which department they
         * are pinned to, and that is already decided upstream.
         *
         * An unpinned account of either role would scope to nothing, so it is
         * refused rather than shown the whole college: this board names
         * colleagues and counts their work, and "everyone, because your pin is
         * missing" is not a safe default for that.
         */
        $departmentId = (int)($authUser['department_id'] ?? $authUser['department'] ?? 0);
        if ($departmentId <= 0) {
            return null;
        }

        if ($board === 'students') {
            /*
             * One row per student instead of one per staff member, so there is
             * no team on this board and no roster to build.
             *
             * It counts EVERY logged contact on the department's students, not
             * only the faculty ones. The dean asked for the students their
             * faculty had spoken to, and those are here - but a board titled
             * "Students" that silently dropped the SSP and KASAMA calls would
             * report a student as never contacted while the Callers tab two
             * inches away showed the call. Who made it is a column, so the
             * faculty work is still legible on its own.
             *
             * Nothing new is disclosed by that: every caller holding one of
             * these students is already on the Callers board, by the same
             * department rule.
             */
            return [
                'scope' => 'department',
                'board' => 'students',
                'boards' => MONITOR_ACADEMIC_BOARDS,
                // No worker roster, so no teams. monitor_team_rows() is never
                // called on this board; the guard for opening a row checks the
                // student list instead, in the same build-it-and-search-it way.
                'teams' => [],
                'department_id' => $departmentId,
                'scope_by' => 'students',
                /*
                 * Both vocabularies at once: a row can carry a faculty
                 * periodical outcome or a follow-up one depending on who made
                 * the last attempt. The two key sets are disjoint, which is
                 * what makes one merged lookup safe.
                 */
                'vocabulary' => 'mixed',
                'has_caseload' => false,
                'can_record_contact' => false,
                'supervisor_role_id' => $roleId,
            ];
        }

        if ($board === 'callers') {
            /*
             * The same department, reached through the students instead of
             * through the staff.
             *
             * Faculty BELONG to a department, so the faculty board filters on
             * `u.department` and is done. SSP Callers and KASAMA coaches belong
             * to no department at all - they work a COHORT across the whole
             * college - so that filter would hand a dean an empty board, or
             * worse, whichever caller happens to carry their department id in a
             * profile field nobody maintains.
             *
             * What ties a caller to a dean is the STUDENT. A dean sees a caller
             * because that caller holds students in their department, and must
             * see only the part of the caseload that is theirs: caller #7
             * carries 83 students, 5 of them CITE, and the CITE dean is shown
             * the 5. So the scoping is by the student's department and it is
             * applied inside every count on the row - not to the row list
             * afterwards, which would leave the numbers describing a college.
             */
            return [
                'scope' => 'department',
                'board' => 'callers',
                'boards' => MONITOR_ACADEMIC_BOARDS,
                'teams' => $teams,
                'department_id' => $departmentId,
                'scope_by' => 'students',
                // Callers write the follow-up words wherever they are read from.
                'vocabulary' => 'intervention',
                // A caller does have a personal caseload, so Assigned and
                // Coverage mean something here even though the board is a
                // dean's. See monitor_team_rows() for why faculty do not.
                'has_caseload' => true,
                /*
                 * A dean may not log an SSP call. This is not their team: the
                 * SSP Coordinator assigns these students and the callers ring
                 * them, and a contact logged by a dean would arrive with no
                 * assignment behind it.
                 */
                'can_record_contact' => false,
                'supervisor_role_id' => $roleId,
            ];
        }

        return [
            'scope' => 'department',
            'board' => 'faculty',
            'boards' => MONITOR_ACADEMIC_BOARDS,
            'teams' => [[
                'worker_role_id' => MONITOR_FACULTY_ROLE_ID,
                'supervisor_role_id' => $roleId,
                // Faculty work whoever is in the department; there is no cohort
                // split on this side of the board.
                'student_type' => null,
            ]],
            'department_id' => $departmentId,
            // Faculty are pinned to the department, so the staff list is the
            // filter. The callers board above scopes by the student instead.
            'scope_by' => 'staff',
            /*
             * Which set of outcome words this team's attempts are written in.
             * Faculty record continuing / shifting / stopping / undecided; the
             * follow-up teams record recovered / not_recovered / referred and
             * the rest. The two lists share no keys, so a board that summed one
             * against the other would report every faculty attempt as having no
             * outcome at all.
             */
            'vocabulary' => 'faculty',
            'has_caseload' => false,
            /*
             * A dean monitors; they do not log periodical contacts from here.
             * Those are written in the Faculty Workspace, which is where the
             * term stamp and the three intervention gates live.
             */
            'can_record_contact' => false,
            'supervisor_role_id' => $roleId,
        ];
    }

    if ($roleId === 1) {
        return [
            'scope' => 'all',
            'teams' => $teams,
            // An admin acting on either team's behalf has to be able to record
            // what that team did, or the outcome is simply unrecordable.
            'can_record_contact' => true,
            'supervisor_role_id' => 1,
            // Both follow-up teams write the intervention vocabulary. The
            // academic board is a separate supervision above, so an admin sees
            // the follow-up teams here exactly as before.
            'department_id' => null,
            'scope_by' => null,
            'vocabulary' => 'intervention',
            'has_caseload' => true,
            'board' => null,
            'boards' => [],
        ];
    }

    foreach ($teams as $team) {
        if ($team['supervisor_role_id'] === $roleId) {
            return [
                'scope' => 'team',
                'teams' => [$team],
                /*
                 * The KSH TL calls; the SSP Coordinator does not.
                 *
                 * Role 7 is a working team leader on the STAR cohort - they
                 * carry students of their own and make calls. Role 5 runs the
                 * assignment board for Non-STAR and monitors the callers who
                 * make them. Both are on their team in API_FOLLOW_UP_TEAMS,
                 * which is about who a student is assigned to; this is about who
                 * picks up the phone, and they are not the same question.
                 */
                'can_record_contact' => $roleId === 7,
                'supervisor_role_id' => $roleId,
                'department_id' => null,
                'scope_by' => null,
                'vocabulary' => 'intervention',
                'has_caseload' => true,
                'board' => null,
                'boards' => [],
            ];
        }
    }

    return null;
}

/**
 * How many students the department holds, counted the way the faculty see it.
 *
 * Deliberately `faculty_workspace_students()` rather than a COUNT(*) written
 * here: that function is what decides which students appear on a faculty
 * member's board -- non-archived, joined through course to the department --
 * and a second definition of "the department's students" would drift from it
 * the first time either changed. The dean's context number has to be the same
 * number the faculty are working from, or the two screens describe different
 * departments.
 */
function monitor_department_student_count(PDO $pdo, int $departmentId): int
{
    if ($departmentId <= 0) {
        return 0;
    }

    return count(faculty_workspace_students($pdo, $departmentId, []));
}

/** The worker role ids this account supervises, flattened. */
function monitor_worker_role_ids(array $supervision): array
{
    return array_values(array_unique(array_map(
        static fn(array $team): int => $team['worker_role_id'],
        $supervision['teams']
    )));
}

/**
 * The roster: one row per worker, with what they have done.
 *
 * Every worker on the team appears, including one who has done nothing. A
 * roster that silently omits the caller with no attempts hides exactly the row
 * a supervisor opened this screen to find.
 */
function monitor_team_rows(PDO $pdo, array $supervision): array
{
    $roleIds = monitor_worker_role_ids($supervision);
    if (empty($roleIds)) {
        return [];
    }

    $placeholders = implode(',', array_fill(0, count($roleIds), '?'));

    $departmentId = isset($supervision['department_id']) ? (int)$supervision['department_id'] : 0;
    $scopeBy = (string)($supervision['scope_by'] ?? '');

    /*
     * Two ways to be department-scoped, and they filter different things.
     *
     * 'staff'    — the faculty board. Faculty are pinned to a department, so
     *              the filter is on the staff row itself. The `user` table's
     *              column is `department`, not `department_id`; the latter is
     *              the payload key.
     *
     * 'students' — the callers board. Callers belong to no department, so the
     *              filter goes on the STUDENTS behind each number: a caller
     *              appears because they hold students here, and every count on
     *              their row is of this department's students only. Applied
     *              inside the subqueries rather than to the rows afterwards,
     *              because filtering after the fact would leave a dean reading
     *              college-wide totals under a departmental heading.
     *
     * Bound rather than interpolated even though it is an int by the time it
     * gets here, so the query has no string-built predicate to audit later.
     * Parameters are positional, so they are appended in the order the
     * placeholders appear in the SQL text below: assignment subquery, attempt
     * subquery, role list, staff clause.
     */
    $params = [];
    $studentJoin = '';
    $assignmentWhere = '';
    $attemptWhere = '';
    $departmentClause = '';
    $withStudentsClause = '';

    if ($departmentId > 0 && $scopeBy === 'students') {
        /*
         * Archived students are left out on purpose: they are not in the
         * department's population as the faculty board counts it, so counting
         * them here would give the dean two different sizes for one department.
         */
        $studentJoin = '
              JOIN student s ON s.student_id = %s.student_id AND s.archived_at IS NULL
              JOIN course  c ON c.course_id  = s.course_id';
        $assignmentWhere = 'WHERE c.department_id = ?';
        $attemptWhere = 'WHERE c.department_id = ?';
        $params[] = $departmentId;
        $params[] = $departmentId;

        /*
         * A caller with nothing left after the scoping is not on this board.
         *
         * The roster otherwise lists every worker on the team including the one
         * who has done nothing, because that row is the finding. Here it is not
         * the same row: a caller with no students in this department is not
         * this dean's business at all, and naming a colleague plus their
         * college-wide role on a board they have no part in is a disclosure
         * that answers no question.
         */
        $withStudentsClause = 'AND (COALESCE(a.assigned_students, 0) > 0 OR COALESCE(t.total_attempts, 0) > 0)';
    }

    $params = array_merge($params, $roleIds);

    if ($departmentId > 0 && $scopeBy === 'staff') {
        $departmentClause = 'AND u.department = ?';
        $params[] = $departmentId;
    }

    $assignmentJoin = $studentJoin !== '' ? sprintf($studentJoin, 'asg') : '';
    $attemptJoin = $studentJoin !== '' ? sprintf($studentJoin, 'att') : '';

    /*
     * Three sources, joined per worker:
     *
     *   ssp_assignment          how many students they are responsible for
     *   student_contact_attempt what they have logged
     *   the outcome columns     how those attempts ended
     *
     * Aggregated in subqueries rather than in one grouped join: a worker with
     * 40 assignments and 12 attempts would otherwise produce 480 rows and count
     * each assignment twelve times.
     */
    $sql = "
        SELECT
            u.user_id,
            u.first_name,
            u.last_name,
            u.email,
            u.role AS role_id,
            r.role_name,
            COALESCE(a.assigned_students, 0)   AS assigned_students,
            COALESCE(t.students_contacted, 0)  AS students_contacted,
            COALESCE(t.total_attempts, 0)      AS total_attempts,
            COALESCE(t.recovered, 0)           AS recovered,
            COALESCE(t.not_recovered, 0)       AS not_recovered,
            COALESCE(t.referred, 0)            AS referred,
            COALESCE(t.follow_up, 0)           AS follow_up,
            COALESCE(t.unreachable, 0)         AS unreachable,
            COALESCE(t.no_outcome, 0)          AS no_outcome,
            COALESCE(t.continuing, 0)          AS continuing,
            COALESCE(t.shifting, 0)            AS shifting,
            COALESCE(t.stopping, 0)            AS stopping,
            COALESCE(t.undecided, 0)           AS undecided,
            t.last_contacted_at
        FROM user u
        LEFT JOIN role r ON r.role_id = u.role
        LEFT JOIN (
            SELECT asg.caller_user_id, COUNT(DISTINCT asg.student_id) AS assigned_students
              FROM ssp_assignment asg$assignmentJoin
             $assignmentWhere
             GROUP BY asg.caller_user_id
        ) a ON a.caller_user_id = u.user_id
        LEFT JOIN (
            SELECT
                att.attempted_by_user_id,
                COUNT(DISTINCT att.student_id) AS students_contacted,
                COUNT(*)                       AS total_attempts,
                MAX(att.contacted_at)          AS last_contacted_at,
                SUM(att.intervention_status = 'recovered')           AS recovered,
                SUM(att.intervention_status = 'not_recovered')       AS not_recovered,
                SUM(att.intervention_status = 'referred_to_csdl')    AS referred,
                SUM(att.intervention_status IN ('cbr_follow_up', 'undecided_follow_up')) AS follow_up,
                SUM(att.intervention_status = 'unreachable')         AS unreachable,
                SUM(att.intervention_status IS NULL OR att.intervention_status = '')     AS no_outcome,
                /*
                 * The faculty vocabulary, summed in the same pass. Four more
                 * SUMs over a table already being scanned costs nothing, and
                 * computing both sets here keeps one query for both kinds of
                 * team -- the row simply reports whichever set its own team
                 * writes in. The two lists share no keys, so neither can
                 * contaminate the other's counts.
                 */
                SUM(att.intervention_status = 'continuing') AS continuing,
                SUM(att.intervention_status = 'shifting')   AS shifting,
                SUM(att.intervention_status = 'stopping')   AS stopping,
                SUM(att.intervention_status = 'undecided')  AS undecided
              FROM student_contact_attempt att$attemptJoin
             $attemptWhere
             GROUP BY att.attempted_by_user_id
        ) t ON t.attempted_by_user_id = u.user_id
        WHERE u.role IN ($placeholders)
        $departmentClause
        $withStudentsClause
        ORDER BY COALESCE(t.total_attempts, 0) DESC, u.last_name, u.first_name";

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $rows = [];
    $isAcademic = ($supervision['vocabulary'] ?? 'intervention') === 'faculty';
    // Whether a row's worker has a caseload of their own. Not the same question
    // as which board this is: the dean's callers board is academic in every
    // other sense, and its rows do have one.
    $hasCaseload = ($supervision['has_caseload'] ?? true) !== false;

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $assigned = (int)$row['assigned_students'];
        $contacted = (int)$row['students_contacted'];

        $rows[] = [
            'user_id' => (int)$row['user_id'],
            'name' => trim(((string)$row['first_name']) . ' ' . ((string)$row['last_name'])),
            'email' => $row['email'] ?? null,
            'role_id' => (int)$row['role_id'],
            'role_name' => $row['role_name'] ?? '',
            'student_type' => api_student_type_for_role_id((int)$row['role_id']),
            /*
             * NULL for faculty, and that is the honest answer rather than a
             * missing feature.
             *
             * `assigned_students` counts rows in ssp_assignment, which is how a
             * caller gets a personal caseload. Faculty have no such thing: the
             * Faculty Workspace is scoped by DEPARTMENT, so every faculty
             * member in a department is looking at the same students. Reporting
             * that shared total on each row would read as a personal caseload
             * and turn one department's student count into a per-person
             * denominator -- so a teacher who spoke to thirty students would
             * show the same coverage as a colleague who spoke to none, divided
             * by a number neither of them owns.
             *
             * With no denominator there is no coverage, and the board says so
             * by leaving both null. The department total is reported once, in
             * the totals, where it means something.
             */
            'assigned_students' => $hasCaseload ? $assigned : null,
            'students_contacted' => $contacted,
            'total_attempts' => (int)$row['total_attempts'],
            /*
             * Of the students this worker is responsible for, what share have
             * they reached at least once. Null rather than 0 when nobody is
             * assigned: 0% reads as "has not called anyone", and "has nobody to
             * call" is a different problem with a different fix.
             */
            'coverage_percent' => ($hasCaseload && $assigned > 0)
                ? round($contacted / $assigned * 100, 1)
                : null,
            'outcomes' => $isAcademic
                ? [
                    'continuing' => (int)$row['continuing'],
                    'shifting' => (int)$row['shifting'],
                    'stopping' => (int)$row['stopping'],
                    'undecided' => (int)$row['undecided'],
                    'no_outcome' => (int)$row['no_outcome'],
                ]
                : [
                    'recovered' => (int)$row['recovered'],
                    'not_recovered' => (int)$row['not_recovered'],
                    'referred' => (int)$row['referred'],
                    'follow_up' => (int)$row['follow_up'],
                    'unreachable' => (int)$row['unreachable'],
                    'no_outcome' => (int)$row['no_outcome'],
                ],
            'last_contacted_at' => $row['last_contacted_at'] ?? null,
        ];
    }

    return $rows;
}

/**
 * One worker's students: who they are responsible for and what has happened.
 *
 * A LEFT JOIN from the assignment, not from the attempt, so an assigned student
 * nobody has called yet appears with an empty row rather than not at all. That
 * student is the whole point of the screen.
 */
/**
 * One faculty member's periodical contacts, student by student.
 *
 * A separate query from monitor_worker_students() because the two start from
 * different places, not because the SELECT differs. That one reads
 * `FROM ssp_assignment` -- the caller's caseload -- and lists the students they
 * were given, including the ones they have not rung yet, which is the whole
 * value of it for a coordinator.
 *
 * Faculty have no rows in ssp_assignment at all, so the same query returns an
 * empty list for every one of them: a dean would click a teacher with forty
 * logged contacts and be shown nothing. The honest starting point on this side
 * is the attempts themselves -- who this teacher has actually spoken to. There
 * is no "not yet contacted" list to show, because the department's whole roster
 * belongs to every faculty member in it equally and is already one click away
 * on the faculty board.
 */
function monitor_faculty_worker_students(PDO $pdo, int $workerUserId, int $studentDepartmentId = 0): array
{
    /*
     * The same department filter the roster counted with, applied again here.
     *
     * The number on the roster row and the list behind it have to describe one
     * population, or a dean clicks "5" and is handed eight names. It also keeps
     * the department boundary on the detail view rather than only on the list:
     * a faculty account that has moved departments still has its old contacts
     * in student_contact_attempt, and those belong to the other dean's board.
     */
    [$scopeClause, $scopeParams] = monitor_student_department_scope($studentDepartmentId);

    $stmt = $pdo->prepare("
        SELECT
            s.student_id,
            s.student_number,
            TRIM(CONCAT(COALESCE(s.first_name, ''), ' ', COALESCE(s.last_name, ''))) AS student_name,
            s.`star e-profile` AS student_type,
            s.year_level,
            s.mobile_number,
            s.email_address,
            c.course_code,
            COUNT(att.attempt_id) AS attempts,
            MAX(att.contacted_at) AS last_contacted_at,
            -- Same separator reasoning as monitor_worker_students(): the
            -- faculty vocabulary is continuing / shifting / stopping /
            -- undecided, none of which contains a comma.
            SUBSTRING_INDEX(
                GROUP_CONCAT(
                    COALESCE(att.intervention_status, '')
                    ORDER BY att.contacted_at DESC, att.attempt_id DESC
                    SEPARATOR ','
                ),
                ',', 1
            ) AS latest_outcome
        FROM student_contact_attempt att
        JOIN student s ON s.student_id = att.student_id
        LEFT JOIN course c ON c.course_id = s.course_id
       WHERE att.attempted_by_user_id = :worker
         $scopeClause
    GROUP BY s.student_id, s.student_number, student_name, s.`star e-profile`,
             s.year_level, s.mobile_number, s.email_address, c.course_code
    ORDER BY last_contacted_at DESC, s.last_name, s.first_name");
    $stmt->execute([':worker' => $workerUserId] + $scopeParams);

    $labels = faculty_periodical_outcome_labels();

    return array_map(static function (array $row) use ($labels): array {
        $outcome = trim((string)($row['latest_outcome'] ?? ''));
        return [
            'student_id' => (int)$row['student_id'],
            'student_number' => $row['student_number'] ?? '',
            'student_name' => $row['student_name'] ?? '',
            'student_type' => $row['student_type'] ?? null,
            'year_level' => $row['year_level'] !== null ? (int)$row['year_level'] : null,
            'course_code' => $row['course_code'] ?? null,
            'contact' => $row['mobile_number'] ?: ($row['email_address'] ?: null),
            'attempts' => (int)$row['attempts'],
            'last_contacted_at' => $row['last_contacted_at'] ?? null,
            'latest_outcome' => $outcome !== '' ? ($labels[$outcome] ?? $outcome) : null,
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
}

/**
 * The department predicate shared by the roster and the two detail queries.
 *
 * One text, used in three places, so "this department's students" cannot come
 * to mean two slightly different things depending on which query a reader
 * happens to be looking at. Returns an empty clause for an unscoped board,
 * which leaves those queries exactly as they were.
 */
function monitor_student_department_scope(int $studentDepartmentId): array
{
    if ($studentDepartmentId <= 0) {
        return ['', []];
    }

    return [
        'AND c.department_id = :scope_department AND s.archived_at IS NULL',
        [':scope_department' => $studentDepartmentId],
    ];
}

function monitor_worker_students(PDO $pdo, int $workerUserId, int $studentDepartmentId = 0): array
{
    // A dean opening a caller sees the part of that caseload which is theirs,
    // not all 83 students the caller carries across the college. Without this
    // the roster would say 5 and the list would show the lot.
    [$scopeClause, $scopeParams] = monitor_student_department_scope($studentDepartmentId);

    $stmt = $pdo->prepare("
        SELECT
            s.student_id,
            s.student_number,
            TRIM(CONCAT(COALESCE(s.first_name, ''), ' ', COALESCE(s.last_name, ''))) AS student_name,
            s.`star e-profile` AS student_type,
            s.year_level,
            s.mobile_number,
            s.email_address,
            c.course_code,
            COUNT(att.attempt_id)   AS attempts,
            MAX(att.contacted_at)   AS last_contacted_at,
            -- The most recent attempt's outcome. A comma is a safe separator
            -- here because intervention_status holds keys from a fixed
            -- vocabulary - recovered, referred_to_csdl, cbr_follow_up - and
            -- none of them contains one.
            SUBSTRING_INDEX(
                GROUP_CONCAT(
                    COALESCE(att.intervention_status, '')
                    ORDER BY att.contacted_at DESC, att.attempt_id DESC
                    SEPARATOR ','
                ),
                ',', 1
            ) AS latest_outcome
        FROM ssp_assignment asg
        JOIN student s ON s.student_id = asg.student_id
        LEFT JOIN course c ON c.course_id = s.course_id
        LEFT JOIN student_contact_attempt att
               ON att.student_id = asg.student_id
              AND att.attempted_by_user_id = asg.caller_user_id
       WHERE asg.caller_user_id = :worker
         $scopeClause
    GROUP BY s.student_id, s.student_number, student_name, s.`star e-profile`,
             s.year_level, s.mobile_number, s.email_address, c.course_code
    ORDER BY attempts ASC, s.last_name, s.first_name");
    $stmt->execute([':worker' => $workerUserId] + $scopeParams);

    $labels = student_intervention_status_labels();

    return array_map(static function (array $row) use ($labels): array {
        $outcome = trim((string)($row['latest_outcome'] ?? ''));
        return [
            'student_id' => (int)$row['student_id'],
            'student_number' => $row['student_number'] ?? '',
            'student_name' => $row['student_name'] ?? '',
            'student_type' => $row['student_type'] ?? null,
            'year_level' => $row['year_level'] !== null ? (int)$row['year_level'] : null,
            'course_code' => $row['course_code'] ?? null,
            'contact' => $row['mobile_number'] ?: ($row['email_address'] ?: null),
            'attempts' => (int)$row['attempts'],
            'last_contacted_at' => $row['last_contacted_at'] ?? null,
            // The stored key resolved to the word the sheet uses, so the column
            // reads as "REFERRED TO CSDL" rather than as "referred_to_csdl".
            'latest_outcome' => $outcome !== '' ? ($labels[$outcome] ?? $outcome) : null,
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
}

/**
 * Both outcome vocabularies in one lookup.
 *
 * The students board mixes them by design: a row's latest attempt may have been
 * a faculty periodical contact (continuing / shifting / stopping / undecided) or
 * a follow-up call (recovered / referred_to_csdl / ...), and the column has to
 * print whichever it was. The union is safe precisely because the two key sets
 * are disjoint - the same fact the roster's double SUM relies on. A key added to
 * both lists would break that, and would break the roster first.
 */
function monitor_contact_outcome_labels(): array
{
    return faculty_periodical_outcome_labels() + student_intervention_status_labels();
}

/**
 * Every student in the department somebody has spoken to, and who spoke to them.
 *
 * Read from the ATTEMPTS rather than from the department's roster, so the list
 * is of students who have actually been contacted. The students nobody has
 * reached are the other half of the picture and they are not missing: the header
 * reports this count against the department's full population, and the Faculty
 * Workspace lists the whole roster a click away. Putting 247 never-contacted
 * rows here would bury the 5 rows this board exists to show.
 *
 * Two queries rather than a GROUP_CONCAT of staff names. The concatenated form
 * needs a separator that cannot occur in a person's name, and "cannot occur in a
 * name" is a promise about human names that no delimiter keeps.
 */
function monitor_department_contacted_students(PDO $pdo, int $departmentId): array
{
    if ($departmentId <= 0) {
        return [];
    }

    $scope = 'JOIN student s ON s.student_id = att.student_id AND s.archived_at IS NULL
              JOIN course  c ON c.course_id  = s.course_id
             WHERE c.department_id = :department';

    $stmt = $pdo->prepare("
        SELECT
            s.student_id,
            s.student_number,
            TRIM(CONCAT(COALESCE(s.first_name, ''), ' ', COALESCE(s.last_name, ''))) AS student_name,
            s.`star e-profile` AS student_type,
            s.year_level,
            s.section,
            s.mobile_number,
            s.email_address,
            c.course_code,
            COUNT(att.attempt_id)                     AS attempts,
            COUNT(DISTINCT att.attempted_by_user_id)  AS staff_count,
            MAX(att.contacted_at)                     AS last_contacted_at,
            -- The outcome of the most recent attempt, by the same
            -- SUBSTRING_INDEX-of-an-ordered-GROUP_CONCAT the two worker queries
            -- use. No key in either vocabulary contains a comma.
            SUBSTRING_INDEX(
                GROUP_CONCAT(
                    COALESCE(att.intervention_status, '')
                    ORDER BY att.contacted_at DESC, att.attempt_id DESC
                    SEPARATOR ','
                ),
                ',', 1
            ) AS latest_outcome
        FROM student_contact_attempt att
        $scope
    GROUP BY s.student_id, s.student_number, student_name, s.`star e-profile`,
             s.year_level, s.section, s.mobile_number, s.email_address, c.course_code
    ORDER BY last_contacted_at DESC, s.last_name, s.first_name");
    $stmt->execute([':department' => $departmentId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Who spoke to each of them, one entry per staff member per student.
    $byStudent = [];
    $staff = $pdo->prepare("
        SELECT
            att.student_id,
            att.attempted_by_user_id AS user_id,
            TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS name,
            r.role_name,
            COUNT(att.attempt_id) AS attempts,
            MAX(att.contacted_at) AS last_contacted_at
        FROM student_contact_attempt att
        LEFT JOIN user u ON u.user_id = att.attempted_by_user_id
        LEFT JOIN role r ON r.role_id = u.role
        $scope
    GROUP BY att.student_id, att.attempted_by_user_id, name, r.role_name
    ORDER BY last_contacted_at DESC");
    $staff->execute([':department' => $departmentId]);

    foreach ($staff->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $byStudent[(int)$row['student_id']][] = [
            'user_id' => $row['user_id'] !== null ? (int)$row['user_id'] : null,
            // A contact whose author has since been deleted still happened, and
            // the student's row should not lose an attempt over it.
            'name' => trim((string)$row['name']) !== '' ? trim((string)$row['name']) : 'Unknown staff',
            'role_name' => $row['role_name'] ?? '',
            'attempts' => (int)$row['attempts'],
        ];
    }

    $labels = monitor_contact_outcome_labels();

    return array_map(static function (array $row) use ($byStudent, $labels): array {
        $id = (int)$row['student_id'];
        $outcome = trim((string)($row['latest_outcome'] ?? ''));

        return [
            'student_id' => $id,
            'student_number' => $row['student_number'] ?? '',
            'student_name' => $row['student_name'] ?? '',
            'student_type' => $row['student_type'] ?? null,
            'year_level' => $row['year_level'] !== null ? (int)$row['year_level'] : null,
            'section' => $row['section'] ?? null,
            'course_code' => $row['course_code'] ?? null,
            'contact' => $row['mobile_number'] ?: ($row['email_address'] ?: null),
            'attempts' => (int)$row['attempts'],
            'staff_count' => (int)$row['staff_count'],
            'contacted_by' => $byStudent[$id] ?? [],
            'last_contacted_at' => $row['last_contacted_at'] ?? null,
            'latest_outcome' => $outcome !== '' ? ($labels[$outcome] ?? $outcome) : null,
        ];
    }, $rows);
}

/**
 * One student's contacts, newest first.
 *
 * The department predicate is repeated here rather than trusted from the list
 * that found the student, so this cannot be turned into a way to read any
 * student's contact history by editing student_id. The handler checks the list
 * as well - both, because one is the guard and the other is the query being
 * guarded, and a later refactor is likelier to move one than both.
 */
function monitor_student_contact_history(PDO $pdo, int $studentId, int $departmentId): array
{
    if ($studentId <= 0 || $departmentId <= 0) {
        return [];
    }

    $stmt = $pdo->prepare("
        SELECT
            att.attempt_id,
            att.contacted_at,
            att.contact_method,
            att.other_method_label,
            att.contact_status,
            att.intervention_status,
            att.period,
            att.attempted_by_user_id AS user_id,
            TRIM(CONCAT(COALESCE(u.first_name, ''), ' ', COALESCE(u.last_name, ''))) AS staff_name,
            r.role_name
        FROM student_contact_attempt att
        JOIN student s ON s.student_id = att.student_id AND s.archived_at IS NULL
        JOIN course  c ON c.course_id  = s.course_id
        LEFT JOIN user u ON u.user_id = att.attempted_by_user_id
        LEFT JOIN role r ON r.role_id = u.role
       WHERE att.student_id = :student
         AND c.department_id = :department
    ORDER BY att.contacted_at DESC, att.attempt_id DESC");
    $stmt->execute([':student' => $studentId, ':department' => $departmentId]);

    $labels = monitor_contact_outcome_labels();

    return array_map(static function (array $row) use ($labels, $pdo): array {
        $outcome = trim((string)($row['intervention_status'] ?? ''));
        $name = trim((string)($row['staff_name'] ?? ''));

        return [
            'attempt_id' => (int)$row['attempt_id'],
            'contacted_at' => $row['contacted_at'] ?? null,
            // Both resolved to the words the sheet uses, so the modal reads as
            // "Call / text" and "REFERRED TO CSDL" rather than as stored keys.
            'method' => student_contact_channel_label($pdo, $row['contact_method'] ?? '', $row['other_method_label'] ?? null),
            'contact_status' => student_contact_status_label($row['contact_status'] ?? ''),
            'outcome' => $outcome !== '' ? ($labels[$outcome] ?? $outcome) : null,
            'period' => $row['period'] !== null ? (int)$row['period'] : null,
            'staff_name' => $name !== '' ? $name : 'Unknown staff',
            'role_name' => $row['role_name'] ?? '',
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
}

try {
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        monitor_out(401, ['message' => 'Authentication required']);
    }

    /*
     * Which board, from the query string - and it grants nothing.
     *
     * monitor_resolve_supervision() decides what this account may see; the
     * parameter only chooses between the boards that account already has. An
     * SSP Coordinator passing board=faculty is resolved by their role exactly
     * as before, and an unrecognised value falls back to the faculty board
     * rather than erroring.
     */
    $board = strtolower(trim((string)($_GET['board'] ?? '')));

    $supervision = monitor_resolve_supervision($authUser, $board);
    if ($supervision === null) {
        /*
         * 403 and nothing else. This board is a list of named colleagues and
         * how much work each has done, so "who may open it" is the whole of its
         * access control - there is no partial view that would be safe to show
         * a caller about their own team.
         */
        monitor_out(403, ['message' => 'This account does not supervise a follow-up team.']);
    }

    $pdo = (new Database())->connect();

    /*
     * The students board is a different shape, not a different filter, so it
     * answers here and returns rather than falling through to the roster. Its
     * rows are students; there is no worker list to build and nothing below
     * this point applies to it.
     */
    if (($supervision['board'] ?? '') === 'students') {
        $departmentId = (int)($supervision['department_id'] ?? 0);
        $students = monitor_department_contacted_students($pdo, $departmentId);

        if (($_GET['action'] ?? '') === 'student') {
            $studentId = isset($_GET['student_id']) ? (int)$_GET['student_id'] : 0;
            if ($studentId <= 0) {
                monitor_out(400, ['message' => 'student_id is required']);
            }

            /*
             * Checked against the list this board just built, the same way the
             * worker guard is checked against the roster. "Visible on my board"
             * and "openable from my board" have to be one question, or a dean
             * reads another department's student by editing the query string.
             */
            $match = null;
            foreach ($students as $row) {
                if ($row['student_id'] === $studentId) {
                    $match = $row;
                    break;
                }
            }
            if ($match === null) {
                monitor_out(404, ['message' => 'That student is not in your department, or nobody has contacted them yet.']);
            }

            monitor_out(200, ['data' => [
                'student' => $match,
                'attempts' => monitor_student_contact_history($pdo, $studentId, $departmentId),
                'board' => 'students',
            ]]);
        }

        $departmentStudents = monitor_department_student_count($pdo, $departmentId);

        // Distinct staff across the whole board: how many people the department's
        // contact record is the work of.
        $staffIds = [];
        foreach ($students as $row) {
            foreach ($row['contacted_by'] as $staff) {
                $staffIds[(string)($staff['user_id'] ?? $staff['name'])] = true;
            }
        }

        monitor_out(200, ['data' => [
            'students' => $students,
            'totals' => [
                'workers' => count($staffIds),
                'assigned_students' => $departmentStudents,
                'students_contacted' => count($students),
                'total_attempts' => array_sum(array_column($students, 'attempts')),
                /*
                 * The one board where a coverage figure is honest. Each student
                 * is counted once however many people rang them, and the
                 * denominator is the department they are actually in - so this
                 * cannot exceed 100% the way a sum of caseloads could.
                 */
                'coverage_percent' => $departmentStudents > 0
                    ? round(count($students) / $departmentStudents * 100, 1)
                    : null,
            ],
            'scope' => $supervision['scope'],
            'cohorts' => [],
            'can_record_contact' => false,
            'vocabulary' => $supervision['vocabulary'],
            'board' => 'students',
            'boards' => $supervision['boards'],
            'has_caseload' => false,
            // Both, because a row's latest outcome can come from either.
            'intervention_statuses' => monitor_contact_outcome_labels(),
        ]]);
    }

    if (($_GET['action'] ?? '') === 'worker') {
        $workerId = isset($_GET['user_id']) ? (int)$_GET['user_id'] : 0;
        if ($workerId <= 0) {
            monitor_out(400, ['message' => 'user_id is required']);
        }

        /*
         * The worker has to be on this supervisor's own team.
         *
         * Checked against the roster rather than against the role alone: it is
         * the same query the list was built from, so "visible on my board" and
         * "openable from my board" cannot come apart. Without it, a coordinator
         * could read any KASAMA's students by editing the query string.
         */
        $roster = monitor_team_rows($pdo, $supervision);
        $match = null;
        foreach ($roster as $row) {
            if ($row['user_id'] === $workerId) {
                $match = $row;
                break;
            }
        }
        if ($match === null) {
            monitor_out(404, ['message' => 'That user is not on your team.']);
        }

        $academic = ($supervision['vocabulary'] ?? 'intervention') === 'faculty';
        // Only the callers board narrows the detail by student department; the
        // faculty board's staff filter has already done that job, and passing
        // it again would be free but is passed anyway for the moved-faculty
        // case described on that function.
        $scopeDepartment = ($supervision['scope_by'] ?? '') !== ''
            ? (int)($supervision['department_id'] ?? 0)
            : 0;

        monitor_out(200, ['data' => [
            'worker' => $match,
            'students' => $academic
                ? monitor_faculty_worker_students($pdo, $workerId, $scopeDepartment)
                : monitor_worker_students($pdo, $workerId, $scopeDepartment),
            'can_record_contact' => (bool)$supervision['can_record_contact'],
            'vocabulary' => $supervision['vocabulary'] ?? 'intervention',
            'board' => $supervision['board'] ?? null,
        ]]);
    }

    $rows = monitor_team_rows($pdo, $supervision);

    // Totals from the rows themselves, so the header and the table can never
    // report two different numbers for the same team.
    $isAcademic = ($supervision['vocabulary'] ?? 'intervention') === 'faculty';
    $departmentScoped = ($supervision['scope_by'] ?? '') !== '' && $supervision['scope_by'] !== null;

    $totals = [
        'workers' => count($rows),
        /*
         * On either departmental board this is the DEPARTMENT's student count,
         * not a sum of caseloads.
         *
         * The faculty rows carry null for the reason given in
         * monitor_team_rows(), so summing them would produce 0 and read as "no
         * students". The caller rows do carry a number, but two callers can
         * hold the same student across cohorts and a duplicate account can hold
         * the same list twice, so that sum is not a population either. Counted
         * once, from the department itself, which is also the number the
         * faculty board shows.
         */
        'assigned_students' => $departmentScoped
            ? monitor_department_student_count($pdo, (int)$supervision['department_id'])
            : array_sum(array_column($rows, 'assigned_students')),
        'students_contacted' => array_sum(array_column($rows, 'students_contacted')),
        'total_attempts' => array_sum(array_column($rows, 'total_attempts')),
    ];
    /*
     * Left null on both departmental boards. Faculty share the department's
     * students, so the same student reached by two teachers is counted twice in
     * students_contacted -- a ratio against the department total could exceed
     * 100% and would not mean coverage in any case. The caller board divides by
     * the same department total and has the same problem across its two
     * cohorts. Per-row coverage is still reported there, where the numerator
     * and the denominator are one caller's own.
     */
    $totals['coverage_percent'] = (!$departmentScoped && $totals['assigned_students'] > 0)
        ? round($totals['students_contacted'] / $totals['assigned_students'] * 100, 1)
        : null;

    monitor_out(200, ['data' => [
        'team' => $rows,
        'totals' => $totals,
        'scope' => $supervision['scope'],
        'cohorts' => array_values(array_filter(array_map(
            static fn(array $team): ?string => $team['student_type'],
            $supervision['teams']
        ))),
        /*
         * The client shows or hides the "Log a call" action on this. It is not
         * what enforces the rule - student_contact_workflow.php decides that on
         * write - but the two are derived from the same role so they agree.
         */
        'can_record_contact' => (bool)$supervision['can_record_contact'],
        /*
         * Which words this board's outcome columns are in. The client renders
         * the labels it is given rather than holding its own copy of either
         * list, so adding an outcome on the server adds a column here.
         */
        'vocabulary' => $supervision['vocabulary'] ?? 'intervention',
        /*
         * Which board is being shown, and which ones this account may switch
         * to. `boards` is empty for everyone with only one, so the filter is
         * rendered by having somewhere to go rather than by a role test in the
         * browser.
         */
        'board' => $supervision['board'] ?? null,
        'boards' => $supervision['boards'] ?? [],
        // Whether these workers have a caseload of their own, which is what
        // decides the Assigned and Coverage columns. Not the same question as
        // the vocabulary: the dean's callers board answers yes to this and
        // 'intervention' to that.
        'has_caseload' => ($supervision['has_caseload'] ?? true) !== false,
        'intervention_statuses' => $isAcademic
            ? faculty_periodical_outcome_labels()
            : student_intervention_status_labels(),
    ]]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'team_monitor']);
    monitor_out(500, ['message' => 'Server error while loading the team monitor.']);
}
