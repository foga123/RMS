<?php
/**
 * Where role and user permissions are kept, now that RBAC does not use the database.
 *
 * The permission tables were never the source of truth for what modules and
 * actions *exist* - `api_rbac_module_catalog_definitions()` and
 * `api_rbac_action_catalog_definitions()` are, and
 * `api_ensure_rbac_permission_catalog()` only copied them into `rbac_module` /
 * `rbac_module_action` so the join tables had numeric ids to point at. The one
 * thing the database really held was the grants: which role may do what, and
 * the per-user deltas on top.
 *
 * Those three functions are no longer in auth.php. They moved to
 * `tools/rbac_migrate_to_file_store.php` on 2026-09-09 with the rest of the
 * catalogue-reading cluster, because that tool became their only caller and
 * auth.php is parsed on every request. Look for them there, not here.
 *
 * Those grants now live in one JSON file under storage/, which is denied over
 * HTTP by storage/.htaccess and read and written only by PHP. Nothing else about
 * the model changed: the same code presets still answer for a role with no saved
 * entry, the same merge decides what a saved entry overrides, and the Access
 * Management panel still saves - it simply writes here instead of to MySQL.
 *
 * Why a file was worth it beyond dropping five tables: the two RBAC outages this
 * project has had were both storage accidents rather than logic bugs. On
 * 2026-07-24 mis-seeded rows locked whole roles out, and on 2026-08-23 a
 * migration that inserted a single row flipped two roles to "configured" and
 * silently dropped their entire preset. Neither is reachable from here. There
 * are no ids to mis-seed, a migration cannot half-write this file, and what a
 * role holds can be read - and diffed - without a SQL client.
 *
 * Shape on disk:
 *
 *   {
 *     "version": 1,
 *     "updated_at": "2026-09-09T17:04:11+08:00",
 *     "roles": { "<role_id>": { "<module_key>": ["view", "edit", ...] } },
 *     "users": { "<user_id>": { "grants": {...}, "restrictions": {...} } }
 *   }
 *
 * A role key that is absent means "not configured" - the code preset answers in
 * full. A role key that is present is authoritative for every storable module,
 * which is the same rule the tables had, kept deliberately so this change moves
 * the storage and nothing else.
 */

/** The store file. Under storage/, which .htaccess denies over HTTP. */
function api_rbac_store_path(): string
{
    return dirname(__DIR__, 2) . '/storage/rbac/permissions.json';
}

/**
 * The parsed store, cached for the request.
 *
 * The cache lives in a static that `$forget` can clear, because a save followed
 * by a re-read happens on every panel write - `api_store_role_permissions_map()`
 * returns the freshly stored record - and a stale copy there is the difference
 * between a save that appears to work and one that does.
 */
function api_rbac_store_read(bool $forget = false): array
{
    static $cache = null;

    if ($forget) {
        $cache = null;
        return ['version' => 1, 'roles' => [], 'users' => []];
    }
    if ($cache !== null) {
        return $cache;
    }

    $path = api_rbac_store_path();
    if (!is_file($path)) {
        // The normal state on a fresh install: nothing configured, every role
        // answered by its code preset.
        return $cache = ['version' => 1, 'roles' => [], 'users' => []];
    }

    $raw = file_get_contents($path);
    if ($raw === false) {
        throw new RuntimeException('The RBAC permission store could not be read: ' . $path);
    }

    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) {
        /*
         * Deliberately fatal rather than falling back to an empty store.
         * Treating unreadable permissions as "nothing configured" would hand
         * every role its preset and look like a clean boot - which is precisely
         * how the 2026-07-24 lockout presented, and why it took a day to find.
         */
        throw new RuntimeException('The RBAC permission store is not valid JSON: ' . $path);
    }

    return $cache = [
        'version' => (int)($decoded['version'] ?? 1),
        'roles'   => is_array($decoded['roles'] ?? null) ? $decoded['roles'] : [],
        'users'   => is_array($decoded['users'] ?? null) ? $decoded['users'] : [],
    ];
}

/** Drop the cached copy so the next read comes from disk. */
function api_rbac_store_reset_cache(): void
{
    api_rbac_store_read(true);
}

/**
 * Replace the store on disk.
 *
 * Written to a temporary file in the same directory and renamed over the target,
 * so a reader never sees a half-written file and a crash mid-write leaves the
 * previous permissions intact rather than an empty object that would lock
 * everyone out.
 */
