<?php

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/captcha_policy_service.php';
require_once __DIR__ . '/lib/turnstile.php';

try {
    api_start_session();

    $raw = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) api_json_response(400, ['message' => 'Invalid JSON']);
    $email = isset($payload['email']) && is_string($payload['email']) ? trim($payload['email']) : '';
    $password = isset($payload['password']) && is_string($payload['password']) ? $payload['password'] : '';

    if ($email === '' || $password === '') {
        http_response_code(400);
        echo json_encode(['message' => 'Email and password are required']);
        exit;
    }

    $db = new Database();
    $pdo = $db->connect();

    /*
     * The attempt is counted BEFORE the password is checked, and given back if
     * the password turns out to be right.
     *
     * It used to be the other way round: read the count, verify the password,
     * write the count. Twenty guesses sent at once all read "0 so far" before
     * any of them wrote, so all twenty were checked against a limit of five -
     * measured, not theorised. Spending first means the sixth simultaneous
     * guess is refused before bcrypt ever runs.
     *
     * Three buckets, narrowest first (rate_limit_policy.php explains the
     * sizes): this account, from anywhere; this browser on this network; and
     * the whole network. The last used to be the only per-source limit, at 20
     * failures - so twenty typos in one computer lab locked the entire lab out,
     * right passwords included. One browser now carries that limit, and the
     * address as a whole a ceiling a real NAT only reaches under abuse.
     *
     * A nonexistent email spends the same as a real one, so the response time
     * and the lockout both say nothing about which addresses have accounts.
     */
    $accountSubject = strtolower(trim($email));
    $deviceSubject = api_client_device_key();
    $ipSubject = api_client_ip();
    $reservation = api_rate_limit_reserve($pdo, [
        ['login_device', $deviceSubject],
        ['login_ip', $ipSubject],
    ]);

    if (!$reservation['allowed']) {
        $refused = $reservation['refused'];
        $retryMinutes = max(1, (int)ceil($refused['retry_after'] / 60));
        $inMinutes = $retryMinutes . ' minute' . ($retryMinutes === 1 ? '' : 's');
        $message = match ($refused['bucket']) {
            'login_account' => 'Account temporarily locked due to too many failed login attempts. Try again in ' . $inMinutes . '.',
            'login_device' => 'Too many failed login attempts from this device. Try again in ' . $inMinutes . '.',
            default => 'Too many failed login attempts from this network. Try again in ' . $inMinutes . '.',
        };
        api_rate_limit_respond($refused, $message, [
            'locked' => true,
            // The name this endpoint has always used, kept beside retry_after.
            'retry_after_seconds' => $refused['retry_after'],
        ]);
    }

    /*
     * The failure that CLOSES a lock is the one worth a line in the audit log;
     * each refusal after it is already implied. Recorded only once the attempt
     * has actually failed - a correct password on the fifth try is refunded
     * below and never locked anything.
     */
    $auditNewLocks = static function () use ($pdo, &$reservation, $email): void {
        $labels = [
            'login_account' => 'Account locked after %d failed login attempts.',
            'login_device' => 'Device locked out of login after %d failed attempts.',
            'login_ip' => 'Network locked out of login after %d failed attempts.',
        ];
        foreach ($reservation['hits'] as $bucket => $hit) {
            if (!empty($hit['locked_now'])) {
                api_audit_record($pdo, [
                    'actor_label' => $email,
                    'action' => 'rate_limit',
                    'outcome' => 'blocked',
                    'detail' => sprintf($labels[$bucket] ?? 'Rate limit reached after %d attempts.', $hit['max']),
                ]);
            }
        }
    };

    if (api_login_captcha_get_policy()['enabled']) {
        api_require_turnstile($payload, 'login', $auditNewLocks);
    }

    // An unavailable/invalid CAPTCHA is never a password guess. Meter its
    // source above, but spend the account's guess budget only after verification.
    $accountReservation = api_rate_limit_reserve($pdo, [['login_account', $accountSubject]]);
    if (!$accountReservation['allowed']) {
        $refused = $accountReservation['refused'];
        $minutes = max(1, (int)ceil($refused['retry_after'] / 60));
        api_rate_limit_respond($refused, 'Account temporarily locked due to too many failed login attempts. Try again in '
            . $minutes . ' minute' . ($minutes === 1 ? '' : 's') . '.', [
            'locked' => true, 'retry_after_seconds' => $refused['retry_after'],
        ]);
    }
    $reservation['hits'] = array_merge($reservation['hits'], $accountReservation['hits']);

    $sql = api_build_user_context_query($pdo, true) . ' WHERE u.email = :email LIMIT 1';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([':email' => $email]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$user) {
        $auditNewLocks();
        // No user_id exists to attach this to, which is precisely why the row
        // still matters: a run of these against different addresses from one IP
        // is what account enumeration looks like.
        api_audit_record($pdo, [
            'actor_label' => $email,
            'action' => 'login',
            'outcome' => 'failed',
            'detail' => 'No account matches this email',
        ]);
        http_response_code(401);
        echo json_encode(['message' => 'Invalid credentials']);
        exit;
    }

    // Verify password — support bcrypt/argon + SHA-256 legacy (no more plain-text or MD5)
    $storedPassword = (string)($user['password'] ?? '');
    $inputPassword = (string)$password;
    $isValid = false;
    $needsRehash = false;

    if ($storedPassword !== '' && $inputPassword !== '') {
        $info = password_get_info($storedPassword);
        if (!empty($info) && ($info['algo'] ?? 0) !== 0) {
            // Modern hash (bcrypt/argon2)
            $isValid = password_verify($inputPassword, $storedPassword);
            $needsRehash = $isValid && password_needs_rehash($storedPassword, PASSWORD_DEFAULT);
        } else {
            // Legacy SHA-256 only (MD5 and plain-text support removed for security)
            $isSha256 = (preg_match('/^[a-f0-9]{64}$/i', $storedPassword) === 1);

            if ($isSha256) {
                $isValid = hash_equals(strtolower($storedPassword), hash('sha256', $inputPassword));
                $needsRehash = $isValid;
            }
            // Plain-text and MD5 are no longer accepted — users must reset their password
        }
    }

    if (!$isValid) {
        $auditNewLocks();
        api_audit_record($pdo, [
            'user_id' => (int)$user['user_id'],
            'actor_label' => $email,
            'action' => 'login',
            'outcome' => 'failed',
            'detail' => 'Incorrect password',
        ]);
        http_response_code(401);
        echo json_encode(['message' => 'Invalid credentials']);
        exit;
    }

    // From here the password was right, so this attempt was never a failure.
    // The network and device give it back; the account is reset outright on a
    // successful sign-in below, and only refunded for an inactive one, which
    // is what it did before the counting moved ahead of the check.
    api_rate_limit_refund($pdo, 'login_device', $deviceSubject);
    api_rate_limit_refund($pdo, 'login_ip', $ipSubject);

    if (!api_user_is_active($user)) {
        api_rate_limit_refund($pdo, 'login_account', $accountSubject);
        api_audit_record($pdo, [
            'user_id' => (int)$user['user_id'],
            'actor_label' => $email,
            'action' => 'login',
            'outcome' => 'blocked',
            'detail' => 'Correct password on an inactive account',
        ]);
        http_response_code(403);
        echo json_encode(['message' => 'Account is inactive']);
        exit;
    }

    // A successful sign-in forgets the account's earlier failures.
    api_rate_limit_clear($pdo, 'login_account', $accountSubject);

    api_audit_record($pdo, [
        'user_id' => (int)$user['user_id'],
        'actor_label' => $email,
        'action' => 'login',
        'outcome' => 'success',
        'detail' => 'Signed in',
    ]);

    if ($needsRehash) {
        $rehash = $pdo->prepare('UPDATE user SET password = :password WHERE user_id = :user_id');
        $rehash->execute([
            ':password' => password_hash($inputPassword, PASSWORD_DEFAULT),
            ':user_id' => (int)$user['user_id'],
        ]);
        $user['password'] = null;
    }

    $responseUser = api_store_authenticated_user($user, true);
    if (!empty($responseUser['user_id'])) {
        api_password_expiration_sync_notifications_for_user($pdo, (int)$responseUser['user_id']);
    }

    /*
     * The token pair IS the login. Nothing downstream reads $_SESSION for
     * identity any more — api_get_session_user() resolves the bearer token and
     * only the bearer token — so a response without an access token is not a
     * partial success, it is a failed login that looks like a successful one.
     *
     * This was deliberately wrapped in a catch during the migration, when the
     * session was still the live transport and a token failure genuinely cost
     * nothing. Leaving that catch in place after the cutover produced the worst
     * possible shape: HTTP 200, a real user object, no token — so the SPA
     * navigates to the dashboard and then every request 401s, with the actual
     * cause visible only in php-api-error.log.
     *
     * So it is no longer caught here. A missing JWT_SECRET or a failed
     * refresh-token insert now surfaces through the endpoint's own handler
     * below as a 500, which is the honest answer: the server cannot issue
     * credentials, so the user is not signed in.
     */
    require_once __DIR__ . '/middleware/auth_tokens.php';
    require_once __DIR__ . '/session_policy_service.php';
    $userId = (int)$responseUser['user_id'];
    $tokenVersion = (int)($user['token_version'] ?? 0);

    $access = api_jwt_issue_access_token($userId, $tokenVersion);
    api_refresh_cookie_set(api_refresh_token_issue($pdo, $userId));
    api_refresh_token_prune($pdo);

    echo json_encode([
        'user' => $responseUser,
        'access_token' => $access['token'],
        'token_type' => 'Bearer',
        'expires_in' => $access['expires_in'],
        'session_policy' => ['timeout_minutes' => api_session_policy_timeout_minutes()],
    ]);
} catch (Throwable $e) {
    api_log_exception($e, [
        'endpoint' => 'login.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'POST',
    ]);
    http_response_code(500);
    echo json_encode(['message' => 'Server error']);
}
