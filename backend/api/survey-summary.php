<?php

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';


try {
    if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
        api_out(405, ['message' => 'Method not allowed']);
    }

    $db = new Database();
    $pdo = $db->connect();

    /*
     * ---- department scope ---------------------------------------------------
     *
     * Same rule as attendance-summary.php, grades.php and finance-summary.php:
     * a dean reads their own department and no other, whatever the query string
     * claims; admin and SSG see all.
     *
     * This endpoint went without the rule while it was read-only on screen. It
     * stopped being defensible the moment the answers became exportable: each
     * row carries a student number, a student name and a free-text answer about
     * why that student is thinking of leaving. A dean pulling "every answer"
     * would have downloaded named, personal responses for the whole college in
     * one file.
     *
     * deanScope.test.js is what caught it — it derives its endpoint list from
     * EXPORT_SOURCES, so adding the survey export brought this file under the
     * same checks automatically.
     */
    $authUser = api_get_session_user();
    $seesAllDepartments = api_session_user_has_role($authUser, ['admin', 'ssg']);
    $isDepartmentPinned = api_user_is_department_pinned($authUser);

    $departmentId = isset($_GET['department_id']) && $_GET['department_id'] !== ''
        ? (int)$_GET['department_id']
        : null;

    /*
     * Is $departmentId this account's OWN department, or one it asked for?
     *
     * Only the first widens across campuses. A dean is appointed to the
     * department and must see all of it; an admin who picks one row out of the
     * chooser means that row, and silently widening their filter would take
     * away the only way to look at a single campus.
     */
    $departmentScopeIsOwn = false;

    if ($isDepartmentPinned && !$seesAllDepartments) {
        $departmentId = (int)($authUser['department_id'] ?? 0);
        if ($departmentId <= 0) {
            // Falling through with 0 would read as "no filter", which is the
            // worst possible interpretation of an unlinked account.
            api_out(400, ['message' => 'This account is not linked to a department']);
        }
        $departmentScopeIsOwn = true;
    }

    /*
     * ---- what the four headline totals count ---------------------------------
     *
     * They were four unfiltered COUNT(*)s: every survey ever written, every
     * question on any of them, every submission and every answer. On a dashboard
     * whose matrix beside them is scoped to one term, four lifetime totals read
     * as though they described that term - so picking First Semester moved the
     * grid and left the cards saying the same thing.
     *
     * Two rules now apply to all four:
     *
     *   the term      a survey carries a semester_id, so a semester narrows the
     *                 surveys and everything hanging off them
     *   active only   an inactive survey is one the office has taken down, and
     *                 its questions and submissions come down with it. The
     *                 inactive count is still reported separately, so nothing is
     *                 hidden - it just stops being counted as live.
     *
     * School year is deliberately NOT applied to surveys or questions: `survey`
     * has semester_id and no school_year_id, so there is nothing to filter on
     * and pretending otherwise would silently ignore the parameter. It IS
     * applied to submissions and answers, which reach a school year through the
     * student who made them. See `term_note` in the payload, which says so on
     * screen rather than leaving the reader to infer it.
     */
    $semesterId = isset($_GET['semester_id']) && $_GET['semester_id'] !== ''
        ? (int)$_GET['semester_id']
        : null;
    $schoolYearId = isset($_GET['school_year_id']) && $_GET['school_year_id'] !== ''
        ? (int)$_GET['school_year_id']
        : null;
    $includeInactive = isset($_GET['include_inactive'])
        && in_array(strtolower(trim((string)$_GET['include_inactive'])), ['1', 'true', 'yes'], true);

    // The survey-side clause, shared by all four totals.
    $surveyWhere = [];
    $surveyParams = [];
    if ($semesterId !== null && $semesterId > 0) {
        $surveyWhere[] = 'sv.semester_id = :totals_semester_id';
        $surveyParams[':totals_semester_id'] = $semesterId;
    }
    if (!$includeInactive) {
        $surveyWhere[] = "LOWER(COALESCE(st.status_name, '')) <> 'inactive'";
    }
    $surveyWhereSql = $surveyWhere ? ('WHERE ' . implode(' AND ', $surveyWhere)) : '';

    // The student-side clause, for the two totals that reach one.
    $studentWhere = [];
    $studentParams = [];
    if ($schoolYearId !== null && $schoolYearId > 0) {
        $studentWhere[] = 'totals_student.schoolyear_id = :totals_school_year_id';
        $studentParams[':totals_school_year_id'] = $schoolYearId;
    }
    if ($departmentId !== null && $departmentId > 0) {
        $studentWhere[] = 'totals_course.department_id = :totals_department_id';
        $studentParams[':totals_department_id'] = $departmentId;
    }
    /*
     * LEFT, not INNER, when nothing is being filtered on the student.
     *
     * An unfiltered count must include a submission whose student row is gone;
     * a departmental or per-year count must not, because such a submission
     * cannot be attributed to either. The join type follows the filter.
     */
    $studentJoinType = $studentWhere ? 'JOIN' : 'LEFT JOIN';
    $studentJoinSql = "
        $studentJoinType student totals_student ON totals_student.student_id = ss.student_id
        $studentJoinType course  totals_course  ON totals_course.course_id   = totals_student.course_id";
    $studentWhereSql = $studentWhere ? (' AND ' . implode(' AND ', $studentWhere)) : '';

    $scalar = static function (string $sql, array $params) use ($pdo): int {
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return (int)$stmt->fetchColumn();
    };

    $totalsStmt = $pdo->prepare(
        "SELECT
            COUNT(*) AS total_surveys,
            SUM(CASE WHEN LOWER(COALESCE(st.status_name, '')) = 'active' THEN 1 ELSE 0 END) AS active_surveys,
            SUM(CASE WHEN LOWER(COALESCE(st.status_name, '')) = 'inactive' THEN 1 ELSE 0 END) AS inactive_surveys
         FROM survey sv
         LEFT JOIN status st ON st.status_id = sv.status
         $surveyWhereSql"
    );
    $totalsStmt->execute($surveyParams);
    $totals = $totalsStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    // Counted separately and without the active filter, so the card can say
    // "3 inactive not counted" rather than leaving a drop unexplained.
    $inactiveStmt = $pdo->prepare(
        "SELECT COUNT(*) FROM survey sv
         LEFT JOIN status st ON st.status_id = sv.status
         WHERE LOWER(COALESCE(st.status_name, '')) = 'inactive'"
        . ($semesterId !== null && $semesterId > 0 ? ' AND sv.semester_id = :totals_semester_id' : '')
    );
    $inactiveStmt->execute(
        $semesterId !== null && $semesterId > 0 ? [':totals_semester_id' => $semesterId] : []
    );
    $inactiveExcluded = (int)$inactiveStmt->fetchColumn();

    $totalQuestions = $scalar(
        "SELECT COUNT(*)
           FROM survey_question q
           JOIN survey sv ON sv.survey_id = q.survey_id
      LEFT JOIN status st ON st.status_id = sv.status
           $surveyWhereSql",
        $surveyParams
    );

    $totalSubmissions = $scalar(
        "SELECT COUNT(*)
           FROM survey_submission ss
           JOIN survey sv ON sv.survey_id = ss.survey_id AND ss.archived_at IS NULL
      LEFT JOIN status st ON st.status_id = sv.status
           $studentJoinSql
           " . ($surveyWhereSql !== '' ? $surveyWhereSql : 'WHERE 1=1') . $studentWhereSql,
        array_merge($surveyParams, $studentParams)
    );

    $totalResponses = $scalar(
        "SELECT COUNT(*)
           FROM survey_answer sa
           JOIN survey_submission ss ON ss.submission_id = sa.submission_id AND ss.archived_at IS NULL
           JOIN survey sv ON sv.survey_id = ss.survey_id
      LEFT JOIN status st ON st.status_id = sv.status
           $studentJoinSql
           " . ($surveyWhereSql !== '' ? $surveyWhereSql : 'WHERE 1=1') . $studentWhereSql,
        array_merge($surveyParams, $studentParams)
    );

    $surveySql = "
        SELECT
            sv.survey_id,
            sv.survey_title,
            sv.date,
            sem.semester_name,
            COALESCE(st.status_name, 'Unknown') AS status_name,
            COALESCE(q.question_count, 0) AS question_count,
            COALESCE(sub.submission_count, 0) AS submission_count,
            COALESCE(resp.response_count, 0) AS response_count,
            sub.latest_submission_at
        FROM survey sv
        LEFT JOIN semester sem ON sem.semester_id = sv.semester_id
        LEFT JOIN status st ON st.status_id = sv.status
        LEFT JOIN (
            SELECT survey_id, COUNT(*) AS question_count
            FROM survey_question
            GROUP BY survey_id
        ) q ON q.survey_id = sv.survey_id
        LEFT JOIN (
            SELECT survey_id, COUNT(*) AS submission_count, MAX(submitted_at) AS latest_submission_at
            FROM survey_submission
            WHERE archived_at IS NULL
            GROUP BY survey_id
        ) sub ON sub.survey_id = sv.survey_id
        LEFT JOIN (
            SELECT ss.survey_id, COUNT(sa.answer_id) AS response_count
            FROM survey_submission ss
            LEFT JOIN survey_answer sa ON sa.submission_id = ss.submission_id
            WHERE ss.archived_at IS NULL
            GROUP BY ss.survey_id
        ) resp ON resp.survey_id = sv.survey_id
        ORDER BY COALESCE(resp.response_count, 0) DESC, COALESCE(sub.submission_count, 0) DESC, sv.survey_id DESC
    ";
    $surveyStmt = $pdo->query($surveySql);
    $bySurvey = $surveyStmt ? $surveyStmt->fetchAll(PDO::FETCH_ASSOC) : [];
    $bySurvey = array_map(function ($row) {
        $submissionCount = (int)($row['submission_count'] ?? 0);
        $responseCount = (int)($row['response_count'] ?? 0);
        return [
            'survey_id' => (int)($row['survey_id'] ?? 0),
            'survey_title' => $row['survey_title'] ?? '',
            'date' => $row['date'] ?? null,
            'semester_name' => $row['semester_name'] ?? null,
            'status_name' => $row['status_name'] ?? 'Unknown',
            'question_count' => (int)($row['question_count'] ?? 0),
            'submission_count' => $submissionCount,
            'response_count' => $responseCount,
            'latest_submission_at' => $row['latest_submission_at'] ?? null,
            'average_responses_per_submission' => $submissionCount > 0 ? round($responseCount / $submissionCount, 2) : 0,
        ];
    }, $bySurvey);

    // ------------------------------------------------------------------------
    // Answer drill-down.
    //
    // The report used to stop at counts — how many surveys, questions and
    // responses existed — and never showed a single answer. The numbers said a
    // survey had 400 results without saying what any of them were.
    //
    // These filters are all optional; with none supplied the behaviour below is
    // the same shape as before plus the unfiltered breakdown.
    // ------------------------------------------------------------------------
    $surveyId     = isset($_GET['survey_id']) && $_GET['survey_id'] !== '' ? (int)$_GET['survey_id'] : null;
    $questionId   = isset($_GET['question_id']) && $_GET['question_id'] !== '' ? (int)$_GET['question_id'] : null;
    $questionType = isset($_GET['question_type']) ? trim((string)$_GET['question_type']) : '';
    $search       = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
    $page         = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
    $pageSize     = isset($_GET['page_size']) ? (int)$_GET['page_size'] : 50;
    $pageSize     = max(10, min(200, $pageSize));

    $allowedTypes = ['text', 'radio', 'checkbox', 'rating'];
    if ($questionType !== '' && !in_array($questionType, $allowedTypes, true)) {
        api_out(400, ['message' => 'question_type must be one of: ' . implode(', ', $allowedTypes)]);
    }

    /*
     * Named `$params` rather than `$answerParams` to match the three other
     * scoped endpoints. They all implement the same department rule, and
     * deanScope.test.js checks that the pinned variable is the one actually
     * bound into the query — a check that only works if the four files agree on
     * what to call things.
     */
    $answerWhere = [];
    $params = [];
    if ($surveyId !== null)   { $answerWhere[] = 'sv.survey_id = :survey_id';       $params[':survey_id'] = $surveyId; }
    if ($questionId !== null) { $answerWhere[] = 'q.question_id = :question_id';    $params[':question_id'] = $questionId; }
    if ($questionType !== '') { $answerWhere[] = 'q.question_type = :question_type';$params[':question_type'] = $questionType; }
    if ($search !== '') {
        // Search the resolved label, so typing "Yes" finds both storage shapes.
        $answerWhere[] = '(COALESCE(o.option_text, sa.answer) LIKE :search OR q.question_text LIKE :search)';
        $params[':search'] = '%' . $search . '%';
    }

    /*
     * The department filter reaches an answer through its submission's student
     * and that student's course. `scope_student` is an INNER join deliberately:
     * a submission with no linked student cannot be attributed to a department,
     * so it must fall outside a departmental view rather than leak into every
     * one of them.
     */
    $scopeJoinSql = '';
    if ($departmentId !== null && $departmentId > 0) {
        $scopeJoinSql = '
        JOIN student  scope_student ON scope_student.student_id = ss.student_id
        JOIN course   scope_course  ON scope_course.course_id   = scope_student.course_id';
        $answerWhere[] = api_department_filter_sql('scope_course.department_id', $departmentScopeIsOwn);
        $params[':department_id'] = $departmentId;
    }

    $answerWhereSql = $answerWhere ? ('WHERE ' . implode(' AND ', $answerWhere)) : '';

    /*
     * COALESCE(o.option_text, sa.answer) is doing real work here.
     *
     * Choice answers are stored two different ways in this database: seeded
     * rows set option_id and leave answer NULL, while rows written by the
     * current app store the option's text and leave option_id NULL. Counting
     * either column alone splits one option into two buckets and undercounts
     * both. Resolving to the label first merges them.
     */
    $answerValueExpr = "TRIM(COALESCE(o.option_text, sa.answer, ''))";

    $breakdownSql = "
        SELECT
            q.question_id,
            q.question_text,
            q.question_type,
            sv.survey_id,
            sv.survey_title,
            $answerValueExpr AS answer_value,
            COUNT(*) AS answer_count
        FROM survey_answer sa
        JOIN survey_submission ss ON ss.submission_id = sa.submission_id AND ss.archived_at IS NULL
        JOIN survey sv            ON sv.survey_id     = ss.survey_id
        JOIN survey_question q    ON q.question_id    = sa.question_id
        LEFT JOIN survey_question_option o ON o.option_id = sa.option_id
        $scopeJoinSql
        $answerWhereSql
        GROUP BY q.question_id, q.question_text, q.question_type, sv.survey_id, sv.survey_title, answer_value
        ORDER BY q.question_id, answer_count DESC, answer_value
    ";
    $breakdownStmt = $pdo->prepare($breakdownSql);
    $breakdownStmt->execute($params);

    $questionBreakdown = [];
    foreach ($breakdownStmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $qid = (int)$row['question_id'];
        if (!isset($questionBreakdown[$qid])) {
            $questionBreakdown[$qid] = [
                'question_id'   => $qid,
                'question_text' => $row['question_text'] ?? '',
                'question_type' => $row['question_type'] ?? 'text',
                'survey_id'     => (int)($row['survey_id'] ?? 0),
                'survey_title'  => $row['survey_title'] ?? '',
                'answer_count'  => 0,
                'values'        => [],
            ];
        }
        $count = (int)$row['answer_count'];
        $questionBreakdown[$qid]['answer_count'] += $count;
        $questionBreakdown[$qid]['values'][] = [
            'label' => ($row['answer_value'] ?? '') === '' ? '(blank)' : $row['answer_value'],
            'count' => $count,
        ];
    }

    // Percentages need the question's own total, so they are filled in after
    // every row for that question has been folded in.
    $questionBreakdown = array_values(array_map(function (array $question): array {
        $total = max(1, (int)$question['answer_count']);
        // Free text can have hundreds of distinct answers; the long tail is
        // noise in a summary, so cap it and report what was left out.
        $allValues = $question['values'];
        $question['distinct_values'] = count($allValues);
        $question['values'] = array_map(function (array $value) use ($total): array {
            $value['percent'] = round($value['count'] / $total * 100, 1);
            return $value;
        }, array_slice($allValues, 0, 12));
        return $question;
    }, $questionBreakdown));

    $countSql = "
        SELECT COUNT(*)
        FROM survey_answer sa
        JOIN survey_submission ss ON ss.submission_id = sa.submission_id AND ss.archived_at IS NULL
        JOIN survey sv            ON sv.survey_id     = ss.survey_id
        JOIN survey_question q    ON q.question_id    = sa.question_id
        LEFT JOIN survey_question_option o ON o.option_id = sa.option_id
        $scopeJoinSql
        $answerWhereSql
    ";
    $countStmt = $pdo->prepare($countSql);
    $countStmt->execute($params);
    $answersTotal = (int)$countStmt->fetchColumn();

    $offset = ($page - 1) * $pageSize;
    $answersSql = "
        SELECT
            sa.answer_id,
            sa.submission_id,
            ss.submitted_at,
            st.student_id,
            st.student_number,
            TRIM(CONCAT(COALESCE(st.first_name, ''), ' ', COALESCE(st.last_name, ''))) AS student_name,
            -- Carried for the export's identity columns. The other three report
            -- exports all name the student's course, and a survey matrix handed
            -- to a dean is unreadable without it. LEFT, because an answer whose
            -- student record is gone must still export rather than disappear.
            sc.course_code,
            st.year_level,
            sv.survey_id,
            sv.survey_title,
            q.question_id,
            q.question_text,
            q.question_type,
            $answerValueExpr AS answer_value
        FROM survey_answer sa
        JOIN survey_submission ss ON ss.submission_id = sa.submission_id AND ss.archived_at IS NULL
        JOIN survey sv            ON sv.survey_id     = ss.survey_id
        JOIN survey_question q    ON q.question_id    = sa.question_id
        LEFT JOIN survey_question_option o ON o.option_id = sa.option_id
        LEFT JOIN student st      ON st.student_id    = ss.student_id
        LEFT JOIN course sc       ON sc.course_id     = st.course_id
        $scopeJoinSql
        $answerWhereSql
        ORDER BY ss.submitted_at DESC, sa.answer_id DESC
        LIMIT :limit OFFSET :offset
    ";
    $answersStmt = $pdo->prepare($answersSql);
    foreach ($params as $key => $value) {
        $answersStmt->bindValue($key, $value);
    }
    $answersStmt->bindValue(':limit', $pageSize, PDO::PARAM_INT);
    $answersStmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $answersStmt->execute();

    $answers = array_map(function (array $row): array {
        $value = trim((string)($row['answer_value'] ?? ''));
        return [
            'answer_id'     => (int)$row['answer_id'],
            'submission_id' => (int)$row['submission_id'],
            'submitted_at'  => $row['submitted_at'] ?? null,
            'student_id'    => isset($row['student_id']) ? (int)$row['student_id'] : null,
            'student_number'=> $row['student_number'] ?? null,
            'student_name'  => trim((string)($row['student_name'] ?? '')) ?: null,
            'course_code'   => $row['course_code'] ?? null,
            'year_level'    => isset($row['year_level']) ? (int)$row['year_level'] : null,
            'survey_id'     => (int)$row['survey_id'],
            'survey_title'  => $row['survey_title'] ?? '',
            'question_id'   => (int)$row['question_id'],
            'question_text' => $row['question_text'] ?? '',
            'question_type' => $row['question_type'] ?? 'text',
            'answer_value'  => $value === '' ? null : $value,
        ];
    }, $answersStmt->fetchAll(PDO::FETCH_ASSOC) ?: []);

    // Dropdown sources. Questions carry survey_id so the question list can be
    // narrowed client-side when a survey is picked, without another round trip.
    $filterSurveys = $pdo->query(
        'SELECT survey_id, COALESCE(survey_title, CONCAT("Survey #", survey_id)) AS survey_title
           FROM survey ORDER BY survey_id DESC'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $filterQuestions = $pdo->query(
        'SELECT question_id, survey_id, question_text, question_type
           FROM survey_question ORDER BY survey_id DESC, COALESCE(sort_order, 9999), question_id'
    )->fetchAll(PDO::FETCH_ASSOC) ?: [];

    api_out(200, ['data' => [
        'total_surveys' => (int)($totals['total_surveys'] ?? 0),
        'active_surveys' => (int)($totals['active_surveys'] ?? 0),
        'inactive_surveys' => (int)($totals['inactive_surveys'] ?? 0),
        'total_questions' => $totalQuestions,
        'total_submissions' => $totalSubmissions,
        'total_responses' => $totalResponses,
        // What the four totals above were counted under, so the cards can say
        // it rather than leaving the reader to guess why a number moved.
        'totals_scope' => [
            'semester_id' => $semesterId,
            'school_year_id' => $schoolYearId,
            'department_id' => $departmentId,
            'include_inactive' => $includeInactive,
            'inactive_surveys_excluded' => $includeInactive ? 0 : $inactiveExcluded,
            'term_note' => $schoolYearId !== null && $schoolYearId > 0
                ? 'A survey is filed against a semester, not a school year, so the school year narrows submissions and responses only.'
                : null,
        ],
        'average_responses_per_submission' => $totalSubmissions > 0 ? round($totalResponses / $totalSubmissions, 2) : 0,
        'by_survey' => $bySurvey,
        'filters' => [
            'surveys' => array_map(static function (array $row): array {
                return ['survey_id' => (int)$row['survey_id'], 'survey_title' => $row['survey_title']];
            }, $filterSurveys),
            'questions' => array_map(static function (array $row): array {
                return [
                    'question_id'   => (int)$row['question_id'],
                    'survey_id'     => (int)$row['survey_id'],
                    'question_text' => $row['question_text'] ?? '',
                    'question_type' => $row['question_type'] ?? 'text',
                ];
            }, $filterQuestions),
            'question_types' => $allowedTypes,
        ],
        'applied_filters' => [
            'survey_id'     => $surveyId,
            'question_id'   => $questionId,
            'question_type' => $questionType !== '' ? $questionType : null,
            'search'        => $search !== '' ? $search : null,
        ],
        'question_breakdown' => $questionBreakdown,
        'answers' => $answers,
        'answers_total' => $answersTotal,
        'page' => $page,
        'page_size' => $pageSize,
    ]]);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
