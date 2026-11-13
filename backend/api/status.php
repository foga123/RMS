<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
// The four statuses the backend looks up by name, and what breaks if one moves.
require_once __DIR__ . '/lib/status_guard.php';
require_once __DIR__ . '/lib/status_types.php';
// The finance balance ladder, so a band edited here is the band imports apply.
require_once __DIR__ . '/lib/finance_bands.php';

function ensure_status_archive_column(PDO $pdo): void {
    api_require_column($pdo, 'status', 'archived_at');
}

/**
 * The ladder as it would be after this edit, for validation before the write.
 *
 * $change is the row being added or altered: ['status_id' => int|null, 'label',
 * 'min', 'max'], or null when the row is being archived out of the ladder. The
 * point is to refuse a gap at the moment somebody types it, rather than let the
 * importer discover it later and file a term's balances as NULL.
 */
function status_prospective_bands(PDO $pdo, ?array $change, ?int $removeStatusId = null): array {
    $bands = finance_bands_read($pdo) ?? [];

    if ($removeStatusId !== null) {
        $bands = array_values(array_filter($bands, static function (array $band) use ($removeStatusId): bool {
            return (int)($band['status_id'] ?? 0) !== $removeStatusId;
        }));
    }

    if ($change !== null) {
        $changeId = $change['status_id'] === null ? null : (int)$change['status_id'];
        if ($changeId !== null) {
            $bands = array_values(array_filter($bands, static function (array $band) use ($changeId): bool {
                return (int)($band['status_id'] ?? 0) !== $changeId;
            }));
        }
        $bands[] = [
            'status_id' => $changeId ?? 0,
            'key'       => 'pending',
            'label'     => (string)$change['label'],
            'min'       => $change['min'],
            'max'       => $change['max'],
        ];
    }

    return $bands;
}

