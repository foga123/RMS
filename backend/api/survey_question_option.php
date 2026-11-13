<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/survey_text_limits.php';
// A question offers each choice once: survey_option_duplicate_error().
require_once __DIR__ . '/lib/survey_uniqueness.php';


function question_exists(PDO $pdo, int $questionId): bool {
    $stmt = $pdo->prepare('SELECT question_id FROM survey_question WHERE question_id = :id LIMIT 1');
    $stmt->execute([':id' => $questionId]);
    return (bool)$stmt->fetch();
}

function option_row(PDO $pdo, int $optionId) {
    $stmt = $pdo->prepare(
        'SELECT o.option_id, o.question_id, o.option_text, o.enrollment_status_id,
                s.status_name AS enrollment_status_name
           FROM survey_question_option o
      LEFT JOIN status s ON s.status_id = o.enrollment_status_id
          WHERE o.option_id = :id
          LIMIT 1'
    );
    $stmt->execute([':id' => $optionId]);
    return $stmt->fetch(PDO::FETCH_ASSOC);
}

/**
 * Resolve the `enrollment_status_id` field of a request body.
 *
 * Returns null when the caller is clearing the mapping, which is the ordinary
 * state for the great majority of options.
 *
 * The foreign key only guarantees the target is *a* status; `status` is a
 * shared lookup holding account, finance, attendance and semester rows too, and
 * pointing an enrolment mapping at "3k Above" would be accepted by the database
 * and meaningless everywhere else. That check has to live here.
 */
