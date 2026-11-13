<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
// The PDO segment matrix, so a case reads the same Priority 1-4 here as the
// caller screens and the prioritization list show for the same student.
require_once __DIR__ . '/pdo_priority_lib.php';
require_once __DIR__ . '/periodic_lib.php';
require_once __DIR__ . '/risk_model_service.php';
// Who may write what to a case. Pure policy, kept out of this file so it can
// be tested without standing up a request -- see lib/retention_case_policy.php.
require_once __DIR__ . '/lib/retention_case_policy.php';
// The term the school is in, which is the half of a limited
// interventionist's window that says WHICH P1 -- see
// case_limited_interventionist_scope().
require_once __DIR__ . '/lib/academic_calendar.php';
// A closed semester's cases are read-only. See lib/term_closure.php.
require_once __DIR__ . '/lib/term_closure.php';

const SSP_CALLER_ROLE_ID = 6;
const STAR_SSP_CALLER_ROLE_ID = 12;
// CASE_RISK_LEVELS, CASE_VALIDATION_STATUSES and CASE_INTERVENTION_STATUSES
// come from lib/retention_case_policy.php, required above.
const CASE_NOTE_TYPES = ['evaluation', 'validation', 'intervention', 'follow_up', 'system'];
const SURVEY_RISK_KEYWORDS = [
    'financial' => ['financial', 'tuition', 'allowance', 'money', 'payment', 'balance', 'scholarship'],
    'transfer' => ['transfer', 'migrate', 'migration', 'relocate', 'shift', 'move'],
    'family' => ['family', 'parent', 'guardian', 'pregnant', 'childcare', 'caregiver'],
    'health' => ['health', 'sick', 'ill', 'depress', 'anxiety', 'stress', 'mental', 'panic'],
    'work' => ['work', 'job', 'employment', 'schedule', 'overtime', 'shiftwork'],
    'academic' => ['failing', 'failed', 'difficulty', 'difficult', 'struggle', 'overload'],
];


function normalize_text($value): ?string {
    if ($value === null) {
        return null;
    }
    $text = trim((string)$value);
    return $text === '' ? null : $text;
}

function normalize_role_token_value($value): string {
    return api_normalize_role_token($value);
}

function is_allowed_value(?string $value, array $allowedValues, string $fallback): string {
    $token = strtolower(trim((string)$value));
    return in_array($token, $allowedValues, true) ? $token : $fallback;
}

function require_case_access(array $authUser, array $modulePermissions): array {
    $isAdmin = api_session_user_has_role($authUser, ['admin']);
    $isDepartmentPinned = api_user_is_department_pinned($authUser);
    $isSsg = api_session_user_has_role($authUser, ['ssg']);
    $isCoordinator = api_session_user_has_role($authUser, ['ssp-coordinator']);
    $isCaller = api_session_user_has_role($authUser, ['ssp-caller', 12]);
    $canViewModule = api_can($modulePermissions, 'retention_cases', 'view');
    $canEditModule = api_can($modulePermissions, 'retention_cases', 'edit');
    $canAssignModule = api_can($modulePermissions, 'retention_cases', 'assign');
    $canAnalyzeModule = api_can($modulePermissions, 'retention_cases', 'analyze');
    $canCreateModule = api_can($modulePermissions, 'retention_cases', 'create');
    $canDeleteModule = api_can($modulePermissions, 'retention_cases', 'delete');
    /*
     * Recording what you did about a student, split from approving the case.
     *
     * These were one permission -- `edit` opened both -- and they are two
     * different jobs. Writing "called the parent, they will come in Friday" is
     * the work; deciding the case was correctly flagged and may be closed is a
     * sign-off. Faculty were given the first and must not get the second, and
     * with one gate there was no way to say that.
     *
     * `edit` still implies it, so every role that could record an intervention
     * before still can and no existing grant changed meaning.
     */
    $canInterveneModule = api_can($modulePermissions, 'retention_cases', 'intervene');

    if (!$canViewModule) {
        api_out(403, ['message' => 'You do not have permission to view retention cases.']);
    }

    return [
        'is_admin' => $isAdmin,
        'is_department_pinned' => $isDepartmentPinned,
        'is_ssg' => $isSsg,
        'is_coordinator' => $isCoordinator,
        'is_caller' => $isCaller,
        'can_view_module' => $canViewModule,
        'can_create_module' => $canCreateModule,
        'can_edit_module' => $canEditModule,
        'can_delete_module' => $canDeleteModule,
        'can_assign_module' => $canAssignModule,
        'can_analyze_module' => $canAnalyzeModule,
        'can_run_evaluation' => $canAnalyzeModule,
        'can_validate' => $canEditModule,
        'can_assign' => $canAssignModule,
        'can_update_intervention' => $canEditModule || $canInterveneModule,

        /*
         * A role holding `intervene` WITHOUT `edit` is a limited interventionist
         * -- faculty, today -- and may only act on the early periodicals. See
         * case_period_is_open_to_limited_intervention().
         *
         * Expressed as "narrow grant" rather than "is faculty" on purpose. The
         * restriction belongs to the shape of the permission, not to one role's
         * name, so a second role granted the same narrow access inherits the
         * same limit without another branch here.
         */
        'is_limited_interventionist' => $canInterveneModule && !$canEditModule,
    ];
}

function ensure_retention_case_tables(PDO $pdo): void {
    static $initialized = false;

    if ($initialized) {
        return;
    }

    api_require_table($pdo, 'retention_case');
    api_require_table($pdo, 'retention_case_note');

    $initialized = true;
}

/**
 * The people a retention case may be handed to: the two WORKER roles only.
 *
 * The same two roles fetch_follow_up_team_members() in ssp_assignment.php
 * offers since 2026-10-01, when the board stopped storing a coach and
 * supervisor pair per student and went to one coach. Until then the board also
 * offered roles 5 and 7, and this list was the narrower one on purpose.
 *
 * Offering a supervisor here would let a case be owned by a coordinator with
 * no worker on it at all. Checked against the data on 2026-09-14: 0 of 1,703
 * cases name a supervisor, so nothing is being hidden by this.
 *
 * The role_name clause below is belt-and-braces against renumbered roles. It
 * currently matches nobody the role ids do not already catch ('star-ssp-caller'
 * predates KASAMA's rename), and is kept only for that resilience.
 */
