<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

/**
 * Reading and editing the rules that decide a grade's remark.
 *
 * The engine is in grade_remark_service.php; this is the way in. Two audiences,
 * which is why the GET returns more than a list:
 *
 *   The Settings panel needs the policies, their rules, and the vocabulary a
 *   rule may be written in -- field keys, operators, the remarks available --
 *   so the editor can offer choices instead of free text.
 *
 *   The Add Grade form needs the active rules so it can show which remark a row
 *   is heading for while somebody is still typing the counts. It evaluates them
 *   in the browser rather than asking per keystroke; the rules come from here,
 *   so the two answers cannot drift the way the old hardcoded pair did.
 *
 * Mutations are admin-only and audit-logged, the same shape risk_model.php uses.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/grade_remark_service.php';

function gremark_out(int $code, array $payload): void {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/** Every rule of every policy, so the editor can render without N requests. */
function gremark_all_policies(PDO $pdo): array {
    $policies = $pdo->query(
        'SELECT p.policy_id, p.policy_name, p.description, p.school_year_id, p.is_active,
                sy.schoolyear_name
           FROM grade_remark_policy p
           LEFT JOIN school_year sy ON sy.school_year_id = p.school_year_id
       ORDER BY (p.school_year_id IS NULL) DESC, sy.schoolyear_name ASC, p.policy_id ASC'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    foreach ($policies as $index => $policy) {
        $policyId = (int)$policy['policy_id'];
        $policies[$index]['policy_id'] = $policyId;
        $policies[$index]['is_active'] = (int)$policy['is_active'];
        $policies[$index]['school_year_id'] = $policy['school_year_id'] === null ? null : (int)$policy['school_year_id'];
        // Whether this policy may be edited travels WITH it rather than being
        // recomputed in the browser. The comparison that decides it is on the
        // year NAME, because school_year ids are insertion order -- 2022-2023
        // has a higher id than 2026-2027 -- and a UI that gets it wrong offers
        // an edit the server then refuses.
        $policies[$index]['is_editable'] = sy_window_policy_is_editable($pdo, $policies[$index]['school_year_id']) ? 1 : 0;

        // Every rule, active or not -- the editor has to show a rule that is
        // switched off, or there is no way to switch it back on.
        $stmt = $pdo->prepare(
            'SELECT r.rule_id, r.remark_id, r.label, r.sort_order, r.is_active,
                    rm.remark_name, rm.risk_level
               FROM grade_remark_rule r
               JOIN remarks rm ON rm.remark_id = r.remark_id
              WHERE r.policy_id = :policy
           ORDER BY r.sort_order ASC, r.rule_id ASC'
        );
        $stmt->execute([':policy' => $policyId]);
        $rules = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

        $conditions = $pdo->prepare(
            'SELECT condition_id, field_key, operator, value_min, value_max
               FROM grade_remark_condition WHERE rule_id = :rule ORDER BY condition_id ASC'
        );
        foreach ($rules as $ruleIndex => $rule) {
            $conditions->execute([':rule' => (int)$rule['rule_id']]);
            $rules[$ruleIndex]['rule_id'] = (int)$rule['rule_id'];
            $rules[$ruleIndex]['remark_id'] = (int)$rule['remark_id'];
            $rules[$ruleIndex]['sort_order'] = (int)$rule['sort_order'];
            $rules[$ruleIndex]['is_active'] = (int)$rule['is_active'];
            $rules[$ruleIndex]['conditions'] = $conditions->fetchAll(PDO::FETCH_ASSOC) ?: [];
        }

        $policies[$index]['rules'] = $rules;
    }

    return $policies;
}

