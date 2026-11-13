<?php
/**
 * Reading and writing the per-term record of what each student was.
 *
 * Separate from term_snapshot.php so it can be exercised without firing a
 * request: the endpoint runs its whole dispatch on load, which makes every
 * function in it unreachable from a test. Nothing here writes a response or
 * exits — callers decide what an empty result means.
 *
 * See term_snapshot.php for why closing a term is worth doing and when doing it
 * is dishonest.
 */

// Closing a semester also locks it - see lib/term_closure.php.
require_once __DIR__ . '/lib/term_closure.php';

if (!defined('TERM_SNAPSHOT_LIB')) {
    define('TERM_SNAPSHOT_LIB', true);

    /**
     * The attributes that belong to a student IN a term, and so are worth copying.
     *
     * Names, contact details, parents and addresses are deliberately absent:
     * those are corrections to one fact about a person, not per-term values, and
     * snapshotting them produces eight rows saying the same thing plus a
     * "historical" name that is really a typo somebody fixed.
     *
     * Every name here must exist as a column on BOTH `student` and
     * `student_term_snapshot` — the write is an INSERT ... SELECT that names the
     * same list on each side. term_snapshot_guard_check.php asserts it.
     */
    define('TERM_SNAPSHOT_COLUMNS', [
        'year_level',
        'section',
        // Set by the year-end migration (2026-10-06). NULL on older snapshots: unknown.
        'is_irregular',
        'course_id',
        'star e-profile',
        'modality',
        'coaching_unit',
        'final_scholarship_grant',
    ]);

    /**
     * Where a student can leave evidence of having been in a term.
     *
     * Keyed by table, valued by that table's school-year column. `attendance`
     * spells it schoolyear_id while the other four use school_year_id, and
     * reading the spelling from here rather than assuming it is what keeps the
     * union from silently dropping a source — a dropped source does not error,
     * it just under-counts who was in the term.
     */
    define('TERM_SNAPSHOT_SOURCES', [
        'grades'            => ['year' => 'school_year_id', 'archived' => 'archived_at'],
        'attendance'        => ['year' => 'schoolyear_id',  'archived' => null],
        'finance'           => ['year' => 'school_year_id', 'archived' => null],
        'retention_case'    => ['year' => 'school_year_id', 'archived' => null],
        'enrollment_status' => ['year' => 'school_year_id', 'archived' => 'archived_at'],
    ]);

    /** How many drifted students a preview lists before it just gives the count. */
    define('TERM_SNAPSHOT_REWRITE_SAMPLE', 50);
}

/** True once the migration has been applied; every read degrades gracefully until then. */
function term_snapshot_table_ready(PDO $pdo): bool
{
    static $ready = null;
    if ($ready === null) {
        $ready = api_table_exists($pdo, 'student_term_snapshot');
    }
    return $ready;
}

/**
 * A SELECT of every student who left a record in one term, bound to :sy and :sem.
 *
 * UNION rather than UNION ALL: a student with grades and attendance and a
 * retention case is one student, and the point of the set is who was there.
 */
function term_snapshot_population_sql(): string
{
    $parts = [];
    foreach (TERM_SNAPSHOT_SOURCES as $table => $meta) {
        $where = "WHERE {$meta['year']} = :sy AND semester_id = :sem";
        if ($meta['archived']) {
            $where .= " AND {$meta['archived']} IS NULL";
        }
        $parts[] = "SELECT student_id FROM `$table` $where";
    }

    return implode(' UNION ', $parts);
}

/** The student ids that a close would cover, for one term. */
function term_snapshot_population(PDO $pdo, int $schoolYearId, int $semesterId): array
{
    $sql = 'SELECT DISTINCT student_id FROM (' . term_snapshot_population_sql() . ') pop
             WHERE student_id IS NOT NULL';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);

    return array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
}

/**
 * Every term that has any data, newest first, with its snapshot state.
 *
 * Terms come from the data rather than from school_year CROSS JOIN semester:
 * the cross product is fourteen rows of which three exist, and offering to
 * "close" a term nobody recorded anything in is offering to write an empty
 * snapshot.
 */
