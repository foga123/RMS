<?php
/**
 * Read and edit the retention risk model.
 *
 * This is the endpoint that makes the scoring configurable: categories,
 * keywords, indicator rules and level thresholds are all data, so tuning what
 * the institution treats as "at risk" never requires a code change.
 *
 * GET  ?action=config        the full model (categories, indicators, keywords)
 *      ?action=signals       the signal vocabulary a rule may reference
 *      ?action=preview&student_id=&semester_id=&school_year_id=
 *                            score one student without writing a case — lets an
 *                            admin see the effect of a weight before saving it
 * PUT  ?action=model&id=     rename / retune thresholds / activate
 *      ?action=indicator&id= update one rule
 * POST ?action=indicator     add a rule
 *      ?action=activate&id=  make a model the active one
 * DELETE ?action=indicator&id=
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/risk_model_service.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

const RISK_SOURCES   = ['grades', 'finance', 'attendance', 'survey', 'student'];
const RISK_OPERATORS = ['gte', 'gt', 'lte', 'lt', 'eq', 'neq', 'between', 'missing', 'present'];

/**
 * The signal keys a rule may address, published so the configuration UI can
 * offer a dropdown instead of a free-text field that silently never matches.
 */
function risk_signal_vocabulary(): array
{
    return [
        'grades' => [
            ['field_key' => 'remark_risk',   'label' => 'Grade remark risk level', 'type' => 'text',   'values' => ['low', 'moderate', 'high']],
            ['field_key' => 'failed',        'label' => 'Failed subjects',         'type' => 'number'],
            ['field_key' => 'incomplete',    'label' => 'Incomplete subjects',     'type' => 'number'],
            ['field_key' => 'no_credit',     'label' => 'No-credit subjects',      'type' => 'number'],
            ['field_key' => 'no_grade',      'label' => 'No-grade subjects',       'type' => 'number'],
            ['field_key' => 'total_subject', 'label' => 'Total subjects',          'type' => 'number'],
            ['field_key' => 'passed',        'label' => 'Passed subjects',         'type' => 'number'],
            ['field_key' => 'pass_rate',     'label' => 'Pass rate (%)',           'type' => 'number'],
            ['field_key' => 'record',        'label' => 'Has a grade record',      'type' => 'presence'],
        ],
        'finance' => [
            ['field_key' => 'balance_amount',    'label' => 'Outstanding balance (PHP)', 'type' => 'number'],
            ['field_key' => 'balance_tier',      'label' => 'Balance tier (status id)',  'type' => 'number'],
            ['field_key' => 'balance_unchanged', 'label' => 'Balance not paid down',     'type' => 'number', 'values' => [0, 1]],
            ['field_key' => 'record',            'label' => 'Has a finance record',      'type' => 'presence'],
        ],
        'attendance' => [
            ['field_key' => 'absent_rate',             'label' => 'Absent rate (%)',    'type' => 'number'],
            ['field_key' => 'present_rate',            'label' => 'Present rate (%)',   'type' => 'number'],
            ['field_key' => 'absent',                  'label' => 'Classes missed',     'type' => 'number'],
            ['field_key' => 'present',                 'label' => 'Classes attended',   'type' => 'number'],
            ['field_key' => 'total_classes_conducted', 'label' => 'Classes conducted',  'type' => 'number'],
            ['field_key' => 'record',                  'label' => 'Has an attendance record', 'type' => 'presence'],
        ],
        'survey' => [
            ['field_key' => 'submission', 'label' => 'Submitted a survey this term', 'type' => 'presence'],
            // survey.<category_code> keys are generated per active category.
        ],
    ];
}

