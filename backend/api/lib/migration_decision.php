<?php

/** Configured single-choice enrollment questions for the semester on screen. */
function migration_decision_sources(PDO $pdo, ?int $semesterId): array {
    $stmt = $pdo->prepare(
        "SELECT q.question_id, q.survey_id, q.question_text, q.question_type,
                sv.survey_title, sv.semester_id
           FROM survey_question q
           JOIN survey sv ON sv.survey_id = q.survey_id
          WHERE sv.semester_id = :semester AND q.question_type = 'radio'
            AND EXISTS (SELECT 1 FROM survey_question_option o
                         JOIN status st ON st.status_id = o.enrollment_status_id
                        WHERE o.question_id = q.question_id
                          AND st.status_type = 'enrollment' AND st.archived_at IS NULL)
       ORDER BY sv.survey_id DESC, COALESCE(q.sort_order, 2147483647), q.question_id"
    );
    $stmt->execute([':semester' => $semesterId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];
}

/** Validate the configured choice rather than accepting arbitrary Yes/No text. */
function migration_decision_choice(PDO $pdo, int $questionId, int $optionId, int $surveyId, int $semesterId): ?array {
    $stmt = $pdo->prepare(
        "SELECT o.option_id, o.option_text, o.enrollment_status_id
           FROM survey_question_option o
           JOIN survey_question q ON q.question_id = o.question_id
           JOIN survey sv ON sv.survey_id = q.survey_id
           JOIN status st ON st.status_id = o.enrollment_status_id
          WHERE q.question_id = :question AND o.option_id = :option
            AND q.survey_id = :survey AND sv.semester_id = :semester
            AND q.question_type = 'radio'
            AND st.status_type = 'enrollment' AND st.archived_at IS NULL"
    );
    $stmt->execute([':question' => $questionId, ':option' => $optionId, ':survey' => $surveyId, ':semester' => $semesterId]);
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}
