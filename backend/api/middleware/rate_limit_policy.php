<?php

/**
 * Every rate limit on a sensitive operation, in one place.
 *
 * Two different controls read this file, and they are deliberately different:
 *
 *   - The flood throttle (throttle.php) meters ALL traffic per client, before
 *     authentication and without a database. Its per-client sizes are edited in
 *     Settings; only its anonymous per-IP ceiling is defined here.
 *
 *   - The buckets below count specific, expensive or guessable operations -
 *     a password check, an email sent - in the api_rate_limits table, through
 *     api_rate_limit_hit() in auth.php. Each operation has its own buckets, so
 *     failing to log in never spends a password-reset allowance, and polling a
 *     dashboard spends neither.
 *
 * Every number can be overridden from .env.local without touching code:
 *
 *     RATE_LIMIT_LOGIN_IP_MAX=250
 *     RATE_LIMIT_RESET_SEND_EMAIL_WINDOW=1800
 *     THROTTLE_IP_CEILING_PER_MINUTE=1200
 *
 * ── WHY THREE TIERS FOR ANONYMOUS OPERATIONS ───────────────────────────────
 *
 * Anonymous requests cannot be told apart by account, so the obvious key is the
 * IP - and a campus, a computer lab or a mobile carrier puts hundreds of people
 * behind one. Keyed on the IP alone, one person mistyping a password twenty
 * times locked the whole address out of login.
 *
 * So each anonymous operation is counted three ways:
 *
 *   account/email  the thing being attacked - a strict limit, and the one a
 *                  distributed attacker cannot dilute
 *   device         IP + the browser's X-Client-ID - what used to be the IP
 *                  limit, now scoped to one browser
 *   ip             every device on the address together - a ceiling several
 *                  times higher, which is the only tier able to stop a whole
 *                  address, and which a real NAT only reaches under abuse
 *
 * The client id is the browser's own claim and can be rotated freely. That is
 * why the device tier always sits UNDER the ip tier: rotating it buys a fresh
 * device budget and nothing more, because the ip ceiling still counts every
 * request. It is never used on its own and never used for authentication.
 */

/** The shipped limits. max per window seconds; lock > 0 holds the key shut once max is reached. */
function api_rate_limit_default_policies(): array
{
    return [
        // Failed-password attempts. Counted before the password is checked
        // (so parallel guesses cannot race past the limit) and refunded on
        // success (so signing in successfully never counts toward a lock).
        'login_account' => ['max' => 5, 'window' => 900, 'lock' => 900],
        'login_device' => ['max' => 20, 'window' => 900, 'lock' => 600],
        'login_ip' => ['max' => 100, 'window' => 900, 'lock' => 600],

        // Password-reset emails. The session's 60-second resend cooldown stays
        // for the countdown on screen, but a session is shed by dropping a
        // cookie; these are not. Every send draws on the one Gmail quota the
        // whole portal shares, so an unlimited sender breaks reset for everyone.
        'reset_send_email' => ['max' => 3, 'window' => 900, 'lock' => 0],
        'reset_send_device' => ['max' => 10, 'window' => 900, 'lock' => 0],
        'reset_send_ip' => ['max' => 50, 'window' => 900, 'lock' => 0],

        // Signed-in OTP mail. Keyed on the account, which cannot be rotated.
        // The profile code goes to an address the user TYPES, so that address
        // gets its own bucket - otherwise one account could mail any stranger.
        'profile_otp_user' => ['max' => 5, 'window' => 900, 'lock' => 0],
        'profile_otp_email' => ['max' => 3, 'window' => 900, 'lock' => 0],
        'password_otp_user' => ['max' => 5, 'window' => 900, 'lock' => 0],
    ];
}

/**
 * One bucket's limits, with any .env.local override applied and clamped.
 *
 * Clamped so a typo cannot switch a control off while it claims to be on: max
 * is at least 1, and window and lock stay within a day - the row sweep in
 * api_rate_limit_sweep() assumes nothing lives longer than that.
 */
function api_rate_limit_policy(string $bucket): array
{
    static $cache = [];
    if (isset($cache[$bucket])) {
        return $cache[$bucket];
    }

    $defaults = api_rate_limit_default_policies()[$bucket] ?? null;
    if ($defaults === null) {
        throw new InvalidArgumentException('Unknown rate limit bucket: ' . $bucket);
    }

    $prefix = 'RATE_LIMIT_' . strtoupper($bucket) . '_';
    $read = static function (string $field, int $default, int $min, int $max) use ($prefix): int {
        $raw = function_exists('api_env') ? api_env($prefix . strtoupper($field), '') : '';
        if ($raw === '' || !is_numeric($raw)) {
            return $default;
        }
        return min($max, max($min, (int)$raw));
    };

    return $cache[$bucket] = [
        'max' => $read('max', $defaults['max'], 1, 1000000),
        'window' => $read('window', $defaults['window'], 1, 86400),
        'lock' => $read('lock', $defaults['lock'], 0, 86400),
    ];
}

/**
 * The flood throttle's ceiling for ALL anonymous traffic from one address.
 *
 * Each anonymous browser has its own bucket in throttle.php, sized by Settings.
 * This second bucket is shared by every anonymous request from the IP, so a
 * client that rotates X-Client-ID to mint fresh buckets is still metered here.
 *
 * Sized for a NAT, not a person: signing in costs a browser two or three
 * anonymous requests, so 600 a minute is a few hundred sign-ins a minute from
 * one address before anybody waits. It meters and never blocks - see
 * api_throttle_request() - so a flood from one student cannot put the rest of
 * the campus in the penalty box.
 */
function api_throttle_ip_ceiling(): array
{
    $read = static function (string $key, int $default): int {
        $raw = function_exists('api_env') ? api_env($key, '') : '';
        if ($raw === '' || !is_numeric($raw)) {
            return $default;
        }
        return min(100000, max(60, (int)$raw));
    };

    return [
        'burst' => $read('THROTTLE_IP_CEILING_BURST', 600),
        'per_minute' => $read('THROTTLE_IP_CEILING_PER_MINUTE', 600),
    ];
}
