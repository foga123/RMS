<?php
/**
 * The contact log: every contact attempt a Contact Workspace user may see, as
 * rows to read, filter and export.
 *
 * The workspace shows one student's five latest attempts, inside that student's
 * card. That answers "what happened with this student" and nothing else - not
 * "what did I do this week", not "every referral to CSDL in September", and
 * nothing that can be handed to anyone as a file. This is the same attempt log,
 * flat, filtered and paged on the server so an export can hold all of it.
 *
 * WHO SEES WHAT
 *
 * The workspace's own scope - student_contact_visibility_clause() and the
 * cohort a coordinator or caller is limited to - widened by one rule: an
 * account always sees the attempts it made itself. A caller whose student was
 * reassigned still has the call they made in their own log.
 *
 * WHOSE ATTEMPTS
 *
 * Every writer's, not only this workspace's. The Faculty Workspace's periodical
 * contacts and CSDL's home-visit outcomes are attempts on the same students,
 * and the card's history already shows them; a log that left them out would
 * disagree with the card. "Conducted by" says whose each one was.
 */

require_once __DIR__ . '/../student_contact_workflow_lib.php';
require_once __DIR__ . '/calendar_date.php';

/** The most rows one request returns. An export walks the pages. */
const CONTACT_LOG_MAX_LIMIT = 500;

/** The outcome filter's value for "no outcome recorded". */
const CONTACT_LOG_NO_OUTCOME = 'none';

/**
 * The request's filters, checked. Throws InvalidArgumentException, which the
 * endpoint answers with a 400.
 *
 * A bad date is refused rather than dropped. Dropping it would quietly widen the
 * log to every date, and an export taken that way looks exactly like the one
 * that was asked for.
 */
function contact_log_filters(array $query): array
{
    foreach (['from' => 'The start date', 'to' => 'The end date'] as $key => $label) {
        $error = api_calendar_date_error(isset($query[$key]) ? (string)$query[$key] : null, $label, false);
        if ($error !== null) {
            throw new InvalidArgumentException($error);
        }
    }
    $from = api_calendar_date_value(isset($query['from']) ? (string)$query['from'] : null);
    $to = api_calendar_date_value(isset($query['to']) ? (string)$query['to'] : null);
    if ($from !== null && $to !== null && $from > $to) {
        throw new InvalidArgumentException('The start date is after the end date.');
    }

    $conductedBy = trim((string)($query['conducted_by'] ?? ''));
    if ($conductedBy !== '' && !ctype_digit($conductedBy)) {
        throw new InvalidArgumentException('conducted_by must be a user id.');
    }

    return [
        'from' => $from,
        'to' => $to,
        'channel' => strtolower(trim((string)($query['channel'] ?? ''))),
        'outcome' => strtolower(trim((string)($query['outcome'] ?? ''))),
        'conducted_by' => $conductedBy === '' ? null : (int)$conductedBy,
        'search' => trim((string)($query['search'] ?? '')),
        'page' => max(1, (int)($query['page'] ?? 1)),
        'limit' => max(1, min(CONTACT_LOG_MAX_LIMIT, (int)($query['limit'] ?? 20))),
    ];
}

/**
 * The attempts this account may see, as one bracketed WHERE condition over
 * `a` (the attempt), `st` (its student) and `c` (the student's course).
 */
function contact_log_scope(PDO $pdo, array $access): array
{
    $visibility = student_contact_visibility_clause($pdo, $access, 'c.department_id', 'a.student_id');
    $sql = '(1 = 1' . $visibility['sql'];
    $params = $visibility['params'];

    if (!empty($access['student_type_scope'])) {
        // Backticked: the column's name has a space in it.
        $sql .= ' AND st.`star e-profile` = :log_student_type';
        $params[':log_student_type'] = $access['student_type_scope'];
    }
    $sql .= ')';

    $userId = (int)($access['user_id'] ?? 0);
    if ($userId > 0) {
        $sql = '(' . $sql . ' OR a.attempted_by_user_id = :log_actor_id)';
        $params[':log_actor_id'] = $userId;
    }

    return ['sql' => $sql, 'params' => $params];
}

/** The joins every query here reads through. */
function contact_log_from_sql(): string
{
    return ' FROM student_contact_attempt a
             INNER JOIN student st ON st.student_id = a.student_id
             LEFT JOIN course c ON c.course_id = st.course_id
             LEFT JOIN department d ON d.department_id = c.department_id
             LEFT JOIN user u ON u.user_id = a.attempted_by_user_id
             LEFT JOIN role r ON r.role_id = a.attempted_by_role_id
             LEFT JOIN contact_reason cr ON cr.reason_id = a.reason_id
             LEFT JOIN contact_recovery_plan rp ON rp.plan_id = a.recovery_plan_id';
}