/** A rule's conditions, replaced wholesale. Partial edits of a set are not a thing. */
function gremark_write_conditions(PDO $pdo, int $ruleId, array $conditions): void {
    $del = $pdo->prepare('DELETE FROM grade_remark_condition WHERE rule_id = :rule');
    $del->execute([':rule' => $ruleId]);

    $ins = $pdo->prepare(
        'INSERT INTO grade_remark_condition (rule_id, field_key, operator, value_min, value_max)
         VALUES (:rule, :field_key, :operator, :value_min, :value_max)'
    );

    foreach ($conditions as $condition) {
        $field = (string)($condition['field_key'] ?? '');
        $operator = (string)($condition['operator'] ?? 'gte');
        if (!in_array($field, grade_remark_field_keys(), true)) {
            gremark_out(400, ['message' => "Unknown field: $field"]);
        }
        if (!in_array($operator, grade_remark_operators(), true)) {
            gremark_out(400, ['message' => "Unknown operator: $operator"]);
        }

        $min = ($condition['value_min'] ?? '') === '' ? null : (float)$condition['value_min'];
        $max = ($condition['value_max'] ?? '') === '' ? null : (float)$condition['value_max'];
        $needsValue = $operator !== 'eq_total';
        if ($needsValue && $min === null) {
            gremark_out(400, ['message' => 'Every condition needs a value to compare against.']);
        }
        if ($operator === 'between' && $max === null) {
            gremark_out(400, ['message' => 'A "between" condition needs both a low and a high value.']);
        }

        $ins->execute([
            ':rule' => $ruleId,
            ':field_key' => $field,
            ':operator' => $operator,
            ':value_min' => $needsValue ? $min : null,
            ':value_max' => $operator === 'between' ? $max : null,
        ]);
    }
}

