<?php
/**
 * Year-end migration: classify every student for a finished school year, THEN move the year level.
 *
 * Moving up is the result of an evaluation, not the evaluation itself. Before
 * 2026-10-06 the only ways a year level moved were someone typing it, which
 * made "migration" mean "add one". Here each student is first classified from
 * what the year left on record, and the year level follows the classification:
 *
 *   Pending Evaluation     data not final yet          nothing changes
 *   Retained               failed >= the share line    year kept
 *   Irregular - Retained   failed > the advance limit  year kept, marked irregular
 *   Irregular - Advancing  failed 1..the limit         year +1, marked irregular
 *   Migrated               failed nothing              year +1
 *   For Graduation         final year, failed nothing  year kept (no next year)
 *
 * First match wins, in that order. A final-year student with back subjects is
 * Irregular - Retained, not Advancing: there is no next year to advance into,
 * and the back subjects stand between them and graduating.
 *
 * WHAT THE DATA CAN AND CANNOT SAY
 *   `grades` stores subject COUNTS per periodical (total, passed, failed, INC,
 *   no credit, no grade), not one row per subject. So the rules can count failed
 *   subjects but cannot see which subject, whether it was a prerequisite, or its
 *   units. The classification is therefore a proposal: an evaluator can override
 *   any student, with a reason that is kept, and the override wins.
 *
 * WHAT COUNTS AS FINAL
 *   A semester is final when it has its last periodical (P3), or - for a student
 *   tracked without periodicals - a whole-semester row. Every semester except
 *   Summer must be final. "No credit" counts as failed; INC and "no grade" hold
 *   the student at Pending, because both are outcomes still to come.
 *
 * APPLIED ONCE, REVERTIBLE EXACTLY
 *   Apply writes one student_year_migration row per student and school year with
 *   the year level, section and irregular flag before and after. A row already
 *   applied is never applied again, so running Apply twice cannot add two years;
 *   and a student with a LATER school year applied is left alone, so evaluating
 *   an old year cannot move anyone. Revert puts back exactly what Apply changed.
 *
 * Nothing here emits a response or exits; year_migration.php decides how to answer.
 */

require_once __DIR__ . '/student_year_level.php';
require_once __DIR__ . '/../periodic_lib.php';

const YEAR_MIGRATION_PENDING = 'pending';

/** The classifications, in the order the screen lists them. */
function year_migration_classes(): array
{
    return [
        'migrated' => [
            'label' => 'Migrated', 'tone' => 'good', 'advances' => true, 'irregular' => 0,
            'meaning' => 'Passed every subject; moves up one year level.',
        ],
        'irregular_advancing' => [
            'label' => 'Irregular – Advancing', 'tone' => 'warn', 'advances' => true, 'irregular' => 1,
            'meaning' => 'Moves up one year level, carrying back subjects; marked irregular.',
        ],
        'irregular_retained' => [
            'label' => 'Irregular – Retained', 'tone' => 'bad', 'advances' => false, 'irregular' => 1,
            'meaning' => 'Too many back subjects to move up; keeps the year level, marked irregular.',
        ],
        'retained' => [
            'label' => 'Retained', 'tone' => 'bad', 'advances' => false, 'irregular' => 0,
            'meaning' => 'Does not qualify to move up; keeps the year level.',
        ],
        'for_graduation' => [
            'label' => 'For Graduation', 'tone' => 'good', 'advances' => false, 'irregular' => 0,
            'meaning' => 'Final year with nothing failed; there is no next year level to move to.',
        ],
        YEAR_MIGRATION_PENDING => [
            'label' => 'Pending Evaluation', 'tone' => 'none', 'advances' => false, 'irregular' => null,
            'meaning' => 'The year is not on record in full yet; nothing changes until it is.',
        ],
    ];
}

/**
 * The cut-offs, with their bounds. Defaults are placeholders chosen on
 * 2026-10-06, not registrar policy - which is why they are settings.
 */
