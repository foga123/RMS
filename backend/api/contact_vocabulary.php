<?php
/**
 * The words a caller picks from, taken from section 3 of the RETENTION &
 * MIGRATION sheet.
 *
 * The sheet lists four dropdowns twice - once under FOR COACHES and once under
 * FOR CSDL. Three of them are identical in both columns and are defined once
 * here: CHANNEL USED, REASON and "Plan if Not Recovered". Only Intervention
 * Status genuinely differs, so that one is split.
 *
 * REASON, Plan and CHANNEL live in the database (contact_reason,
 * contact_recovery_plan, contact_channel) rather than in this file, because the
 * office maintains them: re-deploying PHP to add a channel is not a workflow.
 * They are edited on the Dropdown Management screen - see
 * lib/dropdown_lists.php. Intervention Status stays here, because it is not a
 * list anyone maintains - it is the shape of the process, and each value the
 * CSDL column carries has different code behind it.
 *
 * Channels were a constant here until 2026-09-25. The four keys stored before
 * the sheet's list arrived ('call', 'message', 'online_meeting', 'other') are
 * archived rows now: they still label the attempts that hold them, and are
 * never offered.
 */

require_once __DIR__ . '/lib/dropdown_lists.php';

/** The channels a form offers, in order: [['key' => ..., 'label' => ...], ...]. */
function student_contact_channel_options(PDO $pdo): array
{
    return array_map(
        static fn(array $option): array => ['key' => $option['value'], 'label' => $option['label']],
        dropdown_list_options($pdo, 'contact_channels')
    );
}

/**
 * Intervention Status, as the sheet's FOR COACHES column lists it.
 *
 * REFERRED TO CSDL is the handover: a coach who cannot recover a student passes
 * them to CSDL, which is why that value exists on this list and not the other.
 */
const STUDENT_INTERVENTION_STATUSES_COACH = [
    'recovered' => 'RECOVERED',
    'not_recovered' => 'NOT RECOVERED',
    'referred_to_csdl' => 'REFERRED TO CSDL',
];

/** Retired choices remain readable on historical attempts. */
const STUDENT_INTERVENTION_STATUSES_RETIRED = [
    'cbr_follow_up' => 'CBR - Follow Up',
    'undecided_follow_up' => 'Undecided - For Follow Up',
];

/**
 * Intervention Status, as the sheet's FOR CSDL column lists it.
 *
 * Shorter by design. CSDL is the end of the line - there is nobody left to refer
 * to - so UNREACHABLE appears here
 * instead, because exhausting every channel is an outcome CSDL records and a
 * coach does not.
 */
const STUDENT_INTERVENTION_STATUSES_CSDL = [
    'recovered' => 'RECOVERED',
    'not_recovered' => 'NOT RECOVERED',
    'unreachable' => 'UNREACHABLE',
];

/**
 * The CSDL outcome suggested by the sheet's Plan if Not Recovered rows.
 *
 * Only the three mappings supplied by the office are encoded. The other plan
 * rows deliberately return null: a blank cell in the source table is not an
 * instruction to guess an outcome. A suggestion is never stored as the final
 * outcome until CSDL reviews and saves it.
 */
const STUDENT_CSDL_OUTCOME_BY_RECOVERY_PLAN = [
    'will not continue - stop & work' => 'recovered',
    'will not continue - stop & reenroll next sem/year' => 'not_recovered',
    'will not continue - transfer to suc/ luc' => 'unreachable',
];

/** The suggested CSDL status key for a recovery-plan label, or null when blank. */
function student_csdl_suggested_outcome_for_recovery_plan(?string $planText): ?string
{
    $normalized = strtolower(trim((string)$planText));
    if ($normalized === '') {
        return null;
    }

    return STUDENT_CSDL_OUTCOME_BY_RECOVERY_PLAN[$normalized] ?? null;
}

