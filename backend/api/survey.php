<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/survey_text_limits.php';
// survey_is_duplicate_key(), for the title index uq_survey_title_term.
require_once __DIR__ . '/lib/survey_uniqueness.php';
// Refuses a date MySQL would silently store as 0000-00-00.
require_once __DIR__ . '/lib/calendar_date.php';
require_once __DIR__ . '/periodic_lib.php';


/**
 * Copy one survey's questions onto another survey.
 *
 * Surveys here are rewritten every term, and the rewriting is done by hand:
 * "Student Enrollment Survey" and "Survey Enrollment Sem 2" are the same ten
 * questions retyped, down to the near-identical wording. That is slow and it
 * drifts — two questions meant to be the same end up phrased differently, and
 * the two terms stop being comparable.
 *
 * Copied, not shared: the new survey gets its own question rows, so editing the
 * copy cannot reach back and change a survey that already has answers filed
 * against it.
 *
 * Three tables move together, and the second and third need their foreign keys
 * remapped onto the new rows rather than left pointing at the original:
 *
 *   survey_question           -> new question_id per row
 *   survey_question_option    -> remapped question_id
 *   survey_question_condition -> remapped question_id AND option_id
 *
 * A condition pointing at an option outside the source survey is skipped: it
 * has no counterpart to be remapped onto, and copying it verbatim would leave
 * the new survey's branching wired to another survey's options.
 *
 * Columns are read from the table rather than listed, because survey_question
 * grows feature-detected columns (answer_format, sort_order, is_required) that
 * an installation may or may not have run the migration for.
 */
function survey_copy_questions(PDO $pdo, int $sourceSurveyId, int $targetSurveyId): int
{
    $copyableColumns = static function (string $table, array $skip) use ($pdo): array {
        $names = [];
        foreach ($pdo->query("SHOW COLUMNS FROM `$table`")->fetchAll(PDO::FETCH_ASSOC) ?: [] as $column) {
            $field = (string)$column['Field'];
            if (!in_array($field, $skip, true)) {
                $names[] = $field;
            }
        }
        return $names;
    };

    // ---- questions ---------------------------------------------------------
    $questionColumns = $copyableColumns('survey_question', ['question_id', 'survey_id']);
    $questionList = implode(', ', array_map(static fn(string $c): string => "`$c`", $questionColumns));
    $questionPlaceholders = implode(', ', array_map(static fn(string $c): string => ":$c", $questionColumns));

    $readQuestions = $pdo->prepare(
        "SELECT question_id, $questionList FROM survey_question
          WHERE survey_id = :survey_id
       ORDER BY (sort_order IS NULL) ASC, sort_order ASC, question_id ASC"
    );
    $readQuestions->execute([':survey_id' => $sourceSurveyId]);
    $sourceQuestions = $readQuestions->fetchAll(PDO::FETCH_ASSOC) ?: [];
    if (empty($sourceQuestions)) {
        return 0;
    }

    $insertQuestion = $pdo->prepare(
        "INSERT INTO survey_question (survey_id, $questionList) VALUES (:survey_id, $questionPlaceholders)"
    );

    $questionMap = [];
    foreach ($sourceQuestions as $question) {
        $bind = [':survey_id' => $targetSurveyId];
        foreach ($questionColumns as $column) {
            $bind[":$column"] = $question[$column];
        }
        $insertQuestion->execute($bind);
        $questionMap[(int)$question['question_id']] = (int)$pdo->lastInsertId();
    }

    // ---- options -----------------------------------------------------------
    $optionColumns = $copyableColumns('survey_question_option', ['option_id', 'question_id']);
    $optionList = implode(', ', array_map(static fn(string $c): string => "`$c`", $optionColumns));
    $optionPlaceholders = implode(', ', array_map(static fn(string $c): string => ":$c", $optionColumns));

    $readOptions = $pdo->prepare(
        "SELECT option_id, question_id, $optionList FROM survey_question_option
          WHERE question_id = :question_id ORDER BY option_id ASC"
    );
    $insertOption = $pdo->prepare(
        "INSERT INTO survey_question_option (question_id, $optionList) VALUES (:question_id, $optionPlaceholders)"
    );

    $optionMap = [];
    foreach ($questionMap as $oldQuestionId => $newQuestionId) {
        $readOptions->execute([':question_id' => $oldQuestionId]);
        foreach ($readOptions->fetchAll(PDO::FETCH_ASSOC) ?: [] as $option) {
            $bind = [':question_id' => $newQuestionId];
            foreach ($optionColumns as $column) {
                $bind[":$column"] = $option[$column];
            }
            $insertOption->execute($bind);
            $optionMap[(int)$option['option_id']] = (int)$pdo->lastInsertId();
        }
    }

    // ---- branching conditions ----------------------------------------------
    $readConditions = $pdo->prepare(
        'SELECT question_id, option_id FROM survey_question_condition WHERE question_id = :question_id'
    );
    $insertCondition = $pdo->prepare(
        'INSERT INTO survey_question_condition (question_id, option_id) VALUES (:question_id, :option_id)'
    );

    foreach ($questionMap as $oldQuestionId => $newQuestionId) {
        $readConditions->execute([':question_id' => $oldQuestionId]);
        foreach ($readConditions->fetchAll(PDO::FETCH_ASSOC) ?: [] as $condition) {
            $oldOptionId = (int)$condition['option_id'];
            if (!isset($optionMap[$oldOptionId])) {
                continue;
            }
            $insertCondition->execute([
                ':question_id' => $newQuestionId,
                ':option_id'   => $optionMap[$oldOptionId],
            ]);
        }
    }

    return count($questionMap);
}

