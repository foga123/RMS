<?php
/**
 * The faculty workspace: three modules read as one, per periodical.
 *
 * Faculty were being asked to open Grades, then Attendance, then Finance, then
 * the retention board, and hold one student's situation in their head across
 * four screens. This answers the question those four visits were really asking
 * -- "which of my students is in trouble this periodical, and why" -- in one
 * place, and lets the answer be acted on without leaving it.
 *
 * It owns no scoring of its own. The priority, the grade colour, the attendance
 * status and the balance band all come from pdo_priority_lib.php, which is the
 * authority the caller screens and the prioritisation board already use. A
 * second implementation here would be a second answer to "is this student a
 * potential drop-out", and the two would disagree the week somebody tuned one.
 *
 * Split out of the endpoint so it can be exercised from the CLI: including an
 * endpoint runs the auth guard and exits.
 */

if (!defined('FACULTY_WORKSPACE_LIB_LOADED')) {
    define('FACULTY_WORKSPACE_LIB_LOADED', true);

require_once __DIR__ . '/../pdo_priority_lib.php';
require_once __DIR__ . '/../periodic_lib.php';
require_once __DIR__ . '/../contact_vocabulary.php';
// For student_contact_ensure_case() and student_contact_write_audit_log(),
// which faculty_record_periodical_contact() below writes through.
require_once __DIR__ . '/../student_contact_workflow_lib.php';
require_once __DIR__ . '/academic_calendar.php';
require_once __DIR__ . '/term_closure.php';

/**
 * A semester runs three periodicals; the detail view shows all of them.
 *
 * A function rather than a `const` because everything in this file lives inside
 * the include guard, and PHP will not declare a const inside a conditional
 * block. Same reason the retention policy file uses one.
 */
function faculty_workspace_periods(): array
{
    return [1, 2, 3];
}

/**
 * The students a faculty account may see: their own department, still enrolled.
 *
 * Department scoping is applied here as well as by the endpoint's own guard,
 * because this is what a future report or batch job would call, and "whose
 * students" must not depend on the caller remembering to ask.
 *
 * A faculty account with NO department reaches nobody rather than everybody.
 * Of the two ways to be wrong, an empty screen is the one somebody reports.
 */
function faculty_workspace_students(PDO $pdo, ?int $departmentId, array $filters = []): array
{
    $where = ['st.archived_at IS NULL'];
    $params = [];

    if ($departmentId !== null) {
        if ($departmentId <= 0) {
            return [];
        }
        /*
         * Always widened, because this parameter is never a chooser: every
         * caller passes the account's own department (or, in team_monitor.php,
         * the department a team belongs to). A faculty member on one CITE
         * campus answers for CITE.
         */
        $where[] = api_department_scope_sql('c.department_id');
        $params[':department_id'] = $departmentId;
    }

    $search = trim((string)($filters['search'] ?? ''));
    if ($search !== '') {
        $where[] = '(st.student_number LIKE :q OR st.first_name LIKE :q'
            . ' OR st.last_name LIKE :q OR st.section LIKE :q)';
        $params[':q'] = '%' . $search . '%';
    }

    $sql = 'SELECT
                st.student_id,
                st.student_number,
                st.first_name,
                st.last_name,
                st.email_address,
                st.mobile_number,
                st.year_level,
                st.section,
                st.`star e-profile` AS student_type,
                c.course_id,
                c.course_code,
                c.course_name,
                c.department_id,
                d.department_name
            FROM student st
            LEFT JOIN course c ON c.course_id = st.course_id
            LEFT JOIN department d ON d.department_id = c.department_id
            WHERE ' . implode(' AND ', $where) . '
            ORDER BY st.year_level ASC, st.section ASC, st.last_name ASC, st.first_name ASC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

/**
 * One row per student: who they are, and the three signals for ONE periodical.
 *
 * This is the mini-detail the list shows. It is deliberately the same shape the
 * PDO board produces, because it IS that -- pdo_classify_student() called with
 * the period the workspace is looking at, rather than a summary invented here.
 */
function faculty_workspace_rows(PDO $pdo, array $students, array $term): array
{
    if (empty($students)) {
        return [];
    }

    $ids = array_map(static function (array $student): int {
        return (int)$student['student_id'];
    }, $students);

    $settings = pdo_settings($pdo);
    $signals = pdo_load_signals(
        $pdo,
        $ids,
        $term['semester_id'] ?? null,
        $term['school_year_id'] ?? null,
        $term['period'] ?? null
    );
    $latestContact = faculty_latest_contacts($pdo, $ids, $term);

    $rows = [];
    foreach ($students as $student) {
        $id = (int)$student['student_id'];
        $classified = pdo_classify_student(
            $student,
            $signals['grades'][$id] ?? null,
            $signals['attendance'][$id] ?? null,
            $signals['finance'][$id] ?? null,
            $settings
        );

        $rows[] = $classified + [
            'email_address' => $student['email_address'] ?? null,
            'mobile_number' => $student['mobile_number'] ?? null,
            'department_name' => $student['department_name'] ?? null,
            /*
             * Whether this student has already been spoken to THIS periodical.
             * Without it the list cannot be worked down: every refresh looks
             * identical whether or not the last hour of calls happened.
             */
            'periodical_contact' => $latestContact[$id] ?? null,
        ];
    }

    return $rows;
}

/**
 * Whose students the board is answering for, in words the screen can print.
 *
 * The overview says "your department" three times and could not name it, which
 * is a small thing right up until somebody asks whether the numbers cover the
 * other campus. They do: a department is one row PER CAMPUS sharing a code, and
 * the scope widens by code -- CITE is two rows, and a faculty account sees
 * both. Nothing on screen said so, and "College of Information Technology"
 * alone still would not, because the reader has no reason to know the name
 * spans two places.
 *
 * Asked of the server rather than assembled in the browser on purpose. Whether
 * an account is pinned at all is API_DEPARTMENT_PINNED_ROLES' answer, and a
 * mirror of that list in the client would be a second place for it to be wrong
 * -- one that fails silently, by labelling an unpinned caller's college-wide
 * figures with whatever department happens to sit on their user row. Callers
 * carry one and are not pinned by it; see the note on faculty_workspace.php's
 * own $isPinned.
 *
 * $departmentId is null for an unpinned caller, which means the whole college.
 */
function faculty_workspace_scope(PDO $pdo, ?int $departmentId): array
{
    if ($departmentId === null || $departmentId <= 0) {
        return ['department_name' => null, 'department_code' => null, 'campus_count' => 0];
    }

    $statement = $pdo->prepare(
        /*
         * Counted exactly as api_department_scope_sql() widens -- every row
         * sharing the code, archived ones included. Adding `archived_at IS
         * NULL` here would read tidier and would be a different number from the
         * one the figures were drawn over: the scope clause carries no such
         * filter, so an archived campus's students are still on the board. A
         * label that disagrees with its own totals is worse than no label.
         */
        'SELECT d.department_name,
                d.department_code,
                (SELECT COUNT(*)
                   FROM department sibling
                  WHERE sibling.department_code = d.department_code) AS campus_count
           FROM department d
          WHERE d.department_id = :department_id'
    );
    $statement->execute([':department_id' => $departmentId]);
    $row = $statement->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        return ['department_name' => null, 'department_code' => null, 'campus_count' => 0];
    }

    return [
        'department_name' => $row['department_name'],
        'department_code' => $row['department_code'],
        // How many department rows share the code, which is how many campuses
        // the figures cover. 1 is the ordinary case and the screen says nothing
        // extra about it.
        'campus_count' => (int)$row['campus_count'],
    ];
}

/**
 * The most recent periodical this term actually holds marks for.
 *
 * Needed because "no grades are encoded for P2 yet" is a dead end on its own,
 * and the reader is one click from a screen that contradicts it. The PDO board
 * next door defaults `?period=` to null, which pdo_load_signals() reads as "the
 * latest periodical on record" -- so on the morning a periodical rolls over,
 * My Students reports nobody at risk while Potential Drop Outs ranks everyone
 * on last periodical's marks. Both are deliberate and they disagree in public.
 *
 * This does not resolve that. It lets the overview say WHERE the marks are, so
 * the contradiction reads as two questions rather than as a broken screen.
 *
 * Term-wide rather than department-scoped on purpose: it answers "has anybody
 * encoded P2 yet", which is a question about the registrar's calendar and not
 * about one department's students. Scoping it would cost a join across the
 * whole roster to refine a sentence.
 *
 * Returns null when the term holds no periodical marks at all, which is a
 * different thing from "the current one is empty" and is left unsaid.
 */
function faculty_latest_graded_period(PDO $pdo, array $term): ?int
{
    /*
     * Built rather than written as `:x IS NULL OR col = :x`, which needs the
     * same placeholder twice -- and a named placeholder used twice is the
     * emulated-prepares trap this codebase has been bitten by before.
     */
    $where = ['g.period IS NOT NULL'];
    $params = [];

    if (($term['semester_id'] ?? null) !== null) {
        $where[] = 'g.semester_id = :semester_id';
        $params[':semester_id'] = (int)$term['semester_id'];
    }
    if (($term['school_year_id'] ?? null) !== null) {
        $where[] = 'g.school_year_id = :school_year_id';
        $params[':school_year_id'] = (int)$term['school_year_id'];
    }

    $statement = $pdo->prepare(
        'SELECT MAX(g.period) FROM grades g WHERE ' . implode(' AND ', $where)
    );
    $statement->execute($params);
    $latest = $statement->fetchColumn();

    return $latest === null || $latest === false ? null : (int)$latest;
}

/**
 * Has this student been dealt with for this periodical?
 *
 * One reading of `periodical_contact` for every caller, because "contacted" is
 * a word two of them used to mean two things. A row carrying an "Undecided -
 * for follow up" outcome HAS been contacted and has NOT been dealt with, and
 * every list that takes students off itself has to agree about which of those
 * it means or the same student gets rung twice by two people -- or, worse, once
 * and never again.
 *
 * Reads the flag faculty_latest_contacts() stamps, and falls back to the
 * outcome itself so a row assembled somewhere else still gets the right answer
 * rather than silently counting as settled.
 */
function faculty_row_is_settled(array $row): bool
{
    $contact = $row['periodical_contact'] ?? null;
    if (!is_array($contact)) {
        return false;
    }
    if (array_key_exists('settled', $contact)) {
        return (bool)$contact['settled'];
    }
    return faculty_outcome_is_settled($contact['intervention_status'] ?? ($contact['outcome'] ?? null));
}

/**
 * How many students the landing snapshot names before it stops and counts the rest.
 *
 * A function rather than a `const` for the reason faculty_workspace_periods()
 * is: everything in this file lives inside the include guard, and PHP will not
 * declare a const inside a conditional block.
 */
function faculty_overview_shortlist_size(): int
{
    return 5;
}

/**
 * The handful of students the faculty overview opens with.
 *
 * Flagged AND not yet spoken to in this periodical, worst band first. Both
 * halves matter: priority alone names the same five students every morning
 * however much calling gets done, which is how a shortlist stops being read.
 * `periodical_contact` is what lets the list empty out as the work happens, and
 * it resets when the calendar moves on because a P1 conversation is not an
 * answer about P2.
 *
 * Sorted with a stable sort (PHP 8.0 and later), so students sharing a band
 * keep the roster order the query returned them in rather than shuffling
 * between refreshes for no reason a reader could explain.
 */
function faculty_overview_shortlist(array $rows): array
{
    $waiting = array_values(array_filter($rows, static function (array $row): bool {
        return in_array((int)($row['priority'] ?? 0), PDO_FLAGGED_PRIORITIES, true)
            && !faculty_row_is_settled($row);
    }));

    usort($waiting, static function (array $a, array $b): int {
        return (int)$a['priority'] <=> (int)$b['priority'];
    });

    return array_slice($waiting, 0, faculty_overview_shortlist_size());
}

/**
 * The most recent contact each student had in this exact periodical.
 *
 * Matched on the period as well as the term. A P1 conversation is not an answer
 * about P2 -- that is the entire reason the attempt table grew a period column
 * -- so a student contacted in P1 reappears as uncontacted when the calendar
 * moves on, which is the behaviour the workspace is for.
 */
function faculty_latest_contacts(PDO $pdo, array $studentIds, array $term): array
{
    $ids = array_values(array_unique(array_map('intval', $studentIds)));
    if (empty($ids)) {
        return [];
    }
    $idList = implode(',', $ids);

    [$periodSql, $periodParams] = api_period_filter_sql('a.period', $term['period'] ?? null, ':contact_period');
    $where = ['a.student_id IN (' . $idList . ')'];
    $params = [];

    if (!empty($term['semester_id'])) {
        $where[] = 'a.semester_id = :semester_id';
        $params[':semester_id'] = (int)$term['semester_id'];
    }
    if (!empty($term['school_year_id'])) {
        $where[] = 'a.school_year_id = :school_year_id';
        $params[':school_year_id'] = (int)$term['school_year_id'];
    }
    if ($periodSql !== '') {
        $where[] = $periodSql;
        $params += $periodParams;
    }

    /*
     * The newest attempt PER STUDENT, chosen inside the term filter rather than
     * outside it. Taking MAX(attempt_id) across all time and then filtering
     * would answer "their latest attempt, if it happens to be this periodical",
     * which silently reports a student as uncontacted whenever a later attempt
     * exists in a different term.
     */
    $sql = 'SELECT
                a.student_id,
                a.attempt_id,
                a.contact_status,
                a.intervention_status,
                a.reason_id,
                r.reason_text,
                a.other_reason_label,
                a.notes,
                a.contacted_at,
                a.period,
                TRIM(CONCAT(COALESCE(u.first_name, ""), " ", COALESCE(u.last_name, ""))) AS attempted_by_name,
                actor_role.role_name AS attempted_by_role_name
            FROM student_contact_attempt a
            LEFT JOIN contact_reason r ON r.reason_id = a.reason_id
            LEFT JOIN user u ON u.user_id = a.attempted_by_user_id
            LEFT JOIN role actor_role ON actor_role.role_id = a.attempted_by_role_id
            WHERE ' . implode(' AND ', $where) . '
            ORDER BY a.student_id ASC, a.attempt_id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $byStudent = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $studentId = (int)$row['student_id'];
        // Ordered newest-first, so the first row seen for a student is theirs.
        if (isset($byStudent[$studentId])) {
            continue;
        }
        $row['outcome_label'] = faculty_periodical_outcome_label($row['intervention_status'] ?? '');
        $row['reason_label'] = faculty_reason_label(
            $row['reason_text'] ?? null,
            $row['other_reason_label'] ?? null
        );
        /*
         * Whether this conversation CONCLUDED anything, which is a different
         * question from whether it happened.
         *
         * "Undecided - for follow up" is a reason to ring back, so a student
         * carrying one is still outstanding. Treating any attempt as done is
         * how a student who said "I have not decided" drops off the board and
         * is never asked again -- and that student is the entire reason the
         * question gets asked in P1 rather than read off a withdrawal form in
         * P3. Same rule the PDO board applies, from the same function.
         */
        $row['settled'] = faculty_outcome_is_settled($row['intervention_status'] ?? null);
        $byStudent[$studentId] = $row;
    }

    return $byStudent;
}

