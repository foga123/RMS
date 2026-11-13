/**
 * What a student number and a section are allowed to look like, in the browser.
 *
 * A mirror. backend/api/lib/student_identity.php is the authority and validates
 * everything that reaches it; this file exists so a form can object while
 * someone is still typing rather than after a round trip. studentIdentity.test.js
 * reads the PHP source and fails if the two have drifted apart.
 */

/** 02-2324-10233 - campus, the school year it was issued in, then the sequence. */
export const STUDENT_NUMBER_PATTERN = "^\\d{2}-\\d{4}-\\d{4,8}$";
export const STUDENT_NUMBER_MESSAGE =
  "Use a student number like 02-2324-10233 - campus, school year, then the sequence.";

/** COC-FAB-BSIT2-03 - campus, department, course, year level, section number. */
export const SECTION_PREFIX = "COC-FAB-";
export const SECTION_PATTERN = "^COC-FAB-[A-Z]+(?:-[A-Z]+)*[1-9]-\\d{2}$";
export const SECTION_MESSAGE =
  'Use a section like COC-FAB-BSIT2-03 - campus, department, course, year level, then a two-digit section number. Single letters such as "A" are no longer used.';

/** Trim, and fold the U+00A0 that arrives with anything pasted out of a browser. */
function clean(value) {
  return String(value ?? "").replace(/\u00a0/g, " ").trim();
}

export function normalizeStudentNumber(value) {
  return clean(value);
}

/**
 * Sections are stored upper case, so "coc-fab-bsit2-03" typed in a hurry is the
 * same section as the one already on file rather than a second one.
 */
export function normalizeSection(value) {
  return clean(value).replace(/\s*-\s*/g, "-").replace(/\s+/g, " ").toUpperCase();
}

/** "" when acceptable, otherwise the reason it is not. Blank is acceptable. */
export function validateStudentNumber(value) {
  const text = normalizeStudentNumber(value);
  if (text === "") return "";
  return new RegExp(STUDENT_NUMBER_PATTERN).test(text) ? "" : STUDENT_NUMBER_MESSAGE;
}

/** "" when acceptable, otherwise the reason it is not. Blank is acceptable. */
export function validateSection(value) {
  const text = normalizeSection(value);
  if (text === "") return "";
  return new RegExp(SECTION_PATTERN).test(text) ? "" : SECTION_MESSAGE;
}

/** The course code, year level and section number inside a section name. */
export function parseSection(value) {
  const text = normalizeSection(value);
  if (!new RegExp(SECTION_PATTERN).test(text)) return null;

  const body = text.slice(SECTION_PREFIX.length);
  const cut = body.lastIndexOf("-");
  const head = body.slice(0, cut);

  return {
    course_code: head.slice(0, -1),
    year_level: Number(head.slice(-1)),
    number: body.slice(cut + 1),
  };
}

/** COC-FAB-BSIT2-03 from BSIT, 2 and 3. */
export function composeSection(courseCode, yearLevel, number) {
  const level = Number(yearLevel) || 1;
  const seq = String(Number(number) || 1).padStart(2, "0");
  return `${SECTION_PREFIX}${clean(courseCode).toUpperCase()}${level}-${seq}`;
}

/**
 * "" when a section agrees with the course and year level on the same record.
 *
 * The shape check alone would accept "COC-FAB-BSIT3-04" on a BEED-ECE student,
 * which is a row that exists today. A section that contradicts the record it is
 * attached to is worse than a missing one, because it reads as authoritative.
 */
export function sectionMatchesCourse(section, courseCode, yearLevel) {
  const parts = parseSection(section);
  if (!parts) return "";

  const code = clean(courseCode).toUpperCase();
  if (code !== "" && parts.course_code !== code) {
    return `Section ${normalizeSection(section)} says the course is ${parts.course_code}, but this student is in ${code}. Use ${composeSection(code, parts.year_level, parts.number)}.`;
  }

  const level = yearLevel === null || yearLevel === undefined || yearLevel === "" ? null : Number(yearLevel);
  if (level !== null && level !== parts.year_level) {
    return `Section ${normalizeSection(section)} says year ${parts.year_level}, but this student is in year ${level}. Use ${composeSection(code !== "" ? code : parts.course_code, level, parts.number)}.`;
  }

  return "";
}

/**
 * Keep a section field on the rails while it is being typed.
 *
 * Upper-cases and drops characters a section name cannot contain, so the value
 * in the box is always one the server would recognise the shape of. Deliberately
 * does not insert the COC-FAB- prefix - silently rewriting what someone typed is
 * how you end up with COC-FAB-COC-FAB-BSIT2-01.
 */
export function sanitizeSectionInput(value) {
  return String(value ?? "").toUpperCase().replace(/[^A-Z0-9-]/g, "");
}
