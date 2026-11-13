<?php
/**
 * Student migration — where students stand in a chosen term, and how they got there.
 *
 * GET                        summary + student list for one term
 *   ?school_year_id= &semester_id=   the term to inspect (defaults to the newest with data)
 *   ?department_id=                  Deans are forced to their own; Admin/SSG may pick or omit for all
 *   ?course_id= &year_level= &status_id= &search= &page= &limit=
 *
 * GET ?action=history&student_id=    one student's term-by-term record
 * GET ?action=year_migration         year-level progression for the chosen term
 * GET ?action=year_students          the students behind one migration cell
 *   &year_level=                     omit for the TOTAL column
 *   &bucket=                         a bucket key, or all / final_year / over_term
 *
 * Status cards come from the `status` table, so a status added in Status
 * Management appears here at zero rather than silently missing.
 */

require_once __DIR__ . '/connection-pdo.php';
// The PDO segment matrix, so this page ranks students by the same Priority 1-4
// the caller screens and the prioritization list use.
require_once __DIR__ . '/pdo_priority_lib.php';
require_once __DIR__ . '/lib/school_year_window.php';
// Who this page may see - shared with the year-end evaluation.
require_once __DIR__ . '/lib/migration_scope.php';
// The term this page opens on, shared with retention_matrix.php so the page
// header and the matrix rendered beneath it cannot name different terms.
require_once __DIR__ . '/lib/academic_calendar.php';
require_once __DIR__ . '/lib/retention_term_default.php';
require_once __DIR__ . '/lib/migration_decision.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

/** Students with no enrollment_status row at all — the group worth chasing, so it is a bucket not an omission. */
const MIGRATION_NO_STATUS = 'none';


function migration_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * The term immediately before the given one.
 *
 * Delegated to lib/school_year_window.php, which exists precisely because
 * school_year_id is insertion order rather than chronological order. This
 * function used to compare ids and told a reader of 2022-2023 that the term
 * before it was 2026-2027 Summer.
 */
function migration_previous_term(PDO $pdo, ?int $schoolYearId, ?int $semesterId): array
{
    return sy_window_previous_term($pdo, $schoolYearId, $semesterId);
}

/**
 * Count students per enrollment status for one term, keyed by status id.
 *
 * Left-joined from `status` so every configured status is represented; the
 * unrecorded bucket is returned under MIGRATION_NO_STATUS.
 */
/**
 * The retention risk levels this endpoint will filter on.
 *
 * The three real ones are retention_case.combined_risk_level, matching
 * CASE_RISK_LEVELS in retention_case.php. 'none' is the fourth thing a reader
 * can ask for and the one the database cannot answer with a value: a student
 * who has never been evaluated. It is a filter, never something written.
 */
const MIGRATION_RISK_LEVELS = ['high', 'moderate', 'low'];
const MIGRATION_RISK_NONE = 'none';

/**
 * Each student's standing retention assessment: their most recent case.
 *
 * Deliberately *not* scoped to the term this page is inspecting, which is the
 * one thing worth being explicit about. Retention risk is an assessment that
 * stands until it is redone, not a per-term fact - a student judged high risk
 * last semester has not become unassessed because a new one began.
 *
 * That also matches the two neighbours. retention_matrix.php reads a student's
 * risk with `ORDER BY case_id DESC LIMIT 1` and no term filter at all, and the
 * failed_terms subquery further down this same file counts across a student's
 * whole record. A third convention here would mean the same student could be
 * called high risk on one screen and moderate on the next.
 *
 * MAX(case_id) rather than MAX(evaluated_at): evaluated_at is nullable, and two
 * evaluations in the same second would tie.
 */
function migration_risk_join(): string
{
    return "
        LEFT JOIN (
            SELECT rc.student_id, rc.combined_risk_level, rc.evaluation_score, rc.evaluated_at
              FROM retention_case rc
              JOIN (SELECT student_id, MAX(case_id) AS case_id
                      FROM retention_case GROUP BY student_id) newest_case
                ON newest_case.case_id = rc.case_id
        ) risk ON risk.student_id = s.student_id";
}

/**
 * How many students sit at each risk level, for the dropdown's labels.
 *
 * Scope only, like migration_status_counts - the figures describe the whole
 * population this account can see, so choosing one level does not change what
 * the others report. A count that moved every time you filtered would be
 * useless for deciding what to filter to.
 *
 * This docblock sat directly above a different function and described one
 * that was never written, so $riskCounts was undefined and every level in the
 * dropdown reported 0 students - `$riskCounts[$level] ?? 0` swallowing the
 * warning on the way past.
 */
function migration_risk_counts(PDO $pdo, string $scopeSql, array $scopeParams): array
{
    $stmt = $pdo->prepare('
        SELECT risk.combined_risk_level AS level, COUNT(*) AS student_count
          FROM student s
          JOIN course c ON c.course_id = s.course_id
          ' . migration_risk_join() . '
         WHERE ' . $scopeSql . '
         GROUP BY risk.combined_risk_level');
    $stmt->execute($scopeParams);

    // Seeded at zero so a level nobody currently holds still reports a number,
    // and so the dropdown's four options are always all present.
    $counts = array_fill_keys(MIGRATION_RISK_LEVELS, 0);
    $counts[MIGRATION_RISK_NONE] = 0;

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        // NULL is not a fourth risk level, it is never having been evaluated -
        // mapped in PHP rather than COALESCEd in SQL, as migration_status_counts
        // does with an absent status.
        $level = $row['level'] === null
            ? MIGRATION_RISK_NONE
            : strtolower(trim((string)$row['level']));
        if (array_key_exists($level, $counts)) {
            $counts[$level] = (int)$row['student_count'];
        }
    }

    return $counts;
}

/**
 * Every student in scope, classified by the PDO segment matrix.
 *
 * Returns [student_id => classification]. Computed in PHP rather than expressed
 * as SQL because the classifier already exists once, in pdo_priority_lib.php,
 * and the caller screens and the prioritization list all call it. A CASE
 * expression here that reproduced those five rules would be a second copy free
 * to drift from the first, which is the exact failure this file's own comments
 * warn about for retention risk.
 *
 * The whole scope, not the page: the dropdown counts describe the population
 * this account can see, and filtering to Priority 1 must not change what
 * Priority 2 reports.
 */