function api_rbac_store_write(array $store): void
{
    $path = api_rbac_store_path();
    $dir  = dirname($path);
    if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException('The RBAC permission store directory could not be created: ' . $dir);
    }

    $payload = [
        'version'    => 1,
        'updated_at' => date('c'),
        // Cast so an empty set encodes as {} and not [] - the file is read back
        // as a map, and an array there would fail the is_array key lookups.
        'roles'      => (object)($store['roles'] ?? []),
        'users'      => (object)($store['users'] ?? []),
    ];

    $json = json_encode($payload, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES);
    if ($json === false) {
        throw new RuntimeException('The RBAC permissions could not be encoded as JSON.');
    }

    $tmp = $path . '.' . bin2hex(random_bytes(6)) . '.tmp';
    if (file_put_contents($tmp, $json, LOCK_EX) === false) {
        throw new RuntimeException('The RBAC permission store could not be written: ' . $tmp);
    }
    if (!@rename($tmp, $path)) {
        @unlink($tmp);
        throw new RuntimeException('The RBAC permission store could not be replaced: ' . $path);
    }

    api_rbac_store_reset_cache();
}

/**
 * What one role has saved, in the app's module => actions shape.
 *
 * Returns the same two keys the table-backed snapshot returned, so everything
 * upstream - the merge with the code presets included - is untouched.
 */
function api_rbac_store_role_snapshot(int $roleId): array
{
    if ($roleId <= 0) {
        return ['permissions' => [], 'has_saved_permissions' => false];
    }

    $store = api_rbac_store_read();
    $entry = $store['roles'][(string)$roleId] ?? null;

    if (!is_array($entry)) {
        return ['permissions' => [], 'has_saved_permissions' => false];
    }

    return [
        'permissions' => api_normalize_permissions_map($entry),
        /*
         * Present at all means configured, even when every module is empty. An
         * administrator who unticks everything has made a choice, and it has to
         * survive a reload rather than silently reverting to the preset.
         */
        'has_saved_permissions' => true,
    ];
}

/** Save one role's map. An empty map still marks the role configured. */
function api_rbac_store_save_role(int $roleId, array $permissions): void
{
    if ($roleId <= 0) {
        return;
    }

    $store = api_rbac_store_read();
    $store['roles'][(string)$roleId] = api_normalize_permissions_map($permissions);
    api_rbac_store_write($store);
}

/** Forget a role's saved map, handing it back to the code preset. */
function api_rbac_store_clear_role(int $roleId): void
{
    $store = api_rbac_store_read();
    unset($store['roles'][(string)$roleId]);
    api_rbac_store_write($store);
}

/** One user's delta, as grants and restrictions relative to their role. */
function api_rbac_store_user_delta(int $userId): array
{
    if ($userId <= 0) {
        return ['grants' => [], 'restrictions' => []];
    }

    $store = api_rbac_store_read();
    $entry = $store['users'][(string)$userId] ?? null;
    if (!is_array($entry)) {
        return ['grants' => [], 'restrictions' => []];
    }

    return [
        'grants'       => api_normalize_permissions_map($entry['grants'] ?? []),
        'restrictions' => api_normalize_permissions_map($entry['restrictions'] ?? []),
    ];
}

/**
 * Save one user's delta, or remove it when there is nothing left to say.
 *
 * An empty delta deletes the entry rather than storing two empty maps, so
 * "this user is exactly their role" has one representation instead of two.
 */
function api_rbac_store_save_user_delta(int $userId, array $grants, array $restrictions): void
{
    if ($userId <= 0) {
        return;
    }

    $grants = api_normalize_permissions_map($grants);
    $restrictions = api_normalize_permissions_map($restrictions);

    $store = api_rbac_store_read();
    if (empty($grants) && empty($restrictions)) {
        unset($store['users'][(string)$userId]);
    } else {
        $store['users'][(string)$userId] = [
            'grants'       => $grants,
            'restrictions' => $restrictions,
        ];
    }
    api_rbac_store_write($store);
}

/** Every user id carrying a delta - for the "has custom access" badges. */
function api_rbac_store_user_ids_with_overrides(): array
{
    $store = api_rbac_store_read();
    return array_map('intval', array_keys($store['users'] ?? []));
}
