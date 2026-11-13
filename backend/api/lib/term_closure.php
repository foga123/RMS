<?php
/**
 * Closed semesters: once a term is closed, its records are read-only.
 *
 * A term is closed from Settings > Close Semester, which records its students'
 * year level, section and course (term_snapshot.php) and closes it in the same
 * step. From then on nothing is filed under that school year and semester,
 * nothing already there changes, and nothing is removed. An administrator can
 * reopen it - to correct a wrong remark, say - and close it again afterwards;
 * both are audited, and the reopen asks why.
 *
 * THE RULE LIVES HERE, THE REFUSAL IN EACH ENDPOINT
 *
 * Every endpoint answers through its own responder (api_out, gradeimport_out,
 * financeimport_out, ...), so this file returns the refusal and never emits it.
 * academic_calendar_resolve_import_term() is built the same way for the same
 * reason.
 *
 * WHO ASKS - tests/term_closure_check.php holds this list against the code:
 *
 *   grades.php                         POST, PUT (the row's term and the one it
 *                                      would move to), DELETE
 *   grades-import.php                  the term being imported into
 *   attendance-import.php              the same
 *   finance.php                        POST, PUT, DELETE
 *   finance-import.php                 the term being imported into
 *   enrollment_status.php              POST, PUT, DELETE
 *   retention_case.php                 run_evaluation (per student), add_note, PUT
 *   lib/faculty_workspace.php          a faculty contact, filed under the
 *                                      calendar's term
 *   student_contact_workflow_lib.php   a coach's call and a CSDL outcome - below
 *   lib/survey_enrollment_status.php   the enrollment status a survey answer sets
 *   attendance_remark_policy.php       policy edits that would change how a
 *                                      closed term's attendance reads
 *   term_snapshot.php                  closing, reopening, re-stamping
 *
 * WORK THAT CARRIES ON AFTER A SEMESTER ENDS
 *
 * A coach's call and a CSDL visit outcome are not about a semester, but each
 * writes into one: the call updates the student's latest enrollment standing,
 * and a CSDL outcome is stamped with the term of the referral. When that term
 * is closed, the write goes to the calendar's current term instead - a new
 * standing there carrying the old status forward, an outcome stamped with the
 * current term - so the closed record is kept and the work is not refused.
 * Only when the current term is closed as well is it refused.
 *
 * A ROW WITH NO TERM IS NOT IN A CLOSED ONE
 *
 * Either half missing means the row is not filed under a semester, so nothing
 * here refuses it. Coach call attempts carry no term at all, which is why the
 * call log itself never needs this.
 *
 * BEFORE THE MIGRATION
 *
 * Without the term_closure table (migrations/2026_09_27_term_closure.sql)
 * every term reads as open, so the code can ship ahead of the migration.
 */

if (!defined('TERM_CLOSURE_LOADED')) {
    define('TERM_CLOSURE_LOADED', true);

    /** 423 Locked: the request was well formed; the term is not open to it. */
    define('TERM_CLOSURE_HTTP_STATUS', 423);

    /** What a client matches on, rather than on the sentence. */
    define('TERM_CLOSURE_CODE', 'TERM_CLOSED');

    /** Tables whose single rows the endpoints edit by id, and how each spells its term. */
    define('TERM_CLOSURE_ROW_TABLES', [
        'grades' => ['id' => 'grades_id', 'year' => 'school_year_id'],
        'finance' => ['id' => 'finance_id', 'year' => 'school_year_id'],
        'enrollment_status' => ['id' => 'enrollment_status_id', 'year' => 'school_year_id'],
        'retention_case' => ['id' => 'case_id', 'year' => 'school_year_id'],
    ]);
}

/**
 * A closed-term refusal from code that throws rather than returns a status.
 *
 * The contact workflow reports every refusal by throwing, and its endpoints
 * turn RuntimeException into a 400. Those endpoints catch this first and answer
 * TERM_CLOSURE_HTTP_STATUS with body(), so a closed term reads the same from
 * the Contact Workspace as from Grades.
 */
class TermClosedException extends RuntimeException
{
    private array $body;

    public function __construct(array $body)
    {
        parent::__construct((string)($body['message'] ?? 'This semester is closed.'));
        $this->body = $body;
    }

    public function body(): array
    {
        return $this->body;
    }
}

/** True once the migration has run. Before it, nothing is closed. */
function term_closure_ready(PDO $pdo): bool
{
    return api_table_exists($pdo, 'term_closure');
}

/**
 * The per-request cache of closed terms, one entry per connection.
 *
 * A class property rather than a function's static, because term_closure_forget()
 * has to empty it from outside: a close or a reopen changes the answer, and a
 * request that closed a term and then asked about it must not be told it is
 * still open.
 */
