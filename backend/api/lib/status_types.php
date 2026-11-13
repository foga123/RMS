<?php
/**
 * The status types that exist, and which screen reads each one.
 *
 * `status` is one lookup table shared by every domain, keyed by a `status_type`
 * string. Until now that string was free text on both create and edit: the Add
 * Status dialog offered a box whose placeholder read "e.g. account, semester,
 * schoolyear", and the endpoint stored whatever came back.
 *
 * Nothing reads "schoolyear". A status filed under a type no module queries is
 * not a broken status - it is an invisible one. It saves, it appears in Status
 * Management, and it never shows up in the dropdown the person was trying to
 * add it to. The same is true of a typo: "acount" and "Enrollment" are both
 * accepted today, and both produce a row that no screen will ever offer.
 *
 * So the type is now chosen from this list rather than typed. This file is the
 * one place that says which types are real, and the Status Management screen
 * groups its table under these headings so that "where can this be added?" is
 * answerable by looking.
 *
 * ## Adding a type here does not create a feature
 *
 * An entry is a claim that some screen queries `status_type = '<key>'` and
 * renders what it gets. Adding a key without that query gives an administrator
 * a heading they can file statuses under that still go nowhere - which is the
 * bug this file exists to remove, wearing a tidier hat. Grep for the key before
 * adding one.
 *
 * See lib/status_guard.php for the four individual NAMES that cannot change.
 * This file is about the type, that one is about the row.
 */

/**
 * status_type => how it is described to an administrator.
 *
 * 'label'    the heading shown in Status Management.
 * 'used_by'  the screen that reads it, in the words of someone using the app.
 * 'can_add'  false when rows are real but must be created somewhere else.
 * 'add_hint' where that somewhere else is; required when can_add is false.
 */
const STATUS_TYPE_CATALOGUE = [
    'account' => [
        'label'   => 'User accounts',
        'used_by' => 'The state of a login on the Users screen - active, inactive or archived.',
        'can_add' => true,
    ],
    'enrollment' => [
        'label'   => 'Enrollment',
        'used_by' => 'What a student answered about next term. Drives the survey, the retention board and the migration matrix.',
        'can_add' => true,
    ],
    'contact_workspace' => [
        'label'   => 'Contact outcomes',
        'used_by' => 'How a call ended, recorded by a caller in the Contact Workspace.',
        'can_add' => true,
    ],
    'attendance' => [
        'label'   => 'Attendance',
        'used_by' => 'Whether a student was present, used by the attendance import and its remark rules.',
        'can_add' => true,
    ],
    'semester' => [
        'label'   => 'Semester state',
        'used_by' => 'Whether a semester is open or closed, which decides what the imports will accept.',
        'can_add' => true,
    ],
    'finance' => [
        'label'    => 'Balance bands',
        'used_by'  => 'Which balance bracket a student falls in. Matched by amount, not by name, so these can be renamed freely.',
        'can_add'  => false,
        'add_hint' => 'Settings -> Balance Bands',
    ],
];

/** Every type, in the order Status Management should show them. */
function status_types_all(): array
{
    $out = [];
    foreach (STATUS_TYPE_CATALOGUE as $key => $entry) {
        $out[] = ['key' => $key] + $entry;
    }
    return $out;
}

/** The catalogue entry for a type, or null when it is not one we know. */
function status_type_entry(?string $type): ?array
{
    $key = strtolower(trim((string)$type));
    return STATUS_TYPE_CATALOGUE[$key] ?? null;
}

/** The keys, for an error message that has to list them. */
function status_type_keys(): array
{
    return array_keys(STATUS_TYPE_CATALOGUE);
}

/**
 * The catalogue's spelling of a type, or the input unchanged if unlisted.
 *
 * "Enrollment" and "enrollment" are the same type to MySQL, whose default
 * collation is case-insensitive, so both keep working in every query. They are
 * NOT the same string to the screen, which groups its table by the value it is
 * given and would draw two headings for one module. Store the canonical form
 * and the question never arises.
 */
function status_type_canonical(?string $type): string
{
    $raw = trim((string)$type);
    return status_type_entry($raw) !== null ? strtolower($raw) : $raw;
}

/**
 * Why this type cannot be used, or null to allow it.
 *
 * Only answers "is this a type some screen reads". It deliberately does not act
 * on 'can_add': finance has its own refusal in status.php, worded for the
 * specific reason a lone band cannot be inserted, and a second generic message
 * competing with it would be the weaker one that fires first.
 *
 * $existingType grandfathers a row that already carries a type this file does
 * not list. Refusing an unrelated rename because of a type somebody set before
 * this list existed would strand the row with no way to fix it - the check is on
 * the value being written, not on the row's history.
 */
function status_type_refusal(?string $type, ?string $existingType = null): ?string
{
    $raw = trim((string)$type);

    if ($existingType !== null && strcasecmp($raw, trim((string)$existingType)) === 0) {
        return null;   // unchanged, whatever it is
    }

    if (status_type_entry($raw) !== null) {
        return null;
    }

    return sprintf(
        '"%s" is not a status type any screen reads, so a status saved under it would never appear anywhere. Choose one of: %s.',
        $raw,
        implode(', ', status_type_keys())
    );
}
