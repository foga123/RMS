<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

/**
 * Reading and editing the attendance target and the rules that read it.
 *
 * The engine is attendance_remark_service.php; this is the way in, and it is
 * the twin of grade_remark_policy.php on purpose -- same actions, same request
 * shapes, same error wording -- because the two screens sit next to each other
 * in Remarks Management and a person moving between them should not have to
 * learn a second set of habits.
 *
 * The one thing this endpoint has that the grade one does not is SCOPE. A grade
 * policy is pinned to a school year and nothing finer. An attendance policy is
 * pinned to a school year, optionally a semester, and optionally a period,
 * because a fifteen-meeting periodical and a fifty-meeting semester cannot
 * share an absence count and pretending otherwise is what the hardcoded 75 in
 * attendanceReportMetrics.js was doing.
 *
 * ---------------------------------------------------------------------------
 * WHO MAY WRITE
 *
 * Deliberately NOT a hardcoded `is admin` check, which is what
 * grade_remark_policy.php does. The middleware already gates this file on
 * remarks:edit or settings:edit (see api_permission_module_action_overrides),
 * and repeating the decision here as a role name would quietly override any
 * later grant -- an institution that gives its registrar remarks:edit would
 * find the screen loads and every save returns 403, with the RBAC table
 * insisting they have permission.
 * ---------------------------------------------------------------------------
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/attendance_remark_service.php';

function aremark_out(int $code, array $payload): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/** A scope triple from a request body or query string, each part optional. */
function aremark_scope(array $source): array {
    $value = static function ($raw): ?int {
        return ($raw === null || $raw === '') ? null : (int)$raw;
    };

    $period = $value($source['period'] ?? null);
    // Periods are 1-3. A 0 arriving from a "no period" select that stringifies
    // its empty value would otherwise be stored as a real period nothing matches.
    if ($period !== null && ($period < 1 || $period > 3)) {
        $period = null;
    }

    return [
        'school_year_id' => $value($source['school_year_id'] ?? null),
        'semester_id' => $value($source['semester_id'] ?? null),
        'period' => $period,
    ];
}

