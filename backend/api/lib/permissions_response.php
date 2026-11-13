<?php
/**
 * The JSON reply shape the two permissions endpoints answer with.
 *
 * role_permissions.php and user_permissions.php each defined this, byte for
 * byte, and call it eleven times apiece. They are separate request entry points
 * that never include one another, so it was never a redeclare - just two places
 * to change and one of them easy to miss.
 *
 * NOT the same as api_out() in middleware/auth.php, and not replaceable by it.
 * That one writes the payload as given; this adds a `success` boolean derived
 * from the status code. The permissions screens read that field, so swapping in
 * api_out() would drop it and the client would treat every reply as a failure.
 * The duplication was worth removing; the difference is worth keeping.
 */

if (!function_exists('permissions_out')) {
    /**
     * Send $payload as JSON with $code, adding `success` unless it is already set,
     * and stop. Like api_out(), this never returns.
     */
    function permissions_out($code, $payload) {
        http_response_code($code);
        if (is_array($payload) && !array_key_exists('success', $payload)) {
            $payload['success'] = $code < 400;
        }
        echo json_encode($payload);
        exit;
    }
}
