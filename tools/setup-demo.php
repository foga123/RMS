<?php
/** LOCAL DEMO ONLY. Initializes an empty, dedicated schema; never resets data. */
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
require_once __DIR__ . '/../backend/api/middleware/env.php';

$root = dirname(__DIR__);
$name = api_env('DB_NAME', 'rms_public_demo');
if (!preg_match('/^rms_public_demo(?:_verify_[0-9]+)?$/D', $name)) {
    fwrite(STDERR, "Refusing database name. This tool only accepts rms_public_demo or an isolated verification schema.\n");
    exit(1);
}
$host = api_env('DB_HOST', '127.0.0.1');
$port = (int)api_env('DB_PORT', '3306');
$username = api_env('DB_USERNAME', 'root');
$password = api_env('DB_PASSWORD', '');

try {
    $pdo = new PDO("mysql:host=$host;port=$port;charset=utf8mb4", $username, $password, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
    $pdo->exec("CREATE DATABASE IF NOT EXISTS `$name` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci");
    $pdo->exec("USE `$name`");
    if ((int)$pdo->query('SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()')->fetchColumn() !== 0) {
        throw new RuntimeException('Demo database is not empty. Nothing was reset or imported.');
    }
    $pdo->exec(file_get_contents($root . '/database/schema.sql'));
    api_db_init_session($pdo);
    $pdo->beginTransaction();
    $pdo->exec("INSERT INTO role (role_id, role_name, description) VALUES (1, 'Admin', 'Public demonstration administrator')");
    $pdo->exec("INSERT INTO status (status_id, status_name, status_type) VALUES (1, 'Active', 'account')");
    $stmt = $pdo->prepare('INSERT INTO user (first_name, last_name, role, status, email, password) VALUES (?, ?, 1, 1, ?, ?)');
    $stmt->execute(['Demo', 'Administrator', 'admin@gmail.com', password_hash('admin123', PASSWORD_DEFAULT)]);
    $pdo->commit();

    // Signing keys are required by the existing authentication code. Generate
    // a new local key at setup; no real or shared signing key is distributed.
    $env = "DB_HOST=$host\nDB_PORT=$port\nDB_NAME=$name\nDB_USERNAME=$username\nDB_PASSWORD=$password\nJWT_SECRET=" . bin2hex(random_bytes(32)) . "\nAPP_FORCE_HTTPS=0\nTURNSTILE_SITE_KEY=\nTURNSTILE_SECRET_KEY=\nTURNSTILE_HOSTNAMES=\nAPPS_SCRIPT_URL=\nAPPS_SCRIPT_SECRET=\nSMTP_HOST=\nSMTP_USERNAME=\nSMTP_PASSWORD=\nSMTP_FROM_EMAIL=\nGMAIL_CLIENT_ID=\nGMAIL_CLIENT_SECRET=\nGMAIL_REFRESH_TOKEN=\nBREVO_API_KEY=\n";
    if (file_put_contents($root . '/backend/.env.local', $env, LOCK_EX) === false) {
        throw new RuntimeException('Could not save the local backend environment.');
    }
    @chmod($root . '/backend/.env.local', 0600);
    fwrite(STDOUT, "Empty demo initialized. Only Admin role, Active status and admin@gmail.com / admin123 were seeded.\nLocal signing key generated privately; no external email or CAPTCHA configured.\n");
} catch (Throwable $error) {
    if (isset($pdo) && $pdo->inTransaction()) $pdo->rollBack();
    fwrite(STDERR, "Demo setup failed: " . $error->getMessage() . "\n");
    exit(1);
}