/** Every rule of every policy, so the editor can render without N requests. */
function aremark_all_policies(PDO $pdo): array {
    $policies = $pdo->query(
        'SELECT p.policy_id, p.policy_name, p.description, p.school_year_id, p.semester_id, p.period,
                p.target_max_absences, p.target_min_rate, p.is_active,
                sy.schoolyear_name, s.semester_name
           FROM attendance_remark_policy p
           LEFT JOIN school_year sy ON sy.school_year_id = p.school_year_id
           LEFT JOIN semester s ON s.semester_id = p.semester_id
       ORDER BY (p.school_year_id IS NULL) DESC, sy.schoolyear_name ASC,
                (p.semester_id IS NULL) DESC, s.semester_name ASC,
                (p.period IS NULL) DESC, p.period ASC, p.policy_id ASC'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Every rule, active or not. The editor has to show a rule that is switched
    // off, or there is no way to switch it back on.
    $ruleStmt = $pdo->prepare(
        'SELECT r.rule_id, r.remark_id, r.label, r.sort_order, r.is_active,
                rm.remark_name, rm.risk_level
           FROM attendance_remark_rule r
           JOIN remarks rm ON rm.remark_id = r.remark_id
          WHERE r.policy_id = :policy
       ORDER BY r.sort_order ASC, r.rule_id ASC'
    );
    $conditionStmt = $pdo->prepare(
        'SELECT condition_id, field_key, operator, value_min, value_max
           FROM attendance_remark_condition WHERE rule_id = :rule ORDER BY condition_id ASC'
    );

    foreach ($policies as $index => $policy) {
        $policyId = (int)$policy['policy_id'];
        $policies[$index]['policy_id'] = $policyId;
        $policies[$index]['is_active'] = (int)$policy['is_active'];
        $policies[$index]['school_year_id'] = $policy['school_year_id'] === null ? null : (int)$policy['school_year_id'];
        $policies[$index]['semester_id'] = $policy['semester_id'] === null ? null : (int)$policy['semester_id'];
        $policies[$index]['period'] = $policy['period'] === null ? null : (int)$policy['period'];
        $policies[$index]['target_max_absences'] = $policy['target_max_absences'] === null
            ? null : (int)$policy['target_max_absences'];
        $policies[$index]['target_min_rate'] = $policy['target_min_rate'] === null
            ? null : (float)$policy['target_min_rate'];

        // Whether this policy may be edited travels WITH it rather than being
        // recomputed in the browser. The comparison that decides it is on the
        // year NAME and is easy to get wrong -- see lib/school_year_window.php
        // -- and a UI that gets it wrong offers an edit the server then refuses.
        $yearOpen = sy_window_policy_is_editable($pdo, $policies[$index]['school_year_id']);
        // A closed semester that reads its attendance through this policy
        // freezes it too. The reason travels with it, because "that year has
        // finished" is the wrong sentence for a semester closed this year.
        $closedTerms = $yearOpen ? attendance_remark_closed_terms_affected($pdo, $policyId, null) : [];
        $policies[$index]['is_editable'] = $yearOpen && !$closedTerms ? 1 : 0;
        $policies[$index]['frozen_reason'] = $closedTerms
            ? $closedTerms[0]['label'] . ' is closed and reads its attendance through this target, so it cannot be changed. '
                . 'Reopen the semester in Settings > Close Semester to change it, or add a target for an open semester.'
            : null;

        $ruleStmt->execute([':policy' => $policyId]);
        $rules = $ruleStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        foreach ($rules as $ruleIndex => $rule) {
            $conditionStmt->execute([':rule' => (int)$rule['rule_id']]);
            $rules[$ruleIndex]['rule_id'] = (int)$rule['rule_id'];
            $rules[$ruleIndex]['remark_id'] = (int)$rule['remark_id'];
            $rules[$ruleIndex]['sort_order'] = (int)$rule['sort_order'];
            $rules[$ruleIndex]['is_active'] = (int)$rule['is_active'];
            $rules[$ruleIndex]['conditions'] = $conditionStmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
        }

        $policies[$index]['rules'] = $rules;
    }

    return $policies;
}

/** A rule's conditions, replaced wholesale. Partial edits of a set are not a thing. */
function aremark_write_conditions(PDO $pdo, int $ruleId, array $conditions): void {
    $del = $pdo->prepare('DELETE FROM attendance_remark_condition WHERE rule_id = :rule');
    $del->execute([':rule' => $ruleId]);

    $ins = $pdo->prepare(
        'INSERT INTO attendance_remark_condition (rule_id, field_key, operator, value_min, value_max)
         VALUES (:rule, :field_key, :operator, :value_min, :value_max)'
    );

    foreach ($conditions as $condition) {
        $field = (string)($condition['field_key'] ?? '');
        $operator = (string)($condition['operator'] ?? 'gte');
        if (!in_array($field, attendance_remark_field_keys(), true)) {
            aremark_out(400, ['message' => "Unknown field: $field"]);
        }
        if (!in_array($operator, attendance_remark_operators(), true)) {
            aremark_out(400, ['message' => "Unknown operator: $operator"]);
        }

        $min = ($condition['value_min'] ?? '') === '' ? null : (float)$condition['value_min'];
        $max = ($condition['value_max'] ?? '') === '' ? null : (float)$condition['value_max'];
        if ($min === null) {
            aremark_out(400, ['message' => 'Every condition needs a value to compare against.']);
        }
        if ($operator === 'between' && $max === null) {
            aremark_out(400, ['message' => 'A "between" condition needs both a low and a high value.']);
        }

        $ins->execute([
            ':rule' => $ruleId,
            ':field_key' => $field,
            ':operator' => $operator,
            ':value_min' => $min,
            ':value_max' => $operator === 'between' ? $max : null,
        ]);
    }
}

/**
 * The policy a write is aimed at, refused when its year is frozen.
 *
 * Every write path goes through this rather than each checking for itself. The
 * failure it prevents is invisible: a back-dated edit produces rows that look
 * exactly like correct ones, and nobody discovers it until a report disagrees
 * with a printout from March.
 */
function aremark_require_editable_policy(PDO $pdo, int $policyId): array {
    $stmt = $pdo->prepare(
        'SELECT p.policy_id, p.policy_name, p.school_year_id, sy.schoolyear_name
           FROM attendance_remark_policy p
           LEFT JOIN school_year sy ON sy.school_year_id = p.school_year_id
          WHERE p.policy_id = :id LIMIT 1'
    );
    $stmt->execute([':id' => $policyId]);
    $policy = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$policy) {
        aremark_out(404, ['message' => 'That policy no longer exists.']);
    }

    $schoolYearId = $policy['school_year_id'] === null ? null : (int)$policy['school_year_id'];
    if (!sy_window_policy_is_editable($pdo, $schoolYearId)) {
        aremark_out(409, [
            'message' => sprintf(
                '%s has already finished. Its records keep the target they were judged against, so this policy is read-only.',
                $policy['schoolyear_name'] ?: 'That school year'
            ),
        ]);
    }

    return $policy;
}

