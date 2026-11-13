<?php
/** Cheap change-probe: returns a version token per topic so pages refetch only when data actually changed. */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
// A probe answer is only valid for the instant it was taken. Set after
// api_send_headers() because this endpoint is the one exception to the shared
// header set, not a variation on it.
header('Cache-Control: no-store');
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';

function changes_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * topic => [table, module key the caller must be able to view].
 *
 * Keys are the canonical ones from api_permission_module_action_map(), not the
 * hyphenated rbac_module slugs — only some of those have aliases. A null module
 * means the matching endpoint has no module gate either, so login is enough.
 */
function changes_topic_map(): array
{
    return [
        'students'           => ['student', 'student_manage'],
        'grades'             => ['grades', 'grades'],
        'attendance'         => ['attendance', 'attendance_management'],
        'enrollment_status'  => ['enrollment_status', 'enrollment_status'],
        'finance'            => ['finance', 'finance_management'],
        'users'              => ['user', 'users'],
        'roles'              => ['role', 'roles'],
        'departments'        => ['department', 'departments'],
        'courses'            => ['course', 'courses'],
        'campuses'           => ['campus', 'campuses'],
        'statuses'           => ['status', 'statuses'],
        'remarks'            => ['remarks', 'remarks'],
        'school_years'       => ['school_year', null],
        'semesters'          => ['semester', null],
        'surveys'            => ['survey', 'survey'],
        'survey_questions'   => ['survey_question', 'survey_questions'],
        'survey_submissions' => ['survey_submission', 'survey_submissions'],
        'survey_answers'     => ['survey_answer', 'survey_responses'],
        'retention_cases'    => ['retention_case', 'retention_cases'],
        'ssp_assignments'    => ['ssp_assignment', 'assignments'],
        /*
         * Contact attempts. Added because the Team Monitor board is built from
         * exactly this table and had no topic to watch: it asked for
         * 'student_contacts', got no such key, and every probe answered with an
         * empty token set. Nothing errored -- the board simply never refreshed,
         * so a supervisor saw a caller working and the numbers standing still.
         *
         * Gated on `student_contacts`, the module that owns the record, the same
         * way every other row here names the module that owns its table. The two
         * roles that hold team_monitor today (SSP Coordinator, KSH TL) both hold
         * student_contacts as well, so the topic resolves for them.
         */
        'student_contacts'   => ['student_contact_attempt', 'student_contacts'],
        'audit_log'          => ['api_audit_log', 'settings'],
    ];
}

/** Column list for a table, read once per request. */
function changes_table_columns(PDO $pdo, string $table): array
{
    static $cache = [];
    if (isset($cache[$table])) {
        return $cache[$table];
    }

    $stmt = $pdo->prepare(
        'SELECT COLUMN_NAME FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t
         ORDER BY ORDINAL_POSITION'
    );
    $stmt->execute([':t' => $table]);

    return $cache[$table] = $stmt->fetchAll(PDO::FETCH_COLUMN);
}

function changes_quote_ident(string $name): string
{
    return '`' . str_replace('`', '``', $name) . '`';
}

/**
 * Token for one table.
 *
 * Tables carrying `updated_at` get an index-friendly MAX() probe. The rest —
 * including student, grades, enrollment_status and finance — have no timestamp
 * at all, so only a checksum over every column can notice an in-place edit.
 */
/**
 * Tables that are only ever appended to, with the primary key that proves it.
 *
 * For these, COUNT(*) plus MAX(pk) is a complete token: rows are never edited
 * or deleted in place, so nothing can change without the count or the highest
 * id moving. Both come from the index, which matters because the audit log is
 * polled every few seconds and grows without bound -- the CRC32 fallback below
 * reads every column of every row, and would turn a cheap probe into a full
 * table scan a few hundred thousand rows deep.
 */
function changes_append_only_map(): array
{
    return ['api_audit_log' => 'audit_id'];
}

