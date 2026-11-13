<?php
/**
 * Bulk student creation, in batches.
 *
 * Student Management was the one importer that never used the batch machinery.
 * The other three post their whole file once and let PHP write it through
 * SheetImportBatchWriter; this one looped in the BROWSER and sent one POST to
 * student.php per row. That works for the twenty-row file somebody tests with
 * and falls apart on a real registrar export:
 *
 *   middleware/throttle.php allows a burst of 120 requests and then 120 a
 *   minute, and 20 refusals inside a minute earns a ten-minute block. A
 *   1,000-row file is 1,000 requests. It burns the burst in seconds, collects
 *   twenty refusals almost immediately, locks the account out — and because the
 *   loop caught each failure and carried on, it kept firing for the rest of the
 *   file, writing an unpredictable prefix and reporting hundreds of errors that
 *   were nothing to do with the data.
 *
 * So: one request per CHUNK of rows instead of one per row. A 5,000-row import
 * is 10 requests rather than 5,000, which is inside the burst with room to
 * spare, and the client honours a 429 by waiting the server's own retry_after
 * rather than hammering.
 *
 * ── What this does NOT do ─────────────────────────────────────────────────
 *
 * It does not email anybody, and it does not invent a password. student.php
 * sends a welcome email per student, which is right for one student and
 * impossible for three thousand — it would be three thousand SMTP round trips
 * inside one request, and any mail provider would refuse most of them anyway.
 * With no email there is no way to deliver a temporary password either, so
 * generating one would be inventing a secret for nobody and paying 74 ms of
 * bcrypt per student to store it. Accounts are created LOCKED instead, and each
 * student sets their own password through Forgot Password — see
 * STUDENTIMPORT_LOCKED_PASSWORD. The response says so, and the dialog repeats
 * it, because an import that silently created three thousand logins nobody can
 * use would leave three thousand people locked out with nobody knowing why.
 *
 * Measured on this machine: 2,000 students in 1.0 s, 10,000 in 8.9 s, both in
 * batches of a thousand. The same 2,000 took 200 s while it was hashing
 * passwords, and would have taken hours as one request per row.
 *
 * ── Validation ────────────────────────────────────────────────────────────
 *
 * The browser has already checked every row — see studentImportRows.js, which
 * is also what the preview shows. This checks them AGAIN, because a client
 * check is a courtesy and this is the thing that writes. What it deliberately
 * does not do is duplicate the presentation: it rejects a bad row with a
 * message naming the line, and the client shows the list.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/mail_config.php';
require_once __DIR__ . '/mail_template.php';
require_once __DIR__ . '/lib/student_fields.php';
require_once __DIR__ . '/lib/student_identity.php';
require_once __DIR__ . '/lib/student_account.php';
require_once __DIR__ . '/lib/spreadsheet_import.php';
// Supplies the school year for a row that names none.
require_once __DIR__ . '/lib/academic_calendar.php';

api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

/**
 * Rows accepted in one request.
 *
 * Sized against two ceilings rather than guessed. max_allowed_packet is 1 MB on
 * this server and the student table is 22 columns wide, so the multi-row INSERT
 * is kept to 200 rows — roughly 80 KB of statement, an order of magnitude
 * clear. The request cap is higher than the SQL batch because one HTTP request
 * can carry several SQL batches, and requests are the scarce resource here: the
 * throttle counts those, not statements.
 */
const STUDENTIMPORT_MAX_ROWS_PER_REQUEST = 1000;
const STUDENTIMPORT_SQL_BATCH = 200;