final class TermClosureCache
{
    /** @var array<int, array> closed terms keyed by spl_object_id() of the connection */
    public static array $closed = [];
}

/** Drops the cached answer. Called by every write in this file. */
function term_closure_forget(): void
{
    TermClosureCache::$closed = [];
}

/** An id from a request or a row: a positive int, or null for '', 0 and null. */
function term_closure_id($value): ?int
{
    if ($value === null || $value === '' || $value === false) {
        return null;
    }
    $id = (int)$value;
    return $id > 0 ? $id : null;
}

/** "2026-2027 1st Semester", the way Term Records names a term. */
function term_closure_label(?string $schoolYearName, ?string $semesterName, int $schoolYearId, int $semesterId): string
{
    $year = trim((string)$schoolYearName) !== '' ? trim((string)$schoolYearName) : 'SY ' . $schoolYearId;
    $semester = trim((string)$semesterName) !== '' ? trim((string)$semesterName) : 'Semester ' . $semesterId;
    return $year . ' ' . $semester;
}

/**
 * Every closed term, keyed "schoolYearId:semesterId".
 *
 * One query per request. A bulk evaluation asks once per student, and the
 * answer can only change through term_closure_close() and _reopen(), which
 * drop the cache.
 */
function term_closure_closed_terms(PDO $pdo): array
{
    $key = spl_object_id($pdo);
    if (array_key_exists($key, TermClosureCache::$closed)) {
        return TermClosureCache::$closed[$key];
    }

    if (!term_closure_ready($pdo)) {
        TermClosureCache::$closed[$key] = [];
        return [];
    }

    $rows = $pdo->query(
        "SELECT tc.school_year_id, tc.semester_id, tc.closed_at,
                sy.schoolyear_name, sem.semester_name,
                NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS closed_by
           FROM term_closure tc
           LEFT JOIN school_year sy ON sy.school_year_id = tc.school_year_id
           LEFT JOIN semester sem ON sem.semester_id = tc.semester_id
           LEFT JOIN user u ON u.user_id = tc.closed_by_user_id
          WHERE tc.closed_at IS NOT NULL
       ORDER BY sy.schoolyear_name DESC, tc.semester_id DESC"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $closed = [];
    foreach ($rows as $row) {
        $schoolYearId = (int)$row['school_year_id'];
        $semesterId = (int)$row['semester_id'];
        $closed[$schoolYearId . ':' . $semesterId] = [
            'school_year_id' => $schoolYearId,
            'semester_id' => $semesterId,
            // The names too: Students and Enrollment Status pick a school year
            // by name, not by id.
            'schoolyear_name' => $row['schoolyear_name'],
            'semester_name' => $row['semester_name'],
            'label' => term_closure_label($row['schoolyear_name'], $row['semester_name'], $schoolYearId, $semesterId),
            'closed_at' => $row['closed_at'],
            'closed_by' => $row['closed_by'],
        ];
    }

    TermClosureCache::$closed[$key] = $closed;
    return $closed;
}

/** The closed terms as a list, newest first, for the screens. */
function term_closure_list(PDO $pdo): array
{
    return array_values(term_closure_closed_terms($pdo));
}

/** The closure of one term, or null when it is open or either half is missing. */
function term_closure_find(PDO $pdo, $schoolYearId, $semesterId): ?array
{
    $year = term_closure_id($schoolYearId);
    $semester = term_closure_id($semesterId);
    if ($year === null || $semester === null) {
        return null;
    }
    return term_closure_closed_terms($pdo)[$year . ':' . $semester] ?? null;
}

function term_closure_is_closed(PDO $pdo, $schoolYearId, $semesterId): bool
{
    return term_closure_find($pdo, $schoolYearId, $semesterId) !== null;
}

/** The refusal as a sentence: which term, since when, and how to undo it. */
function term_closure_sentence(array $closure): string
{
    $closedAt = !empty($closure['closed_at']) ? strtotime((string)$closure['closed_at']) : false;
    return $closure['label'] . ' was closed'
        . ($closedAt ? ' on ' . date('j M Y', $closedAt) : '')
        . (!empty($closure['closed_by']) ? ' by ' . $closure['closed_by'] : '')
        . ', so its records cannot be changed. An administrator can reopen it in Settings > Close Semester.';
}

/** Why a write into this term is refused, or null when it may go ahead. */
function term_closure_refusal(PDO $pdo, $schoolYearId, $semesterId): ?string
{
    $closure = term_closure_find($pdo, $schoolYearId, $semesterId);
    return $closure === null ? null : term_closure_sentence($closure);
}

/**
 * The response body refusing a write, for the first closed term among those
 * given, or null when every one of them is open.
 *
 * Each argument is a [school_year_id, semester_id] pair. More than one is for a
 * write that touches two terms: an edit that moves a row is refused when the
 * row sits in a closed term AND when it would land in one.
 */
function term_closure_block(PDO $pdo, array ...$terms): ?array
{
    foreach ($terms as $term) {
        $closure = term_closure_find($pdo, $term[0] ?? null, $term[1] ?? null);
        if ($closure !== null) {
            return [
                'message' => term_closure_sentence($closure),
                'code' => TERM_CLOSURE_CODE,
                'term' => [
                    'school_year_id' => $closure['school_year_id'],
                    'semester_id' => $closure['semester_id'],
                    'label' => $closure['label'],
                ],
            ];
        }
    }
    return null;
}

/**
 * The term a row is filed under, as [school_year_id, semester_id], or null
 * when there is no such row.
 *
 * For the edits and deletes that arrive with an id and nothing else.
 */
function term_closure_row_term(PDO $pdo, string $table, int $id): ?array
{
    $meta = TERM_CLOSURE_ROW_TABLES[$table] ?? null;
    if ($meta === null) {
        throw new InvalidArgumentException("term_closure_row_term does not know the table $table.");
    }

    $stmt = $pdo->prepare(
        "SELECT `{$meta['year']}` AS school_year_id, semester_id
           FROM `$table` WHERE `{$meta['id']}` = :id LIMIT 1"
    );
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    return [term_closure_id($row['school_year_id']), term_closure_id($row['semester_id'])];
}

/**
 * Every term that has ever been closed, open again or not, keyed
 * "schoolYearId:semesterId", for Term Records.
 */
function term_closure_states(PDO $pdo): array
{
    if (!term_closure_ready($pdo)) {
        return [];
    }

    $rows = $pdo->query(
        "SELECT tc.school_year_id, tc.semester_id, tc.closed_at, tc.reopened_at, tc.reopen_reason,
                NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '') AS closed_by,
                NULLIF(TRIM(CONCAT_WS(' ', ru.first_name, ru.last_name)), '') AS reopened_by
           FROM term_closure tc
           LEFT JOIN user cu ON cu.user_id = tc.closed_by_user_id
           LEFT JOIN user ru ON ru.user_id = tc.reopened_by_user_id"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $states = [];
    foreach ($rows as $row) {
        $states[(int)$row['school_year_id'] . ':' . (int)$row['semester_id']] = [
            'is_closed' => $row['closed_at'] !== null,
            'closed_at' => $row['closed_at'],
            'closed_by' => $row['closed_by'],
            'reopened_at' => $row['reopened_at'],
            'reopened_by' => $row['reopened_by'],
            'reopen_reason' => $row['reopen_reason'],
        ];
    }
    return $states;
}

/**
 * Close a term. Returns false when it was already closed, which changes
 * nothing - the first close keeps its date and its name.
 *
 * The two assignments are in this order on purpose: MariaDB applies them left
 * to right, and closed_by must be decided while closed_at still holds its old
 * value.
 */
function term_closure_close(PDO $pdo, int $schoolYearId, int $semesterId, ?int $actorUserId): bool
{
    $stmt = $pdo->prepare(
        'INSERT INTO term_closure (school_year_id, semester_id, closed_at, closed_by_user_id)
         VALUES (:sy, :sem, NOW(), :user)
         ON DUPLICATE KEY UPDATE
            closed_by_user_id = IF(closed_at IS NULL, VALUES(closed_by_user_id), closed_by_user_id),
            closed_at = IF(closed_at IS NULL, VALUES(closed_at), closed_at)'
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId, ':user' => $actorUserId]);
    term_closure_forget();

    // 1 = a new row, 2 = a reopened row closed again, 0 = already closed.
    return $stmt->rowCount() > 0;
}

/**
 * Reopen a closed term. Returns false when it was not closed.
 *
 * The row stays, with the reopen written onto it, so Term Records can say the
 * semester is open again on purpose rather than never having been closed.
 */
function term_closure_reopen(PDO $pdo, int $schoolYearId, int $semesterId, ?int $actorUserId, string $reason): bool
{
    $stmt = $pdo->prepare(
        'UPDATE term_closure
            SET closed_at = NULL,
                reopened_at = NOW(),
                reopened_by_user_id = :user,
                reopen_reason = :reason
          WHERE school_year_id = :sy AND semester_id = :sem AND closed_at IS NOT NULL'
    );
    $stmt->execute([
        ':user' => $actorUserId,
        ':reason' => mb_substr($reason, 0, 255),
        ':sy' => $schoolYearId,
        ':sem' => $semesterId,
    ]);
    term_closure_forget();

    return $stmt->rowCount() > 0;
}
