<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/periodic_lib.php';
// The Potential Drop Out filter. The priority rules live there and are not
// restated here — see pdo_filter_student_ids().
require_once __DIR__ . '/pdo_priority_lib.php';
// A closed semester's balances are read-only. See lib/term_closure.php.
require_once __DIR__ . '/lib/term_closure.php';


/*
 * Every column the finance table actually holds, plus the names its foreign keys
 * point at.
 *
 * This replaces a hand-built array that returned three fields the table does not
 * have: reference_no (always null), notes (always empty) and status (always the
 * literal string 'Pending'). Nothing read them, but 'Pending' rendered as a real
 * status for a record whose payment state the system has never tracked, and a
 * finance officer reading it had no way to know it was invented. The columns
 * below are the row as stored, with balance_range resolved to the status name it
 * references so the band reads as "3k Below" rather than as the number 7.
 */
const FINANCE_ROW_SELECT = "SELECT f.finance_id,
                                   f.student_id,
                                   st.student_number,
                                   TRIM(CONCAT(COALESCE(st.first_name, ''), ' ', COALESCE(st.last_name, ''))) AS student_name,
                                   f.balance_to_data,
                                   f.balance_range,
                                   bal.status_name AS balance_range_name,
                                   f.`date`,
                                   f.semester_id,
                                   sem.semester_name,
                                   f.school_year_id,
                                   sy.schoolyear_name,
                                   f.period,
                                   f.updated_at
                              FROM finance f
                              LEFT JOIN student st ON st.student_id = f.student_id
                              LEFT JOIN semester sem ON sem.semester_id = f.semester_id
                              LEFT JOIN school_year sy ON sy.school_year_id = f.school_year_id
                              LEFT JOIN status bal ON bal.status_id = f.balance_range";

