<?php

/**
 * Reading .env.local, split out so it does not depend on load order.
 *
 * These two functions used to live in connection-pdo.php. That was fine while
 * the only thing that needed configuration was the database, because reaching
 * the database and including connection-pdo.php were the same act. Bearer auth
 * broke that assumption: api_jwt_secret() needs JWT_SECRET the moment a token is
 * decoded, which for some endpoints is before any database work has been asked
 * for.
 *
 * logout.php is the case that proved it. It requires middleware/auth.php at the
 * top and connection-pdo.php only later, inside the audit block — so when
 * api_get_session_user() ran, api_env() did not exist yet, api_jwt_secret() fell
 * through to an empty process environment, and logout answered
 * "Server authentication is misconfigured." with a 500. The refresh token was
 * never revoked and the cookie was never cleared, which meant logging out did
 * not log anybody out. It looked like it worked, because the tab that asked
 * navigated away regardless.
 *
 * Configuration should not be reachable only through a database connection.
 * Anything that needs a setting requires this file directly.
 */

if (!function_exists('api_load_env')) {
    /**
     * Load and cache .env.local values.
     * Returns an associative array of key => value pairs.
     */
    function api_load_env(): array
    {
        static $env = null;

        if ($env !== null) {
            return $env;
        }

        // Two levels up from middleware/: backend/.env.local, which is where the
        // file has always lived relative to connection-pdo.php.
        $envFile = dirname(__DIR__, 2) . DIRECTORY_SEPARATOR . '.env.local';
        $env = [];

        if (is_file($envFile) && is_readable($envFile)) {
            $lines = file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
            if (is_array($lines)) {
                foreach ($lines as $line) {
                    $line = trim($line);
                    if ($line === '' || $line[0] === '#') {
                        continue;
                    }
                    $eqPos = strpos($line, '=');
                    if ($eqPos === false) {
                        continue;
                    }
                    $key = trim(substr($line, 0, $eqPos));
                    $value = trim(substr($line, $eqPos + 1));
                    if ($key !== '') {
                        $env[$key] = $value;
                    }
                }
            }
        }

        return $env;
    }
}

if (!function_exists('api_env')) {
    /**
     * Get a single env value with a fallback default.
     *
     * Order: .env.local first, then the real process environment, then the default.
     *
     * The file wins so an existing XAMPP checkout behaves exactly as before. The
     * process environment is what containers actually set - docker-compose passes
     * DB_HOST and friends as environment variables, and there is no .env.local in
     * the image - so without this fallback the container would silently connect to
     * "localhost" and find no database.
     */
    function api_env(string $key, string $default = ''): string
    {
        $env = api_load_env();
        if (array_key_exists($key, $env) && $env[$key] !== '') {
            return $env[$key];
        }

        $fromProcess = getenv($key);
        if ($fromProcess !== false && $fromProcess !== '') {
            return $fromProcess;
        }

        return $default;
    }
}

if (!function_exists('api_env_flag')) {
    /** A yes/no setting: 1, true, yes or on (any case) is yes; anything else is no. */
    function api_env_flag(string $key): bool
    {
        return in_array(strtolower(trim(api_env($key, ''))), ['1', 'true', 'yes', 'on'], true);
    }
}

if (!function_exists('api_db_settings')) {
    /**
     * Where the database is and how to reach it, read in one place.
     *
     * There are three ways in - the Database class, the permission lookup in
     * auth.php, and the backup tools - and each used to read DB_HOST and friends
     * on its own. A managed database (Aiven) needs two more things than XAMPP
     * does, a port and TLS, and three copies of that is three chances for one
     * to connect in plain text.
     *
     *   DB_PORT    defaults to 3306.
     *   DB_SSL_CA  path to the server's CA certificate. Set means TLS, with the
     *              certificate verified; Aiven signs with its own project CA, so
     *              the system bundle would not verify it. Empty means no TLS,
     *              which is what XAMPP has always done.
     */
    function api_db_settings(): array
    {
        return [
            'host' => api_env('DB_HOST', '127.0.0.1'),
            'port' => (int)api_env('DB_PORT', '3306'),
            'db_name' => api_env('DB_NAME', 'rms_public_demo'),
            'username' => api_env('DB_USERNAME', 'root'),
            'password' => api_env('DB_PASSWORD', ''),
            'ssl_ca' => api_env('DB_SSL_CA', ''),
        ];
    }

    function api_db_dsn(array $settings): string
    {
        return 'mysql:host=' . $settings['host'] . ';port=' . (int)$settings['port']
            . ';dbname=' . $settings['db_name'] . ';charset=utf8mb4';
    }

    function api_db_pdo_options(array $settings): array
    {
        $options = [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        ];
        if ($settings['ssl_ca'] !== '') {
            $options[PDO::MYSQL_ATTR_SSL_CA] = $settings['ssl_ca'];
            $options[PDO::MYSQL_ATTR_SSL_VERIFY_SERVER_CERT] = true;
        }
        return $options;
    }

    /**
     * Make every connection behave like the development database.
     *
     * Time zone: a fixed +08:00 rather than a name, because the Philippines has
     * no DST and named zones need the tz tables loaded. A managed server's own
     * zone is UTC, so without this NOW() and CURRENT_TIMESTAMP would be eight
     * hours off from every date PHP writes.
     *
     * SQL mode: the app was written against XAMPP's MariaDB, whose mode is
     * NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION - no strict mode and
     * no ONLY_FULL_GROUP_BY. MySQL 8 (Aiven) turns both on by default, which
     * would turn queries that work today into errors. DB_SQL_MODE overrides.
     */
    function api_db_init_session(PDO $pdo): void
    {
        $pdo->exec("SET time_zone = '+08:00'");
        $mode = api_env('DB_SQL_MODE', 'NO_ZERO_IN_DATE,NO_ZERO_DATE,NO_ENGINE_SUBSTITUTION');
        $pdo->prepare('SET SESSION sql_mode = ?')->execute([$mode]);
    }
}

if (!function_exists('api_https_forced')) {
    /**
     * Whether TLS ended at a proxy in front of this server (Railway, Vercel).
     *
     * Apache then sees plain HTTP, so $_SERVER['HTTPS'] is empty and the cookies
     * would go out without the Secure flag. APP_FORCE_HTTPS=1 says every request
     * really arrived over HTTPS, which is true when the only public address is an
     * https:// one.
     */
    function api_https_forced(): bool
    {
        return api_env_flag('APP_FORCE_HTTPS');
    }
}
