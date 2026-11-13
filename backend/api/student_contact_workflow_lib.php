<?php

// The follow-up queue decides who appears in this workspace at all; see the
// membership clause in student_contact_base_rows().
require_once __DIR__ . '/lib/follow_up_queue.php';
// The sheet's four caller dropdowns: channel, reason, recovery plan and
// intervention status. See contact_vocabulary.php for why two of them live in
// code and two in the database.
require_once __DIR__ . '/contact_vocabulary.php';
// The PDO segment matrix. The queue is ranked by the same priority the
// prioritization screen shows, so a caller and a coordinator looking at the same
// student never read two different numbers off two different scales.
require_once __DIR__ . '/pdo_priority_lib.php';
// Which term the school is in. The workspace header states it, and a new
// enrollment standing is opened in it -- see student_contact_current_term().
require_once __DIR__ . '/lib/academic_calendar.php';
// Closed semesters. A call or a visit outcome that would write into one goes to
// the current term instead -- see lib/term_closure.php.
require_once __DIR__ . '/lib/term_closure.php';

const STUDENT_CONTACT_STATUS_LABELS = [
    'contacted' => 'Contacted',
    'no_response' => 'No Response',
    'pending' => 'Pending',
    'follow_up_needed' => 'Follow Up Needed',
];
const STUDENT_CONTACT_HOME_VISIT_STATUS_KEYS = ['no_response', 'follow_up_needed'];

/**
 * The contact status each Intervention Status implies.
 *
 * Current behaviour: the caller picked a contact status (Contacted / No
 * Response / Pending / Follow Up Needed) from a dropdown of its own, alongside
 * the Intervention Status.
 *
 * Problem: the two fields answered overlapping questions and could disagree.
 * Nothing stopped an attempt reading "No Response" with an outcome of
 * RECOVERED, and the case workflow followed the contact status, so the outcome
 * the caller actually recorded had no effect on where the student went next.
 * The sheet has no contact-status column; it has Intervention Status.
 *
 * Change: the dropdown is gone and the status is derived here. Intervention
 * Status is the single thing a caller records about how the call went, and the
 * case follows it.
 *
 * Reason: one field cannot contradict itself. The stored column is unchanged,
 * so every existing attempt, filter, summary and chart keeps reading.
 *
 * A blank outcome stays Pending: an attempt may be logged before anyone knows
 * how it went, and that is not the same statement as "nobody answered".
 */
const STUDENT_CONTACT_STATUS_BY_INTERVENTION = [
    'recovered'           => 'contacted',
    'not_recovered'       => 'follow_up_needed',
    'referred_to_csdl'    => 'follow_up_needed',
    'cbr_follow_up'       => 'follow_up_needed',
    'undecided_follow_up' => 'follow_up_needed',
    'unreachable'         => 'no_response',
];

/**
 * The contact status label for an intervention status key.
 *
 * Everything except RECOVERED and a blank outcome lands on a home-visit status,
 * which is the point: those are the outcomes that mean the student still needs
 * chasing, and escalation already keys off that list. REFERRED TO CSDL
 * escalating is the referral itself - role 8 is notified by the same path.
 */
function student_contact_status_for_intervention(?string $interventionKey): string
{
    $key = (string)$interventionKey;
    if (!isset(STUDENT_CONTACT_STATUS_BY_INTERVENTION[$key])) {
        return STUDENT_CONTACT_STATUS_LABELS['pending'];
    }

    return STUDENT_CONTACT_STATUS_LABELS[STUDENT_CONTACT_STATUS_BY_INTERVENTION[$key]];
}
const STUDENT_CONTACT_STATUS_TYPE = 'contact_workspace';
const STUDENT_CONTACT_AUDIT_ACTION = 'student_contact_status_updated';
const STUDENT_HOME_VISIT_AUDIT_ACTION = 'student_home_visit_updated';
const STUDENT_HOME_VISIT_QUEUE_STATUSES = ['queued', 'scheduled', 'completed'];

function student_contact_normalize_text($value): ?string
{
    if ($value === null) {
        return null;
    }

    $text = trim((string)$value);
    return $text === '' ? null : $text;
}

function student_contact_normalize_token($value): string
{
    $token = strtolower(trim((string)$value));
    if ($token === '') {
        return '';
    }

    $token = str_replace(['-', ' '], '_', $token);
    $token = preg_replace('/[^a-z0-9_]+/', '', $token) ?: '';
    return trim($token, '_');
}

function student_contact_status_key($value): string
{
    $token = student_contact_normalize_token($value);
    if ($token === '') {
        return '';
    }

    if (isset(STUDENT_CONTACT_STATUS_LABELS[$token])) {
        return $token;
    }

    foreach (STUDENT_CONTACT_STATUS_LABELS as $key => $label) {
        if ($token === student_contact_normalize_token($label)) {
            return $key;
        }
    }

    return '';
}

function student_contact_status_label($value): string
{
    $key = student_contact_status_key($value);
    if ($key !== '' && isset(STUDENT_CONTACT_STATUS_LABELS[$key])) {
        return STUDENT_CONTACT_STATUS_LABELS[$key];
    }

    return STUDENT_CONTACT_STATUS_LABELS['pending'];
}

const STUDENT_ENROLLMENT_STATUS_TYPE = 'enrollment';

/** Enrolled is a registrar fact, not a phone outcome. See below. */
const STUDENT_ENROLLMENT_STATUS_NOT_CALLABLE = ['enrolled'];

/**
 * The enrollment outcomes a caller may record.
 *
 * Read from the `status` table rather than listed here, because the institution
 * already defines them - Will Enroll, To Stop, Undecided, CBR, WFR and the rest.
 * Hardcoding a second list is how the dropdown and the database start
 * disagreeing about what a status means.
 *
 * Enrolled is the one exception and is filtered out. It is not something a
 * caller can establish on the phone: a student is Enrolled when the registrar's
 * records say so, and a caller who hears "yes I already enrolled" is repeating
 * what the student believes. Will Enroll is the answer that call actually
 * produces. Filtering here rather than only in the dropdown is what makes it
 * enforced - the validator below checks against this same list, so a request
 * naming Enrolled is refused whatever sent it.
 */
function student_contact_enrollment_options(PDO $pdo): array
{
    static $cache = [];
    $key = spl_object_id($pdo);
    if (isset($cache[$key])) {
        return $cache[$key];
    }

    $hasArchivedAt = student_contact_column_exists($pdo, 'status', 'archived_at');
    $sql = 'SELECT status_id, status_name FROM status WHERE status_type = :status_type';
    if ($hasArchivedAt) {
        $sql .= ' AND archived_at IS NULL';
    }
    // In the office's order (latest.xlsx), not insertion order: the five
    // statuses added on 2026-10-06 have the highest ids and would otherwise
    // land after Undecided instead of inside the "Will not continue" run.
    $sql .= ' ORDER BY sort_order ASC, status_id ASC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':status_type' => STUDENT_ENROLLMENT_STATUS_TYPE]);

    $options = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $name = (string)$row['status_name'];
        if (in_array(student_contact_normalize_token($name), STUDENT_ENROLLMENT_STATUS_NOT_CALLABLE, true)) {
            continue;
        }
        $options[] = [
            'status_id' => (int)$row['status_id'],
            'status_name' => $name,
        ];
    }

    $cache[$key] = $options;
    return $options;
}

/**
 * Resolve a caller's chosen enrollment outcome to a status id, or 0.
 *
 * Accepts either the id or the name so the client may send whichever it holds,
 * and validates both against the `enrollment` rows specifically. That validation
 * is the point: the workspace used to write the CONTACT status into
 * enrollment_status.status_type, which is why that column currently holds rows
 * reading 'Contacted' and 'Pending' - contact_workspace values sitting in a
 * column whose join renders them as the student's enrollment standing.
 */
function student_contact_enrollment_status_id(PDO $pdo, $value): int
{
    $options = student_contact_enrollment_options($pdo);
    if ($value === null || $value === '') {
        return 0;
    }

    if (is_numeric($value)) {
        $id = (int)$value;
        foreach ($options as $option) {
            if ($option['status_id'] === $id) {
                return $id;
            }
        }
        return 0;
    }

    $token = student_contact_normalize_token($value);
    foreach ($options as $option) {
        if (student_contact_normalize_token($option['status_name']) === $token) {
            return $option['status_id'];
        }
    }

    return 0;
}

function student_contact_enrollment_status_needs_reason(PDO $pdo, $value): bool
{
    if ($value === null || $value === '') {
        return false;
    }

    $name = (string)$value;
    if (is_numeric($value)) {
        $wantedId = (int)$value;
        $name = '';
        foreach (student_contact_enrollment_options($pdo) as $option) {
            if ((int)$option['status_id'] === $wantedId) {
                $name = (string)$option['status_name'];
                break;
            }
        }
    }

    $token = student_contact_normalize_token($name);
    return $token === 'to_stop'
        || $token === 'not_enrolled'
        || strpos($token, 'stop') !== false
        || strpos($token, 'will_not_continue') !== false;
}

/**
 * The term a contact attempt files new work under: the Academic Calendar's.
 *
 * This used to be read as "the newest row in enrollment_status", which is a
 * different question that only looks like the same one. The newest row is
 * whatever happened to be inserted last, and on 2026-09-03 that was 2nd
 * Semester 2025-2026 while the calendar said 1st Semester 2026-2027 -- so a
 * standing opened by a call today was filed against the previous school year,
 * and then became the "newest" row that misdirected the next one.
 *
 * The old read stays as the fallback, for a calendar that cannot name a term.
 * Nulls are still an acceptable answer if neither can: the row exists to hold
 * the standing this call is about to set, and refusing the call over a missing
 * term would lose the work that was actually done.
 *
 * @return array{semester_id: ?int, school_year_id: ?int}
 */
function student_contact_current_term(PDO $pdo): array
{
    $calendar = academic_calendar_current($pdo);
    $semesterId = (int)($calendar['semester_id'] ?? 0);
    $schoolYearId = (int)($calendar['school_year_id'] ?? 0);
    if ($semesterId > 0 && $schoolYearId > 0) {
        return ['semester_id' => $semesterId, 'school_year_id' => $schoolYearId];
    }

    $fallback = $pdo->query(
        'SELECT semester_id, school_year_id FROM enrollment_status
         ORDER BY enrollment_status_id DESC LIMIT 1'
    )->fetch(PDO::FETCH_ASSOC) ?: [];

    return [
        'semester_id' => isset($fallback['semester_id']) ? (int)$fallback['semester_id'] : null,
        'school_year_id' => isset($fallback['school_year_id']) ? (int)$fallback['school_year_id'] : null,
    ];
}

function student_contact_is_home_visit_status($value): bool
{
    return in_array(student_contact_status_key($value), STUDENT_CONTACT_HOME_VISIT_STATUS_KEYS, true);
}

function student_contact_format_name(array $row, string $firstKey = 'first_name', string $lastKey = 'last_name'): string
{
    $firstName = trim((string)($row[$firstKey] ?? ''));
    $lastName = trim((string)($row[$lastKey] ?? ''));
    return trim($firstName . ' ' . $lastName);
}

function student_contact_now(): DateTimeImmutable
{
    return new DateTimeImmutable('now');
}

function student_contact_iso_datetime(?string $value): ?string
{
    $text = trim((string)$value);
    if ($text === '') {
        return null;
    }

    try {
        return (new DateTimeImmutable($text))->format('Y-m-d H:i:s');
    } catch (Throwable $throwable) {
        return null;
    }
}

function student_contact_combine_date_time(?string $dateValue, ?string $timeValue): ?string
{
    $dateText = trim((string)$dateValue);
    $timeText = trim((string)$timeValue);
    if ($dateText === '' || $timeText === '') {
        return null;
    }

    return student_contact_iso_datetime($dateText . ' ' . $timeText);
}

function student_contact_table_exists(PDO $pdo, string $table): bool
{
    static $cache = [];

    $key = spl_object_id($pdo) . ':' . strtolower($table);
    if (array_key_exists($key, $cache)) {
        return $cache[$key];
    }

    $stmt = $pdo->prepare('SHOW TABLES LIKE :table_name');
    $stmt->execute([':table_name' => $table]);
    $cache[$key] = (bool)$stmt->fetch(PDO::FETCH_NUM);

    return $cache[$key];
}

function student_contact_column_exists(PDO $pdo, string $table, string $column): bool
{
    static $cache = [];

    $key = spl_object_id($pdo) . ':' . strtolower($table) . ':' . strtolower($column);
    if (array_key_exists($key, $cache)) {
        return $cache[$key];
    }

    if (!student_contact_table_exists($pdo, $table)) {
        $cache[$key] = false;
        return false;
    }

    $stmt = $pdo->prepare("SHOW COLUMNS FROM `$table` LIKE :column_name");
    $stmt->execute([':column_name' => $column]);
    $cache[$key] = (bool)$stmt->fetch(PDO::FETCH_ASSOC);

    return $cache[$key];
}

