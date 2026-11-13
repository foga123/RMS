<?php
/**
 * Flood control for every endpoint, stored in files.
 *
 * WHAT THIS IS NOT
 * ----------------
 * auth.php already has api_rate_limit_hit(), backed by the api_rate_limits
 * table. That one limits specific operations - failed sign-ins per account,
 * reset and OTP emails per recipient - it has to survive a restart, and being
 * wrong about it is a security incident. Its limits live in
 * rate_limit_policy.php.
 *
 * This is the other half — flood control. It counts *all* requests per client
 * regardless of outcome, so a script hammering students.php 40 times a second
 * is stopped even though every one of those requests is perfectly valid and
 * correctly authenticated. Losing its state on restart costs nothing: the worst
 * case is a flooder gets a fresh budget, and they were going to be re-counted
 * within seconds anyway. That is what makes it safe to keep out of the
 * database.
 *
 * WHY FILES
 * ---------
 * The usual answer is APCu or Redis. This PHP has neither — no apcu, no redis,
 * no memcached, not even shmop or sysvshm (checked, not assumed). Files plus
 * flock() are what is left, and they are enough: one small file per client,
 * two numbers in it, opened once per request.
 *
 * THE ALGORITHM: token bucket
 * ---------------------------
 * Chosen over a fixed window because this app's legitimate traffic is bursty
 * and its sustained traffic is not. Opening a dashboard fires ~20 requests at
 * once, then settles to a poll every 3-15 seconds. A fixed window sized for the
 * burst would let a flooder send that burst every single window; one sized for
 * the steady rate would refuse the dashboard. A bucket handles both: it holds
 * enough tokens to absorb the burst, and refills at the rate real use needs.
 *
 * A sliding-window log would be more precise, but it stores one timestamp per
 * request rather than two floats, and precision is not what this is for.
 *
 * ESCALATION
 * ----------
 * Running the bucket dry answers 429 with a Retry-After of a second or two —
 * that alone is enough for a client that is merely enthusiastic. Someone who
 * keeps pushing after being told to stop is not enthusiastic, so a run of
 * refusals inside one minute escalates to a flat block. That is the standard
 * shape (soft limit, then a penalty box) and it is what stops a flood instead
 * of merely metering it.
 *
 * FAIL-OPEN
 * ---------
 * Every storage failure lets the request through. A rate limiter whose disk is
 * full must not take the portal down with it — the damage from refusing every
 * user vastly exceeds the damage from not throttling for a few minutes.
 */

/** The anonymous per-IP ceiling, beside every other limit in the portal. */
require_once __DIR__ . '/rate_limit_policy.php';

// ---------------------------------------------------------------------------
// Limits.
//
// Sized against measured load, not guessed. The heaviest real client is the
// audit log open on Live (a probe every 3s = 20/min) on top of a dashboard's
// other live panels (15s each). Together that is roughly 40 requests a minute,
// with a burst of about 20 as the page mounts.
//
// So: a bucket of 120 absorbs a page load six times over, and 120/min sustained
// leaves 3x headroom over the heaviest legitimate client. A flooder at 10/s
// drains it in ~13 seconds and is blocked ~2 seconds later.
// ---------------------------------------------------------------------------

/** Bucket size — the largest burst allowed from cold. */
const API_THROTTLE_BURST = 120;

/** Sustained requests per minute once the burst is spent. */
const API_THROTTLE_PER_MINUTE = 120;

/** Refusals inside API_THROTTLE_STRIKE_WINDOW before the block lands. */
const API_THROTTLE_STRIKES = 20;
const API_THROTTLE_STRIKE_WINDOW = 60;

/** The penalty box, in seconds. */
const API_THROTTLE_BLOCK_SECONDS = 600;

/** Files idle longer than this are swept. */
const API_THROTTLE_GC_SECONDS = 3600;

