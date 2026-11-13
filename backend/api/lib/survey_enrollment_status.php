<?php
/**
 * Turning a survey answer into an enrolment standing.
 *
 * Extracted from survey_submission.php when the Student Migration board gained
 * an editable "Enrollment Decision" column: staff recording a decision on a
 * student's behalf goes through survey_response.php, and both endpoints have to
 * reach the same conclusion from the same answer. A second copy would have been
 * a second set of rules.
 *
 * The mapping itself lives in data, not here - survey_question_option carries an
 * enrollment_status_id, and an option without one implies nothing.
 */

// A closed semester's standings are read-only. See lib/term_closure.php.
require_once __DIR__ . '/term_closure.php';

/**
 * Re-derive and apply the standing for a submission whose answers just changed.
 *
 * The submission itself supplies the survey, the student and the date, so a
 * caller that edited a single answer does not have to carry them. Used by
 * survey_response.php, where staff record a decision on a student's behalf and
 * the standing has to follow exactly as it would from the student's own
 * submission.
 *
 * Returns null when the submission is gone or nothing is implied.
 *
 * $term, when given, is the term to file the standing under - see
 * apply_survey_enrollment_status().
 */
function apply_survey_enrollment_status_for_submission(PDO $pdo, int $submissionId, ?array $term = null, ?int $decisionQuestionId = null): ?array
{
    $stmt = $pdo->prepare(
        'SELECT survey_id, student_id, submitted_at
           FROM survey_submission WHERE submission_id = :id LIMIT 1'
    );
    $stmt->execute([':id' => $submissionId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row) return null;

    $submittedAt = trim((string)($row['submitted_at'] ?? ''));
    if ($submittedAt === '') $submittedAt = date('Y-m-d H:i:s');

    return apply_survey_enrollment_status(
        $pdo,
        $submissionId,
        (int)$row['survey_id'],
        (int)$row['student_id'],
        $submittedAt,
        $term,
        $decisionQuestionId
    );
}

function survey_option_supports_enrollment_status(PDO $pdo): bool {
    static $supports = null;
    if ($supports !== null) return $supports;
    $supports = in_array('enrollment_status_id', api_table_columns($pdo, 'survey_question_option'), true);
    return $supports;
}

/**
 * Find the enrollment status a submission's answers imply, if any.
 *
 * Returns null whenever nothing is implied - no tagged option was chosen, or
 * the survey has no mapping at all - which is the ordinary case for every
 * survey that is not the enrolment-intent one.
 *
 * Two wrinkles this has to absorb, both properties of how answers are stored:
 *
 *  - A radio answer exists in two shapes. Seeded rows set `option_id` and leave
 *    `answer` NULL; rows written by the app set `answer` text and leave
 *    `option_id` NULL. Both are resolved here, which is also why the risk
 *    model calls this function rather than reading answers itself: the
 *    survey signal is now "did they say they will enroll", and that is the
 *    same question this resolver already answers.
 *  - A checkbox answer is stored as its chosen labels joined with ", ", so no
 *    single option_text can match the whole string. The full text is tried
 *    first, then each comma-separated fragment. An option label that itself
 *    contains a comma is genuinely ambiguous under this storage format; the
 *    whole-string attempt is what rescues it.
 *
 * When several tagged options are chosen, the question with the lowest
 * sort_order wins and the rest are ignored, so the outcome does not depend on
 * row order. Tagging more than one question is not the intended use.
 */
function resolve_submission_enrollment_status(PDO $pdo, int $submissionId, int $surveyId, ?int $decisionQuestionId = null): ?array {
    if (!survey_option_supports_enrollment_status($pdo)) return null;

    $map = survey_enrollment_option_map($pdo, $surveyId);
    if ($map === null) return null;

    $ansStmt = $pdo->prepare(
        'SELECT a.question_id, a.option_id, a.answer
           FROM survey_answer a
           JOIN survey_question q ON q.question_id = a.question_id
          WHERE a.submission_id = :submission_id
       ORDER BY COALESCE(q.sort_order, 2147483647) ASC, q.question_id ASC, a.answer_id ASC'
    );
    $ansStmt->execute([':submission_id' => $submissionId]);

    $answers = $ansStmt->fetchAll(PDO::FETCH_ASSOC);
    if ($decisionQuestionId !== null) {
        $answers = array_values(array_filter($answers, static fn(array $answer): bool => (int)$answer['question_id'] === $decisionQuestionId));
    }
    return survey_enrollment_match_answers($map, $answers);
}

/**
 * The same answer for many submissions at once, keyed by submission id.
 *
 * For the assignment board, which shows the survey answer on every row: one
 * answers query for the whole page instead of one per student. The matching is
 * survey_enrollment_match_answers(), the function the single resolver above
 * uses, and the answers arrive in the same order - so a board row and the
 * status the submission wrote cannot disagree.
 *
 * @param array<int,int> $surveyBySubmission submission_id => survey_id
 * @return array<int,array> submission_id => the matched option row; submissions
 *                          that imply nothing are absent
 */
function resolve_submissions_enrollment_status(PDO $pdo, array $surveyBySubmission): array {
    if (empty($surveyBySubmission) || !survey_option_supports_enrollment_status($pdo)) return [];

    $ids = array_map('intval', array_keys($surveyBySubmission));
    $placeholders = implode(',', array_fill(0, count($ids), '?'));
    $ansStmt = $pdo->prepare(
        "SELECT a.submission_id, a.question_id, a.option_id, a.answer
           FROM survey_answer a
           JOIN survey_question q ON q.question_id = a.question_id
          WHERE a.submission_id IN ($placeholders)
       ORDER BY a.submission_id ASC, COALESCE(q.sort_order, 2147483647) ASC, q.question_id ASC, a.answer_id ASC"
    );
    $ansStmt->execute($ids);

    $answersBySubmission = [];
    foreach ($ansStmt->fetchAll(PDO::FETCH_ASSOC) as $answer) {
        $answersBySubmission[(int)$answer['submission_id']][] = $answer;
    }

    // Local rather than static: a page of submissions mostly shares one or two
    // surveys, and a cache that outlived this call could serve a mapping edited
    // later in the same request.
    $maps = [];
    $resolved = [];
    foreach ($surveyBySubmission as $submissionId => $surveyId) {
        $surveyId = (int)$surveyId;
        if (!array_key_exists($surveyId, $maps)) {
            $maps[$surveyId] = survey_enrollment_option_map($pdo, $surveyId);
        }
        $map = $maps[$surveyId];
        if ($map === null) continue;

        $match = survey_enrollment_match_answers($map, $answersBySubmission[(int)$submissionId] ?? []);
        if ($match !== null) {
            $resolved[(int)$submissionId] = $match;
        }
    }

    return $resolved;
}

/**
 * The options of one survey that carry an enrollment status, indexed two ways,
 * or null when the survey maps none.
 */
function survey_enrollment_option_map(PDO $pdo, int $surveyId): ?array {
    $optStmt = $pdo->prepare(
        'SELECT o.option_id, o.question_id, o.option_text, o.enrollment_status_id
           FROM survey_question_option o
           JOIN survey_question q ON q.question_id = o.question_id
          WHERE q.survey_id = :survey_id AND o.enrollment_status_id IS NOT NULL'
    );
    $optStmt->execute([':survey_id' => $surveyId]);
    $mapped = $optStmt->fetchAll(PDO::FETCH_ASSOC);
    if (empty($mapped)) return null;

    $byOptionId = [];
    $byQuestionText = [];
    foreach ($mapped as $row) {
        $optionId = (int)$row['option_id'];
        $questionId = (int)$row['question_id'];
        $byOptionId[$optionId] = $row;
        $byQuestionText[$questionId][mb_strtolower(trim((string)$row['option_text']))] = $row;
    }

    return ['by_option' => $byOptionId, 'by_question_text' => $byQuestionText];
}

/** The first answer, in question order, that selects a mapped option. */
function survey_enrollment_match_answers(array $map, array $answers): ?array {
    $byOptionId = $map['by_option'];
    $byQuestionText = $map['by_question_text'];

    foreach ($answers as $answer) {
        $answerOptionId = $answer['option_id'] !== null ? (int)$answer['option_id'] : 0;
        if ($answerOptionId > 0 && isset($byOptionId[$answerOptionId])) {
            return $byOptionId[$answerOptionId];
        }

        $questionId = (int)$answer['question_id'];
        if (empty($byQuestionText[$questionId])) continue;

        $text = trim((string)($answer['answer'] ?? ''));
        if ($text === '') continue;

        $candidates = array_merge([$text], array_map('trim', explode(',', $text)));
        foreach ($candidates as $candidate) {
            $key = mb_strtolower($candidate);
            if ($key !== '' && isset($byQuestionText[$questionId][$key])) {
                return $byQuestionText[$questionId][$key];
            }
        }
    }

    return null;
}

/**
 * The student's own words explaining the choice they just made.
 *
 * This is what lands in the "Update From The Student" column on the Student
 * Migration board, so it wants the explanation - "Still fixing financial
 * issues" - not the label already shown by the status badge next to it.
 *
 * Which questions count is decided structurally, not by matching their wording:
 * everything after the enrolment question is a follow-up to it, while the
 * questions before it collect contact details. So the search is simply "answered
 * text questions that sort after the one carrying the mapping". The form's own
 * Reason / Motivation field is a summary of the branch answers, so it is
 * preferred when present; otherwise the first branch the student actually filled
 * wins, which is the one their choice routed them to.
 *
 * Returns null when they explained nothing, leaving the caller to decide.
 */
function resolve_submission_remark(PDO $pdo, int $submissionId, int $decisionQuestionId): ?string
{
    $stmt = $pdo->prepare(
        'SELECT q.question_text, COALESCE(o.option_text, a.answer) AS value
           FROM survey_answer a
           JOIN survey_question q ON q.question_id = a.question_id
           LEFT JOIN survey_question_option o ON o.option_id = a.option_id
          WHERE a.submission_id = :submission_id
            AND q.question_type = :text_type
            AND COALESCE(q.sort_order, 2147483647) > (
                  SELECT COALESCE(dq.sort_order, 0) FROM survey_question dq
                   WHERE dq.question_id = :decision_question_id
                )
       ORDER BY COALESCE(q.sort_order, 2147483647) ASC, a.answer_id ASC'
    );
    $stmt->execute([
        ':submission_id' => $submissionId,
        ':text_type' => 'text',
        ':decision_question_id' => $decisionQuestionId,
    ]);

    $firstFilled = null;
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $value = trim((string)($row['value'] ?? ''));
        if ($value === '') continue;

        if (preg_match('/reason|motivation/i', (string)$row['question_text'])) {
            return $value;
        }
        if ($firstFilled === null) $firstFilled = $value;
    }

    return $firstFilled;
}

