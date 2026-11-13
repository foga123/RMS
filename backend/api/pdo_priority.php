<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/pdo_priority_lib.php';
/*
 * For faculty_record_periodical_contact(): the board can now log a contact, and
 * it writes the same record the Faculty Workspace writes. Not a copy of that
 * write -- one student can be worked from either screen, and two writers would
 * be two answers to "what did we do about this student".
 */
require_once __DIR__ . '/lib/faculty_workspace.php';
/*
 * faculty_outcome_is_settled() and faculty_periodical_outcome_label(), for
 * deciding whether a recorded contact takes a student off the list.
 *
 * Required here rather than leaned on through faculty_workspace.php, which
 * happens to include it today: a file that only works while something else
 * remembers to load its dependencies breaks the next time the include order
 * changes. Same rule this module's own library states at the top of
 * pdo_priority_lib.php.
 */
require_once __DIR__ . '/contact_vocabulary.php';


try {
    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if ($method !== 'GET' && $method !== 'POST') {
        api_out(405, ['message' => 'Method not allowed']);
    }

    $permissionRecord = api_fetch_effective_permissions_record(
        $pdo,
        (int)($authUser['role_id'] ?? 0),
        (int)($authUser['user_id'] ?? 0)
    );
    $modulePermissions = $permissionRecord['permissions'] ?? [];
    /*
     * `intervene` is the narrow grant for "record what you did about a student
     * without signing the case off", and that is exactly what this action is.
     *
     * Written as edit-OR-intervene rather than as a single api_can() call,
     * because the implication is not in api_can(): it is spelled out at each
     * point of use, and retention_case.php's `can_update_intervention` is the
     * same expression. So a Dean or an SSP Coordinator holding `edit` needs no
     * new grant, and a role holding only `intervene` gets this and nothing
     * else. Keeping the two spellings identical is what stops the board and the
     * case screen from disagreeing about who may record what.
     */
    $canRecordContact = api_can($modulePermissions, 'retention_cases', 'edit')
        || api_can($modulePermissions, 'retention_cases', 'intervene');

    $settings = pdo_settings($pdo);

    $semesterId = (isset($_GET['semester_id']) && $_GET['semester_id'] !== '') ? (int)$_GET['semester_id'] : null;
    $schoolYearId = (isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '') ? (int)$_GET['school_year_id'] : null;
    $courseId = (isset($_GET['course_id']) && $_GET['course_id'] !== '') ? (int)$_GET['course_id'] : null;
    // Year level is a filter, not a scope: it narrows what the reader is
    // already entitled to see and is never used to widen it.
    $yearLevel = (isset($_GET['year_level']) && $_GET['year_level'] !== '') ? (int)$_GET['year_level'] : null;
    $priorityFilter = (isset($_GET['priority']) && $_GET['priority'] !== '') ? (int)$_GET['priority'] : null;
    /*
     * Whether students already contacted this term are still on the list.
     *
     * `outstanding` (the default) is who is left to ring. `done` is who has
     * been, which is how a coordinator checks the work happened. `all` is the
     * old behaviour and the honest fallback for anything unrecognised -- a
     * mistyped parameter should widen the list, never silently hide students
     * from the person looking for them.
     */
    $contactedView = contact_state_view($_GET['contacted'] ?? null);
    /*
     * Paging, in the same shape student.php uses: ?page= and ?limit=, capped.
     *
     * The board classifies the whole cohort no matter what this says - the
     * priority tiles count every student in scope, and the sort below is by a
     * computed priority rather than a column, so both need the full set. What
     * paging changes is how much of that set gets serialised and sent.
     */
    $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
    $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 25;
    /*
     * Which periodical the list is about.
     *
     * Blank keeps the old behaviour -- the whole term, which for grades means
     * the latest periodical on record. Naming one makes every signal read that
     * periodical and nothing else, so a list headed "P1" is a list of who was
     * at risk in P1 rather than of who is at risk on their most recent marks.
     */
    $period = isset($_GET['period']) ? $_GET['period'] : null;
    $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';

    /*
     * Department scope, the same rule grades.php and finance-summary.php apply.
     *
     * A pinned viewer's department is taken from their session and NOT from the
     * query string, whatever it says. The chooser is not rendered for a dean,
     * but the parameter is just a URL: without this a dean could read another
     * department's drop-out list by editing it.
     */
    $seesAllDepartments = api_session_user_has_role($authUser, ['admin', 'ssg']);
    $isDepartmentPinned = api_user_is_department_pinned($authUser);
    $departmentId = (isset($_GET['department_id']) && $_GET['department_id'] !== '') ? (int)$_GET['department_id'] : null;
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
            api_out(400, ['message' => 'This account is not linked to a department']);
        }
        $departmentScopeIsOwn = true;
    }

    $where = ['st.archived_at IS NULL'];
    $params = [];

    if ($departmentId !== null) {
        $where[] = api_department_filter_sql('cr.department_id', $departmentScopeIsOwn);
        $params[':department_id'] = $departmentId;
    }
    // The STAR / Non-STAR split, so a caller sees only their own cohort here
    // exactly as they do everywhere else. Moved above the filters so it lands
    // in the scope snapshot below; it was always a scope and never a filter.
    api_apply_student_type_scope($where, $params, $authUser, 'st.`star e-profile`', ':student_type_scope');

    /*
     * Everything above is SCOPE -- who this account may see at all. Everything
     * below is FILTER -- how the reader has narrowed what they are entitled to.
     *
     * Snapshotted here because a write is checked against the first and must
     * not be touched by the second. A dean whose board is filtered to Priority
     * 1 is still entitled to log a contact for a Priority 3 student of theirs,
     * so the filters must not narrow the check; and a filter must never be able
     * to widen it, which is why the scope is taken before any of them is added
     * rather than reconstructed afterwards.
     */
    $scopeWhere = $where;
    $scopeParams = $params;

    // ------------------------------------------------------------- write
    if ($method === 'POST') {
        if (!$canRecordContact) {
            api_out(403, ['message' => 'You do not have permission to record a contact.']);
        }

        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            api_out(400, ['message' => 'Send the contact as JSON.']);
        }

        $targetId = (int)($payload['student_id'] ?? 0);
        if ($targetId <= 0) {
            api_out(400, ['message' => 'Which student is this about?']);
        }

        $scopeWhere[] = 'st.student_id = :target_student';
        $scopeParams[':target_student'] = $targetId;

        $targetStmt = $pdo->prepare(
            'SELECT st.student_id, st.student_number, cr.department_id
               FROM student st
               LEFT JOIN course cr ON cr.course_id = st.course_id
              WHERE ' . implode(' AND ', $scopeWhere) . '
              LIMIT 1'
        );
        foreach ($scopeParams as $key => $value) {
            $targetStmt->bindValue($key, $value);
        }
        $targetStmt->execute();
        $target = $targetStmt->fetch(PDO::FETCH_ASSOC);

        if (!$target) {
            api_out(404, ['message' => 'That student is not on your board.']);
        }

        /*
         * The term comes from the calendar and NOT from this request.
         *
         * `?period=` on this board chooses which periodical's signals are READ
         * -- it is how a reader looks back at who was at risk in P1. Letting it
         * choose where a contact is WRITTEN would let somebody reading P1 in
         * December record a conversation into P1, which is a note filed under a
         * periodical that closed months ago. Acting always happens in the term
         * in progress; reading an old one is what Records History is for.
         */
        $calendar = academic_calendar_current($pdo);
        [$status, $body] = faculty_record_periodical_contact(
            $pdo,
            $authUser,
            $target,
            [
                'school_year_id' => $calendar['school_year_id'] ?? null,
                'semester_id' => $calendar['semester_id'] ?? null,
                'period' => $calendar['period'] ?? null,
            ],
            $payload
        );
        api_out($status, $body);
    }

    if ($courseId !== null) {
        $where[] = 'st.course_id = :course_id';
        $params[':course_id'] = $courseId;
    }
    if ($yearLevel !== null) {
        $where[] = 'st.year_level = :year_level';
        $params[':year_level'] = $yearLevel;
    }
    if ($search !== '') {
        $where[] = '(st.student_number LIKE :q OR st.first_name LIKE :q OR st.last_name LIKE :q)';
        $params[':q'] = '%' . $search . '%';
    }

    $studentSql = 'SELECT st.student_id, st.student_number, st.first_name, st.last_name,
                          st.`star e-profile` AS student_type, st.year_level, st.section, st.course_id,
                          cr.course_code, cr.course_name, cr.department_id
                     FROM student st
                     LEFT JOIN course cr ON cr.course_id = st.course_id
                    WHERE ' . implode(' AND ', $where);
    $studentStmt = $pdo->prepare($studentSql);
    foreach ($params as $k => $v) { $studentStmt->bindValue($k, $v); }
    $studentStmt->execute();
    $students = $studentStmt->fetchAll(PDO::FETCH_ASSOC);

    /*
     * What a reader needs to log a contact from this board: whether they may,
     * and the words the form offers. The same three lists the Faculty Workspace
     * hands its form, read from the same functions, so one screen cannot start
     * offering an outcome the other does not know.
     *
     * `term` is the calendar's, and is shown rather than chosen: it is the
     * periodical a contact recorded now will be stamped with, which is worth
     * saying on a board whose own filter can be pointed at a different one.
     */
    $contactSettings = [
        'can_record' => $canRecordContact,
        'term' => academic_calendar_current($pdo),
        'outcomes' => faculty_periodical_outcome_options(),
        'reasons' => student_contact_reason_options($pdo),
        'channels' => student_contact_channel_options($pdo),
    ];

    if (empty($students)) {
        api_out(200, [
            'data' => [],
            'summary' => ['total' => 0, 'shown' => 0, 'by_priority' => []],
            'pagination' => ['page' => 1, 'limit' => $limit, 'total' => 0],
            'settings' => $settings,
            'contact' => $contactSettings,
        ]);
    }

    /*
     * The three signals, in three queries for the whole page.
     *
     * Shared with the contact workspace, which classifies its queue the same
     * way: a second copy of these three window functions is how the caller's
     * priority and this screen's priority would quietly start disagreeing about
     * the same student.
     */
    $signals = pdo_load_signals($pdo, array_column($students, 'student_id'), $semesterId, $schoolYearId, $period);
    /*
     * Who has already been rung this term, so the board can take them off the
     * list once the conversation has happened.
     *
     * The priority itself does NOT move because somebody made a call -- it is
     * read from grades, attendance and balance, and none of those change on the
     * phone. So a contacted student stays exactly as at risk as they were, and
     * the tiles below keep counting them. What changes is whether they are
     * still on the list of people to ring, which is a different question and
     * the one a caller is actually asking.
     */
    $lastContact = pdo_load_last_contact($pdo, array_column($students, 'student_id'), $semesterId, $schoolYearId, $period);

    $rows = [];
    $byPriority = [1 => 0, 2 => 0, 3 => 0, 4 => 0];
    $bySegment = [];
    $contactedCount = 0;

    foreach ($students as $student) {
        $id = (int)$student['student_id'];
        $classified = pdo_classify_student(
            $student,
            $signals['grades'][$id] ?? null,
            $signals['attendance'][$id] ?? null,
            $signals['finance'][$id] ?? null,
            $settings
        );

        /*
         * Settled, not merely attempted. An outcome of "Undecided - for follow
         * up" is a reason to ring again, so it leaves the student on the list
         * -- see faculty_outcome_is_settled(), which treats anything it does
         * not recognise as unsettled for the same reason.
         */
        $contact = $lastContact[$id] ?? null;
        $isSettled = $contact !== null && faculty_outcome_is_settled($contact['outcome'] ?? null);

        $classified['last_contact'] = $contact ? [
            'contacted_at' => $contact['contacted_at'],
            'outcome' => $contact['outcome'],
            'outcome_label' => faculty_periodical_outcome_label($contact['outcome']),
            'contact_method' => $contact['contact_method'],
            'period' => $contact['period'] === null ? null : (int)$contact['period'],
            'by_name' => $contact['by_name'] ?: null,
            'by_role_name' => $contact['by_role_name'] ?: null,
            'settled' => $isSettled,
        ] : null;
        $classified['contacted'] = $isSettled;

        /*
         * Counted before any filter, the same way the priority tiles are: the
         * tiles answer "how many are at risk", which does not stop being true
         * because the student has been spoken to.
         */
        $byPriority[$classified['priority']]++;
        $segment = $classified['segment'];
        $bySegment[$segment] = ($bySegment[$segment] ?? 0) + 1;
        if ($isSettled) {
            $contactedCount++;
        }

        if ($priorityFilter !== null && $classified['priority'] !== $priorityFilter) {
            continue;
        }
        /*
         * Off the list once the call is done, unless the reader asked to see
         * them. `outstanding` is the default because the board's job is "who do
         * I ring next" -- leaving worked students in it is how the same student
         * gets rung twice by two callers.
         */
        if (!contact_state_includes($contactedView, $isSettled)) {
            continue;
        }
        $rows[] = $classified;
    }

    /*
     * Priority 1 first, then by how much is wrong within a priority.
     *
     * Inside one priority the tie-break is problem subjects then balance, so the
     * student with five failed subjects and a large balance is at the top of the
     * band rather than wherever the student table happened to order them.
     */
    usort($rows, static function (array $a, array $b): int {
        if ($a['priority'] !== $b['priority']) {
            return $a['priority'] <=> $b['priority'];
        }
        if (($b['problem_subjects'] ?? 0) !== ($a['problem_subjects'] ?? 0)) {
            return ($b['problem_subjects'] ?? 0) <=> ($a['problem_subjects'] ?? 0);
        }
        if (($b['balance_amount'] ?? 0) != ($a['balance_amount'] ?? 0)) {
            return ($b['balance_amount'] ?? 0) <=> ($a['balance_amount'] ?? 0);
        }
        return strcmp((string)$a['student_name'], (string)$b['student_name']);
    });

    arsort($bySegment);

    /*
     * Sort the whole list, then send one page of it.
     *
     * The order is global and the counts are whole-cohort, so both are settled
     * before this point: slicing here cannot change who is at the top of the
     * board or what the priority tiles say. It only stops the other 2,751 rows
     * from being serialised to draw twenty-five of them - 2.1MB, on a screen
     * that has always shown a page at a time.
     *
     * The page is clamped rather than honoured blindly, so a stale link, or a
     * live refresh that shortens the list while somebody is on page nine,
     * lands on the last real page instead of an empty table. The clamped value
     * is what comes back in `pagination`, so the control shows where the
     * reader actually is.
     */
    $filteredTotal = count($rows);
    $pageCount = max(1, (int)ceil($filteredTotal / $limit));
    $page = min($page, $pageCount);
    $pageRows = array_slice($rows, ($page - 1) * $limit, $limit);

    api_out(200, [
        'data' => $pageRows,
        'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $filteredTotal],
        'summary' => [
            'total' => count($students),
            // How many the filter leaves, which is not how many were sent:
            // `pagination.total` is the same number, and this stays for the
            // readers that were already using it.
            'shown' => $filteredTotal,
            /*
             * Both halves of "have we worked this list", counted over everyone
             * in scope rather than over what the filter left -- a board showing
             * only the outstanding students should still be able to say how
             * many have been done.
             */
            'contacted' => $contactedCount,
            'outstanding' => count($students) - $contactedCount,
            'contacted_view' => $contactedView,
            'by_priority' => array_map(
                static function (int $level, int $count): array {
                    return [
                        'priority' => $level,
                        'owner' => PDO_PRIORITY_OWNERS[$level],
                        'label' => 'Priority ' . $level . ': ' . PDO_PRIORITY_OWNERS[$level],
                        'count' => $count,
                    ];
                },
                array_keys($byPriority),
                array_values($byPriority)
            ),
            'by_segment' => array_map(
                static function (string $segment, int $count): array {
                    return ['segment' => $segment, 'count' => $count];
                },
                array_keys($bySegment),
                array_values($bySegment)
            ),
        ],
        'settings' => $settings,
        'contact' => $contactSettings,
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'pdo_priority']);
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
