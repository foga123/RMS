<?php
/**
 * Server-recorded audit trail: who signed in, from which address, on what — and
 * what they then changed.
 *
 * Read-only. Rows are written by api_audit_record() at the point the event
 * happens; nothing can be posted here, because an audit log a client can write
 * to is not evidence of anything.
 *
 * Two kinds of event share the table, and the viewer splits them into tabs:
 *
 *   auth    login, logout, failed and blocked sign-ins. Answers "who was here".
 *   action  everything else — a user archived, a permission granted, a sheet
 *           imported, a backup restored. Answers "who changed what".
 *
 * They are one table because they are one timeline: seeing a failed sign-in at
 * 02:14 and a settings change at 02:15 is the whole point of an audit log. They
 * are two tabs because the columns that matter differ — an IP address and a
 * device tell you about a sign-in, and say nothing about an import.
 */
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';

function audit_log_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * The actions that are sign-in activity rather than a change.
 *
 * Listed explicitly, and the "action" tab is defined as everything NOT in this
 * list. That direction matters: a new kind of administrative action added next
 * month appears in the Actions tab on its own, whereas an allow-list would drop
 * it silently and nobody would notice a category of change had stopped showing.
 */
function audit_auth_actions(): array
{
    return ['login', 'logout'];
}

/** YYYY-MM-DD or nothing. Anything else is discarded rather than guessed at. */
function audit_valid_date(?string $value): ?string
{
    $value = trim((string)$value);
    if ($value === '' || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $value)) {
        return null;
    }
    [$y, $m, $d] = array_map('intval', explode('-', $value));
    return checkdate($m, $d, $y) ? $value : null;
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        audit_log_out(405, ['message' => 'Method not allowed. This endpoint is read-only.']);
    }

    $pdo = (new Database())->connect();
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        audit_log_out(401, ['message' => 'Not authenticated']);
    }

    api_audit_ensure_table($pdo);

    $limit = isset($_GET['limit']) ? max(1, min(500, (int)$_GET['limit'])) : 100;
    $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
    $offset = ($page - 1) * $limit;

    $authActions = audit_auth_actions();
    $authPlaceholders = [];
    $authParams = [];
    foreach ($authActions as $index => $name) {
        $key = ':auth_action_' . $index;
        $authPlaceholders[] = $key;
        $authParams[$key] = $name;
    }
    $authList = implode(', ', $authPlaceholders);

    $where = [];
    $params = [];

    // Which tab. An unrecognised value means "everything", so a hand-edited URL
    // shows the whole log rather than an empty table.
    $category = strtolower(trim((string)($_GET['category'] ?? '')));
    if ($category === 'auth') {
        $where[] = "a.action IN ($authList)";
        $params += $authParams;
    } elseif ($category === 'action') {
        $where[] = "a.action NOT IN ($authList)";
        $params += $authParams;
    } else {
        $category = '';
    }

    $action = trim((string)($_GET['action'] ?? ''));
    if ($action !== '') {
        $where[] = 'a.action = :action';
        $params[':action'] = $action;
    }

    $outcome = trim((string)($_GET['outcome'] ?? ''));
    if ($outcome !== '') {
        $where[] = 'a.outcome = :outcome';
        $params[':outcome'] = $outcome;
    }

    // Both ends inclusive. `to` is compared against the start of the following
    // day rather than against the date itself, or a range ending today would
    // exclude everything that happened today after midnight — which is most of
    // what someone filtering to today is looking for.
    $from = audit_valid_date($_GET['from'] ?? null);
    if ($from !== null) {
        $where[] = 'a.occurred_at >= :from';
        $params[':from'] = $from . ' 00:00:00';
    }

    $to = audit_valid_date($_GET['to'] ?? null);
    if ($to !== null) {
        $where[] = 'a.occurred_at < DATE_ADD(:to, INTERVAL 1 DAY)';
        $params[':to'] = $to . ' 00:00:00';
    }

    $search = trim((string)($_GET['search'] ?? ''));
    if ($search !== '') {
        // `detail` is searched too: for an action row it holds what changed, and
        // that is the only place a student number or a filename appears.
        $where[] = '(a.actor_label LIKE :search OR a.ip_address LIKE :search OR a.device LIKE :search
                     OR a.detail LIKE :search
                     OR CONCAT_WS(" ", u.first_name, u.last_name) LIKE :search)';
        $params[':search'] = '%' . $search . '%';
    }

    $whereSql = $where ? ('WHERE ' . implode(' AND ', $where)) : '';

    $sql = "
        SELECT a.audit_id, a.occurred_at, a.user_id, a.actor_label, a.action, a.outcome,
               a.detail, a.metadata, a.ip_address, a.device, a.user_agent,
               NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS user_name,
               r.role_name
          FROM api_audit_log a
     LEFT JOIN user u ON u.user_id = a.user_id
     LEFT JOIN role r ON r.role_id = u.role
        $whereSql
      ORDER BY a.occurred_at DESC, a.audit_id DESC
         LIMIT :limit OFFSET :offset";

    $stmt = $pdo->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value);
    }
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $countStmt = $pdo->prepare("
        SELECT COUNT(*) FROM api_audit_log a
     LEFT JOIN user u ON u.user_id = a.user_id
        $whereSql");
    foreach ($params as $key => $value) {
        $countStmt->bindValue($key, $value);
    }
    $countStmt->execute();
    // Matches the current filter, so it drives the pager and the "showing X of
    // Y" range.
    $total = (int)$countStmt->fetchColumn();

    // Unfiltered, because the headline tile answers "how much is on record",
    // not "how much matched what I just typed". Reusing the filtered count
    // there would make the total appear to shrink as someone searched.
    $recordedTotal = (int)$pdo->query('SELECT COUNT(*) FROM api_audit_log')->fetchColumn();

    // Per tab, so each tab can say how much it holds before it is opened.
    $categoryStmt = $pdo->prepare(
        "SELECT SUM(CASE WHEN action IN ($authList) THEN 1 ELSE 0 END) AS auth_total,
                SUM(CASE WHEN action NOT IN ($authList) THEN 1 ELSE 0 END) AS action_total
           FROM api_audit_log"
    );
    foreach ($authParams as $key => $value) {
        $categoryStmt->bindValue($key, $value);
    }
    $categoryStmt->execute();
    $categoryCounts = $categoryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $failedLogins = (int)$pdo->query(
        'SELECT COUNT(*) FROM api_audit_log
          WHERE action = "login" AND outcome = "failed"
            AND occurred_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)'
    )->fetchColumn();

    /*
     * Two numbers the summary was missing, both scoped to the tab.
     *
     * "Recorded Events" alone answers a question nobody asks: the total only
     * ever goes up, and a number that has been climbing for months tells a
     * reader nothing about whether anything happened. Activity in the last day
     * and the busiest account do -- they are what someone opening this panel
     * after an incident is actually looking for.
     */
    $recentSql = 'SELECT COUNT(*) FROM api_audit_log WHERE occurred_at > DATE_SUB(NOW(), INTERVAL 24 HOUR)';
    if ($category === 'auth') {
        $recentSql .= " AND action IN ($authList)";
    } elseif ($category === 'action') {
        $recentSql .= " AND action NOT IN ($authList)";
    }
    $recentStmt = $pdo->prepare($recentSql);
    if ($category === 'auth' || $category === 'action') {
        foreach ($authParams as $key => $value) {
            $recentStmt->bindValue($key, $value);
        }
    }
    $recentStmt->execute();
    $recent24h = (int)$recentStmt->fetchColumn();

    // Over the last week rather than all time: "who has been busiest since this
    // system was installed" is trivia, "who has been busiest lately" is a lead.
    $busiestSql = 'SELECT actor_label, COUNT(*) AS records FROM api_audit_log
                    WHERE actor_label IS NOT NULL AND LENGTH(actor_label) > 0
                      AND occurred_at > DATE_SUB(NOW(), INTERVAL 7 DAY)';
    if ($category === 'auth') {
        $busiestSql .= " AND action IN ($authList)";
    } elseif ($category === 'action') {
        $busiestSql .= " AND action NOT IN ($authList)";
    }
    $busiestSql .= ' GROUP BY actor_label ORDER BY records DESC LIMIT 1';
    $busiestStmt = $pdo->prepare($busiestSql);
    if ($category === 'auth' || $category === 'action') {
        foreach ($authParams as $key => $value) {
            $busiestStmt->bindValue($key, $value);
        }
    }
    $busiestStmt->execute();
    $busiest = $busiestStmt->fetch(PDO::FETCH_ASSOC) ?: null;

    /*
     * What the "Action" dropdown offers, and how much each holds.
     *
     * Scoped to the tab but NOT to the other filters, on purpose. Narrowing it
     * by the current search would empty the dropdown as soon as a search matched
     * nothing, leaving no way back except clearing a filter that is no longer
     * visible. It is a list of what this log can contain, not of what is on
     * screen.
     */
    $facetSql = 'SELECT action, COUNT(*) AS records FROM api_audit_log';
    $facetParams = [];
    if ($category === 'auth') {
        $facetSql .= " WHERE action IN ($authList)";
        $facetParams = $authParams;
    } elseif ($category === 'action') {
        $facetSql .= " WHERE action NOT IN ($authList)";
        $facetParams = $authParams;
    }
    $facetSql .= ' GROUP BY action ORDER BY records DESC, action ASC';
    $facetStmt = $pdo->prepare($facetSql);
    foreach ($facetParams as $key => $value) {
        $facetStmt->bindValue($key, $value);
    }
    $facetStmt->execute();
    $actionFacets = array_map(static function (array $row): array {
        return ['action' => (string)$row['action'], 'records' => (int)$row['records']];
    }, $facetStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

    audit_log_out(200, [
        'data' => array_map(static function (array $row): array {
            return [
                'id' => (int)$row['audit_id'],
                'occurred_at' => $row['occurred_at'],
                'user_id' => $row['user_id'] !== null ? (int)$row['user_id'] : null,
                // Falls back to what was typed, so a failed login against an
                // address with no account still names its target.
                'user' => $row['user_name'] ?: ($row['actor_label'] ?: 'Unknown'),
                'role_name' => $row['role_name'],
                'action' => $row['action'],
                'outcome' => $row['outcome'],
                'detail' => $row['detail'],
                /*
                 * Decoded here rather than shipped as a string, so the reader
                 * renders fields instead of a blob. Rows written before
                 * 2026-08-27 kept their sentence but lost their data -- the two
                 * were concatenated into a varchar(255) and cut mid-object --
                 * so null is normal on old rows and means "not recorded", not
                 * "nothing happened".
                 */
                'metadata' => $row['metadata'] ? json_decode((string)$row['metadata'], true) : null,
                'ip_address' => $row['ip_address'],
                'device' => $row['device'],
                'user_agent' => $row['user_agent'],
            ];
        }, $rows),
        'stats' => [
            'total' => $recordedTotal,
            // `matching` used to sit here as a second copy of the filtered
            // count. It is `pagination.total`, byte for byte, from the same
            // $total — and nothing ever read it. One number, one place.
            'failed_logins_24h' => $failedLogins,
            'recent_24h' => $recent24h,
            'busiest_actor' => $busiest ? (string)$busiest['actor_label'] : null,
            'busiest_actor_records' => $busiest ? (int)$busiest['records'] : 0,
            'auth_total' => (int)($categoryCounts['auth_total'] ?? 0),
            'action_total' => (int)($categoryCounts['action_total'] ?? 0),
        ],
        'actions' => $actionFacets,
        'pagination' => [
            'page' => $page,
            'limit' => $limit,
            'total' => $total,
            'pages' => $limit > 0 ? (int)ceil($total / $limit) : 0,
        ],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'audit_log']);
    audit_log_out(500, ['message' => 'Server error while loading the audit log.']);
}