// ---------------------------------------------------------------------------
// Making the four numbers above editable from Settings.
//
// The constants stay, and they stay the DEFAULTS. What changes is that an
// administrator can now override them without a deployment, which matters
// because the sizing note above is honest about being measured against today's
// load: add a live panel, run a bulk import, put the portal on a shared campus
// address behind one NAT, and the right numbers are different. Editing a
// constant meant editing a file on the server.
//
// ── WHY A JSON FILE AND NOT THE DATABASE ───────────────────────────────────
//
// This runs on EVERY request, and it runs BEFORE authentication — see
// api_bootstrap_auth(), which calls api_throttle_request() ahead of its
// public-endpoint return so that login and password reset are covered. There is
// no PDO connection at that point, and there must not be one: a flood control
// that opens a database connection per request hands a flooder a heavier weapon
// than the one it is defending against.
//
// So the settings live in a small JSON file, read the same way the session
// timeout and CAPTCHA policies next door are read, and this file keeps the
// property that made it safe to begin with: it depends on nothing.
//
// ── FAIL-OPEN, EXTENDED ────────────────────────────────────────────────────
//
// Every failure path here returns the built-in defaults rather than throwing or
// disabling the limiter. A missing file is the normal state before anyone has
// ever opened the panel; an unreadable or corrupt one is a bug, and neither is
// a reason to stop metering traffic.
// ---------------------------------------------------------------------------

/** Where the Settings screen writes the overrides. */
function api_throttle_policy_path(): string
{
    return dirname(__DIR__) . '/storage/security/throttle_policy.json';
}

/** The shipped sizing, used when nothing has been configured. */
function api_throttle_default_limits(): array
{
    return [
        'enabled' => true,
        'burst' => API_THROTTLE_BURST,
        'per_minute' => API_THROTTLE_PER_MINUTE,
        'strikes' => API_THROTTLE_STRIKES,
        'block_seconds' => API_THROTTLE_BLOCK_SECONDS,
        'updated_at' => null,
        'updated_by' => null,
    ];
}

/**
 * What each field may be set to.
 *
 * Bounded in the one place both the reader and the writer can see, so a
 * hand-edited file cannot do what the form refuses. The floors matter more than
 * the ceilings: a burst of 1 refuses the dashboard on its own page load, and
 * three strikes blocks a client for a stutter. The ceilings only stop a value
 * so large the limiter is off while still claiming to be on — which is what the
 * `enabled` switch is for, honestly and in the audit log.
 */
function api_throttle_limit_bounds(): array
{
    return [
        'burst' => ['min' => 10, 'max' => 10000],
        'per_minute' => ['min' => 10, 'max' => 10000],
        'strikes' => ['min' => 3, 'max' => 1000],
        'block_seconds' => ['min' => 60, 'max' => 86400],
    ];
}

function api_throttle_clamp_limit(string $field, $value, int $fallback): int
{
    $bounds = api_throttle_limit_bounds()[$field] ?? null;
    if ($bounds === null || $value === null || $value === '' || !is_numeric($value)) {
        return $fallback;
    }

    return min($bounds['max'], max($bounds['min'], (int)round((float)$value)));
}

/** A stored or posted policy, forced into range. */
function api_throttle_normalize_limits(array $raw): array
{
    $defaults = api_throttle_default_limits();

    return [
        'enabled' => array_key_exists('enabled', $raw)
            ? !in_array(strtolower(trim((string)$raw['enabled'])), ['0', 'false', 'no', 'off', ''], true)
            : $defaults['enabled'],
        'burst' => api_throttle_clamp_limit('burst', $raw['burst'] ?? null, $defaults['burst']),
        'per_minute' => api_throttle_clamp_limit('per_minute', $raw['per_minute'] ?? null, $defaults['per_minute']),
        'strikes' => api_throttle_clamp_limit('strikes', $raw['strikes'] ?? null, $defaults['strikes']),
        'block_seconds' => api_throttle_clamp_limit('block_seconds', $raw['block_seconds'] ?? null, $defaults['block_seconds']),
        'updated_at' => $raw['updated_at'] ?? null,
        'updated_by' => isset($raw['updated_by']) ? (int)$raw['updated_by'] : null,
    ];
}

