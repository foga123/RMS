<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
// survey_answer_format_normalize() and the list of formats an author can pick.
require_once __DIR__ . '/lib/survey_answer_format.php';
require_once __DIR__ . '/lib/survey_text_limits.php';
// A survey asks each question once: survey_question_duplicate_error().
require_once __DIR__ . '/lib/survey_uniqueness.php';
require_once __DIR__ . '/notification_service.php';


/**
 * Tell SSG when a Secretary changes a survey question.
 *
 * Secretary and SSG now share the same access; the agreed difference is that
 * SSG is kept in the loop on what a Secretary does. So only a Secretary (role 9)
 * triggers this — an SSG editing their own surveys does not notify themselves —
 * and the notice goes to SSG (role 2) alone, never back to the Secretary.
 *
 * A notification failure must never fail the edit that caused it, so the whole
 * thing is swallowed: the question is already saved by the time this runs.
 */
/**
 * Who changed a survey question, whatever their role.
 *
 * Deliberately NOT folded into survey_question_notify_ssg_of_secretary()
 * below, which returns early for anybody who is not a Secretary. That guard is
 * right for the notification -- SSG are told when a Secretary edits their
 * questions -- and wrong for an audit trail, which has to record the edit no
 * matter who made it. Sharing the function would have silently logged one role
 * and no other.
 */
function survey_question_audit(?PDO $pdo, ?array $actor, string $verb, int $questionId, int $surveyId, string $questionText): void {
    if (!$pdo || !function_exists('api_write_audit_log')) return;

    $action = [
        'added'   => 'survey_question_created',
        'edited'  => 'survey_question_updated',
        'deleted' => 'survey_question_deleted',
    ][$verb] ?? 'survey_question_updated';

    // The question itself is the useful identifier -- an id alone says nothing
    // about what was changed. Trimmed because `detail` is a varchar(255).
    $snippet = trim($questionText);
    if (function_exists('mb_strlen') && mb_strlen($snippet) > 80) {
        $snippet = mb_substr($snippet, 0, 77) . '...';
    }

    api_write_audit_log($pdo, $actor, $action,
        ucfirst($verb) . ' a survey question' . ($snippet !== '' ? ': "' . $snippet . '"' : '') . '.', [
            'question_id' => $questionId,
            'survey_id' => $surveyId ?: null,
            'question_text' => $questionText !== '' ? $questionText : null,
        ]);
}

function survey_question_notify_ssg_of_secretary(?PDO $pdo, ?array $actor, string $verb, int $questionId, int $surveyId, string $questionText): void {
    if (!$pdo || !$actor || !function_exists('api_notifications_try_create')) return;

    $roleId = (int)($actor['role_id'] ?? 0);
    $roleName = strtolower(trim((string)($actor['role_name'] ?? '')));
    if ($roleId !== 9 && $roleName !== 'secretary') return;

    try {
        $surveyTitle = '';
        if ($surveyId > 0) {
            $stmt = $pdo->prepare('SELECT survey_title FROM survey WHERE survey_id = :id LIMIT 1');
            $stmt->execute([':id' => $surveyId]);
            $surveyTitle = (string)($stmt->fetchColumn() ?: '');
        }

        $actorName = trim((string)($actor['first_name'] ?? '') . ' ' . (string)($actor['last_name'] ?? ''));
        if ($actorName === '') $actorName = trim((string)($actor['email'] ?? '')) ?: 'A Secretary';

        $snippet = trim($questionText);
        if (function_exists('mb_substr') && mb_strlen($snippet) > 80) {
            $snippet = mb_substr($snippet, 0, 77) . '...';
        }

        $where = $surveyTitle !== '' ? sprintf(' in "%s"', $surveyTitle) : '';
        $tail = $snippet !== '' ? ': "' . $snippet . '"' : '.';

        api_notifications_try_create($pdo, [
            'event_key' => 'survey_question_changed_by_secretary',
            'level' => 'info',
            'title' => 'Secretary ' . $verb . ' a survey question',
            'message' => sprintf('%s %s a survey question%s%s', $actorName, $verb, $where, $tail),
            'module_key' => 'survey_questions',
            'entity_type' => 'survey_question',
            'entity_id' => $questionId,
            'actor_user_id' => (int)($actor['user_id'] ?? 0),
            'toast' => false,
            // SSG only (role 2). Never the Secretary who made the change.
            'recipients' => ['role_ids' => [2]],
            'target' => ['view' => 'survey_questions', 'survey_id' => $surveyId ?: null],
        ]);
    } catch (Throwable $e) {
        error_log('survey_question SSG notification failed: ' . $e->getMessage());
    }
}

