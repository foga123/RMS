<?php

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'PUT', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/mail_config.php';
require_once __DIR__ . '/mail_template.php';

// PHPMailer is loaded on demand by api_mail_send().

const PROFILE_CAPTCHA_SESSION_KEY = 'profile_update_captcha';
const PROFILE_OTP_SESSION_KEY = 'profile_update_otp';
const PROFILE_CAPTCHA_TTL_SECONDS = 180;
const PROFILE_OTP_TTL_SECONDS = 600;
const PROFILE_OTP_COOLDOWN_SECONDS = 60;
const PROFILE_OTP_MAX_ATTEMPTS = 5;
const PROFILE_HISTORY_LIMIT = 8;

function profile_iso8601(?int $timestamp): ?string
{
    if (!$timestamp || $timestamp <= 0) {
        return null;
    }

    return gmdate('c', $timestamp);
}

function profile_user_display_name(array $userRow): string
{
    $fullName = trim((string)($userRow['first_name'] ?? '') . ' ' . (string)($userRow['last_name'] ?? ''));
    if ($fullName !== '') {
        return $fullName;
    }

    $email = trim((string)($userRow['email'] ?? ''));
    return $email !== '' ? $email : 'User';
}

function profile_mask_email(string $email): string
{
    $email = trim($email);
    if ($email === '' || strpos($email, '@') === false) {
        return $email;
    }

    [$localPart, $domain] = explode('@', $email, 2);
    $visibleLocal = substr($localPart, 0, 1);
    $localMask = strlen($localPart) > 1 ? str_repeat('*', max(1, strlen($localPart) - 1)) : '*';

    $domainParts = explode('.', $domain);
    $domainName = $domainParts[0] ?? '';
    $domainSuffix = isset($domainParts[1]) ? '.' . implode('.', array_slice($domainParts, 1)) : '';
    $visibleDomain = substr($domainName, 0, 1);
    $domainMask = strlen($domainName) > 1 ? str_repeat('*', max(1, strlen($domainName) - 1)) : '*';

    return $visibleLocal . $localMask . '@' . $visibleDomain . $domainMask . $domainSuffix;
}

function profile_has_user_phone_column(PDO $pdo): bool
{
    $stmt = $pdo->query("SHOW COLUMNS FROM `user` LIKE 'phone_number'");
    return (bool)$stmt->fetch(PDO::FETCH_ASSOC);
}

function profile_ensure_user_phone_column(PDO $pdo): void
{
    api_require_column($pdo, 'user', 'phone_number');
}

/**
 * Kept as a no-op rather than deleted from its two call sites.
 *
 * It used to assert the legacy `audit_logs` table before writing to it.
 * api_write_audit_log() now records into `api_audit_log` — the table the Audit
 * Logs screen actually reads — and creates it itself, so there is nothing left
 * to check here. The two calls below read as "make sure auditing is ready",
 * which is still the right thing to say at those points if the audit target
 * ever changes again.
 */
function profile_ensure_audit_logs_table(PDO $pdo): void
{
}

