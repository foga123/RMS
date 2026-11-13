import { useEffect, useMemo, useState } from "react";

/**
 * Narrowing a student list to a year level, then to a section inside it.
 *
 * Faculty asked for this and it belongs on more than one screen: the Contact
 * Workspace is the queue they call from and the retention board is where they
 * record what they did, and "show me Year II, section B" is the same question
 * on both. One module rather than a pair of nearly-identical filter blocks,
 * because the near-identical pair is how one of them ends up sorting sections
 * as text and listing B10 before B2.
 *
 * The options are derived from the rows on screen rather than fetched from a
 * reference table. A section nobody in this queue belongs to is not a useful
 * thing to offer: choosing it can only ever produce an empty list, and an empty
 * list under a filter you just set reads as a broken screen.
 */

/** A section as it is stored, trimmed. "" when the record has none. */
function sectionOf(row) {
  return String(row?.section ?? "").trim();
}

/** A year level as its number, or 0 when the record has none worth showing. */
function yearLevelOf(row) {
  const level = Number(row?.year_level);
  return Number.isFinite(level) && level >= 1 ? level : 0;
}

/**
 * Does this row survive the cohort filters? Blank filters match everything.
 *
 * Compared as strings because the filter value comes off a `<select>` and the
 * row value comes off JSON, where `year_level` is a number. `4 !== "4"` would
 * hide every row under a filter that names the year they are all in.
 */
export function matchesCohort(row, { yearLevel = "", section = "" } = {}) {
  if (yearLevel && String(yearLevelOf(row)) !== String(yearLevel)) return false;
  if (section && sectionOf(row) !== section) return false;
  return true;
}

/**
 * The Year and Section choices present in `rows`, each as {value, label}.
 *
 * The two lists are NOT symmetrical, and that is the point. Years are drawn
 * from every row, so the year dropdown always offers every year the queue holds
 * and you can move between them freely. Sections are drawn only from the rows
 * in the chosen year: a section list spanning the whole department is mostly
 * sections the reader cannot be looking at, and picking one of them silently
 * contradicts the year they just chose.
 *
 * Year levels sort numerically and are labelled the way the college writes them
 * - "Year II", not "2" - through the shared yearLevel helper, so a filter and
 * the row beneath it name the cohort identically.
 *
 * Sections sort naturally: `localeCompare` with `numeric` so B2 comes before
 * B10. Plain string ordering puts B10 first, which looks like a bug in a
 * dropdown even though it is only a sort.
 *
 * @param {Array} rows Anything carrying `year_level` and `section`.
 * @param {(year: number) => string} labelYear Usually yearLevelLabel.
 * @param {{yearLevel?: string}} selected The year already chosen, if any.
 */
export function cohortOptions(rows, labelYear, { yearLevel = "" } = {}) {
  const list = Array.isArray(rows) ? rows : [];

  const years = [...new Set(list.map(yearLevelOf).filter((level) => level > 0))]
    .sort((a, b) => a - b)
    .map((level) => ({
      value: String(level),
      label: typeof labelYear === "function" ? labelYear(level) : String(level),
    }));

  const inYear = yearLevel
    ? list.filter((row) => String(yearLevelOf(row)) === String(yearLevel))
    : list;

  const sections = [...new Set(inYear.map(sectionOf).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map((section) => ({ value: section, label: section }));

  return { years, sections };
}

/**
 * Both filters, their options, and the one piece of state-keeping the cascade
 * needs: a section that the newly chosen year does not contain has to let go.
 *
 * Without that, choosing Year I while section B4-02 is still selected leaves a
 * filter pair that describes nobody, and the screen goes empty under two
 * dropdowns that each look reasonable on their own. It lives here rather than
 * in each page because a cascade whose reset is copied per screen is a cascade
 * that is correct on one screen.
 *
 * @param {Array} rows The rows the options are drawn from - all of them, before
 *   these filters are applied, or the dropdowns would erase their own choices.
 */
export function useCohortFilters(rows, labelYear) {
  const [yearLevel, setYearLevel] = useState("");
  const [section, setSection] = useState("");

  const { years, sections } = useMemo(
    () => cohortOptions(rows, labelYear, { yearLevel }),
    [rows, labelYear, yearLevel],
  );

  useEffect(() => {
    if (!section) return;
    if (sections.some((option) => option.value === section)) return;
    setSection("");
  }, [section, sections]);

  const filters = useMemo(() => ({ yearLevel, section }), [yearLevel, section]);

  return { yearLevel, setYearLevel, section, setSection, years, sections, filters };
}
