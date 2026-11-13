<?php
/**
 * Read and rewrite the finance balance bands, as one ladder.
 *
 * GET   the bands in force, plus what the built-in ladder was
 * PUT   replace the whole ladder in one transaction
 *
 * ## Why the whole ladder, and not one band at a time
 *
 * The bands are contiguous: each one starts exactly where the one below it
 * ends, which is what guarantees every balance lands in exactly one. That makes
 * a boundary a shared thing - "1 to 3K" ending at 3,000 and "3K to 5K" starting
 * at 3,000 are one decision written twice.
 *
 * So there is no such thing as a valid single-band edit. Lowering the first
 * band's top to 2,500 without touching its neighbour leaves 2,500-3,000 owned
 * by nobody, and a validator worth having refuses it. Editing row by row
 * against a whole-ladder rule means every edit is refused; editing row by row
 * WITHOUT that rule means the gap gets saved and the next import quietly files
 * a range of balances as NULL.
 *
 * Taking the ladder as one document removes the dilemma: the administrator
 * moves a boundary, both sides of it move, and the result is checked once
 * before anything is written. status.php keeps the per-row create and archive
 * for the other five status types, where rows really are independent.
 *
 * ## Archiving rather than deleting
 *
 * finance.status_id points at these rows. A band dropped from the ladder is
 * archived, so every balance already filed under it still resolves its name in
 * the Finance module and the overview chart - it simply stops taking new ones.
 * Deleting would break those rows' foreign key or blank a column of history.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/finance_bands.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

/** The ladder as the panel renders it, with the built-in one for reference. */
function finance_bands_payload(PDO $pdo): array
{
    $configured = finance_bands_read($pdo);
    $inForce = finance_bands_load($pdo);

    $problems = $configured === null ? [] : finance_bands_problems($configured);

    return [
        'installed' => finance_bands_columns_exist($pdo),
        'bands'     => array_map(static function (array $band): array {
            return [
                'status_id'   => $band['status_id'],
                'status_name' => $band['label'],
                'range_min'   => $band['min'],
                'range_max'   => $band['max'],
                'band_key'    => $band['key'],
            ];
        }, $inForce),
        // True when the table holds a ladder the loader had to reject. The
        // screen is then showing the built-in bands, which is NOT what the
        // table says, and saying so is the difference between a puzzling
        // display and an actionable one.
        'using_fallback' => $configured === null || !empty($problems),
        'problems'       => $problems,
    ];
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $pdo = (new Database())->connect();

    if ($method === 'GET') {
        api_json_response(200, ['message' => 'Finance bands loaded.'] + finance_bands_payload($pdo));
    }

    // Rewriting the bands changes where every future import files a balance, so
    // it is gated like the other settings on this screen.
    if (!api_session_user_has_role($authUser, ['admin'])) {
        api_json_response(403, ['message' => 'You do not have permission to change the balance bands.']);
    }

    if ($method !== 'PUT') {
        api_json_response(405, ['message' => 'Method not allowed']);
    }

    if (!finance_bands_columns_exist($pdo)) {
        api_json_response(503, [
            'message' => 'Balance bands are not editable yet. Run migrations/2026_09_09_finance_band_thresholds.sql.',
        ]);
    }

    $payload = json_decode(file_get_contents('php://input') ?: '', true);
    if (!is_array($payload) || !isset($payload['bands']) || !is_array($payload['bands'])) {
        api_json_response(400, ['message' => 'A bands array is required.']);
    }

    // ------------------------------------------------------------- validate --
    $submitted = [];
    $seenNames = [];
    foreach ($payload['bands'] as $index => $raw) {
        if (!is_array($raw)) {
            api_json_response(400, ['message' => 'Each band must be an object.']);
        }

        $name = trim((string)($raw['status_name'] ?? ''));
        if ($name === '') {
            api_json_response(400, ['message' => 'Every band needs a name.']);
        }
        if (mb_strlen($name) > 50) {
            api_json_response(400, ['message' => 'Keep band names to 50 characters or fewer: "' . $name . '".']);
        }
        // The same refusal every other name field on this screen makes.
        $unsafe = api_reject_unsafe_fields(['status_name' => $name], ['status_name' => 'Band name'], 'strict');
        if ($unsafe !== null) {
            api_json_response(400, ['message' => $unsafe]);
        }
        $lowerName = mb_strtolower($name);
        if (isset($seenNames[$lowerName])) {
            api_json_response(409, ['message' => 'Two bands are both called "' . $name . '".']);
        }
        $seenNames[$lowerName] = true;

        foreach (['range_min', 'range_max'] as $bound) {
            if (array_key_exists($bound, $raw) && $raw[$bound] !== null
                && !(is_numeric($raw[$bound]) || (is_string($raw[$bound]) && trim($raw[$bound]) === ''))) {
                api_json_response(400, [
                    'message' => 'The amounts for "' . $name . '" must be numbers, or left blank for no limit.',
                ]);
            }
        }

        $readBound = static function ($value): ?float {
            if ($value === null || (is_string($value) && trim($value) === '')) {
                return null;
            }
            return (float)$value;
        };

        $submitted[] = [
            'status_id' => isset($raw['status_id']) && (int)$raw['status_id'] > 0 ? (int)$raw['status_id'] : null,
            'label'     => $name,
            'min'       => $readBound($raw['range_min'] ?? null),
            'max'       => $readBound($raw['range_max'] ?? null),
            'position'  => $index,
        ];
    }

    $problems = finance_bands_problems($submitted);
    if ($problems) {
        api_json_response(422, ['message' => $problems[0], 'problems' => $problems]);
    }

    /*
     * Every id sent must be a finance row. Without this an administrator could
     * point a band at the "Enrolled" status and rewrite it from here, which is
     * the sort of thing that only ever happens by accident and is very hard to
     * trace afterwards.
     */
    $existing = $pdo->query(
        "SELECT status_id, status_name, range_min, range_max, archived_at
           FROM `status` WHERE status_type = 'finance'"
    )->fetchAll(PDO::FETCH_ASSOC);
    $existingById = [];
    foreach ($existing as $row) {
        $existingById[(int)$row['status_id']] = $row;
    }
    foreach ($submitted as $band) {
        if ($band['status_id'] !== null && !isset($existingById[$band['status_id']])) {
            api_json_response(400, [
                'message' => 'Band "' . $band['label'] . '" refers to a status that is not a finance band.',
            ]);
        }
    }

    // ---------------------------------------------------------------- write --
    $before = finance_bands_payload($pdo);
    $keptIds = [];
    $created = 0;
    $archived = 0;

    $pdo->beginTransaction();
    try {
        $sorted = finance_bands_sort($submitted);
        foreach ($sorted as $order => $band) {
            if ($band['status_id'] !== null) {
                $upd = $pdo->prepare(
                    'UPDATE `status`
                        SET status_name = :n, range_min = :min, range_max = :max,
                            sort_order = :sort, archived_at = NULL
                      WHERE status_id = :id'
                );
                $upd->execute([
                    ':n'    => $band['label'],
                    ':min'  => $band['min'],
                    ':max'  => $band['max'],
                    ':sort' => $order,
                    ':id'   => $band['status_id'],
                ]);
                $keptIds[] = $band['status_id'];
                continue;
            }

            $ins = $pdo->prepare(
                "INSERT INTO `status` (status_name, status_type, range_min, range_max, sort_order)
                 VALUES (:n, 'finance', :min, :max, :sort)"
            );
            $ins->execute([
                ':n'    => $band['label'],
                ':min'  => $band['min'],
                ':max'  => $band['max'],
                ':sort' => $order,
            ]);
            $keptIds[] = (int)$pdo->lastInsertId();
            $created++;
        }

        /*
         * Bands dropped from the ladder. Archived, and their bounds cleared so
         * they cannot be read back as part of a ladder - an archived row with a
         * range still in it would reappear the moment somebody restored it,
         * possibly overlapping whatever took its place.
         */
        foreach ($existing as $row) {
            $id = (int)$row['status_id'];
            if (in_array($id, $keptIds, true) || $row['archived_at'] !== null) {
                continue;
            }
            $pdo->prepare(
                'UPDATE `status` SET archived_at = :now, range_min = NULL, range_max = NULL WHERE status_id = :id'
            )->execute([':now' => date('Y-m-d H:i:s'), ':id' => $id]);
            $archived++;
        }

        api_write_audit_log($pdo, $authUser, 'settings_update', sprintf(
            'Finance balance bands updated: %d band(s), %d added, %d retired.',
            count($sorted),
            $created,
            $archived
        ), [
            'before' => $before['bands'],
            'after'  => array_map(static function (array $band): array {
                return ['name' => $band['label'], 'min' => $band['min'], 'max' => $band['max']];
            }, $sorted),
        ]);

        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $e;
    }

    api_json_response(200, [
        'message' => sprintf(
            'Balance bands saved. %d band%s in use%s.',
            count($submitted),
            count($submitted) === 1 ? '' : 's',
            $archived > 0 ? sprintf(', %d retired', $archived) : ''
        ),
    ] + finance_bands_payload($pdo));
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'finance_bands.php']);
    api_json_response(500, ['message' => 'Server error']);
}
