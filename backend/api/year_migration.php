<?php
/**
 * Year-end evaluation: classify each student for a school year, then move year levels.
 *
 * The rules and why they are shaped this way are in lib/year_migration.php.
 * This file is the door: who may look, who may change anything, and the shape
 * of the answer.
 *
 * GET  year_migration.php?school_year_id=          (default: the calendar's year)
 *        &department_id= &course_id= &year_level= &campus_id=   the population
 *        &classification= &state= &search= &page= &limit=        the list only
 * POST {action: "override", school_year_id, student_id, classification, reason}
 *        an evaluator's decision for one student; classification null clears it
 * POST {action: "apply", school_year_id, department_id?, course_id?, year_level?, campus_id?}
 *        record every "ready" student in that population and move their year
 * POST {action: "revert", school_year_id, student_id}
 *        put one applied student back exactly as Apply found them
 * POST {action: "settings", values: {...}}
 *        the cut-offs (settings:edit)
 *
 * WHO
 *   Reading is the Student Migration module (`student_migration:view`), scoped by
 *   lib/migration_scope.php - the same students the migration page shows, so a
 *   dean evaluates and applies only within their department. Every write moves
 *   a student record, so it also needs `student_manage:edit`, the permission
 *   that already governs year_level on the student form. The Migration module
 *   itself stays read-only in RBAC terms: no new action, no new grants.
 */

require_once __DIR__ . '/middleware/auth.php';

api_send_headers(['GET', 'POST', 'OPTIONS']);
api_handle_preflight();

require_once __DIR__ . '/connection-pdo.php';
require_once __DIR__ . '/lib/migration_scope.php';
require_once __DIR__ . '/lib/year_migration.php';
require_once __DIR__ . '/lib/academic_calendar.php';
// School years order by name, not id: "the year before" is a name comparison.
require_once __DIR__ . '/lib/school_year_window.php';

/**
 * The school year asked for, else the one the calendar says is ending, else the newest by name.
 *
 * "Ending", not "current": a year-end evaluation reviews a year that is over or
 * nearly over. While the calendar is in a year's FIRST semester, the year that
 * just finished is the previous one - evaluating the year that started last
 * month would find nothing but Pending. From the 2nd semester on, it is this one.
 */