function term_snapshot_terms(PDO $pdo): array
{
    // Each source spells its school-year column differently, so every branch
    // projects to a common name before the union.
    $parts = [];
    foreach (TERM_SNAPSHOT_SOURCES as $table => $meta) {
        $where = $meta['archived'] ? "WHERE {$meta['archived']} IS NULL" : '';
        $parts[] = "SELECT {$meta['year']} AS school_year_id, semester_id, student_id FROM `$table` $where";
    }

    // Ordered by the year's NAME - school_year_id is insertion order, so id
    // order puts 2022-2023 after 2026-2027. See lib/school_year_window.php.
    // MAX() rather than a bare column so the ORDER BY stays legal under
    // ONLY_FULL_GROUP_BY; the join is on the primary key, so it is exact.
    $sql = 'SELECT t.school_year_id, t.semester_id, COUNT(DISTINCT t.student_id) AS students
              FROM (' . implode(' UNION ', $parts) . ') t
         LEFT JOIN school_year sy ON sy.school_year_id = t.school_year_id
             WHERE t.school_year_id IS NOT NULL
               AND t.semester_id IS NOT NULL
               AND t.student_id IS NOT NULL
          GROUP BY t.school_year_id, t.semester_id
          ORDER BY MAX(sy.schoolyear_name) DESC, t.semester_id DESC';

    $terms = $pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC);
    $labels = term_snapshot_term_labels($pdo);
    $snapshots = term_snapshot_closures($pdo);
    $locks = term_closure_states($pdo);

    $rows = [];
    foreach ($terms as $index => $term) {
        $schoolYearId = (int)$term['school_year_id'];
        $semesterId = (int)$term['semester_id'];
        $key = $schoolYearId . ':' . $semesterId;
        $snapshot = $snapshots[$key] ?? null;
        $lock = $locks[$key] ?? null;

        $rows[] = [
            'school_year_id' => $schoolYearId,
            'semester_id' => $semesterId,
            'school_year_name' => $labels['years'][$schoolYearId] ?? ('SY ' . $schoolYearId),
            'semester_name' => $labels['semesters'][$semesterId] ?? ('Semester ' . $semesterId),
            'students_with_records' => (int)$term['students'],
            // Closed now: its records are read-only. See lib/term_closure.php.
            'is_closed' => (bool)($lock['is_closed'] ?? false),
            'closed_at' => $lock['closed_at'] ?? null,
            'closed_by' => $lock['closed_by'] ?? null,
            // Set when an administrator opened it again, and why.
            'reopened_at' => $lock['reopened_at'] ?? null,
            'reopened_by' => $lock['reopened_by'] ?? null,
            'reopen_reason' => $lock['reopen_reason'] ?? null,
            // What each student was, as written down by the first close.
            'has_snapshot' => $snapshot !== null,
            'snapshot_students' => $snapshot ? (int)$snapshot['students'] : 0,
            'recorded_at' => $snapshot['closed_at'] ?? null,
            'recorded_by' => $snapshot['closed_by'] ?? null,
            // The newest term with data. Closing this one records what students
            // are now, which is what they are; closing an older one records what
            // they are now as what they were then, which is a guess.
            'is_latest_term' => $index === 0,
        ];
    }

    return $rows;
}

function term_snapshot_term_labels(PDO $pdo): array
{
    return [
        'years' => $pdo->query('SELECT school_year_id, schoolyear_name FROM school_year')->fetchAll(PDO::FETCH_KEY_PAIR),
        'semesters' => $pdo->query('SELECT semester_id, semester_name FROM semester')->fetchAll(PDO::FETCH_KEY_PAIR),
    ];
}