/**
 * Write the implied enrollment status onto the student's record for the term.
 *
 * The term is the survey's semester and the student's school year, because
 * those are the only two the submission itself can speak for - unless the
 * caller names one in $term (['school_year_id' => int, 'semester_id' => int]).
 * Staff recording a decision on the Student Migration board do: they are
 * looking at one term's standings, and filing the status anywhere else left
 * the status beside the decision unchanged, which read as the edit failing.
 * That happened whenever the board's term was not the student's own school
 * year, e.g. every 4th-year still on 2025-2026.
 *
 * If either half of the term is missing the write is skipped rather than
 * guessed: `enrollment_status` is
 * uniquely keyed on (student, school_year, semester) and MySQL lets NULLs
 * repeat inside a UNIQUE key, so a row with a NULL term would slip past the
 * constraint and quietly become the duplicate that key exists to prevent.
 *
 * An existing row for the term is overwritten, so the most recent submission
 * always wins. `decision` is deliberately left out of the update list - that
 * column is the Dean's approve/pending workflow, not the student's answer, and
 * resetting it would undo staff work on every resubmission.
 *
 * Returns a small summary for the response payload, or null when nothing was
 * written. Callers run this inside the submission transaction so a failure here
 * takes the submission with it rather than leaving a half-applied state.
 */
