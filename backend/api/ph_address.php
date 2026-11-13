<?php
/**
 * The address picker's list source.
 *
 * One question, asked once per step as the student walks down the list: what
 * is inside the place they just chose.
 *
 *   GET ph_address.php              the provinces (and Metro Manila), and how
 *                                   many entries are loaded
 *   GET ph_address.php?parent=CODE  what is inside that place, and its ZIP codes
 *
 * The first step is the province rather than the region, and each Highly
 * Urbanized City - Cagayan de Oro among them - is offered inside the province it
 * sits in on the map. See lib/ph_address.php for why. Below the province there
 * is no fixed ladder: the response says what it returned (`label`) and whether
 * anything is below it (`is_leaf`), and the picker follows, which is what lets
 * Manila have a district step that nowhere else has.
 *
 * Read-only. There is no write path here on purpose: this is a published
 * national list, not something an operator edits one row at a time, and the way
 * it changes is by loading the PSA's newer file with tools/import_psgc.php.
 *
 * Gated on `survey` rather than on a module of its own. It exists to serve the
 * survey's address question, and a module key of its own would start with no
 * permission rows, locking every role out of a list that is less sensitive than
 * anything else on the page — these are place names, published by the
 * government, and a student answering a survey has to be able to read them.
 */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/ph_address.php';

function ph_address_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

try {
    $database = new Database();
    $pdo = $database->connect();

    if (strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        ph_address_out(405, ['message' => 'Method not allowed.']);
    }

    $parent = trim((string)($_GET['parent'] ?? ''));

    // Codes are digits as published. Refusing anything else keeps a stray value
    // out of the query even though it is bound - the list it would return is
    // empty either way, and a 400 says so instead of implying the place has no
    // barangays.
    if ($parent !== '' && !preg_match('/^\d{1,12}$/', $parent)) {
        ph_address_out(400, ['message' => 'That is not an address code.']);
    }

    $options = $parent === '' ? ph_address_provinces($pdo) : ph_address_places_in($pdo, $parent);
    $levels = array_column($options, 'level');

    ph_address_out(200, [
        'data' => [
            'parent' => $parent === '' ? null : $parent,
            // What to call this dropdown, worked out from what came back rather
            // than from a fixed ladder: under Manila it is a district, under
            // every other city a barangay, and the caller cannot know which.
            'label' => ph_address_label_for_levels($levels),
            'options' => $options,
            // No children means this is as deep as the hierarchy goes here, and
            // the picker stops asking. It is not an error and not an empty
            // result to apologise for - it is the bottom.
            'is_leaf' => count($options) === 0,
            // Read once at the top so the picker can decide, before it renders
            // anything, whether to offer dropdowns or a plain text box.
            'entries_loaded' => $parent === '' ? ph_address_count($pdo) : null,
            // The ZIP codes of the place just chosen, so the picker can fill the
            // ZIP box: one for a town (Cagayan de Oro City -> 9000), a list of
            // postal areas for a Metro Manila city, the matching area for a
            // barangay that names one. See ph_address_zip_codes().
            'zip_codes' => $parent === '' ? [] : ph_address_zip_codes($pdo, $parent),
        ],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'ph_address.php']);
    ph_address_out(500, ['message' => 'Could not read the address list.']);
}
