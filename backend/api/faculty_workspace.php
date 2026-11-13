<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/faculty_workspace.php';
require_once __DIR__ . '/student_contact_workflow_lib.php';


/**
 * Which term this workspace is looking at.
 *
 * The Academic Calendar decides, and a request may override the periodical only.
 * The semester and school year are deliberately NOT overridable here: this is a
 * screen for acting on the term in progress, and letting a query string move it
 * to a previous year would offer buttons that write interventions into history.
 * Reading an old term is what Records History is for.
 */
function faculty_workspace_term(PDO $pdo): array
{
    $calendar = academic_calendar_current($pdo);
    $term = [
        'school_year_id' => $calendar['school_year_id'] ?? null,
        'semester_id' => $calendar['semester_id'] ?? null,
        'period' => $calendar['period'] ?? null,
        'label' => $calendar['label'] ?? null,
        'semester_name' => $calendar['semester_name'] ?? null,
        'schoolyear_name' => $calendar['schoolyear_name'] ?? null,
    ];

    if (array_key_exists('period', $_GET) && $_GET['period'] !== '') {
        $requested = api_normalize_period($_GET['period']);
        /*
         * `false` means unparseable, which is different from blank. Refused
         * rather than defaulted: silently showing P1 to somebody who asked for
         * "banana" is how a filter appears to work and does not.
         */
        if ($requested === false) {
            api_out(400, ['message' => 'That is not a periodical. Choose P1, P2 or P3.']);
        }
        $term['period'] = $requested;
    }

    return $term;
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();

    if (!$authUser) {
        api_out(401, ['message' => 'Authentication required']);
    }

    $permissionRecord = api_fetch_effective_permissions_record(
        $pdo,
        (int)($authUser['role_id'] ?? 0),
        (int)($authUser['user_id'] ?? 0)
    );
    $modulePermissions = $permissionRecord['permissions'] ?? [];

    if (!api_can($modulePermissions, 'faculty_workspace', 'view')) {
        api_out(403, ['message' => 'You do not have permission to open the faculty workspace.']);
    }

    /*
     * Whose students. Department-pinned roles see their own department and
     * nothing else; an unpinned role (admin) passes null and sees everyone,
     * which is what makes this screen usable for checking what faculty see.
     */
    $isPinned = api_user_is_department_pinned($authUser);
    // The session user carries `department_id`; the `user` table column it
    // comes from is called `department`. Both are read so this does not depend
    // on which of the two shapes the caller was built from.
    $departmentId = $isPinned
        ? (int)($authUser['department_id'] ?? $authUser['department'] ?? 0)
        : null;

    $term = faculty_workspace_term($pdo);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // ---------------------------------------------------------------- read
    if ($method === 'GET') {
        $studentId = isset($_GET['student_id']) ? (int)$_GET['student_id'] : 0;

        if ($studentId > 0) {
            /*
             * The detail view re-runs the department scope rather than trusting
             * that the id came from a list this account was allowed to see. A
             * hand-typed ?student_id= is the whole reason to check again.
             */
            $students = faculty_workspace_students($pdo, $departmentId, []);
            $allowed = array_filter($students, static function (array $row) use ($studentId): bool {
                return (int)$row['student_id'] === $studentId;
            });
            if (empty($allowed)) {
                api_out(404, ['message' => 'That student is not in your department.']);
            }

            api_out(200, [
                'student' => array_values($allowed)[0],
                'term' => $term,
                'periods' => faculty_student_detail($pdo, $studentId, $term),
                'contacts' => faculty_contact_history($pdo, $studentId),
            ]);
        }

        /*
         * Whether students already dealt with this periodical are still on the
         * list. Same parameter, same three values and the same default as the
         * PDO board -- see contact_state_view() for why an unrecognised value
         * widens to `all` instead of falling back to the default.
         */
        $contactedView = contact_state_view($_GET['contacted'] ?? null);

        $students = faculty_workspace_students($pdo, $departmentId, [
            'search' => $_GET['search'] ?? '',
        ]);
        $rows = faculty_workspace_rows($pdo, $students, $term);

        /*
         * COUNTED BEFORE THE FILTER, because the cards ARE the filter.
         *
         * The summary used to be counted after `?pdo=`, which made it a
         * description of the current slice: filter to Priority 1 and every other
         * band read 0. That was harmless while the cards were only a readout,
         * and became a dead end the moment they were made clickable -- pressing
         * Priority 1 zeroed the Priority 2 card, so there was no way to move
         * between bands except back through the dropdown.
         *
         * So the counts answer for everyone matching the SEARCH, and the rows
         * answer for the current band. The page says "showing N of M" where the
         * two differ, which is the honest reading of two numbers that are
         * deliberately about different sets.
         */
        $summary = [
            'students' => count($rows),
            'priority_1' => 0,
            'priority_2' => 0,
            'priority_3' => 0,
            'priority_4' => 0,
            /*
             * How much of the board is waiting on encoding rather than on a
             * decision. Counts every row with no grade data, whatever its band.
             *
             * It was a slice of Priority 1 once: the sheet makes "No Grade Data"
             * Priority 1 on all twelve of its rows, which is right as a statement
             * of risk and wrong as a work queue - the action it needs is "chase
             * the encoding", not "call the student".
             *
             * Since 2026-09-12 a missing grade does not decide a priority at all
             * (see the no-data rule in pdo_priority_for), so these students are
             * spread across the bands on attendance and balance instead - mostly
             * Priority 4 when nothing else is known. This is therefore NOT a
             * subset of priority_1 and will routinely exceed it: on a cohort with
             * no grades loaded at all it is every student, against a P1 of zero.
             * The screen labels it "Not graded yet" and places it apart from the
             * four bands for exactly that reason.
             */
            'unassessed' => 0,
            /*
             * The same question asked of attendance: how many of these
             * students has nobody recorded attendance for.
             *
             * Worth counting for the same reason `unassessed` is, and for a
             * sharper one. A missing grade at least shows on the board as
             * "No Grade Data"; a missing attendance row used to show as
             * "Attending", because pdo_attendance_status() answers the policy
             * question (attendance_missing_is_slip) rather than the factual
             * one. The label says so now -- see pdo_attendance_label() -- and
             * this is the count behind it, so the overview can tell a faculty
             * member that a green-looking column is an empty one.
             *
             * Read off `attendance_colour`, which is null exactly when
             * nothing is on record, rather than off attendance_status.
             */
            'unrecorded_attendance' => 0,
            /*
             * Contacted AT ALL this periodical. Kept because it answers "did
             * the calling happen", which is not the same question as the one
             * below and is the one a coordinator checks coverage against.
             */
            'contacted_this_period' => 0,
            /*
             * Contacted AND CONCLUDED, plus its complement -- the PDO board's
             * two numbers, counted by the PDO board's rule, so the same student
             * is outstanding on both screens or on neither.
             *
             * `contacted` is deliberately not `contacted_this_period`: a
             * student who answered "Undecided - for follow up" has been spoken
             * to and still needs ringing, so they raise the first and not the
             * second. Where the two differ is exactly the list of conversations
             * that are not finished.
             */
            'contacted' => 0,
            'outstanding' => 0,
            /*
             * Flagged and not yet spoken to THIS periodical: the work actually
             * outstanding, as opposed to how much of it there is.
             *
             * The overview's shortlist shows five of these and says how many
             * more are behind them, and it cannot count them itself once the
             * payload is trimmed to those five. Counted here for the same
             * reason as everything else in this block -- before the `?pdo=`
             * filter, over everyone matching the search.
             */
            'flagged_waiting' => 0,
        ];
        foreach ($rows as $row) {
            $summary['priority_' . (int)$row['priority']] += 1;
            if (($row['grade_colour'] ?? '') === PDO_GRADE_NO_DATA) {
                $summary['unassessed'] += 1;
            }
            if (($row['attendance_colour'] ?? null) === null) {
                $summary['unrecorded_attendance'] += 1;
            }
            if (!empty($row['periodical_contact'])) {
                $summary['contacted_this_period'] += 1;
            }
            if (faculty_row_is_settled($row)) {
                $summary['contacted'] += 1;
            } else {
                $summary['outstanding'] += 1;
                if (in_array((int)$row['priority'], PDO_FLAGGED_PRIORITIES, true)) {
                    $summary['flagged_waiting'] += 1;
                }
            }
        }
        $summary['contacted_view'] = $contactedView;

        /*
         * The landing snapshot, which wants the counts and five names -- not
         * the board.
         *
         * Same request, same classifier, same numbers: the overview and the My
         * Students board must never disagree about how many students are in
         * trouble, so this is a narrowing of one answer rather than a second
         * endpoint computing its own. What it saves is the wire, and that is
         * not a rounding error -- a full department is 2,776 rows and 2.4MB of
         * JSON, which is an absurd thing to send to fill in ten numbers on a
         * page somebody opens every morning.
         *
         * Returned early and deliberately lean. `settings` and `permissions`
         * describe the contact form, and the overview has no form: it is a
         * glance with a button that opens the board, which asks for them then.
         *
         * `?pdo=` is ignored here rather than combined. The two are different
         * requests -- one asks "what is my department like", the other "show me
         * this band" -- and a landing page that quietly honoured a leftover
         * filter would report a slice as the whole department.
         */
        if (($_GET['view'] ?? '') === 'overview') {
            api_out(200, [
                'data' => faculty_overview_shortlist($rows),
                'summary' => $summary,
                'term' => $term,
                /*
                 * Whose students these are, so the page can say it instead of
                 * writing "your department" and leaving the reader to assume
                 * both which one and whether it covers the other campus.
                 */
                'scope' => faculty_workspace_scope($pdo, $departmentId),
                /*
                 * Asked only when the board has nothing to judge anybody on.
                 * On an ordinary periodical this is a query nobody reads, and
                 * the answer is the periodical we are already in.
                 */
                'latest_graded_period' => $summary['unassessed'] >= $summary['students'] && $summary['students'] > 0
                    ? faculty_latest_graded_period($pdo, $term)
                    : null,
            ]);
        }

        /*
         * The board's own filters, applied after classification because that is
         * where the priority exists. `pdo=none` is the data-gap filter: students
         * the three modules hold nothing about, who otherwise look identical to
         * students genuinely doing fine.
         */
        /*
         * Applied after classification and after the counts, exactly like
         * `?pdo=` below: the cards say how many students are in each band and
         * how many have been dealt with, and neither number stops being true
         * because the table is currently showing one slice of it.
         */
        if ($contactedView !== 'all') {
            $rows = array_values(array_filter($rows, static function (array $row) use ($contactedView): bool {
                return contact_state_includes($contactedView, faculty_row_is_settled($row));
            }));
        }

        $pdoFilter = trim((string)($_GET['pdo'] ?? ''));
        if ($pdoFilter !== '') {
            $rows = array_values(array_filter($rows, static function (array $row) use ($pdoFilter): bool {
                if ($pdoFilter === 'none') {
                    return $row['total_subject'] === null
                        && $row['total_classes_conducted'] === null
                        && $row['balance_amount'] === null;
                }
                /*
                 * Every student nobody has graded, in whatever band they landed.
                 *
                 * Cuts across the priorities rather than narrowing one of them -
                 * see the note on `unassessed` in the summary above. Reading it as
                 * "the ungraded half of P1" was true until 2026-09-12 and is not
                 * true now.
                 */
                if ($pdoFilter === 'unassessed') {
                    return ($row['grade_colour'] ?? '') === PDO_GRADE_NO_DATA;
                }
                if ($pdoFilter === 'flagged') {
                    return in_array((int)$row['priority'], PDO_FLAGGED_PRIORITIES, true);
                }
                return (string)$row['priority'] === $pdoFilter;
            }));
        }

        api_out(200, [
            'data' => $rows,
            'summary' => $summary,
            'term' => $term,
            'settings' => [
                'outcomes' => faculty_periodical_outcome_options(),
                'reasons' => student_contact_reason_options($pdo),
                'channels' => student_contact_channel_options($pdo),
            ],
            'permissions' => [
                'can_record_contact' => api_can($modulePermissions, 'faculty_workspace', 'create'),
            ],
        ]);
    }

    // --------------------------------------------------------------- write
    if ($method === 'POST') {
        if (!api_can($modulePermissions, 'faculty_workspace', 'create')) {
            api_out(403, ['message' => 'You do not have permission to record a contact.']);
        }

        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            api_out(400, ['message' => 'Send the contact as JSON.']);
        }

        $studentId = (int)($payload['student_id'] ?? 0);
        if ($studentId <= 0) {
            api_out(400, ['message' => 'Which student is this about?']);
        }

        $students = faculty_workspace_students($pdo, $departmentId, []);
        $allowed = array_filter($students, static function (array $row) use ($studentId): bool {
            return (int)$row['student_id'] === $studentId;
        });
        if (empty($allowed)) {
            api_out(404, ['message' => 'That student is not in your department.']);
        }
        $student = array_values($allowed)[0];

        /*
         * Everything from here -- the reason rules, the term stamp, the case
         * upsert, the attempt row and the audit line -- is in the shared lib,
         * because the PDO board records the same contact and two writers would
         * be two answers to "what did we do about this student". What stays
         * here is the part that is this endpoint's alone: which students this
         * account may act on, checked above.
         */
        [$status, $body] = faculty_record_periodical_contact($pdo, $authUser, $student, $term, $payload);
        api_out($status, $body);

    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $throwable) {
    api_out(500, ['message' => $throwable->getMessage()]);
}