function normalize_question_type($value): ?string {
    if ($value === null) return null;
    $v = strtolower(trim((string)$value));
    if ($v === '') return null;
    return in_array($v, ['text', 'radio', 'checkbox', 'rating'], true) ? $v : null;
}

/**
 * The per-question character limit to store, or null.
 *
 * A limit belongs only to a text answer, and only up to the ceiling the chosen
 * format already sets: a larger number is clamped down to that ceiling rather
 * than stored, so the value that comes back is always the limit actually in
 * force - the same shrink-only rule the student form and the submission
 * validator apply. Blank or non-positive means "no limit, use the format
 * default", which is what every question carried before the column existed.
 * survey_answer_effective_max_length (lib/survey_answer_format.php) is the
 * authority on the clamp.
 */
function resolve_answer_max_length($raw, string $effectiveType, string $format): ?int {
    if ($effectiveType !== 'text') return null;
    if ($raw === null || $raw === '') return null;
    $value = (int)$raw;
    if ($value < 1) return null;
    return survey_answer_effective_max_length($format, $value);
}

function ensure_sort_order_column(PDO $pdo): bool {
    api_require_column($pdo, 'survey_question', 'sort_order');
    return true;
}

/**
 * Attach each question's visibility rules, as `show_when_option_ids`.
 *
 * An empty array means the question is always shown. That is the default for
 * every question that has no rows in survey_question_condition, so a survey
 * written before conditions existed behaves exactly as it always did.
 *
 * The table is optional: it arrives with a migration, and this endpoint is also
 * used by installations that have not run it yet. A missing table yields empty
 * arrays rather than a 500 - the same reason sort_order and is_required are
 * feature-detected above.
 */
function survey_question_attach_conditions(PDO $pdo, array $rows): array
{
    if (empty($rows)) return $rows;

    static $tableExists = null;
    if ($tableExists === null) {
        try {
            $tableExists = (bool)$pdo->query("SHOW TABLES LIKE 'survey_question_condition'")->fetch();
        } catch (Throwable $e) {
            $tableExists = false;
        }
    }

    $ids = array_values(array_filter(array_map(
        static fn(array $r): int => (int)($r['question_id'] ?? 0),
        $rows
    )));

    $byQuestion = [];
    if ($tableExists && !empty($ids)) {
        // Ids come from the rows just fetched, so they are integers from the
        // database rather than anything a caller supplied.
        $in = implode(',', array_map('intval', $ids));
        $stmt = $pdo->query(
            "SELECT question_id, option_id FROM survey_question_condition
              WHERE question_id IN ($in) ORDER BY question_id, option_id"
        );
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
            $byQuestion[(int)$row['question_id']][] = (int)$row['option_id'];
        }
    }

    foreach ($rows as &$row) {
        $row['show_when_option_ids'] = $byQuestion[(int)($row['question_id'] ?? 0)] ?? [];
    }
    unset($row);

    return $rows;
}

/**
 * Replace a question's visibility rules with the given option ids.
 *
 * Absent key means "leave the rules alone"; an empty array means "always show",
 * so an author can clear a condition as well as set one. Ids are checked against
 * options that belong to the same survey - a question cannot be gated behind an
 * answer from a different form, and would be permanently invisible if it were.
 */
