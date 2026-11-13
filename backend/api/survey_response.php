<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
// Shared with survey_submission.php so both reach the same standing from the
// same answer. An answer whose option carries an enrollment_status_id moves the
// student on the Student Migration board, whichever screen recorded it.
require_once __DIR__ . '/lib/survey_enrollment_status.php';
require_once __DIR__ . '/lib/migration_decision.php';


function normalize_submitted_at(array $payload, ?string $fallback = null): string {
    if (array_key_exists('submitted_at', $payload) && $payload['submitted_at'] !== null && trim((string)$payload['submitted_at']) !== '') {
        $raw = trim((string)$payload['submitted_at']);
        $ts = strtotime($raw);
        if ($ts !== false) return date('Y-m-d H:i:s', $ts);
    }
    if (array_key_exists('date', $payload) && $payload['date'] !== null && trim((string)$payload['date']) !== '') {
        $rawDate = trim((string)$payload['date']);
        $ts = strtotime($rawDate . ' 00:00:00');
        if ($ts !== false) return date('Y-m-d H:i:s', $ts);
    }
    if ($fallback !== null && trim($fallback) !== '') return $fallback;
    return date('Y-m-d H:i:s');
}

function answer_row(PDO $pdo, int $id) {
    $sel = $pdo->prepare(
        'SELECT
            sa.answer_id AS response_id,
            sa.answer_id,
            sa.question_id,
            sq.question_text,
            sa.answer,
            sa.submission_id,
            ss.survey_id,
            sv.survey_title,
            ss.student_id,
            st.student_number,
            ss.submitted_at,
            DATE(ss.submitted_at) AS date
         FROM survey_answer sa
         LEFT JOIN survey_question sq ON sq.question_id = sa.question_id
         LEFT JOIN survey_submission ss ON ss.submission_id = sa.submission_id
         LEFT JOIN survey sv ON sv.survey_id = ss.survey_id
         LEFT JOIN student st ON st.student_id = ss.student_id
         WHERE sa.answer_id = :id
         LIMIT 1'
    );
    $sel->execute([':id' => $id]);
    return $sel->fetch(PDO::FETCH_ASSOC);
}

/**
 * Answers in an archived submission are read-only until it is restored.
 *
 * Archiving (survey_submission.php DELETE, since 2026-10-07) keeps a
 * submission's answers so it can be restored as it was; editing them while it
 * is archived would change a record nobody can see on the screens that count it.
 */
function survey_response_refuse_archived_submission(PDO $pdo, int $submissionId): void {
    if ($submissionId <= 0) return;
    $stmt = $pdo->prepare('SELECT archived_at FROM survey_submission WHERE submission_id = :id LIMIT 1');
    $stmt->execute([':id' => $submissionId]);
    $archivedAt = $stmt->fetchColumn();
    if ($archivedAt !== false && $archivedAt !== null) {
        api_out(409, [
            'message' => 'This submission is archived. Restore it on the Survey Submissions screen before changing its answers.',
            'code' => 'SUBMISSION_ARCHIVED',
        ]);
    }
}