function student_contact_ensure_status_rows(PDO $pdo): void
{
    api_require_table($pdo, 'status');

    $hasArchivedAt = student_contact_column_exists($pdo, 'status', 'archived_at');
    $sql = 'SELECT status_id, status_name, status_type' . ($hasArchivedAt ? ', archived_at' : '') . ' FROM status';
    $rows = $pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $existing = [];
    foreach ($rows as $row) {
        if (
            $hasArchivedAt
            && student_contact_normalize_text($row['archived_at'] ?? null) !== null
        ) {
            continue;
        }

        $typeKey = strtolower(trim((string)($row['status_type'] ?? '')));
        $nameKey = student_contact_status_key($row['status_name'] ?? '');
        if ($typeKey === STUDENT_CONTACT_STATUS_TYPE && $nameKey !== '') {
            $existing[$nameKey] = (int)($row['status_id'] ?? 0);
        }
    }

    foreach (STUDENT_CONTACT_STATUS_LABELS as $key => $label) {
        if (!empty($existing[$key])) {
            continue;
        }

        throw new RuntimeException(
            'Required contact-workspace status `' . $label . '` is missing from `status`. Add the required lookup values to this empty demo database.'
        );
    }
}

function student_contact_fetch_status_map(PDO $pdo): array
{
    static $cache = [];

    $cacheKey = spl_object_id($pdo);
    if (isset($cache[$cacheKey])) {
        return $cache[$cacheKey];
    }

    student_contact_ensure_status_rows($pdo);
    if (!student_contact_table_exists($pdo, 'status')) {
        $cache[$cacheKey] = [];
        return [];
    }

    $hasArchivedAt = student_contact_column_exists($pdo, 'status', 'archived_at');
    $sql = 'SELECT status_id, status_name, status_type' . ($hasArchivedAt ? ', archived_at' : '') . ' FROM status WHERE status_type = :status_type';
    if ($hasArchivedAt) {
        $sql .= ' AND archived_at IS NULL';
    }

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':status_type' => STUDENT_CONTACT_STATUS_TYPE]);

    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $key = student_contact_status_key($row['status_name'] ?? '');
        if ($key === '') {
            continue;
        }

        $map[$key] = [
            'status_id' => (int)($row['status_id'] ?? 0),
            'status_name' => student_contact_status_label($row['status_name'] ?? ''),
        ];
    }

    $cache[$cacheKey] = $map;
    return $map;
}

function student_contact_status_id_for_label(PDO $pdo, string $statusLabel): int
{
    $statusMap = student_contact_fetch_status_map($pdo);
    $key = student_contact_status_key($statusLabel);
    return isset($statusMap[$key]['status_id']) ? (int)$statusMap[$key]['status_id'] : 0;
}

function student_contact_resolve_access(array $authUser): array
{
    $departmentId = isset($authUser['department_id']) ? (int)$authUser['department_id'] : 0;

    return [
        'user_id' => isset($authUser['user_id']) ? (int)$authUser['user_id'] : 0,
        'role_id' => isset($authUser['role_id']) ? (int)$authUser['role_id'] : 0,
        'department_id' => $departmentId > 0 ? $departmentId : null,
        'is_admin' => api_session_user_has_role($authUser, ['admin']),
        /*
         * Works the queue for a whole department rather than for a personal
         * assignment list.
         *
         * Named for the scope and not for the role because it is read at five
         * places — three of them gates that decide whether the workspace opens
         * at all — and adding Faculty as its own flag would have meant editing
         * every one of them. Miss one gate and the role gets a 403 on a screen
         * its permissions say it owns; miss the branch in
         * student_contact_visibility_clause() below and it falls through to
         * `AND 1 = 0`, which opens the screen and shows an empty table.
         *
         * `faculty` STAYS here even though the faculty preset stopped granting
         * student_contacts on 2026-09-04. The preset is not the only door: an
         * admin can grant the module to role 15 in Access Management at any
         * time, and saved rows beat presets. If the branch were deleted along
         * with the grant, the day somebody re-granted it a faculty account would
         * match no branch and read EVERY department's students -- a scoping
         * failure introduced by tidying up, and one that looks like a working
         * screen. Withdrawing an invitation is not a reason to unlock the door.
         */
        'is_department_scoped' => api_session_user_has_role($authUser, ['dept-caller', 'faculty']),
        /*
         * KSH TL sits here beside the SSP Coordinator because they are the same
         * job on the other cohort: API_FOLLOW_UP_TEAMS pairs 'nonstar' => [6, 5]
         * with 'star' => [12, 7], supervisor second in both. Without it role 7
         * matched no branch in student_contact_visibility_clause() and fell
         * through to `AND 1 = 0` — the module would open and show an empty table,
         * which reads as broken rather than as forbidden.
         */
        'is_coordinator' => api_session_user_has_role($authUser, ['ssp-coordinator', 'ksh-tl']),
        'is_ssp_caller' => api_session_user_has_role($authUser, ['ssp-caller', 12]),
        'is_csdl' => api_session_user_has_role($authUser, ['csdl']),
        'student_type_scope' => api_student_type_scope_for_user($authUser),
        'actor' => [
            'user_id' => isset($authUser['user_id']) ? (int)$authUser['user_id'] : 0,
            'email' => $authUser['email'] ?? null,
            'role_id' => isset($authUser['role_id']) ? (int)$authUser['role_id'] : null,
            'role_name' => $authUser['role_name'] ?? null,
            'first_name' => $authUser['first_name'] ?? '',
            'last_name' => $authUser['last_name'] ?? '',
        ],
    ];
}

function student_contact_ensure_tables(PDO $pdo): void
{
    static $initialized = [];

    $key = spl_object_id($pdo);
    if (!empty($initialized[$key])) {
        return;
    }

    student_contact_ensure_status_rows($pdo);
    $initialized[$key] = true;
}

function student_contact_has_ssp_assignment_table(PDO $pdo): bool
{
    return student_contact_table_exists($pdo, 'ssp_assignment');
}

function student_contact_visibility_clause(PDO $pdo, array $access, string $departmentField = 'c.department_id', string $studentField = 'es.student_id'): array
{
    if (!empty($access['is_admin']) || !empty($access['is_coordinator']) || !empty($access['is_csdl'])) {
        return ['sql' => '', 'params' => []];
    }

    if (!empty($access['is_department_scoped'])) {
        $departmentId = isset($access['department_id']) ? (int)$access['department_id'] : 0;
        /*
         * No department on the user row means no queue.
         *
         * Fails closed on purpose, and it is the likeliest way a new Faculty
         * account goes wrong: the role is chosen, the department field is left
         * blank, and the workspace opens onto an empty table. That reads as a
         * broken screen rather than as a missing field, so student_contact_
         * workflow.php answers it with a message naming the department instead
         * of returning a silently empty queue.
         */
        if ($departmentId <= 0) {
            return ['sql' => ' AND 1 = 0', 'params' => []];
        }

        /*
         * The same department on every campus, not the single department row.
         *
         * CITE is two rows sharing one code — department_id 1 and 11 — because
         * the college runs on more than one campus. `department_id = :x` would
         * show a CITE faculty member half of their own department and give no
         * sign the other half existed. api_department_scope_sql() is the same
         * widening the deans have had since Program Head arrived; this branch
         * predates it and was still on the narrow comparison.
         */
        return [
            'sql' => ' AND ' . api_department_scope_sql($departmentField),
            'params' => [':department_id' => $departmentId],
        ];
    }

    if (!empty($access['is_ssp_caller'])) {
        if (!student_contact_has_ssp_assignment_table($pdo)) {
            return ['sql' => ' AND 1 = 0', 'params' => []];
        }

        $userId = isset($access['user_id']) ? (int)$access['user_id'] : 0;
        if ($userId <= 0) {
            return ['sql' => ' AND 1 = 0', 'params' => []];
        }

        return [
            'sql' => " AND EXISTS (
                SELECT 1
                FROM ssp_assignment ssa
                WHERE ssa.student_id = {$studentField}
                  AND ssa.caller_user_id = :ssp_caller_user_id
            )",
            'params' => [':ssp_caller_user_id' => $userId],
        ];
    }

    return ['sql' => ' AND 1 = 0', 'params' => []];
}

function student_contact_base_rows(PDO $pdo, array $access, array $filters = []): array
{
    student_contact_ensure_tables($pdo);
    if (!student_contact_table_exists($pdo, 'enrollment_status') || !student_contact_table_exists($pdo, 'student')) {
        return [];
    }

    $hasEnrollmentArchivedAt = student_contact_column_exists($pdo, 'enrollment_status', 'archived_at');
    $hasStudentArchivedAt = student_contact_column_exists($pdo, 'student', 'archived_at');

    $latestWhere = [];
    if ($hasEnrollmentArchivedAt) {
        $latestWhere[] = 'archived_at IS NULL';
    }

    $latestSql = 'SELECT student_id, MAX(enrollment_status_id) AS latest_id FROM enrollment_status';
    if (!empty($latestWhere)) {
        $latestSql .= ' WHERE ' . implode(' AND ', $latestWhere);
    }
    $latestSql .= ' GROUP BY student_id';

    /*
     * The queue is who needs calling, not who already has a record.
     *
     * This clause used to be the whole membership test, against a table holding
     * 20 rows for 509 students - so the workspace was empty for reasons unrelated
     * to whether anyone was in trouble. A student with no enrollment_status row at
     * all is now IN the queue (that is the group most worth chasing); an approved
     * one is out, which is what the original clause was really for.
     */
    $whereParts = ["(es.enrollment_status_id IS NULL OR LOWER(COALESCE(es.decision, '')) <> 'approved')"];
    $params = [];

    $band = follow_up_queue_where($filters['queue'] ?? FOLLOW_UP_QUEUE_PRIORITY);
    $whereParts[] = $band['sql'];
    $params += $band['params'];

    if ($hasStudentArchivedAt) {
        $whereParts[] = 'st.archived_at IS NULL';
    }

    if (!empty($access['student_type_scope'])) {
        $whereParts[] = 'st.`star e-profile` = :student_type_scope';
        $params[':student_type_scope'] = $access['student_type_scope'];
    }

    if (!empty($filters['enrollment_status_id'])) {
        $whereParts[] = 'es.enrollment_status_id = :enrollment_status_id';
        $params[':enrollment_status_id'] = (int)$filters['enrollment_status_id'];
    }

    if (!empty($filters['student_id'])) {
        $whereParts[] = 'st.student_id = :student_id';
        $params[':student_id'] = (int)$filters['student_id'];
    }

    $visibility = student_contact_visibility_clause($pdo, $access, 'c.department_id', 'st.student_id');
    $params += $visibility['params'];

    $sql = "SELECT
                es.enrollment_status_id,
                st.student_id,
                es.status_type,
                es.date AS record_date,
                es.decision,
                es.response,
                es.reason,
                es.semester_id,
                es.school_year_id,
                st.student_number,
                st.first_name,
                st.last_name,
                st.email_address,
                st.mobile_number,
                st.home_address,
                st.year_level,
                st.section,
                st.`star e-profile` AS student_type,
                c.course_id,
                c.course_name,
                c.course_code,
                c.department_id,
                d.department_name,
                status_ref.status_name AS raw_status_name,
                hv_state.queue_status AS home_visit_queue_status,
                hv_state.scheduled_visit_at AS home_visit_scheduled_at,"
                . follow_up_queue_select_sql() . "
            FROM student st
            LEFT JOIN enrollment_status es
                   ON es.enrollment_status_id = (
                        SELECT latest.latest_id FROM ({$latestSql}) latest
                        WHERE latest.student_id = st.student_id
                      )
            LEFT JOIN course c ON c.course_id = st.course_id
            LEFT JOIN department d ON d.department_id = c.department_id
            LEFT JOIN status status_ref ON status_ref.status_id = es.status_type
            -- The student's home visit, one at most: unique per contact case,
            -- and a student has one case. Shown on the card so a coach sees
            -- what their call did to it.
            LEFT JOIN student_home_visit hv_state ON hv_state.student_id = st.student_id"
            . follow_up_queue_join_sql('st') . "
            WHERE " . implode(' AND ', $whereParts) . $visibility['sql'] . '
            ORDER BY ' . follow_up_queue_order_sql('st');

    $stmt = $pdo->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();

    /*
     * Deliberately NOT band-filtered here.
     *
     * The queue is the PDO priority as of 2026-09-18, and the matrix is five
     * PHP branches no WHERE clause can evaluate -- follow_up_queue_where()
     * therefore narrows only what SQL can answer. The band is kept in
     * student_contact_queue_rows(), which already classifies every row for the
     * badges and so knows each student's priority without a second pass.
     */
    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

function student_contact_fetch_history_map(PDO $pdo, array $studentIds): array
{
    $normalizedIds = array_values(array_unique(array_filter(array_map('intval', $studentIds), static function ($value) {
        return $value > 0;
    })));

    if (empty($normalizedIds)) {
        return [];
    }

    /*
     * Only the table this actually reads is checked.
     *
     * There was a second guard here requiring `audit_logs` to exist — left over
     * from when the history was reconstructed by scanning that table's JSON
     * metadata, as the comment below describes. The scan was replaced; the guard
     * was not. It meant dropping the obsolete `audit_logs` table would silently
     * empty every student's contact history, even though nothing in this
     * function had touched it for some time.
     */
    if (!student_contact_table_exists($pdo, 'student_contact_attempt')) {
        return [];
    }

    // Read the attempt log directly. This used to scan every `audit_logs` row
    // carrying the contact action and decode its JSON metadata, which meant the
    // history could only ever be as good as an audit trail written for a
    // different purpose - unindexed, unfilterable by student, and silently
    // dropped whenever the JSON failed to parse.
    $placeholders = implode(',', array_fill(0, count($normalizedIds), '?'));
    $stmt = $pdo->prepare(
        'SELECT
            a.attempt_id,
            a.student_id,
            a.attempted_by_role_id,
            a.contact_method,
            a.other_method_label,
            a.contact_status,
            a.intervention_status,
            a.recovery_plan_id,
            a.contacted_at,
            a.follow_up_due_at,
            a.notes,
            a.updated_at,
            u.first_name AS actor_first_name,
            u.last_name  AS actor_last_name,
            r.role_name  AS actor_role_name,
            rp.plan_text AS recovery_plan
         FROM student_contact_attempt a
         LEFT JOIN user u ON u.user_id = a.attempted_by_user_id
         LEFT JOIN role r ON r.role_id = a.attempted_by_role_id
         LEFT JOIN contact_recovery_plan rp ON rp.plan_id = a.recovery_plan_id
         WHERE a.student_id IN (' . $placeholders . ')
         ORDER BY a.contacted_at DESC, a.attempt_id DESC'
    );
    $stmt->execute($normalizedIds);

    $historyMap = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $studentId = (int)($row['student_id'] ?? 0);
        if ($studentId <= 0) {
            continue;
        }

        $historyMap[$studentId][] = [
            'attempt_id' => (int)($row['attempt_id'] ?? 0),
            /*
             * Labelled from the channel list, archived channels included.
             *
             * This went through a helper that knew only the four retired keys -
             * message, call, online_meeting, other - so every attempt on the
             * sheet's seven channels read "Not Recorded", in the card's history
             * and in the queue's Last Update column alike. The key came back
             * empty for the same reason, which is why a draft never opened on the
             * channel the student was last reached by.
             */
            'contact_method' => student_contact_channel_label(
                $pdo,
                $row['contact_method'] ?? '',
                $row['other_method_label'] ?? null
            ) ?: 'Not Recorded',
            'contact_method_key' => strtolower(trim((string)($row['contact_method'] ?? ''))),
            'contact_status' => student_contact_status_label($row['contact_status'] ?? ''),
            'contact_status_key' => student_contact_status_key($row['contact_status'] ?? ''),
            // The raw outcome the caller recorded, kept as its own key. The
            // contact status flattens 'Refer to CSDL', 'Not recovered' and the
            // other follow-ups into one 'Follow Up Needed', so this is the only
            // thing that still says which of them it actually was.
            'intervention_status_key' => student_contact_normalize_token($row['intervention_status'] ?? ''),
            'intervention_status' => student_contact_outcome_label(
                student_contact_normalize_token($row['intervention_status'] ?? '')
            ),
            'recovery_plan_id' => $row['recovery_plan_id'] !== null ? (int)$row['recovery_plan_id'] : null,
            'recovery_plan' => $row['recovery_plan'] ?? null,
            'contacted_at' => student_contact_iso_datetime($row['contacted_at'] ?? null),
            'follow_up_due_at' => student_contact_iso_datetime($row['follow_up_due_at'] ?? null),
            'updated_at' => student_contact_iso_datetime($row['updated_at'] ?? null),
            'notes' => student_contact_normalize_text($row['notes'] ?? null) ?? '',
            'attempted_by_name' => student_contact_format_name($row, 'actor_first_name', 'actor_last_name'),
            'attempted_by_role_name' => $row['actor_role_name'] ?? null,
            'attempted_by_role_id' => $row['attempted_by_role_id'] !== null
                ? (int)$row['attempted_by_role_id']
                : null,
        ];
    }

    return $historyMap;
}

