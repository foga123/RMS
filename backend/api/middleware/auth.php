<?php

/**
 * Per-client flood control. Required here rather than from connection-pdo.php
 * so it is present wherever this middleware is, and because api_bootstrap_auth()
 * below is its only caller. It leans on api_client_ip() from this file, which
 * is fine — both are only ever called at request time, long after both files
 * have finished parsing.
 */
require_once __DIR__ . '/throttle.php';

/**
 * The server runs on Europe/Berlin, six hours behind Cagayan de Oro. Every
 * timestamp PHP writes - audit entries, notifications, backup filenames,
 * password expiry windows - was stamped in the wrong zone.
 *
 * Set here rather than in php.ini so the correct zone travels with the code
 * instead of depending on how a particular machine is configured. Only applied
 * when the ini value is not already Asia/Manila, so a properly configured
 * server is left alone.
 */
if (date_default_timezone_get() !== 'Asia/Manila') {
    date_default_timezone_set('Asia/Manila');
}

require_once dirname(__DIR__) . '/password_expiration_service.php';

/**
 * The token layer, so api_get_session_user() can resolve a bearer token on any
 * endpoint rather than only the three that wire it up explicitly.
 *
 * This is the first thing in the project to pull in a global composer
 * autoloader, and it therefore changes include behaviour for every endpoint at
 * once — vendor/autoload.php was previously loaded lazily and only by
 * mail_template.php. It defines functions and registers the autoloader; it
 * reads no configuration at include time, so the api_env() load-order trap
 * (api_env is defined in connection-pdo.php, which requires this file first)
 * does not apply. api_jwt_secret() reads it lazily at call time instead.
 */
require_once __DIR__ . '/jwt.php';
// Refuses requests that skipped the front proxy, when ORIGIN_SECRET is set.
require_once __DIR__ . '/origin_guard.php';
// RBAC grants live in a JSON file under storage/, not in the permission tables.
require_once dirname(__DIR__) . '/lib/rbac_store.php';

function api_json_response(int $statusCode, array $payload): void
{
    http_response_code($statusCode);
    echo json_encode($payload);
    exit;
}

/**
 * The request body as an array: [] for an empty body, a 400 for one that is
 * not a JSON object or array.
 *
 * Ten endpoints carried this exact function under ten names. Endpoints that
 * treat a bad body differently (as empty, or with their own message) still
 * read php://input themselves; this is only the shared, strict version.
 */
function api_read_json_body(): array
{
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') {
        return [];
    }
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        api_json_response(400, ['message' => 'Invalid JSON payload']);
    }
    return $payload;
}

/**
 * A user's name for a list: first and last name, else the email, else
 * "User #<id>". Shared by the roles and permissions endpoints, which each
 * carried an identical copy. Other screens word the empty case differently
 * ("User", or blank) and keep their own.
 */
function api_user_display_name(array $row): string
{
    $fullName = trim((string)($row['first_name'] ?? '') . ' ' . (string)($row['last_name'] ?? ''));
    if ($fullName !== '') {
        return $fullName;
    }

    return trim((string)($row['email'] ?? '')) !== '' ? (string)$row['email'] : ('User #' . (int)($row['user_id'] ?? 0));
}

/**
 * A JSON settings file as an array, or $fallback when it is missing, unreadable
 * or not JSON. Read under a shared lock so a save in progress is never half
 * read. The captcha, password-expiration and session policies each carried an
 * identical copy.
 */
function api_read_json_file(string $path, array $fallback): array
{
    if (!is_file($path)) {
        return $fallback;
    }

    $handle = @fopen($path, 'rb');
    if (!$handle) {
        return $fallback;
    }

    try {
        @flock($handle, LOCK_SH);
        $raw = stream_get_contents($handle);
        @flock($handle, LOCK_UN);
    } finally {
        fclose($handle);
    }

    $decoded = json_decode((string)$raw, true);
    return is_array($decoded) ? $decoded : $fallback;
}

/**
 * A setting read as true/false: 1/true/yes/on/enabled and 0/false/no/off/
 * disabled, anything else (or null, or blank) is $default. Shared by the
 * captcha and password-expiration policies, which each carried a copy.
 */
function api_parse_bool($value, bool $default = false): bool
{
    if ($value === null) {
        return $default;
    }
    if (is_bool($value)) {
        return $value;
    }

    $normalized = strtolower(trim((string)$value));
    if ($normalized === '') {
        return $default;
    }
    if (in_array($normalized, ['1', 'true', 'yes', 'on', 'enabled'], true)) {
        return true;
    }
    if (in_array($normalized, ['0', 'false', 'no', 'off', 'disabled'], true)) {
        return false;
    }

    return $default;
}

function api_configure_error_logging(): void
{
    static $configured = false;

    if ($configured) {
        return;
    }

    error_reporting(E_ALL);
    ini_set('display_errors', '0');
    ini_set('log_errors', '1');

    $logDirectory = dirname(__DIR__, 2) . '/storage/logs';
    if (!is_dir($logDirectory)) {
        @mkdir($logDirectory, 0750, true);
    }

    if (is_dir($logDirectory)) {
        ini_set('error_log', $logDirectory . '/php-api-error.log');
    }

    $configured = true;
}

function api_log_exception(Throwable $e, array $context = []): void
{
    api_configure_error_logging();

    $parts = [
        '[api]',
        $e->getMessage(),
        'in',
        $e->getFile() . ':' . $e->getLine(),
    ];

    if (!empty($context)) {
        $encodedContext = json_encode($context, JSON_UNESCAPED_UNICODE);
        if ($encodedContext !== false) {
            $parts[] = 'context=' . $encodedContext;
        }
    }

    error_log(implode(' ', $parts));
    error_log($e->getTraceAsString());
}

api_configure_error_logging();

function api_allowed_origins(): array
{
    return [
        'http://localhost:3000',
        'http://localhost:3001',
        'http://localhost:5173',
        'http://localhost:5174',
        'http://localhost:8080',
        'http://localhost:1234',
        'http://127.0.0.1:3000',
        'http://127.0.0.1:3001',
        'http://127.0.0.1:5173',
        'http://127.0.0.1:5174',
        'http://127.0.0.1:8080',
        'http://127.0.0.1:1234',
    ];
}

function api_send_headers(array $methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']): void
{
    header('Content-Type: application/json');

    // CORS — whitelist specific origins instead of reflecting all
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    if ($origin !== '' && in_array($origin, api_allowed_origins(), true)) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Credentials: true');
        header('Vary: Origin');
    }

    header('Access-Control-Allow-Methods: ' . implode(', ', $methods));
    header('Allow: ' . implode(', ', $methods));

    // Never cached, by the browser or by anything in between. Behind Vercel
    // this matters most: its CDN caches proxied responses that look cacheable,
    // and these answers are one signed-in person's data. An endpoint that
    // serves a download can still set its own header after this one.
    header('Cache-Control: no-store, private');

    /*
     * The list above is now a rule, not a claim.
     *
     * Every endpoint passes the methods it serves, and until now that only
     * set two headers - refusing an undeclared method was left to each
     * endpoint's own REQUEST_METHOD branch. Nearly all of them do it. Two
     * did not, and both were found by sending them a method called FOO:
     *
     *   me.php     declares GET, answered 200 to DELETE
     *   logout.php declares POST, and ran - revoking the refresh token,
     *              bumping token_version to sign the account out on every
     *              device, and writing the audit row - for ANY verb. The
     *              probe that found it logged its own test account out.
     *
     * SameSite=Strict on both cookies means a cross-site request carries no
     * credential, so this was never a live CSRF hole. It was an endpoint
     * that advertised POST and accepted anything, which is worth closing on
     * its own and worth closing HERE: a guard written into 60 endpoints is a
     * guard the 61st forgets, and forgetting is how both of these happened.
     *
     * Nothing currently handled gets refused. Every endpoint that branches
     * on a method also declares it - checked across all of them before this
     * went in, and pinned by tests/request_method_check.php.
     *
     * OPTIONS always passes so api_handle_preflight() below can answer it,
     * and HEAD passes wherever GET does, because that is what HEAD is: PHP
     * runs the GET body and the server drops the response body.
     */
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $allowed = array_map('strtoupper', $methods);
    if (in_array('GET', $allowed, true)) {
        $allowed[] = 'HEAD';
    }
    $allowed[] = 'OPTIONS';

    if (!in_array($method, $allowed, true)) {
        http_response_code(405);
        echo json_encode(['message' => 'Method not allowed']);
        exit;
    }
    // Authorization is NOT a CORS-safelisted request header, so under the bearer
    // scheme every cross-origin call triggers a preflight that names it in
    // Access-Control-Request-Headers. Omitting it here made the browser block the
    // request before PHP ever saw it — invisible in the server logs, because
    // there was no request to log. api_allowed_origins() whitelists the dev
    // origins on purpose, so cross-origin is a supported configuration.
    // X-Client-ID is on every call the app makes (authToken.js), so leaving it
    // out would fail every cross-origin request the same invisible way.
    header('Access-Control-Allow-Headers: Authorization, Content-Type, X-Requested-With, X-CSRF-Token, X-Client-ID');

    // Security headers
    header('X-Content-Type-Options: nosniff');
    header('X-Frame-Options: DENY');
    header('X-XSS-Protection: 1; mode=block');
    header('Referrer-Policy: strict-origin-when-cross-origin');

    // A content security policy scoped to what these endpoints actually are:
    // JSON, never a document. `default-src 'none'` means a response that is
    // somehow rendered as HTML — a sniffing bug, a proxy that rewrites the
    // Content-Type — can still load no script, style, image or frame of its
    // own. `frame-ancestors 'none'` restates X-Frame-Options for browsers that
    // prefer CSP. This is deliberately strict because nothing here is a page;
    // the React app is served by Apache with its own policy, not from here.
    header("Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none'");

    // HSTS only when the request actually arrived over TLS. Sending it on plain
    // HTTP is how a dev box locks itself out: the browser remembers the header
    // and then refuses the http://localhost the app is served from. On XAMPP
    // over HTTP this branch never runs, so it is inert here and correct in
    // production the day the site is behind HTTPS.
    //
    // The TLS test is inlined rather than delegated to api_request_is_secure():
    // that lives in auth_tokens.php, which this file does not require and most
    // requests never load, so the guard would have been permanently false — HSTS
    // would never fire even over real HTTPS. Same two conditions, no dependency.
    // APP_FORCE_HTTPS: TLS ended at a proxy (Railway, Vercel) - see env.php.
    $overTls = (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['SERVER_PORT']) && (string)$_SERVER['SERVER_PORT'] === '443')
        || (function_exists('api_https_forced') && api_https_forced());
    if ($overTls) {
        header('Strict-Transport-Security: max-age=31536000; includeSubDomains');
    }
}

function api_handle_preflight(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') {
        http_response_code(204);
        exit;
    }
}

/**
 * How long an idle session file survives on disk, in seconds. Must stay above
 * the client idle timeout — see the note in api_start_session().
 */
const API_SESSION_GC_MAXLIFETIME = 28800; // 8 hours

function api_start_session(): void
{
    if (session_status() === PHP_SESSION_ACTIVE) {
        return;
    }

    $isSecure = (
        (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off')
        || (isset($_SERVER['SERVER_PORT']) && (string)$_SERVER['SERVER_PORT'] === '443')
        || (function_exists('api_https_forced') && api_https_forced())
    );

    ini_set('session.use_strict_mode', '1');
    ini_set('session.use_only_cookies', '1');
    ini_set('session.cookie_httponly', '1');
    if ($isSecure) {
        ini_set('session.cookie_secure', '1');
    }

    /*
     * Expired session files were never actually being swept. php.ini ships
     * session.gc_probability=1/1000, so the collector ran on roughly one
     * request in a thousand, and files holding a live user_id sat in the save
     * path for days — a stale one from three days earlier was still readable
     * when this was found. 1/100 keeps the sweep cheap while making it happen.
     *
     * gc_maxlifetime has to move in the same breath, and this is the part that
     * bites if you skip it: PHP defaults to 1440 *seconds* (24 minutes) while
     * the client idle timeout defaults to 30 minutes and is configurable up to
     * a day (shared/lib/session.js, securityPolicy.js LIMITS). Making the
     * collector run without raising it would start logging people out six
     * minutes before the app told them it would — a bug reported as "it keeps
     * signing me out" and almost impossible to trace back to here.
     *
     * Eight hours bounds an abandoned session to one working day. It is not the
     * idle timeout — that is enforced client-side, and the cookie itself dies
     * with the browser (lifetime => 0 below).
     */
    ini_set('session.gc_probability', '1');
    ini_set('session.gc_divisor', '100');
    ini_set('session.gc_maxlifetime', (string)API_SESSION_GC_MAXLIFETIME);

    if (session_name() === 'PHPSESSID') {
        session_name('CAPSTONESESSID');
    }

    session_set_cookie_params([
        'lifetime' => 0,
        'path' => '/',
        'secure' => $isSecure,
        'httponly' => true,
        'samesite' => 'Strict',
    ]);

    session_start();
}

function api_destroy_session(): void
{
    api_start_session();

    $_SESSION = [];

    if (ini_get('session.use_cookies')) {
        $params = session_get_cookie_params();
        setcookie(
            session_name(),
            '',
            time() - 42000,
            $params['path'] ?? '/',
            $params['domain'] ?? '',
            (bool)($params['secure'] ?? false),
            (bool)($params['httponly'] ?? true)
        );
    }

    session_destroy();
}

function api_role_token_alias_map(): array
{
    return [
        'administrator' => 'admin',
        'system-admin' => 'admin',
        'secretary' => 'ssg',
        'student-supreme-government' => 'ssg',
        'student-government' => 'ssg',
        'deptcaller' => 'dept-caller',
        'department-caller' => 'dept-caller',
        'departmentcaller' => 'dept-caller',
    ];
}

function api_role_id_slug_map(): array
{
    return [
        1 => 'admin',
        2 => 'ssg',
        3 => 'dean',
        4 => 'dept-caller',
        5 => 'ssp-coordinator',
        6 => 'ssp-caller',
        7 => 'ksh-tl',
        8 => 'csdl',
        9 => 'ssg',
        10 => 'finance',
        // 11 was 'registrar' -- role deleted 2026-07-26. Intentionally left
        // unmapped so a future role landing on id 11 cannot inherit its access.
        12 => 'ksh-coach',
        13 => 'student',
        // The dean's assistant. Same modules, same department pinning; see
        // API_DEPARTMENT_PINNED_ROLES.
        14 => 'program-head',
        /*
         * Faculty run the intervention workspace for their own department.
         *
         * The same screen an SSP Caller works, scoped differently: a caller sees
         * the students assigned to them personally, faculty see every student in
         * the department they teach in. Both scopes are enforced in
         * student_contact_visibility_clause(); faculty are additionally in
         * API_DEPARTMENT_PINNED_ROLES so the department clause applies to every
         * other endpoint too, not only to the workspace.
         */
        15 => 'faculty',
    ];
}

function api_role_slug_from_id(int $roleId): string
{
    $map = api_role_id_slug_map();
    return $map[$roleId] ?? '';
}

function api_normalize_role_token($value): string
{
    $token = strtolower(trim((string)$value));
    if ($token === '') {
        return '';
    }

    $token = str_replace(['_', ' '], '-', $token);
    $token = preg_replace('/[^a-z0-9-]+/', '', $token);
    $token = $token ?? '';
    if ($token === '') {
        return '';
    }

    $aliasMap = api_role_token_alias_map();
    return $aliasMap[$token] ?? $token;
}

function api_permission_module_alias_map(): array
{
    return [
        // `dashboard` and `workspace` were separate modules for one idea: the
        // page a role lands on. Which key mattered depended on which dashboard
        // component the role rendered, so granting the wrong one failed
        // silently. They now normalise to `overview`, which also keeps
        // permissions saved under the old keys working.
        'overview' => 'overview',
        'dashboard' => 'overview',
        'workspace' => 'overview',
        'user' => 'users',
        'users' => 'users',
        'user_management' => 'users',
        'role' => 'roles',
        'roles' => 'roles',
        'role_management' => 'roles',
        'student_management' => 'student_manage',
        'student_manage' => 'student_manage',
        'attendance' => 'attendance_management',
        'attendance_management' => 'attendance_management',
        'attendance_summary' => 'attendance_management',
        'department' => 'departments',
        'departments' => 'departments',
        'department_management' => 'departments',
        'course' => 'courses',
        'courses' => 'courses',
        'course_management' => 'courses',
        'campus' => 'campuses',
        'campuses' => 'campuses',
        'campus_management' => 'campuses',
        'status' => 'statuses',
        'statuses' => 'statuses',
        'status_management' => 'statuses',
        'dropdown_list' => 'dropdown_lists',
        'dropdown_management' => 'dropdown_lists',
        'enrollmentstatus' => 'enrollment_status',
        'enrollment_status' => 'enrollment_status',
        'remarks_management' => 'remarks',
        'remark' => 'remarks',
        'remarks' => 'remarks',
        'survey_question' => 'survey_questions',
        'survey_questions' => 'survey_questions',
        'survey_response' => 'survey_responses',
        'survey_responses' => 'survey_responses',
        'survey_submission' => 'survey_submissions',
        'survey_submissions' => 'survey_submissions',
        'finance' => 'finance_management',
        'finance_management' => 'finance_management',
        'assignment' => 'assignments',
        'assignments' => 'assignments',
        'student_contact' => 'student_contacts',
        'student_contacts' => 'student_contacts',
        'team_monitor' => 'team_monitor',
        'team_monitoring' => 'team_monitor',
        'home_visit' => 'home_visits',
        'home_visits' => 'home_visits',
        // Grades, attendance and finance for one periodical, in one screen.
        'faculty_workspace' => 'faculty_workspace',
        'report' => 'reports',
        'reports' => 'reports',
        'retention_case' => 'retention_cases',
        'retention_cases' => 'retention_cases',
        'setting' => 'settings',
        'settings' => 'settings',
    ];
}

function api_normalize_permission_module_key($value): string
{
    $token = strtolower(trim((string)$value));
    if ($token === '') {
        return '';
    }

    $token = str_replace([' ', '-'], '_', $token);
    $token = preg_replace('/[^a-z0-9_]+/', '', $token);
    $token = $token ?? '';
    if ($token === '') {
        return '';
    }

    $aliasMap = api_permission_module_alias_map();
    return $aliasMap[$token] ?? $token;
}

function api_permission_db_connect(): ?PDO
{
    static $pdo = false;

    if ($pdo !== false) {
        return $pdo;
    }

    // The same settings, TLS and session setup as the Database class
    // (middleware/env.php, loaded through jwt.php).
    $settings = api_db_settings();

    try {
        $pdo = new PDO(
            api_db_dsn($settings),
            $settings['username'],
            $settings['password'],
            api_db_pdo_options($settings)
        );
        api_db_init_session($pdo);
    } catch (Throwable $e) {
        $pdo = null;
    }

    return $pdo;
}

function api_table_exists(PDO $pdo, string $table): bool
{
    static $cache = [];

    if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
        throw new InvalidArgumentException('Invalid database table name.');
    }

    $cacheKey = spl_object_id($pdo) . ':' . strtolower($table);
    if (array_key_exists($cacheKey, $cache)) {
        return $cache[$cacheKey];
    }

    $stmt = $pdo->prepare('SHOW TABLES LIKE :table_name');
    $stmt->execute([':table_name' => $table]);
    $cache[$cacheKey] = (bool)$stmt->fetch(PDO::FETCH_NUM);

    return $cache[$cacheKey];
}

function api_column_exists(PDO $pdo, string $table, string $column): bool
{
    static $cache = [];

    if (!preg_match('/^[A-Za-z0-9_]+$/', $table) || !preg_match('/^[A-Za-z0-9_]+$/', $column)) {
        throw new InvalidArgumentException('Invalid database identifier.');
    }

    $cacheKey = spl_object_id($pdo) . ':' . strtolower($table) . ':' . strtolower($column);
    if (array_key_exists($cacheKey, $cache)) {
        return $cache[$cacheKey];
    }

    if (!api_table_exists($pdo, $table)) {
        $cache[$cacheKey] = false;
        return false;
    }

    $stmt = $pdo->prepare("SHOW COLUMNS FROM `$table` LIKE :column_name");
    $stmt->execute([':column_name' => $column]);
    $cache[$cacheKey] = (bool)$stmt->fetch(PDO::FETCH_ASSOC);

    return $cache[$cacheKey];
}

/**
 * Every column name on a table, or [] if it cannot be read.
 *
 * The list, where api_column_exists() above answers about one name. Both
 * survey_question.php and lib/survey_enrollment_status.php had defined their
 * own byte-identical `table_columns()` for this; they never met in one request
 * so it was never a redeclare, only two places to fix.
 *
 * Returns [] rather than throwing, because both callers use it to decide which
 * optional columns to write - a table that cannot be described should narrow
 * the write, not fail the request. The identifier is validated for the same
 * reason api_column_exists() validates it: the name is interpolated, since SHOW
 * COLUMNS takes no placeholder there.
 */
function api_table_columns(PDO $pdo, string $table): array
{
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
        throw new InvalidArgumentException('Invalid database identifier.');
    }

    try {
        $stmt = $pdo->query("SHOW COLUMNS FROM `$table`");
        $rows = $stmt ? $stmt->fetchAll(PDO::FETCH_ASSOC) : [];
        if (!is_array($rows)) {
            return [];
        }

        return array_values(array_filter(array_map(
            static fn ($row) => isset($row['Field']) ? (string)$row['Field'] : '',
            $rows
        )));
    } catch (Throwable $e) {
        return [];
    }
}

function api_require_table(PDO $pdo, string $table): void
{
    if (!api_table_exists($pdo, $table)) {
        throw new RuntimeException(
            'Required database table `' . $table . '` is missing. Initialize database/schema.sql using tools/setup-demo.php in this demo copy.'
        );
    }
}

function api_require_column(PDO $pdo, string $table, string $column): void
{
    api_require_table($pdo, $table);

    if (!api_column_exists($pdo, $table, $column)) {
        throw new RuntimeException(
            'Required database column `' . $table . '.' . $column . '` is missing. Initialize database/schema.sql using tools/setup-demo.php in this demo copy.'
        );
    }
}

/**
 * Whether the row a foreign key points at exists.
 *
 * `$sql` is the caller's own SELECT with a single `:id` placeholder, because the
 * question differs per table - some check an archived_at IS NULL alongside the
 * key. Four endpoints had each written this same four-line wrapper (grades,
 * student, survey_response, survey_submission) purely to avoid repeating the
 * prepare/execute/fetch.
 *
 * The SQL is the caller's literal, never anything from a request; the id is the
 * only value that varies and it is bound, not interpolated.
 */
function api_fk_exists(PDO $pdo, string $sql, int $id): bool
{
    $stmt = $pdo->prepare($sql);
    $stmt->execute([':id' => $id]);
    return (bool)$stmt->fetch();
}

