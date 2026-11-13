<?php
/**
 * Reading one term's records: who was in it, and what each of the three modules
 * says about them.
 *
 * Extracted from term_comparison.php when the Records Logbook needed the same
 * three rollups. They are not obvious rollups -- each has a convention already
 * agreed across modules, and each is agreed for a different reason -- so a
 * second copy would not have been a duplicate so much as a slow disagreement.
 *
 * ---------------------------------------------------------------------------
 * THE THREE CONVENTIONS, AND WHY THEY DIFFER
 *
 *   grades      the latest periodical, else the whole-term row.  A term row
 *               sitting beside periodicals is the older import, not a final
 *               result somebody entered on purpose. (grades.php)
 *   attendance  SUM of the periodicals when there are any, else the term row.
 *               Different from grades ON PURPOSE: classes conducted accumulate,
 *               so P1+P2+P3 IS the semester -- adding the legacy term row on top
 *               is the 20+20+20-alongside-52-makes-112 bug attendance-summary.php
 *               documents. (attendance-summary.php)
 *   finance     latest by date, a periodical breaking a tie against a term row
 *               on the same date. (finance.php)
 *
 * When an explicit period is asked for, none of that applies: the request is
 * about one periodical and the answer is that periodical's own row.
 * ---------------------------------------------------------------------------
 */

require_once __DIR__ . '/school_year_window.php';

if (!defined('TERM_RECORDS_LOADED')) {
    define('TERM_RECORDS_LOADED', true);

/** A query value as an int, or null for "not supplied". */
function term_records_int($value): ?int {
    return ($value === null || $value === '') ? null : (int)$value;
}

function term_records_rate(float $part, float $whole): ?float {
    return $whole > 0 ? round($part / $whole * 100, 2) : null;
}

/** The average of the values that exist, ignoring the ones that do not. */
function term_records_average(array $values): ?float {
    $known = array_values(array_filter($values, static fn($v) => $v !== null));
    if (!$known) {
        return null;
    }
    return round(array_sum($known) / count($known), 2);
}

/**
 * The cohort filter, as a SQL fragment on aliases `st` and `c`.
 *
 * Campus reaches the student through course -> department -> campus, so the
 * caller's JOINs have to be present for the fragment to compile. Every consumer
 * in this file uses the same JOIN list, which is why it is spelled out in
 * tcmp_population_sql() rather than assembled per query.
 */
function term_records_student_filter(array $query, array &$params): string {
    $clauses = ['st.archived_at IS NULL'];

    if (($courseId = term_records_int($query['course_id'] ?? null)) !== null) {
        $clauses[] = 'st.course_id = :course_id';
        $params[':course_id'] = $courseId;
    }
    if (($yearLevel = term_records_int($query['year_level'] ?? null)) !== null) {
        $clauses[] = 'st.year_level = :year_level';
        $params[':year_level'] = $yearLevel;
    }
    if (($departmentId = term_records_int($query['department_id'] ?? null)) !== null) {
        /*
         * The department across every campus that runs it, not the single row.
         *
         * CITE Carmen and CITE Puerto are two `department` rows sharing a code,
         * and a dean is appointed to the department rather than to the campus
         * hosting their row — so `department_id = :x` showed them a fraction of
         * their own students. api_department_scope_sql() is the same fragment
         * the other scoped endpoints use, and it still binds exactly one
         * parameter, so nothing about the call site changes.
         */
        $clauses[] = api_department_scope_sql('c.department_id');
        $params[':department_id'] = $departmentId;
    }
    if (($campusId = term_records_int($query['campus_id'] ?? null)) !== null) {
        $clauses[] = 'd.campus_id = :campus_id';
        $params[':campus_id'] = $campusId;
    }
    if (($studentType = trim((string)($query['student_type'] ?? ''))) !== '') {
        // Backticked because the column is literally named `star e-profile`,
        // space and hyphen included; unquoted it parses as three tokens.
        $clauses[] = 'st.`star e-profile` = :student_type';
        $params[':student_type'] = $studentType;
    }

    return implode(' AND ', $clauses);
}

/** Every student in the cohort, with the identity columns the table shows. */
function term_records_cohort(PDO $pdo, array $query): array {
    $params = [];
    $where = term_records_student_filter($query, $params);

    $stmt = $pdo->prepare(
        "SELECT st.student_id, st.student_number, st.first_name, st.last_name,
                st.year_level, st.section, st.modality, st.final_scholarship_grant,
                st.`star e-profile` AS student_type,
                c.course_code, c.course_name, d.department_code
           FROM student st
           LEFT JOIN course c ON c.course_id = st.course_id
           LEFT JOIN department d ON d.department_id = c.department_id
          WHERE $where"
    );
    $stmt->execute($params);

    $cohort = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $cohort[(int)$row['student_id']] = [
            'student_id' => (int)$row['student_id'],
            'student_number' => (string)$row['student_number'],
            'name' => trim(((string)$row['last_name']) . ', ' . ((string)$row['first_name'])),
            'year_level' => term_records_int($row['year_level']),
            'section' => $row['section'] ?? null,
            'modality' => $row['modality'] ?? null,
            'scholarship' => $row['final_scholarship_grant'] ?? null,
            'student_type' => $row['student_type'] ?? null,
            'course_code' => $row['course_code'] ?? null,
            'department_code' => $row['department_code'] ?? null,
        ];
    }

    return $cohort;
}