/**
 * One student, every periodical: the full detail behind the summary row.
 *
 * P1, P2 and P3 side by side rather than the term rolled up, because the reason
 * to open a student is to see the shape of the slide. "Failing two subjects" is
 * one fact; "passing everything in P1 and failing two in P2" is a different one,
 * and only the second says when it started.
 */
function faculty_student_detail(PDO $pdo, int $studentId, array $term): array
{
    $settings = pdo_settings($pdo);
    $periods = [];

    foreach (faculty_workspace_periods() as $period) {
        $signals = pdo_load_signals(
            $pdo,
            [$studentId],
            $term['semester_id'] ?? null,
            $term['school_year_id'] ?? null,
            $period
        );
        $grade = $signals['grades'][$studentId] ?? null;
        $attendance = $signals['attendance'][$studentId] ?? null;
        $finance = $signals['finance'][$studentId] ?? null;

        $classified = pdo_classify_student(
            ['student_id' => $studentId],
            $grade,
            $attendance,
            $finance,
            $settings
        );

        $periods[] = [
            'period' => $period,
            'period_label' => api_period_label($period),
            /*
             * Said explicitly rather than left to be inferred from a row of
             * dashes. "Nothing recorded for P3" and "P3 looks fine" are
             * opposite conclusions, and an empty row reads as the second.
             */
            'has_records' => $grade !== null || $attendance !== null || $finance !== null,
            'grade_colour' => $classified['grade_colour'],
            'grade_label' => $classified['grade_label'],
            'problem_subjects' => $classified['problem_subjects'],
            'total_subject' => $classified['total_subject'],
            'attendance_status' => $classified['attendance_status'],
            'attendance_label' => $classified['attendance_label'],
            'attendance_colour' => $classified['attendance_colour'] ?? null,
            'present_rate' => $classified['present_rate'],
            'absent' => $attendance === null ? null : (int)($attendance['absent'] ?? 0),
            'total_classes_conducted' => $attendance === null ? null : (int)($attendance['total_classes_conducted'] ?? 0),
            'balance_band' => $classified['balance_band'],
            'balance_colour' => $classified['balance_colour'] ?? null,
            'balance_label' => $classified['balance_label'],
            'balance_amount' => $classified['balance_amount'],
            'priority' => $classified['priority'],
            'priority_label' => $classified['priority_label'],
            'priority_reason' => $classified['priority_reason'],
        ];
    }

    return $periods;
}

