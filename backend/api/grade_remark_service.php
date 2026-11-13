<?php
/**
 * Deciding which remark a grade row carries.
 *
 * Before this, nothing decided. `grades.remark_id` was written in two places --
 * grades-import.php matching a spreadsheet's text against remarks.remark_name,
 * and a person typing one in -- so the standard for "With Failed Mark" lived in
 * whatever the last import happened to say. Restating it meant re-importing.
 *
 * Two steps, kept separate for the same reason risk_model_service.php keeps its
 * two apart:
 *
 *   grade_remark_signals()   turns a grades row into a flat map of numbers.
 *                            Knows the columns, knows nothing about rules.
 *   grade_remark_evaluate()  walks the policy's rules against that map.
 *                            Knows the rules, knows nothing about the columns.
 *
 * PUBLISHED FIELD KEYS
 *   failed, incomplete, no_credit, no_grade, passed, total_subject, pass_rate
 *
 * The same vocabulary risk_model_service.php publishes for its `grades` source,
 * deliberately: an administrator who has learned one screen has learned both,
 * and a rule that reads well in one reads the same way in the other.
 *
 * ---------------------------------------------------------------------------
 * Old records are frozen
 *
 * A policy governs the current school year and the ones after it. It is never
 * applied to a year that has already finished, so restating the standard in
 * August does not silently rewrite what a student's record said in March --
 * which someone may already have counselled them about, or reported on.
 *
 * That rule lives in grade_remark_year_is_open() and is enforced at every write
 * path rather than trusted to callers, because the failure is invisible: a
 * back-dated recompute produces rows that look exactly like correct ones.
 * ---------------------------------------------------------------------------
 */

require_once __DIR__ . '/lib/school_year_window.php';
require_once __DIR__ . '/lib/remark_engine.php';

if (!defined('GRADE_REMARK_SERVICE_LOADED')) {
    define('GRADE_REMARK_SERVICE_LOADED', true);

/** The three tables the engine needs. Absent means "no policy", not an error. */
function grade_remark_tables_exist(PDO $pdo): bool
{
    return remark_tables_exist($pdo, 'grade_remark');
}

/**
 * The school year the portal treats as now, or null when nobody has said.
 *
 * Delegated to lib/school_year_window.php. This used to hold the logic, and
 * then the attendance policy needed the identical answer -- at which point the
 * only two ways to go were one shared helper or two copies of a comparison that
 * is subtle enough to get wrong (see that file: comparing school_year_id rather
 * than the name calls 2022-2023 a later year than 2026-2027).
 *
 * Kept as a named function rather than deleted: it is what the rest of this
 * file and grade_remark_policy.php already call, and renaming those adds churn
 * without adding an answer.
 */
function grade_remark_current_school_year(PDO $pdo): ?array
{
    return sy_window_current($pdo);
}

/**
 * Is this year the current one or a later one?
 *
 * Compared by NAME, not by id. The names are "2025-2026" style and sort
 * correctly as strings, where the ids do not sort chronologically at all -- a
 * comparison on id would call 2022-2023 (id 3) a later year than 2025-2026
 * (id 1) and cheerfully rewrite four-year-old records.
 *
 * With no current year set, nothing is open: better to leave remarks alone than
 * to guess which year an administrator meant and rewrite the wrong one.
 */
function grade_remark_year_is_open(PDO $pdo, ?int $schoolYearId): bool
{
    return sy_window_year_is_open($pdo, $schoolYearId);
}

/**
 * The policy governing a term: the one pinned to that year, else the fallback.
 *
 * Ordered by how specific the match is, which is the resolution risk_model
 * already uses. One rule in this codebase for "which version of the policy
 * governs this term" rather than two that can drift apart.
 */
function grade_remark_get_policy(PDO $pdo, ?int $schoolYearId = null): ?array
{
    if (!grade_remark_tables_exist($pdo)) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT policy_id, policy_name, school_year_id
           FROM grade_remark_policy
          WHERE is_active = 1
            AND (school_year_id IS NULL OR school_year_id = :sy)
       ORDER BY (school_year_id IS NOT NULL) DESC, policy_id DESC
          LIMIT 1'
    );
    $stmt->execute([':sy' => $schoolYearId]);
    $policy = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$policy) {
        return null;
    }

    $policy['policy_id'] = (int)$policy['policy_id'];
    $policy['rules'] = grade_remark_load_rules($pdo, $policy['policy_id']);
    return $policy;
}

/** A policy's active rules in the order they are tried, each with its conditions. */
function grade_remark_load_rules(PDO $pdo, int $policyId): array
{
    // This domain selects rule_id on its conditions and leaves sort_order a
    // string, which is what it returned before; see lib/remark_engine.php.
    return remark_load_rules($pdo, 'grade_remark', $policyId, [
        'condition_columns' => 'rule_id, field_key, operator, value_min, value_max',
    ]);
}