/**
 * The limits in force, read once per request.
 *
 * Static rather than re-read, because api_throttle_consume() asks for them
 * several times inside one locked read-modify-write and a file that changed
 * mid-calculation would produce a bucket bigger than its own refill target.
 */
function api_throttle_limits(): array
{
    static $limits = null;
    if ($limits !== null) {
        return $limits;
    }

    $path = api_throttle_policy_path();
    if (!is_file($path)) {
        return $limits = api_throttle_default_limits();
    }

    $handle = @fopen($path, 'rb');
    if (!$handle) {
        return $limits = api_throttle_default_limits();
    }

    try {
        @flock($handle, LOCK_SH);
        $raw = stream_get_contents($handle);
        @flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }

    $decoded = json_decode((string)$raw, true);
    return $limits = api_throttle_normalize_limits(is_array($decoded) ? $decoded : []);
}

/**
 * Save new limits. Called by security_policy.php, never by this file.
 *
 * Returns the policy as stored — clamped — so the caller reports back what
 * actually took effect rather than what was asked for.
 */
function api_throttle_save_limits(array $payload, ?array $actor = null): array
{
    $current = api_throttle_limits();
    $merged = array_merge($current, array_intersect_key($payload, array_flip([
        'enabled', 'burst', 'per_minute', 'strikes', 'block_seconds',
    ])));

    $policy = api_throttle_normalize_limits($merged);
    $policy['updated_at'] = (new DateTimeImmutable('now'))->format('Y-m-d H:i:s');
    $policy['updated_by'] = isset($actor['user_id']) ? (int)$actor['user_id'] : null;

    $directory = dirname(api_throttle_policy_path());
    if (!is_dir($directory)) {
        @mkdir($directory, 0750, true);
    }

    $handle = @fopen(api_throttle_policy_path(), 'c+b');
    if (!$handle) {
        throw new RuntimeException('Rate limit storage is not writable.');
    }

    try {
        if (!@flock($handle, LOCK_EX)) {
            throw new RuntimeException('Rate limit storage is locked.');
        }
        ftruncate($handle, 0);
        rewind($handle);
        fwrite($handle, json_encode($policy, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE));
        fflush($handle);
        @flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }

    // The static in api_throttle_limits() is already populated with the old
    // values in this process. Nothing after a save in this request should read
    // stale limits, and the next request re-reads the file anyway.
    return $policy;
}

/**
 * Where the counters live.
 *
 * The system temp dir rather than a folder in the repo: it is writable by the
 * web server everywhere this runs, it is not inside the document root (so no
 * request can ever read a counter file), and nothing here is worth backing up.
 * The subdirectory keeps it from mixing with everything else in temp.
 */
function api_throttle_dir(): string
{
    $dir = rtrim(sys_get_temp_dir(), '/\\') . DIRECTORY_SEPARATOR . 'capstone_api_throttle';
    if (!is_dir($dir)) {
        @mkdir($dir, 0700, true);
    }

    return $dir;
}

/**
 * Who is being counted.
 *
 * The user id when signed in, the IP when not. Keying purely on IP would put a
 * whole campus behind one NAT on a single budget, so one busy staff member
 * could throttle the rest of the office. Keying purely on the session would
 * leave anonymous floods — the ones that matter most — uncounted entirely.
 *
 * An attacker cannot widen their budget by rotating the key: getting a second
 * user id means getting a second account.
 *
 * The IP comes from api_client_ip(), which believes X-Forwarded-For only from
 * a peer listed in TRUSTED_PROXIES - empty by default. Trusting that header
 * from anyone else would let them reset this counter with one line of curl,
 * which is exactly what trusting it from any private peer used to allow on a
 * LAN.
 */