/**
 * How a reason reads once its free text is folded back in.
 *
 * Composed here rather than in the browser because both read paths -- the board
 * row and the history list -- render the reason, and two clients joining the
 * pair themselves is two chances to show "Financial - Others" to somebody while
 * the words that explain it sit unread in the next column.
 *
 * The category is kept, not replaced: "Financial - Others: mother lost her job"
 * still groups under Financial in a report, which is the whole point of picking
 * a category first.
 */
function faculty_reason_label(?string $reasonText, ?string $detail): string
{
    $reason = trim((string)$reasonText);
    $extra = trim((string)$detail);

    if ($reason === '') {
        return $extra;
    }

    return $extra === '' ? $reason : $reason . ': ' . $extra;
}

/**
 * Every contact logged for this student, newest first, across all periodicals.
 *
 * The detail view shows the history rather than only the current periodical's
 * answer: "continuing in P1, undecided in P2" is the pattern worth acting on,
 * and it is invisible if each periodical only ever shows its own row.
 */
function faculty_contact_history(PDO $pdo, int $studentId): array
{
    $sql = 'SELECT
                a.attempt_id,
                a.intervention_status,
                a.reason_id,
                r.reason_text,
                a.other_reason_label,
                a.notes,
                a.contacted_at,
                a.period,
                a.semester_id,
                a.school_year_id,
                sem.semester_name,
                sy.schoolyear_name,
                TRIM(CONCAT(COALESCE(u.first_name, ""), " ", COALESCE(u.last_name, ""))) AS attempted_by_name,
                actor_role.role_name AS attempted_by_role_name
            FROM student_contact_attempt a
            LEFT JOIN contact_reason r ON r.reason_id = a.reason_id
            LEFT JOIN user u ON u.user_id = a.attempted_by_user_id
            LEFT JOIN role actor_role ON actor_role.role_id = a.attempted_by_role_id
            LEFT JOIN semester sem ON sem.semester_id = a.semester_id
            LEFT JOIN school_year sy ON sy.school_year_id = a.school_year_id
            WHERE a.student_id = :student_id
            ORDER BY a.attempt_id DESC
            LIMIT 50';

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':student_id' => $studentId]);

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    foreach ($rows as &$row) {
        $row['outcome_label'] = faculty_periodical_outcome_label($row['intervention_status'] ?? '');
        $row['reason_label'] = faculty_reason_label(
            $row['reason_text'] ?? null,
            $row['other_reason_label'] ?? null
        );
        $row['period_label'] = $row['period'] === null
            ? 'Whole semester'
            : api_period_label((int)$row['period']);
    }
    unset($row);

    return $rows;
}

