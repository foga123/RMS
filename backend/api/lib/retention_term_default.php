<?php
/**
 * Which term the retention screens open on when nobody names one.
 *
 * THE RULE
 *
 *   the semester is PINNED to 2nd Semester, whatever the calendar says
 *   the school YEAR comes from the academic calendar
 *
 * Retention is a second-semester question at this College: the decision these
 * screens report -- who continues, transfers or stops -- is made on the way out
 * of the year, not on the way into it. So they open there even while the
 * College is in 1st Semester, and the dropdowns reach everything else.
 *
 * The year is deliberately NOT pinned. Pinning both would freeze the screens on
 * one term forever and need editing every August; following the calendar for
 * the year means they roll over on their own.
 *
 * WHY THIS IS A LIB AND NOT A CONSTANT IN ONE ENDPOINT
 *
 * Two screens answer this question and they are read side by side:
 * retention_matrix.php, and student_migration.php -- which renders the matrix
 * INSIDE itself and passes its own term down as an explicit semester_id. When
 * the two defaults disagreed, the same grid showed a different term depending
 * on which page it was opened from, and the page header contradicted the matrix
 * header directly beneath it. One definition, read by both, is the only
 * arrangement where that cannot come back.
 *
 * AN EMPTY DEFAULT IS EXPECTED, NOT A BUG. 2nd Semester of the current year
 * routinely holds no rows until enrolment decisions are recorded. Both screens
 * say so in words rather than showing a blank grid, and neither borrows another
 * term's numbers under this term's name -- that substitution is the thing that
 * would actually be wrong.
 */

/** The semester every retention screen opens on. */
const RETENTION_DEFAULT_SEMESTER = 2;

/**
 * The term to open on, as ['school_year_id' => int|null, 'semester_id' => int].
 *
 * $fallbackTerm is used for the YEAR only, and only when the calendar names
 * none -- callers pass whatever they were doing before (typically the newest
 * term holding rows) so a calendar that cannot be read still leaves a usable
 * screen rather than an error.
 *
 * The semester it carries is ignored on purpose: that is the whole point of the
 * pin, and silently honouring a fallback's semester is exactly how the two
 * endpoints drifted apart the first time.
 */
function retention_default_term(PDO $pdo, ?array $fallbackTerm = null): array
{
    $year = null;

    try {
        $calendar = academic_calendar_current($pdo);
        $calYear = (int)($calendar['school_year_id'] ?? 0);
        if ($calYear > 0) {
            $year = $calYear;
        }
    } catch (Throwable $calendarError) {
        // A preference, not a dependency: failing a whole page over which term
        // it opens on would be a worse answer than the fallback below.
        api_log_exception($calendarError, [
            'endpoint' => 'retention_term_default',
            'step' => 'calendar_year',
        ]);
    }

    if ($year === null && $fallbackTerm !== null) {
        $fallbackYear = (int)($fallbackTerm['school_year_id'] ?? 0);
        if ($fallbackYear > 0) {
            $year = $fallbackYear;
        }
    }

    if ($year === null) {
        $newest = $pdo->query(
            'SELECT school_year_id FROM school_year ORDER BY schoolyear_name DESC LIMIT 1'
        )->fetchColumn();
        $year = $newest !== false ? (int)$newest : null;
    }

    return [
        'school_year_id' => $year,
        'semester_id'    => RETENTION_DEFAULT_SEMESTER,
    ];
}