function year_migration_pick_year(PDO $pdo, $asked): ?array
{
    $id = $asked !== null && $asked !== '' ? (int)$asked : 0;
    if ($id <= 0) {
        $current = academic_calendar_current($pdo);
        $id = (int)($current['school_year_id'] ?? 0);
        $required = year_migration_required_semesters($pdo);
        $firstSemester = $required ? (int)$required[0]['semester_id'] : 0;
        if ($id > 0 && (int)($current['semester_id'] ?? 0) === $firstSemester) {
            $previous = sy_window_previous($pdo, $id);
            if ($previous !== null) {
                $id = $previous['school_year_id'];
            }
        }
    }
    $stmt = $pdo->prepare('SELECT school_year_id, schoolyear_name FROM school_year WHERE school_year_id = :id');
    $stmt->execute([':id' => $id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row && ($asked === null || $asked === '')) {
        $row = $pdo->query('SELECT school_year_id, schoolyear_name FROM school_year ORDER BY schoolyear_name DESC LIMIT 1')->fetch(PDO::FETCH_ASSOC);
    }
    return $row ? ['school_year_id' => (int)$row['school_year_id'], 'schoolyear_name' => (string)$row['schoolyear_name']] : null;
}

/** One student, if they are inside the caller's scope. */
function year_migration_scoped_student(PDO $pdo, array $scope, int $studentId): ?array
{
    $stmt = $pdo->prepare("
        SELECT s.student_id, s.year_level, s.section, s.is_irregular, c.course_code, c.year_duration
          FROM student s
          JOIN course c ON c.course_id = s.course_id
         WHERE s.student_id = :year_migration_sid AND {$scope['sql']}
         LIMIT 1");
    $stmt->execute(array_merge($scope['params'], [':year_migration_sid' => $studentId]));
    return $stmt->fetch(PDO::FETCH_ASSOC) ?: null;
}

/** One evaluated student as the screen shows it. */
function year_migration_row(array $e): array
{
    $s = $e['student'];
    return [
        'student_id' => (int)$s['student_id'],
        'student_number' => $s['student_number'],
        'name' => trim(implode(', ', array_filter([(string)$s['last_name'], trim(((string)$s['first_name']) . ' ' . ((string)($s['middle_name'] ?? '')))]))),
        'course_code' => $s['course_code'],
        'year_duration' => $s['year_duration'] !== null ? (int)$s['year_duration'] : null,
        'state' => $e['state'],
        'classification' => $e['classification'],
        'computed_classification' => $e['computed']['classification'],
        'reasons' => $e['state'] === 'applied' ? $e['applied']['reasons'] : $e['computed']['reasons'],
        'subjects_total' => $e['computed']['subjects_total'],
        'subjects_failed' => $e['computed']['subjects_failed'],
        'balance' => $e['computed']['balance'],
        'override' => $e['override'],
        'applied' => $e['state'] === 'applied' ? ['at' => $e['applied']['at'], 'by_user_id' => $e['applied']['by_user_id']] : null,
        'superseded_by' => $e['superseded_by'] ?? null,
        'from' => $e['from'],
        'to' => $e['to'],
    ];
}

try {
    $authUser = api_get_session_user();
    if (!$authUser || empty($authUser['user_id'])) {
        api_out(401, ['message' => 'Authentication required']);
    }
    $permissions = $authUser['permissions'] ?? [];
    if (!api_can($permissions, 'student_migration', 'view')) {
        api_out(403, ['message' => 'The year-end evaluation is part of Student Migration, which this account cannot open.']);
    }

    $pdo = (new Database())->connect();
    if (!api_table_exists($pdo, 'student_year_migration')) {
        api_out(503, ['message' => 'The year-end migration tables are not installed. Apply migrations/2026_10_06_year_end_migration.sql.']);
    }
    $canApply = api_can($permissions, 'student_manage', 'edit');
    $canEditSettings = api_can($permissions, 'settings', 'edit');
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

    // ------------------------------------------------------------------ GET
    if ($method === 'GET') {
        $year = year_migration_pick_year($pdo, $_GET['school_year_id'] ?? null);
        if ($year === null) {
            api_out(404, ['message' => 'That school year does not exist.']);
        }
        $scope = migration_scope($authUser, $_GET);
        if ($scope['error'] !== null) {
            api_out(400, ['message' => $scope['error']]);
        }

        $evaluated = year_migration_evaluate($pdo, $scope['sql'], $scope['params'], $year['school_year_id']);
        $classes = year_migration_classes();
        $semesters = year_migration_required_semesters($pdo);

        // Counted over the whole population, before the list filters below, so
        // the chips and the Apply button describe what Apply would touch.
        $byClass = array_fill_keys(array_keys($classes), 0);
        $byState = ['ready' => 0, 'applied' => 0, 'pending' => 0, 'superseded' => 0];
        $byYear = [];
        $readyByClass = array_fill_keys(array_keys($classes), 0);
        $readyMovesUp = 0;
        foreach ($evaluated as $e) {
            $byClass[$e['classification']] = ($byClass[$e['classification']] ?? 0) + 1;
            $byState[$e['state']]++;
            $year0 = $e['from']['year_level'] ?? 0;
            $byYear[$year0] ??= array_fill_keys(array_keys($classes), 0);
            $byYear[$year0][$e['classification']]++;
            if ($e['state'] === 'ready') {
                $readyByClass[$e['classification']]++;
                if (($e['to']['year_level'] ?? 0) > ($e['from']['year_level'] ?? 0)) $readyMovesUp++;
            }
        }
        ksort($byYear);

        // How much of the year is on record, per required semester: the reason
        // a board full of Pending is Pending.
        $coverage = [];
        $evidence = year_migration_evidence($pdo, $year['school_year_id']);
        foreach ($semesters as $semester) {
            $semId = (int)$semester['semester_id'];
            $final = 0;
            $any = 0;
            foreach ($evaluated as $e) {
                $state = year_migration_semester_state($evidence['grades'][(int)$e['student']['student_id']][$semId] ?? []);
                if ($state['state'] !== 'none') $any++;
                if ($state['state'] === 'final') $final++;
            }
            $coverage[] = ['semester_id' => $semId, 'semester_name' => $semester['semester_name'], 'students_with_grades' => $any, 'students_with_final_grades' => $final];
        }

        $filterClass = trim((string)($_GET['classification'] ?? ''));
        $filterState = trim((string)($_GET['state'] ?? ''));
        $search = mb_strtolower($scope['search']);
        $list = array_values(array_filter($evaluated, static function (array $e) use ($filterClass, $filterState, $search): bool {
            if ($filterClass !== '' && $e['classification'] !== $filterClass) return false;
            if ($filterState !== '' && $e['state'] !== $filterState) return false;
            if ($search !== '') {
                $s = $e['student'];
                $hay = mb_strtolower($s['student_number'] . ' ' . $s['last_name'] . ' ' . $s['first_name'] . ' ' . ($s['middle_name'] ?? ''));
                if (strpos($hay, $search) === false) return false;
            }
            return true;
        }));
        $page = max(1, (int)($_GET['page'] ?? 1));
        $limit = max(1, min(200, (int)($_GET['limit'] ?? 25)));

        $years = $pdo->query('SELECT school_year_id, schoolyear_name FROM school_year ORDER BY schoolyear_name DESC')->fetchAll(PDO::FETCH_ASSOC) ?: [];
        $classList = [];
        foreach ($classes as $key => $class) {
            $classList[] = ['key' => $key] + $class;
        }

        api_out(200, [
            'school_year' => $year,
            'school_years' => $years,
            'semesters' => $coverage,
            'classes' => $classList,
            'settings' => year_migration_settings($pdo),
            'setting_specs' => year_migration_setting_specs(),
            'summary' => [
                'students' => count($evaluated),
                'by_class' => $byClass,
                'by_state' => $byState,
                'by_year' => array_map(static fn($y, $counts) => ['year_level' => $y ?: null, 'by_class' => $counts], array_keys($byYear), $byYear),
                'ready_by_class' => $readyByClass,
                'ready_moves_up' => $readyMovesUp,
            ],
            'students' => array_map('year_migration_row', array_slice($list, ($page - 1) * $limit, $limit)),
            'pagination' => ['page' => $page, 'limit' => $limit, 'total' => count($list)],
            'can_apply' => $canApply,
            'can_edit_settings' => $canEditSettings,
        ]);
    }

    // ----------------------------------------------------------------- POST
    if ($method !== 'POST') {
        api_out(405, ['message' => 'Method not allowed']);
    }
    $p = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($p)) {
        api_out(400, ['message' => 'Invalid JSON']);
    }
    $action = (string)($p['action'] ?? '');

    if ($action === 'settings') {
        if (!$canEditSettings) {
            api_out(403, ['message' => 'Changing the cut-offs needs Settings edit access.']);
        }
        $checked = year_migration_settings_validate(is_array($p['values'] ?? null) ? $p['values'] : []);
        if ($checked['error'] !== null) {
            api_out(400, ['message' => $checked['error']]);
        }
        $before = year_migration_settings($pdo);
        year_migration_settings_save($pdo, $checked['values']);
        $after = year_migration_settings($pdo);
        api_write_audit_log($pdo, $authUser, 'year_migration_settings_changed', 'Changed the year-end migration cut-offs.', ['before' => $before, 'after' => $after]);
        api_out(200, ['message' => 'Cut-offs saved.', 'settings' => $after]);
    }

    if (!$canApply) {
        api_out(403, ['message' => 'Moving a year level edits the student record, which needs Student Management edit access.']);
    }
    if (!in_array($action, ['override', 'apply', 'revert'], true)) {
        api_out(400, ['message' => 'Unknown action.']);
    }

    $year = year_migration_pick_year($pdo, isset($p['school_year_id']) ? (string)$p['school_year_id'] : '');
    if ($year === null || (int)($p['school_year_id'] ?? 0) <= 0) {
        api_out(400, ['message' => 'Choose the school year being evaluated.']);
    }
    $syId = $year['school_year_id'];
    $userId = (int)$authUser['user_id'];

    if ($action === 'override' || $action === 'revert') {
        $studentId = (int)($p['student_id'] ?? 0);
        $scope = migration_scope($authUser, []);
        if ($scope['error'] !== null) {
            api_out(400, ['message' => $scope['error']]);
        }
        $student = $studentId > 0 ? year_migration_scoped_student($pdo, $scope, $studentId) : null;
        if ($student === null) {
            api_out(404, ['message' => 'Student not found in your scope.']);
        }

        if ($action === 'revert') {
            $pdo->beginTransaction();
            $error = year_migration_revert($pdo, $studentId, $syId);
            if ($error !== null) {
                $pdo->rollBack();
                api_out(409, ['message' => $error]);
            }
            $pdo->commit();
            api_write_audit_log($pdo, $authUser, 'year_migration_reverted', sprintf('Reverted the %s year-end migration of student #%d.', $year['schoolyear_name'], $studentId), ['student_id' => $studentId, 'school_year_id' => $syId]);
            api_out(200, ['message' => 'Put back as it was before Apply.']);
        }

        // override
        $existing = $pdo->prepare('SELECT applied_at FROM student_year_migration WHERE student_id = :sid AND school_year_id = :sy');
        $existing->execute([':sid' => $studentId, ':sy' => $syId]);
        $appliedAt = $existing->fetchColumn();
        if ($appliedAt !== false && $appliedAt !== null) {
            api_out(409, ['message' => 'This student is already applied for ' . $year['schoolyear_name'] . '. Revert it first, then change the decision.']);
        }

        $classification = $p['classification'] ?? null;
        if ($classification === null || $classification === '') {
            $pdo->prepare('DELETE FROM student_year_migration WHERE student_id = :sid AND school_year_id = :sy AND applied_at IS NULL')
                ->execute([':sid' => $studentId, ':sy' => $syId]);
            api_out(200, ['message' => 'Override cleared; the rules decide again.']);
        }

        $classification = (string)$classification;
        $refusal = year_migration_override_error($classification, $student);
        if ($refusal !== '') {
            api_out(400, ['message' => $refusal]);
        }
        $reason = trim((string)($p['reason'] ?? ''));
        if (mb_strlen($reason) < 3) {
            api_out(400, ['message' => 'Say why, so the next person reading this knows.']);
        }
        if (mb_strlen($reason) > 255) {
            api_out(400, ['message' => 'Keep the reason under 255 characters.']);
        }
        $unsafe = api_reject_unsafe_fields(['reason' => $reason], ['reason' => 'Reason'], 'prose');
        if ($unsafe !== null) {
            api_out(400, ['message' => $unsafe]);
        }

        $pdo->prepare(
            'INSERT INTO student_year_migration (student_id, school_year_id, override_classification, override_reason, override_by_user_id, override_at)
             VALUES (:sid, :sy, :c, :r, :u, NOW())
             ON DUPLICATE KEY UPDATE override_classification = VALUES(override_classification), override_reason = VALUES(override_reason),
                                     override_by_user_id = VALUES(override_by_user_id), override_at = VALUES(override_at)'
        )->execute([':sid' => $studentId, ':sy' => $syId, ':c' => $classification, ':r' => $reason, ':u' => $userId]);
        api_write_audit_log($pdo, $authUser, 'year_migration_override', sprintf('Set student #%d to %s for %s.', $studentId, year_migration_classes()[$classification]['label'], $year['schoolyear_name']), ['student_id' => $studentId, 'school_year_id' => $syId, 'classification' => $classification, 'reason' => $reason]);
        api_out(200, ['message' => 'Decision saved. It is applied with the rest when you press Apply.']);
    }

    // apply
    $scope = migration_scope($authUser, $p);
    if ($scope['error'] !== null) {
        api_out(400, ['message' => $scope['error']]);
    }
    $pdo->beginTransaction();
    // Locks the year: a second Apply for it waits here, then finds these students applied.
    $pdo->prepare('SELECT school_year_id FROM school_year WHERE school_year_id = :sy FOR UPDATE')->execute([':sy' => $syId]);
    $evaluated = year_migration_evaluate($pdo, $scope['sql'], $scope['params'], $syId);
    $result = year_migration_apply($pdo, $evaluated, $syId, $userId);
    $pdo->commit();

    // After the commit: the audit write can run DDL, which would end an open transaction.
    api_write_audit_log($pdo, $authUser, 'year_migration_applied', sprintf('Applied the %s year-end migration to %d students; %d moved up a year.', $year['schoolyear_name'], $result['applied'], $result['moved_up']), $result + ['school_year_id' => $syId]);
    api_out(200, [
        'message' => $result['applied'] > 0
            ? sprintf('%d student%s recorded; %d moved up a year level.', $result['applied'], $result['applied'] === 1 ? '' : 's', $result['moved_up'])
            : 'Nobody was ready to apply.',
        'result' => $result,
    ]);
} catch (Throwable $e) {
    if (isset($pdo) && $pdo instanceof PDO && $pdo->inTransaction()) {
        $pdo->rollBack();
    }
    api_out(500, ['message' => 'Server error']);
}