/**
 * Is this payload a contact the workspace will accept? Null if yes, else why.
 *
 * A sentence rather than a bool, for the same reason the retention policy
 * returns one: "pick an outcome", "that outcome needs a reason" and "that is
 * not a reason we know" are three different problems, and one message for all
 * three is what makes a form feel broken rather than strict.
 */
function faculty_contact_rejection(
    array $payload,
    array $validReasonIds,
    array $detailReasonIds
): ?string {
    $outcome = faculty_periodical_outcome_key($payload['outcome'] ?? '');
    if ($outcome === '') {
        return 'Choose what the student decided: '
            . implode(', ', array_values(FACULTY_PERIODICAL_OUTCOMES)) . '.';
    }

    if (faculty_outcome_needs_reason($outcome)) {
        $reasonId = (int)($payload['reason_id'] ?? 0);
        if ($reasonId <= 0) {
            return 'A student who is not continuing needs a reason, so whoever '
                . 'opens this record next knows what to do about it.';
        }
        if (!in_array($reasonId, $validReasonIds, true)) {
            return 'That reason is not one of the listed reasons.';
        }
        /*
         * The escape-hatch reasons have to say which. "Financial - Others" on
         * its own records that a student stopped for a financial reason nobody
         * wrote down, which reads as an answer and is not one.
         *
         * $detailReasonIds is a required argument rather than one defaulting to
         * an empty array: an empty list means "no reason needs detail", so a
         * caller that forgot to pass it would silently turn this rule off.
         */
        if (in_array($reasonId, $detailReasonIds, true)
            && trim((string)($payload['other_reason_label'] ?? '')) === '') {
            return 'That reason ends in "Others", so say which one in a few words.';
        }
    }

    /*
     * A reason left attached to "Continuing" is not worth refusing a save over
     * -- somebody picked one, then changed the outcome. The writer drops it
     * instead, so no stored row can read "continuing, because of financial
     * hardship", which is a contradiction to whoever reads it in March.
     */
    return null;
}

