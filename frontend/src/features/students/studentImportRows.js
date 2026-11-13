import { normalizeCsvToken } from "../../shared/lib/spreadsheet";
import {
  getDropdownDefault,
  getDropdownValues,
  hasDropdownOptions,
} from "../../shared/lib/dropdownOptions";
import {
  STUDENT_TYPE_LABEL,
  STUDENT_TYPE_NON_STAR,
  STUDENT_TYPE_STAR,
} from "../../shared/lib/studentType";
import {
  normalizeSection,
  sectionMatchesCourse,
  validateSection,
  validateStudentNumber,
} from "../../shared/lib/studentIdentity";
import { resolveImportCourse } from "./courseLookup";

/**
 * Reading a student spreadsheet into rows, before anything is written.
 *
 * This used to live inside StudentsPage's handleImport, which meant it ran only
 * after the Upload button was pressed: every check, every course lookup, every
 * "that is not a school year" happened with the writing already under way. The
 * file's verdict arrived as a list of line numbers in the summary afterwards,
 * beside a count of accounts that had already been created.
 *
 * Pulling it out is what makes a preview possible, and a preview is only worth
 * showing if it is THE SAME CODE — a second implementation that agreed most of
 * the time would be worse than none, because it would be believed. StudentsPage
 * now calls this twice with the same context: once to show the reader what will
 * happen, once to do it.
 *
 * Nothing here touches the network. The one asynchronous thing the import needs
 * is resolving (and possibly creating) the school year chosen in the dialog, so
 * that id is passed in — null while previewing, because looking at a file must
 * not create a school year as a side effect.
 */

/** Fallback programme length; mirrors DEFAULT_YEAR_DURATION in StudentsPage. */
export const DEFAULT_YEAR_DURATION = 4;

export function trimToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

export function firstNonEmptyValue(record, keys) {
  for (const key of keys) {
    const value = trimToNull(record?.[key]);
    if (value !== null) return value;
  }
  return null;
}

/*
 * Gender, scholarship grant and modality are the office's lists, served by the
 * server (shared/lib/dropdownOptions.js) rather than written here: they are
 * edited on the Dropdown Management screen, and a copy in this file is exactly
 * how the Users screen ended up offering grants the server refuses.
 *
 * Matched the way the sheet is folded (normalizeCsvToken), so "hk-25", "HK 25"
 * and "HK-25" land on the one spelling the list uses. If the lists have not
 * loaded, the value goes through as written and the server - which checks the
 * same list - is the one to refuse it: a preview must not reject a value it
 * has no way to check.
 */
function matchListValue(listKey, value) {
  const token = normalizeCsvToken(value);
  if (!token) return null;
  if (!hasDropdownOptions(listKey)) return String(value).trim();
  return getDropdownValues(listKey).find((candidate) => normalizeCsvToken(candidate) === token);
}

/**
 * Blank or unrecognised becomes the list's default, as it always has - a
 * modality was never a reason to refuse a row - and the server names that
 * default, so nothing here spells it.
 */
export function normalizeModalityValue(value) {
  return matchListValue("modalities", value) || getDropdownDefault("modalities");
}

/**
 * A grant, null for blank, or undefined for "that is not a grant".
 *
 * Three outcomes rather than two so a typo cannot be silently swallowed. The
 * old version returned "Others" for anything it did not recognise, which meant
 * a misspelled grant was stored as a real value nobody chose.
 */
export function normalizeScholarshipValue(value) {
  return matchListValue("scholarship_grants", value);
}

/**
 * Import-side normalisation for the cohort field.
 *
 * The vocabulary itself lives in shared/lib/studentType.js so Users, Students
 * and the assignment board all name it the same way. What is local here is the
 * spreadsheet folding: normalizeCsvToken turns "Non-STAR" into "non_star" and
 * "STAR E-Profile" into "star_e_profile", which are not the tokens the shared
 * routing helper works in.
 *
 * Retired spellings stay readable so an import written against any of them
 * still loads: "Unstar" (to 2026-08-17), "Star"/"Nonstar" (to 2026-08-21),
 * "STAR E-Profile" (part of 2026-08-21). Mirrors normalize_student_type() in
 * student.php, which is what actually enforces this.
 */
