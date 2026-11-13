<?php
/**
 * Closing a term: writing down what each student was, while it is still true.
 *
 * `student` holds one row per student, so year_level, section, course_id,
 * student_type and the scholarship grant are current values that the next edit
 * overwrites. Everything measured about a student is filed by term — grades,
 * attendance, finance and retention_case all carry the term, enrollment_status
 * carries the year and semester — but the student's own attributes are not, so
 * there is no way to ask what year level somebody held two terms ago.
 *
 * Closing a term copies those attributes into student_term_snapshot, one row per
 * student per term. That is what lets YearMigrationMatrix stop projecting, and
 * what stops a later course shift from re-reporting last year's grades under the
 * new department.
 *
 * The honesty problem, and what this endpoint does about it
 * --------------------------------------------------------
 * A snapshot is only true if it is taken while it is true. Closing a term the
 * week it ends records what people actually were. Closing a term from two years
 * ago records what they are TODAY and files it as history, which is worse than
 * having no history at all — an empty table is visibly empty, a fabricated one
 * is indistinguishable from a real one.
 *
 * This endpoint cannot tell how late you are, so it does not pretend to. It
 * reports `is_latest_term` on every term, refuses to overwrite an existing
 * snapshot without `restamp`, and the preview says how many stored records a
 * re-stamp would rewrite. The judgement stays with the person closing the term,
 * which is where it belongs; what the endpoint owes them is an accurate
 * description of the act.
 *
 * Closing is also a LOCK (2026-09-27)
 * -----------------------------------
 * A closed semester's records are read-only: grades, attendance, finance,
 * enrollment standings, retention cases and faculty contacts filed under it.
 * lib/term_closure.php holds the rule and lists every write that asks it. An
 * administrator can reopen a semester - to correct a wrong remark, say - with a
 * reason that is kept, then close it again. Re-closing never overwrites the
 * record the first close wrote; re-stamping it is a separate act, and only an
 * open semester allows it.
 *
 * GET  term_snapshot.php                        every term that has data, and its state
 * GET  term_snapshot.php?action=preview&school_year_id=&semester_id=
 *                                               who would be stamped, and what would change
 * POST term_snapshot.php  {action: "close", school_year_id, semester_id}
 *                                               record the students and lock the semester
 * POST term_snapshot.php  {action: "reopen", school_year_id, semester_id, reason}
 *                                               unlock it; the reason is required and kept
 * POST term_snapshot.php  {action: "restamp", school_year_id, semester_id}
 *                                               overwrite the record with today's values
 *                                               (open semesters only). The older
 *                                               {restamp: true} body still means this.
 *
 * Gated on `settings`, not on a module of its own — the same reasoning
 * risk_model.php carries in api_endpoint_module_map(). Closing a term is a
 * system-wide administrative act that changes what every later report says about
 * the past, not case work. The Migration module, which is where the payoff
 * shows, stays read-only.
 */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/term_snapshot_lib.php';
// Which term the calendar is in: closing that one stops the imports, calls and
// case work that default to it, and the panel says so before it happens.
require_once __DIR__ . '/lib/academic_calendar.php';

function term_snapshot_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