function changes_token(PDO $pdo, string $table): ?string
{
    $columns = changes_table_columns($pdo, $table);
    if (empty($columns)) {
        return null;
    }

    // $table is never user input: it comes from changes_topic_map() above.
    $quoted = changes_quote_ident($table);

    $appendOnlyKey = changes_append_only_map()[$table] ?? null;
    if ($appendOnlyKey !== null && in_array($appendOnlyKey, $columns, true)) {
        $key = changes_quote_ident($appendOnlyKey);
        $stmt = $pdo->query("SELECT COUNT(*) AS n, COALESCE(MAX($key),0) AS m FROM $quoted");
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: ['n' => 0, 'm' => 0];
        return 'a' . $row['n'] . ':' . $row['m'];
    }

    if (in_array('updated_at', $columns, true)) {
        $stmt = $pdo->query("SELECT COUNT(*) AS n, COALESCE(MAX(updated_at),'') AS m FROM $quoted");
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: ['n' => 0, 'm' => ''];
        return 't' . $row['n'] . ':' . $row['m'];
    }

    $parts = [];
    foreach ($columns as $column) {
        // COALESCE keeps NULL distinct from an empty string.
        $parts[] = "COALESCE(" . changes_quote_ident($column) . ",'~')";
    }
    $expr = "CONCAT_WS('|'," . implode(',', $parts) . ")";

    $stmt = $pdo->query("SELECT COUNT(*) AS n, COALESCE(SUM(CRC32($expr)),0) AS c FROM $quoted");
    $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: ['n' => 0, 'c' => 0];

    return 'c' . $row['n'] . ':' . $row['c'];
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        changes_out(405, ['message' => 'Method not allowed']);
    }

    // Login is already enforced by api_bootstrap_auth() when connection-pdo.php loads.
    $user = api_get_session_user();
    if (!$user) {
        changes_out(401, ['message' => 'Authentication required']);
    }

    $requested = array_filter(array_map('trim', explode(',', (string)($_GET['topics'] ?? ''))));
    if (empty($requested)) {
        changes_out(400, ['message' => 'No topics requested']);
    }

    $db = new Database();
    $pdo = $db->connect();

    $topicMap = changes_topic_map();
    $permissions = api_normalize_permissions_map($user['permissions'] ?? []);
    if (empty($permissions)) {
        $record = api_fetch_effective_permissions_record(
            $pdo,
            isset($user['role_id']) ? (int)$user['role_id'] : 0,
            isset($user['user_id']) ? (int)$user['user_id'] : 0
        );
        $permissions = api_normalize_permissions_map($record['permissions'] ?? []);
    }

    $tokens = [];
    $skipped = [];
    /*
     * Two different reasons to skip, reported separately.
     *
     * "You may not watch this" is normal and expected -- one denied topic must
     * not break the rest of the probe. "There is no such topic" is a wiring
     * mistake, and it used to be indistinguishable from the first: both landed
     * in $skipped, the client ignored the field entirely, and a misspelt topic
     * produced a page that polled forever and never refreshed. The Team Monitor
     * asked for 'ssp_assignment' against a map holding 'ssp_assignments' and
     * failed that way for as long as the board has existed.
     */
    $unknown = [];
    foreach ($requested as $topic) {
        if (!isset($topicMap[$topic])) {
            $skipped[] = $topic;
            $unknown[] = $topic;
            continue;
        }

        [$table, $moduleKey] = $topicMap[$topic];

        // A topic the caller cannot view is omitted rather than refused, so one
        // denied topic never breaks the rest of the probe.
        if ($moduleKey !== null && !api_can($permissions, $moduleKey, 'view')) {
            $skipped[] = $topic;
            continue;
        }

        $token = changes_token($pdo, $table);
        if ($token !== null) {
            $tokens[$topic] = $token;
        }
    }

    changes_out(200, [
        'tokens' => $tokens,
        'skipped' => $skipped,
        // Named topics that do not exist in changes_topic_map(). Always sent, so
        // the client can surface it; useLiveRefresh() logs it in development.
        // Kept out of `skipped`'s meaning rather than replacing it, because
        // `skipped` is the existing field and nothing should have to change to
        // keep reading it.
        'unknown_topics' => $unknown,
        'ts' => time(),
    ]);
} catch (Throwable $e) {
    if (function_exists('api_log_exception')) {
        api_log_exception($e, ['scope' => 'changes_probe']);
    }
    changes_out(500, ['message' => 'Server error']);
}