function profile_fetch_user_context(PDO $pdo, int $userId): ?array
{
    $phoneSelect = profile_has_user_phone_column($pdo)
        ? "COALESCE(NULLIF(TRIM(u.phone_number), ''), NULLIF(TRIM(st.mobile_number), '')) AS phone_number,"
        : "NULLIF(TRIM(st.mobile_number), '') AS phone_number,";

    $campusSelect = api_user_table_has_campus_column($pdo)
        ? 'COALESCE(u.campus_id, d.campus_id) AS campus_id,'
        : 'd.campus_id AS campus_id,';
    $campusJoin = api_user_table_has_campus_column($pdo)
        ? 'LEFT JOIN campus c ON c.campus_id = COALESCE(u.campus_id, d.campus_id)'
        : 'LEFT JOIN campus c ON c.campus_id = d.campus_id';

    $sql = "SELECT
                u.user_id,
                u.first_name,
                u.last_name,
                u.email,
                $phoneSelect
                u.role AS role_id,
                r.role_name,
                u.department AS department_id,
                d.department_name,
                $campusSelect
                c.campus_name,
                u.status,
                s.status_name,
                s.status_type,
                st.student_id,
                st.student_number
            FROM user u
            LEFT JOIN role r ON r.role_id = u.role
            LEFT JOIN department d ON d.department_id = u.department
            $campusJoin
            LEFT JOIN status s ON s.status_id = u.status
            LEFT JOIN student st ON st.user_id = u.user_id
            WHERE u.user_id = :user_id
            LIMIT 1";

    $stmt = $pdo->prepare($sql);
    $stmt->execute([':user_id' => $userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

function profile_normalize_phone($value, bool $allowEmpty = true): ?string
{
    $raw = trim((string)$value);
    if ($raw === '') {
        return $allowEmpty ? null : '';
    }

    $hasPlus = strpos($raw, '+') === 0;
    $digits = preg_replace('/\D+/', '', $raw);
    if (!$digits) {
        api_json_response(400, ['message' => 'Phone number must contain digits only']);
    }

    $length = strlen($digits);
    if ($length < 10 || $length > 15) {
        api_json_response(400, ['message' => 'Phone number must be between 10 and 15 digits']);
    }

    return ($hasPlus ? '+' : '') . $digits;
}

/*
 * A student's email is the school's to set (the @phinmaed.com address), not
 * theirs, so a student may change only the contact number on their profile.
 * Refused here rather than only greyed out in the form, so no client can send
 * one past it.
 */
function profile_is_student(array $userRow): bool
{
    return api_session_user_has_role($userRow, ['student']);
}

function profile_validate_requested_changes(array $payload, array $currentUser): array
{
    $currentEmail = trim((string)($currentUser['email'] ?? ''));
    $currentPhone = profile_normalize_phone($currentUser['phone_number'] ?? null, true);
    $isStudent = profile_is_student($currentUser);

    $email = array_key_exists('email', $payload) ? trim((string)$payload['email']) : $currentEmail;
    $phoneNumber = array_key_exists('phone_number', $payload)
        ? profile_normalize_phone($payload['phone_number'], true)
        : $currentPhone;

    if ($isStudent && strcasecmp($email, $currentEmail) !== 0) {
        api_json_response(403, [
            'message' => 'Students cannot change their email address. Only the contact number can be updated.',
        ]);
    }
    // Callers ring the number on the student record, so a student may change
    // it but not blank it.
    if ($isStudent && ($phoneNumber === null || $phoneNumber === '')) {
        api_json_response(400, ['message' => 'Enter your contact number.']);
    }

    if ($email === '' || !filter_var($email, FILTER_VALIDATE_EMAIL)) {
        api_json_response(400, ['message' => 'A valid email address is required']);
    }

    $changes = [];
    if (strcasecmp($email, $currentEmail) !== 0) {
        $changes['email'] = [
            'before' => $currentEmail,
            'after' => $email,
        ];
    }

    if (($phoneNumber ?? '') !== ($currentPhone ?? '')) {
        $changes['phone_number'] = [
            'before' => $currentPhone,
            'after' => $phoneNumber,
        ];
    }

    if (empty($changes)) {
        api_json_response(400, ['message' => 'No profile changes detected']);
    }

    return [
        'email' => $email,
        'phone_number' => $phoneNumber,
        'current_email' => $currentEmail,
        'current_phone_number' => $currentPhone,
        'changes' => $changes,
    ];
}

function profile_assert_unique_email(PDO $pdo, int $userId, string $email): void
{
    $emailStmt = $pdo->prepare(
        'SELECT user_id
         FROM user
         WHERE user_id <> :user_id
           AND LOWER(TRIM(email)) = LOWER(TRIM(:email))
         LIMIT 1'
    );
    $emailStmt->execute([
        ':user_id' => $userId,
        ':email' => $email,
    ]);
    if ($emailStmt->fetch(PDO::FETCH_ASSOC)) {
        api_json_response(409, ['message' => 'Email address is already in use']);
    }
}

function profile_generate_captcha(bool $forceRefresh = false): array
{
    api_start_session();

    $existing = $_SESSION[PROFILE_CAPTCHA_SESSION_KEY] ?? null;
    $now = time();
    if (
        !$forceRefresh
        && is_array($existing)
        && !empty($existing['token'])
        && !empty($existing['expires_at'])
        && (int)$existing['expires_at'] > $now
    ) {
        return $existing;
    }

    // Answer capped at 100, matching the login CAPTCHA. The right operand is
    // drawn against what the left one left over, so the sum stays in range —
    // two independent 1-100 draws would reach 200. Two different ranges for the
    // same arithmetic check is the kind of drift nobody notices until one of
    // them is changed and the other is not.
    $captchaLeft = random_int(1, 99);
    $captcha = [
        'token' => bin2hex(random_bytes(16)),
        'left' => $captchaLeft,
        'right' => random_int(1, 100 - $captchaLeft),
        'answer' => null,
        'expires_at' => $now + PROFILE_CAPTCHA_TTL_SECONDS,
    ];
    $captcha['answer'] = $captcha['left'] + $captcha['right'];
    $_SESSION[PROFILE_CAPTCHA_SESSION_KEY] = $captcha;

    return $captcha;
}

function profile_captcha_payload(array $captcha): array
{
    return [
        'token' => $captcha['token'] ?? '',
        'left' => (int)($captcha['left'] ?? 0),
        'right' => (int)($captcha['right'] ?? 0),
        'expires_at' => profile_iso8601(isset($captcha['expires_at']) ? (int)$captcha['expires_at'] : null),
    ];
}

function profile_fail_with_captcha(string $message, int $statusCode = 422): void
{
    $captcha = profile_generate_captcha(true);
    api_json_response($statusCode, [
        'message' => $message,
        'verification' => [
            'captcha' => profile_captcha_payload($captcha),
        ],
    ]);
}

function profile_assert_valid_captcha(array $payload): void
{
    api_start_session();

    $captcha = $_SESSION[PROFILE_CAPTCHA_SESSION_KEY] ?? null;
    if (!is_array($captcha) || empty($captcha['token']) || empty($captcha['expires_at'])) {
        profile_fail_with_captcha('CAPTCHA verification has expired. Try again.');
    }

    $token = trim((string)($payload['captcha_token'] ?? ''));
    $answerRaw = trim((string)($payload['captcha_answer'] ?? ''));
    if ($token === '' || $answerRaw === '') {
        profile_fail_with_captcha('Complete the CAPTCHA challenge before saving.');
    }

    if ((int)$captcha['expires_at'] <= time()) {
        unset($_SESSION[PROFILE_CAPTCHA_SESSION_KEY]);
        profile_fail_with_captcha('CAPTCHA verification has expired. Try again.');
    }

    if (!hash_equals((string)$captcha['token'], $token)) {
        profile_fail_with_captcha('CAPTCHA verification is invalid. Try again.');
    }

    if (!ctype_digit(ltrim($answerRaw, '-')) || (int)$answerRaw !== (int)$captcha['answer']) {
        profile_fail_with_captcha('Incorrect CAPTCHA answer. Try again.');
    }
}

function profile_get_otp_session(): ?array
{
    api_start_session();

    $otp = $_SESSION[PROFILE_OTP_SESSION_KEY] ?? null;
    if (!is_array($otp)) {
        return null;
    }

    if (!empty($otp['expires_at']) && (int)$otp['expires_at'] <= time()) {
        unset($_SESSION[PROFILE_OTP_SESSION_KEY]);
        return null;
    }

    return $otp;
}

function profile_build_otp_payload(?array $otp): array
{
    if (!$otp) {
        return [
            'pending' => false,
            'verification_method' => 'email_otp',
            'masked_destination' => '',
            'cooldown_ends_at' => null,
            'expires_at' => null,
            'pending_email' => null,
            'pending_phone_number' => null,
        ];
    }

    return [
        'pending' => true,
        'verification_method' => $otp['verification_method'] ?? 'email_otp',
        'masked_destination' => $otp['masked_destination'] ?? '',
        'cooldown_ends_at' => profile_iso8601(isset($otp['cooldown_ends_at']) ? (int)$otp['cooldown_ends_at'] : null),
        'expires_at' => profile_iso8601(isset($otp['expires_at']) ? (int)$otp['expires_at'] : null),
        'pending_email' => $otp['pending_email'] ?? null,
        'pending_phone_number' => $otp['pending_phone_number'] ?? null,
    ];
}

function profile_build_verification_payload(array $userRow, array $captcha): array
{
    return [
        // The form reads this to lock the email field; see profile_is_student().
        'email_locked' => profile_is_student($userRow),
        'email_otp' => [
            'available' => api_mail_service_is_configured(),
            'message' => api_mail_service_is_configured()
                ? 'OTP emails will be sent to the email address you are verifying. If the code does not arrive right away, check spam or junk before resending.'
                : api_mail_configuration_error_message('Email OTP service'),
        ],
        'captcha' => profile_captcha_payload($captcha),
        'otp' => profile_build_otp_payload(profile_get_otp_session()),
    ];
}

function profile_send_email_otp(string $destination, string $code, array $userRow): void
{
    $displayName = profile_user_display_name($userRow);

    $result = api_mail_send([
        'to' => $destination,
        'to_name' => $displayName,
        'from_name' => 'COC Profile Security',
        'subject' => 'Your profile update verification code',
        'log_event' => 'profile_email_otp_send_failed',
        'heading' => 'Verify your profile update',
        'preheader' => 'Your profile update code expires in 10 minutes.',
        'greeting' => 'Hello ' . ($displayName !== '' ? $displayName : 'there') . ',',
        'intro' => ['Use the code below to verify the email address on your profile update request.'],
        'code' => $code,
        'code_note' => 'This code expires in 10 minutes.',
        'note' => 'If you did not request this change you can safely ignore this email. '
            . 'If you do not see it right away, check your spam or junk folder.',
        'alt' => 'Your profile update email verification code is ' . $code
            . '. It expires in 10 minutes. Check spam or junk if you do not see it.',
    ]);

    // Callers expect a throw so the request can answer 503.
    if (empty($result['sent'])) {
        throw new RuntimeException(
            api_mail_user_friendly_error_message((string)($result['error'] ?? ''), api_mail_config('COC Profile Security'))
        );
    }
}

function profile_dispatch_email_otp(string $destination, string $code, array $userRow): void
{
    profile_send_email_otp($destination, $code, $userRow);
}

function profile_store_otp_session(string $deliveryEmail, string $code, array $targets): array
{
    api_start_session();

    $otpState = [
        'verification_method' => 'email_otp',
        'destination' => $deliveryEmail,
        'masked_destination' => profile_mask_email($deliveryEmail),
        'code_hash' => password_hash($code, PASSWORD_DEFAULT),
        'expires_at' => time() + PROFILE_OTP_TTL_SECONDS,
        'cooldown_ends_at' => time() + PROFILE_OTP_COOLDOWN_SECONDS,
        'attempt_count' => 0,
        'pending_email' => $targets['email'],
        'pending_phone_number' => $targets['phone_number'],
    ];

    $_SESSION[PROFILE_OTP_SESSION_KEY] = $otpState;
    return $otpState;
}

function profile_assert_valid_otp(array $payload, array $targets): array
{
    api_start_session();

    $otpState = profile_get_otp_session();
    if (!$otpState) {
        api_json_response(400, ['message' => 'Request a new OTP before saving your profile']);
    }

    if (
        ($otpState['pending_email'] ?? null) !== $targets['email']
        || ($otpState['pending_phone_number'] ?? null) !== $targets['phone_number']
    ) {
        unset($_SESSION[PROFILE_OTP_SESSION_KEY]);
        api_json_response(400, ['message' => 'Your changes were updated after the OTP was sent. Request a new code and try again.']);
    }

    $otpCode = trim((string)($payload['otp_code'] ?? ''));
    if ($otpCode === '') {
        api_json_response(400, ['message' => 'Enter the OTP code before saving your profile']);
    }
    if (!preg_match('/^\d{6}$/', $otpCode)) {
        api_json_response(400, ['message' => 'Enter the 6-digit OTP code before saving your profile']);
    }

    $attemptCount = (int)($otpState['attempt_count'] ?? 0);
    if ($attemptCount >= PROFILE_OTP_MAX_ATTEMPTS) {
        unset($_SESSION[PROFILE_OTP_SESSION_KEY]);
        api_json_response(429, ['message' => 'Too many incorrect OTP attempts. Request a new code and try again.']);
    }

    if (!password_verify($otpCode, (string)($otpState['code_hash'] ?? ''))) {
        $attemptCount++;
        $otpState['attempt_count'] = $attemptCount;
        $_SESSION[PROFILE_OTP_SESSION_KEY] = $otpState;

        if ($attemptCount >= PROFILE_OTP_MAX_ATTEMPTS) {
            unset($_SESSION[PROFILE_OTP_SESSION_KEY]);
            api_json_response(429, ['message' => 'Too many incorrect OTP attempts. Request a new code and try again.']);
        }

        $remainingAttempts = PROFILE_OTP_MAX_ATTEMPTS - $attemptCount;
        $attemptLabel = $remainingAttempts === 1 ? 'attempt' : 'attempts';
        api_json_response(422, ['message' => 'Incorrect OTP code. ' . $remainingAttempts . ' ' . $attemptLabel . ' remaining.']);
    }
    return $otpState;
}

function profile_fetch_history(PDO $pdo, int $userId, int $limit = PROFILE_HISTORY_LIMIT): array
{
    profile_ensure_audit_logs_table($pdo);

    $stmt = $pdo->prepare(
        'SELECT audit_log_id, action, detail, metadata, created_at
         FROM audit_logs
         WHERE user_id = :user_id
           AND action = :action
         ORDER BY created_at DESC, audit_log_id DESC
         LIMIT :limit'
    );
    $stmt->bindValue(':user_id', $userId, PDO::PARAM_INT);
    $stmt->bindValue(':action', 'profile_updated');
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->execute();

    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    return array_map(static function (array $row): array {
        $metadata = json_decode((string)($row['metadata'] ?? ''), true);
        $changes = is_array($metadata['changes'] ?? null) ? $metadata['changes'] : [];

        return [
            'id' => (int)($row['audit_log_id'] ?? 0),
            'action' => (string)($row['action'] ?? ''),
            'detail' => (string)($row['detail'] ?? ''),
            'created_at' => $row['created_at'] ?? null,
            'changes' => $changes,
        ];
    }, $rows);
}

function profile_write_audit_log(PDO $pdo, array $updatedUser, array $changes, array $verificationContext): void
{
    $changeLabels = [];
    foreach ($changes as $field => $change) {
        $changeLabels[] = $field === 'phone_number' ? 'phone number' : 'email address';
    }
    $detail = 'Updated ' . implode(' and ', $changeLabels) . '.';
    $metadata = json_encode([
        'changes' => $changes,
        'verified_via' => $verificationContext['verification_method'] ?? 'email_otp',
        'verified_destination' => $verificationContext['masked_destination'] ?? null,
    ], JSON_UNESCAPED_UNICODE);

    $stmt = $pdo->prepare(
        'INSERT INTO audit_logs (user_id, action, detail, email_snapshot, role_id_snapshot, role_name_snapshot, metadata)
         VALUES (:user_id, :action, :detail, :email_snapshot, :role_id_snapshot, :role_name_snapshot, :metadata)'
    );
    $stmt->execute([
        ':user_id' => (int)($updatedUser['user_id'] ?? 0),
        ':action' => 'profile_updated',
        ':detail' => $detail,
        ':email_snapshot' => $updatedUser['email'] ?? null,
        ':role_id_snapshot' => isset($updatedUser['role_id']) ? (int)$updatedUser['role_id'] : null,
        ':role_name_snapshot' => $updatedUser['role_name'] ?? null,
        ':metadata' => $metadata !== false ? $metadata : null,
    ]);

    /*
     * The same event, again, in the log the Audit Logs screen reads.
     *
     * Deliberately a second write rather than a redirect. `audit_logs` is not
     * dead for this endpoint the way it is elsewhere: profile_fetch_history()
     * above selects these exact rows back — by user_id and action — to build the
     * "recent changes to your profile" list, and it needs the structured
     * `metadata` JSON that api_audit_log has no column for. Moving the write
     * would empty that list.
     *
     * So each table keeps the row it has a reader for: `audit_logs` for the
     * profile's own history, `api_audit_log` for the administrator asking who
     * changed which email address and when. Without this second line, a profile
     * change was the one account edit that appeared nowhere in the audit trail.
     */
    api_write_audit_log($pdo, $updatedUser, 'profile_updated', $detail, [
        'target_user_id' => (int)($updatedUser['user_id'] ?? 0),
        'changed' => array_keys($changes),
        'verified_via' => $verificationContext['verification_method'] ?? 'email_otp',
    ]);
}

try {
    $db = new Database();
    $pdo = $db->connect();

    $sessionUser = api_get_session_user();
    if (!$sessionUser || empty($sessionUser['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    $userId = (int)$sessionUser['user_id'];
    $currentUser = profile_fetch_user_context($pdo, $userId);
    if (!$currentUser) {
        api_json_response(404, ['message' => 'User not found']);
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET') {
        $refreshCaptcha = isset($_GET['refresh_captcha']) && (string)$_GET['refresh_captcha'] === '1';
        $freshSessionUser = api_refresh_authenticated_user($pdo, false) ?: api_get_session_user();
        $captcha = profile_generate_captcha($refreshCaptcha);

        api_json_response(200, [
            'user' => $freshSessionUser,
            'history' => profile_fetch_history($pdo, $userId),
            'verification' => profile_build_verification_payload($currentUser, $captcha),
        ]);
    }

    if ($method === 'POST') {
        $payload = api_read_json_body();
        $action = strtolower(trim((string)($payload['action'] ?? '')));

        if ($action === 'refresh_captcha') {
            $captcha = profile_generate_captcha(true);
            api_json_response(200, [
                'message' => 'CAPTCHA refreshed',
                'verification' => [
                    'captcha' => profile_captcha_payload($captcha),
                ],
            ]);
        }

        if ($action !== 'send_otp') {
            api_json_response(400, ['message' => 'Unsupported profile action']);
        }

        $targets = profile_validate_requested_changes($payload, $currentUser);
        profile_assert_unique_email($pdo, $userId, $targets['email']);
        if (!api_mail_service_is_configured()) {
            api_json_response(503, [
                'message' => api_mail_configuration_error_message('Email OTP service'),
                'verification' => [
                    'email_otp' => [
                        'available' => false,
                        'message' => api_mail_configuration_error_message('Email OTP service'),
                    ],
                ],
            ]);
        }

        $existingOtp = profile_get_otp_session();
        if ($existingOtp && !empty($existingOtp['cooldown_ends_at']) && (int)$existingOtp['cooldown_ends_at'] > time()) {
            header('Retry-After: ' . max(1, (int)$existingOtp['cooldown_ends_at'] - time()));
            api_json_response(429, [
                'message' => 'Please wait before requesting another OTP code',
                'verification' => [
                    'otp' => profile_build_otp_payload($existingOtp),
                ],
            ]);
        }

        $deliveryEmail = trim((string)$targets['email']);
        if ($deliveryEmail === '') {
            api_json_response(400, ['message' => 'A valid email address is required for OTP delivery']);
        }

        /*
         * The cooldown above lives in the session, which the caller can shed by
         * dropping a cookie - and this code goes to an address the caller TYPES,
         * not one on file. Without these, any signed-in account could have the
         * portal mail any stranger as fast as the flood throttle allowed. One
         * bucket per account, and one per destination so a single inbox stays
         * protected however many accounts aim at it.
         */
        $otpSubjects = [
            ['profile_otp_user', (string)$userId],
            ['profile_otp_email', strtolower($deliveryEmail)],
        ];
        $otpReservation = api_rate_limit_reserve($pdo, $otpSubjects);
        if (!$otpReservation['allowed']) {
            $refused = $otpReservation['refused'];
            $minutes = max(1, (int)ceil($refused['retry_after'] / 60));
            api_rate_limit_respond($refused, sprintf(
                'Too many OTP codes requested. Try again in %d minute%s.',
                $minutes,
                $minutes === 1 ? '' : 's'
            ));
        }

        $otpCode = str_pad((string)random_int(0, 999999), 6, '0', STR_PAD_LEFT);

        try {
            profile_dispatch_email_otp($deliveryEmail, $otpCode, $currentUser);
        } catch (Throwable $throwable) {
            // Nothing was sent, so nothing is spent.
            foreach ($otpSubjects as [$bucket, $subject]) {
                api_rate_limit_refund($pdo, $bucket, $subject);
            }
            api_json_response(503, [
                'message' => $throwable->getMessage() ?: 'Failed to send email OTP',
                'verification' => [
                    'email_otp' => [
                        'available' => api_mail_service_is_configured(),
                        'message' => $throwable->getMessage() ?: 'Failed to send email OTP',
                    ],
                ],
            ]);
        }

        $otpState = profile_store_otp_session($deliveryEmail, $otpCode, $targets);

        api_json_response(200, [
            'message' => 'Email OTP sent successfully',
            'verification' => [
                'otp' => profile_build_otp_payload($otpState),
            ],
        ]);
    }

    if ($method === 'PUT') {
        $payload = api_read_json_body();
        $targets = profile_validate_requested_changes($payload, $currentUser);
        profile_assert_unique_email($pdo, $userId, $targets['email']);
        profile_assert_valid_captcha($payload);
        $verificationContext = profile_assert_valid_otp($payload, $targets);

        profile_ensure_user_phone_column($pdo);
        profile_ensure_audit_logs_table($pdo);

        $pdo->beginTransaction();
        try {
            $update = $pdo->prepare(
                'UPDATE user
                 SET email = :email,
                     phone_number = :phone_number
                 WHERE user_id = :user_id'
            );
            $update->bindValue(':email', $targets['email']);
            if ($targets['phone_number'] === null || $targets['phone_number'] === '') {
                $update->bindValue(':phone_number', null, PDO::PARAM_NULL);
            } else {
                $update->bindValue(':phone_number', $targets['phone_number']);
            }
            $update->bindValue(':user_id', $userId, PDO::PARAM_INT);
            $update->execute();

            /*
             * A student's number goes onto the student record as well. That is
             * the number the Contact Workspace and the Home Visit queue show,
             * and the reason a student updates it at all: so a coach rings the
             * right phone.
             */
            if (profile_is_student($currentUser) && !empty($currentUser['student_id'])) {
                $studentPhone = $pdo->prepare('UPDATE student SET mobile_number = :phone_number WHERE student_id = :student_id');
                $studentPhone->execute([
                    ':phone_number' => $targets['phone_number'],
                    ':student_id' => (int)$currentUser['student_id'],
                ]);
            }

            $updatedUser = profile_fetch_user_context($pdo, $userId);
            if (!$updatedUser) {
                throw new RuntimeException('Failed to reload updated profile');
            }

            profile_write_audit_log($pdo, $updatedUser, $targets['changes'], $verificationContext);
            $pdo->commit();
        } catch (Throwable $throwable) {
            if ($pdo->inTransaction()) {
                $pdo->rollBack();
            }
            throw $throwable;
        }

        api_notifications_try_create($pdo, [
            'event_key' => 'profile_updated',
            'level' => 'success',
            'title' => 'Profile updated',
            'message' => profile_user_display_name($updatedUser) . ' updated profile information.',
            'module_key' => 'users',
            'entity_type' => 'user',
            'entity_id' => $userId,
            'actor_user_id' => (int)($sessionUser['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'view' => 'users',
            ],
            'metadata' => [
                'user_id' => $userId,
                'changes' => $targets['changes'],
            ],
            'recipients' => [
                'module_targets' => [
                    ['module' => 'users', 'action' => 'view'],
                ],
            ],
        ], [
            'endpoint' => 'profile.php',
            'event_key' => 'profile_updated',
            'user_id' => $userId,
        ]);
        api_notifications_try_create($pdo, [
            'event_key' => 'profile_updated_personal',
            'level' => 'success',
            'title' => 'Profile updated successfully',
            'message' => 'Your profile changes were saved.',
            'entity_type' => 'user',
            'entity_id' => $userId,
            'actor_user_id' => (int)($sessionUser['user_id'] ?? 0),
            'toast' => true,
            'target' => [
                'overlay' => 'profile',
            ],
            'metadata' => [
                'user_id' => $userId,
                'changes' => $targets['changes'],
            ],
            'recipients' => [
                'user_ids' => [$userId],
            ],
        ], [
            'endpoint' => 'profile.php',
            'event_key' => 'profile_updated_personal',
            'user_id' => $userId,
        ]);

        unset($_SESSION[PROFILE_CAPTCHA_SESSION_KEY], $_SESSION[PROFILE_OTP_SESSION_KEY]);
        $updatedSessionUser = api_store_authenticated_user($updatedUser, false);
        $captcha = profile_generate_captcha(true);

        api_json_response(200, [
            'message' => 'Profile updated successfully',
            'user' => $updatedSessionUser,
            'history' => profile_fetch_history($pdo, $userId),
            'verification' => profile_build_verification_payload($updatedUser, $captcha),
        ]);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (Throwable $throwable) {
    api_json_response(500, ['message' => 'Server error']);
}
