/**
 * The Potential Drop Out filter, shared by Grades, Attendance and Finance.
 *
 * "Which of these students are we worried about" is the same question on all
 * three screens, so it is one control with one vocabulary rather than three
 * that drift. The classification itself is server-side and stays there: these
 * are labels for a value the browser passes through as `?pdo=`, never a second
 * implementation of the priority rules.
 *
 * Mirrors pdo_filter_options() in backend/api/pdo_priority_lib.php. That file
 * is the authority — it derives the priorities from the RETENTION & MIGRATION
 * sheet's 48-row table, and its own tests check the reduction.
 */

/** The query value that means "do not filter". */
export const PDO_FILTER_ALL = "";

/**
 * Priority 1 to 3 together — what somebody means by "the potential drop outs".
 *
 * Every student gets a priority, so being on the PDO list is not a distinction.
 * Priority 4 is Attending with passing grades and no balance, the safest
 * standing on the board; 1 to 3 are the ones with something wrong.
 */
export const PDO_FILTER_FLAGGED = "flagged";

/**
 * Not a priority - the absence of one.
 *
 * Every student is classified, so nobody is missing from the board: a student
 * with no grades, no attendance and no finance row for the term still lands
 * somewhere, on three defaults. That makes them look identical to a student
 * genuinely doing fine, which is the more dangerous of the two to leave
 * unmarked. This picks out the ones the board cannot say anything about, so
 * the gap gets filled instead of read as good news.
 */
export const PDO_FILTER_NONE = "none";

export const PDO_FILTER_OPTIONS = [
  { value: PDO_FILTER_ALL, label: "All students" },
  { value: PDO_FILTER_FLAGGED, label: "Potential drop out (P1-P3)" },
  { value: "1", label: "Priority 1 - College" },
  { value: "2", label: "Priority 2 - Coaches" },
  { value: "3", label: "Priority 3 - Coaches" },
  { value: "4", label: "Priority 4 - No concern" },
  { value: PDO_FILTER_NONE, label: "No PDO record yet" },
];

/** How an active filter reads in a summary line or an export filename. */
export function pdoFilterLabel(value) {
  return PDO_FILTER_OPTIONS.find((option) => option.value === String(value ?? ""))?.label || "All students";
}

/** True when a filter is actually narrowing the list. */
export function isPdoFiltered(value) {
  return String(value ?? "") !== PDO_FILTER_ALL;
}

/**
 * Adds `pdo` to a URLSearchParams only when it is set.
 *
 * A blank `?pdo=` is harmless — the server ignores anything not in its own
 * option list — but it shows up in saved links and export URLs as a filter that
 * is not filtering, which is exactly the sort of thing that gets read as a bug.
 */
export function applyPdoParam(params, value) {
  if (isPdoFiltered(value)) params.set("pdo", String(value));
  return params;
}