try {
    $authUser = api_get_session_user();
    $database = new Database();
    $pdo = $database->connect();

    $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');

    if ($method === 'GET') {
        $action = trim((string)($_GET['action'] ?? ''));

        if ($action === 'preview') {
            $schoolYearId = (int)($_GET['school_year_id'] ?? 0);
            $semesterId = (int)($_GET['semester_id'] ?? 0);
            if ($schoolYearId <= 0 || $semesterId <= 0) {
                term_snapshot_out(400, ['message' => 'A school year and a semester are required.']);
            }
            term_snapshot_out(200, ['data' => term_snapshot_preview($pdo, $schoolYearId, $semesterId)]);
        }

        if ($action !== '') {
            term_snapshot_out(400, ['message' => 'Unknown action.']);
        }

        $calendar = academic_calendar_current($pdo);
        $terms = array_map(static function (array $term) use ($calendar): array {
            $term['is_calendar_term'] = (int)($calendar['school_year_id'] ?? 0) === $term['school_year_id']
                && (int)($calendar['semester_id'] ?? 0) === $term['semester_id'];
            return $term;
        }, term_snapshot_terms($pdo));

        term_snapshot_out(200, [
            'data' => [
                'terms' => $terms,
                // So the screen can say "run the migration first" rather than
                // fail on a missing table.
                'storage_ready' => term_snapshot_table_ready($pdo),
                'closure_ready' => term_closure_ready($pdo),
                'snapshot_fields' => TERM_SNAPSHOT_COLUMNS,
            ],
        ]);
    }

    if ($method === 'POST') {
        if (!term_snapshot_table_ready($pdo)) {
            term_snapshot_out(503, [
                'message' => 'Term records storage is not set up yet. Apply migrations/2026_08_22_student_term_snapshot.sql first.',
            ]);
        }

        $raw = file_get_contents('php://input');
        $body = json_decode($raw ?: '[]', true);
        if (!is_array($body)) {
            $body = [];
        }

        $schoolYearId = (int)($body['school_year_id'] ?? 0);
        $semesterId = (int)($body['semester_id'] ?? 0);
        if ($schoolYearId <= 0 || $semesterId <= 0) {
            term_snapshot_out(400, ['message' => 'A school year and a semester are required.']);
        }

        // An older client sends {restamp: true} and no action.
        $action = strtolower(trim((string)($body['action'] ?? '')));
        if ($action === '') {
            $action = !empty($body['restamp']) ? 'restamp' : 'close';
        }
        if (!in_array($action, ['close', 'reopen', 'restamp'], true)) {
            term_snapshot_out(400, ['message' => 'Unknown action.']);
        }

        // Closing and reopening need the lock table; re-stamping does not.
        if ($action !== 'restamp' && !term_closure_ready($pdo)) {
            term_snapshot_out(503, [
                'message' => 'Closing a semester is not set up yet. Apply migrations/2026_09_27_term_closure.sql first.',
            ]);
        }

        $actorUserId = isset($authUser['user_id']) ? (int)$authUser['user_id'] : null;
        $labels = term_snapshot_term_labels($pdo);
        $termLabel = term_closure_label(
            $labels['years'][$schoolYearId] ?? null,
            $labels['semesters'][$semesterId] ?? null,
            $schoolYearId,
            $semesterId
        );

        if ($action === 'close') {
            // A second close would change nothing, and saying so beats a 200
            // that suggests the click did something.
            $lock = term_closure_find($pdo, $schoolYearId, $semesterId);
            if ($lock !== null) {
                term_snapshot_out(409, [
                    'message' => term_closure_sentence($lock),
                    'code' => 'TERM_ALREADY_CLOSED',
                    'closed_at' => $lock['closed_at'],
                    'closed_by' => $lock['closed_by'],
                ]);
            }

            $result = term_snapshot_close_semester($pdo, $schoolYearId, $semesterId, $actorUserId);
            if ($result === null) {
                term_snapshot_out(422, [
                    'message' => 'No student has any record in that term, so there is nothing to close.',
                ]);
            }

            // After the commit: the audit write can run DDL, which would end a
            // transaction it found open.
            api_write_audit_log(
                $pdo,
                $authUser,
                'semester_closed',
                sprintf(
                    'Closed %s: its records are now read-only. %d student records held, %d newly recorded.',
                    $termLabel,
                    $result['snapshots_after'],
                    $result['inserted']
                ),
                $result
            );

            term_snapshot_out(200, [
                'message' => sprintf(
                    '%s is closed. Its grades, attendance, finance, enrollment standings and cases are now '
                    . 'read-only, and %d student %s recorded.',
                    $termLabel,
                    $result['students_in_term'],
                    $result['students_in_term'] === 1 ? 'record is' : 'records are'
                ),
                'data' => $result,
            ]);
        }

        if ($action === 'reopen') {
            // Reopening a finished semester is the act most worth explaining
            // later, so the explanation is required rather than invited.
            $reason = trim((string)($body['reason'] ?? ''));
            if ($reason === '') {
                term_snapshot_out(400, ['message' => 'Say why the semester is being reopened. The reason is kept with it.']);
            }
            $unsafe = api_reject_unsafe_fields(['reason' => $reason], ['reason' => 'The reason'], 'prose');
            if ($unsafe !== null) {
                term_snapshot_out(400, ['message' => $unsafe]);
            }
            if (mb_strlen($reason) > 255) {
                term_snapshot_out(400, ['message' => 'Keep the reason under 255 characters.']);
            }

            if (!term_closure_reopen($pdo, $schoolYearId, $semesterId, $actorUserId, $reason)) {
                term_snapshot_out(409, [
                    'message' => $termLabel . ' is not closed, so there is nothing to reopen.',
                    'code' => 'TERM_NOT_CLOSED',
                ]);
            }

            api_write_audit_log(
                $pdo,
                $authUser,
                'semester_reopened',
                sprintf('Reopened %s: %s', $termLabel, $reason),
                ['school_year_id' => $schoolYearId, 'semester_id' => $semesterId, 'reason' => $reason]
            );

            term_snapshot_out(200, [
                'message' => $termLabel . ' is open again. Close it once the corrections are made.',
                'data' => ['school_year_id' => $schoolYearId, 'semester_id' => $semesterId],
            ]);
        }

        // Re-stamp: overwrite what the students were with what they are now.
        // Never on a closed semester - its record is part of what closing froze.
        $closedTerm = term_closure_block($pdo, [$schoolYearId, $semesterId]);
        if ($closedTerm !== null) {
            term_snapshot_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);
        }

        $result = term_snapshot_close($pdo, $schoolYearId, $semesterId, true, $actorUserId);
        if ($result === null) {
            term_snapshot_out(422, [
                'message' => 'No student has any record in that term, so there is nothing to record.',
            ]);
        }

        api_write_audit_log(
            $pdo,
            $authUser,
            'term_snapshot_restamp',
            sprintf('Re-stamped %s: %d student records stamped.', $termLabel, $result['students_in_term']),
            $result
        );

        term_snapshot_out(200, [
            'message' => sprintf(
                '%s re-recorded. %d student %s now match the student files.',
                $termLabel,
                $result['students_in_term'],
                $result['students_in_term'] === 1 ? 'record' : 'records'
            ),
            'data' => $result,
        ]);
    }

    term_snapshot_out(405, ['message' => 'Method not allowed.']);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'term_snapshot.php']);
    term_snapshot_out(500, ['message' => 'Could not read the term records.']);
}