function api_throttle_identity(): string
{
    $userId = 0;

    /*
     * The bearer token is read first, and this is not optional once tokens are
     * the live transport.
     *
     * This function used to read $_SESSION directly — not through
     * api_get_session_user() — so reshaping that function does not reach it. A
     * token-authenticated request carries no session, so every signed-in user
     * would have silently fallen back to 'ip:' keying, which is precisely the
     * whole-campus-on-one-budget failure the comment above describes.
     *
     * Only the claim is used. This runs before authentication on every request,
     * so it must not query the database; a forged token buys nothing here
     * beyond a throttle bucket, and the request still fails the real check a
     * moment later in api_require_auth().
     *
     * An EXPIRED token still names its user here (api_jwt_token_subject()
     * checks the signature and skips only the expiry). Every signed-in person's
     * token lapses every 15 minutes, and the polls sent with it before the
     * client refreshes used to land on the shared IP bucket instead.
     */
    if (function_exists('api_bearer_token') && function_exists('api_jwt_token_subject')) {
        $token = api_bearer_token();
        if ($token !== null) {
            $userId = (int)(api_jwt_token_subject($token) ?? 0);
        }
    }

    /*
     * The session fallback below is now reachable only on login.php, the one
     * endpoint that still writes $_SESSION. Everywhere else identity comes from
     * the bearer claim read above; nothing has authenticated from a session
     * since the August 2026 cutover.
     *
     * It is kept because it costs nothing — isset() on an unstarted session does
     * not warn — and because it correctly keys the request that *creates* the
     * session. Deleting it would silently move login traffic onto IP keying,
     * which is the exact failure this function exists to prevent.
     */
    if ($userId <= 0 && isset($_SESSION['user_id'])) {
        $userId = (int)$_SESSION['user_id'];
    } elseif ($userId <= 0 && isset($_SESSION['user']['user_id'])) {
        $userId = (int)$_SESSION['user']['user_id'];
    }

    if ($userId > 0) {
        return 'u:' . $userId;
    }

    /*
     * Anonymous: this browser on this address, when it names itself.
     *
     * Keyed on the IP alone, every anonymous request from a campus shared one
     * bucket AND one penalty box - so one script, or one lab signing in at the
     * start of a class, put everyone on that address in a ten-minute block.
     * The X-Client-ID the app sends splits that into one bucket per browser.
     *
     * The id is the client's own claim and can be rotated at will, which is
     * why api_throttle_request() also meters all anonymous traffic from the
     * address through a shared ceiling. A client that sends no id - curl, a
     * script - keeps the plain IP bucket it always had, shared only with other
     * clients that send none.
     */
    $deviceId = function_exists('api_client_device_id') ? api_client_device_id() : '';

    return 'ip:' . api_client_ip() . ($deviceId !== '' ? '|c:' . $deviceId : '');
}

/** Counter file for an identity. Hashed so no address is written to disk. */
function api_throttle_path(string $identity): string
{
    return api_throttle_dir() . DIRECTORY_SEPARATOR . hash('sha256', $identity) . '.json';
}

/**
 * Delete counters nobody has touched in an hour.
 *
 * Runs on roughly 1 request in 200 rather than on every one: sweeping a
 * directory is the single most expensive thing in this file, and the files it
 * removes are a few hundred bytes each.
 */
function api_throttle_gc(): void
{
    if (random_int(1, 200) !== 1) {
        return;
    }

    $cutoff = time() - API_THROTTLE_GC_SECONDS;
    foreach (@glob(api_throttle_dir() . DIRECTORY_SEPARATOR . '*.json') ?: [] as $file) {
        if (@filemtime($file) < $cutoff) {
            @unlink($file);
        }
    }
}

/**
 * Spend one token, or report that there is nothing left to spend.
 *
 * The whole read-modify-write runs under an exclusive flock, because two
 * requests that both read "1 token left" would both spend it. That is the one
 * place this can be wrong in a way that matters, so it is the one place that
 * locks.
 *
 * Returns: allowed, remaining, retry_after, limit, reset, blocked.
 *
 * $limits defaults to the per-client sizes from Settings; the anonymous per-IP
 * ceiling passes its own (see api_throttle_request()).
 */
