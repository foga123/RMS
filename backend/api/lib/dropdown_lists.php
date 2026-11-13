<?php
/**
 * Every dropdown the office maintains, described once, and the operations the
 * Dropdown Management screen performs on them.
 *
 * ── MODULAR ON PURPOSE ──────────────────────────────────────────────────────
 *
 * Each list is one entry in dropdown_list_definitions(): its table, its
 * columns, and what (if anything) the code depends on. Everything else - the
 * endpoint (dropdown_list.php), the form options (dropdown_options.php) and the
 * screen - is written once against that description. Making another list
 * editable is another entry here plus the table behind it, not another
 * endpoint and another page.
 *
 * Table and column names reach SQL only from this file, never from a request,
 * which is what makes interpolating them safe: a request names a list by its
 * key, and a key that is not in the registry is refused before any SQL is built.
 *
 * ── THREE SHAPES ────────────────────────────────────────────────────────────
 *
 *   id    an auto-increment id and a separate text (contact_reason,
 *         contact_recovery_plan). Other rows point at the id, so the text can
 *         be reworded freely.
 *   key   a fixed code and a label (contact_channel). Attempts store the code,
 *         so the label is what gets renamed; the code is made once, from the
 *         first label, and never changes.
 *   name  the name IS the stored value (scholarship_grant, gender, modality).
 *         The student row holds 'HK-25' itself, and the foreign keys cascade
 *         on update, so a rename reaches every student and snapshot row at
 *         once and no screen that displays the stored value had to change.
 *
 * ── WHAT CANNOT HAPPEN HERE ─────────────────────────────────────────────────
 *
 *   Nothing is deleted. Archiving takes a value off new forms; rows that hold
 *   it keep it and still show it. (The foreign keys refuse a delete anyway.)
 *
 *   A locked row - one the code writes or defaults to - is never archived, and
 *   for the name shape never renamed, since renaming it would rename the value
 *   the code writes. See 2026_09_25_dropdown_lists.sql for which and why.
 *
 * Workflow values stay in code and are deliberately NOT here: intervention
 * outcomes, priorities, periods, the STAR e-profile cohort. The code branches
 * on each of those, and a list someone could reword or archive would switch a
 * feature off without an error.
 */

/** A refusal with the HTTP status that explains it. */
class DropdownListError extends RuntimeException
{
    public int $status;

    public function __construct(string $message, int $status = 400)
    {
        parent::__construct($message);
        $this->status = $status;
    }
}

function dropdown_list_definitions(): array
{
    return [
        'contact_reasons' => [
            'label' => 'Contact reasons',
            'noun' => 'reason',
            'used_by' => 'The REASON a caller or faculty member picks when recording a contact.',
            'shape' => 'id',
            'table' => 'contact_reason',
            'id' => 'reason_id',
            'text' => 'reason_text',
            'max_length' => 190,
            'group' => ['column' => 'category', 'label' => 'Category', 'max_length' => 40],
            'flags' => ['needs_detail' => 'Ask for details when picked'],
            'usage' => [['student_contact_attempt', 'reason_id']],
        ],
        'recovery_plans' => [
            'label' => 'Recovery plans',
            'noun' => 'plan',
            'used_by' => 'The "Plan if Not Recovered" a caller picks for a student who is not coming back.',
            'shape' => 'id',
            'table' => 'contact_recovery_plan',
            'id' => 'plan_id',
            'text' => 'plan_text',
            'max_length' => 190,
            'usage' => [['student_contact_attempt', 'recovery_plan_id']],
        ],
        'contact_channels' => [
            'label' => 'Contact channels',
            'noun' => 'channel',
            'used_by' => 'How a student was reached (CHANNEL USED), in the Contact and Faculty Workspaces.',
            'shape' => 'key',
            'table' => 'contact_channel',
            'id' => 'channel_key',
            'text' => 'label',
            'max_length' => 80,
            'usage' => [['student_contact_attempt', 'contact_method']],
        ],
        'scholarship_grants' => [
            'label' => 'Scholarship grants',
            'noun' => 'grant',
            'used_by' => 'A student\'s Final Scholarship Grant, on Students, Users and the student import.',
            'shape' => 'name',
            'table' => 'scholarship_grant',
            'id' => 'name',
            'text' => 'name',
            'max_length' => 60,
            'usage' => [['student', 'final_scholarship_grant'], ['student_term_snapshot', 'final_scholarship_grant']],
        ],
        'genders' => [
            'label' => 'Genders',
            'noun' => 'gender',
            'used_by' => 'A student\'s gender, on Students, Users and the student import.',
            'shape' => 'name',
            'table' => 'gender',
            'id' => 'name',
            'text' => 'name',
            'max_length' => 20,
            'usage' => [['student', 'gender']],
        ],
        'modalities' => [
            'label' => 'Modalities',
            'noun' => 'modality',
            'used_by' => 'A student\'s learning modality, on Students, Users and the student import.',
            'shape' => 'name',
            'table' => 'modality',
            'id' => 'name',
            'text' => 'name',
            'max_length' => 20,
            'usage' => [['student', 'modality'], ['student_term_snapshot', 'modality']],
            // What a blank modality becomes, on the form, the import and the
            // server alike. Its row is locked so it can never stop existing.
            'default' => 'Flex',
        ],
    ];
}