/** What has already been stamped, keyed "schoolYearId:semesterId". */
function term_snapshot_closures(PDO $pdo): array
{
    if (!term_snapshot_table_ready($pdo)) {
        return [];
    }

    $sql = "SELECT s.school_year_id,
                   s.semester_id,
                   COUNT(*) AS students,
                   MAX(s.recorded_at) AS closed_at,
                   MAX(CONCAT_WS(' ', u.first_name, u.last_name)) AS closed_by
              FROM student_term_snapshot s
         LEFT JOIN user u ON u.user_id = s.recorded_by_user_id
          GROUP BY s.school_year_id, s.semester_id";

    $rows = [];
    foreach ($pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $rows[(int)$row['school_year_id'] . ':' . (int)$row['semester_id']] = [
            'students' => (int)$row['students'],
            'closed_at' => $row['closed_at'],
            'closed_by' => trim((string)$row['closed_by']) ?: null,
        ];
    }

    return $rows;
}

/**
 * What a close would write, without writing it.
 *
 * Three counts the person clicking the button actually needs: how many rows are
 * new, how many already exist and match, and how many already exist but no
 * longer match the student record — the last being the only interesting number,
 * because it is the history a re-stamp would rewrite.
 */
/**
 * The snapshot columns as a SQL list, every name quoted.
 *
 * Quoted rather than joined raw because one of them is `star e-profile`, which
 * carries a space and a hyphen: unquoted it parses as three tokens and the
 * statement dies with a syntax error. The list is interpolated into a SELECT,
 * an INSERT column list and the SELECT that feeds it, so the quoting has to
 * happen once here rather than at each of the three.
 */
function term_snapshot_column_sql(): string
{
    return implode(', ', array_map(static fn(string $column): string => "`$column`", TERM_SNAPSHOT_COLUMNS));
}

function term_snapshot_preview(PDO $pdo, int $schoolYearId, int $semesterId): array
{
    $population = term_snapshot_population($pdo, $schoolYearId, $semesterId);
    $columns = term_snapshot_column_sql();
    $existing = [];

    if (term_snapshot_table_ready($pdo)) {
        $stmt = $pdo->prepare(
            "SELECT student_id, $columns FROM student_term_snapshot
              WHERE school_year_id = :sy AND semester_id = :sem"
        );
        $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $existing[(int)$row['student_id']] = $row;
        }
    }

    $new = 0;
    $unchanged = 0;
    $drifted = [];

    if ($population) {
        $placeholders = implode(',', array_fill(0, count($population), '?'));
        $stmt = $pdo->prepare(
            "SELECT student_id, student_number, first_name, last_name, $columns
               FROM student WHERE student_id IN ($placeholders)"
        );
        $stmt->execute($population);

        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $student) {
            $studentId = (int)$student['student_id'];
            $stored = $existing[$studentId] ?? null;

            if ($stored === null) {
                $new++;
                continue;
            }

            $changes = [];
            foreach (TERM_SNAPSHOT_COLUMNS as $column) {
                // Compared as strings because both sides arrive as strings from
                // PDO; NULL and '' both flatten to '' here, which is right — the
                // pair means "not recorded" either way, and calling that a change
                // would report drift on every student with an empty section.
                if ((string)$stored[$column] !== (string)$student[$column]) {
                    $changes[] = [
                        'field' => $column,
                        'snapshot' => $stored[$column],
                        'student_now' => $student[$column],
                    ];
                }
            }

            if ($changes) {
                $drifted[] = [
                    'student_id' => $studentId,
                    'student_number' => $student['student_number'],
                    'name' => trim($student['first_name'] . ' ' . $student['last_name']),
                    'changes' => $changes,
                ];
            } else {
                $unchanged++;
            }
        }
    }

    return [
        'school_year_id' => $schoolYearId,
        'semester_id' => $semesterId,
        'students_with_records' => count($population),
        'would_insert' => $new,
        'already_matching' => $unchanged,
        'would_rewrite' => count($drifted),
        // Capped: the list is here to be read, and a reader shown 300 rows of
        // drift has learned exactly what the count already told them.
        'rewrites' => array_slice($drifted, 0, TERM_SNAPSHOT_REWRITE_SAMPLE),
        'rewrites_truncated' => count($drifted) > TERM_SNAPSHOT_REWRITE_SAMPLE,
    ];
}