function apply_survey_enrollment_status(PDO $pdo, int $submissionId, int $surveyId, int $studentId, string $submittedAt, ?array $fileUnder = null, ?int $decisionQuestionId = null): ?array {
    $option = resolve_submission_enrollment_status($pdo, $submissionId, $surveyId, $decisionQuestionId);
    if (!$option) return null;

    $termStmt = $pdo->prepare(
        'SELECT sv.semester_id, st.schoolyear_id, sv.survey_title
           FROM survey sv
           CROSS JOIN student st
          WHERE sv.survey_id = :survey_id AND st.student_id = :student_id
          LIMIT 1'
    );
    $termStmt->execute([':survey_id' => $surveyId, ':student_id' => $studentId]);
    $term = $termStmt->fetch(PDO::FETCH_ASSOC);
    if (!$term) return null;

    if ($fileUnder !== null) {
        $term['semester_id'] = $fileUnder['semester_id'] ?? null;
        $term['schoolyear_id'] = $fileUnder['school_year_id'] ?? null;
    }
    $semesterId = $term['semester_id'] !== null ? (int)$term['semester_id'] : 0;
    $schoolYearId = $term['schoolyear_id'] !== null ? (int)$term['schoolyear_id'] : 0;
    if ($semesterId <= 0 || $schoolYearId <= 0) {
        return [
            'applied' => false,
            'reason' => 'The survey has no semester, or the student has no school year, so there is no term to file the status under.',
        ];
    }

    /*
     * A closed semester's standings are read-only, so nothing is written here.
     * What that means is the caller's to say, which is why the code travels
     * with the reason: a student's own submission is kept and only the standing
     * is skipped (survey_submission.php), while a staff edit made on their
     * behalf is refused whole (survey_response.php) - that answer is the closed
     * term's record too.
     */
    $closedTerm = term_closure_block($pdo, [$schoolYearId, $semesterId]);
    if ($closedTerm !== null) {
        return [
            'applied' => false,
            'reason' => $closedTerm['message'],
            'code' => TERM_CLOSURE_CODE,
            'term' => $closedTerm['term'],
        ];
    }

    $statusId = (int)$option['enrollment_status_id'];
    $optionText = (string)$option['option_text'];
    $surveyTitle = trim((string)($term['survey_title'] ?? ''));
    $note = 'Set from survey answer' . ($surveyTitle !== '' ? ' "' . $surveyTitle . '"' : '') . ': ' . $optionText;
    $date = substr($submittedAt, 0, 10);

    // The option text is only a stand-in for a student who explained nothing;
    // it repeats the status badge shown beside it and says nothing new.
    $remark = resolve_submission_remark($pdo, $submissionId, (int)$option['question_id']);
    $response = $remark !== null && $remark !== '' ? $remark : $optionText;

    $upsert = $pdo->prepare(
        'INSERT INTO enrollment_status
                (status_type, date, student_id, decision, response, semester_id, reason, school_year_id)
         VALUES (:status_type, :date, :student_id, :decision, :response, :semester_id, :reason, :school_year_id)
         ON DUPLICATE KEY UPDATE
                status_type = VALUES(status_type),
                date        = VALUES(date),
                response    = IF(:remark_given = 1,
                                 VALUES(response),
                                 COALESCE(NULLIF(TRIM(response), ""), VALUES(response))),
                reason      = VALUES(reason),
                archived_at = NULL'
    );
    $upsert->execute([
        ':status_type' => $statusId,
        ':date' => $date,
        ':student_id' => $studentId,
        ':decision' => 'Pending',
        ':response' => $response,
        ':semester_id' => $semesterId,
        ':reason' => $note,
        ':school_year_id' => $schoolYearId,
        // Without this guard a resubmission with the explanation left blank would
        // wipe a remark a coordinator had typed by hand and replace it with the
        // option label - losing the better of the two.
        ':remark_given' => $remark !== null && $remark !== '' ? 1 : 0,
    ]);

    return [
        'applied' => true,
        'status_id' => $statusId,
        'option_text' => $optionText,
        'remark' => $remark,
        'semester_id' => $semesterId,
        'school_year_id' => $schoolYearId,
    ];
}