function api_throttle_consume(string $identity, float $now, ?array $limits = null): array
{
    $limits = $limits ?? api_throttle_limits();
    $refillPerSecond = $limits['per_minute'] / 60;
    $allow = [
        'allowed' => true,
        'remaining' => $limits['burst'],
        'retry_after' => 0,
        'limit' => $limits['per_minute'],
        'reset' => 0,
        'blocked' => false,
    ];

    $handle = @fopen(api_throttle_path($identity), 'c+');
    if ($handle === false) {
        return $allow; // Fail open.
    }

    try {
        if (!@flock($handle, LOCK_EX)) {
            return $allow; // Fail open.
        }

        $raw = stream_get_contents($handle);
        $state = json_decode((string)$raw, true);
        if (!is_array($state)) {
            $state = [];
        }

        $tokens = isset($state['tokens']) ? (float)$state['tokens'] : (float)$limits['burst'];
        $updated = isset($state['updated']) ? (float)$state['updated'] : $now;
        $strikes = isset($state['strikes']) ? (int)$state['strikes'] : 0;
        $strikeStart = isset($state['strike_start']) ? (float)$state['strike_start'] : 0.0;
        $blockedUntil = isset($state['blocked_until']) ? (float)$state['blocked_until'] : 0.0;

        // Already in the penalty box. Deliberately does NOT extend the block on
        // further requests: a client that keeps retrying should serve its ten
        // minutes and be let back in, not be held indefinitely for retrying.
        if ($blockedUntil > $now) {
            return [
                'allowed' => false,
                'remaining' => 0,
                'retry_after' => (int)ceil($blockedUntil - $now),
                'limit' => $limits['per_minute'],
                'reset' => (int)ceil($blockedUntil - $now),
                'blocked' => true,
            ];
        }

        // Coming out of a block starts clean, otherwise the strikes that caused
        // it are still banked and the next single refusal re-blocks instantly.
        if ($blockedUntil > 0) {
            $blockedUntil = 0.0;
            $strikes = 0;
            $strikeStart = 0.0;
            $tokens = (float)$limits['burst'];
            $updated = $now;
        }

        // Refill for the time that has passed, capped at the bucket size.
        // max(0, ...) guards a clock that has stepped backwards, which would
        // otherwise subtract tokens.
        $elapsed = max(0.0, $now - $updated);
        $tokens = min((float)$limits['burst'], $tokens + ($elapsed * $refillPerSecond));
        $updated = $now;

        // Strike counting is windowed: twenty refusals spread over an afternoon
        // are a client with a slow bug, not a flood.
        if ($strikeStart > 0 && ($now - $strikeStart) > API_THROTTLE_STRIKE_WINDOW) {
            $strikes = 0;
            $strikeStart = 0.0;
        }

        if ($tokens < 1.0) {
            if ($strikeStart <= 0) {
                $strikeStart = $now;
            }
            $strikes++;

            $result = [
                'allowed' => false,
                'remaining' => 0,
                'retry_after' => (int)max(1, ceil((1.0 - $tokens) / $refillPerSecond)),
                'limit' => $limits['per_minute'],
                'reset' => (int)max(1, ceil(($limits['burst'] - $tokens) / $refillPerSecond)),
                'blocked' => false,
            ];

            if ($strikes >= $limits['strikes']) {
                $blockedUntil = $now + $limits['block_seconds'];
                $strikes = 0;
                $strikeStart = 0.0;
                $result['retry_after'] = $limits['block_seconds'];
                $result['reset'] = $limits['block_seconds'];
                $result['blocked'] = true;
            }
        } else {
            $tokens -= 1.0;
            $result = [
                'allowed' => true,
                'remaining' => (int)floor($tokens),
                'retry_after' => 0,
                'limit' => $limits['per_minute'],
                'reset' => (int)ceil(($limits['burst'] - $tokens) / $refillPerSecond),
                'blocked' => false,
            ];
        }

        $payload = json_encode([
            'tokens' => $tokens,
            'updated' => $updated,
            'strikes' => $strikes,
            'strike_start' => $strikeStart,
            'blocked_until' => $blockedUntil,
        ]);

        @ftruncate($handle, 0);
        @rewind($handle);
        @fwrite($handle, (string)$payload);
        @fflush($handle);

        return $result;
    } catch (Throwable $e) {
        return $allow; // Fail open.
    } finally {
        @flock($handle, LOCK_UN);
        @fclose($handle);
    }
}

