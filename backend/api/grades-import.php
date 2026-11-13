<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

// Auth bootstraps on include. This endpoint maps to the `grades` module, so the
// caller needs grades:create — see api_endpoint_module_map().
require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/periodic_lib.php';
require_once __DIR__ . '/lib/spreadsheet_import.php';
// Supplies the term when the uploader did not name one.
require_once __DIR__ . '/lib/academic_calendar.php';
require_once __DIR__ . '/lib/term_closure.php';
require_once __DIR__ . '/grade_remark_service.php';

function gradeimport_out($code, $payload) {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * Header spellings accepted for each field.
 *
 * Deliberately generous: these files come out of registrar exports that label
 * the same column half a dozen ways, and a rejected import with no indication
 * of which header was wrong is the worst outcome.
 */
function gradeimport_header_map(): array {
    return [
        'studentid' => 'student_id',
        'studentnumber' => 'student_id',
        'studentno' => 'student_id',
        'idnumber' => 'student_id',
        'totalsubject' => 'total_subject',
        'totalsubjects' => 'total_subject',
        'subjects' => 'total_subject',
        'totalunits' => 'total_subject',
        'total' => 'total_subject',
        'passed' => 'passed',
        'passedsubjects' => 'passed',
        'failed' => 'failed',
        'failedsubjects' => 'failed',
        'incomplete' => 'incomplete',
        'inc' => 'incomplete',
        'nocredit' => 'no_credit',
        'nc' => 'no_credit',
        'nograde' => 'no_grade',
        'ng' => 'no_grade',
        'remarks' => 'remarks',
        'remark' => 'remarks',
        'academicremark' => 'remarks',
    ];
}

/*
 * The remark a row implies used to be decided here, by gradeimport_auto_remark()
 * -- a hardcoded ladder whose own docblock recorded the problem with it: it
 * "mirrors autoRemarkFromBreakdown() in GradesPage.jsx ... If that rule changes,
 * both have to move together." Two copies of a rule nobody could edit without a
 * code change, which is what grade_remark_service.php now replaces.
 *
 * The seeded policy reproduces that ladder exactly, verified across every
 * combination of the five counts, so imports land on the same remarks they
 * always did until somebody deliberately edits the policy.
 */

try {
    $db = new Database();
    $pdo = $db->connect();
    $authUser = api_get_session_user();

    if (($_SERVER['REQUEST_METHOD'] ?? 'POST') !== 'POST') {
        gradeimport_out(405, ['message' => 'Method not allowed']);
    }

    foreach (['student', 'grades', 'semester', 'school_year'] as $table) {
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
        gradeimport_out(400, ['message' => $termError]);
    }
    $schoolYearId = $term['school_year_id'];
    $semesterId   = $term['semester_id'];
    $period       = $term['period'];

    // A closed semester takes no new rows and no overwrites. Asked before the
    // file is read, so the refusal names the term rather than a row.
    $closedTerm = term_closure_block($pdo, [$schoolYearId, $semesterId]);
    if ($closedTerm !== null) {
        gradeimport_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);
    }

    // --- Read and parse the upload ---
    [$content, $uploadError] = sheetimport_read_upload($_FILES['file'] ?? null);
    if ($uploadError !== null) {
        gradeimport_out(400, ['message' => $uploadError]);
    }

    $rows = sheetimport_parse($content);
    if (count($rows) < 2) {
        gradeimport_out(400, ['message' => 'The file has no data rows. Expected a header row plus at least one student row.']);
    }

    // Only the student and the subject count are required. Passed and the
    // academic remark are derived below exactly as the Add Grade form derives
    // them, so a file carrying just the problem counts imports correctly.
    [$headerRowIndex, $columnMap] = sheetimport_locate_header(
        $rows,
        gradeimport_header_map(),
        ['student_id', 'total_subject']
    );

    if ($headerRowIndex === null) {
        gradeimport_out(400, [
            'message' => 'Could not find the required columns. The file must have headers: Student ID and Total Subject. Passed, Failed, Incomplete, No Credit, No Grade and Remarks are optional.',
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

    $hasRemarkColumn = false;
    $remarkIdByName = [];
    try {
        $remarkCheck = $pdo->query("SHOW COLUMNS FROM `grades` LIKE 'remark_id'");
        $hasRemarkColumn = (bool)$remarkCheck->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $ignored) {
        $hasRemarkColumn = false;
    }
    if ($hasRemarkColumn) {
        foreach ($pdo->query('SELECT remark_id, remark_name FROM remarks')->fetchAll(PDO::FETCH_ASSOC) as $r) {
            $remarkIdByName[strtolower(trim((string)$r['remark_name']))] = (int)$r['remark_id'];
        }
    }

    /*
     * The policy for the term being imported into, loaded once for the file.
     *
     * Empty for a school year that has already finished, which is what stops an
     * import from restating remarks on a closed year. A sheet that carries its
     * own Remarks column still sets them there -- that is somebody stating a
     * value explicitly, not a policy reaching backwards.
     */
    $policyRules = [];
    if ($hasRemarkColumn && grade_remark_year_is_open($pdo, $schoolYearId)) {
        $policy = grade_remark_get_policy($pdo, $schoolYearId);
        $policyRules = $policy['rules'] ?? [];
    }

    $existingStmt = $pdo->prepare(
        'SELECT student_id FROM grades
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
    $warnings = [];
    $overTotal = [];
    $overTotalCount = 0;
    $duplicates = [];
    $skippedByScope = 0;
    $seenStudentIds = [];

    // passed_of_subject is intentionally omitted: grades.php derives it in every
    // SELECT from passed/total_subject, and writing it here would create a second
    // copy free to disagree with the first.
    $columns = ['student_id', 'semester_id', 'school_year_id', 'period', 'total_subject', 'passed', 'failed', 'incomplete', 'no_credit', 'no_grade'];
    $updates = 'total_subject = VALUES(total_subject), passed = VALUES(passed), failed = VALUES(failed),
                incomplete = VALUES(incomplete), no_credit = VALUES(no_credit), no_grade = VALUES(no_grade)';
    if ($hasRemarkColumn) {
        $columns[] = 'remark_id';
        /*
         * COALESCE, not a plain assignment: a null must never erase a remark.
         *
         * A re-import now produces a null remark in two ordinary situations --
         * the term belongs to a closed school year, where the policy stays
         * silent by design, and no rule matched. With `= VALUES(remark_id)`
         * either one would blank a remark that is already recorded, so
         * correcting a typo in a closed year's spreadsheet would strip the
         * remarks off every row it touched. Nothing in the response would say so.
         *
         * The trade is that an import can no longer clear a remark by leaving
         * the column empty, which was never a way anyone asked for.
         */
        $updates .= ', remark_id = COALESCE(VALUES(remark_id), remark_id)';
    }

    $upsert = new SheetImportBatchWriter($pdo, 'grades', $columns, $updates);

    $pdo->beginTransaction();

    $dataRows = array_slice($rows, $headerRowIndex + 1, SHEETIMPORT_MAX_ROWS, true);
    foreach ($dataRows as $row) {
        $cell = static function (string $field) use ($row, $columnMap): string {
            return isset($columnMap[$field]) ? trim((string)($row[$columnMap[$field]] ?? '')) : '';
        };

        $idToken = $cell('student_id');
        $totalRaw = $cell('total_subject');
        $passedRaw = $cell('passed');

        if ($idToken === '' && $totalRaw === '' && $passedRaw === '') {
            continue; // blank spacer line
        }
        $processedTotal++;

        $lookup = strtolower($idToken);
        $studentId = $byNumber[$lookup] ?? ($byId[$idToken] ?? null);
        if ($studentId === null) {
            if (count($unmatched) < SHEETIMPORT_SAMPLE_LIMIT) $unmatched[] = $idToken;
            continue;
        }

        // A Star/Nonstar-scoped role must not write grades for the other cohort.
        if (!api_student_type_is_allowed($authUser, $typeById[$studentId] ?? null)) {
            $skippedByScope++;
            continue;
        }

        $total = sheetimport_to_int($totalRaw);
        $failed = $cell('failed') === '' ? 0 : sheetimport_to_int($cell('failed'));
        $incomplete = $cell('incomplete') === '' ? 0 : sheetimport_to_int($cell('incomplete'));
        $noCredit = $cell('no_credit') === '' ? 0 : sheetimport_to_int($cell('no_credit'));
        $noGrade = $cell('no_grade') === '' ? 0 : sheetimport_to_int($cell('no_grade'));

        $numbers = [$total, $failed, $incomplete, $noCredit, $noGrade];
        $anyBad = false;
        foreach ($numbers as $n) {
            if ($n === null || $n < 0) { $anyBad = true; break; }
        }
        if ($anyBad) {
            if (count($invalid) < SHEETIMPORT_SAMPLE_LIMIT) $invalid[] = $idToken;
            continue;
        }

        // Same rule as withAutoComputedFields() on the Add Grade form: passed is
        // whatever is left after the problem counts, unless the file states it.
        $deductions = $failed + $incomplete + $noCredit + $noGrade;
        if ($passedRaw === '') {
            $passed = max(0, $total - $deductions);
        } else {
            $passed = sheetimport_to_int($passedRaw);
            if ($passed === null || $passed < 0) {
                if (count($invalid) < SHEETIMPORT_SAMPLE_LIMIT) $invalid[] = $idToken;
                continue;
            }
        }

        /*
         * The student's own total is the cap. Over it, the row is refused and
         * named, and the rest of the file still imports - it used to be saved
         * "anyway", which put a pass rate like 125% on screen. Under it is still
         * a warning only: short is readable, over is impossible.
         *
         * Refused here rather than left to chk_grades_counts_within_total: the
         * whole file is one transaction, so a CHECK failure would throw away
         * every good row with it and report only "Server error".
         */
        $breakdown = $passed + $deductions;
        if ($breakdown > $total) {
            $overTotalCount++;
            if (count($overTotal) < SHEETIMPORT_SAMPLE_LIMIT) {
                $overTotal[] = "$idToken (passed+failed+inc+nc+ng = $breakdown, total = $total)";
            }
            continue;
        }
        if ($breakdown < $total && count($warnings) < SHEETIMPORT_SAMPLE_LIMIT) {
            $warnings[] = "$idToken (passed+failed+inc+nc+ng = $breakdown, total = $total)";
        }

        if (isset($seenStudentIds[$studentId]) && count($duplicates) < SHEETIMPORT_SAMPLE_LIMIT) {
            $duplicates[] = $idToken;
        }
        $wasExisting = isset($existingIds[$studentId]) || isset($seenStudentIds[$studentId]);
        $seenStudentIds[$studentId] = true;

        // Positional, in the same order as $columns above.
        $params = [$studentId, $semesterId, $schoolYearId, $period, $total, $passed, $failed, $incomplete, $noCredit, $noGrade];
        if ($hasRemarkColumn) {
            $remarkText = strtolower($cell('remarks'));
            if ($remarkText !== '') {
                // Stated in the file, so it wins outright -- including on a
                // closed year, where the policy deliberately stays silent.
                $params[] = $remarkIdByName[$remarkText] ?? null;
            } else {
                $params[] = grade_remark_evaluate([
                    'total_subject' => $total,
                    'passed' => $passed,
                    'failed' => $failed,
                    'incomplete' => $incomplete,
                    'no_credit' => $noCredit,
                    'no_grade' => $noGrade,
                ], $policyRules);
            }
        }

        $upsert->add($params);

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
        'warnings' => count($warnings),
        'over_total' => $overTotalCount,
        'duplicates' => count($duplicates),
        'skipped_out_of_scope' => $skippedByScope,
    ];

    // After the commit, so the log records an import that actually landed. A
    // rolled-back run leaves no row, which is correct — nothing happened.
    api_audit_import(
        $pdo,
        $authUser,
        'grades',
        (string)($_FILES['file']['name'] ?? ''),
        $summary,
        api_term_label($pdo, $semesterId, $schoolYearId, $period)
    );

    gradeimport_out(200, [
        // The headline of the result. Refused rows are an error the reader has
        // to act on, so they are said here, not only in a tile.
        'message' => $overTotalCount > 0
            ? sprintf(
                "%d %s not imported: the counts are more than the student's total subjects. Fix %s in the file and import again.",
                $overTotalCount,
                $overTotalCount === 1 ? 'row was' : 'rows were',
                $overTotalCount === 1 ? 'it' : 'them'
            )
            : 'Import complete.',
        'summary' => $summary,
        'details' => [
            'unmatched_student_ids' => $unmatched,
            'invalid_student_ids' => $invalid,
            'mismatch_warnings' => $warnings,
            'over_total_rows' => $overTotal,
            'duplicate_student_ids' => array_values(array_unique($duplicates)),
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
    api_log_exception($e, ['scope' => 'grades_import']);
    gradeimport_out(500, ['message' => 'Server error while importing grades.']);
}
