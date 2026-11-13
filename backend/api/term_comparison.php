<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

/**
 * One term against another: grades, attendance and finance, for the same
 * students.
 *
 * The reports that already exist answer "what does this term look like". None of
 * them answers "is it better or worse than last year", which is the only
 * question that tells anyone whether an intervention worked. Doing it by opening
 * two reports and comparing by eye fails quietly, because the two are not
 * necessarily describing the same students -- a cohort grows and shrinks between
 * terms, and an average over a different population is not a comparison.
 *
 * So the population is computed once and carried: `students_in_both` is the only
 * set a delta is reported over, and students present in one term only are
 * counted separately rather than being folded into an average that then moves
 * for a reason nobody can see.
 *
 * ---------------------------------------------------------------------------
 * THE ROLLUPS ARE NOT INVENTED HERE
 *
 * Each of the three has a convention already agreed across modules, and getting
 * one wrong here would make this screen disagree with the module it summarises:
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
 *
 * The attendance target comes from attendance_remark_policy, resolved per term.
 * That matters more than it looks: the previous year is judged against the
 * policy pinned to the previous year, not against this year's. Comparing last
 * year's students to this year's target would answer a question nobody asked and
 * make every change of target look like a change in the students.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/attendance_remark_service.php';
// The cohort filter and the three rollups. Shared with term_logbook.php, which
// asks the same question of one term that this file asks of two -- see that file
// for why they are separate endpoints rather than one with a mode flag.
require_once __DIR__ . '/lib/term_records.php';

function tcmp_out(int $code, array $payload): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/** Kept as this file's spelling of term_records_int(), which is the same function. */
function tcmp_int($value): ?int {
    return term_records_int($value);
}

function tcmp_term(
    PDO $pdo,
    ?int $schoolYearId,
    ?int $semesterId,
    ?int $period,
    array $cohort,
    array $visibility
): ?array {
    if ($schoolYearId === null || $semesterId === null) {
        return null;
    }

    $studentIds = array_keys($cohort);
    $grades = $visibility['grades'] ? term_records_grades($pdo, $schoolYearId, $semesterId, $period, $studentIds) : [];
    $attendance = $visibility['attendance'] ? term_records_attendance($pdo, $schoolYearId, $semesterId, $period, $studentIds) : [];
    /*
     * Balances are withheld from a caller without the finance module.
     *
     * The report menu grants this screen to anyone who may open Reports at all,
     * and SSG is one of those without finance_management. Showing a column of
     * outstanding balances to a reader the finance module refuses would widen
     * that permission by the back door -- and reports are exactly where nobody
     * would notice it had happened.
     */
    $finance = $visibility['finance'] ? term_records_finance($pdo, $schoolYearId, $semesterId, $period, $studentIds) : [];

    $policy = attendance_remark_get_policy($pdo, $schoolYearId, $semesterId, $period);
    $target = attendance_remark_target($policy);

    // Whether each row meets the target, worked out once and reused by both the
    // summary and the per-student list. Computing it twice is how a screen ends
    // up reporting "412 meet the target" above a table that lists 409.
    foreach ($attendance as $studentId => $row) {
        $described = attendance_remark_signals($row, $target);
        $attendance[$studentId]['meets_target'] = $described['meets_target'] === null
            ? null : (bool)$described['meets_target'];
        $attendance[$studentId]['absences_over_target'] = $described['absences_over_target'];
        $attendance[$studentId]['remark_id'] = attendance_remark_evaluate($row, $policy);
    }

    $remarkNames = [];
    foreach ($policy['rules'] ?? [] as $rule) {
        $remarkNames[(int)$rule['remark_id']] = (string)$rule['remark_name'];
    }
    foreach ($attendance as $studentId => $row) {
        $attendance[$studentId]['remark'] = $row['remark_id'] === null
            ? null : ($remarkNames[$row['remark_id']] ?? null);
    }

    return [
        'school_year_id' => $schoolYearId,
        'semester_id' => $semesterId,
        'period' => $period,
        'target' => $target,
        'policy_name' => $policy['policy_name'] ?? null,
        'visibility' => $visibility,
        'grades' => $grades,
        'attendance' => $attendance,
        'finance' => $finance,
    ];
}

