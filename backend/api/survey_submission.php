<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
// resolve_submission_enrollment_status(), resolve_submission_remark() and
// apply_survey_enrollment_status() live here, shared with survey_response.php.
// table_columns() used to as well; it is api_table_columns() in
// middleware/auth.php now.
require_once __DIR__ . '/lib/survey_enrollment_status.php';
// Which questions the student was actually asked, and what each answer is
// allowed to look like. Both mirror a module the student's page uses, so the
// form and the endpoint reach the same verdict.
require_once __DIR__ . '/lib/survey_visibility.php';
require_once __DIR__ . '/lib/survey_answer_format.php';


/**
 * The submission this student already has for this survey, if any.
 *
 * `survey_submission` carries UNIQUE(survey_id, student_id), so a second
 * submission was never able to reach the table — it hit the index and came back
 * as a 500 reading "Server error", with the raw constraint violation attached.
 * The row was safe and the message was not: a student who double-tapped Submit
 * was told the system had broken, and handed the key name and its value.
 *
 * Checked up front so the common case answers cleanly, and caught again at the
 * insert (see the POST handler) because two requests in flight at once can both
 * pass this check before either writes.
 *
 * Live submissions only. An archived one keeps its answers but no longer counts
 * as having answered - the unique key is now (survey_id, student_id,
 * archive_slot), so the student may answer again, as they could after a delete.
 */