/**
 * A query string or JSON field read as a boolean.
 *
 * Ten endpoints had written this, in four versions that did not agree:
 *
 *   seven files  a true-list only, so ANY unrecognised value returned false and
 *                $default was ignored for everything except null and "". A
 *                caller asking for bool_like($x, true) got false on garbage,
 *                which is the opposite of what passing a default means.
 *   user.php     no 'y' and no 'n' in its lists, so ?archived=y meant one thing
 *                on /course.php and another here.
 *   student.php  the only one that read a number, so archived=2 was true there
 *                and false everywhere else.
 *   attendance   the most complete, and prefixed attendance_bool_like purely to
 *                avoid colliding with the others.
 *
 * This is the union, and it is the attendance version plus student's numeric
 * case. Nothing in the app can currently tell the difference: every call site
 * passes false as the default, and the frontend only ever sends 1. The
 * divergence was a trap for the next person, not a live bug.
 *
 * The rule: null and blank mean "not answered", so they take $default. A
 * recognised word or number is honoured. Anything else is also "not answered"
 * and takes $default, rather than being quietly read as false.
 */
function api_bool_like($value, bool $default = false): bool
{
    if ($value === null) return $default;
    if (is_bool($value)) return $value;
    if (is_int($value) || is_float($value)) return ((int)$value) !== 0;

    $normalized = strtolower(trim((string)$value));
    if ($normalized === '') return $default;
    if (in_array($normalized, ['1', 'true', 'yes', 'y', 'on'], true)) return true;
    if (in_array($normalized, ['0', 'false', 'no', 'n', 'off'], true)) return false;
    if (is_numeric($normalized)) return ((float)$normalized) !== 0.0;

    return $default;
}

/**
 * Send a JSON response and stop.
 *
 * Twenty-five endpoints carried a byte-identical copy of this. They could not
 * collide - each file is its own request - so nothing was broken by it; what it
 * cost was a single place to stand. Anything one might later want on every
 * response, a request id to correlate with the audit log being the obvious one,
 * meant twenty-five edits, which in practice means it never happens.
 *
 * The Content-Type is already set by api_send_headers() at the top of each
 * endpoint, so this deliberately does not set it again: a second header() call
 * would silently mask an endpoint that forgot to send its headers at all.
 *
 * Two files do NOT use this. role_permissions.php and user_permissions.php add
 * a `success` key to every payload, and they are the only two that do. Adding
 * it here would change the response shape of twenty-five endpoints the frontend
 * already reads, so their version stays theirs - renamed permissions_out() so
 * that a function which behaves differently no longer wears the same name.
 */
