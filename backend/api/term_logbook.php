<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

/**
 * The records logbook: one term, opened and read.
 *
 * School year, then semester, then periodical -- and at the bottom of that
 * drill-down, every student who left a record in it, with their grades, their
 * attendance and their balance side by side.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT term_comparison.php WITH A FLAG
 *
 * They read the same three rollups -- which is why those live in
 * lib/term_records.php and neither file owns them -- but they answer different
 * questions, and the difference shows up in what each one is allowed to leave
 * out.
 *
 * A comparison exists to show CHANGE. It always resolves a second term, its
 * deltas are only honest over students present in both, and a student with no
 * previous record is a caveat it has to state.
 *
 * A logbook exists to show WHAT WAS RECORDED. There is no second term, no
 * delta, and no population caveat -- every student who has a row belongs in it.
 * What a logbook needs instead is the thing a comparison does not care about at
 * all: who the student WAS at the time.
 *
 * One endpoint doing both would carry a mode flag through every branch, and
 * half its response would be null on any given call.
 * ---------------------------------------------------------------------------
 *
 * IDENTITY IS THE WHOLE POINT
 *
 * Year level, section, course, cohort and scholarship come from
 * student_term_snapshot where the term has been closed, and from the live
 * `student` row where it has not -- see term_records_identity(). Which one was
 * used travels with every row as `identity_source`, and the term carries a
 * `snapshot` block saying whether it was closed at all.
 *
 * That flag is not decoration. A register showing a student who was Year 2 BSN
 * in 2025-2026 as Year 3 BSCRIM is wrong in a way nobody can see by looking at
 * it, so the screen has to be able to say which of the two it is showing.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/attendance_remark_service.php';
require_once __DIR__ . '/lib/term_records.php';

function logbook_out(int $code, array $payload): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * How many records each periodical of this term holds.
 *
 * So the drill-down offers P1, P2 and P3 only where something was recorded.
 * Offering all three unconditionally means clicking P3 on a term that stops at
 * P2 and reading the empty table as a broken page rather than as an answer.
 */
function logbook_period_counts(PDO $pdo, int $schoolYearId, int $semesterId): array {
    $sql = "SELECT period_key AS p, SUM(n) AS records FROM (
                SELECT COALESCE(period, 0) AS period_key, COUNT(*) AS n
                  FROM grades
                 WHERE archived_at IS NULL AND school_year_id = :sy1 AND semester_id = :sem1
                 GROUP BY COALESCE(period, 0)
          UNION ALL
                SELECT COALESCE(period, 0), COUNT(*)
                  FROM attendance
                 WHERE schoolyear_id = :sy2 AND semester_id = :sem2
                 GROUP BY COALESCE(period, 0)
          UNION ALL
                SELECT COALESCE(period, 0), COUNT(*)
                  FROM finance
                 WHERE school_year_id = :sy3 AND semester_id = :sem3
                 GROUP BY COALESCE(period, 0)
            ) t
            GROUP BY period_key ORDER BY period_key";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([
        ':sy1' => $schoolYearId, ':sem1' => $semesterId,
        ':sy2' => $schoolYearId, ':sem2' => $semesterId,
        ':sy3' => $schoolYearId, ':sem3' => $semesterId,
    ]);

    $counts = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        // 0 is the stand-in for NULL that the generated period_key column uses,
        // and it means the whole-semester row rather than a fourth periodical.
        $period = (int)$row['p'];
        $counts[] = [
            'period' => $period === 0 ? null : $period,
            'records' => (int)$row['records'],
        ];
    }

    return $counts;
}

