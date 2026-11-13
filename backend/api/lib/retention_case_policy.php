<?php
/**
 * Who may write what to a retention case.
 *
 * Pure policy: no database, no superglobals, no response. Given a role context
 * and a case row it answers whether the write is allowed, and these answers are
 * the same whether they are reached from an HTTP request, a test, or a future
 * batch job.
 *
 * Split out of retention_case.php because that file is an endpoint — including
 * it runs the auth guard and exits, so the rules inside it could not be tested
 * without standing up a whole request. Rules that cannot be tested directly are
 * rules nobody checks.
 *
 * The transport half stays in retention_case.php: require_case_access() reads
 * the permission record and calls out() to refuse, both of which are that
 * endpoint's job.
 */

if (!defined('RETENTION_CASE_POLICY_LOADED')) {
    define('RETENTION_CASE_POLICY_LOADED', true);

/*
 * The codes a case's three workflow fields may hold. Here rather than in
 * retention_case.php so the status-label settings endpoint can read the same
 * lists - it cannot require that endpoint, which runs its request on include,
 * and it used to keep its own copy in step by hand.
 */
define('CASE_RISK_LEVELS', ['low', 'moderate', 'high']);
define('CASE_VALIDATION_STATUSES', ['pending', 'approved', 'rejected']);
define('CASE_INTERVENTION_STATUSES', ['unassigned', 'assigned', 'in_progress', 'follow_up', 'resolved']);

/**
 * Which periodicals a limited interventionist may act on: P1 and P2.
 *
 * The point of the restriction is that this is *preventive* work. A student
 * flagged in P1 can still be turned around inside the same semester; the same
 * flag raised in P3 is a case for the people who own withdrawal and re-enrolment
 * decisions, and an intervention logged against it by someone outside that
 * process reads as handled when it is not.
 *
 * A whole-semester case (period NULL) is deliberately NOT open. It carries no
 * timing at all, so it cannot be shown to be early, and the whole basis of this
 * grant is that the intervention is early enough to matter.
 *
 * Compared numerically after a cast, because a period read back from the
 * database arrives as the string "2" and `in_array` without the cast would put
 * every case outside the window under a strict comparison.
 */
function case_limited_intervention_periods(): array {
    return [1, 2];
}

function case_period_is_open_to_limited_intervention($period): bool {
    if ($period === null || $period === '') {
        return false;
    }
    return in_array((int)$period, case_limited_intervention_periods(), true);
}

/**
 * May this user record an intervention on this case? Null if yes, else why not.
 *
 * One function for all four write paths — intervention_status, follow_up_date,
 * outcome_summary and add_note. They carried identical copies of the same
 * condition, which is four places for a rule about who may write to a student's
 * record to drift apart.
 *
 * Returns the refusal SENTENCE rather than a bool, because the three reasons
 * are genuinely different and "No permission for this action." sent for all of
 * them is what makes a permission problem take an afternoon to diagnose. A
 * caller looking at somebody else's case, a faculty member looking at a P3
 * case, and a role with no grant at all should not read the same message.
 *
 * @param array $roleContext From require_case_access().
 * @param array $caseRow     From fetch_case_row(); needs `period` and
 *                           `assigned_to_user_id`.
 */
function case_intervention_allowed(array $roleContext, array $caseRow, int $sessionUserId): ?string {
    if (empty($roleContext['can_update_intervention'])) {
        return 'No permission for this action.';
    }

    // A caller owns the cases assigned to them and no others.
    if (!empty($roleContext['is_caller'])
        && (int)($caseRow['assigned_to_user_id'] ?? 0) !== $sessionUserId
    ) {
        return 'This case is assigned to somebody else.';
    }

    if (!empty($roleContext['is_limited_interventionist'])
        && !case_period_is_open_to_limited_intervention($caseRow['period'] ?? null)
    ) {
        return 'Your role can record interventions on P1 and P2 cases only. '
            . 'This case is outside that window, so it belongs to the retention team.';
    }

    return null;
}


/**
 * The slice of the board a limited interventionist is allowed to SEE.
 *
 * The window used to govern only the write. A faculty member opening the board
 * still got every case in their department -- the P3 ones, the whole-semester
 * ones -- and every control on those rows answered with a refusal sentence. A
 * list where most rows cannot be acted on is not a work queue, and a screenful
 * of refusals reads as broken rather than as a boundary. So the rule that
 * governs the write now governs the read too, and the two are written next to
 * each other so they cannot drift apart.
 *
 * The term half matters because a case carries a school year and a semester and
 * this board never filtered on either. "P1" with no term means this semester's
 * P1 stacked on last year's -- the same student twice, one row live and one row
 * history. It is dropped when the calendar cannot name a term: a filter that
 * cannot be answered should not silently empty the board.
 *
 * Returns SQL rather than running any of it. The clauses ARE the scope, and
 * keeping them here puts them beside the write rule they mirror instead of a
 * hundred lines away inside a query builder.
 *
 * @param array|null $currentTerm From academic_calendar_current(), or null.
 * @return array|null Null when the role is not limited, meaning no scope.
 */
function case_limited_interventionist_scope(array $roleContext, ?array $currentTerm = null): ?array {
    if (empty($roleContext['is_limited_interventionist'])) {
        return null;
    }

    $periods = case_limited_intervention_periods();
    // Inlined rather than bound: these are integers this file owns, and a
    // placeholder list would have to be built and bound for a value no request
    // can influence.
    $where = ['rc.period IN (' . implode(', ', array_map('intval', $periods)) . ')'];
    $params = [];

    $schoolYearId = (int)($currentTerm['school_year_id'] ?? 0);
    $semesterId = (int)($currentTerm['semester_id'] ?? 0);
    if ($schoolYearId > 0 && $semesterId > 0) {
        $where[] = 'rc.school_year_id = :window_school_year_id';
        $where[] = 'rc.semester_id = :window_semester_id';
        $params[':window_school_year_id'] = $schoolYearId;
        $params[':window_semester_id'] = $semesterId;
    }

    return [
        'where' => $where,
        'params' => $params,
        'periods' => $periods,
        'school_year_id' => $schoolYearId ?: null,
        'semester_id' => $semesterId ?: null,
        'term_label' => $currentTerm['label'] ?? null,
        'semester_name' => $currentTerm['semester_name'] ?? null,
        'schoolyear_name' => $currentTerm['schoolyear_name'] ?? null,
    ];
}

}