function dropdown_list_definition(string $listKey): array
{
    $definition = dropdown_list_definitions()[$listKey] ?? null;
    if ($definition === null) {
        throw new DropdownListError('There is no dropdown list called "' . $listKey . '".', 404);
    }

    return $definition + ['key' => $listKey, 'group' => null, 'flags' => [], 'default' => null];
}

/** The value a blank field becomes for this list, or null if blank stays blank. */
function dropdown_list_default(string $listKey): ?string
{
    return dropdown_list_definition($listKey)['default'];
}

/** Every column a list's table carries, in the shape SELECT needs. */
function dropdown_list_select_columns(array $def): string
{
    $columns = [$def['id']];
    if ($def['text'] !== $def['id']) {
        $columns[] = $def['text'];
    }
    if ($def['group'] !== null) {
        $columns[] = $def['group']['column'];
    }
    foreach (array_keys($def['flags']) as $flag) {
        $columns[] = $flag;
    }
    $columns[] = 'sort_order';
    $columns[] = 'is_active';
    // id-shaped tables have nothing the code depends on, so no lock column.
    if ($def['shape'] !== 'id') {
        $columns[] = 'is_locked';
    }

    return implode(', ', array_map(static fn(string $c): string => "`$c`", $columns));
}

/** One stored row, in the one shape every caller reads. */
function dropdown_list_normalize_row(array $def, array $row): array
{
    $flags = [];
    foreach (array_keys($def['flags']) as $flag) {
        $flags[$flag] = !empty($row[$flag]);
    }

    return [
        'id' => $def['shape'] === 'id' ? (int)$row[$def['id']] : (string)$row[$def['id']],
        'text' => (string)$row[$def['text']],
        'group' => $def['group'] !== null ? (string)$row[$def['group']['column']] : null,
        'flags' => $flags,
        'sort_order' => (int)$row['sort_order'],
        'active' => !empty($row['is_active']),
        'locked' => !empty($row['is_locked']),
    ];
}

/**
 * A list's rows in display order, archived included.
 *
 * Cached for the request, because the vocabulary helpers read it once per row
 * they label. Every write here clears it, so a request that writes and then
 * reads sees what it wrote.
 */
function dropdown_list_rows(PDO $pdo, string $listKey, bool $refresh = false): array
{
    static $cache = [];
    if ($refresh) {
        unset($cache[$listKey]);
    }
    if (isset($cache[$listKey])) {
        return $cache[$listKey];
    }

    $def = dropdown_list_definition($listKey);
    $sql = sprintf(
        'SELECT %s FROM `%s` ORDER BY is_active DESC, sort_order, `%s`',
        dropdown_list_select_columns($def),
        $def['table'],
        $def['text']
    );

    return $cache[$listKey] = array_map(
        static fn(array $row): array => dropdown_list_normalize_row($def, $row),
        $pdo->query($sql)->fetchAll(PDO::FETCH_ASSOC)
    );
}

/** The values a form offers: active rows only, in order. */
function dropdown_list_options(PDO $pdo, string $listKey): array
{
    $def = dropdown_list_definition($listKey);
    $options = [];
    foreach (dropdown_list_rows($pdo, $listKey) as $row) {
        if (!$row['active']) {
            continue;
        }
        $option = ['value' => $row['id'], 'label' => $row['text']];
        if ($def['group'] !== null) {
            $option['group'] = $row['group'];
        }
        foreach ($row['flags'] as $flag => $on) {
            $option[$flag] = $on;
        }
        $options[] = $option;
    }

    return $options;
}

