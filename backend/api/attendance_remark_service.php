<?php
/**
 * Deciding what an attendance row means: the target it is judged against, and
 * the remark that follows.
 *
 * Before this, neither existed. `attendance` has no remark column at all, and
 * the only number in the system resembling a target was a bare `75` inside
 * attendanceReportMetrics.js -- not editable, not visible, and applied to a
 * fifteen-meeting periodical and a fifty-meeting semester alike.
 *
 * The structure mirrors grade_remark_service.php deliberately, down to the
 * function names, because it is the same algorithm on different columns:
 *
 *   attendance_remark_signals()          a row -> a flat map of numbers.
 *   attendance_remark_condition_holds()  one comparison.
 *   attendance_remark_evaluate()         walk the rules, first match wins.
 *
 * PUBLISHED FIELD KEYS
 *   absent, present, total_classes_conducted, attendance_rate, absence_rate,
 *   absences_over_target, meets_target
 *
 * ---------------------------------------------------------------------------
 * ONE REAL DIFFERENCE FROM THE GRADE ENGINE, AND IT MATTERS
 *
 * A grade rule is written against the row alone. An attendance rule may be
 * written against the row AND THE TARGET -- `absences_over_target` and
 * `meets_target` are both derived from the policy the rule belongs to.
 *
 * So signals() takes the target as an argument, and the target has to come from
 * the same policy whose rules are about to be evaluated. Passing one policy's
 * target with another policy's rules would produce answers that look perfectly
 * reasonable and are wrong, which is why attendance_remark_evaluate() takes the
 * whole policy rather than a rules array: there is no way to hand it a
 * mismatched pair.
 * ---------------------------------------------------------------------------
 *
 * WHY NOTHING HERE WRITES
 *
 * The remark is computed on read and never stored. That is not a shortcut, it
 * is the freeze: with no column to write, there is no code path that can
 * restate what a finished year's attendance said. A closed year is evaluated
 * against the policy pinned to that year, which cannot be edited (see
 * sy_window_policy_is_editable), so its answers are stable by construction
 * rather than by everyone remembering not to run a backfill.
 */

require_once __DIR__ . '/lib/school_year_window.php';
require_once __DIR__ . '/lib/remark_engine.php';
// A closed semester's attendance must keep reading the same - see the end of
// this file.
require_once __DIR__ . '/lib/term_closure.php';

