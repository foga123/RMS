<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/student_contact_workflow_lib.php';


try {
    $db = new Database();
    $pdo = $db->connect();
    student_contact_ensure_tables($pdo);

    $authUser = api_get_session_user();
    $access = student_contact_resolve_access($authUser ?? []);
    if (
        empty($access['is_admin'])
        && empty($access['is_department_scoped'])
        && empty($access['is_coordinator'])
        && empty($access['is_ssp_caller'])
        && empty($access['is_csdl'])
    ) {
        api_out(403, ['message' => 'Forbidden']);
    }

    api_out(200, student_contact_report_data($pdo, $access));
} catch (Throwable $throwable) {
    api_log_exception($throwable, ['scope' => 'student_contact_report']);
    api_out(500, ['message' => 'Server error']);
}