/**
 * Refuses a write to a policy that a closed semester reads its attendance
 * through. For the rule writes, every one of which changes what the policy
 * says; a policy edit makes a finer test of its own, since a rename changes
 * nothing a remark reads.
 */
function aremark_refuse_if_closed_term_reads_through(PDO $pdo, int $policyId): void {
    $affected = attendance_remark_closed_terms_affected($pdo, $policyId, null);
    if ($affected) {
        aremark_out(TERM_CLOSURE_HTTP_STATUS, attendance_remark_closed_term_refusal($affected[0]));
    }
}

try {
    $pdo = (new Database())->connect();
    $authUser = api_get_session_user();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if (!attendance_remark_tables_exist($pdo)) {
        aremark_out(503, ['message' => 'The attendance policy tables are not installed yet.']);
    }

    parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
    $action = strtolower(trim((string)($query['action'] ?? '')));

    if ($method === 'GET') {
        /*
         * What a row would be called, without writing anything.
         *
         * The editor uses it to answer "show me what this target does to a
         * student like this" before it is applied to a thousand records. It
         * resolves the policy by SCOPE, so switching the period in the preview
         * shows the periodical's target rather than the semester's -- which is
         * the whole point of the scope existing.
         */
        if ($action === 'preview') {
            $scope = aremark_scope($query);
            $row = [
                'total_classes_conducted' => (int)($query['total_classes_conducted'] ?? 0),
                'present' => (int)($query['present'] ?? 0),
                'absent' => (int)($query['absent'] ?? 0),
            ];

            $described = attendance_remark_describe(
                $pdo, $row, $scope['school_year_id'], $scope['semester_id'], $scope['period']
            );

            $name = null;
            if ($described['remark_id'] !== null) {
                $stmt = $pdo->prepare('SELECT remark_name FROM remarks WHERE remark_id = :id');
                $stmt->execute([':id' => $described['remark_id']]);
                $name = $stmt->fetchColumn() ?: null;
            }

            aremark_out(200, ['data' => $described + ['remark_name' => $name]]);
        }

        /*
         * `applies_to` filters the remark list to the ones meant for attendance
         * plus the unclassified ones. Offering "With Failed Mark" as the answer
         * to an absence rule is offering nonsense, and the shortest way to stop
         * somebody choosing it is not to list it.
         */
        $remarksHaveKind = api_table_exists($pdo, 'remarks')
            && $pdo->query("SHOW COLUMNS FROM `remarks` LIKE 'applies_to'")->fetchAll();
        $remarkSql = $remarksHaveKind
            ? "SELECT remark_id, remark_name, risk_level, applies_to FROM remarks
                WHERE archived_at IS NULL AND applies_to IN ('any', 'attendance') ORDER BY remark_name"
            : "SELECT remark_id, remark_name, risk_level, 'any' AS applies_to FROM remarks
                WHERE archived_at IS NULL ORDER BY remark_name";

        aremark_out(200, ['data' => [
            'policies' => aremark_all_policies($pdo),
            'remarks' => $pdo->query($remarkSql)->fetchAll(PDO::FETCH_ASSOC) ?: [],
            'school_years' => sy_window_years($pdo),
            'semesters' => $pdo->query(
                'SELECT semester_id, semester_name FROM semester ORDER BY semester_id'
            )->fetchAll(PDO::FETCH_ASSOC) ?: [],
            'current_school_year' => sy_window_current($pdo),
            'field_keys' => attendance_remark_field_keys(),
            'operators' => attendance_remark_operators(),
        ]]);
    }

    // Everything past here writes. The middleware has already decided whether
    // this caller may -- see the file docblock for why that is not repeated as
    // a role check here.
    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = [];

    if ($method === 'POST' && $action === 'policy') {
        $name = trim((string)($body['policy_name'] ?? ''));
        if ($name === '') aremark_out(400, ['message' => 'Give the policy a name.']);

        $scope = aremark_scope($body);

        /*
         * A policy may not be written for a year that has already finished.
         *
         * Allowing it would be an editor that appears to work and protects
         * nothing: the records it claims to govern were judged against whatever
         * was in force at the time, and this row would sit there looking
         * authoritative while disagreeing with every printout of that term.
         */
        if (!sy_window_policy_is_editable($pdo, $scope['school_year_id'])) {
            aremark_out(400, [
                'message' => 'That school year has already finished. A target can only be set for the current year or a later one.',
            ]);
        }

        // Nor may a new policy take over a closed semester's reading - it would
        // be the most specific match there the moment it was saved.
        $affected = attendance_remark_closed_terms_affected(
            $pdo,
            null,
            $scope + ['is_active' => !empty($body['is_active']) ? 1 : 0, 'policy_id' => null]
        );
        if ($affected) {
            aremark_out(TERM_CLOSURE_HTTP_STATUS, attendance_remark_closed_term_refusal($affected[0]));
        }

        /*
         * Resolved BEFORE the insert.
         *
         * Asking afterwards returns the policy just created -- it is active and
         * is the most specific match for its own scope, so it beats the one
         * being copied from, the guard below declines to clone it onto itself,
         * and the new policy is left with no rules at all. An empty policy is a
         * perfectly valid thing to store, so nothing would report the mistake;
         * the term would just quietly stop getting attendance remarks.
         */
        $source = attendance_remark_get_policy(
            $pdo, $scope['school_year_id'], $scope['semester_id'], $scope['period']
        );

        $ins = $pdo->prepare(
            'INSERT INTO attendance_remark_policy
                    (policy_name, description, school_year_id, semester_id, period,
                     target_max_absences, target_min_rate, is_active, created_by_user_id)
             VALUES (:name, :description, :sy, :sem, :period, :max_absences, :min_rate, :active, :user)'
        );
        $ins->execute([
            ':name' => $name,
            ':description' => trim((string)($body['description'] ?? '')) ?: null,
            ':sy' => $scope['school_year_id'],
            ':sem' => $scope['semester_id'],
            ':period' => $scope['period'],
            ':max_absences' => ($body['target_max_absences'] ?? '') === '' ? null : (int)$body['target_max_absences'],
            ':min_rate' => ($body['target_min_rate'] ?? '') === '' ? null : (float)$body['target_min_rate'],
            ':active' => !empty($body['is_active']) ? 1 : 0,
            ':user' => $authUser['user_id'] ?? null,
        ]);
        $policyId = (int)$pdo->lastInsertId();

        // A new policy starts as a copy of whatever governs that scope today, so
        // there is something to edit rather than a policy that remarks nothing.
        if ($source && (int)$source['policy_id'] !== $policyId) {
            $insRule = $pdo->prepare(
                'INSERT INTO attendance_remark_rule (policy_id, remark_id, label, sort_order, is_active)
                 VALUES (:policy, :remark, :label, :sort, 1)'
            );
            foreach ($source['rules'] as $rule) {
                $insRule->execute([
                    ':policy' => $policyId,
                    ':remark' => (int)$rule['remark_id'],
                    ':label' => (string)$rule['label'],
                    ':sort' => (int)$rule['sort_order'],
                ]);
                aremark_write_conditions($pdo, (int)$pdo->lastInsertId(), $rule['conditions'] ?? []);
            }
        }

        api_write_audit_log(
            $pdo, $authUser, 'attendance_policy_created',
            "Created attendance policy \"$name\"",
            ['policy_id' => $policyId] + $scope
        );
        aremark_out(201, ['message' => 'Policy created', 'data' => ['policy_id' => $policyId]]);
    }

    if ($method === 'PUT' && $action === 'policy') {
        $policyId = (int)($body['policy_id'] ?? 0);
        if ($policyId <= 0) aremark_out(400, ['message' => 'Which policy?']);
        $existing = aremark_require_editable_policy($pdo, $policyId);

        $fields = [];
        $params = [':id' => $policyId];

        foreach (['policy_name' => 'policy_name', 'description' => 'description'] as $key => $column) {
            if (array_key_exists($key, $body)) {
                $fields[] = "$column = :$column";
                $params[":$column"] = trim((string)$body[$key]) ?: null;
            }
        }

        /*
         * The target. Empty string clears the column, which is how a policy is
         * moved from "at most 8 absences and at least 80%" to one of the two --
         * distinguishable from "not supplied" only because array_key_exists is
         * asked rather than isset, since isset() is false for a null the caller
         * sent deliberately.
         */
        if (array_key_exists('target_max_absences', $body)) {
            $fields[] = 'target_max_absences = :target_max_absences';
            $raw = $body['target_max_absences'];
            $params[':target_max_absences'] = ($raw === '' || $raw === null) ? null : max(0, (int)$raw);
        }
        if (array_key_exists('target_min_rate', $body)) {
            $fields[] = 'target_min_rate = :target_min_rate';
            $raw = $body['target_min_rate'];
            $params[':target_min_rate'] = ($raw === '' || $raw === null) ? null : min(100.0, max(0.0, (float)$raw));
        }
        if (array_key_exists('is_active', $body)) {
            $fields[] = 'is_active = :is_active';
            $params[':is_active'] = !empty($body['is_active']) ? 1 : 0;
        }

        if (!$fields) aremark_out(200, ['message' => 'No changes']);

        /*
         * A closed semester reading through this policy freezes what it says -
         * the target, and whether it is on at all. The name and description are
         * the editor's own words and change nothing a remark reads, so a rename
         * still goes through. Compared as values: the editor sends every field
         * on each save, changed or not.
         */
        $stored = $pdo->prepare(
            'SELECT school_year_id, semester_id, period, target_max_absences, target_min_rate, is_active
               FROM attendance_remark_policy WHERE policy_id = :id'
        );
        $stored->execute([':id' => $policyId]);
        $storedRow = $stored->fetch(PDO::FETCH_ASSOC) ?: [];
        $readingBefore = [
            'target_max_absences' => ($storedRow['target_max_absences'] ?? null) === null ? null : (int)$storedRow['target_max_absences'],
            'target_min_rate' => ($storedRow['target_min_rate'] ?? null) === null ? null : (float)$storedRow['target_min_rate'],
            'is_active' => (int)($storedRow['is_active'] ?? 0),
        ];
        $readingAfter = [
            'target_max_absences' => array_key_exists(':target_max_absences', $params)
                ? $params[':target_max_absences'] : $readingBefore['target_max_absences'],
            'target_min_rate' => array_key_exists(':target_min_rate', $params)
                ? ($params[':target_min_rate'] === null ? null : (float)$params[':target_min_rate'])
                : $readingBefore['target_min_rate'],
            'is_active' => array_key_exists(':is_active', $params) ? (int)$params[':is_active'] : $readingBefore['is_active'],
        ];
        if ($readingAfter !== $readingBefore) {
            // Switching a policy on can also make it take over a closed term
            // it does not govern today.
            $candidate = $readingAfter['is_active'] ? [
                'policy_id' => $policyId,
                'school_year_id' => term_closure_id($storedRow['school_year_id'] ?? null),
                'semester_id' => term_closure_id($storedRow['semester_id'] ?? null),
                'period' => term_closure_id($storedRow['period'] ?? null),
                'is_active' => 1,
            ] : null;
            $affected = attendance_remark_closed_terms_affected($pdo, $policyId, $candidate);
            if ($affected) {
                aremark_out(TERM_CLOSURE_HTTP_STATUS, attendance_remark_closed_term_refusal($affected[0]));
            }
        }

        $upd = $pdo->prepare('UPDATE attendance_remark_policy SET ' . implode(', ', $fields) . ' WHERE policy_id = :id');
        $upd->execute($params);

        api_write_audit_log(
            $pdo, $authUser, 'attendance_policy_updated',
            'Updated attendance policy "' . $existing['policy_name'] . '"',
            ['policy_id' => $policyId, 'changed' => array_keys($body)]
        );
        aremark_out(200, ['message' => 'Policy updated']);
    }

    if (($method === 'POST' || $method === 'PUT') && $action === 'rule') {
        $policyId = (int)($body['policy_id'] ?? 0);
        $remarkId = (int)($body['remark_id'] ?? 0);
        $label = trim((string)($body['label'] ?? ''));
        $sortOrder = (int)($body['sort_order'] ?? 0);
        $isActive = array_key_exists('is_active', $body) ? (!empty($body['is_active']) ? 1 : 0) : 1;
        $conditions = is_array($body['conditions'] ?? null) ? $body['conditions'] : [];

        if ($policyId <= 0) aremark_out(400, ['message' => 'Which policy?']);
        if ($remarkId <= 0) aremark_out(400, ['message' => 'Choose the remark this rule assigns.']);
        if ($label === '') aremark_out(400, ['message' => 'Give the rule a short description.']);
        aremark_require_editable_policy($pdo, $policyId);
        aremark_refuse_if_closed_term_reads_through($pdo, $policyId);

        $pdo->beginTransaction();
        try {
            if ($method === 'POST') {
                $ins = $pdo->prepare(
                    'INSERT INTO attendance_remark_rule (policy_id, remark_id, label, sort_order, is_active)
                     VALUES (:policy, :remark, :label, :sort, :active)'
                );
                $ins->execute([
                    ':policy' => $policyId, ':remark' => $remarkId, ':label' => $label,
                    ':sort' => $sortOrder, ':active' => $isActive,
                ]);
                $ruleId = (int)$pdo->lastInsertId();
            } else {
                $ruleId = (int)($body['rule_id'] ?? 0);
                if ($ruleId <= 0) aremark_out(400, ['message' => 'Which rule?']);
                $upd = $pdo->prepare(
                    'UPDATE attendance_remark_rule
                        SET remark_id = :remark, label = :label, sort_order = :sort, is_active = :active
                      WHERE rule_id = :id AND policy_id = :policy'
                );
                $upd->execute([
                    ':remark' => $remarkId, ':label' => $label, ':sort' => $sortOrder,
                    ':active' => $isActive, ':id' => $ruleId, ':policy' => $policyId,
                ]);
            }

            aremark_write_conditions($pdo, $ruleId, $conditions);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }

        // Audited AFTER the commit. api_write_audit_log can run DDL the first
        // time it is called, and DDL inside a transaction commits it implicitly
        // -- which made the equivalent call in risk_model.php throw on commit()
        // and throw again on rollBack(). Same trap, same distance from it.
        api_write_audit_log(
            $pdo, $authUser,
            $method === 'POST' ? 'attendance_rule_created' : 'attendance_rule_updated',
            ($method === 'POST' ? 'Added' : 'Updated') . " attendance rule \"$label\"",
            ['rule_id' => $ruleId, 'policy_id' => $policyId, 'conditions' => count($conditions)]
        );
        aremark_out($method === 'POST' ? 201 : 200, ['message' => 'Rule saved', 'data' => ['rule_id' => $ruleId]]);
    }

    if ($method === 'DELETE' && $action === 'rule') {
        $ruleId = (int)($query['rule_id'] ?? 0);
        if ($ruleId <= 0) aremark_out(400, ['message' => 'Which rule?']);

        $stmt = $pdo->prepare('SELECT label, policy_id FROM attendance_remark_rule WHERE rule_id = :id');
        $stmt->execute([':id' => $ruleId]);
        $rule = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$rule) aremark_out(404, ['message' => 'That rule no longer exists.']);
        aremark_require_editable_policy($pdo, (int)$rule['policy_id']);
        aremark_refuse_if_closed_term_reads_through($pdo, (int)$rule['policy_id']);

        // Conditions go with it: the FK cascades.
        $del = $pdo->prepare('DELETE FROM attendance_remark_rule WHERE rule_id = :id');
        $del->execute([':id' => $ruleId]);

        api_write_audit_log(
            $pdo, $authUser, 'attendance_rule_deleted',
            'Removed attendance rule "' . $rule['label'] . '"',
            ['rule_id' => $ruleId, 'policy_id' => (int)$rule['policy_id']]
        );
        aremark_out(200, ['message' => 'Rule removed']);
    }

    aremark_out(400, ['message' => 'Unsupported request.']);
} catch (Throwable $e) {
    aremark_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