/**
 * The year a survey date falls in, or null for no usable date.
 *
 * The same value the survey_year column computes with YEAR(`date`), done here
 * so a check can be run on a date before it is saved. `0000-00-00` (what this
 * non-strict MySQL stored for a bad date before the date check existed) is
 * year 0 to MySQL, and is here too.
 */
function survey_date_year(?string $date): ?int
{
    $date = trim((string)$date);
    if (!preg_match('/^(\d{4})-\d{2}-\d{2}/', $date, $m)) return null;
    return (int)$m[1];
}

/**
 * Is another survey already called this, in the same semester and year?
 *
 * A title may repeat from term to term - "Retention Survey" every 1st
 * Semester - but not within one: two of them in the 1st Semester of 2026 is a
 * list nobody can read. The year is the year of the survey's date, because a
 * survey has no school year and `semester` rows carry none either. See
 * migrations/2026_09_30_survey_title_per_term.sql for why that names the term.
 *
 * Plain equality on the title, not LOWER(survey_title) = LOWER(...): the
 * column is utf8mb4_general_ci, so the comparison already ignores case, and
 * MySQL ignores trailing spaces comparing VARCHAR - which is exactly what
 * uq_survey_title_term enforces, and the two must agree. <=> for the semester
 * and year, so two surveys with no semester are the same term here even
 * though the index (where NULLs never collide) would let them both in.
 * YEAR(sv.date) rather than sv.survey_year so the check reads the same thing
 * the column is computed from.
 *
 * $excludeId keeps an edit from colliding with itself.
 *
 * Runs before the write so the author reads which survey holds the name and
 * term; the index catches two saves that race.
 */
function survey_duplicate_title_error(PDO $pdo, string $title, ?int $semesterId, ?int $year, ?int $excludeId = null): ?string
{
    $sql = 'SELECT sv.survey_id, sem.semester_name
              FROM survey sv
              LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
             WHERE sv.survey_title = :title
               AND sv.semester_id <=> :semester_id
               AND YEAR(sv.date) <=> :year';
    $params = [':title' => $title, ':semester_id' => $semesterId, ':year' => $year];
    if ($excludeId !== null) {
        $sql .= ' AND sv.survey_id <> :exclude';
        $params[':exclude'] = $excludeId;
    }
    $stmt = $pdo->prepare($sql . ' LIMIT 1');
    $stmt->execute($params);
    $clash = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$clash) return null;

    $semesterName = trim((string)($clash['semester_name'] ?? ''));
    $term = trim(($semesterName !== '' ? $semesterName : 'no semester') . ($year !== null ? ' ' . $year : ''));

    return 'A survey called "' . $title . '" already exists for ' . $term
        . ' (#' . (int)$clash['survey_id'] . '). Give this one a different name, or another semester or year.';
}

// survey table schema (from capstone_db.sql):
// survey_id (PK, auto)
// semester_id (FK -> semester.semester_id)
// date (date)
// survey_year (generated: YEAR(date), for uq_survey_title_term; never written)
// survey_title (varchar)
// status (int FK -> status.status_id, using account statuses Active/Inactive)

