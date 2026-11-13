<?php
/**
 * The Contact Workspace's contact log: every attempt its reader may see, filtered
 * and paged, for the log view and its export. The query is lib/contact_log.php.
 *
 * Read-only. Attempts are written by the workspaces that record them; a log a
 * client could post to would not be a log.
 *
 * Gated on student_contacts:analyze rather than view (see the override in
 * middleware/auth.php): reading the whole log and taking it away as a file is
 * reporting, and `analyze` is the grant this system uses for reporting on a
 * module. Every role that holds student_contacts holds it today, so nobody who
 * works the queue is refused; an administrator can withdraw it from a role
 * without withdrawing the queue.
 */
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/contact_log.php';

try {
    $pdo = (new Database())->connect();

    // The workspace's own gates, word for word, so the log answers exactly the
    // accounts the queue beside it answers.
    $access = student_contact_resolve_access(api_get_session_user() ?? []);
    if (empty($access['is_department_scoped']) && empty($access['is_coordinator']) && empty($access['is_ssp_caller'])) {
        api_out(403, ['message' => 'Forbidden']);
    }
    if (!empty($access['is_department_scoped']) && empty($access['department_id'])) {
        api_out(409, ['message' => 'Your account has no department set, so this workspace has no students to show. Ask an administrator to set the department on your profile.']);
    }

    api_out(200, contact_log($pdo, $access, contact_log_filters($_GET)));
} catch (InvalidArgumentException $exception) {
    api_out(400, ['message' => $exception->getMessage()]);
} catch (Throwable $throwable) {
    api_log_exception($throwable, ['scope' => 'student_contact_log']);
    api_out(500, ['message' => 'Server error']);
}
