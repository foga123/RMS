<?php
/**
 * What a text answer is allowed to look like.
 *
 * The authority. src/features/surveys/answerFormats.js carries the same rules
 * so the browser can say "that is not a mobile number" while the student is
 * still typing, but a browser check is a courtesy - anything that reaches
 * survey_submission.php is validated here before it is stored.
 *
 * The two files are kept in step by answerFormats.test.js, which reads the
 * patterns below out of this source and fails if they differ. Change a rule
 * here and the test tells you the mirror is stale.
 *
 * Only text questions carry a format. Radio, checkbox and rating answers come
 * from a fixed list the author wrote, so there is nothing left to constrain.
 */

/**
 * The pattern strings are shared with JavaScript verbatim, so they are written
 * to be legal in both engines:
 *   \p{L}  - any Unicode letter, so N-with-tilde and e-acute are letters
 *   \x27   - an apostrophe, spelled as a code point so neither file has to
 *            escape a quote and drift out of step with the other
 *
 * Single-quoted on purpose: PHP would read \p and \d in a double-quoted string
 * as escapes of its own and hand PCRE something else.
 */
/**
 * Said once, filled in with the limit that applies.
 *
 * A template rather than four sentences so the wording cannot drift between
 * formats, or between this file and the JavaScript one.
 */
const SURVEY_ANSWER_LENGTH_MESSAGE = 'Keep this answer to %d characters or fewer.';

function survey_answer_formats(): array
{
    return [
        'any' => [
            'label' => 'Any text',
            'pattern' => '',
            'maxLength' => 1000,
            'message' => '',
        ],
        'letters' => [
            'label' => 'Letters only (no numbers)',
            'pattern' => '^(?=.*\p{L})[\p{L}\s.\x27-]+$',
            'maxLength' => 100,
            'message' => 'Use letters only - no numbers.',
        ],
        'number' => [
            'label' => 'Numbers only',
            'pattern' => '^\d+$',
            'maxLength' => 10,
            'message' => 'Use numbers only.',
        ],
        'phone' => [
            'label' => 'Mobile number (09XXXXXXXXX)',
            'pattern' => '^09\d{9}$',
            'maxLength' => 11,
            'message' => 'Use an 11-digit mobile number starting with 09, e.g. 09362743710.',
        ],

        /*
         * How much room the answer gets, when the shape does not matter.
         *
         * Three sizes rather than a number the author types, because the useful
         * question is "a phrase, a sentence or a paragraph?" and not "how many
         * characters exactly?". A free number would also have to be stored per
         * question, which is a column; these are the existing varchar(20).
         *
         * 'any' is left at its historical 1000 rather than folded into one of
         * these. Every question written before this existed carries it, and
         * moving that ceiling would change what those questions accept - a
         * silent edit to surveys somebody has already run.
         */
        'short' => [
            'label' => 'Short answer (a word or a phrase)',
            'pattern' => '',
            'maxLength' => 100,
            'message' => '',
        ],
        'medium' => [
            'label' => 'Medium answer (a sentence or two)',
            'pattern' => '',
            'maxLength' => 400,
            'message' => '',
        ],
        'long' => [
            'label' => 'Long answer (a paragraph)',
            'pattern' => '',
            'maxLength' => 1500,
            'message' => '',
        ],

        /*
         * A Philippine address, assembled by the picker rather than typed.
         *
         * No pattern. The value that arrives is one composed line -
         * "street, Brgy. barangay, city, province ZIP" - and a regular expression over
         * that would be asserting a shape this file cannot actually guarantee:
         * the picker builds it, but the endpoint is reachable without the
         * picker, and a rule that only holds when the browser cooperates is not
         * a rule. What is enforced here is the one thing that is always true and
         * always matters - the length the column can hold.
         *
         * The parts themselves are checked where they are chosen, against
         * ph_address. See lib/ph_address.php.
         */
        'address' => [
            'label' => 'Philippine address (street, barangay, city, province, ZIP)',
            'pattern' => '',
            'maxLength' => 250,
            'message' => '',
        ],
    ];
}

