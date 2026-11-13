<?php
/**
 * Which school years may still be written to.
 *
 * One question, asked by two policy engines and about to be asked by a third.
 * It was answered inside grade_remark_service.php, which was fine while grades
 * were the only thing with a policy -- but "is this year frozen?" is not a fact
 * about grades, and a second copy of it in the attendance service would be a
 * second place for the answer to drift.
 *
 * ---------------------------------------------------------------------------
 * THE TRAP THIS FILE EXISTS TO AVOID
 *
 * The obvious implementation compares school_year_id. It is wrong here, and
 * wrong in a way that does damage rather than throwing:
 *
 *     school_year_id  1 -> 2025-2026
 *                     2 -> 2026-2027   <- is_current
 *                     3 -> 2022-2023
 *
 * The ids are insertion order, not chronological order. `id >= current_id`
 * calls 2022-2023 a later year than 2026-2027 and would happily recompute
 * four-year-old records against a policy written this August.
 *
 * The names are "YYYY-YYYY" and sort correctly as strings, so the comparison is
 * on the NAME. That is the only comparison in this file and everything else is
 * lookup around it.
 * ---------------------------------------------------------------------------
 *
 * With no current year set, NOTHING is open. Leaving records alone is always
 * recoverable; guessing which year an administrator meant and rewriting the
 * wrong one is not.
 */