function api_out(int $code, $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

/**
 * Record an administrative change — a settings edit, a permission grant, an
 * account being archived.
 *
 * Writes to `api_audit_log`, the same table as api_audit_record(), and that
 * matters: for a long time this function wrote to a *second* table, `audit_logs`,
 * which audit_log.php never reads. Everything recorded here — every RBAC change,
 * every security-policy edit, every user archive and restore — was being stored
 * correctly and shown nowhere. An administrator asking "who deactivated this
 * account" could not find the answer in the Audit Logs screen.
 *
 * One table, one viewer, one answer.
 *
 * This note used to end "nothing writes to `audit_logs` now", and that was not
 * true — two writers had been missed, so the consolidation was only ever
 * partial:
 *
 *   student_contact_workflow_lib.php  wrote every contact-status change and
 *       home-visit update there, and NOTHING read them back. Forty-five rows
 *       into a table with no reader. Now goes through this function.
 *   profile.php  writes there and also reads its own rows back, by user_id and
 *       action, to build the "recent changes" list on the profile screen. That
 *       one still writes to `audit_logs` because that list depends on it — and
 *       now calls this function as well, so the change shows up in both places.
 *
 * The rows written before the consolidation were copied across by
 * migrations/2026_08_25_backfill_action_audit_trail.sql. `audit_logs` stays in
 * place: it is the profile history's store, and it is the original record of
 * everything backfilled.
 *
 * The metadata array is folded into the detail text because api_audit_log has no
 * JSON column. That is a deliberate trade: a slightly lossy detail string in the
 * log an administrator actually reads beats a perfectly structured row in a
 * table nobody looks at.
 */
/**
 * "granted Reports (view); revoked Grades (edit, delete)" — a permissions
 * change as a sentence.
 *
 * The audit row carries the whole before and after map in its metadata, which
 * is the right thing to keep and the wrong thing to read: it is two nested
 * objects listing every module in the system, and the two or three entries that
 * actually differ are somewhere inside them. Nobody scanning a log finds a
 * changed permission that way.
 *
 * So the diff is computed once, when the change is made and both sides are in
 * hand, and written into the sentence. The full maps stay in the metadata for
 * anyone who needs to prove exactly what the state was.
 *
 * Module keys are passed through a lookup rather than printed raw, because
 * `student_manage` is a database identifier and "Student Management" is what
 * the person who made the change saw on their screen.
 */
function api_permission_change_summary(PDO $pdo, array $before, array $after): string
{
    $names = [];
    try {
        foreach ($pdo->query('SELECT module_key, module_name FROM rbac_module') as $row) {
            $names[(string)$row['module_key']] = (string)$row['module_name'];
        }
    } catch (Throwable $ignored) {
        $names = [];
    }

    $label = static function (string $key) use ($names): string {
        return $names[$key] ?? ucwords(str_replace(['_', '-'], ' ', $key));
    };

    $granted = [];
    $revoked = [];

    foreach (array_unique(array_merge(array_keys($before), array_keys($after))) as $module) {
        $was = array_values(array_unique(array_map('strval', (array)($before[$module] ?? []))));
        $now = array_values(array_unique(array_map('strval', (array)($after[$module] ?? []))));

        $added = array_values(array_diff($now, $was));
        $removed = array_values(array_diff($was, $now));

        if ($added) {
            $granted[] = $label((string)$module) . ' (' . implode(', ', $added) . ')';
        }
        if ($removed) {
            $revoked[] = $label((string)$module) . ' (' . implode(', ', $removed) . ')';
        }
    }

    if (!$granted && !$revoked) {
        // Saving the same map is a real thing people do, and "no change" is a
        // more honest line than an empty list that reads like a failure.
        return 'no permissions changed';
    }

    /*
     * Budgeted in characters, not in entries.
     *
     * `detail` is varchar(255) and api_audit_record() truncates to fit, so a
     * sentence that runs over does not get an ellipsis -- it gets cut mid-word,
     * which is how this column came to hold half-finished JSON in the first
     * place. Counting entries does not prevent that: six modules named
     * "Attendance Management (view, edit, delete)" are 250 characters on their
     * own. So each half gets a character allowance and says how many it left
     * out, and the row stays a sentence at any width.
     */
    $summarize = static function (array $items, int $budget): string {
        $shown = [];
        $used = 0;

        foreach ($items as $item) {
            $addition = ($shown ? 2 : 0) + strlen($item);
            if ($shown && $used + $addition > $budget) {
                break;
            }
            $shown[] = $item;
            $used += $addition;
        }

        $hidden = count($items) - count($shown);
        return implode(', ', $shown) . ($hidden > 0 ? ' and ' . $hidden . ' more' : '');
    };

    // Room for the role name the caller puts in front, and for "; " between the
    // halves when a change both grants and revokes.
    $allowance = $granted && $revoked ? 82 : 172;

    $parts = [];
    if ($granted) {
        $parts[] = 'granted ' . $summarize($granted, $allowance);
    }
    if ($revoked) {
        $parts[] = 'revoked ' . $summarize($revoked, $allowance);
    }

    return implode('; ', $parts);
}

/**
 * Characters no stored value may contain, at two strictness levels.
 *
 * Prompted by a student saved as `<TESTII><SVG/ONLOAD=ALERT(1)//>`. Nothing
 * executed — React escapes JSX, the Excel writer escapes XML, the PDF writer
 * escapes its own syntax — but the value was stored raw and appeared verbatim
 * in every list, export and printout. Refusing it on the way IN is the durable
 * fix: output escaping is a promise that five rendering paths have to keep
 * forever, and a value that cannot be stored cannot be rendered wrongly by a
 * path written next year.
 *
 * ── WHY TWO LEVELS AND NOT ONE LIST ────────────────────────────────────────
 *
 * A single blocklist is either too loose for a name or too tight for prose. A
 * survey question legitimately reads "How many hours (per week) do you study?"
 * — parentheses and a question mark are ordinary English there and an attack
 * nowhere. Refusing them would train people to work around the validator, which
 * is worse than not having one.
 *
 *   STRICT  names, codes, sections, student numbers — values that are
 *           identifiers. Nothing here is ever punctuation-heavy, so the list is
 *           wide: it also covers formula and glob characters.
 *
 *   PROSE   descriptions, questions, addresses, remarks — values that are
 *           sentences. Only the characters that open a tag, an expression or a
 *           shell context, which is the actual injection surface.
 *
 * Both levels reject control characters, including NUL — which truncates a C
 * string mid-value and is never something a person typed.
 *
 * Never blocked at either level, because real records contain them: apostrophes
 * (O'BRIEN), hyphens (DELA CRUZ-SANTOS), periods, commas, ñ and accents, and
 * the # & @ + that appear in addresses and contact fields.
 */
const API_UNSAFE_CHARS_STRICT = '<>{}[]()\\|`;~^*?=';
const API_UNSAFE_CHARS_PROSE  = '<>{}\\|`~';

/**
 * null when the value is clean, or a sentence naming what is wrong.
 *
 * Names the offending characters rather than refusing generically: "remove <
 * and >" is fixable, "invalid input" is a puzzle, and the person typing is a
 * registrar with a real record in front of them, not an attacker.
 */
function api_reject_unsafe_text(?string $value, string $label, string $mode = 'strict'): ?string
{
    if ($value === null || $value === '') {
        return null;
    }

    $blocked = $mode === 'prose' ? API_UNSAFE_CHARS_PROSE : API_UNSAFE_CHARS_STRICT;
    $found = [];

    $length = mb_strlen($value, 'UTF-8');
    for ($i = 0; $i < $length; $i++) {
        $char = mb_substr($value, $i, 1, 'UTF-8');
        if (strlen($char) === 1 && ord($char) < 32) {
            $found['(control character)'] = true;
            continue;
        }
        if (strpos($blocked, $char) !== false) {
            $found[$char] = true;
        }
    }

    if (!$found) {
        return null;
    }

    return $label . ' cannot contain ' . implode(' ', array_keys($found)) . '.';
}

/**
 * Check several fields at once; returns the first problem, or null.
 *
 * `$fields` is [request key => label], and `$mode` applies to all of them, so a
 * caller separates its identifier fields from its prose fields by calling twice
 * rather than by annotating every entry.
 */
function api_reject_unsafe_fields(array $payload, array $fields, string $mode = 'strict'): ?string
{
    foreach ($fields as $key => $label) {
        $value = $payload[$key] ?? null;
        if ($value === null || is_array($value)) {
            continue;
        }
        $rejection = api_reject_unsafe_text(trim((string)$value), $label, $mode);
        if ($rejection !== null) {
            return $rejection;
        }
    }

    return null;
}

function api_write_audit_log(PDO $pdo, ?array $actor, string $action, string $detail, array $metadata = []): void
{
    $normalizedAction = trim((string)$action);
    if ($normalizedAction === '') {
        return;
    }

    /*
     * The sentence and the data are stored apart, in `detail` and `metadata`.
     *
     * They used to be joined -- prose, a space, then json_encode() of the
     * metadata -- and written into `detail`, which is varchar(255). Anything
     * with a real payload was therefore cut mid-object: of the 136 rows written
     * that way, 76 were truncated at exactly 255 characters and every one of
     * those held JSON that never closed. The reader could not parse it, and the
     * sentence a person actually reads was buried behind the wreckage.
     *
     * TEXT for the metadata rather than a wider varchar, because a permissions
     * diff carries a before and an after for every module and there is no
     * sensible ceiling to pick.
     */
    $encoded = null;
    if (!empty($metadata)) {
        $json = json_encode($metadata, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json !== false) {
            $encoded = $json;
        }
    }

    api_audit_record($pdo, [
        'user_id' => isset($actor['user_id']) ? (int)$actor['user_id'] : null,
        // The email rather than the id, so the row still names someone after the
        // account is gone — the reason the old table kept its *_snapshot columns.
        'actor_label' => (string)($actor['email'] ?? ''),
        'action' => $normalizedAction,
        'outcome' => 'success',
        'detail' => trim($detail),
        'metadata' => $encoded,
    ]);
}

/**
 * "1st Semester 2026-2027, P2" — the term an import wrote into, in words.
 *
 * Ids are what the request carried, and they are useless in an audit line: the
 * reader checking whether a file landed in the right term cannot tell whether
 * semester_id 2 was the one they picked. Names are resolved once per import, so
 * the two extra lookups cost nothing against a file of thousands of rows.
 */
function api_term_label(PDO $pdo, ?int $semesterId, ?int $schoolYearId, $period = null): string
{
    $parts = [];

    if ($semesterId) {
        $stmt = $pdo->prepare('SELECT semester_name FROM semester WHERE semester_id = :id LIMIT 1');
        $stmt->execute([':id' => $semesterId]);
        $parts[] = (string)($stmt->fetchColumn() ?: ('Semester #' . $semesterId));
    }

    if ($schoolYearId) {
        $stmt = $pdo->prepare('SELECT schoolyear_name FROM school_year WHERE school_year_id = :id LIMIT 1');
        $stmt->execute([':id' => $schoolYearId]);
        $parts[] = (string)($stmt->fetchColumn() ?: ('School year #' . $schoolYearId));
    }

    // periodic_lib.php is loaded by the importers but not by every caller, so
    // the label is optional rather than assumed.
    if (function_exists('api_period_label')) {
        $parts[] = api_period_label($period);
    }

    return implode(' ', array_filter($parts));
}

/**
 * Record a bulk upload.
 *
 * Imports were the one high-impact act with no audit trail at all. They write
 * with INSERT ... ON DUPLICATE KEY UPDATE, so a single upload can silently
 * replace a term's worth of grades or balances for hundreds of students, and
 * afterwards the only evidence was a summary on a screen that had since been
 * closed. Nothing on record said the file had ever been uploaded, by whom, or
 * against which term.
 *
 * The action is per module (`grades_imported`, `finance_imported`, …) rather
 * than one shared `data_imported`, so the Action filter in the audit viewer can
 * answer "show me the grade uploads" without a text search.
 *
 * The counts go in the detail line because that is what makes a row worth
 * reading: "312 updated" against a term nobody meant to touch is the sentence
 * that reveals the mistake.
 */
function api_audit_import(PDO $pdo, ?array $actor, string $module, string $fileName, array $summary, string $termLabel = ''): void
{
    $parts = [];
    foreach (['inserted' => 'added', 'updated' => 'updated', 'unmatched' => 'unmatched', 'invalid' => 'invalid'] as $key => $word) {
        $value = (int)($summary[$key] ?? 0);
        if ($value > 0) {
            $parts[] = $value . ' ' . $word;
        }
    }

    $name = trim($fileName) !== '' ? basename(trim($fileName)) : 'an uploaded file';
    $detail = 'Imported ' . $module . ' from "' . $name . '"'
        . ($termLabel !== '' ? ' into ' . $termLabel : '')
        . ': ' . ($parts ? implode(', ', $parts) : 'no rows written')
        . ' (' . (int)($summary['rows_read'] ?? 0) . ' rows read).';

    api_write_audit_log($pdo, $actor, $module . '_imported', $detail, $summary);
}

function api_endpoint_module_map(): array
{
    return [
        'notifications.php' => '',
        'security_policy.php' => 'settings',
        // Who signed in from where is a security record, not a report: it is
        // gated with the rest of the security surface, not with `reports`.
        'audit_log.php' => 'settings',
        'user.php' => 'users',
        'user_permissions.php' => 'users',
        'student.php' => 'student_manage',
        // One student read across every term they appear in. Gated with
        // Student Management because that is the screen it serves; the
        // endpoint itself then drops each block a caller's modules do not
        // cover, so student_manage:view is not a back door into balances.
        'student_history.php' => 'student_manage',
        // Bulk student creation. Same module as the single-student POST it
        // replaces in volume — the difference is one request per thousand
        // rows instead of one per row, not a different kind of permission.
        'student-import.php' => 'student_manage',
        'user-summary.php' => 'reports',
        /*
         * The institution's charts: enrolment by year, attendance rates by
         * course, grade distribution, and the total outstanding balance across
         * every student — for the caller's department or, via ?department_id=,
         * for any other.
         *
         * It was gated on `overview` so that a role could have its own
         * dashboard without being handed Reports. That reasoning does not
         * survive contact with who holds `overview`: EVERY role does, students
         * included, because it is the module that puts a dashboard on the
         * account at all. Measured 2026-09-21, a student account read the whole
         * College's figures — 2,777 students, an 87.1% attendance rate and
         * ₱61.8M of outstanding balances — and reached a second department by
         * adding ?department_id=11.
         *
         * `reports` is the honest key: this is reporting data, and it is held
         * by every staff role and by no student. The dashboard concern the old
         * comment raised is answered by student_overview.php below, which is
         * the endpoint a bare dashboard actually needs and correctly stays on
         * `overview` — it takes no parameters and can only answer for the
         * caller's own record.
         */
        'overview_analytics.php' => 'reports',
        // A student's own balance and attendance for their own dashboard. Gated
        // on `overview` and not on finance_management/attendance_management on
        // purpose: it takes no student parameter and can only ever answer for
        // the caller's own linked record, so it is not a window onto either of
        // those modules. See the header of student_overview.php.
        'student_overview.php' => 'overview',
        'attendance-summary.php' => 'attendance_management',
        'survey.php' => 'survey',
        // The address picker's list source. Gated with the survey it serves
        // rather than given a module of its own: a new module key starts with no
        // permission rows and would lock every role out of a list of published
        // place names.
        'ph_address.php' => 'survey',
        'survey-summary.php' => 'reports',
        'survey_question.php' => 'survey_questions',
        'survey_question_option.php' => 'survey_questions',
        'survey_response.php' => 'survey_responses',
        'survey_submission.php' => 'survey_submissions',
        'finance.php' => 'finance_management',
        'finance-import.php' => 'finance_management',
        // The Finance Report reads balances per student, so it is gated on the
        // finance module itself rather than on `reports` — being allowed to open
        // Reports is not the same as being allowed to see what people owe.
        'finance-summary.php' => 'finance_management',
        'grades.php' => 'grades',
        'grades-import.php' => 'grades',
        'remarks.php' => 'remarks',
        'enrollment_status.php' => 'enrollment_status',
        'retention_case.php' => 'retention_cases',
        'retention_matrix.php' => 'retention_cases',
        // The PDO prioritization list. Gated on retention_cases rather than on a
        // module of its own: it is a reading of the same students the retention
        // module already governs, and a new module key would start with no
        // permission rows at all, locking every role out of a screen they are
        // meant to have.
        'pdo_priority.php' => 'retention_cases',
        'student_migration.php' => 'student_migration',
        // The year-end evaluation. Read on the Migration module; its writes
        // move student records and are pointed at student_manage:edit in
        // api_endpoint_permission_target_overrides().
        'year_migration.php' => 'student_migration',
        // Configuring how risk is scored is a settings-level act, not a
        // case-work one: it changes every future evaluation system-wide.
        'risk_model.php' => 'settings',
        // Which term the portal is in. Its own module rather than a corner of
        // Settings: three working screens read it on every page load, and it is
        // maintained every periodical rather than configured once.
        'academic_calendar.php' => 'academic_calendar',
        // Managing the lists. The forms that PICK from them read
        // dropdown_options.php instead, which has no module on purpose.
        'dropdown_list.php' => 'dropdown_lists',
        'grade_remark_policy.php' => 'settings',
        /*
         * The attendance target and the rules that read it.
         *
         * Gated on `remarks` rather than on `settings`, which is where its twin
         * above sits, and the difference is deliberate: this screen lives inside
         * Remarks Management, next to the vocabulary it assigns from. Gating it
         * on settings would mean a person who may create the remark "Excessive
         * Absences" cannot write the rule that hands it out -- two halves of one
         * job behind two different permissions.
         *
         * The override below also accepts settings:edit, so an administrator
         * reaches it either way.
         */
        'attendance_remark_policy.php' => 'remarks',
        // Reads three modules' records and writes none of them. Gated as a
        // report because that is what it is: reports:analyze already exists and
        // is already granted to the roles that compare cohorts, where a module
        // key of its own would start with no permission rows at all and lock
        // every one of them out of a screen meant for them.
        'term_comparison.php' => 'reports',
        'faculty_periodical_report.php' => 'reports',
        // The records logbook. Same reasoning as the comparison above: it reads
        // three modules and writes none of them, and a module key of its own
        // would start with no permission rows and lock every role out of a
        // screen meant for them.
        'term_logbook.php' => 'reports',
        // Closing a term is the same shape: it writes down what every student
        // was that term, which is what every later report about the past will
        // read. Not case work, and not something the Migration module should be
        // able to do — that one is read-only by design.
        'term_snapshot.php' => 'settings',
        'roles.php' => 'roles',
        'role_permissions.php' => 'roles',
        'campus.php' => 'campuses',
        'department.php' => 'departments',
        'course.php' => 'courses',
        'ssp_assignment.php' => 'assignments',
        'student_contact_workflow.php' => 'student_contacts',
        // The workspace's contact log. Asks for `analyze`, not `view`: see the
        // override in api_endpoint_permission_target_overrides().
        'student_contact_log.php' => 'student_contacts',
        'team_monitor.php' => 'team_monitor',
        'home_visit_queue.php' => 'home_visits',
        /*
         * The periodical workspace. Centralized here rather than left to the
         * endpoint's own api_can() call, which was the only gate it had.
         *
         * That check is correct and stays where it is -- this is defence in
         * depth, not a replacement. What the endpoint could not do on its own is
         * be *seen*: with no entry here it resolved to no permission target at
         * all, so api_require_auth() admitted any signed-in account and left the
         * decision to one line inside the file. It was also invisible to the
         * endpoint-guard test that covers the rest of the API.
         *
         * The default method mapping is exactly right here, which is why no
         * override is needed: GET maps to `view` and POST to `create`, and
         * faculty_workspace declares both. attendance-import.php could not be
         * listed here for the opposite reason -- POST would have resolved to a
         * `create` that attendance_management does not declare -- so it names its
         * target explicitly in api_endpoint_permission_target_overrides() and asks
         * for `import` instead.
         *
         * Tightens POST from `view` to `create`. Every account holding this
         * module today (role 15, Faculty) holds view, create and analyze, so
         * nothing that could write before loses access.
         */
        'faculty_workspace.php' => 'faculty_workspace',
        'student_contact_report.php' => 'reports',
        'status.php' => 'statuses',
        'backup.php' => 'settings',
    ];
}

function api_get_endpoint_module_key(?string $endpoint = null): string
{
    $currentEndpoint = $endpoint ?: basename($_SERVER['SCRIPT_FILENAME'] ?? '');
    $map = api_endpoint_module_map();
    return api_normalize_permission_module_key($map[$currentEndpoint] ?? '');
}

function api_endpoint_permission_target_overrides(): array
{
    return [
        'user-summary.php' => [
            'GET' => [
                ['module' => 'overview', 'action' => 'view'],
                ['module' => 'survey', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
            ],
        ],
        // `import` OR `create`: the frontend has always treated a role that
        // can create students as able to import them, and a role holding
        // only `import` must not be refused by a default mapping that asks
        // for `create`.
        'student-import.php' => [
            'POST' => [
                ['module' => 'student_manage', 'action' => 'import'],
                ['module' => 'student_manage', 'action' => 'create'],
            ],
        ],
        /*
         * Attendance uploads, gated like the other two importers at last.
         *
         * This could not be expressed before: an entry in api_endpoint_module_map()
         * resolves POST to `create`, an action attendance_management does not
         * declare and nobody could hold, which would refuse every role including
         * admin. So the endpoint had no permission target at all, fell through to
         * the role list in api_endpoint_policy_map(), and answered a bare
         * "Forbidden" to everyone but admin -- including SSG, who holds attendance
         * export and analyze, already imports grades, and was shown an Import
         * button that could only ever fail.
         *
         * An override names the action outright and is read before the default
         * method mapping, so `import` is what gets asked for and `create` never
         * comes up.
         */
        'attendance-import.php' => [
            'POST' => [
                ['module' => 'attendance_management', 'action' => 'import'],
            ],
        ],
        /*
         * The Contact Workspace's contact log, which is also its export.
         *
         * `analyze` rather than the `view` a GET would default to: reading the
         * whole log and taking it away as a file is reporting, and `analyze`
         * is how this system grants reporting on a module. Every role holding
         * student_contacts holds it, so no one working the queue loses the log,
         * and a role can be given the queue without it.
         */
        'student_contact_log.php' => [
            'GET' => [
                ['module' => 'student_contacts', 'action' => 'analyze'],
            ],
        ],
        'faculty_periodical_report.php' => [
            'GET' => [
                ['module' => 'reports', 'action' => 'analyze'],
            ],
        ],
        'student.php' => [
            'GET' => [
                ['module' => 'users', 'action' => 'view'],
                ['module' => 'student_manage', 'action' => 'view'],
                ['module' => 'finance_management', 'action' => 'view'],
                ['module' => 'grades', 'action' => 'view'],
                ['module' => 'enrollment_status', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
                ['module' => 'survey', 'action' => 'view'],
                ['module' => 'survey_responses', 'action' => 'view'],
                ['module' => 'survey_submissions', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'student_manage', 'action' => 'create'],
            ],
            'PUT' => [
                ['module' => 'student_manage', 'action' => 'edit'],
            ],
            'DELETE' => [
                ['module' => 'student_manage', 'action' => 'delete'],
            ],
        ],
        // ---------------------------------------------------------------
        // SUPPORTING READS
        //
        // A page is not one endpoint. The Survey Submissions page, for
        // example, reads survey_response.php to render the answers inside a
        // submission — so granting a role "Survey Submissions" and nothing
        // else produced a page that loaded and then said "You do not have
        // permission to view this page", with no clue which other module was
        // missing. The admin ticked the box the UI offered and it did not work.
        //
        // Each GET below therefore accepts any module whose page legitimately
        // has to read it. GET only: POST/PUT/DELETE fall through to the owning
        // module (api_get_endpoint_permission_targets resolves per method), so
        // reading a survey's questions never implies editing them.
        // ---------------------------------------------------------------
        'survey.php' => [
            'GET' => [
                ['module' => 'survey', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
                // Questions/responses/submissions pages all show survey names.
                ['module' => 'survey_questions', 'action' => 'view'],
                ['module' => 'survey_responses', 'action' => 'view'],
                ['module' => 'survey_submissions', 'action' => 'view'],
            ],
        ],
        'survey_question.php' => [
            'GET' => [
                ['module' => 'survey_questions', 'action' => 'view'],
                // An answer is meaningless without the question text.
                ['module' => 'survey_responses', 'action' => 'view'],
                ['module' => 'survey_submissions', 'action' => 'view'],
                ['module' => 'survey', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
            ],
        ],
        'survey_response.php' => [
            'GET' => [
                ['module' => 'survey_responses', 'action' => 'view'],
                // Opening a submission lists the answers it contains.
                ['module' => 'survey_submissions', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
            ],
        ],
        'survey_submission.php' => [
            'GET' => [
                ['module' => 'survey_submissions', 'action' => 'view'],
                ['module' => 'survey_responses', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
            ],
        ],
        // NOTE: user.php is deliberately NOT widened to reports:view either.
        // It re-checks users:view itself before allowing the list to be
        // browsed (see the $canBrowseUsers gate), so an override here would
        // only move the 403 one line down, not remove it. The one report that
        // reads it — Archived Records — asks for the archived *user* list, so
        // users:view is the honest requirement. It already loads through
        // Promise.allSettled, so that report degrades instead of breaking.
        'roles.php' => [
            'GET' => [
                ['module' => 'roles', 'action' => 'view'],
                // The user form needs the role list to populate its dropdown,
                // and Settings > Role-Based Access is built entirely from it.
                ['module' => 'users', 'action' => 'view'],
                ['module' => 'settings', 'action' => 'view'],
            ],
        ],
        'role_permissions.php' => [
            'GET' => [
                ['module' => 'roles', 'action' => 'view'],
                ['module' => 'settings', 'action' => 'view'],
            ],
        ],
        'user_permissions.php' => [
            'GET' => [
                ['module' => 'users', 'action' => 'view'],
                ['module' => 'roles', 'action' => 'view'],
                ['module' => 'settings', 'action' => 'view'],
            ],
        ],
        'grades.php' => [
            'GET' => [
                ['module' => 'grades', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
            ],
        ],
        // NOTE: retention_case.php is deliberately NOT widened to reports:view.
        // Its own require_case_access() gate re-checks retention_cases:view,
        // and enforce_case_scope() narrows by department only for roles it
        // recognises (admin/dean/coordinator/ssg/caller) — any other role
        // falls through the bottom of that function and is scoped to nothing.
        // Letting reports:view past the outer gate would therefore expose
        // every department's cases. The retention report needs the real
        // retention_cases:view grant.
        //
        // The WRITE methods do carry an override, added 2026-09-03 for the
        // faculty `intervene` grant. Without it PUT resolved to the default
        // retention_cases:edit and POST to :create, so a role holding only
        // `intervene` was refused by this outer gate and never reached the
        // finer check inside the endpoint -- faculty got a flat 403 on a P1
        // case they were supposed to be able to act on.
        //
        // This is an OR list, so it widens the OUTER gate only. Every path
        // behind it still makes its own decision: validation_status needs
        // can_validate, assigned_to_user_id needs can_assign, the three
        // intervention fields and add_note go through
        // case_intervention_allowed(), and run_evaluation needs
        // can_run_evaluation. Nothing that could write before loses access --
        // the actions that used to satisfy the gate are all still listed.
        /*
         * Logging a contact from the PDO board.
         *
         * POST defaults to `<module>:create` through
         * api_method_to_permission_action(), which would refuse a role holding
         * only `intervene` at this OUTER gate -- before the endpoint's own
         * check ever runs, so the refusal arrives as a flat 403 with nothing
         * saying which rule produced it. That is exactly how the faculty
         * intervention grant failed in 2026-09, and the fix is the same: name
         * the actions that mean "record what you did" explicitly.
         */
        'pdo_priority.php' => [
            'POST' => [
                ['module' => 'retention_cases', 'action' => 'intervene'],
                ['module' => 'retention_cases', 'action' => 'edit'],
                ['module' => 'retention_cases', 'action' => 'create'],
            ],
        ],
        'retention_case.php' => [
            'PUT' => [
                ['module' => 'retention_cases', 'action' => 'edit'],
                ['module' => 'retention_cases', 'action' => 'assign'],
                ['module' => 'retention_cases', 'action' => 'intervene'],
            ],
            'POST' => [
                ['module' => 'retention_cases', 'action' => 'create'],
                ['module' => 'retention_cases', 'action' => 'analyze'],
                ['module' => 'retention_cases', 'action' => 'edit'],
                ['module' => 'retention_cases', 'action' => 'intervene'],
            ],
        ],
        'semester.php' => [
            'GET' => [
                ['module' => 'survey', 'action' => 'view'],
                ['module' => 'finance_management', 'action' => 'view'],
                ['module' => 'grades', 'action' => 'view'],
                ['module' => 'enrollment_status', 'action' => 'view'],
                ['module' => 'attendance_management', 'action' => 'view'],
            ],
        ],
        'school_year.php' => [
            'GET' => [
                ['module' => 'users', 'action' => 'view'],
                ['module' => 'student_manage', 'action' => 'view'],
                ['module' => 'finance_management', 'action' => 'view'],
                ['module' => 'grades', 'action' => 'view'],
                ['module' => 'enrollment_status', 'action' => 'view'],
                ['module' => 'attendance_management', 'action' => 'view'],
            ],
            /*
             * Setting the current school year is a settings act, not a term-picker
             * one. Everything that can READ a year list is listed above, which is
             * most of the app; deciding which year is live is an administrator's
             * job and asks for the same permission the other settings writes do.
             */
            'PUT' => [
                ['module' => 'settings', 'action' => 'edit'],
            ],
        ],
        'status.php' => [
            'GET' => [
                ['module' => 'statuses', 'action' => 'view'],
                ['module' => 'survey', 'action' => 'view'],
            ],
        ],
        'department.php' => [
            'GET' => [
                ['module' => 'departments', 'action' => 'view'],
                ['module' => 'users', 'action' => 'view'],
                ['module' => 'courses', 'action' => 'view'],
                ['module' => 'attendance_management', 'action' => 'view'],
            ],
        ],
        'campus.php' => [
            'GET' => [
                ['module' => 'campuses', 'action' => 'view'],
                ['module' => 'users', 'action' => 'view'],
                ['module' => 'departments', 'action' => 'view'],
            ],
        ],
        'course.php' => [
            'GET' => [
                ['module' => 'courses', 'action' => 'view'],
                ['module' => 'users', 'action' => 'view'],
                ['module' => 'student_manage', 'action' => 'view'],
                ['module' => 'reports', 'action' => 'view'],
                ['module' => 'attendance_management', 'action' => 'view'],
            ],
        ],
        'backup.php' => [
            'GET' => [
                ['module' => 'settings', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'PUT' => [
                ['module' => 'settings', 'action' => 'edit'],
            ],
        ],
        /*
         * Closing a term has to be spelled out rather than left to the default
         * method mapping, and for a reason worth recording: POST maps to
         * `create`, and `settings` has no `create` action. The default would
         * therefore ask for a permission nobody can hold and refuse the request
         * for every role including admin - a lockout that looks exactly like a
         * bug in the endpoint.
         *
         * `edit` and not `manage`, which is the counter-intuitive half. On this
         * module `manage` is not "the strongest settings act" - it resolves to
         * the single RBAC action key `backup-database`, so asking for it here
         * would gate closing a term on holding the backup permission, and no
         * role including admin currently holds it. `edit` resolves to
         * can_edit/can_update, which is what backup.php's own POST asks for.
         */
        /*
         * The same trap term_snapshot.php documents below, and worth repeating
         * rather than inheriting: this endpoint writes on POST, PUT and DELETE,
         * and the default mapping would ask `settings` for `create` and
         * `delete`, neither of which that module defines. Every role including
         * admin would be refused, which reads as a broken endpoint rather than
         * as a missing permission. All three writes ask for `edit`, which is
         * what backup.php's own writes ask for.
         */
        /*
         * And once more, for the risk model.
         *
         * This one had gone unnoticed because nothing on the client called it:
         * the endpoint has been shipped and reachable since the risk model was
         * made configurable, and every write it offers — add an indicator,
         * delete one, activate a model — was refused for every role including
         * admin. `settings` defines no `create` and no `delete`, so the default
         * mapping asked for permissions nobody can hold. A model that cannot be
         * edited is a hardcoded model with extra tables.
         */
        'risk_model.php' => [
            'GET' => [
                ['module' => 'settings', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'PUT' => [
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'DELETE' => [
                ['module' => 'settings', 'action' => 'edit'],
            ],
        ],
        /*
         * Read by everyone who works a term; written only from Settings.
         *
         * The widest GET in this map, and deliberately so. What term it is now
         * is not a secret -- it is the answer three import dialogs need to fill
         * their own pickers in, and the person uploading a grades sheet holds
         * `grades`, not `settings`. Gating the read on settings:view would give
         * exactly the people this feature is for three blank dropdowns and no
         * indication why.
         *
         * The bottom four were added 2026-09-03, when the workspaces started
         * showing the term in their headers. The failure this fixes is the worst
         * kind: useCurrentTerm() swallows its errors on purpose -- a red banner
         * because a convenience could not load would be louder than the thing it
         * is about -- so a 403 here does not surface as a 403. It surfaces as a
         * header with no chips on it, which looks exactly like a feature that
         * was never built. Faculty hold none of the five modules above, so every
         * one of those screens was silently blank for them.
         *
         * `faculty_workspace` is listed in its own right rather than left to
         * ride on `overview`, which faculty also hold. Its header states the
         * periodical, and a page whose whole subject is "which periodical are we
         * in" must not lose that chip the day somebody narrows an unrelated
         * module. `student_contacts` came off the faculty preset on 2026-09-04
         * and this list did not have to change, which is the arrangement
         * working: the entry belongs to the screen, not to the role.
         *
         * The writes stay on settings:edit alone. Reading which term is current
         * is not permission to move it.
         */
        /*
         * Any action that could apply to the verb gets a request in; the
         * endpoint then checks the one it performs (a PUT may be an edit, an
         * archive, a restore or a reorder, and they are granted apart).
         * settings is beside each for the reason given at academic_calendar.php
         * below: a new module key starts with no grants anywhere.
         */
        'dropdown_list.php' => [
            'GET' => [
                ['module' => 'dropdown_lists', 'action' => 'view'],
                ['module' => 'settings', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'dropdown_lists', 'action' => 'create'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'PUT' => [
                ['module' => 'dropdown_lists', 'action' => 'edit'],
                ['module' => 'dropdown_lists', 'action' => 'archive'],
                ['module' => 'dropdown_lists', 'action' => 'restore'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
        ],
        'academic_calendar.php' => [
            'GET' => [
                ['module' => 'academic_calendar', 'action' => 'view'],
                ['module' => 'grades', 'action' => 'view'],
                ['module' => 'attendance_management', 'action' => 'view'],
                ['module' => 'finance_management', 'action' => 'view'],
                ['module' => 'settings', 'action' => 'view'],
                // The screens that show the term in their header, or open their
                // own filters on it. See currentTermScope() and
                // useCurrentTermFilters() in shared/lib/currentTerm.js.
                ['module' => 'overview', 'action' => 'view'],
                ['module' => 'student_contacts', 'action' => 'view'],
                ['module' => 'home_visits', 'action' => 'view'],
                ['module' => 'retention_cases', 'action' => 'view'],
                ['module' => 'faculty_workspace', 'action' => 'view'],
                // Enrollment Status fills its import year from the calendar and
                // reads the closed semesters from it too - see closed_terms.
                ['module' => 'enrollment_status', 'action' => 'view'],
            ],
            /*
             * settings:edit is listed beside the module's own edit, and stays
             * listed. A brand new module key starts with no permission rows
             * anywhere, so an installation that has this code but has not run
             * 2026_09_01_academic_calendar_module.sql would otherwise have
             * nobody at all able to set the term -- including the administrator
             * who is meant to grant the module in the first place.
             */
            'POST' => [
                ['module' => 'academic_calendar', 'action' => 'edit'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'PUT' => [
                ['module' => 'academic_calendar', 'action' => 'edit'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'DELETE' => [
                ['module' => 'academic_calendar', 'action' => 'edit'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
        ],
        /*
         * Two ways in, because there are two screens.
         *
         * Settings owns "which year is current", which is the line that decides
         * what a policy can reach. Remarks Management owns the vocabulary a rule
         * assigns from. Both show the rule editor, so both permissions open it;
         * the list is an OR.
         *
         * `remarks` was added when the editor moved into Remarks Management. It
         * widens nothing today -- Admin is the only role holding either -- but
         * it means granting remarks:edit later grants a working screen instead
         * of one that loads and then refuses every save.
         */
        'grade_remark_policy.php' => [
            'GET' => [
                ['module' => 'settings', 'action' => 'view'],
                ['module' => 'remarks', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'settings', 'action' => 'edit'],
                ['module' => 'remarks', 'action' => 'edit'],
            ],
            'PUT' => [
                ['module' => 'settings', 'action' => 'edit'],
                ['module' => 'remarks', 'action' => 'edit'],
            ],
            'DELETE' => [
                ['module' => 'settings', 'action' => 'edit'],
                ['module' => 'remarks', 'action' => 'edit'],
            ],
        ],
        // The attendance twin, same pair of doors. Spelled out rather than
        // sharing a variable with the grade entry above: they are two policies
        // that happen to agree today, and a shared list would silently move one
        // when somebody edited the other.
        'attendance_remark_policy.php' => [
            'GET' => [
                ['module' => 'remarks', 'action' => 'view'],
                ['module' => 'settings', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'remarks', 'action' => 'edit'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'PUT' => [
                ['module' => 'remarks', 'action' => 'edit'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
            'DELETE' => [
                ['module' => 'remarks', 'action' => 'edit'],
                ['module' => 'settings', 'action' => 'edit'],
            ],
        ],
        'term_snapshot.php' => [
            'GET' => [
                ['module' => 'settings', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'settings', 'action' => 'edit'],
            ],
        ],
        /*
         * Year-end evaluation (2026-10-06). Reading is the Migration module;
         * every write - an override, Apply, Revert, the cut-offs - moves or
         * decides a student's year level, which is student_manage:edit on the
         * student form, so it is the same permission here. The Migration module
         * keeps its read-only action list. year_migration.php also requires
         * student_migration:view for a write, and settings:edit for the cut-offs.
         */
        'year_migration.php' => [
            'GET' => [
                ['module' => 'student_migration', 'action' => 'view'],
            ],
            'POST' => [
                ['module' => 'student_manage', 'action' => 'edit'],
            ],
        ],
        /*
         * Two of the three endpoints Records & History reads.
         *
         * Listed as ALTERNATIVES to the module each already answers to, not as
         * replacements. term_logbook.php still answers Reports and
         * student_history.php still answers Student Management -- repointing
         * them would break two working screens to gain nothing. The list is an
         * OR: whichever door the reader came through, the endpoint answers.
         *
         * audit_log.php is DELIBERATELY NOT HERE. It stays on `settings` alone.
         * Adding records_history to it would hand the trail of every sign-in and
         * every permission change to SSG, Dean and Program Head, none of whom
         * can read it today -- and an earlier draft of this list also named
         * `reports`, which handed it to the SSP Caller as well. The module's
         * Activity tab is gated on the reader holding `settings` instead, so the
         * other three roles get the term register and the student timeline and
         * the trail stays where it was.
         */
        'term_logbook.php' => [
            'GET' => [
                ['module' => 'reports', 'action' => 'view'],
                ['module' => 'records_history', 'action' => 'view'],
            ],
        ],
        /*
         * Narrower than student.php's list on purpose. That endpoint is reached
         * by nine screens that each name a student in passing; this one
         * assembles a single student's grades, attendance and balances into one
         * answer, so it asks for the module that owns the record rather than for
         * any module that mentions it -- plus records_history, which is the
         * second screen that legitimately reads a whole timeline.
         *
         * This is the only entry for student_history.php. There used to be a
         * second one further up, listing student_manage alone; PHP keeps the
         * last literal for a duplicate key, so that one was dead the day this
         * was added and editing it would have changed nothing.
         */
        'student_history.php' => [
            'GET' => [
                ['module' => 'student_manage', 'action' => 'view'],
                ['module' => 'records_history', 'action' => 'view'],
            ],
        ],
    ];
}

function api_normalize_permission_targets(array $targets): array
{
    $normalized = [];

    foreach ($targets as $target) {
        $moduleKey = api_normalize_permission_module_key($target['module'] ?? '');
        $action = api_normalize_permission_action($target['action'] ?? '');
        if ($moduleKey === '' || $action === '') {
            continue;
        }

        $normalized[] = [
            'module' => $moduleKey,
            'action' => $action,
        ];
    }

    return $normalized;
}

/**
 * The permission actions that only READ. Everything else changes something.
 *
 * Used to stop `?permission_action=` crossing the line between the two. The
 * list is deliberately short and explicit rather than "everything that is not a
 * write": an action added to the vocabulary is treated as a write until
 * somebody decides otherwise, which is the safe direction for a new name to
 * default in.
 */
const API_READ_PERMISSION_ACTIONS = ['view', 'analyze', 'export'];

/**
 * May this request nominate this permission action?
 *
 * `?permission_action=` exists because two real actions have no HTTP verb of
 * their own: archiving is a DELETE that must be checked against `archive`, and
 * restoring is a PUT that must be checked against `restore`. A role may hold
 * one and not the other, so the client has to be able to say which it means.
 *
 * What it must NEVER do is let a write be checked against a read. Until this
 * existed, any account holding `grades:view` could POST, PUT and DELETE on
 * grades.php by appending `?permission_action=view` -- the nominated action was
 * accepted purely because `view` is a valid action of that module, and the
 * method it arrived on was never consulted. Measured 2026-09-21: a Program Head
 * holding grades:view and nothing else reached all three write handlers, and
 * only a missing student_id stopped the row being written.
 *
 * So the nomination must stay on the same side of the read/write line as the
 * verb. GET may pick `export`; DELETE may pick `archive`; neither may pick the
 * other's kind. A nomination that fails this is ignored rather than refused --
 * the request then falls through to the action its method implies, which is the
 * check it should have had all along.
 */
function api_permission_action_matches_method(string $action, string $method): bool
{
    if ($action === '') {
        return false;
    }

    $methodReads = in_array(strtoupper(trim($method)), ['GET', 'HEAD', 'OPTIONS'], true);
    $actionReads = in_array($action, API_READ_PERMISSION_ACTIONS, true);

    return $methodReads === $actionReads;
}

function api_get_endpoint_permission_targets(?string $endpoint = null, ?string $method = null): array
{
    $currentEndpoint = $endpoint ?: basename($_SERVER['SCRIPT_FILENAME'] ?? '');
    $currentMethod = strtoupper(trim((string)($method ?: ($_SERVER['REQUEST_METHOD'] ?? 'GET'))));
    $overrideMap = api_endpoint_permission_target_overrides();
    $moduleKey = api_get_endpoint_module_key($currentEndpoint);
    $allowedModuleActions = api_permission_module_action_map();
    $explicitAction = api_normalize_permission_action($_GET['permission_action'] ?? '');

    if (
        $explicitAction !== ''
        && $moduleKey !== ''
        && isset($allowedModuleActions[$moduleKey])
        && in_array($explicitAction, $allowedModuleActions[$moduleKey], true)
        // The nominated action has to be the same kind as the verb it arrived
        // on, or a write can be checked against a read. See the note above.
        && api_permission_action_matches_method($explicitAction, $currentMethod)
    ) {
        return [[
            'module' => $moduleKey,
            'action' => $explicitAction,
        ]];
    }

    if (isset($overrideMap[$currentEndpoint][$currentMethod])) {
        return api_normalize_permission_targets($overrideMap[$currentEndpoint][$currentMethod]);
    }

    $action = api_method_to_permission_action($currentMethod);
    if ($moduleKey === '' || $action === '') {
        return [];
    }

    return [[
        'module' => $moduleKey,
        'action' => $action,
    ]];
}

function api_permission_module_action_map(): array
{
    return [
        'overview' => ['view'],
        'users' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'import', 'export', 'manage'],
        'student_manage' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'import', 'export'],
        // `import` is the only write attendance has: the figures are uploaded as
        // a sheet, never typed in, so there is nothing for `create` or `edit` to
        // mean here. Without it the importer had no grantable permission at all
        // and fell through to a hard-coded admin-only role list.
        'attendance_management' => ['view', 'export', 'analyze', 'import'],
        'departments' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'manage'],
        'roles' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'manage'],
        'courses' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'manage'],
        'grades' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'export'],
        'remarks' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'manage'],
        'statuses' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'manage'],
        'campuses' => ['view', 'create', 'edit', 'delete', 'manage'],
        'enrollment_status' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'manage'],
        'survey' => ['view', 'create', 'edit', 'delete', 'answer'],
        'survey_questions' => ['view', 'create', 'edit', 'delete', 'manage'],
        'survey_responses' => ['view', 'create', 'edit', 'delete', 'analyze'],
        'survey_submissions' => ['view', 'create', 'delete', 'analyze'],
        'finance_management' => ['view', 'create', 'edit', 'delete', 'export'],
        'assignments' => ['view', 'create', 'edit', 'delete', 'assign'],
        'student_contacts' => ['view', 'create', 'edit', 'analyze'],
        'home_visits' => ['view', 'edit', 'assign', 'analyze'],
        /*
         * `create` is the whole write surface: recording that a conversation
         * happened. There is deliberately no `edit` and no `delete` -- a
         * contact is a log of something that occurred at a moment, and a log
         * somebody can rewrite afterwards is not a log. A mistake is
         * corrected by recording the correction.
         */
        'faculty_workspace' => ['view', 'create', 'analyze'],
        /*
         * Read-only by design, like student_migration above it.
         *
         * The module reports what a team has done; it does not do the work. A
         * KSH TL who wants to log a call goes to the Contact Workspace, which is
         * the one place a contact attempt is written and therefore the one place
         * that has to authorise it.
         */
        'team_monitor' => ['view', 'analyze'],
        'reports' => ['view', 'analyze'],
        /*
         * `intervene` is deliberately narrower than `edit`: it records what was
         * done about a student (status, follow-up date, outcome, notes) without
         * the approve/reject sign-off that `edit` also carries. Faculty hold it;
         * see require_case_access() in retention_case.php.
         */
        'retention_cases' => ['view', 'create', 'edit', 'delete', 'assign', 'analyze', 'intervene'],
        // Read-only by design: the module reports on enrollment status, it does
        // not set it. Editing a status stays with `enrollment_status`.
        'student_migration' => ['view', 'analyze'],
        /*
         * Read-only, and more strictly so than the two above it.
         *
         * Records & History reads finished terms, per-student timelines and the
         * audit trail. Every one of those is a record of something that already
         * happened, and a module that could edit them would not be a history --
         * it would be a place to rewrite one. Editing a grade stays with
         * `grades`, a balance with `finance_management`, and the audit trail is
         * not editable from anywhere at all by design (see audit_log.php: an
         * audit log a client can write to is not evidence of anything).
         */
        'records_history' => ['view', 'analyze'],
        // Read it, or change it. There is nothing here to analyse and nothing
        // to delete -- removing a term's dates is an edit to the calendar.
        'academic_calendar' => ['view', 'edit'],
        /*
         * The Dropdown Management screen (dropdown_list.php). No `delete`: an
         * entry is archived, never removed, because records already hold it.
         * `archive` and `restore` are separate from `edit` so that rewording
         * an entry and taking it off every form can be granted apart.
         */
        'dropdown_lists' => ['view', 'create', 'edit', 'archive', 'restore'],
        'settings' => ['view', 'edit', 'manage'],
    ];
}

function api_default_role_permission_presets(): array
{
    return [
        'admin' => [
            'overview' => ['view'],
            // Fresh installations have no saved RBAC store yet.
            'student_migration' => ['view', 'analyze'],
            'finance_management' => ['view', 'create', 'edit', 'delete', 'export'],
            'users' => ['manage'],
            'student_manage' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'import', 'export'],
            'attendance_management' => ['view', 'export', 'analyze', 'import'],
            'departments' => ['manage'],
            'roles' => ['manage'],
            'courses' => ['manage'],
            'grades' => ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'export'],
            'remarks' => ['manage'],
            'statuses' => ['manage'],
            'campuses' => ['manage'],
            'enrollment_status' => ['manage'],
            'survey' => ['view', 'create', 'edit', 'delete', 'answer'],
            'survey_questions' => ['manage'],
            'survey_responses' => ['view', 'create', 'edit', 'delete', 'analyze'],
            'survey_submissions' => ['view', 'create', 'delete', 'analyze'],
            'reports' => ['view', 'analyze'],
            'retention_cases' => ['view', 'create', 'edit', 'delete', 'assign', 'analyze', 'intervene'],
            'home_visits' => ['view', 'edit', 'assign', 'analyze'],
            // Admin holds this in the database today, but the preset did not,
            // so a permission reset would silently lock admin out of the
            // assignment board and the fallback role list (coordinator/caller
            // only) would refuse the request.
            'assignments' => ['view', 'create', 'edit', 'delete', 'assign'],
            'academic_calendar' => ['view', 'edit'],
            'dropdown_lists' => ['view', 'create', 'edit', 'archive', 'restore'],
            'settings' => ['view', 'edit', 'manage'],
        ],
        'ssg' => [
            'overview' => ['view'],
            'student_manage' => ['view', 'create', 'edit', 'import', 'export'],
            'grades' => ['view', 'create', 'edit', 'archive', 'restore', 'export'],
            'survey' => ['view', 'create', 'edit', 'delete'],
            'survey_questions' => ['manage'],
            'survey_responses' => ['view', 'create', 'edit', 'analyze'],
            'survey_submissions' => ['view', 'delete', 'analyze'],
            'reports' => ['view', 'analyze'],
            'retention_cases' => ['view', 'edit', 'assign', 'analyze'],
            // SSG runs the term day to day, so they set the calendar as well as
            // read it — this is the role that knows P2 has started.
            'academic_calendar' => ['view', 'edit'],
        ],
        'secretary' => [
            'overview' => ['view'],
            'student_manage' => ['view', 'export'],
            'grades' => ['view', 'export'],
            'survey' => ['view', 'edit'],
            'survey_questions' => ['view'],
            'survey_responses' => ['view', 'analyze'],
            'survey_submissions' => ['view', 'analyze'],
            'reports' => ['view', 'analyze'],
            'retention_cases' => ['view'],
        ],
        'student' => [
            'overview' => ['view'],
            'survey' => ['view', 'answer'],
            'survey_questions' => ['view'],
            'survey_submissions' => ['view', 'create'],
        ],
        'finance' => [
            'overview' => ['view'],
            'finance_management' => ['view', 'edit', 'export'],
            'reports' => ['view', 'analyze'],
        ],
        'dean' => [
            'overview' => ['view'],
            'student_manage' => ['view', 'create', 'edit', 'delete', 'import', 'export'],
            'retention_cases' => ['view', 'edit', 'assign', 'analyze'],
            // The board of their own department's faculty: what each has
            // logged this periodical. Read-only, like the coordinator's --
            // periodical contacts are written in the Faculty Workspace, which
            // is where the term stamp and the intervention gates live.
            'team_monitor' => ['view', 'analyze'],
            'reports' => ['view', 'analyze'],
        ],
        // Spelled out rather than aliased to 'dean' above. This map is the
        // fallback for a role with no saved rows, and an admin who later
        // narrows the Program Head in Access Management must not have this
        // entry quietly widen the dean back out with it.
        'program-head' => [
            'overview' => ['view'],
            'student_manage' => ['view', 'create', 'edit', 'delete', 'import', 'export'],
            'retention_cases' => ['view', 'edit', 'assign', 'analyze'],
            // Same board as the dean, scoped to the department this account is
            // pinned to -- see the note on 'dean'. Spelled out here for the
            // reason given above: this map is a fallback, and narrowing one
            // role must not widen the other.
            'team_monitor' => ['view', 'analyze'],
            'reports' => ['view', 'analyze'],
        ],
        'ssp-coordinator' => [
            'overview' => ['view'],
            'assignments' => ['view', 'create', 'edit', 'delete', 'assign'],
            /*
             * The board of their own SSP Callers: how many students each has
             * reached and what came of it. The counterpart grant is on 'ksh-tl'
             * below - team_monitor.php works out which team from the role, so
             * the same grant means a different roster for each of them.
             */
            'team_monitor' => ['view', 'analyze'],
            'student_contacts' => ['view', 'create', 'edit', 'analyze'],
            /*
             * No retention_cases (Intervention) and no student_migration, by
             * Francis's call on 2026-09-30, and the same for 'ksh-tl' below: a
             * supervisor routes students to coaches and watches the team, and
             * those two screens are not part of that. Without retention_cases,
             * team_monitor shows as its own rail entry instead of a tab of
             * Intervention, and the Retention report leaves the Reports menu.
             */
            'reports' => ['view', 'analyze'],
        ],
        'ssp-caller' => [
            'overview' => ['view'],
            /*
             * Deliberately three modules and no more.
             *
             * A caller works one screen: the contact workspace lists who to ring
             * and records what happened. Enrollment status is NOT a separate
             * module for them - the status is set from inside the call log, by
             * student_contact_record_attempt(), so a second module granting the
             * same write would be two doors onto one action with only one of them
             * audited as a call. Retention cases and the assignment board belong
             * to the supervisor who monitors them.
             */
            'student_contacts' => ['view', 'create', 'edit', 'analyze'],
            'reports' => ['view', 'analyze'],
        ],
        'dept-caller' => [
            'overview' => ['view'],
            'student_contacts' => ['view', 'create', 'edit', 'analyze'],
            'reports' => ['view', 'analyze'],
        ],
        /*
         * Faculty work the intervention queue for the department they teach in.
         *
         * The module list is the caller's, for the reason given under
         * 'ssp-caller': the workspace is one screen that lists who to follow up
         * and records what came of it, and the enrollment status is set from
         * inside that log rather than through a second module. What differs is
         * only who appears in the queue, and that is a scope rather than a
         * permission — student_contact_visibility_clause() answers it from the
         * department on the user row.
         *
         * Deliberately NOT an alias of 'dept-caller', even though the two are
         * identical today. They answer to different people and will be narrowed
         * on different days; sharing one array would make narrowing either of
         * them silently narrow the other.
         */
        /*
         * No 'student_contacts'. Removed 2026-09-04, once faculty had a
         * workspace of their own.
         *
         * The Contact Workspace is the CALLER's screen, and the callers work a
         * different clock: they ring students at the end of a semester or before
         * the next one begins, around P3, about whether the student is coming
         * back. Faculty work inside the term -- P1 and P2, while there is still
         * something to do about it. Same students, opposite ends of the
         * timeline, and one screen was answering both questions with the
         * semester-level vocabulary the callers need.
         *
         * What they lose here they have in faculty_workspace, per periodical.
         * The scoping in student_contact_resolve_access() still answers for
         * faculty on purpose -- see the note there.
         */
        'faculty' => [
            'overview' => ['view'],
            'reports' => ['view', 'analyze'],
            /*
             * No Potential Drop Out board in the Faculty sidebar. Faculty
             * Workspace is their single queue: it already shows the risk signals
             * and stores the conversation, without opening the retention case
             * approval workflow to them.
             */
            /*
             * The three data modules read as one, per periodical.
             *
             * `view` and `create`, never `edit`: faculty read grades,
             * attendance and balance here but change none of them -- those
             * belong to the offices that own them -- and the one thing they
             * write is a record of a conversation they had.
             */
            'faculty_workspace' => ['view', 'create', 'analyze'],
        ],
        /*
         * The Kasama Hub pair mirrors the SSP pair, because that is what the rest
         * of the system already assumes: API_FOLLOW_UP_TEAMS pairs 'star' => [12, 7]
         * against 'nonstar' => [6, 5], api_student_type_for_role_id() routes Star
         * students to the KSH Coach exactly as it routes Nonstar to the SSP Caller,
         * and student_contact_resolve_access() already counts role 12 as a caller.
         *
         * Both presets said overview + reports and nothing else, so the entire Star
         * side of the workflow had a queue it could not open. The endpoints had
         * always admitted role 12; only the preset withheld the module, which is
         * why it presented as a missing screen rather than as a denial.
         *
         * KSH TL mirrors the SSP Coordinator, its opposite number on the board:
         * the same job over STAR students instead of Non-STAR. Both gave up
         * retention_cases and student_migration (the coordinator on 2026-09-30,
         * the TL on 2026-10-01).
         */
        'ksh-tl' => [
            'overview' => ['view'],
            'assignments' => ['view', 'create', 'edit', 'delete', 'assign'],
            // The board of their own KASAMA workers; see the note on
            // 'ssp-coordinator' above.
            'team_monitor' => ['view', 'analyze'],
            'student_contacts' => ['view', 'create', 'edit', 'analyze'],
            'enrollment_status' => ['view', 'edit'],
            'reports' => ['view', 'analyze'],
        ],
        'csdl' => [
            'overview' => ['view'],
            'home_visits' => ['view', 'edit', 'assign', 'analyze'],
            'reports' => ['view', 'analyze'],
        ],
        // KSH Coach mirrors the SSP Caller; see the note on 'ksh-tl' above.
        'ksh-coach' => [
            'overview' => ['view'],
            /*
             * Deliberately three modules and no more.
             *
             * A caller works one screen: the contact workspace lists who to ring
             * and records what happened. Enrollment status is NOT a separate
             * module for them - the status is set from inside the call log, by
             * student_contact_record_attempt(), so a second module granting the
             * same write would be two doors onto one action with only one of them
             * audited as a call. Retention cases and the assignment board belong
             * to the supervisor who monitors them.
             */
            'student_contacts' => ['view', 'create', 'edit', 'analyze'],
            'reports' => ['view', 'analyze'],
        ],
    ];
}

function api_permission_actions_without_manage(string $moduleKey): array
{
    $allowed = api_permission_module_action_map()[api_normalize_permission_module_key($moduleKey)] ?? [];
    return array_values(array_filter($allowed, static function (string $action): bool {
        return $action !== 'manage';
    }));
}

function api_normalize_permission_action_set(string $moduleKey, array $actions): array
{
    $orderedAllowed = api_permission_actions_without_manage($moduleKey);
    if (empty($orderedAllowed)) {
        return [];
    }

    $normalizedMap = api_normalize_permissions_map([
        $moduleKey => $actions,
    ]);
    $normalizedActions = $normalizedMap[$moduleKey] ?? [];
    if (empty($normalizedActions)) {
        return [];
    }

    return array_values(array_filter($orderedAllowed, static function (string $action) use ($normalizedActions): bool {
        return in_array($action, $normalizedActions, true);
    }));
}

function api_is_full_permission_action_set(string $moduleKey, array $actions): bool
{
    $orderedAllowed = api_permission_actions_without_manage($moduleKey);
    if (empty($orderedAllowed)) {
        return false;
    }

    $normalized = api_normalize_permission_action_set($moduleKey, $actions);
    if (count($normalized) !== count($orderedAllowed)) {
        return false;
    }

    return array_values($normalized) === array_values($orderedAllowed);
}

function api_build_permission_delta(array $basePermissions, array $effectivePermissions): array
{
    $normalizedBase = api_normalize_permissions_map($basePermissions);
    $normalizedEffective = api_normalize_permissions_map($effectivePermissions);
    $moduleMap = api_permission_module_action_map();
    $grants = [];
    $restrictions = [];

    foreach ($moduleMap as $moduleKey => $_allowedActions) {
        $baseSet = api_normalize_permission_action_set($moduleKey, $normalizedBase[$moduleKey] ?? []);
        $effectiveSet = api_normalize_permission_action_set($moduleKey, $normalizedEffective[$moduleKey] ?? []);

        $grantedActions = array_values(array_filter(
            api_permission_actions_without_manage($moduleKey),
            static function (string $action) use ($baseSet, $effectiveSet): bool {
                return in_array($action, $effectiveSet, true) && !in_array($action, $baseSet, true);
            }
        ));
        $restrictedActions = array_values(array_filter(
            api_permission_actions_without_manage($moduleKey),
            static function (string $action) use ($baseSet, $effectiveSet): bool {
                return in_array($action, $baseSet, true) && !in_array($action, $effectiveSet, true);
            }
        ));

        if (!empty($grantedActions)) {
            $grants[$moduleKey] = $grantedActions;
        }
        if (!empty($restrictedActions)) {
            $restrictions[$moduleKey] = $restrictedActions;
        }
    }

    return [
        'grants' => api_normalize_permissions_map($grants),
        'restrictions' => api_normalize_permissions_map($restrictions),
    ];
}

function api_apply_permission_delta(array $basePermissions, array $grants, array $restrictions): array
{
    $normalizedBase = api_normalize_permissions_map($basePermissions);
    $normalizedGrants = api_normalize_permissions_map($grants);
    $normalizedRestrictions = api_normalize_permissions_map($restrictions);
    $moduleMap = api_permission_module_action_map();
    $result = [];

    foreach ($moduleMap as $moduleKey => $allowedActions) {
        $baseSet = api_normalize_permission_action_set($moduleKey, $normalizedBase[$moduleKey] ?? []);
        $grantSet = api_normalize_permission_action_set($moduleKey, $normalizedGrants[$moduleKey] ?? []);
        $restrictionSet = api_normalize_permission_action_set($moduleKey, $normalizedRestrictions[$moduleKey] ?? []);

        $resultSet = $baseSet;
        foreach ($grantSet as $action) {
            if (!in_array($action, $resultSet, true)) {
                $resultSet[] = $action;
            }
        }
        $resultSet = array_values(array_filter($resultSet, static function (string $action) use ($restrictionSet): bool {
            return !in_array($action, $restrictionSet, true);
        }));

        if (empty($resultSet)) {
            continue;
        }

        $orderedResult = array_values(array_filter(
            api_permission_actions_without_manage($moduleKey),
            static function (string $action) use ($resultSet): bool {
                return in_array($action, $resultSet, true);
            }
        ));

        if (in_array('manage', $allowedActions, true) && api_is_full_permission_action_set($moduleKey, $orderedResult)) {
            $result[$moduleKey] = array_merge(['manage'], $orderedResult);
            continue;
        }

        $result[$moduleKey] = $orderedResult;
    }

    return api_normalize_permissions_map($result);
}

function api_get_default_role_permissions_map(PDO $pdo, int $roleId, ?string $roleName = null): array
{
    $presets = api_default_role_permission_presets();
    $normalizedRoleName = strtolower(trim((string)$roleName));

    /*
     * Secretary (role 9) now carries the SAME access as SSG. The two do the
     * same survey work; the only difference is that SSG is NOTIFIED when a
     * Secretary makes a change (see survey_question.php). Falling through to the
     * 'ssg' preset — role 9 maps to that slug — keeps the two identical from one
     * source, so widening SSG later widens Secretary with it. The reduced
     * 'secretary' preset is left in place for reference but no longer applied.
     */

    $presetKey = api_role_slug_from_id($roleId);
    if ($presetKey === '' && $normalizedRoleName !== '') {
        $presetKey = api_normalize_role_token($normalizedRoleName);
    }

    if ($presetKey === '' && $roleId > 0) {
        $stmt = $pdo->prepare('SELECT role_name FROM role WHERE role_id = :role_id LIMIT 1');
        $stmt->execute([':role_id' => $roleId]);
        $resolvedRoleName = strtolower(trim((string)$stmt->fetchColumn()));

        if ($roleId === 9 || $resolvedRoleName === 'secretary') {
            return api_permissions_without_manage_tokens($presets['secretary'] ?? []);
        }

        $presetKey = api_normalize_role_token($resolvedRoleName);
    }

    return api_permissions_without_manage_tokens($presets[$presetKey] ?? []);
}

function api_permissions_without_manage_tokens($value): array
{
    $normalized = api_normalize_permissions_map($value);

    foreach ($normalized as $moduleKey => $actions) {
        $filtered = array_values(array_filter($actions, static function (string $action): bool {
            return $action !== 'manage';
        }));

        if (empty($filtered)) {
            unset($normalized[$moduleKey]);
            continue;
        }

        $normalized[$moduleKey] = $filtered;
    }

    return $normalized;
}

function api_access_management_permission_actions(): array
{
    return ['view', 'create', 'edit', 'delete', 'archive', 'restore', 'export', 'import', 'answer', 'analyze', 'assign'];
}

function api_sanitize_access_management_permissions_map($value): array
{
    $normalized = api_normalize_permissions_map($value);
    $allowedAccessActions = api_access_management_permission_actions();
    $result = [];

    foreach ($normalized as $moduleKey => $actions) {
        $moduleAllowedActions = api_permission_actions_without_manage($moduleKey);
        $cleanActions = [];
        foreach ($allowedAccessActions as $action) {
            if (in_array($action, $moduleAllowedActions, true) && in_array($action, $actions, true)) {
                $cleanActions[] = $action;
            }
        }

        if (!empty($cleanActions)) {
            $result[$moduleKey] = $cleanActions;
        }
    }

    return api_normalize_permissions_map($result);
}

function api_permission_action_set_without_manage(string $moduleKey, array $actions): array
{
    $normalized = api_permissions_without_manage_tokens([
        $moduleKey => $actions,
    ]);

    return $normalized[$moduleKey] ?? [];
}

function api_rbac_module_key_map(): array
{
    return [
        'overview' => 'overview',
        'users' => 'user-management',
        'roles' => 'role-management',
        'departments' => 'department-management',
        'courses' => 'course-management',
        'campuses' => 'campus-management',
        'statuses' => 'status-management',
        'student_manage' => 'student-management',
        'attendance_management' => 'attendance-management',
        'enrollment_status' => 'enrollment-status-management',
        'grades' => 'grades-management',
        'remarks' => 'remarks-management',
        'survey' => 'survey-management',
        'survey_questions' => 'survey-question-management',
        'survey_responses' => 'survey-response-management',
        'survey_submissions' => 'survey-submission-management',
        'reports' => 'reports',
        'settings' => 'settings',
        'finance_management' => 'finance-management',
        'assignments' => 'ssp-assignments',
        'student_contacts' => 'student-contacts',
        'team_monitor' => 'team-monitor',
        'home_visits' => 'home-visits',
        'faculty_workspace' => 'faculty-workspace',
        'retention_cases' => 'retention-cases',
        'student_migration' => 'student-migration',
        'records_history' => 'records-history',
        'academic_calendar' => 'academic-calendar',
        'dropdown_lists' => 'dropdown-lists',
    ];
}

function api_rbac_action_keys_for_app_action(string $moduleKey, string $action): array
{
    $normalizedModuleKey = api_normalize_permission_module_key($moduleKey);
    $normalizedAction = api_normalize_permission_action($action);
    if ($normalizedModuleKey === '' || $normalizedAction === '') {
        return [];
    }

    $keys = [];
    switch ($normalizedAction) {
        case 'view':
            $keys = ['can_view', 'can_read'];
            break;
        case 'create':
            $keys = ['can_create'];
            break;
        case 'edit':
            $keys = ['can_edit', 'can_update'];
            if ($normalizedModuleKey === 'finance_management') {
                $keys[] = 'update-balance';
            }
            break;
        case 'delete':
            $keys = ['can_delete'];
            break;
        case 'archive':
            $keys = ['archive'];
            break;
        case 'restore':
            $keys = ['restore'];
            break;
        case 'import':
            $keys = ['import'];
            if ($normalizedModuleKey === 'student_manage') {
                $keys[] = 'import-students';
            }
            break;
        case 'export':
            $keys = ['export'];
            if ($normalizedModuleKey === 'reports') {
                $keys[] = 'export-reports';
            }
            break;
        case 'answer':
            $keys = ['answer'];
            break;
        case 'analyze':
            $keys = ['analyze'];
            break;
        case 'assign':
            $keys = ['assign'];
            if ($normalizedModuleKey === 'assignments') {
                $keys[] = 'assign-callers';
            }
            break;
        case 'manage':
            if ($normalizedModuleKey === 'users') {
                $keys = ['assign-roles'];
            } elseif ($normalizedModuleKey === 'roles') {
                $keys = ['manage-module-access', 'manage-function-permissions'];
            } elseif ($normalizedModuleKey === 'settings') {
                $keys = ['backup-database'];
            }
            break;
    }

    return array_values(array_unique($keys));
}

function api_rbac_non_storable_action_set(string $moduleKey, array $actions): array
{
    $normalized = api_permission_action_set_without_manage($moduleKey, $actions);

    return array_values(array_filter($normalized, static function (string $action) use ($moduleKey): bool {
        return empty(api_rbac_action_keys_for_app_action($moduleKey, $action));
    }));
}

function api_rbac_requested_action_key_set(string $moduleKey, array $actions): array
{
    $normalized = api_permission_action_set_without_manage($moduleKey, $actions);
    $requested = [];

    foreach ($normalized as $action) {
        foreach (api_rbac_action_keys_for_app_action($moduleKey, $action) as $actionKey) {
            $requested[$actionKey] = true;
        }
    }

    return array_keys($requested);
}

/**
 * Inverse of api_rbac_requested_action_key_set(): turn stored rbac action keys
 * back into the app-level action names the permission model uses.
 *
 * An app action maps to several action keys ('view' => can_view, can_read), so a
 * single stored key is enough to consider that app action present.
 *
 * @param array<string, string[]> $actionKeysByModule module key => action keys
 * @return array<string, string[]> module key => app actions
 */
function api_rbac_action_keys_to_permissions_map(array $actionKeysByModule): array
{
    $result = [];

    foreach ($actionKeysByModule as $moduleKey => $actionKeys) {
        $moduleKey = api_normalize_permission_module_key($moduleKey);
        if ($moduleKey === '') {
            continue;
        }

        $present = array_flip(array_map('strval', (array)$actionKeys));
        $actions = [];

        foreach (api_permission_actions_without_manage($moduleKey) as $action) {
            foreach (api_rbac_action_keys_for_app_action($moduleKey, $action) as $actionKey) {
                if (isset($present[$actionKey])) {
                    $actions[] = $action;
                    break;
                }
            }
        }

        if (!empty($actions)) {
            $result[$moduleKey] = $actions;
        }
    }

    return $result;
}

function api_rbac_db_permissions_to_app_actions(string $moduleKey, bool $canAccess, array $allowedActionKeys): array
{
    $allowedMap = [];
    foreach ($allowedActionKeys as $actionKey) {
        $normalizedActionKey = trim((string)$actionKey);
        if ($normalizedActionKey !== '') {
            $allowedMap[$normalizedActionKey] = true;
        }
    }

    $actions = [];
    if ($canAccess || !empty($allowedMap)) {
        $actions[] = 'view';
    }
    if (!empty($allowedMap['can_create'])) {
        $actions[] = 'create';
    }
    if (!empty($allowedMap['can_edit']) || !empty($allowedMap['can_update']) || !empty($allowedMap['update-balance'])) {
        $actions[] = 'edit';
    }
    if (!empty($allowedMap['can_delete'])) {
        $actions[] = 'delete';
    }
    if (!empty($allowedMap['archive'])) {
        $actions[] = 'archive';
    }
    if (!empty($allowedMap['restore'])) {
        $actions[] = 'restore';
    }
    if (!empty($allowedMap['import']) || ($moduleKey === 'student_manage' && !empty($allowedMap['import-students']))) {
        $actions[] = 'import';
    }
    if (!empty($allowedMap['export']) || ($moduleKey === 'reports' && !empty($allowedMap['export-reports']))) {
        $actions[] = 'export';
    }
    if (!empty($allowedMap['answer'])) {
        $actions[] = 'answer';
    }
    if (!empty($allowedMap['analyze'])) {
        $actions[] = 'analyze';
    }
    if (!empty($allowedMap['assign']) || ($moduleKey === 'assignments' && !empty($allowedMap['assign-callers']))) {
        $actions[] = 'assign';
    }

    return api_permission_action_set_without_manage($moduleKey, $actions);
}

function api_fetch_rbac_role_permissions_snapshot(PDO $pdo, int $roleId): array
{
    /*
     * Reads the JSON store instead of role_module_access /
     * role_module_action_permission.
     *
     * $pdo stays in the signature although nothing here uses it now. Every
     * caller already holds one and passes it, and the rest of this file's
     * permission helpers take a PDO; dropping the parameter would be a wide
     * diff whose only content is removing an argument.
     */
    return api_rbac_store_role_snapshot($roleId);
}

function api_merge_role_permissions_with_schema_defaults(array $defaultPermissions, array $rbacPermissions): array
{
    $basePermissions = api_permissions_without_manage_tokens($defaultPermissions);
    $rbacPermissions = api_permissions_without_manage_tokens($rbacPermissions);
    $result = [];
    $supportedModuleMap = api_rbac_module_key_map();

    foreach (api_permission_module_action_map() as $moduleKey => $_allowedActions) {
        if (isset($supportedModuleMap[$moduleKey])) {
            $rbacActionSet = api_permission_action_set_without_manage($moduleKey, $rbacPermissions[$moduleKey] ?? []);
            if (empty($rbacActionSet)) {
                $mergedActions = [];
            } else {
                $mergedActions = array_values(array_unique(array_merge(
                    api_rbac_non_storable_action_set($moduleKey, $basePermissions[$moduleKey] ?? []),
                    $rbacActionSet
                )));
            }
        } else {
            $mergedActions = api_permission_action_set_without_manage($moduleKey, $basePermissions[$moduleKey] ?? []);
        }

        if (!empty($mergedActions)) {
            $result[$moduleKey] = $mergedActions;
        }
    }

    return api_permissions_without_manage_tokens($result);
}

function api_normalize_permission_action($value): string
{
    $action = strtolower(trim((string)$value));
    if ($action === '') {
        return '';
    }

    $action = preg_replace('/[^a-z0-9_-]+/', '', $action);
    return $action ?? '';
}

function api_normalize_permissions_map($value): array
{
    if (!is_array($value)) {
        return [];
    }

    $allowedMap = api_permission_module_action_map();
    $normalized = [];

    foreach ($value as $moduleKey => $actions) {
        $key = api_normalize_permission_module_key($moduleKey);
        if ($key === '' || !isset($allowedMap[$key]) || !is_array($actions)) {
            continue;
        }

        $allowedActions = $allowedMap[$key];
        $seen = [];
        $list = [];

        foreach ($actions as $action) {
            $normalizedAction = api_normalize_permission_action($action);
            if ($normalizedAction === '' || !in_array($normalizedAction, $allowedActions, true) || isset($seen[$normalizedAction])) {
                continue;
            }
            $seen[$normalizedAction] = true;
            $list[] = $normalizedAction;
        }

        if (in_array('manage', $list, true)) {
            foreach ($allowedActions as $allowedAction) {
                if (!isset($seen[$allowedAction])) {
                    $seen[$allowedAction] = true;
                    $list[] = $allowedAction;
                }
            }
        }

        if (!empty($list)) {
            $normalized[$key] = $list;
        }
    }

    return $normalized;
}

function api_fetch_role_permissions_record(PDO $pdo, int $roleId): array
{
    if ($roleId <= 0) {
        return ['permissions' => [], 'has_saved_permissions' => false];
    }

    $stmt = $pdo->prepare('SELECT role_name FROM role WHERE role_id = :role_id LIMIT 1');
    $stmt->execute([':role_id' => $roleId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    if (!$row) {
        return ['permissions' => [], 'has_saved_permissions' => false];
    }

    $roleName = isset($row['role_name']) ? (string)$row['role_name'] : null;
    $defaultPermissions = api_get_default_role_permissions_map($pdo, $roleId, $roleName);
    $rbacRecord = api_fetch_rbac_role_permissions_snapshot($pdo, $roleId);

    return [
        'permissions' => empty($rbacRecord['has_saved_permissions']) ? $defaultPermissions : api_merge_role_permissions_with_schema_defaults(
            $defaultPermissions,
            $rbacRecord['permissions'] ?? []
        ),
        'has_saved_permissions' => !empty($rbacRecord['has_saved_permissions']),
    ];
}

function api_store_role_permissions_map(PDO $pdo, int $roleId, array $permissions): array
{
    if ($roleId <= 0) {
        return ['permissions' => [], 'has_saved_permissions' => false];
    }

    $normalized = api_permissions_without_manage_tokens($permissions);
    $currentRecord = api_fetch_role_permissions_record($pdo, $roleId);
    $currentPermissions = api_permissions_without_manage_tokens($currentRecord['permissions'] ?? []);

    /*
     * Some actions are decided by the code presets and cannot be varied per
     * role. That is a property of the permission MODEL, not of the old table
     * schema, so the guard stays: without it the panel would accept a change to
     * one of these, report success, and the merge below would keep answering
     * from the preset - a save that silently does nothing.
     *
     * A CALLER THAT CANNOT NAME AN ACTION IS NOT ASKING TO REMOVE IT.
     *
     * This compared the two sets for INEQUALITY, which made the guard fire on
     * every save of a role that holds such an action -- because the caller
     * cannot express one. api_sanitize_access_management_permissions_map()
     * strips non-storable actions out of the request before this is reached,
     * so the requested set is always empty while the current set is not, and
     * the two could never match.
     *
     * The effect was that Access Management could not save role 1 (Admin) or
     * role 15 (Faculty) at all -- the only two roles holding
     * retention_cases:intervene, and the two an administrator is most likely
     * to edit. Read the role, tick one box, press Save, and the panel reported
     * a bare "Server error" with nothing written. Verified end to end on
     * 2026-09-22 by putting each role's own unmodified map straight back.
     *
     * The guard itself is right and stays strict. What was missing is that a
     * caller who CANNOT NAME these actions is not asking to drop them, so they
     * are carried forward before the comparison rather than read as removed.
     *
     * Carrying forward is what actually protects the grant, and only for the
     * roles that need it. Role 1 holds retention_cases:intervene through its
     * CODE PRESET, so the merge below would restore it either way. Role 15
     * holds it only in the STORE -- 2026_08_22_faculty_role.sql wrote it there
     * and no preset mentions retention_cases for Faculty at all -- so nothing
     * downstream can put it back, and a save that dropped it would quietly
     * revoke the one grant the intervention workspace exists for.
     *
     * Only for a module the request still grants. Clearing a module outright is
     * a deliberate revocation and takes its preset-decided actions with it,
     * which is the same all-or-nothing rule the merge applies.
     */
    foreach ($normalized as $moduleKey => $requestedActions) {
        $requestedSet = api_permission_action_set_without_manage((string)$moduleKey, (array)$requestedActions);
        if (empty($requestedSet)) {
            continue;
        }
        $carryForward = api_rbac_non_storable_action_set(
            (string)$moduleKey,
            $currentPermissions[$moduleKey] ?? []
        );
        if (empty($carryForward)) {
            continue;
        }
        $normalized[$moduleKey] = array_values(array_unique(array_merge($requestedSet, $carryForward)));
    }

    $nonStorableChanges = [];
    foreach (api_permission_module_action_map() as $moduleKey => $_allowedActions) {
        $requestedNonStorable = api_rbac_non_storable_action_set($moduleKey, $normalized[$moduleKey] ?? []);
        $currentNonStorable = api_rbac_non_storable_action_set($moduleKey, $currentPermissions[$moduleKey] ?? []);

        if ($requestedNonStorable !== $currentNonStorable) {
            $nonStorableChanges[] = $moduleKey;
        }
    }

    if (!empty($nonStorableChanges)) {
        throw new InvalidArgumentException(
            'These modules take their permissions from the code presets and cannot be set per role: '
            . implode(', ', $nonStorableChanges)
            . '.'
        );
    }

    /*
     * Saved in the same shape the tables produced on read, module by module,
     * through the same two translations -- plus the preset-decided actions,
     * which have no action key to translate through and would otherwise be
     * lost between them. The merge DOES consult those: it reads the stored
     * action set whole, which is how Faculty resolves an `intervene` that no
     * code preset grants it.
     */
    $storable = [];
    foreach (api_rbac_module_key_map() as $moduleKey => $_dbModuleKey) {
        $requestedActionSet = api_permission_action_set_without_manage($moduleKey, $normalized[$moduleKey] ?? []);
        if (empty($requestedActionSet)) {
            continue;
        }

        $actions = api_rbac_db_permissions_to_app_actions(
            $moduleKey,
            true,
            api_rbac_requested_action_key_set($moduleKey, $requestedActionSet)
        );

        /*
         * Preset-decided actions survive the round trip.
         *
         * The two translations above go app action -> rbac action key -> app
         * action, and an action with no key vanishes in the middle. That is
         * correct for the storable ones and silently destructive for the
         * rest: `intervene` has no key, so saving a role through Access
         * Management dropped it from the file.
         *
         * It mattered for exactly one role. Role 1 gets `intervene` back from
         * its code preset on every read, so the loss was invisible there.
         * Role 15 (Faculty) does not -- no preset mentions retention_cases
         * for Faculty at all; its grant lives ONLY in the store, written by
         * 2026_08_22_faculty_role.sql. So one save of the Faculty role from
         * the panel would have revoked the intervention grant the whole
         * faculty workspace is built on, reporting success as it did so.
         *
         * Read from $normalized, which the carry-forward above has already
         * topped up from what the role holds today -- so a caller that could
         * not name the action keeps it, and a caller that could name one it
         * does not hold was refused before reaching here.
         */
        $presetDecided = api_rbac_non_storable_action_set($moduleKey, $requestedActionSet);
        if (!empty($presetDecided)) {
            $actions = array_values(array_unique(array_merge($actions, $presetDecided)));
        }

        if (!empty($actions)) {
            $storable[$moduleKey] = $actions;
        }
    }

    api_rbac_store_save_role($roleId, $storable);

    return api_fetch_role_permissions_record($pdo, $roleId);
}

function api_fetch_user_permissions_record(PDO $pdo, int $userId, array $basePermissions = []): array
{
    $empty = [
        'permissions' => [],
        'grants' => [],
        'restrictions' => [],
        'has_saved_permissions' => false,
        'storage_mode' => null,
    ];

    if ($userId <= 0) {
        return $empty;
    }

    // Stored as the delta itself now, so the fold from one row per action back
    // into module => [action] that this function used to do is gone.
    $delta = api_rbac_store_user_delta($userId);
    $grants = $delta['grants'];
    $restrictions = $delta['restrictions'];

    if (empty($grants) && empty($restrictions)) {
        return $empty;
    }

    return [
        'permissions' => api_apply_permission_delta($basePermissions, $grants, $restrictions),
        'grants' => $grants,
        'restrictions' => $restrictions,
        'has_saved_permissions' => true,
        'storage_mode' => 'delta',
    ];
}

function api_store_user_permissions_map(PDO $pdo, int $userId, array $permissions, array $basePermissions = []): array
{
    if ($userId <= 0) {
        return [
            'permissions' => [],
            'grants' => [],
            'restrictions' => [],
            'has_saved_permissions' => false,
            'storage_mode' => null,
        ];
    }

    $delta = api_build_permission_delta($basePermissions, api_normalize_permissions_map($permissions));

    /*
     * One write replaces the user's whole delta, so a save is never a partial
     * merge of an earlier one - the property the DELETE-then-INSERT transaction
     * used to provide. The file write is atomic (temp file plus rename), so no
     * transaction is needed to get it.
     */
    api_rbac_store_save_user_delta($userId, $delta['grants'] ?? [], $delta['restrictions'] ?? []);

    return api_fetch_user_permissions_record($pdo, $userId, $basePermissions);
}

function api_fetch_effective_permissions_record(PDO $pdo, int $roleId, int $userId = 0): array
{
    $savedRoleRecord = api_fetch_role_permissions_record($pdo, $roleId);
    $defaultRolePermissions = api_get_default_role_permissions_map($pdo, $roleId);
    $rolePermissions = !empty($savedRoleRecord['has_saved_permissions'])
        ? ($savedRoleRecord['permissions'] ?? [])
        : $defaultRolePermissions;
    $rolePermissions = api_normalize_permissions_map($rolePermissions);
    $userRecord = api_fetch_user_permissions_record($pdo, $userId, $rolePermissions);
    $isAdminRole = $roleId === 1;
    $useUserPermissions = !$isAdminRole && !empty($userRecord['has_saved_permissions']);
    $effectivePermissions = $useUserPermissions
        ? ($userRecord['permissions'] ?? [])
        : $rolePermissions;
    $userPermissions = $useUserPermissions
        ? api_normalize_permissions_map($userRecord['permissions'] ?? [])
        : [];

    return [
        'permissions' => api_normalize_permissions_map($effectivePermissions),
        'has_saved_permissions' => $useUserPermissions || !empty($savedRoleRecord['has_saved_permissions']),
        'has_saved_role_permissions' => !empty($savedRoleRecord['has_saved_permissions']),
        'has_saved_user_permissions' => $useUserPermissions,
        'role_permissions' => $rolePermissions,
        'user_permissions' => $userPermissions,
        'user_override_grants' => $useUserPermissions ? api_normalize_permissions_map($userRecord['grants'] ?? []) : [],
        'user_override_restrictions' => $useUserPermissions ? api_normalize_permissions_map($userRecord['restrictions'] ?? []) : [],
        'user_override_storage_mode' => $useUserPermissions ? ($userRecord['storage_mode'] ?? null) : null,
        'permission_source' => $useUserPermissions
            ? 'user'
            : (!empty($savedRoleRecord['has_saved_permissions']) ? 'role' : 'default'),
    ];
}

function api_summarize_permissions_map(array $permissions): array
{
    $normalized = api_normalize_permissions_map($permissions);
    $moduleMap = api_permission_module_action_map();
    $modules = [];
    $actionCount = 0;

    foreach ($normalized as $moduleKey => $actions) {
        $allowedActions = $moduleMap[$moduleKey] ?? [];
        $cleanActions = [];
        foreach ($actions as $action) {
            $normalizedAction = api_normalize_permission_action($action);
            if (
                $normalizedAction === ''
                || $normalizedAction === 'manage'
                || !in_array($normalizedAction, $allowedActions, true)
            ) {
                continue;
            }
            $cleanActions[] = $normalizedAction;
        }

        $cleanActions = array_values(array_unique($cleanActions));
        $actionCount += count($cleanActions);
        $modules[] = [
            'module_key' => $moduleKey,
            'actions' => array_values($actions),
            'granted_actions' => $cleanActions,
            'action_count' => count($cleanActions),
        ];
    }

    usort($modules, static function (array $left, array $right): int {
        return strcmp((string)($left['module_key'] ?? ''), (string)($right['module_key'] ?? ''));
    });

    return [
        'module_count' => count($normalized),
        'action_count' => $actionCount,
        'modules' => $modules,
    ];
}

function api_can(array $permissions, string $moduleKey, string $action): bool
{
    $normalizedPermissions = api_normalize_permissions_map($permissions);
    $normalizedModule = api_normalize_permission_module_key($moduleKey);
    $normalizedAction = api_normalize_permission_action($action);

    if ($normalizedModule === '' || $normalizedAction === '') {
        return false;
    }

    $actions = $normalizedPermissions[$normalizedModule] ?? [];
    if (in_array('manage', $actions, true)) {
        return true;
    }

    if ($normalizedAction === 'view') {
        return in_array('view', $actions, true);
    }

    return in_array($normalizedAction, $actions, true);
}

function api_permission_denied_message(array $targets): string
{
    $normalizedTargets = api_normalize_permission_targets($targets);
    if (empty($normalizedTargets)) {
        return 'Forbidden';
    }

    $actions = array_values(array_unique(array_map(static function (array $target): string {
        return $target['action'] ?? '';
    }, $normalizedTargets)));

    if (count($actions) === 1 && $actions[0] === 'view') {
        return 'You do not have permission to view this page.';
    }

    return 'No permission for this action.';
}

function api_can_any(array $permissions, array $targets): bool
{
    foreach (api_normalize_permission_targets($targets) as $target) {
        if (api_can($permissions, $target['module'], $target['action'])) {
            return true;
        }
    }

    return false;
}

function api_method_to_permission_action(string $method): string
{
    $verb = strtoupper(trim($method));

    if ($verb === 'GET') return 'view';
    if ($verb === 'POST') return 'create';
    if ($verb === 'PUT' || $verb === 'PATCH') return 'edit';
    if ($verb === 'DELETE') return 'delete';

    return '';
}

/**
 * Per-request store for the bearer-resolved user.
 *
 * api_get_session_user() is called up to four times on some endpoints and the
 * token path costs a user-context query plus a permission resolve, so the
 * answer is kept for the life of the request. Only successful resolutions are
 * cached; a failed decode is cheap to repeat and never reaches the database.
 *
 * Cleared by api_store_authenticated_user() — see the note there.
 */
function api_bearer_user_cache(?array $store = null, bool $reset = false): ?array
{
    static $cached = null;

    if ($reset) {
        $cached = null;
        return null;
    }
    if ($store !== null) {
        $cached = $store;
    }

    return $cached;
}

/**
 * Resolve the caller from an Authorization: Bearer token, or null.
 *
 * Everything security-relevant is read from the database, not from the token.
 * The token says only *who* the caller claims to be and at which token
 * version; role, department, student-type scope and the permission maps all
 * come from the user row on every request.
 *
 * That is deliberate and it is the reason the claims are thin. Dean department
 * pinning and Star/Nonstar scoping are enforced from these fields, so carrying
 * them in a 15-minute token would leave a demoted dean reading another
 * department for up to fifteen minutes. api_require_auth() already queries the
 * database on every request, so this costs one more indexed lookup and buys
 * immediate effect for role changes, deactivation and token revocation.
 */
function api_resolve_bearer_user(): ?array
{
    $cached = api_bearer_user_cache();
    if ($cached !== null) {
        return $cached;
    }

    // jwt.php is only loaded where the token layer is wired up; on an endpoint
    // that never pulls it in there is simply no bearer path.
    if (!function_exists('api_bearer_token') || !function_exists('api_jwt_decode_access_token')) {
        return null;
    }

    $token = api_bearer_token();
    if ($token === null) {
        return null;
    }

    $claims = api_jwt_decode_access_token($token);
    if ($claims === null) {
        return null;
    }

    $pdo = api_permission_db_connect();
    if (!($pdo instanceof PDO)) {
        return null;
    }

    $userRow = api_fetch_user_context($pdo, (int)$claims['user_id'], false);
    if (!$userRow || !api_user_is_active($userRow)) {
        return null;
    }

    // The revocation check. Bumping user.token_version invalidates every
    // outstanding access token for that user at once, without waiting for the
    // 15-minute expiry.
    if ((int)($userRow['token_version'] ?? 0) !== (int)$claims['token_version']) {
        return null;
    }

    $user = api_build_authenticated_user_payload($userRow);
    api_bearer_user_cache($user);

    return $user;
}

/**
 * The authenticated caller, resolved from the Authorization bearer token.
 *
 * The name is now a small lie — it has not read $_SESSION since the cutover —
 * and it is kept anyway. Renaming it would touch 44 call sites across 38
 * endpoints for no behavioural gain, and this file is the one place where the
 * meaning of "who is calling" is defined; better one honest comment here than a
 * 44-file diff whose only content is a word.
 *
 * $_SESSION is not consulted, and this function no longer starts a session.
 * Sessions still exist for the anonymous multi-step flows — password reset,
 * change-password OTP, profile CAPTCHA — which start one themselves and keep
 * only their own scratch state in it. Nothing about identity lives there now.
 *
 * Two things got better in the move rather than merely different:
 *
 *   Freshness. The session carried a `permissions` map written once at login and
 *   never refreshed, so a request reading it saw a snapshot that could be hours
 *   stale — student_migration.php authorizes off exactly that. Every caller now
 *   gets a map rebuilt from the database on the request that uses it.
 *
 *   Revocation. Deactivating an account or bumping token_version is checked on
 *   every request in api_resolve_bearer_user(), so it takes effect at once. A
 *   session stayed valid until it happened to be re-read.
 */
function api_get_session_user(): ?array
{
    return api_resolve_bearer_user();
}

function api_session_user_has_role(?array $user, array $allowedRoles): bool
{
    if (!$user || empty($allowedRoles)) {
        return false;
    }

    $roleId = isset($user['role_id']) ? (int)$user['role_id'] : 0;
    $roleTokens = array_values(array_unique(array_filter([
        api_normalize_role_token($user['role'] ?? ''),
        api_normalize_role_token($user['role_name'] ?? ''),
        api_role_slug_from_id($roleId),
    ])));

    foreach ($allowedRoles as $allowedRole) {
        if (is_int($allowedRole) || ctype_digit((string)$allowedRole)) {
            if ($roleId === (int)$allowedRole) {
                return true;
            }
            continue;
        }

        $allowedToken = api_normalize_role_token($allowedRole);
        if ($allowedToken !== '' && in_array($allowedToken, $roleTokens, true)) {
            return true;
        }
    }

    return false;
}

/**
 * Which student type a role is allowed to work with.
 *
 * The SSP team (6 SSP Caller, 5 SSP Coordinator) handles Non-STAR students; the
 * KASAMA team (12 KASAMA, 7 KSH TL) handles STAR students. Any other role
 * returns null, meaning "no restriction".
 *
 * The two supervisors joined on 2026-09-24, at the user's request: each one is
 * to see only its own cohort. Until then they were unscoped so that either could
 * run the assignment board for both teams. That is no longer how the office
 * works - the coordinator assigns Non-STAR, the TL assigns STAR - and Admin is
 * still unscoped, so there remains one account that can see both.
 *
 * This is the single source of truth for that split. api_student_type_scope_for_user()
 * enforces it on reads, and ssp_assignment.php uses it to label callers so the
 * assignment dropdown can only offer someone who will actually be able to open
 * the student. Keep them driven from here — a second copy of the mapping is how
 * the two silently drift apart.
 *
 * The strings are the values stored in student.student_type, which changed on
 * 2026-08-21 from 'Star'/'Nonstar' to the sheet's capitalised spellings. These
 * are compared in a WHERE clause against that column, so they are not labels
 * that can drift from it: with the old strings still here, every SSP Caller and
 * KASAMA saw an empty board.
 *
 * NOTE — the direction below is the direction the system has always run, and it
 * is the opposite of the PDO routing requested on 2026-08-21 (SSP Caller = STAR,
 * KASAMA = Non-STAR). It is left as-is deliberately: flipping it reassigns the
 * follow-up team of every student already on the board, which is a decision to
 * take on purpose rather than as a side effect of a vocabulary migration.
 */
function api_student_type_for_role_id(int $roleId): ?string
{
    // SSP Caller, SSP Coordinator
    if ($roleId === 6 || $roleId === 5) {
        return 'Non-STAR';
    }

    // KASAMA, KSH TL
    if ($roleId === 12 || $roleId === 7) {
        return 'STAR';
    }

    return null;
}

function api_student_type_scope_for_user(?array $user): ?string
{
    return api_student_type_for_role_id(isset($user['role_id']) ? (int)$user['role_id'] : 0);
}

/**
 * The follow-up team for each student type, worker first.
 *
 * A Non-STAR student is worked by an SSP Caller together with the SSP
 * Coordinator; a STAR student by KASAMA together with the KSH TL.
 * Both members are assigned, so the supervisor carries the student rather than
 * only supervising whoever does.
 *
 * Kept separate from api_student_type_for_role_id() above even though, since
 * 2026-09-24, the two agree for every role. That function answers "which
 * students may this role open at all" and is enforced as a WHERE clause on
 * reads; this one answers "whose team is this student on" and drives
 * assignment. They agree because each supervisor now sees only the cohort it
 * supervises - change one and check the other.
 *
 * Worker first because that ordering is what makes a team "complete": the
 * worker is the one who has to exist for the student to be worked at all.
 */
const API_FOLLOW_UP_TEAMS = [
    'non-star' => [6, 5], // SSP Caller, SSP Coordinator
    'star' => [12, 7],    // KASAMA, KSH TL
    // Spellings stored before 2026-08-21, kept so a row that somehow still
    // holds one resolves to a team instead of to nobody.
    'nonstar' => [6, 5],
    'star e-profile' => [12, 7],
];

/** Role ids that make up the follow-up team for a student type, or [] if unknown. */
function api_follow_up_team_role_ids(?string $studentType): array
{
    $key = strtolower(trim((string)$studentType));
    return API_FOLLOW_UP_TEAMS[$key] ?? [];
}

/**
 * Which student type a role is assigned work for, by team membership.
 *
 * Unlike api_student_type_for_role_id() this covers the supervisors too, so it
 * is what the assignment board should label and validate against. A role in no
 * team returns null, meaning "not assignable".
 */
function api_follow_up_team_type_for_role_id(int $roleId): ?string
{
    foreach (API_FOLLOW_UP_TEAMS as $type => $roleIds) {
        if (in_array($roleId, $roleIds, true)) {
            return ucfirst($type);
        }
    }

    return null;
}

/**
 * Roles that answer for one department and may only ever see that department.
 *
 * The single source of truth for department pinning. Ten endpoints enforce this
 * rule — student.php, grades.php, overview_analytics.php, retention_case.php,
 * retention_matrix.php, finance-summary.php, attendance-summary.php,
 * survey-summary.php, student_migration.php and the notification recipient
 * resolver — and every one of them asked `has_role($user, ['dean'])` directly
 * until Program Head arrived.
 *
 * That is exactly the shape of bug this constant exists to prevent: adding a
 * second department role means adding it in ten places, and the site that gets
 * missed does not fail loudly. It silently returns another department's
 * students, which is the one outcome this rule exists to stop.
 *
 * Faculty joined on 2026-08-22 and is the proof that it works: adding the slug
 * here pinned all ten at once. Note it is the only entry whose main screen is
 * the contact workspace, which does its own scoping in
 * student_contact_visibility_clause() rather than through this constant — so
 * faculty are pinned in two separate places, and both are needed. Removing the
 * slug here would leave the workspace correctly scoped while every other
 * endpoint answered for the whole institution.
 */
const API_DEPARTMENT_PINNED_ROLES = ['dean', 'program-head', 'faculty'];

/**
 * Is this caller confined to their own department?
 *
 * Admin and SSG are institution-wide and are excluded here rather than at each
 * call site, so a new pinned role cannot accidentally be written in a way that
 * also pins the admin.
 *
 * Note this answers "should a department clause be applied", not "which
 * department" — the id comes from the user row, never from the request.
 */
function api_user_is_department_pinned(?array $user): bool
{
    if (!$user) {
        return false;
    }

    if (api_session_user_has_role($user, ['admin', 'ssg'])) {
        return false;
    }

    return api_session_user_has_role($user, API_DEPARTMENT_PINNED_ROLES);
}

/**
 * SQL that widens a single department id to the same department on every campus.
 *
 * A department used to be one row, so scoping was `department_id = :x`. The
 * same college now runs on more than one campus — CITE Carmen and CITE Puerto
 * are two rows sharing a code — and a dean is appointed to the *department*,
 * not to the campus that happens to host their row. Scoping to the single row
 * would show them half their own students.
 *
 * Written as a subquery rather than an expanded `IN (1, 7, 9)` list so the
 * caller keeps binding exactly one parameter. Every call site was already
 * passing `:department_id`; swapping the fragment changes no binding code,
 * which is what makes this safe to apply across nine endpoints.
 *
 * Fails closed: an id that resolves to no row leaves the inner select NULL,
 * `department_code = NULL` matches nothing, and the scope returns no rows.
 *
 * Caveat worth knowing: departments are matched by code alone, because nothing
 * in the schema groups campuses into institutions. If a campus belonging to a
 * different college ever uses a code COC also uses, the two would be treated as
 * one department. Adding an institution column to `campus` is the fix if that
 * day comes.
 */
function api_department_scope_sql(string $column, string $param = ':department_id'): string
{
    return "$column IN (
                SELECT dept_sibling.department_id
                  FROM department dept_sibling
                 WHERE dept_sibling.department_code = (
                       SELECT dept_self.department_code
                         FROM department dept_self
                        WHERE dept_self.department_id = $param
                 )
            )";
}

/**
 * Every department id sharing a code with this one - the same college on
 * each of its campuses, including the one asked about.
 *
 * The PHP-side counterpart to api_department_scope_sql(), for the checks that
 * compare a value already in hand instead of building a query. Both answer the
 * same question, and a comparison that uses only one of them is how a dean ends
 * up able to LIST a case and forbidden to OPEN it.
 *
 * Fails closed: an id matching no department row returns the id itself, so the
 * comparison stays as narrow as it was rather than widening to everything.
 */
/**
 * The department clause for a scope that may or may not be the caller's own.
 *
 * Every screen that scopes by department resolves one of two different things
 * into the same variable: the department this account is pinned to, or the one
 * it picked from a chooser. They need different SQL. The first is a security
 * scope and must cover every campus of that department; the second is a filter
 * and must mean exactly what was picked.
 *
 * Binds the same single :department_id either way, so a call site swaps the
 * fragment without touching how it binds.
 */
function api_department_filter_sql(string $column, bool $isOwnScope, string $param = ':department_id'): string
{
    return $isOwnScope
        ? api_department_scope_sql($column, $param)
        : "$column = $param";
}

function api_department_sibling_ids(PDO $pdo, int $departmentId): array
{
    static $cache = [];

    if ($departmentId <= 0) {
        return [];
    }
    if (isset($cache[$departmentId])) {
        return $cache[$departmentId];
    }

    $stmt = $pdo->prepare(
        'SELECT sibling.department_id
           FROM department sibling
          WHERE sibling.department_code = (
                SELECT self.department_code FROM department self WHERE self.department_id = :department_id
          )'
    );
    $stmt->execute([':department_id' => $departmentId]);
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));

    $cache[$departmentId] = $ids ?: [$departmentId];

    return $cache[$departmentId];
}

function api_department_matches(PDO $pdo, int $userDepartmentId, int $rowDepartmentId): bool
{
    if ($userDepartmentId <= 0 || $rowDepartmentId <= 0) {
        return false;
    }

    return in_array($rowDepartmentId, api_department_sibling_ids($pdo, $userDepartmentId), true);
}

function api_student_type_access_denied_message(): string
{
    return 'Access Denied';
}

function api_student_type_is_allowed(?array $user, $studentType): bool
{
    $scope = api_student_type_scope_for_user($user);
    if ($scope === null) {
        return true;
    }

    return strcasecmp(trim((string)$studentType), $scope) === 0;
}

function api_apply_student_type_scope(array &$whereParts, array &$params, ?array $user, string $column = '`star e-profile`', string $paramName = ':student_type_scope'): void
{
    $scope = api_student_type_scope_for_user($user);
    if ($scope === null) {
        return;
    }

    $whereParts[] = $column . ' = ' . $paramName;
    $params[$paramName] = $scope;
}

function api_fetch_student_access_row(PDO $pdo, int $studentId): ?array
{
    if ($studentId <= 0) {
        return null;
    }

    $stmt = $pdo->prepare('SELECT student_id, `star e-profile` AS student_type FROM student WHERE student_id = :student_id LIMIT 1');
    $stmt->execute([':student_id' => $studentId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

/**
 * Stop a deactivated account on its next request, not on its next page load.
 *
 * api_user_is_active() was consulted in exactly two places: login.php, and
 * api_refresh_authenticated_user() — which is only ever reached from me.php and
 * profile.php. Every other endpoint took the session at its word. So revoking
 * someone left them holding full API access across all of the protected
 * endpoints until their browser happened to load one of those two pages, and a
 * stolen session never loads either. Expelled students, departed staff and
 * demoted deans all kept working.
 *
 * Deliberately its own narrow query rather than api_refresh_authenticated_user(),
 * which rebuilds the whole session payload — this runs on every authenticated
 * request and must stay to one indexed lookup, on a connection
 * api_permission_db_connect() already holds open for the permission read below.
 */
function api_assert_account_active(array $user): void
{
    $userId = isset($user['user_id']) ? (int)$user['user_id'] : 0;
    if ($userId <= 0) {
        return;
    }

    $pdo = api_permission_db_connect();
    if (!($pdo instanceof PDO)) {
        // No database means the endpoint behind this guard cannot serve
        // anything either. Refusing here would convert an outage into a wave of
        // spurious logouts, which is strictly worse than deferring the check.
        return;
    }

    try {
        $stmt = $pdo->prepare('SELECT status FROM user WHERE user_id = :user_id LIMIT 1');
        $stmt->execute([':user_id' => $userId]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (Throwable $e) {
        return;
    }

    if (is_array($row) && api_user_is_active($row)) {
        return;
    }

    // Deactivated, or the row is gone entirely. Drop the session so the next
    // request arrives anonymous instead of repeating this lookup forever.
    api_destroy_session();
    api_json_response(401, [
        'message' => 'This account is no longer active.',
        'code' => 'ACCOUNT_INACTIVE',
    ]);
}

function api_require_auth(array $allowedRoles = []): array
{
    $user = api_get_session_user();
    if (!$user) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    // Before the password check below: someone who has been deactivated should
    // be turned away, not invited to change their password.
    api_assert_account_active($user);

    if (function_exists('api_password_expiration_should_block_request') && api_password_expiration_should_block_request($user)) {
        api_json_response(403, [
            'message' => 'Password expired. Change your password to continue.',
            'code' => 'PASSWORD_EXPIRED',
            'force_password_change' => true,
        ]);
    }

    $permissionTargets = api_get_endpoint_permission_targets();
    $roleId = isset($user['role_id']) ? (int)$user['role_id'] : 0;
    $userId = isset($user['user_id']) ? (int)$user['user_id'] : 0;

    if (!empty($permissionTargets) && ($roleId > 0 || $userId > 0)) {
        $pdo = api_permission_db_connect();
        if ($pdo instanceof PDO) {
            $permissionRecord = api_fetch_effective_permissions_record($pdo, $roleId, $userId);
            $effectivePermissions = api_normalize_permissions_map($permissionRecord['permissions'] ?? []);
            $permissionsConfigured = !empty($permissionRecord['has_saved_permissions']);
            if (!empty($effectivePermissions) || $permissionsConfigured) {
                $permissionAllowed = !empty($effectivePermissions) && api_can_any($effectivePermissions, $permissionTargets);
                $endpoint = basename($_SERVER['SCRIPT_FILENAME'] ?? '');
                $method = strtoupper($_SERVER['REQUEST_METHOD'] ?? 'GET');
                /*
                 * Answering a survey is not a module a student is granted; it
                 * is something every student does. These endpoints carry their
                 * own per-student scoping, so the bypass lets the student reach
                 * them without handing them the survey module itself.
                 *
                 * survey_response.php is read-only here on purpose. A student
                 * needs it to reread their own submitted answers — the endpoint
                 * overwrites the requested student_id with the session's own on
                 * GET, so a submission belonging to anyone else matches no rows.
                 * Writing individual answers is a different act with a wider
                 * surface, and nothing in the student flow does it: submissions
                 * arrive whole, through survey_submission.php.
                 */
                $studentSurveyWrite = ['survey.php', 'survey_question.php', 'survey_question_option.php', 'survey_submission.php'];
                /*
                 * ph_address.php joins the read bypass because the student is
                 * the one who needs it: an address question renders a picker,
                 * and the picker is three GETs for lists of province, city and
                 * barangay names. Without this the field would fall back to a
                 * text box for exactly the person it was built for, and only
                 * staff would ever see the dropdowns.
                 *
                 * It reads no student data - the whole table is published
                 * government place names - so admitting it widens nothing.
                 */
                $studentSurveyRead = ['survey_response.php', 'ph_address.php'];
                $studentSurveyBypass =
                    api_session_user_has_role($user, ['student'])
                    && (
                        (in_array($endpoint, $studentSurveyWrite, true) && in_array($method, ['GET', 'POST'], true))
                        || (in_array($endpoint, $studentSurveyRead, true) && $method === 'GET')
                    );

                if (!$permissionAllowed && !$studentSurveyBypass) {
                    api_json_response(403, ['message' => api_permission_denied_message($permissionTargets)]);
                }

                $user['permissions'] = $effectivePermissions;
                $user['module_permissions'] = $effectivePermissions;
                $user['permissions_configured'] = $permissionsConfigured;
                $user['role_permissions'] = $permissionRecord['role_permissions'];
                $user['user_permissions'] = $permissionRecord['user_permissions'];
                $user['role_permissions_configured'] = !empty($permissionRecord['has_saved_role_permissions']);
                $user['user_permissions_configured'] = !empty($permissionRecord['has_saved_user_permissions']);
                $user['permission_source'] = $permissionRecord['permission_source'] ?? 'default';
                return $user;
            }
        }
    }

    if (!empty($allowedRoles) && !api_session_user_has_role($user, $allowedRoles)) {
        api_json_response(403, ['message' => 'Forbidden']);
    }

    return $user;
}

function api_is_public_endpoint(string $endpoint): bool
{
    // refresh.php has to be here: it is called precisely when the access token
    // has expired, so requiring one would make it unreachable. Its credential
    // is the httpOnly refresh cookie, which it checks itself.
    //
    // endpointGuard.test.js caps this list at 6 entries, and this is the sixth.
    // Anything further should replace an entry rather than raise the cap.
    return in_array($endpoint, ['login.php', 'send-reset-code.php', 'verify-reset-code.php', 'reset-password.php', 'me.php', 'refresh.php'], true);
}

function api_endpoint_policy_map(): array
{
    /*
     * `finance` and `dept-caller` used to appear throughout these lists. Both
     * roles were deleted by the 2026-08-12 migrations, so no account can hold
     * either one and the entries authorized nobody.
     *
     * They are removed rather than left harmlessly in place because this map is
     * the document someone reads to answer "who can see student balances". A
     * name in it reads as an answer, and a name that cannot exist is a wrong
     * one. The finance *module* is unaffected — finance_management is still
     * granted to Admin and SSG through the RBAC tables, which is what actually
     * gates those endpoints.
     */
    $surveyManagers = ['admin', 'ssg'];
    $surveyResponseManagers = ['admin', 'ssg'];
    $surveySubmissionReaders = ['admin', 'student', 'ssg'];
    $studentReadRoles = ['admin', 'dean', 'program-head', 'student', 'ssg', 'ssp-caller', 12];
    $semesterReadRoles = ['admin', 'ssg'];
    $statusReadRoles = ['admin', 'ssg'];
    $reportReadRoles = ['admin', 'ssg', 'dean', 'program-head', 'faculty', 'ssp-coordinator', 'ssp-caller', 'ksh-tl', 'csdl', 'ksh-coach', 12];

    return [
        'me.php' => [
            'GET' => [],
        ],
        'logout.php' => [
            'POST' => [],
        ],
        // Any signed-in account: the choices a form offers, not records.
        'dropdown_options.php' => [
            'GET' => [],
        ],
        'dropdown_list.php' => [
            'GET' => ['admin'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
        ],
        'notifications.php' => [
            'GET' => [],
            'PUT' => [],
            'DELETE' => [],
        ],
        // Any signed-in role may probe; changes.php filters topics per module itself.
        'changes.php' => [
            'GET' => [],
        ],
        'security_policy.php' => [
            'GET' => ['admin'],
            'PUT' => ['admin'],
        ],
        // Stated rather than left to the empty-list default, which would admit
        // any authenticated role that has no saved permissions.
        'audit_log.php' => [
            'GET' => ['admin'],
        ],
        'password_expiration.php' => [
            'GET' => [],
            'PUT' => ['admin'],
        ],
        'change-password.php' => [
            'GET' => [],
            'POST' => [],
        ],
        'user.php' => [
            'GET' => [],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'PATCH' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'user-summary.php' => [
            'GET' => array_values(array_unique(array_merge($reportReadRoles, ['student']))),
        ],
        // Fallback for roles with no saved permissions. The endpoint scopes the
        // data itself — a dean reaching it still sees only their own department.
        'overview_analytics.php' => [
            'GET' => ['admin', 'ssg', 'dean', 'program-head'],
        ],
        'attendance-summary.php' => [
            'GET' => ['admin'],
        ],
        // Fallback for roles with no saved permissions only; configured roles are
        // gated on attendance_management:import by the override in
        // api_endpoint_permission_target_overrides(). Same shape, and now the same
        // list, as grades-import.php below.
        'attendance-import.php' => [
            'POST' => ['admin', 'ssg'],
        ],
        // Same shape as attendance-import: this list only applies to roles with
        // no saved permissions. Configured roles are gated by grades:create via
        // api_endpoint_module_map().
        'grades-import.php' => [
            'POST' => ['admin', 'ssg'],
        ],
        // Same shape again: this fallback list only applies to roles with no
        // saved permissions. Configured roles are gated by
        // finance_management:create via api_endpoint_module_map(), which is now
        // the only route in — the `finance` role that used to be listed here was
        // deleted in August 2026.
        'finance-import.php' => [
            'POST' => ['admin'],
        ],
        'survey-summary.php' => [
            'GET' => $reportReadRoles,
        ],
        'student-import.php' => [
            'POST' => ['admin', 'dean', 'program-head', 'ssg'],
        ],
        'student_history.php' => [
            'GET' => $studentReadRoles,
        ],
        'student.php' => [
            'GET' => $studentReadRoles,
            'POST' => ['admin', 'dean', 'program-head', 'ssg'],
            'PUT' => ['admin', 'dean', 'program-head', 'ssg'],
            'DELETE' => ['admin', 'dean', 'program-head'],
        ],
        'survey.php' => [
            'GET' => [],
            'POST' => $surveyManagers,
            'PUT' => $surveyManagers,
            'DELETE' => $surveyManagers,
        ],
        'survey_question.php' => [
            'GET' => [],
            'POST' => $surveyManagers,
            'PUT' => $surveyManagers,
            'DELETE' => $surveyManagers,
        ],
        'survey_question_option.php' => [
            'GET' => [],
            'POST' => $surveyManagers,
            'PUT' => $surveyManagers,
            'DELETE' => $surveyManagers,
        ],
        'survey_response.php' => [
            // Students included so they can review what they answered; the
            // endpoint scopes a student to their own submissions, so the wider
            // role list does not widen what any one of them can read.
            'GET' => array_merge($surveyResponseManagers, ['student']),
            'POST' => ['student', 'ssg'],
            'PUT' => $surveyResponseManagers,
            'DELETE' => ['admin'],
        ],
        'survey_submission.php' => [
            'GET' => $surveySubmissionReaders,
            'POST' => ['admin', 'student'],
            'PUT' => ['admin'],
            'DELETE' => ['admin', 'ssg'],
        ],
        // NOTE: a second 'retention_case.php' key used to sit here holding
        // permission-target arrays. This map stores ROLE lists, and the key is
        // declared again further down, so PHP kept the later one and this entry
        // never applied. Removed rather than left as a trap — retention_case.php
        // does its own module check in require_case_access() anyway.
        'finance.php' => [
            'GET' => ['admin'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        // Stated rather than left to the empty-list default, which would admit
        // any authenticated role that has no saved permissions. Dean is here
        // because the endpoint pins them to their own department; admin reads
        // across all of them. Anyone else needs finance_management:view, which
        // is how SSG reaches it.
        'finance-summary.php' => [
            'GET' => ['admin', 'dean', 'program-head'],
        ],
        'grades.php' => [
            'GET' => ['admin', 'ssg'],
            'POST' => ['admin', 'ssg'],
            'PUT' => ['admin', 'ssg'],
            'DELETE' => ['admin'],
        ],
        'remarks.php' => [
            'GET' => ['admin'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'enrollment_status.php' => [
            'GET' => ['admin'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'backup.php' => [
            'GET' => ['admin'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
        ],
        'roles.php' => [
            'GET' => ['admin'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'role_permissions.php' => [
            'GET' => ['admin'],
            'PUT' => ['admin'],
        ],
        'user_permissions.php' => [
            'GET' => ['admin'],
            'PUT' => ['admin'],
        ],
        'campus.php' => [
            'GET' => ['admin'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'department.php' => [
            'GET' => ['admin', 'dean', 'program-head'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'course.php' => [
            'GET' => ['admin', 'dean', 'program-head', 'ssg'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'school_year.php' => [
            'GET' => ['admin', 'dean', 'program-head', 'ssg'],
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'semester.php' => [
            'GET' => $semesterReadRoles,
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'status.php' => [
            'GET' => $statusReadRoles,
            'POST' => ['admin'],
            'PUT' => ['admin'],
            'DELETE' => ['admin'],
        ],
        'ssp_assignment.php' => [
            'GET' => ['ssp-coordinator', 'ksh-tl', 'ssp-caller', 12],
            'POST' => ['ssp-coordinator', 'ksh-tl'],
            'PUT' => ['ssp-coordinator', 'ksh-tl'],
            'DELETE' => ['ssp-coordinator', 'ksh-tl'],
        ],
        /*
         * `faculty` came off this list 2026-09-04 with the preset grant.
         *
         * It has to be removed in BOTH places or it is not removed. This map is
         * the fallback for a caller whose effective permissions resolve to
         * nothing at all -- a brand new role, a user mid-migration -- and
         * leaving 'faculty' here would have left exactly those accounts able to
         * open the caller's workspace while every properly configured faculty
         * account was refused. A hole that only opens for the least-configured
         * accounts is the kind nobody finds by clicking around.
         */
        'student_contact_workflow.php' => [
            'GET' => ['ssp-coordinator', 'ksh-tl', 'ssp-caller', 12],
            'POST' => ['ssp-coordinator', 'ksh-tl', 'ssp-caller', 12],
        ],
        // Read-only, and the same audience as the workspace it belongs to.
        'student_contact_log.php' => [
            'GET' => ['ssp-coordinator', 'ksh-tl', 'ssp-caller', 12],
        ],
        'home_visit_queue.php' => [
            'GET' => ['admin', 'csdl'],
            'PUT' => ['admin', 'csdl'],
        ],
        'student_contact_report.php' => [
            'GET' => ['admin', 'ssp-coordinator', 'ksh-tl', 'ssp-caller', 'csdl', 'faculty', 12],
        ],
        // Read-only, and the same audience as every other report: this list only
        // applies to roles with no saved permissions at all. A configured role is
        // gated by reports:view through api_endpoint_module_map().
        'term_comparison.php' => [
            'GET' => $reportReadRoles,
        ],
        'faculty_periodical_report.php' => [
            'GET' => ['admin', 'ssg', 'dean', 'program-head', 'faculty', 'dept-caller', 'ssp-coordinator', 'ssp-caller', 'ksh-tl', 'ksh-coach'],
        ],
        'term_logbook.php' => [
            'GET' => $reportReadRoles,
        ],
        'retention_matrix.php' => [
            'GET' => ['admin', 'dean', 'program-head', 'ssg', 'ssp-caller', 12],
        ],
        /*
         * The follow-up roles read this too. It is where a caller checks whether
         * the student they just rang actually migrated, and it is already scoped
         * for them: api_apply_student_type_scope() at student_migration.php:203
         * pins an SSP Caller to Nonstar and a KSH Coach to Star, so admitting them
         * widens who may look without widening what anyone sees.
         *
         * Read-only for everybody — the endpoint refuses any non-GET method. The
         * status itself is changed through enrollment_status, which these roles
         * were granted in 2026-08-12_callers_update_enrollment_status.sql.
         */
        // The SSP Coordinator (2026-09-30) and KSH TL (2026-10-01) left these
        // lists, and retention_matrix.php's above, with the retention_cases and
        // student_migration grants (see their presets).
        'student_migration.php' => [
            'GET' => ['admin', 'dean', 'program-head', 'ssg'],
        ],
        'year_migration.php' => [
            'GET' => ['admin', 'dean', 'program-head', 'ssg'],
            'POST' => ['admin', 'dean', 'program-head', 'ssg'],
        ],
        'retention_case.php' => [
            'GET' => ['admin', 'dean', 'program-head', 'ssg', 'ssp-caller', 12],
            'POST' => ['admin', 'dean', 'program-head', 'ssg', 'ssp-caller', 12],
            'PUT' => ['admin', 'dean', 'program-head', 'ssg', 'ssp-caller', 12],
        ],
    ];
}

function api_bootstrap_auth(): ?array
{
    $endpoint = basename($_SERVER['SCRIPT_FILENAME'] ?? '');
    if ($endpoint === '' || $endpoint === 'connection-pdo.php') {
        return null;
    }

    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'OPTIONS') {
        return null;
    }

    $isPublic = api_is_public_endpoint($endpoint);

    // Session before throttle, because api_throttle_identity() keys signed-in
    // traffic on the user id and only falls back to the IP when it cannot see
    // one — read before the session opens, every authenticated request would be
    // counted against its office's shared address instead of the person making
    // it. The condition preserves exactly which endpoints opened a session
    // before: starting one on the password-reset endpoints would hand a cookie
    // to every anonymous visitor for nothing.
    // login.php and me.php are the two public endpoints that read a session;
    // the password-reset three are token-based and have none to read. me.php
    // matters most: it is the session-restore call fired on every page load, so
    // leaving it out charged every signed-in user's page loads to their IP
    // instead of their account — the one place the shared-address problem would
    // actually have bitten.
    if (!$isPublic || in_array($endpoint, ['login.php', 'me.php'], true)) {
        api_start_session();
    }

    // Ahead of the public-endpoint return on purpose. login.php and the
    // password-reset endpoints are the ones reachable without credentials, so
    // they are the ones most worth flood-limiting; returning first would exempt
    // exactly the wrong five. The per-account lockout (api_rate_limit_hit() in
    // login.php) is a different control and still applies on top.
    api_throttle_request($endpoint);

    if ($isPublic) {
        return null;
    }

    $policyMap = api_endpoint_policy_map();
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    $endpointPolicy = $policyMap[$endpoint] ?? [];
    $allowedRoles = $endpointPolicy[$method] ?? [];

    return api_require_auth($allowedRoles);
}

function api_user_table_has_campus_column(PDO $pdo): bool
{
    static $hasColumn = null;

    if ($hasColumn !== null) {
        return $hasColumn;
    }

    $stmt = $pdo->query("SHOW COLUMNS FROM `user` LIKE 'campus_id'");
    $hasColumn = (bool)$stmt->fetch(PDO::FETCH_ASSOC);

    return $hasColumn;
}

function api_user_table_has_phone_column(PDO $pdo): bool
{
    static $hasColumn = null;

    if ($hasColumn !== null) {
        return $hasColumn;
    }

    $stmt = $pdo->query("SHOW COLUMNS FROM `user` LIKE 'phone_number'");
    $hasColumn = (bool)$stmt->fetch(PDO::FETCH_ASSOC);

    return $hasColumn;
}

/**
 * Feature-detected like the phone and campus columns above, so a checkout that
 * has not run 2026-08-14_jwt_auth.sql still logs people in rather than failing
 * every query that touches the user table.
 */
function api_user_table_has_token_version_column(PDO $pdo): bool
{
    static $hasColumn = null;

    if ($hasColumn !== null) {
        return $hasColumn;
    }

    $stmt = $pdo->query("SHOW COLUMNS FROM `user` LIKE 'token_version'");
    $hasColumn = (bool)$stmt->fetch(PDO::FETCH_ASSOC);

    return $hasColumn;
}

function api_build_user_context_query(PDO $pdo, bool $includePassword = false): string
{
    $passwordSelect = $includePassword ? 'u.password,' : '';
    // Aliased to a literal 0 when the column is absent so callers can read
    // $user['token_version'] unconditionally.
    $tokenVersionSelect = api_user_table_has_token_version_column($pdo)
        ? 'u.token_version,'
        : '0 AS token_version,';
    $phoneSelect = api_user_table_has_phone_column($pdo)
        ? "COALESCE(NULLIF(TRIM(u.phone_number), ''), NULLIF(TRIM(st.mobile_number), '')) AS phone_number,"
        : "NULLIF(TRIM(st.mobile_number), '') AS phone_number,";

    if (api_user_table_has_campus_column($pdo)) {
        $campusSelect = 'COALESCE(u.campus_id, d.campus_id) AS campus_id,';
        $campusJoin = 'LEFT JOIN campus c ON c.campus_id = COALESCE(u.campus_id, d.campus_id)';
    } else {
        $campusSelect = 'd.campus_id AS campus_id,';
        $campusJoin = 'LEFT JOIN campus c ON c.campus_id = d.campus_id';
    }

    return "SELECT
                u.user_id,
                u.first_name,
                u.last_name,
                u.email,
                u.created_at,
                $phoneSelect
                $passwordSelect
                $tokenVersionSelect
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
            LEFT JOIN student st ON st.user_id = u.user_id";
}

function api_fetch_user_context(PDO $pdo, int $userId, bool $includePassword = false): ?array
{
    $sql = api_build_user_context_query($pdo, $includePassword) . ' WHERE u.user_id = :user_id LIMIT 1';
    $stmt = $pdo->prepare($sql);
    $stmt->execute([':user_id' => $userId]);

    $row = $stmt->fetch(PDO::FETCH_ASSOC);

    return $row ?: null;
}

function api_user_is_active(array $userRow): bool
{
    return isset($userRow['status']) && (int)$userRow['status'] === 1;
}

function api_build_session_user(array $userRow): array
{
    $fullName = trim(($userRow['first_name'] ?? '') . ' ' . ($userRow['last_name'] ?? ''));

    return [
        'user_id' => isset($userRow['user_id']) ? (int)$userRow['user_id'] : null,
        'email' => $userRow['email'] ?? null,
        'phone_number' => $userRow['phone_number'] ?? null,
        'name' => $fullName !== '' ? $fullName : ($userRow['email'] ?? 'User'),
        'first_name' => $userRow['first_name'] ?? null,
        'last_name' => $userRow['last_name'] ?? null,
        'role' => $userRow['role_name'] ?? $userRow['role_id'] ?? null,
        'role_id' => isset($userRow['role_id']) ? (int)$userRow['role_id'] : null,
        'role_name' => $userRow['role_name'] ?? null,
        'department_id' => isset($userRow['department_id']) ? (int)$userRow['department_id'] : null,
        'department_name' => $userRow['department_name'] ?? null,
        'campus_id' => isset($userRow['campus_id']) ? (int)$userRow['campus_id'] : null,
        'campus_name' => $userRow['campus_name'] ?? null,
        'student_id' => isset($userRow['student_id']) && $userRow['student_id'] !== null ? (int)$userRow['student_id'] : null,
        'student_number' => $userRow['student_number'] ?? null,
        'created_at' => $userRow['created_at'] ?? null,
    ];
}

/**
 * The full authenticated-user payload for a user row: identity, the resolved
 * permission maps, and password-expiration state.
 *
 * Lifted out of api_store_authenticated_user() so the bearer-token path can
 * produce a byte-identical payload without writing a session. Two copies of
 * this would drift, and the drift would show up as a permission map that
 * differs depending on which transport the request arrived on — which is the
 * one class of bug a hybrid migration must not introduce.
 */
function api_build_authenticated_user_payload(array $userRow): array
{
    $sessionUser = api_build_session_user($userRow);
    $roleId = isset($sessionUser['role_id']) ? (int)$sessionUser['role_id'] : 0;
    $userId = isset($sessionUser['user_id']) ? (int)$sessionUser['user_id'] : 0;
    $permissionMap = [];
    $rolePermissionMap = [];
    $userPermissionMap = [];
    $permissionsConfigured = false;
    $rolePermissionsConfigured = false;
    $userPermissionsConfigured = false;
    $permissionSource = 'default';

    if ($roleId > 0 || $userId > 0) {
        $pdo = api_permission_db_connect();
        if ($pdo instanceof PDO) {
            $permissionRecord = api_fetch_effective_permissions_record($pdo, $roleId, $userId);
            $permissionMap = $permissionRecord['permissions'];
            $permissionsConfigured = !empty($permissionRecord['has_saved_permissions']);
            $rolePermissionMap = $permissionRecord['role_permissions'] ?? [];
            $userPermissionMap = $permissionRecord['user_permissions'] ?? [];
            $rolePermissionsConfigured = !empty($permissionRecord['has_saved_role_permissions']);
            $userPermissionsConfigured = !empty($permissionRecord['has_saved_user_permissions']);
            $permissionSource = $permissionRecord['permission_source'] ?? 'default';
        }
    }

    $sessionUser['permissions'] = $permissionMap;
    $sessionUser['module_permissions'] = $permissionMap;
    $sessionUser['role_permissions'] = $rolePermissionMap;
    $sessionUser['user_permissions'] = $userPermissionMap;
    $sessionUser['permissions_configured'] = $permissionsConfigured;
    $sessionUser['role_permissions_configured'] = $rolePermissionsConfigured;
    $sessionUser['user_permissions_configured'] = $userPermissionsConfigured;
    $sessionUser['permission_source'] = $permissionSource;
    $sessionUser['password_expiration'] = function_exists('api_password_expiration_status_for_user_row')
        ? api_password_expiration_status_for_user_row($userRow)
        : null;

    return $sessionUser;
}

function api_store_authenticated_user(array $userRow, bool $regenerateSessionId = true): array
{
    api_start_session();

    if ($regenerateSessionId) {
        session_regenerate_id(true);
    }

    $sessionUser = api_build_authenticated_user_payload($userRow);
    $permissionMap = $sessionUser['permissions'];
    $rolePermissionMap = $sessionUser['role_permissions'];
    $userPermissionMap = $sessionUser['user_permissions'];
    $permissionsConfigured = $sessionUser['permissions_configured'];
    $rolePermissionsConfigured = $sessionUser['role_permissions_configured'];
    $userPermissionsConfigured = $sessionUser['user_permissions_configured'];
    $permissionSource = $sessionUser['permission_source'];

    // The context this user was rebuilt from may differ from what a bearer
    // token resolved earlier in the same request (profile.php does exactly
    // that), so the token cache must not answer with the stale copy.
    api_bearer_user_cache(null, true);

    $_SESSION['user_id'] = $sessionUser['user_id'];
    $_SESSION['email'] = $sessionUser['email'];
    $_SESSION['phone_number'] = $sessionUser['phone_number'];
    $_SESSION['name'] = $sessionUser['name'];
    $_SESSION['first_name'] = $sessionUser['first_name'];
    $_SESSION['last_name'] = $sessionUser['last_name'];
    $_SESSION['role'] = $sessionUser['role'];
    $_SESSION['role_id'] = $sessionUser['role_id'];
    $_SESSION['role_name'] = $sessionUser['role_name'];
    $_SESSION['department_id'] = $sessionUser['department_id'];
    $_SESSION['department_name'] = $sessionUser['department_name'];
    $_SESSION['campus_id'] = $sessionUser['campus_id'];
    $_SESSION['campus_name'] = $sessionUser['campus_name'];
    $_SESSION['student_id'] = $sessionUser['student_id'];
    $_SESSION['student_number'] = $sessionUser['student_number'];
    $_SESSION['created_at'] = $sessionUser['created_at'];
    $_SESSION['password_expiration'] = $sessionUser['password_expiration'];
    $_SESSION['permissions'] = $permissionMap;
    $_SESSION['module_permissions'] = $permissionMap;
    $_SESSION['role_permissions'] = $rolePermissionMap;
    $_SESSION['user_permissions'] = $userPermissionMap;
    $_SESSION['permissions_configured'] = $permissionsConfigured;
    $_SESSION['role_permissions_configured'] = $rolePermissionsConfigured;
    $_SESSION['user_permissions_configured'] = $userPermissionsConfigured;
    $_SESSION['permission_source'] = $permissionSource;

    return $sessionUser;
}

function api_refresh_authenticated_user(PDO $pdo, bool $regenerateSessionId = false): ?array
{
    $sessionUser = api_get_session_user();
    if (!$sessionUser || empty($sessionUser['user_id'])) {
        return null;
    }

    $dbUser = api_fetch_user_context($pdo, (int)$sessionUser['user_id'], false);
    if (!$dbUser || !api_user_is_active($dbUser)) {
        api_destroy_session();
        return null;
    }

    return api_store_authenticated_user($dbUser, $regenerateSessionId);
}

// =============================================
// Rate limits on sensitive operations (login, reset and OTP mail)
// =============================================

/*
 * One counter per (bucket, subject) in api_rate_limits, for operations worth
 * limiting on their own: a password check, an email sent. The limits live in
 * middleware/rate_limit_policy.php; which buckets an operation spends is the
 * endpoint's decision. Flood control of ordinary traffic is throttle.php's job,
 * not this one's.
 *
 * ── WHY THIS REPLACED api_rate_limit_check() / api_rate_limit_record() ───────
 *
 * That pair read the count, let the endpoint do its work, then wrote the count
 * back. Measured 2026-09-25 with 20 parallel wrong-password attempts against a
 * limit of 5: all 20 were allowed, 16 increments were lost, the key split into
 * two rows (the pair had no unique key), and the account never locked. Every
 * earlier test had sent one request at a time, which is the only way it worked.
 *
 * Now a single INSERT ... ON DUPLICATE KEY UPDATE both counts the hit and
 * reports which number it was, via LAST_INSERT_ID(expr). MariaDB takes the
 * row lock for the statement, so 100 simultaneous hits receive 1..100 exactly
 * once each and the first `max` of them are allowed - no read-then-write left
 * to interleave. Endpoints spend BEFORE the work and refund after it if it
 * should not count (a correct password, an email that failed to send).
 *
 * Every time comparison is done by MySQL against its own NOW(), for the reason
 * the old code learned the hard way: PHP, the database and the server clocks
 * disagreed about the timezone, and a 900-second lock was once born 6300
 * seconds in the past.
 */

/**
 * The table, its columns and - above all - its unique key.
 *
 * The key is checked, not assumed, because without it this code fails OPEN
 * and silently: the upsert would never collide, every hit would insert a fresh
 * row with a count of 1, and every limit in the portal would quietly stop
 * limiting. Refusing loudly is the only safe answer to a missing migration.
 */
function api_ensure_rate_limit_table(PDO $pdo): void
{
    static $initialized = false;

    if ($initialized) {
        return;
    }

    api_require_table($pdo, 'api_rate_limits');
    foreach (['id', 'identity_key', 'action_type', 'attempt_count', 'first_attempt_at', 'last_attempt_at', 'locked_until'] as $column) {
        api_require_column($pdo, 'api_rate_limits', $column);
    }

    $unique = $pdo->query("SHOW INDEX FROM api_rate_limits WHERE Key_name = 'uq_rate_limits_identity'")->fetchAll();
    if (!$unique) {
        throw new RuntimeException(
            'api_rate_limits has no unique key on (identity_key, action_type), so rate limits cannot be counted. '
            . 'Run migrations/2026_09_25_rate_limit_unique_key.sql.'
        );
    }

    $initialized = true;
}

/**
 * What is stored for a subject: its SHA-256, never the email or IP itself.
 *
 * The table is a list of who tried to sign in, from where. Hashed, it answers
 * "has this key been seen" - all a limiter needs - without being a readable log
 * of addresses. The audit log is the record meant to be read.
 */
function api_rate_limit_key(string $subject): string
{
    return hash('sha256', $subject);
}

/**
 * Delete rows whose window and lock are both long over.
 *
 * About one request in a hundred, and through idx_rate_limits_last_attempt, in
 * place of the unindexed full-table DELETE that used to run on every login.
 * A day is past any window or lock the policy allows (both clamp to 86400).
 */
function api_rate_limit_sweep(PDO $pdo): void
{
    if (random_int(1, 100) !== 1) {
        return;
    }

    $pdo->exec(
        'DELETE FROM api_rate_limits
         WHERE last_attempt_at < NOW() - INTERVAL 1 DAY
           AND (locked_until IS NULL OR locked_until < NOW())'
    );
}

/**
 * Spend one hit from a bucket, atomically, and say whether it was allowed.
 *
 * Returns:
 *   allowed      this hit is within the limit
 *   remaining    hits left in the window after this one
 *   retry_after  seconds until a refused caller may try again (0 if allowed)
 *   count, max   this hit's number, and the limit it was measured against
 *   locked_now   this hit reached the limit and closed the lock - the moment
 *                worth an audit entry, as opposed to every refusal after it
 *
 * Hits made while a lock holds are still counted but never extend the lock:
 * someone who keeps retrying serves the lock and is let back in, rather than
 * being held for as long as they keep trying.
 */
function api_rate_limit_hit(PDO $pdo, string $bucket, string $subject, ?array $policy = null): array
{
    api_ensure_rate_limit_table($pdo);
    api_rate_limit_sweep($pdo);

    $policy = $policy ?? api_rate_limit_policy($bucket);
    // Integers, interpolated after the cast: INTERVAL cannot take a bound
    // parameter, and a bound timestamp would reopen the timezone question.
    $max = max(1, (int)$policy['max']);
    $window = max(1, (int)$policy['window']);
    $lock = max(0, (int)$policy['lock']);

    $held = 'locked_until IS NOT NULL AND locked_until > NOW()';
    // An expired lock or an elapsed window both start the count again.
    $restart = "NOT ($held) AND (locked_until IS NOT NULL OR first_attempt_at <= NOW() - INTERVAL $window SECOND)";
    $lockUntil = $lock > 0 ? "NOW() + INTERVAL $lock SECOND" : 'NULL';

    /*
     * MariaDB applies these assignments left to right, and an assignment sees
     * the NEW value of any column assigned before it. The order is therefore
     * load-bearing: attempt_count and first_attempt_at must read the OLD
     * locked_until, so it is assigned last; locked_until must read the NEW
     * attempt_count, so it comes after it.
     */
    $stmt = $pdo->prepare(
        "INSERT INTO api_rate_limits
            (identity_key, action_type, attempt_count, first_attempt_at, last_attempt_at, locked_until)
         VALUES (:identity_key, :action_type, 1, NOW(), NOW(), " . ($max <= 1 ? $lockUntil : 'NULL') . ")
         ON DUPLICATE KEY UPDATE
            attempt_count = LAST_INSERT_ID(IF($restart, 1, attempt_count + 1)),
            first_attempt_at = IF($restart, NOW(), first_attempt_at),
            last_attempt_at = NOW(),
            locked_until = IF($held, locked_until, IF(attempt_count >= $max, $lockUntil, NULL))"
    );
    $params = [
        ':identity_key' => api_rate_limit_key($subject),
        ':action_type' => $bucket,
    ];
    $stmt->execute($params);

    // 1 = a new row, whose count is 1 by definition (LAST_INSERT_ID() then holds
    // the auto-increment id, not a count). 2 = an update, and LAST_INSERT_ID()
    // holds exactly the count this statement wrote. The count changes on every
    // hit, so the unchanged-row answer (0) cannot occur.
    $count = $stmt->rowCount() === 1
        ? 1
        : (int)$pdo->query('SELECT LAST_INSERT_ID()')->fetchColumn();

    $allowed = $count <= $max;
    $retryAfter = 0;
    if (!$allowed) {
        $row = $pdo->prepare(
            "SELECT TIMESTAMPDIFF(SECOND, NOW(), locked_until) AS lock_left,
                    TIMESTAMPDIFF(SECOND, NOW(), first_attempt_at + INTERVAL $window SECOND) AS window_left
             FROM api_rate_limits
             WHERE identity_key = :identity_key AND action_type = :action_type"
        );
        $row->execute($params);
        $timing = $row->fetch(PDO::FETCH_ASSOC) ?: [];
        $lockLeft = isset($timing['lock_left']) ? (int)$timing['lock_left'] : 0;
        $retryAfter = max(1, $lockLeft > 0 ? $lockLeft : (int)($timing['window_left'] ?? 1));
    }

    return [
        'allowed' => $allowed,
        'remaining' => max(0, $max - $count),
        'retry_after' => $retryAfter,
        'count' => $count,
        'max' => $max,
        'locked_now' => $lock > 0 && $count === $max,
        'bucket' => $bucket,
    ];
}

/**
 * Give back one hit that turned out not to count - a correct password, an
 * email that never left.
 *
 * Only ever call this after a hit that was ALLOWED. If that hit is what closed
 * the lock, dropping the count back under the limit reopens it, which is right:
 * the attempt that "reached the limit" was not a failure after all.
 */
function api_rate_limit_refund(PDO $pdo, string $bucket, string $subject, ?array $policy = null): void
{
    api_ensure_rate_limit_table($pdo);

    $max = max(1, (int)(($policy ?? api_rate_limit_policy($bucket))['max']));

    // locked_until reads the NEW attempt_count - see the ordering note above.
    $stmt = $pdo->prepare(
        "UPDATE api_rate_limits
         SET attempt_count = GREATEST(attempt_count - 1, 0),
             locked_until = IF(attempt_count < $max, NULL, locked_until)
         WHERE identity_key = :identity_key AND action_type = :action_type"
    );
    $stmt->execute([
        ':identity_key' => api_rate_limit_key($subject),
        ':action_type' => $bucket,
    ]);
}

/**
 * Spend one hit from each bucket for a single operation, all or nothing.
 *
 * $buckets is a list of [bucket, subject] pairs, narrowest first, so a refusal
 * names the most specific reason. If one refuses, the ones already spent are
 * refunded - the operation is not going to run, so it must not cost anything.
 *
 * Returns ['allowed' => bool, 'refused' => the refusing hit or null,
 *          'hits' => [bucket => hit]].
 */
function api_rate_limit_reserve(PDO $pdo, array $buckets): array
{
    $hits = [];
    foreach ($buckets as [$bucket, $subject]) {
        $hit = api_rate_limit_hit($pdo, $bucket, $subject);
        if (!$hit['allowed']) {
            foreach ($buckets as [$spentBucket, $spentSubject]) {
                if (!isset($hits[$spentBucket])) {
                    break;
                }
                api_rate_limit_refund($pdo, $spentBucket, $spentSubject);
            }
            return ['allowed' => false, 'refused' => $hit, 'hits' => $hits];
        }
        $hits[$bucket] = $hit;
    }

    return ['allowed' => true, 'refused' => null, 'hits' => $hits];
}

/** Forget a subject's count entirely - a successful login resets its account. */
function api_rate_limit_clear(PDO $pdo, string $bucket, string $subject): void
{
    api_ensure_rate_limit_table($pdo);

    $stmt = $pdo->prepare(
        'DELETE FROM api_rate_limits WHERE identity_key = :identity_key AND action_type = :action_type'
    );
    $stmt->execute([
        ':identity_key' => api_rate_limit_key($subject),
        ':action_type' => $bucket,
    ]);
}

/**
 * The 429 every bucket refusal sends, and then stop.
 *
 * `message` and `retry_after` are the names the rest of this API and the
 * throttle already use, so the client reads one shape whichever limit it hit.
 * `$extra` carries an endpoint's own fields (a countdown deadline the screen
 * already knows how to show). Nothing about which bucket refused, or its key,
 * is ever sent back.
 */
function api_rate_limit_respond(array $hit, string $message, array $extra = []): void
{
    $retryAfter = max(1, (int)($hit['retry_after'] ?? 1));

    if (!headers_sent()) {
        header('Retry-After: ' . $retryAfter);
        // A cached 429 would outlive the limit it reports.
        header('Cache-Control: no-store');
    }

    api_json_response(429, array_merge([
        'message' => $message,
        'error' => 'RATE_LIMITED',
        'retry_after' => $retryAfter,
    ], $extra));
}

/**
 * The browser's X-Client-ID, if it sent a well-formed one, else ''.
 *
 * An anti-abuse signal and nothing more: the client writes it, can change it at
 * will, and it proves nothing about who is asking. It only ever narrows a
 * budget that an IP-keyed bucket still bounds - see rate_limit_policy.php.
 * Validated so a hostile value cannot bloat keys or the throttle's filenames.
 */
function api_client_device_id(): string
{
    $raw = trim((string)($_SERVER['HTTP_X_CLIENT_ID'] ?? ''));

    return preg_match('/^[A-Za-z0-9-]{16,64}$/', $raw) === 1 ? strtolower($raw) : '';
}

/** "This browser on this network": the device tier's subject. */
function api_client_device_key(): string
{
    return api_client_ip() . '|' . api_client_device_id();
}

// =============================================
// Server-side password validation (Fix #8)
// =============================================

/**
 * Does this plaintext already match the credential on the account?
 *
 * Used to refuse a "new" password that is the one already in use.
 * change-password.php can compare plaintext to plaintext because it asks for
 * the current password; a reset cannot, because it proves the account with an
 * emailed code instead and never sees the old password. So the comparison has
 * to go through the stored value.
 *
 * Accepts the same two formats login.php does — a modern hash, and the legacy
 * bare SHA-256 that predates it. Anything else returns false, deliberately
 * failing open: an unreadable stored value must not leave someone unable to
 * set a working password.
 */
function api_password_matches_stored(string $storedPassword, string $candidate): bool
{
    if ($storedPassword === '' || $candidate === '') {
        return false;
    }

    $info = password_get_info($storedPassword);
    if (!empty($info) && ($info['algo'] ?? 0) !== 0) {
        return password_verify($candidate, $storedPassword);
    }

    if (preg_match('/^[a-f0-9]{64}$/i', $storedPassword) === 1) {
        return hash_equals(strtolower($storedPassword), hash('sha256', $candidate));
    }

    return false;
}

function api_validate_password_strength(string $password): ?string
{
    /*
     * Characters, not bytes.
     *
     * strlen() counts bytes, so a password of non-ASCII characters cleared the
     * 8-character minimum while being far shorter than one: "Ab1" plus two CJK
     * characters is 9 bytes and 5 characters, and passed. The frontend mirror
     * in shared/lib/passwordValidation.js has always counted characters, so the
     * two disagreed and the backend -- the source of truth -- was the lax one.
     * Only reachable by a client that does not run the mirror, which is any
     * direct call to the API.
     */
    if (mb_strlen($password) < 8) {
        return 'Password must be at least 8 characters long';
    }

    if (!preg_match('/[A-Z]/', $password)) {
        return 'Password must contain at least one uppercase letter';
    }

    if (!preg_match('/[a-z]/', $password)) {
        return 'Password must contain at least one lowercase letter';
    }

    if (!preg_match('/[0-9]/', $password)) {
        return 'Password must contain at least one number';
    }

    $commonPasswords = [
        '123', '1234', '12345', '123456', '1234567', '12345678',
        'password', 'admin', 'admin123', 'qwerty', 'abc123',
        'letmein', 'welcome', 'monkey', 'dragon', 'master',
    ];
    if (in_array(strtolower($password), $commonPasswords, true)) {
        return 'This password is too common. Please choose a stronger password';
    }

    return null;
}

// =============================================
// Audit log: who did what, from where, on what
// =============================================

/**
 * The caller's IP address.
 *
 * REMOTE_ADDR is the only value the server observes directly and is the only
 * one that cannot be forged. X-Forwarded-For is attacker-controlled in general
 * -- anyone can send that header -- so it is consulted ONLY when the immediate
 * peer is loopback or a private address, i.e. when we really are behind a local
 * reverse proxy or a dev tunnel. Reached directly from the internet, the header
 * is ignored and REMOTE_ADDR wins.
 *
 * On XAMPP opened as localhost this correctly returns 127.0.0.1 or ::1: that IS
 * the client. Real addresses appear once the app is reached from another
 * machine.
 */
/**
 * Does $ip match one TRUSTED_PROXIES entry - an exact address or a CIDR block?
 *
 * Compared as packed bytes through inet_pton rather than as strings, so ::1 and
 * 0:0:0:0:0:0:0:1 are recognised as one address, and an IPv4 rule can never
 * match an IPv6 peer by sharing a prefix of its text.
 */
function api_ip_matches_rule(string $ip, string $rule): bool
{
    $rule = trim($rule);
    if ($rule === '' || $ip === '') {
        return false;
    }

    $slash = strpos($rule, '/');
    $network = $slash === false ? $rule : substr($rule, 0, $slash);

    $ipBin = @inet_pton($ip);
    $netBin = @inet_pton($network);
    if ($ipBin === false || $netBin === false || strlen($ipBin) !== strlen($netBin)) {
        return false;
    }
    if ($slash === false) {
        return $ipBin === $netBin;
    }

    $bits = (int)substr($rule, $slash + 1);
    $maxBits = strlen($ipBin) * 8;
    if ($bits < 0 || $bits > $maxBits) {
        return false;
    }

    $wholeBytes = intdiv($bits, 8);
    if ($wholeBytes > 0 && strncmp($ipBin, $netBin, $wholeBytes) !== 0) {
        return false;
    }
    $spareBits = $bits % 8;
    if ($spareBits === 0) {
        return true;
    }
    $mask = chr((0xFF << (8 - $spareBits)) & 0xFF);

    return ($ipBin[$wholeBytes] & $mask) === ($netBin[$wholeBytes] & $mask);
}

/**
 * The addresses allowed to speak for somebody else through X-Forwarded-For.
 *
 * Empty unless configured. A deployment behind nginx, Cloudflare or a campus
 * load balancer lists that hop in TRUSTED_PROXIES in .env.local (comma
 * separated, exact addresses or CIDR); everything else is an ordinary client
 * whose headers are its own opinion.
 */
function api_trusted_proxies(): array
{
    if (!function_exists('api_env')) {
        return [];
    }

    $rules = [];
    foreach (explode(',', api_env('TRUSTED_PROXIES', '')) as $entry) {
        $entry = trim($entry);
        if ($entry !== '') {
            $rules[] = $entry;
        }
    }

    return $rules;
}

function api_peer_is_trusted_proxy(string $ip): bool
{
    foreach (api_trusted_proxies() as $rule) {
        if (api_ip_matches_rule($ip, $rule)) {
            return true;
        }
    }

    return false;
}

/**
 * The address this request came from, as far as it can be trusted.
 *
 * X-Forwarded-For is a request header, so it is written by whoever sends the
 * request. It is believed only from a peer on the TRUSTED_PROXIES list, and the
 * chain is read RIGHT to left. Both halves of that matter, and this function
 * used to get both wrong:
 *
 *   - It trusted any private-range peer. On a campus LAN that is every client,
 *     and api_throttle_identity() buckets anonymous traffic by this value - so a
 *     client could rotate one header and draw a fresh 120-request budget per
 *     request, evading the global throttle entirely.
 *
 *   - It took the first PUBLIC address from the left. A client sends
 *     `X-Forwarded-For: 8.8.8.8` and the proxy APPENDS the address it actually
 *     saw, so the leftmost entry is the client's own claim and the rightmost is
 *     the only one a proxy vouched for. Reading left to right returned the
 *     forgery even where the proxy was configured correctly.
 *
 * Walking back from the right, past hops that are themselves on the list,
 * leaves the first address nobody vouched for: the client. A private address
 * there is kept - behind a real proxy, a LAN client is a perfectly ordinary
 * client.
 */
/**
 * The visitor's address as the front proxy (Vercel) reported it, or null.
 *
 * CLIENT_IP_HEADER names the header that carries it (X-Real-IP or
 * X-Forwarded-For). It is read only when the request also carried the proxy's
 * secret (middleware/origin_guard.php) - that is, only when it provably came
 * through Vercel, which writes these headers itself rather than passing on what
 * the visitor sent. Without the secret it is the sender's own claim, and the
 * TRUSTED_PROXIES walk below decides as before.
 *
 * The FIRST valid address wins: Vercel puts the visitor there, and any hop
 * after it (Railway's edge) appends its own.
 */
function api_client_ip_from_front_proxy(): ?string
{
    if (!function_exists('api_origin_secret_ok') || !api_origin_secret_ok()) {
        return null;
    }
    $header = function_exists('api_env') ? trim(api_env('CLIENT_IP_HEADER', '')) : '';
    if ($header === '' || !preg_match('/^[A-Za-z0-9-]+$/', $header)) {
        return null;
    }
    $key = 'HTTP_' . strtoupper(str_replace('-', '_', $header));
    foreach (explode(',', (string)($_SERVER[$key] ?? '')) as $candidate) {
        $candidate = trim($candidate);
        if ($candidate !== '' && filter_var($candidate, FILTER_VALIDATE_IP) !== false) {
            return substr($candidate, 0, 45);
        }
    }

    return null;
}

function api_client_ip(): string
{
    $fromFrontProxy = api_client_ip_from_front_proxy();
    if ($fromFrontProxy !== null) {
        return $fromFrontProxy;
    }

    $remote = trim((string)($_SERVER['REMOTE_ADDR'] ?? ''));
    if ($remote === '') {
        return 'unknown';
    }

    if (api_peer_is_trusted_proxy($remote)) {
        $chain = explode(',', (string)($_SERVER['HTTP_X_FORWARDED_FOR'] ?? ''));
        for ($i = count($chain) - 1; $i >= 0; $i--) {
            $candidate = trim($chain[$i]);
            if ($candidate === '' || filter_var($candidate, FILTER_VALIDATE_IP) === false) {
                continue;
            }
            if (api_peer_is_trusted_proxy($candidate)) {
                continue;   // one of our own hops; keep walking left
            }

            return substr($candidate, 0, 45);
        }
    }

    return substr($remote, 0, 45);
}

/**
 * A readable device summary from the User-Agent header.
 *
 * Hand-rolled rather than pulled from a library: this needs to name a browser
 * and an OS for a report, not to identify every crawler ever shipped, and a
 * dependency here would have to be vendored into a project whose PHP has no
 * package manager wired up.
 *
 * Order matters. Edge and Opera both carry "Chrome" in their UA, and Chrome
 * carries "Safari", so the most specific brand has to be tested first or every
 * browser reports as Chrome.
 */
function api_describe_device(?string $userAgent = null): string
{
    $ua = trim((string)($userAgent ?? $_SERVER['HTTP_USER_AGENT'] ?? ''));
    if ($ua === '') {
        return 'Unknown device';
    }

    $browser = 'Unknown browser';
    foreach ([
        'Edg' => 'Edge',
        'OPR' => 'Opera',
        'Opera' => 'Opera',
        'SamsungBrowser' => 'Samsung Internet',
        'Firefox' => 'Firefox',
        'Chrome' => 'Chrome',
        'Safari' => 'Safari',
        'Trident' => 'Internet Explorer',
        'curl' => 'curl',
        'PostmanRuntime' => 'Postman',
    ] as $needle => $label) {
        if (stripos($ua, $needle) !== false) {
            $browser = $label;
            break;
        }
    }

    $platform = 'Unknown OS';
    foreach ([
        'Windows NT 10' => 'Windows',
        'Windows NT' => 'Windows',
        'Android' => 'Android',
        'iPhone' => 'iOS',
        'iPad' => 'iPadOS',
        'Mac OS X' => 'macOS',
        'CrOS' => 'ChromeOS',
        'Linux' => 'Linux',
    ] as $needle => $label) {
        if (stripos($ua, $needle) !== false) {
            $platform = $label;
            break;
        }
    }

    $isMobile = preg_match('/Mobile|Android|iPhone|iPad|Tablet/i', $ua) === 1;
    $form = $isMobile ? ' (mobile)' : '';

    return substr("$browser on $platform$form", 0, 120);
}

function api_audit_ensure_table(PDO $pdo): void
{
    static $ensured = false;
    if ($ensured) {
        return;
    }

    /*
     * Looked up before it is created, because in MariaDB EVERY DDL statement
     * carries an implicit COMMIT -- `CREATE TABLE IF NOT EXISTS` included, and
     * including the case where the table already exists and the statement does
     * nothing at all.
     *
     * This runs inside other people's transactions. The contact workspace
     * records an attempt and audits it in one transaction, so this ended that
     * transaction halfway through: the caller's own commit() then threw "There
     * is no active transaction", and a save that had ALREADY been written was
     * reported to the user as a failure. They then saved again. Verified on
     * PHP 8.2.12 / MariaDB 10.4.32 -- inTransaction() flips from true to false
     * across this one statement.
     *
     * `SHOW TABLES LIKE` is not DDL and commits nothing, so the normal path --
     * the table exists, as it does on every installation past its first request
     * -- no longer touches the caller's transaction at all.
     */
    $exists = (bool)$pdo->query("SHOW TABLES LIKE 'api_audit_log'")->fetchColumn();
    if ($exists) {
        $ensured = true;
        return;
    }

    /*
     * Creating it would end a transaction that is already open, so on the one
     * request that has to bootstrap the table, the bootstrap yields instead of
     * breaking the write it was called from. `$ensured` stays false so the next
     * request retries outside a transaction; the audit row this call would have
     * written is lost, which is much the smaller of the two losses.
     */
    if ($pdo->inTransaction()) {
        return;
    }

    $pdo->exec(
        'CREATE TABLE IF NOT EXISTS api_audit_log (
            audit_id     BIGINT AUTO_INCREMENT PRIMARY KEY,
            occurred_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
            user_id      INT          NULL,
            actor_label  VARCHAR(190) NULL,
            action       VARCHAR(60)  NOT NULL,
            outcome      VARCHAR(20)  NOT NULL DEFAULT "success",
            detail       VARCHAR(255) NULL,
            metadata     TEXT         NULL,
            ip_address   VARCHAR(45)  NULL,
            device       VARCHAR(120) NULL,
            user_agent   VARCHAR(255) NULL,
            KEY idx_audit_occurred (occurred_at),
            KEY idx_audit_user (user_id),
            KEY idx_audit_action (action),
            KEY idx_audit_ip (ip_address)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
    );

    $ensured = true;
}

/**
 * Record one audited event. Never throws: an audit write must not be able to
 * fail the action it is describing, or a full disk turns into a login outage.
 * A dropped row is logged through the normal exception path instead.
 */
function api_audit_record(PDO $pdo, array $event): void
{
    try {
        api_audit_ensure_table($pdo);

        $userId = isset($event['user_id']) && (int)$event['user_id'] > 0 ? (int)$event['user_id'] : null;
        $userAgent = (string)($_SERVER['HTTP_USER_AGENT'] ?? '');

        $stmt = $pdo->prepare(
            'INSERT INTO api_audit_log
                (user_id, actor_label, action, outcome, detail, metadata, ip_address, device, user_agent)
             VALUES (:user_id, :actor_label, :action, :outcome, :detail, :metadata, :ip, :device, :user_agent)'
        );
        $stmt->execute([
            ':user_id' => $userId,
            ':actor_label' => substr(trim((string)($event['actor_label'] ?? '')), 0, 190) ?: null,
            ':action' => substr((string)($event['action'] ?? 'unknown'), 0, 60),
            ':outcome' => substr((string)($event['outcome'] ?? 'success'), 0, 20),
            ':detail' => substr(trim((string)($event['detail'] ?? '')), 0, 255) ?: null,
            // Not truncated: it is TEXT, and a clipped JSON document is worth
            // less than none at all — it cannot be parsed and cannot be trusted.
            ':metadata' => ($event['metadata'] ?? null) ?: null,
            ':ip' => api_client_ip(),
            ':device' => api_describe_device($userAgent),
            ':user_agent' => substr($userAgent, 0, 255) ?: null,
        ]);
    } catch (Throwable $throwable) {
        if (function_exists('api_log_exception')) {
            api_log_exception($throwable, ['scope' => 'api_audit_record', 'action' => $event['action'] ?? '']);
        }
    }
}
