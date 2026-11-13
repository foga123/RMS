<?php
/**
 * The statuses the code finds by name, and what breaks if one is renamed.
 *
 * Most of the `status` table is free. Thirteen enrollment values, four contact
 * outcomes, two attendance values, two semester states - every one of those is
 * read from the table, shown from the table, and can be renamed, reordered or
 * added to without a line of code changing. That is the design and it works.
 *
 * Four rows are not like the others. Somewhere in the backend a query says
 * `LOWER(status_name) = 'active'` and uses the id it gets back, so the NAME is
 * the identifier. Renaming one of those does not rename a status; it detaches
 * one, and the feature that depended on it fails quietly:
 *
 *   - a student account created with status 0, which cannot log in
 *   - an "archive user" button that appears to work and archives nothing
 *   - a retention matrix whose entire previous-term cohort is empty
 *
 * None of those raise an error. They are the failure mode this file exists to
 * prevent - Status Management offered a text box against each of them and said
 * nothing about what the box was wired to.
 *
 * ## Why refuse rather than warn
 *
 * A warning would be honest and would still let somebody click through it into
 * a broken login flow. These four are identifiers that happen to be spelled in
 * English, not labels, so the endpoint refuses and says which feature is
 * holding the name. Making one of them genuinely renameable is a code change -
 * resolve it by id, or add a code column beside the name the way
 * retention_status_label does - not a settings change.
 *
 * ## Finance bands are deliberately NOT here
 *
 * They used to belong on this list: the importer matched a band by its
 * lowercased name, so renaming "1 to 3K" silently sent every balance in that
 * range to NULL. Since 2026-09-09 the bands are matched by their range_min /
 * range_max instead (lib/finance_bands.php), so a finance status can be
 * renamed, added or re-banded freely. What is guarded there is the SHAPE of the
 * ladder - no gaps, no overlaps, open at both ends - which status.php checks
 * with finance_bands_problems().
 */

/**
 * type:lowercased-name => what holds it.
 *
 * 'used_by' is shown to the administrator, so it names the feature rather than
 * the function. 'code' is for the developer who has to decide whether the entry
 * is still true - grep it before deleting a line from here.
 */
const STATUS_GUARDED_NAMES = [
    'account:active' => [
        'used_by' => 'Student accounts. A student login created by an import is given this status so it works immediately.',
        'code'    => "student_active_status_id() in lib/student_account.php",
    ],
    'account:inactive' => [
        'used_by' => 'Survey counts. The Surveys summary separates active from inactive surveys by this name.',
        'code'    => 'survey-summary.php totals and the inactive filter',
    ],
    'account:archived' => [
        'used_by' => 'Archiving users. The Users screen moves an account to this status instead of deleting it.',
        'code'    => "get_archived_status_id() in user.php, and user-summary.php",
    ],
    'enrollment:enrolled' => [
        'used_by' => 'The retention matrix. The cohort it compares terms across is every student holding this status in the previous term.',
        'code'    => 'retention_matrix.php cohort query',
    ],
];

/** The guard entry for a status, or null when the row is free to edit. */
function status_guard_entry(?string $type, ?string $name): ?array
{
    $key = strtolower(trim((string)$type)) . ':' . strtolower(trim((string)$name));
    return STATUS_GUARDED_NAMES[$key] ?? null;
}

/**
 * Why this edit is refused, or null to allow it.
 *
 * Renaming, retyping and archiving are all the same failure: the lookup stops
 * finding a row. Restoring an archived guarded status is allowed - that puts
 * the name back where the code expects it.
 */
function status_guard_edit_refusal(array $existing, ?string $newName, ?string $newType, bool $archiving): ?string
{
    $entry = status_guard_entry($existing['status_type'] ?? null, $existing['status_name'] ?? null);
    if ($entry === null) {
        return null;
    }

    $currentName = (string)($existing['status_name'] ?? '');
    $currentType = (string)($existing['status_type'] ?? '');
    $renaming = $newName !== null && strcasecmp(trim($newName), $currentName) !== 0;
    $retyping = $newType !== null && strcasecmp(trim($newType), $currentType) !== 0;

    if (!$renaming && !$retyping && !$archiving) {
        return null;
    }

    $verb = $archiving ? 'archived' : ($retyping ? 'moved to another type' : 'renamed');

    return sprintf(
        '"%s" cannot be %s. %s It is found by its name, so changing it would stop that working without any error. '
        . 'Every other %s status can be renamed freely.',
        $currentName,
        $verb,
        $entry['used_by'],
        $currentType
    );
}

/**
 * Why creating this status is refused, or null to allow it.
 *
 * Only one case: a SECOND row with a guarded name and type. The lookups all end
 * in LIMIT 1 with no ORDER BY, so which of the two answers is up to the storage
 * engine - the kind of bug that behaves for months and then changes its mind
 * after an unrelated table rebuild.
 *
 * Creating a guarded name that is missing is the opposite of a problem: it is
 * how a database that lost one gets it back, so $alreadyExists is what decides,
 * not the name on its own.
 */
function status_guard_create_refusal(?string $name, ?string $type, bool $alreadyExists): ?string
{
    if (!$alreadyExists) {
        return null;
    }

    $entry = status_guard_entry($type, $name);
    if ($entry === null) {
        return null;
    }

    return sprintf(
        'There is already a "%s" status under %s, and the system looks that name up expecting exactly one row. %s',
        trim((string)$name),
        trim((string)$type),
        $entry['used_by']
    );
}
