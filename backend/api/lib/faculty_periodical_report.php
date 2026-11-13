<?php
require_once __DIR__ . '/faculty_workspace.php';

/** Report visibility never trusts role, cohort or department query parameters. */
function faculty_report_scope(PDO $pdo, array $user): array
{
    if (api_session_user_has_role($user, ['admin', 'ssg'])) {
        return ['sql' => '', 'params' => []];
    }
    if (api_user_is_department_pinned($user) || api_session_user_has_role($user, ['dept-caller'])) {
        $department = (int)($user['department_id'] ?? $user['department'] ?? 0);
        return $department > 0
            ? ['sql' => ' AND ' . api_department_scope_sql('c.department_id'), 'params' => [':department_id' => $department]]
            : ['sql' => ' AND 1 = 0', 'params' => []];
    }
    $access = student_contact_resolve_access($user);
    if (empty($access['is_coordinator']) && empty($access['is_ssp_caller'])) {
        return ['sql' => ' AND 1 = 0', 'params' => []];
    }
    $scope = student_contact_visibility_clause($pdo, $access, 'c.department_id', 'st.student_id');
    $cohort = $access['student_type_scope'] ?? null;
    if (!$cohort) {
        return ['sql' => ' AND 1 = 0', 'params' => []];
    }
    $scope['sql'] .= ' AND st.`star e-profile` = :report_cohort';
    $scope['params'][':report_cohort'] = $cohort;
    return $scope;
}

function faculty_report_filters(array $query, array $calendar): array
{
    $result = [];
    foreach (['school_year_id', 'semester_id', 'period'] as $key) {
        $value = $query[$key] ?? $calendar[$key] ?? null;
        if (!is_scalar($value) || !ctype_digit((string)$value) || (int)$value < 1
            || ($key === 'period' && (int)$value > 3)) {
            throw new InvalidArgumentException('Choose a school year, semester and periodical (P1–P3).');
        }
        $result[$key] = (int)$value;
    }
    $outcome = $query['outcome'] ?? '';
    if (!is_string($outcome) || !in_array($outcome, array_merge(['', 'not_recorded'], array_keys(FACULTY_PERIODICAL_OUTCOMES)), true)) {
        throw new InvalidArgumentException('Choose a valid faculty outcome.');
    }
    $result['outcome'] = $outcome;
    if (isset($query['search']) && !is_string($query['search'])) {
        throw new InvalidArgumentException('Search must be text.');
    }
    $result['search'] = mb_substr(trim($query['search'] ?? ''), 0, 120);
    foreach (['page' => 1, 'limit' => 20, 'student_id' => 0] as $key => $default) {
        $value = $query[$key] ?? $default;
        if (!is_scalar($value) || !ctype_digit((string)$value)) {
            throw new InvalidArgumentException($key . ' must be a nonnegative integer.');
        }
        $result[$key] = (int)$value;
    }
    $result['page'] = max(1, $result['page']);
    $result['limit'] = min(100, max(1, $result['limit']));
    return $result;
}

function faculty_report_query(PDO $pdo, string $sql, array $params): PDOStatement
{
    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    return $stmt;
}