/**
 * Does this term hold anything at all?
 *
 * The difference between "nobody cleared their balance" and "no record of this
 * term exists" is the whole reason this function is here. Both come back from
 * the rollups as an empty array, and summarising an empty array produces a
 * confident row of zeros -- which a reader takes as a finding.
 */
function tcmp_term_has_records(?array $term): bool {
    if ($term === null) {
        return false;
    }
    return (bool)($term['grades'] || $term['attendance'] || $term['finance']);
}

/** The headline numbers for one term, over whichever students it holds. */
function tcmp_summarise(?array $term): ?array {
    if ($term === null) {
        return null;
    }

    $gradeRows = $term['grades'];
    $attendanceRows = $term['attendance'];
    $financeRows = $term['finance'];

    $byRemark = [];
    $withFailed = 0;
    foreach ($gradeRows as $row) {
        $key = $row['remark'] ?? 'No remark';
        $byRemark[$key] = ($byRemark[$key] ?? 0) + 1;
        if ($row['failed'] > 0 || $row['no_credit'] > 0) {
            $withFailed++;
        }
    }
    arsort($byRemark);

    $meets = 0;
    $missed = 0;
    $unjudged = 0;
    foreach ($attendanceRows as $row) {
        if ($row['meets_target'] === null) {
            $unjudged++;
        } elseif ($row['meets_target']) {
            $meets++;
        } else {
            $missed++;
        }
    }

    $balances = array_values(array_filter(
        array_column($financeRows, 'balance'),
        static fn($value) => $value !== null
    ));
    $cleared = count(array_filter($financeRows, static fn($row) => $row['is_cleared'] === true));

    $attendanceByRemark = [];
    foreach ($attendanceRows as $row) {
        $key = $row['remark'] ?? 'No remark';
        $attendanceByRemark[$key] = ($attendanceByRemark[$key] ?? 0) + 1;
    }
    arsort($attendanceByRemark);

    return [
        'grades' => [
            'records' => count($gradeRows),
            'average_pass_rate' => term_records_average(array_column($gradeRows, 'pass_rate')),
            'with_failed_mark' => $withFailed,
            'clean' => count($gradeRows) - $withFailed,
            'by_remark' => $byRemark,
        ],
        'attendance' => [
            'records' => count($attendanceRows),
            'average_rate' => term_records_average(array_column($attendanceRows, 'attendance_rate')),
            'average_absences' => term_records_average(array_map(
                static fn($row) => (float)$row['absent'],
                $attendanceRows
            )),
            'meets_target' => $meets,
            'missed_target' => $missed,
            // Separate from "missed" on purpose: a term nobody set a target for
            // is not a term where everybody failed.
            'no_target' => $unjudged,
            'meets_target_rate' => term_records_rate((float)$meets, (float)($meets + $missed)),
            'by_remark' => $attendanceByRemark,
        ],
        'finance' => [
            'records' => count($financeRows),
            'cleared' => $cleared,
            'with_balance' => count($financeRows) - $cleared,
            'average_balance' => $balances ? round(array_sum($balances) / count($balances), 2) : null,
            'total_balance' => $balances ? round(array_sum($balances), 2) : null,
        ],
    ];
}

/** One student's figures for one term, or nulls when they have no record in it. */
function tcmp_student_side(?array $term, int $studentId): array {
    $grade = $term['grades'][$studentId] ?? null;
    $attendance = $term['attendance'][$studentId] ?? null;
    $finance = $term['finance'][$studentId] ?? null;

    return [
        'has_record' => $grade !== null || $attendance !== null || $finance !== null,
        'pass_rate' => $grade['pass_rate'] ?? null,
        'failed' => $grade['failed'] ?? null,
        'grade_remark' => $grade['remark'] ?? null,
        'attendance_rate' => $attendance['attendance_rate'] ?? null,
        'absent' => $attendance['absent'] ?? null,
        'classes' => $attendance['total_classes_conducted'] ?? null,
        'meets_target' => $attendance['meets_target'] ?? null,
        'absences_over_target' => $attendance['absences_over_target'] ?? null,
        'attendance_remark' => $attendance['remark'] ?? null,
        'balance' => $finance['balance'] ?? null,
        'is_cleared' => $finance['is_cleared'] ?? null,
    ];
}

/** current - previous, or null when either side is missing. */
function tcmp_delta(?float $current, ?float $previous): ?float {
    if ($current === null || $previous === null) {
        return null;
    }
    return round($current - $previous, 2);
}

