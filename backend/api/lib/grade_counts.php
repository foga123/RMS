<?php

/**
 * A student's total subjects is the cap on everything counted against it.
 *
 * Passed + failed + incomplete + no credit + no grade can never be more than the
 * subjects the student takes. Each student has their own total (7 to 10 in the
 * 2026 roster), and the check is always against that student's own number -
 * there is no school-wide limit.
 *
 * ## Why it is refused rather than warned about
 *
 * Until 2026-09-25 the Grades import saved such a row and listed it under
 * "imported anyway". The pass rate is passed / total, uncapped, so 10 passed of
 * 8 subjects printed as 125% on Grades Management and the retention case - an
 * impossible figure that looks like data. The Add Grade form already refused it
 * in the browser; the endpoint and the import did not.
 *
 * ## What is still allowed
 *
 * Counts that add up to LESS than the total. The rule asked for was a cap, not
 * an exact match, and a short row is still a readable row. The import keeps
 * warning about it.
 *
 * The database holds the same cap as a CHECK (chk_grades_counts_within_total),
 * so a direct SQL load cannot slip past it either. These functions exist so a
 * person gets a sentence instead of a constraint error.
 */

/** Passed + failed + incomplete + no credit + no grade, a missing count as 0. */
function grade_counts_sum(array $counts): int
{
    $sum = 0;
    foreach (['passed', 'failed', 'incomplete', 'no_credit', 'no_grade'] as $key) {
        $sum += (int)($counts[$key] ?? 0);
    }
    return $sum;
}

/**
 * null when the counts fit inside the total, otherwise the message for a 400.
 *
 * A missing total has nothing to cap against, and the CHECK lets it through
 * too, so it passes here.
 */
function grade_counts_over_total_message(array $counts): ?string
{
    $total = $counts['total_subject'] ?? null;
    if ($total === null || $total === '') {
        return null;
    }
    $total = (int)$total;
    $sum = grade_counts_sum($counts);
    if ($sum <= $total) {
        return null;
    }
    return "Passed + Failed + Incomplete + No Credit + No Grade add up to $sum, "
        . "but the student takes $total subjects. They cannot be more than the total.";
}
