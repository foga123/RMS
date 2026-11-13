<?php
/**
 * The student field vocabulary: what a cohort, a gender, a grant and a name
 * are allowed to be.
 *
 * Lifted out of student.php so student-import.php validates a bulk row exactly
 * as student.php validates a single one. A bulk path with its own second
 * opinion would write rows the single path would have refused.
 *
 * Gender, grant and modality are checked against their tables (see below);
 * the foreign keys refuse a bad value too, but only these checks say which
 * values ARE allowed. normalize_scholarship_grant() answers false rather than
 * null for a typo so that a misspelling cannot blank somebody's award.
 */

function as_nullable_int($value) {
    if ($value === null || $value === '') return null;
    return (int)$value;
}

function as_nullable_text($value) {
    if ($value === null) return null;
    $v = trim((string)$value);
    return $v === '' ? null : $v;
}

/**
 * The two student cohorts, and every spelling that has ever meant them.
 *
 * The field is called "STAR E-Profile" on screen; the values it holds are
 * 'STAR' and 'Non-STAR', capitalised as the RETENTION & MIGRATION sheet writes
 * them. The label and the value are deliberately different words - a row
 * reading "STAR E-Profile" under a column headed "STAR E-Profile" says the same
 * thing twice and never says which cohort the student is in.
 *
 * The retired spellings are all still accepted on input and folded forward,
 * because an import sheet or a saved integration written against any of them
 * should load rather than fail a row at a time on a word change:
 *
 *   'Unstar'         -> stored until 2026-08-17
 *   'Star'/'Nonstar' -> stored until 2026-08-21
 *   'STAR E-Profile' -> stored for part of 2026-08-21
 *
 * Matched case-insensitively and returned in canonical case; every comparison
 * downstream is strcasecmp() already.
 */
const STUDENT_TYPE_STAR = 'STAR';
const STUDENT_TYPE_NON_STAR = 'Non-STAR';

function normalize_student_type($value): ?string {
    $v = as_nullable_text($value);
    if ($v === null) return STUDENT_TYPE_NON_STAR;

    $aliases = [
        'unstar'         => STUDENT_TYPE_NON_STAR,
        'nonstar'        => STUDENT_TYPE_NON_STAR,
        'non-star'       => STUDENT_TYPE_NON_STAR,
        'non star'       => STUDENT_TYPE_NON_STAR,
        'star'           => STUDENT_TYPE_STAR,
        'star e-profile' => STUDENT_TYPE_STAR,
        'star eprofile'  => STUDENT_TYPE_STAR,
        'star e profile' => STUDENT_TYPE_STAR,
    ];

    $key = strtolower(trim($v));
    return $aliases[$key] ?? null;
}

/**
 * The name columns stored in capitals.
 *
 * The registrar's own records are capitalised and the RETENTION & MIGRATION
 * sheet writes every student in capitals, so this is the house style rather
 * than a display preference - it is applied on the way in, which is what makes
 * every screen, export, report and PDF agree without each of the twenty-three
 * places that render a name having to remember to do it.
 *
 * Only these five columns. Addresses, parents' names and email addresses are
 * left exactly as typed: an email address is case-sensitive after the @ in
 * principle, and shouting a home address gains nothing.
 */
const STUDENT_NAME_COLUMNS = ['first_name', 'middle_name', 'last_name', 'extension_name'];

/**
 * Digits, and the punctuation a phone number is actually written with.
 *
 * `as_nullable_text()` accepted anything at all here, so "N/A", "none", a name
 * or a script all stored happily in a column the contact workspace later tries
 * to dial. The stored value is the digits alone, with a leading + kept because
 * +63 is how half these numbers are written.
 *
 * Returns false for "not a phone number" so the caller can tell it apart from a
 * blank field — the same convention normalize_scholarship_grant() uses, and for
 * the same reason: silently blanking somebody's contact number is worse than
 * refusing the row.
 */
function normalize_mobile_number($value) {
    $v = as_nullable_text($value);
    if ($v === null) {
        return null;
    }

    // Spaces, dashes and brackets are how people write numbers; strip them
    // rather than refusing "0917-123-4567".
    $stripped = preg_replace('/[\s\-().]/u', '', $v);
    if ($stripped === '' || !preg_match('/^\+?\d{7,15}$/', $stripped)) {
        return false;
    }

    return $stripped;
}

/**
 * A name in capitals, or null.
 *
 * MB_CASE_UPPER rather than strtoupper() so that a name carrying an accent -
 * Muñoz, Peña - uppercases the accented letter too instead of leaving it as the
 * one lowercase character in an otherwise capitalised name.
 */
function normalize_student_name($value): ?string {
    $v = as_nullable_text($value);
    return $v === null ? null : mb_convert_case($v, MB_CASE_UPPER, 'UTF-8');
}

/*
 * Scholarship grant, gender and modality are lists the office maintains, kept
 * in the scholarship_grant, gender and modality tables and edited on the
 * Dropdown Management screen (lib/dropdown_lists.php). Until 2026-09-25 each
 * was written into the code - the grants in four places, one of which, the
 * Users screen, had gone stale and could not save any grant at all.
 *
 * The student columns hold foreign keys to those tables, so the database now
 * refuses a value that is not on the list. These checks still run first,
 * because a refusal from here names the choices, and one from MySQL names a
 * constraint.
 */
require_once __DIR__ . '/dropdown_lists.php';

/**
 * Null for "not recorded", the list's own spelling, or false for "not on the
 * list".
 *
 * false rather than null for the invalid case so the caller can tell a blank
 * field from a typo - blanking someone's scholarship because they misspelled it
 * is the failure mode worth avoiding here.
 */
function student_field_normalize(PDO $pdo, string $listKey, $value) {
    $v = as_nullable_text($value);
    if ($v === null) return null;

    return dropdown_list_canonical($pdo, $listKey, $v) ?? false;
}

/** "must be one of: HK-25, HK-50, ..." for a refusal. */
function student_field_choices(PDO $pdo, string $listKey): string {
    return implode(', ', dropdown_list_active_values($pdo, $listKey));
}

/**
 * Null stays valid: not recorded is a blank field. Without this check the
 * database used to coerce a bad value to an empty string and return success;
 * the foreign key now refuses it too, but only this says why.
 */
function normalize_gender(PDO $pdo, $value) {
    return student_field_normalize($pdo, 'genders', $value);
}

/** Blank means "not recorded", which is what every student reads as until the registrar enters theirs. */
function normalize_scholarship_grant(PDO $pdo, $value) {
    return student_field_normalize($pdo, 'scholarship_grants', $value);
}

/**
 * Blank becomes the list's default (declared in lib/dropdown_lists.php, and
 * locked on the Dropdown Management screen so it can never stop existing);
 * anything else must be on the list.
 */
function normalize_modality(PDO $pdo, $value) {
    return student_field_normalize($pdo, 'modalities', $value) ?? dropdown_list_default('modalities');
}
