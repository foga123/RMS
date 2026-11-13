<?php
/**
 * Dropdown Management: read and edit the lists described in
 * lib/dropdown_lists.php.
 *
 *   GET                       the lists, with counts, and what the caller may do
 *   GET  ?list=KEY            one list's entries, archived included, with usage
 *   POST ?list=KEY            add an entry        {text, group?, flags?}
 *   PUT  ?list=KEY            one of:
 *        {action: "update",  id, text?, group?, flags?}
 *        {action: "archive", id}   {action: "restore", id}
 *        {action: "reorder", ids: [...every active id, in the new order]}
 *
 * ── ACCESS ──────────────────────────────────────────────────────────────────
 *
 * The dropdown_lists RBAC module, granted per role or per user on Access
 * Management like any other. api_bootstrap_auth() lets a request in if the
 * caller holds ANY action that could apply to its verb (see
 * api_endpoint_permission_target_overrides()); this file then checks the one
 * action the request actually performs, so holding `archive` does not let
 * anyone reword an entry.
 *
 * settings:edit is accepted beside each action, as it is for the Academic
 * Calendar: a module key is born with no grants anywhere, and without it an
 * installation would have nobody able to open this screen - including the
 * administrator meant to grant it. Only Admin holds settings:edit.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/dropdown_lists.php';

api_send_headers(['GET', 'POST', 'PUT', 'OPTIONS']);
api_handle_preflight();

/** Which dropdown_lists actions this caller holds, for the checks and the screen. */
function dropdown_list_caller_permissions(array $permissions): array
{
    $result = [];
    foreach (['view', 'create', 'edit', 'archive', 'restore'] as $action) {
        $result[$action] = api_can_any($permissions, [
            ['module' => 'dropdown_lists', 'action' => $action],
            ['module' => 'settings', 'action' => $action === 'view' ? 'view' : 'edit'],
        ]);
    }

    return $result;
}

function dropdown_list_require(array $can, string $action, string $message): void
{
    if (empty($can[$action])) {
        api_json_response(403, ['message' => $message]);
    }
}