function resolve_submission_id(PDO $pdo, array $payload, ?array $existing = null): int {
    if (array_key_exists('submission_id', $payload) && $payload['submission_id'] !== null && $payload['submission_id'] !== '') {
        $submissionId = (int)$payload['submission_id'];
        if ($submissionId <= 0) throw new RuntimeException('submission_id is invalid');
        if (!api_fk_exists($pdo, 'SELECT submission_id FROM survey_submission WHERE submission_id = :id LIMIT 1', $submissionId)) {
            throw new RuntimeException('Selected submission does not exist');
        }
        survey_response_refuse_archived_submission($pdo, $submissionId);
        if (array_key_exists('submitted_at', $payload) || array_key_exists('date', $payload)) {
            $newTs = normalize_submitted_at($payload);
            $upd = $pdo->prepare('UPDATE survey_submission SET submitted_at = :ts WHERE submission_id = :id');
            $upd->execute([':ts' => $newTs, ':id' => $submissionId]);
        }
        return $submissionId;
    }

    $hasSurvey = array_key_exists('survey_id', $payload) && $payload['survey_id'] !== null && $payload['survey_id'] !== '';
    $hasStudent = array_key_exists('student_id', $payload) && $payload['student_id'] !== null && $payload['student_id'] !== '';

    $surveyId = $hasSurvey ? (int)$payload['survey_id'] : (int)($existing['survey_id'] ?? 0);
    $studentId = $hasStudent ? (int)$payload['student_id'] : (int)($existing['student_id'] ?? 0);

    if ($surveyId <= 0 || $studentId <= 0) {
        if ($existing && isset($existing['submission_id'])) {
            return (int)$existing['submission_id'];
        }
        throw new RuntimeException('Provide either submission_id or both survey_id and student_id');
    }

    if (!api_fk_exists($pdo, 'SELECT survey_id FROM survey WHERE survey_id = :id LIMIT 1', $surveyId)) {
        throw new RuntimeException('Selected survey does not exist');
    }
    if (!api_fk_exists($pdo, 'SELECT student_id FROM student WHERE student_id = :id LIMIT 1', $studentId)) {
        throw new RuntimeException('Selected student does not exist');
    }

    $reuseExisting = $existing
        && (int)$existing['survey_id'] === $surveyId
        && (int)$existing['student_id'] === $studentId
        && isset($existing['submission_id']);

    if ($reuseExisting) {
        $submissionId = (int)$existing['submission_id'];
    } else {
        // The student's LIVE submission. An archived one is left as it was; with
        // none live, a new submission is started below.
        $find = $pdo->prepare(
            'SELECT submission_id
             FROM survey_submission
             WHERE survey_id = :survey_id AND student_id = :student_id
               AND archived_at IS NULL
             ORDER BY submitted_at DESC, submission_id DESC
             LIMIT 1'
        );
        $find->execute([':survey_id' => $surveyId, ':student_id' => $studentId]);
        $submissionId = (int)$find->fetchColumn();

        if ($submissionId <= 0) {
            $submittedAt = normalize_submitted_at($payload);
            $ins = $pdo->prepare(
                'INSERT INTO survey_submission (survey_id, student_id, submitted_at)
                 VALUES (:survey_id, :student_id, :submitted_at)'
            );
            $ins->execute([
                ':survey_id' => $surveyId,
                ':student_id' => $studentId,
                ':submitted_at' => $submittedAt,
            ]);
            $submissionId = (int)$pdo->lastInsertId();
        }
    }

    if (array_key_exists('submitted_at', $payload) || array_key_exists('date', $payload)) {
        $newTs = normalize_submitted_at($payload);
        $upd = $pdo->prepare('UPDATE survey_submission SET submitted_at = :ts WHERE submission_id = :id');
        $upd->execute([':ts' => $newTs, ':id' => $submissionId]);
    }

    return $submissionId;
}