/**
 * What a faculty contact concluded, for ONE periodical.
 *
 * Deliberately not the caller's list. A caller asks "did we get this student
 * back?" about the semester, and answers RECOVERED or NOT RECOVERED. Faculty
 * ask a different question at a different moment: partway through the term,
 * with P1 marks in hand, is this student carrying on? The answer is about the
 * student's intention, not about whether an intervention succeeded, and forcing
 * it into RECOVERED/NOT RECOVERED would file two unlike things in one column.
 *
 * `continuing` is the outcome that needs nothing further. Every other one opens
 * the reason dropdown, including `undecided`: a student who has not made up
 * their mind still has a reason they are wavering, and that reason is the whole
 * value of asking in P1 rather than reading it off a withdrawal form in P3.
 */
const FACULTY_PERIODICAL_OUTCOMES = [
    'continuing' => 'Continuing',
    'shifting' => 'Shifting course',
    'stopping' => 'Stopping',
    'undecided' => 'Undecided - for follow up',
];

/**
 * The outcomes that require a reason: everything except carrying on.
 *
 * Expressed as "not continuing" rather than as a list of three, so an outcome
 * added above is required to explain itself unless somebody deliberately
 * exempts it. The safer default when the list grows.
 */
function faculty_outcome_needs_reason(?string $outcome): bool
{
    $key = faculty_periodical_outcome_key($outcome);
    return $key !== '' && $key !== 'continuing';
}

/**
 * The outcomes that still leave a reason to ring back.
 *
 * Only `undecided`, and its own label says so: "Undecided - for follow up". A
 * student who has not made up their mind is not a student who has been dealt
 * with, and that is the whole point of asking in P1 rather than reading it off
 * a withdrawal form in P3.
 *
 * Named as the OPEN list rather than the settled one for the same reason
 * faculty_outcome_needs_reason() is written as "not continuing": an outcome
 * added to the vocabulary above is treated as settled only if somebody decides
 * it is, and the safer default when the list grows is that a new outcome does
 * not silently start clearing students off the board.
 */
const FACULTY_PERIODICAL_OPEN_OUTCOMES = ['undecided'];

/**
 * True when this contact concluded something that needs no further call.
 *
 * `shifting` and `stopping` count as settled even though the news is bad: the
 * question a caller asked was "is this student carrying on", and they have
 * their answer. Ringing again does not improve it.
 *
 * An unrecognised or missing outcome is NOT settled, so a row this file does
 * not understand stays on the list rather than disappearing from it.
 */
function faculty_outcome_is_settled(?string $outcome): bool
{
    $key = faculty_periodical_outcome_key($outcome);
    return $key !== '' && !in_array($key, FACULTY_PERIODICAL_OPEN_OUTCOMES, true);
}

/**
 * The three states a contact list can be read in.
 *
 * `outstanding` is who is left to ring, `done` is who has been, `all` is
 * everybody. Two boards ask this question -- the PDO prioritisation list and
 * the faculty board -- over the same students, through the same writer, against
 * the same settled rule, so they get one vocabulary rather than two that agree
 * until somebody adds a state to one of them.
 */
const CONTACT_STATE_VIEWS = ['outstanding', 'done', 'all'];

/** The state a list opens in: who is left to ring. */
const CONTACT_STATE_DEFAULT = 'outstanding';

/**
 * Which state a request asked for.
 *
 * Anything unrecognised WIDENS to `all` rather than falling back to the
 * default. A mistyped parameter must never silently hide students from the
 * person looking for them -- a reader who sees too many notices; a reader shown
 * too few has no way to tell.
 *
 * A missing parameter is a different thing from a wrong one and takes the
 * default, which is what makes the board open on the work rather than on the
 * archive.
 */
function contact_state_view($raw): string
{
    if ($raw === null || trim((string)$raw) === '') {
        return CONTACT_STATE_DEFAULT;
    }
    $view = strtolower(trim((string)$raw));
    return in_array($view, CONTACT_STATE_VIEWS, true) ? $view : 'all';
}

/**
 * Does a row belong in this state's list?
 *
 * Settled, not merely attempted: an "Undecided - for follow up" outcome is a
 * reason to ring again, so it stays outstanding. See
 * faculty_outcome_is_settled(), which treats anything it does not recognise the
 * same way.
 */
function contact_state_includes(string $view, bool $isSettled): bool
{
    if ($view === 'outstanding') {
        return !$isSettled;
    }
    if ($view === 'done') {
        return $isSettled;
    }
    return true;
}