if (!defined('ATTENDANCE_REMARK_SERVICE_LOADED')) {
    define('ATTENDANCE_REMARK_SERVICE_LOADED', true);

/** The three tables the engine needs. Absent means "no policy", not an error. */
function attendance_remark_tables_exist(PDO $pdo): bool
{
    return remark_tables_exist($pdo, 'attendance_remark');
}

/** The field keys a condition may name. */
function attendance_remark_field_keys(): array
{
    return [
        'absent',
        'present',
        'total_classes_conducted',
        'attendance_rate',
        'absence_rate',
        'absences_over_target',
        'meets_target',
    ];
}

/** The operators a condition may use. Shared with the grade engine. */
function attendance_remark_operators(): array
{
    return remark_operators();
}

/**
 * The target a policy sets, or null when it sets none.
 *
 * Both parts are optional and both are honoured when present -- a row has to
 * satisfy every part that is set. They are not two spellings of one idea: a
 * count catches the student who missed nine of forty-five, a rate catches the
 * student who missed four of twelve, and either on its own lets one of those
 * two through.
 */
function attendance_remark_target(?array $policy): ?array
{
    if ($policy === null) {
        return null;
    }

    $maxAbsences = $policy['target_max_absences'] ?? null;
    $minRate = $policy['target_min_rate'] ?? null;

    $maxAbsences = ($maxAbsences === null || $maxAbsences === '') ? null : (int)$maxAbsences;
    $minRate = ($minRate === null || $minRate === '') ? null : (float)$minRate;

    if ($maxAbsences === null && $minRate === null) {
        return null;
    }

    return ['max_absences' => $maxAbsences, 'min_rate' => $minRate];
}

/**
 * An attendance row as the flat numbers rules are written against.
 *
 * A term with no classes conducted has no rate and no verdict -- null, not
 * zero, and not "passed". Zero would read as "missed everything" to a
 * `attendance_rate lt 80` rule and hand the worst remark in the policy to a
 * class nobody has taken a register for yet. This is the same decision
 * grade_remark_signals() makes about a term with no subjects, for the same
 * reason.
 */
function attendance_remark_signals(array $row, ?array $target = null): array
{
    $number = static function ($value): float {
        return $value === null || $value === '' ? 0.0 : (float)$value;
    };

    $conducted = $number($row['total_classes_conducted'] ?? null);
    $present = $number($row['present'] ?? null);
    $absent = $number($row['absent'] ?? null);

    $hasClasses = $conducted > 0;
    $attendanceRate = $hasClasses ? ($present / $conducted) * 100.0 : null;
    $absenceRate = $hasClasses ? ($absent / $conducted) * 100.0 : null;

    $maxAbsences = $target['max_absences'] ?? null;
    $minRate = $target['min_rate'] ?? null;

    /*
     * Negative means headroom, which is what makes the field useful.
     *
     * A rule written "absent >= 8" has to be edited every time the target moves,
     * and disagrees with the target silently until somebody remembers.
     * "absences_over_target >= -2" says "within two of the limit" and stays true
     * to whatever the limit becomes.
     */
    $over = ($maxAbsences === null) ? null : $absent - (float)$maxAbsences;

    $meets = null;
    if ($target !== null && $hasClasses) {
        $meets = true;
        if ($maxAbsences !== null && $absent > (float)$maxAbsences) {
            $meets = false;
        }
        // Compared with a tolerance because the rate is a division: a student on
        // exactly the 80% line arrives as 79.99999999999999 often enough to
        // matter, and being failed by floating point is not a policy.
        if ($minRate !== null && $attendanceRate !== null && $attendanceRate < ((float)$minRate - 0.005)) {
            $meets = false;
        }
    }

    return [
        'absent' => $absent,
        'present' => $present,
        'total_classes_conducted' => $conducted,
        'attendance_rate' => $attendanceRate,
        'absence_rate' => $absenceRate,
        'absences_over_target' => $over,
        'meets_target' => $meets === null ? null : ($meets ? 1.0 : 0.0),
    ];
}

/** Does one condition hold? A field with no value never matches. */
function attendance_remark_condition_holds(array $condition, array $signals): bool
{
    return remark_condition_holds($condition, $signals);
}

/**
 * The remark this policy gives the row, or null when no rule matched.
 *
 * Takes the whole policy rather than a rules array on purpose -- see the file
 * docblock. The target and the rules have to come from the same policy, and the
 * cheapest way to guarantee that is to make it impossible to pass them apart.
 */
function attendance_remark_evaluate(array $row, ?array $policy): ?int
{
    if ($policy === null) {
        return null;
    }

    $signals = attendance_remark_signals($row, attendance_remark_target($policy));

    // No classes conducted, no remark. Every remark in the vocabulary describes
    // how a set of meetings went and there is no honest way to describe an
    // empty one.
    if (($signals['total_classes_conducted'] ?? 0) <= 0) {
        return null;
    }

    return remark_first_match($policy['rules'] ?? [], $signals, 'attendance_remark_condition_holds');
}

/**
 * The policy governing one scope: the most specific active match.
 *
 * Specificity is year, then semester, then period. That order is a decision
 * rather than an obvious truth -- it makes a policy for "2026-2027, 1st
 * Semester, any period" beat one for "2026-2027, any semester, period 1" -- and
 * it is the right way round because a semester is the unit a target is actually
 * argued about, while a period is a slice of one.
 *
 * A null in the request means "the semester total", not "any": a policy pinned
 * to period 1 must not answer a question about the whole semester. SQL gives
 * that for free, since `period = :period` is NULL rather than true when the
 * parameter is null.
 */
function attendance_remark_get_policy(
    PDO $pdo,
    ?int $schoolYearId = null,
    ?int $semesterId = null,
    ?int $period = null
): ?array {
    if (!attendance_remark_tables_exist($pdo)) {
        return null;
    }

    static $cache = [];
    $key = ($schoolYearId ?? 'n') . ':' . ($semesterId ?? 'n') . ':' . ($period ?? 'n');
    if (array_key_exists($key, $cache)) {
        return $cache[$key];
    }

    $stmt = $pdo->prepare(
        'SELECT policy_id, policy_name, school_year_id, semester_id, period,
                target_max_absences, target_min_rate
           FROM attendance_remark_policy
          WHERE is_active = 1
            AND (school_year_id IS NULL OR school_year_id = :sy)
            AND (semester_id IS NULL OR semester_id = :sem)
            AND (period IS NULL OR period = :period)
       ORDER BY (school_year_id IS NOT NULL) DESC,
                (semester_id IS NOT NULL) DESC,
                (period IS NOT NULL) DESC,
                policy_id DESC
          LIMIT 1'
    );
    $stmt->execute([':sy' => $schoolYearId, ':sem' => $semesterId, ':period' => $period]);
    $policy = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$policy) {
        $cache[$key] = null;
        return null;
    }

    $policy['policy_id'] = (int)$policy['policy_id'];
    $policy['school_year_id'] = $policy['school_year_id'] === null ? null : (int)$policy['school_year_id'];
    $policy['semester_id'] = $policy['semester_id'] === null ? null : (int)$policy['semester_id'];
    $policy['period'] = $policy['period'] === null ? null : (int)$policy['period'];
    $policy['target_max_absences'] = $policy['target_max_absences'] === null
        ? null : (int)$policy['target_max_absences'];
    $policy['target_min_rate'] = $policy['target_min_rate'] === null
        ? null : (float)$policy['target_min_rate'];
    $policy['rules'] = attendance_remark_load_rules($pdo, $policy['policy_id']);

    $cache[$key] = $policy;
    return $policy;
}

