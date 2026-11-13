<?php
/**
 * What a student number and a section are allowed to look like.
 *
 * The authority. src/shared/lib/studentIdentity.js carries the same rules so a
 * form can object while someone is still typing, but a browser check is a
 * courtesy - anything that reaches student.php is validated here before it is
 * stored. studentIdentity.test.js reads the patterns out of this source and
 * fails if the mirror has drifted.
 *
 * Both rules were previously unwritten, and the database shows what that cost:
 *
 *   - A row imported as student_number "REPLACE-WITH-STUDENT-NUMBER", named
 *     "Juan Dela Cruz", section "A". That is the import template's own example
 *     row, uploaded unedited. Nothing rejected it, so the placeholder became a
 *     student.
 *   - A section reading "BSIT3" on a student enrolled in BEED-ECE.
 *   - "02-23-24-01669", which is 02-2324-01669 with one hyphen too many.
 *
 * None of those are exotic. They are what happens when the only thing checking
 * a registrar's spreadsheet is the person who typed it.
 */

/**
 * Pattern strings are shared with JavaScript verbatim, so they are written to be
 * legal in both engines - no named groups, no possessive quantifiers, nothing
 * PCRE offers that JavaScript does not. Single-quoted on purpose: PHP would read
 * \d in a double-quoted string as an escape of its own and hand PCRE something
 * else.
 */

/**
 * 02-2324-10233 - campus, the school year it was issued in, then the sequence.
 *
 * The tail is 4-8 digits rather than a fixed width because the real data is not
 * fixed width: 167 numbers carry a five-digit tail and 336 carry six. Widening
 * it costs nothing and narrowing it would reject people who already exist.
 */
const STUDENT_NUMBER_PATTERN = '^\d{2}-\d{4}-\d{4,8}$';
const STUDENT_NUMBER_MESSAGE = 'Use a student number like 02-2324-10233 - campus, school year, then the sequence.';

/**
 * COC-FAB-BSIT2-03 - campus, department, course, year level, section number.
 *
 * The course code is one or more all-caps words joined by hyphens, because real
 * codes look like BSIT, AB-ENG, BSBA-FM and BSED-SCIENCE. The year level is the
 * single digit welded to the end of the code, and the section number is the two
 * digits after the final hyphen.
 *
 * Letter sections - "A", "B" - are deliberately not accepted. They carry no
 * course and no year, so two "Section A" rows in different programmes are
 * indistinguishable once they are in the same table.
 */
const SECTION_PREFIX = 'COC-FAB-';
const SECTION_PATTERN = '^COC-FAB-[A-Z]+(?:-[A-Z]+)*[1-9]-\d{2}$';
const SECTION_MESSAGE = 'Use a section like COC-FAB-BSIT2-03 - campus, department, course, year level, then a two-digit section number. Single letters such as "A" are no longer used.';

/** Trim, and fold the U+00A0 that arrives with anything pasted out of a browser. */
function student_identity_clean($value): string
{
    return trim(str_replace("\xC2\xA0", ' ', (string)($value ?? '')));
}

/** Student numbers hold no letters, so cleaning is all the normalising there is. */
function student_number_normalize($value): string
{
    return student_identity_clean($value);
}

/**
 * Sections are stored upper case, so "coc-fab-bsit2-03" typed in a hurry is the
 * same section as the one already on file rather than a second one.
 */
function section_normalize($value): string
{
    $text = student_identity_clean($value);
    // Spaces around the hyphens are a typing artefact, never part of the name.
    $text = preg_replace('/\s*-\s*/', '-', $text);
    return strtoupper(preg_replace('/\s+/', ' ', $text));
}

/**
 * '' when the value is acceptable, otherwise the reason it is not.
 *
 * A blank is acceptable here; whether the field may be blank at all is a
 * separate question, decided by the caller.
 */
function student_number_validate($value): string
{
    $text = student_number_normalize($value);
    if ($text === '') return '';
    return preg_match('/' . STUDENT_NUMBER_PATTERN . '/', $text) === 1 ? '' : STUDENT_NUMBER_MESSAGE;
}

/** '' when the value is acceptable, otherwise the reason it is not. */
function section_validate($value): string
{
    $text = section_normalize($value);
    if ($text === '') return '';
    return preg_match('/' . SECTION_PATTERN . '/', $text) === 1 ? '' : SECTION_MESSAGE;
}

/**
 * The course code, year level and section number carried inside a section name,
 * or null when it is not a section name at all.
 */
function section_parse($value): ?array
{
    $text = section_normalize($value);
    if (preg_match('/' . SECTION_PATTERN . '/', $text) !== 1) {
        return null;
    }

    $body = substr($text, strlen(SECTION_PREFIX));
    $cut = strrpos($body, '-');
    $head = substr($body, 0, $cut);

    return [
        'course_code' => substr($head, 0, -1),
        'year_level' => (int)substr($head, -1),
        'number' => substr($body, $cut + 1),
    ];
}

/** COC-FAB-BSIT2-03 from BSIT, 2 and 3. */
function section_compose($courseCode, $yearLevel, $number): string
{
    return SECTION_PREFIX
        . strtoupper(student_identity_clean($courseCode))
        . (int)$yearLevel
        . '-'
        . str_pad((string)(int)$number, 2, '0', STR_PAD_LEFT);
}

/**
 * '' when a section agrees with the course and year level on the same record.
 *
 * The shape check alone would happily accept "COC-FAB-BSIT3-04" on a BEED-ECE
 * student, which is exactly the row sitting in the database today. A section
 * name that contradicts the record it is attached to is worse than a missing
 * one, because it reads as authoritative.
 *
 * Silent when there is nothing to compare against - a student with no course
 * recorded yet is a gap, not a contradiction.
 */
function section_matches_course($section, $courseCode, $yearLevel): string
{
    $parts = section_parse($section);
    if ($parts === null) return '';

    $code = strtoupper(student_identity_clean($courseCode));
    if ($code !== '' && $parts['course_code'] !== $code) {
        return sprintf(
            'Section %s says the course is %s, but this student is in %s. Use %s.',
            section_normalize($section),
            $parts['course_code'],
            $code,
            section_compose($code, $parts['year_level'], $parts['number'])
        );
    }

    if ($yearLevel !== null && $yearLevel !== '' && (int)$yearLevel !== $parts['year_level']) {
        return sprintf(
            'Section %s says year %d, but this student is in year %d. Use %s.',
            section_normalize($section),
            $parts['year_level'],
            (int)$yearLevel,
            section_compose($code !== '' ? $code : $parts['course_code'], (int)$yearLevel, $parts['number'])
        );
    }

    return '';
}
