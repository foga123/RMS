import ExportMenu from "../../shared/components/ui/ExportMenu";
import { TABLE_EXPORT_FORMATS, exportTable } from "../../shared/lib/tableExport";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import Table from "../../shared/components/Table";
import Card from "../../shared/components/ui/Card";
import { AlertMessage, Pagination, StatCard, StatCardGrid } from "../../shared/components/ui";
import { getBackendUrl } from "../../shared/lib/url";
import { scopeToParams } from "./exportSources";
import { describeTarget } from "../../shared/lib/attendanceRemarkPolicy";
import { PERIODS, WHOLE_PERIODICAL_LABEL, periodLabel } from "../../shared/lib/periods";
import { tone } from "../../shared/theme/tokens";

/**
 * The records logbook: school year, then semester, then periodical, then the
 * register of everyone who left a record in it.
 *
 * Drill-down rather than three dropdowns, because that is the shape of the
 * question. "Open 2025-2026, second semester, P2" is one thought; three selects
 * make it three, and none of them shows you what is behind the others until you
 * have chosen all three.
 *
 * ---------------------------------------------------------------------------
 * ONE LEVEL AT A TIME
 *
 * The drill-down used to be three rows of pills stacked in a box, all on screen
 * at once. Everything was reachable and nothing was legible: three rows of
 * identically-sized capsules give no sign which row is the question being asked
 * right now, the year you are in looks exactly like the year you are not, and
 * the rows below the one you are working in are answers to questions you have
 * not reached yet.
 *
 * So each level is a grid of cards, and only one level is on screen: pick a
 * year and the years are replaced by that year's semesters, pick a semester and
 * those are replaced by its periodicals. The breadcrumb above is what carries
 * the path and what steps back up it.
 *
 * Cards rather than bigger pills, because a card has room for the thing a pill
 * could never show: how much is in there. "2025-2026, 3 semesters, 4,412
 * records" is a year you can decide about before opening it. That number is why
 * term_records_terms() now counts rows per term.
 *
 * The level is held in state rather than derived from the selection. Derived
 * would mean the screen opens at the deepest level the API happened to resolve
 * -- and it always resolves one, because a logbook that opens on nothing looks
 * broken -- so the reader would land in a term they never chose, with a
 * breadcrumb implying they had.
 * ---------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------
 * THE IDENTITY WARNING IS THE MOST IMPORTANT THING ON THIS SCREEN
 *
 * Year level, section and course come from `student`, which holds ONE value:
 * the current one. For a term that has been closed, student_term_snapshot has
 * what the student actually was at the time and that is used instead.
 *
 * For a term that has NOT been closed, this screen shows today's values — and
 * says so, loudly, because the failure is invisible. A student who was Year 2
 * BSN in 2025-2026 and is Year 3 BSCRIM now appears in the 2025-2026 register as
 * Year 3 BSCRIM, and every row looks perfectly reasonable.
 *
 * Showing the term anyway rather than refusing: the grades, attendance and
 * balances are real and worth reading whether or not anyone has pressed Close
 * Term. It is only the identity columns that are standing in.
 * ---------------------------------------------------------------------------
 */

const CARD = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 14,
};

const FILTERS = [
  { key: "all", label: "Everyone in this term" },
  { key: "missed_target", label: "Missed the attendance target" },
  { key: "meets_target", label: "Met the attendance target" },
  { key: "with_failed", label: "Has a failed mark" },
  { key: "clean", label: "Clean record" },
  { key: "with_balance", label: "Still owed a balance" },
  { key: "cleared", label: "Balance cleared" },
];

const SORTS = [
  { key: "name", label: "Name" },
  { key: "student_number", label: "Student number" },
  { key: "section", label: "Section" },
  { key: "year_level", label: "Year level" },
  { key: "pass_rate", label: "Pass rate" },
  { key: "attendance_rate", label: "Attendance rate" },
  { key: "absent", label: "Absences" },
  { key: "balance", label: "Balance" },
];