function year_migration_setting_specs(): array
{
    return [
        'advance_max_failed' => [
            'default' => 2, 'min' => 0, 'max' => 30, 'type' => 'int',
            'label' => 'Most failed subjects that still move up',
        ],
        'retained_min_failed_share' => [
            'default' => 50, 'min' => 1, 'max' => 100, 'type' => 'int',
            'label' => 'Retained when this % of subjects or more are failed',
        ],
        'balance_limit' => [
            'default' => 0, 'min' => 0, 'max' => 10000000, 'type' => 'money',
            'label' => 'A balance above this (₱) holds the student at Pending',
        ],
        'require_attendance' => [
            'default' => 1, 'min' => 0, 'max' => 1, 'type' => 'bool',
            'label' => 'Missing final attendance holds the student at Pending',
        ],
    ];
}

function year_migration_cast_setting(array $spec, $value)
{
    if ($spec['type'] === 'money') {
        return round((float)$value, 2);
    }
    return (int)$value;
}

/** The cut-offs in force: the table's values over the defaults. */
function year_migration_settings(PDO $pdo): array
{
    $specs = year_migration_setting_specs();
    $values = [];
    foreach ($specs as $key => $spec) {
        $values[$key] = $spec['default'];
    }

    if (api_table_exists($pdo, 'year_migration_setting')) {
        $rows = $pdo->query('SELECT setting_key, setting_value FROM year_migration_setting')->fetchAll(PDO::FETCH_KEY_PAIR) ?: [];
        foreach ($rows as $key => $value) {
            if (isset($specs[$key]) && is_numeric($value)) {
                $values[$key] = year_migration_cast_setting($specs[$key], $value);
            }
        }
    }

    return $values;
}

/** ['values' => [...], 'error' => ?string] for a submitted settings form. Only known keys are read. */
function year_migration_settings_validate(array $input): array
{
    $values = [];
    foreach (year_migration_setting_specs() as $key => $spec) {
        if (!array_key_exists($key, $input)) {
            continue;
        }
        $raw = $input[$key];
        if (is_bool($raw)) {
            $raw = $raw ? 1 : 0;
        }
        if (!is_numeric($raw)) {
            return ['values' => [], 'error' => $spec['label'] . ' must be a number.'];
        }
        if ($spec['type'] !== 'money' && (float)$raw != (int)$raw) {
            return ['values' => [], 'error' => $spec['label'] . ' must be a whole number.'];
        }
        $value = year_migration_cast_setting($spec, $raw);
        if ($value < $spec['min'] || $value > $spec['max']) {
            return ['values' => [], 'error' => sprintf('%s must be between %s and %s.', $spec['label'], $spec['min'], $spec['max'])];
        }
        $values[$key] = $value;
    }
    if (!$values) {
        return ['values' => [], 'error' => 'Nothing to save.'];
    }
    return ['values' => $values, 'error' => null];
}

function year_migration_settings_save(PDO $pdo, array $values): void
{
    $specs = year_migration_setting_specs();
    $stmt = $pdo->prepare(
        'INSERT INTO year_migration_setting (setting_key, setting_value, description)
         VALUES (:k, :v, :d)
         ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value)'
    );
    foreach ($values as $key => $value) {
        $stmt->execute([':k' => $key, ':v' => (string)$value, ':d' => $specs[$key]['label']]);
    }
}

/** Every semester a school year must have on record in full: all of them but Summer. */
function year_migration_required_semesters(PDO $pdo): array
{
    $rows = $pdo->query('SELECT semester_id, semester_name FROM semester ORDER BY semester_id')->fetchAll(PDO::FETCH_ASSOC) ?: [];
    return array_values(array_filter(
        $rows,
        static fn(array $row): bool => stripos((string)$row['semester_name'], 'summer') === false
    ));
}

/**
 * Everything one school year left on record, keyed by student.
 *
 *   grades[student][semester][period_key]      the row (period_key 0 = whole semester)
 *   attendance[student][semester][period_key]  true
 *   balance[student]                           the latest reading, or absent
 *
 * The balance is the latest reading of the year - highest semester, then
 * highest periodical - because a balance is a snapshot, never a sum.
 */
