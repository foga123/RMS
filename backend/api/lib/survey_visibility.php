<?php
/**
 * Which questions a submission was actually asked.
 *
 * survey_question_condition lets an author hide a question behind an earlier
 * answer - "What is stopping you from enrolling?" is only asked of a student
 * who said they will not enroll. The student's page has understood that since
 * branching shipped; the submit endpoint did not, and required every question
 * marked is_required whether or not it had been on screen. A student who marked
 * the "Yes, I will enroll" follow-up as required and then answered anything
 * else was told to "answer all required questions" about a question the form
 * had never shown them, with no way to satisfy it. The Submit button was a dead
 * end for that whole branch.
 *
 * This is the server's copy of src/features/surveys/surveyBranching.js. The two
 * have to agree: the page decides what to send, this decides what was owed, and
 * a disagreement is either a student blocked from submitting or a required
 * answer quietly skipped.
 */

/**
 * The rules for one survey, as [question_id => [[source_question_id, option_text], ...]].
 *
 * A question with no rules is absent from the result, which reads as "always
 * asked" - the default, and what every question did before branching existed.
 * The table arrives with a migration and this runs on installations that have
 * not applied it, so a missing table means no rules rather than a 500.
 */
function survey_visibility_rules(PDO $pdo, int $surveyId): array
{
    try {
        if (!$pdo->query("SHOW TABLES LIKE 'survey_question_condition'")->fetch()) {
            return [];
        }
    } catch (Throwable $e) {
        return [];
    }

    $stmt = $pdo->prepare(
        'SELECT c.question_id, o.question_id AS source_question_id, o.option_text
           FROM survey_question_condition c
           JOIN survey_question_option o ON o.option_id = c.option_id
           JOIN survey_question q ON q.question_id = c.question_id
          WHERE q.survey_id = :survey_id'
    );
    $stmt->execute([':survey_id' => $surveyId]);

    $rules = [];
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $row) {
        $questionId = (int)($row['question_id'] ?? 0);
        $sourceId = (int)($row['source_question_id'] ?? 0);
        $optionText = trim((string)($row['option_text'] ?? ''));
        if ($questionId <= 0 || $sourceId <= 0 || $optionText === '') {
            continue;
        }
        $rules[$questionId][] = ['question_id' => $sourceId, 'option_text' => $optionText];
    }

    return $rules;
}

/**
 * Was this option the answer given to its own question?
 *
 * A checkbox answer arrives as the picked labels joined with ", " - that is how
 * the page compiles it and how survey_answer has always stored it. Splitting on
 * the comma is therefore the right read, and the whole string is compared too
 * so a single-choice answer, or an option whose own text contains a comma,
 * still matches.
 */
function survey_visibility_option_chosen(array $rule, array $answersByQuestion): bool
{
    $given = $answersByQuestion[$rule['question_id']] ?? null;
    if ($given === null) {
        return false;
    }

    $answer = trim((string)$given);
    if ($answer === '') {
        return false;
    }
    if ($answer === $rule['option_text']) {
        return true;
    }

    foreach (explode(',', $answer) as $part) {
        if (trim($part) === $rule['option_text']) {
            return true;
        }
    }

    return false;
}

/**
 * True when the question was on screen for the answers given.
 *
 * No rules means always. One or more means any of them satisfied - OR, never
 * AND, matching the page: a question can hang off both "Yes, I will enroll."
 * and "Yes, but with shift course.", and requiring both would hide it forever.
 */
function survey_question_is_visible(int $questionId, array $rules, array $answersByQuestion): bool
{
    $gate = $rules[$questionId] ?? [];
    if (empty($gate)) {
        return true;
    }

    foreach ($gate as $rule) {
        if (survey_visibility_option_chosen($rule, $answersByQuestion)) {
            return true;
        }
    }

    return false;
}