/**
 * The reason ids a contact may cite: the live vocabulary, as ints.
 *
 * Read from the table rather than trusted from the request, because the request
 * is where a stale dropdown or a hand-made POST would send an id that no longer
 * exists, and a foreign key pointing at nothing is worse than a refusal.
 */
function faculty_valid_reason_ids(PDO $pdo): array
{
    $rows = $pdo->query('SELECT reason_id FROM contact_reason WHERE is_active = 1')
        ->fetchAll(PDO::FETCH_COLUMN) ?: [];

    return array_map('intval', $rows);
}

/**
 * Record one periodical contact against a student, and say what happened.
 *
 * Lifted out of faculty_workspace.php's POST when the PDO board was given the
 * same action, because two screens writing a contact two ways is two answers to
 * "what did we do about this student". Everything a contact needs to be a
 * contact is here: the reason rules, the term stamp, the case upsert, the
 * attempt row and the audit line. A caller supplies only WHICH student, having
 * already satisfied itself that this account may act on them -- the scoping is
 * the endpoint's question and stays there, because the two boards scope
 * differently.
 *
 * Returns [$httpStatus, $body] rather than calling api_out(). A function that
 * exits cannot be shared by a second caller and cannot be exercised from the
 * CLI, which is the same reason the retention policy rules live outside their
 * endpoint.
 *
 * `$student` must carry `student_id`, and `department_id` if the student has
 * one -- both boards' student queries already select them.
 */