/** The list's description as the screen needs it - no table or column names. */
function dropdown_list_public_meta(PDO $pdo, string $listKey): array
{
    $def = dropdown_list_definition($listKey);
    $rows = dropdown_list_rows($pdo, $listKey);
    $active = count(array_filter($rows, static fn(array $r): bool => $r['active']));

    return [
        'key' => $listKey,
        'label' => $def['label'],
        'noun' => $def['noun'],
        'used_by' => $def['used_by'],
        // What the screen may offer: a key-shaped entry keeps its code when
        // renamed, a name-shaped one renames every record that holds it.
        'shape' => $def['shape'],
        'max_length' => (int)$def['max_length'],
        'group' => $def['group'] !== null
            ? ['label' => $def['group']['label'], 'max_length' => (int)$def['group']['max_length']]
            : null,
        'flags' => $def['flags'],
        'counts' => ['active' => $active, 'archived' => count($rows) - $active],
    ];
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $pdo = (new Database())->connect();
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $permissionRecord = api_fetch_effective_permissions_record(
        $pdo,
        (int)($authUser['role_id'] ?? 0),
        (int)($authUser['user_id'] ?? 0)
    );
    $can = dropdown_list_caller_permissions($permissionRecord['permissions'] ?? []);
    dropdown_list_require($can, 'view', 'You do not have permission to view dropdown lists.');

    $listKey = trim((string)($_GET['list'] ?? ''));

    if ($method === 'GET') {
        if ($listKey === '') {
            api_json_response(200, [
                'lists' => array_map(
                    static fn(string $key): array => dropdown_list_public_meta($pdo, $key),
                    array_keys(dropdown_list_definitions())
                ),
                'permissions' => $can,
            ]);
        }

        $usage = dropdown_list_usage($pdo, $listKey);
        $items = array_map(static function (array $row) use ($usage): array {
            return $row + ['in_use' => (int)($usage[$row['id']] ?? 0)];
        }, dropdown_list_rows($pdo, $listKey));

        api_json_response(200, [
            'list' => dropdown_list_public_meta($pdo, $listKey),
            'items' => $items,
            'permissions' => $can,
        ]);
    }

    if ($listKey === '') {
        api_json_response(400, ['message' => 'Which list? Send ?list=.']);
    }
    $def = dropdown_list_definition($listKey);
    $payload = api_read_json_body();

    if ($method === 'POST') {
        dropdown_list_require($can, 'create', 'You do not have permission to add to dropdown lists.');
        $item = dropdown_list_create($pdo, $listKey, $payload);
        api_write_audit_log($pdo, $authUser, 'dropdown_list_created', sprintf(
            'Added "%s" to %s.',
            $item['text'],
            $def['label']
        ), ['list' => $listKey, 'item' => $item]);
        api_json_response(201, ['message' => ucfirst($def['noun']) . ' added.', 'item' => $item]);
    }

    if ($method === 'PUT') {
        $action = strtolower(trim((string)($payload['action'] ?? 'update')));

        if ($action === 'reorder') {
            dropdown_list_require($can, 'edit', 'You do not have permission to reorder dropdown lists.');
            $ids = is_array($payload['ids'] ?? null) ? $payload['ids'] : [];
            dropdown_list_reorder($pdo, $listKey, $ids);
            api_write_audit_log($pdo, $authUser, 'dropdown_list_reordered', sprintf('Reordered %s.', $def['label']), [
                'list' => $listKey,
                'order' => array_values($ids),
            ]);
            api_json_response(200, ['message' => $def['label'] . ' reordered.']);
        }

        if (!array_key_exists('id', $payload)) {
            api_json_response(400, ['message' => 'Which ' . $def['noun'] . '? Send its id.']);
        }

        if ($action === 'archive' || $action === 'restore') {
            dropdown_list_require($can, $action, 'You do not have permission to ' . $action . ' dropdown entries.');
            [$before, $after] = dropdown_list_set_active($pdo, $listKey, $payload['id'], $action === 'restore');
            if ($before['active'] !== $after['active']) {
                api_write_audit_log($pdo, $authUser, 'dropdown_list_' . ($action === 'restore' ? 'restored' : 'archived'), sprintf(
                    '%s "%s" in %s.',
                    $action === 'restore' ? 'Restored' : 'Archived',
                    $after['text'],
                    $def['label']
                ), ['list' => $listKey, 'id' => $after['id']]);
            }
            api_json_response(200, [
                'message' => ucfirst($def['noun']) . ($action === 'restore' ? ' restored.' : ' archived.'),
                'item' => $after,
            ]);
        }

        if ($action !== 'update') {
            api_json_response(400, ['message' => 'Unknown action "' . $action . '".']);
        }

        dropdown_list_require($can, 'edit', 'You do not have permission to edit dropdown lists.');
        [$before, $after] = dropdown_list_update($pdo, $listKey, $payload['id'], $payload);
        if ($before !== $after) {
            $detail = $before['text'] !== $after['text']
                ? sprintf('Renamed "%s" to "%s" in %s.', $before['text'], $after['text'], $def['label'])
                : sprintf('Edited "%s" in %s.', $after['text'], $def['label']);
            api_write_audit_log($pdo, $authUser, 'dropdown_list_updated', $detail, [
                'list' => $listKey,
                'before' => $before,
                'after' => $after,
            ]);
        }
        api_json_response(200, ['message' => ucfirst($def['noun']) . ' saved.', 'item' => $after]);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (DropdownListError $e) {
    api_json_response($e->status, ['message' => $e->getMessage()]);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'dropdown_list.php', 'method' => $_SERVER['REQUEST_METHOD'] ?? '']);
    api_json_response(500, ['message' => 'Server error']);
}