try {
    $pdo = (new Database())->connect();
    parse_str($_SERVER['QUERY_STRING'] ?? '', $query);

    if (!attendance_remark_tables_exist($pdo)) {
        tcmp_out(503, ['message' => 'The attendance policy tables are not installed yet.']);
    }

    /*
     * The terms that actually hold records, newest first.
     *
     * Taken from the data rather than from school_year CROSS JOIN semester: the
     * cross product is twenty-one rows of which three exist, and offering to
     * compare a term nobody recorded anything in wastes the reader's time and
     * then shows them two empty columns. Same reasoning as
     * term_snapshot_terms().
     */
    /*
     * Every term that holds a record, newest first. Shared with the logbook so
     * the two screens offer the same list -- see lib/term_records.php for why it
     * comes from the data rather than from school_year CROSS JOIN semester.
     */
    $terms = term_records_terms($pdo);

    if (!$terms) {
        tcmp_out(200, ['data' => [
            'terms' => [], 'current' => null, 'previous' => null,
            'students' => [], 'pagination' => ['total' => 0, 'page' => 1, 'limit' => 25],
            'message' => 'No term holds any records yet.',
        ]]);
    }

    // The current term: what was asked for, else the newest that holds records.
    $schoolYearId = tcmp_int($query['school_year_id'] ?? null) ?? $terms[0]['school_year_id'];
    $semesterId = tcmp_int($query['semester_id'] ?? null);
    if ($semesterId === null) {
        /*
         * No semester given: take the first one this year actually holds rather
         * than defaulting to id 1. Defaulting to a semester with no records
         * shows two empty columns and reads as "the comparison is broken".
         */
        foreach ($terms as $term) {
            if ($term['school_year_id'] === $schoolYearId) {
                $semesterId = $term['semester_id'];
                break;
            }
        }
    }
    if ($semesterId === null) {
        tcmp_out(400, ['message' => 'That school year holds no records to compare.']);
    }

    $period = tcmp_int($query['period'] ?? null);
    if ($period !== null && ($period < 1 || $period > 3)) {
        $period = null;
    }

    /*
     * The term compared against: explicit, else the same semester a year earlier.
     *
     * "A year earlier" is resolved by NAME through sy_window_previous() -- the
     * school_year ids are insertion order, so the row before 2026-2027 by id is
     * 2022-2023 and an off-by-one here compares this year to one four years ago
     * without saying so.
     */
    $compareYearId = tcmp_int($query['compare_school_year_id'] ?? null);
    $compareSemesterId = tcmp_int($query['compare_semester_id'] ?? null) ?? $semesterId;
    if ($compareYearId === null) {
        $previousYear = sy_window_previous($pdo, $schoolYearId);
        $compareYearId = $previousYear['school_year_id'] ?? null;
    }
    // A period only means the same thing in both terms if both were recorded
    // that way; when the earlier term has no periodicals its whole-term row is
    // the only honest answer.
    $comparePeriod = tcmp_int($query['compare_period'] ?? null) ?? $period;

    /*
     * Which blocks this caller may read.
     *
     * A role with no saved permission map sees everything: the middleware has
     * already checked it against this endpoint's reader list, and the
     * alternative is showing a dean three empty cards because nobody has ticked
     * boxes for their role yet. Where a map exists it is honoured per module.
     * Same rule, same helper, as student_history.php.
     */
    $authUser = api_get_session_user();
    $permissionMap = [];
    $usesPermissionMap = false;
    if (!empty($authUser['role_id']) || !empty($authUser['user_id'])) {
        $permissionRecord = api_fetch_effective_permissions_record(
            $pdo,
            (int)($authUser['role_id'] ?? 0),
            (int)($authUser['user_id'] ?? 0)
        );
        $usesPermissionMap = !empty($permissionRecord['has_saved_permissions']);
        $permissionMap = $usesPermissionMap ? ($permissionRecord['permissions'] ?? []) : [];
    }
    $may = static function (string $moduleKey) use ($usesPermissionMap, $permissionMap): bool {
        return $usesPermissionMap ? api_can($permissionMap, $moduleKey, 'view') : true;
    };
    $visibility = [
        'grades' => $may('grades'),
        'attendance' => $may('attendance_management'),
        'finance' => $may('finance_management'),
    ];

    $cohort = term_records_cohort($pdo, $query);
    if (!$cohort) {
        tcmp_out(200, ['data' => [
            'terms' => $terms, 'current' => null, 'previous' => null, 'students' => [],
            'pagination' => ['total' => 0, 'page' => 1, 'limit' => 25],
            'message' => 'No students match these filters.',
        ]]);
    }

    $current = tcmp_term($pdo, $schoolYearId, $semesterId, $period, $cohort, $visibility);
    $previous = tcmp_term($pdo, $compareYearId, $compareSemesterId, $comparePeriod, $cohort, $visibility);

    /*
     * A comparison term with no records is NO comparison, not a term of zeros.
     *
     * sy_window_previous() answers "the year before this one" from the school
     * year list, and most of those years hold nothing -- 2024-2025 exists as a
     * row and has never had a single record imported. Summarising it produced a
     * complete previous block reading "0 cleared, 0 met the target" under the
     * heading "null · null", and every delta on the screen was then computed
     * against those zeros. A reader has no way to tell that apart from a term
     * where everybody genuinely failed.
     *
     * The label is kept so the screen can say WHICH term was empty. Only the
     * numbers go.
     */
    $comparisonNote = null;
    if ($previous !== null && !tcmp_term_has_records($previous)) {
        $emptyYear = sy_window_name($pdo, (int)$previous['school_year_id']);
        $comparisonNote = ($emptyYear ?: 'That term') . ' holds no records, so there is nothing to compare against.';
        $previous = null;
    }

    /*
     * Only students with a record in the term are counted.
     *
     * A cohort of 1,628 students against a term holding 300 grade rows would
     * otherwise report an average over 1,628 people, 1,328 of whom were never in
     * it. That average is not wrong by a little.
     */
    $inCurrent = $current === null ? [] : array_unique(array_merge(
        array_keys($current['grades']), array_keys($current['attendance']), array_keys($current['finance'])
    ));
    $inPrevious = $previous === null ? [] : array_unique(array_merge(
        array_keys($previous['grades']), array_keys($previous['attendance']), array_keys($previous['finance'])
    ));
    $inBoth = array_values(array_intersect($inCurrent, $inPrevious));

    $listed = $query['scope'] ?? 'current';
    $studentIds = $listed === 'both' ? $inBoth : ($listed === 'previous' ? $inPrevious : $inCurrent);

    // ---- the per-student table -------------------------------------------
    $rows = [];
    foreach ($studentIds as $studentId) {
        if (!isset($cohort[$studentId])) {
            continue;
        }
        $currentSide = tcmp_student_side($current, $studentId);
        $previousSide = tcmp_student_side($previous, $studentId);

        $rows[] = $cohort[$studentId] + [
            'current' => $currentSide,
            'previous' => $previousSide,
            'change' => [
                'attendance_rate' => tcmp_delta($currentSide['attendance_rate'], $previousSide['attendance_rate']),
                'pass_rate' => tcmp_delta($currentSide['pass_rate'], $previousSide['pass_rate']),
                // Deliberately current - previous, so a POSITIVE balance change
                // is money owed going up. The UI colours it accordingly; the
                // sign is not flipped here because a number that means the
                // opposite of what it says is worse than an awkward one.
                'balance' => tcmp_delta($currentSide['balance'], $previousSide['balance']),
                'absent' => tcmp_delta(
                    $currentSide['absent'] === null ? null : (float)$currentSide['absent'],
                    $previousSide['absent'] === null ? null : (float)$previousSide['absent']
                ),
            ],
        ];
    }

    // ---- filters over that table -----------------------------------------
    $filter = strtolower(trim((string)($query['filter'] ?? '')));
    if ($filter !== '' && $filter !== 'all') {
        $rows = array_values(array_filter($rows, static function (array $row) use ($filter): bool {
            switch ($filter) {
                case 'meets_target':
                    return $row['current']['meets_target'] === true;
                case 'missed_target':
                    return $row['current']['meets_target'] === false;
                case 'improved':
                    return ($row['change']['attendance_rate'] ?? 0) > 0;
                case 'declined':
                    return ($row['change']['attendance_rate'] ?? 0) < 0;
                case 'with_failed':
                    return ($row['current']['failed'] ?? 0) > 0;
                case 'with_balance':
                    return $row['current']['is_cleared'] === false;
                case 'no_previous':
                    return $row['previous']['has_record'] === false;
                default:
                    return true;
            }
        }));
    }

    $search = trim((string)($query['search'] ?? ''));
    if ($search !== '') {
        $needle = mb_strtolower($search);
        $rows = array_values(array_filter($rows, static function (array $row) use ($needle): bool {
            return mb_strpos(mb_strtolower($row['name']), $needle) !== false
                || mb_strpos(mb_strtolower($row['student_number']), $needle) !== false;
        }));
    }

    // ---- sorting ----------------------------------------------------------
    $sort = strtolower(trim((string)($query['sort'] ?? 'name')));
    $direction = strtolower(trim((string)($query['direction'] ?? ''))) === 'desc' ? -1 : 1;
    $pluck = static function (array $row) use ($sort) {
        switch ($sort) {
            case 'attendance_rate': return $row['current']['attendance_rate'];
            case 'pass_rate': return $row['current']['pass_rate'];
            case 'balance': return $row['current']['balance'];
            case 'absent': return $row['current']['absent'];
            case 'attendance_change': return $row['change']['attendance_rate'];
            default: return null;
        }
    };

    if ($sort === 'name') {
        usort($rows, static fn($a, $b) => $direction * strcasecmp($a['name'], $b['name']));
    } else {
        // Rows with no value sort last whichever way the column is pointing --
        // a null is missing information, not the smallest number, and burying
        // the students you can act on under the ones you have no data for is
        // exactly backwards.
        usort($rows, static function ($a, $b) use ($pluck, $direction) {
            $left = $pluck($a);
            $right = $pluck($b);
            if ($left === null && $right === null) return strcasecmp($a['name'], $b['name']);
            if ($left === null) return 1;
            if ($right === null) return -1;
            return $direction * ($left <=> $right);
        });
    }

    $total = count($rows);
    $limit = max(1, min(200, tcmp_int($query['limit'] ?? null) ?? 25));
    $page = max(1, tcmp_int($query['page'] ?? null) ?? 1);
    $paged = array_slice($rows, ($page - 1) * $limit, $limit);

    $termLabel = static function (?array $term) use ($terms): ?array {
        if ($term === null) {
            return null;
        }
        foreach ($terms as $known) {
            if ($known['school_year_id'] === $term['school_year_id']
                && $known['semester_id'] === $term['semester_id']) {
                return [
                    'school_year' => $known['schoolyear_name'],
                    'semester' => $known['semester_name'],
                ];
            }
        }
        return ['school_year' => null, 'semester' => null];
    };

    $describe = static function (?array $term) use ($termLabel): ?array {
        if ($term === null) {
            return null;
        }
        return [
            'school_year_id' => $term['school_year_id'],
            'semester_id' => $term['semester_id'],
            'period' => $term['period'],
            'target' => $term['target'],
            'policy_name' => $term['policy_name'],
        ] + ($termLabel($term) ?? []) + (tcmp_summarise($term) ?? []);
    };

    tcmp_out(200, ['data' => [
        'terms' => $terms,
        'current' => $describe($current),
        'previous' => $describe($previous),
        'comparison_note' => $comparisonNote,
        'visibility' => $visibility,
        'population' => [
            'cohort' => count($cohort),
            'in_current' => count($inCurrent),
            'in_previous' => count($inPrevious),
            'in_both' => count($inBoth),
            'listed' => $listed,
        ],
        'students' => $paged,
        'pagination' => [
            'total' => $total,
            'page' => $page,
            'limit' => $limit,
            'pages' => (int)ceil($total / $limit),
        ],
        'options' => [
            'courses' => $pdo->query(
                'SELECT c.course_id, c.course_code, c.course_name, c.department_id
                   FROM course c WHERE c.archived_at IS NULL ORDER BY c.course_code'
            )->fetchAll(PDO::FETCH_ASSOC) ?: [],
            'departments' => $pdo->query(
                'SELECT department_id, department_code, department_name, campus_id
                   FROM department WHERE archived_at IS NULL ORDER BY department_code'
            )->fetchAll(PDO::FETCH_ASSOC) ?: [],
        ],
    ]]);
} catch (Throwable $e) {
    tcmp_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