/** Run a prepared statement with every parameter bound by its type. */
function contact_log_execute(PDO $pdo, string $sql, array $params): PDOStatement
{
    $stmt = $pdo->prepare($sql);
    foreach ($params as $name => $value) {
        $stmt->bindValue($name, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    return $stmt;
}

/**
 * The filtered, paged log with its totals, and the options each filter offers.
 */
function contact_log(PDO $pdo, array $access, array $filters): array
{
    $scope = contact_log_scope($pdo, $access);
    $from = contact_log_from_sql();

    $where = [$scope['sql']];
    $params = $scope['params'];

    // Both ends inclusive: `to` is compared with the start of the next day, or a
    // range ending today would leave out everything after midnight.
    if ($filters['from'] !== null) {
        $where[] = 'a.contacted_at >= :log_from';
        $params[':log_from'] = $filters['from'] . ' 00:00:00';
    }
    if ($filters['to'] !== null) {
        $where[] = 'a.contacted_at < DATE_ADD(:log_to, INTERVAL 1 DAY)';
        $params[':log_to'] = $filters['to'] . ' 00:00:00';
    }
    if ($filters['channel'] !== '') {
        $where[] = 'a.contact_method = :log_channel';
        $params[':log_channel'] = $filters['channel'];
    }
    if ($filters['outcome'] === CONTACT_LOG_NO_OUTCOME) {
        $where[] = "(a.intervention_status IS NULL OR a.intervention_status = '')";
    } elseif ($filters['outcome'] !== '') {
        $where[] = 'a.intervention_status = :log_outcome';
        $params[':log_outcome'] = $filters['outcome'];
    }
    if ($filters['conducted_by'] !== null) {
        $where[] = 'a.attempted_by_user_id = :log_conducted_by';
        $params[':log_conducted_by'] = $filters['conducted_by'];
    }
    if ($filters['search'] !== '') {
        // A student by number or by name, either way round. Wildcards typed
        // into the box are matched as themselves.
        $like = '%' . addcslashes($filters['search'], '%_\\') . '%';
        $where[] = "(st.student_number LIKE :log_q1
                     OR CONCAT_WS(' ', st.first_name, st.last_name) LIKE :log_q2
                     OR CONCAT_WS(', ', st.last_name, st.first_name) LIKE :log_q3)";
        $params[':log_q1'] = $like;
        $params[':log_q2'] = $like;
        $params[':log_q3'] = $like;
    }
    $whereSql = ' WHERE ' . implode(' AND ', $where);

    $totals = contact_log_execute(
        $pdo,
        'SELECT COUNT(*) AS total,
                COUNT(DISTINCT a.student_id) AS students,
                COUNT(DISTINCT a.attempted_by_user_id) AS conductors' . $from . $whereSql,
        $params
    )->fetch(PDO::FETCH_ASSOC) ?: [];
    $total = (int)($totals['total'] ?? 0);

    $limit = (int)$filters['limit'];
    $page = (int)$filters['page'];
    $offset = ($page - 1) * $limit;

    // Newest first, and the attempt id breaks a tie: two attempts logged in
    // the same second still come back in the order they were saved.
    $rows = contact_log_execute(
        $pdo,
        "SELECT a.attempt_id, a.student_id, a.contacted_at, a.contact_method, a.other_method_label,
                a.contact_status, a.intervention_status, a.other_reason_label, a.notes,
                a.attempted_by_user_id,
                st.student_number, st.first_name, st.last_name, st.year_level, st.section,
                c.course_code, c.course_name, d.department_name,
                u.first_name AS actor_first_name, u.last_name AS actor_last_name,
                r.role_name AS actor_role_name,
                cr.reason_text, rp.plan_text"
            . $from . $whereSql
            . " ORDER BY a.contacted_at DESC, a.attempt_id DESC LIMIT {$limit} OFFSET {$offset}",
        $params
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    return [
        'data' => array_map(static fn(array $row): array => contact_log_row($pdo, $row), $rows),
        'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total],
        'summary' => [
            'attempts' => $total,
            'students' => (int)($totals['students'] ?? 0),
            'conductors' => (int)($totals['conductors'] ?? 0),
        ],
        'facets' => contact_log_facets($pdo, $scope),
    ];
}

/**
 * One attempt, in the words a reader and a spreadsheet want.
 *
 * The channel and the outcome are worded by the same functions the card's
 * history uses, so the log and the card cannot name one attempt two ways.
 */
function contact_log_row(PDO $pdo, array $row): array
{
    $outcomeKey = strtolower(trim((string)($row['intervention_status'] ?? '')));
    $reason = trim((string)($row['reason_text'] ?? ''));
    $reasonDetail = trim((string)($row['other_reason_label'] ?? ''));
    $channelKey = strtolower(trim((string)($row['contact_method'] ?? '')));

    return [
        'id' => (int)$row['attempt_id'],
        'attempt_id' => (int)$row['attempt_id'],
        'contacted_at' => student_contact_iso_datetime($row['contacted_at'] ?? null),
        'student_id' => (int)$row['student_id'],
        'student_number' => (string)($row['student_number'] ?? ''),
        'first_name' => (string)($row['first_name'] ?? ''),
        'last_name' => (string)($row['last_name'] ?? ''),
        'year_level' => isset($row['year_level']) ? (int)$row['year_level'] : null,
        'section' => (string)($row['section'] ?? ''),
        'course_code' => (string)($row['course_code'] ?? ''),
        'course_name' => (string)($row['course_name'] ?? ''),
        'department_name' => (string)($row['department_name'] ?? ''),
        'channel_key' => $channelKey,
        'channel' => student_contact_channel_label($pdo, $channelKey, $row['other_method_label'] ?? null) ?: 'Not Recorded',
        'outcome_key' => $outcomeKey,
        'outcome' => student_contact_outcome_label($outcomeKey),
        'contact_status' => student_contact_status_label($row['contact_status'] ?? ''),
        // The free text a "... - Others" reason asks for, kept with its reason.
        'reason' => $reason !== '' && $reasonDetail !== '' ? "$reason ($reasonDetail)" : ($reason !== '' ? $reason : $reasonDetail),
        'recovery_plan' => (string)($row['plan_text'] ?? ''),
        'notes' => student_contact_normalize_text($row['notes'] ?? null) ?? '',
        'conducted_by_user_id' => isset($row['attempted_by_user_id']) ? (int)$row['attempted_by_user_id'] : null,
        'conducted_by' => student_contact_format_name($row, 'actor_first_name', 'actor_last_name'),
        'conducted_by_role' => $row['actor_role_name'] ?? null,
    ];
}

/**
 * What each filter can offer: the channels, outcomes and people that appear in
 * this account's scope, with how many attempts each has.
 *
 * Read over the whole scope rather than the filtered rows, so choosing one
 * channel does not empty the channel list of every other choice.
 */
function contact_log_facets(PDO $pdo, array $scope): array
{
    $from = contact_log_from_sql();
    $where = ' WHERE ' . $scope['sql'];

    $channels = [];
    foreach (contact_log_execute(
        $pdo,
        'SELECT a.contact_method AS channel_key, COUNT(*) AS attempts'
            . $from . $where . ' GROUP BY a.contact_method ORDER BY attempts DESC, a.contact_method',
        $scope['params']
    )->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $key = strtolower(trim((string)$row['channel_key']));
        $channels[] = [
            'key' => $key,
            'label' => student_contact_channel_label($pdo, $key) ?: 'Not Recorded',
            'count' => (int)$row['attempts'],
        ];
    }

    $outcomes = [];
    foreach (contact_log_execute(
        $pdo,
        "SELECT COALESCE(a.intervention_status, '') AS outcome_key, COUNT(*) AS attempts"
            . $from . $where . " GROUP BY COALESCE(a.intervention_status, '') ORDER BY attempts DESC",
        $scope['params']
    )->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $key = strtolower(trim((string)$row['outcome_key']));
        $outcomes[] = $key === ''
            ? ['key' => CONTACT_LOG_NO_OUTCOME, 'label' => 'No outcome recorded', 'count' => (int)$row['attempts']]
            : ['key' => $key, 'label' => student_contact_outcome_label($key) ?? $key, 'count' => (int)$row['attempts']];
    }

    $conductors = [];
    foreach (contact_log_execute(
        $pdo,
        'SELECT a.attempted_by_user_id AS user_id, MAX(u.first_name) AS actor_first_name,
                MAX(u.last_name) AS actor_last_name, MAX(r.role_name) AS role_name, COUNT(*) AS attempts'
            . $from . $where . ' AND a.attempted_by_user_id IS NOT NULL
             GROUP BY a.attempted_by_user_id ORDER BY actor_last_name, actor_first_name',
        $scope['params']
    )->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $conductors[] = [
            'user_id' => (int)$row['user_id'],
            'name' => student_contact_format_name($row, 'actor_first_name', 'actor_last_name') ?: ('User #' . (int)$row['user_id']),
            'role' => $row['role_name'] ?? null,
            'count' => (int)$row['attempts'],
        ];
    }

    return ['channels' => $channels, 'outcomes' => $outcomes, 'conductors' => $conductors];
}