const STUDENT_TYPE_ALIASES = {
  unstar: STUDENT_TYPE_NON_STAR,
  nonstar: STUDENT_TYPE_NON_STAR,
  non_star: STUDENT_TYPE_NON_STAR,
  star: STUDENT_TYPE_STAR,
  star_e_profile: STUDENT_TYPE_STAR,
  star_eprofile: STUDENT_TYPE_STAR,
};

export function normalizeStudentTypeValue(value) {
  const token = normalizeCsvToken(value);
  if (!token) return STUDENT_TYPE_NON_STAR;
  return STUDENT_TYPE_ALIASES[token] || null;
}

/**
 * Male, Female, or blank.
 *
 * "Other" used to be accepted and is not any more - the column is
 * enum('Male','Female') as of 2026-08-21. No row ever held it, so nothing was
 * lost; an import row carrying it now fails loudly instead of writing a value
 * the database will reject anyway. Blank stays valid: not recorded is a blank
 * field, not a third gender.
 */
/**
 * A gender from the list, null for blank, or undefined for "not on the list".
 * A single letter ("M", "F") is read as the one entry it starts, the way the
 * registrar's sheet abbreviates - and only when exactly one entry starts with it.
 */
export function normalizeGenderValue(value) {
  const match = matchListValue("genders", value);
  if (match !== undefined) return match;

  const token = normalizeCsvToken(value);
  if (token.length === 1) {
    const starts = getDropdownValues("genders").filter((gender) => normalizeCsvToken(gender).startsWith(token));
    if (starts.length === 1) return starts[0];
  }
  return undefined;
}

/** The header spellings each field is read under, newest first. */
const KEYS = {
  studentNumber: ["student_number", "student_no", "studentid", "student_id"],
  firstName: ["first_name", "firstname"],
  lastName: ["last_name", "lastname"],
  middleName: ["middle_name", "middlename"],
  // The registrar sheet heads this column "EXTENSION ON NAME".
  extensionName: ["extension_name", "extensionname", "extensiononname", "extension", "suffix"],
  email: ["email_address", "email"],
  gender: ["gender", "sex"],
  modality: ["modality"],
  mobile: ["mobile_number", "mobile", "contact_number", "contact_no"],
  motherNumber: ["mother_number", "mothers_number", "mother_contact", "mother_mobile"],
  fatherNumber: ["father_number", "fathers_number", "father_contact", "father_mobile"],
  address: ["home_address", "address", "home_addr"],
  facebook: ["facebook_name", "facebook", "fb_name", "fb"],
  course: ["course_id", "course_code", "course", "course_name"],
  schoolYear: ["schoolyear_id", "school_year_id", "school_year", "schoolyear_name"],
  yearLevel: ["year_level", "year"],
  section: ["section"],
  scholarship: ["final_scholarship_grant", "scholarship", "scholarship_grant"],
};

/**
 * The template's own heading first, then the older spellings.
 *
 * normalizeCsvToken folds "STAR E-Profile" to "star_e_profile", which is the
 * header this page now writes and hands out. "student_type" and the rest stay
 * accepted because every file the office already has was written against them,
 * and an import that rejects last month's spreadsheet is a worse import than
 * one that reads both.
 */
const STUDENT_TYPE_KEYS = [
  normalizeCsvToken(STUDENT_TYPE_LABEL),
  "student_type",
  "studenttype",
  "student_classification",
];

/** "DELA CRUZ, JUAN" — as written in the file, for finding the row again. */
function displayName(lastName, firstName) {
  if (lastName && firstName) return `${lastName}, ${firstName}`;
  return lastName || firstName || "";
}