function existing_submission_for(PDO $pdo, int $surveyId, int $studentId): ?array {
    $stmt = $pdo->prepare(
        'SELECT submission_id, submitted_at
           FROM survey_submission
          WHERE survey_id = :survey_id AND student_id = :student_id
            AND archived_at IS NULL
          LIMIT 1'
    );
    $stmt->execute([':survey_id' => $surveyId, ':student_id' => $studentId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

/** One wording for the duplicate, wherever it is detected. */
function out_already_submitted(array $existing): void {
    api_out(409, [
        'message' => 'You have already answered this survey. Your first answers were kept.',
        'code' => 'ALREADY_SUBMITTED',
        'data' => [
            'submission_id' => (int)$existing['submission_id'],
            'submitted_at' => $existing['submitted_at'] ?? null,
        ],
    ]);
}

/** True when a PDO error is the unique-index rejection rather than anything else. */
function is_duplicate_key_error(Throwable $e): bool {
    if ($e instanceof PDOException) {
        return ($e->errorInfo[1] ?? 0) === 1062 || strpos((string)$e->getMessage(), '1062') !== false;
    }
    return false;
}

function normalize_submitted_at_value($submittedAtRaw, $dateRaw, ?string $fallback = null): string {
    if ($submittedAtRaw !== null && trim((string)$submittedAtRaw) !== '') {
        $ts = strtotime(trim((string)$submittedAtRaw));
        if ($ts !== false) return date('Y-m-d H:i:s', $ts);
    }
    if ($dateRaw !== null && trim((string)$dateRaw) !== '') {
        $ts = strtotime(trim((string)$dateRaw) . ' 00:00:00');
        if ($ts !== false) return date('Y-m-d H:i:s', $ts);
    }
    if ($fallback !== null && trim($fallback) !== '') return $fallback;
    return date('Y-m-d H:i:s');
}

function submission_row(PDO $pdo, int $id) {
    $sel = $pdo->prepare(
        'SELECT
            ss.submission_id,
            ss.survey_id,
            sv.survey_title,
            ss.student_id,
            st.student_number,
            TRIM(CONCAT(COALESCE(st.first_name, \'\'), \' \', COALESCE(st.last_name, \'\'))) AS student_name,
            -- Notifications address user accounts, not student records, so the
            -- link is carried here rather than looked up again per notice.
            st.user_id AS student_user_id,
            -- Carried so the notification reaches the dean of this department
            -- and of no other.
            c.department_id,
            ss.submitted_at,
            DATE(ss.submitted_at) AS date,
            ss.archived_at,
            TRIM(CONCAT(COALESCE(au.first_name, \'\'), \' \', COALESCE(au.last_name, \'\'))) AS archived_by_name,
            (SELECT COUNT(*) FROM survey_answer sa WHERE sa.submission_id = ss.submission_id) AS answer_count
         FROM survey_submission ss
         LEFT JOIN survey sv ON sv.survey_id = ss.survey_id
         LEFT JOIN student st ON st.student_id = ss.student_id
         LEFT JOIN course c ON c.course_id = st.course_id
         LEFT JOIN user au ON au.user_id = ss.archived_by_user_id
         WHERE ss.submission_id = :id
         LIMIT 1'
    );
    $sel->execute([':id' => $id]);
    return $sel->fetch(PDO::FETCH_ASSOC);
}

function survey_question_supports_is_required(PDO $pdo): bool {
    static $supports = null;
    if ($supports !== null) return $supports;
    $supports = in_array('is_required', api_table_columns($pdo, 'survey_question'), true);
    return $supports;
}

function normalize_answer_text($value): string {
    if (is_array($value)) {
        $parts = array_values(array_unique(array_values(array_filter(array_map(function ($item) {
            return trim((string)$item);
        }, $value), function ($item) {
            return $item !== '';
        }))));
        return implode(', ', $parts);
    }

    return trim((string)($value ?? ''));
}

function survey_question_supports_answer_format(PDO $pdo): bool {
    static $supports = null;
    if ($supports !== null) return $supports;
    $supports = in_array('answer_format', api_table_columns($pdo, 'survey_question'), true);
    return $supports;
}

function survey_question_supports_answer_max_length(PDO $pdo): bool {
    static $supports = null;
    if ($supports !== null) return $supports;
    $supports = in_array('answer_max_length', api_table_columns($pdo, 'survey_question'), true);
    return $supports;
}

function questions_for_survey(PDO $pdo, int $surveyId): array {
    // Both columns are feature-detected rather than assumed, the same way the
    // rest of this endpoint treats a schema that may predate a migration.
    $columns = ['question_id', 'question_text', 'question_type'];
    $columns[] = survey_question_supports_is_required($pdo) ? 'COALESCE(is_required, 0) AS is_required' : '0 AS is_required';
    $columns[] = survey_question_supports_answer_format($pdo) ? "COALESCE(answer_format, 'any') AS answer_format" : "'any' AS answer_format";
    $columns[] = survey_question_supports_answer_max_length($pdo) ? 'COALESCE(answer_max_length, 0) AS answer_max_length' : '0 AS answer_max_length';

    $stmt = $pdo->prepare('SELECT ' . implode(', ', $columns) . ' FROM survey_question WHERE survey_id = :survey_id');
    $stmt->execute([':survey_id' => $surveyId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

    $indexed = [];
    foreach ($rows as $row) {
        $questionId = (int)($row['question_id'] ?? 0);
        if ($questionId <= 0) continue;
        $indexed[$questionId] = [
            'question_id' => $questionId,
            'question_text' => trim((string)($row['question_text'] ?? '')),
            'question_type' => strtolower(trim((string)($row['question_type'] ?? 'text'))),
            'is_required' => (int)($row['is_required'] ?? 0) === 1,
            'answer_format' => (string)($row['answer_format'] ?? 'any'),
            // 0 means "no per-question limit set"; the validator reads that as
            // null and falls back to the format's own ceiling.
            'answer_max_length' => (int)($row['answer_max_length'] ?? 0),
        ];
    }

    return $indexed;
}

function normalize_submission_answers($value): array {
    if (!is_array($value)) {
        throw new RuntimeException('answers must be an array');
    }

    $normalized = [];
    foreach ($value as $row) {
        if (!is_array($row)) continue;

        $questionId = (int)($row['question_id'] ?? 0);
        if ($questionId <= 0) {
            throw new RuntimeException('Each answer must include a valid question_id');
        }

        $answerText = normalize_answer_text($row['answer'] ?? null);
        if ($answerText === '') continue;

        $normalized[$questionId] = [
            'question_id' => $questionId,
            'answer' => $answerText,
        ];
    }

    return array_values($normalized);
}

function validate_submission_answers(PDO $pdo, int $surveyId, array $answers): array {
    $questions = questions_for_survey($pdo, $surveyId);
    if (empty($questions)) {
        throw new RuntimeException('This survey has no questions configured');
    }

    $normalized = normalize_submission_answers($answers);
    $answersByQuestion = [];
    foreach ($normalized as $row) {
        $questionId = (int)$row['question_id'];
        if (!isset($questions[$questionId])) {
            throw new RuntimeException('One or more answers do not belong to this survey');
        }
        $answersByQuestion[$questionId] = (string)$row['answer'];
    }

    // What the answer has to look like, where the author said so. Checked
    // before the required sweep so "09xx" comes back as a format complaint
    // rather than passing silently into the table.
    foreach ($normalized as $row) {
        $question = $questions[(int)$row['question_id']];
        $problem = survey_answer_format_validate(
            survey_answer_format_for_question($question),
            (string)$row['answer'],
            ($question['answer_max_length'] ?? 0) > 0 ? (int)$question['answer_max_length'] : null
        );
        if ($problem !== '') {
            $label = $question['question_text'] !== '' ? $question['question_text'] : ('Question ' . $question['question_id']);
            throw new RuntimeException($label . ': ' . $problem);
        }
    }

    /*
     * Only a question the student was actually asked can be missing.
     *
     * A branching question that the given answers never revealed was not
     * declined - it was never on screen, and there is no way for the student to
     * satisfy it. Requiring those made Submit impossible for every branch but
     * one as soon as an author ticked "Required" on a conditional question.
     */
    $rules = survey_visibility_rules($pdo, $surveyId);
    $missingRequired = [];
    foreach ($questions as $questionId => $row) {
        if (empty($row['is_required'])) continue;
        if (isset($answersByQuestion[$questionId])) continue;
        if (!survey_question_is_visible($questionId, $rules, $answersByQuestion)) continue;
        $missingRequired[] = $questionId;
    }

    if (!empty($missingRequired)) {
        throw new RuntimeException('Please answer all required questions');
    }

    if (empty($normalized)) {
        throw new RuntimeException('Please answer at least one question');
    }

    return $normalized;
}

/**
 * A finished submission: announce it, and write it to the audit log.
 *
 * Both POST branches end here -- the one that stores answers and the one that
 * records a bare submission -- which is why the audit write lives in this
 * function rather than at the two call sites. Two copies would drift, and the
 * one that drifted would be the branch nobody tests.
 *
 * A row in survey_submission IS the completion. There is no draft state in the
 * table: drafts are held in the browser until the student submits, so reaching
 * here means the student finished and answered.
 */
function record_submission_created(PDO $pdo, ?array $actor, ?array $row): void
{
    if (!is_array($row) || empty($row)) {
        return;
    }

    $surveyTitle = trim((string)($row['survey_title'] ?? ''));
    $studentLabel = trim((string)($row['student_number'] ?? ''));

    /*
     * The audit entry is written first, and on its own terms.
     *
     * $actor is the student who submitted, so the row lands under their user
     * id and the log answers "did this student finish the survey, and when"
     * -- which the notification below cannot, because notifications are read
     * and dismissed while an audit row is kept.
     */
    api_write_audit_log($pdo, $actor, 'survey_completed',
        'Completed the survey' . ($surveyTitle !== '' ? ' "' . $surveyTitle . '"' : '') . '.', [
            'submission_id' => isset($row['submission_id']) ? (int)$row['submission_id'] : null,
            'survey_id' => isset($row['survey_id']) ? (int)$row['survey_id'] : null,
            'survey_title' => $row['survey_title'] ?? null,
            'student_id' => isset($row['student_id']) ? (int)$row['student_id'] : null,
            'student_number' => $row['student_number'] ?? null,
            'submitted_at' => $row['submitted_at'] ?? null,
        ]);
    $message = 'A new submission was received';
    if ($surveyTitle !== '') {
        $message .= ' for "' . $surveyTitle . '"';
    }
    if ($studentLabel !== '') {
        $message .= ' from student ' . $studentLabel;
    }
    $message .= '.';

    api_notifications_try_create($pdo, [
        'event_key' => 'survey_submission_received',
        'level' => 'info',
        'title' => 'New survey submission received',
        'message' => $message,
        'module_key' => 'survey_submissions',
        'entity_type' => 'survey_submission',
        'entity_id' => isset($row['submission_id']) ? (int)$row['submission_id'] : null,
        'actor_user_id' => (int)($actor['user_id'] ?? 0),
        'toast' => true,
        'target' => [
            'view' => 'survey_submissions',
        ],
        'metadata' => [
            'submission_id' => isset($row['submission_id']) ? (int)$row['submission_id'] : null,
            'survey_id' => isset($row['survey_id']) ? (int)$row['survey_id'] : null,
            'survey_title' => $row['survey_title'] ?? null,
            'student_id' => isset($row['student_id']) ? (int)$row['student_id'] : null,
            'student_number' => $row['student_number'] ?? null,
        ],
        /*
         * Named roles, not "anyone who can view submissions".
         *
         * Recipients used to be resolved from the survey_submissions:view
         * permission, and students hold exactly that — the default preset
         * grants them survey_submissions view+create, because they need it to
         * answer at all. So every student in the school was told each time any
         * other student finished a survey, which is both noise and a privacy
         * leak: the message names the student and the survey.
         *
         * A dean is scoped to their own department; admin and SSG already read
         * every department, matching how survey_submission.php and
         * overview_analytics.php scope those roles elsewhere. The submitting
         * student is excluded — they were there.
         */
        'recipients' => [
            'role_slugs' => ['admin', 'ssg'],
            'department_role_slugs' => ['dean', 'program-head'],
            'department_id' => isset($row['department_id']) ? (int)$row['department_id'] : 0,
            'exclude_actor' => true,
        ],
    ], [
        'endpoint' => 'survey_submission.php',
        'event_key' => 'survey_submission_received',
        'submission_id' => isset($row['submission_id']) ? (int)$row['submission_id'] : null,
    ]);

    /*
     * And the student, on their own account.
     *
     * Separate from the notice above rather than a recipient added to it: that
     * one names the student in the third person and points at the submissions
     * board, which a student cannot open. This one is addressed to them.
     *
     * Sent to student.user_id rather than the actor, so it still reaches the
     * student when staff file a submission on their behalf.
     *
     * No toast. The page already confirms the submit on screen, and a second
     * pop-up saying the same thing reads as a glitch rather than a receipt.
     * This is for the notification list, where it answers "have I done this
     * one yet" without reopening the survey.
     */
    $studentUserId = isset($row['student_user_id']) ? (int)$row['student_user_id'] : 0;
    if ($studentUserId <= 0) {
        return;
    }

    $ownMessage = 'You have already answered';
    $ownMessage .= $surveyTitle !== '' ? ' "' . $surveyTitle . '".' : ' this survey.';

    $submittedAt = trim((string)($row['submitted_at'] ?? ''));
    $submittedTs = $submittedAt !== '' ? strtotime($submittedAt) : false;
    if ($submittedTs !== false) {
        $ownMessage .= ' Your answers were recorded on ' . date('M j, Y g:i A', $submittedTs) . '.';
    }

    api_notifications_try_create($pdo, [
        'event_key' => 'survey_submission_confirmed',
        'level' => 'success',
        'title' => 'Survey answered',
        'message' => $ownMessage,
        'module_key' => 'survey_submissions',
        'entity_type' => 'survey_submission',
        'entity_id' => isset($row['submission_id']) ? (int)$row['submission_id'] : null,
        'actor_user_id' => (int)($actor['user_id'] ?? 0),
        'toast' => false,
        /*
         * No target, so the notice carries no "go to" button.
         *
         * The whole point of this one is that the survey is finished. Offering
         * to open it invites a student to go back to a form they can no longer
         * change, and a button that leads to a dead end is worse than no
         * button. The message says everything there is to act on.
         */
        'metadata' => [
            'submission_id' => isset($row['submission_id']) ? (int)$row['submission_id'] : null,
            'survey_id' => isset($row['survey_id']) ? (int)$row['survey_id'] : null,
            'survey_title' => $row['survey_title'] ?? null,
        ],
        'recipients' => [
            'user_ids' => [$studentUserId],
        ],
    ], [
        'endpoint' => 'survey_submission.php',
        'event_key' => 'survey_submission_confirmed',
        'submission_id' => isset($row['submission_id']) ? (int)$row['submission_id'] : null,
    ]);
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();
    $isStudent = api_session_user_has_role($authUser, ['student']);
    $sessionStudentId = (int)($authUser['student_id'] ?? 0);
    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $row = submission_row($pdo, $id);
            if (!$row) api_out(404, ['message' => 'Submission not found']);
            if ($isStudent && (int)($row['student_id'] ?? 0) !== $sessionStudentId) {
                api_out(403, ['message' => 'Forbidden']);
            }
            if ($isStudent && $row['archived_at'] !== null) {
                api_out(404, ['message' => 'Submission not found']);
            }
            api_out(200, ['data' => $row]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $surveyId = (isset($_GET['survey_id']) && $_GET['survey_id'] !== '') ? (int)$_GET['survey_id'] : null;
        $studentId = (isset($_GET['student_id']) && $_GET['student_id'] !== '') ? (int)$_GET['student_id'] : null;
        $submittedFrom = isset($_GET['submitted_from']) ? trim((string)$_GET['submitted_from']) : '';
        $submittedTo = isset($_GET['submitted_to']) ? trim((string)$_GET['submitted_to']) : '';

        if ($isStudent) {
            if ($sessionStudentId <= 0) api_out(403, ['message' => 'Student account is not linked to a student record']);
            $studentId = $sessionStudentId;
        }

        /*
         * Live submissions by default; `?archived=1` lists the archived ones
         * instead, for the screen's Archived tab. A student never sees an
         * archived submission: to them it is as if it had been deleted, which is
         * what archiving replaced.
         */
        $wantsArchived = !$isStudent && isset($_GET['archived']) && $_GET['archived'] === '1';

        /*
         * ---- folder view --------------------------------------------------
         *
         * One row per survey, so the screen can offer a survey to open before
         * it shows anybody's answers.
         *
         * The count has to be computed here rather than on the client, because
         * the submissions list is paged on the server. The groups the page used
         * to draw were groups *within the current page*: a survey with twelve
         * submissions split across two pages reported "8 students" on one and
         * "4 students" on the next, and neither number was the survey's.
         *
         * It answers this endpoint under this endpoint's permission instead of
         * getting its own. survey-summary.php already computes similar totals,
         * but it belongs to the `reports` module — reaching for it would have
         * left this screen broken for anyone granted submissions alone.
         *
         * LEFT JOIN from `survey`, so a survey nobody has answered yet still
         * gets a folder saying zero. fk_ss_survey is ON DELETE CASCADE, so no
         * submission can exist without a survey to file it under.
         */
        if (isset($_GET['group_by']) && $_GET['group_by'] === 'survey') {
            // A student may only ever count their own. The restriction sits in
            // the JOIN rather than the WHERE so that unanswered surveys keep
            // their folder instead of vanishing from the list.
            $groupParams = [];
            $ownSubmissionsOnly = '';
            if ($studentId !== null) {
                $ownSubmissionsOnly = ' AND ss.student_id = :student_id';
                $groupParams[':student_id'] = $studentId;
            }

            $groupStmt = $pdo->prepare(
                "SELECT
                    sv.survey_id,
                    sv.survey_title,
                    sv.date,
                    sv.period,
                    sem.semester_name,
                    COALESCE(stt.status_name, '') AS status_name,
                    (SELECT COUNT(*) FROM survey_question sq WHERE sq.survey_id = sv.survey_id) AS question_count,
                    -- The folder's number is its live submissions; archived ones
                    -- are counted beside it for the folder's Archived tab.
                    COUNT(CASE WHEN ss.archived_at IS NULL THEN ss.submission_id END) AS submission_count,
                    COUNT(CASE WHEN ss.archived_at IS NOT NULL THEN ss.submission_id END) AS archived_count,
                    MAX(CASE WHEN ss.archived_at IS NULL THEN ss.submitted_at END) AS latest_submission_at
                 FROM survey sv
                 LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
                 LEFT JOIN status stt ON stt.status_id = sv.status
                 LEFT JOIN survey_submission ss ON ss.survey_id = sv.survey_id$ownSubmissionsOnly
                 GROUP BY sv.survey_id, sv.survey_title, sv.date, sv.period, sem.semester_name, stt.status_name
                 ORDER BY submission_count DESC, sv.date DESC, sv.survey_id DESC"
            );
            foreach ($groupParams as $k => $v) { $groupStmt->bindValue($k, $v); }
            $groupStmt->execute();

            $groups = array_map(static function (array $row): array {
                return [
                    'survey_id' => (int)($row['survey_id'] ?? 0),
                    'survey_title' => $row['survey_title'] ?? '',
                    'date' => $row['date'] ?? null,
                    // With the date, what tells two same-named folders apart:
                    // a title may repeat in another semester or year.
                    'semester_name' => $row['semester_name'] ?? null,
                    'period' => $row['period'] !== null ? (int)$row['period'] : null,
                    'status_name' => $row['status_name'] ?? '',
                    'question_count' => (int)($row['question_count'] ?? 0),
                    'submission_count' => (int)($row['submission_count'] ?? 0),
                    'archived_count' => (int)($row['archived_count'] ?? 0),
                    'latest_submission_at' => $row['latest_submission_at'] ?? null,
                ];
            }, $groupStmt->fetchAll(PDO::FETCH_ASSOC));
            // A student's own folder counts never mention archived submissions.
            if ($isStudent) {
                $groups = array_map(static fn(array $g): array => ['archived_count' => 0] + $g, $groups);
            }

            api_out(200, ['data' => $groups, 'grouped_by' => 'survey']);
        }

        $from = 'FROM survey_submission ss
                 LEFT JOIN survey sv ON sv.survey_id = ss.survey_id
                 LEFT JOIN student st ON st.student_id = ss.student_id
                 LEFT JOIN user au ON au.user_id = ss.archived_by_user_id';

        $whereParts = [$wantsArchived ? 'ss.archived_at IS NOT NULL' : 'ss.archived_at IS NULL'];
        $params = [];
        if ($search !== '') {
            // The name is searchable because the list now shows it: a column a
            // reader can see but not search reads as a broken search box.
            $whereParts[] = '(sv.survey_title LIKE :q
                              OR st.student_number LIKE :q
                              OR CONCAT(COALESCE(st.first_name, \'\'), \' \', COALESCE(st.last_name, \'\')) LIKE :q
                              OR ss.submission_id LIKE :q)';
            $params[':q'] = "%$search%";
        }
        if ($surveyId !== null) {
            $whereParts[] = 'ss.survey_id = :survey_id';
            $params[':survey_id'] = $surveyId;
        }
        if ($studentId !== null) {
            $whereParts[] = 'ss.student_id = :student_id';
            $params[':student_id'] = $studentId;
        }
        if ($submittedFrom !== '') {
            $whereParts[] = 'DATE(ss.submitted_at) >= :submitted_from';
            $params[':submitted_from'] = $submittedFrom;
        }
        if ($submittedTo !== '') {
            $whereParts[] = 'DATE(ss.submitted_at) <= :submitted_to';
            $params[':submitted_to'] = $submittedTo;
        }
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT
                    ss.submission_id,
                    ss.survey_id,
                    sv.survey_title,
                    ss.student_id,
                    st.student_number,
                    TRIM(CONCAT(COALESCE(st.first_name, ''), ' ', COALESCE(st.last_name, ''))) AS student_name,
                    ss.submitted_at,
                    DATE(ss.submitted_at) AS date,
                    ss.archived_at,
                    TRIM(CONCAT(COALESCE(au.first_name, ''), ' ', COALESCE(au.last_name, ''))) AS archived_by_name,
                    (SELECT COUNT(*) FROM survey_answer sa WHERE sa.submission_id = ss.submission_id) AS answer_count
                $from
                $where
                ORDER BY " . ($wantsArchived ? 'ss.archived_at DESC, ' : '') . "ss.submitted_at DESC, ss.submission_id DESC
                LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = "SELECT COUNT(*) $from " . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) { $countStmt->bindValue($k, $v); }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        if (!isset($p['survey_id']) || $p['survey_id'] === '') api_out(400, ['message' => 'survey_id is required']);
        if (!isset($p['student_id']) || $p['student_id'] === '') api_out(400, ['message' => 'student_id is required']);

        $surveyId = (int)$p['survey_id'];
        $studentId = (int)$p['student_id'];
        if ($surveyId <= 0) api_out(400, ['message' => 'survey_id is invalid']);
        if ($studentId <= 0) api_out(400, ['message' => 'student_id is invalid']);
        if ($isStudent) {
            if ($sessionStudentId <= 0) api_out(403, ['message' => 'Student account is not linked to a student record']);
            if ($studentId !== $sessionStudentId) api_out(403, ['message' => 'Forbidden']);
        }

        if (!api_fk_exists($pdo, 'SELECT survey_id FROM survey WHERE survey_id = :id LIMIT 1', $surveyId)) {
            api_out(400, ['message' => 'Selected survey does not exist']);
        }
        if (!api_fk_exists($pdo, 'SELECT student_id FROM student WHERE student_id = :id LIMIT 1', $studentId)) {
            api_out(400, ['message' => 'Selected student does not exist']);
        }

        // Ahead of answer validation on purpose: someone resubmitting a survey
        // should be told they already answered it, not marched through a list of
        // required questions first.
        $alreadyAnswered = existing_submission_for($pdo, $surveyId, $studentId);
        if ($alreadyAnswered) {
            out_already_submitted($alreadyAnswered);
        }

        $submittedAt = normalize_submitted_at_value($p['submitted_at'] ?? null, $p['date'] ?? null, null);
        $answerRows = array_key_exists('answers', $p) ? $p['answers'] : null;

        if ($answerRows !== null) {
            try {
                $validatedAnswers = validate_submission_answers($pdo, $surveyId, $answerRows);
            } catch (RuntimeException $e) {
                api_out(400, ['message' => $e->getMessage()]);
            }

            $pdo->beginTransaction();
            try {
                $ins = $pdo->prepare('INSERT INTO survey_submission (survey_id, student_id, submitted_at) VALUES (:survey_id, :student_id, :submitted_at)');
                $ins->execute([
                    ':survey_id' => $surveyId,
                    ':student_id' => $studentId,
                    ':submitted_at' => $submittedAt,
                ]);
                $newId = (int)$pdo->lastInsertId();

                $insAnswer = $pdo->prepare(
                    'INSERT INTO survey_answer (question_id, answer, submission_id)
                     VALUES (:question_id, :answer, :submission_id)'
                );
                foreach ($validatedAnswers as $row) {
                    $insAnswer->execute([
                        ':question_id' => (int)$row['question_id'],
                        ':answer' => $row['answer'],
                        ':submission_id' => $newId,
                    ]);
                }

                // Inside the transaction on purpose: a submission that claims to
                // have set a standing, and did not, is worse than no submission.
                $enrollmentUpdate = apply_survey_enrollment_status($pdo, $newId, $surveyId, $studentId, $submittedAt);

                $pdo->commit();
            } catch (Throwable $inner) {
                if ($pdo->inTransaction()) $pdo->rollBack();

                /*
                 * Two submissions in flight at once: both cleared the check
                 * above, one reached the index first. The loser is a duplicate
                 * like any other and gets the same answer — a double-tapped
                 * Submit button must never read as a server fault.
                 */
                if (is_duplicate_key_error($inner)) {
                    $winner = existing_submission_for($pdo, $surveyId, $studentId);
                    if ($winner) out_already_submitted($winner);
                }

                throw $inner;
            }

            $row = submission_row($pdo, $newId);
            record_submission_created($pdo, $authUser, $row);
            api_out(201, [
                'message' => 'Submission created',
                'data' => $row,
                'enrollment_status_update' => $enrollmentUpdate,
            ]);
        }

        $ins = $pdo->prepare('INSERT INTO survey_submission (survey_id, student_id, submitted_at) VALUES (:survey_id, :student_id, :submitted_at)');
        $ins->execute([
            ':survey_id' => $surveyId,
            ':student_id' => $studentId,
            ':submitted_at' => $submittedAt,
        ]);
        $newId = (int)$pdo->lastInsertId();

        $row = submission_row($pdo, $newId);
        record_submission_created($pdo, $authUser, $row);
        api_out(201, ['message' => 'Submission created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) $id = isset($p['submission_id']) ? (int)$p['submission_id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid submission id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $existing = submission_row($pdo, $id);
        if (!$existing) api_out(404, ['message' => 'Submission not found']);

        /*
         * ---- restore -------------------------------------------------------
         *
         * Arrives as PUT ?permission_action=delete with {"restore": true}, so it
         * is checked against the permission that archives - there is no
         * separate archive/restore action on survey_submissions, and adding one
         * would mean rewriting every saved role in permissions.json, here and on
         * the cloud. That nomination is accepted for this branch alone: a field
         * edit that nominates `delete` is refused below, or holding delete would
         * quietly grant edit.
         */
        $nominatedDelete = strtolower(trim((string)($_GET['permission_action'] ?? ''))) === 'delete';
        if (!empty($p['restore'])) {
            if (!$nominatedDelete) api_out(400, ['message' => 'Restore with ?permission_action=delete.']);
            if ($existing['archived_at'] === null) {
                api_out(200, ['message' => 'Submission is not archived', 'data' => $existing]);
            }
            // One live submission per student per survey: if they answered again
            // after this one was archived, that newer one has to go first.
            $live = existing_submission_for($pdo, (int)$existing['survey_id'], (int)$existing['student_id']);
            if ($live) {
                api_out(409, [
                    'message' => 'This student answered the survey again after this submission was archived. Archive the newer submission first, then restore this one.',
                    'code' => 'LIVE_SUBMISSION_EXISTS',
                    'data' => ['submission_id' => (int)$live['submission_id']],
                ]);
            }
            $restore = $pdo->prepare(
                'UPDATE survey_submission
                    SET archived_at = NULL, archived_by_user_id = NULL, archive_slot = 0
                  WHERE submission_id = :id AND archived_at IS NOT NULL'
            );
            try {
                $restore->execute([':id' => $id]);
            } catch (PDOException $inner) {
                // Lost a race with a new submission for the same survey.
                if (is_duplicate_key_error($inner)) {
                    api_out(409, ['message' => 'This student answered the survey again just now. Archive that submission first.', 'code' => 'LIVE_SUBMISSION_EXISTS']);
                }
                throw $inner;
            }
            $row = submission_row($pdo, $id);
            api_write_audit_log($pdo, $authUser, 'survey_submission_restored',
                'Restored the archived survey submission #' . $id . ' of student ' . ($row['student_number'] ?? '') . '.', [
                    'submission_id' => $id,
                    'survey_id' => (int)($row['survey_id'] ?? 0),
                    'student_id' => (int)($row['student_id'] ?? 0),
                ]);
            api_out(200, ['message' => 'Submission restored', 'data' => $row]);
        }
        if ($nominatedDelete) {
            api_out(403, ['message' => 'You do not have permission to edit submissions.']);
        }
        if ($existing['archived_at'] !== null) {
            api_out(409, ['message' => 'This submission is archived. Restore it before changing it.']);
        }

        $fields = [];
        $params = [':id' => $id];

        if (array_key_exists('survey_id', $p)) {
            if ($p['survey_id'] === '' || $p['survey_id'] === null) api_out(400, ['message' => 'survey_id cannot be empty']);
            $surveyId = (int)$p['survey_id'];
            if ($surveyId <= 0) api_out(400, ['message' => 'survey_id is invalid']);
            if (!api_fk_exists($pdo, 'SELECT survey_id FROM survey WHERE survey_id = :id LIMIT 1', $surveyId)) {
                api_out(400, ['message' => 'Selected survey does not exist']);
            }
            $fields[] = 'survey_id = :survey_id';
            $params[':survey_id'] = $surveyId;
        }

        if (array_key_exists('student_id', $p)) {
            if ($p['student_id'] === '' || $p['student_id'] === null) api_out(400, ['message' => 'student_id cannot be empty']);
            $studentId = (int)$p['student_id'];
            if ($studentId <= 0) api_out(400, ['message' => 'student_id is invalid']);
            if (!api_fk_exists($pdo, 'SELECT student_id FROM student WHERE student_id = :id LIMIT 1', $studentId)) {
                api_out(400, ['message' => 'Selected student does not exist']);
            }
            $fields[] = 'student_id = :student_id';
            $params[':student_id'] = $studentId;
        }

        if (array_key_exists('submitted_at', $p) || array_key_exists('date', $p)) {
            $submittedAt = normalize_submitted_at_value($p['submitted_at'] ?? null, $p['date'] ?? null, (string)$existing['submitted_at']);
            $fields[] = 'submitted_at = :submitted_at';
            $params[':submitted_at'] = $submittedAt;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE survey_submission SET ' . implode(', ', $fields) . ' WHERE submission_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $row = submission_row($pdo, $id);
        api_out(200, ['message' => 'Submission updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid submission id is required']);

        $existing = submission_row($pdo, $id);
        if (!$existing) api_out(404, ['message' => 'Submission not found']);

        /*
         * DELETE archives (2026-10-07). It used to remove the submission and
         * every answer in it for good; now both stay, the submission drops out
         * of every count and list, and it can be restored. Same permission as
         * the delete it replaces (survey_submissions:delete).
         *
         * archive_slot takes the submission's own id so the unique key
         * (survey_id, student_id, archive_slot) lets the student answer again.
         */
        if ($existing['archived_at'] !== null) {
            api_out(200, ['message' => 'Submission already archived', 'data' => $existing]);
        }
        $archive = $pdo->prepare(
            'UPDATE survey_submission
                SET archived_at = NOW(), archived_by_user_id = :user_id, archive_slot = submission_id
              WHERE submission_id = :id AND archived_at IS NULL'
        );
        $archive->execute([
            ':user_id' => isset($authUser['user_id']) ? (int)$authUser['user_id'] : null,
            ':id' => $id,
        ]);
        $row = submission_row($pdo, $id);
        api_write_audit_log($pdo, $authUser, 'survey_submission_archived',
            'Archived the survey submission #' . $id . ' of student ' . ($row['student_number'] ?? '') . '.', [
                'submission_id' => $id,
                'survey_id' => (int)($row['survey_id'] ?? 0),
                'student_id' => (int)($row['student_id'] ?? 0),
                'answer_count' => (int)($row['answer_count'] ?? 0),
            ]);

        api_out(200, ['message' => 'Submission archived', 'data' => $row]);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    /*
     * The exception text used to ride along in the response, which is how a
     * student came to be shown a SQL constraint violation naming the table and
     * its key. It goes to the log instead, where the person who can act on it
     * will actually see it.
     */
    api_log_exception($e, ['endpoint' => 'survey_submission.php', 'method' => $_SERVER['REQUEST_METHOD'] ?? '']);
    api_out(500, ['message' => 'Something went wrong saving this survey. Please try again.']);
}