/** A policy's active rules in the order they are tried, each with its conditions. */
function attendance_remark_load_rules(PDO $pdo, int $policyId): array
{
    // join_remarks and the int cast on sort_order are what this domain
    // returned before the engine was shared; see lib/remark_engine.php.
    return remark_load_rules($pdo, 'attendance_remark', $policyId, [
        'join_remarks' => true,
        'cast_sort_order' => true,
    ]);
}

/**
 * Everything a caller needs about one attendance row in one call.
 *
 * Returns the signals, the target that was applied, whether the row met it, and
 * the remark -- as one structure, because a screen that shows "meets target"
 * without showing which target was applied is asking to be disbelieved, and a
 * closed year's target is not the current one.
 *
 * `remark_id` is null for a row with no classes conducted, for a scope with no
 * policy, and when no rule matched. Callers treat all three alike: no remark.
 */
function attendance_remark_describe(
    PDO $pdo,
    array $row,
    ?int $schoolYearId,
    ?int $semesterId = null,
    ?int $period = null
): array {
    $policy = attendance_remark_get_policy($pdo, $schoolYearId, $semesterId, $period);
    $target = attendance_remark_target($policy);
    $signals = attendance_remark_signals($row, $target);

    return [
        'policy_id' => $policy['policy_id'] ?? null,
        'policy_name' => $policy['policy_name'] ?? null,
        'target' => $target,
        'signals' => $signals,
        'meets_target' => $signals['meets_target'] === null ? null : (bool)$signals['meets_target'],
        'remark_id' => attendance_remark_evaluate($row, $policy),
    ];
}