/** A faculty observation is not the caller case's latest-attempt pointer. */
function faculty_report_data(PDO $pdo, array $user, array $filters): array
{
    $scope = faculty_report_scope($pdo, $user);
    $params = $scope['params'] + [':report_year' => $filters['school_year_id'],
        ':report_semester' => $filters['semester_id'], ':report_period' => $filters['period']];
    // Restrict before MAX: a later P3 update must never hide the student's P1 observation.
    $from = ' FROM student st LEFT JOIN course c ON c.course_id = st.course_id
        LEFT JOIN department d ON d.department_id = c.department_id
        LEFT JOIN student_contact_attempt fa ON fa.attempt_id = (
            SELECT MAX(f.attempt_id) FROM student_contact_attempt f
            WHERE f.student_id = st.student_id AND f.attempted_by_role_id = 15
              AND f.intervention_status IN ("continuing", "shifting", "stopping", "undecided")
              AND f.school_year_id = :report_year AND f.semester_id = :report_semester
              AND f.period = :report_period)
        LEFT JOIN user actor ON actor.user_id = fa.attempted_by_user_id
        LEFT JOIN contact_reason reason ON reason.reason_id = fa.reason_id';
    $where = ' WHERE st.archived_at IS NULL' . $scope['sql'];
    if ($filters['student_id']) {
        $where .= ' AND st.student_id = :report_student';
        $params[':report_student'] = $filters['student_id'];
    }
    if ($filters['search'] !== '') {
        $where .= ' AND (st.student_number LIKE :q1 OR CONCAT_WS(" ", st.first_name, st.last_name) LIKE :q2 OR st.section LIKE :q3)';
        foreach ([':q1', ':q2', ':q3'] as $key) {
            $params[$key] = '%' . addcslashes($filters['search'], '%_\\') . '%';
        }
    }
    if ($filters['outcome'] === 'not_recorded') {
        $where .= ' AND fa.attempt_id IS NULL';
    } elseif ($filters['outcome'] !== '') {
        $where .= ' AND fa.intervention_status = :report_outcome';
        $params[':report_outcome'] = $filters['outcome'];
    }
    $summary = faculty_report_query($pdo, 'SELECT COUNT(*) AS total,
        COALESCE(SUM(fa.attempt_id IS NULL),0) AS not_recorded,
        COALESCE(SUM(fa.intervention_status = "continuing"),0) AS continuing,
        COALESCE(SUM(fa.intervention_status IN ("shifting","stopping","undecided")),0) AS concerns'
        . $from . $where, $params)->fetch(PDO::FETCH_ASSOC);
    $summary = array_map('intval', $summary);
    $page = min($filters['page'], max(1, (int)ceil($summary['total'] / $filters['limit'])));
    $offset = ($page - 1) * $filters['limit'];
    $rows = faculty_report_query($pdo, 'SELECT st.student_id, st.student_number, st.first_name,
        st.last_name, st.year_level, st.section, st.`star e-profile` AS student_type,
        c.course_id, c.course_code, c.course_name, c.department_id, d.department_name,
        fa.attempt_id, fa.intervention_status AS faculty_outcome, fa.contacted_at,
        fa.notes, fa.other_reason_label, reason.reason_text,
        TRIM(CONCAT_WS(" ", actor.first_name, actor.last_name)) AS faculty_name'
        . $from . $where . ' ORDER BY st.last_name, st.first_name, st.student_id LIMIT '
        . $filters['limit'] . ' OFFSET ' . $offset, $params)->fetchAll(PDO::FETCH_ASSOC);

    $ids = array_map('intval', array_column($rows, 'student_id'));
    $history = [];
    $assignments = [];
    $priorities = [];
    if ($ids) {
        $idList = implode(',', $ids);
        $termParams = [':year' => $filters['school_year_id'], ':semester' => $filters['semester_id']];
        $history = faculty_report_query($pdo, 'SELECT a.student_id, a.attempt_id, a.period,
            a.attempted_by_role_id, a.intervention_status AS outcome, a.contacted_at,
            a.notes, a.other_reason_label, r.reason_text,
            TRIM(CONCAT_WS(" ", u.first_name, u.last_name)) AS actor_name,
            actor_role.role_name AS actor_role_name
            FROM student_contact_attempt a LEFT JOIN user u ON u.user_id = a.attempted_by_user_id
            LEFT JOIN role actor_role ON actor_role.role_id = a.attempted_by_role_id
            LEFT JOIN contact_reason r ON r.reason_id = a.reason_id
            WHERE a.student_id IN (' . $idList . ') AND a.school_year_id = :year
              AND a.semester_id = :semester
            ORDER BY a.contacted_at DESC, a.attempt_id DESC', $termParams)->fetchAll(PDO::FETCH_ASSOC);
        if (student_contact_has_ssp_assignment_table($pdo)) {
            $assignedRows = faculty_report_query($pdo, 'SELECT ssa.student_id,
                TRIM(CONCAT_WS(" ", u.first_name, u.last_name)) AS worker
                FROM ssp_assignment ssa JOIN user u ON u.user_id = ssa.caller_user_id
                WHERE ssa.student_id IN (' . $idList . ') ORDER BY u.last_name, u.first_name', [])->fetchAll(PDO::FETCH_ASSOC);
            foreach ($assignedRows as $assignment) {
                $assignments[(int)$assignment['student_id']][] = $assignment['worker'];
            }
        }
        $signals = pdo_load_signals($pdo, $ids, $filters['semester_id'], $filters['school_year_id'], $filters['period']);
        $settings = pdo_settings($pdo);
        foreach ($rows as $row) {
            $id = (int)$row['student_id'];
            $priorities[$id] = pdo_classify_student($row, $signals['grades'][$id] ?? null,
                $signals['attendance'][$id] ?? null, $signals['finance'][$id] ?? null, $settings);
            if (!isset($signals['grades'][$id]) && !isset($signals['attendance'][$id]) && !isset($signals['finance'][$id])) {
                $priorities[$id]['priority_label'] = 'No records for this periodical';
            }
        }
    }
    $historyByStudent = [];
    foreach ($history as $attempt) {
        $historyByStudent[(int)$attempt['student_id']][] = $attempt;
    }
    foreach ($rows as &$row) {
        $id = (int)$row['student_id'];
        $row['student_id'] = $id;
        $row['student_name'] = trim($row['last_name'] . ', ' . $row['first_name']);
        $row['faculty_outcome_label'] = $row['attempt_id'] ? faculty_periodical_outcome_label($row['faculty_outcome']) : 'Not recorded';
        $row['reason'] = faculty_reason_label($row['reason_text'], $row['other_reason_label']);
        $row['priority_label'] = $priorities[$id]['priority_label'] ?? 'Not assessed';
        $row['assigned_staff'] = array_values(array_unique($assignments[$id] ?? []));
        $row['follow_up'] = 'No faculty update';
        if ($row['attempt_id']) {
            $row['follow_up'] = $row['faculty_outcome'] === 'continuing' ? 'No concern reported' : 'Awaiting follow-up';
        }
        $row['follow_up_at'] = null;
        $row['follow_up_by'] = null;
        foreach ($historyByStudent[$id] ?? [] as $attempt) {
            if (!$row['attempt_id']
                || (int)$attempt['attempt_id'] <= (int)$row['attempt_id']
                || $attempt['contacted_at'] < $row['contacted_at']
                || (!empty($attempt['period']) && (int)$attempt['period'] !== $filters['period'])
                || (int)$attempt['attempted_by_role_id'] === 15
                || !in_array($attempt['outcome'], ['recovered', 'not_recovered', 'referred_to_csdl', 'unreachable'], true)) {
                continue;
            }
            $row['follow_up'] = student_contact_outcome_label($attempt['outcome']) ?? $attempt['outcome'];
            $row['follow_up_at'] = $attempt['contacted_at'];
            $row['follow_up_by'] = $attempt['actor_name'];
            break;
        }
    }
    unset($row);
    $detailHistory = [];
    if ($filters['student_id'] && $rows) {
        foreach ($history as $attempt) {
            $attempt['outcome_label'] = student_contact_outcome_label($attempt['outcome']) ?? $attempt['outcome'];
            $attempt['reason'] = faculty_reason_label($attempt['reason_text'], $attempt['other_reason_label']);
            $detailHistory[] = $attempt;
        }
    }
    return ['rows' => $rows, 'summary' => $summary, 'page' => $page, 'limit' => $filters['limit'],
        'term' => array_intersect_key($filters, array_flip(['school_year_id','semester_id','period'])),
        'history' => $detailHistory];
}