/**
 * The grade rollup for one term, keyed by student id.
 *
 * `pass_rate` is COMPUTED, never read from grades.passed_of_subject: 2,382 of
 * the 3,382 grade rows carry 0.00 in that column because no importer ever filled
 * it in, so a report that trusted it would show a student who passed all eight
 * subjects at 0%. The `grades_with_pass_rate` view draws the same distinction.
 */
function term_records_grades(PDO $pdo, int $schoolYearId, int $semesterId, ?int $period, array $studentIds): array {
    if (!$studentIds) {
        return [];
    }
    $ids = implode(',', array_map('intval', $studentIds));

    if ($period !== null) {
        $sql = "SELECT g.student_id, g.total_subject, g.passed, g.failed, g.incomplete,
                       g.no_credit, g.no_grade, g.remark_id, r.remark_name
                  FROM grades g
                  LEFT JOIN remarks r ON r.remark_id = g.remark_id
                 WHERE g.archived_at IS NULL AND g.student_id IN ($ids)
                   AND g.school_year_id = :sy AND g.semester_id = :sem AND g.period = :period";
        $params = [':sy' => $schoolYearId, ':sem' => $semesterId, ':period' => $period];
    } else {
        // Latest periodical first, whole-term row only where there is none.
        $sql = "SELECT student_id, total_subject, passed, failed, incomplete,
                       no_credit, no_grade, remark_id, remark_name
                  FROM (
                        SELECT g.student_id, g.total_subject, g.passed, g.failed, g.incomplete,
                               g.no_credit, g.no_grade, g.remark_id, r.remark_name,
                               ROW_NUMBER() OVER (
                                   PARTITION BY g.student_id
                                   ORDER BY (g.period IS NULL) ASC, g.period DESC, g.grades_id DESC
                               ) AS pick
                          FROM grades g
                          LEFT JOIN remarks r ON r.remark_id = g.remark_id
                         WHERE g.archived_at IS NULL AND g.student_id IN ($ids)
                           AND g.school_year_id = :sy AND g.semester_id = :sem
                  ) ranked
                 WHERE pick = 1";
        $params = [':sy' => $schoolYearId, ':sem' => $semesterId];
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $total = (int)($row['total_subject'] ?? 0);
        $passed = (int)($row['passed'] ?? 0);
        $out[(int)$row['student_id']] = [
            'total_subject' => $total,
            'passed' => $passed,
            'failed' => (int)($row['failed'] ?? 0),
            'incomplete' => (int)($row['incomplete'] ?? 0),
            'no_credit' => (int)($row['no_credit'] ?? 0),
            'no_grade' => (int)($row['no_grade'] ?? 0),
            'pass_rate' => term_records_rate((float)$passed, (float)$total),
            'remark' => $row['remark_name'] ?? null,
        ];
    }

    return $out;
}

/**
 * The attendance rollup for one term, keyed by student id.
 *
 * Summed across periodicals where there are any -- see the file docblock for why
 * this differs from the grade rollup rather than matching it.
 */