try {
    $pdo = (new Database())->connect();
    parse_str($_SERVER['QUERY_STRING'] ?? '', $query);

    $terms = term_records_terms($pdo);
    if (!$terms) {
        logbook_out(200, ['data' => [
            'terms' => [], 'term' => null, 'students' => [],
            'pagination' => ['total' => 0, 'page' => 1, 'limit' => 50, 'pages' => 0],
            'message' => 'No term holds any records yet.',
        ]]);
    }

    $schoolYearId = term_records_int($query['school_year_id'] ?? null) ?? $terms[0]['school_year_id'];
    $semesterId = term_records_int($query['semester_id'] ?? null);
    if ($semesterId === null) {
        // The first semester this year actually holds, rather than semester 1 --
        // defaulting to a semester with no records opens the logbook on an empty
        // page, which reads as a broken screen rather than as an empty term.
        foreach ($terms as $term) {
            if ($term['school_year_id'] === $schoolYearId) {
                $semesterId = $term['semester_id'];
                break;
            }
        }
    }
    if ($semesterId === null) {
        logbook_out(400, ['message' => 'That school year holds no records.']);
    }

    $period = term_records_int($query['period'] ?? null);
    if ($period !== null && ($period < 1 || $period > 3)) {
        $period = null;
    }

    /*
     * Which blocks this reader may see. Same rule and same helper as
     * student_history.php and term_comparison.php: a role with no saved
     * permission map sees everything, because the middleware has already
     * checked it against this endpoint's reader list and showing a dean an empty
     * logbook because nobody ticked boxes for their role is the worse failure.
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

    /*
     * A pinned reader is pinned whatever the query string says.
     *
     * term_records_student_filter() applies `department_id` only when the CALLER
     * supplies one, so until now a dean or program head who simply did not send
     * it read the register for every department in the college. The screen never
     * offered the filter, which is exactly why nobody noticed: the omission was
     * the default path, not an edge case.
     *
     * Assigned after the query string is parsed and never merged with it, so a
     * hand-written ?department_id= cannot widen the scope — only this line
     * decides it. Same rule and same helper as the eleven endpoints that already
     * do this; this file was simply not one of them.
     */
    if (api_user_is_department_pinned($authUser)) {
        $pinnedDepartmentId = (int)($authUser['department_id'] ?? 0);
        if ($pinnedDepartmentId <= 0) {
            logbook_out(400, ['message' => 'This account is not linked to a department.']);
        }
        $query['department_id'] = $pinnedDepartmentId;
    }

    $cohort = term_records_cohort($pdo, $query);
    $studentIds = array_keys($cohort);

    $grades = $visibility['grades']
        ? term_records_grades($pdo, $schoolYearId, $semesterId, $period, $studentIds) : [];
    $attendance = $visibility['attendance']
        ? term_records_attendance($pdo, $schoolYearId, $semesterId, $period, $studentIds) : [];
    $finance = $visibility['finance']
        ? term_records_finance($pdo, $schoolYearId, $semesterId, $period, $studentIds) : [];

    // The target this term was judged against -- resolved for THIS scope, so a
    // finished year is read against the policy pinned to it rather than against
    // whatever is in force today.
    $policy = attendance_remark_get_policy($pdo, $schoolYearId, $semesterId, $period);
    $target = attendance_remark_target($policy);

    $remarkNames = [];
    foreach ($policy['rules'] ?? [] as $rule) {
        $remarkNames[(int)$rule['remark_id']] = (string)$rule['remark_name'];
    }
    foreach ($attendance as $studentId => $row) {
        $signals = attendance_remark_signals($row, $target);
        $remarkId = attendance_remark_evaluate($row, $policy);
        $attendance[$studentId]['meets_target'] = $signals['meets_target'] === null
            ? null : (bool)$signals['meets_target'];
        $attendance[$studentId]['absences_over_target'] = $signals['absences_over_target'];
        $attendance[$studentId]['remark'] = $remarkId === null ? null : ($remarkNames[$remarkId] ?? null);
    }

    $identity = term_records_identity($pdo, $schoolYearId, $semesterId, $cohort);
    $snapshot = term_records_snapshot_state($pdo, $schoolYearId, $semesterId);

    /*
     * Only students who left a record in this term.
     *
     * A logbook page is a register of who was there, not a roster of everyone
     * who has ever enrolled. Listing the whole cohort would put 1,628 names
     * under a term holding 305 records, and the 1,323 blank rows would read as
     * missing data rather than as people who were not in it.
     */
    $present = array_unique(array_merge(array_keys($grades), array_keys($attendance), array_keys($finance)));

    $rows = [];
    foreach ($present as $studentId) {
        if (!isset($cohort[$studentId])) {
            continue;
        }
        $grade = $grades[$studentId] ?? null;
        $attend = $attendance[$studentId] ?? null;
        $money = $finance[$studentId] ?? null;

        $rows[] = [
            'student_id' => $cohort[$studentId]['student_id'],
            'student_number' => $cohort[$studentId]['student_number'],
            'name' => $cohort[$studentId]['name'],
            'department_code' => $cohort[$studentId]['department_code'],
        ] + $identity[$studentId] + [
            'grades' => $grade,
            'attendance' => $attend,
            'finance' => $money,
        ];
    }

    // ---- filters ----------------------------------------------------------
    $filter = strtolower(trim((string)($query['filter'] ?? '')));
    if ($filter !== '' && $filter !== 'all') {
        $rows = array_values(array_filter($rows, static function (array $row) use ($filter): bool {
            switch ($filter) {
                case 'meets_target':
                    return ($row['attendance']['meets_target'] ?? null) === true;
                case 'missed_target':
                    return ($row['attendance']['meets_target'] ?? null) === false;
                case 'with_failed':
                    return (int)($row['grades']['failed'] ?? 0) > 0;
                case 'clean':
                    return $row['grades'] !== null
                        && (int)$row['grades']['failed'] === 0
                        && (int)$row['grades']['incomplete'] === 0
                        && (int)$row['grades']['no_grade'] === 0;
                case 'with_balance':
                    return ($row['finance']['is_cleared'] ?? null) === false;
                case 'cleared':
                    return ($row['finance']['is_cleared'] ?? null) === true;
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
                || mb_strpos(mb_strtolower($row['student_number']), $needle) !== false
                || mb_strpos(mb_strtolower((string)$row['section']), $needle) !== false;
        }));
    }

    // ---- sorting ----------------------------------------------------------
    $sort = strtolower(trim((string)($query['sort'] ?? 'name')));
    $direction = strtolower(trim((string)($query['direction'] ?? ''))) === 'desc' ? -1 : 1;
    $pluck = static function (array $row) use ($sort) {
        switch ($sort) {
            case 'student_number': return $row['student_number'];
            case 'section': return $row['section'];
            case 'year_level': return $row['year_level'];
            case 'pass_rate': return $row['grades']['pass_rate'] ?? null;
            case 'attendance_rate': return $row['attendance']['attendance_rate'] ?? null;
            case 'absent': return $row['attendance']['absent'] ?? null;
            case 'balance': return $row['finance']['balance'] ?? null;
            default: return null;
        }
    };

    if ($sort === 'name') {
        usort($rows, static fn($a, $b) => $direction * strcasecmp($a['name'], $b['name']));
    } else {
        // A missing value sorts last whichever way the column points: null is
        // absent information, not the smallest number, and burying the students
        // you can act on under the ones with no record is exactly backwards.
        usort($rows, static function ($a, $b) use ($pluck, $direction) {
            $left = $pluck($a);
            $right = $pluck($b);
            if ($left === null && $right === null) return strcasecmp($a['name'], $b['name']);
            if ($left === null) return 1;
            if ($right === null) return -1;
            if (is_string($left) || is_string($right)) {
                return $direction * strcasecmp((string)$left, (string)$right);
            }
            return $direction * ($left <=> $right);
        });
    }

    $total = count($rows);
    $limit = max(1, min(500, term_records_int($query['limit'] ?? null) ?? 50));
    $page = max(1, term_records_int($query['page'] ?? null) ?? 1);
    $paged = array_slice($rows, ($page - 1) * $limit, $limit);

    $termName = null;
    $semesterName = null;
    foreach ($terms as $term) {
        if ($term['school_year_id'] === $schoolYearId && $term['semester_id'] === $semesterId) {
            $termName = $term['schoolyear_name'];
            $semesterName = $term['semester_name'];
            break;
        }
    }

    // Counted over every row in the term, not the page, so the totals describe
    // the term rather than whatever happens to be on screen.
    $meets = 0;
    $missed = 0;
    foreach ($attendance as $row) {
        if ($row['meets_target'] === true) $meets++;
        elseif ($row['meets_target'] === false) $missed++;
    }
    $balances = array_values(array_filter(
        array_column($finance, 'balance'),
        static fn($value) => $value !== null
    ));

    logbook_out(200, ['data' => [
        'terms' => $terms,
        'term' => [
            'school_year_id' => $schoolYearId,
            'school_year' => $termName,
            'semester_id' => $semesterId,
            'semester' => $semesterName,
            'period' => $period,
            'periods' => logbook_period_counts($pdo, $schoolYearId, $semesterId),
            'target' => $target,
            'policy_name' => $policy['policy_name'] ?? null,
            'is_open' => sy_window_year_is_open($pdo, $schoolYearId),
            'snapshot' => $snapshot,
        ],
        'summary' => [
            'students' => count($present),
            'grades' => count($grades),
            'attendance' => count($attendance),
            'finance' => count($finance),
            'average_pass_rate' => term_records_average(array_column($grades, 'pass_rate')),
            'average_attendance_rate' => term_records_average(array_column($attendance, 'attendance_rate')),
            'meets_target' => $meets,
            'missed_target' => $missed,
            'cleared' => count(array_filter($finance, static fn($row) => $row['is_cleared'] === true)),
            'total_balance' => $balances ? round(array_sum($balances), 2) : null,
        ],
        'visibility' => $visibility,
        'students' => $paged,
        'pagination' => [
            'total' => $total,
            'page' => $page,
            'limit' => $limit,
            'pages' => (int)ceil($total / $limit),
        ],
    ]]);
} catch (Throwable $e) {
    logbook_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