function student_contact_build_queue_row(array $row, array $historyMap): array
{
    $studentId = isset($row['student_id']) ? (int)$row['student_id'] : 0;
    $history = $historyMap[$studentId] ?? [];
    $latestHistory = $history[0] ?? null;
    /*
     * Contact status comes from the latest ATTEMPT, not from the enrollment row.
     *
     * es.status_type now holds the enrollment standing (Enrolled / Will Enroll /
     * To Stop / ...), so running it through the contact-status mapper would render
     * every one of them as 'Pending' - the mapper's fallback for a value it does
     * not recognise. The attempt row already carries what happened on the call,
     * which is the honest source for it. 'Pending' remains the answer for a
     * student never yet attempted, which is correct rather than a fallback.
     */
    $statusLabel = $latestHistory !== null
        ? student_contact_status_label($latestHistory['contact_status'] ?? null)
        : student_contact_status_label(null);
    $statusKey = student_contact_status_key($statusLabel);
    /*
     * The student's CSDL referral, if they have one: the earliest attempt that
     * recorded REFERRED TO CSDL, searched for across the whole history.
     *
     * This used to ask only whether the LATEST outcome was the referral. That was
     * enough to colour the row, but it cannot close the card - see
     * student_contact_record_attempt() - because the latest outcome moves on: a
     * CSDL home-visit outcome is logged as an attempt too, and until the card
     * closed, so was every call made after the referral. The row still colours
     * a referral apart from a home visit, which shares its status.
     */
    $referral = null;
    // Oldest first: the history arrives newest-first.
    foreach (array_reverse($history) as $attempt) {
        if (($attempt['intervention_status_key'] ?? '') === 'referred_to_csdl') {
            $referral = $attempt;
            break;
        }
    }
    $recordDate = trim((string)($row['record_date'] ?? ''));
    $defaultDateTime = $recordDate !== '' ? ($recordDate . ' 00:00:00') : null;
    $notesFallback = student_contact_normalize_text($row['response'] ?? null)
        ?? student_contact_normalize_text($row['reason'] ?? null)
        ?? '';

    return [
        'case_id' => (int)($row['enrollment_status_id'] ?? 0),
        'enrollment_status_id' => (int)($row['enrollment_status_id'] ?? 0),
        'student_id' => $studentId,
        'student_number' => $row['student_number'] ?? '',
        'first_name' => $row['first_name'] ?? '',
        'last_name' => $row['last_name'] ?? '',
        'email_address' => $row['email_address'] ?? '',
        'mobile_number' => $row['mobile_number'] ?? '',
        'home_address' => $row['home_address'] ?? '',
        'year_level' => isset($row['year_level']) ? (int)$row['year_level'] : null,
        'section' => $row['section'] ?? '',
        'student_type' => $row['student_type'] ?? '',

        // The student's enrollment standing, distinct from the contact status
        // above: one is what the caller confirmed, the other is how the call went.
        'enrollment_status_name' => $row['raw_status_name'] ?? '',
        'enrollment_status_type' => isset($row['status_type']) ? (int)$row['status_type'] : null,
        'enrollment_reason' => $row['reason'] ?? '',

        /*
         * Why this student is in the queue. Carried to the caller so the reason
         * for the call is on screen at the moment they dial, rather than being
         * something they have to look up in another module.
         *
         * risk_level / risk_score / risk_reason are the retention evaluator's
         * own scale and are what decides queue MEMBERSHIP - they are kept for
         * that reason and because other readers still consume them. What the
         * caller is shown is the PDO priority instead, attached in
         * student_contact_queue_rows(): two different scales for "how bad is
         * this" on one screen is how a caller ends up working the wrong list.
         */
        'risk_level' => $row['risk_level'] ?? 'low',
        'risk_score' => isset($row['risk_score']) ? (float)$row['risk_score'] : 0.0,
        'risk_reason' => $row['risk_reason'] ?? '',
        'missing_survey' => !empty($row['missing_survey']),
        'queue_band' => $row['queue_band'] ?? FOLLOW_UP_QUEUE_PRIORITY,
        'course_id' => isset($row['course_id']) ? (int)$row['course_id'] : null,
        'course_name' => $row['course_name'] ?? ($row['course_code'] ?? ''),
        'course_code' => $row['course_code'] ?? '',
        'department_id' => isset($row['department_id']) ? (int)$row['department_id'] : null,
        'department_name' => $row['department_name'] ?? '',
        'decision' => $row['decision'] ?? null,
        'response' => $row['response'] ?? null,
        'reason' => $row['reason'] ?? null,
        'record_date' => $row['record_date'] ?? null,
        'current_status' => $statusLabel,
        'current_status_key' => $statusKey,
        'latest_contact_status' => $statusLabel,
        'latest_contact_status_key' => $statusKey,
        'latest_contact_method' => $latestHistory['contact_method'] ?? null,
        'latest_contact_method_key' => $latestHistory['contact_method_key'] ?? null,
        'latest_contacted_at' => $latestHistory['contacted_at'] ?? $defaultDateTime,
        'latest_contact_notes' => $latestHistory['notes'] ?? $notesFallback,
        'last_updated_at' => $latestHistory['updated_at'] ?? $defaultDateTime,
        'updated_by_name' => $latestHistory['attempted_by_name'] ?? '',
        'updated_by_role_name' => $latestHistory['attempted_by_role_name'] ?? null,
        'needs_home_visit' => in_array($statusKey, STUDENT_CONTACT_HOME_VISIT_STATUS_KEYS, true),
        'referred_to_csdl' => $referral !== null,
        // Named as the Home Visit Workspace names them, for the notice on the
        // closed card.
        'referred_at' => $referral['contacted_at'] ?? null,
        'referred_by_name' => $referral['attempted_by_name'] ?? '',
        'referred_by_role_name' => $referral['attempted_by_role_name'] ?? null,
        'home_visit_id' => in_array($statusKey, STUDENT_CONTACT_HOME_VISIT_STATUS_KEYS, true)
            ? (int)($row['enrollment_status_id'] ?? 0)
            : null,
        'home_visit_status' => in_array($statusKey, STUDENT_CONTACT_HOME_VISIT_STATUS_KEYS, true)
            ? $statusLabel
            : null,
        // The visit itself, as CSDL's workspace has it: queued / scheduled /
        // completed, or null when the student was never escalated.
        'home_visit_queue_status' => $row['home_visit_queue_status'] ?? null,
        'home_visit_scheduled_at' => student_contact_iso_datetime($row['home_visit_scheduled_at'] ?? null),
        // Now a real total. The old audit-log reader stopped collecting at five
        // per student, so a student contacted eight times also reported five -
        // exactly the number the escalation rule cares about. The payload still
        // carries only the five most recent.
        'contact_attempt_count' => count($history),
        'attempts' => array_slice($history, 0, 5),
    ];
}

/**
 * @param int|array|null $filters A single enrollment_status_id (the historical
 *        signature, still used by the write path to re-read one row) or a filter
 *        map, which is how the queue band is passed.
 */
function student_contact_queue_rows(PDO $pdo, array $access, $filters = null): array
{
    $normalized = is_array($filters)
        ? $filters
        : ['enrollment_status_id' => $filters];

    $rows = student_contact_base_rows($pdo, $access, $normalized);
    if (empty($rows)) {
        return [];
    }

    $studentIds = array_map(static function (array $row): int {
        return isset($row['student_id']) ? (int)$row['student_id'] : 0;
    }, $rows);
    $historyMap = student_contact_fetch_history_map($pdo, $studentIds);

    $queue = array_map(static function (array $row) use ($historyMap): array {
        return student_contact_build_queue_row($row, $historyMap);
    }, $rows);

    /*
     * The PDO priority, from the same matrix the prioritization screen uses.
     *
     * Not a second scoring pass: pdo_load_signals() and pdo_classify_student()
     * are the ones that screen calls, so a student who is Priority 1 there is
     * Priority 1 here. Three extra queries for the whole queue, not per student.
     *
     * Term-wide rather than scoped to a semester, because the queue itself is
     * not term-scoped - a caller works whoever is in front of them, and passing
     * a term this list does not have would classify half of them on no data.
     */
    $settings = pdo_settings($pdo);
    $signals = pdo_load_signals($pdo, $studentIds);
    $studentDetails = student_contact_fetch_student_details($pdo, $studentIds);

    foreach ($queue as &$row) {
        $studentId = (int)$row['student_id'];
        $classified = pdo_classify_student(
            ['student_id' => $studentId],
            $signals['grades'][$studentId] ?? null,
            $signals['attendance'][$studentId] ?? null,
            $signals['finance'][$studentId] ?? null,
            $settings
        );

        $row['priority'] = $classified['priority'];
        $row['priority_owner'] = $classified['owner'];
        $row['priority_label'] = $classified['priority_label'];
        $row['priority_reason'] = $classified['priority_reason'];
        $row['segment'] = $classified['segment'];
        $row['grade_colour'] = $classified['grade_colour'];
        $row['grade_label'] = $classified['grade_label'];
        $row['problem_subjects'] = $classified['problem_subjects'];
        $row['total_subject'] = $classified['total_subject'];
        $row['attendance_status'] = $classified['attendance_status'];
        $row['attendance_label'] = $classified['attendance_label'];
        $row['attendance_colour'] = $classified['attendance_colour'] ?? null;
        $row['present_rate'] = $classified['present_rate'];
        $row['balance_band'] = $classified['balance_band'];
        $row['balance_label'] = $classified['balance_label'];
        $row['balance_amount'] = $classified['balance_amount'];

        // Everything else the student record holds, read-only, so the caller has
        // the whole person in front of them without leaving the workspace for a
        // module most of them cannot open anyway.
        $row['student_details'] = $studentDetails[$studentId] ?? null;
    }
    unset($row);

    /*
     * Priority 1 first. Within a band, the students with the most going wrong.
     *
     * The queue used to arrive in whatever order the join produced, which meant
     * a caller worked down the list in database order and reached the most
     * urgent student whenever they happened to reach them.
     */
    usort($queue, static function (array $a, array $b): int {
        if (($a['priority'] ?? 9) !== ($b['priority'] ?? 9)) {
            return ($a['priority'] ?? 9) <=> ($b['priority'] ?? 9);
        }
        if (($b['problem_subjects'] ?? 0) !== ($a['problem_subjects'] ?? 0)) {
            return ($b['problem_subjects'] ?? 0) <=> ($a['problem_subjects'] ?? 0);
        }
        return strcmp((string)($a['last_name'] ?? ''), (string)($b['last_name'] ?? ''));
    });

    /*
     * The band, kept here because this is where the priority is known.
     *
     * student_contact_base_rows() narrows to what SQL can answer -- the
     * caller's scope, a non-approved decision, and for the survey band a
     * missing submission. Which PRIORITY a student is cannot be a WHERE
     * clause without reproducing the 48-square matrix in SQL, so it is applied
     * over the rows this function has already classified for the badges.
     *
     * `queue_band` is set on the way past so a row says which list it came
     * from, the same field ssp_assignment.php returns.
     */
    $wanted = follow_up_queue_levels($normalized['queue'] ?? FOLLOW_UP_QUEUE_PRIORITY);
    $token = follow_up_queue_normalize($normalized['queue'] ?? FOLLOW_UP_QUEUE_PRIORITY);

    $banded = [];
    foreach ($queue as $row) {
        $row['queue_band'] = $token === FOLLOW_UP_QUEUE_SURVEY
            ? FOLLOW_UP_QUEUE_SURVEY
            : (string)($row['priority'] ?? '');

        if ($token === FOLLOW_UP_QUEUE_SURVEY) {
            /*
             * Both halves tested here, the same as follow_up_queue_apply():
             * the missing submission (which the WHERE clause has usually
             * already required, but the write path re-reads one row with a
             * wider band) and the exclusion of anyone in a calling band, so a
             * student never sits on the call list and the chase list at once.
             */
            if (empty($row['missing_survey'])) {
                continue;
            }
            if (in_array($row['priority'] ?? null, FOLLOW_UP_PRIORITY_LEVELS, true)) {
                continue;
            }
            $banded[] = $row;
            continue;
        }

        if ($wanted === [] || in_array($row['priority'] ?? null, $wanted, true)) {
            $banded[] = $row;
        }
    }

    return $banded;
}