function risk_survey_signal_keys(PDO $pdo): array
{
    $rows = $pdo->query(
        "SELECT category_code, category_name FROM risk_category WHERE is_active = 1 ORDER BY sort_order"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    return array_map(static function (array $row): array {
        return [
            'field_key' => 'survey.' . $row['category_code'],
            'label'     => 'Survey score: ' . $row['category_name'],
            'type'      => 'number',
        ];
    }, $rows);
}

function risk_require_value($value, string $field)
{
    if ($value === null || $value === '') {
        api_json_response(400, ['message' => "$field is required"]);
    }
    return $value;
}

function risk_load_full_config(PDO $pdo): array
{
    $models = $pdo->query(
        "SELECT model_id, model_name, description, school_year_id, semester_id,
                moderate_threshold, high_threshold, is_active, created_at, updated_at
           FROM risk_model ORDER BY is_active DESC, model_id DESC"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $categories = $pdo->query(
        "SELECT category_id, category_code, category_name, description, sort_order, is_active
           FROM risk_category WHERE archived_at IS NULL ORDER BY sort_order, category_id"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $indicators = $pdo->query(
        "SELECT i.indicator_id, i.model_id, i.category_id, c.category_code, c.category_name,
                i.label, i.source, i.field_key, i.operator, i.value_min, i.value_max,
                i.value_text, i.points, i.reason_template, i.is_active, i.sort_order
           FROM risk_indicator i
           JOIN risk_category c ON c.category_id = i.category_id
       ORDER BY i.model_id, i.sort_order, i.indicator_id"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $keywords = $pdo->query(
        "SELECT k.keyword_id, k.category_id, c.category_code, k.keyword, k.points, k.is_active
           FROM risk_keyword k
           JOIN risk_category c ON c.category_id = k.category_id
       ORDER BY c.sort_order, k.keyword"
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Max attainable score per model, so the UI can show whether a threshold is
    // even reachable — a "high" cutoff above the ceiling silently disables the
    // level entirely, which is invisible without this.
    $ceilings = [];
    foreach ($indicators as $row) {
        if ((int)$row['is_active'] !== 1) {
            continue;
        }
        $mid = (int)$row['model_id'];
        $ceilings[$mid] = ($ceilings[$mid] ?? 0) + (float)$row['points'];
    }

    foreach ($models as &$model) {
        $mid = (int)$model['model_id'];
        $model['model_id']           = $mid;
        $model['is_active']          = (bool)$model['is_active'];
        $model['moderate_threshold'] = (float)$model['moderate_threshold'];
        $model['high_threshold']     = (float)$model['high_threshold'];
        $model['max_possible_score'] = round($ceilings[$mid] ?? 0, 2);
        $model['high_threshold_reachable'] =
            $model['high_threshold'] <= ($ceilings[$mid] ?? 0);
    }
    unset($model);

    return [
        'models'     => $models,
        'categories' => $categories,
        'indicators' => $indicators,
        'keywords'   => $keywords,
        'sources'    => RISK_SOURCES,
        'operators'  => RISK_OPERATORS,
    ];
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $action = isset($_GET['action']) ? trim((string)$_GET['action']) : '';
    $id     = isset($_GET['id']) ? (int)$_GET['id'] : 0;

    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();

    if (!risk_model_tables_exist($pdo)) {
        api_json_response(503, [
            'message' => 'The risk model tables are not installed. Run frontend/sql/2026-07-28_risk_model.sql.',
        ]);
    }

    // ---------------------------------------------------------------- GET ---
    if ($method === 'GET') {
        if ($action === 'signals') {
            $vocab = risk_signal_vocabulary();
            $vocab['survey'] = array_merge($vocab['survey'], risk_survey_signal_keys($pdo));
            api_json_response(200, ['message' => 'Signal vocabulary loaded.', 'signals' => $vocab]);
        }

        if ($action === 'preview') {
            $studentId    = isset($_GET['student_id']) ? (int)$_GET['student_id'] : 0;
            $semesterId   = isset($_GET['semester_id']) && $_GET['semester_id'] !== '' ? (int)$_GET['semester_id'] : null;
            $schoolYearId = isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '' ? (int)$_GET['school_year_id'] : null;
            /*
             * The periodical to preview against, so "what would this model say
             * about this student" is answered on the same slice the evaluation
             * run would use. Without it an admin tuning thresholds during P1
             * reads semester-summed absences while the run scores P1's, and the
             * two disagree about the student in front of them.
             *
             * Ignored when unparseable rather than refused - a preview is a read.
             */
            $period = api_normalize_period($_GET['period'] ?? null);
            if ($period === false) {
                $period = null;
            }
            if ($studentId <= 0) {
                api_json_response(400, ['message' => 'student_id is required']);
            }

            $model = $id > 0
                ? (function (PDO $pdo, int $id): ?array {
                    $stmt = $pdo->prepare(
                        "SELECT model_id, model_name, moderate_threshold, high_threshold
                           FROM risk_model WHERE model_id = :id LIMIT 1"
                    );
                    $stmt->execute([':id' => $id]);
                    $m = $stmt->fetch(PDO::FETCH_ASSOC);
                    if (!$m) {
                        return null;
                    }
                    $m['model_id']           = (int)$m['model_id'];
                    $m['moderate_threshold'] = (float)$m['moderate_threshold'];
                    $m['high_threshold']     = (float)$m['high_threshold'];
                    $m['indicators']         = risk_model_load_indicators($pdo, $m['model_id']);
                    return $m;
                })($pdo, $id)
                : risk_model_get_active($pdo, $schoolYearId, $semesterId);

            if ($model === null) {
                api_json_response(404, ['message' => 'No active risk model. Activate one first.']);
            }

            $signals = risk_collect_signals($pdo, $studentId, $semesterId, $schoolYearId, null, null, $period);
            $result  = risk_evaluate_signals($model, $signals);

            api_json_response(200, [
                'message'    => 'Preview computed. Nothing was saved.',
                'model'      => ['model_id' => $model['model_id'], 'model_name' => $model['model_name'] ?? null],
                // Named back, because a preview that does not say which slice it
                // read is a number the reader has to guess the meaning of.
                'period'       => $period,
                'period_label' => api_period_label($period),
                'signals'    => $signals,
                'evaluation' => $result,
            ]);
        }

        api_json_response(200, array_merge(
            ['message' => 'Risk model configuration loaded.'],
            risk_load_full_config($pdo)
        ));
    }

    // Everything past this point mutates the model.
    $canEdit = api_session_user_has_role($authUser, ['admin']);
    if (!$canEdit) {
        api_json_response(403, ['message' => 'You do not have permission to change the risk model.']);
    }

    // ---------------------------------------------------------------- PUT ---
    if ($method === 'PUT') {
        $payload = api_read_json_body();

        if ($action === 'model') {
            if ($id <= 0) {
                api_json_response(400, ['message' => 'Valid id is required']);
            }

            $fields = [];
            $params = [':id' => $id];
            foreach ([
                'model_name'         => ':model_name',
                'description'        => ':description',
                'moderate_threshold' => ':moderate_threshold',
                'high_threshold'     => ':high_threshold',
            ] as $key => $bind) {
                if (array_key_exists($key, $payload)) {
                    $fields[] = "$key = $bind";
                    $params[$bind] = $payload[$key];
                }
            }

            if (array_key_exists('moderate_threshold', $payload) && array_key_exists('high_threshold', $payload)
                && (float)$payload['moderate_threshold'] > (float)$payload['high_threshold']) {
                api_json_response(400, ['message' => 'Moderate threshold cannot be above the high threshold.']);
            }

            if (!$fields) {
                api_json_response(200, ['message' => 'No changes']);
            }

            $pdo->prepare('UPDATE risk_model SET ' . implode(', ', $fields) . ' WHERE model_id = :id')
                ->execute($params);

            api_write_audit_log($pdo, $authUser, 'settings_update', 'Risk model updated.', [
                'model_id' => $id,
                'changed'  => array_keys($payload),
            ]);

            api_json_response(200, array_merge(
                ['message' => 'Risk model updated.'],
                risk_load_full_config($pdo)
            ));
        }

        if ($action === 'indicator') {
            if ($id <= 0) {
                api_json_response(400, ['message' => 'Valid id is required']);
            }

            $allowed = ['category_id', 'label', 'source', 'field_key', 'operator',
                        'value_min', 'value_max', 'value_text', 'points',
                        'reason_template', 'is_active', 'sort_order'];

            if (array_key_exists('source', $payload) && !in_array($payload['source'], RISK_SOURCES, true)) {
                api_json_response(400, ['message' => 'Unknown source']);
            }
            if (array_key_exists('operator', $payload) && !in_array($payload['operator'], RISK_OPERATORS, true)) {
                api_json_response(400, ['message' => 'Unknown operator']);
            }

            $fields = [];
            $params = [':id' => $id];
            foreach ($allowed as $key) {
                if (array_key_exists($key, $payload)) {
                    $fields[] = "`$key` = :$key";
                    $params[":$key"] = $payload[$key] === '' ? null : $payload[$key];
                }
            }
            if (!$fields) {
                api_json_response(200, ['message' => 'No changes']);
            }

            $pdo->prepare('UPDATE risk_indicator SET ' . implode(', ', $fields) . ' WHERE indicator_id = :id')
                ->execute($params);

            api_write_audit_log($pdo, $authUser, 'settings_update', 'Risk indicator updated.', [
                'indicator_id' => $id,
                'changed'      => array_keys($payload),
            ]);

            api_json_response(200, array_merge(
                ['message' => 'Indicator updated.'],
                risk_load_full_config($pdo)
            ));
        }

        api_json_response(400, ['message' => 'Invalid action']);
    }

    // --------------------------------------------------------------- POST ---
    if ($method === 'POST') {
        $payload = api_read_json_body();

        if ($action === 'activate') {
            if ($id <= 0) {
                api_json_response(400, ['message' => 'Valid id is required']);
            }
            $exists = $pdo->prepare('SELECT model_name FROM risk_model WHERE model_id = :id');
            $exists->execute([':id' => $id]);
            $modelName = $exists->fetchColumn();
            if ($modelName === false) {
                api_json_response(404, ['message' => 'That risk model does not exist.']);
            }

            /*
             * Exactly one active model, so scoring is never ambiguous.
             *
             * The audit write happens AFTER the commit, not inside it. It used
             * to sit between the two UPDATEs and the commit, and
             * api_write_audit_log ensures its own table — DDL, which MySQL
             * commits implicitly. So the transaction was already closed by the
             * time commit() ran, commit() threw "There is no active
             * transaction", and the catch called rollBack() on nothing and
             * threw again. Activating a model has never once succeeded: it
             * answered 500 every time, and the two UPDATEs landed anyway.
             */
            $pdo->beginTransaction();
            try {
                $pdo->exec('UPDATE risk_model SET is_active = 0');
                $pdo->prepare('UPDATE risk_model SET is_active = 1 WHERE model_id = :id')->execute([':id' => $id]);
                $pdo->commit();
            } catch (Throwable $e) {
                if ($pdo->inTransaction()) {
                    $pdo->rollBack();
                }
                throw $e;
            }

            api_write_audit_log($pdo, $authUser, 'settings_update', 'Risk model activated: ' . $modelName, [
                'model_id' => $id,
                'model_name' => $modelName,
            ]);

            api_json_response(200, array_merge(
                ['message' => 'Risk model activated. It applies from the next evaluation.'],
                risk_load_full_config($pdo)
            ));
        }

        if ($action === 'deactivate') {
            $pdo->exec('UPDATE risk_model SET is_active = 0');
            api_write_audit_log($pdo, $authUser, 'settings_update', 'Risk model deactivated.', []);
            api_json_response(200, array_merge(
                ['message' => 'No model is active. Evaluation falls back to the built-in defaults.'],
                risk_load_full_config($pdo)
            ));
        }

        if ($action === 'indicator') {
            $modelId    = (int)risk_require_value($payload['model_id'] ?? null, 'model_id');
            $categoryId = (int)risk_require_value($payload['category_id'] ?? null, 'category_id');
            $label      = trim((string)risk_require_value($payload['label'] ?? null, 'label'));
            $source     = (string)risk_require_value($payload['source'] ?? null, 'source');
            $fieldKey   = (string)risk_require_value($payload['field_key'] ?? null, 'field_key');
            $operator   = (string)($payload['operator'] ?? 'gte');

            if (!in_array($source, RISK_SOURCES, true)) {
                api_json_response(400, ['message' => 'Unknown source']);
            }
            if (!in_array($operator, RISK_OPERATORS, true)) {
                api_json_response(400, ['message' => 'Unknown operator']);
            }

            $stmt = $pdo->prepare(
                "INSERT INTO risk_indicator
                    (model_id, category_id, label, source, field_key, operator,
                     value_min, value_max, value_text, points, reason_template, is_active, sort_order)
                 VALUES (:model_id, :category_id, :label, :source, :field_key, :operator,
                     :value_min, :value_max, :value_text, :points, :reason_template, :is_active, :sort_order)"
            );
            $stmt->execute([
                ':model_id'        => $modelId,
                ':category_id'     => $categoryId,
                ':label'           => $label,
                ':source'          => $source,
                ':field_key'       => $fieldKey,
                ':operator'        => $operator,
                ':value_min'       => $payload['value_min'] ?? null,
                ':value_max'       => $payload['value_max'] ?? null,
                ':value_text'      => $payload['value_text'] ?? null,
                ':points'          => isset($payload['points']) ? (float)$payload['points'] : 1.0,
                ':reason_template' => $payload['reason_template'] ?? null,
                ':is_active'       => isset($payload['is_active']) ? (int)(bool)$payload['is_active'] : 1,
                ':sort_order'      => isset($payload['sort_order']) ? (int)$payload['sort_order'] : 0,
            ]);

            api_write_audit_log($pdo, $authUser, 'settings_update', 'Risk indicator created.', [
                'indicator_id' => (int)$pdo->lastInsertId(),
                'label'        => $label,
            ]);

            api_json_response(201, array_merge(
                ['message' => 'Indicator added.'],
                risk_load_full_config($pdo)
            ));
        }

        api_json_response(400, ['message' => 'Invalid action']);
    }

    // ------------------------------------------------------------- DELETE ---
    if ($method === 'DELETE') {
        if ($action === 'indicator') {
            if ($id <= 0) {
                api_json_response(400, ['message' => 'Valid id is required']);
            }
            /*
             * The label is read first so the audit entry can name what went.
             * "Risk indicator deleted. {indicator_id: 14}" is a record of an id
             * that no longer resolves to anything — the one case where the
             * detail has to carry the name, because the row it points at is
             * gone.
             *
             * And a delete that matched nothing is reported as such rather than
             * answered with "Indicator deleted." and an audit entry saying so.
             */
            $found = $pdo->prepare('SELECT label FROM risk_indicator WHERE indicator_id = :id');
            $found->execute([':id' => $id]);
            $label = $found->fetchColumn();
            if ($label === false) {
                api_json_response(404, ['message' => 'That indicator does not exist.']);
            }

            $pdo->prepare('DELETE FROM risk_indicator WHERE indicator_id = :id')->execute([':id' => $id]);
            api_write_audit_log($pdo, $authUser, 'settings_update', 'Risk indicator deleted: ' . $label, [
                'indicator_id' => $id,
                'label' => $label,
            ]);

            api_json_response(200, array_merge(
                ['message' => 'Indicator deleted.'],
                risk_load_full_config($pdo)
            ));
        }

        api_json_response(400, ['message' => 'Invalid action']);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'risk_model.php']);
    api_json_response(500, ['message' => 'Server error']);
}