function year_migration_evidence(PDO $pdo, int $schoolYearId): array
{
    $grades = [];
    $stmt = $pdo->prepare(
        'SELECT student_id, semester_id, COALESCE(period, 0) AS period_key,
                total_subject, passed, failed, incomplete, no_credit, no_grade
           FROM grades
          WHERE school_year_id = :sy AND archived_at IS NULL'
    );
    $stmt->execute([':sy' => $schoolYearId]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $grades[(int)$row['student_id']][(int)$row['semester_id']][(int)$row['period_key']] = $row;
    }

    $attendance = [];
    $stmt = $pdo->prepare('SELECT student_id, semester_id, COALESCE(period, 0) AS period_key FROM attendance WHERE schoolyear_id = :sy');
    $stmt->execute([':sy' => $schoolYearId]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $attendance[(int)$row['student_id']][(int)$row['semester_id']][(int)$row['period_key']] = true;
    }

    $balance = [];
    $stmt = $pdo->prepare(
        'SELECT student_id, balance_to_data
           FROM finance
          WHERE school_year_id = :sy AND student_id IS NOT NULL AND balance_to_data IS NOT NULL
       ORDER BY student_id, semester_id, COALESCE(period, 0)'
    );
    $stmt->execute([':sy' => $schoolYearId]);
    foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $balance[(int)$row['student_id']] = (float)$row['balance_to_data']; // later rows overwrite: latest wins
    }

    return ['grades' => $grades, 'attendance' => $attendance, 'balance' => $balance];
}

/**
 * Is a semester's record final? For grades or attendance alike.
 *
 * A student with ANY periodical row is tracked by periodical, so a
 * whole-semester row beside them is history and does not make it final - the
 * same precedence the grade, attendance and finance screens use.
 *
 * @return array{state: string, key: ?int, latest: ?int}  state: final | partial | none
 */
function year_migration_semester_state(array $byPeriod): array
{
    if (!$byPeriod) {
        return ['state' => 'none', 'key' => null, 'latest' => null];
    }
    $periodicals = array_filter(array_keys($byPeriod), static fn($k): bool => (int)$k > 0);
    if (!$periodicals) {
        return ['state' => 'final', 'key' => 0, 'latest' => null];
    }
    $finalPeriod = max(API_PERIODS);
    if (isset($byPeriod[$finalPeriod])) {
        return ['state' => 'final', 'key' => $finalPeriod, 'latest' => $finalPeriod];
    }
    return ['state' => 'partial', 'key' => null, 'latest' => (int)max($periodicals)];
}

/**
 * The classification the rules give one student. Pure: no database.
 *
 * $student needs student_id, year_level, year_duration. Returns
 * classification, reasons (sentences), subjects_total, subjects_failed, balance.
 */
