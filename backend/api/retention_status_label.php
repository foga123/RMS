<?php
/**
 * Read and rename the retention case status labels.
 *
 * The three retention vocabularies - validation, intervention and risk level -
 * are fixed sets of codes in retention_case.php, because the workflow logic
 * compares them literally. This endpoint makes the *words* configurable without
 * touching those codes, the same split risk_category already uses between
 * category_code and category_name.
 *
 * GET                  every label, grouped
 * PUT  ?id=            rename one label
 *
 * Rename-only by design. There is no POST or DELETE: a new status would need
 * the workflow logic to know what it means, and a deleted one would strand the
 * retention_case rows still holding its code. See the migration for the long
 * version - migrations/2026_09_09_retention_status_label.sql.
 */

require_once __DIR__ . '/connection-pdo.php';
// The workflow codes, shared with retention_case.php.
require_once __DIR__ . '/lib/retention_case_policy.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

/**
 * The groups this endpoint will serve, and the codes each is allowed to hold.
 *
 * The codes are CASE_VALIDATION_STATUSES, CASE_INTERVENTION_STATUSES and
 * CASE_RISK_LEVELS from lib/retention_case_policy.php - the same lists
 * retention_case.php validates writes against. This file used to keep its own
 * copy, because requiring retention_case.php would run its request pipeline.
 *
 * It is what stops a PUT renaming a row that no longer corresponds to anything
 * the workflow can produce.
 */
const RETENTION_LABEL_GROUPS = [
    'validation'   => CASE_VALIDATION_STATUSES,
    'intervention' => CASE_INTERVENTION_STATUSES,
    'risk_level'   => CASE_RISK_LEVELS,
];

/** Human-readable group names, for the settings panel's section headings. */
const RETENTION_LABEL_GROUP_TITLES = [
    'validation'   => 'Validation status',
    'intervention' => 'Intervention status',
    'risk_level'   => 'Risk level',
];

/**
 * The fallback label for a code with no row.
 *
 * Matches what the UI did before this table existed - underscore to space -
 * so a database that has not run the migration renders the same words it
 * always did rather than an empty cell.
 */
function retention_label_fallback(string $code): string
{
    return ucwords(str_replace('_', ' ', $code));
}

function retention_label_table_exists(PDO $pdo): bool
{
    $stmt = $pdo->query("SHOW TABLES LIKE 'retention_status_label'");
    return $stmt !== false && $stmt->fetchColumn() !== false;
}

/**
 * Every label, as group => [code => label].
 *
 * Codes absent from the table are filled from the fallback, so the shape of the
 * response is decided by RETENTION_LABEL_GROUPS and never by which rows happen
 * to exist. A caller can render straight from this without null checks.
 */
function retention_labels_load(PDO $pdo): array
{
    $stored = [];
    if (retention_label_table_exists($pdo)) {
        $rows = $pdo->query(
            'SELECT label_id, status_group, status_code, label, sort_order
               FROM retention_status_label
              ORDER BY status_group, sort_order, label_id'
        )->fetchAll(PDO::FETCH_ASSOC);
        foreach ($rows as $row) {
            $stored[$row['status_group']][$row['status_code']] = $row;
        }
    }

    $out = [];
    foreach (RETENTION_LABEL_GROUPS as $group => $codes) {
        $items = [];
        foreach ($codes as $index => $code) {
            $row = $stored[$group][$code] ?? null;
            $items[] = [
                'label_id'    => $row ? (int)$row['label_id'] : null,
                'status_code' => $code,
                'label'       => $row ? (string)$row['label'] : retention_label_fallback($code),
                'sort_order'  => $row ? (int)$row['sort_order'] : $index + 1,
                // True when the row is missing and the word shown is derived.
                // The panel uses this to explain why a label is not editable.
                'is_fallback' => $row === null,
            ];
        }
        $out[] = [
            'status_group' => $group,
            'title'        => RETENTION_LABEL_GROUP_TITLES[$group] ?? $group,
            'items'        => $items,
        ];
    }
    return $out;
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $id     = isset($_GET['id']) ? (int)$_GET['id'] : 0;

    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();

    if ($method === 'GET') {
        api_json_response(200, [
            'message'   => 'Retention status labels loaded.',
            'installed' => retention_label_table_exists($pdo),
            'groups'    => retention_labels_load($pdo),
        ]);
    }

    // Renaming is a settings change, gated like every other one on this screen.
    if (!api_session_user_has_role($authUser, ['admin'])) {
        api_json_response(403, ['message' => 'You do not have permission to rename retention statuses.']);
    }

    if ($method === 'PUT') {
        if (!retention_label_table_exists($pdo)) {
            api_json_response(503, [
                'message' => 'The retention status label table is not installed. Run migrations/2026_09_09_retention_status_label.sql.',
            ]);
        }
        if ($id <= 0) {
            api_json_response(400, ['message' => 'Valid id is required']);
        }

        $payload = json_decode(file_get_contents('php://input') ?: '', true);
        if (!is_array($payload)) {
            api_json_response(400, ['message' => 'Invalid JSON payload']);
        }
        if (!array_key_exists('label', $payload)) {
            api_json_response(400, ['message' => 'label is required']);
        }

        $label = trim((string)$payload['label']);
        if ($label === '') {
            api_json_response(400, ['message' => 'A status needs a name.']);
        }
        // The column is varchar(60); refused here so the value is not silently
        // truncated into something nobody chose.
        if (mb_strlen($label) > 60) {
            api_json_response(400, ['message' => 'Keep the name to 60 characters or fewer.']);
        }

        $stmt = $pdo->prepare(
            'SELECT status_group, status_code, label
               FROM retention_status_label WHERE label_id = :id LIMIT 1'
        );
        $stmt->execute([':id' => $id]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
        if (!$row) {
            api_json_response(404, ['message' => 'That status does not exist.']);
        }

        /*
         * A row whose code the workflow can no longer produce is not renameable.
         *
         * It would be a label nobody ever sees, and editing it reads as a change
         * that had no effect. This only fires if the table and the PHP constants
         * have drifted apart.
         */
        $allowed = RETENTION_LABEL_GROUPS[$row['status_group']] ?? [];
        if (!in_array($row['status_code'], $allowed, true)) {
            api_json_response(409, [
                'message' => 'That status is no longer part of the retention workflow and cannot be renamed.',
            ]);
        }

        if ($label === (string)$row['label']) {
            api_json_response(200, [
                'message' => 'No changes',
                'groups'  => retention_labels_load($pdo),
            ]);
        }

        $upd = $pdo->prepare('UPDATE retention_status_label SET label = :label WHERE label_id = :id');
        $upd->execute([':label' => $label, ':id' => $id]);

        /*
         * The audit entry names the code, not just the id. The id resolves to a
         * row whose label is now the new one, so without the code the log cannot
         * answer "which status was this?" after a second rename.
         */
        api_write_audit_log($pdo, $authUser, 'settings_update', 'Retention status renamed.', [
            'status_group' => $row['status_group'],
            'status_code'  => $row['status_code'],
            'from'         => (string)$row['label'],
            'to'           => $label,
        ]);

        api_json_response(200, [
            'message' => 'Status renamed.',
            'groups'  => retention_labels_load($pdo),
        ]);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'retention_status_label.php']);
    api_json_response(500, ['message' => 'Server error']);
}
