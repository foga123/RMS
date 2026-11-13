<?php

require_once __DIR__ . '/middleware/auth.php';
require_once __DIR__ . '/captcha_policy_service.php';
require_once __DIR__ . '/lib/turnstile.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

/**
 * What the login screen needs, and nothing else.
 *
 * The GET below is deliberately unauthenticated - the sign-in form has to
 * know whether to draw a CAPTCHA before anyone has signed in, so this is one
 * of the few endpoints anybody on the network can read. It was answering
 * them with `updated_at` and `updated_by` as well, which named the user id
 * of an administrator who can change security settings and when they last
 * did. Small, but it was free to anyone who asked, and no caller ever wanted
 * it: the only consumer is LoginForm.jsx, which reads the flag.
 */
function captcha_policy_public_payload(array $policy): array
{
    return ['login_captcha_enabled' => (bool)$policy['enabled'], 'captcha' => api_turnstile_public_config()];
}

/** The same policy for an administrator who has just saved it. */
function captcha_policy_admin_payload(array $policy): array
{
    return captcha_policy_public_payload($policy) + [
        'updated_at' => $policy['updated_at'] ?? null,
        'updated_by' => $policy['updated_by'] ?? null,
    ];
}

try {
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

    if ($method === 'GET') {
        $policy = api_login_captcha_get_policy();
        api_json_response(200, [
            'message' => 'CAPTCHA policy loaded.',
            'policy' => captcha_policy_public_payload($policy),
        ]);
    }

    if ($method === 'PUT') {
        $user = api_require_auth(['admin']);
        $payload = api_read_json_body();
        $policy = api_login_captcha_save_policy($payload, $user);

        try {
            require_once __DIR__ . '/connection-pdo.php';
            $pdo = (new Database())->connect();
            api_write_audit_log($pdo, $user, 'settings_update', 'Login CAPTCHA policy updated.', [
                'login_captcha_enabled' => (bool)$policy['enabled'],
            ]);
        } catch (Throwable $auditError) {
            api_log_exception($auditError, [
                'endpoint' => 'captcha_policy.php',
                'audit_action' => 'settings_update',
            ]);
        }

        api_json_response(200, [
            'message' => 'CAPTCHA policy saved.',
            'policy' => captcha_policy_admin_payload($policy),
        ]);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (Throwable $throwable) {
    api_log_exception($throwable, [
        'endpoint' => 'captcha_policy.php',
        'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
    ]);
    api_json_response(500, ['message' => 'Server error']);
}