function year_migration_classify(array $student, array $evidence, array $semesters, array $settings): array
{
    $sid = (int)$student['student_id'];
    $holds = [];
    $notes = [];
    $total = 0;
    $failed = 0;
    $incomplete = 0;
    $noGrade = 0;
    $finalSemesters = 0;

    if (!$semesters) {
        $holds[] = 'No semesters are defined, so no school year can be complete.';
    }

    foreach ($semesters as $semester) {
        $semId = (int)$semester['semester_id'];
        $name = (string)$semester['semester_name'];

        $grade = year_migration_semester_state($evidence['grades'][$sid][$semId] ?? []);
        if ($grade['state'] === 'none') {
            $holds[] = "No $name grades on record.";
            continue;
        }
        if ($grade['state'] === 'partial') {
            $holds[] = sprintf('%s grades only reach P%d; the final (P%d) grades are not in yet.', $name, $grade['latest'], max(API_PERIODS));
            continue;
        }

        $row = $evidence['grades'][$sid][$semId][$grade['key']];
        $finalSemesters++;
        $total += (int)$row['total_subject'];
        $failed += (int)$row['failed'] + (int)$row['no_credit'];
        $incomplete += (int)$row['incomplete'];
        $noGrade += (int)$row['no_grade'];

        if (!empty($settings['require_attendance'])) {
            $attendance = year_migration_semester_state($evidence['attendance'][$sid][$semId] ?? []);
            if ($attendance['state'] !== 'final') {
                $holds[] = "No final attendance for $name.";
            }
        }
    }

    if ($incomplete > 0) {
        $holds[] = sprintf('%d INC still to be completed.', $incomplete);
    }
    if ($noGrade > 0) {
        $holds[] = sprintf('%d subject%s with no grade yet.', $noGrade, $noGrade === 1 ? '' : 's');
    }
    if ($finalSemesters === count($semesters) && $finalSemesters > 0 && $total <= 0) {
        $holds[] = 'The final grades list no subjects.';
    }

    $balance = $evidence['balance'][$sid] ?? null;
    if ($balance !== null && $balance > (float)$settings['balance_limit']) {
        $holds[] = sprintf('Balance of ₱%s outstanding.', number_format($balance, 2));
    } elseif ($balance === null) {
        $notes[] = 'No balance on record for this school year.';
    }

    $from = isset($student['year_level']) && $student['year_level'] !== null ? (int)$student['year_level'] : null;
    if ($from === null || $from < 1) {
        $holds[] = 'No year level on record.';
    }

    $result = [
        'classification' => YEAR_MIGRATION_PENDING,
        'reasons' => [],
        'subjects_total' => $finalSemesters > 0 ? $total : null,
        'subjects_failed' => $finalSemesters > 0 ? $failed : null,
        'balance' => $balance,
    ];

    if ($holds) {
        $result['reasons'] = array_merge($holds, $notes);
        return $result;
    }

    $duration = (int)($student['year_duration'] ?? 0) ?: 4;
    $finalYear = $from >= $duration;
    $share = $failed / $total * 100;
    $maxFailed = (int)$settings['advance_max_failed'];
    $shareLine = (int)$settings['retained_min_failed_share'];

    if ($failed === 0) {
        $result['classification'] = $finalYear ? 'for_graduation' : 'migrated';
        $result['reasons'][] = sprintf('Passed all %d subjects of the year.', $total)
            . ($finalYear ? sprintf(' Year %d is the last year of this course.', $from) : '');
    } elseif ($share >= $shareLine) {
        $result['classification'] = 'retained';
        $result['reasons'][] = sprintf('Failed %d of %d subjects (%s%%), at or above the %d%% line.', $failed, $total, round($share, 1), $shareLine);
    } elseif ($failed > $maxFailed) {
        $result['classification'] = 'irregular_retained';
        $result['reasons'][] = sprintf('Failed %d subjects; at most %d can move up.', $failed, $maxFailed);
    } elseif ($finalYear) {
        $result['classification'] = 'irregular_retained';
        $result['reasons'][] = sprintf('Failed %d subject%s in the final year; back subjects must be cleared before graduating.', $failed, $failed === 1 ? '' : 's');
    } else {
        $result['classification'] = 'irregular_advancing';
        $result['reasons'][] = sprintf('Failed %d subject%s, within the %d that can move up.', $failed, $failed === 1 ? '' : 's', $maxFailed);
    }

    $result['reasons'] = array_merge($result['reasons'], $notes);
    return $result;
}

/** What a classification does to the student: year level, section and irregular flag after. */
function year_migration_outcome(string $classification, array $student): array
{
    $class = year_migration_classes()[$classification] ?? null;
    $from = isset($student['year_level']) ? (int)$student['year_level'] : null;
    $section = isset($student['section']) && $student['section'] !== '' ? (string)$student['section'] : null;
    $irregular = (int)($student['is_irregular'] ?? 0);

    if ($class === null || $classification === YEAR_MIGRATION_PENDING || $from === null) {
        return ['year_level_to' => $from, 'section_to' => $section, 'irregular_to' => $irregular];
    }

    $to = $class['advances'] ? $from + 1 : $from;
    return [
        'year_level_to' => $to,
        'section_to' => $to !== $from ? student_year_level_section_for($section, $student['course_code'] ?? null, $to) : $section,
        'irregular_to' => $class['irregular'] === null ? $irregular : (int)$class['irregular'],
    ];
}

