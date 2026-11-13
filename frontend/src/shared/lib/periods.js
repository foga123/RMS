/**
 * Grading periods, shared by Grades, Attendance and Finance.
 *
 * A PHINMA semester runs three periodicals - P1, P2 and P3 - and all three
 * modules record data at each one. This mirrors periodic_lib.php, which is what
 * actually enforces the rules; the copy here exists so the three screens label
 * and query periods identically instead of each inventing its own wording.
 *
 * A semester runs three periodicals and then the whole of them: P1, P2, P3,
 * Whole Periodical. The whole is not a fourth periodical - it is the three
 * added up, and for a student recorded before periodicals existed it is the
 * single whole-semester row (period = NULL) that was uploaded instead.
 *
 * Which of those two the whole means is decided per student, not globally, and
 * it is decided in SQL: see the three-layer query in attendance-summary.php and
 * the ROW_NUMBER() rollup in grades.php. Both take the periodicals where a
 * student has any, because adding a periodical figure to a whole-semester
 * figure counts the same semester twice.
 *
 * `PERIOD_TERM` keeps its name and its value: `term` is the word the API
 * accepts on the wire, and no viewer sees it.
 */

/** The query value that means "do not filter" - every row, all periods. */
export const PERIOD_ALL = "";

/**
 * The query value for the whole-semester rows, where period IS NULL.
 *
 * The constant and the string it holds are the API's word, not the reader's -
 * `?period=term` is what every one of these screens already sends. Renaming
 * either would break saved links and the endpoints in one go, for a word no
 * viewer sees.
 */
export const PERIOD_TERM = "term";

/**
 * What P1, P2 and P3 together are called, everywhere they are offered.
 *
 * It was "Total", which in a column reading P1 / P2 / P3 looked like a sum
 * sitting beside its parts rather than like the fourth thing you can choose.
 * One constant so the filter, the table cell and the export never drift.
 */
export const WHOLE_PERIODICAL_LABEL = "Whole Periodical";

/** The periodicals, in the order a semester runs them. */
export const PERIODS = [
  { value: "1", label: "P1", full: "First Periodical" },
  { value: "2", label: "P2", full: "Second Periodical" },
  { value: "3", label: "P3", full: "Third Periodical" },
];

/** How a stored period reads in a table cell. */
export function periodLabel(period) {
  if (period === null || period === undefined || period === "") return WHOLE_PERIODICAL_LABEL;
  const found = PERIODS.find((p) => p.value === String(period));
  return found ? found.label : String(period);
}

/**
 * Options for a period filter dropdown: P1, P2, P3, Whole Periodical.
 *
 * In that order, ending on the whole, because that is the order a semester
 * runs. Whole Periodical is the default even though it is last - the page opens
 * on the whole picture and the periodicals narrow it.
 *
 * There is no separate option for the period-IS-NULL rows any more. It was
 * offered as "Semester total" beside an "All periods" that also claimed to be a
 * semester total, which is two names for figures that were not the same number.
 * Whole Periodical now covers both readings honestly: the periodicals where a
 * student has them, the whole-semester row where they do not. The `term` value
 * still works if it arrives in a URL - only the option is gone.
 *
 * `counts` is the `periods` array the API returns - how many rows each bucket
 * actually holds. Passing it in turns three identical-looking options into
 * "P2 (411)", so nobody picks a periodical that has no data and reads the empty
 * table as a broken page. Without it the options still render, just unlabelled.
 */
export function periodFilterOptions(counts = []) {
  const byKey = new Map(
    (Array.isArray(counts) ? counts : []).map((bucket) => [
      bucket?.period == null ? PERIOD_TERM : String(bucket.period),
      Number(bucket?.records) || 0,
    ])
  );
  const total = [...byKey.values()].reduce((sum, n) => sum + n, 0);
  const withCount = (label, key) => (byKey.has(key) ? `${label} (${byKey.get(key)})` : label);

  return [
    ...PERIODS.map((p) => ({ value: p.value, label: withCount(p.label, p.value), title: p.full })),
    {
      value: PERIOD_ALL,
      label: total ? `${WHOLE_PERIODICAL_LABEL} (${total})` : WHOLE_PERIODICAL_LABEL,
      title: "P1, P2 and P3 together - or the whole-semester figure for a student with no periodical recorded",
    },
  ];
}

/** How the blank choice reads when writing: a record covering the whole semester. */
export const PERIOD_TERM_WRITE_LABEL = "Semester total (no periodical)";

/**
 * The options a form or an import offers when *writing* a record.
 *
 * Deliberately shorter than the filter list: "All periods" is a way of reading,
 * not a value a row can hold, so offering it here would let someone save a
 * record filed under nothing.
 *
 * `includeBlank` is false for ImportDialog, which renders its own placeholder
 * option; passing the blank as well would show the same choice twice.
 */
export function periodWriteOptions({ includeBlank = true } = {}) {
  const periodicals = PERIODS.map((p) => ({ value: p.value, label: `${p.label} - ${p.full}` }));
  return includeBlank ? [{ value: "", label: PERIOD_TERM_WRITE_LABEL }, ...periodicals] : periodicals;
}
