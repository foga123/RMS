<?php
/**
 * The part of the remark engine that is not about attendance or grades.
 *
 * attendance_remark_service.php and grade_remark_service.php are the same
 * algorithm on different columns - the attendance file has always said so in
 * its own header. Measured across the eight functions that paired by name, 56%
 * of their lines were identical once the domain word was normalised away, and
 * `operators`, `condition_holds` and `tables_exist` matched outright.
 *
 * That much lives here now. The two services keep their public function names,
 * so nothing that calls them changed.
 *
 * ## What is deliberately NOT here
 *
 * `signals` - what facts a domain publishes - is the one paired function that
 * was genuinely different, 26%. Attendance counts absences and rates; grades
 * count failures and pass rates; the two field vocabularies are disjoint by
 * design. Folding them into one function with a flag would be a merge of two
 * things that only rhyme.
 *
 * `get_policy` stays per-domain too. Attendance resolves across year, semester
 * AND period and caches per scope; grade resolves across year alone. The
 * ordering in attendance's version is a policy decision written as SQL, not an
 * implementation detail worth generalising.
 *
 * ## Why load_rules takes options rather than being two functions
 *
 * The two differ in three small ways and agree on the other twenty lines. The
 * options make those three differences visible in one place, which is the
 * point: before this they were invisible, sitting in two files nobody diffed.
 */

if (!defined('REMARK_ENGINE_LOADED')) {
    define('REMARK_ENGINE_LOADED', true);

/**
 * The operators a condition may use. One list, both domains.
 *
 * Note what `value_min` means for the one-sided operators: it is the value
 * being compared against, for `lte` and `lt` as much as for `gte` and `gt`.
 * Reading "min" as "lower bound" and renaming accordingly would invert them.
 */
function remark_operators(): array
{
    return ['gte', 'gt', 'lte', 'lt', 'eq', 'between'];
}

/**
 * Does one condition hold against a set of signals?
 *
 * A field the signals do not carry never matches, and neither does a NULL
 * signal - "no value" is not "zero", and a term with nothing recorded must not
 * satisfy a rule about having little.
 *
 * `eq` compares with a tolerance because every rate in either domain is a
 * division: a pass rate of exactly 50 arrives as 49.999999999999993 often
 * enough to matter, and being missed by floating point is not a policy.
 */
function remark_condition_holds(array $condition, array $signals): bool
{
    $key = (string)($condition['field_key'] ?? '');
    if (!array_key_exists($key, $signals)) {
        return false;
    }

    $actual = $signals[$key];
    if ($actual === null) {
        return false;
    }

    $min = ($condition['value_min'] ?? null) === null ? null : (float)$condition['value_min'];
    $max = ($condition['value_max'] ?? null) === null ? null : (float)$condition['value_max'];

    switch ((string)($condition['operator'] ?? 'gte')) {
        case 'gte':
            return $min !== null && $actual >= $min;
        case 'gt':
            return $min !== null && $actual > $min;
        case 'lte':
            return $min !== null && $actual <= $min;
        case 'lt':
            return $min !== null && $actual < $min;
        case 'eq':
            return $min !== null && abs($actual - $min) < 0.005;
        case 'between':
            return $min !== null && $max !== null && $actual >= $min && $actual <= $max;
        default:
            return false;
    }
}

/**
 * Are a domain's three tables present? Absent means "no policy", not an error.
 *
 * Cached per prefix rather than in one static bool, which is what made this
 * two functions before: a single cache shared between the domains would have
 * answered attendance's question with grade's answer.
 */
function remark_tables_exist(PDO $pdo, string $prefix): bool
{
    static $cache = [];
    if (array_key_exists($prefix, $cache)) {
        return $cache[$prefix];
    }

    $cache[$prefix] = api_table_exists($pdo, $prefix . '_policy')
        && api_table_exists($pdo, $prefix . '_rule')
        && api_table_exists($pdo, $prefix . '_condition');

    return $cache[$prefix];
}

/**
 * A policy's active rules in the order they are tried, each with its conditions.
 *
 * $options, all optional, are the three places the two domains disagree:
 *   'join_remarks'      also select remark_name and risk_level from `remarks`
 *   'condition_columns' the column list for the conditions query
 *   'cast_sort_order'   cast sort_order to int on the way out
 *
 * Every one of those changes the shape of what callers receive, so each is
 * pinned to what its domain returned before rather than harmonised. Making them
 * agree is a separate decision from removing the duplication.
 */
function remark_load_rules(PDO $pdo, string $prefix, int $policyId, array $options = []): array
{
    $joinRemarks = (bool)($options['join_remarks'] ?? false);
    $conditionColumns = (string)($options['condition_columns'] ?? 'field_key, operator, value_min, value_max');
    $castSortOrder = (bool)($options['cast_sort_order'] ?? false);

    $sql = $joinRemarks
        ? "SELECT r.rule_id, r.remark_id, r.label, r.sort_order, rm.remark_name, rm.risk_level
             FROM {$prefix}_rule r
             JOIN remarks rm ON rm.remark_id = r.remark_id
            WHERE r.policy_id = :policy AND r.is_active = 1
         ORDER BY r.sort_order ASC, r.rule_id ASC"
        : "SELECT rule_id, remark_id, label, sort_order
             FROM {$prefix}_rule
            WHERE policy_id = :policy AND is_active = 1
         ORDER BY sort_order ASC, rule_id ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':policy' => $policyId]);
    $rules = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    if (!$rules) {
        return [];
    }

    $conditions = $pdo->prepare(
        "SELECT {$conditionColumns}
           FROM {$prefix}_condition
          WHERE rule_id = :rule
       ORDER BY condition_id ASC"
    );

    foreach ($rules as $index => $rule) {
        $conditions->execute([':rule' => (int)$rule['rule_id']]);
        $rules[$index]['rule_id'] = (int)$rule['rule_id'];
        $rules[$index]['remark_id'] = (int)$rule['remark_id'];
        if ($castSortOrder) {
            $rules[$index]['sort_order'] = (int)$rule['sort_order'];
        }
        $rules[$index]['conditions'] = $conditions->fetchAll(PDO::FETCH_ASSOC) ?: [];
    }

    return $rules;
}

/**
 * The first rule whose every condition holds, or null when none does.
 *
 * First match wins, in the order the rules were loaded - which is why a rule's
 * position is part of the policy and not a display preference. A rule with no
 * conditions matches everything, and is how a policy names the remark for a
 * clean record.
 *
 * `$holds` is the domain's own comparison. Grade adds `eq_total` on top of the
 * shared operators, and before this took the comparison as an argument it
 * always used the shared one - which answers false for an operator it does not
 * know, so a grade rule using eq_total could be saved and could never match.
 */
function remark_first_match(array $rules, array $signals, ?callable $holds = null): ?int
{
    $holds = $holds ?? 'remark_condition_holds';
    foreach ($rules as $rule) {
        $allHold = true;
        foreach ($rule['conditions'] ?? [] as $condition) {
            if (!$holds($condition, $signals)) {
                $allHold = false;
                break;
            }
        }
        if ($allHold) {
            return (int)$rule['remark_id'];
        }
    }

    return null;
}

}