/** The field keys a condition may name. */
function grade_remark_field_keys(): array
{
    return ['failed', 'incomplete', 'no_credit', 'no_grade', 'passed', 'total_subject', 'pass_rate', 'problem_kinds'];
}

/** The operators a condition may use. */
function grade_remark_operators(): array
{
    // Field-to-field comparison used by rules such as "failed subjects equals
    // total subjects". It is grade-only, so attendance keeps its established
    // operator vocabulary unchanged.
    return array_merge(remark_operators(), ['eq_total']);
}

/**
 * A grades row as the flat numbers rules are written against.
 *
 * `pass_rate` is computed rather than read: grades.passed_of_subject exists but
 * is inert (it is stored and never maintained), so trusting it would make a
 * rule about pass rate quietly test a stale number.
 *
 * A term with no subjects recorded has no pass rate -- null, not zero. Zero
 * would read as "failed everything" to a `lt 50` rule and hand a nobody-graded
 * row the worst remark in the policy.
 */
function grade_remark_signals(array $grade): array
{
    $number = static function ($value): float {
        return $value === null || $value === '' ? 0.0 : (float)$value;
    };

    $total = $number($grade['total_subject'] ?? null);
    $passed = $number($grade['passed'] ?? null);
    $failed = $number($grade['failed'] ?? null);
    $incomplete = $number($grade['incomplete'] ?? null);
    $noCredit = $number($grade['no_credit'] ?? null);
    $noGrade = $number($grade['no_grade'] ?? null);

    return [
        'failed' => $failed,
        'incomplete' => $incomplete,
        'no_credit' => $noCredit,
        'no_grade' => $noGrade,
        'passed' => $passed,
        'total_subject' => $total,
        'pass_rate' => $total > 0 ? ($passed / $total) * 100.0 : null,
        /*
         * How many KINDS of problem the term has, not how many subjects.
         *
         * Four failures is one kind of problem; a failure and an incomplete is
         * two. That distinction is what "With Multiple Problems" has always
         * meant, and it cannot be written as a set of ANDed conditions without
         * one rule per pair -- six of them, for four categories -- so the count
         * is published as a field a single rule can test.
         */
        'problem_kinds' => (float)(
            ($failed > 0 ? 1 : 0)
            + ($incomplete > 0 ? 1 : 0)
            + ($noCredit > 0 ? 1 : 0)
            + ($noGrade > 0 ? 1 : 0)
        ),
    ];
}

/** Does one condition hold? A field with no value never matches. */
function grade_remark_condition_holds(array $condition, array $signals): bool
{
    if ((string)($condition['operator'] ?? '') === 'eq_total') {
        $key = (string)($condition['field_key'] ?? '');
        if (!array_key_exists($key, $signals) || !array_key_exists('total_subject', $signals)) {
            return false;
        }
        $actual = $signals[$key];
        $total = $signals['total_subject'];
        return $actual !== null && $total !== null && abs((float)$actual - (float)$total) < 0.005;
    }

    return remark_condition_holds($condition, $signals);
}

/**
 * The remark a policy gives this row, or null when no rule matched.
 *
 * First match wins, in sort_order -- which is why a rule's position is part of
 * the policy and not a display preference. A rule with no conditions matches
 * everything, and is how a policy names the remark for a clean record.
 */
function grade_remark_evaluate(array $grade, array $rules): ?int
{
    $signals = grade_remark_signals($grade);

    /*
     * A term with no subjects recorded gets no remark at all.
     *
     * Not a rule, because it is not a policy decision: every remark in the
     * vocabulary describes how a set of subjects went, and there is no honest
     * way to describe a set that is empty. Without this the catch-all at the
     * bottom of every policy hands "Regular Standing" -- Low Risk -- to a
     * student nobody has entered marks for yet, which is the most misleading
     * answer available.
     *
     * It also preserves what the importer's own ladder did (`if ($total <= 0)
     * return ''`), so moving imports onto the policy does not quietly start
     * labelling empty rows.
     */
    if (($signals['total_subject'] ?? 0) <= 0) {
        return null;
    }

    return remark_first_match($rules, $signals, 'grade_remark_condition_holds');
}

/**
 * The remark for a row in a given term, honouring the freeze on closed years.
 *
 * Returns null -- meaning "leave whatever is there alone" -- for a year that is
 * not the current one or a later one, for a term with no policy, and when no
 * rule matched. Callers treat all three the same way, which is what keeps a
 * closed year's remarks exactly as they were recorded.
 */
function grade_remark_for_term(PDO $pdo, ?int $schoolYearId, array $grade): ?int
{
    if (!grade_remark_year_is_open($pdo, $schoolYearId)) {
        return null;
    }

    $policy = grade_remark_get_policy($pdo, $schoolYearId);
    if ($policy === null || empty($policy['rules'])) {
        return null;
    }

    return grade_remark_evaluate($grade, $policy['rules']);
}

}