/**
 * The gate. Called once per request from api_bootstrap_auth().
 *
 * Answers 429 and stops the request, or returns and lets it continue. The
 * RateLimit-* headers go out either way, so a client can see it approaching the
 * limit instead of discovering it by being refused — that is the point of
 * publishing them.
 */
function api_throttle_request(string $endpoint): void
{
    // Preflight carries no credentials and does no work; refusing it breaks
    // CORS for the request that follows without slowing an attacker down.
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'OPTIONS') {
        return;
    }

    /*
     * Switched off in Settings.
     *
     * Returns before the counters are touched rather than metering silently
     * with the refusal skipped: an administrator who turns this off during a
     * bulk load wants it off, and a bucket that kept draining would block them
     * the moment it came back on. The switch is audited, which is what makes
     * "why was there no rate limiting on the 14th" answerable.
     */
    if (empty(api_throttle_limits()['enabled'])) {
        return;
    }

    api_throttle_gc();

    $now = microtime(true);
    $identity = api_throttle_identity();
    $result = api_throttle_consume($identity, $now);
    $scope = 'client';

    /*
     * Anonymous traffic is also metered per address, across every browser on
     * it (rate_limit_policy.php sizes it for a NAT). This is what bounds a
     * client that rotates X-Client-ID to mint a fresh bucket per request.
     *
     * It METERS and never blocks: strikes is set out of reach, so it has no
     * penalty box. Blocking here would put every student on a campus address
     * in the box because of one of them - the exact failure the per-browser
     * bucket exists to prevent. The per-browser bucket keeps its box, so a
     * flooder is still stopped; the address is only ever slowed.
     *
     * Only reached when the client's own bucket allowed the request, so a
     * refused request does not also spend the neighbours' shared budget.
     */
    if ($result['allowed'] && strncmp($identity, 'ip:', 3) === 0) {
        $ceiling = api_throttle_ip_ceiling();
        $ceilingResult = api_throttle_consume('ipall:' . api_client_ip(), $now, [
            'burst' => $ceiling['burst'],
            'per_minute' => $ceiling['per_minute'],
            'strikes' => PHP_INT_MAX,
            'block_seconds' => 0,
        ]);
        if (!$ceilingResult['allowed']) {
            $result = $ceilingResult;
            $scope = 'network';
        }
    }

    if (!headers_sent()) {
        // Names from the IETF ratelimit-headers draft, which is what most
        // clients and gateways already read.
        header('RateLimit-Limit: ' . $result['limit']);
        header('RateLimit-Remaining: ' . $result['remaining']);
        header('RateLimit-Reset: ' . $result['reset']);
    }

    if ($result['allowed']) {
        return;
    }

    if (!headers_sent()) {
        header('Retry-After: ' . $result['retry_after']);
        header('Content-Type: application/json');
        // Nothing here is cacheable, and a cached 429 would outlive the block.
        header('Cache-Control: no-store');
    }

    http_response_code(429);
    if ($result['blocked']) {
        $message = sprintf(
            'Too many requests from this device. Access is paused for %d minutes.',
            (int)round(api_throttle_limits()['block_seconds'] / 60)
        );
    } elseif ($scope === 'network') {
        $message = 'This network is sending too many requests right now. Try again shortly.';
    } else {
        $message = 'Too many requests. Slow down and try again shortly.';
    }
    echo json_encode([
        'message' => $message,
        'error' => 'RATE_LIMITED',
        'retry_after' => $result['retry_after'],
        'blocked' => $result['blocked'],
    ]);
    exit;
}
