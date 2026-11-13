<?php

require_once __DIR__ . '/middleware/auth.php';

api_bootstrap_auth();
require_once __DIR__ . '/notification_service.php';

/*
 * api_load_env() and api_env() used to be defined here.
 *
 * They moved to middleware/env.php because reading a setting had come to
 * require a database include: an endpoint that decodes a bearer token before it
 * asks for a connection found api_env() undefined and read an empty JWT_SECRET.
 * See the header of that file for the logout bug this caused.
 */
require_once __DIR__ . '/middleware/env.php';

class Database {
    private $host;
    private $port;
    private $db_name;
    private $username;
    private $password;
    private $ssl_ca;
    public $conn;

    public function __construct() {
        /*
         * 127.0.0.1, not 'localhost'.
         *
         * On Windows 'localhost' resolves to ::1 first. MariaDB here listens on
         * IPv4 only, so every connection spent ~2 SECONDS waiting for the IPv6
         * attempt to fail before falling back — measured at 2035ms against 1ms
         * for the literal address. Two connections per request made that the
         * entire cost of every screen in the portal: a 7-row department list
         * took 4.2 seconds, of which 4.1 was this.
         *
         * The literal address skips resolution altogether. Set DB_HOST in
         * .env.local to override for a real remote database.
         *
         * Read through api_db_settings() (middleware/env.php), which also
         * carries DB_PORT and DB_SSL_CA for a managed database.
         */
        $settings = api_db_settings();
        $this->host     = $settings['host'];
        $this->port     = $settings['port'];
        $this->db_name  = $settings['db_name'];
        $this->username = $settings['username'];
        $this->password = $settings['password'];
        $this->ssl_ca   = $settings['ssl_ca'];
    }

    public function getConfig() {
        return [
            'host' => $this->host,
            'port' => $this->port,
            'db_name' => $this->db_name,
            'username' => $this->username,
            'password' => $this->password,
            'ssl_ca' => $this->ssl_ca,
        ];
    }

    public function connect() {
        $this->conn = null;

        try {
            $settings = $this->getConfig();
            $this->conn = new PDO(
                api_db_dsn($settings),
                $this->username,
                $this->password,
                api_db_pdo_options($settings)
            );

            // Time zone and SQL mode to match development; see the function.
            api_db_init_session($this->conn);
        } catch (PDOException $e) {
            api_log_exception($e, ['scope' => 'database_connect']);
            http_response_code(500);
            echo json_encode(["message" => "Database connection failed"]);
            exit;
        }

        return $this->conn;
    }
}