/** The stored key for an outcome, or '' when it is not one of ours. */
function faculty_periodical_outcome_key($value): string
{
    $token = strtolower(trim((string)$value));
    return array_key_exists($token, FACULTY_PERIODICAL_OUTCOMES) ? $token : '';
}

/** How an outcome reads on screen. Falls back to the stored value. */
function faculty_periodical_outcome_label($value): string
{
    $key = faculty_periodical_outcome_key($value);
    return $key === '' ? (string)$value : FACULTY_PERIODICAL_OUTCOMES[$key];
}

/** The outcome list as the dropdown wants it, with the reason rule attached. */
function faculty_periodical_outcome_options(): array
{
    $options = [];
    foreach (FACULTY_PERIODICAL_OUTCOMES as $key => $label) {
        $options[] = [
            'key' => $key,
            'label' => $label,
            // The client opens the reason dropdown from this rather than from
            // its own copy of the rule, so the two cannot disagree about which
            // outcomes have to explain themselves.
            'needs_reason' => faculty_outcome_needs_reason($key),
        ];
    }

    return $options;
}

/**
 * The faculty outcomes as key => label, for a caller that renders columns.
 *
 * The mirror of student_intervention_status_labels() for the academic side of
 * Team Monitoring. Both exist so a client can be handed the words for whichever
 * vocabulary its board is counting, instead of carrying its own copy of either
 * list and drifting the first time one of them gains an outcome.
 */
function faculty_periodical_outcome_labels(): array
{
    return FACULTY_PERIODICAL_OUTCOMES;
}

/** The CSDL role. Its intervention statuses are the shorter list above. */
const STUDENT_CONTACT_CSDL_ROLE_ID = 8;

/**
 * Which intervention statuses a role may record.
 *
 * Admin gets both lists merged rather than one of them: an admin acting on
 * behalf of either team needs to be able to record what that team actually did,
 * and picking one list for them would silently make the other team's outcomes
 * unrecordable from an admin account.
 */
function student_intervention_statuses_for_role(?int $roleId): array
{
    if ($roleId === STUDENT_CONTACT_CSDL_ROLE_ID) {
        return STUDENT_INTERVENTION_STATUSES_CSDL;
    }
    if ($roleId === 1) {
        return STUDENT_INTERVENTION_STATUSES_COACH + STUDENT_INTERVENTION_STATUSES_CSDL;
    }
    return STUDENT_INTERVENTION_STATUSES_COACH;
}

/** Intervention status labels, including retired choices for historical records. */
function student_intervention_status_labels(): array
{
    return STUDENT_INTERVENTION_STATUSES_COACH + STUDENT_INTERVENTION_STATUSES_CSDL + STUDENT_INTERVENTION_STATUSES_RETIRED;
}

/**
 * The words for any outcome an attempt can carry, whichever screen wrote it.
 *
 * Three writers share student_contact_attempt.intervention_status: the caller's
 * list, CSDL's, and faculty's periodical outcomes (FACULTY_PERIODICAL_OUTCOMES).
 * A reader that knew only the first two showed every faculty contact with no
 * outcome at all. The keys do not collide - `undecided` is faculty's and
 * `undecided_follow_up` the caller's - so one map reads all three.
 *
 * For reading a stored value only. What a role may WRITE is
 * student_intervention_status_key(), which this must never replace.
 */
function student_contact_outcome_label(?string $key): ?string
{
    $token = strtolower(trim((string)$key));
    if ($token === '') {
        return null;
    }

    return (student_intervention_status_labels() + FACULTY_PERIODICAL_OUTCOMES)[$token] ?? null;
}

/**
 * A channel key, or '' if it is not one this system offers.
 *
 * Archived channels - the retired keys included - are deliberately NOT
 * accepted here. This is the validator for what gets written, and the point of
 * it is that new attempts use the current vocabulary;
 * student_contact_channel_label() is the one that still reads them.
 */
function student_contact_channel_key(PDO $pdo, $value): string
{
    return (string)(dropdown_list_canonical($pdo, 'contact_channels', strtolower(trim((string)$value))) ?? '');
}

