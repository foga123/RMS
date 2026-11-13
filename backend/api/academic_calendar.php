<?php
/**
 * The academic calendar: term dates, the manual pin, and the resolved answer.
 *
 * GET is read by four screens -- the Settings panel that maintains this, and
 * the Grades, Attendance and Finance pages that fill their import pickers from
 * it. That is why the GET permission in auth.php is the widest in the map and
 * the writes are not: see the note beside 'academic_calendar.php' there.
 *
 * The resolving itself lives in lib/academic_calendar.php. This file is the
 * door: it validates what comes in, writes it, and says what happened.
 */

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/academic_calendar.php';
// Which semesters are closed travels with the calendar: every screen that
// records against a term already reads this, so it learns the lock for free.
require_once __DIR__ . '/lib/term_closure.php';

api_send_headers(['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS']);
api_handle_preflight();

/**
 * A real calendar date in Y-m-d, or null.
 *
 * checkdate() through DateTime rather than strtotime(), because strtotime()
 * accepts "2026-02-31" and quietly answers 3 March. A term that starts on a day
 * that does not exist should be refused, not moved.
 */
function academic_calendar_date($value): ?string
{
    $text = trim((string)$value);
    if ($text === '') {
        return null;
    }
    $parsed = DateTime::createFromFormat('Y-m-d', $text);
    $errors = DateTime::getLastErrors();
    if (!$parsed || ($errors && ($errors['warning_count'] || $errors['error_count']))) {
        return null;
    }
    return $parsed->format('Y-m-d');
}

/** Everything the calendar screen and the import pickers need, in one read. */
function academic_calendar_get_payload(PDO $pdo): array
{
    $years = $pdo->query('SELECT school_year_id, schoolyear_name, is_current FROM school_year ORDER BY schoolyear_name DESC')
                 ->fetchAll(PDO::FETCH_ASSOC) ?: [];
    foreach ($years as $index => $year) {
        $years[$index]['school_year_id'] = (int)$year['school_year_id'];
        $years[$index]['is_current'] = (int)($year['is_current'] ?? 0) === 1;
    }

    $semesters = $pdo->query('SELECT semester_id, semester_name FROM semester ORDER BY semester_id')
                     ->fetchAll(PDO::FETCH_ASSOC) ?: [];
    foreach ($semesters as $index => $semester) {
        $semesters[$index]['semester_id'] = (int)$semester['semester_id'];
    }

    $settings = academic_calendar_settings($pdo);

    /*
     * The current term says whether it is closed, because the screens that
     * record against it - the Contact, Faculty and Home Visit workspaces - have
     * nothing else to go on, and a closed current term refuses their saves.
     */
    $current = academic_calendar_current($pdo);
    if (is_array($current)) {
        $currentClosure = term_closure_find($pdo, $current['school_year_id'] ?? null, $current['semester_id'] ?? null);
        $current['is_closed'] = $currentClosure !== null;
        $current['closed_note'] = $currentClosure !== null ? term_closure_sentence($currentClosure) : null;
    }

    return [
        'current' => $current,
        // Every closed semester, for the import pickers and edit forms to say
        // "closed" before a save is refused rather than after.
        'closed_terms' => term_closure_list($pdo),
        'settings' => [
            'mode' => $settings['mode'],
            'manual_school_year_id' => academic_calendar_pin_int($settings['manual_school_year_id']),
            'manual_semester_id' => academic_calendar_pin_int($settings['manual_semester_id']),
            'manual_period' => academic_calendar_pin_int($settings['manual_period']),
        ],
        'terms' => academic_calendar_terms($pdo),
        'school_years' => $years,
        'semesters' => $semesters,
        'today' => date('Y-m-d'),
    ];
}

