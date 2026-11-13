<?php
/**
 * When a student may be put onto a follow-up team.
 *
 * THE RULE
 *
 * Assignment opens in Periodical 3 and only in Periodical 3 -- after P2 has
 * been marked, before the semester ends. The College works the semester in that
 * order: faculty intervene early on P1 and P2 marks (see
 * lib/retention_case_policy.php, which holds the other half of this timetable),
 * and a student still at risk once P2 is in is handed to a follow-up team with
 * enough of the semester left for the calls to matter. Assigning in P1 is
 * assigning on one set of marks out of three.
 *
 * NEW ASSIGNMENTS ONLY
 *
 * The window governs putting somebody ON a team, not the work afterwards.
 * Editing the notes on an assignment that already exists, and removing an
 * assignment, stay open all year -- a calendar that has rolled into the next
 * semester must never strand work that is already in flight, and a mistake has
 * to be undoable the moment it is noticed.
 *
 * One consequence worth being plain about: moving a student from one caller to
 * another is a removal plus a NEW assignment, so the second half is inside the
 * window. Outside P3 a student can be taken off a team but not put onto a
 * different one.
 *
 * A PERIODICAL THAT IS NOT NAMED IS OUTSIDE THE WINDOW
 *
 * The calendar can sit in manual mode with the periodical deliberately blank,
 * and between terms it names none at all. Assignment needs a known P3, so an
 * absent periodical refuses -- the same way a whole-semester retention case
 * (period NULL) falls outside the faculty intervention window: it carries no
 * timing, and the whole basis of the rule is timing.
 *
 * Pure, and in a lib rather than in ssp_assignment.php, for the reason the case
 * policy moved out too: including an endpoint runs the auth guard and exits, so
 * a rule written inside one cannot be tested without standing up a request.
 */

/** The one periodical in which a student may be added to a follow-up team. */
const ASSIGNMENT_WINDOW_PERIOD = 3;

/**
 * Whether a new assignment may be created while the calendar reads $period.
 *
 * Takes the periodical rather than the calendar array so the rule can be
 * exercised across all four of its states without a database.
 */
function assignment_window_allows(?int $period): bool
{
    return $period === ASSIGNMENT_WINDOW_PERIOD;
}

/**
 * Why a new assignment was refused, as a sentence, or null when it was allowed.
 *
 * A sentence rather than a bool, for the same reason the case policy returns
 * one: "not yet, and here is when" and "the calendar does not say which
 * periodical it is" are different problems with different fixes, and answering
 * both with "Forbidden" is what makes a timing rule take an afternoon to
 * diagnose.
 */
function assignment_window_refusal(?int $period): ?string
{
    if (assignment_window_allows($period)) {
        return null;
    }

    if ($period === null) {
        return 'Assignment opens in Periodical 3, and the academic calendar does not currently name a periodical. '
            . 'Set the calendar to a periodical before assigning.';
    }

    return sprintf(
        'Assignment opens in Periodical 3, after P2 is marked and before the semester ends. '
        . 'The academic calendar is in P%d.',
        $period
    );
}

/**
 * The window as the screen should describe it.
 *
 * Sent with every GET so the board reports the rule the server actually
 * applied rather than keeping a second copy of it in the browser -- the same
 * arrangement as `case_window` on the faculty board. `can_assign` is the one
 * the UI acts on; `reason` is what it prints when that is false.
 */
function assignment_window_state(?int $period): array
{
    return [
        'period' => ASSIGNMENT_WINDOW_PERIOD,
        'period_label' => 'P' . ASSIGNMENT_WINDOW_PERIOD,
        'current_period' => $period,
        'can_assign' => assignment_window_allows($period),
        'reason' => assignment_window_refusal($period),
    ];
}

/**
 * The periodical the calendar is in, or null when it names none.
 *
 * Wrapped so every caller reads it the same way, and so a calendar that cannot
 * be read at all refuses rather than falling through to an unguarded write: a
 * missing calendar is exactly the "no periodical named" case above.
 */
function assignment_window_current_period(PDO $pdo): ?int
{
    try {
        $calendar = academic_calendar_current($pdo);
    } catch (Throwable $calendarError) {
        api_log_exception($calendarError, [
            'endpoint' => 'ssp_assignment.php',
            'step' => 'assignment_window',
        ]);
        return null;
    }

    $period = $calendar['period'] ?? null;

    return $period === null || $period === '' ? null : (int)$period;
}
