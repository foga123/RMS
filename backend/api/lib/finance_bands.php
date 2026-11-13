<?php
/**
 * The finance balance bands, as one ladder both banders read.
 *
 * A balance is filed under one of the finance rows in `status` - No Balance,
 * 1 to 3K, and so on. Which row it lands in used to be decided by two separate
 * pieces of code that each hardcoded the same four cut-offs:
 *
 *   financeimport_tier_id()  in finance-import.php, naming a `status` row
 *   pdo_balance_band()       in pdo_priority_lib.php, naming a display band
 *
 * They were kept in step by a test that copied one body into the other and
 * compared them character for character, which worked but meant the bands were
 * only editable by a developer. Status Management could already add and rename
 * finance statuses; doing so simply had no effect, because neither bander read
 * the table it was editing. A renamed band stopped matching and imports filed
 * that balance as NULL.
 *
 * So the cut-offs moved into the table, as `status.range_min` / `range_max`,
 * and both banders now read this ladder instead of their own copy.
 *
 * ## How a band matches
 *
 *   range_min IS NULL  no lower bound - this is the bottom band, and it takes
 *                      credits (negative balances) as well as zero
 *   range_max IS NULL  no upper bound - the top band
 *
 * A band matches when `amount > range_min` and `amount <= range_max`, so bounds
 * are EXCLUSIVE at the bottom and INCLUSIVE at the top. Exactly 3,000 is
 * "1 to 3K", not "3K to 5K" - the rule the sheet has always used, and the one
 * the old hardcoded `if ($amount <= 3000)` ladder expressed.
 *
 * Because each band's min is the previous band's max, one number moves one
 * boundary. There is no way to write a gap that silently swallows a balance
 * without status.php refusing the edit first.
 */

/**
 * The ladder as it was hardcoded, and as the migration seeds it.
 *
 * Kept for three jobs: seeding, the fallback when the columns do not exist yet,
 * and the historical band keys below. It is NOT consulted when the table has a
 * usable ladder - editing the table is the point.
 */
const FINANCE_BAND_DEFAULTS = [
    ['key' => 'no_balance',  'name' => 'No Balance',  'min' => null,   'max' => 0.0],
    ['key' => 'band_1_3k',   'name' => '1 to 3K',     'min' => 0.0,    'max' => 3000.0],
    ['key' => 'band_3_5k',   'name' => '3K to 5K',    'min' => 3000.0, 'max' => 5000.0],
    ['key' => 'band_5_75k',  'name' => '5K to 7.5K',  'min' => 5000.0, 'max' => 7500.0],
    ['key' => 'band_75k_up', 'name' => '7.5K and Up', 'min' => 7500.0, 'max' => null],
];

/** The display key for a band, given its bounds. */
function finance_band_key_for(?float $min, ?float $max, int $statusId): string
{
    /*
     * The bottom band is 'no_balance' whatever it is called, because
     * pdo_priority_for() compares against that key to decide Priority 4 - a
     * student attending and owing nothing. Identified by its range rather than
     * by its name, so renaming it to "Fully Paid" does not quietly demote every
     * paid-up student out of Priority 4.
     */
    if ($max !== null && $max <= 0) {
        return 'no_balance';
    }

    /*
     * A band whose bounds are unchanged keeps the key it has always had.
     *
     * Those keys are not private: StudentContactsPage colours the balance chip
     * from them, and the PDO matrix test names them. Deriving every key from
     * status_id would have been tidier and would have silently changed the
     * colour of two chips on a screen nobody asked to change.
     */
    foreach (FINANCE_BAND_DEFAULTS as $band) {
        if ($band['min'] === $min && $band['max'] === $max) {
            return $band['key'];
        }
    }

    // A band the ladder did not have before. Keyed by id so it survives being
    // renamed, which is the one thing a display key has to do.
    return 'band_status_' . $statusId;
}

/** The built-in ladder, in the shape finance_band_for() expects. */
function finance_bands_defaults(): array
{
    $out = [];
    foreach (FINANCE_BAND_DEFAULTS as $band) {
        $out[] = [
            'status_id' => null,
            'key'       => $band['key'],
            'label'     => $band['name'],
            'min'       => $band['min'],
            'max'       => $band['max'],
        ];
    }
    return $out;
}

/**
 * Order a set of bands the way the ladder reads: bottom first.
 *
 * The unbounded bottom sorts first and the unbounded top last, which is what
 * makes "each min equals the previous max" a check rather than a guess.
 */
function finance_bands_sort(array $bands): array
{
    usort($bands, static function (array $a, array $b): int {
        if ($a['min'] === null) {
            return $b['min'] === null ? 0 : -1;
        }
        if ($b['min'] === null) {
            return 1;
        }
        return $a['min'] <=> $b['min'];
    });
    return array_values($bands);
}

/** A bound as a person would write it: 3000.00 reads as 3000. */
function finance_bands_format_bound(float $value): string
{
    return rtrim(rtrim(number_format($value, 2, '.', ''), '0'), '.');
}

