<?php
require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/student_contact_workflow_lib.php';


try {
    $db = new Database();
    $pdo = $db->connect();
    student_contact_ensure_tables($pdo);

    $authUser = api_get_session_user();
    $access = student_contact_resolve_access($authUser ?? []);
    if (empty($access['is_department_scoped']) && empty($access['is_coordinator']) && empty($access['is_ssp_caller'])) {
        api_out(403, ['message' => 'Forbidden']);
    }

    /*
     * A department-scoped account with no department answers for nobody.
     *
     * student_contact_visibility_clause() already fails closed on this, so
     * without the check here the workspace opens onto an empty queue and looks
     * broken. It is not a permission problem — the role is right and the screen
     * is theirs — so it is reported as the missing field it actually is, and
     * not as a 403 that would send the user looking at their role instead of at
     * their profile.
     */
    if (!empty($access['is_department_scoped']) && empty($access['department_id'])) {
        api_out(409, ['message' => 'Your account has no department set, so this workspace has no students to show. Ask an administrator to set the department on your profile.']);
    }

    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    if ($method === 'GET') {
        // Which band of the follow-up queue: who needs a call, or who has simply
        // never returned a survey. Defaults to the former.
        $queue = follow_up_queue_normalize($_GET['queue'] ?? null);
        $rows = student_contact_queue_rows($pdo, $access, ['queue' => $queue]);

        api_out(200, [
            'data' => $rows,
            'summary' => student_contact_queue_summary($rows),
            'queue' => $queue,
            // Scoped exactly as the rows above are, so the tab badge counts the
            // queue the table is showing. See follow_up_queue_counts().
            'queue_counts' => follow_up_queue_counts(
                $pdo,
                $access['student_type_scope'] ?? null,
                student_contact_visibility_clause($pdo, $access, 'c.department_id', 'st.student_id')
            ),
            'settings' => [
                'statuses' => array_values(STUDENT_CONTACT_STATUS_LABELS),
                // Read from the `status` table, not listed here: the institution
                // already defines Will Enroll, To Stop, Undecided, CBR and the
                // rest, and a second copy would drift from it. Enrolled is the
                // one it filters out - see student_contact_enrollment_options().
                'enrollment_statuses' => student_contact_enrollment_options($pdo),

                /*
                 * The four caller dropdowns from section 3 of the sheet.
                 *
                 * Sent with the queue rather than fetched separately: all four
                 * are needed the moment the log-attempt form opens, and a second
                 * round trip to fill a dropdown is a spinner inside a modal.
                 *
                 * 'contact_methods' keeps its old name and now carries the
                 * seven channels. Renaming the key would have been a contract
                 * change for no gain - it has always meant "how the caller
                 * reached them", which is exactly what CHANNEL USED is.
                 */
                'contact_methods' => array_column(student_contact_channel_options($pdo), 'key'),
                'channels' => student_contact_channel_options($pdo),
                'reason_groups' => student_contact_reason_options($pdo),
                'recovery_plans' => student_contact_recovery_plan_options($pdo),
                /*
                 * Filtered to the acting role's own list, so a coach is never
                 * offered UNREACHABLE and CSDL is never offered REFERRED TO
                 * CSDL. The same rule is enforced on write by
                 * student_intervention_status_key() - this dropdown is the
                 * convenience, that validator is the control.
                 */
                'intervention_statuses' => array_map(
                    static function (string $key, string $label): array {
                        return ['key' => $key, 'label' => $label];
                    },
                    array_keys(student_intervention_statuses_for_role((int)($access['role_id'] ?? 0) ?: null)),
                    array_values(student_intervention_statuses_for_role((int)($access['role_id'] ?? 0) ?: null))
                ),
            ],
        ]);
    }

    if ($method === 'POST') {
        $payload = json_decode(file_get_contents('php://input'), true);
        if (!is_array($payload)) {
            api_out(400, ['message' => 'Invalid JSON payload.']);
        }

        $row = student_contact_record_attempt($pdo, $access, $payload);
        api_out(201, [
            'message' => 'Contact attempt saved.',
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
    api_log_exception($throwable, ['scope' => 'student_contact_workflow']);
    api_out(500, ['message' => 'Server error']);
}
