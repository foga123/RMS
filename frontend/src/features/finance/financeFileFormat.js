/**
 * The Finance file format: what an import expects and what an export writes.
 *
 * Both follow the office's template (latest.xlsx, "New template sa Finance",
 * 2026-10-06): Student Number, Balance to Date, S2 Balance Range. Kept in one
 * module so the dialog's template and the export cannot drift apart - an export
 * that does not read back in through the importer is two formats, not one.
 *
 * The range is CHECKED, never obeyed. The band is always worked out from the
 * amount on the server (finance-import.php), because two sources for one fact
 * disagree sooner or later; a row whose range disagrees is imported by its
 * amount and listed in the result, so whoever made the sheet can see which
 * side is wrong.
 */

/** Drives both the downloadable template and the column list in the dialog. */
export const FINANCE_IMPORT_COLUMNS = [
  {
    name: "Student Number",
    required: true,
    example: "REPLACE-WITH-STUDENT-NUMBER",
    hint: "The student number; the numeric student ID also works",
  },
  {
    name: "Balance to Date",
    required: true,
    example: "6491.59",
    hint: "Outstanding balance. Commas and a peso sign are fine",
  },
  {
    name: "S2 Balance Range",
    example: "5K to 7.5K",
    hint: "Checked against the balance; the range is always worked out from the amount",
  },
];

/**
 * The range column's header for a set of exported rows.
 *
 * "S2 Balance Range" is the office's header, and it names a semester. A file
 * of 1st-semester balances labelled "S2" would misdescribe every row in it, so
 * the header follows the rows: S1 / S2 / Summer when they are all one semester,
 * plain "Balance Range" when they are mixed or unknown. The importer reads all
 * four spellings.
 */
export function balanceRangeHeader(semesterNames = []) {
  const names = [
    ...new Set(
      semesterNames
        .map((name) => String(name ?? "").trim())
        .filter((name) => name !== "" && name !== "-")
    ),
  ];
  if (names.length !== 1) return "Balance Range";
  if (/summer/i.test(names[0])) return "Summer Balance Range";
  const digit = names[0].match(/^(\d)/);
  return digit ? `S${digit[1]} Balance Range` : "Balance Range";
}

/**
 * What an exported finance file holds: the template's three columns first, so
 * the file imports back as-is, then what ties each balance to a term - a column
 * of pesos with no periodical or semester beside it cannot be reconciled
 * against anything once it has left the page.
 *
 * Keys are the display fields FinancePage's displayRow() builds.
 */
export function financeExportColumns(rangeHeader = "Balance Range") {
  return [
    { key: "display_student", label: "Student Number" },
    { key: "display_amount", label: "Balance to Date" },
    { key: "display_range", label: rangeHeader },
    { key: "display_student_name", label: "Student Name" },
    { key: "display_period", label: "Periodical" },
    { key: "display_date", label: "Date" },
    { key: "display_semester", label: "Semester" },
    { key: "display_school_year", label: "School Year" },
  ];
}