/** Saves the mode and the pin. Blank clears a pin field. */
function academic_calendar_put_settings(PDO $pdo, ?array $actor): void
{
    $payload = api_read_json_body();

    /*
     * The mode must be said, not assumed.
     *
     * Defaulting an absent key to 'auto' made a body with no fields at all --
     * `{}`, or a truncated request -- read as a deliberate switch away from
     * manual, which blanks all three pins below and answers 200. The calendar
     * drives every import, so that silently moves which term the next import
     * lands in, and it looks like it worked.
     */
    if (!array_key_exists('mode', $payload)) {
        api_json_response(400, ['message' => 'Mode must be either auto or manual.']);
    }
    $mode = strtolower(trim((string)$payload['mode']));
    if (!in_array($mode, ['auto', 'manual'], true)) {
        api_json_response(400, ['message' => 'Mode must be either auto or manual.']);
    }

    $yearId = academic_calendar_pin_int($payload['manual_school_year_id'] ?? '');
    $activeYear = academic_calendar_dated_term($pdo) ?? academic_calendar_current_year_only($pdo);
    if ($mode === 'manual' && $yearId !== null && $yearId !== $activeYear['school_year_id']) {
        api_json_response(400, ['message' => 'The school year follows the active academic calendar and cannot be pinned to another year.']);
    }
    $yearId = $mode === 'manual' ? $activeYear['school_year_id'] : null;
    $semesterId = academic_calendar_pin_int($payload['manual_semester_id'] ?? '');
    $period = academic_calendar_pin_int($payload['manual_period'] ?? '');

    if ($period !== null && ($period < 1 || $period > 3)) {
        api_json_response(400, ['message' => 'The periodical must be 1, 2 or 3.']);
    }

    /*
     * Manual mode needs at least a school year.
     *
     * Refused here rather than resolved silently later. The library falls back
     * to the dates when the pin is unusable, which is right for a pin that has
     * gone stale -- but a pin somebody is saving right now, on purpose, should
     * fail in front of them instead of appearing to work and doing nothing.
     */
    if ($mode === 'manual' && $yearId === null) {
        api_json_response(400, ['message' => 'Choose a school year to pin before switching to manual.']);
    }
    if ($yearId !== null) {
        $check = $pdo->prepare('SELECT 1 FROM school_year WHERE school_year_id = :id LIMIT 1');
        $check->execute([':id' => $yearId]);
        if (!$check->fetchColumn()) {
            api_json_response(400, ['message' => 'That school year does not exist.']);
        }
    }
    if ($semesterId !== null) {
        $check = $pdo->prepare('SELECT 1 FROM semester WHERE semester_id = :id LIMIT 1');
        $check->execute([':id' => $semesterId]);
        if (!$check->fetchColumn()) {
            api_json_response(400, ['message' => 'That semester does not exist.']);
        }
    }

    $before = academic_calendar_settings($pdo);
    $values = [
        'mode' => $mode,
        'manual_school_year_id' => $yearId === null ? '' : (string)$yearId,
        'manual_semester_id' => $semesterId === null ? '' : (string)$semesterId,
        'manual_period' => $period === null ? '' : (string)$period,
    ];

    $save = $pdo->prepare(
        'INSERT INTO academic_calendar_setting (setting_key, setting_value, description)
         VALUES (:key, :value, :description)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
    );
    $pdo->beginTransaction();
    try {
        foreach ($values as $key => $value) {
            $save->execute([
                ':key' => $key,
                ':value' => $value,
                // Only ever used when a row is missing; the UPDATE branch above
                // leaves whatever the migration wrote.
                ':description' => ACADEMIC_CALENDAR_DEFAULTS[$key] === $value ? 'Default.' : 'Set from Settings.',
            ]);
        }
        $pdo->commit();
    } catch (Throwable $e) {
        if ($pdo->inTransaction()) $pdo->rollBack();
        throw $e;
    }

    $resolved = academic_calendar_current($pdo);
    api_write_audit_log(
        $pdo,
        $actor,
        'settings_update',
        $mode === 'manual'
            ? 'Pinned the current term to ' . $resolved['label']
            : 'Set the current term to follow the calendar dates',
        ['before' => $before, 'after' => $values, 'resolved' => $resolved['label']]
    );

    api_json_response(200, [
        'message' => $mode === 'manual'
            ? 'Imports will now default to ' . $resolved['label'] . '.'
            : 'The current term will follow the calendar dates.',
        'data' => academic_calendar_get_payload($pdo),
    ]);
}