/**
 * Copy the student attributes into the snapshot for one term.
 *
 * Returns null when no student has a record in the term — there is nothing to
 * write, and an empty snapshot would claim the term was closed.
 */
function term_snapshot_close(PDO $pdo, int $schoolYearId, int $semesterId, bool $restamp, ?int $actorUserId): ?array
{
    $population = term_snapshot_population($pdo, $schoolYearId, $semesterId);
    if (!$population) {
        return null;
    }

    $columns = term_snapshot_column_sql();
    $placeholders = implode(',', array_fill(0, count($population), '?'));

    /*
     * ON DUPLICATE KEY is doing the work of two different intentions, so both
     * branches are spelled out rather than left to a default:
     *
     *   restamp on   overwrite the stored values with today's
     *   restamp off  leave the stored row exactly as it is
     *
     * The no-op branch assigns snapshot_id to itself, which is the standard way
     * to say "conflict is fine, change nothing". Without a clause at all the
     * unique key would abort the whole statement, taking the genuinely new rows
     * down with it — a term that gained one student since it was closed could
     * never record them.
     */
    $updates = [];
    foreach (TERM_SNAPSHOT_COLUMNS as $column) {
        $updates[] = "`$column` = VALUES(`$column`)";
    }
    $updates[] = 'recorded_at = VALUES(recorded_at)';
    $updates[] = 'recorded_by_user_id = VALUES(recorded_by_user_id)';

    $conflict = $restamp
        ? ' ON DUPLICATE KEY UPDATE ' . implode(', ', $updates)
        : ' ON DUPLICATE KEY UPDATE snapshot_id = snapshot_id';

    $sql = "INSERT INTO student_term_snapshot
                (student_id, school_year_id, semester_id, $columns, recorded_at, recorded_by_user_id)
            SELECT st.student_id, ?, ?, $columns, NOW(), ?
              FROM student st
             WHERE st.student_id IN ($placeholders)"
        . $conflict;

    $before = term_snapshot_closures($pdo)[$schoolYearId . ':' . $semesterId]['students'] ?? 0;

    // Joins a transaction the caller already holds - closing a semester writes
    // this and the lock as one - and opens its own otherwise.
    $ownTransaction = !$pdo->inTransaction();
    if ($ownTransaction) {
        $pdo->beginTransaction();
    }
    try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute(array_merge([$schoolYearId, $semesterId, $actorUserId], $population));
        if ($ownTransaction) {
            $pdo->commit();
        }
    } catch (Throwable $e) {
        if ($ownTransaction && $pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    $after = term_snapshot_closures($pdo)[$schoolYearId . ':' . $semesterId]['students'] ?? 0;

    return [
        'school_year_id' => $schoolYearId,
        'semester_id' => $semesterId,
        'students_in_term' => count($population),
        'snapshots_before' => $before,
        'snapshots_after' => $after,
        'inserted' => $after - $before,
        'restamped' => $restamp,
    ];
}

/**
 * Close a semester: record its students and lock its records, as one write.
 *
 * The record never overwrites here. A semester closed, reopened to correct a
 * remark and closed again keeps what its students were the first time, and
 * gains only students recorded since. Re-stamping is a separate, deliberate
 * act - term_snapshot_close() with $restamp - and only an open term allows it.
 *
 * Returns null when no student has a record in the term: an empty record
 * would claim a semester nobody was in.
 */
function term_snapshot_close_semester(PDO $pdo, int $schoolYearId, int $semesterId, ?int $actorUserId): ?array
{
    if (!term_snapshot_population($pdo, $schoolYearId, $semesterId)) {
        return null;
    }

    $pdo->beginTransaction();
    try {
        $result = term_snapshot_close($pdo, $schoolYearId, $semesterId, false, $actorUserId);
        term_closure_close($pdo, $schoolYearId, $semesterId, $actorUserId);
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        term_closure_forget();
        throw $e;
    }

    return $result;
}