function term_records_attendance(PDO $pdo, int $schoolYearId, int $semesterId, ?int $period, array $studentIds): array {
    if (!$studentIds) {
        return [];
    }
    $ids = implode(',', array_map('intval', $studentIds));

    if ($period !== null) {
        $sql = "SELECT student_id, total_classes_conducted, present, absent
                  FROM attendance
                 WHERE student_id IN ($ids)
                   AND schoolyear_id = :sy AND semester_id = :sem AND period = :period";
        $params = [':sy' => $schoolYearId, ':sem' => $semesterId, ':period' => $period];
    } else {
        $sql = "SELECT student_id,
                       COUNT(CASE WHEN period IS NOT NULL THEN 1 END) AS periodical_records,
                       COALESCE(SUM(CASE WHEN period IS NOT NULL THEN total_classes_conducted END), 0) AS periodical_classes,
                       COALESCE(SUM(CASE WHEN period IS NOT NULL THEN present END), 0) AS periodical_present,
                       COALESCE(SUM(CASE WHEN period IS NOT NULL THEN absent END), 0) AS periodical_absent,
                       COALESCE(SUM(CASE WHEN period IS NULL THEN total_classes_conducted END), 0) AS term_classes,
                       COALESCE(SUM(CASE WHEN period IS NULL THEN present END), 0) AS term_present,
                       COALESCE(SUM(CASE WHEN period IS NULL THEN absent END), 0) AS term_absent
                  FROM attendance
                 WHERE student_id IN ($ids) AND schoolyear_id = :sy AND semester_id = :sem
                 GROUP BY student_id";
        $params = [':sy' => $schoolYearId, ':sem' => $semesterId];
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);

    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        if ($period !== null) {
            $classes = (int)$row['total_classes_conducted'];
            $present = (int)$row['present'];
            $absent = (int)$row['absent'];
        } else {
            $usesPeriodicals = (int)$row['periodical_records'] > 0;
            $classes = (int)($usesPeriodicals ? $row['periodical_classes'] : $row['term_classes']);
            $present = (int)($usesPeriodicals ? $row['periodical_present'] : $row['term_present']);
            $absent = (int)($usesPeriodicals ? $row['periodical_absent'] : $row['term_absent']);
        }

        $out[(int)$row['student_id']] = [
            'total_classes_conducted' => $classes,
            'present' => $present,
            'absent' => $absent,
            'attendance_rate' => term_records_rate((float)$present, (float)$classes),
        ];
    }

    return $out;
}

/** The balance at the end of one term, keyed by student id. */
function term_records_finance(PDO $pdo, int $schoolYearId, int $semesterId, ?int $period, array $studentIds): array {
    if (!$studentIds) {
        return [];
    }
    $ids = implode(',', array_map('intval', $studentIds));

    $periodClause = $period !== null ? 'AND f.period = :period' : '';
    $params = [':sy' => $schoolYearId, ':sem' => $semesterId];
    if ($period !== null) {
        $params[':period'] = $period;
    }

    // Latest by date, a periodical breaking a tie against a term row on the same
    // date. With an explicit period the partition still runs, because a student
    // can hold more than one row for one periodical.
    $stmt = $pdo->prepare(
        "SELECT student_id, balance_to_data, `date`
           FROM (
                SELECT f.student_id, f.balance_to_data, f.`date`,
                       ROW_NUMBER() OVER (
                           PARTITION BY f.student_id
                           ORDER BY f.`date` DESC, (f.period IS NULL) ASC, f.period DESC, f.finance_id DESC
                       ) AS pick
                  FROM finance f
                 WHERE f.student_id IN ($ids)
                   AND f.school_year_id = :sy AND f.semester_id = :sem $periodClause
           ) ranked
          WHERE pick = 1"
    );
    $stmt->execute($params);

    $out = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $balance = $row['balance_to_data'] === null ? null : (float)$row['balance_to_data'];
        $out[(int)$row['student_id']] = [
            'balance' => $balance,
            'is_cleared' => $balance !== null ? ($balance <= 0.0049) : null,
            'date' => $row['date'] ?? null,
        ];
    }

    return $out;
}

/**
 * Everything about one term for one cohort: the three rollups and the target.
 *
 * The target is resolved for THIS term's scope, which is what makes comparing
 * two terms honest -- last year's students are judged against last year's
 * policy. See the file docblock.
 */

/**
 * Who each student WAS in this term, not who they are now.
 *
 * ---------------------------------------------------------------------------
 * THE DISTINCTION THIS FUNCTION EXISTS FOR
 *
 * Year level, section, course, cohort and scholarship all live on `student`,
 * and `student` holds one value: the current one. Joining it to show a finished
 * term produces rows that are entirely plausible and quietly wrong -- a student
 * who was Year 2 BSN in 2025-2026 and is Year 3 BSCRIM today appears in the
 * 2025-2026 register as Year 3 BSCRIM.
 *
 * `student_term_snapshot` is the fix, and it is written by closing a term (see
 * term_snapshot.php). Where a snapshot exists it wins. Where it does not, the
 * live row is used AND SAID SO -- `identity_source` travels with every student
 * so a screen can mark the difference instead of presenting a guess as a record.
 *
 * Degrading loudly rather than refusing: a term nobody has closed still has real
 * grades, attendance and balances worth reading, and hiding all of it until
 * somebody presses a button in Settings would be the worse failure.
 * ---------------------------------------------------------------------------
 */