function survey_question_save_conditions(PDO $pdo, int $questionId, $requested): void
{
    if ($requested === null || !is_array($requested)) return;

    try {
        if (!$pdo->query("SHOW TABLES LIKE 'survey_question_condition'")->fetch()) return;
    } catch (Throwable $e) {
        return;
    }

    $wanted = array_values(array_unique(array_filter(array_map('intval', $requested), static fn(int $id): bool => $id > 0)));

    $pdo->prepare('DELETE FROM survey_question_condition WHERE question_id = :qid')
        ->execute([':qid' => $questionId]);

    if (empty($wanted)) return;

    $insert = $pdo->prepare(
        'INSERT IGNORE INTO survey_question_condition (question_id, option_id)
         SELECT :qid, o.option_id
           FROM survey_question_option o
           JOIN survey_question src ON src.question_id = o.question_id
           JOIN survey_question tgt ON tgt.question_id = :qid2
          WHERE o.option_id = :oid
            AND src.survey_id = tgt.survey_id
            AND src.question_id <> tgt.question_id'
    );
    foreach ($wanted as $optionId) {
        $insert->execute([':qid' => $questionId, ':qid2' => $questionId, ':oid' => $optionId]);
    }
}

function ensure_is_required_column(PDO $pdo): bool {
    api_require_column($pdo, 'survey_question', 'is_required');
    return true;
}

// NOTE: This endpoint follows the same CRUD + pagination + search pattern used in survey.php
// It assumes your existing SQL schema (frontend/sql/capstone_db.sql):
// CREATE TABLE `survey_question` (
//   `question_id` int NOT NULL AUTO_INCREMENT,
//   `survey_id` int DEFAULT NULL,
//   `question_text` text DEFAULT NULL,
//   `question_type` varchar(50) DEFAULT NULL,
//   `is_required` tinyint(1) NOT NULL DEFAULT 0,
//   `sort_order` int DEFAULT NULL,
//   PRIMARY KEY (`question_id`)
// )
// This endpoint therefore reads/writes: survey_id, question_text, question_type,
// is_required, and sort_order (if available).