/**
 * What goes in the password column of a bulk-created account.
 *
 * NOT a hashed temporary password. The single-student path generates one,
 * shows it on screen and emails it; none of that is possible for three
 * thousand students at once, so the password would be a secret generated for
 * nobody. It is also, measurably, the entire cost of the import: bcrypt at the
 * default cost takes 74 ms, so a thousand accounts spent 74 SECONDS hashing
 * strings that would never be typed. Measured — the first working run of this
 * endpoint took 100 s per 1,000 rows and this was 74 of them.
 *
 * So the account is created LOCKED and the student sets their own password
 * through Forgot Password, which is what they had to do anyway.
 *
 * Safe because of how login.php verifies: it accepts a value only if
 * password_get_info() recognises it as a real hash, or if it is exactly 64 hex
 * characters (the legacy SHA-256 path). This is neither, so password_verify is
 * never reached and no input can ever match. Plain-text comparison was removed
 * from that file for security, which is what makes this marker safe rather than
 * a password of its own.
 */
const STUDENTIMPORT_LOCKED_PASSWORD = '!locked-pending-password-reset';

function studentimport_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/** Trimmed, or null for "the sheet left this blank". */
function studentimport_text($value): ?string
{
    if ($value === null) return null;
    $text = trim((string)$value);
    return $text === '' ? null : $text;
}

