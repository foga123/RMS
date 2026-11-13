<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'PUT', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/student_contact_workflow_lib.php';


try {
    $db = new Database();
    $pdo = $db->connect();
    student_contact_ensure_tables($pdo);

    $authUser = api_get_session_user();
    $access = student_contact_resolve_access($authUser ?? []);
    if (empty($access['is_admin']) && empty($access['is_csdl'])) {
        api_out(403, ['message' => 'Forbidden']);
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET') {
        $rows = student_home_visit_rows($pdo, $access);
        api_out(200, [
            'data' => $rows,
            'summary' => student_home_visit_summary($rows),
            'enrollment_outcomes' => student_contact_enrollment_options($pdo),
            'reason_groups' => student_contact_reason_options($pdo),
            'role8_users' => student_contact_fetch_role_users($pdo, STUDENT_CONTACT_CSDL_ROLE_ID, 'csdl'),
            'final_outcomes' => array_map(
                static fn(string $label, string $key): array => ['key' => $key, 'label' => $label],
                STUDENT_INTERVENTION_STATUSES_CSDL,
                array_keys(STUDENT_INTERVENTION_STATUSES_CSDL)
            ),
        ]);
    }

    if ($method === 'PUT') {
        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            api_out(400, ['message' => 'Invalid JSON payload.']);
        }

        $row = student_home_visit_update($pdo, $access, $payload);
        api_out(200, [
            'message' => 'Home visit record updated.',
            'data' => $row,
        ]);
    }

    api_out(405, ['message' => 'Method not allowed']);
} catch (InvalidArgumentException $exception) {
    api_out(400, ['message' => $exception->getMessage()]);
} catch (TermClosedException $exception) {
    // Before RuntimeException, which it extends: a closed term is a 423.
    api_out(TERM_CLOSURE_HTTP_STATUS, $exception->body());
} catch (RuntimeException $exception) {
    $message = $exception->getMessage() ?: 'Request failed.';
    $status = strtolower($message) === 'forbidden' ? 403 : 400;
    api_out($status, ['message' => $message]);
} catch (Throwable $throwable) {
    api_log_exception($throwable, ['scope' => 'home_visit_queue']);
    api_out(500, ['message' => 'Server error']);
}
