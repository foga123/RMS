<?php
/**
 * Refuse any request that did not come through the front proxy.
 *
 * Deployed with the React app on Vercel and this API on Railway, the browser
 * only ever talks to Vercel, which forwards /frontend/backend/... here and adds
 * an X-Origin-Secret header that only it knows (set by a `transforms` rule in
 * frontend/vercel.json from its ORIGIN_SECRET environment variable). The Railway
 * address is public all the same, so without this check anyone could skip
 * Vercel and call the API directly - and, worse, send their own X-Forwarded-For,
 * since api_client_ip() trusts the front proxy's word for who the visitor is.
 *
 * Loaded before every PHP file under /frontend/backend/ by `auto_prepend_file`
 * in docker/apache-vhost.conf, so no endpoint can forget it, and again by
 * middleware/auth.php in case that line is ever lost. With ORIGIN_SECRET unset
 * (XAMPP) it does nothing.
 *
 * The comparison is hash_equals(), so the secret cannot be guessed one
 * character at a time from response timings.
 */

if (!function_exists('api_origin_secret_ok')) {
    /**
     * Whether ORIGIN_SECRET is set and this request carried it. Read from the
     * process environment only: the secret belongs to the deployment, never to
     * a file in the code tree.
     */
    function api_origin_secret_ok(): bool
    {
        $secret = (string)getenv('ORIGIN_SECRET');
        if ($secret === '') {
            return false;
        }
        $sent = (string)($_SERVER['HTTP_X_ORIGIN_SECRET'] ?? '');
        return $sent !== '' && hash_equals($secret, $sent);
    }
}

// The command line (tests, scripts) is never behind a proxy.
if (PHP_SAPI !== 'cli' && (string)getenv('ORIGIN_SECRET') !== '' && !api_origin_secret_ok()) {
    http_response_code(403);
    header('Content-Type: application/json');
    header('Cache-Control: no-store, private');
    echo json_encode(['message' => 'Forbidden']);
    exit;
}