/**
 * The full student record for each student in the queue, for the read-only
 * detail panel.
 *
 * One query for the batch. Every column the student table holds except the
 * housekeeping ones - the caller is looking at a person, and which of these
 * fields matters depends entirely on what the student says when they answer.
 *
 * Read-only on purpose: a caller's job is to record what happened on the call,
 * not to correct the registrar's record from it. Student Management is where
 * these are edited, by the people who own them.
 */
function student_contact_fetch_student_details(PDO $pdo, array $studentIds): array
{
    $ids = array_values(array_unique(array_filter(array_map('intval', $studentIds))));
    if (empty($ids)) {
        return [];
    }
    $idList = implode(',', $ids);

    $stmt = $pdo->query(
        "SELECT s.student_id, s.student_number, s.`star e-profile` AS student_type,
                s.first_name, s.middle_name, s.last_name, s.extension_name,
                s.gender, s.email_address, s.mobile_number, s.facebook_name,
                s.home_address, s.mother_number, s.father_number,
                s.modality, s.year_level, s.section, s.batch_id, s.coaching_unit,
                s.final_scholarship_grant, s.updated_at,
                c.course_code, c.course_name,
                d.department_name, d.department_code,
                cam.campus_name,
                sy.schoolyear_name
           FROM student s
           LEFT JOIN course c ON c.course_id = s.course_id
           LEFT JOIN department d ON d.department_id = c.department_id
           LEFT JOIN campus cam ON cam.campus_id = d.campus_id
           LEFT JOIN school_year sy ON sy.school_year_id = s.schoolyear_id
          WHERE s.student_id IN ($idList)"
    );

    $map = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $map[(int)$row['student_id']] = $row;
    }
    return $map;
}

/**
 * The workspace's headline counts, as buckets that add up.
 *
 * Every row lands in exactly one: referred, contacted, escalated, or not yet
 * reached. `total_students` is the queue - the last three together - and a
 * student referred to CSDL is counted beside it in `referred_students`, not in
 * it: their card only reads now (see student_contact_record_attempt()).
 *
 * A caller added the cards up on 2026-09-27 and found both of the old faults.
 * `follow_up_students` was every student not yet contacted, so it included the
 * escalated ones `escalated_students` counted as well; and the two referred
 * students on that caller's list were still counted as work. Two rows read "2
 * in queue, 2 need follow-up, 1 home visit" - five students, apparently.
 */
function student_contact_queue_summary(array $rows): array
{
    $summary = [
        'total_students' => 0,
        'contacted_students' => 0,
        'follow_up_students' => 0,
        'escalated_students' => 0,
        'referred_students' => 0,
        'pending_students' => 0,
        'no_response_students' => 0,
        'follow_up_needed_students' => 0,
    ];

    foreach ($rows as $row) {
        if (!empty($row['referred_to_csdl'])) {
            $summary['referred_students']++;
            continue;
        }

        $summary['total_students']++;

        $statusKey = student_contact_status_key($row['current_status'] ?? '');
        if ($statusKey === 'contacted') {
            $summary['contacted_students']++;
            continue;
        }

        if (student_contact_is_home_visit_status($statusKey)) {
            $summary['escalated_students']++;
        } else {
            $summary['follow_up_students']++;
        }

        if ($statusKey === 'pending') {
            $summary['pending_students']++;
        }
        if ($statusKey === 'no_response') {
            $summary['no_response_students']++;
        }
        if ($statusKey === 'follow_up_needed') {
            $summary['follow_up_needed_students']++;
        }
    }

    return $summary;
}

/**
 * `$action` defaults to the contact-status action so existing callers are
 * unchanged; home-visit updates pass their own so the two are separable in the
 * audit trail rather than sharing one label.
 *
 * This wrote straight into `audit_logs` — the table the Audit Logs screen does
 * not read. It was missed when api_write_audit_log() was consolidated onto
 * `api_audit_log`, so every contact-status change and every home-visit update
 * since then has been recorded into a table with no reader at all: nothing in
 * the application selects those rows back. Forty-five of them were sitting there
 * when this was found, and they were the largest single category of recorded
 * action in the system.
 *
 * It now goes through the same function as every other administrative change,
 * which puts it in the Actions tab and gives it an IP address and a device it
 * never had.
 *
 * The `audit_logs` existence guard goes with it: api_audit_record() creates its
 * own table if it is missing and never throws, so there is nothing left to check
 * for.
 */
function student_contact_write_audit_log(
    PDO $pdo,
    ?array $actor,
    string $detail,
    array $metadata,
    string $action = STUDENT_CONTACT_AUDIT_ACTION
): void {
    api_write_audit_log($pdo, $actor, $action, $detail, $metadata);
}

function student_contact_notification_tables_available(PDO $pdo): bool
{
    return student_contact_table_exists($pdo, 'system_notification')
        && student_contact_table_exists($pdo, 'system_notification_recipient');
}

function student_contact_insert_notification(PDO $pdo, array $spec): int
{
    if (!student_contact_notification_tables_available($pdo)) {
        return 0;
    }

    $recipientIds = array_values(array_unique(array_filter(array_map('intval', $spec['recipient_user_ids'] ?? []), static function ($value) {
        return $value > 0;
    })));
    $title = trim((string)($spec['title'] ?? ''));
    $message = trim((string)($spec['message'] ?? ''));

    if (empty($recipientIds) || $title === '' || $message === '') {
        return 0;
    }

    $targetView = trim((string)($spec['target_view'] ?? '')) ?: null;
    $metadata = json_encode(is_array($spec['metadata'] ?? null) ? $spec['metadata'] : [], JSON_UNESCAPED_UNICODE);

    $insertNotification = $pdo->prepare(
        'INSERT INTO system_notification (
            event_key,
            level,
            title,
            message,
            module_key,
            entity_type,
            entity_id,
            actor_user_id,
            target_view,
            target_report,
            target_section,
            target_overlay,
            toast,
            metadata
        ) VALUES (
            :event_key,
            :level,
            :title,
            :message,
            :module_key,
            :entity_type,
            :entity_id,
            :actor_user_id,
            :target_view,
            NULL,
            NULL,
            NULL,
            :toast,
            :metadata
        )'
    );
    $insertNotification->execute([
        ':event_key' => trim((string)($spec['event_key'] ?? 'student_contact_notification')),
        ':level' => trim((string)($spec['level'] ?? 'warning')) ?: 'warning',
        ':title' => $title,
        ':message' => $message,
        ':module_key' => trim((string)($spec['module_key'] ?? 'home_visits')) ?: 'home_visits',
        ':entity_type' => trim((string)($spec['entity_type'] ?? 'enrollment_status')) ?: null,
        ':entity_id' => isset($spec['entity_id']) ? (int)$spec['entity_id'] : null,
        ':actor_user_id' => isset($spec['actor_user_id']) ? (int)$spec['actor_user_id'] : null,
        ':target_view' => $targetView,
        ':toast' => !empty($spec['toast']) ? 1 : 0,
        ':metadata' => $metadata !== false ? $metadata : null,
    ]);

    $notificationId = (int)$pdo->lastInsertId();
    if ($notificationId <= 0) {
        return 0;
    }

    $insertRecipient = $pdo->prepare(
        'INSERT INTO system_notification_recipient (notification_id, user_id, is_read, read_at)
         VALUES (:notification_id, :user_id, 0, NULL)'
    );
    foreach ($recipientIds as $userId) {
        $insertRecipient->execute([
            ':notification_id' => $notificationId,
            ':user_id' => $userId,
        ]);
    }

    return $notificationId;
}

function student_contact_fetch_role_users(PDO $pdo, int $roleId, string $roleSlug): array
{
    if (!student_contact_table_exists($pdo, 'user')) {
        return [];
    }

    $stmt = $pdo->prepare(
        'SELECT user_id, first_name, last_name, email
         FROM user
         WHERE role = :role_id
           AND status = 1
         ORDER BY last_name ASC, first_name ASC, user_id ASC'
    );
    $stmt->execute([':role_id' => $roleId]);

    return array_map(static function (array $row) use ($roleSlug): array {
        $displayName = trim(
            trim((string)($row['first_name'] ?? '')) . ' ' . trim((string)($row['last_name'] ?? ''))
        );

        return [
            'user_id' => (int)($row['user_id'] ?? 0),
            'display_name' => $displayName !== '' ? $displayName : ('User #' . (int)($row['user_id'] ?? 0)),
            'email' => $row['email'] ?? null,
            'role_slug' => $roleSlug,
        ];
    }, $stmt->fetchAll(PDO::FETCH_ASSOC) ?: []);
}

function student_contact_notify_role8(PDO $pdo, array $queueRow, array $actor, string $statusLabel): void
{
    if (!student_contact_notification_tables_available($pdo) || !student_contact_is_home_visit_status($statusLabel)) {
        return;
    }

    $recipients = student_contact_fetch_role_users($pdo, 8, 'csdl');
    $recipientIds = array_values(array_filter(array_map(static function (array $row): int {
        return (int)($row['user_id'] ?? 0);
    }, $recipients), static function (int $value): bool {
        return $value > 0;
    }));

    if (empty($recipientIds)) {
        return;
    }

    $studentLabel = trim(
        ((string)($queueRow['student_number'] ?? ''))
        . (((string)($queueRow['student_number'] ?? '')) !== '' ? ' - ' : '')
        . trim((string)($queueRow['last_name'] ?? '') . ', ' . (string)($queueRow['first_name'] ?? ''))
    );
    $actorName = trim(
        trim((string)($actor['first_name'] ?? '')) . ' ' . trim((string)($actor['last_name'] ?? ''))
    ) ?: 'A contact workspace user';

    student_contact_insert_notification($pdo, [
        'event_key' => 'student_contact_home_visit_needed',
        'level' => 'warning',
        'title' => 'Home visit review required',
        'message' => $studentLabel . ' was updated to ' . $statusLabel . ' by ' . $actorName . '.',
        'module_key' => 'home_visits',
        'entity_type' => 'enrollment_status',
        'entity_id' => isset($queueRow['enrollment_status_id']) ? (int)$queueRow['enrollment_status_id'] : null,
        'actor_user_id' => isset($actor['user_id']) ? (int)$actor['user_id'] : null,
        'target_view' => 'home_visits',
        'toast' => true,
        'recipient_user_ids' => $recipientIds,
        'metadata' => [
            'student_id' => isset($queueRow['student_id']) ? (int)$queueRow['student_id'] : null,
            'student_number' => $queueRow['student_number'] ?? null,
            'contact_status' => $statusLabel,
            'updated_by' => $actorName,
            'last_updated_at' => $queueRow['last_updated_at'] ?? null,
        ],
    ]);
}

/**
 * Return the contact case id for a student, opening a case on first contact.
 *
 * `student_contact_case` is unique on `student_id`, so this is a get-or-create
 * rather than a plain insert. The department is copied in at creation time so a
 * case stays visible to the dean who owned it even if the student later shifts
 * course.
 */