/**
 * Every row in the file, each one already decided.
 *
 * Returns `{ rows, valid, errors, termOverrides }`, where a row is
 *
 *     { lineNumber, status: "create" | "skip", reason, cells, payload }
 *
 * `cells` is what the file said, resolved where resolution succeeded — a row
 * whose course_name matched shows the course CODE, because seeing "BSIT" where
 * the sheet said "Bachelor of Science in Information Technology" is the proof
 * that the column was understood. A row that failed keeps its raw text, since
 * the point there is to show the reader what to go and fix.
 *
 * One error per row, the first one found, which is what the summary has always
 * listed. Fixing the first thing wrong with a row and re-uploading is the
 * workflow; a row with five complaints against it is not more actionable.
 */
export function buildStudentImportRows(parsedRows, context = {}) {
  const {
    existingStudentNumbers = new Set(),
    courseMatchIndex = new Map(),
    courseCodeById = new Map(),
    courseYearDurationById = {},
    schoolYearIdByLookup = new Map(),
    termSchoolYearId = null,
    termSchoolYearLabel = "",
    campusId = null,
    campusName = "",
  } = context;

  const fileStudentNumbers = new Set();
  const rows = [];
  const termOverrides = new Map();

  (parsedRows || []).forEach(({ lineNumber, values }) => {
    const rawNumber = firstNonEmptyValue(values, KEYS.studentNumber);
    const rawFirst = firstNonEmptyValue(values, KEYS.firstName);
    const rawLast = firstNonEmptyValue(values, KEYS.lastName);
    const rawCourse = firstNonEmptyValue(values, KEYS.course);
    const rawYearLevel = firstNonEmptyValue(values, KEYS.yearLevel);
    const rawSection = firstNonEmptyValue(values, KEYS.section);
    const rawSchoolYear = firstNonEmptyValue(values, KEYS.schoolYear);

    const cells = {
      student_number: rawNumber || "",
      name: displayName(rawLast, rawFirst),
      course: rawCourse || "",
      year_level: rawYearLevel || "",
      section: rawSection || "",
      school_year: rawSchoolYear || termSchoolYearLabel || "",
    };

    try {
      if (!rawNumber) throw new Error("student_number is required");

      // Checked here rather than left to the server so the whole file is
      // reported at once, by line, instead of one failed POST at a time.
      const numberError = validateStudentNumber(rawNumber);
      if (numberError) throw new Error(numberError);

      const normalizedStudentNumber = normalizeCsvToken(rawNumber);
      if (existingStudentNumbers.has(normalizedStudentNumber)) {
        throw new Error(`student number "${rawNumber}" already exists`);
      }
      if (fileStudentNumbers.has(normalizedStudentNumber)) {
        throw new Error(`duplicate student number "${rawNumber}" in file`);
      }

      if (!rawFirst) throw new Error("first_name is required");
      if (!rawLast) throw new Error("last_name is required");

      /*
       * The campus chosen in the dialog is passed in because it is what tells
       * two courses of the same code apart. Without it an ambiguous code is
       * refused by name rather than resolved by array order - a file of Carmen
       * students landing in Puerto is the kind of mistake nobody notices until
       * the wrong dean is looking at them.
       */
      const courseId = resolveImportCourse({
        index: courseMatchIndex,
        courseValue: rawCourse,
        campusId: campusId || null,
        campusName,
      });
      const courseCode = courseCodeById.get(String(courseId));
      if (courseCode) cells.course = courseCode;

      // Older files may name the same school year, but cannot override the calendar.
      const rowSchoolYearId = rawSchoolYear
        ? schoolYearIdByLookup.get(normalizeCsvToken(rawSchoolYear)) ?? null
        : null;
      if (rawSchoolYear && !rowSchoolYearId) {
        throw new Error(`school year "${rawSchoolYear}" was not found`);
      }
      if (rawSchoolYear && termSchoolYearLabel && normalizeCsvToken(rawSchoolYear) !== normalizeCsvToken(termSchoolYearLabel)) {
        throw new Error(`school year must match the Academic Calendar (${termSchoolYearLabel}); remove the school_year column or correct it`);
      }
      const schoolYearId = termSchoolYearId;

      const yearLevel = rawYearLevel !== null ? Number(rawYearLevel) : null;
      if (rawYearLevel !== null && !Number.isFinite(yearLevel)) {
        throw new Error("year_level must be a valid number");
      }
      // Capped by the row's own course, so an Architecture line may carry a
      // Year 5 while a BSIT line on the next row may not.
      const rowMaxYear = courseYearDurationById[String(courseId)] ?? DEFAULT_YEAR_DURATION;
      if (yearLevel !== null && (yearLevel < 1 || yearLevel > rowMaxYear)) {
        throw new Error(`year_level must be between 1 and ${rowMaxYear} for ${rawCourse}`);
      }

      /*
       * Gender and scholarship are validated here rather than trusted, because
       * both normalisers now answer "that is not one of the values" with
       * undefined. Posting undefined would send the row to a backend that
       * rejects it with a less useful message, or - worse for gender - quietly
       * drop the field.
       */
      const genderRaw = firstNonEmptyValue(values, KEYS.gender);
      const gender = normalizeGenderValue(genderRaw);
      if (gender === undefined) {
        throw new Error(`gender must be ${getDropdownValues("genders").join(" or ")} (got "${genderRaw}")`);
      }

      const scholarshipRaw = firstNonEmptyValue(values, KEYS.scholarship);
      const scholarship = normalizeScholarshipValue(scholarshipRaw);
      if (scholarship === undefined) {
        throw new Error(
          `final_scholarship_grant "${scholarshipRaw}" is not one of: ${getDropdownValues("scholarship_grants").join(", ")}`
        );
      }

      const studentType = normalizeStudentTypeValue(firstNonEmptyValue(values, STUDENT_TYPE_KEYS));
      if (!studentType) {
        throw new Error(`${STUDENT_TYPE_LABEL} must be ${STUDENT_TYPE_STAR} or ${STUDENT_TYPE_NON_STAR}`);
      }

      // The section is checked twice: once for shape, then against the course
      // and year on the same line. The second is the one that matters — a
      // section naming the wrong course reads as authoritative.
      const section = rawSection ? normalizeSection(rawSection) : null;
      if (section) {
        const shapeError = validateSection(section);
        if (shapeError) throw new Error(shapeError);
        const mismatch = sectionMatchesCourse(section, courseCode || "", yearLevel);
        if (mismatch) throw new Error(mismatch);
        cells.section = section;
      }

      fileStudentNumbers.add(normalizedStudentNumber);

      rows.push({
        lineNumber,
        status: "create",
        reason: "",
        cells,
        payload: {
          student_number: rawNumber,
          student_type: studentType,
          first_name: rawFirst,
          last_name: rawLast,
          middle_name: firstNonEmptyValue(values, KEYS.middleName),
          extension_name: firstNonEmptyValue(values, KEYS.extensionName),
          email_address: firstNonEmptyValue(values, KEYS.email),
          gender,
          modality: normalizeModalityValue(firstNonEmptyValue(values, KEYS.modality)),
          mobile_number: firstNonEmptyValue(values, KEYS.mobile),
          // The backend create endpoint has always stored these four, but the
          // importer used to drop them, so a "full profile" spreadsheet landed
          // with blank parent contacts, address and Facebook name.
          mother_number: firstNonEmptyValue(values, KEYS.motherNumber),
          father_number: firstNonEmptyValue(values, KEYS.fatherNumber),
          home_address: firstNonEmptyValue(values, KEYS.address),
          facebook_name: firstNonEmptyValue(values, KEYS.facebook),
          course_id: courseId,
          year_level: yearLevel,
          section,
          schoolyear_id: schoolYearId,
          final_scholarship_grant: scholarship,
        },
      });
    } catch (rowError) {
      rows.push({
        lineNumber,
        status: "skip",
        reason: rowError?.message || "invalid row",
        cells,
        payload: null,
      });
    }
  });

  return {
    rows,
    valid: rows.filter((row) => row.status === "create"),
    errors: rows
      .filter((row) => row.status === "skip")
      .map((row) => `Line ${row.lineNumber}: ${row.reason}`),
    termOverrides,
  };
}