if (!defined('SCHOOL_YEAR_WINDOW_LOADED')) {
    define('SCHOOL_YEAR_WINDOW_LOADED', true);

/**
 * The school year the portal treats as now, or null when nobody has said.
 *
 * Deliberately not MAX(school_year_id) -- see the file docblock. Cached for the
 * request because every row of a bulk recompute asks the same question.
 */
function sy_window_current(PDO $pdo): ?array
{
    static $cached = false;
    static $current = null;

    if ($cached) {
        return $current;
    }
    $cached = true;

    if (!api_table_exists($pdo, 'school_year')) {
        return null;
    }

    // A database that predates the is_current migration has no line to read, so
    // there is no current year rather than an error: every caller already
    // handles "nobody has said" and degrading is better than a 500 on a screen
    // that would otherwise work.
    $columns = $pdo->query("SHOW COLUMNS FROM `school_year` LIKE 'is_current'")->fetchAll();
    if (!$columns) {
        return null;
    }

    $row = $pdo->query(
        'SELECT school_year_id, schoolyear_name FROM school_year WHERE is_current = 1 LIMIT 1'
    )->fetch(PDO::FETCH_ASSOC);

    $current = $row ? [
        'school_year_id' => (int)$row['school_year_id'],
        'schoolyear_name' => (string)$row['schoolyear_name'],
    ] : null;

    return $current;
}

/** A school year's name, or null. Cached: resolution asks per policy row. */
function sy_window_name(PDO $pdo, int $schoolYearId): ?string
{
    static $names = [];

    if (array_key_exists($schoolYearId, $names)) {
        return $names[$schoolYearId];
    }

    $stmt = $pdo->prepare('SELECT schoolyear_name FROM school_year WHERE school_year_id = :id LIMIT 1');
    $stmt->execute([':id' => $schoolYearId]);
    $name = $stmt->fetchColumn();

    $names[$schoolYearId] = ($name === false || $name === null || $name === '') ? null : (string)$name;
    return $names[$schoolYearId];
}

/**
 * Is this year the current one or a later one?
 *
 * The year-independent fallback (null) is NOT open. That reads oddly at first --
 * the fallback is the one policy an administrator most often edits -- but the
 * question here is about a YEAR, and null is not a year. Callers that mean "may
 * this policy be edited" ask sy_window_policy_is_editable() instead, which knows
 * that a fallback is editable and a pinned closed year is not.
 */
function sy_window_year_is_open(PDO $pdo, ?int $schoolYearId): bool
{
    if ($schoolYearId === null) {
        return false;
    }

    $current = sy_window_current($pdo);
    if ($current === null) {
        return false;
    }
    if ($current['school_year_id'] === $schoolYearId) {
        return true;
    }

    $name = sy_window_name($pdo, $schoolYearId);
    if ($name === null) {
        return false;
    }

    return strcmp($name, $current['schoolyear_name']) >= 0;
}

/**
 * May a policy scoped to this year be created or edited?
 *
 * The fallback may: it is what governs a year nobody has configured, including
 * next year, and freezing it would mean no policy could ever be written for a
 * fresh database. A pinned year may only if that year is still open.
 *
 * The cost of an editable fallback is real and worth naming: it also governs
 * closed years that have no policy of their own, so editing it can restate what
 * a finished year's records mean. That is why the attendance migration pins a
 * policy to every year that already holds records -- with one, the fallback can
 * no longer reach them.
 */
function sy_window_policy_is_editable(PDO $pdo, ?int $schoolYearId): bool
{
    return $schoolYearId === null || sy_window_year_is_open($pdo, $schoolYearId);
}

/**
 * Every school year with the two flags a policy editor needs.
 *
 * Returned as one list rather than as "open years" alone, because a closed year
 * has to be VISIBLE and disabled. Hiding it makes an administrator wonder where
 * 2025-2026 went; showing it greyed tells them it is frozen, which is the fact
 * they actually need.
 */
function sy_window_years(PDO $pdo): array
{
    if (!api_table_exists($pdo, 'school_year')) {
        return [];
    }

    $current = sy_window_current($pdo);
    $rows = $pdo->query(
        'SELECT school_year_id, schoolyear_name, is_current FROM school_year ORDER BY schoolyear_name'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    foreach ($rows as $index => $row) {
        $name = (string)$row['schoolyear_name'];
        $rows[$index]['school_year_id'] = (int)$row['school_year_id'];
        $rows[$index]['is_current'] = (int)$row['is_current'];
        $rows[$index]['is_open'] = $current !== null && strcmp($name, $current['schoolyear_name']) >= 0 ? 1 : 0;
    }

    return $rows;
}

/**
 * The year immediately before this one, by name, or null.
 *
 * What "previous" means when a report compares two terms. By name for the same
 * reason everything else here is: the row before 2026-2027 in id order is
 * 2025-2026 only by luck, and in this database the row after it is 2022-2023.
 *
 * Only years that exist are returned -- there is no arithmetic on the label, so
 * a gap in the list is skipped rather than producing a year nobody created.
 */
function sy_window_previous(PDO $pdo, int $schoolYearId): ?array
{
    $name = sy_window_name($pdo, $schoolYearId);
    if ($name === null) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT school_year_id, schoolyear_name
           FROM school_year
          WHERE schoolyear_name < :name
       ORDER BY schoolyear_name DESC
          LIMIT 1'
    );
    $stmt->execute([':name' => $name]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ? [
        'school_year_id' => (int)$row['school_year_id'],
        'schoolyear_name' => (string)$row['schoolyear_name'],
    ] : null;
}

/**
 * The TERM immediately before this one - year and semester together.
 *
 * sy_window_previous() above answers for a whole year; a report comparing
 * "this term against the one before" needs the semester too, and the term
 * before 1st Semester is the last semester of the previous YEAR rather than
 * nothing at all.
 *
 * Two copies of this lived in student_migration.php and retention_matrix.php,
 * both ordering by school_year_id and both carrying a docblock that said so:
 * "Terms order by (school_year_id, semester_id)". They do not, which is the
 * whole subject of this file's header. Measured against the seven years in
 * this database, 3 of the 21 terms got the wrong answer - 2022-2023 1st
 * Semester was told its previous term was 2026-2027 Summer, four years in the
 * future, and 2025-2026 1st Semester was told it had no previous term at all
 * when 2024-2025 Summer sits right before it.
 *
 * Semesters keep their id order. Those ids ARE the sequence - 1st, 2nd,
 * Summer - and unlike school years they were inserted in that order.
 *
 * Returns nulls rather than throwing when either argument is missing, because
 * every caller renders "no previous term" as an ordinary state: a page opened
 * on the earliest term on record has nothing to compare against and says so.
 */
function sy_window_previous_term(PDO $pdo, ?int $schoolYearId, ?int $semesterId): array
{
    $none = ['school_year_id' => null, 'semester_id' => null];
    if (!$schoolYearId || !$semesterId) {
        return $none;
    }

    $stmt = $pdo->prepare(
        "SELECT sy.school_year_id, sem.semester_id
           FROM school_year sy
           CROSS JOIN semester sem
           JOIN school_year cur ON cur.school_year_id = :sy
          WHERE (sy.schoolyear_name < cur.schoolyear_name)
             OR (sy.school_year_id = cur.school_year_id AND sem.semester_id < :sem)
       ORDER BY sy.schoolyear_name DESC, sem.semester_id DESC
          LIMIT 1"
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row
        ? ['school_year_id' => (int)$row['school_year_id'], 'semester_id' => (int)$row['semester_id']]
        : $none;
}

/**
 * The next term a student ENROLLS for - what retention is chasing.
 *
 * The counterpart of sy_window_previous_term(), ordered the same way (year by
 * name, semester by id), with one difference: Summer is skipped. Nobody is
 * retained into a summer term, so during 2nd Semester the enrollment that
 * matters is next year's 1st, not the optional summer in between.
 *
 * Returns names as well as ids, because every caller puts the term on screen.
 * Nulls when the current term is unknown or nothing follows it.
 */
function sy_window_next_enrollment_term(PDO $pdo, ?int $schoolYearId, ?int $semesterId): array
{
    $none = ['school_year_id' => null, 'schoolyear_name' => null, 'semester_id' => null, 'semester_name' => null];
    if (!$schoolYearId || !$semesterId) {
        return $none;
    }

    $stmt = $pdo->prepare(
        "SELECT sy.school_year_id, sy.schoolyear_name, sem.semester_id, sem.semester_name
           FROM school_year sy
           CROSS JOIN semester sem
           JOIN school_year cur ON cur.school_year_id = :sy
          WHERE LOWER(sem.semester_name) NOT LIKE '%summer%'
            AND ((sy.schoolyear_name > cur.schoolyear_name)
              OR (sy.school_year_id = cur.school_year_id AND sem.semester_id > :sem))
       ORDER BY sy.schoolyear_name ASC, sem.semester_id ASC
          LIMIT 1"
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row
        ? [
            'school_year_id' => (int)$row['school_year_id'],
            'schoolyear_name' => (string)$row['schoolyear_name'],
            'semester_id' => (int)$row['semester_id'],
            'semester_name' => (string)$row['semester_name'],
        ]
        : $none;
}

}