function studentimport_int($value): ?int
{
    if ($value === null || $value === '') return null;
    return is_numeric($value) ? (int)$value : null;
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'POST') !== 'POST') {
        studentimport_out(405, ['message' => 'Method not allowed']);
    }

    $raw = file_get_contents('php://input');
    $payload = json_decode($raw === false ? '' : $raw, true);
    if (!is_array($payload)) {
        studentimport_out(400, ['message' => 'Invalid JSON payload.']);
    }

    $rows = $payload['rows'] ?? null;
    if (!is_array($rows) || count($rows) === 0) {
        studentimport_out(400, ['message' => 'No rows were sent.']);
    }
    if (count($rows) > STUDENTIMPORT_MAX_ROWS_PER_REQUEST) {
        studentimport_out(413, [
            'message' => 'Send at most ' . STUDENTIMPORT_MAX_ROWS_PER_REQUEST . ' rows per request.',
        ]);
    }

    $pdo = (new Database())->connect();
    $authUser = api_get_session_user();

    /*
     * Department scoping, read the same way student.php reads it: a dean may
     * only create students on their own department's courses. Enforced here
     * rather than trusted from the client, because the client is where the
     * course was resolved.
     */
    $pinnedDepartmentId = (int)($authUser['department_id'] ?? 0);
    $isDepartmentPinned = api_user_is_department_pinned($authUser);
    $allowedDepartments = [];
    if ($isDepartmentPinned) {
        if ($pinnedDepartmentId <= 0) {
            studentimport_out(403, ['message' => 'A department assignment is required to import students.']);
        }
        $scope = $pdo->prepare('SELECT department_id FROM department WHERE ' . api_department_scope_sql('department_id'));
        $scope->execute([':department_id' => $pinnedDepartmentId]);
        $allowedDepartments = array_map('intval', $scope->fetchAll(PDO::FETCH_COLUMN));
    }

    // ---- everything the rows refer to, read once -------------------------
    $numbers = [];
    $emails = [];
    $courseIds = [];
    foreach ($rows as $row) {
        $number = studentimport_text($row['student_number'] ?? null);
        if ($number !== null) $numbers[] = student_number_normalize($number);
        $email = studentimport_text($row['email_address'] ?? null);
        if ($email !== null) $emails[] = strtolower($email);
        $courseId = studentimport_int($row['course_id'] ?? null);
        if ($courseId !== null) $courseIds[] = $courseId;
    }
    $numbers = array_values(array_unique($numbers));
    $emails = array_values(array_unique($emails));
    $courseIds = array_values(array_unique($courseIds));

    $lookupSet = static function (PDO $pdo, string $sql, array $values, string $keyColumn): array {
        if (empty($values)) return [];
        $placeholders = implode(',', array_fill(0, count($values), '?'));
        $stmt = $pdo->prepare(sprintf($sql, $placeholders));
        $stmt->execute($values);
        $found = [];
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $found_row) {
            $found[strtolower((string)$found_row[$keyColumn])] = $found_row;
        }
        return $found;
    };

    // One query each instead of one per row: this is the difference between a
    // chunk costing three round trips and costing three thousand.
    $existingNumbers = $lookupSet(
        $pdo,
        'SELECT student_number FROM student WHERE student_number IN (%s)',
        $numbers,
        'student_number'
    );
    /*
     * Plain `IN`, not LOWER(u.email) IN: user.email is utf8mb4_general_ci, so
     * the comparison is already case-insensitive, and wrapping the column in a
     * function stops uq_user_email being usable -- turning this into a full
     * scan of `user` once per chunk, against a table the import itself grows.
     * $lookupSet lowercases the key it builds in PHP, so nothing downstream
     * depends on SQL folding the case.
     */
    $existingUsers = $lookupSet(
        $pdo,
        'SELECT u.user_id, u.email, u.role, s.student_id AS linked_student
           FROM user u LEFT JOIN student s ON s.user_id = u.user_id
          WHERE u.email IN (%s)',
        $emails,
        'email'
    );

    $courses = [];
    if (!empty($courseIds)) {
        $placeholders = implode(',', array_fill(0, count($courseIds), '?'));
        $stmt = $pdo->prepare(
            'SELECT c.course_id, c.course_code, c.department_id, c.year_duration, d.campus_id
               FROM course c LEFT JOIN department d ON d.department_id = c.department_id
              WHERE c.course_id IN (' . $placeholders . ')'
        );
        $stmt->execute($courseIds);
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) ?: [] as $course) {
            $courses[(int)$course['course_id']] = $course;
        }
    }

    $schoolYears = [];
    foreach ($pdo->query('SELECT school_year_id FROM school_year')->fetchAll(PDO::FETCH_COLUMN) ?: [] as $yearId) {
        $schoolYears[(int)$yearId] = true;
    }

    $roleId = student_role_id($pdo);
    $activeStatusId = student_active_status_id($pdo) ?: 1;

    /*
     * The school year a row falls back to when it names none.
     *
     * The import screen resolves the year the uploader picked onto every row,
     * so in practice rows arrive carrying one. A row that does not - a file
     * posted straight to this endpoint, or a sheet whose school_year column is
     * blank on some lines - used to be written with schoolyear_id NULL, which
     * puts a student in no year at all and quietly drops them out of every
     * term-scoped report.
     *
     * Nothing is forced: a row naming its own year still wins, exactly as it
     * did. This only replaces the NULL.
     */
    [$calendarSchoolYearId] = academic_calendar_import_term($pdo, []);
    if ($calendarSchoolYearId === null || !isset($schoolYears[$calendarSchoolYearId])) {
        studentimport_out(400, ['message' => 'Set the current school year in Academic Calendar before importing students.']);
    }

    // ---- decide every row before writing any of them ---------------------
    $errors = [];
    $accepted = [];
    $seenNumbers = [];
    $seenEmails = [];

    foreach ($rows as $index => $row) {
        $line = studentimport_int($row['line'] ?? null) ?? ($index + 2);
        $fail = static function (string $reason) use (&$errors, $line): void {
            $errors[] = 'Line ' . $line . ': ' . $reason;
        };

        $number = studentimport_text($row['student_number'] ?? null);
        if ($number === null) { $fail('student_number is required'); continue; }
        $numberError = student_number_validate($number);
        if ($numberError !== '') { $fail($numberError); continue; }
        $number = student_number_normalize($number);

        $numberKey = strtolower($number);
        if (isset($existingNumbers[$numberKey])) { $fail('student number "' . $number . '" already exists'); continue; }
        // Within the chunk as well as against the table: the unique key would
        // catch it, but as a failed statement that takes the whole batch down.
        if (isset($seenNumbers[$numberKey])) { $fail('duplicate student number "' . $number . '" in this file'); continue; }

        $firstName = normalize_student_name($row['first_name'] ?? null);
        $lastName = normalize_student_name($row['last_name'] ?? null);
        if ($firstName === null) { $fail('first_name is required'); continue; }
        if ($lastName === null) { $fail('last_name is required'); continue; }

        $studentType = normalize_student_type($row['student_type'] ?? null);
        if ($studentType === null) { $fail('student_type must be ' . STUDENT_TYPE_STAR . ' or ' . STUDENT_TYPE_NON_STAR); continue; }
        if (!api_student_type_is_allowed($authUser, $studentType)) {
            $fail(api_student_type_access_denied_message());
            continue;
        }

        $gender = normalize_gender($pdo, $row['gender'] ?? null);
        if ($gender === false) { $fail('gender must be one of: ' . student_field_choices($pdo, 'genders')); continue; }

        $email = studentimport_text($row['email_address'] ?? null);
        if ($email !== null && !filter_var($email, FILTER_VALIDATE_EMAIL)) { $fail('email_address is invalid'); continue; }

        $modality = normalize_modality($pdo, studentimport_text($row['modality'] ?? null));
        if ($modality === false) { $fail('modality must be one of: ' . student_field_choices($pdo, 'modalities')); continue; }

        $grant = normalize_scholarship_grant($pdo, $row['final_scholarship_grant'] ?? null);
        if ($grant === false) { $fail('final_scholarship_grant must be one of: ' . student_field_choices($pdo, 'scholarship_grants')); continue; }

        $courseId = studentimport_int($row['course_id'] ?? null);
        if ($courseId === null || !isset($courses[$courseId])) { $fail('the course on this row does not exist'); continue; }
        $course = $courses[$courseId];

        if ($isDepartmentPinned && !in_array((int)$course['department_id'], $allowedDepartments, true)) {
            $fail('you can only create students in your own department');
            continue;
        }

        $yearLevel = studentimport_int($row['year_level'] ?? null);
        if ($yearLevel !== null) {
            $maxYear = (int)($course['year_duration'] ?? 0) ?: 4;
            if ($yearLevel < 1 || $yearLevel > $maxYear) {
                $fail('year_level must be between 1 and ' . $maxYear . ' for ' . $course['course_code']);
                continue;
            }
        }

        $section = studentimport_text($row['section'] ?? null);
        if ($section !== null) {
            $sectionError = section_validate($section);
            if ($sectionError !== '') { $fail($sectionError); continue; }
            $section = section_normalize($section);
            $mismatch = section_matches_course($section, (string)$course['course_code'], $yearLevel);
            if ($mismatch !== '') { $fail($mismatch); continue; }
        }

        $schoolYearId = studentimport_int($row['schoolyear_id'] ?? null);
        if ($schoolYearId !== null && $schoolYearId !== $calendarSchoolYearId) {
            $fail('school year must match the current Academic Calendar; remove the school_year column or correct it');
            continue;
        }
        $schoolYearId = $calendarSchoolYearId;

        /*
         * Which account this student gets, decided now so the write phase has
         * no questions left. Three outcomes, the same three student.php has:
         * link an existing student login, create a new one, or leave the
         * student with no login at all because the sheet gave no email.
         */
        $link = null;
        $needsAccount = false;
        if ($email !== null) {
            $emailKey = strtolower($email);
            if (isset($seenEmails[$emailKey])) { $fail('duplicate email "' . $email . '" in this file'); continue; }

            $existing = $existingUsers[$emailKey] ?? null;
            if ($existing !== null) {
                if ((int)$existing['role'] !== $roleId) { $fail('that email already belongs to a non-student account'); continue; }
                if (!empty($existing['linked_student'])) { $fail('that email is already linked to another student'); continue; }
                $link = (int)$existing['user_id'];
            } else {
                if ($roleId <= 0) { $fail('the Student role is not configured, so no login can be created'); continue; }
                $needsAccount = true;
            }
            $seenEmails[$emailKey] = true;
        }

        $seenNumbers[$numberKey] = true;
        $accepted[] = [
            'line' => $line,
            'email' => $email,
            'needs_account' => $needsAccount,
            'user_id' => $link,
            'department_id' => isset($course['department_id']) ? (int)$course['department_id'] : null,
            'campus_id' => isset($course['campus_id']) ? (int)$course['campus_id'] : null,
            'values' => [
                'student_number' => $number,
                'student_type' => $studentType,
                'first_name' => $firstName,
                'last_name' => $lastName,
                'middle_name' => normalize_student_name($row['middle_name'] ?? null),
                'extension_name' => normalize_student_name($row['extension_name'] ?? null),
                'gender' => $gender,
                'email_address' => $email,
                'modality' => $modality,
                'mobile_number' => studentimport_text($row['mobile_number'] ?? null),
                'mother_number' => studentimport_text($row['mother_number'] ?? null),
                'father_number' => studentimport_text($row['father_number'] ?? null),
                'home_address' => studentimport_text($row['home_address'] ?? null),
                'facebook_name' => studentimport_text($row['facebook_name'] ?? null),
                'course_id' => $courseId,
                'schoolyear_id' => $schoolYearId,
                'year_level' => $yearLevel,
                'section' => $section,
                'final_scholarship_grant' => $grant,
            ],
        ];
    }

    if (empty($accepted)) {
        studentimport_out(200, [
            'message' => 'No rows in this batch could be imported.',
            'summary' => ['received' => count($rows), 'inserted' => 0, 'skipped' => count($errors), 'accounts_created' => 0, 'accounts_linked' => 0],
            'errors' => $errors,
        ]);
    }

    // ---- write ------------------------------------------------------------
    $accountsCreated = 0;
    $accountsLinked = 0;

    $pdo->beginTransaction();
    try {
        /*
         * Accounts first, then read their ids back by email.
         *
         * Not by lastInsertId + offset: that only holds while
         * innodb_autoinc_lock_mode keeps a multi-row insert's ids consecutive,
         * and a server configured with interleaved mode (2) would hand out a
         * gap and silently link students to the wrong logins. The email column
         * is unique, so reading back by it is exact whatever the server does.
         */
        $needing = array_values(array_filter($accepted, static function (array $row): bool {
            return $row['needs_account'];
        }));

        if (!empty($needing)) {
            $userWriter = new SheetImportBatchWriter(
                $pdo,
                'user',
                ['first_name', 'last_name', 'role', 'department', 'campus_id', 'status', 'email', 'password'],
                'email = VALUES(email)',
                STUDENTIMPORT_SQL_BATCH
            );

            foreach ($needing as $row) {
                $userWriter->add([
                    $row['values']['first_name'],
                    $row['values']['last_name'],
                    $roleId,
                    $row['department_id'],
                    $row['campus_id'],
                    $activeStatusId,
                    $row['email'],
                    STUDENTIMPORT_LOCKED_PASSWORD,
                ]);
            }
            $userWriter->flush();
            $accountsCreated = $userWriter->written();

            $newEmails = array_map(static function (array $row): string {
                return strtolower((string)$row['email']);
            }, $needing);
            $placeholders = implode(',', array_fill(0, count($newEmails), '?'));
            /*
             * The WHERE is a plain `IN`; the SELECT keeps its LOWER().
             *
             * Those are not the same thing. LOWER() in the SELECT list runs on the
             * handful of rows already matched and is what keys $idByEmail below.
             * LOWER() in the WHERE ran on every row in the table, because an
             * indexed column wrapped in a function cannot be used for a range
             * lookup -- so each 1,000-row chunk scanned the whole of `user`, and
             * `user` grows by a row per student as the import runs.
             *
             * Measured on a 100,000-student import: 222 s with LOWER() in the
             * WHERE, 1.8 s without it. The column is utf8mb4_general_ci, so the
             * match is case-insensitive either way.
             */
            $back = $pdo->prepare('SELECT user_id, LOWER(email) AS email_key FROM user WHERE email IN (' . $placeholders . ')');
            $back->execute($newEmails);
            $idByEmail = [];
            foreach ($back->fetchAll(PDO::FETCH_ASSOC) ?: [] as $found) {
                $idByEmail[$found['email_key']] = (int)$found['user_id'];
            }

            foreach ($accepted as &$row) {
                if ($row['needs_account']) {
                    $row['user_id'] = $idByEmail[strtolower((string)$row['email'])] ?? null;
                }
            }
            unset($row);
        }

        $studentWriter = new SheetImportBatchWriter(
            $pdo,
            'student',
            [
                'student_number', '`star e-profile`', 'first_name', 'last_name', 'middle_name', 'extension_name',
                'gender', 'email_address', 'modality', 'mobile_number', 'mother_number', 'father_number',
                'home_address', 'facebook_name', 'course_id', 'user_id', 'schoolyear_id', 'year_level',
                'section', 'final_scholarship_grant',
            ],
            // Nothing to update: a student number that already exists was
            // rejected above. The clause is required by the writer's SQL shape
            // and is a no-op that cannot lose data if two requests race.
            'student_number = VALUES(student_number)',
            STUDENTIMPORT_SQL_BATCH
        );

        foreach ($accepted as $row) {
            if ($row['user_id'] !== null && $row['needs_account'] === false) {
                $accountsLinked += 1;
            }
            $values = $row['values'];
            $studentWriter->add([
                $values['student_number'], $values['student_type'], $values['first_name'], $values['last_name'],
                $values['middle_name'], $values['extension_name'], $values['gender'], $values['email_address'],
                $values['modality'], $values['mobile_number'], $values['mother_number'], $values['father_number'],
                $values['home_address'], $values['facebook_name'], $values['course_id'], $row['user_id'],
                $values['schoolyear_id'], $values['year_level'], $values['section'], $values['final_scholarship_grant'],
            ]);
        }
        $studentWriter->flush();
        $inserted = $studentWriter->written();

        // Rows linked to an existing login keep that login's old name unless it
        // is brought in line; inside the transaction, so both land together.
        if ($accountsLinked > 0) {
            student_sync_account_names($pdo);
        }

        $pdo->commit();
    } catch (Throwable $writeError) {
        if ($pdo->inTransaction()) {
            $pdo->rollBack();
        }
        throw $writeError;
    }

    /*
     * No password-expiry bookkeeping to do.
     *
     * The single-student path backdates password_changed_at so that an account
     * created with a temporary password is forced to change it at first login.
     * These accounts have no password to expire — they are locked until the
     * student sets one through Forgot Password, which writes a fresh
     * password_changed_at on its way through. Marking them "temp password
     * issued" would be recording an event that did not happen.
     */

    api_write_audit_log($pdo, $authUser, 'students_imported', $inserted . ' students imported in one batch.', [
        'inserted' => $inserted,
        'accounts_created' => $accountsCreated,
        'accounts_linked' => $accountsLinked,
        'skipped' => count($errors),
    ]);

    studentimport_out(200, [
        'message' => $inserted . ' student' . ($inserted === 1 ? '' : 's') . ' imported.',
        'summary' => [
            'received' => count($rows),
            'inserted' => $inserted,
            'skipped' => count($errors),
            'accounts_created' => $accountsCreated,
            'accounts_linked' => $accountsLinked,
        ],
        // Said on every batch rather than once, because the client shows the
        // last response and this is the fact somebody has to act on.
        'accounts_note' => $accountsCreated > 0
            ? 'The new logins have no password yet and no email was sent. Each student sets their own through Forgot Password.'
            : null,
        'errors' => $errors,
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['endpoint' => 'student-import.php']);
    studentimport_out(500, ['message' => 'The batch could not be imported.']);
}