/**
 * Creates or updates one dated window.
 *
 * Upserts on the unique (year, semester, period) key rather than refusing a
 * duplicate, because "set P1's dates" and "correct P1's dates" are the same act
 * from the panel's side and there is only ever one P1 per semester.
 */
function academic_calendar_save_term(PDO $pdo, ?array $actor): void
{
    $payload = api_read_json_body();

    $yearId = academic_calendar_pin_int($payload['school_year_id'] ?? '');
    $semesterId = academic_calendar_pin_int($payload['semester_id'] ?? '');
    $period = academic_calendar_pin_int($payload['period'] ?? '');
    $startsOn = academic_calendar_date($payload['starts_on'] ?? '');
    $endsOn = academic_calendar_date($payload['ends_on'] ?? '');

    if ($yearId === null) api_json_response(400, ['message' => 'Choose a school year.']);
    if ($semesterId === null) api_json_response(400, ['message' => 'Choose a semester.']);
    if ($period === null || $period < 1 || $period > 3) {
        api_json_response(400, ['message' => 'The periodical must be P1, P2 or P3.']);
    }
    if ($startsOn === null) api_json_response(400, ['message' => 'Enter a valid start date.']);
    if ($endsOn === null) api_json_response(400, ['message' => 'Enter a valid end date.']);
    if ($endsOn < $startsOn) {
        api_json_response(400, ['message' => 'The end date cannot fall before the start date.']);
    }

    $year = $pdo->prepare('SELECT schoolyear_name FROM school_year WHERE school_year_id = :id LIMIT 1');
    $year->execute([':id' => $yearId]);
    $yearName = $year->fetchColumn();
    if ($yearName === false) api_json_response(400, ['message' => 'That school year does not exist.']);

    $semester = $pdo->prepare('SELECT semester_name FROM semester WHERE semester_id = :id LIMIT 1');
    $semester->execute([':id' => $semesterId]);
    $semesterName = $semester->fetchColumn();
    if ($semesterName === false) api_json_response(400, ['message' => 'That semester does not exist.']);

    /*
     * Overlaps are refused on the way in, not resolved on the way out.
     *
     * Only one term can be "now", so two windows containing the same day is not
     * a case with a right answer -- it is a typo. Catching it here means the
     * resolver never has to choose between two true rows, and the person who
     * mistyped 2026 for 2025 finds out immediately rather than three weeks later
     * when imports start landing in the wrong semester.
     *
     * Two windows overlap when each starts before the other ends. The row being
     * edited is excluded from its own check.
     */
    $clash = $pdo->prepare(
        'SELECT t.period, sy.schoolyear_name, s.semester_name, t.starts_on, t.ends_on
           FROM academic_term t
           JOIN school_year sy ON sy.school_year_id = t.school_year_id
           JOIN semester s ON s.semester_id = t.semester_id
          WHERE t.starts_on <= :ends_on
            AND t.ends_on >= :starts_on
            AND NOT (t.school_year_id = :year_id AND t.semester_id = :semester_id AND t.period = :period)
          LIMIT 1'
    );
    $clash->execute([
        ':ends_on' => $endsOn,
        ':starts_on' => $startsOn,
        ':year_id' => $yearId,
        ':semester_id' => $semesterId,
        ':period' => $period,
    ]);
    $conflict = $clash->fetch(PDO::FETCH_ASSOC);
    if ($conflict) {
        api_json_response(409, ['message' => sprintf(
            'Those dates overlap %s of %s, %s (%s to %s). Terms cannot share a day.',
            academic_calendar_period_label((int)$conflict['period']),
            $conflict['semester_name'],
            $conflict['schoolyear_name'],
            $conflict['starts_on'],
            $conflict['ends_on']
        )]);
    }

    $save = $pdo->prepare(
        'INSERT INTO academic_term (school_year_id, semester_id, period, starts_on, ends_on, created_by_user_id)
         VALUES (:year_id, :semester_id, :period, :starts_on, :ends_on, :user_id)
         ON DUPLICATE KEY UPDATE starts_on = VALUES(starts_on), ends_on = VALUES(ends_on)'
    );
    $save->execute([
        ':year_id' => $yearId,
        ':semester_id' => $semesterId,
        ':period' => $period,
        ':starts_on' => $startsOn,
        ':ends_on' => $endsOn,
        ':user_id' => $actor['user_id'] ?? null,
    ]);

    $label = academic_calendar_period_label($period) . ' - ' . $semesterName . ' - ' . $yearName;
    api_write_audit_log($pdo, $actor, 'settings_update', "Set term dates for $label", [
        'school_year_id' => $yearId,
        'semester_id' => $semesterId,
        'period' => $period,
        'starts_on' => $startsOn,
        'ends_on' => $endsOn,
    ]);

    api_json_response(200, [
        'message' => "$label runs from $startsOn to $endsOn.",
        'data' => academic_calendar_get_payload($pdo),
    ]);
}