try {
    $db = new Database();
    $pdo = $db->connect();
    $actor = api_get_session_user();

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT sv.survey_id, sv.semester_id, sv.period, sem.semester_name, sv.date, sv.survey_title, sv.status, st.status_name, st.status_type
                                   FROM survey sv
                                   LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
                                   LEFT JOIN status st ON st.status_id = sv.status
                                   WHERE sv.survey_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Survey not found']);
            api_out(200, ['data' => $row]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(200, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $semesterId = (isset($_GET['semester_id']) && $_GET['semester_id'] !== '') ? (int)$_GET['semester_id'] : null;
        $status = (isset($_GET['status']) && $_GET['status'] !== '') ? (int)$_GET['status'] : null;

        $whereParts = [];
        $params = [];
        if ($search !== '') {
            $whereParts[] = '(sv.survey_title LIKE :q OR sem.semester_name LIKE :q OR st.status_name LIKE :q)';
            $params[':q'] = "%$search%";
        }
        if ($semesterId !== null) {
            $whereParts[] = 'sv.semester_id = :semester_id';
            $params[':semester_id'] = $semesterId;
        }
        if ($status !== null) {
            $whereParts[] = 'sv.status = :status';
            $params[':status'] = $status;
        }
        /*
         * Which retention period's surveys to list. Same vocabulary as grades,
         * attendance and finance: 1, 2, 3, `term` for the surveys that cover a
         * whole semester, absent for all of them.
         */
        [$periodSql, $periodParams] = api_period_filter_sql('sv.period', $_GET['period'] ?? null, ':survey_period');
        if ($periodSql !== '') {
            $whereParts[] = $periodSql;
            $params += $periodParams;
        }
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        $sql = "SELECT sv.survey_id, sv.semester_id, sv.period, sem.semester_name, sv.date, sv.survey_title, sv.status, st.status_name, st.status_type
                FROM survey sv
                LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
                LEFT JOIN status st ON st.status_id = sv.status
                $where
                ORDER BY sv.survey_id DESC
                LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) {
            $stmt->bindValue($k, $v);
        }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = 'SELECT COUNT(*) FROM survey sv LEFT JOIN semester sem ON sem.semester_id = sv.semester_id LEFT JOIN status st ON st.status_id = sv.status ' . ($where !== '' ? $where : '');
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


        /*
         * Injection guard. See api_reject_unsafe_text() in middleware/auth.php
         * for the two levels and why refusing on input beats escaping on output.
         * Names and codes are identifiers ('strict'); anything that is a
         * sentence is 'prose', which allows the brackets and question marks real
         * writing contains.
         */
        $unsafe = api_reject_unsafe_fields($p, [
            'survey_title' => 'Survey title',
            'description' => 'Description',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        if (!isset($p['survey_title']) || trim((string)$p['survey_title']) === '') api_out(400, ['message' => 'survey_title is required']);
        // survey_title is varchar(255) and this MySQL runs without
        // STRICT_TRANS_TABLES, so anything longer was silently cut to fit and
        // stored. Rejecting it is the difference between a message and a title
        // that quietly loses its ending.
        $lengthError = survey_text_length_error('survey_title', trim((string)$p['survey_title']));
        if ($lengthError !== null) api_out(400, ['message' => $lengthError]);

        /*
         * The date is required on create, and has to be a real one.
         *
         * It used to be optional and unchecked, which produced two bad states
         * rather than one: a NULL date, and - because this MySQL is not in
         * strict mode - `0000-00-00` for anything that was not a valid date.
         * The Add Survey form fills today's date in for the author now, so a
         * blank arriving here is a client that skipped the field rather than a
         * person who could not decide.
         */
        $dateError = api_calendar_date_error((string)($p['date'] ?? ''), 'Survey date');
        if ($dateError !== null) api_out(400, ['message' => $dateError]);

        $semesterId = isset($p['semester_id']) && $p['semester_id'] !== '' ? (int)$p['semester_id'] : null;
        /*
         * Which retention period this survey is run in. Optional - a survey
         * that asks about the semester as a whole is the shape every existing
         * survey has, and stays legal.
         *
         * Identity check against false, not a falsy test: api_normalize_period
         * returns null for "not given" and false for "not a period", and
         * treating the second as the first would file a typo as a
         * whole-semester survey rather than refusing it.
         */
        $period = api_normalize_period($p['period'] ?? null);
        if ($period === false) {
            api_out(400, ['message' => 'period must be 1, 2 or 3, or left blank for a whole-semester survey']);
        }
        $statusId = isset($p['status']) && $p['status'] !== '' ? (int)$p['status'] : 1;

        if ($semesterId !== null) {
            $semChk = $pdo->prepare('SELECT semester_id FROM semester WHERE semester_id = :id LIMIT 1');
            $semChk->execute([':id' => $semesterId]);
            if (!$semChk->fetch()) api_out(400, ['message' => 'Selected semester does not exist']);
        }
        if ($statusId !== null) {
            $stChk = $pdo->prepare('SELECT status_id FROM status WHERE status_id = :id AND status_type = :type LIMIT 1');
            $stChk->execute([':id' => $statusId, ':type' => 'account']);
            if (!$stChk->fetch()) api_out(400, ['message' => 'status must be Active or Inactive']);
        }

        // After the date and semester are known good, since they are half of
        // what makes a name a duplicate: the same title in the same semester
        // and year is a list nobody can read - the author cannot tell which to
        // edit and the student cannot tell which to answer.
        $duplicateError = survey_duplicate_title_error(
            $pdo,
            trim((string)$p['survey_title']),
            $semesterId,
            survey_date_year((string)$p['date'])
        );
        if ($duplicateError !== null) api_out(409, ['message' => $duplicateError]);

        /*
         * Optionally start from an existing survey's questions.
         *
         * Validated before the insert so a bad id fails cleanly rather than
         * leaving an empty survey behind that someone has to find and delete.
         */
        $copyFromId = isset($p['copy_from_survey_id']) && $p['copy_from_survey_id'] !== ''
            ? (int)$p['copy_from_survey_id']
            : null;
        if ($copyFromId !== null) {
            $srcChk = $pdo->prepare('SELECT survey_id FROM survey WHERE survey_id = :id LIMIT 1');
            $srcChk->execute([':id' => $copyFromId]);
            if (!$srcChk->fetch()) api_out(400, ['message' => 'The survey being copied does not exist']);
        }

        // The survey and its copied questions land together or not at all: a
        // survey that exists with half its questions is worse than one that
        // failed outright, because nothing about it looks wrong.
        $pdo->beginTransaction();
        $copiedQuestions = 0;
        try {
            $sql = 'INSERT INTO survey (semester_id, period, date, survey_title, status) VALUES (:semester_id, :period, :date, :survey_title, :status)';
            $stmt = $pdo->prepare($sql);
            $stmt->execute([
                ':semester_id' => $semesterId,
                ':period' => $period,
                ':date' => trim((string)$p['date']),
                ':survey_title' => trim((string)$p['survey_title']),
                ':status' => $statusId,
            ]);

            $newId = (int)$pdo->lastInsertId();

            if ($copyFromId !== null) {
                $copiedQuestions = survey_copy_questions($pdo, $copyFromId, $newId);
            }

            $pdo->commit();
        } catch (Throwable $copyError) {
            if ($pdo->inTransaction()) $pdo->rollBack();
            throw $copyError;
        }
        $sel = $pdo->prepare('SELECT sv.survey_id, sv.semester_id, sv.period, sem.semester_name, sv.date, sv.survey_title, sv.status, st.status_name, st.status_type
                              FROM survey sv
                              LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
                              LEFT JOIN status st ON st.status_id = sv.status
                              WHERE sv.survey_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);
        if ($row) {
            api_notifications_try_create($pdo, [
                'event_key' => 'survey_created',
                'level' => 'success',
                'title' => 'New survey created',
                'message' => 'A new survey "' . (string)($row['survey_title'] ?? ('Survey #' . $newId)) . '" is now available.',
                'module_key' => 'survey',
                'entity_type' => 'survey',
                'entity_id' => $newId,
                'actor_user_id' => (int)($actor['user_id'] ?? 0),
                'toast' => true,
                'target' => [
                    'view' => 'survey',
                ],
                'metadata' => [
                    'survey_id' => $newId,
                    'survey_title' => $row['survey_title'] ?? null,
                    'semester_id' => isset($row['semester_id']) ? (int)$row['semester_id'] : null,
                ],
                'recipients' => [
                    'module_targets' => [
                        ['module' => 'survey', 'action' => 'view'],
                    ],
                ],
            ], [
                'endpoint' => 'survey.php',
                'event_key' => 'survey_created',
                'survey_id' => $newId,
            ]);
        }

        /*
         * Audited as well as announced. The notification tells people a survey
         * appeared; the audit log is what answers "who made this, and when"
         * months later, once every notification about it has been dismissed.
         */
        api_write_audit_log($pdo, $actor, 'survey_created',
            'Created the survey "' . (string)($row['survey_title'] ?? ('#' . $newId)) . '".', [
                'survey_id' => $newId,
                'survey_title' => $row['survey_title'] ?? null,
                'semester_id' => isset($row['semester_id']) ? (int)$row['semester_id'] : null,
                'period' => $row['period'] ?? null,
                'copied_questions' => $copiedQuestions,
            ]);

        api_out(201, [
            'message' => $copiedQuestions > 0
                ? 'Survey created with ' . $copiedQuestions . ' copied question' . ($copiedQuestions === 1 ? '' : 's')
                : 'Survey created',
            'data' => $row,
            'copied_questions' => $copiedQuestions,
        ]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;

        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) {
            $id = isset($p['survey_id']) ? (int)$p['survey_id'] : 0;
        }
        if ($id <= 0) api_out(400, ['message' => 'Valid survey id is required']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        // The same refusal POST makes. Update had none, so anything create
        // turned away could be PUT onto the row a moment later. 'prose' for both,
        // as on create: a survey title and its description are written for a
        // student to read, not identifiers.
        $unsafe = api_reject_unsafe_fields($p, [
            'survey_title' => 'Survey title',
            'description' => 'Description',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $chk = $pdo->prepare('SELECT * FROM survey WHERE survey_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Survey not found']);

        $fields = [];
        $params = [':id' => $id];
        $editable = ['semester_id', 'period', 'date', 'survey_title', 'status'];

        foreach ($editable as $col) {
            if (array_key_exists($col, $p)) {
                $fields[] = "$col = :$col";
                if ($col === 'semester_id') {
                    if ($p[$col] === null || $p[$col] === '') {
                        $params[":$col"] = null;
                    } else {
                        $semesterId = (int)$p[$col];
                        if ($semesterId <= 0) api_out(400, ['message' => 'Valid semester_id is required']);
                        $semChk = $pdo->prepare('SELECT semester_id FROM semester WHERE semester_id = :id LIMIT 1');
                        $semChk->execute([':id' => $semesterId]);
                        if (!$semChk->fetch()) api_out(400, ['message' => 'Selected semester does not exist']);
                        $params[":$col"] = $semesterId;
                    }
                } elseif ($col === 'status') {
                    if ($p[$col] === null || $p[$col] === '') {
                        $params[":$col"] = null;
                    } else {
                        $statusId = (int)$p[$col];
                        if ($statusId <= 0) api_out(400, ['message' => 'Valid status is required']);
                        $stChk = $pdo->prepare('SELECT status_id FROM status WHERE status_id = :id AND status_type = :type LIMIT 1');
                        $stChk->execute([':id' => $statusId, ':type' => 'account']);
                        if (!$stChk->fetch()) api_out(400, ['message' => 'status must be Active or Inactive']);
                        $params[":$col"] = $statusId;
                    }
                } elseif ($col === 'period') {
                    // Blank clears it back to a whole-semester survey, which is
                    // a legal state rather than a missing value - so unlike the
                    // create path this accepts null as an edit, not just as an
                    // absence.
                    $normalized = api_normalize_period($p[$col]);
                    if ($normalized === false) {
                        api_out(400, ['message' => 'period must be 1, 2 or 3, or left blank for a whole-semester survey']);
                    }
                    $params[":$col"] = $normalized;
                } elseif ($col === 'survey_title') {
                    $title = trim((string)($p[$col] ?? ''));
                    if ($title === '') api_out(400, ['message' => 'survey_title cannot be empty']);
                    $lengthError = survey_text_length_error('survey_title', $title);
                    if ($lengthError !== null) api_out(400, ['message' => $lengthError]);
                    // Checked for duplicates after the loop, with the semester
                    // and date this edit leaves the row with.
                    $params[":$col"] = $title;
                } elseif ($col === 'date') {
                    // Unlike `period`, a blank is not a legal state to edit
                    // into: the survey lists sort on this and print it in a
                    // column. Sending the key at all means changing it, so the
                    // value has to be a date. Not sending it leaves it alone.
                    $dateError = api_calendar_date_error((string)($p[$col] ?? ''), 'Survey date');
                    if ($dateError !== null) api_out(400, ['message' => $dateError]);
                    $params[":$col"] = trim((string)$p[$col]);
                } else {
                    $params[":$col"] = ($p[$col] !== null && $p[$col] !== '') ? $p[$col] : null;
                }
            }
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        /*
         * Title, semester and year together decide a duplicate, so moving a
         * survey to another semester or date can collide as surely as renaming
         * it. Whatever this edit did not send keeps the row's current value.
         *
         * Only when that combination actually changes. Sending a survey's own
         * title back (in any case, as utf8mb4_general_ci compares), or saving
         * its status alone, is not introducing a duplicate, and a row that
         * already shares its term with another - two with no semester, which
         * the index cannot see - must stay editable, or the rename that would
         * fix it is refused by the thing it is fixing.
         */
        $currentTitle = trim((string)($existing['survey_title'] ?? ''));
        $currentSemester = $existing['semester_id'] !== null ? (int)$existing['semester_id'] : null;
        $currentYear = survey_date_year($existing['date'] ?? null);
        $nextTitle = array_key_exists(':survey_title', $params) ? (string)$params[':survey_title'] : $currentTitle;
        $nextSemester = array_key_exists(':semester_id', $params) ? $params[':semester_id'] : $currentSemester;
        $nextYear = array_key_exists(':date', $params) ? survey_date_year($params[':date']) : $currentYear;
        if (strcasecmp($nextTitle, $currentTitle) !== 0 || $nextSemester !== $currentSemester || $nextYear !== $currentYear) {
            $duplicateError = survey_duplicate_title_error($pdo, $nextTitle, $nextSemester, $nextYear, $id);
            if ($duplicateError !== null) api_out(409, ['message' => $duplicateError]);
        }

        $sql = 'UPDATE survey SET ' . implode(', ', $fields) . ' WHERE survey_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare('SELECT sv.survey_id, sv.semester_id, sv.period, sem.semester_name, sv.date, sv.survey_title, sv.status, st.status_name, st.status_type
                              FROM survey sv
                              LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
                              LEFT JOIN status st ON st.status_id = sv.status
                              WHERE sv.survey_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        /*
         * The columns this request touched, not a diff of the whole row.
         *
         * $fields is built from exactly the keys the caller sent, so it is the
         * honest record of what changed -- dumping every column would bury one
         * edited title under a dozen untouched ones.
         */
        api_write_audit_log($pdo, $actor, 'survey_updated',
            'Updated the survey "' . (string)($row['survey_title'] ?? ('#' . $id)) . '".', [
                'survey_id' => $id,
                'survey_title' => $row['survey_title'] ?? null,
                'changed_columns' => array_values(array_map(
                    static fn(string $field): string => trim(explode('=', $field)[0]),
                    $fields
                )),
            ]);

        api_out(200, ['message' => 'Survey updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid survey id is required']);

        /*
         * Read the title before deleting it.
         *
         * Afterwards there is nothing left to name the row, and an audit entry
         * reading 'Deleted survey #7' is close to useless -- the whole reason
         * to log a deletion is that the record it describes is gone.
         */
        $doomed = $pdo->prepare('SELECT survey_title, semester_id, period FROM survey WHERE survey_id = :id LIMIT 1');
        $doomed->execute([':id' => $id]);
        $doomedRow = $doomed->fetch(PDO::FETCH_ASSOC) ?: [];

        $del = $pdo->prepare('DELETE FROM survey WHERE survey_id = :id');
        $del->execute([':id' => $id]);

        api_write_audit_log($pdo, $actor, 'survey_deleted',
            'Deleted the survey "' . (string)($doomedRow['survey_title'] ?? ('#' . $id)) . '".', [
                'survey_id' => $id,
                'survey_title' => $doomedRow['survey_title'] ?? null,
                'semester_id' => isset($doomedRow['semester_id']) ? (int)$doomedRow['semester_id'] : null,
                'period' => $doomedRow['period'] ?? null,
                'rows_deleted' => $del->rowCount(),
            ]);

        api_out(200, ['message' => 'Survey deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    // Two saves raced past survey_duplicate_title_error(); uq_survey_title_term
    // refused the second.
    if (survey_is_duplicate_key($e)) {
        api_out(409, ['message' => 'A survey with that title already exists for that semester and year. Give this one a different name, or another semester or year.']);
    }
    api_out(500, ['message' => 'Server error']);
}