/**
 * The stored value for what a form or a sheet sent, or null if it names
 * nothing on the list.
 *
 * Matched without regard to case, because a registrar's sheet says "hk-25" as
 * often as "HK-25", and returned in the list's own spelling so the database
 * never holds two spellings of one value. Only active rows count unless asked:
 * an archived value is one nobody may choose any more.
 */
function dropdown_list_canonical(PDO $pdo, string $listKey, $value, bool $activeOnly = true)
{
    $token = trim((string)$value);
    if ($token === '') {
        return null;
    }

    foreach (dropdown_list_rows($pdo, $listKey) as $row) {
        if ($activeOnly && !$row['active']) {
            continue;
        }
        if (strcasecmp((string)$row['id'], $token) === 0) {
            return $row['id'];
        }
    }

    return null;
}

/** The active values of a list, for "must be one of" messages. */
function dropdown_list_active_values(PDO $pdo, string $listKey): array
{
    return array_column(dropdown_list_options($pdo, $listKey), 'value');
}

/** How many records hold each value - what "in use" means on the screen. */
function dropdown_list_usage(PDO $pdo, string $listKey): array
{
    $def = dropdown_list_definition($listKey);
    $counts = [];
    foreach ($def['usage'] as [$table, $column]) {
        $sql = sprintf('SELECT `%1$s` AS v, COUNT(*) AS n FROM `%2$s` WHERE `%1$s` IS NOT NULL GROUP BY `%1$s`', $column, $table);
        foreach ($pdo->query($sql) as $row) {
            $key = $def['shape'] === 'id' ? (int)$row['v'] : (string)$row['v'];
            // Case-folded for name lists: the collation already treats the
            // spellings as one value, so the count must too.
            if ($def['shape'] !== 'id') {
                $key = dropdown_list_canonical($pdo, $listKey, $key, false) ?? $key;
            }
            $counts[$key] = ($counts[$key] ?? 0) + (int)$row['n'];
        }
    }

    return $counts;
}

/** The row with this id, or a 404. */
function dropdown_list_find(PDO $pdo, string $listKey, $id): array
{
    $def = dropdown_list_definition($listKey);
    foreach (dropdown_list_rows($pdo, $listKey) as $row) {
        $match = $def['shape'] === 'id'
            ? $row['id'] === (int)$id
            : strcasecmp((string)$row['id'], trim((string)$id)) === 0;
        if ($match) {
            return $row;
        }
    }

    throw new DropdownListError('That ' . $def['noun'] . ' is not on the list. It may have been changed by someone else - reload and try again.', 404);
}

/** Trimmed, single-spaced, and within the column. */
function dropdown_list_clean_text($value, string $label, int $maxLength): string
{
    $text = preg_replace('/\s+/u', ' ', trim((string)$value));
    if ($text === '') {
        throw new DropdownListError($label . ' is required.');
    }
    if (mb_strlen($text, 'UTF-8') > $maxLength) {
        throw new DropdownListError($label . ' can be at most ' . $maxLength . ' characters.');
    }
    // The input guard every other write in the portal passes. "prose" rather
    // than "strict" because real entries hold parentheses and slashes -
    // "FB Messenger (Chat)", "Call/Text".
    $rejection = api_reject_unsafe_text($text, $label, 'prose');
    if ($rejection !== null) {
        throw new DropdownListError($rejection);
    }

    return $text;
}

/**
 * Refuse a text another row already uses.
 *
 * Checked across archived rows too, and the message says so, because the right
 * answer to "Financial - Others already exists" is to restore it rather than
 * make a second one - two rows with one wording would split the history of a
 * single answer in two.
 */
function dropdown_list_assert_unique(PDO $pdo, array $def, string $text, $exceptId = null): void
{
    foreach (dropdown_list_rows($pdo, $def['key']) as $row) {
        if ($exceptId !== null && (string)$row['id'] === (string)$exceptId) {
            continue;
        }
        if (strcasecmp($row['text'], $text) === 0) {
            throw new DropdownListError(
                $row['active']
                    ? '"' . $row['text'] . '" is already on the list.'
                    : '"' . $row['text'] . '" is on the list but archived. Restore it instead of adding it again.',
                409
            );
        }
    }
}

