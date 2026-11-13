<?php

/**
 * How long the text an author writes into a survey may be.
 *
 * The answers a student gives have been bounded for a while — see
 * lib/survey_answer_format.php, which caps them at 1000 characters and is
 * mirrored in the browser so the student is told before they press Submit. The
 * text staff write when *building* a survey had no limit at all: question_text
 * is a TEXT column with nothing checking it, and survey_title is varchar(255)
 * with nothing checking it either.
 *
 * The varchar case is the one that actually loses data. This MySQL runs without
 * STRICT_TRANS_TABLES, so a 300-character title is not rejected — it is quietly
 * cut to 255 and stored, and nobody finds out until they notice the end of the
 * title is missing. Rejecting it here turns silent truncation into a message.
 *
 * The limits are chosen from what a survey actually holds today (longest
 * question 68 characters, longest option 27) with generous room above, and from
 * what stays readable elsewhere: a question becomes a column header in the
 * exported response matrix, and one that runs to a paragraph makes the sheet
 * unusable no matter how the column wraps.
 *
 * Characters, not bytes. mb_strlen matches what the browser counts and what a
 * person typing sees; strlen would quietly give a question written with ñ or é
 * less room than the same question written without.
 */

const SURVEY_TEXT_LIMITS = [
    'question_text' => 300,
    'option_text'   => 120,
    'survey_title'  => 120,
];

/** Kept as a template so the wording cannot drift between the six call sites. */
const SURVEY_TEXT_LENGTH_MESSAGE = '%s must be %d characters or fewer.';

/** Human names, so the message reads as English rather than as a column name. */
const SURVEY_TEXT_LABELS = [
    'question_text' => 'Question text',
    'option_text'   => 'Answer choice',
    'survey_title'  => 'Survey title',
];

function survey_text_limit(string $field): int
{
    return SURVEY_TEXT_LIMITS[$field] ?? 0;
}

/**
 * null when the value fits, otherwise the message to hand back with a 400.
 *
 * Returning the message rather than calling out() keeps this usable from the
 * three endpoints, which each have their own response helper.
 */
function survey_text_length_error(string $field, string $value): ?string
{
    $limit = survey_text_limit($field);
    if ($limit <= 0 || mb_strlen($value) <= $limit) {
        return null;
    }

    return sprintf(
        SURVEY_TEXT_LENGTH_MESSAGE,
        SURVEY_TEXT_LABELS[$field] ?? $field,
        $limit
    );
}