const selectStyle = {
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
  fontSize: 12.5,
};

function percent(value) {
  return value === null || value === undefined ? "—" : `${Number(value).toFixed(1)}%`;
}

function peso(value) {
  if (value === null || value === undefined) return "—";
  return `₱${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

/**
 * One thing you can open: a year, a semester, a periodical.
 *
 * `selected` marks the one already chosen, which only shows after stepping back
 * up the breadcrumb -- on the way down nothing is selected yet, because the
 * whole point of the level is that the choice has not been made. Coming back to
 * the year list and seeing which year you were in is the difference between
 * navigating and starting over.
 *
 * A button rather than a div with a click handler, so it is reachable by keyboard
 * and announced as something that can be pressed without a role attribute
 * standing in for one.
 */
function DrillCard({ title, meta, figure, figureLabel, selected = false, onClick }) {
  return (
    <Card
      as="button"
      type="button"
      interactive
      padding="md"
      onClick={onClick}
      aria-current={selected ? "true" : undefined}
      style={{
        display: "grid",
        gap: 10,
        width: "100%",
        alignContent: "start",
        // The selected card is marked by its border and a tinted ground rather
        // than by a fill: these sit in a grid of four or five, and a solid green
        // tile among white ones reads as an alert rather than as "you are here".
        borderColor: selected ? "var(--brand-600)" : undefined,
        background: selected ? "var(--brand-50)" : undefined,
      }}
    >
      <div style={{ display: "grid", gap: 2 }}>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{title}</span>
        {meta ? <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{meta}</span> : null}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          <strong style={{ fontWeight: 600, color: "var(--text-primary)" }}>{figure}</strong>
          {figureLabel ? ` ${figureLabel}` : ""}
        </span>
        <span aria-hidden="true" style={{ fontSize: 14, color: "var(--text-faint)", lineHeight: 1 }}>
          ›
        </span>
      </div>
    </Card>
  );
}

/** The grid every level is laid out on, so the three levels line up. */
function DrillGrid({ label, hint, children }) {
  return (
    <div style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5 }}>{label}</strong>
        {hint ? <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{hint}</span> : null}
      </div>
      <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(min(190px, 100%), 1fr))" }}>
        {children}
      </div>
    </div>
  );
}

/**
 * The path, and the way back up it.
 *
 * Every step except the one you are on is a button. The last is plain text: a
 * crumb for the level already on screen would be a control that does nothing,
 * and a reader who presses it and sees no change learns the page is unreliable.
 */
function DrillTrail({ steps }) {
  return (
    <nav aria-label="Logbook location" style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        return (
          <React.Fragment key={step.key}>
            {index > 0 ? (
              <span aria-hidden="true" style={{ color: "var(--text-faint)", fontSize: 12.5 }}>
                ›
              </span>
            ) : null}
            {last || !step.onClick ? (
              <span
                aria-current={last ? "page" : undefined}
                style={{ fontSize: 12.5, fontWeight: last ? 600 : 400, color: "var(--text-primary)" }}
              >
                {step.label}
              </span>
            ) : (
              <button
                type="button"
                onClick={step.onClick}
                style={{
                  fontSize: 12.5,
                  padding: "2px 6px",
                  borderRadius: 6,
                  border: "1px solid transparent",
                  background: "none",
                  color: "var(--brand-700)",
                  cursor: "pointer",
                  fontWeight: 500,
                }}
              >
                {step.label}
              </button>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

export default function TermLogbookReport({ scope }) {
  const beginRequest = useLatestRequest();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState("");

  const [selection, setSelection] = useState({ schoolYearId: "", semesterId: "", period: "" });

  /*
   * Which level of the drill-down is on screen: "year", "semester" or "period".
   *
   * Starts at "year" whatever the API resolved. It always resolves a term --
   * see the defaulting in term_logbook.php, which exists so the endpoint never
   * answers with an empty page -- and honouring that here would drop the reader
   * into a term they did not pick, three crumbs deep, on a screen they have not
   * seen before. Opening on the years makes the first thing they see the
   * question the screen is asking.
   */
  const [level, setLevel] = useState("year");

  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(50);

  const scopeKey = useMemo(() => scopeToParams(scope).toString(), [scope]);

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams(scopeKey);
      if (selection.schoolYearId) params.set("school_year_id", selection.schoolYearId);
      if (selection.semesterId) params.set("semester_id", selection.semesterId);
      if (selection.period) params.set("period", selection.period);
      if (filter && filter !== "all") params.set("filter", filter);
      if (sort) params.set("sort", sort);
      if (search.trim()) params.set("search", search.trim());
      params.set("page", String(page));
      params.set("limit", String(limit));

      const response = await fetch(getBackendUrl(`term_logbook.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not open the logbook.");
      if (!isCurrent()) return;
      setData(payload.data);
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(loadError?.message || "Could not open the logbook.");
      setData(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, filter, limit, page, scopeKey, search, selection, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any change to what is being asked returns to page 1. Leaving somebody on
  // page 14 of a result set that now has two shows an empty table and reads as
  // a broken filter.
  useEffect(() => {
    setPage(1);
  }, [selection, filter, search, scopeKey]);

  // Memoised because `|| []` builds a new array on every render, which makes
  // the two useMemos below re-run every time regardless of whether the terms
  // changed. Same fix as the comparison report and the risk panel.
  const terms = useMemo(() => data?.terms || [], [data]);
  const term = data?.term || null;
  const summary = data?.summary || null;
  const visibility = data?.visibility || { grades: true, attendance: true, finance: true };

  const exportRegister = async (format) => {
    setExporting(format);
    setError("");
    try {
      const params = new URLSearchParams(scopeKey);
      params.set("school_year_id", String(term.school_year_id));
      params.set("semester_id", String(term.semester_id));
      if (selection.period) params.set("period", selection.period);
      if (filter !== "all") params.set("filter", filter);
      params.set("sort", sort);
      if (search.trim()) params.set("search", search.trim());
      params.set("limit", "500");
      const rows = [];
      let pages = 1;
      let allowed = {};
      for (let n = 1; n <= pages; n++) {
        params.set("page", String(n));
        const response = await fetch(getBackendUrl(`term_logbook.php?${params}`), { credentials: "include", headers: { Accept: "application/json" } });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload.message || "Could not export records.");
        const result = payload.data;
        pages = result.pagination.pages;
        if (n === 1) allowed = { ...result.visibility };
        else {
          for (const key of Object.keys(allowed)) {
            allowed[key] = allowed[key] && result.visibility?.[key];
          }
        }
        rows.push(...result.students);
      }
      const columns = [
        { key: "term", label: "Term" }, { key: "student_number", label: "Student number" },
        { key: "name", label: "Student name" }, { key: "course_code", label: "Course" },
        { key: "year_level", label: "Year level" }, { key: "section", label: "Section" },
        { key: "source", label: "Standing source" },
        ...(allowed.grades ? [{ key: "grades_text", label: "Grades" }] : []),
        ...(allowed.attendance ? [{ key: "attendance_text", label: "Attendance" }] : []),
        ...(allowed.finance ? [{ key: "balance", label: "Balance (PHP)" }] : []),
      ];
      if (!exportTable(format, {
        filename: `term-register-${term.school_year_id}-${term.semester_id}-${selection.period || "whole-term"}`,
        sheet: "Term Register", columns,
        rows: rows.map((row) => ({
          student_number: row.student_number, name: row.name, course_code: row.course_code,
          year_level: row.year_level, section: row.section,
          term: [term.school_year, term.semester, selection.period ? periodLabel(selection.period) : "Whole term"].join(" / "),
          source: row.identity_source === "snapshot" ? "Historical snapshot" : "Current standing",
          grades_text: allowed.grades ? (row.grades ? `${row.grades.passed}/${row.grades.total_subject} passed (${percent(row.grades.pass_rate)})` : "No record") : "",
          attendance_text: allowed.attendance ? (row.attendance ? `${percent(row.attendance.attendance_rate)} present; ${row.attendance.absent} absent` : "No record") : "",
          balance: allowed.finance ? (row.finance?.balance ?? "No record") : "",
        })),
      })) throw new Error("No matching records to export.");
    } catch (e) { setError(e.message || "Could not export records."); }
    finally { setExporting(""); }
  };

  /**
   * The school years that hold records, newest first, each listed once, with
   * what the card needs to be worth reading: how many semesters are inside and
   * how many records across all of them.
   *
   * Summed here rather than asked for, because `terms` is already one row per
   * semester and the year is just those rows added up. A second endpoint for a
   * number the client is holding all the parts of would be a second place for
   * the total to disagree with the cards under it.
   */
  const years = useMemo(() => {
    const seen = new Map();
    terms.forEach((entry) => {
      const found = seen.get(entry.school_year_id);
      if (found) {
        found.semesters += 1;
        found.records += entry.records || 0;
      } else {
        seen.set(entry.school_year_id, {
          id: entry.school_year_id,
          name: entry.schoolyear_name,
          semesters: 1,
          records: entry.records || 0,
        });
      }
    });
    return [...seen.values()];
  }, [terms]);

  /*
   * The semesters recorded inside the year being opened.
   *
   * Keyed off `selection.schoolYearId` rather than off the loaded `term`,
   * because the semester cards have to be on screen the instant a year is
   * clicked. Waiting for the register fetch to come back before drawing them
   * would leave the level the reader just opened empty for as long as the query
   * takes, which reads as a year with nothing in it.
   */
  const semesters = useMemo(() => {
    const yearId = Number(selection.schoolYearId) || term?.school_year_id || null;
    if (!yearId) return [];
    return terms.filter((entry) => entry.school_year_id === yearId);
  }, [terms, term, selection.schoolYearId]);

  const openYear = useMemo(
    () => years.find((entry) => String(entry.id) === String(selection.schoolYearId)) || null,
    [years, selection.schoolYearId]
  );

  const openSemester = useMemo(
    () => semesters.find((entry) => String(entry.semester_id) === String(selection.semesterId)) || null,
    [semesters, selection.semesterId]
  );

  /*
   * Only the periodicals this term actually holds.
   *
   * Offering P1/P2/P3 unconditionally means clicking P3 on a term that stops at
   * P2 and reading the empty register as a broken page rather than as an answer.
   */
  const availablePeriods = useMemo(() => {
    const counts = new Map((term?.periods || []).map((entry) => [entry.period, entry.records]));
    return PERIODS.filter((entry) => counts.has(Number(entry.value))).map((entry) => ({
      ...entry,
      records: counts.get(Number(entry.value)),
    }));
  }, [term]);

  const wholeRecords = useMemo(
    () => (term?.periods || []).find((entry) => entry.period === null)?.records ?? 0,
    [term]
  );

  const snapshotClosed = term?.snapshot?.closed === true;

  /*
   * The period cards need `term.periods`, which only arrives with the fetch the
   * semester click starts. Until it does, the level has cards for a semester
   * that is no longer the one on screen -- so it says it is loading rather than
   * offering the previous term's periodicals for half a second.
   */
  const periodsReady = term && String(term.semester_id) === String(selection.semesterId);

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ ...CARD, display: "grid", gap: 14 }}>
        <DrillTrail
          steps={[
            {
              key: "root",
              label: "All school years",
              onClick:
                level === "year"
                  ? null
                  : () => {
                      // Only the level moves. The selection is left alone so
                      // the year card you came from is still marked, and so
                      // stepping back up and straight down again does not
                      // refetch a term that never changed.
                      setLevel("year");
                    },
            },
            ...(openYear && level !== "year"
              ? [
                  {
                    key: "year",
                    label: openYear.name,
                    onClick: level === "semester" ? null : () => setLevel("semester"),
                  },
                ]
              : []),
            ...(openSemester && level === "period"
              ? [{ key: "semester", label: openSemester.semester_name, onClick: null }]
              : []),
          ]}
        />

        {level === "year" ? (
          <DrillGrid label="School year" hint="Only years that hold records">
            {/*
              An empty grid under a heading reads as a screen that failed to
              draw. The endpoint's own message says why there is nothing here and
              appears below; this says it in the space where the cards would be,
              which is where the reader is looking.
            */}
            {!loading && years.length === 0 ? (
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                No school year holds any records yet.
              </span>
            ) : null}
            {years.map((year) => (
              <DrillCard
                key={year.id}
                title={year.name}
                meta={`${year.semesters} ${year.semesters === 1 ? "semester" : "semesters"} recorded`}
                figure={formatCount(year.records)}
                figureLabel="records"
                selected={String(selection.schoolYearId) === String(year.id)}
                onClick={() => {
                  // Changing the year clears the semester and period: the ones
                  // that were chosen belong to the year being left, and carrying
                  // "P3" into a year that has no P3 asks for an empty page.
                  if (String(selection.schoolYearId) !== String(year.id)) {
                    setSelection({ schoolYearId: String(year.id), semesterId: "", period: "" });
                  }
                  setLevel("semester");
                }}
              />
            ))}
          </DrillGrid>
        ) : null}

        {level === "semester" ? (
          <DrillGrid label="Semester" hint={openYear ? `Inside ${openYear.name}` : null}>
            {semesters.map((entry) => (
              <DrillCard
                key={entry.semester_id}
                title={entry.semester_name}
                meta={entry.has_periods ? "P1–P3 recorded separately" : "semester totals only"}
                figure={formatCount(entry.records)}
                figureLabel="records"
                selected={String(selection.semesterId) === String(entry.semester_id)}
                onClick={() => {
                  if (String(selection.semesterId) !== String(entry.semester_id)) {
                    setSelection({
                      schoolYearId: String(entry.school_year_id),
                      semesterId: String(entry.semester_id),
                      period: "",
                    });
                  }
                  setLevel("period");
                }}
              />
            ))}
          </DrillGrid>
        ) : null}

        {level === "period" ? (
          <DrillGrid
            label="Periodical"
            hint={openSemester && openYear ? `${openYear.name} · ${openSemester.semester_name}` : null}
          >
            {!periodsReady ? (
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Opening the term…</span>
            ) : (
              <>
                <DrillCard
                  title={WHOLE_PERIODICAL_LABEL}
                  meta="P1, P2 and P3 together"
                  figure={formatCount(wholeRecords)}
                  figureLabel="records"
                  selected={!term?.period}
                  onClick={() => setSelection((prev) => ({ ...prev, period: "" }))}
                />
                {availablePeriods.map((entry) => (
                  <DrillCard
                    key={entry.value}
                    title={entry.label}
                    meta={entry.full}
                    figure={formatCount(entry.records)}
                    figureLabel="records"
                    selected={String(term?.period ?? "") === entry.value}
                    onClick={() => setSelection((prev) => ({ ...prev, period: entry.value }))}
                  />
                ))}
              </>
            )}
          </DrillGrid>
        ) : null}

        {level === "period" && periodsReady && availablePeriods.length === 0 ? (
          <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            No periodical breakdown was recorded for this term — the whole semester is all there is.
          </span>
        ) : null}
      </div>

      {error ? <AlertMessage tone="error" message={error} /> : null}
      {loading && !data ? <p style={{ color: "var(--text-muted)" }}>Opening the logbook…</p> : null}
      {data?.message ? <AlertMessage tone="info" message={data.message} /> : null}

      {/*
        The register belongs to a periodical, so it appears once one is open and
        not before. `periodsReady` is checked as well as the level: without it,
        stepping into a semester shows the PREVIOUS term's register under the
        new term's breadcrumb for as long as the fetch takes, which is the one
        failure this screen cannot afford -- a register that names the wrong
        term is not obviously wrong to anyone reading it.
      */}
      {term && level === "period" && periodsReady ? (
        <>
          {/*
            The identity warning. Placed above the register rather than in a
            footnote because it changes how every row on it should be read.
          */}
          {snapshotClosed ? (
            <AlertMessage
              tone="success"
              message={`This term's students were recorded${term.snapshot.recorded_at ? ` on ${new Date(term.snapshot.recorded_at).toLocaleDateString()}` : ""}, so year level, section and course below are what each student was AT THE TIME (${term.snapshot.rows} students recorded).`}
            />
          ) : (
            <AlertMessage
              tone="warning"
              message="This term has not been closed, so year level, section and course below are each student's CURRENT values, not what they were at the time. Grades, attendance and balances are the term's own. Close the semester in Settings → Close Semester to record who everyone was."
            />
          )}

          <div style={CARD}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <strong style={{ fontSize: 14 }}>
                {term.school_year} · {term.semester} · {term.period ? periodLabel(term.period) : WHOLE_PERIODICAL_LABEL}
              </strong>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                attendance target: {describeTarget(term.target)}
                {term.policy_name ? ` (${term.policy_name})` : ""}
                {term.is_open ? "" : " · year frozen"}
              </span>
            </div>

            <StatCardGrid>
              <StatCard label="Students in this term" value={summary?.students ?? "—"} tone="info" meta="left at least one record" />
              {visibility.grades ? (
                <StatCard
                  label="Average pass rate"
                  value={percent(summary?.average_pass_rate)}
                  tone="default"
                  meta={`${summary?.grades ?? 0} with grades`}
                  progress={summary?.average_pass_rate ?? null}
                />
              ) : null}
              {visibility.attendance ? (
                <StatCard
                  label="Met the attendance target"
                  value={summary?.meets_target ?? "—"}
                  tone="success"
                  meta={`${summary?.missed_target ?? 0} missed it`}
                />
              ) : null}
              {visibility.attendance ? (
                <StatCard
                  label="Average attendance"
                  value={percent(summary?.average_attendance_rate)}
                  tone="info"
                  meta={`${summary?.attendance ?? 0} with attendance`}
                  progress={summary?.average_attendance_rate ?? null}
                />
              ) : null}
              {visibility.finance ? (
                <StatCard
                  label="Balances cleared"
                  value={summary?.cleared ?? "—"}
                  tone="success"
                  meta={`of ${summary?.finance ?? 0} with a balance row`}
                />
              ) : null}
              {visibility.finance ? (
                <StatCard label="Total owed" value={peso(summary?.total_balance)} tone="warning" meta="across this term" />
              ) : null}
            </StatCardGrid>
          </div>

          <div style={CARD}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              <select value={filter} onChange={(event) => setFilter(event.target.value)} style={selectStyle}>
                {FILTERS.filter(
                  (entry) =>
                    (!["with_balance", "cleared"].includes(entry.key) || visibility.finance) &&
                    (!["with_failed", "clean"].includes(entry.key) || visibility.grades) &&
                    (!["missed_target", "meets_target"].includes(entry.key) || visibility.attendance)
                ).map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.label}
                  </option>
                ))}
              </select>
              <select value={sort} onChange={(event) => setSort(event.target.value)} style={selectStyle}>
                {SORTS.filter(
                  (entry) =>
                    (entry.key !== "balance" || visibility.finance) &&
                    (entry.key !== "pass_rate" || visibility.grades) &&
                    (!["attendance_rate", "absent"].includes(entry.key) || visibility.attendance)
                ).map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    Sort by {entry.label.toLowerCase()}
                  </option>
                ))}
              </select>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name, student number or section"
                style={{ ...selectStyle, minWidth: 220 }}
              />
              <ExportMenu options={TABLE_EXPORT_FORMATS} busyKey={exporting} disabled={loading || !data?.pagination?.total} onSelect={exportRegister} />
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", marginLeft: "auto" }}>
                {data?.pagination?.total ?? 0} listed
              </span>
            </div>

            <Table
              loading={loading}
              emptyText="No student matches this filter in this term."
              /*
               * Every cell here is a stacked two-line block — a heading line
               * over a smaller detail line — and each of those lines is short.
               * `nowrap` keeps each on the one line it was laid out as, so the
               * hyphenated values in them (student number 02-2526-000001,
               * section COC-FAB-AB-ENG1-01) cannot break after a hyphen and
               * turn a two-line block into a ragged four-line one.
               */
              columns={[
                { key: "student", label: "Student", nowrap: true },
                { key: "standing", label: snapshotClosed ? "Standing at the time" : "Standing (current)", nowrap: true },
                ...(visibility.grades ? [{ key: "grades", label: "Grades", nowrap: true }] : []),
                ...(visibility.attendance ? [{ key: "attendance", label: "Attendance", nowrap: true }] : []),
                ...(visibility.finance ? [{ key: "finance", label: "Balance", nowrap: true }] : []),
              ]}
              rows={(data?.students || []).map((row) => {
                const meets = row.attendance?.meets_target ?? null;
                const palette = meets === null ? null : tone(meets ? "success" : "danger");
                return {
                  key: row.student_id,
                  student: (
                    <div>
                      <div style={{ fontWeight: 600 }}>{row.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{row.student_number}</div>
                    </div>
                  ),
                  standing: (
                    <div style={{ fontSize: 11.5 }}>
                      <div>
                        {row.course_code || "—"}
                        {row.year_level ? ` · Year ${row.year_level}` : ""}
                      </div>
                      <div style={{ color: "var(--text-muted)" }}>
                        {row.section || "no section"}
                        {row.student_type ? ` · ${row.student_type}` : ""}
                        {row.scholarship ? ` · ${row.scholarship}` : ""}
                      </div>
                    </div>
                  ),
                  grades: row.grades ? (
                    <div>
                      <div>{percent(row.grades.pass_rate)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.grades.passed}/{row.grades.total_subject} passed
                        {row.grades.remark ? ` · ${row.grades.remark}` : ""}
                      </div>
                    </div>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>no record</span>
                  ),
                  attendance: row.attendance ? (
                    <div>
                      <div>
                        {percent(row.attendance.attendance_rate)}{" "}
                        {palette ? (
                          <span
                            style={{
                              padding: "1px 7px",
                              borderRadius: 999,
                              fontSize: 10.5,
                              whiteSpace: "nowrap",
                              background: palette.bg,
                              color: palette.text,
                            }}
                          >
                            {row.attendance.remark || (meets ? "Met" : "Missed")}
                          </span>
                        ) : null}
                      </div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.attendance.absent} of {row.attendance.total_classes_conducted} missed
                      </div>
                    </div>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>no record</span>
                  ),
                  finance: row.finance ? (
                    <div>
                      <div>{peso(row.finance.balance)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.finance.is_cleared ? "cleared" : "outstanding"}
                        {row.finance.date ? ` · ${row.finance.date}` : ""}
                      </div>
                    </div>
                  ) : (
                    <span style={{ color: "var(--text-muted)" }}>no record</span>
                  ),
                };
              })}
            />

            <div style={{ marginTop: 10 }}>
              <Pagination
                page={page}
                pageSize={limit}
                total={data?.pagination?.total ?? 0}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setLimit(size);
                  setPage(1);
                }}
                itemLabel="students"
              />
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