/** A channel code made from its first label: "Telegram Chat" -> telegram_chat. */
function dropdown_list_new_key(PDO $pdo, array $def, string $text): string
{
    $base = trim((string)preg_replace('/[^a-z0-9]+/', '_', strtolower($text)), '_');
    $base = substr($base !== '' ? $base : $def['noun'], 0, 32);

    $taken = array_map(static fn(array $r): string => strtolower((string)$r['id']), dropdown_list_rows($pdo, $def['key']));
    $key = $base;
    for ($n = 2; in_array($key, $taken, true); $n++) {
        $key = $base . '_' . $n;
    }

    return $key;
}

function dropdown_list_group_value(array $def, array $payload): ?string
{
    if ($def['group'] === null) {
        return null;
    }

    return dropdown_list_clean_text($payload['group'] ?? '', $def['group']['label'], (int)$def['group']['max_length']);
}

function dropdown_list_create(PDO $pdo, string $listKey, array $payload): array
{
    $def = dropdown_list_definition($listKey);
    $text = dropdown_list_clean_text($payload['text'] ?? '', ucfirst($def['noun']), (int)$def['max_length']);
    $group = dropdown_list_group_value($def, $payload);
    dropdown_list_assert_unique($pdo, $def, $text);

    // New entries go to the end; the screen reorders from there.
    $next = (int)$pdo->query(sprintf('SELECT COALESCE(MAX(sort_order), 0) + 10 FROM `%s`', $def['table']))->fetchColumn();

    $columns = ['sort_order' => $next, 'is_active' => 1];
    if ($def['shape'] === 'key') {
        $columns[$def['id']] = dropdown_list_new_key($pdo, $def, $text);
    }
    $columns[$def['text']] = $text;
    if ($group !== null) {
        $columns[$def['group']['column']] = $group;
    }
    foreach (array_keys($def['flags']) as $flag) {
        $columns[$flag] = !empty($payload['flags'][$flag]) ? 1 : 0;
    }

    $names = implode(', ', array_map(static fn(string $c): string => "`$c`", array_keys($columns)));
    $holders = implode(', ', array_map(static fn(string $c): string => ':' . $c, array_keys($columns)));
    $stmt = $pdo->prepare(sprintf('INSERT INTO `%s` (%s) VALUES (%s)', $def['table'], $names, $holders));
    $stmt->execute(array_combine(array_map(static fn(string $c): string => ':' . $c, array_keys($columns)), array_values($columns)));

    $id = $def['shape'] === 'id' ? (int)$pdo->lastInsertId() : $columns[$def['id']];
    dropdown_list_rows($pdo, $listKey, true);

    return dropdown_list_find($pdo, $listKey, $id);
}

/**
 * Reword, regroup or re-flag one entry. Returns [before, after].
 *
 * For the name shape a rename is an UPDATE of the key itself, which the
 * foreign keys carry to every student and snapshot row that holds it - in the
 * same statement, so there is no moment where a student holds a value the list
 * no longer has.
 */
function dropdown_list_update(PDO $pdo, string $listKey, $id, array $payload): array
{
    $def = dropdown_list_definition($listKey);
    $before = dropdown_list_find($pdo, $listKey, $id);

    $sets = [];
    $params = [':id' => $before['id']];

    if (array_key_exists('text', $payload)) {
        $text = dropdown_list_clean_text($payload['text'], ucfirst($def['noun']), (int)$def['max_length']);
        if ($text !== $before['text']) {
            if ($def['shape'] === 'name' && $before['locked']) {
                throw new DropdownListError(
                    '"' . $before['text'] . '" is used by the system itself and cannot be renamed.',
                    409
                );
            }
            dropdown_list_assert_unique($pdo, $def, $text, $before['id']);
            $sets[] = sprintf('`%s` = :text', $def['text']);
            $params[':text'] = $text;
        }
    }

    if ($def['group'] !== null && array_key_exists('group', $payload)) {
        $group = dropdown_list_group_value($def, $payload);
        if ($group !== $before['group']) {
            $sets[] = sprintf('`%s` = :group', $def['group']['column']);
            $params[':group'] = $group;
        }
    }

    foreach (array_keys($def['flags']) as $flag) {
        if (isset($payload['flags']) && is_array($payload['flags']) && array_key_exists($flag, $payload['flags'])) {
            $on = !empty($payload['flags'][$flag]);
            if ($on !== $before['flags'][$flag]) {
                $sets[] = sprintf('`%s` = :flag_%s', $flag, $flag);
                $params[':flag_' . $flag] = $on ? 1 : 0;
            }
        }
    }

    if ($sets) {
        $stmt = $pdo->prepare(sprintf('UPDATE `%s` SET %s WHERE `%s` = :id', $def['table'], implode(', ', $sets), $def['id']));
        $stmt->execute($params);
        dropdown_list_rows($pdo, $listKey, true);
    }

    $afterId = $def['shape'] === 'name' && isset($params[':text']) ? $params[':text'] : $before['id'];

    return [$before, dropdown_list_find($pdo, $listKey, $afterId)];
}