function migration_priority_map(PDO $pdo, string $scopeSql, array $scopeParams): array
{
    $stmt = $pdo->prepare("
        SELECT s.student_id
          FROM student s
          JOIN course c ON c.course_id = s.course_id
         WHERE $scopeSql");
    $stmt->execute($scopeParams);
    $studentIds = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

    if (empty($studentIds)) {
        return [];
    }

    $settings = pdo_settings($pdo);
    $signals = pdo_load_signals($pdo, $studentIds);

    /*
     * Which term each figure came from, carried alongside the figure.
     *
     * pdo_load_signals() is called with no term, so it answers with the
     * student's most recent records whenever they were filed. That is what
     * makes the board usable - every grade in this database sits in
     * 2026-2027 1st Semester while the page opens on the newest term with
     * ENROLMENT decisions, which is 2025-2026 2nd Semester - but it means the
     * numbers can predate the heading above them. The ids ride along so the
     * page can say so instead of letting the heading speak for them.
     */
    $map = [];
    foreach ($studentIds as $studentId) {
        $grade = $signals['grades'][$studentId] ?? null;
        $finance = $signals['finance'][$studentId] ?? null;

        $map[$studentId] = pdo_classify_student(
            ['student_id' => $studentId],
            $grade,
            $signals['attendance'][$studentId] ?? null,
            $finance,
            $settings
        ) + [
            'grade_school_year_id' => isset($grade['school_year_id']) ? (int)$grade['school_year_id'] : null,
            'grade_semester_id' => isset($grade['semester_id']) ? (int)$grade['semester_id'] : null,
            'balance_school_year_id' => isset($finance['school_year_id']) ? (int)$finance['school_year_id'] : null,
            'balance_semester_id' => isset($finance['semester_id']) ? (int)$finance['semester_id'] : null,
        ];
    }
    return $map;
}

/** How many students sit at each priority, for the dropdown's labels. */
function migration_priority_counts(array $priorityMap): array
{
    $counts = [1 => 0, 2 => 0, 3 => 0, 4 => 0];
    foreach ($priorityMap as $classified) {
        $counts[$classified['priority']]++;
    }
    return $counts;
}

function migration_status_counts(PDO $pdo, string $scopeSql, array $scopeParams, ?int $schoolYearId, ?int $semesterId): array
{
    $termFilter = '';
    $params = $scopeParams;
    if ($schoolYearId) {
        $termFilter .= ' AND e.school_year_id = :sy';
        $params[':sy'] = $schoolYearId;
    }
    if ($semesterId) {
        $termFilter .= ' AND e.semester_id = :sem';
        $params[':sem'] = $semesterId;
    }

    $stmt = $pdo->prepare("
        SELECT es.status_type AS status_id, COUNT(*) AS student_count
          FROM student s
          JOIN course c ON c.course_id = s.course_id
          LEFT JOIN (
              SELECT e.student_id, MAX(e.enrollment_status_id) AS latest_id
                FROM enrollment_status e
               WHERE e.archived_at IS NULL $termFilter
               GROUP BY e.student_id
          ) latest ON latest.student_id = s.student_id
          LEFT JOIN enrollment_status es ON es.enrollment_status_id = latest.latest_id
         WHERE $scopeSql
         GROUP BY es.status_type");
    $stmt->execute($params);

    $counts = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $key = $row['status_id'] === null ? MIGRATION_NO_STATUS : (string)(int)$row['status_id'];
        $counts[$key] = (int)$row['student_count'];
    }

    return $counts;
}

/**
 * Which column of the migration matrix a status belongs in.
 *
 * Matched on the status NAME rather than on seeded ids, because Status
 * Management can add rows and the ids are not stable across installs. An
 * enrollment status nobody has taught this function about lands in "undecided"
 * — visible, counted, and obviously not yet classified, which is the failure
 * anyone can spot. Dropping it would make the row totals disagree with the
 * headcount and nobody would know why.
 */
function migration_year_bucket(?string $statusName): string
{
    /*
     * The list changed on 2026-10-06 (latest.xlsx): "Will Continue", "Graduated"
     * and six "Will not continue - ..." values. The retired names stay here,
     * because records filed under them keep those names. Mirrored for the
     * browser by src/shared/lib/enrollmentStatusKind.js - change both together.
     *
     * Transfers are tried before "will not continue": "Will not continue -
     * Transfer to LUC/ SUC" is a student moving elsewhere, which is the
     * Shift/Transfer column, not a stop.
     */
    $name = strtolower(trim((string)$statusName));
    if ($name === '') {
        return 'no_record';
    }
    if (preg_match('/^(enrolled|will enroll|will continue|for enlistment)$/', $name)) {
        return 'continuing';
    }
    if (strpos($name, 'graduat') !== false) {
        return 'graduating';
    }
    if (preg_match('/^(to shift|to transfer)$/', $name) || strpos($name, 'transfer to') !== false) {
        return 'moving';
    }
    if (preg_match('/^(not enrolled|to stop|no show)$/', $name) || strpos($name, 'will not continue') === 0) {
        return 'not_continuing';
    }
    return 'undecided';
}

/** Column order and labels, sent with the data so the grid never hardcodes them. */
function migration_year_buckets(): array
{
    return [
        ['key' => 'continuing',     'label' => 'Continuing',      'tone' => 'good'],
        ['key' => 'graduating',     'label' => 'Graduating',      'tone' => 'good'],
        ['key' => 'moving',         'label' => 'Shift/Transfer',  'tone' => 'warn'],
        ['key' => 'not_continuing', 'label' => 'Not continuing',  'tone' => 'bad'],
        ['key' => 'undecided',      'label' => 'Undecided',       'tone' => 'warn'],
        ['key' => 'no_record',      'label' => 'No record',       'tone' => 'none'],
    ];
}

/**
 * Year-level progression: who is in each year now, and where next term takes them.
 *
 * A caveat that belongs in the code and on the screen: this is a PROJECTION,
 * not an observed history. `year_level` exists only on `student`, as a single
 * current value — no table records the year a student held in a past term — so
 * "Year I becomes Year II" cannot be measured, only derived from who is
 * recorded as continuing. The endpoint says so in `basis`, and the UI prints it.
 *
 * `over_term` and `final_year` are what make the projection honest for the
 * students who do not simply move up one: someone already past their course's
 * year_duration is still finishing rather than progressing, and someone sitting
 * exactly at it is choosing between graduating and another year.
 */
function migration_year_rows(PDO $pdo, string $scopeSql, array $scopeParams, ?int $schoolYearId, ?int $semesterId): array
{
    $termFilter = '';
    $params = $scopeParams;
    if ($schoolYearId) {
        $termFilter .= ' AND e.school_year_id = :sy';
        $params[':sy'] = $schoolYearId;
    }
    if ($semesterId) {
        $termFilter .= ' AND e.semester_id = :sem';
        $params[':sem'] = $semesterId;
    }

    $stmt = $pdo->prepare("
        SELECT s.year_level,
               st.status_name,
               COUNT(*) AS students,
               SUM(CASE WHEN s.year_level > c.year_duration THEN 1 ELSE 0 END) AS over_term,
               SUM(CASE WHEN s.year_level = c.year_duration THEN 1 ELSE 0 END) AS final_year
          FROM student s
          JOIN course c ON c.course_id = s.course_id
          LEFT JOIN (
              SELECT e.student_id, MAX(e.enrollment_status_id) AS latest_id
                FROM enrollment_status e
               WHERE e.archived_at IS NULL $termFilter
               GROUP BY e.student_id
          ) latest ON latest.student_id = s.student_id
          LEFT JOIN enrollment_status es ON es.enrollment_status_id = latest.latest_id
          LEFT JOIN status st ON st.status_id = es.status_type
         WHERE $scopeSql AND s.year_level IS NOT NULL
         GROUP BY s.year_level, st.status_name
         ORDER BY s.year_level ASC");
    $stmt->execute($params);

    $bucketKeys = array_column(migration_year_buckets(), 'key');
    $rows = [];

    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $year = (int)$row['year_level'];
        if (!isset($rows[$year])) {
            $rows[$year] = [
                'year_level' => $year,
                'next_year_level' => $year + 1,
                'students' => 0,
                'over_term' => 0,
                'final_year' => 0,
                'buckets' => array_fill_keys($bucketKeys, 0),
            ];
        }

        $count = (int)$row['students'];
        $rows[$year]['students'] += $count;
        $rows[$year]['over_term'] += (int)$row['over_term'];
        $rows[$year]['final_year'] += (int)$row['final_year'];
        $rows[$year]['buckets'][migration_year_bucket($row['status_name'])] += $count;
    }

    ksort($rows);

    /*
     * The headline number: of the students in this year whose intention is
     * actually on record, what share are moving up to the next one.
     *
     * The denominator is `decided`, not the whole cohort. Dividing by everyone
     * would report a Year I that has answered nobody as a 0% progression rate,
     * which reads as "nobody survives" when it means "nobody has been asked
     * yet" — the opposite conclusion from the same data. `decided` is carried
     * alongside so the rate is never read without knowing how thin it is.
     */
    foreach ($rows as $year => $row) {
        $decided = $row['students'] - $row['buckets']['no_record'];
        $rows[$year]['decided'] = $decided;
        $rows[$year]['progression_rate'] = $decided > 0
            ? round($row['buckets']['continuing'] / $decided * 100, 1)
            : null;
    }

    // Column totals, so the footer never re-adds the rows in the browser and
    // reaches a different number from the one the server counted.
    $totals = array_fill_keys($bucketKeys, 0);
    $totalStudents = 0;
    $totalOverTerm = 0;
    $totalDecided = 0;
    foreach ($rows as $row) {
        $totalStudents += $row['students'];
        $totalOverTerm += $row['over_term'];
        $totalDecided += $row['decided'];
        foreach ($bucketKeys as $key) {
            $totals[$key] += $row['buckets'][$key];
        }
    }

    return [
        'buckets' => migration_year_buckets(),
        'rows' => array_values($rows),
        'totals' => [
            'students' => $totalStudents,
            'over_term' => $totalOverTerm,
            'decided' => $totalDecided,
            // Recomputed from the totals rather than averaged across the rows:
            // the mean of five percentages is not the percentage of the whole.
            'progression_rate' => $totalDecided > 0
                ? round($totals['continuing'] / $totalDecided * 100, 1)
                : null,
            'buckets' => $totals,
        ],
    ];
}

/**
 * Has this school year been recorded in full, or only halfway?
 *
 * A year-level migration is a statement about a whole school year: a student
 * moves up when they finish it, not when they finish its first semester. Both
 * semesters therefore have to be on record before the grid is describing a
 * completed year - and until then it is describing a year in progress, which is
 * a different claim and a much weaker one.
 *
 * Nothing said so. The grid rendered identically whether both semesters were
 * in or only the first, so a reader looking at it in October read a "42%
 * moving up" that was really "42% of the students we have asked so far, in the
 * only semester that has happened yet".
 *
 * Every semester the institution defines is checked, not a hardcoded two: a
 * school that adds a summer term gets it counted without this being edited.
 * Counted inside the caller's scope, so a dean's answer is about their own
 * department rather than about the college.
 */
function migration_term_completeness(PDO $pdo, string $scopeSql, array $scopeParams, ?int $schoolYearId): array
{
    $semesters = $pdo->query(
        'SELECT semester_id, semester_name FROM semester ORDER BY semester_id'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $params = $scopeParams;
    $yearFilter = '';
    if ($schoolYearId) {
        $yearFilter = ' AND e.school_year_id = :completeness_sy';
        $params[':completeness_sy'] = $schoolYearId;
    }

    $stmt = $pdo->prepare("
        SELECT e.semester_id, COUNT(DISTINCT e.student_id) AS students
          FROM enrollment_status e
          JOIN student s ON s.student_id = e.student_id
          JOIN course c ON c.course_id = s.course_id
         WHERE e.archived_at IS NULL AND $scopeSql $yearFilter
      GROUP BY e.semester_id");
    $stmt->execute($params);

    $counts = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        if ($row['semester_id'] === null) continue;
        $counts[(int)$row['semester_id']] = (int)$row['students'];
    }

    $terms = [];
    $missing = [];
    foreach ($semesters as $semester) {
        $id = (int)$semester['semester_id'];
        $students = $counts[$id] ?? 0;
        $terms[] = [
            'semester_id' => $id,
            'semester_name' => (string)$semester['semester_name'],
            'students' => $students,
            'recorded' => $students > 0,
        ];
        if ($students <= 0) {
            $missing[] = (string)$semester['semester_name'];
        }
    }

    $complete = !empty($terms) && empty($missing);
    $nothingYet = count($missing) === count($terms) && !empty($terms);

    // Three states, three sentences. "Not finished" is the wrong words for
    // a year nobody has recorded anything against - that one has not started.
    if (empty($terms)) {
        $note = 'No semesters are defined, so completeness cannot be judged.';
    } elseif ($complete) {
        $note = 'Every semester of this school year has decisions on record, so this is a complete year.';
    } elseif ($nothingYet) {
        $note = 'No enrollment decisions have been recorded for this school year yet, in any semester.';
    } else {
        $note = implode(' and ', $missing)
            . (count($missing) === 1 ? ' has' : ' have')
            . ' no enrollment decisions on record yet, so this school year is not finished. A student moves up '
            . 'a year level when they complete the whole year - treat these figures as the year so far rather '
            . 'than as its outcome.';
    }

    return [
        'complete' => $complete,
        'terms' => $terms,
        'missing_terms' => $missing,
        'note' => $note,
    ];
}

/**
 * The students behind one cell of the year-migration grid.
 *
 * Every count in that grid was a figure you had to take on faith. The retention
 * matrix beside it has opened its cells since it was built, and the first
 * question anyone asks either grid is the same one: which students are those.
 *
 * The bucket is decided in PHP by migration_year_bucket(), the same function the
 * grid counts with, rather than by a WHERE clause repeating its rules in SQL. A
 * second copy is how a cell and the list behind it start naming different
 * students - and the rules are not trivial: "graduating" is a substring match,
 * and a blank status is a bucket of its own rather than an absence.
 *
 * $bucket also accepts the three rows that are not buckets at all:
 *   all         every student in the year - the "Students in year" row
 *   final_year  sitting exactly on their course's length
 *   over_term   already past it and still finishing
 *
 * Capped at 500 like the retention matrix, and the cap is applied after the
 * bucket filter so a cell of 12 students is never reported as truncated.
 */
function migration_year_students(
    PDO $pdo,
    string $scopeSql,
    array $scopeParams,
    ?int $schoolYearId,
    ?int $semesterId,
    ?int $yearLevel,
    string $bucket
): array {
    $termFilter = '';
    $params = $scopeParams;
    if ($schoolYearId) {
        $termFilter .= ' AND e.school_year_id = :sy';
        $params[':sy'] = $schoolYearId;
    }
    if ($semesterId) {
        $termFilter .= ' AND e.semester_id = :sem';
        $params[':sem'] = $semesterId;
    }

    $yearFilter = '';
    if ($yearLevel !== null) {
        $yearFilter = ' AND s.year_level = :cell_year_level';
        $params[':cell_year_level'] = $yearLevel;
    }

    // Mirrors migration_year_rows() exactly - same latest-decision subquery, same
    // joins, same scope - so the two read the same population.
    $stmt = $pdo->prepare("
        SELECT s.student_id, s.student_number, s.first_name, s.last_name,
               s.year_level, s.section, s.email_address, s.mobile_number,
               c.course_code, c.course_name, c.year_duration,
               st.status_name
          FROM student s
          JOIN course c ON c.course_id = s.course_id
          LEFT JOIN (
              SELECT e.student_id, MAX(e.enrollment_status_id) AS latest_id
                FROM enrollment_status e
               WHERE e.archived_at IS NULL $termFilter
               GROUP BY e.student_id
          ) latest ON latest.student_id = s.student_id
          LEFT JOIN enrollment_status es ON es.enrollment_status_id = latest.latest_id
          LEFT JOIN status st ON st.status_id = es.status_type
         WHERE $scopeSql AND s.year_level IS NOT NULL $yearFilter
      ORDER BY s.year_level, s.last_name, s.first_name");
    $stmt->execute($params);

    $students = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $year = (int)$row['year_level'];
        $duration = $row['year_duration'] !== null ? (int)$row['year_duration'] : null;

        if ($bucket === 'final_year') {
            if ($duration === null || $year !== $duration) continue;
        } elseif ($bucket === 'over_term') {
            if ($duration === null || $year <= $duration) continue;
        } elseif ($bucket !== 'all') {
            if (migration_year_bucket($row['status_name']) !== $bucket) continue;
        }

        $students[] = [
            'student_id'     => (int)$row['student_id'],
            'student_number' => $row['student_number'] ?? '',
            'full_name'      => trim(((string)($row['first_name'] ?? '')) . ' ' . ((string)($row['last_name'] ?? ''))),
            'year_level'     => $year,
            'section'        => $row['section'] ?? null,
            'course_code'    => $row['course_code'] ?? null,
            'course_name'    => $row['course_name'] ?? null,
            'email_address'  => $row['email_address'] ?? null,
            'mobile_number'  => $row['mobile_number'] ?? null,
            // What the student is actually recorded as, so the list explains
            // itself rather than only repeating the column header.
            'status_name'    => $row['status_name'] ?? null,
        ];
    }

    $truncated = count($students) > 500;

    return [
        'students' => array_slice($students, 0, 500),
        'truncated' => $truncated,
    ];
}

/** "2025-2026 · First Semester", or null when the term is not fully specified. */
function migration_term_label(PDO $pdo, ?int $schoolYearId, ?int $semesterId): ?string
{
    if (!$schoolYearId || !$semesterId) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT sy.schoolyear_name, sem.semester_name
           FROM school_year sy CROSS JOIN semester sem
          WHERE sy.school_year_id = :sy AND sem.semester_id = :sem LIMIT 1'
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    $label = trim(($row['schoolyear_name'] ?? '') . ' · ' . ($row['semester_name'] ?? ''), ' ·');
    return $label !== '' ? $label : null;
}

/**
 * Each row's Enrollment Decision, and exactly which answer it was read from.
 *
 * The decision is the student's newest answer to the selected survey question,
 * read live rather than stored. Two
 * shapes of answer are coalesced: a seeded row sets option_id, an app-written
 * row sets answer text.
 *
 * Where it came from (submission, question, survey) rides along because the
 * board edits that same answer. It used to write to one fixed survey instead,
 * so for a student whose newest answer lived in another survey the edit landed
 * where the column never looks, and the dropdown snapped back to the old value.
 *
 * One query for the whole page, not a correlated subquery per row; the first
 * answer per student in this ORDER BY is their newest.
 */
function migration_attach_survey_decisions(PDO $pdo, array $rows, ?int $questionId = null): array
{
    $studentIds = array_values(array_unique(array_map(static fn(array $row): int => (int)$row['student_id'], $rows)));
    $latest = [];
    if ($studentIds !== []) {
        // Ints cast from the rows just read, so inlining them is safe.
        $stmt = $pdo->query(
            'SELECT ss.student_id, ss.submission_id, ss.survey_id, sa.question_id, sa.option_id,
                    COALESCE(sqo.option_text, sa.answer) AS decision
               FROM survey_submission ss
               JOIN survey_answer sa ON sa.submission_id = ss.submission_id
               LEFT JOIN survey_question_option sqo ON sqo.option_id = sa.option_id
              WHERE ss.student_id IN (' . implode(',', $studentIds) . ')
                AND ss.archived_at IS NULL
                ' . ($questionId !== null ? 'AND sa.question_id = ' . (int)$questionId : '') . '
                AND EXISTS (SELECT 1 FROM survey_question_option qo
                             WHERE qo.question_id = sa.question_id
                               AND qo.enrollment_status_id IS NOT NULL)
           ORDER BY ss.student_id, ss.submission_id DESC, sa.answer_id DESC'
        );
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $answer) {
            $latest[(int)$answer['student_id']] ??= $answer;
        }
    }

    foreach ($rows as &$row) {
        $answer = $latest[(int)$row['student_id']] ?? null;
        $row['survey_decision'] = $answer['decision'] ?? null;
        $row['survey_decision_submission_id'] = $answer ? (int)$answer['submission_id'] : null;
        $row['survey_decision_survey_id'] = $answer ? (int)$answer['survey_id'] : null;
        $row['survey_decision_question_id'] = $answer ? (int)$answer['question_id'] : null;
        $row['survey_decision_option_id'] = $answer && $answer['option_id'] !== null ? (int)$answer['option_id'] : null;
    }
    unset($row);

    return $rows;
}

/**
 * Decision questions with their choices, for the Enrollment Decision dropdown.
 *
 * One entry per question id asked for, so a row whose answer belongs to an
 * older or different survey is offered that survey's own choices rather than
 * those of the survey the board would open for a new answer.
 */
function migration_decision_questions(PDO $pdo, array $questionIds): array
{
    $questionIds = array_values(array_unique(array_filter(array_map('intval', $questionIds))));
    if ($questionIds === []) {
        return [];
    }

    // Ints by construction, as above.
    $in = implode(',', $questionIds);
    $questions = $pdo->query(
        "SELECT q.question_id, q.survey_id, q.question_text, q.question_type, sv.survey_title
           FROM survey_question q
           JOIN survey sv ON sv.survey_id = q.survey_id
          WHERE q.question_id IN ($in)"
    )->fetchAll(PDO::FETCH_ASSOC);
    $choices = $pdo->query(
        "SELECT o.question_id, o.option_id, o.option_text, o.enrollment_status_id, st.status_name
           FROM survey_question_option o
           LEFT JOIN status st ON st.status_id = o.enrollment_status_id
          WHERE o.question_id IN ($in)
            AND st.status_type = 'enrollment' AND st.archived_at IS NULL
       ORDER BY o.risk_points ASC, o.option_id ASC"
    )->fetchAll(PDO::FETCH_ASSOC);

    $byQuestion = [];
    foreach ($questions as $question) {
        $byQuestion[(int)$question['question_id']] = [
            'survey_id' => (int)$question['survey_id'],
            'survey_title' => $question['survey_title'],
            'question_id' => (int)$question['question_id'],
            'question_text' => $question['question_text'],
            'question_type' => $question['question_type'],
            'choices' => [],
        ];
    }
    foreach ($choices as $choice) {
        $questionId = (int)$choice['question_id'];
        if (isset($byQuestion[$questionId])) {
            unset($choice['question_id']);
            $byQuestion[$questionId]['choices'][] = $choice;
        }
    }

    return array_values($byQuestion);
}

/** One student's term-by-term enrollment status and grade outcome, newest first. */
function migration_student_history(PDO $pdo, int $studentId): array
{
    $stmt = $pdo->prepare("
        SELECT t.school_year_id,
               t.semester_id,
               sy.schoolyear_name,
               sem.semester_name,
               st.status_name,
               es.status_type AS status_id,
               es.decision,
               es.date AS status_date,
               es.reason,
               es.response,
               g.total_subject,
               g.passed,
               g.failed,
               g.incomplete,
               g.no_credit,
               g.no_grade,
               rm.remark_name
          FROM (
              SELECT school_year_id, semester_id FROM enrollment_status
               WHERE student_id = :sid1 AND archived_at IS NULL
              UNION
              SELECT school_year_id, semester_id FROM grades
               WHERE student_id = :sid2 AND archived_at IS NULL
          ) t
          LEFT JOIN school_year sy ON sy.school_year_id = t.school_year_id
          LEFT JOIN semester sem   ON sem.semester_id   = t.semester_id
          LEFT JOIN enrollment_status es
                 ON es.enrollment_status_id = (
                      SELECT MAX(e2.enrollment_status_id) FROM enrollment_status e2
                       WHERE e2.student_id = :sid3
                         AND e2.archived_at IS NULL
                         AND e2.school_year_id <=> t.school_year_id
                         AND e2.semester_id    <=> t.semester_id
                    )
          LEFT JOIN status st ON st.status_id = es.status_type
          LEFT JOIN grades g
                 ON g.student_id = :sid4
                AND g.school_year_id <=> t.school_year_id
                AND g.semester_id    <=> t.semester_id
                AND g.archived_at IS NULL
          LEFT JOIN remarks rm ON rm.remark_id = g.remark_id
         ORDER BY sy.schoolyear_name DESC, t.semester_id DESC");
    $stmt->execute([':sid1' => $studentId, ':sid2' => $studentId, ':sid3' => $studentId, ':sid4' => $studentId]);

    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

try {
    // Read-only: kept even though the middleware already rejects non-GET, so that stays true if a write action is ever declared.
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        migration_out(405, ['message' => 'Method not allowed. This endpoint is read-only.']);
    }

    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        migration_out(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();

    // ---- scope -------------------------------------------------------------
    // Shared with year_migration.php, so the year-end evaluation applies to
    // exactly the students this page shows. See lib/migration_scope.php.
    $scopeInfo = migration_scope($authUser, $_GET);
    if ($scopeInfo['error'] !== null) {
        migration_out(400, ['message' => $scopeInfo['error']]);
    }
    $seesAllDepartments = $scopeInfo['sees_all_departments'];
    $departmentId = $scopeInfo['department_id'];
    $departmentScopeIsOwn = $scopeInfo['department_is_own'];
    $campusId = $scopeInfo['campus_id'];
    $courseId = $scopeInfo['course_id'];
    $yearLevel = $scopeInfo['year_level'];
    $search = $scopeInfo['search'];
    $scope = $scopeInfo['clauses'];
    $scopeParams = $scopeInfo['params'];
    $scopeSql = $scopeInfo['sql'];

    // ---- history for one student -------------------------------------------
    if (($_GET['action'] ?? '') === 'history') {
        $studentId = isset($_GET['student_id']) ? (int)$_GET['student_id'] : 0;
        if ($studentId <= 0) {
            migration_out(400, ['message' => 'student_id is required']);
        }

        // Re-checked against the same scope so history cannot reach outside it.
        $guard = $pdo->prepare("
            SELECT s.student_id, s.student_number, s.first_name, s.last_name,
                   s.year_level, s.section, s.`star e-profile` AS student_type,
                   c.course_code, c.course_name, d.department_name
              FROM student s
              JOIN course c ON c.course_id = s.course_id
              LEFT JOIN department d ON d.department_id = c.department_id
             WHERE s.student_id = :student_id AND $scopeSql
             LIMIT 1");
        $guard->execute(array_merge($scopeParams, [':student_id' => $studentId]));
        $student = $guard->fetch(PDO::FETCH_ASSOC);
        if (!$student) {
            migration_out(404, ['message' => 'Student not found in your scope']);
        }

        migration_out(200, [
            'student' => $student,
            'history' => migration_student_history($pdo, $studentId),
        ]);
    }

    // ---- the term being inspected ------------------------------------------
    $schoolYearId = isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '' ? (int)$_GET['school_year_id'] : null;
    $semesterId = isset($_GET['semester_id']) && $_GET['semester_id'] !== '' ? (int)$_GET['semester_id'] : null;

    /*
     * The default term: the calendar's year, semester pinned to 2nd.
     *
     * Shared with retention_matrix.php through lib/retention_term_default.php,
     * and that sharing is the point. This page RENDERS that matrix and hands
     * it the term resolved here as an explicit semester_id, so whatever this
     * picks is what the grid shows. When the two had separate defaults the
     * page header and the matrix header directly beneath it named different
     * terms, and the matrix's own default was unreachable from this screen.
     *
     * This used to open on the newest term holding enrollment rows. That
     * moved on its own as data arrived -- adding 2026-2027 1st Semester
     * silently changed what the page opened on, which is how it stopped
     * showing 2nd Semester without anybody changing a line of code.
     *
     * The newest recorded term is still offered, for the YEAR only, and only
     * when the calendar names none.
     */
    if ($schoolYearId === null && $semesterId === null) {
        $latest = $pdo->query(
            "SELECT es.school_year_id, es.semester_id
               FROM enrollment_status es
               JOIN school_year sy ON sy.school_year_id = es.school_year_id
              WHERE es.archived_at IS NULL AND es.school_year_id IS NOT NULL
                AND es.semester_id IS NOT NULL
           ORDER BY sy.schoolyear_name DESC, es.semester_id DESC
              LIMIT 1"
        )->fetch(PDO::FETCH_ASSOC) ?: null;

        $default = retention_default_term($pdo, $latest);
        $schoolYearId = $default['school_year_id'] === null ? null : (int)$default['school_year_id'];
        $semesterId   = (int)$default['semester_id'];
    }

    /*
     * ---- year-level migration matrix ---------------------------------------
     *
     * Answered before the summary work below, because none of it is needed: the
     * matrix is one grouped query over the same scope, and running the status
     * cards and the paged student list first would be several hundred
     * milliseconds spent building a payload this response throws away.
     */
    if (($_GET['action'] ?? '') === 'year_students') {
        $cellYear = isset($_GET['year_level']) && $_GET['year_level'] !== ''
            ? (int)$_GET['year_level']
            : null;
        $bucket = strtolower(trim((string)($_GET['bucket'] ?? 'all')));

        // Validated against the grid's own bucket list plus the three rows that
        // are not buckets, so an unknown value is refused rather than silently
        // returning the whole year under someone else's heading.
        $allowed = array_merge(
            array_column(migration_year_buckets(), 'key'),
            ['all', 'final_year', 'over_term']
        );
        if (!in_array($bucket, $allowed, true)) {
            migration_out(400, ['message' => 'Unknown bucket: ' . $bucket]);
        }

        migration_out(200, ['data' => migration_year_students(
            $pdo, $scopeSql, $scopeParams, $schoolYearId, $semesterId, $cellYear, $bucket
        )]);
    }

    if (($_GET['action'] ?? '') === 'year_migration') {
        $matrix = migration_year_rows($pdo, $scopeSql, $scopeParams, $schoolYearId, $semesterId);

        migration_out(200, [
            'data' => array_merge($matrix, [
                /*
                 * Whether the school year this grid describes is actually over.
                 * Sent with the data rather than inferred in the browser: the
                 * counts it rests on are the ones the grid was built from, and
                 * a second query from the client could disagree with them.
                 */
                'completeness' => migration_term_completeness($pdo, $scopeSql, $scopeParams, $schoolYearId),
                'term' => [
                    'school_year_id' => $schoolYearId,
                    'semester_id' => $semesterId,
                    'campus_id' => $campusId,
                    'label' => migration_term_label($pdo, $schoolYearId, $semesterId),
                ],
                /*
                 * Said out loud in the payload, not only in a comment: every
                 * consumer has to know the destination year is derived rather
                 * than observed, and a caveat that lives only in the UI is one
                 * screenshot away from being lost.
                 */
                'basis' => 'projected',
                'basis_note' => 'Year level is stored only as each student\'s current value, so the destination year is derived as the next level up for students recorded as continuing. This is a projection from this term\'s enrollment decisions, not an observed history.',
            ]),
        ]);
    }

    $previous = migration_previous_term($pdo, $schoolYearId, $semesterId);

    // ---- summary, with the previous term alongside for comparison ----------
    $current = migration_status_counts($pdo, $scopeSql, $scopeParams, $schoolYearId, $semesterId);

    // Only compare when a previous term exists: passing nulls would drop the term
    // filter entirely and report all-time counts as if they were last term's.
    $hasPrevious = $previous['semester_id'] !== null;
    $prior = $hasPrevious
        ? migration_status_counts($pdo, $scopeSql, $scopeParams, $previous['school_year_id'], $previous['semester_id'])
        : [];

    // Retired statuses too (archived when latest.xlsx replaced the list on
    // 2026-10-06), after the current ones: the records that hold them still
    // count. They are never offered as something to save - see `filters`.
    $statusRows = $pdo->query(
        "SELECT status_id, status_name, archived_at FROM status
          WHERE status_type = 'enrollment'
       ORDER BY archived_at IS NOT NULL, COALESCE(sort_order, 9999) ASC, status_name ASC"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $priorityMap = migration_priority_map($pdo, $scopeSql, $scopeParams);
    $priorityCounts = migration_priority_counts($priorityMap);
    $riskCounts = migration_risk_counts($pdo, $scopeSql, $scopeParams);

    $summary = [];
    $totalStudents = 0;
    foreach ($statusRows as $row) {
        $key = (string)(int)$row['status_id'];
        $count = $current[$key] ?? 0;
        $retired = $row['archived_at'] !== null;
        // A retired status is listed while someone in this term or the last
        // still holds it, so its students can be found and its drop to 0 seen;
        // with nobody in either it is just a name off the old list.
        if ($retired && $count === 0 && ($prior[$key] ?? 0) === 0) {
            continue;
        }
        $totalStudents += $count;
        $summary[] = [
            'status_id' => (int)$row['status_id'],
            'status_name' => $row['status_name'],
            'retired' => $retired,
            'student_count' => $count,
            'previous_count' => $hasPrevious ? ($prior[$key] ?? 0) : null,
            'change' => $hasPrevious ? $count - ($prior[$key] ?? 0) : null,
        ];
    }

    $noStatusNow = $current[MIGRATION_NO_STATUS] ?? 0;
    $totalStudents += $noStatusNow;
    $summary[] = [
        'status_id' => MIGRATION_NO_STATUS,
        'status_name' => 'No status recorded',
        'student_count' => $noStatusNow,
        'previous_count' => $hasPrevious ? ($prior[MIGRATION_NO_STATUS] ?? 0) : null,
        'change' => $hasPrevious ? $noStatusNow - ($prior[MIGRATION_NO_STATUS] ?? 0) : null,
    ];

    // ---- student list ------------------------------------------------------
    $statusParam = isset($_GET['status_id']) ? trim((string)$_GET['status_id']) : '';
    $wantsNoStatus = strtolower($statusParam) === MIGRATION_NO_STATUS;
    $statusId = (!$wantsNoStatus && $statusParam !== '' && ctype_digit($statusParam)) ? (int)$statusParam : null;

    /*
     * Retention risk, whitelisted rather than passed through. Anything the list
     * above does not name is treated as no filter, so a bad value widens the
     * result set instead of reaching the query.
     */
    /*
     * Which priority band to show, 1-4.
     *
     * Replaced ?retention_risk=high|moderate|low|none. The scoring engine's risk
     * level still exists and still drives the retention module; what this page
     * ranks and filters by is the sheet's Priority 1-4, so the same student does
     * not read as "high risk" here and "P1" on the screens the callers work in.
     */
    $priorityParam = isset($_GET['priority']) ? trim((string)$_GET['priority']) : '';
    $priorityLevel = in_array($priorityParam, ['1', '2', '3', '4'], true) ? (int)$priorityParam : null;

    $riskParam = isset($_GET['retention_risk']) ? strtolower(trim((string)$_GET['retention_risk'])) : '';
    $wantsNoRisk = $riskParam === MIGRATION_RISK_NONE;
    $riskLevel = in_array($riskParam, MIGRATION_RISK_LEVELS, true) ? $riskParam : null;

    $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
    $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 25;
    $offset = ($page - 1) * $limit;

    $termFilter = '';
    $termParams = [];
    if ($schoolYearId) {
        $termFilter .= ' AND e.school_year_id = :sy';
        $termParams[':sy'] = $schoolYearId;
    }
    if ($semesterId) {
        $termFilter .= ' AND e.semester_id = :sem';
        $termParams[':sem'] = $semesterId;
    }

    // Latest row is picked by enrollment_status_id because school_year_id is not reliably set.
    $latestJoin = "
        LEFT JOIN (
            SELECT e.student_id, MAX(e.enrollment_status_id) AS latest_id
              FROM enrollment_status e
             WHERE e.archived_at IS NULL $termFilter
             GROUP BY e.student_id
        ) latest ON latest.student_id = s.student_id
        LEFT JOIN enrollment_status es ON es.enrollment_status_id = latest.latest_id
        LEFT JOIN status st ON st.status_id = es.status_type";

    $listWhere = [$scopeSql];
    $listParams = array_merge($scopeParams, $termParams);

    if ($wantsNoStatus) {
        $listWhere[] = 'es.enrollment_status_id IS NULL';
    } elseif ($statusId !== null) {
        $listWhere[] = 'es.status_type = :status_id';
        $listParams[':status_id'] = $statusId;
    }
    if ($search !== '') {
        $listWhere[] = "(s.student_number LIKE :q OR s.first_name LIKE :q OR s.last_name LIKE :q
                         OR CONCAT(s.first_name, ' ', s.last_name) LIKE :q OR s.email_address LIKE :q)";
        $listParams[':q'] = '%' . $search . '%';
    }
    if ($wantsNoRisk) {
        $listWhere[] = 'risk.combined_risk_level IS NULL';
    } elseif ($riskLevel !== null) {
        $listWhere[] = 'risk.combined_risk_level = :retention_risk';
        $listParams[':retention_risk'] = $riskLevel;
    }

    /*
     * The priority filter, applied as a student-id set.
     *
     * Priority is computed in PHP from three signals, so it cannot be a WHERE
     * clause on a column. The ids are already in hand from the scope pass above,
     * and this keeps SQL paging intact - the alternative, fetching every row and
     * paging in PHP, would load the whole cohort to show fifteen of them.
     *
     * The inlined list is safe: every value is an int cast from a database id,
     * never from the request. An empty result is expressed as an impossible id
     * rather than an empty IN (), which is a syntax error.
     */
    if ($priorityLevel !== null) {
        $matchingIds = [];
        foreach ($priorityMap as $studentId => $classified) {
            if ($classified['priority'] === $priorityLevel) {
                $matchingIds[] = (int)$studentId;
            }
        }
        $listWhere[] = 's.student_id IN (' . ($matchingIds ? implode(',', $matchingIds) : '0') . ')';
    }

    $listWhereSql = implode(' AND ', $listWhere);

    $countStmt = $pdo->prepare("
        SELECT COUNT(*) FROM student s
          JOIN course c ON c.course_id = s.course_id
          $latestJoin
          " . migration_risk_join() . "
         WHERE $listWhereSql");
    $countStmt->execute($listParams);
    $total = (int)$countStmt->fetchColumn();

    // failed_terms answers "in which term did this student fail" without opening the history panel.
    //
    // survey_decision is attached afterwards by migration_attach_survey_decisions(),
    // because the board needs to know which answer it came from as well as what
    // it says. `es.decision` is a different thing: the Approved/Declined flow.
    $studentSelectSql = "
        SELECT s.student_id, s.student_number, s.first_name, s.last_name, s.middle_name,
               s.extension_name, s.gender, s.email_address,
               s.`star e-profile` AS student_type, s.year_level, s.section,
               c.course_code, c.course_name, c.year_duration, d.department_name, cam.campus_name,
               es.enrollment_status_id, es.status_type AS status_id, st.status_name, es.decision,
               es.date AS status_date, es.reason, es.response,
               sem.semester_name, sy.schoolyear_name,
               risk.combined_risk_level AS retention_risk_level,
               risk.evaluation_score AS retention_score,
               risk.evaluated_at AS retention_evaluated_at,
               (SELECT COUNT(*) FROM grades g
                 WHERE g.student_id = s.student_id AND g.archived_at IS NULL
                   AND (g.failed > 0 OR g.no_credit > 0 OR g.no_grade > 0 OR g.incomplete > 0)) AS failed_terms
          FROM student s
          JOIN course c ON c.course_id = s.course_id
          LEFT JOIN department d ON d.department_id = c.department_id
          LEFT JOIN campus cam ON cam.campus_id = d.campus_id
          $latestJoin
          " . migration_risk_join() . "
          LEFT JOIN semester sem ON sem.semester_id = es.semester_id
          LEFT JOIN school_year sy ON sy.school_year_id = es.school_year_id";

    /*
     * One student, read back on their own.
     *
     * Editing a decision or a status changes several fields at once - the
     * standing, its date, the note and, for a student who had no row for the
     * term, the enrollment_status_id a later edit needs to know about. Rather
     * than have the page guess at those, it asks for the row again and swaps it
     * in, so a single edit costs one small query instead of re-reading and
     * repainting the whole table.
     *
     * Deliberately not filtered by the caller's status filter: a student moved
     * to a status outside the current filter still gets their row back, so the
     * edit is visible where it was made rather than the row vanishing under the
     * pointer. The next full load applies the filter as usual.
     *
     * Scope still applies, so this cannot read a student the caller could not
     * already see in the list.
     */
    $decisionSources = migration_decision_sources($pdo, $semesterId);
    $selectedDecisionId = (int)($_GET['decision_question_id'] ?? 0);
    $decisionQuestion = null;
    foreach ($decisionSources as $source) {
        if ((int)$source['question_id'] === $selectedDecisionId) $decisionQuestion = $source;
    }
    if ($selectedDecisionId > 0 && !$decisionQuestion) {
        migration_out(400, ['message' => 'Choose an enrollment decision question configured for this semester.']);
    }
    // A unique source is unambiguous; several sources require an explicit choice.
    if (!$decisionQuestion && count($decisionSources) === 1) $decisionQuestion = $decisionSources[0];
    $selectedDecisionId = (int)($decisionQuestion['question_id'] ?? 0);

    if (($_GET['action'] ?? '') === 'row') {
        $rowStudentId = isset($_GET['student_id']) ? (int)$_GET['student_id'] : 0;
        if ($rowStudentId <= 0) {
            migration_out(400, ['message' => 'student_id is required']);
        }

        $rowStmt = $pdo->prepare($studentSelectSql . "
         WHERE $scopeSql AND s.student_id = :row_student_id
         LIMIT 1");
        // $latestJoin carries the term placeholders, so those bind here too.
        foreach (array_merge($scopeParams, $termParams) as $key => $value) {
            $rowStmt->bindValue($key, $value);
        }
        $rowStmt->bindValue(':row_student_id', $rowStudentId, PDO::PARAM_INT);
        $rowStmt->execute();
        $rowStudent = $rowStmt->fetch(PDO::FETCH_ASSOC);

        if (!$rowStudent) {
            migration_out(404, ['message' => 'Student not found in your scope']);
        }
        [$rowStudent] = migration_attach_survey_decisions($pdo, [$rowStudent], $selectedDecisionId);

        // The counts move with the status, so they are returned alongside -
        // otherwise the filter dropdown would keep showing the old totals until
        // something else forced a reload. The row's decision question comes
        // too, in case the page has not seen it yet.
        migration_out(200, [
            'student' => $rowStudent,
            'summary' => $summary,
            'total_students' => $totalStudents,
            'decision_questions' => migration_decision_questions($pdo, [$rowStudent['survey_decision_question_id']]),
        ]);
    }

    /*
     * The page is chosen first, and only then described.
     *
     * $studentSelectSql carries a correlated subquery - failed_terms - which
     * the server runs once per candidate row (survey_decision was a second one
     * until it moved to migration_attach_survey_decisions()). Asking for them
     * and LIMITing afterwards ran them for the whole cohort to print
     * twenty-five: 2,776 executions of each, 30,803 rows examined, 507ms, and
     * growing with every student the registrar adds.
     *
     * The subquery appears in neither WHERE nor ORDER BY, so it cannot change
     * which students are on the page or what order they come in. That is what
     * makes splitting this safe: the first pass settles membership using the
     * same filters and the same ORDER BY, and the second pass decorates the
     * rows it chose. Same rows, same order, the expensive part done 25 times
     * instead of 2,776.
     *
     * The ORDER BY is repeated below rather than trusted to the IN () list,
     * which has no order of its own.
     */
    $orderBySql = ' ORDER BY COALESCE(st.sort_order, 9999) ASC, s.year_level ASC,'
        . ' s.last_name ASC, s.first_name ASC, s.student_id ASC';

    $pageStmt = $pdo->prepare("
        SELECT s.student_id
          FROM student s
          JOIN course c ON c.course_id = s.course_id
          $latestJoin
          " . migration_risk_join() . "
         WHERE $listWhereSql" . $orderBySql . "
         LIMIT :limit OFFSET :offset");
    foreach ($listParams as $key => $value) {
        $pageStmt->bindValue($key, $value);
    }
    $pageStmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $pageStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $pageStmt->execute();
    $pageIds = array_map('intval', $pageStmt->fetchAll(PDO::FETCH_COLUMN) ?: []);

    /*
     * $listWhereSql is kept on the second pass even though the ids already
     * satisfy it. It carries $scopeSql - the department pinning - and a filter
     * that only guards the gate is one refactor away from guarding nothing.
     *
     * The ids are ints cast from the column just read, so inlining them is not
     * a way in for request data. An empty page skips the query rather than
     * emitting IN (), which is a syntax error.
     */
    if ($pageIds === []) {
        $listStmt = null;
    } else {
        $listStmt = $pdo->prepare($studentSelectSql . "
         WHERE $listWhereSql AND s.student_id IN (" . implode(',', $pageIds) . ")" . $orderBySql);
        foreach ($listParams as $key => $value) {
            $listStmt->bindValue($key, $value);
        }
        $listStmt->execute();
    }

    // ---- filter options ----------------------------------------------------
    /*
     * The campus comes back so the chooser can tell two BSITs apart.
     *
     * A department runs on more than one campus and each campus's is its own
     * row, so CITE Carmen and CITE Puerto both offer a course coded BSIT.
     * Across departments that is two options spelled identically; the list
     * that draws them appends the campus only when a code is ambiguous, and
     * needs these fields to do it.
     */
    $courseStmt = $pdo->prepare(
        'SELECT DISTINCT c.course_id, c.course_code, c.course_name,
                cam.campus_code, cam.campus_name
           FROM course c
           JOIN student s ON s.course_id = c.course_id AND s.archived_at IS NULL
           LEFT JOIN department d ON d.department_id = c.department_id
           LEFT JOIN campus cam ON cam.campus_id = d.campus_id
          WHERE ' . ($departmentId ? api_department_filter_sql('c.department_id', $departmentScopeIsOwn) : '1=1') . '
       ORDER BY c.course_code ASC, cam.campus_code ASC'
    );
    $courseStmt->execute($departmentId ? [':department_id' => $departmentId] : []);

    $departmentName = null;
    if ($departmentId) {
        $deptStmt = $pdo->prepare('SELECT department_name FROM department WHERE department_id = :id LIMIT 1');
        $deptStmt->execute([':id' => $departmentId]);
        $departmentName = $deptStmt->fetchColumn() ?: null;
    }

    $termLabel = migration_term_label($pdo, $schoolYearId, $semesterId);

    /*
     * The survey question whose answers carry an enrolment status, for the term
     * being viewed, plus its choices.
     *
     * This is what lets the board offer "Enrollment Decision" as a dropdown
     * rather than a read-only echo. The question is found by the mapping itself
     * - options with an enrollment_status_id - so a survey rebuilt or renamed
     * later is picked up without touching this file. The survey is matched on
     * the semester being viewed. Multiple eligible sources require a selection;
     * no source from a different semester is borrowed as a fallback.
     *
     * This is only where a NEW answer goes. A student who has answered
     * already is edited in place - see migration_attach_survey_decisions().
     *
     * The write goes to survey_response.php, which owns survey answers and
     * re-checks permission; this endpoint stays read-only.
     */
    /*
     * The page's rows, each carrying the priority already computed for the whole
     * scope above. Attached here rather than re-derived so the row, the dropdown
     * counts and the filter can never disagree about the same student.
     */
    $studentRows = migration_attach_survey_decisions(
        $pdo,
        $listStmt ? ($listStmt->fetchAll(PDO::FETCH_ASSOC) ?: []) : [],
        $selectedDecisionId
    );

    // Every decision question the dropdowns on this page need: the one a new
    // answer goes to, plus each one an existing answer belongs to.
    $decisionQuestions = migration_decision_questions($pdo, array_merge(
        [$decisionQuestion['question_id'] ?? 0],
        array_column($studentRows, 'survey_decision_question_id')
    ));
    $decisionChoices = [];
    foreach ($decisionQuestions as $question) {
        if ($decisionQuestion && $question['question_id'] === (int)$decisionQuestion['question_id']) {
            $decisionChoices = $question['choices'];
        }
    }

    /**
     * Names a term, but only when it is not the term already in the heading.
     *
     * Returning null for a match is the point: a column that repeated the
     * page's own term on all 2,776 rows would be noise, and noise is what
     * stops the rare disagreeing row from being noticed. Two small lookups
     * rather than a query per row.
     */
    $years = $pdo->query('SELECT school_year_id, schoolyear_name FROM school_year')
        ->fetchAll(PDO::FETCH_KEY_PAIR);
    $semesters = $pdo->query('SELECT semester_id, semester_name FROM semester')
        ->fetchAll(PDO::FETCH_KEY_PAIR);
    $otherTermLabel = static function (?int $sy, ?int $sem) use ($years, $semesters, $schoolYearId, $semesterId): ?string {
        if ($sy === null || $sem === null) {
            return null;
        }
        if ($sy === $schoolYearId && $sem === $semesterId) {
            return null;
        }
        $name = trim(($years[$sy] ?? '') . ' ' . ($semesters[$sem] ?? ''));
        return $name === '' ? null : $name;
    };

    foreach ($studentRows as &$studentRow) {
        $classified = $priorityMap[(int)$studentRow['student_id']] ?? null;
        $studentRow['priority'] = $classified['priority'] ?? null;
        $studentRow['priority_owner'] = $classified['owner'] ?? null;
        $studentRow['priority_label'] = $classified['priority_label'] ?? null;
        $studentRow['segment'] = $classified['segment'] ?? null;

        /*
         * The two columns the Dean's sheet leaves blank.
         *
         * "Academics standing last sem" and "Balances" are columns of the
         * retention workbook this page was built from, and in the copy we
         * were given both are empty for every one of the 2,776 rows - so the
         * grid that counts off them reports zero for everybody. The app
         * already holds a grades row for all of those students and a finance
         * row for all of them, which is the only reason this is a decoration
         * and not a data-entry project.
         *
         * Read off $classified rather than queried, because these are the
         * very figures that decided the Priority badge one column to the
         * left. Asking for them again would let a row explain itself with
         * numbers its own badge disagrees with, and would cost two more
         * queries a page for values already in memory.
         *
         * A student with no record keeps a null rather than a zero. "Nobody
         * has uploaded marks for this student" and "this student failed
         * nothing" are different facts, and only one of them is good news.
         */
        $studentRow['grade_colour'] = $classified['grade_colour'] ?? null;
        $studentRow['grade_label'] = $classified['grade_label'] ?? null;
        $studentRow['problem_subjects'] = $classified['problem_subjects'] ?? null;
        $studentRow['total_subject'] = $classified['total_subject'] ?? null;
        $studentRow['balance_band'] = $classified['balance_band'] ?? null;
        $studentRow['balance_colour'] = $classified['balance_colour'] ?? null;
        $studentRow['balance_label'] = $classified['balance_label'] ?? null;
        $studentRow['balance_amount'] = $classified['balance_amount'] ?? null;

        // Null unless the figure predates the heading - see $otherTermLabel.
        $studentRow['standing_term'] = $otherTermLabel(
            $classified['grade_school_year_id'] ?? null,
            $classified['grade_semester_id'] ?? null
        );
        $studentRow['balance_term'] = $otherTermLabel(
            $classified['balance_school_year_id'] ?? null,
            $classified['balance_semester_id'] ?? null
        );
    }
    unset($studentRow);

    migration_out(200, [
        'scope' => [
            'department_id' => $departmentId,
            'department_name' => $departmentName ?? ($departmentId ? null : 'All Departments'),
            'can_choose_department' => $seesAllDepartments,
            'sees_all_departments' => $seesAllDepartments && $departmentId === null,
            // Whether to offer the inline status editor. The write itself goes to
            // enrollment_status.php, which owns that module and re-checks this —
            // this flag only decides whether to render a control the caller
            // cannot use. This endpoint stays read-only.
            'can_edit_status' => api_can($authUser['permissions'] ?? [], 'enrollment_status', 'edit'),
            'can_create_status' => api_can($authUser['permissions'] ?? [], 'enrollment_status', 'create'),
            // Recording a decision writes a survey answer, so it is the survey
            // responses module that governs it, not enrollment_status. A role
            // may hold one and not the other.
            'can_edit_decision' => $decisionQuestion !== null
                && api_can($authUser['permissions'] ?? [], 'survey_responses', 'create'),
        ],
        'term' => [
            'school_year_id' => $schoolYearId,
            'semester_id' => $semesterId,
            'label' => $termLabel,
            'previous_school_year_id' => $previous['school_year_id'],
            'previous_semester_id' => $previous['semester_id'],
            'has_previous' => $previous['semester_id'] !== null,
        ],
        'summary' => $summary,
        'total_students' => $totalStudents,
        'students' => $studentRows,
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
            'pages' => $limit > 0 ? (int)ceil($total / $limit) : 0,
        ],
        'applied_filters' => [
            'status_id' => $wantsNoStatus ? MIGRATION_NO_STATUS : $statusId,
            'course_id' => $courseId,
            'year_level' => $yearLevel,
            'search' => $search,
            'retention_risk' => $wantsNoRisk ? MIGRATION_RISK_NONE : $riskLevel,
            'priority' => $priorityLevel,
        ],
        'filters' => [
            'courses' => $courseStmt->fetchAll(PDO::FETCH_ASSOC) ?: [],
            // Real, current statuses only. `summary` carries the same names but
            // appends a synthetic "No status recorded" bucket and keeps retired
            // statuses that still hold students - neither may be offered as
            // something to save (enrollment_status.php refuses a retired one).
            'enrollment_statuses' => array_values(array_map(
                static fn(array $row): array => ['status_id' => $row['status_id'], 'status_name' => $row['status_name']],
                array_filter($statusRows, static fn(array $row): bool => $row['archived_at'] === null)
            )),
            /*
             * The retention dropdown, counts included, in the order a reader
             * cares about: the students most likely to leave first. 'Not
             * assessed' sits last because it is the absence of an answer rather
             * than a fourth kind of one.
             */
            'retention_risks' => (function () use ($riskCounts) {
                $labels = [
                    'high' => 'High risk',
                    'moderate' => 'Moderate risk',
                    'low' => 'Low risk',
                    MIGRATION_RISK_NONE => 'Not assessed',
                ];
                $out = [];
                foreach ($labels as $level => $label) {
                    $out[] = [
                        'level' => $level,
                        'label' => $label,
                        'student_count' => $riskCounts[$level] ?? 0,
                    ];
                }
                return $out;
            })(),
            /*
             * The priority dropdown, counts included, most urgent first. Counted
             * over the whole scope rather than over what is currently on screen,
             * so choosing P1 does not change what P2 reports.
             */
            'priorities' => (function () use ($priorityCounts) {
                $out = [];
                foreach ([1, 2, 3, 4] as $level) {
                    $out[] = [
                        'priority' => $level,
                        'owner' => PDO_PRIORITY_OWNERS[$level],
                        'label' => 'P' . $level . ' - ' . PDO_PRIORITY_OWNERS[$level],
                        'student_count' => $priorityCounts[$level] ?? 0,
                    ];
                }
                return $out;
            })(),
            'semesters' => $pdo->query('SELECT semester_id, semester_name FROM semester ORDER BY semester_id ASC')->fetchAll(PDO::FETCH_ASSOC) ?: [],
            'school_years' => $pdo->query('SELECT school_year_id, schoolyear_name FROM school_year ORDER BY schoolyear_name DESC')->fetchAll(PDO::FETCH_ASSOC) ?: [],
            'departments' => $seesAllDepartments
                ? ($pdo->query('SELECT department_id, department_name FROM department ORDER BY department_name ASC')->fetchAll(PDO::FETCH_ASSOC) ?: [])
                : [],
            // Where a student with no answer yet has one recorded. survey_id and
            // question_id ride along because survey_response.php needs both to
            // find or open the student's submission.
            'survey_decision' => $decisionQuestion ? [
                'survey_id' => (int)$decisionQuestion['survey_id'],
                'survey_title' => $decisionQuestion['survey_title'],
                'question_id' => (int)$decisionQuestion['question_id'],
                'question_text' => $decisionQuestion['question_text'],
                'question_type' => $decisionQuestion['question_type'],
                'choices' => $decisionChoices,
            ] : null,
            // Choices for each row's own decision question, keyed by the
            // survey_decision_question_id the rows carry.
            'decision_questions' => $decisionQuestions,
            'decision_sources' => $decisionSources,
        ],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'student_migration']);
    migration_out(500, ['message' => 'Server error while loading student migration.']);
}