try {
    $db = new Database();
    $pdo = $db->connect();
    ensure_status_archive_column($pdo);
    $hasArchivedAt = api_column_exists($pdo, 'status', 'archived_at');
    // Present once the finance band migration has run. Every statement naming
    // these two columns is guarded by it, so an un-migrated database behaves
    // exactly as it did before, without the band editing.
    $hasRanges = finance_bands_columns_exist($pdo);
    $rangeSelect = $hasRanges ? ', range_min, range_max' : '';

    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        // GET by id
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare("SELECT status_id, status_name, status_type$rangeSelect FROM status WHERE status_id = :id LIMIT 1");
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Status not found']);
            api_out(200, ['data' => $row]);
        }

        // List with pagination + search (by name or type)
        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        $limit = isset($_GET['limit']) ? max(1, min(500, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $includeArchived = isset($_GET['include_archived']) ? api_bool_like($_GET['include_archived'], false) : false;
        $archivedOnly = isset($_GET['archived']) ? api_bool_like($_GET['archived'], false) : false;
        $whereParts = [];
        $params = [];
        if ($hasArchivedAt) {
            if ($archivedOnly) {
                $whereParts[] = 'archived_at IS NOT NULL';
            } elseif (!$includeArchived) {
                $whereParts[] = 'archived_at IS NULL';
            }
        }
        if ($search !== '') {
            $whereParts[] = '(status_name LIKE :q OR status_type LIKE :q)';
            $params[':q'] = "%$search%";
        }

        // `status` is one lookup table shared by every domain, so a form that
        // wants only enrollment values had no way to ask for them and ended up
        // hardcoding ids instead.
        $typeFilter = isset($_GET['status_type']) ? trim((string)$_GET['status_type']) : '';
        if ($typeFilter !== '') {
            $whereParts[] = 'status_type = :status_type';
            $params[':status_type'] = $typeFilter;
        }

        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        // sort_order is the display order the statuses were seeded with; falling
        // back to status_id would list "Not Enrolled" (an older row) among the
        // newer values rather than last where it belongs.
        $hasSortOrder = api_column_exists($pdo, 'status', 'sort_order');
        $orderBy = $hasSortOrder
            ? 'ORDER BY COALESCE(sort_order, 9999) ASC, status_id ASC'
            : 'ORDER BY status_id ASC';
        $sortSelect = $hasSortOrder ? 'sort_order, ' : '';

        $sql = "SELECT status_id, status_name, status_type$rangeSelect, $sortSelect archived_at FROM status $where $orderBy LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $countSql = 'SELECT COUNT(*) FROM status ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) { $countStmt->bindValue($k, $v); }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        /*
         * The catalogue rides along with the list so the screen has one source
         * for the headings, the Type dropdown and the "added elsewhere" note. A
         * copy of this list in the frontend would be a second place to forget
         * when a module starts or stops reading a type.
         */
        api_out(200, [
            'data' => $rows,
            'types' => status_types_all(),
            'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total],
        ]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);


        /*
         * Injection guard. See api_reject_unsafe_text() in middleware/auth.php
         * for the two levels and why refusing on input beats escaping on output.
         * Names and codes are identifiers ('strict'); anything that is a
         * sentence is 'prose', which allows the brackets and question marks real
         * writing contains.
         */
        $unsafe = api_reject_unsafe_fields($p, [
            'status_name' => 'Status name',
            'status_type' => 'Status type',
        ], 'strict');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);
        $name = isset($p['status_name']) ? trim((string)$p['status_name']) : '';
        $type = isset($p['status_type']) ? trim((string)$p['status_type']) : '';
        if ($name === '') api_out(400, ['message' => 'status_name is required']);
        if ($type === '') api_out(400, ['message' => 'status_type is required']);

        // The type has to be one a screen actually queries. It used to be free
        // text, so "schoolyear" - the placeholder the dialog itself suggested -
        // saved happily and produced a status no dropdown would ever offer.
        $typeRefusal = status_type_refusal($type);
        if ($typeRefusal !== null) api_out(400, ['message' => $typeRefusal]);
        $type = status_type_canonical($type);

        // Prevent duplicates by name+type pair
        $dupSql = 'SELECT status_id FROM status WHERE status_name = :n AND (status_type <=> :t)';
        if ($hasArchivedAt) {
            $dupSql .= ' AND archived_at IS NULL';
        }
        $dupSql .= ' LIMIT 1';
        $dup = $pdo->prepare($dupSql);
        $dup->execute([':n' => $name, ':t' => $type]);
        $alreadyExists = (bool)$dup->fetch();

        // A second row under a guarded name is worse than a plain duplicate, so
        // it gets the message that says which feature is about to become
        // ambiguous rather than the generic one.
        $guarded = status_guard_create_refusal($name, $type, $alreadyExists);
        if ($guarded !== null) api_out(409, ['message' => $guarded]);
        if ($alreadyExists) api_out(409, ['message' => 'Status already exists']);

        /*
         * A finance band cannot be added as a lone row.
         *
         * The bands are contiguous - each starts exactly where the one below it
         * ends - so adding one is never just an insert: it takes its range from
         * the band it splits, which has to be narrowed in the same breath.
         * Inserting a row here would either open a gap that silently sends a
         * range of balances to NULL on the next import, or be refused for
         * leaving one, and neither is a useful answer to somebody who simply
         * wants a "10K and Up" band.
         *
         * finance_bands.php takes the whole ladder at once, which is the shape
         * that lets both halves of a split be checked and written together.
         */
        if (strcasecmp($type, 'finance') === 0 && $hasRanges) {
            api_out(409, ['message' =>
                'Finance bands are added in Balance Bands, not here. A band takes its range from the one it '
                . 'splits, so both have to be saved together — adding a row on its own would leave balances '
                . 'that belong to no band.',
            ]);
        }

        $ins = $pdo->prepare('INSERT INTO status (status_name, status_type) VALUES (:n, :t)');
        $ins->execute([':n' => $name, ':t' => $type]);
        $newId = (int)$pdo->lastInsertId();

        $sel = $pdo->prepare("SELECT status_id, status_name, status_type$rangeSelect FROM status WHERE status_id = :id LIMIT 1");
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(201, ['message' => 'Status created', 'data' => $row]);
    }

    if ($method === 'PUT') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) { $id = isset($p['status_id']) ? (int)$p['status_id'] : 0; }
        if ($id <= 0) api_out(400, ['message' => 'Valid status_id is required']);

        $chk = $pdo->prepare("SELECT status_id, status_name, status_type, archived_at$rangeSelect FROM status WHERE status_id = :id LIMIT 1");
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Status not found']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);

        // The same refusal POST makes. Update had none, so anything create
        // turned away could be PUT onto the row a moment later.
        $unsafe = api_reject_unsafe_fields($p, [
            'status_name' => 'Status name',
            'status_type' => 'Status type',
        ], 'strict');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        $name = array_key_exists('status_name', $p) ? trim((string)$p['status_name']) : null;
        $typeProvided = array_key_exists('status_type', $p);
        $type = $typeProvided ? trim((string)$p['status_type']) : null;
        $restoreRequested = $hasArchivedAt && array_key_exists('archived', $p) && !api_bool_like($p['archived'], false);

        $fields = [];
        $params = [':id' => $id];
        if ($name !== null && $name === '') api_out(400, ['message' => 'status_name cannot be empty']);
        if ($typeProvided && $type === '') api_out(400, ['message' => 'status_type cannot be empty']);

        $effectiveName = $name !== null ? $name : $existing['status_name'];
        $effectiveType = $typeProvided ? $type : $existing['status_type'];

        /*
         * Moving a status to a type nothing reads is the same disappearance as
         * creating one there, except it also removes the status from the screen
         * that was using it. The row's own type is passed so that a status
         * already filed under something unlisted can still be renamed - the
         * check is on what is being written, not on what the row arrived with.
         */
        if ($typeProvided) {
            $typeRefusal = status_type_refusal($type, (string)$existing['status_type']);
            if ($typeRefusal !== null) api_out(400, ['message' => $typeRefusal]);
            $type = status_type_canonical($type);
            $effectiveType = $type;
        }

        /*
         * The guard rail.
         *
         * Four statuses are found by their name in SQL rather than by their id,
         * so renaming one detaches the feature that depends on it and nothing
         * reports an error - a student account that cannot log in, an archive
         * button that archives nothing, an empty retention cohort. Refused with
         * the name of the feature holding it. See lib/status_guard.php.
         */
        $archiving = $hasArchivedAt && array_key_exists('archived', $p) && api_bool_like($p['archived'], false);
        $guarded = status_guard_edit_refusal($existing, $name, $type, $archiving);
        if ($guarded !== null) api_out(409, ['message' => $guarded]);

        if ($restoreRequested || $effectiveName !== $existing['status_name'] || $effectiveType !== $existing['status_type']) {
            $dupSql = 'SELECT status_id FROM status WHERE status_name = :n AND (status_type <=> :t) AND status_id <> :id';
            if ($hasArchivedAt) {
                $dupSql .= ' AND archived_at IS NULL';
            }
            $dupSql .= ' LIMIT 1';
            $dup = $pdo->prepare($dupSql);
            $dup->execute([':n' => $effectiveName, ':t' => $effectiveType, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'Status already exists']);
        }

        if ($name !== null) {
            $fields[] = 'status_name = :n';
            $params[':n'] = $name;
        }
        if ($typeProvided) {
            $fields[] = 'status_type = :t';
            $params[':t'] = $type;
        }
        if ($hasArchivedAt && array_key_exists('archived', $p)) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($p['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        /*
         * A finance band's RANGE is not editable from here, for the same reason
         * one cannot be created here: a boundary belongs to two bands at once,
         * so moving it one row at a time is either refused or leaves a gap.
         * Balance Bands (finance_bands.php) saves the ladder as a whole.
         *
         * The NAME still is editable here, and that is the change worth having:
         * the importer used to match a band by its lowercased name, so renaming
         * "1 to 3K" detached it and sent every balance in that range to NULL.
         * Bands are matched by their range now, so the word is free.
         */
        if ($hasRanges && strcasecmp((string)$effectiveType, 'finance') === 0) {
            if (array_key_exists('range_min', $p) || array_key_exists('range_max', $p)) {
                api_out(409, ['message' =>
                    'Balance ranges are edited in Balance Bands, where both sides of a boundary move together. '
                    . 'Renaming a band here is fine — the ranges decide where a balance goes, not the name.',
                ]);
            }
            if ($archiving) {
                $problems = finance_bands_problems(status_prospective_bands($pdo, null, $id));
                if ($problems) {
                    api_out(422, [
                        'message' => 'Retiring "' . $existing['status_name'] . '" would leave balances with no band: '
                            . $problems[0] . ' Remove it in Balance Bands instead, where the neighbouring band '
                            . 'can be widened in the same save.',
                        'problems' => $problems,
                    ]);
                }
            }
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE status SET ' . implode(', ', $fields) . ' WHERE status_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        $sel = $pdo->prepare("SELECT status_id, status_name, status_type$rangeSelect FROM status WHERE status_id = :id LIMIT 1");
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        api_out(200, ['message' => 'Status updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid status_id is required']);

        /*
         * The row is read before it is archived.
         *
         * This branch used to archive by id without looking at what it was
         * archiving, which is how "Archived" could itself be archived - after
         * which the Users screen's archive button silently stopped working. The
         * same two checks the PUT branch makes apply here, because archiving is
         * the edit that removes a name from the lookups just as surely as
         * renaming it.
         */
        $chk = $pdo->prepare("SELECT status_id, status_name, status_type$rangeSelect FROM status WHERE status_id = :id LIMIT 1");
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Status not found']);

        $guarded = status_guard_edit_refusal($existing, null, null, true);
        if ($guarded !== null) api_out(409, ['message' => $guarded]);

        if ($hasRanges && strcasecmp((string)$existing['status_type'], 'finance') === 0) {
            $problems = finance_bands_problems(status_prospective_bands($pdo, null, $id));
            if ($problems) {
                api_out(422, [
                    'message' => 'Retiring "' . $existing['status_name'] . '" would leave balances with no band: '
                        . $problems[0] . ' Remove it in Balance Bands instead, where the neighbouring band '
                        . 'can be widened in the same save.',
                    'problems' => $problems,
                ]);
            }
        }

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE status SET archived_at = :archived_at WHERE status_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);
        } else {
            $del = $pdo->prepare('DELETE FROM status WHERE status_id = :id');
            $del->execute([':id' => $id]);
        }

        api_out(200, ['message' => 'Status archived']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error']);
}
