<?php
/**
 * The token layer: what api_get_session_user() now resolves every caller from.
 *
 * Split from auth.php rather than added to it because auth.php is already ~3700
 * lines, and because this file has one job that is worth reading on its own:
 * turning a user id into a signed string and back again.
 *
 * The access token is a JWT. The refresh token deliberately is NOT — see
 * api_refresh_token_generate() below.
 */

require_once dirname(__DIR__, 2) . '/vendor/autoload.php';
// Required directly rather than assumed: api_jwt_secret() needs JWT_SECRET the
// moment a token is decoded, which on some endpoints happens before anything has
// asked for a database connection.
require_once __DIR__ . '/env.php';

use Firebase\JWT\ExpiredException;
use Firebase\JWT\JWT;
use Firebase\JWT\Key;

/**
 * 15 minutes.
 *
 * A JWT cannot be withdrawn once signed, so this number is the honest answer to
 * "how long does a stolen access token keep working". Short enough to bound the
 * damage, long enough that the refresh endpoint is not carrying the whole app.
 *
 * Revocation that must be immediate does not wait for this: api_get_session_user()
 * checks the token's `ver` claim against user.token_version on every request, so
 * bumping that column kills outstanding tokens at once.
 */
const API_JWT_ACCESS_TTL = 900;

/** 7 days. Revocable, because it is stored server-side and can be struck out. */
const API_JWT_REFRESH_TTL = 604800;

const API_JWT_ALGO = 'HS256';
const API_JWT_ISSUER = 'capstone-retention-portal';
const API_JWT_AUDIENCE = 'capstone-retention-portal-spa';

/** Anything shorter is not a serious HS256 key. */
const API_JWT_MIN_SECRET_BYTES = 32;

/**
 * The signing key, or a hard failure.
 *
 * Never falls back to a default. A JWT layer that quietly signs with an empty
 * or guessable key is worse than no JWT layer at all: every check downstream
 * still passes, and every token in existence is forgeable by anyone who reads
 * this file. So a missing secret is a 500, loudly, on the first request.
 *
 * Read lazily rather than at include time on purpose. api_env() is defined in
 * connection-pdo.php, which requires middleware/auth.php *first* — so anything
 * resolved while this file is being included would see api_env() undefined and
 * silently take a fallback. That is exactly the trap api_permission_db_connect()
 * works around with its function_exists() guards.
 */
function api_jwt_secret(): string
{
    static $secret = null;
    if ($secret !== null) {
        return $secret;
    }

    $candidate = '';
    if (function_exists('api_env')) {
        $candidate = (string)api_env('JWT_SECRET', '');
    }
    if ($candidate === '') {
        $candidate = (string)(getenv('JWT_SECRET') ?: ($_ENV['JWT_SECRET'] ?? ''));
    }

    if (strlen($candidate) < API_JWT_MIN_SECRET_BYTES) {
        // Logged rather than echoed: the response must not describe the reason.
        error_log('JWT_SECRET is missing or shorter than ' . API_JWT_MIN_SECRET_BYTES . ' characters.');
        if (function_exists('api_json_response')) {
            api_json_response(500, ['message' => 'Server authentication is misconfigured.']);
        }
        throw new RuntimeException('JWT_SECRET is missing or too short.');
    }

    $secret = $candidate;
    return $secret;
}

/**
 * A signed access token for one user.
 *
 * Claims are deliberately thin: the subject, the token version, and the
 * standard registered claims. No role, no department, no permission map.
 *
 * The tempting alternative — baking role_id and department_id in, so the gate
 * needs no query — creates a window equal to the token TTL in which a demoted
 * dean still reads another department's students. Dean pinning and Star/Nonstar
 * student-type scoping are real boundaries in this system; they resolve from
 * the user row per request, and api_require_auth() already queries the database
 * on every request anyway, so the claims buy nothing worth that risk.
 */
function api_jwt_issue_access_token(int $userId, int $tokenVersion): array
{
    $now = time();
    $expiresAt = $now + API_JWT_ACCESS_TTL;

    $payload = [
        'iss' => API_JWT_ISSUER,
        'aud' => API_JWT_AUDIENCE,
        'iat' => $now,
        'nbf' => $now,
        'exp' => $expiresAt,
        'jti' => bin2hex(random_bytes(16)),
        'sub' => $userId,
        'ver' => $tokenVersion,
    ];

    return [
        'token' => JWT::encode($payload, api_jwt_secret(), API_JWT_ALGO),
        'expires_in' => API_JWT_ACCESS_TTL,
        'expires_at' => $expiresAt,
    ];
}

/**
 * Decode and verify, or null.
 *
 * Every failure — expired, bad signature, wrong issuer, malformed — returns
 * null rather than throwing, so callers have one path to handle and cannot
 * accidentally let an exception escape as a 500 on what is really a 401.
 */