function student_contact_ensure_case(PDO $pdo, int $studentId, ?int $departmentId): int
{
    $select = $pdo->prepare('SELECT case_id, department_id FROM student_contact_case WHERE student_id = :student_id');
    $select->execute([':student_id' => $studentId]);
    $existing = $select->fetch(PDO::FETCH_ASSOC);

    if ($existing) {
        $caseId = (int)$existing['case_id'];
        // Backfill the department if the case was opened before the student had
        // a course, so dean visibility starts working without a manual fix.
        if ($departmentId !== null && $existing['department_id'] === null) {
            $patch = $pdo->prepare('UPDATE student_contact_case SET department_id = :department_id WHERE case_id = :case_id');
            $patch->execute([':department_id' => $departmentId, ':case_id' => $caseId]);
        }
        return $caseId;
    }

    $insert = $pdo->prepare(
        'INSERT INTO student_contact_case (student_id, department_id, workflow_status, is_active)
         VALUES (:student_id, :department_id, :workflow_status, 1)'
    );

    try {
        $insert->execute([
            ':student_id' => $studentId,
            ':department_id' => $departmentId,
            ':workflow_status' => 'pending_contact',
        ]);
        return (int)$pdo->lastInsertId();
    } catch (PDOException $exception) {
        // Two callers can open the same student's case at once; the unique key
        // on student_id makes one of them lose. Re-read rather than fail - the
        // winner created exactly the row this one wanted.
        $select->execute([':student_id' => $studentId]);
        $row = $select->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            return (int)$row['case_id'];
        }
        throw $exception;
    }
}

/** The words of a contact reason, or null when it is not on the list. */
function student_contact_reason_text(PDO $pdo, int $reasonId): ?string
{
    foreach (student_contact_reason_options($pdo) as $group) {
        foreach ($group['reasons'] as $reason) {
            if ((int)$reason['reason_id'] === $reasonId) {
                return (string)$reason['reason_text'];
            }
        }
    }

    return null;
}

/**
 * Is this enrollment outcome the "For Home Visit" status?
 *
 * Matched by name, the way the stop outcomes are matched in
 * student_contact_enrollment_status_needs_reason(): the id differs between a
 * fresh install and a migrated database, the name is the office's.
 */
function student_contact_enrollment_wants_home_visit(PDO $pdo, int $enrollmentStatusId): bool
{
    if ($enrollmentStatusId <= 0) {
        return false;
    }
    foreach (student_contact_enrollment_options($pdo) as $option) {
        if ((int)$option['status_id'] === $enrollmentStatusId) {
            return student_contact_normalize_token($option['status_name']) === 'for_home_visit';
        }
    }

    return false;
}

/**
 * Bring the student's home visit in line with the call just logged.
 *
 * Francis, 2026-10-07: a coach's call should update the home visit by its
 * outcome. Before this, only escalation reached the visit: a student a coach
 * later RECOVERED stayed Queued in CSDL's list, waiting for a visit nobody
 * needed, and a student who slipped back after a finished visit never
 * reappeared there.
 *
 *  - The call needs a visit (an escalating Intervention Status, or the
 *    enrollment outcome For Home Visit): the visit is queued. An open one keeps
 *    its state and schedule and takes this call as its source; a finished one
 *    is REOPENED as queued, because the student needs visiting again.
 *  - The call is RECOVERED: an open visit is completed, and the coach's call is
 *    its final outcome (see student_home_visit_rows()).
 *  - Anything else leaves the visit as it is.
 *
 * Unique on `contact_case_id`, so a student escalated across several attempts
 * keeps one visit rather than accumulating duplicates.
 *
 * @return string|null 'queued' (new visit), 'updated', 'reopened', 'completed',
 *         or null when the visit was not touched.
 */
function student_contact_sync_home_visit(
    PDO $pdo,
    int $caseId,
    int $studentId,
    int $attemptId,
    string $statusLabel,
    ?string $interventionStatus,
    bool $enrollmentWantsVisit,
    string $contactedAt
): ?string {
    $select = $pdo->prepare('SELECT home_visit_id, completed_at FROM student_home_visit WHERE contact_case_id = :case_id');
    $select->execute([':case_id' => $caseId]);
    $existing = $select->fetch(PDO::FETCH_ASSOC) ?: null;

    if (student_contact_is_home_visit_status($statusLabel)) {
        $reason = $enrollmentWantsVisit
            ? 'Enrollment outcome is For Home Visit.'
            : 'Contact status is ' . $statusLabel . '.';

        if ($existing === null) {
            $insert = $pdo->prepare(
                'INSERT INTO student_home_visit
                    (contact_case_id, student_id, source_attempt_id, escalation_reason, queue_status)
                 VALUES (:case_id, :student_id, :attempt_id, :reason, :queue_status)'
            );
            $insert->execute([
                ':case_id' => $caseId,
                ':student_id' => $studentId,
                ':attempt_id' => $attemptId,
                ':reason' => $reason,
                ':queue_status' => 'queued',
            ]);
            return 'queued';
        }

        $wasCompleted = $existing['completed_at'] !== null;
        // completed_at is assigned last: the CASEs read the value from before
        // this statement whether the server assigns left to right (MySQL) or
        // all at once (MariaDB's SIMULTANEOUS_ASSIGNMENT).
        $update = $pdo->prepare(
            "UPDATE student_home_visit
                SET source_attempt_id = :attempt_id,
                    escalation_reason = :reason,
                    queue_status = CASE WHEN completed_at IS NULL THEN queue_status ELSE 'queued' END,
                    scheduled_visit_at = CASE WHEN completed_at IS NULL THEN scheduled_visit_at ELSE NULL END,
                    completed_at = NULL
              WHERE home_visit_id = :home_visit_id"
        );
        $update->execute([
            ':attempt_id' => $attemptId,
            ':reason' => $reason,
            ':home_visit_id' => (int)$existing['home_visit_id'],
        ]);
        return $wasCompleted ? 'reopened' : 'updated';
    }

    if ($interventionStatus === 'recovered' && $existing !== null && $existing['completed_at'] === null) {
        $close = $pdo->prepare(
            "UPDATE student_home_visit
                SET queue_status = 'completed',
                    completed_at = :completed_at
              WHERE home_visit_id = :home_visit_id
                AND completed_at IS NULL"
        );
        $close->execute([
            ':completed_at' => $contactedAt,
            ':home_visit_id' => (int)$existing['home_visit_id'],
        ]);
        return $close->rowCount() > 0 ? 'completed' : null;
    }

    return null;
}