/**
 * '' when an evaluator may set this classification on this student, otherwise why not.
 *
 * Only the two classes that cannot fit the student's course are refused: moving
 * a final-year student up past their course length, and calling a student who
 * is not in their final year "For Graduation".
 */
function year_migration_override_error(string $classification, array $student): string
{
    $classes = year_migration_classes();
    if (!isset($classes[$classification])) {
        return 'Choose one of: ' . implode(', ', array_column($classes, 'label')) . '.';
    }
    $from = isset($student['year_level']) ? (int)$student['year_level'] : 0;
    $duration = (int)($student['year_duration'] ?? 0) ?: 4;
    $code = (string)($student['course_code'] ?? 'This course');

    if ($classification !== YEAR_MIGRATION_PENDING && $from < 1) {
        return 'This student has no year level on record, so it cannot move. Set it on the student record first.';
    }
    if ($classes[$classification]['advances'] && $from >= $duration) {
        return "$code is a $duration-year programme and this student is in Year $from, so they cannot move up. Use For Graduation or Irregular – Retained.";
    }
    if ($classification === 'for_graduation' && $from < $duration) {
        return "For Graduation is for a student in the final year of their course; this student is in Year $from of $duration.";
    }
    return '';
}

/**
 * Every student in scope with their classification and what Apply would do.
 *
 * state:
 *   applied     done for this year; shows what was applied, not today's rules
 *   superseded  a LATER school year is already applied; this one cannot move them
 *   pending     Pending Evaluation (computed or by override); nothing to apply
 *   ready       Apply will record it and move the year level as shown
 */