/** One database row, shaped for the UI. */
function finance_map_row(array $r): array {
    return [
        // 'id' and 'amount' are the names the finance screens have always used
        // for finance_id and balance_to_data. Kept so this stays a widening of
        // the response rather than a rename every caller has to follow, with the
        // real column names alongside them.
        'id' => (int)$r['finance_id'],
        'finance_id' => (int)$r['finance_id'],
        'amount' => (float)($r['balance_to_data'] ?? 0),
        'balance_to_data' => (float)($r['balance_to_data'] ?? 0),
        'student_id' => (string)($r['student_id'] ?? ''),
        'student_number' => $r['student_number'] ?? null,
        'student_name' => ($r['student_name'] ?? '') !== '' ? $r['student_name'] : null,
        'balance_range' => isset($r['balance_range']) ? (int)$r['balance_range'] : null,
        'balance_range_name' => $r['balance_range_name'] ?? null,
        'date' => $r['date'] ?? null,
        'semester_id' => isset($r['semester_id']) ? (int)$r['semester_id'] : null,
        'semester_name' => $r['semester_name'] ?? null,
        'school_year_id' => isset($r['school_year_id']) ? (int)$r['school_year_id'] : null,
        'schoolyear_name' => $r['schoolyear_name'] ?? null,
        'period' => isset($r['period']) ? (int)$r['period'] : null,
        'period_label' => api_period_label($r['period'] ?? null),
        'updated_at' => $r['updated_at'] ?? null,
    ];
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();
    $isAdmin = api_session_user_has_role($authUser, ['admin']);
    $isFinance = api_session_user_has_role($authUser, ['finance']);
    $permissionRecord = null;
    $usesPermissionMap = false;
    $permissionMap = [];
    if (!empty($authUser['role_id']) || !empty($authUser['user_id'])) {
        $permissionRecord = api_fetch_effective_permissions_record(
            $pdo,
            (int)($authUser['role_id'] ?? 0),
            (int)($authUser['user_id'] ?? 0)
        );
        $usesPermissionMap = !empty($permissionRecord['has_saved_permissions']);
        $permissionMap = $usesPermissionMap ? ($permissionRecord['permissions'] ?? []) : [];
    }
    $canCreateFinance = $usesPermissionMap
        ? api_can($permissionMap, 'finance_management', 'create')
        : $isAdmin;
    $canEditFinance = $usesPermissionMap
        ? api_can($permissionMap, 'finance_management', 'edit')
        : ($isAdmin || $isFinance);
    $canDeleteFinance = $usesPermissionMap
        ? api_can($permissionMap, 'finance_management', 'delete')
        : $isAdmin;
    $amountOnlyFinanceEdit = $canEditFinance && $isFinance && !$isAdmin && !$canCreateFinance && !$canDeleteFinance;

    $method = $_SERVER['REQUEST_METHOD'];
    $action = isset($_GET['action']) ? trim((string)$_GET['action']) : '';

    if ($method === 'GET') {
        // GET /finance.php?id=123 -> fetch one mapped to UI shape
        if (isset($_GET['id']) && (int)$_GET['id'] > 0) {
            $id = (int)$_GET['id'];
            $stmt = $pdo->prepare(FINANCE_ROW_SELECT . ' WHERE f.finance_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $r = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$r) api_out(404, ['message' => 'Record not found']);
            api_out(200, ['data' => finance_map_row($r)]);
        }

        // GET /finance.php?action=list -> list all mapped
        if ($action === 'list' || $action === '' ) {
            /*
             * Which periodical to show: 1, 2, 3, 'term' for the semester-total rows,
             * or absent for all of them together. An unreadable value falls back
             * to "all" rather than erroring, so a stale bookmark shows the page.
             */
            $period = isset($_GET['period']) ? trim((string)$_GET['period']) : '';
            [$periodSql, $periodParams] = api_period_filter_sql('f.period', $period);

            /*
             * ── TWO WHERE CLAUSES, AND THEY ARE NOT INTERCHANGEABLE ──────────
             *
             * $termWhere  period + semester + school year. Conditions on `f`
             *             alone, which is what the summary subquery below can
             *             see: it selects FROM finance with no joins, so a
             *             condition naming st.student_number would not compile
             *             there.
             * $listWhere  $termWhere plus the text search, which DOES reach
             *             through the joins. Used by the list and its count.
             *
             * The summary therefore describes the TERM, not the search — the
             * rollup above the table keeps meaning "this term owes X" while a
             * search narrows the rows underneath it. That is exactly what the
             * screen did when the filtering happened in the browser, so the
             * numbers do not change behaviour with this rewrite.
             */
            $termParts = $periodSql !== '' ? [$periodSql] : [];
            $termParams = $periodParams;

            // The import precheck asks "how many rows are already filed in this
            // term" and used to answer it by downloading every row and counting
            // in JavaScript. Filtering here lets it ask for one row and read the
            // total instead.
            if (isset($_GET['semester_id']) && $_GET['semester_id'] !== '') {
                $termParts[] = 'f.semester_id = :f_semester_id';
                $termParams[':f_semester_id'] = (int)$_GET['semester_id'];
            }
            if (isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '') {
                $termParts[] = 'f.school_year_id = :f_school_year_id';
                $termParams[':f_school_year_id'] = (int)$_GET['school_year_id'];
            }

            /*
             * "Show me only the students we are worried about."
             *
             * Into $termParts rather than $listParts, so the balance summary
             * above the table is computed over the same students the table
             * lists. The summary subquery carries no joins, which is exactly why
             * this filter can go there at all: it reduces to a plain
             * `f.student_id IN (...)` and needs nothing but the finance table.
             */
            pdo_filter_apply(
                $termParts,
                $pdo,
                $_GET['pdo'] ?? '',
                isset($_GET['semester_id']) && $_GET['semester_id'] !== '' ? (int)$_GET['semester_id'] : null,
                isset($_GET['school_year_id']) && $_GET['school_year_id'] !== '' ? (int)$_GET['school_year_id'] : null,
                'f.student_id',
                // The page's own periodical, so "potential drop out" is judged on the
                // periodical being shown rather than on the whole term.
                $_GET['period'] ?? null
            );

            $where = $termParts ? (' WHERE ' . implode(' AND ', $termParts)) : '';

            $listParts = $termParts;
            $listParams = $termParams;

            /*
             * The same columns the browser used to search over, moved server
             * side. It has to move: with the table paginated, a search that ran
             * in the browser would only ever match the fifty rows on screen and
             * would look like the record simply is not there.
             */
            $search = trim((string)($_GET['search'] ?? ''));
            if ($search !== '') {
                $listParts[] = "(st.student_number LIKE :q
                                 OR TRIM(CONCAT(COALESCE(st.first_name,''), ' ', COALESCE(st.last_name,''))) LIKE :q
                                 OR CAST(f.balance_to_data AS CHAR) LIKE :q
                                 OR bal.status_name LIKE :q
                                 OR CAST(f.`date` AS CHAR) LIKE :q
                                 OR sem.semester_name LIKE :q
                                 OR sy.schoolyear_name LIKE :q
                                 OR CAST(f.finance_id AS CHAR) LIKE :q)";
                $listParams[':q'] = '%' . $search . '%';
            }

            $listWhere = $listParts ? (' WHERE ' . implode(' AND ', $listParts)) : '';

            /*
             * Paginated by default. This action returned every row — 3,349 of
             * them, 1.3 MB — no matter what the caller asked for, and the page
             * then sliced it in the browser.
             *
             * `all=1` still returns everything, because two callers legitimately
             * need the whole filtered set rather than a page: the export, whose
             * file is meant to be the search result and not the visible page,
             * and anything counting a term. It is opt-in so that the expensive
             * answer is never the one a caller gets by accident.
             */
            $wantsAll = isset($_GET['all']) && in_array(strtolower(trim((string)$_GET['all'])), ['1', 'true', 'yes'], true);
            $limit = max(1, min(500, (int)($_GET['limit'] ?? 50)));
            $page = max(1, (int)($_GET['page'] ?? 1));
            $offset = ($page - 1) * $limit;

            $countStmt = $pdo->prepare('SELECT COUNT(*) FROM finance f
                                        LEFT JOIN student st ON st.student_id = f.student_id
                                        LEFT JOIN semester sem ON sem.semester_id = f.semester_id
                                        LEFT JOIN school_year sy ON sy.school_year_id = f.school_year_id
                                        LEFT JOIN status bal ON bal.status_id = f.balance_range' . $listWhere);
            foreach ($listParams as $k => $v) { $countStmt->bindValue($k, $v); }
            $countStmt->execute();
            $total = (int)$countStmt->fetchColumn();

            $sql = FINANCE_ROW_SELECT . $listWhere . ' ORDER BY f.finance_id DESC';
            if (!$wantsAll) {
                $sql .= ' LIMIT :limit OFFSET :offset';
            }
            $stmt = $pdo->prepare($sql);
            foreach ($listParams as $k => $v) { $stmt->bindValue($k, $v); }
            if (!$wantsAll) {
                $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
                $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
            }
            $stmt->execute();
            $rows = array_map('finance_map_row', $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

            /*
             * The semester rollup shown above the table.
             *
             * Balances are a running figure, not a ledger: a student owing 5,000
             * at P1 and 2,000 at P3 owes 2,000, not 7,000. So the rollup takes
             * one reading per student - the latest by date, matching how
             * finance-summary.php picks a current balance - and totals those.
             *
             * Period breaks a tie on the same date, with a periodical beating a
             * whole-term row: a term row sitting alongside periodicals is the
             * older import, not a final figure someone entered deliberately.
             * Same precedence as the grades rollup, for the same reason.
             */
            $summaryStmt = $pdo->prepare(
                "SELECT COUNT(*) AS student_records,
                        COALESCE(SUM(balance_to_data), 0) AS total_balance,
                        COALESCE(SUM(CASE WHEN balance_to_data > 0 THEN 1 ELSE 0 END), 0) AS with_balance,
                        COALESCE(SUM(CASE WHEN COALESCE(balance_to_data, 0) <= 0 THEN 1 ELSE 0 END), 0) AS cleared
                   FROM (
                        SELECT f.balance_to_data,
                               ROW_NUMBER() OVER (
                                   PARTITION BY f.student_id, f.semester_id, f.school_year_id
                                   ORDER BY f.`date` DESC, (f.period IS NULL) ASC, f.period DESC, f.finance_id DESC
                               ) AS pick
                          FROM finance f" . $where . "
                   ) latest_per_student
                  WHERE pick = 1"
            );
            // $termParams, not $periodParams: $where gained the semester and
            // school-year placeholders, and binding only the period ones leaves
            // the rest unbound — PDO then fails the whole statement with
            // "Invalid parameter number" and the endpoint answers 500.
            foreach ($termParams as $k => $v) { $summaryStmt->bindValue($k, $v); }
            $summaryStmt->execute();
            $summary = $summaryStmt->fetch(PDO::FETCH_ASSOC) ?: [];

            // Counted without the period filter, so the dropdown can show what
            // each periodical holds instead of only the bucket already picked.
            $breakdownStmt = $pdo->query('SELECT period, COUNT(*) AS records FROM finance GROUP BY period ORDER BY (period IS NULL), period');
            $breakdown = [];
            foreach ($breakdownStmt->fetchAll(PDO::FETCH_ASSOC) as $bucket) {
                $breakdown[] = [
                    'period' => $bucket['period'] === null ? null : (int)$bucket['period'],
                    'label' => api_period_label($bucket['period']),
                    'records' => (int)$bucket['records'],
                ];
            }

            api_out(200, [
                'data' => $rows,
                'summary' => $summary,
                'periods' => $breakdown,
                // `total` is the whole filtered set, not the page — it is what
                // the import precheck reads, and what the pager counts against.
                'pagination' => [
                    'page' => $wantsAll ? 1 : $page,
                    'limit' => $wantsAll ? $total : $limit,
                    'total' => $total,
                ],
            ]);
        }

        api_out(400, ['message' => 'Invalid action']);
    }

    if ($method === 'POST') {
        if (!$canCreateFinance) api_out(403, ['message' => 'You do not have permission to create finance records']);
        // POST /finance.php?action=create
        if ($action !== 'create') api_out(400, ['message' => 'Invalid action']);
        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        // Map only supported fields to the finance table
        $student_id = isset($payload['student_id']) ? trim((string)$payload['student_id']) : '';
        $amount = isset($payload['amount']) ? (float)$payload['amount'] : 0.0; // maps to balance_to_data
        $semester_id = isset($payload['semester_id']) ? (int)$payload['semester_id'] : null;
        $school_year_id = isset($payload['school_year_id']) ? (int)$payload['school_year_id'] : null;
        $date = isset($payload['date']) ? trim((string)$payload['date']) : date('Y-m-d');
        $balance_range = isset($payload['balance_range']) ? (int)$payload['balance_range'] : null;
        $period = api_normalize_period($payload['period'] ?? null);
        if ($period === false) {
            api_out(400, ['message' => 'period must be 1, 2 or 3, or left blank for a semester-total record']);
        }

        if ($student_id === '') api_out(400, ['message' => 'student_id is required']);
        $closedTerm = term_closure_block($pdo, [$school_year_id, $semester_id]);
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        $ins = $pdo->prepare('INSERT INTO finance (student_id, semester_id, balance_to_data, balance_range, `date`, school_year_id, period) VALUES (:sid, :sem, :amt, :br, :dt, :sy, :period)');
        $ins->execute([
            ':sid' => $student_id,
            ':sem' => $semester_id,
            ':amt' => $amount,
            ':br' => $balance_range,
            ':dt' => $date,
            ':sy' => $school_year_id,
            ':period' => $period,
        ]);
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare(FINANCE_ROW_SELECT . ' WHERE f.finance_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $r = $sel->fetch(PDO::FETCH_ASSOC);
        api_out(201, ['message' => 'Record created', 'data' => finance_map_row($r)]);
    }

    if ($method === 'PUT') {
        // PUT /finance.php?action=update&id=123
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid id is required']);

        $raw = file_get_contents('php://input');
        $payload = json_decode($raw, true);
        if (!is_array($payload)) api_out(400, ['message' => 'Invalid JSON']);

        if (!$canEditFinance) {
            api_out(403, ['message' => 'You do not have permission to update finance records']);
        }

        if ($amountOnlyFinanceEdit) {
            // Deliberately still just 'amount'. A finance user may correct a
            // balance; moving a record to a different periodical is a change to
            // which reading it is, and that belongs to whoever owns the term.
            $allowedKeys = ['amount'];
            $payloadKeys = array_keys($payload);
            $disallowedKeys = array_values(array_diff($payloadKeys, $allowedKeys));

            if (!empty($disallowedKeys)) {
                api_out(403, ['message' => 'Finance users can only update the student balance amount']);
            }
            if (!array_key_exists('amount', $payload)) {
                api_out(400, ['message' => 'amount is required']);
            }
        }

        // Where the record is AND where it would go - moving a balance out of a
        // closed semester changes that semester as surely as editing it.
        $rowTerm = term_closure_row_term($pdo, 'finance', $id) ?? [null, null];
        $closedTerm = term_closure_block(
            $pdo,
            $rowTerm,
            [
                array_key_exists('school_year_id', $payload) ? $payload['school_year_id'] : $rowTerm[0],
                array_key_exists('semester_id', $payload) ? $payload['semester_id'] : $rowTerm[1],
            ]
        );
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        $fields = [];
        $params = [':id' => $id];

        if (array_key_exists('student_id', $payload)) {
            $student_id = trim((string)$payload['student_id']);
            if ($student_id === '') api_out(400, ['message' => 'student_id cannot be empty']);
            $fields[] = 'student_id = :sid';
            $params[':sid'] = $student_id;
        }
        if (array_key_exists('amount', $payload)) {
            $amount = (float)$payload['amount'];
            $fields[] = 'balance_to_data = :amt';
            $params[':amt'] = $amount;
        }
        if (array_key_exists('semester_id', $payload)) { $fields[] = 'semester_id = :sem'; $params[':sem'] = ($payload['semester_id'] !== null ? (int)$payload['semester_id'] : null); }
        if (array_key_exists('school_year_id', $payload)) { $fields[] = 'school_year_id = :sy'; $params[':sy'] = ($payload['school_year_id'] !== null ? (int)$payload['school_year_id'] : null); }
        if (array_key_exists('date', $payload)) { $fields[] = '`date` = :dt'; $params[':dt'] = ($payload['date'] !== null ? (string)$payload['date'] : null); }
        if (array_key_exists('balance_range', $payload)) { $fields[] = 'balance_range = :br'; $params[':br'] = ($payload['balance_range'] !== null ? (int)$payload['balance_range'] : null); }
        if (array_key_exists('period', $payload)) {
            $period = api_normalize_period($payload['period']);
            if ($period === false) {
                api_out(400, ['message' => 'period must be 1, 2 or 3, or left blank for a semester-total record']);
            }
            $fields[] = 'period = :period';
            $params[':period'] = $period;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE finance SET ' . implode(', ', $fields) . ' WHERE finance_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare(FINANCE_ROW_SELECT . ' WHERE f.finance_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $r = $sel->fetch(PDO::FETCH_ASSOC);
        api_out(200, ['message' => 'Record updated', 'data' => finance_map_row($r)]);
    }

    if ($method === 'DELETE') {
        if (!$canDeleteFinance) api_out(403, ['message' => 'You do not have permission to delete finance records']);
        // DELETE /finance.php?action=delete&id=123
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid id is required']);

        $closedTerm = term_closure_block($pdo, term_closure_row_term($pdo, 'finance', $id) ?? [null, null]);
        if ($closedTerm !== null) api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);

        $del = $pdo->prepare('DELETE FROM finance WHERE finance_id = :id');
        $del->execute([':id' => $id]);

        api_out(200, ['message' => 'Record deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
