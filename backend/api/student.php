<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/mail_config.php';
require_once __DIR__ . '/mail_template.php';
require_once __DIR__ . '/lib/student_fields.php';
require_once __DIR__ . '/lib/student_identity.php';
require_once __DIR__ . '/lib/student_year_level.php';
require_once __DIR__ . '/lib/student_account.php';
require_once __DIR__ . '/lib/student_coach.php';


/** The course code behind a course id, for checking a section name against it. */
function course_code_for(PDO $pdo, ?int $courseId): string {
    if ($courseId === null) return '';
    $stmt = $pdo->prepare('SELECT course_code FROM course WHERE course_id = :id LIMIT 1');
    $stmt->execute([':id' => $courseId]);
    return (string)($stmt->fetchColumn() ?: '');
}

function student_table_has_column(PDO $pdo, string $column): bool {
    $stmt = $pdo->prepare("SHOW COLUMNS FROM `student` LIKE :column_name");
    $stmt->execute([':column_name' => $column]);
    return (bool)$stmt->fetch(PDO::FETCH_ASSOC);
}

function ensure_student_columns(PDO $pdo): void {
    /*
     * The column is `star e-profile`, renamed from `student_type` on
     * 2026-08-22. This guard has to name the CURRENT column or it does real
     * damage: asked about a name that no longer exists it answers "missing" and
     * adds a second column, leaving the table with two type fields where every
     * read uses one and every write the other.
     */
    if (!student_table_has_column($pdo, 'star e-profile')) {
        $afterColumn = student_table_has_column($pdo, 'student_name') ? 'student_name' : 'student_number';
        $pdo->exec("ALTER TABLE `student` ADD COLUMN `star e-profile` ENUM('STAR','Non-STAR') NOT NULL DEFAULT 'Non-STAR' AFTER `$afterColumn`");
    }
    api_require_column($pdo, 'student', 'archived_at');
}

/**
 * Record a change to a student, without ever failing the change.
 *
 * Same shape as user.php's wrapper and for the same reason: an audit write that
 * throws must not turn a successful edit into a 500. A dropped row goes to the
 * exception log instead, where it can be noticed without costing anyone work.
 */
function student_audit(PDO $pdo, ?array $actor, string $action, string $detail, array $metadata = []): void {
    try {
        api_write_audit_log($pdo, $actor, $action, $detail, $metadata);
    } catch (Throwable $auditError) {
        api_log_exception($auditError, ['endpoint' => 'student.php', 'audit_action' => $action]);
    }
}

/**
 * The columns an UPDATE touched, in words.
 *
 * Reads the "col = :param" assignments the update was built from rather than
 * comparing before and after, so it stays true when a field is added: a new
 * column appears in the audit line under its own name with no change here. The
 * one column that needs translating is the type field, whose real name is
 * `star e-profile` and reads as a typo in a sentence.
 */
function student_changed_labels(array $fields): array {
    $labels = [];
    foreach ($fields as $assignment) {
        $column = trim(strtok((string)$assignment, '='), " `\t\n\r");
        if ($column === '') continue;
        $labels[] = $column === 'star e-profile' ? 'STAR E-Profile' : str_replace('_', ' ', $column);
    }
    return $labels ?: ['nothing'];
}


/**
 * Year level must fit the programme it belongs to.
 *
 * There was no server-side check at all: year_level went through
 * as_nullable_int and was stored as-is, so the 1-5 range in the student form
 * and the CSV importer was the only thing standing between a typo and a
 * "Year 47" row. Both are client-side and neither knew the programme length —
 * every four-year course accepted a Year 5.
 *
 * The cap now comes from course.year_duration, so Architecture allows 5 and
 * the rest allow 4 without any course code appearing in this file. The rule
 * itself is student_year_level_error() in lib/student_year_level.php, shared
 * with the year-end migration, which moves a student's year too.
 */
function assert_year_level_fits_course(PDO $pdo, ?int $courseId, ?int $yearLevel): void {
    $error = student_year_level_error($pdo, $courseId, $yearLevel);
    if ($error !== '') {
        api_out(400, ['message' => $error]);
    }
}

/*
 * Both checks read "is this in my department", and a department is now the same
 * college on every campus it runs on rather than a single row — see
 * api_department_scope_sql(). A CITE dean reaches CITE students on Carmen and
 * Puerto alike; a CMA dean still reaches neither.
 */
function course_in_department(PDO $pdo, int $courseId, int $departmentId): bool {
    $stmt = $pdo->prepare(
        'SELECT course_id FROM course
          WHERE course_id = :course_id
            AND ' . api_department_scope_sql('department_id') . '
          LIMIT 1'
    );
    $stmt->execute([
        ':course_id' => $courseId,
        ':department_id' => $departmentId,
    ]);
    return (bool)$stmt->fetch();
}

function student_in_department(PDO $pdo, int $studentId, int $departmentId): bool {
    $stmt = $pdo->prepare(
        'SELECT st.student_id
         FROM student st
         INNER JOIN course c ON c.course_id = st.course_id
         WHERE st.student_id = :student_id
           AND ' . api_department_scope_sql('c.department_id') . '
         LIMIT 1'
    );
    $stmt->execute([
        ':student_id' => $studentId,
        ':department_id' => $departmentId,
    ]);
    return (bool)$stmt->fetch();
}

