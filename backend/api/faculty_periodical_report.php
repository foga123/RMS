<?php
require_once __DIR__ . '/middleware/auth.php';
api_send_headers(['GET', 'OPTIONS']);
api_handle_preflight();
require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/faculty_periodical_report.php';

try {
    $user = api_get_session_user();
    if (!$user) { api_out(401, ['message' => 'Authentication required']); }
    $pdo = (new Database())->connect();
    $calendar = academic_calendar_current($pdo);
    $options = [
        'school_years' => $pdo->query('SELECT school_year_id AS id, schoolyear_name AS label FROM school_year ORDER BY schoolyear_name DESC')->fetchAll(PDO::FETCH_ASSOC),
        'semesters' => $pdo->query('SELECT semester_id AS id, semester_name AS label FROM semester ORDER BY semester_id')->fetchAll(PDO::FETCH_ASSOC),
    ];
    if (($_GET['action'] ?? '') === 'options') {
        api_out(200, ['options' => $options, 'term' => array_intersect_key($calendar, array_flip(['school_year_id','semester_id','period']))]);
    }
    $filters = faculty_report_filters($_GET, $calendar);
    $report = faculty_report_data($pdo, $user, $filters);
    if ($filters['student_id'] && !$report['rows']) {
        api_out(404, ['message' => 'Student not available in your report scope.']);
    }
    api_out(200, $report);
} catch (InvalidArgumentException $error) {
    api_out(400, ['message' => $error->getMessage()]);
} catch (Throwable $error) {
    api_log_exception($error, ['scope' => 'faculty_periodical_report']);
    api_out(500, ['message' => 'Could not load the faculty periodical report.']);
}