/*
 * ---------------------------------------------------------------------------
 * CLOSED SEMESTERS
 *
 * Because the remark is computed on read, a closed semester's attendance keeps
 * reading the same only while the policy that governs it stays the same. The
 * year freeze above covers finished years; a semester closed inside the
 * current year needs the finer question these answer: would this write change
 * which policy governs a closed term, or what that policy says?
 * ---------------------------------------------------------------------------
 */

/**
 * Whether a policy's scope answers a question about one term and period.
 *
 * The same test attendance_remark_get_policy() makes in SQL, including its one
 * subtlety: a question about the semester total (period null) is answered only
 * by a policy that is itself for the semester total.
 */
function attendance_remark_scope_matches(array $scope, int $schoolYearId, int $semesterId, ?int $period): bool
{
    $year = $scope['school_year_id'] ?? null;
    $semester = $scope['semester_id'] ?? null;
    $scopePeriod = $scope['period'] ?? null;

    if ($year !== null && (int)$year !== $schoolYearId) return false;
    if ($semester !== null && (int)$semester !== $semesterId) return false;
    if ($period === null) return $scopePeriod === null;
    return $scopePeriod === null || (int)$scopePeriod === $period;
}

/**
 * Whether $candidate would be chosen ahead of $current for a scope both match.
 *
 * The ORDER BY of attendance_remark_get_policy() as a comparison: a pinned
 * year, then a pinned semester, then a pinned period, then the newer id. A
 * candidate without an id is a policy not yet created, which is the newest.
 */
function attendance_remark_outranks(array $candidate, ?array $current): bool
{
    if ($current === null) {
        return true;
    }

    $rank = static function (array $policy, int $fallbackId): array {
        return [
            ($policy['school_year_id'] ?? null) !== null ? 1 : 0,
            ($policy['semester_id'] ?? null) !== null ? 1 : 0,
            ($policy['period'] ?? null) !== null ? 1 : 0,
            isset($policy['policy_id']) ? (int)$policy['policy_id'] : $fallbackId,
        ];
    };

    return $rank($candidate, PHP_INT_MAX) > $rank($current, 0);
}

/**
 * The closed semesters whose attendance would read differently after a
 * policy write, or [] when none would.
 *
 * $policyId  the policy being changed or removed; every closed term it
 *            governs today is affected. Null for a policy being created.
 * $candidate the policy as it will be afterwards (its scope, is_active and
 *            policy_id) when the write could make it govern somewhere new -
 *            a create, or switching one on. Null otherwise.
 *
 * Checked for the semester total and each periodical, because a policy can be
 * pinned to any of the four.
 */
function attendance_remark_closed_terms_affected(PDO $pdo, ?int $policyId, ?array $candidate): array
{
    $affected = [];
    foreach (term_closure_list($pdo) as $closure) {
        foreach ([null, 1, 2, 3] as $period) {
            $current = attendance_remark_get_policy($pdo, $closure['school_year_id'], $closure['semester_id'], $period);

            $governsNow = $policyId !== null
                && $current !== null
                && (int)$current['policy_id'] === $policyId;

            $wouldTakeOver = $candidate !== null
                && !empty($candidate['is_active'])
                && attendance_remark_scope_matches($candidate, $closure['school_year_id'], $closure['semester_id'], $period)
                && attendance_remark_outranks($candidate, $current);

            if ($governsNow || $wouldTakeOver) {
                $affected[] = $closure;
                break;
            }
        }
    }

    return $affected;
}

/** The refusal for a policy write that would change how a closed term reads. */
function attendance_remark_closed_term_refusal(array $closure): array
{
    return [
        'message' => $closure['label'] . ' is closed, and this change would alter how its attendance remarks read. '
            . 'Reopen it in Settings > Close Semester first, or set the target for an open semester instead.',
        'code' => TERM_CLOSURE_CODE,
        'term' => [
            'school_year_id' => $closure['school_year_id'],
            'semester_id' => $closure['semester_id'],
            'label' => $closure['label'],
        ],
    ];
}

}