function student_contact_record_attempt(PDO $pdo, array $access, array $payload): array
{
    if (empty($access['is_department_scoped']) && empty($access['is_coordinator']) && empty($access['is_ssp_caller'])) {
        throw new RuntimeException('Forbidden');
    }

    $studentId = isset($payload['student_id']) ? (int)$payload['student_id'] : 0;
    if ($studentId <= 0) {
        throw new InvalidArgumentException('student_id is required');
    }

    $rows = student_contact_queue_rows($pdo, $access, ['queue' => FOLLOW_UP_QUEUE_ALL]);
    $currentRow = null;
    foreach ($rows as $row) {
        if ((int)($row['student_id'] ?? 0) === $studentId) {
            $currentRow = $row;
            break;
        }
    }

    if (!$currentRow) {
        throw new RuntimeException('Student record not found in the contact workspace.');
    }

    /*
     * A referral to CSDL closes the student to this workspace.
     *
     * REFERRED TO CSDL is the handover (see contact_vocabulary.php): from then on
     * the student is CSDL's, worked in the Home Visit Workspace, and the card here
     * is a record to read. Attempts logged after a referral undid it without
     * anyone meaning to. Each one became the latest outcome, so the student
     * stopped reading as referred - s171 went from escalated back to pending on
     * 2026-09-24 - and an escalating one also replaces the home visit's source
     * attempt, which is what tells CSDL the student was referred at all.
     *
     * The card hides the form; this is the control.
     */
    if (!empty($currentRow['referred_to_csdl'])) {
        throw new RuntimeException(
            'This student has been referred to CSDL, so no more contact updates can be logged here. '
            . 'CSDL continues with them in the Home Visit Workspace.'
        );
    }

    /*
     * The channel, from the sheet's CHANNEL USED list.
     *
     * student_contact_channel_key() accepts only active channels. Archived
     * ones - the four retired keys included - still render on rows that hold
     * them, but a new attempt cannot be filed against a vocabulary the office
     * has replaced.
     */
    $methodKey = student_contact_channel_key($pdo, $payload['contact_method'] ?? ($payload['channel'] ?? ''));
    if ($methodKey === '') {
        throw new InvalidArgumentException(
            'Choose a channel: ' . implode(', ', array_column(student_contact_channel_options($pdo), 'label'))
        );
    }

    // 'other' is gone from the list, so nothing carries a free-text label any
    // more. The column stays for the rows that already have one.
    $otherMethodLabel = null;

    /*
     * REASON - why the student is stopping, continuing, or anything else.
     *
     * Offered with every enrollment outcome since 2026-10-07 (Francis: "the
     * reason always display even will continue or other outcome"). It is still
     * REQUIRED only with a stop-type outcome; with any other it is optional.
     */
    $reasonId = null;
    $reasonInput = $payload['reason_id'] ?? null;

    /*
     * "Plan if Not Recovered" - what the student intends to do instead.
     *
     * Only meaningful once somebody has been reached, which is why it is
     * optional in the same way the reason is.
     */
    $recoveryPlanId = null;
    $planInput = $payload['recovery_plan_id'] ?? null;
    if ($planInput !== null && $planInput !== '') {
        $recoveryPlanId = (int)$planInput;
        if ($recoveryPlanId <= 0 || !student_contact_recovery_plan_exists($pdo, $recoveryPlanId)) {
            throw new InvalidArgumentException('That recovery plan is not on the current list.');
        }
    }

    /*
     * Intervention Status, validated against the acting role's own list.
     *
     * A coach cannot record UNREACHABLE and CSDL cannot record REFERRED TO CSDL:
     * the two columns on the sheet are different lists because the two teams
     * reach different outcomes, and accepting either word from either team would
     * make the field unreadable in aggregate.
     */
    $interventionStatus = student_intervention_status_key(
        $payload['intervention_status'] ?? null,
        (int)($access['role_id'] ?? 0) ?: null
    );
    if ($interventionStatus === false) {
        throw new InvalidArgumentException(
            'That intervention status is not one your role records. Choose from: '
            . implode(', ', student_intervention_statuses_for_role((int)($access['role_id'] ?? 0) ?: null))
        );
    }
    if ($interventionStatus === '') {
        throw new InvalidArgumentException('Choose the intervention status before saving the call.');
    }

    /*
     * Derived from the outcome above, never read from the request.
     *
     * A `contact_status` in the payload is ignored rather than refused: older
     * clients still send one, and refusing it would break them over a field
     * whose value is now computable from another they already send.
     */
    $statusLabel = student_contact_status_for_intervention($interventionStatus);
    $statusId = student_contact_status_id_for_label($pdo, $statusLabel);
    if ($statusId <= 0) {
        throw new RuntimeException('Unable to resolve the selected contact status.');
    }

    $contactedAt = student_contact_combine_date_time(
        $payload['date_contacted'] ?? null,
        $payload['time_contacted'] ?? null
    );
    if ($contactedAt === null) {
        throw new InvalidArgumentException('date_contacted and time_contacted are required.');
    }

    $notes = student_contact_normalize_text($payload['notes'] ?? null);

    /*
     * The enrollment outcome the caller confirmed on the phone - Will Continue,
     * For Follow-up, For Home Visit, the Will not continue run and the rest,
     * straight from the `status` table.
     *
     * Required since 2026-10-07 (Francis: "its no more optional"). It used to be
     * optional so that a call reaching nobody left the previous standing alone;
     * the list now carries the answers such a call gives - For Follow-up, For
     * Home Visit, Undecided - so every call states one.
     */
    $enrollmentStatusInput = $payload['enrollment_status'] ?? ($payload['enrollment_status_id'] ?? null);
    if ($enrollmentStatusInput === null || $enrollmentStatusInput === '') {
        throw new InvalidArgumentException('Choose the enrollment outcome of this call.');
    }
    $enrollmentStatusId = student_contact_enrollment_status_id($pdo, $enrollmentStatusInput);
    $enrollmentNeedsReason = student_contact_enrollment_status_needs_reason($pdo, $enrollmentStatusInput);

    if ($enrollmentStatusId <= 0) {
        throw new InvalidArgumentException('enrollment_status is not a recognised enrollment value.');
    }
    if ($reasonInput !== null && $reasonInput !== '') {
        $reasonId = (int)$reasonInput;
        if ($reasonId <= 0 || !student_contact_reason_exists($pdo, $reasonId)) {
            throw new InvalidArgumentException('That reason is not on the current list.');
        }
    } elseif ($enrollmentNeedsReason) {
        throw new InvalidArgumentException('Choose the reason the student will stop.');
    }
    // The words come from the list, not the request, so the enrollment record
    // and the attempt can never name two different reasons.
    $enrollmentReason = $reasonId !== null ? student_contact_reason_text($pdo, $reasonId) : null;

    /*
     * The home visit follows the call. See student_contact_sync_home_visit().
     *
     * "For Home Visit" asks for a visit in so many words, so it escalates like
     * the Intervention Statuses that do; RECOVERED ends the need for one. Both at
     * once is a contradiction, refused rather than resolved by a guess.
     */
    $enrollmentWantsVisit = student_contact_enrollment_wants_home_visit($pdo, $enrollmentStatusId);
    if ($enrollmentWantsVisit && $interventionStatus === 'recovered') {
        throw new InvalidArgumentException(
            'RECOVERED and For Home Visit contradict each other. Change the intervention status or the enrollment outcome.'
        );
    }
    if ($enrollmentWantsVisit && !student_contact_is_home_visit_status($statusLabel)) {
        $statusLabel = STUDENT_CONTACT_STATUS_LABELS['follow_up_needed'];
    }

    $previousStatusLabel = student_contact_status_label($currentRow['current_status'] ?? '');
    $recordId = (int)($currentRow['enrollment_status_id'] ?? 0);

    /*
     * A standing filed under a closed semester is left exactly as it was.
     *
     * The call is not refused for it - calls go on after a semester ends, and
     * the student's latest standing is often the last term's. It opens a new
     * standing in the calendar's term instead, below, carrying the old status
     * forward when the call records no outcome, so the card reads the same and
     * the closed semester keeps what it said.
     */
    $carriedStatusType = null;
    if ($recordId > 0) {
        // Read from the row itself: the queue row the workspace hands over
        // carries neither the standing's term nor its raw status.
        $standing = $pdo->prepare(
            'SELECT status_type, school_year_id, semester_id FROM enrollment_status WHERE enrollment_status_id = :id'
        );
        $standing->execute([':id' => $recordId]);
        $standingRow = $standing->fetch(PDO::FETCH_ASSOC) ?: [];
        if (term_closure_is_closed($pdo, $standingRow['school_year_id'] ?? null, $standingRow['semester_id'] ?? null)) {
            $carriedStatusType = (int)($standingRow['status_type'] ?? 0) ?: null;
            $recordId = 0;
        }
    }

    if ($recordId <= 0) {
        /*
         * Create the standing rather than refuse the call.
         *
         * A student with no enrollment_status row is the group most worth
         * chasing - nobody has recorded a decision for them yet - and since the
         * queue became risk-driven they are in the workspace by design. Throwing
         * here would have let a caller open them, dial, and then be told there was
         * nowhere to write the answer down.
         *
         * The term is taken from the Academic Calendar rather than from the
         * request, so a caller cannot file an attempt against an arbitrary
         * semester, and it is the same term the workspace header states.
         * See student_contact_current_term() for what it replaced.
         */
        $term = student_contact_current_term($pdo);

        // The current term closed as well leaves nowhere to write the answer.
        $closedTerm = term_closure_block($pdo, [$term['school_year_id'] ?? null, $term['semester_id'] ?? null]);
        if ($closedTerm !== null) {
            throw new TermClosedException($closedTerm);
        }

        /*
         * Upserted: the student may already hold a row for this term that is
         * not their latest - archived, or older than the closed semester's row
         * that sent us here - and the (student, year, semester) key would turn a
         * plain insert into a 500. That row is reused, and revived if archived,
         * since a call is fresh news about that term. Its own status stands:
         * the UPDATE below only changes it when the call recorded an outcome.
         */
        $seed = $pdo->prepare(
            'INSERT INTO enrollment_status (status_type, `date`, student_id, semester_id, school_year_id)
             VALUES (:status_type, :contact_date, :student_id, :semester_id, :school_year_id)
             ON DUPLICATE KEY UPDATE
                enrollment_status_id = LAST_INSERT_ID(enrollment_status_id),
                archived_at = NULL'
        );
        $seed->execute([
            // The enrollment outcome if the caller recorded one; else the status
            // carried over from a closed semester's standing; else the row opens
            // on 'Undecided' rather than borrowing a contact status, which is
            // the conflation fixed below.
            ':status_type' => $enrollmentStatusId > 0
                ? $enrollmentStatusId
                : ($carriedStatusType ?? student_contact_enrollment_status_id($pdo, 'Undecided')),
            ':contact_date' => substr($contactedAt, 0, 10),
            ':student_id' => $studentId,
            ':semester_id' => $term['semester_id'] ?? null,
            ':school_year_id' => $term['school_year_id'] ?? null,
        ]);

        $recordId = (int)$pdo->lastInsertId();
        if ($recordId <= 0) {
            throw new RuntimeException('Unable to open an enrollment record for this student.');
        }
    }

    $pdo->beginTransaction();
    try {
        $updateStmt = $pdo->prepare(
            'UPDATE enrollment_status
             SET status_type = COALESCE(:enrollment_status_type, status_type),
                 `date` = :contact_date,
                 reason = :reason,
                 response = :response
             WHERE enrollment_status_id = :enrollment_status_id'
        );
        /*
         * The ENROLLMENT outcome goes here, never the contact status.
         *
         * This used to bind $statusId - the contact_workspace value - so logging a
         * call overwrote the student's enrollment standing with 'Contacted' or
         * 'Pending'. The column is joined to `status` and rendered as the
         * student's enrollment standing everywhere it appears, so a caller doing
         * their job destroyed the answer the call was placed to obtain. Rows
         * carrying status_type 16 and 18 today are that bug's residue.
         *
         * COALESCE so an attempt that records no outcome - "no answer", which is
         * most of them - leaves the previous standing intact rather than blanking
         * it. The contact status still lands on the attempt row below, which is
         * where the history of what happened belongs. (Since 2026-10-07 every
         * call records an outcome, so the COALESCE is only a guard.)
         *
         * The reason is this call's, not COALESCEd: an outcome and its reason
         * are one answer. Keeping the old one meant a student who moved from
         * "Will not continue" to "Will Continue" kept reading "because of
         * financial hardship".
         */
        $updateStmt->bindValue(
            ':enrollment_status_type',
            $enrollmentStatusId > 0 ? $enrollmentStatusId : null,
            $enrollmentStatusId > 0 ? PDO::PARAM_INT : PDO::PARAM_NULL
        );
        $updateStmt->bindValue(':contact_date', substr($contactedAt, 0, 10), PDO::PARAM_STR);
        $updateStmt->bindValue(':reason', $enrollmentReason, $enrollmentReason === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $updateStmt->bindValue(':response', $notes, $notes === null ? PDO::PARAM_NULL : PDO::PARAM_STR);
        $updateStmt->bindValue(':enrollment_status_id', $recordId, PDO::PARAM_INT);
        $updateStmt->execute();

        // `enrollment_status` above holds the student's *current* standing, which
        // is what the matrix and dashboards read. It cannot answer "how many
        // times did we try, by what method, and what did they say" because each
        // update overwrites the last. The case/attempt tables below are the log
        // that question needs, so both are written: one is state, one is history.
        $departmentId = isset($currentRow['department_id']) && (int)$currentRow['department_id'] > 0
            ? (int)$currentRow['department_id']
            : null;
        $caseId = student_contact_ensure_case($pdo, $studentId, $departmentId);

        $followUpDueAt = student_contact_iso_datetime($payload['follow_up_due_at'] ?? null);

        $attemptStmt = $pdo->prepare(
            'INSERT INTO student_contact_attempt
                (contact_case_id, student_id, attempted_by_user_id, attempted_by_role_id,
                 contact_method, other_method_label, contact_status, contacted_at,
                 follow_up_due_at, notes,
                 reason_id, recovery_plan_id, intervention_status)
             VALUES
                (:case_id, :student_id, :user_id, :role_id,
                 :method, :other_method_label, :status, :contacted_at,
                 :follow_up_due_at, :notes,
                 :reason_id, :recovery_plan_id, :intervention_status)'
        );
        $actorUserId = (int)($access['user_id'] ?? 0);
        $actorRoleId = (int)($access['role_id'] ?? 0);
        $attemptStmt->execute([
            ':case_id' => $caseId,
            ':student_id' => $studentId,
            ':user_id' => $actorUserId > 0 ? $actorUserId : null,
            ':role_id' => $actorRoleId > 0 ? $actorRoleId : null,
            ':method' => $methodKey,
            ':other_method_label' => $otherMethodLabel,
            ':status' => student_contact_status_key($statusLabel),
            ':contacted_at' => $contactedAt,
            ':follow_up_due_at' => $followUpDueAt,
            ':notes' => $notes,
            ':reason_id' => $reasonId,
            ':recovery_plan_id' => $recoveryPlanId,
            ':intervention_status' => $interventionStatus,
        ]);
        $attemptId = (int)$pdo->lastInsertId();

        $isHomeVisitStatus = student_contact_is_home_visit_status($statusLabel);

        $caseStmt = $pdo->prepare(
            'UPDATE student_contact_case
                SET latest_attempt_id = :attempt_id,
                    latest_contact_status = :status,
                    latest_contacted_at = :contacted_at,
                    next_follow_up_at = :follow_up_due_at,
                    workflow_status = :workflow_status,
                    escalated_at = CASE WHEN :is_escalated = 1 AND escalated_at IS NULL
                                        THEN :contacted_at_2 ELSE escalated_at END
              WHERE case_id = :case_id'
        );
        $caseStmt->execute([
            ':attempt_id' => $attemptId,
            ':status' => student_contact_status_key($statusLabel),
            ':contacted_at' => $contactedAt,
            ':follow_up_due_at' => $followUpDueAt,
            ':workflow_status' => $isHomeVisitStatus ? 'escalated' : student_contact_status_key($statusLabel),
            ':is_escalated' => $isHomeVisitStatus ? 1 : 0,
            ':contacted_at_2' => $contactedAt,
            ':case_id' => $caseId,
        ]);

        $homeVisitChange = student_contact_sync_home_visit(
            $pdo,
            $caseId,
            $studentId,
            $attemptId,
            $statusLabel,
            $interventionStatus,
            $enrollmentWantsVisit,
            $contactedAt
        );

        $detail = 'Updated contact status to ' . $statusLabel . ' for '
            . (($currentRow['student_number'] ?? ('ID:' . $studentId)))
            . ' - '
            . trim((string)($currentRow['last_name'] ?? '') . ', ' . (string)($currentRow['first_name'] ?? ''));

        student_contact_write_audit_log($pdo, $access['actor'] ?? null, $detail, [
            'student_id' => $studentId,
            'enrollment_status_id' => $recordId,
            'contact_status' => $statusLabel,
            'contact_status_key' => student_contact_status_key($statusLabel),
            'contact_method' => $methodKey,
            'contact_method_label' => student_contact_channel_label($pdo, $methodKey, $otherMethodLabel),
            'other_method_label' => $otherMethodLabel,
            'contacted_at' => $contactedAt,
            'notes' => $notes,
            'previous_status' => $previousStatusLabel,
            'enrollment_outcome_status_id' => $enrollmentStatusId,
            'reason_id' => $reasonId,
            'home_visit' => $homeVisitChange,
        ]);

        $pdo->commit();
    } catch (Throwable $throwable) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $throwable;
    }

    $refreshedRows = student_contact_queue_rows($pdo, $access, [
        'enrollment_status_id' => $recordId,
        'queue' => FOLLOW_UP_QUEUE_ALL,
    ]);
    if (empty($refreshedRows)) {
        throw new RuntimeException('Failed to reload the updated contact record.');
    }

    $updatedRow = $refreshedRows[0];
    // A reopened visit is new work for CSDL even when the status did not move.
    if (($previousStatusLabel !== $statusLabel || $homeVisitChange === 'reopened')
        && student_contact_is_home_visit_status($statusLabel)) {
        student_contact_notify_role8($pdo, $updatedRow, $access['actor'] ?? [], $statusLabel);
    }

    // What the call did to the student's home visit, for the save message.
    $updatedRow['home_visit_change'] = $homeVisitChange;
    return $updatedRow;
}

/**
 * The CSDL home-visit queue, read from `student_home_visit`.
 *
 * This used to be derived: every student whose *current* contact status was
 * No Response or Follow Up Needed was synthesised into a queue row. That made
 * the queue a view of the present rather than a work list - a visit could not
 * be assigned, scheduled or completed, because there was nowhere to put those
 * facts, and a student who was later reached simply vanished from the queue
 * along with the record that CSDL had ever been asked.
 */