/** How a channel reads on screen, archived ones included. */
function student_contact_channel_label(PDO $pdo, $value, ?string $otherLabel = null): string
{
    $token = strtolower(trim((string)$value));

    // 'other' carried a free-text label alongside it; show what was typed
    // rather than the word "Other", which says nothing.
    if ($token === 'other') {
        $typed = trim((string)$otherLabel);
        if ($typed !== '') {
            return $typed;
        }
    }

    foreach (dropdown_list_rows($pdo, 'contact_channels') as $row) {
        if ($row['id'] === $token) {
            return $row['text'];
        }
    }

    return $token === '' ? '' : (string)$value;
}

/**
 * An intervention status key valid for this role, '' for blank, or false for
 * "that role cannot record that".
 *
 * Three outcomes so the caller can tell "not filled in" - which is legitimate,
 * an attempt can be logged before its outcome is known - from a coach trying to
 * record UNREACHABLE, which is CSDL's word and would quietly mean nothing on a
 * coach's row.
 */
function student_intervention_status_key($value, ?int $roleId)
{
    $token = strtolower(trim((string)$value));
    if ($token === '') {
        return '';
    }

    $allowed = student_intervention_statuses_for_role($roleId);
    if (array_key_exists($token, $allowed)) {
        return $token;
    }

    // Accept the label as typed too, so a sheet paste of "REFERRED TO CSDL"
    // resolves instead of being refused for its capitals.
    foreach ($allowed as $key => $label) {
        if (strcasecmp($token, $label) === 0) {
            return $key;
        }
    }

    return false;
}

/**
 * The reason ids that must be accompanied by free text - the escape hatches
 * like "Financial - Others" that, picked on their own, record that a student
 * stopped for a financial reason nobody wrote down.
 *
 * A box on the reason (contact_reason.needs_detail), ticked on the Dropdown
 * Management screen. Until 2026-09-25 it was guessed from the WORDING - the
 * segment after the en dash starting "Others", or saying "specify" - which
 * meant rewording "Financial - Others" silently stopped asking for the detail.
 * The migration set the box from that same rule, so nothing asked for changed.
 */
function student_contact_reason_ids_needing_detail(PDO $pdo): array
{
    $ids = [];
    foreach (dropdown_list_rows($pdo, 'contact_reasons') as $row) {
        if ($row['active'] && $row['flags']['needs_detail']) {
            $ids[] = (int)$row['id'];
        }
    }

    return $ids;
}

/**
 * The reason list, grouped as the sheet groups it.
 *
 * Grouped rather than flat because it is fifty-four entries long: an ungrouped
 * dropdown of that length is scrolled past rather than read, and the eight
 * categories are how a caller already thinks about the answer.
 */
function student_contact_reason_options(PDO $pdo): array
{
    $grouped = [];
    foreach (dropdown_list_options($pdo, 'contact_reasons') as $option) {
        $category = (string)$option['group'];
        if (!isset($grouped[$category])) {
            $grouped[$category] = ['category' => $category, 'reasons' => []];
        }
        $grouped[$category]['reasons'][] = [
            'reason_id' => (int)$option['value'],
            'reason_text' => (string)$option['label'],
            // Carried on the option so the form opens the free-text box from
            // the server's answer, exactly as it opens the reason dropdown from
            // `needs_reason`. A client-side list of which reasons need detail
            // is a second copy of a vocabulary the office edits.
            'needs_detail' => (bool)$option['needs_detail'],
        ];
    }

    return array_values($grouped);
}

/** The "Plan if Not Recovered" list. */
function student_contact_recovery_plan_options(PDO $pdo): array
{
    return array_map(static function (array $option): array {
        return ['plan_id' => (int)$option['value'], 'plan_text' => (string)$option['label']];
    }, dropdown_list_options($pdo, 'recovery_plans'));
}

/** Does this reason exist and is it still offered? */
function student_contact_reason_exists(PDO $pdo, int $reasonId): bool
{
    return dropdown_list_canonical($pdo, 'contact_reasons', $reasonId) !== null;
}

/** Does this recovery plan exist and is it still offered? */
function student_contact_recovery_plan_exists(PDO $pdo, int $planId): bool
{
    return dropdown_list_canonical($pdo, 'recovery_plans', $planId) !== null;
}