function term_records_identity(PDO $pdo, int $schoolYearId, int $semesterId, array $cohort): array
{
    $identity = [];
    foreach ($cohort as $studentId => $row) {
        $identity[$studentId] = [
            'year_level' => $row['year_level'],
            'section' => $row['section'] ?? null,
            'course_code' => $row['course_code'],
            'student_type' => $row['student_type'],
            'modality' => $row['modality'] ?? null,
            'scholarship' => $row['scholarship'] ?? null,
            'identity_source' => 'current',
        ];
    }

    if (!$cohort || !api_table_exists($pdo, 'student_term_snapshot')) {
        return $identity;
    }

    $ids = implode(',', array_map('intval', array_keys($cohort)));
    // `star e-profile` is backticked because the column name carries a space and
    // a hyphen; unquoted it parses as three tokens and the statement dies.
    $stmt = $pdo->prepare(
        "SELECT s.student_id, s.year_level, s.section, s.`star e-profile` AS student_type,
                s.modality, s.final_scholarship_grant, c.course_code
           FROM student_term_snapshot s
           LEFT JOIN course c ON c.course_id = s.course_id
          WHERE s.student_id IN ($ids)
            AND s.school_year_id = :sy AND s.semester_id = :sem"
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $studentId = (int)$row['student_id'];
        if (!isset($identity[$studentId])) {
            continue;
        }
        $identity[$studentId] = [
            'year_level' => $row['year_level'] === null ? null : (int)$row['year_level'],
            'section' => $row['section'],
            'course_code' => $row['course_code'],
            'student_type' => $row['student_type'],
            'modality' => $row['modality'],
            'scholarship' => $row['final_scholarship_grant'],
            'identity_source' => 'snapshot',
        ];
    }

    return $identity;
}

/** Has this term been closed, and how many students did the close cover? */
function term_records_snapshot_state(PDO $pdo, int $schoolYearId, int $semesterId): array
{
    if (!api_table_exists($pdo, 'student_term_snapshot')) {
        return ['closed' => false, 'rows' => 0, 'recorded_at' => null];
    }

    $stmt = $pdo->prepare(
        'SELECT COUNT(*) AS rows_stored, MAX(recorded_at) AS recorded_at
           FROM student_term_snapshot
          WHERE school_year_id = :sy AND semester_id = :sem'
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $rows = (int)($row['rows_stored'] ?? 0);
    return [
        'closed' => $rows > 0,
        'rows' => $rows,
        'recorded_at' => $row['recorded_at'] ?? null,
    ];
}

/**
 * Every term that holds any record, newest first.
 *
 * Taken from the DATA rather than from school_year CROSS JOIN semester: the
 * cross product is twenty-one rows of which five exist, and offering to open a
 * term nobody recorded anything in wastes the reader's time and then shows them
 * an empty page they read as a broken screen.
 *
 * `records` is how many rows the term holds across the three modules, and it is
 * here because the logbook's drill-down is a grid of cards: a card reading
 * "2025-2026" and nothing else is a large button, and the reader choosing which
 * year to open has no way to tell a year with four thousand records from one
 * somebody imported twice and abandoned. It costs nothing -- the inner selects
 * already GROUP BY the same two columns, so this is a COUNT alongside a MAX on
 * a pass that was happening anyway.
 *
 * Rows, not students, because rows are the unit the periodical cards under it
 * already count, and a card grid that switches units halfway down invites the
 * reader to compare two numbers that do not mean the same thing.
 */
function term_records_terms(PDO $pdo): array
{
    $terms = $pdo->query(
        "SELECT t.school_year_id, t.semester_id, sy.schoolyear_name, s.semester_name,
                MAX(t.has_periods) AS has_periods, SUM(t.records) AS records
           FROM (
                SELECT school_year_id, semester_id, MAX(period IS NOT NULL) AS has_periods,
                       COUNT(*) AS records
                  FROM grades WHERE archived_at IS NULL GROUP BY school_year_id, semester_id
          UNION ALL
                SELECT schoolyear_id, semester_id, MAX(period IS NOT NULL), COUNT(*)
                  FROM attendance GROUP BY schoolyear_id, semester_id
          UNION ALL
                SELECT school_year_id, semester_id, MAX(period IS NOT NULL), COUNT(*)
                  FROM finance WHERE school_year_id IS NOT NULL AND semester_id IS NOT NULL
                 GROUP BY school_year_id, semester_id
           ) t
           JOIN school_year sy ON sy.school_year_id = t.school_year_id
           JOIN semester s ON s.semester_id = t.semester_id
       GROUP BY t.school_year_id, t.semester_id, sy.schoolyear_name, s.semester_name
       ORDER BY sy.schoolyear_name DESC, s.semester_id ASC"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    foreach ($terms as $index => $term) {
        $terms[$index]['school_year_id'] = (int)$term['school_year_id'];
        $terms[$index]['semester_id'] = (int)$term['semester_id'];
        $terms[$index]['has_periods'] = (int)$term['has_periods'];
        $terms[$index]['records'] = (int)$term['records'];
    }

    return $terms;
}

}