function fetch_case_owner_candidates(PDO $pdo): array {
    $sql = "SELECT
                u.user_id,
                u.role AS role_id,
                u.first_name,
                u.last_name,
                u.email,
                u.status,
                s.status_name
            FROM user u
            LEFT JOIN role r ON r.role_id = u.role
            LEFT JOIN status s ON s.status_id = u.status
            WHERE u.role IN (:ssp_role_id, :star_ssp_role_id)
               OR LOWER(REPLACE(REPLACE(COALESCE(r.role_name, ''), '_', '-'), ' ', '-')) IN ('ssp-caller', 'star-ssp-caller')
            ORDER BY CASE WHEN u.status = 1 THEN 0 ELSE 1 END, u.first_name ASC, u.last_name ASC, u.user_id ASC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([
        ':ssp_role_id' => SSP_CALLER_ROLE_ID,
        ':star_ssp_role_id' => STAR_SSP_CALLER_ROLE_ID,
    ]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    // Tag each caller with the student type their role can actually open, so the
    // assign dropdown can narrow itself per case instead of offering someone the
    // student-type scope would immediately hide the student from.
    foreach ($rows as &$row) {
        $row['handles_student_type'] = api_student_type_for_role_id((int)($row['role_id'] ?? 0));
    }
    unset($row);

    return $rows;
}

function fetch_case_row(PDO $pdo, int $caseId): ?array {
    $sql = "SELECT
                rc.case_id,
                rc.student_id,
                rc.department_id,
                rc.semester_id,
                rc.school_year_id,
                rc.period,
                rc.grade_record_id,
                rc.survey_submission_id,
                rc.academic_risk_level,
                rc.survey_risk_level,
                rc.combined_risk_level,
                rc.evaluation_score,
                rc.evaluation_reason,
                rc.validation_status,
                rc.intervention_status,
                rc.assigned_to_user_id,
                rc.assigned_by_user_id,
                rc.follow_up_date,
                rc.outcome_summary,
                rc.evaluated_by_user_id,
                rc.evaluated_at,
                rc.validated_by_user_id,
                rc.validated_at,
                rc.created_at,
                rc.updated_at,
                st.student_number,
                st.first_name,
                st.last_name,
                st.email_address,
                st.`star e-profile` AS student_type,
                st.year_level,
                st.section,
                c.course_name,
                c.course_code,
                d.department_name,
                sem.semester_name,
                sy.schoolyear_name,
                CONCAT(COALESCE(assignee.first_name, ''), CASE WHEN assignee.last_name IS NOT NULL AND assignee.last_name <> '' THEN CONCAT(' ', assignee.last_name) ELSE '' END) AS assigned_to_name,
                assignee.email AS assigned_to_email,
                CONCAT(COALESCE(assigner.first_name, ''), CASE WHEN assigner.last_name IS NOT NULL AND assigner.last_name <> '' THEN CONCAT(' ', assigner.last_name) ELSE '' END) AS assigned_by_name,
                CONCAT(COALESCE(evaluator.first_name, ''), CASE WHEN evaluator.last_name IS NOT NULL AND evaluator.last_name <> '' THEN CONCAT(' ', evaluator.last_name) ELSE '' END) AS evaluated_by_name,
                CONCAT(COALESCE(validator.first_name, ''), CASE WHEN validator.last_name IS NOT NULL AND validator.last_name <> '' THEN CONCAT(' ', validator.last_name) ELSE '' END) AS validated_by_name,
                note_counts.note_count,
                last_note.note_type AS last_note_type,
                last_note.note_body AS last_note_body,
                last_note.created_at AS last_note_created_at
            FROM retention_case rc
            INNER JOIN student st ON st.student_id = rc.student_id
            LEFT JOIN course c ON c.course_id = st.course_id
            LEFT JOIN department d ON d.department_id = rc.department_id
            LEFT JOIN semester sem ON sem.semester_id = rc.semester_id
            LEFT JOIN school_year sy ON sy.school_year_id = rc.school_year_id
            LEFT JOIN user assignee ON assignee.user_id = rc.assigned_to_user_id
            LEFT JOIN user assigner ON assigner.user_id = rc.assigned_by_user_id
            LEFT JOIN user evaluator ON evaluator.user_id = rc.evaluated_by_user_id
            LEFT JOIN user validator ON validator.user_id = rc.validated_by_user_id
            LEFT JOIN (
                SELECT case_id, COUNT(*) AS note_count
                FROM retention_case_note
                GROUP BY case_id
            ) note_counts ON note_counts.case_id = rc.case_id
            LEFT JOIN (
                SELECT note.case_id, note.note_type, note.note_body, note.created_at
                FROM retention_case_note note
                INNER JOIN (
                    SELECT case_id, MAX(note_id) AS latest_note_id
                    FROM retention_case_note
                    GROUP BY case_id
                ) latest ON latest.latest_note_id = note.note_id
            ) last_note ON last_note.case_id = rc.case_id
            WHERE rc.case_id = :case_id
            LIMIT 1";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':case_id' => $caseId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return null;
    }

    $row['note_count'] = isset($row['note_count']) ? (int)$row['note_count'] : 0;
    $row['evaluation_score'] = isset($row['evaluation_score']) ? (float)$row['evaluation_score'] : 0;
    return $row;
}