function faculty_record_periodical_contact(
    PDO $pdo,
    array $authUser,
    array $student,
    array $term,
    array $payload
): array {
    $studentId = (int)($student['student_id'] ?? 0);
    if ($studentId <= 0) {
        return [400, ['message' => 'Which student is this about?']];
    }

    // Stamped with the calendar's term, so a closed one takes no more contacts.
    $closedTerm = term_closure_block($pdo, [$term['school_year_id'] ?? null, $term['semester_id'] ?? null]);
    if ($closedTerm !== null) {
        return [TERM_CLOSURE_HTTP_STATUS, $closedTerm];
    }

    $detailReasonIds = student_contact_reason_ids_needing_detail($pdo);
    $rejection = faculty_contact_rejection($payload, faculty_valid_reason_ids($pdo), $detailReasonIds);
    if ($rejection !== null) {
        return [400, ['message' => $rejection]];
    }

    $outcome = faculty_periodical_outcome_key($payload['outcome']);
    // 'f2f' is locked on the Dropdown Management screen because of this default.
    $method = student_contact_channel_key($pdo, $payload['contact_method'] ?? 'f2f');
    if ($method === '') {
        return [400, ['message' => 'Choose how the student was contacted.']];
    }
    // Dropped rather than stored: see faculty_contact_rejection().
    $reasonId = faculty_outcome_needs_reason($outcome) ? (int)$payload['reason_id'] : null;
    $note = trim((string)($payload['note'] ?? ''));

    /*
     * The free text belongs to the reason, so it is dropped whenever the
     * reason is -- an outcome changed back to Continuing, or a reason
     * changed from "Health - Others" to "Health - Pregnancy", must not
     * leave last-minute typing attached to a reason that no longer asks for
     * it. Trimmed to the column width here rather than refused: a faculty
     * member two sentences into the box should not lose them to a 400.
     */
    $otherReasonLabel = null;
    if ($reasonId !== null && in_array($reasonId, $detailReasonIds, true)) {
        $otherReasonLabel = mb_substr(trim((string)($payload['other_reason_label'] ?? '')), 0, 160);
    }

    $pdo->beginTransaction();
    try {
        $caseId = student_contact_ensure_case(
            $pdo,
            $studentId,
            isset($student['department_id']) ? (int)$student['department_id'] : null
        );

        $stmt = $pdo->prepare(
            'INSERT INTO student_contact_attempt
                (contact_case_id, student_id, attempted_by_user_id, attempted_by_role_id,
                 contact_method, contact_status, intervention_status, reason_id,
                 other_reason_label, contacted_at, school_year_id, semester_id, period, notes)
             VALUES
                (:case_id, :student_id, :user_id, :role_id,
                 :method, :status, :outcome, :reason_id,
                 :other_reason_label, NOW(), :school_year_id, :semester_id, :period, :notes)'
        );
        $stmt->execute([
            ':case_id' => $caseId,
            ':student_id' => $studentId,
            ':user_id' => (int)($authUser['user_id'] ?? 0) ?: null,
            /*
             * `role_id` first, and that is a fix rather than a preference.
             *
             * This read `$authUser['role']`, which on the session user is the
             * role NAME -- 'Dean', 'Faculty' -- so `(int)` made it 0 and the
             * `?: null` stored NULL. Every contact ever recorded through this
             * write has a null attempted_by_role_id because of it; the column
             * was collecting nothing. The numeric fallback is kept for a caller
             * that passes the id under the other key.
             */
            ':role_id' => (int)($authUser['role_id'] ?? $authUser['role'] ?? 0) ?: null,
            ':method' => $method,
            /*
             * contact_status is the older semester-level vocabulary and is
             * still what the caller screens read. A periodical outcome is
             * recorded in intervention_status; contact_status says only
             * that the conversation happened, so a faculty row does not
             * masquerade as a caller's RECOVERED/NOT RECOVERED verdict.
             */
            ':status' => 'contacted',
            ':outcome' => $outcome,
            ':reason_id' => $reasonId,
            ':other_reason_label' => ($otherReasonLabel ?? '') !== '' ? $otherReasonLabel : null,
            ':school_year_id' => $term['school_year_id'],
            ':semester_id' => $term['semester_id'],
            ':period' => $term['period'],
            ':notes' => $note !== '' ? $note : null,
        ]);
        $attemptId = (int)$pdo->lastInsertId();

        $pdo->commit();
    } catch (Throwable $throwable) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $throwable;
    }

    /*
     * The audit write is deliberately OUTSIDE the transaction. It reaches
     * api_audit_ensure_table(), and DDL implicitly commits on MariaDB --
     * that is what silently ended the contact workspace's transactions and
     * reported written saves as failures. See the migration notes.
     */
    student_contact_write_audit_log(
        $pdo,
        $authUser,
        'Recorded a ' . api_period_label($term['period']) . ' contact for '
            . ($student['student_number'] ?? ('ID:' . $studentId))
            . ': ' . faculty_periodical_outcome_label($outcome),
        [
            'student_id' => $studentId,
            'attempt_id' => $attemptId,
            'outcome' => $outcome,
            'reason_id' => $reasonId,
            'period' => $term['period'],
            'semester_id' => $term['semester_id'],
            'school_year_id' => $term['school_year_id'],
        ]
    );

    return [201, [
        'message' => 'Contact recorded for ' . api_period_label($term['period']) . '.',
        'attempt_id' => $attemptId,
        'contacts' => faculty_contact_history($pdo, $studentId),
    ]];
}

}