function year_migration_evaluate(PDO $pdo, string $scopeSql, array $scopeParams, int $schoolYearId): array
{
    $stmt = $pdo->prepare("
        SELECT s.student_id, s.student_number, s.first_name, s.middle_name, s.last_name,
               s.year_level, s.section, s.is_irregular,
               c.course_id, c.course_code, c.year_duration
          FROM student s
          JOIN course c ON c.course_id = s.course_id
         WHERE $scopeSql
      ORDER BY s.last_name, s.first_name, s.student_id");
    $stmt->execute($scopeParams);
    $students = $stmt->fetchAll(PDO::FETCH_ASSOC) ?: [];

    $stored = [];
    $rows = $pdo->prepare('SELECT * FROM student_year_migration WHERE school_year_id = :sy');
    $rows->execute([':sy' => $schoolYearId]);
    foreach ($rows->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $stored[(int)$row['student_id']] = $row;
    }

    // School years order by NAME, never by id - see lib/school_year_window.php.
    $later = [];
    $laterStmt = $pdo->prepare(
        'SELECT m.student_id, MAX(sy.schoolyear_name) AS schoolyear_name
           FROM student_year_migration m
           JOIN school_year sy  ON sy.school_year_id = m.school_year_id
           JOIN school_year cur ON cur.school_year_id = :sy
          WHERE m.applied_at IS NOT NULL AND sy.schoolyear_name > cur.schoolyear_name
       GROUP BY m.student_id'
    );
    $laterStmt->execute([':sy' => $schoolYearId]);
    foreach ($laterStmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
        $later[(int)$row['student_id']] = (string)$row['schoolyear_name'];
    }

    $evidence = year_migration_evidence($pdo, $schoolYearId);
    $semesters = year_migration_required_semesters($pdo);
    $settings = year_migration_settings($pdo);

    $out = [];
    foreach ($students as $student) {
        $sid = (int)$student['student_id'];
        $computed = year_migration_classify($student, $evidence, $semesters, $settings);
        $row = $stored[$sid] ?? null;
        $override = $row['override_classification'] ?? null;

        $entry = [
            'student' => $student,
            'computed' => $computed,
            'override' => $override !== null ? [
                'classification' => $override,
                'reason' => $row['override_reason'],
                'at' => $row['override_at'],
                'by_user_id' => $row['override_by_user_id'] !== null ? (int)$row['override_by_user_id'] : null,
            ] : null,
        ];

        if ($row !== null && $row['applied_at'] !== null) {
            $entry['state'] = 'applied';
            $entry['classification'] = (string)$row['classification'];
            $entry['applied'] = [
                'at' => $row['applied_at'],
                'by_user_id' => $row['applied_by_user_id'] !== null ? (int)$row['applied_by_user_id'] : null,
                'computed_classification' => $row['computed_classification'],
                'reasons' => json_decode((string)$row['reasons'], true) ?: [],
            ];
            $entry['from'] = ['year_level' => $row['year_level_from'] !== null ? (int)$row['year_level_from'] : null, 'section' => $row['section_from'], 'is_irregular' => (int)$row['irregular_from']];
            $entry['to'] = ['year_level' => $row['year_level_to'] !== null ? (int)$row['year_level_to'] : null, 'section' => $row['section_to'], 'is_irregular' => (int)$row['irregular_to']];
        } else {
            $classification = $override ?? $computed['classification'];
            $outcome = year_migration_outcome($classification, $student);
            $entry['classification'] = $classification;
            $entry['from'] = ['year_level' => $student['year_level'] !== null ? (int)$student['year_level'] : null, 'section' => $student['section'], 'is_irregular' => (int)$student['is_irregular']];
            $entry['to'] = ['year_level' => $outcome['year_level_to'], 'section' => $outcome['section_to'], 'is_irregular' => $outcome['irregular_to']];
            if (isset($later[$sid])) {
                $entry['state'] = 'superseded';
                $entry['superseded_by'] = $later[$sid];
            } elseif ($classification === YEAR_MIGRATION_PENDING) {
                $entry['state'] = 'pending';
            } else {
                $entry['state'] = 'ready';
            }
        }

        $out[] = $entry;
    }

    return $out;
}

/**
 * Record and move every `ready` student. Call inside a transaction that has
 * locked the school year row, so two Applies cannot interleave.
 *
 * Rows are written first, then the students are moved from those rows in one
 * statement - the row is the record of the move, so the move reads it.
 */
function year_migration_apply(PDO $pdo, array $evaluated, int $schoolYearId, int $userId): array
{
    $ready = array_values(array_filter($evaluated, static fn(array $e): bool => $e['state'] === 'ready'));
    $counts = array_fill_keys(array_keys(year_migration_classes()), 0);
    if (!$ready) {
        return ['applied' => 0, 'by_class' => $counts, 'moved_up' => 0];
    }

    $stamp = date('Y-m-d H:i:s');
    $columns = ['student_id', 'school_year_id', 'computed_classification', 'classification', 'reasons',
        'subjects_total', 'subjects_failed', 'balance',
        'year_level_from', 'year_level_to', 'section_from', 'section_to', 'irregular_from', 'irregular_to',
        'applied_at', 'applied_by_user_id'];
    $updates = implode(', ', array_map(
        static fn(string $c): string => "$c = VALUES($c)",
        array_slice($columns, 2) // never the key; override_* columns are not listed, so they survive
    ));

    $movedUp = 0;
    foreach (array_chunk($ready, 200) as $chunk) {
        $placeholders = [];
        $params = [];
        foreach ($chunk as $i => $e) {
            $row = [
                (int)$e['student']['student_id'],
                $schoolYearId,
                $e['computed']['classification'],
                $e['classification'],
                json_encode(array_values($e['computed']['reasons']), JSON_UNESCAPED_UNICODE),
                $e['computed']['subjects_total'],
                $e['computed']['subjects_failed'],
                $e['computed']['balance'],
                $e['from']['year_level'],
                $e['to']['year_level'],
                $e['from']['section'],
                $e['to']['section'],
                $e['from']['is_irregular'],
                $e['to']['is_irregular'],
                $stamp,
                $userId > 0 ? $userId : null,
            ];
            $marks = [];
            foreach ($row as $j => $value) {
                $marks[] = ":v{$i}_$j";
                $params[":v{$i}_$j"] = $value;
            }
            $placeholders[] = '(' . implode(', ', $marks) . ')';
            $counts[$e['classification']]++;
            if ($e['to']['year_level'] > $e['from']['year_level']) {
                $movedUp++;
            }
        }
        $pdo->prepare('INSERT INTO student_year_migration (' . implode(', ', $columns) . ') VALUES '
            . implode(', ', $placeholders) . " ON DUPLICATE KEY UPDATE $updates")->execute($params);
    }

    $pdo->prepare(
        'UPDATE student s
           JOIN student_year_migration m ON m.student_id = s.student_id
            SET s.year_level = m.year_level_to, s.section = m.section_to, s.is_irregular = m.irregular_to
          WHERE m.school_year_id = :sy AND m.applied_at = :stamp'
    )->execute([':sy' => $schoolYearId, ':stamp' => $stamp]);

    return ['applied' => count($ready), 'by_class' => $counts, 'moved_up' => $movedUp];
}

/**
 * Undo one applied student: back to the year level, section and flag Apply found.
 *
 * Refused when a later year is applied on top of it, or when the student record
 * has changed since - putting back an old value over someone's later correction
 * would undo the wrong thing.
 */
function year_migration_revert(PDO $pdo, int $studentId, int $schoolYearId): ?string
{
    $stmt = $pdo->prepare('SELECT * FROM student_year_migration WHERE student_id = :sid AND school_year_id = :sy FOR UPDATE');
    $stmt->execute([':sid' => $studentId, ':sy' => $schoolYearId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$row || $row['applied_at'] === null) {
        return 'Nothing has been applied for this student in this school year.';
    }

    $later = $pdo->prepare(
        'SELECT sy.schoolyear_name
           FROM student_year_migration m
           JOIN school_year sy  ON sy.school_year_id = m.school_year_id
           JOIN school_year cur ON cur.school_year_id = :sy
          WHERE m.student_id = :sid AND m.applied_at IS NOT NULL AND sy.schoolyear_name > cur.schoolyear_name
          LIMIT 1'
    );
    $later->execute([':sid' => $studentId, ':sy' => $schoolYearId]);
    $laterName = $later->fetchColumn();
    if ($laterName !== false) {
        return "$laterName is already applied for this student. Revert that year first.";
    }

    $now = $pdo->prepare('SELECT year_level, section, is_irregular FROM student WHERE student_id = :sid FOR UPDATE');
    $now->execute([':sid' => $studentId]);
    $student = $now->fetch(PDO::FETCH_ASSOC);
    if (!$student
        || (int)$student['year_level'] !== (int)$row['year_level_to']
        || (string)$student['section'] !== (string)$row['section_to']
        || (int)$student['is_irregular'] !== (int)$row['irregular_to']) {
        return 'The student record has changed since this was applied, so it cannot be put back automatically. Correct it on the student record.';
    }

    $pdo->prepare('UPDATE student SET year_level = :y, section = :s, is_irregular = :i WHERE student_id = :sid')->execute([
        ':y' => $row['year_level_from'],
        ':s' => $row['section_from'],
        ':i' => (int)$row['irregular_from'],
        ':sid' => $studentId,
    ]);

    if ($row['override_classification'] !== null) {
        // The evaluator's decision outlives the undo; only the move is taken back.
        $pdo->prepare(
            'UPDATE student_year_migration
                SET applied_at = NULL, applied_by_user_id = NULL, classification = NULL, computed_classification = NULL,
                    reasons = NULL, subjects_total = NULL, subjects_failed = NULL, balance = NULL,
                    year_level_from = NULL, year_level_to = NULL, section_from = NULL, section_to = NULL,
                    irregular_from = NULL, irregular_to = NULL
              WHERE year_migration_id = :id'
        )->execute([':id' => $row['year_migration_id']]);
    } else {
        $pdo->prepare('DELETE FROM student_year_migration WHERE year_migration_id = :id')->execute([':id' => $row['year_migration_id']]);
    }

    return null;
}
