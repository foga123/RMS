<?php

/**
 * One check for "is this string a date", for the endpoints that store one.
 *
 * ## Why this is needed at all
 *
 * This MySQL runs without STRICT_TRANS_TABLES. A DATE column therefore does not
 * refuse bad input - it stores `0000-00-00` and reports success. Measured on
 * this server:
 *
 *     'not-a-date'  -> 0000-00-00
 *     '2026-13-45'  -> 0000-00-00
 *     '2026-02-30'  -> 0000-00-00
 *     ''            -> 0000-00-00
 *
 * Having NO_ZERO_DATE in sql_mode does not save you: without STRICT that mode
 * only warns. It is the same failure the survey title length check exists for
 * (lib/survey_text_limits.php) - MySQL quietly accepting something nobody meant
 * - on a different column type.
 *
 * `0000-00-00` is worse than NULL, which is why this is worth refusing rather
 * than coercing. Screens already handle a NULL date: it renders as "-" and
 * sorts as empty. `0000-00-00` renders as itself, sorts before every real row,
 * and reads like a date somebody chose.
 *
 * ## Why checkdate() and not the obvious alternatives
 *
 * A regex accepts 31 February. `strtotime('2026-02-31')` is worse than
 * accepting it - it ROLLS OVER to 3 March, so the row is filed under a date
 * nobody typed and nothing looks wrong afterwards. checkdate() is the only one
 * of the three that answers the question actually being asked.
 *
 * The format is fixed at YYYY-MM-DD rather than being lenient, because that is
 * what `<input type="date">` submits and what the column stores. Accepting
 * 10/09/2026 would mean guessing whether it is September or October.
 */

/**
 * null when the value is a real calendar date, otherwise the message for a 400.
 *
 * $required decides what a blank means. A survey must have a date - the lists
 * sort on it. An enrollment status row need not, and there a blank is stored as
 * NULL rather than refused.
 *
 * Returns the message rather than responding, so the endpoints can keep using
 * their own response helpers.
 */
function api_calendar_date_error(?string $value, string $label = 'Date', bool $required = true): ?string
{
    $trimmed = trim((string)$value);

    if ($trimmed === '') {
        return $required ? $label . ' is required.' : null;
    }

    if (!preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', $trimmed, $parts)) {
        return $label . ' must be written as YYYY-MM-DD.';
    }

    [, $year, $month, $day] = $parts;
    if (!checkdate((int)$month, (int)$day, (int)$year)) {
        return $label . ' is not a real date.';
    }

    return null;
}

/**
 * The value to store: the trimmed date, or null for a blank.
 *
 * Only meaningful once api_calendar_date_error() has passed. Paired with it so
 * a caller cannot validate one string and store a differently-trimmed one.
 */
function api_calendar_date_value(?string $value): ?string
{
    $trimmed = trim((string)$value);
    return $trimmed === '' ? null : $trimmed;
}
