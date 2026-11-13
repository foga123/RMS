<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

// Auth bootstraps on include. This endpoint maps to the `finance_management`
// module, so the caller needs finance_management:create — see
// api_endpoint_module_map().
require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/periodic_lib.php';
require_once __DIR__ . '/lib/spreadsheet_import.php';
// Supplies the term when the uploader did not name one.
require_once __DIR__ . '/lib/academic_calendar.php';
require_once __DIR__ . '/lib/term_closure.php';
// The balance bands, read from `status` rather than hardcoded here.
require_once __DIR__ . '/lib/finance_bands.php';

function financeimport_out($code, $payload) {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * Header spellings accepted for each field.
 *
 * As generous as the grades importer, and for the same reason: these files come
 * out of the cashier's system with the balance column named a different thing
 * every term, and a rejected import that will not say which header was wrong is
 * the worst possible outcome.
 */
function financeimport_header_map(): array {
    return [
        'studentid' => 'student_id',
        'studentnumber' => 'student_id',
        'studentno' => 'student_id',
        'idnumber' => 'student_id',
        'balance' => 'amount',
        'balancetodate' => 'amount',
        'balancetodata' => 'amount',
        'outstandingbalance' => 'amount',
        'amount' => 'amount',
        'amountdue' => 'amount',
        'totalbalance' => 'amount',
        'accountbalance' => 'amount',
        'date' => 'date',
        'asof' => 'date',
        'asofdate' => 'date',
        'balancedate' => 'date',
        // The office's template (latest.xlsx, 2026-10-06) carries the band as a
        // third column, "S2 Balance Range". Read so it can be CHECKED, never
        // obeyed: the band is always worked out from the amount, because two
        // sources for one fact disagree sooner or later. S1 and Summer are the
        // same column on another semester's file.
        'balancerange' => 'range',
        's1balancerange' => 'range',
        's2balancerange' => 'range',
        'summerbalancerange' => 'range',
    ];
}

/** A band name reduced to what identifies it: "7.5K and up" and "7.5K and Up" are one band. */
function financeimport_range_key(string $value): string {
    return preg_replace('/[^a-z0-9.]/', '', strtolower($value));
}

/**
 * Parse a money cell into a float.
 *
 * Handles what actually turns up in these exports: thousands separators, a peso
 * sign, stray spaces, and accounting-style negatives written as "(1,234.00)".
 * Returns null when the cell is not a number at all, which the caller reports as
 * an invalid row rather than silently importing a zero.
 */
function financeimport_to_amount(string $value): ?float {
    $clean = trim($value);
    if ($clean === '') return null;

    $negative = (bool)preg_match('/^\(.*\)$/', $clean);
    $clean = preg_replace('/[^0-9.\-]/', '', $clean);
    if ($clean === '' || $clean === '-' || $clean === '.') return null;
    if (substr_count($clean, '.') > 1) return null;

    $amount = (float)$clean;
    return $negative ? -abs($amount) : $amount;
}

/**
 * The balance tier a given amount falls into, as a `status` row id.
 *
 * The tiers are the active finance statuses, which by default are the bands the
 * RETENTION & MIGRATION sheet uses: No Balance / 1 to 3K / 3K to 5K /
 * 5K to 7.5K / 7.5K and Up.
 *
 * The cut-offs are NOT written here any more. They live on the rows themselves
 * as range_min / range_max, are edited in Status Management, and are read by
 * finance_bands_load() - which pdo_balance_band() reads too, so the Finance
 * module and the priority list cannot disagree about where a balance sits.
 *
 * They disagreed for real once: the importer split at 3,000 and 10,000 while
 * the sheet split at 3,000, 5,000 and 7,500, so a student owing 9,962 read as
 * "3k Above" in Finance and "7.5K and Up" on the list they were called from.
 * That is now impossible by construction rather than by two copies agreeing;
 * tests/finance_band_parity_check.php still checks it.
 *
 * Matched by range rather than by name, which is the point of the change: the
 * old lookup keyed on the lowercased status name, so renaming a band in Status
 * Management detached it and every balance in its range imported as NULL. A
 * balance the ladder does not cover still yields null, which stores as NULL
 * exactly like a hand-entered record with no tier does.
 */
function financeimport_tier_id(float $amount, array $bands): ?int {
    $band = finance_band_for($amount, $bands);
    return $band === null ? null : ($band['status_id'] ?? null);
}

try {
    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();

    if (($_SERVER['REQUEST_METHOD'] ?? 'POST') !== 'POST') {
        financeimport_out(405, ['message' => 'Method not allowed']);
    }

    foreach (['student', 'finance', 'semester', 'school_year', 'status'] as $table) {
        api_require_table($pdo, $table);
    }

    // --- Validate the target term ---
    /*
     * Which term these rows are filed under.
     *
     * Resolved and validated in one call: what the uploader sent wins, a blank
     * falls through to the Academic Calendar, and anything unusable comes back
     * as a sentence rather than a thrown error. All three imports share this —
     * they each used to carry their own copy, which is three places for the
     * same rule to drift.
     */
    ['term' => $term, 'error' => $termError] = academic_calendar_resolve_import_term($pdo, $_POST, true);
    if ($termError !== null) {
        financeimport_out(400, ['message' => $termError]);
    }
    $schoolYearId = $term['school_year_id'];
    $semesterId   = $term['semester_id'];
    $period       = $term['period'];

    // A closed semester takes no new balances and no overwrites.
    $closedTerm = term_closure_block($pdo, [$schoolYearId, $semesterId]);
    if ($closedTerm !== null) {
        financeimport_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);
    }

    // --- Read and parse the upload ---
    [$content, $uploadError] = sheetimport_read_upload($_FILES['file'] ?? null);
    if ($uploadError !== null) {
        financeimport_out(400, ['message' => $uploadError]);
    }

    $rows = sheetimport_parse($content);
    if (count($rows) < 2) {
        financeimport_out(400, ['message' => 'The file has no data rows. Expected a header row plus at least one student row.']);
    }

    // Only the student and the balance are required. The date defaults to today
    // and the tier is derived, so a two-column file imports cleanly.
    [$headerRowIndex, $columnMap] = sheetimport_locate_header(
        $rows,
        financeimport_header_map(),
        ['student_id', 'amount']
    );

    if ($headerRowIndex === null) {
        financeimport_out(400, [
            'message' => 'Could not find the required columns. The file must have headers: Student Number and Balance to Date. S2 Balance Range and Date are optional.',
        ]);
    }

    // --- Preload lookups ---
    $studentStmt = $pdo->query('SELECT student_id, student_number, `star e-profile` AS student_type FROM student');
    $byNumber = [];
    $byId = [];
    $typeById = [];
    foreach ($studentStmt->fetchAll(PDO::FETCH_ASSOC) as $s) {
        $sid = (int)$s['student_id'];
        $num = strtolower(trim((string)$s['student_number']));
        if ($num !== '') {
            $byNumber[$num] = $sid;
        }
        $byId[(string)$sid] = $sid;
        $typeById[$sid] = $s['student_type'] ?? null;
    }

    /*
     * The bands in force, loaded once for the whole file rather than per row.
     *
     * Active bands only - the three superseded ones are archived rather than
     * deleted, and an import must not file a new balance under a retired band.
     * finance_bands_load() applies that filter, and falls back to the built-in
     * ladder if the thresholds have not been migrated in yet.
     */
    $balanceBands = finance_bands_load($pdo);

    $existingStmt = $pdo->prepare(
        'SELECT student_id FROM finance
          WHERE semester_id = :sem AND school_year_id = :yr AND COALESCE(period, 0) = :period_key'
    );
    $existingStmt->execute([':sem' => $semesterId, ':yr' => $schoolYearId, ':period_key' => $period ?? 0]);
    $existingIds = [];
    foreach ($existingStmt->fetchAll(PDO::FETCH_COLUMN) as $eid) {
        $existingIds[(int)$eid] = true;
    }

    // --- Process data rows ---
    $inserted = 0;
    $updated = 0;
    $processedTotal = 0;
    $unmatched = [];
    $invalid = [];
    $negatives = [];
    $duplicates = [];
    $rangeMismatches = [];
    $rangeMismatchCount = 0;
    $skippedByScope = 0;
    $seenStudentIds = [];

    // Relies on uq_finance_student_term_period (student_id, school_year_id,
    // semester_id, period_key), which replaced the narrower key on 2026-08-21.
    // Without a unique key this would insert a second row per student instead of
    // updating the first; without period_key in it, importing P2 would overwrite
    // the student's P1 balance rather than record a second reading.
    $upsert = new SheetImportBatchWriter(
        $pdo,
        'finance',
        ['student_id', 'semester_id', 'school_year_id', 'period', 'balance_to_data', 'balance_range', '`date`'],
        'balance_to_data = VALUES(balance_to_data),
         balance_range   = VALUES(balance_range),
         `date`          = VALUES(`date`)'
    );

    $pdo->beginTransaction();

    $today = date('Y-m-d');
    $dataRows = array_slice($rows, $headerRowIndex + 1, SHEETIMPORT_MAX_ROWS, true);
    foreach ($dataRows as $row) {
        $cell = static function (string $field) use ($row, $columnMap): string {
            return isset($columnMap[$field]) ? trim((string)($row[$columnMap[$field]] ?? '')) : '';
        };

        $idToken = $cell('student_id');
        $amountRaw = $cell('amount');

        if ($idToken === '' && $amountRaw === '') {
            continue; // blank spacer line
        }
        $processedTotal++;

        $lookup = strtolower($idToken);
        $studentId = $byNumber[$lookup] ?? ($byId[$idToken] ?? null);
        if ($studentId === null) {
            if (count($unmatched) < SHEETIMPORT_SAMPLE_LIMIT) $unmatched[] = $idToken;
            continue;
        }

        // A Star/Nonstar-scoped role must not write balances for the other cohort.
        if (!api_student_type_is_allowed($authUser, $typeById[$studentId] ?? null)) {
            $skippedByScope++;
            continue;
        }

        $amount = financeimport_to_amount($amountRaw);
        if ($amount === null) {
            if (count($invalid) < SHEETIMPORT_SAMPLE_LIMIT) $invalid[] = $idToken;
            continue;
        }

        // A credit balance is reported rather than rejected: it is unusual but
        // real, and dropping the row would hide it.
        if ($amount < 0 && count($negatives) < SHEETIMPORT_SAMPLE_LIMIT) {
            $negatives[] = "$idToken ($amountRaw)";
        }

        $dateRaw = $cell('date');
        $date = $today;
        if ($dateRaw !== '') {
            $timestamp = strtotime($dateRaw);
            if ($timestamp === false) {
                if (count($invalid) < SHEETIMPORT_SAMPLE_LIMIT) $invalid[] = $idToken;
                continue;
            }
            $date = date('Y-m-d', $timestamp);
        }

        if (isset($seenStudentIds[$studentId]) && count($duplicates) < SHEETIMPORT_SAMPLE_LIMIT) {
            $duplicates[] = $idToken;
        }
        $wasExisting = isset($existingIds[$studentId]) || isset($seenStudentIds[$studentId]);
        $seenStudentIds[$studentId] = true;

        // The file's own band, when it has one, against the band the amount
        // falls in. The row still imports by the amount; the disagreement is
        // reported so whoever made the sheet can see which side is wrong.
        $band = finance_band_for($amount, $balanceBands);
        $rangeRaw = $cell('range');
        if ($rangeRaw !== '' && ($band === null || financeimport_range_key($rangeRaw) !== financeimport_range_key((string)$band['label']))) {
            $rangeMismatchCount++;
            if (count($rangeMismatches) < SHEETIMPORT_SAMPLE_LIMIT) {
                $rangeMismatches[] = sprintf('%s: file says "%s", but %s falls in "%s"', $idToken, $rangeRaw, number_format($amount, 2), $band['label'] ?? 'no band');
            }
        }

        $upsert->add([
            $studentId,
            $semesterId,
            $schoolYearId,
            $period,
            $amount,
            financeimport_tier_id($amount, $balanceBands),
            $date,
        ]);

        if ($wasExisting) {
            $updated++;
        } else {
            $inserted++;
        }
    }

    // Whatever is still buffered has to land before the transaction closes.
    $upsert->flush();
    $pdo->commit();

    $summary = [
        'rows_read' => $processedTotal,
        'imported' => $inserted + $updated,
        'inserted' => $inserted,
        'updated' => $updated,
        'unmatched' => count($unmatched),
        'invalid' => count($invalid),
        'negatives' => count($negatives),
        'duplicates' => count($duplicates),
        'range_mismatches' => $rangeMismatchCount,
        'skipped_out_of_scope' => $skippedByScope,
    ];

    // After the commit, so the log records an import that actually landed.
    api_audit_import(
        $pdo,
        $authUser,
        'finance',
        (string)($_FILES['file']['name'] ?? ''),
        $summary,
        api_term_label($pdo, $semesterId, $schoolYearId, $period)
    );

    financeimport_out(200, [
        'message' => 'Import complete.',
        'summary' => $summary,
        'details' => [
            'unmatched_student_ids' => $unmatched,
            'invalid_student_ids' => $invalid,
            'negative_balances' => $negatives,
            'duplicate_student_ids' => array_values(array_unique($duplicates)),
            'range_mismatches' => $rangeMismatches,
        ],
        'term' => [
            'semester_id' => $semesterId,
            'school_year_id' => $schoolYearId,
            'period' => $period,
            'period_label' => api_period_label($period),
        ],
    ]);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    api_log_exception($e, ['scope' => 'finance_import']);
    financeimport_out(500, ['message' => 'Server error while importing finance balances.']);
}