/**
 * What is wrong with a ladder, in words an administrator can act on.
 *
 * Returns an empty array when the ladder is sound. status.php calls this before
 * saving, so a gap or an overlap is refused at the point somebody types it
 * rather than discovered later as a column of NULLs in the finance table.
 */
function finance_bands_problems(array $bands): array
{
    if (empty($bands)) {
        return ['There are no finance bands, so imported balances cannot be filed under one.'];
    }

    $bands = finance_bands_sort($bands);
    $problems = [];
    $last = count($bands) - 1;

    if ($bands[0]['min'] !== null) {
        $problems[] = 'The lowest band needs an empty "from" value, so balances of zero and credits have somewhere to go.';
    }
    if ($bands[$last]['max'] !== null) {
        $problems[] = 'The highest band needs an empty "to" value, so there is no balance too large to file.';
    }

    foreach ($bands as $index => $band) {
        if ($band['min'] !== null && $band['max'] !== null && $band['min'] >= $band['max']) {
            $problems[] = sprintf(
                '"%s" ends at %s, which is not above where it starts (%s).',
                $band['label'],
                finance_bands_format_bound((float)$band['max']),
                finance_bands_format_bound((float)$band['min'])
            );
        }
        if ($index === 0) {
            continue;
        }
        $previous = $bands[$index - 1];
        // Contiguity. A gap loses balances; an overlap makes the answer depend
        // on row order, which is not something anybody chose.
        if ($previous['max'] === null || $band['min'] === null || (float)$previous['max'] !== (float)$band['min']) {
            $problems[] = sprintf(
                '"%s" should start exactly where "%s" ends. Balances between them would belong to neither band.',
                $band['label'],
                $previous['label']
            );
        }
    }

    return $problems;
}

/** True when the `status` table can hold thresholds at all. */
function finance_bands_columns_exist(PDO $pdo): bool
{
    static $exists = null;
    if ($exists !== null) {
        return $exists;
    }
    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM `status` LIKE 'range_min'");
        $exists = $stmt !== false && $stmt->fetchColumn() !== false;
    } catch (Throwable $e) {
        $exists = false;
    }
    return $exists;
}

/**
 * The ladder exactly as the table holds it, sound or not, or null when the
 * table holds none at all.
 *
 * Archived bands are left out. The three superseded 2026-08 bands (3k Below,
 * 3k Above, 10k Above) are archived rather than deleted so old finance rows
 * still resolve a name, and an import must not file a new balance under one.
 *
 * Separate from finance_bands_load() so a caller can see a BROKEN ladder rather
 * than the fallback that hides it. status.php validates against this before a
 * save, and the parity check asserts against it - checking the loaded ladder
 * instead would be asserting that a fallback falls back, which is always true
 * and therefore worth nothing.
 */
function finance_bands_read(PDO $pdo): ?array
{
    if (!finance_bands_columns_exist($pdo)) {
        return null;
    }

    try {
        $rows = $pdo->query(
            "SELECT status_id, status_name, range_min, range_max
               FROM `status`
              WHERE status_type = 'finance' AND archived_at IS NULL
                AND (range_min IS NOT NULL OR range_max IS NOT NULL)"
        )->fetchAll(PDO::FETCH_ASSOC) ?: [];
    } catch (Throwable $e) {
        return null;
    }

    if (empty($rows)) {
        return null;
    }

    $bands = [];
    foreach ($rows as $row) {
        $min = $row['range_min'] === null ? null : (float)$row['range_min'];
        $max = $row['range_max'] === null ? null : (float)$row['range_max'];
        $bands[] = [
            'status_id' => (int)$row['status_id'],
            'key'       => finance_band_key_for($min, $max, (int)$row['status_id']),
            'label'     => (string)$row['status_name'],
            'min'       => $min,
            'max'       => $max,
        ];
    }

    return finance_bands_sort($bands);
}

/**
 * The ladder in force: from the table when it holds a sound one, from the
 * defaults when it does not.
 *
 * The fallback is there because a half-edited ladder must not turn every import
 * into NULLs. status.php refuses the edits that would produce one, so this
 * fires only for a database changed by hand - and when it does, the screen
 * carries on banding as it did before anybody touched it.
 */
function finance_bands_load(PDO $pdo): array
{
    $bands = finance_bands_read($pdo);
    if ($bands === null || finance_bands_problems($bands)) {
        return finance_bands_defaults();
    }
    return $bands;
}

/**
 * The band an amount falls into, or null if the ladder does not cover it.
 *
 * Null is reachable only from a ladder finance_bands_problems() would reject,
 * and callers treat it the way they always treated an unmatched balance: the
 * importer stores NULL, exactly as a hand-entered record with no tier does.
 */
function finance_band_for(float $amount, array $bands): ?array
{
    foreach (finance_bands_sort($bands) as $band) {
        if ($band['min'] !== null && $amount <= (float)$band['min']) {
            continue;
        }
        if ($band['max'] !== null && $amount > (float)$band['max']) {
            continue;
        }
        return $band;
    }
    return null;
}