try {
    $db = new Database();
    $pdo = $db->connect();

    $method = $_SERVER['REQUEST_METHOD'];
    // Who is acting, for the SSG-on-Secretary-edit notification below.
    $actor = function_exists('api_get_session_user') ? api_get_session_user() : null;
    $supportsSortOrder = ensure_sort_order_column($pdo);
    $supportsIsRequired = ensure_is_required_column($pdo);
    $columns = api_table_columns($pdo, 'survey_question');
    $supportsStatus = in_array('status', $columns, true);
    // Feature-detected rather than required: the column arrives with
    // 2026-08-11_survey_question_answer_format.sql, and an installation that
    // has not run it should still be able to edit questions.
    $supportsAnswerFormat = in_array('answer_format', $columns, true);
    // Arrives with 2026_08_23_survey_question_answer_max_length.sql; an install
    // that has not run it still edits questions, just without a custom limit.
    $supportsAnswerMaxLength = in_array('answer_max_length', $columns, true);
    $supports = [
        'sort_order' => $supportsSortOrder,
        'is_required' => $supportsIsRequired,
        'status' => $supportsStatus,
        'answer_format' => $supportsAnswerFormat,
        'answer_max_length' => $supportsAnswerMaxLength,
    ];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT * FROM survey_question WHERE question_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Question not found']);
            api_out(200, ['data' => $row, 'supports' => $supports]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $surveyId = (isset($_GET['survey_id']) && $_GET['survey_id'] !== '') ? (int)$_GET['survey_id'] : null;

        /*
         * ---- folder view --------------------------------------------------
         *
         * One row per survey, so the questions screen can ask which survey
         * before it shows a single question. The same branch exists on
         * survey_submission.php and returns the same shape, because the two
         * screens draw the same shelf and should not disagree about what a
         * folder is.
         *
         * The count is the endpoint's job for the same reason it is there: the
         * question list is paged, so anything counted client-side would be a
         * count of the current page rather than of the survey.
         *
         * LEFT JOIN from `survey`, so a survey created a minute ago and still
         * empty gets a folder saying zero questions - which is exactly the
         * folder someone who just created a survey is looking for.
         */
        if (isset($_GET['group_by']) && $_GET['group_by'] === 'survey') {
            $groupStmt = $pdo->query(
                "SELECT
                    sv.survey_id,
                    sv.survey_title,
                    sv.date,
                    sv.period,
                    sem.semester_name,
                    COALESCE(stt.status_name, '') AS status_name,
                    COUNT(sq.question_id) AS question_count,
                    (SELECT COUNT(*) FROM survey_submission ss WHERE ss.survey_id = sv.survey_id AND ss.archived_at IS NULL) AS submission_count
                 FROM survey sv
                 LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
                 LEFT JOIN status stt ON stt.status_id = sv.status
                 LEFT JOIN survey_question sq ON sq.survey_id = sv.survey_id
                 GROUP BY sv.survey_id, sv.survey_title, sv.date, sv.period, sem.semester_name, stt.status_name
                 ORDER BY sv.date DESC, sv.survey_id DESC"
            );

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
                ];
            }, $groupStmt ? $groupStmt->fetchAll(PDO::FETCH_ASSOC) : []);

            api_out(200, ['data' => $groups, 'grouped_by' => 'survey', 'supports' => $supports]);
        }

        $whereParts = [];
        $params = [];

        if ($search !== '') {
            $whereParts[] = 'question_text LIKE :q';
            $params[':q'] = "%$search%";
        }
        if ($surveyId !== null) {
            $whereParts[] = 'survey_id = :survey_id';
            $params[':survey_id'] = $surveyId;
        }

        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $orderBy = $supportsSortOrder
            ? 'ORDER BY (sort_order IS NULL) ASC, sort_order ASC, question_id ASC'
            : 'ORDER BY question_id DESC';
        $sql = "SELECT * FROM survey_question $where $orderBy LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        /*
         * Which answers reveal each question.
         *
         * An empty array means "always shown", which is what every question had
         * before conditions existed - so a survey with no rules behaves exactly
         * as it did. One query for the whole page rather than one per question:
         * a ten-question form would otherwise cost ten extra round trips before
         * a student sees anything.
         */
        $rows = survey_question_attach_conditions($pdo, $rows);

        $countSql = 'SELECT COUNT(*) FROM survey_question ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) {
            $countStmt->bindValue($k, $v);
        }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total], 'supports' => $supports]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        if (!isset($p['survey_id']) || $p['survey_id'] === '') api_out(400, ['message' => 'survey_id is required']);
        $surveyId = (int)$p['survey_id'];
        if ($surveyId <= 0) api_out(400, ['message' => 'survey_id is invalid']);

        /*
         * Injection guard. See api_reject_unsafe_text() in middleware/auth.php
         * for the two levels and why refusing on input beats escaping on output.
         * Names and codes are identifiers ('strict'); anything that is a
         * sentence is 'prose', which allows the brackets and question marks real
         * writing contains.
         */
        $unsafe = api_reject_unsafe_fields($p, [
            'question_text' => 'Question text',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        if (!isset($p['question_text']) || trim((string)$p['question_text']) === '') api_out(400, ['message' => 'question_text is required']);
        $lengthError = survey_text_length_error('question_text', trim((string)$p['question_text']));
        if ($lengthError !== null) api_out(400, ['message' => $lengthError]);
        $questionType = normalize_question_type($p['question_type'] ?? null);
        if ($questionType === null) api_out(400, ['message' => 'question_type must be text, radio, checkbox, or rating']);
        $duplicate = survey_question_duplicate_error($pdo, $surveyId, trim((string)$p['question_text']));
        if ($duplicate !== null) api_out(409, ['message' => $duplicate]);

        $insertColumns = ['survey_id', 'question_text', 'question_type'];
        $insertPlaceholders = [':survey_id', ':question_text', ':question_type'];
        $insertParams = [
            ':survey_id' => $surveyId,
            ':question_text' => trim((string)$p['question_text']),
            ':question_type' => $questionType,
        ];

        // Only a text answer can have a shape. Radio, checkbox and rating
        // answers come from the option list the author wrote, so a format
        // stored against one would be a rule nothing could ever break.
        if ($supportsAnswerFormat) {
            $insertColumns[] = 'answer_format';
            $insertPlaceholders[] = ':answer_format';
            $insertParams[':answer_format'] = $questionType === 'text'
                ? survey_answer_format_normalize($p['answer_format'] ?? null)
                : 'any';
        }

        // A per-question character cap, kept within the ceiling the format
        // already sets. Resolved against the format this question will carry,
        // independent of whether the format column exists - without it the
        // answer behaves as 'any', whose ceiling is the right bound anyway.
        if ($supportsAnswerMaxLength) {
            $effectiveFormat = $questionType === 'text'
                ? survey_answer_format_normalize($p['answer_format'] ?? null)
                : 'any';
            $insertColumns[] = 'answer_max_length';
            $insertPlaceholders[] = ':answer_max_length';
            $insertParams[':answer_max_length'] = resolve_answer_max_length(
                $p['answer_max_length'] ?? null,
                $questionType,
                $effectiveFormat
            );
        }

        if ($supportsIsRequired && array_key_exists('is_required', $p)) {
            $isRequired = ($p['is_required'] !== null && $p['is_required'] !== '') ? (int)$p['is_required'] : null;
            if ($isRequired !== null && !in_array($isRequired, [0, 1], true)) api_out(400, ['message' => 'is_required must be 0 or 1']);
            $insertColumns[] = 'is_required';
            $insertPlaceholders[] = ':is_required';
            $insertParams[':is_required'] = $isRequired;
        }

        if ($supportsSortOrder && array_key_exists('sort_order', $p)) {
            $sortOrder = ($p['sort_order'] !== null && $p['sort_order'] !== '') ? (int)$p['sort_order'] : null;
            if ($sortOrder !== null && $sortOrder < 0) api_out(400, ['message' => 'sort_order cannot be negative']);
            $insertColumns[] = 'sort_order';
            $insertPlaceholders[] = ':sort_order';
            $insertParams[':sort_order'] = $sortOrder;
        }

        if ($supportsStatus && array_key_exists('status', $p)) {
            $status = ($p['status'] !== null && $p['status'] !== '') ? (int)$p['status'] : null;
            if ($status !== null && $status < 0) api_out(400, ['message' => 'status is invalid']);
            $insertColumns[] = 'status';
            $insertPlaceholders[] = ':status';
            $insertParams[':status'] = $status;
        }

        $sql = 'INSERT INTO survey_question (' . implode(', ', $insertColumns) . ') VALUES (' . implode(', ', $insertPlaceholders) . ')';
        $stmt = $pdo->prepare($sql);
        $stmt->execute($insertParams);

        $newId = (int)$pdo->lastInsertId();
        survey_question_save_conditions($pdo, $newId, $p['show_when_option_ids'] ?? null);

        $sel = $pdo->prepare('SELECT * FROM survey_question WHERE question_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);
        $row = survey_question_attach_conditions($pdo, [$row])[0] ?? $row;

        survey_question_audit($pdo, $actor, 'added', (int)$newId, $surveyId, (string)($p['question_text'] ?? ''));
        survey_question_notify_ssg_of_secretary($pdo, $actor, 'added', (int)$newId, $surveyId, (string)($p['question_text'] ?? ''));
        api_out(201, ['message' => 'Question created', 'data' => $row, 'supports' => $supports]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;

        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) {
            $id = isset($p['question_id']) ? (int)$p['question_id'] : 0;
        }
        if ($id <= 0) api_out(400, ['message' => 'Valid question id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        // The same refusal POST makes. Update had none, so anything create
        // turned away could be PUT onto the row a moment later. 'prose' as on
        // create - a question is a sentence and often ends in a question mark.
        $unsafe = api_reject_unsafe_fields($p, [
            'question_text' => 'Question text',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $chk = $pdo->prepare('SELECT * FROM survey_question WHERE question_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Question not found']);

        $fields = [];
        $params = [':id' => $id];
        $editable = ['survey_id', 'question_text', 'question_type'];
        if ($supportsIsRequired) $editable[] = 'is_required';
        if ($supportsSortOrder) $editable[] = 'sort_order';
        if ($supportsStatus) $editable[] = 'status';

        foreach ($editable as $col) {
            if (!array_key_exists($col, $p)) continue;

            $fields[] = "$col = :$col";
            if ($col === 'survey_id') {
                $val = ($p[$col] !== null && $p[$col] !== '') ? (int)$p[$col] : null;
                if ($val !== null && $val <= 0) api_out(400, ['message' => 'survey_id is invalid']);
                $params[":$col"] = $val;
                continue;
            }

            if ($col === 'question_text') {
                $val = trim((string)($p[$col] ?? ''));
                if ($val === '') api_out(400, ['message' => 'question_text cannot be empty']);
                $lengthError = survey_text_length_error('question_text', $val);
                if ($lengthError !== null) api_out(400, ['message' => $lengthError]);
                $params[":$col"] = $val;
                continue;
            }

            if ($col === 'question_type') {
                $val = normalize_question_type($p[$col] ?? null);
                if ($val === null) api_out(400, ['message' => 'question_type must be text, radio, checkbox, or rating']);
                $params[":$col"] = $val;
                continue;
            }

            if ($col === 'is_required') {
                $val = ($p[$col] !== null && $p[$col] !== '') ? (int)$p[$col] : null;
                if ($val !== null && !in_array($val, [0, 1], true)) api_out(400, ['message' => 'is_required must be 0 or 1']);
                $params[":$col"] = $val;
                continue;
            }

            if ($col === 'sort_order') {
                $val = ($p[$col] !== null && $p[$col] !== '') ? (int)$p[$col] : null;
                if ($val !== null && $val < 0) api_out(400, ['message' => 'sort_order cannot be negative']);
                $params[":$col"] = $val;
                continue;
            }

            if ($col === 'status') {
                $val = ($p[$col] !== null && $p[$col] !== '') ? (int)$p[$col] : null;
                if ($val !== null && $val < 0) api_out(400, ['message' => 'status is invalid']);
                $params[":$col"] = $val;
                continue;
            }
        }

        /*
         * The answer format, resolved against the type the question will have
         * after this edit rather than the one it had before.
         *
         * Switching a "Mobile number" text question to radio has to drop the
         * format with it; leaving it behind would put a rule on option labels
         * the author already chose, and the next edit that switched it back
         * would silently resurrect it. Written only when it actually differs,
         * so a PUT that changes nothing else still reports "No changes".
         */
        $effectiveType = array_key_exists('question_type', $p)
            ? (string)normalize_question_type($p['question_type'])
            : strtolower(trim((string)($existing['question_type'] ?? 'text')));
        $requestedFormat = array_key_exists('answer_format', $p)
            ? $p['answer_format']
            : ($existing['answer_format'] ?? 'any');
        $nextFormat = $effectiveType === 'text'
            ? survey_answer_format_normalize($requestedFormat)
            : 'any';

        if ($supportsAnswerFormat) {
            if ($nextFormat !== survey_answer_format_normalize($existing['answer_format'] ?? 'any')) {
                $fields[] = 'answer_format = :answer_format';
                $params[':answer_format'] = $nextFormat;
            }
        }

        /*
         * The character limit, resolved against the format the question will
         * carry after this edit. Switching the type away from text drops it, the
         * way the format is dropped; shrinking the format re-clamps it to the new
         * ceiling. Written only when it actually changes, so a PUT that touches
         * nothing else still reports "No changes".
         */
        if ($supportsAnswerMaxLength) {
            $requestedLimit = array_key_exists('answer_max_length', $p)
                ? $p['answer_max_length']
                : ($existing['answer_max_length'] ?? null);
            $nextLimit = resolve_answer_max_length($requestedLimit, $effectiveType, $nextFormat);

            $existingLimit = $existing['answer_max_length'] ?? null;
            $existingLimit = ($existingLimit === null || $existingLimit === '') ? null : (int)$existingLimit;

            if ($nextLimit !== $existingLimit) {
                $fields[] = 'answer_max_length = :answer_max_length';
                $params[':answer_max_length'] = $nextLimit;
            }
        }

        /*
         * The wording, or the survey it is moved to, must not repeat a question
         * already there. Checked before anything is written - the branching
         * conditions just below are saved on their own, and a refused edit must
         * not leave half of itself behind.
         */
        if (array_key_exists(':question_text', $params) || array_key_exists(':survey_id', $params)) {
            $targetSurvey = array_key_exists(':survey_id', $params) ? $params[':survey_id'] : ($existing['survey_id'] ?? null);
            $targetText = (string)($params[':question_text'] ?? $existing['question_text'] ?? '');
            if ($targetSurvey !== null) {
                $duplicate = survey_question_duplicate_error($pdo, (int)$targetSurvey, $targetText, $id);
                if ($duplicate !== null) api_out(409, ['message' => $duplicate]);
            }
        }

        // Visibility rules live in their own table, so they are saved whether or
        // not a column changed. Checked before the "No changes" exit: editing
        // only the branching condition is a real edit, and bailing here would
        // report success while discarding it.
        $conditionsRequested = array_key_exists('show_when_option_ids', $p);
        if ($conditionsRequested) {
            survey_question_save_conditions($pdo, $id, $p['show_when_option_ids']);
        }

        if (empty($fields) && !$conditionsRequested) api_out(200, ['message' => 'No changes']);

        if (!empty($fields)) {
            $sql = 'UPDATE survey_question SET ' . implode(', ', $fields) . ' WHERE question_id = :id';
            $upd = $pdo->prepare($sql);
            $upd->execute($params);
        }

        $sel = $pdo->prepare('SELECT * FROM survey_question WHERE question_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);
        $row = survey_question_attach_conditions($pdo, [$row])[0] ?? $row;

        survey_question_audit($pdo, $actor, 'edited', (int)$id, (int)($row['survey_id'] ?? 0), (string)($row['question_text'] ?? ''));
        survey_question_notify_ssg_of_secretary($pdo, $actor, 'edited', (int)$id, (int)($row['survey_id'] ?? 0), (string)($row['question_text'] ?? ''));
        api_out(200, ['message' => 'Question updated', 'data' => $row, 'supports' => $supports]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid question id is required']);

        // Capture the context before the row is gone, for the SSG notification.
        $ctxStmt = $pdo->prepare('SELECT survey_id, question_text FROM survey_question WHERE question_id = :id LIMIT 1');
        $ctxStmt->execute([':id' => $id]);
        $ctxRow = $ctxStmt->fetch(PDO::FETCH_ASSOC) ?: [];

        $del = $pdo->prepare('DELETE FROM survey_question WHERE question_id = :id');
        $del->execute([':id' => $id]);

        survey_question_audit($pdo, $actor, 'deleted', $id, (int)($ctxRow['survey_id'] ?? 0), (string)($ctxRow['question_text'] ?? ''));
        survey_question_notify_ssg_of_secretary($pdo, $actor, 'deleted', $id, (int)($ctxRow['survey_id'] ?? 0), (string)($ctxRow['question_text'] ?? ''));
        api_out(200, ['message' => 'Question deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    // Two saves raced past the check above; the index refused the second.
    if (survey_is_duplicate_key($e)) {
        api_out(409, ['message' => 'This survey already asks that question. Each question in a survey must be different.']);
    }
    // Returning the message can help during development; comment it out for production.
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