/** Removes one dated window. The pin, if any, is untouched. */
function academic_calendar_delete_term(PDO $pdo, ?array $actor): void
{
    $termId = academic_calendar_pin_int($_GET['term_id'] ?? '');
    if ($termId === null) {
        api_json_response(400, ['message' => 'Which term?']);
    }

    $find = $pdo->prepare(
        'SELECT t.period, t.starts_on, t.ends_on, sy.schoolyear_name, s.semester_name
           FROM academic_term t
           JOIN school_year sy ON sy.school_year_id = t.school_year_id
           JOIN semester s ON s.semester_id = t.semester_id
          WHERE t.term_id = :id LIMIT 1'
    );
    $find->execute([':id' => $termId]);
    $row = $find->fetch(PDO::FETCH_ASSOC);
    if (!$row) {
        api_json_response(404, ['message' => 'That term is not on the calendar.']);
    }

    $pdo->prepare('DELETE FROM academic_term WHERE term_id = :id')->execute([':id' => $termId]);

    $label = academic_calendar_period_label((int)$row['period']) . ' - ' . $row['semester_name'] . ' - ' . $row['schoolyear_name'];
    api_write_audit_log($pdo, $actor, 'settings_update', "Removed term dates for $label", [
        'term_id' => $termId,
        'starts_on' => $row['starts_on'],
        'ends_on' => $row['ends_on'],
    ]);

    api_json_response(200, [
        'message' => "Removed the dates for $label.",
        'data' => academic_calendar_get_payload($pdo),
    ]);
}

try {
    $db = new Database();
    $pdo = $db->connect();

    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $actor = api_get_session_user();
    if (!$actor || empty($actor['user_id'])) {
        api_json_response(401, ['message' => 'Authentication required']);
    }

    if ($method === 'GET') {
        api_json_response(200, [
            'message' => 'Academic calendar loaded.',
            'data' => academic_calendar_get_payload($pdo),
        ]);
    }

    if ($method === 'PUT') {
        academic_calendar_put_settings($pdo, $actor);
    }

    if ($method === 'POST') {
        academic_calendar_save_term($pdo, $actor);
    }

    if ($method === 'DELETE') {
        academic_calendar_delete_term($pdo, $actor);
    }

    api_json_response(405, ['message' => 'Method not allowed']);
} catch (Throwable $e) {
    error_log('academic_calendar.php: ' . $e->getMessage());
    api_json_response(500, ['message' => 'Could not read the academic calendar.']);
}