function fetch_case_notes(PDO $pdo, int $caseId): array {
    $sql = "SELECT
                note.note_id,
                note.case_id,
                note.note_type,
                note.note_body,
                note.created_by_user_id,
                note.created_at,
                CONCAT(COALESCE(u.first_name, ''), CASE WHEN u.last_name IS NOT NULL AND u.last_name <> '' THEN CONCAT(' ', u.last_name) ELSE '' END) AS created_by_name
            FROM retention_case_note note
            LEFT JOIN user u ON u.user_id = note.created_by_user_id
            WHERE note.case_id = :case_id
            ORDER BY note.created_at DESC, note.note_id DESC";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':case_id' => $caseId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

function enforce_case_scope(PDO $pdo, array $caseRow, array $authUser, array $roleContext, bool $requireAssignmentForCaller = false): void {
    if (!api_student_type_is_allowed($authUser, $caseRow['student_type'] ?? null)) {
        api_out(403, ['message' => api_student_type_access_denied_message()]);
    }

    if ($roleContext['is_admin']) {
        return;
    }

    $sessionUserId = (int)($authUser['user_id'] ?? 0);
    $departmentId = (int)($authUser['department_id'] ?? 0);

    if ($roleContext['is_department_pinned']) {
        /*
         * Matched across campuses, exactly as the list is.
         *
         * A strict id comparison here contradicted build_case_filters(): the
         * board would show a CITE dean a case on the other CITE campus and
         * then 403 them for clicking it. A scope enforced in two places has
         * to be the same scope in both.
         */
        if (!api_department_matches($pdo, $departmentId, (int)($caseRow['department_id'] ?? 0))) {
            api_out(403, ['message' => 'Forbidden']);
        }
        return;
    }

    if ($roleContext['is_coordinator']) {
        return;
    }

    if (!empty($roleContext['is_ssg'])) {
        return;
    }

    if ($roleContext['is_caller']) {
        if ($requireAssignmentForCaller && (int)($caseRow['assigned_to_user_id'] ?? 0) !== $sessionUserId) {
            api_out(403, ['message' => 'No permission for this action.']);
        }
        if ((int)($caseRow['assigned_to_user_id'] ?? 0) !== $sessionUserId) {
            api_out(403, ['message' => 'You do not have permission to view this retention case.']);
        }
        return;
    }
}

/**
 * The grade rows one evaluation run walks, one per student.
 *
 * `$period` is which retention period is being evaluated. Given 1, 2 or 3 this
 * reads that periodical's row, so a P2 run judges the student on P2 numbers.
 *
 * Given null it runs at semester level, and then it has to choose: a student
 * may now hold a whole-semester row and up to three periodicals, and evaluating
 * all four would upsert the same case four times and leave whichever the sort
 * happened to visit last. The rollup below picks one - the newest periodical
 * where the student has any, the whole-semester row where they do not - which
 * is the same precedence grades.php uses for its own semester figure. With no
 * periodical data recorded the two behave identically; they only diverge once
 * periodicals exist, where the old behaviour was undefined rather than
 * different.
 */
function build_grade_rows(PDO $pdo, ?int $departmentId, ?int $semesterId, ?int $schoolYearId, ?array $authUser = null, $period = null): array {
    $hasRemarkIdColumn = api_column_exists($pdo, 'grades', 'remark_id');
    $hasRemarksColumn = api_column_exists($pdo, 'grades', 'remarks');

    $remarkSelect = "'Low Risk' AS remark_risk_level, NULL AS remark_name";
    $remarkJoin = '';

    if ($hasRemarkIdColumn) {
        $remarkSelect = "COALESCE(rm.risk_level, 'Low Risk') AS remark_risk_level, rm.remark_name";
        $remarkJoin = 'LEFT JOIN remarks rm ON rm.remark_id = g.remark_id';
    } elseif ($hasRemarksColumn) {
        $remarkSelect = "CASE
                            WHEN LOWER(COALESCE(g.remarks, '')) LIKE '%high%' THEN 'High Risk'
                            WHEN LOWER(COALESCE(g.remarks, '')) LIKE '%moderate%' THEN 'Moderate Risk'
                            ELSE 'Low Risk'
                         END AS remark_risk_level,
                         g.remarks AS remark_name";
    }

    $whereParts = [];
    $params = [];

    if ($departmentId !== null) {
        // Same widening as the board list; see build_case_filters().
        $whereParts[] = api_department_scope_sql('c.department_id');
        $params[':department_id'] = $departmentId;
    }
    if ($semesterId !== null) {
        $whereParts[] = 'g.semester_id = :semester_id';
        $params[':semester_id'] = $semesterId;
    }
    if ($schoolYearId !== null) {
        $whereParts[] = 'g.school_year_id = :school_year_id';
        $params[':school_year_id'] = $schoolYearId;
    }

    // A named periodical narrows the source rows; the rollup below is what
    // handles the semester-level case.
    [$periodSql, $periodParams] = api_period_filter_sql('g.period', $period, ':evaluation_period');
    if ($periodSql !== '') {
        $whereParts[] = $periodSql;
        $params += $periodParams;
    }

    api_apply_student_type_scope($whereParts, $params, $authUser, 'st.`star e-profile`', ':student_type_scope');

    $whereSql = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

    /*
     * One row per student per term when no periodical was asked for.
     *
     * Wrapping rather than filtering, because "the newest periodical, or the
     * whole-semester row if there is none" is not a WHERE clause - it is a
     * choice made per student. ROW_NUMBER with (period IS NULL) ASC puts the
     * periodicals ahead of the whole-semester row, then the highest periodical
     * first within them.
     */
    $rollupOpen = '';
    $rollupClose = '';
    if ($period === null || $period === '') {
        $rollupOpen = 'SELECT * FROM (';
        $rollupClose = ') ranked WHERE ranked.pick = 1';
    }
    $sql = $rollupOpen . "SELECT
                g.grades_id,
                g.student_id,
                g.semester_id,
                g.school_year_id,
                g.total_subject,
                g.passed,
                g.failed,
                g.incomplete,
                g.no_credit,
                g.no_grade,
                CASE WHEN g.total_subject > 0
                     THEN ROUND(g.passed / g.total_subject * 100, 2)
                     ELSE 0.00 END AS passed_of_subject,
                $remarkSelect,
                st.student_number,
                st.first_name,
                st.last_name,
                st.email_address,
                st.year_level,
                st.section,
                c.course_name,
                c.course_code,
                c.department_id,
                d.department_name,
                sem.semester_name,
                sy.schoolyear_name,
                g.period AS grade_period,
                ROW_NUMBER() OVER (
                    PARTITION BY g.student_id, g.semester_id, g.school_year_id
                    ORDER BY (g.period IS NULL) ASC, g.period DESC, g.grades_id DESC
                ) AS pick
            FROM grades g
            INNER JOIN student st ON st.student_id = g.student_id
            LEFT JOIN course c ON c.course_id = st.course_id
            LEFT JOIN department d ON d.department_id = c.department_id
            LEFT JOIN semester sem ON sem.semester_id = g.semester_id
            LEFT JOIN school_year sy ON sy.school_year_id = g.school_year_id
            $remarkJoin
            $whereSql
            ORDER BY sy.schoolyear_name DESC, g.semester_id DESC, st.last_name ASC, st.first_name ASC, g.grades_id DESC" . $rollupClose;

    $stmt = $pdo->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

/**
 * The survey answers a case is judged on.
 *
 * `$period` is the retention period being evaluated. A submission's period is
 * its survey's period - see migrations/2026_08_21_survey_period.sql for why it
 * lives there and not on the submission.
 *
 * Given a period, this prefers that period's survey and falls back to a
 * whole-semester one. The fallback matters: a P2 run for a student who answered
 * only the semester-wide survey should still read what they said, rather than
 * treating them as having answered nothing. What it will no longer do is read a
 * P1 answer during a P3 run, which is what "most recent submission this
 * semester" quietly did - a student who reported trouble in P1 and recovered by
 * P3 stayed flagged on the old answer.
 *
 * Ordering does the choosing: (sv.period IS NULL) ASC puts an exact-period
 * survey ahead of a whole-semester one, and only then does recency apply.
 */
function fetch_latest_submission_for_grade(PDO $pdo, int $studentId, ?int $semesterId, ?int $period = null): ?array {
    $params = [':student_id' => $studentId];
    $whereSemester = '';
    if ($semesterId !== null) {
        $whereSemester = ' AND sv.semester_id = :semester_id';
        $params[':semester_id'] = $semesterId;
    }

    $wherePeriod = '';
    $orderPeriod = '';
    if ($period !== null) {
        $wherePeriod = ' AND (sv.period = :survey_period OR sv.period IS NULL)';
        $orderPeriod = '(sv.period IS NULL) ASC, ';
        $params[':survey_period'] = $period;
    }

    $sql = "SELECT
                ss.submission_id,
                ss.survey_id,
                ss.student_id,
                ss.submitted_at,
                sv.survey_title,
                sv.period AS survey_period
            FROM survey_submission ss
            LEFT JOIN survey sv ON sv.survey_id = ss.survey_id
            WHERE ss.student_id = :student_id AND ss.archived_at IS NULL$whereSemester$wherePeriod
            ORDER BY $orderPeriod ss.submitted_at DESC, ss.submission_id DESC
            LIMIT 1";

    $stmt = $pdo->prepare($sql);
    foreach ($params as $key => $value) {
        $stmt->bindValue($key, $value, PDO::PARAM_INT);
    }
    $stmt->execute();
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function fetch_submission_answers(PDO $pdo, int $submissionId): array {
    $stmt = $pdo->prepare('SELECT answer FROM survey_answer WHERE submission_id = :submission_id ORDER BY answer_id ASC');
    $stmt->execute([':submission_id' => $submissionId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
    return array_values(array_filter(array_map(function ($row) {
        return normalize_text($row['answer'] ?? null);
    }, $rows)));
}

function normalize_risk_level_text(?string $value): string {
    $token = strtolower(trim((string)$value));
    if ($token === 'high' || $token === 'high risk') {
        return 'high';
    }
    if ($token === 'moderate' || $token === 'moderate risk' || $token === 'medium' || $token === 'medium risk') {
        return 'moderate';
    }
    return 'low';
}

function extract_survey_keyword_groups(array $answers): array {
    $text = strtolower(implode(' ', $answers));
    if ($text === '') {
        return [];
    }

    $hits = [];
    foreach (SURVEY_RISK_KEYWORDS as $group => $keywords) {
        foreach ($keywords as $keyword) {
            if (strpos($text, strtolower($keyword)) !== false) {
                $hits[] = $group;
                break;
            }
        }
    }

    return array_values(array_unique($hits));
}

function evaluate_academic_risk(array $gradeRow): array {
    $score = 0;
    $reasons = [];
    $remarkRisk = normalize_risk_level_text($gradeRow['remark_risk_level'] ?? null);
    $failed = (int)($gradeRow['failed'] ?? 0);
    $incomplete = (int)($gradeRow['incomplete'] ?? 0);
    $passedRate = isset($gradeRow['passed_of_subject']) ? (float)$gradeRow['passed_of_subject'] : null;

    if ($remarkRisk === 'high') {
        $score += 3;
        $reasons[] = 'Grade remark is tagged as high risk.';
    } elseif ($remarkRisk === 'moderate') {
        $score += 2;
        $reasons[] = 'Grade remark is tagged as moderate risk.';
    }

    if ($failed >= 3) {
        $score += 3;
        $reasons[] = 'Student failed three or more subjects.';
    } elseif ($failed >= 1) {
        $score += 2;
        $reasons[] = 'Student has failed subjects.';
    }

    if ($incomplete >= 2) {
        $score += 2;
        $reasons[] = 'Student has multiple incomplete subjects.';
    } elseif ($incomplete === 1) {
        $score += 1;
        $reasons[] = 'Student has an incomplete subject.';
    }

    if ($passedRate !== null) {
        if ($passedRate < 50) {
            $score += 2;
            $reasons[] = 'Passing rate is below 50%.';
        } elseif ($passedRate < 75) {
            $score += 1;
            $reasons[] = 'Passing rate is below 75%.';
        }
    }

    $riskLevel = 'low';
    if ($score >= 5) {
        $riskLevel = 'high';
    } elseif ($score >= 2) {
        $riskLevel = 'moderate';
    }

    return [
        'score' => $score,
        'risk_level' => $riskLevel,
        'reasons' => $reasons,
    ];
}

function evaluate_survey_risk(?array $submissionRow, array $answers): array {
    $score = 0;
    $reasons = [];

    if (!$submissionRow) {
        $score += 1;
        $reasons[] = 'No survey submission was found for the selected semester.';
    } else {
        $keywordGroups = extract_survey_keyword_groups($answers);
        if (count($keywordGroups) >= 3) {
            $score += 2;
            $reasons[] = 'Survey answers contain multiple at-risk indicators: ' . implode(', ', $keywordGroups) . '.';
        } elseif (count($keywordGroups) >= 1) {
            $score += 1;
            $reasons[] = 'Survey answers contain at-risk indicators: ' . implode(', ', $keywordGroups) . '.';
        }
    }

    $riskLevel = 'low';
    if ($score >= 2) {
        $riskLevel = 'high';
    } elseif ($score >= 1) {
        $riskLevel = 'moderate';
    }

    return [
        'score' => $score,
        'risk_level' => $riskLevel,
        'reasons' => $reasons,
    ];
}

/**
 * Score a student with the active configurable model, falling back to the
 * legacy hardcoded ladder below when no model is active or the risk_model
 * tables have not been migrated yet.
 *
 * The fallback is not dead weight: it keeps this endpoint working on a database
 * that has not run 2026-07-28_risk_model.sql, and it is what runs until an
 * admin deliberately activates a model.
 */
function evaluate_student_risk(
    PDO $pdo,
    array $gradeRow,
    ?array $submissionRow,
    array $answers,
    $period = null
): array {
    $semesterId   = isset($gradeRow['semester_id']) ? (int)$gradeRow['semester_id'] : null;
    $schoolYearId = isset($gradeRow['school_year_id']) ? (int)$gradeRow['school_year_id'] : null;

    $model = risk_model_get_active($pdo, $schoolYearId, $semesterId);
    if ($model === null) {
        $legacy = evaluate_combined_risk($gradeRow, $submissionRow, $answers);
        $legacy['model_id'] = null;
        $legacy['hits'] = [];
        return $legacy;
    }

    /*
     * $period reaches the signal collector so attendance and finance are read
     * for the periodical this run is judging, not for the whole semester. The
     * grade row is already that periodical's - build_grade_rows() filtered it -
     * but the other two are re-queried here, and without the period they came
     * back as the term rollup. A P2 run then scored P2 grades against P1+P2+P3
     * absences, which is how a student who missed a third of P1 and nothing
     * since kept an absence flag in P2.
     */
    $signals = risk_collect_signals(
        $pdo,
        (int)($gradeRow['student_id'] ?? 0),
        $semesterId,
        $schoolYearId,
        $gradeRow,
        $submissionRow,
        $period
    );

    return risk_evaluate_signals($model, $signals);
}

function evaluate_combined_risk(array $gradeRow, ?array $submissionRow, array $answers): array {
    $academic = evaluate_academic_risk($gradeRow);
    $survey = evaluate_survey_risk($submissionRow, $answers);
    $score = (float)$academic['score'] + (float)$survey['score'];
    $reasons = array_values(array_unique(array_merge($academic['reasons'], $survey['reasons'])));

    $combinedRisk = 'low';
    if ($score >= 6) {
        $combinedRisk = 'high';
    } elseif ($score >= 3) {
        $combinedRisk = 'moderate';
    }

    return [
        'academic_risk_level' => $academic['risk_level'],
        'survey_risk_level' => $survey['risk_level'],
        'combined_risk_level' => $combinedRisk,
        'evaluation_score' => $score,
        'evaluation_reason' => implode(' ', $reasons),
    ];
}

/**
 * The case this evaluation updates, if there is one.
 *
 * Matched on the period as well as the term, so a P2 run finds the P2 case and
 * leaves P1 alone. COALESCE(period, 0) rather than `period = :period` because
 * NULL never equals NULL in SQL, and the semester-level case is exactly the row
 * where period is NULL - matching it with `=` would find nothing and the
 * evaluation would try to insert a second one on every run.
 */
function find_existing_case(PDO $pdo, int $studentId, ?int $semesterId, ?int $schoolYearId, ?int $period = null): ?array {
    if ($semesterId === null || $schoolYearId === null) {
        return null;
    }

    $stmt = $pdo->prepare(
        'SELECT case_id, validation_status, intervention_status, assigned_to_user_id, assigned_by_user_id, follow_up_date, outcome_summary
         FROM retention_case
         WHERE student_id = :student_id AND semester_id = :semester_id AND school_year_id = :school_year_id
           AND COALESCE(period, 0) = :period_key
         LIMIT 1'
    );
    $stmt->execute([
        ':student_id' => $studentId,
        ':semester_id' => $semesterId,
        ':school_year_id' => $schoolYearId,
        ':period_key' => $period === null ? 0 : $period,
    ]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function upsert_retention_case(PDO $pdo, array $gradeRow, ?array $submissionRow, array $evaluation, int $sessionUserId, ?int $period = null): string {
    $studentId = (int)($gradeRow['student_id'] ?? 0);
    $semesterId = isset($gradeRow['semester_id']) ? (int)$gradeRow['semester_id'] : null;
    $schoolYearId = isset($gradeRow['school_year_id']) ? (int)$gradeRow['school_year_id'] : null;
    $existing = find_existing_case($pdo, $studentId, $semesterId, $schoolYearId, $period);

    $params = [
        ':student_id' => $studentId,
        ':department_id' => isset($gradeRow['department_id']) ? (int)$gradeRow['department_id'] : null,
        ':semester_id' => $semesterId,
        ':school_year_id' => $schoolYearId,
        ':period' => $period,
        ':grade_record_id' => isset($gradeRow['grades_id']) ? (int)$gradeRow['grades_id'] : null,
        ':survey_submission_id' => $submissionRow && isset($submissionRow['submission_id']) ? (int)$submissionRow['submission_id'] : null,
        ':academic_risk_level' => $evaluation['academic_risk_level'],
        ':survey_risk_level' => $evaluation['survey_risk_level'],
        ':combined_risk_level' => $evaluation['combined_risk_level'],
        ':evaluation_score' => $evaluation['evaluation_score'],
        ':evaluation_reason' => normalize_text($evaluation['evaluation_reason'] ?? null),
        ':evaluated_by_user_id' => $sessionUserId,
        ':risk_model_id' => $evaluation['model_id'] ?? null,
    ];

    if ($existing) {
        $updateParams = [
            ':case_id' => (int)$existing['case_id'],
            ':risk_model_id' => $params[':risk_model_id'],
            ':department_id' => $params[':department_id'],
            ':grade_record_id' => $params[':grade_record_id'],
            ':survey_submission_id' => $params[':survey_submission_id'],
            ':academic_risk_level' => $params[':academic_risk_level'],
            ':survey_risk_level' => $params[':survey_risk_level'],
            ':combined_risk_level' => $params[':combined_risk_level'],
            ':evaluation_score' => $params[':evaluation_score'],
            ':evaluation_reason' => $params[':evaluation_reason'],
            ':evaluated_by_user_id' => $params[':evaluated_by_user_id'],
        ];

        $stmt = $pdo->prepare(
            'UPDATE retention_case
             SET department_id = :department_id,
                 grade_record_id = :grade_record_id,
                 survey_submission_id = :survey_submission_id,
                 academic_risk_level = :academic_risk_level,
                 survey_risk_level = :survey_risk_level,
                 combined_risk_level = :combined_risk_level,
                 evaluation_score = :evaluation_score,
                 evaluation_reason = :evaluation_reason,
                 evaluated_by_user_id = :evaluated_by_user_id,
                 risk_model_id = :risk_model_id,
                 evaluated_at = CURRENT_TIMESTAMP
             WHERE case_id = :case_id'
        );
        $stmt->execute($updateParams);
        risk_persist_case_hits($pdo, (int)$existing['case_id'], $evaluation['hits'] ?? []);
        return 'updated';
    }

    $stmt = $pdo->prepare(
        'INSERT INTO retention_case (
            student_id,
            department_id,
            semester_id,
            school_year_id,
            period,
            grade_record_id,
            survey_submission_id,
            academic_risk_level,
            survey_risk_level,
            combined_risk_level,
            evaluation_score,
            evaluation_reason,
            validation_status,
            intervention_status,
            evaluated_by_user_id,
            risk_model_id,
            evaluated_at
         ) VALUES (
            :student_id,
            :department_id,
            :semester_id,
            :school_year_id,
            :period,
            :grade_record_id,
            :survey_submission_id,
            :academic_risk_level,
            :survey_risk_level,
            :combined_risk_level,
            :evaluation_score,
            :evaluation_reason,
            \'pending\',
            \'unassigned\',
            :evaluated_by_user_id,
            :risk_model_id,
            CURRENT_TIMESTAMP
         )'
    );
    $stmt->execute($params);
    risk_persist_case_hits($pdo, (int)$pdo->lastInsertId(), $evaluation['hits'] ?? []);
    return 'created';
}

function build_case_filters(array $authUser, array $roleContext, ?array $currentTerm = null): array {
    $departmentId = (int)($authUser['department_id'] ?? 0);
    $sessionUserId = (int)($authUser['user_id'] ?? 0);
    $whereParts = [];
    $params = [];

    if ($roleContext['is_department_pinned']) {
        if ($departmentId <= 0) {
            return ['where' => 'WHERE 1 = 0', 'params' => []];
        }
        /*
         * Widened across campuses. CITE is department_id 1 AND 11 - one
         * college on two campuses sharing a code - and a dean is appointed
         * to the department, not to the row. `rc.department_id = :x` showed
         * the CITE dean 21 of 31 CITE cases and nothing said the other 10
         * existed.
         */
        $whereParts[] = api_department_scope_sql('rc.department_id');
        $params[':department_id'] = $departmentId;
    } elseif ($roleContext['is_caller']) {
        $whereParts[] = 'rc.assigned_to_user_id = :assigned_to_user_id';
        $params[':assigned_to_user_id'] = $sessionUserId;
    }

    /*
     * A limited interventionist sees only what they can act on.
     *
     * Applied before the request's own filters and ANDed with them, so a
     * hand-typed ?period=3 narrows to nothing rather than widening past the
     * window. This is the enforcement; the dropdown that stops offering P3 is
     * only courtesy.
     */
    $window = case_limited_interventionist_scope($roleContext, $currentTerm);
    if ($window !== null) {
        foreach ($window['where'] as $clause) {
            $whereParts[] = $clause;
        }
        $params += $window['params'];
    }

    $search = normalize_text($_GET['search'] ?? null);
    if ($search !== null) {
        $whereParts[] = '(st.student_number LIKE :q OR st.first_name LIKE :q OR st.last_name LIKE :q OR c.course_name LIKE :q OR d.department_name LIKE :q OR rc.evaluation_reason LIKE :q)';
        $params[':q'] = '%' . $search . '%';
    }

    /*
     * Which retention period's cases to show. Same vocabulary as the three data
     * modules: 1, 2, 3, `term` for the semester-level cases, absent for all of
     * them. Without this a caller opening the list after a P2 run would see the
     * P1 and P2 cases interleaved with no way to tell them apart.
     */
    [$periodSql, $periodParams] = api_period_filter_sql('rc.period', $_GET['period'] ?? null, ':case_period');
    if ($periodSql !== '') {
        $whereParts[] = $periodSql;
        $params += $periodParams;
    }

    /*
     * Which priority band to show, 1-4. Replaced ?risk_level=low|moderate|high.
     *
     * Read here but applied after classification further down, because priority
     * is computed from three signals rather than stored in a column.
     */
    $priorityParam = normalize_text($_GET['priority'] ?? null);
    $priorityFilter = in_array($priorityParam, ['1', '2', '3', '4'], true) ? (int)$priorityParam : null;

    $validationStatus = normalize_text($_GET['validation_status'] ?? null);
    if ($validationStatus !== null) {
        $whereParts[] = 'rc.validation_status = :validation_status';
        $params[':validation_status'] = is_allowed_value($validationStatus, CASE_VALIDATION_STATUSES, 'pending');
    }

    $interventionStatus = normalize_text($_GET['intervention_status'] ?? null);
    if ($interventionStatus !== null) {
        $whereParts[] = 'rc.intervention_status = :intervention_status';
        $params[':intervention_status'] = is_allowed_value($interventionStatus, CASE_INTERVENTION_STATUSES, 'unassigned');
    }

    $assignedTo = normalize_text($_GET['assigned_to_user_id'] ?? null);
    if ($assignedTo !== null && ctype_digit($assignedTo)) {
        $whereParts[] = 'rc.assigned_to_user_id = :filter_assigned_to';
        $params[':filter_assigned_to'] = (int)$assignedTo;
    }
    api_apply_student_type_scope($whereParts, $params, $authUser, 'st.`star e-profile`', ':student_type_scope');

    $whereSql = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));
    /*
     * `priority` rides alongside the SQL rather than in it. It is computed from
     * three signals after the rows are fetched, so fetch_cases_payload() applies
     * it there; returning it here keeps every filter this endpoint honours in
     * one place to read.
     */
    return [
        'where' => $whereSql,
        'params' => $params,
        'priority' => $priorityFilter,
        'window' => $window,
    ];
}

function fetch_cases_payload(PDO $pdo, array $authUser, array $roleContext): array {
    /*
     * Read only for the role whose board is scoped to it. Every other role sees
     * every term, so asking the calendar for them would be a query per request
     * spent on an answer nothing reads.
     */
    $currentTerm = !empty($roleContext['is_limited_interventionist'])
        ? academic_calendar_current($pdo)
        : null;
    $filters = build_case_filters($authUser, $roleContext, $currentTerm);
    $priorityFilter = $filters['priority'] ?? null;
    $sql = "SELECT
                rc.case_id,
                rc.student_id,
                rc.department_id,
                rc.semester_id,
                rc.school_year_id,
                rc.period,
                rc.grade_record_id,
                rc.survey_submission_id,
                rc.academic_risk_level,
                rc.survey_risk_level,
                rc.combined_risk_level,
                rc.evaluation_score,
                rc.evaluation_reason,
                rc.validation_status,
                rc.intervention_status,
                rc.assigned_to_user_id,
                rc.assigned_by_user_id,
                rc.follow_up_date,
                rc.outcome_summary,
                rc.evaluated_by_user_id,
                rc.evaluated_at,
                rc.validated_by_user_id,
                rc.validated_at,
                rc.created_at,
                rc.updated_at,
                st.student_number,
                st.first_name,
                st.last_name,
                st.email_address,
                st.`star e-profile` AS student_type,
                st.year_level,
                st.section,
                c.course_name,
                c.course_code,
                d.department_name,
                sem.semester_name,
                sy.schoolyear_name,
                CONCAT(COALESCE(assignee.first_name, ''), CASE WHEN assignee.last_name IS NOT NULL AND assignee.last_name <> '' THEN CONCAT(' ', assignee.last_name) ELSE '' END) AS assigned_to_name,
                assignee.email AS assigned_to_email,
                CONCAT(COALESCE(assigner.first_name, ''), CASE WHEN assigner.last_name IS NOT NULL AND assigner.last_name <> '' THEN CONCAT(' ', assigner.last_name) ELSE '' END) AS assigned_by_name,
                CONCAT(COALESCE(validator.first_name, ''), CASE WHEN validator.last_name IS NOT NULL AND validator.last_name <> '' THEN CONCAT(' ', validator.last_name) ELSE '' END) AS validated_by_name,
                note_counts.note_count,
                last_note.note_type AS last_note_type,
                last_note.note_body AS last_note_body,
                last_note.created_at AS last_note_created_at
            FROM retention_case rc
            INNER JOIN student st ON st.student_id = rc.student_id
            LEFT JOIN course c ON c.course_id = st.course_id
            LEFT JOIN department d ON d.department_id = rc.department_id
            LEFT JOIN semester sem ON sem.semester_id = rc.semester_id
            LEFT JOIN school_year sy ON sy.school_year_id = rc.school_year_id
            LEFT JOIN user assignee ON assignee.user_id = rc.assigned_to_user_id
            LEFT JOIN user assigner ON assigner.user_id = rc.assigned_by_user_id
            LEFT JOIN user validator ON validator.user_id = rc.validated_by_user_id
            LEFT JOIN (
                SELECT case_id, COUNT(*) AS note_count
                FROM retention_case_note
                GROUP BY case_id
            ) note_counts ON note_counts.case_id = rc.case_id
            LEFT JOIN (
                SELECT note.case_id, note.note_type, note.note_body, note.created_at
                FROM retention_case_note note
                INNER JOIN (
                    SELECT case_id, MAX(note_id) AS latest_note_id
                    FROM retention_case_note
                    GROUP BY case_id
                ) latest ON latest.latest_note_id = note.note_id
            ) last_note ON last_note.case_id = rc.case_id
            {$filters['where']}
            ORDER BY FIELD(rc.combined_risk_level, 'high', 'moderate', 'low'), rc.updated_at DESC, rc.case_id DESC";

    $stmt = $pdo->prepare($sql);
    foreach ($filters['params'] as $key => $value) {
        $stmt->bindValue($key, $value, is_int($value) ? PDO::PARAM_INT : PDO::PARAM_STR);
    }
    $stmt->execute();
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    /*
     * The PDO priority for every case on the list.
     *
     * Three queries for the batch, then the shared classifier - the same code
     * the contact workspace, the assignment board and the prioritization screen
     * call. The scoring engine's combined_risk_level is still computed and still
     * stored; what this page ranks and filters by is the priority, so a case
     * does not read as "high risk" here and "P1" on the screens that act on it.
     */
    $caseStudentIds = array_map(static function (array $row): int {
        return (int)($row['student_id'] ?? 0);
    }, $rows);
    $pdoSettings = pdo_settings($pdo);
    $pdoSignals = pdo_load_signals($pdo, $caseStudentIds);

    $summary = [
        'total_cases' => count($rows),
        'pending_validation' => 0,
        'assigned_cases' => 0,
        'resolved_cases' => 0,
        // Replaces 'high_risk'. Priority 1 is the band the sheet routes to
        // College, which is the same question "how many are urgent" was asking.
        'priority_1' => 0,
        'priority_2' => 0,
        'priority_3' => 0,
        'priority_4' => 0,
    ];

    foreach ($rows as &$row) {
        $row['evaluation_score'] = isset($row['evaluation_score']) ? (float)$row['evaluation_score'] : 0;
        $row['note_count'] = isset($row['note_count']) ? (int)$row['note_count'] : 0;

        $studentId = (int)($row['student_id'] ?? 0);
        $classified = pdo_classify_student(
            ['student_id' => $studentId],
            $pdoSignals['grades'][$studentId] ?? null,
            $pdoSignals['attendance'][$studentId] ?? null,
            $pdoSignals['finance'][$studentId] ?? null,
            $pdoSettings
        );
        $row['priority'] = $classified['priority'];
        $row['priority_owner'] = $classified['owner'];
        $row['priority_label'] = $classified['priority_label'];
        $row['segment'] = $classified['segment'];

        if (($row['validation_status'] ?? '') === 'pending') {
            $summary['pending_validation'] += 1;
        }
        if (in_array(($row['intervention_status'] ?? ''), ['assigned', 'in_progress', 'follow_up', 'resolved'], true)) {
            $summary['assigned_cases'] += 1;
        }
        if (($row['intervention_status'] ?? '') === 'resolved') {
            $summary['resolved_cases'] += 1;
        }
        $summary['priority_' . $classified['priority']] += 1;
    }
    unset($row);

    /*
     * The priority filter, applied here rather than in SQL.
     *
     * Priority is computed from three signals, so it is not a column to put in a
     * WHERE clause. Filtering after classification keeps one classifier; the
     * summary above is deliberately counted BEFORE this, so choosing P1 does not
     * change what the P2 card reports.
     */
    if ($priorityFilter !== null) {
        $rows = array_values(array_filter($rows, static function (array $row) use ($priorityFilter): bool {
            return ($row['priority'] ?? null) === $priorityFilter;
        }));
    }

    return [
        'data' => $rows,
        'summary' => $summary,
        'callers' => !empty($roleContext['can_assign']) ? fetch_case_owner_candidates($pdo) : [],
        'permissions' => [
            'can_run_evaluation' => !empty($roleContext['can_run_evaluation']),
            'can_validate' => !empty($roleContext['can_validate']),
            'can_assign' => !empty($roleContext['can_assign']),
            'can_update_intervention' => !empty($roleContext['can_update_intervention']),
        ],
        /*
         * What this board is showing and why, for the roles it is narrowed for.
         * Null for everyone else. Without it a faculty board with nothing in it
         * is indistinguishable from a broken one, and "no cases matched the
         * current filters" is a lie about filters the user never set.
         */
        'case_window' => $filters['window'] === null ? null : [
            'periods' => $filters['window']['periods'],
            'term_label' => $filters['window']['term_label'],
            'semester_name' => $filters['window']['semester_name'],
            'schoolyear_name' => $filters['window']['schoolyear_name'],
        ],
    ];
}

/** Role id of a user, or 0 when unknown. Used to resolve their student-type scope. */
function assignee_role_id(PDO $pdo, int $userId): int {
    if ($userId <= 0) {
        return 0;
    }

    $stmt = $pdo->prepare('SELECT role AS role_id FROM user WHERE user_id = :user_id LIMIT 1');
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ? (int)($row['role_id'] ?? 0) : 0;
}

function validate_ssp_caller(PDO $pdo, int $userId): bool {
    if ($userId <= 0) {
        return false;
    }

    $stmt = $pdo->prepare(
        "SELECT
            u.user_id,
            u.role AS role_id,
            r.role_name
         FROM user u
         LEFT JOIN role r ON r.role_id = u.role
         WHERE u.user_id = :user_id
         LIMIT 1"
    );
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        return false;
    }

    $roleId = (int)($row['role_id'] ?? 0);
    if ($roleId === SSP_CALLER_ROLE_ID || $roleId === STAR_SSP_CALLER_ROLE_ID) {
        return true;
    }

    return in_array(normalize_role_token_value($row['role_name'] ?? ''), ['ssp-caller', 'star-ssp-caller'], true);
}

function insert_case_note(PDO $pdo, int $caseId, string $noteType, string $noteBody, int $createdByUserId): array {
    $stmt = $pdo->prepare(
        'INSERT INTO retention_case_note (case_id, note_type, note_body, created_by_user_id)
         VALUES (:case_id, :note_type, :note_body, :created_by_user_id)'
    );
    $stmt->execute([
        ':case_id' => $caseId,
        ':note_type' => $noteType,
        ':note_body' => $noteBody,
        ':created_by_user_id' => $createdByUserId > 0 ? $createdByUserId : null,
    ]);

    $noteId = (int)$pdo->lastInsertId();
    $notes = fetch_case_notes($pdo, $caseId);
    foreach ($notes as $note) {
        if ((int)($note['note_id'] ?? 0) === $noteId) {
            return $note;
        }
    }

    return [];
}

try {
    $db = new Database();
    $pdo = $db->connect();
    ensure_retention_case_tables($pdo);

    $authUser = api_get_session_user();
    if (!$authUser) {
        api_out(401, ['message' => 'Authentication required']);
    }

    $permissionRecord = api_fetch_effective_permissions_record(
        $pdo,
        (int)($authUser['role_id'] ?? 0),
        (int)($authUser['user_id'] ?? 0)
    );
    $roleContext = require_case_access($authUser, $permissionRecord['permissions'] ?? []);
    $sessionUserId = (int)($authUser['user_id'] ?? 0);
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET') {
        $caseId = isset($_GET['case_id']) ? (int)$_GET['case_id'] : 0;
        if ($caseId > 0) {
            $caseRow = fetch_case_row($pdo, $caseId);
            if (!$caseRow) {
                api_out(404, ['message' => 'Retention case not found']);
            }
            enforce_case_scope($pdo, $caseRow, $authUser, $roleContext);
            $caseRow['notes'] = fetch_case_notes($pdo, $caseId);
            api_out(200, ['data' => $caseRow]);
        }

        api_out(200, fetch_cases_payload($pdo, $authUser, $roleContext));
    }

    if ($method === 'POST') {
        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            api_out(400, ['message' => 'Invalid JSON']);
        }

        $action = strtolower(trim((string)($payload['action'] ?? '')));

        if ($action === 'run_evaluation') {
            if (empty($roleContext['can_run_evaluation'])) {
                api_out(403, ['message' => 'No permission for this action.']);
            }

            $departmentId = isset($payload['department_id']) && $payload['department_id'] !== '' ? (int)$payload['department_id'] : null;
            $semesterId = isset($payload['semester_id']) && $payload['semester_id'] !== '' ? (int)$payload['semester_id'] : null;
            $schoolYearId = isset($payload['school_year_id']) && $payload['school_year_id'] !== '' ? (int)$payload['school_year_id'] : null;

            /*
             * Which retention period this run is judging.
             *
             * A semester runs three, and each is evaluated on its own numbers
             * and leaves its own case. Omitting it evaluates at semester level,
             * which is what every run before this change did and what the 305
             * existing cases are.
             *
             * api_normalize_period returns false for a value that is not a
             * period, which is why this is an identity check - a plain falsy
             * test would read that failure as "no period given" and silently
             * write the run over the semester-level case.
             */
            $period = api_normalize_period($payload['period'] ?? null);
            if ($period === false) {
                api_out(400, ['message' => 'Period must be 1, 2 or 3, or left out to evaluate the whole semester.']);
            }

            if ($roleContext['is_department_pinned']) {
                $departmentId = (int)($authUser['department_id'] ?? 0);
            }

            if ($roleContext['is_department_pinned'] && $departmentId <= 0) {
                api_out(400, ['message' => 'This account is not linked to a department']);
            }

            // A run aimed at one closed semester is refused outright. A run
            // across terms goes ahead and leaves the closed ones as they were.
            $closedTerm = term_closure_block($pdo, [$schoolYearId, $semesterId]);
            if ($closedTerm !== null) {
                api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);
            }

            $gradeRows = build_grade_rows($pdo, $departmentId ?: null, $semesterId, $schoolYearId, $authUser, $period);
            $createdCount = 0;
            $updatedCount = 0;
            $closedCount = 0;

            foreach ($gradeRows as $gradeRow) {
                if (term_closure_is_closed($pdo, $gradeRow['school_year_id'] ?? null, $gradeRow['semester_id'] ?? null)) {
                    $closedCount += 1;
                    continue;
                }
                $submissionRow = fetch_latest_submission_for_grade(
                    $pdo,
                    (int)$gradeRow['student_id'],
                    isset($gradeRow['semester_id']) ? (int)$gradeRow['semester_id'] : null,
                    $period
                );
                $answers = $submissionRow ? fetch_submission_answers($pdo, (int)$submissionRow['submission_id']) : [];
                $evaluation = evaluate_student_risk($pdo, $gradeRow, $submissionRow, $answers, $period);
                $result = upsert_retention_case($pdo, $gradeRow, $submissionRow, $evaluation, $sessionUserId, $period);
                if ($result === 'created') {
                    $createdCount += 1;
                } elseif ($result === 'updated') {
                    $updatedCount += 1;
                }
            }

            api_out(200, [
                /*
                 * Naming the period back: a run that silently evaluated the
                 * wrong one is otherwise indistinguishable from the right one.
                 *
                 * Spelled out rather than taken from api_period_label(), which
                 * returns "Whole Periodical" for a null period. That is the
                 * right word in a column header and the wrong one in a sentence
                 * - "completed for Whole Periodical" reads as a broken string,
                 * not as a semester-wide run.
                 */
                'message' => 'Retention evaluation completed for '
                    . ($period === null ? 'the whole semester' : api_period_label($period)) . '.'
                    . ($closedCount > 0
                        ? sprintf(
                            ' %d %s in closed semesters %s left as they were.',
                            $closedCount,
                            $closedCount === 1 ? 'student' : 'students',
                            $closedCount === 1 ? 'was' : 'were'
                        )
                        : ''),
                'period' => $period,
                'period_label' => api_period_label($period),
                'created' => $createdCount,
                'updated' => $updatedCount,
                'skipped_closed' => $closedCount,
                'data' => fetch_cases_payload($pdo, $authUser, $roleContext),
            ]);
        }

        if ($action === 'add_note') {
            /*
             * A note is part of recording an intervention, not part of approving
             * one, so this follows can_update_intervention rather than
             * can_edit_module. The full check needs the case in hand -- the
             * period limit is a property of the case -- so it runs below, once
             * the row is loaded. This only rejects a role with no writing grant
             * at all, before doing any work for it.
             */
            if (empty($roleContext['can_update_intervention'])) {
                api_out(403, ['message' => 'No permission for this action.']);
            }

            $caseId = isset($payload['case_id']) ? (int)$payload['case_id'] : 0;
            $noteBody = normalize_text($payload['note_body'] ?? null);
            $noteType = is_allowed_value($payload['note_type'] ?? 'intervention', CASE_NOTE_TYPES, 'intervention');

            if ($caseId <= 0) {
                api_out(400, ['message' => 'case_id is required']);
            }
            if ($noteBody === null) {
                api_out(400, ['message' => 'note_body is required']);
            }

            $caseRow = fetch_case_row($pdo, $caseId);
            if (!$caseRow) {
                api_out(404, ['message' => 'Retention case not found']);
            }
            enforce_case_scope($pdo, $caseRow, $authUser, $roleContext, true);

            $noteRefusal = case_intervention_allowed($roleContext, $caseRow, $sessionUserId);
            if ($noteRefusal !== null) {
                api_out(403, ['message' => $noteRefusal]);
            }
            $closedTerm = term_closure_block($pdo, [$caseRow['school_year_id'] ?? null, $caseRow['semester_id'] ?? null]);
            if ($closedTerm !== null) {
                api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);
            }

            $note = insert_case_note($pdo, $caseId, $noteType, $noteBody, $sessionUserId);
            api_out(201, [
                'message' => 'Case note added.',
                'data' => $note,
            ]);
        }

        api_out(400, ['message' => 'Unsupported action']);
    }

    if ($method === 'PUT') {
        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            api_out(400, ['message' => 'Invalid JSON']);
        }

        $caseId = isset($payload['case_id']) ? (int)$payload['case_id'] : 0;
        if ($caseId <= 0) {
            api_out(400, ['message' => 'case_id is required']);
        }

        $caseRow = fetch_case_row($pdo, $caseId);
        if (!$caseRow) {
            api_out(404, ['message' => 'Retention case not found']);
        }
        enforce_case_scope($pdo, $caseRow, $authUser, $roleContext, true);
        $closedTerm = term_closure_block($pdo, [$caseRow['school_year_id'] ?? null, $caseRow['semester_id'] ?? null]);
        if ($closedTerm !== null) {
            api_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);
        }

        $fields = [];
        $params = [':case_id' => $caseId];

        if (array_key_exists('validation_status', $payload)) {
            if (empty($roleContext['can_validate'])) {
                api_out(403, ['message' => 'No permission for this action.']);
            }
            $validationStatus = is_allowed_value($payload['validation_status'], CASE_VALIDATION_STATUSES, 'pending');
            $fields[] = 'validation_status = :validation_status';
            $params[':validation_status'] = $validationStatus;
            $fields[] = 'validated_by_user_id = :validated_by_user_id';
            $params[':validated_by_user_id'] = $sessionUserId > 0 ? $sessionUserId : null;
            $fields[] = 'validated_at = CURRENT_TIMESTAMP';
        }

        if (array_key_exists('assigned_to_user_id', $payload)) {
            if (empty($roleContext['can_assign'])) {
                api_out(403, ['message' => 'No permission for this action.']);
            }
            $assignedToUserId = $payload['assigned_to_user_id'] === null || $payload['assigned_to_user_id'] === ''
                ? null
                : (int)$payload['assigned_to_user_id'];

            if ($assignedToUserId !== null && !validate_ssp_caller($pdo, $assignedToUserId)) {
                api_out(400, ['message' => 'Selected assignee is not an SSP Caller']);
            }

            // Star cases belong to KSH Coaches, Nonstar to SSP Callers. Checked
            // server-side as well as in the dropdown: a mismatched pairing saves
            // fine and then the student-type scope hides the case from the very
            // person it was assigned to, which looks like data loss.
            if ($assignedToUserId !== null) {
                $assigneeType = api_student_type_for_role_id(assignee_role_id($pdo, $assignedToUserId));
                $caseType = strtolower(trim((string)($caseRow['student_type'] ?? '')));
                if ($assigneeType !== null && $caseType !== '' && strtolower($assigneeType) !== $caseType) {
                    api_out(422, [
                        'message' => sprintf(
                            'This assignee only handles %s students, but the case student is %s.',
                            $assigneeType,
                            ucfirst($caseType)
                        ),
                    ]);
                }
            }

            $fields[] = 'assigned_to_user_id = :assigned_to_user_id';
            $params[':assigned_to_user_id'] = $assignedToUserId;
            $fields[] = 'assigned_by_user_id = :assigned_by_user_id';
            $params[':assigned_by_user_id'] = $assignedToUserId !== null ? $sessionUserId : null;

            if ($assignedToUserId === null) {
                $fields[] = "intervention_status = 'unassigned'";
            } elseif (($caseRow['intervention_status'] ?? 'unassigned') === 'unassigned') {
                $fields[] = "intervention_status = 'assigned'";
            }
        }

        if (array_key_exists('intervention_status', $payload)) {
            $allowedForCase = case_intervention_allowed($roleContext, $caseRow, $sessionUserId);
            if ($allowedForCase !== null) {
                api_out(403, ['message' => $allowedForCase]);
            }

            $interventionStatus = is_allowed_value($payload['intervention_status'], CASE_INTERVENTION_STATUSES, 'unassigned');
            $fields[] = 'intervention_status = :intervention_status';
            $params[':intervention_status'] = $interventionStatus;
        }

        if (array_key_exists('follow_up_date', $payload)) {
            $allowedForCase = case_intervention_allowed($roleContext, $caseRow, $sessionUserId);
            if ($allowedForCase !== null) {
                api_out(403, ['message' => $allowedForCase]);
            }

            $followUpDate = normalize_text($payload['follow_up_date'] ?? null);
            if ($followUpDate !== null && !preg_match('/^\d{4}-\d{2}-\d{2}$/', $followUpDate)) {
                api_out(400, ['message' => 'follow_up_date must be in YYYY-MM-DD format']);
            }
            $fields[] = 'follow_up_date = :follow_up_date';
            $params[':follow_up_date'] = $followUpDate;
        }

        if (array_key_exists('outcome_summary', $payload)) {
            $allowedForCase = case_intervention_allowed($roleContext, $caseRow, $sessionUserId);
            if ($allowedForCase !== null) {
                api_out(403, ['message' => $allowedForCase]);
            }

            $fields[] = 'outcome_summary = :outcome_summary';
            $params[':outcome_summary'] = normalize_text($payload['outcome_summary'] ?? null);
        }

        if (empty($fields)) {
            api_out(200, ['message' => 'No changes']);
        }

        $sql = 'UPDATE retention_case SET ' . implode(', ', $fields) . ' WHERE case_id = :case_id';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);

        $updatedCase = fetch_case_row($pdo, $caseId);
        api_out(200, [
            'message' => 'Retention case updated.',
            'data' => $updatedCase,
        ]);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