function api_jwt_decode_access_token(string $jwt): ?array
{
    if ($jwt === '') {
        return null;
    }

    try {
        $decoded = JWT::decode($jwt, new Key(api_jwt_secret(), API_JWT_ALGO));
    } catch (Throwable $e) {
        return null;
    }

    $claims = (array)$decoded;

    // Checked explicitly: the library verifies exp/nbf and the signature, but
    // not who the token was issued for. A token minted by another service that
    // happened to share the secret must not authenticate here.
    if (($claims['iss'] ?? null) !== API_JWT_ISSUER) {
        return null;
    }
    if (($claims['aud'] ?? null) !== API_JWT_AUDIENCE) {
        return null;
    }
    if (!isset($claims['sub']) || (int)$claims['sub'] <= 0) {
        return null;
    }

    return [
        'user_id' => (int)$claims['sub'],
        'token_version' => isset($claims['ver']) ? (int)$claims['ver'] : 0,
        'jti' => $claims['jti'] ?? null,
        'expires_at' => isset($claims['exp']) ? (int)$claims['exp'] : 0,
    ];
}

/**
 * Whose token this is, even if it has EXPIRED - or null.
 *
 * For choosing a rate-limit bucket only. It authenticates nothing: an expired
 * token still gets its 401 from api_jwt_decode_access_token() a moment later.
 *
 * Why the flood throttle needs it: access tokens last 15 minutes, and when one
 * lapses every open panel's next poll carries it before the client refreshes.
 * Treated as anonymous, those requests - and every signed-in person's, all at
 * once - were charged to the shared IP bucket, the one budget a whole campus
 * behind a NAT has in common.
 *
 * Safe to trust that far because expiry is the ONLY check skipped. php-jwt
 * verifies the signature before it looks at `exp` (JWT.php, "Signature
 * verification failed" is raised first), so an ExpiredException only ever
 * carries a payload this server signed. A forged or tampered token still
 * returns null and stays on the IP.
 */
function api_jwt_token_subject(string $jwt): ?int
{
    if ($jwt === '') {
        return null;
    }

    try {
        $decoded = JWT::decode($jwt, new Key(api_jwt_secret(), API_JWT_ALGO));
    } catch (ExpiredException $e) {
        $decoded = $e->getPayload();
    } catch (Throwable $e) {
        return null;
    }

    $claims = (array)$decoded;
    if (($claims['iss'] ?? null) !== API_JWT_ISSUER || ($claims['aud'] ?? null) !== API_JWT_AUDIENCE) {
        return null;
    }

    $userId = (int)($claims['sub'] ?? 0);

    return $userId > 0 ? $userId : null;
}

/**
 * The bearer token from the request, or null.
 *
 * apache_request_headers() is tried FIRST, and that ordering is the whole point
 * of this function. Under mod_php — which is what XAMPP runs — Apache does not
 * populate $_SERVER['HTTP_AUTHORIZATION']; verified on this machine, a real
 * request carrying `Authorization: Bearer x` arrives with
 *
 *     $_SERVER['HTTP_AUTHORIZATION']            => null
 *     apache_request_headers()['Authorization'] => 'Bearer x'
 *
 * Reading $_SERVER alone — which is what most PHP JWT examples do — sees
 * nothing, 401s every authenticated request, and leaves nothing in the logs to
 * explain why. The $_SERVER keys are kept as fallbacks for CGI/FastCGI setups
 * and for the CLI harness, where apache_request_headers() does not exist.
 */
function api_bearer_token(): ?string
{
    $header = '';

    if (function_exists('apache_request_headers')) {
        foreach (apache_request_headers() as $name => $value) {
            if (strcasecmp($name, 'Authorization') === 0) {
                $header = (string)$value;
                break;
            }
        }
    }

    if ($header === '') {
        // REDIRECT_ prefixed by mod_rewrite when a rule has passed the request on.
        $header = (string)($_SERVER['HTTP_AUTHORIZATION']
            ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION']
            ?? '');
    }

    if ($header === '' || !preg_match('/^\s*Bearer\s+(.+?)\s*$/i', $header, $m)) {
        return null;
    }

    return $m[1];
}

/**
 * An opaque refresh token.
 *
 * Not a JWT, and that is deliberate. The refresh token lives for a week, so it
 * is the half that has to be withdrawable — on logout, on a password change, on
 * an admin deactivating the account. A JWT cannot be withdrawn; a random string
 * checked against auth_refresh_token can be, in one UPDATE.
 *
 * 32 bytes from random_bytes(), matching how password_reset_codes.php already
 * mints its verification tokens.
 */
function api_refresh_token_generate(): string
{
    return bin2hex(random_bytes(32));
}

/** Only the hash is ever stored, so a leaked backup yields no usable sessions. */
function api_refresh_token_hash(string $token): string
{
    return hash('sha256', $token);
}

/** Groups a rotation chain so a replayed token can revoke the whole lineage. */
function api_refresh_token_family_id(): string
{
    return bin2hex(random_bytes(16));
}