function normalize_enrollment_status_id(PDO $pdo, $value): ?int {
    if ($value === null || $value === '' || $value === false) return null;

    $statusId = (int)$value;
    if ($statusId <= 0) return null;

    $stmt = $pdo->prepare('SELECT status_type FROM status WHERE status_id = :id LIMIT 1');
    $stmt->execute([':id' => $statusId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        api_out(400, ['message' => 'Selected enrollment status does not exist']);
    }
    if (strtolower(trim((string)$row['status_type'])) !== 'enrollment') {
        api_out(400, ['message' => 'Selected status is not an enrollment status']);
    }

    return $statusId;
}

/**
 * The editor's list of choices, checked one by one before it is saved whole
 * by survey_options_replace() (lib/survey_uniqueness.php): each an object,
 * each non-empty and within the length rule, each enrolment mapping a real
 * enrolment status. Refusals are SurveyOptionReplaceError, answered by status.
 */
function survey_option_list_from_request(PDO $pdo, array $incoming): array
{
    $clean = [];
    foreach ($incoming as $entry) {
        if (!is_array($entry)) {
            throw new SurveyOptionReplaceError(400, 'Each choice must be an object.');
        }
        $text = trim((string)($entry['option_text'] ?? ''));
        if ($text === '') {
            throw new SurveyOptionReplaceError(400, 'A choice cannot be empty.');
        }
        $lengthError = survey_text_length_error('option_text', $text);
        if ($lengthError !== null) {
            throw new SurveyOptionReplaceError(400, $lengthError);
        }
        $clean[] = [
            'option_id' => max(0, (int)($entry['option_id'] ?? 0)),
            'option_text' => $text,
            'enrollment_status_id' => normalize_enrollment_status_id($pdo, $entry['enrollment_status_id'] ?? null),
        ];
    }
    return $clean;
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $row = option_row($pdo, $id);
            if (!$row) api_out(404, ['message' => 'Option not found']);
            api_out(200, ['data' => $row]);
        }

        if (!isset($_GET['question_id']) || $_GET['question_id'] === '') {
            api_out(400, ['message' => 'question_id is required']);
        }
        $questionId = (int)$_GET['question_id'];
        if ($questionId <= 0) api_out(400, ['message' => 'question_id is invalid']);

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(500, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;
        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';

        $whereParts = ['o.question_id = :question_id'];
        $params = [':question_id' => $questionId];
        if ($search !== '') {
            $whereParts[] = 'o.option_text LIKE :q';
            $params[':q'] = "%$search%";
        }
        $where = 'WHERE ' . implode(' AND ', $whereParts);

        $sql = "SELECT o.option_id, o.question_id, o.option_text, o.enrollment_status_id,
                       s.status_name AS enrollment_status_name
                FROM survey_question_option o
                LEFT JOIN status s ON s.status_id = o.enrollment_status_id
                $where
                ORDER BY o.option_id ASC
                LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = "SELECT COUNT(*) FROM survey_question_option o $where";
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) {
            $countStmt->bindValue($k, $v);
        }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        if (!isset($p['question_id']) || $p['question_id'] === '') api_out(400, ['message' => 'question_id is required']);
        $questionId = (int)$p['question_id'];
        if ($questionId <= 0) api_out(400, ['message' => 'question_id is invalid']);
        if (!question_exists($pdo, $questionId)) api_out(400, ['message' => 'Selected question does not exist']);

        $optionText = trim((string)($p['option_text'] ?? ''));
        if ($optionText === '') api_out(400, ['message' => 'option_text is required']);
        // Was strlen() against the raw column width. Two problems: strlen counts
        // bytes, so "Hindi pa sigurado" written with an ñ got less room than the
        // same choice without one; and 255 is the storage ceiling rather than a
        // considered limit. The shared rule counts characters and says what it
        // wants in the message.
        $lengthError = survey_text_length_error('option_text', $optionText);
        if ($lengthError !== null) api_out(400, ['message' => $lengthError]);

        $enrollmentStatusId = normalize_enrollment_status_id($pdo, $p['enrollment_status_id'] ?? null);
        $duplicate = survey_option_duplicate_error($pdo, $questionId, $optionText);
        if ($duplicate !== null) api_out(409, ['message' => $duplicate]);

        $ins = $pdo->prepare(
            'INSERT INTO survey_question_option (question_id, option_text, enrollment_status_id)
             VALUES (:question_id, :option_text, :enrollment_status_id)'
        );
        $ins->execute([
            ':question_id' => $questionId,
            ':option_text' => $optionText,
            ':enrollment_status_id' => $enrollmentStatusId,
        ]);
        $newId = (int)$pdo->lastInsertId();

        $row = option_row($pdo, $newId);
        api_out(201, ['message' => 'Option created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);

        // The whole list at once - see survey_options_replace().
        if ($id <= 0 && isset($query['question_id']) && is_array($p) && is_array($p['options'] ?? null)) {
            $questionId = (int)$query['question_id'];
            if ($questionId <= 0 || !question_exists($pdo, $questionId)) api_out(404, ['message' => 'Question not found']);

            $caller = api_get_session_user() ?? [];
            $record = api_fetch_effective_permissions_record($pdo, (int)($caller['role_id'] ?? 0), (int)($caller['user_id'] ?? 0));
            $permissions = $record['permissions'] ?? [];
            try {
                survey_options_replace(
                    $pdo,
                    $questionId,
                    survey_option_list_from_request($pdo, array_values($p['options'])),
                    api_can($permissions, 'survey_questions', 'create'),
                    api_can($permissions, 'survey_questions', 'delete')
                );
            } catch (SurveyOptionReplaceError $refused) {
                api_out($refused->status, ['message' => $refused->getMessage()]);
            }
            $saved = $pdo->prepare('SELECT option_id FROM survey_question_option WHERE question_id = :question ORDER BY option_id');
            $saved->execute([':question' => $questionId]);
            $rows = array_map(static fn($optionId) => option_row($pdo, (int)$optionId), $saved->fetchAll(PDO::FETCH_COLUMN));
            api_out(200, ['message' => 'Choices saved', 'data' => $rows]);
        }
        if (is_array($p) && !$id) $id = isset($p['option_id']) ? (int)$p['option_id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid option id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $existing = option_row($pdo, $id);
        if (!$existing) api_out(404, ['message' => 'Option not found']);

        $fields = [];
        $params = [':id' => $id];

        if (array_key_exists('question_id', $p)) {
            if ($p['question_id'] === '' || $p['question_id'] === null) api_out(400, ['message' => 'question_id cannot be empty']);
            $questionId = (int)$p['question_id'];
            if ($questionId <= 0) api_out(400, ['message' => 'question_id is invalid']);
            if (!question_exists($pdo, $questionId)) api_out(400, ['message' => 'Selected question does not exist']);
            $fields[] = 'question_id = :question_id';
            $params[':question_id'] = $questionId;
        }

        if (array_key_exists('option_text', $p)) {
            $optionText = trim((string)$p['option_text']);
            if ($optionText === '') api_out(400, ['message' => 'option_text cannot be empty']);
            $lengthError = survey_text_length_error('option_text', $optionText);
            if ($lengthError !== null) api_out(400, ['message' => $lengthError]);
            $fields[] = 'option_text = :option_text';
            $params[':option_text'] = $optionText;
        }

        // Absent key leaves the mapping alone; an explicit null clears it.
        if (array_key_exists('enrollment_status_id', $p)) {
            $fields[] = 'enrollment_status_id = :enrollment_status_id';
            $params[':enrollment_status_id'] = normalize_enrollment_status_id($pdo, $p['enrollment_status_id']);
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        // The wording, or the question it is moved to, must not repeat a choice already there.
        if (array_key_exists(':option_text', $params) || array_key_exists(':question_id', $params)) {
            $duplicate = survey_option_duplicate_error(
                $pdo,
                (int)($params[':question_id'] ?? $existing['question_id']),
                (string)($params[':option_text'] ?? $existing['option_text']),
                $id
            );
            if ($duplicate !== null) api_out(409, ['message' => $duplicate]);
        }

        $sql = 'UPDATE survey_question_option SET ' . implode(', ', $fields) . ' WHERE option_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $row = option_row($pdo, $id);
        api_out(200, ['message' => 'Option updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid option id is required']);

        $existing = option_row($pdo, $id);
        if (!$existing) api_out(404, ['message' => 'Option not found']);

        $del = $pdo->prepare('DELETE FROM survey_question_option WHERE option_id = :id');
        $del->execute([':id' => $id]);

        api_out(200, ['message' => 'Option deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    // Two saves raced past the checks; uq_survey_option_text refused the second.
    if (survey_is_duplicate_key($e)) {
        api_out(409, ['message' => survey_option_list_clash_message()]);
    }
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
