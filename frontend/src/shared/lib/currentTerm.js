/**
 * What term the portal is in, for whoever needs to fill a form in.
 *
 * Grades, Attendance and Finance all open an import dialog that asks for a
 * school year, a semester and a periodical, and all three used to ask with
 * empty dropdowns. The answer comes from academic_calendar.php, which resolves
 * it from the term dates an administrator entered or from a manual pin — see
 * backend/api/lib/academic_calendar.php for the ladder it walks.
 *
 * The semester and periodical are DEFAULTS: the import dialogs still show those
 * pickers and the person importing can change them. The school year is not
 * (2026-10-08, Francis): an import always files under the calendar's school
 * year, shown as text rather than a dropdown - see importSchoolYearField().
 * When the calendar is wrong, the fix is Settings → Academic Calendar, which
 * puts every import right at once.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getBackendUrl } from "./url";

/**
 * One answer shared by every caller, and the request that is fetching it.
 *
 * Module-level rather than per-hook because this is a single system-wide fact
 * that changes roughly three times a semester. Without the cache, opening
 * Grades then Attendance then Finance is three identical round trips for a
 * value none of them can disagree about; with it, it is one.
 *
 * `inFlight` is separate from `cache` so two components mounting in the same
 * tick share the request rather than racing to make two.
 *
 * The cache holds the closed semesters as well as the term: the same read
 * carries both, and a closed semester is exactly what an import picker needs to
 * know about before the server refuses the upload. `{ term, closedTerms }`.
 */
let cache = null;
let inFlight = null;

/** A stable empty list, so a hook's closedTerms does not change on every render. */
const NO_CLOSED_TERMS = Object.freeze([]);

/** Drops the cache so the next read goes back to the server. */
export function invalidateCurrentTerm() {
  cache = null;
  inFlight = null;
}

async function fetchCalendar() {
  const response = await fetch(getBackendUrl("academic_calendar.php"), {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || "Could not read the academic calendar.");
  }
  return {
    term: payload?.data?.current || null,
    closedTerms: Array.isArray(payload?.data?.closed_terms) ? payload.data.closed_terms : NO_CLOSED_TERMS,
  };
}