function student_home_visit_rows(PDO $pdo, array $access, ?int $homeVisitId = null): array
{
    if (!student_contact_table_exists($pdo, 'student_home_visit')) {
        return [];
    }

    $visibility = student_contact_visibility_clause($pdo, $access, 'scc.department_id', 'hv.student_id');

    $sql =
        'SELECT
            hv.home_visit_id,
            hv.contact_case_id,
            hv.student_id,
            hv.queue_status,
            hv.escalation_reason,
            hv.scheduled_visit_at,
            hv.completed_at,
            hv.visit_remarks,
            hv.assigned_staff_user_id,
            hv.updated_at AS visit_updated_at,
            scc.department_id,
            scc.latest_contact_status,
            scc.latest_contacted_at,
            s.student_number, s.first_name, s.last_name, s.email_address,
            s.mobile_number, s.home_address, s.year_level, s.section,
            c.course_name, c.course_code,
            d.department_name,
            asg.first_name AS assigned_first_name,
            asg.last_name  AS assigned_last_name,
            att.contact_method    AS latest_contact_method,
            att.other_method_label AS latest_other_method_label,
            att.intervention_status AS source_intervention_status,
            att.recovery_plan_id AS source_recovery_plan_id,
            att.contacted_at AS referred_at,
            att.school_year_id AS source_school_year_id,
            att.semester_id AS source_semester_id,
            att.period AS source_period,
            source_plan.plan_text AS source_recovery_plan,
            source_user.first_name AS source_first_name,
            source_user.last_name AS source_last_name,
            source_role.role_name AS source_role_name
         FROM student_home_visit hv
         INNER JOIN student_contact_case scc ON scc.case_id = hv.contact_case_id
         INNER JOIN student s ON s.student_id = hv.student_id
         LEFT JOIN course c ON c.course_id = s.course_id
         LEFT JOIN department d ON d.department_id = scc.department_id
         LEFT JOIN user asg ON asg.user_id = hv.assigned_staff_user_id
         LEFT JOIN student_contact_attempt att ON att.attempt_id = hv.source_attempt_id
         LEFT JOIN contact_recovery_plan source_plan ON source_plan.plan_id = att.recovery_plan_id
         LEFT JOIN user source_user ON source_user.user_id = att.attempted_by_user_id
         LEFT JOIN role source_role ON source_role.role_id = att.attempted_by_role_id
         WHERE 1 = 1' . $visibility['sql'];

    $params = $visibility['params'];
    if ($homeVisitId !== null && $homeVisitId > 0) {
        $sql .= ' AND hv.home_visit_id = :home_visit_id';
        $params[':home_visit_id'] = $homeVisitId;
    }

    // Open work first, then most recently escalated.
    $sql .= ' ORDER BY (hv.completed_at IS NOT NULL), hv.updated_at DESC, hv.home_visit_id DESC';

    $stmt = $pdo->prepare($sql);
    $stmt->execute($params);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    if (empty($rows)) {
        return [];
    }

    $historyMap = student_contact_fetch_history_map(
        $pdo,
        array_map(static fn(array $row): int => (int)$row['student_id'], $rows)
    );

    return array_map(static function (array $row) use ($historyMap, $pdo): array {
        $statusLabel = student_contact_status_label($row['latest_contact_status'] ?? '');
        $studentId = (int)($row['student_id'] ?? 0);
        $history = $historyMap[$studentId] ?? [];
        $assignedName = student_contact_format_name($row, 'assigned_first_name', 'assigned_last_name');
        $sourcePlan = trim((string)($row['source_recovery_plan'] ?? ''));

        // A final outcome exists only after CSDL records it. The caller's plan
        // can suggest a value, but must never silently become the final result.
        $finalOutcomeKey = null;
        $finalOutcomeSource = 'pending';
        $finalOutcomeByName = '';
        $finalOutcomeAt = null;
        $referredAt = student_contact_iso_datetime($row['referred_at'] ?? null);
        foreach ($history as $attempt) {
            $attemptKey = (string)($attempt['intervention_status_key'] ?? '');
            $attemptRoleId = (int)($attempt['attempted_by_role_id'] ?? 0);
            $attemptedAt = student_contact_iso_datetime($attempt['contacted_at'] ?? null);
            if ($referredAt !== null && ($attemptedAt === null || $attemptedAt < $referredAt)) {
                continue;
            }
            $csdlOutcome = in_array($attemptRoleId, [1, STUDENT_CONTACT_CSDL_ROLE_ID], true)
                && array_key_exists($attemptKey, STUDENT_INTERVENTION_STATUSES_CSDL);
            // A coach's RECOVERED call closes the visit (student_contact_sync_home_visit()),
            // so on a completed visit it is the outcome. On an open one it cannot
            // be: the visit was reopened after it.
            $coachRecovery = $attemptKey === 'recovered'
                && ($row['queue_status'] ?? '') === 'completed';
            if ($csdlOutcome || $coachRecovery) {
                $finalOutcomeKey = $attemptKey;
                $finalOutcomeSource = 'recorded';
                $finalOutcomeByName = (string)($attempt['attempted_by_name'] ?? '');
                $finalOutcomeAt = $attempt['contacted_at'] ?? null;
                break;
            }
        }
        $suggestedOutcomeKey = student_csdl_suggested_outcome_for_recovery_plan($sourcePlan);

        return [
            'home_visit_id' => (int)($row['home_visit_id'] ?? 0),
            'contact_case_id' => (int)($row['contact_case_id'] ?? 0),
            'student_id' => $studentId,
            'student_number' => $row['student_number'] ?? '',
            'first_name' => $row['first_name'] ?? '',
            'last_name' => $row['last_name'] ?? '',
            'email_address' => $row['email_address'] ?? '',
            'mobile_number' => $row['mobile_number'] ?? '',
            'home_address' => $row['home_address'] ?? '',
            'year_level' => isset($row['year_level']) ? (int)$row['year_level'] : null,
            'section' => $row['section'] ?? '',
            'course_name' => $row['course_name'] ?? ($row['course_code'] ?? ''),
            'course_code' => $row['course_code'] ?? '',
            'department_name' => $row['department_name'] ?? '',
            'department_id' => isset($row['department_id']) ? (int)$row['department_id'] : null,
            'current_status' => $statusLabel,
            'current_status_key' => student_contact_status_key($statusLabel),
            // Why the student is here: a caller's explicit CSDL referral, as
            // opposed to a plain no-answer escalation. The two share a status,
            // so the workspace reads this to tell them apart.
            'referred_to_csdl' => student_contact_normalize_token(
                $row['source_intervention_status'] ?? ''
            ) === 'referred_to_csdl',
            'referred_by_name' => student_contact_format_name($row, 'source_first_name', 'source_last_name'),
            'referred_by_role_name' => $row['source_role_name'] ?? null,
            'referred_at' => $referredAt,
            'recovery_plan' => $sourcePlan,
            'suggested_final_outcome_key' => $suggestedOutcomeKey,
            'suggested_final_outcome' => $suggestedOutcomeKey !== null
                ? (STUDENT_INTERVENTION_STATUSES_CSDL[$suggestedOutcomeKey] ?? $suggestedOutcomeKey)
                : null,
            'final_outcome_key' => $finalOutcomeKey,
            'final_outcome' => $finalOutcomeKey !== null
                ? (STUDENT_INTERVENTION_STATUSES_CSDL[$finalOutcomeKey] ?? $finalOutcomeKey)
                : null,
            'final_outcome_source' => $finalOutcomeSource,
            'final_outcome_by_name' => $finalOutcomeByName,
            'final_outcome_at' => $finalOutcomeAt,
            'source_recovery_plan_id' => isset($row['source_recovery_plan_id'])
                ? (int)$row['source_recovery_plan_id']
                : null,
            'source_school_year_id' => isset($row['source_school_year_id'])
                ? (int)$row['source_school_year_id']
                : null,
            'source_semester_id' => isset($row['source_semester_id'])
                ? (int)$row['source_semester_id']
                : null,
            'source_period' => isset($row['source_period']) ? (int)$row['source_period'] : null,
            'queue_status' => $row['queue_status'] ?? 'queued',
            'last_updated_at' => student_contact_iso_datetime($row['visit_updated_at'] ?? null),
            'updated_by_name' => $history[0]['attempted_by_name'] ?? '',
            'updated_by_role_name' => $history[0]['attempted_by_role_name'] ?? null,
            'assigned_staff_user_id' => isset($row['assigned_staff_user_id'])
                ? (int)$row['assigned_staff_user_id']
                : null,
            'assigned_staff_name' => $assignedName,
            'scheduled_visit_at' => student_contact_iso_datetime($row['scheduled_visit_at'] ?? null),
            'completed_at' => student_contact_iso_datetime($row['completed_at'] ?? null),
            'visit_remarks' => student_contact_normalize_text($row['visit_remarks'] ?? null) ?? '',
            'escalation_reason' => $row['escalation_reason'] ?? '',
            'latest_contact_method' => student_contact_channel_label(
                $pdo,
                $row['latest_contact_method'] ?? '',
                $row['latest_other_method_label'] ?? null
            ) ?: 'Not Recorded',
            'latest_contacted_at' => student_contact_iso_datetime($row['latest_contacted_at'] ?? null),
            'attempts' => array_slice($history, 0, 5),
        ];
    }, $rows);
}

function student_home_visit_summary(array $rows): array
{
    $summary = [
        'total_home_visits' => count($rows),
        'queued_home_visits' => 0,
        'scheduled_home_visits' => 0,
        'completed_home_visits' => 0,
        'no_response_students' => 0,
        'follow_up_needed_students' => 0,
    ];

    foreach ($rows as $row) {
        // Queue state now comes from the visit record itself. It used to report
        // every row as queued and scheduled/completed as a flat zero, because
        // there was no stored state to count.
        switch ((string)($row['queue_status'] ?? 'queued')) {
            case 'completed':
                $summary['completed_home_visits']++;
                break;
            case 'scheduled':
                $summary['scheduled_home_visits']++;
                break;
            default:
                $summary['queued_home_visits']++;
                break;
        }

        $statusKey = student_contact_status_key($row['current_status'] ?? '');
        if ($statusKey === 'no_response') {
            $summary['no_response_students']++;
        }
        if ($statusKey === 'follow_up_needed') {
            $summary['follow_up_needed_students']++;
        }
    }

    return $summary;
}

/**
 * Assign, schedule, annotate or complete a queued home visit.
 *
 * Previously this threw: the queue was derived from contact status, so there was
 * no row to write to and CSDL could only look at the list. Every field here is
 * optional - a caller can assign staff without scheduling, or add remarks
 * without changing state.
 */