try {
    $pdo = (new Database())->connect();
    $authUser = api_get_session_user();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if (!grade_remark_tables_exist($pdo)) {
        gremark_out(503, ['message' => 'The grade remark policy tables are not installed yet.']);
    }

    parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
    $action = strtolower(trim((string)($query['action'] ?? '')));

    if ($method === 'GET') {
        /*
         * What a row would be remarked, without writing anything.
         *
         * The editor uses it to answer "show me what this policy does to a row
         * like this" before the rules are saved against three thousand records.
         */
        if ($action === 'preview') {
            $schoolYearId = isset($query['school_year_id']) && $query['school_year_id'] !== ''
                ? (int)$query['school_year_id'] : null;
            $row = [
                'total_subject' => (int)($query['total_subject'] ?? 0),
                'passed' => (int)($query['passed'] ?? 0),
                'failed' => (int)($query['failed'] ?? 0),
                'incomplete' => (int)($query['incomplete'] ?? 0),
                'no_credit' => (int)($query['no_credit'] ?? 0),
                'no_grade' => (int)($query['no_grade'] ?? 0),
            ];

            $policy = grade_remark_get_policy($pdo, $schoolYearId);
            $remarkId = $policy ? grade_remark_evaluate($row, $policy['rules']) : null;

            $name = null;
            if ($remarkId !== null) {
                $stmt = $pdo->prepare('SELECT remark_name FROM remarks WHERE remark_id = :id');
                $stmt->execute([':id' => $remarkId]);
                $name = $stmt->fetchColumn() ?: null;
            }

            gremark_out(200, ['data' => [
                'signals' => grade_remark_signals($row),
                'remark_id' => $remarkId,
                'remark_name' => $name,
                'policy_name' => $policy['policy_name'] ?? null,
                'year_is_open' => grade_remark_year_is_open($pdo, $schoolYearId),
            ]]);
        }

        $current = grade_remark_current_school_year($pdo);
        gremark_out(200, ['data' => [
            'policies' => gremark_all_policies($pdo),
            /*
             * Only remarks meant for grades, plus the unclassified ones.
             *
             * Guarded on the column existing so this endpoint still answers on a
             * database where the attendance migration has not been applied --
             * the panel it feeds is older than that column and must not start
             * 500ing because a migration is pending.
             */
            'remarks' => $pdo->query(
                (api_table_exists($pdo, 'remarks')
                 && $pdo->query("SHOW COLUMNS FROM `remarks` LIKE 'applies_to'")->fetchAll())
                    ? "SELECT remark_id, remark_name, risk_level, applies_to FROM remarks
                        WHERE archived_at IS NULL AND applies_to IN ('any', 'grades') ORDER BY remark_name"
                    : "SELECT remark_id, remark_name, risk_level, 'any' AS applies_to FROM remarks
                        WHERE archived_at IS NULL ORDER BY remark_name"
            )->fetchAll(PDO::FETCH_ASSOC) ?: [],
            // Carries is_open per year, from the same helper the attendance
            // screen reads. Two lists computed two ways is how one screen ends
            // up calling a year frozen while the other offers to edit it.
            'school_years' => sy_window_years($pdo),
            'current_school_year' => $current,
            'field_keys' => grade_remark_field_keys(),
            'operators' => grade_remark_operators(),
        ]]);
    }

    // Everything past here writes.
    if (!api_session_user_has_role($authUser, ['admin'])) {
        gremark_out(403, ['message' => 'Only an administrator can change grade remark policy.']);
    }

    $body = json_decode(file_get_contents('php://input'), true);
    if (!is_array($body)) $body = [];

    if ($method === 'POST' && $action === 'policy') {
        $name = trim((string)($body['policy_name'] ?? ''));
        if ($name === '') gremark_out(400, ['message' => 'Give the policy a name.']);

        $schoolYearId = ($body['school_year_id'] ?? '') === '' ? null : (int)$body['school_year_id'];
        /*
         * A policy may not be pinned to a year that has already finished.
         *
         * Allowing it would be an editor that appears to work and changes
         * nothing: grade_remark_for_term refuses closed years outright, so the
         * policy would sit there looking authoritative and never once be applied.
         */
        if ($schoolYearId !== null && !grade_remark_year_is_open($pdo, $schoolYearId)) {
            gremark_out(400, [
                'message' => 'That school year has already finished. A policy can only be set for the current year or a later one.',
            ]);
        }

        /*
         * Resolved BEFORE the insert, which is the whole trick.
         *
         * Asking afterwards returns the policy just created: it is active and
         * pinned to this very year, so it is the most specific match and beats
         * the one being copied from. The guard below then correctly declines to
         * clone a policy onto itself and the new policy is left empty -- which
         * is exactly what happened the first time, silently, because an empty
         * policy is a perfectly valid thing for the API to return.
         */
        $source = grade_remark_get_policy($pdo, $schoolYearId);

        $ins = $pdo->prepare(
            'INSERT INTO grade_remark_policy (policy_name, description, school_year_id, is_active, created_by_user_id)
             VALUES (:name, :description, :sy, :active, :user)'
        );
        $ins->execute([
            ':name' => $name,
            ':description' => trim((string)($body['description'] ?? '')) ?: null,
            ':sy' => $schoolYearId,
            ':active' => !empty($body['is_active']) ? 1 : 0,
            ':user' => $authUser['user_id'] ?? null,
        ]);
        $policyId = (int)$pdo->lastInsertId();

        /*
         * A new policy starts as a copy of the one currently governing that year.
         *
         * Writing next year's policy from an empty rule list means the first save
         * produces a policy that remarks nothing, and the year it governs silently
         * stops getting remarks at all. Copying gives an administrator something
         * to edit, which is what "new policy, new targets" actually looks like.
         */
        if ($source && (int)$source['policy_id'] !== $policyId) {
            $insRule = $pdo->prepare(
                'INSERT INTO grade_remark_rule (policy_id, remark_id, label, sort_order, is_active)
                 VALUES (:policy, :remark, :label, :sort, 1)'
            );
            foreach ($source['rules'] as $rule) {
                $insRule->execute([
                    ':policy' => $policyId,
                    ':remark' => (int)$rule['remark_id'],
                    ':label' => (string)$rule['label'],
                    ':sort' => (int)$rule['sort_order'],
                ]);
                gremark_write_conditions($pdo, (int)$pdo->lastInsertId(), $rule['conditions'] ?? []);
            }
        }

        api_write_audit_log($pdo, $authUser, 'grade_remark_policy_created', "Created grade remark policy \"$name\"", [
            'policy_id' => $policyId,
            'school_year_id' => $schoolYearId,
        ]);
        gremark_out(201, ['message' => 'Policy created', 'data' => ['policy_id' => $policyId]]);
    }

    if ($method === 'PUT' && $action === 'policy') {
        $policyId = (int)($body['policy_id'] ?? 0);
        if ($policyId <= 0) gremark_out(400, ['message' => 'Which policy?']);

        $fields = [];
        $params = [':id' => $policyId];
        foreach (['policy_name' => 'policy_name', 'description' => 'description'] as $key => $column) {
            if (array_key_exists($key, $body)) {
                $fields[] = "$column = :$column";
                $params[":$column"] = trim((string)$body[$key]) ?: null;
            }
        }
        if (array_key_exists('is_active', $body)) {
            $fields[] = 'is_active = :is_active';
            $params[':is_active'] = !empty($body['is_active']) ? 1 : 0;
        }
        if (!$fields) gremark_out(200, ['message' => 'No changes']);

        $upd = $pdo->prepare('UPDATE grade_remark_policy SET ' . implode(', ', $fields) . ' WHERE policy_id = :id');
        $upd->execute($params);

        api_write_audit_log($pdo, $authUser, 'grade_remark_policy_updated', 'Updated a grade remark policy', [
            'policy_id' => $policyId,
            'changed' => array_keys($body),
        ]);
        gremark_out(200, ['message' => 'Policy updated']);
    }

    if (($method === 'POST' || $method === 'PUT') && $action === 'rule') {
        $policyId = (int)($body['policy_id'] ?? 0);
        $remarkId = (int)($body['remark_id'] ?? 0);
        $label = trim((string)($body['label'] ?? ''));
        $sortOrder = (int)($body['sort_order'] ?? 0);
        $isActive = array_key_exists('is_active', $body) ? (!empty($body['is_active']) ? 1 : 0) : 1;
        $conditions = is_array($body['conditions'] ?? null) ? $body['conditions'] : [];

        if ($remarkId <= 0) gremark_out(400, ['message' => 'Choose the remark this rule assigns.']);
        if ($label === '') gremark_out(400, ['message' => 'Give the rule a short description.']);

        $pdo->beginTransaction();
        try {
            if ($method === 'POST') {
                if ($policyId <= 0) gremark_out(400, ['message' => 'Which policy?']);
                $ins = $pdo->prepare(
                    'INSERT INTO grade_remark_rule (policy_id, remark_id, label, sort_order, is_active)
                     VALUES (:policy, :remark, :label, :sort, :active)'
                );
                $ins->execute([
                    ':policy' => $policyId, ':remark' => $remarkId, ':label' => $label,
                    ':sort' => $sortOrder, ':active' => $isActive,
                ]);
                $ruleId = (int)$pdo->lastInsertId();
            } else {
                $ruleId = (int)($body['rule_id'] ?? 0);
                if ($ruleId <= 0) gremark_out(400, ['message' => 'Which rule?']);
                $upd = $pdo->prepare(
                    'UPDATE grade_remark_rule
                        SET remark_id = :remark, label = :label, sort_order = :sort, is_active = :active
                      WHERE rule_id = :id'
                );
                $upd->execute([
                    ':remark' => $remarkId, ':label' => $label, ':sort' => $sortOrder,
                    ':active' => $isActive, ':id' => $ruleId,
                ]);
            }

            gremark_write_conditions($pdo, $ruleId, $conditions);
            $pdo->commit();
        } catch (Throwable $e) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $e;
        }

        api_write_audit_log(
            $pdo,
            $authUser,
            $method === 'POST' ? 'grade_remark_rule_created' : 'grade_remark_rule_updated',
            ($method === 'POST' ? 'Added' : 'Updated') . " grade remark rule \"$label\"",
            ['rule_id' => $ruleId, 'policy_id' => $policyId, 'conditions' => count($conditions)]
        );
        gremark_out($method === 'POST' ? 201 : 200, ['message' => 'Rule saved', 'data' => ['rule_id' => $ruleId]]);
    }

    if ($method === 'DELETE' && $action === 'rule') {
        $ruleId = (int)($query['rule_id'] ?? 0);
        if ($ruleId <= 0) gremark_out(400, ['message' => 'Which rule?']);

        $stmt = $pdo->prepare('SELECT label FROM grade_remark_rule WHERE rule_id = :id');
        $stmt->execute([':id' => $ruleId]);
        $label = $stmt->fetchColumn();
        if ($label === false) gremark_out(404, ['message' => 'That rule no longer exists.']);

        // Conditions go with it: the FK cascades.
        $del = $pdo->prepare('DELETE FROM grade_remark_rule WHERE rule_id = :id');
        $del->execute([':id' => $ruleId]);

        api_write_audit_log($pdo, $authUser, 'grade_remark_rule_deleted', "Removed grade remark rule \"$label\"", [
            'rule_id' => $ruleId,
        ]);
        gremark_out(200, ['message' => 'Rule removed']);
    }

    gremark_out(400, ['message' => 'Unsupported request.']);
} catch (Throwable $e) {
    gremark_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