/** Anything unrecognised is 'any', so an older row is never treated as invalid. */
function survey_answer_format_normalize($value): string
{
    $key = strtolower(trim((string)($value ?? '')));
    return array_key_exists($key, survey_answer_formats()) ? $key : 'any';
}

/**
 * The format actually in force for a question row.
 *
 * A format left behind on a question that was later switched to radio is
 * ignored rather than applied to an option label the author already chose.
 */
function survey_answer_format_for_question(array $question): string
{
    $type = strtolower(trim((string)($question['question_type'] ?? 'text')));
    if ($type !== 'text') {
        return 'any';
    }
    return survey_answer_format_normalize($question['answer_format'] ?? null);
}

/**
 * How long an answer to this question may actually be.
 *
 * The format sets a natural ceiling - 1000 for 'any', 100/400/1500 for the three
 * sizes - and an author may narrow it per question with answer_max_length. The
 * custom limit can only make the field shorter, never longer: a value above the
 * format's own ceiling is clamped back to it, so a limit set while a question
 * was 'long' can never leave a wider field behind once the question is switched
 * to 'short'. A null or non-positive limit means "use the format default", which
 * is what every question written before the column existed carries.
 */
function survey_answer_effective_max_length(string $format, ?int $customLimit): int
{
    $base = survey_answer_formats()[survey_answer_format_normalize($format)]['maxLength'];
    if ($customLimit !== null && $customLimit > 0) {
        return min($customLimit, $base);
    }
    return $base;
}

/**
 * '' when the value is acceptable, otherwise the reason it is not.
 *
 * A blank value is acceptable whatever the format says. Whether an answer may
 * be blank at all is the is_required question, decided separately - and
 * answering "that is not a mobile number" about an empty box would be nonsense.
 *
 * $customMaxLength is the author's per-question limit, or null to use the
 * format's own ceiling. It only narrows the field - see
 * survey_answer_effective_max_length.
 */
function survey_answer_format_validate(string $format, string $value, ?int $customMaxLength = null): string
{
    $rule = survey_answer_formats()[survey_answer_format_normalize($format)];

    // A pasted value often carries U+00A0 where a space belongs. PCRE's \s is
    // ASCII-only without UCP, and turning UCP on would also widen \d to every
    // Unicode digit - which would let Arabic-Indic numerals through as a phone
    // number. Folding the one character that actually turns up is narrower and
    // keeps this no stricter than the JavaScript copy, whose \s already matches
    // it.
    $text = trim(str_replace("\xC2\xA0", ' ', $value));
    if ($text === '') {
        return '';
    }

    // The shape first, because it is the more specific complaint. A twelve-digit
    // phone number breaks both rules, and 'use an 11-digit number starting with
    // 09' tells the student what to do where 'keep it to 11 characters' only
    // tells them to delete something.
    if ($rule['pattern'] !== '' && preg_match('/' . $rule['pattern'] . '/u', $text) !== 1) {
        return $rule['message'];
    }

    /*
     * Then length, refused rather than trimmed to fit.
     *
     * survey_answer.answer is TEXT and this database is not in strict mode, so
     * an answer longer than 65,535 bytes was cut down to size by MySQL and the
     * insert reported success - the student was told the survey was submitted
     * while the tail of what they wrote had already been thrown away. Measured:
     * 70,000 characters in, 65,535 stored, no error raised.
     *
     * Counted in characters rather than bytes, because a limit that moved
     * depending on how many accented letters were used would be impossible to
     * explain. The column has room to spare either way.
     *
     * The ceiling is the format's own maxLength unless the author set a smaller
     * one on this question; survey_answer_effective_max_length settles which.
     */
    $maxLength = survey_answer_effective_max_length($format, $customMaxLength);
    if (mb_strlen($text) > $maxLength) {
        return str_replace('%d', (string)$maxLength, SURVEY_ANSWER_LENGTH_MESSAGE);
    }

    return '';
}
