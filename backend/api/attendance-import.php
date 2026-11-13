<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

// Auth is bootstrapped on include; the policy map restricts this endpoint to admins.
require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/periodic_lib.php';

// The parsing (CSV and Excel XML, header keys, whole-number cells) and the batch
// writer all come from here, shared with the grades, finance and student
// importers. Only the column names are this file's own: attimport_map_header().
require_once __DIR__ . '/lib/spreadsheet_import.php';
// Supplies the term when the uploader did not name one.
require_once __DIR__ . '/lib/academic_calendar.php';
require_once __DIR__ . '/lib/term_closure.php';

const ATTIMPORT_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
const ATTIMPORT_MAX_ROWS = 5000;
const ATTIMPORT_SAMPLE_LIMIT = 100; // cap detail lists returned to the client

function attimport_out($code, $payload) {
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * Map a normalized header key to a canonical field, or null if it is a column
 * we intentionally ignore (student name and the recomputed percentages).
 */
function attimport_map_header(string $key): ?string {
    $map = [
        'studentid' => 'student_id',
        'studentnumber' => 'student_id',
        'studentno' => 'student_id',
        'idnumber' => 'student_id',
        'totalclassesconducted' => 'total',
        'totalclasses' => 'total',
        'classesconducted' => 'total',
        'totalconducted' => 'total',
        'total' => 'total',
        'present' => 'present',
        'timespresent' => 'present',
        'daspresent' => 'present',
        'absent' => 'absent',
        'timesabsent' => 'absent',
        'daysabsent' => 'absent',
    ];
    return $map[$key] ?? null;
}

try {
    $db = new Database();
    $pdo = $db->connect();

    if (($_SERVER['REQUEST_METHOD'] ?? 'POST') !== 'POST') {
        attimport_out(405, ['message' => 'Method not allowed']);
    }

    foreach (['student', 'attendance', 'attendance_upload', 'semester', 'school_year'] as $table) {
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
        attimport_out(400, ['message' => $termError]);
    }
    $schoolYearId = $term['school_year_id'];
    $semesterId   = $term['semester_id'];
    $period       = $term['period'];

    // A closed semester takes no new rows and no overwrites - and no upload
    // record either, which is why this comes before anything is written.
    $closedTerm = term_closure_block($pdo, [$schoolYearId, $semesterId]);
    if ($closedTerm !== null) {
        attimport_out(TERM_CLOSURE_HTTP_STATUS, $closedTerm);
    }

    // --- Read the uploaded file ---
    if (!isset($_FILES['file']) || !is_array($_FILES['file'])) {
        attimport_out(400, ['message' => 'No file was uploaded. Attach a CSV or Excel (.xls) file.']);
    }
    $file = $_FILES['file'];
    if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
        $reason = ($file['error'] ?? -1) === UPLOAD_ERR_INI_SIZE || ($file['error'] ?? -1) === UPLOAD_ERR_FORM_SIZE
            ? 'The file is too large.'
            : 'The file failed to upload. Please try again.';
        attimport_out(400, ['message' => $reason]);
    }
    if (($file['size'] ?? 0) > ATTIMPORT_MAX_BYTES) {
        attimport_out(400, ['message' => 'The file exceeds the 5 MB limit.']);
    }
    if (!is_uploaded_file($file['tmp_name'] ?? '')) {
        attimport_out(400, ['message' => 'Invalid upload.']);
    }

    $content = file_get_contents($file['tmp_name']);
    if ($content === false || trim($content) === '') {
        attimport_out(400, ['message' => 'The uploaded file is empty.']);
    }

    // Reject binary .xlsx (ZIP) — the zip extension is unavailable in this environment.
    if (strncmp($content, "PK\x03\x04", 4) === 0) {
        attimport_out(400, [
            'message' => 'Binary .xlsx files are not supported. Please re-save the file as CSV (Comma delimited) and upload again, or use the exported .xls template.',
        ]);
    }

    // --- Parse into rows ---
    $rows = sheetimport_parse($content);

    if (count($rows) < 2) {
        attimport_out(400, ['message' => 'The file has no data rows. Expected a header row plus at least one student row.']);
    }

    // --- Locate the header row and map columns ---
    $headerRowIndex = null;
    $columnMap = []; // field => column index
    foreach ($rows as $index => $row) {
        $candidate = [];
        foreach ($row as $colIndex => $cell) {
            $field = attimport_map_header(sheetimport_header_key((string)$cell));
            if ($field !== null && !isset($candidate[$field])) {
                $candidate[$field] = $colIndex;
            }
        }
        if (isset($candidate['student_id'], $candidate['total'], $candidate['present'], $candidate['absent'])) {
            $headerRowIndex = $index;
            $columnMap = $candidate;
            break;
        }
    }

    if ($headerRowIndex === null) {
        attimport_out(400, [
            'message' => 'Could not find the required columns. The file must have headers: Student ID, Total Classes Conducted, Present, Absent.',
        ]);
    }

    // --- Preload students and existing rows for this term ---
    $studentStmt = $pdo->query('SELECT student_id, student_number FROM student');
    $byNumber = []; // lowercased trimmed student_number => student_id
    $byId = [];     // student_id string => student_id
    foreach ($studentStmt->fetchAll(PDO::FETCH_ASSOC) as $s) {
        $sid = (int)$s['student_id'];
        $num = strtolower(trim((string)$s['student_number']));
        if ($num !== '') {
            $byNumber[$num] = $sid;
        }
        $byId[(string)$sid] = $sid;
    }

    $existingStmt = $pdo->prepare(
        'SELECT student_id FROM attendance
          WHERE semester_id = :sem AND schoolyear_id = :yr AND COALESCE(period, 0) = :period_key'
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
    $unmatched = [];   // student id tokens with no matching student
    $invalid = [];     // rows with non-numeric counts
    $warnings = [];     // present+absent < total: imported, flagged
    $overTotal = [];    // present+absent > total: refused
    $overTotalCount = 0;
    $duplicates = [];   // student id appearing more than once in the file
    $seenStudentIds = [];

    /*
     * Who is uploading, for the upload record and the audit line.
     *
     * Read once, here. It used to be fetched only for the audit line, since the
     * middleware already decides who may post; the upload record needs it too.
     */
    $uploader = api_get_session_user();
    $fileName = trim(basename((string)($file['name'] ?? '')));

    /*
     * Every row this file writes carries upload_id, so the Attendance page can
     * filter to one upload. upload_id is overwritten on update, like the counts:
     * a row belongs to the upload that last wrote it.
     */
    $upsert = new SheetImportBatchWriter(
        $pdo,
        'attendance',
        ['student_id', 'semester_id', 'schoolyear_id', 'period', 'total_classes_conducted', 'present', 'absent', 'upload_id'],
        'total_classes_conducted = VALUES(total_classes_conducted),
         present = VALUES(present),
         absent = VALUES(absent),
         upload_id = VALUES(upload_id),
         updated_at = CURRENT_TIMESTAMP'
    );

    $pdo->beginTransaction();

    // Inside the transaction, so an import that fails leaves no upload behind.
    $pdo->prepare(
        'INSERT INTO attendance_upload (uploaded_by, uploader_label, file_name, semester_id, schoolyear_id, period)
         VALUES (:by, :label, :file, :sem, :yr, :period)'
    )->execute([
        ':by' => isset($uploader['user_id']) ? (int)$uploader['user_id'] : null,
        ':label' => isset($uploader['name']) ? mb_substr((string)$uploader['name'], 0, 190) : null,
        ':file' => $fileName !== '' ? mb_substr($fileName, 0, 255) : null,
        ':sem' => $semesterId,
        ':yr' => $schoolYearId,
        ':period' => $period,
    ]);
    $uploadId = (int)$pdo->lastInsertId();

    $dataRows = array_slice($rows, $headerRowIndex + 1, ATTIMPORT_MAX_ROWS, true);
    foreach ($dataRows as $row) {
        $idToken = trim((string)($row[$columnMap['student_id']] ?? ''));
        $totalRaw = (string)($row[$columnMap['total']] ?? '');
        $presentRaw = (string)($row[$columnMap['present']] ?? '');
        $absentRaw = (string)($row[$columnMap['absent']] ?? '');

        // Skip blank lines (no id and no numbers).
        if ($idToken === '' && trim($totalRaw) === '' && trim($presentRaw) === '' && trim($absentRaw) === '') {
            continue;
        }
        $processedTotal++;

        // Match the student.
        $lookup = strtolower($idToken);
        $studentId = $byNumber[$lookup] ?? ($byId[$idToken] ?? null);
        if ($studentId === null) {
            if (count($unmatched) < ATTIMPORT_SAMPLE_LIMIT) $unmatched[] = $idToken;
            continue;
        }

        // Parse the counts.
        $total = sheetimport_to_int($totalRaw);
        $present = sheetimport_to_int($presentRaw);
        $absent = sheetimport_to_int($absentRaw);
        if ($total === null || $present === null || $absent === null || $total < 0 || $present < 0 || $absent < 0) {
            if (count($invalid) < ATTIMPORT_SAMPLE_LIMIT) $invalid[] = $idToken;
            continue;
        }
        /*
         * The total classes is the cap. A student cannot be present or absent
         * for more classes than were held, so over it the row is refused and
         * named, and the rest of the file still imports. Under it (a class
         * nobody marked) is still only a warning.
         *
         * Refused here rather than left to chk_attendance_counts_within_total:
         * the file is one transaction, so a CHECK failure would throw away every
         * good row with it and report only "Server error".
         */
        if ($present + $absent > $total) {
            $overTotalCount++;
            if (count($overTotal) < ATTIMPORT_SAMPLE_LIMIT) {
                $overTotal[] = "$idToken (present $present + absent $absent = " . ($present + $absent) . ", total $total)";
            }
            continue;
        }
        if ($present + $absent < $total && count($warnings) < ATTIMPORT_SAMPLE_LIMIT) {
            $warnings[] = "$idToken (present $present + absent $absent ≠ total $total)";
        }

        if (isset($seenStudentIds[$studentId]) && count($duplicates) < ATTIMPORT_SAMPLE_LIMIT) {
            $duplicates[] = $idToken;
        }
        $wasExisting = isset($existingIds[$studentId]) || isset($seenStudentIds[$studentId]);
        $seenStudentIds[$studentId] = true;

        $upsert->add([$studentId, $semesterId, $schoolYearId, $period, $total, $present, $absent, $uploadId]);

        if ($wasExisting) {
            $updated++;
        } else {
            $inserted++;
        }
    }

    // Whatever is still buffered has to land before the transaction closes.
    $upsert->flush();

    /*
     * A file that wrote nothing (every ID unmatched, every row refused) is not
     * an upload anyone can filter to, so its record goes. Otherwise it keeps how
     * many rows it wrote: distinct students, since a repeated ID is one row.
     */
    $rowsWritten = count($seenStudentIds);
    if ($rowsWritten === 0) {
        $pdo->prepare('DELETE FROM attendance_upload WHERE upload_id = ?')->execute([$uploadId]);
        $uploadId = null;
    } else {
        $pdo->prepare('UPDATE attendance_upload SET rows_written = ? WHERE upload_id = ?')->execute([$rowsWritten, $uploadId]);
    }
    $pdo->commit();

    $summary = [
        'rows_read' => $processedTotal,
        'imported' => $inserted + $updated,
        'inserted' => $inserted,
        'updated' => $updated,
        'unmatched' => $processedTotal > 0 ? count($unmatched) : 0,
        'invalid' => count($invalid),
        'warnings' => count($warnings),
        'over_total' => $overTotalCount,
        'duplicates' => count($duplicates),
    ];

    // After the commit, so the log records an import that actually landed.
    api_audit_import(
        $pdo,
        $uploader,
        'attendance',
        (string)($_FILES['file']['name'] ?? ''),
        $summary,
        api_term_label($pdo, $semesterId, $schoolYearId, $period)
    );

    attimport_out(200, [
        // The headline of the result. Refused rows are an error the reader has
        // to act on, so they are said here, not only in a tile.
        'message' => $overTotalCount > 0
            ? sprintf(
                '%d %s not imported: present + absent is more than the total classes. Fix %s in the file and import again.',
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
        // The Attendance page's Upload filter takes this id; null when nothing was written.
        'upload_id' => $uploadId,
    ]);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    api_log_exception($e, ['scope' => 'attendance_import']);
    attimport_out(500, ['message' => 'Server error while importing attendance.', 'error' => $e->getMessage()]);
}