function submission_belongs_to_student(PDO $pdo, int $submissionId, int $studentId): bool {
    $stmt = $pdo->prepare('SELECT submission_id FROM survey_submission WHERE submission_id = :submission_id AND student_id = :student_id LIMIT 1');
    $stmt->execute([
        ':submission_id' => $submissionId,
        ':student_id' => $studentId,
    ]);
    return (bool)$stmt->fetch();
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
            $row = answer_row($pdo, $id);
            if (!$row) api_out(404, ['message' => 'Response not found']);
            // A student may read their own answer and no one else's. Same rule,
            // same shape, as survey_submission.php one row up the chain.
            if ($isStudent && (int)($row['student_id'] ?? 0) !== $sessionStudentId) {
                api_out(403, ['message' => 'Forbidden']);
            }
            api_out(200, ['data' => $row]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $surveyId = (isset($_GET['survey_id']) && $_GET['survey_id'] !== '') ? (int)$_GET['survey_id'] : null;
        $questionId = (isset($_GET['question_id']) && $_GET['question_id'] !== '') ? (int)$_GET['question_id'] : null;
        $studentId = (isset($_GET['student_id']) && $_GET['student_id'] !== '') ? (int)$_GET['student_id'] : null;
        $submissionId = (isset($_GET['submission_id']) && $_GET['submission_id'] !== '') ? (int)$_GET['submission_id'] : null;

        /*
         * A student reads their own answers, whatever the query string asks
         * for — the overwrite is what makes ?student_id= someone else's id
         * return that student's rows scoped back to the caller rather than the
         * other student's answers. ?submission_id= is left as sent because the
         * student_id clause below still applies to it: a submission belonging
         * to anyone else simply matches no rows.
         */
        if ($isStudent) {
            if ($sessionStudentId <= 0) api_out(403, ['message' => 'Student account is not linked to a student record']);
            $studentId = $sessionStudentId;
        }

        $from = 'FROM survey_answer sa
                 LEFT JOIN survey_question sq ON sq.question_id = sa.question_id
                 LEFT JOIN survey_submission ss ON ss.submission_id = sa.submission_id
                 LEFT JOIN survey sv ON sv.survey_id = ss.survey_id
                 LEFT JOIN student st ON st.student_id = ss.student_id';

        $whereParts = [];
        $params = [];
        if ($search !== '') {
            $whereParts[] = '(sa.answer LIKE :q OR st.student_number LIKE :q OR sv.survey_title LIKE :q OR sq.question_text LIKE :q)';
            $params[':q'] = "%$search%";
        }
        if ($surveyId !== null) {
            $whereParts[] = 'ss.survey_id = :survey_id';
            $params[':survey_id'] = $surveyId;
        }
        if ($questionId !== null) {
            $whereParts[] = 'sa.question_id = :question_id';
            $params[':question_id'] = $questionId;
        }
        if ($studentId !== null) {
            $whereParts[] = 'ss.student_id = :student_id';
            $params[':student_id'] = $studentId;
        }
        if ($submissionId !== null) {
            $whereParts[] = 'sa.submission_id = :submission_id';
            $params[':submission_id'] = $submissionId;
        } else {
            // Results and exports read live submissions only. Asking for one
            // submission by id still shows its answers when it is archived -
            // that is how its Archived tab opens it - except to a student, for
            // whom an archived submission is as gone as a deleted one was.
            $whereParts[] = 'ss.archived_at IS NULL';
        }
        if ($submissionId !== null && $isStudent) {
            $whereParts[] = 'ss.archived_at IS NULL';
        }

        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT
                    sa.answer_id AS response_id,
                    sa.answer_id,
                    sa.question_id,
                    sq.question_text,
                    sa.answer,
                    sa.submission_id,
                    ss.survey_id,
                    sv.survey_title,
                    ss.student_id,
                    st.student_number,
                    ss.submitted_at,
                    DATE(ss.submitted_at) AS date
                $from
                $where
                ORDER BY st.student_number ASC, ss.submitted_at DESC, sa.answer_id DESC
                LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = "SELECT COUNT(*) $from " . ($where !== '' ? $where : '');
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

        if ($isStudent) {
            if ($sessionStudentId <= 0) api_out(403, ['message' => 'Student account is not linked to a student record']);
            if (isset($p['student_id']) && (int)$p['student_id'] !== $sessionStudentId) {
                api_out(403, ['message' => 'Forbidden']);
            }
            if (isset($p['submission_id']) && $p['submission_id'] !== '' && $p['submission_id'] !== null) {
                $submissionId = (int)$p['submission_id'];
                if ($submissionId <= 0 || !submission_belongs_to_student($pdo, $submissionId, $sessionStudentId)) {
                    api_out(403, ['message' => 'Forbidden']);
                }
            }
        }

        if (!isset($p['question_id']) || $p['question_id'] === '') api_out(400, ['message' => 'question_id is required']);
        $questionId = (int)$p['question_id'];
        if ($questionId <= 0) api_out(400, ['message' => 'question_id is invalid']);
        if (!api_fk_exists($pdo, 'SELECT question_id FROM survey_question WHERE question_id = :id LIMIT 1', $questionId)) {
            api_out(400, ['message' => 'Selected question does not exist']);
        }

        $answerText = array_key_exists('answer', $p) ? (string)$p['answer'] : null;

        // Opt-in, because plain POST means "add a response" to the Responses
        // screen and changing that under it would be a surprise. Callers that
        // are setting one question's answer - the Student Migration decision
        // dropdown - ask for replace so a student ends up with one answer per
        // question instead of a growing stack the reports would double-count.
        $replaceExisting = !empty($p['replace_existing']);

        // Optional, both or neither: the term to file the implied standing
        // under. The Student Migration board sends the term it is showing;
        // without one the standing goes where the submission implies (the
        // survey's semester, the student's school year). Staff only: a student
        // naming a term would be choosing which term their own standing lands in.
        $fileUnder = null;
        $hasYear = isset($p['school_year_id']) && $p['school_year_id'] !== '';
        $hasSemester = isset($p['semester_id']) && $p['semester_id'] !== '';
        if (($hasYear || $hasSemester) && $isStudent) {
            api_out(403, ['message' => 'Forbidden']);
        }
        if ($hasYear || $hasSemester) {
            $fileUnder = ['school_year_id' => (int)($p['school_year_id'] ?? 0), 'semester_id' => (int)($p['semester_id'] ?? 0)];
            if (!api_fk_exists($pdo, 'SELECT school_year_id FROM school_year WHERE school_year_id = :id LIMIT 1', $fileUnder['school_year_id'])
                || !api_fk_exists($pdo, 'SELECT semester_id FROM semester WHERE semester_id = :id LIMIT 1', $fileUnder['semester_id'])) {
                api_out(400, ['message' => 'Choose both a school year and a semester that exist.']);
            }
        }

        $migrationChoice = null;
        if (($p['migration_decision'] ?? false) === true) {
            if (!$fileUnder || !$replaceExisting) api_out(400, ['message' => 'Choose a school year, semester and decision source before saving.']);
            $migrationChoice = migration_decision_choice($pdo, $questionId, (int)($p['option_id'] ?? 0), (int)($p['survey_id'] ?? 0), $fileUnder['semester_id']);
            if (!$migrationChoice) api_out(400, ['message' => 'Choose an active enrollment option from the selected survey question for this semester.']);
            $answerText = $migrationChoice['option_text'];
            if (!empty($p['submission_id'])) {
                $owner = $pdo->prepare('SELECT survey_id, student_id FROM survey_submission WHERE submission_id = :id');
                $owner->execute([':id' => (int)$p['submission_id']]);
                $submission = $owner->fetch(PDO::FETCH_ASSOC);
                if (!$submission || (int)$submission['survey_id'] !== (int)$p['survey_id'] || (int)$submission['student_id'] !== (int)($p['student_id'] ?? 0)) {
                    api_out(400, ['message' => 'The submission must belong to this student and selected survey.']);
                }
            }
        }

        $pdo->beginTransaction();
        try {
            $submissionId = resolve_submission_id($pdo, $p, null);

            if ($replaceExisting) {
                $clear = $pdo->prepare(
                    'DELETE FROM survey_answer WHERE submission_id = :submission_id AND question_id = :question_id'
                );
                $clear->execute([':submission_id' => $submissionId, ':question_id' => $questionId]);
            }

            $ins = $pdo->prepare(
                'INSERT INTO survey_answer (question_id, answer, submission_id, option_id)
                 VALUES (:question_id, :answer, :submission_id, :option_id)'
            );
            $ins->execute([
                ':question_id' => $questionId,
                ':answer' => $answerText,
                ':submission_id' => $submissionId,
                ':option_id' => $migrationChoice ? (int)$migrationChoice['option_id'] : null,
            ]);
            $newId = (int)$pdo->lastInsertId();

            // Inside the transaction: a response that claims to have set a
            // standing, and did not, is worse than no response at all.
            $enrollmentUpdate = apply_survey_enrollment_status_for_submission($pdo, $submissionId, $fileUnder, $migrationChoice ? $questionId : null);

            // An answer that would restate a closed semester's standing is
            // refused whole: the answer is that term's record as well.
            if (($enrollmentUpdate['code'] ?? null) === TERM_CLOSURE_CODE) {
                $pdo->rollBack();
                api_out(TERM_CLOSURE_HTTP_STATUS, [
                    'message' => $enrollmentUpdate['reason'],
                    'code' => TERM_CLOSURE_CODE,
                    'term' => $enrollmentUpdate['term'] ?? null,
                ]);
            }

            $pdo->commit();
        } catch (Throwable $inner) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $inner;
        }

        $row = answer_row($pdo, $newId);
        api_out(201, [
            'message' => 'Response created',
            'data' => $row,
            'enrollment_status_update' => $enrollmentUpdate,
        ]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) $id = isset($p['response_id']) ? (int)$p['response_id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid response id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        $existing = answer_row($pdo, $id);
        if (!$existing) api_out(404, ['message' => 'Response not found']);
        survey_response_refuse_archived_submission($pdo, (int)($existing['submission_id'] ?? 0));

        $fields = [];
        $params = [':id' => $id];
        $submissionTouched = false;
        $resolvedSubmissionId = (int)$existing['submission_id'];

        if (array_key_exists('question_id', $p)) {
            if ($p['question_id'] === '' || $p['question_id'] === null) api_out(400, ['message' => 'question_id cannot be empty']);
            $questionId = (int)$p['question_id'];
            if ($questionId <= 0) api_out(400, ['message' => 'question_id is invalid']);
            if (!api_fk_exists($pdo, 'SELECT question_id FROM survey_question WHERE question_id = :id LIMIT 1', $questionId)) {
                api_out(400, ['message' => 'Selected question does not exist']);
            }
            $fields[] = 'question_id = :question_id';
            $params[':question_id'] = $questionId;
        }

        if (array_key_exists('answer', $p)) {
            $fields[] = 'answer = :answer';
            $params[':answer'] = $p['answer'] !== null ? (string)$p['answer'] : null;
        }

        $needsSubmissionResolve = array_key_exists('submission_id', $p)
            || array_key_exists('survey_id', $p)
            || array_key_exists('student_id', $p)
            || array_key_exists('date', $p)
            || array_key_exists('submitted_at', $p);

        $pdo->beginTransaction();
        try {
            if ($needsSubmissionResolve) {
                $submissionTouched = true;
                $resolvedSubmissionId = resolve_submission_id($pdo, $p, $existing);
                if ($resolvedSubmissionId !== (int)$existing['submission_id']) {
                    $fields[] = 'submission_id = :submission_id';
                    $params[':submission_id'] = $resolvedSubmissionId;
                }
            }

            if (!empty($fields)) {
                $sql = 'UPDATE survey_answer SET ' . implode(', ', $fields) . ' WHERE answer_id = :id';
                $upd = $pdo->prepare($sql);
                $upd->execute($params);
            } elseif (!$submissionTouched) {
                if ($pdo->inTransaction()) $pdo->rollBack();
                api_out(200, ['message' => 'No changes']);
            }

            // Editing an answer can change what it implies, so the standing is
            // re-derived here too - otherwise a correction made on the Responses
            // screen would leave the migration board showing the old decision.
            $enrollmentUpdate = apply_survey_enrollment_status_for_submission($pdo, $resolvedSubmissionId);

            // Refused whole when that standing sits in a closed semester, as
            // on create above.
            if (($enrollmentUpdate['code'] ?? null) === TERM_CLOSURE_CODE) {
                $pdo->rollBack();
                api_out(TERM_CLOSURE_HTTP_STATUS, [
                    'message' => $enrollmentUpdate['reason'],
                    'code' => TERM_CLOSURE_CODE,
                    'term' => $enrollmentUpdate['term'] ?? null,
                ]);
            }

            if ($pdo->inTransaction()) $pdo->commit();
        } catch (Throwable $inner) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $inner;
        }

        $row = answer_row($pdo, $id);
        api_out(200, ['message' => 'Response updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid response id is required']);

        $chk = $pdo->prepare('SELECT answer_id, submission_id FROM survey_answer WHERE answer_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Response not found']);

        $submissionId = (int)$existing['submission_id'];
        survey_response_refuse_archived_submission($pdo, $submissionId);
        $removedSubmission = false;

        $pdo->beginTransaction();
        try {
            $del = $pdo->prepare('DELETE FROM survey_answer WHERE answer_id = :id');
            $del->execute([':id' => $id]);

            if ($submissionId > 0) {
                $countStmt = $pdo->prepare('SELECT COUNT(*) FROM survey_answer WHERE submission_id = :submission_id');
                $countStmt->execute([':submission_id' => $submissionId]);
                $remaining = (int)$countStmt->fetchColumn();
                if ($remaining === 0) {
                    $delSub = $pdo->prepare('DELETE FROM survey_submission WHERE submission_id = :submission_id');
                    $delSub->execute([':submission_id' => $submissionId]);
                    $removedSubmission = true;
                }
            }

            $pdo->commit();
        } catch (Throwable $inner) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $inner;
        }

        api_out(200, ['message' => 'Response deleted', 'submission_removed' => $removedSubmission]);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
