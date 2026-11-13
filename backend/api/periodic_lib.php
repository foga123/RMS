<?php
/**
 * Grading periods, shared by every module that records data inside a semester.
 *
 * A PHINMA semester runs three periodicals - P1, P2 and P3 - and grades,
 * attendance and finance are all captured at each one. The `period` column was
 * added to those three tables on 2026-08-21 (see
 * migrations/2026_08_21_periodic_data_and_pdo.sql).
 *
 * NULL is a legal, meaningful value: it means "the whole semester", which is
 * what every row recorded before that date is. Those rows were deliberately not
 * backfilled to a period, because nobody knows which periodical they were taken
 * at, and inventing one would make a semester total look like a P1 reading.
 *
 * This file exists so the rule is written once. The same normaliser is needed by
 * grades.php, finance.php, attendance-summary.php and the three importers, and
 * six private copies of a validator is how they quietly stop agreeing.
 */

/** The periodicals in a semester, in order. */
const API_PERIODS = [1, 2, 3];

/**
 * How a period reads on screen and in an export.
 *
 * A semester is P1, P2, P3, then Total - four things, and NULL is the last of
 * them. It was labelled "Term", which was a fifth word for a semester nobody
 * needed, and then briefly "Semester", which named the container rather than
 * the figure. A row with no periodical holds the whole semester's numbers: it
 * is the total.
 *
 * Only the label changed. The query value is still `term` - see
 * api_period_filter_sql() - because that is the wire contract the three screens
 * and their bookmarks already send.
 */
function api_period_label($period): string
{
    $period = ($period === null || $period === '') ? null : (int)$period;
    if ($period === null) {
        return 'Whole Periodical';
    }
    return in_array($period, API_PERIODS, true) ? 'P' . $period : (string)$period;
}

/**
 * A period number, null for "term total", or false for "that is not a period".
 *
 * Three outcomes rather than two so a caller can tell a blank field from a typo.
 * Returning null for both would let `period=9` silently write a term total over
 * a periodical reading, which is the one mistake here that loses data.
 *
 * Accepts 1/2/3 and the P1/P2/P3 spelling people actually type on a sheet.
 */
function api_normalize_period($value)
{
    if ($value === null) {
        return null;
    }
    if (is_string($value)) {
        $value = trim($value);
        if ($value === '') {
            return null;
        }
        // "P1", "p 2", "Period 3" - all the ways a periodical gets written by
        // hand on an import sheet.
        if (preg_match('/^(?:p|period)\s*([123])$/i', $value, $m)) {
            return (int)$m[1];
        }
    }
    if (!is_numeric($value)) {
        return false;
    }
    $period = (int)$value;
    return in_array($period, API_PERIODS, true) ? $period : false;
}

/**
 * Turn a ?period= query parameter into a SQL fragment.
 *
 * Returns [sqlFragment, params]. Three distinct requests are possible and they
 * are not the same question:
 *
 *   period absent or 'all' -> every row, periodicals and semester totals alike
 *   period=1|2|3           -> that periodical only
 *   period=term            -> the semester-total rows only (period IS NULL)
 *
 * 'term' is spelled out rather than passed as an empty string, because an empty
 * string is what a cleared dropdown sends and that has to keep meaning "all".
 */
function api_period_filter_sql(string $column, $value, string $placeholder = ':period'): array
{
    if ($value === null || $value === '' || strcasecmp((string)$value, 'all') === 0) {
        return ['', []];
    }
    if (strcasecmp((string)$value, 'term') === 0 || strcasecmp((string)$value, 'none') === 0) {
        return ["$column IS NULL", []];
    }
    $period = api_normalize_period($value);
    if ($period === false || $period === null) {
        return ['', []];
    }
    return ["$column = $placeholder", [$placeholder => $period]];
}