function student_home_visit_update(PDO $pdo, array $access, array $payload): array
{
    if (empty($access['is_admin']) && empty($access['is_csdl'])) {
        throw new RuntimeException('Forbidden');
    }

    $homeVisitId = isset($payload['home_visit_id']) ? (int)$payload['home_visit_id'] : 0;
    if ($homeVisitId <= 0) {
        throw new InvalidArgumentException('home_visit_id is required');
    }

    $existingRows = student_home_visit_rows($pdo, $access, $homeVisitId);
    if (empty($existingRows)) {
        throw new RuntimeException('Home visit record not found.');
    }
    $existing = $existingRows[0];

    $hasFinalOutcome = array_key_exists('final_outcome', $payload);
    $finalOutcomeKey = null;
    if ($hasFinalOutcome) {
        // Validate against CSDL's shorter vocabulary even for an administrator
        // using this endpoint. Coach-only states are not final CSDL outcomes.
        $finalOutcomeKey = student_intervention_status_key(
            $payload['final_outcome'] ?? '',
            STUDENT_CONTACT_CSDL_ROLE_ID
        );
        if ($finalOutcomeKey === '' || $finalOutcomeKey === false) {
            throw new InvalidArgumentException(
                'final_outcome must be one of: ' . implode(', ', STUDENT_INTERVENTION_STATUSES_CSDL)
            );
        }
    }

    $sets = [];
    $params = [':home_visit_id' => $homeVisitId];
    $enrollmentStatusId = null;
    $enrollmentReason = null;
    if (array_key_exists('enrollment_status', $payload)) {
        $enrollmentStatusId = student_contact_enrollment_status_id($pdo, $payload['enrollment_status']);
        if ($enrollmentStatusId <= 0) {
            throw new InvalidArgumentException('Choose a recognised final enrollment outcome.');
        }
        $reasonId = (int)($payload['reason_id'] ?? 0);
        if ($reasonId > 0 && !student_contact_reason_exists($pdo, $reasonId)) {
            throw new InvalidArgumentException('That reason is not on the current list.');
        }
        if (student_contact_enrollment_status_needs_reason($pdo, $payload['enrollment_status']) && $reasonId <= 0) {
            throw new InvalidArgumentException('Choose the reason the student will stop.');
        }
        $enrollmentReason = $reasonId > 0 ? student_contact_reason_text($pdo, $reasonId) : null;
    }

    if (array_key_exists('assigned_staff_user_id', $payload)) {
        $assignedId = (int)$payload['assigned_staff_user_id'];
        if ($assignedId > 0) {
            $check = $pdo->prepare('SELECT 1 FROM user WHERE user_id = :user_id');
            $check->execute([':user_id' => $assignedId]);
            if (!$check->fetchColumn()) {
                throw new InvalidArgumentException('The selected staff member does not exist.');
            }
        }
        $sets[] = 'assigned_staff_user_id = :assigned_staff_user_id';
        $params[':assigned_staff_user_id'] = $assignedId > 0 ? $assignedId : null;
    }

    // Accept either a combined datetime or the split date/time the forms use.
    $scheduledAt = null;
    $hasSchedule = false;
    if (array_key_exists('scheduled_visit_at', $payload)) {
        $scheduledAt = student_contact_iso_datetime($payload['scheduled_visit_at']);
        $hasSchedule = true;
    } elseif (isset($payload['scheduled_date'])) {
        $scheduledAt = student_contact_combine_date_time(
            $payload['scheduled_date'] ?? null,
            $payload['scheduled_time'] ?? null
        );
        $hasSchedule = true;
    }
    if ($hasSchedule) {
        $sets[] = 'scheduled_visit_at = :scheduled_visit_at';
        $params[':scheduled_visit_at'] = $scheduledAt;
    }

    if (array_key_exists('visit_remarks', $payload)) {
        $sets[] = 'visit_remarks = :visit_remarks';
        $params[':visit_remarks'] = student_contact_normalize_text($payload['visit_remarks']);
    }

    // Saving a final outcome completes the CSDL visit. The user can still edit
    // an already-completed outcome later; the new attempt becomes the audit
    // trail and the latest recorded result.
    $queueStatus = $hasFinalOutcome ? 'completed' : null;
    if (!$hasFinalOutcome && array_key_exists('queue_status', $payload)) {
        $queueStatus = student_contact_normalize_token($payload['queue_status'] ?? '');
        if (!in_array($queueStatus, STUDENT_HOME_VISIT_QUEUE_STATUSES, true)) {
            throw new InvalidArgumentException(
                'queue_status must be one of: ' . implode(', ', STUDENT_HOME_VISIT_QUEUE_STATUSES)
            );
        }

        // Scheduling without a date would leave a visit nobody can attend.
        $effectiveSchedule = $hasSchedule ? $scheduledAt : ($existing['scheduled_visit_at'] ?? null);
        if ($queueStatus === 'scheduled' && $effectiveSchedule === null) {
            throw new InvalidArgumentException('A scheduled visit needs a visit date.');
        }

    }
    if ($queueStatus !== null) {
        $sets[] = 'queue_status = :queue_status';
        $params[':queue_status'] = $queueStatus;

        // Completing stamps the time; reopening clears it, so a reopened visit
        // does not still read as finished.
        if ($queueStatus === 'completed') {
            $sets[] = 'completed_at = COALESCE(completed_at, :completed_at)';
            $params[':completed_at'] = student_contact_now()->format('Y-m-d H:i:s');
        } else {
            $sets[] = 'completed_at = NULL';
        }
    }

    if (empty($sets)) {
        throw new InvalidArgumentException('No changes were supplied.');
    }

    /*
     * The term a final outcome is stamped with: the referral's, unless that
     * semester has been closed, in which case the calendar's. A visit that
     * finishes after its semester closed is recorded, not refused - see
     * lib/term_closure.php. The period moves with the term: the referral's P2
     * says nothing about the semester the visit finished in.
     */
    $outcomeTerm = [
        'school_year_id' => $existing['source_school_year_id'] ?? null,
        'semester_id' => $existing['source_semester_id'] ?? null,
        'period' => $existing['source_period'] ?? null,
    ];
    if ($enrollmentStatusId !== null && (empty($outcomeTerm['school_year_id']) || empty($outcomeTerm['semester_id']))) {
        $calendar = academic_calendar_current($pdo);
        $outcomeTerm = [
            'school_year_id' => $calendar['school_year_id'] ?? null,
            'semester_id' => $calendar['semester_id'] ?? null,
            'period' => $calendar['period'] ?? null,
        ];
        if (empty($outcomeTerm['school_year_id']) || empty($outcomeTerm['semester_id'])) {
            throw new InvalidArgumentException('Set the current academic term before updating the enrollment outcome.');
        }
    }
    if (($hasFinalOutcome || $enrollmentStatusId !== null) && term_closure_is_closed($pdo, $outcomeTerm['school_year_id'], $outcomeTerm['semester_id'])) {
        $calendar = academic_calendar_current($pdo);
        $closedTerm = term_closure_block($pdo, [$calendar['school_year_id'] ?? null, $calendar['semester_id'] ?? null]);
        if ($closedTerm !== null) {
            throw new TermClosedException($closedTerm);
        }
        $outcomeTerm = [
            'school_year_id' => $calendar['school_year_id'] ?? null,
            'semester_id' => $calendar['semester_id'] ?? null,
            'period' => $calendar['period'] ?? null,
        ];
    }

    $pdo->beginTransaction();
    try {
        $stmt = $pdo->prepare(
            'UPDATE student_home_visit SET ' . implode(', ', $sets) . ' WHERE home_visit_id = :home_visit_id'
        );
        $stmt->execute($params);

        if ($enrollmentStatusId !== null) {
            $enrollmentStmt = $pdo->prepare(
                'INSERT INTO enrollment_status (student_id, school_year_id, semester_id, status_type, `date`, reason)
                 VALUES (:student_id, :school_year_id, :semester_id, :status_type, :recorded_date, :reason)
                 ON DUPLICATE KEY UPDATE status_type = VALUES(status_type), `date` = VALUES(`date`), reason = VALUES(reason)'
            );
            $enrollmentStmt->execute([
                ':student_id' => (int)$existing['student_id'],
                ':school_year_id' => $outcomeTerm['school_year_id'],
                ':semester_id' => $outcomeTerm['semester_id'],
                ':status_type' => $enrollmentStatusId,
                ':recorded_date' => student_contact_now()->format('Y-m-d'),
                ':reason' => $enrollmentReason,
            ]);
        }

        if ($hasFinalOutcome && $finalOutcomeKey !== ($existing['final_outcome_key'] ?? null)) {
            $recordedAt = student_contact_now()->format('Y-m-d H:i:s');
            $statusKey = student_contact_status_key(
                student_contact_status_for_intervention($finalOutcomeKey)
            );
            $actorUserId = (int)($access['user_id'] ?? 0);
            $actorRoleId = (int)($access['role_id'] ?? 0);
            $notes = array_key_exists('visit_remarks', $payload)
                ? student_contact_normalize_text($payload['visit_remarks'])
                : student_contact_normalize_text($existing['visit_remarks'] ?? null);

            $attemptStmt = $pdo->prepare(
                'INSERT INTO student_contact_attempt
                    (contact_case_id, student_id, attempted_by_user_id, attempted_by_role_id,
                     contact_method, contact_status, recovery_plan_id, intervention_status,
                     contacted_at, school_year_id, semester_id, period, notes)
                 VALUES
                    (:case_id, :student_id, :user_id, :role_id,
                     :method, :status, :recovery_plan_id, :intervention_status,
                     :contacted_at, :school_year_id, :semester_id, :period, :notes)'
            );
            $attemptStmt->execute([
                ':case_id' => (int)$existing['contact_case_id'],
                ':student_id' => (int)$existing['student_id'],
                ':user_id' => $actorUserId > 0 ? $actorUserId : null,
                ':role_id' => $actorRoleId > 0 ? $actorRoleId : null,
                ':method' => 'home_visit',
                ':status' => $statusKey,
                ':recovery_plan_id' => $existing['source_recovery_plan_id'] ?? null,
                ':intervention_status' => $finalOutcomeKey,
                ':contacted_at' => $recordedAt,
                ':school_year_id' => $outcomeTerm['school_year_id'],
                ':semester_id' => $outcomeTerm['semester_id'],
                ':period' => $outcomeTerm['period'],
                ':notes' => $notes,
            ]);
            $attemptId = (int)$pdo->lastInsertId();

            $caseStmt = $pdo->prepare(
                'UPDATE student_contact_case
                    SET latest_attempt_id = :attempt_id,
                        latest_contact_status = :status,
                        latest_contacted_at = :contacted_at,
                        next_follow_up_at = NULL,
                        workflow_status = :workflow_status
                  WHERE case_id = :case_id'
            );
            $caseStmt->execute([
                ':attempt_id' => $attemptId,
                ':status' => $statusKey,
                ':contacted_at' => $recordedAt,
                ':workflow_status' => 'completed',
                ':case_id' => (int)$existing['contact_case_id'],
            ]);
        }

        student_contact_write_audit_log(
            $pdo,
            $access['actor'] ?? null,
            'Updated home visit for ' . trim((string)($existing['student_number'] ?? ''))
                . ' - ' . trim((string)($existing['last_name'] ?? '') . ', ' . (string)($existing['first_name'] ?? '')),
            [
                'home_visit_id' => $homeVisitId,
                'student_id' => (int)($existing['student_id'] ?? 0),
                'contact_case_id' => (int)($existing['contact_case_id'] ?? 0),
                'queue_status' => $queueStatus ?? ($existing['queue_status'] ?? null),
                'previous_queue_status' => $existing['queue_status'] ?? null,
                'assigned_staff_user_id' => $params[':assigned_staff_user_id'] ?? ($existing['assigned_staff_user_id'] ?? null),
                'scheduled_visit_at' => $hasSchedule ? $scheduledAt : ($existing['scheduled_visit_at'] ?? null),
                'final_outcome' => $finalOutcomeKey ?? ($existing['final_outcome_key'] ?? null),
                'previous_final_outcome' => $existing['final_outcome_key'] ?? null,
            ],
            STUDENT_HOME_VISIT_AUDIT_ACTION
        );

        $pdo->commit();
    } catch (Throwable $throwable) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $throwable;
    }

    $refreshed = student_home_visit_rows($pdo, $access, $homeVisitId);
    if (empty($refreshed)) {
        throw new RuntimeException('Failed to reload the updated home visit record.');
    }

    return $refreshed[0];
}

function student_contact_report_data(PDO $pdo, array $access): array
{
    $isHomeVisitOnly = !empty($access['is_csdl'])
        && empty($access['is_admin'])
        && empty($access['is_coordinator'])
        && empty($access['is_department_scoped'])
        && empty($access['is_ssp_caller']);

    $rows = $isHomeVisitOnly
        ? student_home_visit_rows($pdo, $access)
        : student_contact_queue_rows($pdo, $access, ['queue' => FOLLOW_UP_QUEUE_ALL]);

    $summary = [
        'total_students' => count($rows),
        'contacted_students' => 0,
        'uncontacted_students' => 0,
        'follow_up_students' => 0,
        'escalated_cases' => 0,
        'queued_home_visits' => 0,
        'scheduled_home_visits' => 0,
        'completed_home_visits' => 0,
    ];

    $statusCounts = [
        'contacted' => 0,
        'pending' => 0,
        'no_response' => 0,
        'follow_up_needed' => 0,
    ];
    $departmentMap = [];
    $recentEscalations = [];

    foreach ($rows as $row) {
        $statusLabel = student_contact_status_label($row['current_status'] ?? $row['queue_status'] ?? '');
        $statusKey = student_contact_status_key($statusLabel);
        $departmentKey = trim((string)($row['department_name'] ?? '')) !== ''
            ? trim((string)$row['department_name'])
            : 'Unassigned';

        if (!isset($departmentMap[$departmentKey])) {
            $departmentMap[$departmentKey] = [
                'key' => strtolower(preg_replace('/[^a-z0-9]+/i', '-', $departmentKey) ?? 'unassigned'),
                'label' => $departmentKey,
                'total' => 0,
                'contacted' => 0,
                'escalated' => 0,
                'completed_home_visits' => 0,
            ];
        }

        $departmentMap[$departmentKey]['total']++;

        if ($statusKey === 'contacted') {
            $summary['contacted_students']++;
            $statusCounts['contacted']++;
            $departmentMap[$departmentKey]['contacted']++;
        } elseif ($statusKey === 'pending') {
            $summary['uncontacted_students']++;
            $summary['follow_up_students']++;
            $statusCounts['pending']++;
        } elseif ($statusKey === 'no_response') {
            $summary['follow_up_students']++;
            $summary['escalated_cases']++;
            $summary['queued_home_visits']++;
            $statusCounts['no_response']++;
            $departmentMap[$departmentKey]['escalated']++;
        } elseif ($statusKey === 'follow_up_needed') {
            $summary['follow_up_students']++;
            $summary['escalated_cases']++;
            $summary['queued_home_visits']++;
            $statusCounts['follow_up_needed']++;
            $departmentMap[$departmentKey]['escalated']++;
        }

        if (student_contact_is_home_visit_status($statusKey)) {
            $recentEscalations[] = [
                'home_visit_id' => isset($row['home_visit_id']) ? (int)$row['home_visit_id'] : (int)($row['enrollment_status_id'] ?? 0),
                'student_id' => (int)($row['student_id'] ?? 0),
                'student_number' => $row['student_number'] ?? '',
                'first_name' => $row['first_name'] ?? '',
                'last_name' => $row['last_name'] ?? '',
                'department_name' => $row['department_name'] ?? '',
                'course_name' => $row['course_name'] ?? '',
                'queue_status' => $statusLabel,
                'assigned_staff_name' => $row['updated_by_name'] ?? '',
                'escalation_reason' => 'Current contact status is ' . $statusLabel . '.',
                'created_at' => $row['last_updated_at'] ?? null,
                'scheduled_visit_at' => null,
            ];
        }
    }

    usort($recentEscalations, static function (array $left, array $right): int {
        return strcmp((string)($right['created_at'] ?? ''), (string)($left['created_at'] ?? ''));
    });

    $departmentRows = array_values($departmentMap);
    usort($departmentRows, static function (array $left, array $right): int {
        if (($right['total'] ?? 0) !== ($left['total'] ?? 0)) {
            return (int)($right['total'] ?? 0) - (int)($left['total'] ?? 0);
        }

        return strcmp((string)($left['label'] ?? ''), (string)($right['label'] ?? ''));
    });

    return [
        'summary' => $summary,
        'by_status' => [
            ['key' => 'contacted', 'label' => 'Contacted', 'value' => $statusCounts['contacted'], 'color' => '#16a34a'],
            ['key' => 'pending', 'label' => 'Pending', 'value' => $statusCounts['pending'], 'color' => '#2563eb'],
            ['key' => 'no_response', 'label' => 'No Response', 'value' => $statusCounts['no_response'], 'color' => '#dc2626'],
            ['key' => 'follow_up_needed', 'label' => 'Follow Up Needed', 'value' => $statusCounts['follow_up_needed'], 'color' => '#d97706'],
        ],
        'by_home_visit_status' => [
            ['key' => 'no_response', 'label' => 'No Response', 'value' => $statusCounts['no_response'], 'color' => '#dc2626'],
            ['key' => 'follow_up_needed', 'label' => 'Follow Up Needed', 'value' => $statusCounts['follow_up_needed'], 'color' => '#d97706'],
        ],
        'by_department' => $departmentRows,
        'recent_escalations' => array_slice($recentEscalations, 0, 8),
        'completion_logs' => [],
        'scope_mode' => $isHomeVisitOnly ? 'home_visits' : (!empty($access['is_admin']) ? 'all' : 'contacts'),
        'settings' => [
            'statuses' => array_values(STUDENT_CONTACT_STATUS_LABELS),
        ],
    ];
}
