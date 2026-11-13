import { getDropdownOptions } from "../../shared/lib/dropdownOptions";
import { STUDENT_TYPES, STUDENT_TYPE_LABEL } from "../../shared/lib/studentType";

/** A maintained list's options, in the shape the panel renders. */
const listOptions = (listKey) => () =>
  getDropdownOptions(listKey).map((option) => ({ value: option.value, label: option.label }));

/**
 * The conditions Student Management can narrow the list by, beyond the
 * campus -> course -> year chain the toolbar already owns.
 *
 * These exist so a bulk archive can be aimed: "archive every Non-STAR student
 * in Section B who has no scholarship" is a sentence somebody says, and before
 * this the only way to act on it was to tick five hundred checkboxes by eye.
 *
 * Kept as data rather than as JSX so the predicate can be tested without
 * rendering anything, and so the panel and the active-count badge cannot
 * disagree about what counts as a filter.
 */

/** A value meaning "the field is empty", as opposed to "any value". */
export const FILTER_BLANK = "__blank__";

export const EMPTY_STUDENT_FILTERS = {
  gender: "",
  student_type: "",
  final_scholarship_grant: "",
  modality: "",
  section: "",
  coach_name: "",
};

/**
 * Field definitions, in the order the panel lays them out.
 *
 * `options` is a function: of nothing for the lists the office maintains
 * (served by the server, edited on Dropdown Management), or of the rows in
 * scope for section and coach, which are free text, so their choices are
 * whatever the data actually holds.
 */
export const STUDENT_FILTER_FIELDS = [
  {
    key: "student_type",
    label: STUDENT_TYPE_LABEL,
    options: () => STUDENT_TYPES.map((value) => ({ value, label: value })),
  },
  {
    key: "gender",
    label: "Sex",
    options: listOptions("genders"),
    blankLabel: "Not recorded",
  },
  {
    key: "final_scholarship_grant",
    label: "Scholarship",
    options: listOptions("scholarship_grants"),
    blankLabel: "No scholarship",
  },
  {
    key: "modality",
    label: "Modality",
    options: listOptions("modalities"),
    blankLabel: "Not recorded",
  },
  {
    key: "section",
    label: "Section",
    options: (rows) => distinctOptions(rows, "section"),
    blankLabel: "No section",
  },
  {
    // The student's coach, as student.php attaches it from the assignment
    // board. Replaced a Coaching Unit filter on a column nothing ever filled;
    // the unit follows from the STAR E-Profile filter above, and "No coach yet"
    // is the list somebody actually needs.
    key: "coach_name",
    label: "Coach",
    options: (rows) => distinctOptions(rows, "coach_name"),
    blankLabel: "No coach yet",
  },
];

/** The values a free-text column actually holds, sorted, for a dropdown. */
function distinctOptions(rows, key) {
  const seen = new Set();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const value = String(row?.[key] ?? "").trim();
    if (value !== "") seen.add(value);
  });
  return [...seen]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((value) => ({ value, label: value }));
}

/** Does one row satisfy one condition? */
function matchesField(row, key, wanted) {
  if (wanted === "") return true;

  const actual = String(row?.[key] ?? "").trim();
  // "Not recorded" is a real thing to filter for - it is how you find the rows
  // somebody still has to fill in - and it cannot be expressed as a value.
  if (wanted === FILTER_BLANK) return actual === "";

  return actual.toLowerCase() === String(wanted).trim().toLowerCase();
}

/**
 * The rows matching every active condition.
 *
 * AND, not OR: each control the reader touches narrows the set further, which is
 * what "filter" means everywhere else in this application. An unknown key is
 * ignored rather than matching nothing, so a stale saved filter cannot empty the
 * table with no way to see why.
 */
export function applyStudentFilters(rows, filters) {
  const active = Object.entries(filters || {}).filter(
    ([key, value]) => value !== "" && value != null && key in EMPTY_STUDENT_FILTERS
  );
  if (active.length === 0) return Array.isArray(rows) ? rows : [];

  return (Array.isArray(rows) ? rows : []).filter((row) =>
    active.every(([key, value]) => matchesField(row, key, value))
  );
}

/** How many conditions are set, for the badge on the Filters button. */
export function countActiveStudentFilters(filters) {
  return Object.entries(filters || {}).filter(
    ([key, value]) => value !== "" && value != null && key in EMPTY_STUDENT_FILTERS
  ).length;
}

/**
 * Each active condition as a readable phrase, for the chips under the toolbar.
 *
 * Worth showing because these live behind a button: a filtered list that looks
 * like the whole list is how somebody archives the wrong four hundred students.
 */
export function describeStudentFilters(filters) {
  return STUDENT_FILTER_FIELDS.filter((field) => (filters || {})[field.key])
    .map((field) => {
      const value = filters[field.key];
      return {
        key: field.key,
        label: field.label,
        value: value === FILTER_BLANK ? field.blankLabel || "Not recorded" : value,
      };
    });
}