function loadCalendar() {
  if (cache) return Promise.resolve(cache);
  if (!inFlight) {
    inFlight = fetchCalendar()
      .then((calendar) => {
        cache = calendar;
        return calendar;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

export function loadCurrentTerm() {
  return loadCalendar().then((calendar) => calendar.term);
}

/**
 * The closure of one semester from the calendar's list, or null when it is
 * open or either half is missing. Ids are compared as numbers, because the
 * pickers hold them as strings.
 */
export function closedTermFor(closedTerms, schoolYearId, semesterId) {
  const year = Number(schoolYearId);
  const semester = Number(semesterId);
  if (!year || !semester) return null;
  return (closedTerms || []).find(
    (closure) => Number(closure.school_year_id) === year && Number(closure.semester_id) === semester
  ) || null;
}

/**
 * closedTermFor() for the pickers that name a school year rather than id it -
 * Students and Enrollment Status, whose import files may carry the year as text.
 */
export function closedTermForYearName(closedTerms, schoolYearName, semesterId) {
  const name = String(schoolYearName || "").trim();
  const semester = Number(semesterId);
  if (!name || !semester) return null;
  return (closedTerms || []).find(
    (closure) => String(closure.schoolyear_name || "").trim() === name && Number(closure.semester_id) === semester
  ) || null;
}

/**
 * What an import dialog says, and why Upload is off, when the chosen semester
 * is closed. Empty for an open one, so it can be passed unconditionally.
 */
export function closedTermNotice(closure) {
  if (!closure) return "";
  return `${closure.label} is closed, so nothing can be imported into it. `
    + "An administrator can reopen it in Settings → Close Semester.";
}

/**
 * The resolved term as picker values: strings, because a `<select value>` is.
 *
 * An unknown part comes back as "", which is exactly what the pickers already
 * treat as "nothing chosen". So a calendar that only knows the school year
 * fills the school year in and leaves the other two alone, rather than the
 * caller having to check which fields are real.
 */
export function currentTermValues(term) {
  return {
    school_year_id: term?.school_year_id != null ? String(term.school_year_id) : "",
    semester_id: term?.semester_id != null ? String(term.semester_id) : "",
    period: term?.period != null ? String(term.period) : "",
  };
}

/**
 * The school year as its NAME ("2026-2027"), for the pickers keyed on the name.
 *
 * Students and Enrollment Status identify a school year by name rather than by
 * id: their import files may carry a `school_year` column, and matching that
 * text against a name is what lets a file name its own year. Both therefore
 * need this rather than currentTermValues()' `school_year_id`.
 *
 * Returns "" when the calendar has no answer, so a caller can tell "the
 * calendar says nothing" from "the calendar says 2026-2027" and fall back
 * without mistaking one for the other.
 */
export function currentTermSchoolYearName(term) {
  const name = String(term?.schoolyear_name ?? "").trim();
  return name;
}

/**
 * The School Year field of an import dialog: shown, not chosen.
 *
 * `key` is the field the page's import handler reads ("school_year_id", or
 * "school_year" for the screens keyed on the name) and `display` the year's
 * name. The page puts the calendar's year into that key itself, so the value
 * shown is the value sent.
 */
export function importSchoolYearField(key, display = "") {
  return {
    key,
    label: "School Year",
    readOnly: true,
    display,
    hint: "from the academic calendar",
    missingMessage: "No school year is set. An administrator can set it in Settings → Academic Calendar.",
  };
}

/**
 * Import picker values with the school year set to the calendar's id, for the
 * screens keyed on `school_year_id`. "" when the calendar has no year, which
 * keeps Upload off with importSchoolYearField()'s message.
 */
export function withCalendarSchoolYear(values, term) {
  return { ...values, school_year_id: currentTermValues(term).school_year_id };
}

/**
 * Fills the blanks in `values` from the calendar, leaving anything already
 * chosen alone.
 *
 * Attendance seeds its import dialog from the filters on screen, and those are
 * a deliberate choice by the person looking at them. The calendar is a fallback
 * for what they have not said, not a second opinion on what they have.
 */
export function withCurrentTermDefaults(values, term) {
  const defaults = currentTermValues(term);
  const merged = { ...values };
  Object.keys(defaults).forEach((key) => {
    if (!merged[key] && defaults[key]) merged[key] = defaults[key];
  });
  return merged;
}

/**
 * The current term, or null while it loads or if the read fails.
 *
 * Failure is deliberately quiet. This fills a form in; a red banner because a
 * convenience could not load would be louder than the thing it is about, and
 * the screen still works exactly as it did before the calendar existed.
 */
export function useCurrentTerm() {
  const [calendar, setCalendar] = useState(cache);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    if (cache) {
      setCalendar(cache);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    loadCalendar()
      .then((resolved) => {
        if (active) setCalendar(resolved);
      })
      .catch(() => {
        if (active) setCalendar(null);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(() => {
    invalidateCurrentTerm();
    return loadCalendar()
      .then((resolved) => {
        setCalendar(resolved);
        return resolved.term;
      })
      .catch(() => null);
  }, []);

  return {
    term: calendar?.term ?? null,
    // Every closed semester - see closedTermFor() and closedTermNotice().
    closedTerms: calendar?.closedTerms ?? NO_CLOSED_TERMS,
    loading,
    refresh,
  };
}

/**
 * The sentence shown under a term picker that the calendar filled in.
 *
 * Empty when the calendar had nothing to say, so a caller can render it
 * unconditionally and get nothing rather than an explanation of a blank.
 */
export function currentTermHint(term) {
  if (!term || term.source === "none") return "";
  if (!term.school_year_id) return "";
  const pinned = term.source === "manual" ? " (pinned)" : "";
  return `Defaulted to ${term.label}${pinned}. ${term.note}`;
}

/**
 * The term, split into the loud half and the quiet half.
 *
 * This started as three chips - Period, Semester, School Year - which rendered
 * as three grey pills identical in weight to the role chip beside them. The
 * term is the one thing on these headers that changes during a semester and the
 * one people were asking for, and it looked like metadata. So it is now ONE
 * object with a hierarchy inside it: the periodical is the part that moves and
 * the part faculty are gated on, so it carries the accent; the semester and
 * year are the context it sits in and stay quiet.
 *
 * `period` is "" when the calendar cannot name one, and the badge renders the
 * words alone. It is deliberately not "Whole Periodical": on a header that
 * phrase reads as a setting somebody chose, when it is really a question nobody
 * answered, and the two must not look alike on a screen where people record
 * work against a term.
 *
 * `label` is "" when there is nothing at all to say, which is the signal to
 * render no badge rather than an empty one.
 *
 * Kept here rather than in each workspace because five screens show this, and
 * the wording is the fact: "Period" on one header and "Periodical" on the next
 * is how a reader starts wondering whether they are the same value.
 */
export function currentTermBadge(term) {
  const period = Number(term?.period);
  return {
    period: [1, 2, 3].includes(period) ? `P${period}` : "",
    label: [term?.semester_name, term?.schoolyear_name].filter(Boolean).join(" · "),
    // The semester has been closed, so work recorded against it is refused.
    // The workspaces that carry this badge file everything under this term,
    // which makes it the one place a reader would think to look.
    closed: term?.is_closed === true,
    closedNote: term?.is_closed === true ? String(term?.closed_note || "") : "",
  };
}

/**
 * currentTermBadge() for a component that has no other use for the term.
 *
 * The term itself is fetched once and cached module-wide, so a page that only
 * wants the badge does not pay for asking - see the cache above loadCurrentTerm.
 */
export function useCurrentTermBadge() {
  const { term } = useCurrentTerm();
  return useMemo(() => currentTermBadge(term), [term]);
}

/**
 * Opens a page's own filters on the current term, once.
 *
 * The import dialogs were the first thing to default from the calendar, but
 * they were not the thing people noticed: a page whose periodical filter says
 * "Whole Periodical" while the calendar says P1 is showing three periodicals
 * added together and calling it now. If the office has said it is P1 of 1st
 * Semester, that is what the table should open on.
 *
 * ONCE is the load-bearing word. The term arrives from a fetch a moment after
 * the page mounts, so this cannot be a plain effect on `term` — that would
 * re-apply the calendar every time the component re-rendered with the term in
 * hand, and quietly undo the reader's own choice of periodical a beat after
 * they made it. The ref latches on the first term that arrives and never fires
 * again for the life of the page.
 *
 * `apply` is held in a ref rather than listed as a dependency for the same
 * reason: callers pass an inline arrow, whose identity changes every render.
 *
 * Returns the term so a caller that also wants to render the hint does not need
 * a second hook.
 */
export function useCurrentTermFilters(apply) {
  const { term, closedTerms, loading, refresh } = useCurrentTerm();
  const applied = useRef(false);
  const applyRef = useRef(apply);
  applyRef.current = apply;

  useEffect(() => {
    if (applied.current || !term) return;
    applied.current = true;
    applyRef.current?.(term);
  }, [term]);

  return { term, closedTerms, loading, refresh };
}

/**
 * The periodical filter value for a term: "1", "2", "3", or "" for no opinion.
 *
 * "" is PERIOD_ALL — Whole Periodical — which is the honest answer when the
 * calendar knows the year but not the periodical. It is also what the filters
 * already default to, so a calendar with nothing to say changes nothing.
 */
export function currentTermPeriodFilter(term) {
  return term?.period != null ? String(term.period) : "";
}