try {
    $db = new Database();
    $pdo = $db->connect();
    ensure_student_columns($pdo);
    $hasArchivedAt = student_table_has_column($pdo, 'archived_at');
    $authUser = api_get_session_user();
    $isDepartmentPinned = api_user_is_department_pinned($authUser);
    $isStudent = api_session_user_has_role($authUser, ['student']);
    $sessionUserId = (int)($authUser['user_id'] ?? 0);
    $pinnedDepartmentId = $isDepartmentPinned ? (int)($authUser['department_id'] ?? 0) : 0;
    $method = $_SERVER['REQUEST_METHOD'];

    if ($method === 'GET') {
        $id = isset($_GET['id']) ? (int)$_GET['id'] : 0;
        if ($id > 0) {
            $stmt = $pdo->prepare('SELECT *, `star e-profile` AS student_type FROM student WHERE student_id = :id LIMIT 1');
            $stmt->execute([':id' => $id]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if (!$row) api_out(404, ['message' => 'Student not found']);
            if (!api_student_type_is_allowed($authUser, $row['student_type'] ?? null)) {
                api_out(403, ['message' => api_student_type_access_denied_message()]);
            }
            if ($isStudent && (int)($row['user_id'] ?? 0) !== $sessionUserId) {
                api_out(403, ['message' => 'Forbidden']);
            }
            if ($isDepartmentPinned) {
                if ($pinnedDepartmentId <= 0) api_out(403, ['message' => 'This account is not linked to a department']);
                if (!student_in_department($pdo, $id, $pinnedDepartmentId)) api_out(403, ['message' => 'Forbidden']);
            }
            api_out(200, ['data' => $row]);
        }

        $page = isset($_GET['page']) ? max(1, (int)$_GET['page']) : 1;
        /*
         * The ceiling is 1000, the default is still 200.
         *
         * Three screens need every student at once - the list filters and
         * searches in the browser, and both reports aggregate over the whole
         * cohort - so they page through this endpoint until it runs out. A
         * request costs about 47ms before it reads a single row (connect, token,
         * permissions), and that floor does not care how many rows come back:
         * limit=1 and limit=200 both answer in ~65ms. At 200 a 2,776-student
         * cohort is 14 round trips, so roughly 660ms of that is spent asking
         * again rather than on the data.
         *
         * Raising the ceiling rather than the default keeps every existing
         * caller exactly where it was; the three that want the whole list opt in
         * by asking for it. 1000 is what school_year.php already allows, and a
         * page that size is about 750KB.
         */
        $limit = isset($_GET['limit']) ? max(1, min(1000, (int)$_GET['limit'])) : 200;
        $offset = ($page - 1) * $limit;

        $search = isset($_GET['search']) ? trim((string)$_GET['search']) : '';
        $courseId = isset($_GET['course_id']) && $_GET['course_id'] !== '' ? (int)$_GET['course_id'] : null;
        $departmentId = isset($_GET['department_id']) && $_GET['department_id'] !== '' ? (int)$_GET['department_id'] : null;
        $yearLevel = isset($_GET['year_level']) && $_GET['year_level'] !== '' ? (int)$_GET['year_level'] : null;
        $studentType = isset($_GET['student_type']) && $_GET['student_type'] !== '' ? as_nullable_text($_GET['student_type']) : null;
        $userId = isset($_GET['user_id']) && $_GET['user_id'] !== '' ? (int)$_GET['user_id'] : null;
        $schoolYearId = isset($_GET['schoolyear_id']) && $_GET['schoolyear_id'] !== '' ? (int)$_GET['schoolyear_id'] : null;
        $batchId = isset($_GET['batch_id']) && $_GET['batch_id'] !== '' ? (int)$_GET['batch_id'] : null;
        $includeArchived = isset($_GET['include_archived']) ? api_bool_like($_GET['include_archived'], false) : false;
        /*
         * Two different questions, so two different flags.
         *
         * include_archived=1 means "do not hide the archived ones" — the list
         * an importer or a report wants, active and archived together.
         * archived=1 means "show me only the archived ones", which is the
         * Archived tab in Student Management. Overloading one flag for both
         * would make the tab list every active student as well.
         */
        $archivedOnly = isset($_GET['archived']) ? api_bool_like($_GET['archived'], false) : false;

        if ($isStudent) {
            $userId = $sessionUserId;
        }
        if ($isDepartmentPinned) {
            if ($pinnedDepartmentId <= 0) api_out(403, ['message' => 'This account is not linked to a department']);
            $departmentId = $pinnedDepartmentId;
        }

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
            $whereParts[] = '(student_number LIKE :q OR first_name LIKE :q OR last_name LIKE :q OR email_address LIKE :q OR mobile_number LIKE :q OR facebook_name LIKE :q)';
            $params[':q'] = "%$search%";
        }
        if ($courseId !== null) { $whereParts[] = 'course_id = :cid'; $params[':cid'] = $courseId; }
        /*
         * A pinned department widens to the same college on every campus; a
         * department named explicitly in the query does not.
         *
         * The difference is deliberate. A dean is appointed to CITE and should
         * reach CITE wherever it runs. Someone who typed one department id
         * asked for that row, and with CITE Carmen and CITE Puerto sitting in
         * the chooser as separate entries, widening the answer would make
         * picking either one return both — a filter that ignores the choice.
         */
        if ($departmentId !== null) {
            $whereParts[] = $isDepartmentPinned
                ? 'course_id IN (SELECT course_id FROM course WHERE ' . api_department_scope_sql('department_id', ':did') . ')'
                : 'course_id IN (SELECT course_id FROM course WHERE department_id = :did)';
            $params[':did'] = $departmentId;
        }
        if ($yearLevel !== null) { $whereParts[] = 'year_level = :yl'; $params[':yl'] = $yearLevel; }
        if ($studentType !== null) {
            // Through the normalizer rather than a second in_array, so the
            // legacy 'Unstar' filter value keeps working here as it does on write.
            $studentType = normalize_student_type($studentType);
            if ($studentType === null) api_out(400, ['message' => 'student_type must be ' . STUDENT_TYPE_STAR . ' or ' . STUDENT_TYPE_NON_STAR]);
            $whereParts[] = '`star e-profile` = :student_type';
            $params[':student_type'] = $studentType;
        }
        api_apply_student_type_scope($whereParts, $params, $authUser, '`star e-profile`', ':student_type_scope');
        if ($userId !== null) { $whereParts[] = 'user_id = :uid'; $params[':uid'] = $userId; }
        if ($schoolYearId !== null) { $whereParts[] = 'schoolyear_id = :syid'; $params[':syid'] = $schoolYearId; }
        if ($batchId !== null) { $whereParts[] = 'batch_id = :bid'; $params[':bid'] = $batchId; }
        $where = empty($whereParts) ? '' : ('WHERE ' . implode(' AND ', $whereParts));

        /*
         * The names behind course_id and schoolyear_id, alongside the ids.
         *
         * The list returned `SELECT *`, so a student's course was the number 14
         * and their school year the number 3. Every screen that wanted to show
         * either had to fetch the whole course list and build its own lookup —
         * and anything that could not, like the Reports export, wrote the raw id
         * into the file. A column headed "Course" reading 14 is not a report.
         *
         * Correlated subqueries rather than LEFT JOINs, deliberately. The WHERE
         * above is built from unqualified column names — `course_id = :cid`,
         * `archived_at IS NULL` — and `course` has a `course_id` and an
         * `archived_at` of its own, so joining it would make both ambiguous and
         * break the query. Every one of these is a primary-key lookup, so the
         * cost is four index seeks per row on a page capped at 200.
         */
        $sql = "SELECT student.*, `star e-profile` AS student_type,
                       (SELECT c.course_code FROM course c WHERE c.course_id = student.course_id) AS course_code,
                       (SELECT c.course_name FROM course c WHERE c.course_id = student.course_id) AS course_name,
                       (SELECT d.department_name
                          FROM course c
                          JOIN department d ON d.department_id = c.department_id
                         WHERE c.course_id = student.course_id) AS department_name,
                       (SELECT sy.schoolyear_name FROM school_year sy WHERE sy.school_year_id = student.schoolyear_id) AS schoolyear_name
                  FROM student $where ORDER BY student_id ASC LIMIT :limit OFFSET :offset";
        $stmt = $pdo->prepare($sql);
        foreach ($params as $k => $v) { $stmt->bindValue($k, $v); }
        $stmt->bindValue(':limit', (int)$limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', (int)$offset, PDO::PARAM_INT);
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);

        /*
         * Coach and Coaching Unit, for Student Management's columns of those
         * names. Read from the assignment board's own record - one batch query
         * for the page - so the two screens cannot name different coaches.
         * `coaching_unit` itself is left alone: it is the stored foreign key the
         * edit form sends back, and overwriting it with "SSP" would break a save.
         */
        $coaches = student_coaches_by_student($pdo, array_column($rows, 'student_id'));
        foreach ($rows as &$row) {
            $coach = $coaches[(int)$row['student_id']] ?? null;
            $row['coach_unit'] = student_coaching_unit($row['student_type'] ?? null);
            $row['coach_name'] = $coach['name'] ?? null;
            $row['coach_email'] = $coach['email'] ?? null;
        }
        unset($row);

        $countSql = 'SELECT COUNT(*) FROM student ' . ($where !== '' ? $where : '');
        $countStmt = $pdo->prepare($countSql);
        foreach ($params as $k => $v) { $countStmt->bindValue($k, $v); }
        $countStmt->execute();
        $total = (int)$countStmt->fetchColumn();

        api_out(200, ['data' => $rows, 'pagination' => ['page' => $page, 'limit' => $limit, 'total' => $total]]);
    }

    if ($method === 'POST') {
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);
        if (array_key_exists('user_id', $p)) api_out(400, ['message' => 'Account links cannot be assigned through student updates.']);

        $firstName = normalize_student_name($p['first_name'] ?? null);
        $lastName = normalize_student_name($p['last_name'] ?? null);
        if ($firstName === null) api_out(400, ['message' => 'first_name is required']);
        if ($lastName === null) api_out(400, ['message' => 'last_name is required']);

        $studentNumber = as_nullable_text($p['student_number'] ?? null);
        if ($studentNumber === null) api_out(400, ['message' => 'student_number is required']);
        $numberError = student_number_validate($studentNumber);
        if ($numberError !== '') api_out(400, ['message' => $numberError]);
        $studentNumber = student_number_normalize($studentNumber);
        $studentType = normalize_student_type($p['student_type'] ?? null);
        if ($studentType === null) api_out(400, ['message' => 'student_type must be ' . STUDENT_TYPE_STAR . ' or ' . STUDENT_TYPE_NON_STAR]);
        if (!api_student_type_is_allowed($authUser, $studentType)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }
        $middleName = normalize_student_name($p['middle_name'] ?? null);
        // Suffix on the name (JR, SR, III). Free text — the registrar's sheet
        // spells it inconsistently and normalising is a data job, not a rule.
        $extensionName = normalize_student_name($p['extension_name'] ?? null);
        $gender = normalize_gender($pdo, $p['gender'] ?? null);
        if ($gender === false) {
            api_out(400, ['message' => 'gender must be one of: ' . student_field_choices($pdo, 'genders')]);
        }
        $emailAddress = as_nullable_text($p['email_address'] ?? null);
        if ($emailAddress !== null && !filter_var($emailAddress, FILTER_VALIDATE_EMAIL)) {
            api_out(400, ['message' => 'email_address is invalid']);
        }

        $modality = normalize_modality($pdo, $p['modality'] ?? null);
        if ($modality === false) api_out(400, ['message' => 'modality must be one of: ' . student_field_choices($pdo, 'modalities')]);

        /*
         * The three phone columns take digits, not prose.
         *
         * They were as_nullable_text(), which accepted anything at all — "N/A",
         * a name, or a script — into a column the contact workspace later tries
         * to dial. A caller working the queue has no way to tell a wrong number
         * from a number that was never a number.
         */
        $phoneError = ' must be 7 to 15 digits, optionally starting with +. Spaces, dashes and brackets are fine.';

        $mobileNumber = normalize_mobile_number($p['mobile_number'] ?? null);
        if ($mobileNumber === false) api_out(400, ['message' => 'Mobile number' . $phoneError]);

        $motherNumber = normalize_mobile_number($p['mother_number'] ?? null);
        if ($motherNumber === false) api_out(400, ['message' => "Mother's number" . $phoneError]);

        $fatherNumber = normalize_mobile_number($p['father_number'] ?? null);
        if ($fatherNumber === false) api_out(400, ['message' => "Father's number" . $phoneError]);

        $homeAddress = as_nullable_text($p['home_address'] ?? null);
        $facebookName = as_nullable_text($p['facebook_name'] ?? null);

        /*
         * Every free-text field, checked for the characters a record has no
         * business containing. See api_reject_unsafe_text() in middleware/auth.php
         * for the list and why this is refused on input rather than escaped on
         * output.
         *
         * Names are included even though they are uppercased afterwards:
         * mb_convert_case() does nothing to a bracket.
         */
        $unsafe = api_reject_unsafe_fields($p, [
            'first_name' => 'First name',
            'middle_name' => 'Middle name',
            'last_name' => 'Last name',
            'extension_name' => 'Extension name',
            'student_number' => 'Student number',
        ], 'strict');
        // An address is a sentence: "Blk 5 Lot 2 (near the chapel)" is a real
        // address and the strict list would refuse it over the brackets.
        $unsafe = $unsafe ?? api_reject_unsafe_fields($p, [
            'home_address' => 'Home address',
            'facebook_name' => 'Facebook name',
        ], 'prose');
        if ($unsafe !== null) {
            api_out(400, ['message' => $unsafe]);
        }

        $courseId = as_nullable_int($p['course_id'] ?? null);
        $userId = as_nullable_int($p['user_id'] ?? null);
        $schoolYearId = as_nullable_int($p['schoolyear_id'] ?? null);
        $batchId = as_nullable_int($p['batch_id'] ?? null);
        $yearLevel = as_nullable_int($p['year_level'] ?? null);
        $section = as_nullable_text($p['section'] ?? null);
        if ($section !== null) {
            $sectionError = section_validate($section);
            if ($sectionError !== '') api_out(400, ['message' => $sectionError]);
            $section = section_normalize($section);
        }
        $coachingUnit = as_nullable_int($p['coaching_unit'] ?? null);

        $finalGrant = normalize_scholarship_grant($pdo, $p['final_scholarship_grant'] ?? null);
        if ($finalGrant === false) {
            api_out(400, ['message' => 'final_scholarship_grant must be one of: ' . student_field_choices($pdo, 'scholarship_grants')]);
        }

        if ($isDepartmentPinned) {
            if ($pinnedDepartmentId <= 0) api_out(403, ['message' => 'This account is not linked to a department']);
            if ($courseId === null || !course_in_department($pdo, $courseId, $pinnedDepartmentId)) {
                api_out(403, ['message' => 'You can only manage students in your department']);
            }
        }

        if ($courseId !== null && !api_fk_exists($pdo, 'SELECT course_id FROM course WHERE course_id = :id LIMIT 1', $courseId)) {
            api_out(400, ['message' => 'Selected course does not exist']);
        }
        assert_year_level_fits_course($pdo, $courseId, $yearLevel);
        if ($section !== null) {
            $mismatch = section_matches_course($section, course_code_for($pdo, $courseId), $yearLevel);
            if ($mismatch !== '') api_out(400, ['message' => $mismatch]);
        }
        if ($userId !== null) {
            if (!api_fk_exists($pdo, 'SELECT user_id FROM user WHERE user_id = :id LIMIT 1', $userId)) {
                api_out(400, ['message' => 'Selected user does not exist']);
            }
            $dup = $pdo->prepare('SELECT student_id FROM student WHERE user_id = :uid LIMIT 1');
            $dup->execute([':uid' => $userId]);
            if ($dup->fetch()) api_out(409, ['message' => 'A student is already linked to this user']);
        }
        if ($schoolYearId !== null && !api_fk_exists($pdo, 'SELECT school_year_id FROM school_year WHERE school_year_id = :id LIMIT 1', $schoolYearId)) {
            api_out(400, ['message' => 'Selected school year does not exist']);
        }
        if ($batchId !== null && !api_fk_exists($pdo, 'SELECT batch_id FROM batch WHERE batch_id = :id LIMIT 1', $batchId)) {
            api_out(400, ['message' => 'Selected batch does not exist']);
        }
        if ($coachingUnit !== null && !api_fk_exists($pdo, 'SELECT coaching_unit_id FROM coaching_unit WHERE coaching_unit_id = :id LIMIT 1', $coachingUnit)) {
            api_out(400, ['message' => 'Selected coaching unit does not exist']);
        }

        // ---- auto-provision the student's login ------------------------------
        // When no user_id was supplied and we have an email, either link an
        // existing student account with that email or create a fresh one. The
        // generated password is returned ONCE in the response and never stored
        // in plaintext.
        $tempPassword = null;
        $createdUserId = 0;
        $linkedExistingUser = false;

        if ($userId === null && $emailAddress !== null) {
            $roleId = student_role_id($pdo);
            if ($roleId <= 0) {
                api_out(500, ['message' => 'Student role is not configured. Create a "Student" role first.']);
            }

            // Plain equality: utf8mb4_general_ci already compares without regard
            // to case, and LOWER() on the column made this a full scan of `user`
            // rather than a unique-index hit. One row either way, but this runs on
            // every single-student create, against a table the importer grows.
            $lookup = $pdo->prepare('SELECT user_id, role, status FROM user WHERE email = :email LIMIT 1');
            $lookup->execute([':email' => $emailAddress]);
            $existingUser = $lookup->fetch(PDO::FETCH_ASSOC);

            if ($existingUser) {
                if ((int)$existingUser['role'] !== $roleId) {
                    api_out(409, ['message' => 'That email already belongs to a non-student account.']);
                }
                $linkCheck = $pdo->prepare('SELECT student_id FROM student WHERE user_id = :uid LIMIT 1');
                $linkCheck->execute([':uid' => (int)$existingUser['user_id']]);
                if ($linkCheck->fetch()) {
                    api_out(409, ['message' => 'That email is already linked to another student.']);
                }
                $userId = (int)$existingUser['user_id'];
                $linkedExistingUser = true;
            } else {
                [$deptId, $campusId] = student_course_org_ids($pdo, $courseId);
                $tempPassword = student_generate_temp_password();

                // The account and the student row must land together: a login
                // with no student record (or vice versa) is worse than neither.
                $pdo->beginTransaction();

                $insUser = $pdo->prepare(
                    'INSERT INTO user (first_name, last_name, role, department, campus_id, status, email, password)
                     VALUES (:first, :last, :role, :department, :campus_id, :status, :email, :pwd)'
                );
                $insUser->execute([
                    ':first' => $firstName,
                    ':last' => $lastName,
                    ':role' => $roleId,
                    ':department' => $deptId,
                    ':campus_id' => $campusId,
                    ':status' => student_active_status_id($pdo) ?: 1,
                    ':email' => $emailAddress,
                    ':pwd' => password_hash($tempPassword, PASSWORD_DEFAULT),
                ]);
                $createdUserId = (int)$pdo->lastInsertId();
                $userId = $createdUserId;
            }
        }

        $sql = 'INSERT INTO student (
                    student_number, `star e-profile`, first_name, last_name, middle_name, extension_name, gender, email_address,
                    modality, mobile_number, mother_number, father_number, home_address, facebook_name,
                    course_id, user_id, schoolyear_id, batch_id, year_level, section, coaching_unit, final_scholarship_grant
                ) VALUES (
                    :student_number, :student_type, :first_name, :last_name, :middle_name, :extension_name, :gender, :email_address,
                    :modality, :mobile_number, :mother_number, :father_number, :home_address, :facebook_name,
                    :course_id, :user_id, :schoolyear_id, :batch_id, :year_level, :section, :coaching_unit, :final_scholarship_grant
                )';
        try {
        $stmt = $pdo->prepare($sql);
        $stmt->execute([
            ':student_number' => $studentNumber,
            ':student_type' => $studentType,
            ':first_name' => $firstName,
            ':last_name' => $lastName,
            ':middle_name' => $middleName,
            ':extension_name' => $extensionName,
            ':gender' => $gender,
            ':email_address' => $emailAddress,
            ':modality' => $modality,
            ':mobile_number' => $mobileNumber,
            ':mother_number' => $motherNumber,
            ':father_number' => $fatherNumber,
            ':home_address' => $homeAddress,
            ':facebook_name' => $facebookName,
            ':course_id' => $courseId,
            ':user_id' => $userId,
            ':schoolyear_id' => $schoolYearId,
            ':batch_id' => $batchId,
            ':year_level' => $yearLevel,
            ':section' => $section,
            ':coaching_unit' => $coachingUnit,
            ':final_scholarship_grant' => $finalGrant,
        ]);
        $newId = (int)$pdo->lastInsertId();
            if ($pdo->inTransaction()) {
                $pdo->commit();
            }
        } catch (Throwable $studentInsertError) {
            // Undo the account we just created rather than leaving an orphan login.
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $studentInsertError;
        }

        // A login that already existed keeps whatever name it was created with
        // unless it is brought in line here; a new one already matches.
        if ($linkedExistingUser) {
            student_sync_account_names($pdo, [$newId]);
        }

        // After commit: expire the temp password so first login forces a reset.
        $forcedChange = false;
        $emailResult = ['sent' => false, 'error' => null];
        if ($createdUserId > 0 && $tempPassword !== null) {
            $forcedChange = student_force_password_change($createdUserId);

            // Best-effort. The student and account are already committed, and the
            // password is shown on screen, so a mail failure is reported rather
            // than thrown.
            $displayName = trim(((string)$firstName) . ' ' . ((string)$lastName));
            $emailResult = student_send_welcome_email(
                $emailAddress,
                $displayName,
                $tempPassword,
                student_app_login_url()
            );
        }

        $sel = $pdo->prepare('SELECT *, `star e-profile` AS student_type FROM student WHERE student_id = :id LIMIT 1');
        $sel->execute([':id' => $newId]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        $payload = ['message' => 'Student created', 'data' => $row];
        if ($createdUserId > 0) {
            // Shown once. It is only stored hashed, so it cannot be retrieved later.
            $payload['account'] = [
                'created' => true,
                'user_id' => $createdUserId,
                'email' => $emailAddress,
                'temporary_password' => $tempPassword,
                'must_change_password' => $forcedChange,
                'email_sent' => (bool)$emailResult['sent'],
                // Distinct from a failure: sending was switched off in Settings,
                // so "could not email them" would be wrong.
                'email_skipped' => !empty($emailResult['skipped']),
                'email_error' => $emailResult['error'],
            ];
            $payload['message'] = $emailResult['sent']
                ? 'Student created; sign-in details emailed'
                : 'Student created with a new login account';
        } elseif ($linkedExistingUser) {
            $payload['account'] = [
                'created' => false,
                'linked' => true,
                'user_id' => $userId,
                'email' => $emailAddress,
            ];
            $payload['message'] = 'Student created and linked to the existing account for that email';
        }

        api_out(201, $payload);
    }

        if ($method === 'PUT') {
            parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
            $id = isset($query['id']) ? (int)$query['id'] : 0;
        $raw = file_get_contents('php://input');
        $p = json_decode($raw, true);
        if (is_array($p) && !$id) { $id = isset($p['student_id']) ? (int)$p['student_id'] : 0; }
        if ($id <= 0) api_out(400, ['message' => 'Valid student id is required']);

        $chk = $pdo->prepare('SELECT *, `star e-profile` AS student_type FROM student WHERE student_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Student not found']);
        if (!is_array($p)) api_out(400, ['message' => 'Invalid JSON']);
        if (array_key_exists('user_id', $p)) api_out(400, ['message' => 'Account links cannot be assigned through student updates.']);

        /*
         * The same refusal POST makes, which update did not make at all - so a
         * name create rejected could be PUT onto the student a moment later.
         *
         * The strict/prose split matches create exactly: names and the student
         * number are identifiers, while an address and a Facebook name are
         * written text ("Blk 5 Lot 2 (near the chapel)" is a real address, and
         * the strict list would refuse it over the brackets).
         */
        $unsafe = api_reject_unsafe_fields($p, [
            'first_name' => 'First name',
            'middle_name' => 'Middle name',
            'last_name' => 'Last name',
            'extension_name' => 'Extension name',
            'student_number' => 'Student number',
        ], 'strict');
        $unsafe = $unsafe ?? api_reject_unsafe_fields($p, [
            'home_address' => 'Home address',
            'facebook_name' => 'Facebook name',
        ], 'prose');
        if ($unsafe !== null) api_out(400, ['message' => $unsafe]);

        if (!api_student_type_is_allowed($authUser, $existing['student_type'] ?? null)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }

        if ($isDepartmentPinned) {
            if ($pinnedDepartmentId <= 0) api_out(403, ['message' => 'This account is not linked to a department']);
            if (!student_in_department($pdo, $id, $pinnedDepartmentId)) api_out(403, ['message' => 'Forbidden']);
        }

        $fields = [];
        $params = [':id' => $id];
        $archiveProvided = array_key_exists('archived', $p);

        // 'gender' is handled on its own below: it is an enum now, and the generic
        // text path would write an unvalidated value straight through.
        $textCols = ['student_number', 'first_name', 'last_name', 'middle_name', 'extension_name', 'email_address', 'mobile_number', 'mother_number', 'father_number', 'home_address', 'facebook_name', 'section'];
        foreach ($textCols as $col) {
            if (array_key_exists($col, $p)) {
                $val = in_array($col, STUDENT_NAME_COLUMNS, true)
                    ? normalize_student_name($p[$col])
                    : as_nullable_text($p[$col]);
                if ($col === 'student_number' && $val === null) api_out(400, ['message' => 'student_number cannot be empty']);
                if ($col === 'first_name' && $val === null) api_out(400, ['message' => 'first_name cannot be empty']);
                if ($col === 'last_name' && $val === null) api_out(400, ['message' => 'last_name cannot be empty']);
                if ($col === 'email_address' && $val !== null && !filter_var($val, FILTER_VALIDATE_EMAIL)) api_out(400, ['message' => 'email_address is invalid']);
                if ($col === 'student_number' && $val !== null) {
                    $numberError = student_number_validate($val);
                    if ($numberError !== '') api_out(400, ['message' => $numberError]);
                    $val = student_number_normalize($val);
                }
                if ($col === 'section' && $val !== null) {
                    $sectionError = section_validate($val);
                    if ($sectionError !== '') api_out(400, ['message' => $sectionError]);
                    $val = section_normalize($val);
                }
                $fields[] = "$col = :$col";
                $params[":$col"] = $val;
            }
        }

        if (array_key_exists('modality', $p)) {
            // Blank is refused on edit rather than defaulted, as it always was.
            $modality = student_field_normalize($pdo, 'modalities', $p['modality']);
            if (!is_string($modality)) api_out(400, ['message' => 'modality must be one of: ' . student_field_choices($pdo, 'modalities')]);
            $fields[] = 'modality = :modality';
            $params[':modality'] = $modality;
        }

        if (array_key_exists('student_type', $p)) {
            $studentType = normalize_student_type($p['student_type']);
            if ($studentType === null) api_out(400, ['message' => 'student_type must be ' . STUDENT_TYPE_STAR . ' or ' . STUDENT_TYPE_NON_STAR]);
            if (!api_student_type_is_allowed($authUser, $studentType)) {
                api_out(403, ['message' => api_student_type_access_denied_message()]);
            }
            $fields[] = '`star e-profile` = :student_type';
            $params[':student_type'] = $studentType;
        }

        if (array_key_exists('final_scholarship_grant', $p)) {
            // Null is allowed on edit where it was not on create: clearing a
            // grant that was entered by mistake has to be possible, and every
            // row is blank right now after the 2026-08-21 replacement.
            $grant = normalize_scholarship_grant($pdo, $p['final_scholarship_grant']);
            if ($grant === false) {
                api_out(400, ['message' => 'final_scholarship_grant must be one of: ' . student_field_choices($pdo, 'scholarship_grants')]);
            }
            $fields[] = 'final_scholarship_grant = :final_scholarship_grant';
            $params[':final_scholarship_grant'] = $grant;
        }

        // Same silent-coercion trap as on create: an out-of-enum gender is
        // stored as an empty string by MySQL rather than refused.
        if (array_key_exists('gender', $p)) {
            $genderValue = normalize_gender($pdo, $p['gender']);
            if ($genderValue === false) {
                api_out(400, ['message' => 'gender must be one of: ' . student_field_choices($pdo, 'genders')]);
            }
            $fields[] = 'gender = :gender_value';
            $params[':gender_value'] = $genderValue;
        }

        $intCols = ['course_id', 'user_id', 'schoolyear_id', 'batch_id', 'year_level', 'coaching_unit'];
        foreach ($intCols as $col) {
            if (array_key_exists($col, $p)) {
                $val = as_nullable_int($p[$col]);
                $fields[] = "$col = :$col";
                $params[":$col"] = $val;
            }
        }

        $courseId = array_key_exists(':course_id', $params) ? $params[':course_id'] : null;
        if ($isDepartmentPinned && $courseId !== null && !course_in_department($pdo, (int)$courseId, $pinnedDepartmentId)) {
            api_out(403, ['message' => 'You can only assign students to courses in your department']);
        }
        if ($courseId !== null && !api_fk_exists($pdo, 'SELECT course_id FROM course WHERE course_id = :id LIMIT 1', $courseId)) {
            api_out(400, ['message' => 'Selected course does not exist']);
        }

        // A partial update may carry only the course or only the year, and
        // moving a Year 5 Architecture student into a four-year programme is
        // just as invalid as typing Year 5 directly. Check the values the row
        // will actually end up with, not just the ones in this payload.
        if (array_key_exists('course_id', $p) || array_key_exists('year_level', $p)) {
            $currentStmt = $pdo->prepare('SELECT course_id, year_level FROM student WHERE student_id = :id LIMIT 1');
            $currentStmt->execute([':id' => $id]);
            $current = $currentStmt->fetch(PDO::FETCH_ASSOC) ?: [];

            $effectiveCourseId = array_key_exists(':course_id', $params)
                ? ($params[':course_id'] !== null ? (int)$params[':course_id'] : null)
                : (isset($current['course_id']) ? (int)$current['course_id'] : null);
            $effectiveYearLevel = array_key_exists(':year_level', $params)
                ? ($params[':year_level'] !== null ? (int)$params[':year_level'] : null)
                : (isset($current['year_level']) ? (int)$current['year_level'] : null);

            assert_year_level_fits_course($pdo, $effectiveCourseId, $effectiveYearLevel);
        }

        /*
         * The same "check what the row ends up with" rule for the section name.
         * Moving a student to another course without retyping the section would
         * otherwise leave COC-FAB-BSIT3-04 sitting on a BEED-ECE record, which
         * is how the one contradicting section already in the table got there.
         */
        $effectiveSection = array_key_exists(':section', $params) ? $params[':section'] : ($existing['section'] ?? null);
        if ($effectiveSection !== null && $effectiveSection !== '') {
            $sectionCourseId = array_key_exists(':course_id', $params)
                ? ($params[':course_id'] !== null ? (int)$params[':course_id'] : null)
                : (isset($existing['course_id']) ? (int)$existing['course_id'] : null);
            $sectionYearLevel = array_key_exists(':year_level', $params)
                ? ($params[':year_level'] !== null ? (int)$params[':year_level'] : null)
                : (isset($existing['year_level']) ? (int)$existing['year_level'] : null);

            $mismatch = section_matches_course($effectiveSection, course_code_for($pdo, $sectionCourseId), $sectionYearLevel);
            if ($mismatch !== '') api_out(400, ['message' => $mismatch]);
        }

        $userId = array_key_exists(':user_id', $params) ? $params[':user_id'] : null;
        if ($userId !== null) {
            if (!api_fk_exists($pdo, 'SELECT user_id FROM user WHERE user_id = :id LIMIT 1', $userId)) {
                api_out(400, ['message' => 'Selected user does not exist']);
            }
            $dup = $pdo->prepare('SELECT student_id FROM student WHERE user_id = :uid AND student_id <> :id LIMIT 1');
            $dup->execute([':uid' => $userId, ':id' => $id]);
            if ($dup->fetch()) api_out(409, ['message' => 'A student is already linked to this user']);
        }

        $schoolYearId = array_key_exists(':schoolyear_id', $params) ? $params[':schoolyear_id'] : null;
        if ($schoolYearId !== null && !api_fk_exists($pdo, 'SELECT school_year_id FROM school_year WHERE school_year_id = :id LIMIT 1', $schoolYearId)) {
            api_out(400, ['message' => 'Selected school year does not exist']);
        }

        $batchId = array_key_exists(':batch_id', $params) ? $params[':batch_id'] : null;
        if ($batchId !== null && !api_fk_exists($pdo, 'SELECT batch_id FROM batch WHERE batch_id = :id LIMIT 1', $batchId)) {
            api_out(400, ['message' => 'Selected batch does not exist']);
        }

        $coachingUnit = array_key_exists(':coaching_unit', $params) ? $params[':coaching_unit'] : null;
        if ($coachingUnit !== null && !api_fk_exists($pdo, 'SELECT coaching_unit_id FROM coaching_unit WHERE coaching_unit_id = :id LIMIT 1', $coachingUnit)) {
            api_out(400, ['message' => 'Selected coaching unit does not exist']);
        }

        if ($archiveProvided && $hasArchivedAt) {
            $fields[] = 'archived_at = :archived_at';
            $params[':archived_at'] = api_bool_like($p['archived'], false) ? date('Y-m-d H:i:s') : null;
        }

        if (empty($fields)) api_out(200, ['message' => 'No changes']);

        $sql = 'UPDATE student SET ' . implode(', ', $fields) . ' WHERE student_id = :id';
        $upd = $pdo->prepare($sql);
        $upd->execute($params);

        /*
         * Carry the new name to the student's own login account.
         *
         * The account is created from these two fields on POST and then never
         * heard from again, so a rename left the sign-in header, the audit log
         * and every notification list still printing the old name - and, before
         * the accounts were uppercased, still printing it in the old case. Both
         * columns are already normalized above, so this writes what the student
         * record holds rather than re-deriving it.
         *
         * Scoped to the linked account only. A student sharing an email with a
         * staff account links to that account instead, and renaming a member of
         * staff because a student was edited would be plainly wrong.
         */
        $nameChanged = array_key_exists(':first_name', $params) || array_key_exists(':last_name', $params);
        // A newly linked login is brought in line too, not only a renamed one.
        if ($nameChanged || array_key_exists(':user_id', $params)) {
            student_sync_account_names($pdo, [$id]);
        }

        $sel = $pdo->prepare('SELECT *, `star e-profile` AS student_type FROM student WHERE student_id = :id LIMIT 1');
        $sel->execute([':id' => $id]);
        $row = $sel->fetch(PDO::FETCH_ASSOC);

        /*
         * Who edited this student, and what they touched.
         *
         * Creation is deliberately NOT audited here. Student Management imports
         * by POSTing one row per student, so auditing creates would add a write
         * per row to an import already sending a thousand requests, and would
         * bury every other kind of action under a thousand near-identical rows.
         * A created student is its own evidence — the record exists. An edit is
         * not: it overwrites what was there, leaving nothing to say who changed
         * what.
         *
         * Archiving and restoring go in under their own names rather than as
         * "Edited student 02-2324-10233: archived at". That phrasing describes
         * the column instead of the act, and it puts the one change worth
         * filtering for — a student taken out of circulation — under the same
         * label as a corrected middle name.
         */
        $studentLabel = (string)($row['student_number'] ?? ('#' . $id))
            . ' (' . trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? '')) . ')';
        $auditMeta = ['student_id' => $id, 'student_number' => $row['student_number'] ?? null];
        $onlyArchiveChanged = $fields === ['archived_at = :archived_at'];

        if ($onlyArchiveChanged) {
            $nowArchived = $params[':archived_at'] !== null;
            student_audit(
                $pdo,
                $authUser,
                $nowArchived ? 'student_archived' : 'student_restored',
                ($nowArchived ? 'Archived student ' : 'Restored student ') . $studentLabel . '.',
                $auditMeta
            );
        } else {
            student_audit(
                $pdo,
                $authUser,
                'student_updated',
                'Edited student ' . $studentLabel . ': ' . implode(', ', student_changed_labels($fields)) . '.',
                $auditMeta
            );
        }

        api_out(200, ['message' => 'Student updated', 'data' => $row]);
    }

    if ($method === 'DELETE') {
        parse_str($_SERVER['QUERY_STRING'] ?? '', $query);
        $id = isset($query['id']) ? (int)$query['id'] : 0;
        if ($id <= 0) api_out(400, ['message' => 'Valid student id is required']);

        // The number and name come back with the permission check because this
        // row may be about to be deleted outright, and an audit line reading
        // "deleted student #418" names something nobody can look up afterwards.
        $chk = $pdo->prepare('SELECT student_id, student_number, first_name, last_name, `star e-profile` AS student_type
                                FROM student WHERE student_id = :id LIMIT 1');
        $chk->execute([':id' => $id]);
        $existing = $chk->fetch(PDO::FETCH_ASSOC);
        if (!$existing) api_out(404, ['message' => 'Student not found']);
        if (!api_student_type_is_allowed($authUser, $existing['student_type'] ?? null)) {
            api_out(403, ['message' => api_student_type_access_denied_message()]);
        }

        if ($isDepartmentPinned) {
            if ($pinnedDepartmentId <= 0) api_out(403, ['message' => 'This account is not linked to a department']);
            if (!student_in_department($pdo, $id, $pinnedDepartmentId)) api_out(403, ['message' => 'Forbidden']);
        }

        $studentLabel = (string)($existing['student_number'] ?? ('#' . $id))
            . ' (' . trim((string)($existing['first_name'] ?? '') . ' ' . (string)($existing['last_name'] ?? '')) . ')';
        $auditMeta = ['student_id' => $id, 'student_number' => $existing['student_number'] ?? null];

        if ($hasArchivedAt) {
            $archive = $pdo->prepare('UPDATE student SET archived_at = :archived_at WHERE student_id = :id');
            $archive->execute([
                ':archived_at' => date('Y-m-d H:i:s'),
                ':id' => $id,
            ]);

            student_audit($pdo, $authUser, 'student_archived', 'Archived student ' . $studentLabel . '.', $auditMeta);
            api_out(200, ['message' => 'Student archived']);
        }

        $del = $pdo->prepare('DELETE FROM student WHERE student_id = :id');
        $del->execute([':id' => $id]);

        student_audit($pdo, $authUser, 'student_deleted', 'Permanently deleted student ' . $studentLabel . '.', $auditMeta);
        api_out(200, ['message' => 'Student deleted']);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    api_out(500, ['message' => 'Server error', 'error' => $e->getMessage()]);
}
