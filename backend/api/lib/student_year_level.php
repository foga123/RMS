<?php
/**
 * A student's year level: what it may be, and what its section becomes when it moves.
 *
 * Two rules, shared by student.php (the form and every edit) and the year-end
 * migration (lib/year_migration.php), so the cap and the section rule each exist
 * once.
 *
 * Nothing here emits a response or exits; callers decide how to answer.
 */

require_once __DIR__ . '/student_identity.php';

/**
 * '' when the year level fits the student's programme, otherwise the sentence to show.
 *
 * There was no server-side check at all once: year_level was stored as typed,
 * so a "Year 47" row needed only a typo. The cap is course.year_duration, so a
 * five-year programme allows Year 5 and a four-year one does not. With no
 * course to measure against, the widest programme in the catalogue is the cap
 * rather than no cap at all.
 */
function student_year_level_error(PDO $pdo, ?int $courseId, ?int $yearLevel): string
{
    if ($yearLevel === null) {
        return '';
    }
    if ($yearLevel < 1) {
        return 'year_level must be at least 1';
    }

    if ($courseId === null) {
        $maxDuration = (int)$pdo->query('SELECT COALESCE(MAX(year_duration), 4) FROM course')->fetchColumn();
        return $yearLevel > $maxDuration ? "year_level must be between 1 and $maxDuration" : '';
    }

    $stmt = $pdo->prepare('SELECT course_code, year_duration FROM course WHERE course_id = :id LIMIT 1');
    $stmt->execute([':id' => $courseId]);
    $course = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$course) {
        return ''; // the course FK check reports this properly on its own
    }

    $duration = (int)($course['year_duration'] ?? 4);
    if ($duration < 1) {
        $duration = 4;
    }
    if ($yearLevel > $duration) {
        $code = (string)($course['course_code'] ?? 'this course');
        return "$code is a $duration-year programme, so year_level must be between 1 and $duration.";
    }

    return '';
}

/**
 * The section a student holds once their year level moves to $yearLevel.
 *
 * A section carries its year: COC-FAB-BSIT1-03 is a Year I section, and
 * student.php refuses EVERY edit of a record whose section and year disagree.
 * Moving the year alone would leave a student whose next unrelated edit - a
 * phone number - is refused. So the section moves with it, same course and
 * number: the correction section_matches_course() itself suggests.
 *
 * A section that is not in the standard shape is returned untouched; there is
 * no year inside it to disagree with.
 */
function student_year_level_section_for(?string $section, ?string $courseCode, int $yearLevel): ?string
{
    if ($section === null || trim($section) === '') {
        return $section;
    }
    $parts = section_parse($section);
    if ($parts === null || $parts['year_level'] === $yearLevel) {
        return $section;
    }
    $code = trim((string)$courseCode) !== '' ? (string)$courseCode : $parts['course_code'];
    return section_compose($code, $yearLevel, $parts['number']);
}
