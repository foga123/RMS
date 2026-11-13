<?php

require_once __DIR__ . '/connection-pdo.php';
// Holds the outbound-email switch this endpoint reads and writes.
require_once __DIR__ . '/mail_config.php';
// The idle timeout, which every browser reads through its auth payload rather
// than from here: this endpoint is gated on the `settings` module, and the
// people the timeout applies to are exactly the ones without it.
require_once __DIR__ . '/session_policy_service.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $user = api_get_session_user();
    if (!$user || empty($user['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    if ($method === 'GET') {
        $policy = api_password_expiration_get_policy();
        $mail = api_mail_outbound_get_policy();
        $session = api_session_policy_get_policy();
        $throttle = api_throttle_limits();
        api_json_response(200, [
            'message' => 'Security policy loaded.',
            'policy' => [
                'password_expiration_enabled' => (bool)$policy['enabled'],
                'password_expiration_days' => (int)$policy['days'],
                'outbound_email_enabled' => (bool)$mail['enabled'],
                'outbound_email_updated_at' => $mail['updated_at'],
                'session_timeout_minutes' => (int)$session['timeout_minutes'],
                'session_timeout_updated_at' => $session['updated_at'],
                'rate_limit_enabled' => (bool)$throttle['enabled'],
                'rate_limit_burst' => (int)$throttle['burst'],
                'rate_limit_per_minute' => (int)$throttle['per_minute'],
                'rate_limit_strikes' => (int)$throttle['strikes'],
                'rate_limit_block_seconds' => (int)$throttle['block_seconds'],
                'rate_limit_updated_at' => $throttle['updated_at'],
            ],
            // The form needs the same floors and ceilings the server clamps to,
            // or it offers a value that is silently changed on save.
            'rate_limit_bounds' => api_throttle_limit_bounds(),
        ]);
    }

    if ($method === 'PUT') {
        $payload = api_read_json_body();

        /*
         * The API rate limit, handled on its own for the same reason the mail
         * switch is: it is stored separately — a JSON file that middleware reads
         * before any database connection exists — and a request that only
         * changes the limiter must not be read as a password-policy save.
         *
         * It shares this endpoint rather than getting one of its own because
         * RBAC is keyed per endpoint file. A separate file would mean a separate
         * module and a separate grant for a field on a screen the administrator
         * already has open.
         */
        $throttleKeys = [
            'rate_limit_enabled' => 'enabled',
            'rate_limit_burst' => 'burst',
            'rate_limit_per_minute' => 'per_minute',
            'rate_limit_strikes' => 'strikes',
            'rate_limit_block_seconds' => 'block_seconds',
        ];
        $throttlePayload = [];
        foreach ($throttleKeys as $requestKey => $policyKey) {
            if (array_key_exists($requestKey, $payload)) {
                $throttlePayload[$policyKey] = $payload[$requestKey];
            }
        }

        if ($throttlePayload) {
            $before = api_throttle_limits();
            $throttle = api_throttle_save_limits($throttlePayload, $user);

            try {
                $pdo = (new Database())->connect();
                /*
                 * The detail names the numbers, not just the fact of a change.
                 * "Rate limit updated" in a log tells a reader that something
                 * moved and not whether the limiter was loosened to the point of
                 * being off — which is the only question worth asking of this
                 * row six months later.
                 */
                $detail = $throttle['enabled']
                    ? sprintf(
                        'API rate limit set to %d burst, %d/min, %d strikes, %d-minute block.',
                        $throttle['burst'],
                        $throttle['per_minute'],
                        $throttle['strikes'],
                        (int)round($throttle['block_seconds'] / 60)
                    )
                    : 'API rate limiting switched OFF. No flood control is in force.';

                $fields = array_flip(array_values($throttleKeys));
                api_write_audit_log($pdo, $user, 'settings_update', $detail, [
                    'before' => array_intersect_key($before, $fields),
                    'after' => array_intersect_key($throttle, $fields),
                ]);
            } catch (Throwable $auditError) {
                api_log_exception($auditError, [
                    'endpoint' => 'security_policy.php',
                    'audit_action' => 'settings_update',
                ]);
            }

            $expiration = api_password_expiration_get_policy();
            $mailPolicy = api_mail_outbound_get_policy();
            $sessionPolicy = api_session_policy_get_policy();
            api_json_response(200, [
                // Says what was stored rather than what was asked for: the
                // values are clamped, so a request for 5 comes back as 10.
                'message' => $throttle['enabled']
                    ? 'API rate limit saved.'
                    : 'API rate limiting switched off. Every client can now send as many requests as it likes.',
                'policy' => [
                    'password_expiration_enabled' => (bool)$expiration['enabled'],
                    'password_expiration_days' => (int)$expiration['days'],
                    'outbound_email_enabled' => (bool)$mailPolicy['enabled'],
                    'outbound_email_updated_at' => $mailPolicy['updated_at'],
                    'session_timeout_minutes' => (int)$sessionPolicy['timeout_minutes'],
                    'session_timeout_updated_at' => $sessionPolicy['updated_at'],
                    'rate_limit_enabled' => (bool)$throttle['enabled'],
                    'rate_limit_burst' => (int)$throttle['burst'],
                    'rate_limit_per_minute' => (int)$throttle['per_minute'],
                    'rate_limit_strikes' => (int)$throttle['strikes'],
                    'rate_limit_block_seconds' => (int)$throttle['block_seconds'],
                    'rate_limit_updated_at' => $throttle['updated_at'],
                ],
                'rate_limit_bounds' => api_throttle_limit_bounds(),
            ]);
        }

        /*
         * The outbound-email switch shares this endpoint because it is a
         * Settings toggle and RBAC is keyed per endpoint file - a separate file
         * would mean a separate module and a separate grant for what is one
         * screen. It is handled on its own because it is stored separately from
         * the password policy, and a request that only flips mail must not be
         * read as a password-policy save.
         */
        $mailKeys = ['outbound_email_enabled', 'outboundEmailEnabled'];
        $mailKey = null;
        foreach ($mailKeys as $candidate) {
            if (array_key_exists($candidate, $payload)) { $mailKey = $candidate; break; }
        }

        $throttleNow = api_throttle_limits();

        if ($mailKey !== null) {
            $enabled = api_mail_parse_bool($payload[$mailKey]);
            $mail = api_mail_outbound_save_policy(
                $enabled,
                (int)$user['user_id'],
                isset($payload['note']) ? substr(trim((string)$payload['note']), 0, 255) : null
            );

            try {
                $pdo = (new Database())->connect();
                api_write_audit_log(
                    $pdo,
                    $user,
                    'settings_update',
                    $enabled ? 'Outbound email switched on.' : 'Outbound email switched off.',
                    ['outbound_email_enabled' => $enabled]
                );
            } catch (Throwable $auditError) {
                api_log_exception($auditError, [
                    'endpoint' => 'security_policy.php',
                    'audit_action' => 'settings_update',
                ]);
            }

            $expiration = api_password_expiration_get_policy();
            $session = api_session_policy_get_policy();
            api_json_response(200, [
                'message' => $enabled
                    ? 'Outbound email switched on.'
                    : 'Outbound email switched off. No messages will be sent until it is switched back on.',
                'policy' => [
                    'password_expiration_enabled' => (bool)$expiration['enabled'],
                    'password_expiration_days' => (int)$expiration['days'],
                    'outbound_email_enabled' => (bool)$mail['enabled'],
                    'outbound_email_updated_at' => $mail['updated_at'],
                    'session_timeout_minutes' => (int)$session['timeout_minutes'],
                    'session_timeout_updated_at' => $session['updated_at'],
                    'rate_limit_enabled' => (bool)$throttleNow['enabled'],
                    'rate_limit_burst' => (int)$throttleNow['burst'],
                    'rate_limit_per_minute' => (int)$throttleNow['per_minute'],
                    'rate_limit_strikes' => (int)$throttleNow['strikes'],
                    'rate_limit_block_seconds' => (int)$throttleNow['block_seconds'],
                    'rate_limit_updated_at' => $throttleNow['updated_at'],
                ],
            ]);
        }

        $policy = api_password_expiration_save_policy($payload, $user);

        /*
         * Saved only when the request names it, so the Settings screen's other
         * PUTs — and any older client that predates this field — leave the
         * timeout as it was instead of resetting it to the default.
         */
        $sessionKeys = ['session_timeout_minutes', 'sessionTimeoutMinutes', 'timeout_minutes'];
        $sessionProvided = false;
        foreach ($sessionKeys as $candidate) {
            if (array_key_exists($candidate, $payload)) { $sessionProvided = true; break; }
        }
        $session = $sessionProvided
            ? api_session_policy_save_policy($payload, $user)
            : api_session_policy_get_policy();

        try {
            $pdo = (new Database())->connect();
            api_write_audit_log($pdo, $user, 'settings_update', 'Password expiration policy updated.', [
                'password_expiration_enabled' => (bool)$policy['enabled'],
                'password_expiration_days' => (int)$policy['days'],
                'session_timeout_minutes' => (int)$session['timeout_minutes'],
            ]);
        } catch (Throwable $auditError) {
            api_log_exception($auditError, [
                'endpoint' => 'security_policy.php',
                'audit_action' => 'settings_update',
            ]);
        }

        $mail = api_mail_outbound_get_policy();
        api_json_response(200, [
            'message' => 'Password expiration policy saved.',
            'policy' => [
                'password_expiration_enabled' => (bool)$policy['enabled'],
                'password_expiration_days' => (int)$policy['days'],
                'outbound_email_enabled' => (bool)$mail['enabled'],
                'outbound_email_updated_at' => $mail['updated_at'],
                'session_timeout_minutes' => (int)$session['timeout_minutes'],
                'session_timeout_updated_at' => $session['updated_at'],
                'rate_limit_enabled' => (bool)$throttleNow['enabled'],
                'rate_limit_burst' => (int)$throttleNow['burst'],
                'rate_limit_per_minute' => (int)$throttleNow['per_minute'],
                'rate_limit_strikes' => (int)$throttleNow['strikes'],
                'rate_limit_block_seconds' => (int)$throttleNow['block_seconds'],
                'rate_limit_updated_at' => $throttleNow['updated_at'],
            ],
        ]);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (Throwable $throwable) {
    api_log_exception($throwable, [
        'endpoint' => 'security_policy.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    ]);
    api_json_response(500, ['message' => 'Server error']);
}
