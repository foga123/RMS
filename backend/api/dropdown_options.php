<?php
/**
 * The choices a form offers, for any signed-in user.
 *
 *   GET ?lists=genders,scholarship_grants,modalities
 *     -> {options: {genders: [{value, label}], ...},
 *         defaults: {modalities: "Flex"}}   what a blank field becomes
 *
 * Separate from dropdown_list.php on purpose. That endpoint is the management
 * screen and is gated by the dropdown_lists module; this one serves the SAME
 * lists to the forms that pick from them - a registrar editing a student has
 * no business managing the grant list, but has every need to see it. Only
 * active entries, only value and label: what a <select> needs, nothing about
 * usage or who changed what.
 *
 * No module, so api_require_auth() admits any authenticated account. The
 * lists are vocabulary, not records - nothing here names a student.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/dropdown_lists.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

try {
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $requested = trim((string)($_GET['lists'] ?? ''));
    $keys = $requested === ''
        ? array_keys(dropdown_list_definitions())
        : array_values(array_unique(array_filter(array_map('trim', explode(',', $requested)))));

    $pdo = (new Database())->connect();
    $options = [];
    $defaults = [];
    foreach ($keys as $key) {
        $options[$key] = dropdown_list_options($pdo, $key);
        $default = dropdown_list_default($key);
        if ($default !== null) {
            $defaults[$key] = $default;
        }
    }

    api_json_response(200, ['options' => $options, 'defaults' => $defaults]);
} catch (DropdownListError $e) {
    api_json_response($e->status, ['message' => $e->getMessage()]);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'dropdown_options.php']);
    api_json_response(500, ['message' => 'Server error']);
}
