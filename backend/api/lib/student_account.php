<?php
/**
 * Provisioning a student's portal login.
 *
 * Lifted out of student.php unchanged so that student-import.php can create
 * accounts the same way one-at-a-time creation does. Two copies of
 * "what a new student account looks like" would drift the first time the
 * temporary-password rules or the welcome email changed, and the drift would
 * show up as students who cannot sign in.
 *
 * student.php still owns the single-student POST; this file owns nothing but
 * the helpers both paths call.
 */

// student_send_welcome_email() sends through api_mail_send(). Required here, by
// the file that calls it, so every endpoint that loads this lib can use it.
require_once __DIR__ . '/../mail_template.php';

if (!defined('STUDENT_ACCOUNT_LIB')) {
    define('STUDENT_ACCOUNT_LIB', 1);

    /**
     * Temporary password for an auto-created student account.
     * Built to satisfy api_validate_password_strength(): >= 8 chars with at least
     * one uppercase, one lowercase and one digit. Ambiguous glyphs (O/0, I/l/1) are
     * excluded because this gets read aloud or copied off a screen.
     */
    function student_generate_temp_password(): string {
        $upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
        $lower = 'abcdefghijkmnpqrstuvwxyz';
        $digit = '23456789';
        $all = $upper . $lower . $digit;

        $chars = [
            $upper[random_int(0, strlen($upper) - 1)],
            $lower[random_int(0, strlen($lower) - 1)],
            $digit[random_int(0, strlen($digit) - 1)],
        ];
        for ($i = 0; $i < 7; $i++) {
            $chars[] = $all[random_int(0, strlen($all) - 1)];
        }

        // Fisher-Yates, so the guaranteed characters are not always in front.
        for ($i = count($chars) - 1; $i > 0; $i--) {
            $j = random_int(0, $i);
            [$chars[$i], $chars[$j]] = [$chars[$j], $chars[$i]];
        }

        return implode('', $chars);
    }

    /**
     * Absolute URL of the login page, for the welcome email.
     * APP_URL in .env.local wins; otherwise fall back to the requesting origin,
     * which is correct whenever an admin triggers this from the browser.
     */
    function student_app_login_url(): string {
        $configured = function_exists('api_mail_env') ? trim((string)(api_mail_env('APP_URL') ?? '')) : '';
        if ($configured !== '') {
            return rtrim($configured, '/') . '/';
        }

        $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
        if ($origin === '' && !empty($_SERVER['HTTP_HOST'])) {
            $scheme = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') ? 'https' : 'http';
            $origin = $scheme . '://' . $_SERVER['HTTP_HOST'];
        }
        if ($origin === '') {
            return '';
        }

        // Dev layout serves the SPA from /RMS-v3-public/frontend/.
        $script = (string)($_SERVER['SCRIPT_NAME'] ?? '');
        if (strpos($script, '/RMS-v3-public/') === 0) {
            return rtrim($origin, '/') . '/RMS-v3-public/frontend/';
        }

        return rtrim($origin, '/') . '/';
    }

    /**
     * Email the new student their sign-in details.
     * Best-effort by design: the account already exists and the caller is shown the
     * password on screen, so a mail failure must never fail student creation.
     *
     * @return array{sent:bool,error:?string}
     */
    function student_send_welcome_email(string $email, string $displayName, string $tempPassword, string $loginUrl): array {
        // $loginUrl is accepted but deliberately not rendered as a link: a clickable
        // sign-in link in a credential email is a phishing pattern, and it trains
        // students to sign in from email. They navigate to the portal themselves.
        unset($loginUrl);

        return api_mail_send([
            'to' => $email,
            'to_name' => $displayName !== '' ? $displayName : $email,
            'from_name' => 'Student Portal',
            'subject' => 'Your student portal account',
            'log_event' => 'student_welcome_email_failed',
            'heading' => 'Your student portal account is ready',
            'preheader' => 'Sign in with your temporary password, then choose a new one.',
            'greeting' => 'Hello ' . ($displayName !== '' ? $displayName : 'student') . ',',
            'intro' => ['A student portal account has been created for you. Use these details to sign in:'],
            'rows' => [
                ['Email', $email, false],
                ['Temporary password', $tempPassword, true],
            ],
            'note' => 'Open the student portal yourself and sign in with the details above. '
                . 'You will be asked to choose a new password the first time you sign in, and we will email you '
                . 'a verification code to confirm the change. '
                . 'If you did not expect this email, please contact your department office.',
            'alt' => "Hello $displayName,\n\n"
                . "A student portal account has been created for you.\n\n"
                . "Email: $email\n"
                . "Temporary password: $tempPassword\n"
                . "\nOpen the student portal yourself and sign in with the details above.\n"
                . "You will be asked to choose a new password the first time you sign in, "
                . "and we will email you a verification code to confirm the change.\n",
        ]);
    }

    function student_role_id(PDO $pdo): int {
        $stmt = $pdo->query("SELECT role_id FROM role WHERE LOWER(role_name) = 'student' LIMIT 1");
        return (int)($stmt->fetchColumn() ?: 0);
    }

    /**
     * Give each linked student login the student record's name.
     *
     * The student record IS the student's account: its name is the source, and
     * the login's copy is what the sign-in header, the audit log and every
     * notification list print. They drifted because only an edit on the student
     * screen carried a rename across - a student created or imported with the
     * email of an EXISTING login was linked to it and kept whatever name that
     * login already had. By 2026-09-25, 201 of 205 linked logins disagreed.
     *
     * Student-role logins only: a student whose email matches a staff account is
     * linked to that account, and renaming staff because a student was edited
     * would be plainly wrong.
     *
     * $studentIds null means every linked student - the import and the one-off
     * backfill use that. Returns the number of logins changed.
     */
    function student_sync_account_names(PDO $pdo, ?array $studentIds = null): int {
        $sql = 'UPDATE user u
                  JOIN student s ON s.user_id = u.user_id
                   SET u.first_name = s.first_name,
                       u.last_name  = s.last_name
                 WHERE u.role = ?
                   AND (NOT (BINARY u.first_name <=> BINARY s.first_name)
                        OR NOT (BINARY u.last_name <=> BINARY s.last_name))';
        $params = [student_role_id($pdo)];
        if ($studentIds !== null) {
            $ids = array_values(array_unique(array_filter(array_map('intval', $studentIds))));
            if (!$ids) {
                return 0;
            }
            $sql .= ' AND s.student_id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')';
            $params = array_merge($params, $ids);
        }
        $stmt = $pdo->prepare($sql);
        $stmt->execute($params);
        return $stmt->rowCount();
    }

    /** Active account status id, so auto-created logins are usable immediately. */
    function student_active_status_id(PDO $pdo): int {
        $stmt = $pdo->query("SELECT status_id FROM status WHERE status_type = 'account' AND LOWER(status_name) = 'active' LIMIT 1");
        return (int)($stmt->fetchColumn() ?: 0);
    }

    /** department_id + campus_id inherited from the student's course. */
    function student_course_org_ids(PDO $pdo, ?int $courseId): array {
        if ($courseId === null) return [null, null];
        $stmt = $pdo->prepare(
            'SELECT c.department_id, d.campus_id
             FROM course c LEFT JOIN department d ON d.department_id = c.department_id
             WHERE c.course_id = :id LIMIT 1'
        );
        $stmt->execute([':id' => $courseId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC) ?: [];
        return [
            isset($row['department_id']) ? (int)$row['department_id'] : null,
            isset($row['campus_id']) ? (int)$row['campus_id'] : null,
        ];
    }

    /**
     * Make the temp password expire immediately so the existing
     * force_password_change path sends the student to /change-password on first
     * login. Best-effort: a failure here must not roll back a created student.
     */
    function student_force_password_change(int $userId): bool {
        if ($userId <= 0 || !function_exists('api_password_expiration_update_user_state')) {
            return false;
        }
        try {
            api_password_expiration_update_user_state($userId, static function (array $current): array {
                // Backdated far enough to beat any configured max-age policy.
                $current['password_changed_at'] = '2000-01-01 00:00:00';
                $current['temp_password_issued'] = true;
                return $current;
            });
            return true;
        } catch (Throwable $e) {
            return false;
        }
    }

}