/** Archive or restore one entry. Returns [before, after]. */
function dropdown_list_set_active(PDO $pdo, string $listKey, $id, bool $active): array
{
    $def = dropdown_list_definition($listKey);
    $before = dropdown_list_find($pdo, $listKey, $id);

    if ($before['active'] === $active) {
        return [$before, $before];
    }
    if (!$active && $before['locked']) {
        throw new DropdownListError(
            '"' . $before['text'] . '" is used by the system itself and cannot be archived.',
            409
        );
    }
    // Restoring must not put two entries with one wording back on the form.
    // The retired 'call' channel is the live case: it reads "Call/Text", which
    // is also the label of the current call_text.
    if ($active) {
        dropdown_list_assert_unique($pdo, $def, $before['text'], $before['id']);
    }

    $stmt = $pdo->prepare(sprintf('UPDATE `%s` SET is_active = :active WHERE `%s` = :id', $def['table'], $def['id']));
    $stmt->execute([':active' => $active ? 1 : 0, ':id' => $before['id']]);
    dropdown_list_rows($pdo, $listKey, true);

    // Archiving is refused for a locked row above; the only other guard is
    // that a list keeps at least one offered value, or its dropdown is empty.
    if (!$active && !dropdown_list_options($pdo, $listKey)) {
        $pdo->prepare(sprintf('UPDATE `%s` SET is_active = 1 WHERE `%s` = :id', $def['table'], $def['id']))
            ->execute([':id' => $before['id']]);
        dropdown_list_rows($pdo, $listKey, true);
        throw new DropdownListError('A list needs at least one active entry, or its dropdown would be empty.', 409);
    }

    return [$before, dropdown_list_find($pdo, $listKey, $before['id'])];
}

/**
 * Put the active entries in the order given.
 *
 * $ids must be exactly the active entries, each once. Anything else means the
 * screen is showing a list that has changed underneath it, and applying a
 * partial order to a list someone else just edited would scramble theirs.
 */
function dropdown_list_reorder(PDO $pdo, string $listKey, array $ids): void
{
    $def = dropdown_list_definition($listKey);
    $active = array_values(array_filter(dropdown_list_rows($pdo, $listKey), static fn(array $r): bool => $r['active']));

    $current = array_map(static fn(array $r): string => strtolower((string)$r['id']), $active);
    $given = array_map(static fn($id): string => strtolower(trim((string)$id)), $ids);
    $sortedCurrent = $current;
    $sortedGiven = $given;
    sort($sortedCurrent);
    sort($sortedGiven);
    if ($sortedCurrent !== $sortedGiven) {
        throw new DropdownListError('The list changed while you were ordering it. Reload and try again.', 409);
    }

    $byToken = [];
    foreach ($active as $row) {
        $byToken[strtolower((string)$row['id'])] = $row['id'];
    }

    $stmt = $pdo->prepare(sprintf('UPDATE `%s` SET sort_order = :sort WHERE `%s` = :id', $def['table'], $def['id']));
    $pdo->beginTransaction();
    try {
        foreach ($given as $index => $token) {
            $stmt->execute([':sort' => ($index + 1) * 10, ':id' => $byToken[$token]]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        $pdo->rollBack();
        throw $e;
    }
    dropdown_list_rows($pdo, $listKey, true);
}
