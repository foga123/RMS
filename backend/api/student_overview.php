<?php
/**
 * A student's own standing, for their own dashboard.
 *
 * The student overview had three cards — Enrolled Courses, Attendance Rate,
 * Notifications — hardcoded to null in StudentDashboard.jsx. They rendered as
 * empty boxes for every student, every visit.
 *
 * The data exists; the problem was reaching it. A balance lives in `finance`
 * and belongs to `finance_management`, attendance lives in `attendance` and
 * belongs to `attendance_management`, and a student holds neither module and
 * should not. Granting them would hand every student the finance and attendance
 * screens for the whole college in order to show them one number about
 * themselves.
 *
 * So this endpoint answers exactly that question and no wider one:
 *
 *   - It is gated on `overview`, the module a student already has.
 *   - It takes NO student parameter. The student id is read from the session's
 *     own linked record, so there is no id to tamper with and no way to phrase
 *     a request for somebody else. That is the whole security design, and it is
 *     why this is a separate endpoint rather than a `?student_id=me` branch
 *     bolted onto finance.php.
 *   - GET only. Read-only.
 *
 * A non-student with `overview` reaches this and gets `is_student: false` with
 * empty figures — there is no "their own data" for an account that is not a
 * student, and inventing a fallback would be inventing a number.
 *
 * The two figures follow the conventions already in the codebase rather than
 * new ones: the balance is the latest finance row by `date DESC, finance_id
 * DESC` (the ordering finance-summary.php and risk_model_service.php use), and
 * the attendance rate is SUM(present) / SUM(total_classes_conducted), the
 * calculation in attendance-summary.php. A student reading a different number
 * on their own dashboard than the office reads about them would be worse than
 * showing nothing.
 */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';

function student_overview_out(int $code, array $payload): void
{
    http_response_code($code);
    echo json_encode($payload);
    exit;
}

try {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        student_overview_out(405, ['message' => 'Method not allowed']);
    }

    $db = new Database();
    $pdo = $db->connect();

    $authUser = api_get_session_user();
    $userId = (int)($authUser['user_id'] ?? 0);
    if ($userId <= 0) {
        student_overview_out(401, ['message' => 'Authentication required']);
    }

    /*
     * The session's own student record. `user_id` on `student` is the only link
     * used; nothing from the query string reaches this.
     */
    $meStmt = $pdo->prepare(
        'SELECT s.student_id, s.student_number, s.year_level, s.section,
                c.course_code, c.course_name, c.course_id,
                d.department_name, cam.campus_name
           FROM student s
      LEFT JOIN course c ON c.course_id = s.course_id
      LEFT JOIN department d ON d.department_id = c.department_id
      LEFT JOIN campus cam ON cam.campus_id = d.campus_id
          WHERE s.user_id = :user_id
          LIMIT 1'
    );
    $meStmt->execute([':user_id' => $userId]);
    $me = $meStmt->fetch(PDO::FETCH_ASSOC);

    if (!$me) {
        // Not a student account, or a student account never linked to a record.
        // Both are "there is no own data here", which the dashboard renders as
        // dashes rather than as an error.
        student_overview_out(200, [
            'is_student' => false,
            'student' => null,
            'finance' => null,
            'attendance' => null,
        ]);
    }

    $studentId = (int)$me['student_id'];

    /*
     * Balance: the latest row, plus the one before it so the card can say which
     * way it moved. Same ordering as finance-summary.php.
     */
    $financeStmt = $pdo->prepare(
        'SELECT f.balance_to_data AS balance,
                f.`date`          AS recorded_on,
                st.status_name    AS tier_name,
                sem.semester_name,
                sy.schoolyear_name,
                (SELECT f2.balance_to_data FROM finance f2
                  WHERE f2.student_id = f.student_id AND f2.`date` < f.`date`
               ORDER BY f2.`date` DESC, f2.finance_id DESC LIMIT 1) AS previous_balance
           FROM finance f
      LEFT JOIN status st ON st.status_id = f.balance_range
      LEFT JOIN semester sem ON sem.semester_id = f.semester_id
      LEFT JOIN school_year sy ON sy.school_year_id = f.school_year_id
          WHERE f.student_id = :student_id
       ORDER BY f.`date` DESC, f.finance_id DESC
          LIMIT 1'
    );
    $financeStmt->execute([':student_id' => $studentId]);
    $financeRow = $financeStmt->fetch(PDO::FETCH_ASSOC);

    $finance = null;
    if ($financeRow && $financeRow['balance'] !== null) {
        $balance = (float)$financeRow['balance'];
        $previous = $financeRow['previous_balance'] !== null ? (float)$financeRow['previous_balance'] : null;
        $finance = [
            'balance' => $balance,
            'previous_balance' => $previous,
            // Signed, so the card does not have to subtract two numbers it was
            // given separately and risk describing the move backwards.
            'change' => $previous === null ? null : round($balance - $previous, 2),
            'recorded_on' => $financeRow['recorded_on'],
            'tier_name' => $financeRow['tier_name'],
            'term' => trim((string)($financeRow['schoolyear_name'] ?? '') . ' ' . (string)($financeRow['semester_name'] ?? '')) ?: null,
        ];
    }

    /*
     * Attendance across every term on record, which is what "my attendance"
     * means to the person asking. total_classes_conducted is the denominator
     * everywhere else in this codebase, and a zero denominator yields null
     * rather than 0% - never attending and never having had a class are
     * different facts, and only one of them is the student's.
     */
    $attendanceStmt = $pdo->prepare(
        'SELECT COALESCE(SUM(total_classes_conducted), 0) AS total_classes,
                COALESCE(SUM(present), 0) AS present,
                COALESCE(SUM(absent), 0)  AS absent,
                COUNT(*) AS term_count
           FROM attendance
          WHERE student_id = :student_id'
    );
    $attendanceStmt->execute([':student_id' => $studentId]);
    $attendanceRow = $attendanceStmt->fetch(PDO::FETCH_ASSOC) ?: [];

    $attendance = null;
    if ((int)($attendanceRow['term_count'] ?? 0) > 0) {
        $totalClasses = (int)$attendanceRow['total_classes'];
        $present = (int)$attendanceRow['present'];
        $absent = (int)$attendanceRow['absent'];
        $attendance = [
            'total_classes' => $totalClasses,
            'present' => $present,
            'absent' => $absent,
            'rate' => $totalClasses > 0 ? round(($present / $totalClasses) * 100, 2) : null,
            // The absent share of the same classes, rounded the same way, so
            // the card's two percentages are both this endpoint's arithmetic.
            'absent_rate' => $totalClasses > 0 ? round(($absent / $totalClasses) * 100, 2) : null,
            'terms_recorded' => (int)$attendanceRow['term_count'],
        ];
    }

    student_overview_out(200, [
        'is_student' => true,
        'student' => [
            'student_number' => $me['student_number'],
            'year_level' => $me['year_level'] !== null ? (int)$me['year_level'] : null,
            'section' => $me['section'],
            'course_code' => $me['course_code'],
            'course_name' => $me['course_name'],
            'department_name' => $me['department_name'],
            'campus_name' => $me['campus_name'],
        ],
        'finance' => $finance,
        'attendance' => $attendance,
    ]);
} catch (Throwable $e) {
    api_log_exception($e, ['scope' => 'student_overview']);
    student_overview_out(500, ['message' => 'Server error while loading your overview.']);
}
