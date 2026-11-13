import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import Table from "../../shared/components/Table";
import { AlertMessage, Pagination, StatCard, StatCardGrid } from "../../shared/components/ui";
import { getBackendUrl } from "../../shared/lib/url";
import { scopeToParams } from "./exportSources";
import { describeTarget } from "../../shared/lib/attendanceRemarkPolicy";
import { PERIODS, periodLabel } from "../../shared/lib/periods";
import { tone } from "../../shared/theme/tokens";

/**
 * One term against another, for the same students.
 *
 * Every other report answers "what does this term look like". None of them
 * answers "is it better or worse than last year", which is the only version of
 * the question that says whether an intervention worked. Doing it by opening two
 * reports and comparing by eye fails silently, because the two are not
 * necessarily describing the same people: a cohort grows and shrinks between
 * terms, and an average over a different population is not a comparison at all.
 *
 * So the population is stated. `in both terms` is printed next to the deltas,
 * and when it is small the deltas carry a warning, because with one student in
 * common a ten-point swing in the average pass rate says nothing about teaching
 * and everything about who enrolled.
 *
 * THE TARGETS ARE PER TERM, NOT PER SCREEN
 *
 * Each side is judged against the attendance target pinned to ITS OWN term. Last
 * year's students are measured against last year's policy. Judging them against
 * this year's would turn every change of target into an apparent change in the
 * students, which is the exact mistake this whole feature exists to prevent.
 */

const CARD = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 10,
  padding: 14,
};

const FILTERS = [
  { key: "all", label: "Everyone" },
  { key: "missed_target", label: "Missed the attendance target" },
  { key: "meets_target", label: "Met the attendance target" },
  { key: "declined", label: "Attendance got worse" },
  { key: "improved", label: "Attendance improved" },
  { key: "with_failed", label: "Has a failed mark" },
  { key: "with_balance", label: "Still owes a balance" },
  { key: "no_previous", label: "No record last term" },
];

const SORTS = [
  { key: "name", label: "Name" },
  { key: "attendance_rate", label: "Attendance rate" },
  { key: "absent", label: "Absences" },
  { key: "attendance_change", label: "Attendance change" },
  { key: "pass_rate", label: "Pass rate" },
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

/**
 * A change, with its sign spelled out and coloured by whether it is GOOD.
 *
 * Not by whether it is positive. A rising balance is money owed going up and has
 * to read as bad while showing a plus, and an arrow that says "up" in green over
 * a growing debt is the kind of chart that gets a decision wrong.
 */
function Delta({ value, suffix = "", goodWhen = "up", digits = 1 }) {
  if (value === null || value === undefined) {
    return <span style={{ color: "var(--text-muted)" }}>—</span>;
  }

  const number = Number(value);
  if (Math.abs(number) < 0.05) {
    return <span style={{ color: "var(--text-muted)" }}>no change</span>;
  }

  const isGood = goodWhen === "up" ? number > 0 : number < 0;
  const palette = tone(isGood ? "success" : "danger");
  return (
    <span style={{ color: palette.text, fontWeight: 600, whiteSpace: "nowrap" }}>
      {number > 0 ? "▲ +" : "▼ "}
      {number.toFixed(digits)}
      {suffix}
    </span>
  );
}

function termLabel(term) {
  if (!term) return "—";
  // Nothing is appended for a whole-semester comparison: "2026-2027 · 1st
  // Semester" already says it, and "· Whole Periodical" on every heading is
  // noise until a periodical is actually chosen.
  const period = term.period ? ` · ${periodLabel(term.period)}` : "";
  return `${term.school_year} · ${term.semester}${period}`;
}

export default function TermComparisonReport({ scope }) {
  const beginRequest = useLatestRequest();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [selection, setSelection] = useState({ term: "", period: "", compare: "" });
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState("name");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);

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
      if (selection.term) {
        const [schoolYearId, semesterId] = selection.term.split(":");
        params.set("school_year_id", schoolYearId);
        params.set("semester_id", semesterId);
      }
      if (selection.period) params.set("period", selection.period);
      if (selection.compare) {
        const [schoolYearId, semesterId] = selection.compare.split(":");
        params.set("compare_school_year_id", schoolYearId);
        params.set("compare_semester_id", semesterId);
      }
      if (filter && filter !== "all") params.set("filter", filter);
      if (sort) params.set("sort", sort);
      if (search.trim()) params.set("search", search.trim());
      params.set("page", String(page));
      params.set("limit", String(limit));

      const response = await fetch(getBackendUrl(`term_comparison.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not build the comparison.");
      if (!isCurrent()) return;
      setData(payload.data);
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(loadError?.message || "Could not build the comparison.");
      setData(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, filter, limit, page, scopeKey, search, selection, sort]);

  useEffect(() => {
    void load();
  }, [load]);

  // Any change to what is being asked sends the reader back to page 1. Leaving
  // them on page 14 of a result set that now has three pages shows an empty
  // table and reads as a broken filter.
  useEffect(() => {
    setPage(1);
  }, [selection, filter, search, scopeKey]);

  const terms = data?.terms || [];
  const current = data?.current || null;
  const previous = data?.previous || null;
  const population = data?.population || null;

  const currentAttendance = current?.attendance;
  const previousAttendance = previous?.attendance;
  const currentGrades = current?.grades;
  const previousGrades = previous?.grades;
  const currentFinance = current?.finance;
  const previousFinance = previous?.finance;

  /*
   * What the server was willing to send.
   *
   * A caller without finance_management gets empty finance rollups rather than
   * an error, so the card would render "0 cleared, ₱0.00 owed" -- a confident
   * set of numbers that are not true. Withheld blocks are hidden instead.
   */
  const visibility = data?.visibility || { grades: true, attendance: true, finance: true };

  const delta = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);

  /*
   * Whether the two sides describe enough of the same people to be compared.
   *
   * Ten shared students is the line. Below it the summary deltas are still
   * shown -- hiding them would be its own kind of lie -- but they carry a
   * warning, because the number moving is mostly the population changing.
   */
  const overlap = population?.in_both ?? 0;
  const thinOverlap = previous !== null && overlap > 0 && overlap < 10;
  const noOverlap = previous !== null && overlap === 0;

  return (
    <div style={{ display: "grid", gap: 14 }}>
      <div style={{ ...CARD, display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
          <span style={{ color: "var(--text-muted)" }}>Term</span>
          <select
            value={selection.term}
            onChange={(event) => setSelection((prev) => ({ ...prev, term: event.target.value }))}
            style={{ ...selectStyle, minWidth: 210 }}
          >
            <option value="">Most recent with records</option>
            {terms.map((term) => (
              <option key={`${term.school_year_id}:${term.semester_id}`} value={`${term.school_year_id}:${term.semester_id}`}>
                {term.schoolyear_name} · {term.semester_name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
          <span style={{ color: "var(--text-muted)" }}>Period</span>
          <select
            value={selection.period}
            onChange={(event) => setSelection((prev) => ({ ...prev, period: event.target.value }))}
            style={selectStyle}
          >
            <option value="">Whole Periodical</option>
            {PERIODS.map((entry) => (
              <option key={entry.value} value={entry.value} title={entry.full}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
          <span style={{ color: "var(--text-muted)" }}>Compared with</span>
          <select
            value={selection.compare}
            onChange={(event) => setSelection((prev) => ({ ...prev, compare: event.target.value }))}
            style={{ ...selectStyle, minWidth: 210 }}
          >
            <option value="">The same semester a year earlier</option>
            {terms.map((term) => (
              <option key={`${term.school_year_id}:${term.semester_id}`} value={`${term.school_year_id}:${term.semester_id}`}>
                {term.schoolyear_name} · {term.semester_name}
              </option>
            ))}
          </select>
        </label>

        <div style={{ fontSize: 11.5, color: "var(--text-muted)", flex: "1 1 240px", paddingBottom: 4 }}>
          {current ? (
            <>
              <strong style={{ color: "var(--text-primary)" }}>{termLabel(current)}</strong> against{" "}
              <strong style={{ color: "var(--text-primary)" }}>{termLabel(previous)}</strong>
              {population ? (
                <div>
                  {population.in_current} students this term · {population.in_previous} last · {overlap} in both
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </div>

      {error ? <AlertMessage tone="error" message={error} /> : null}
      {loading && !data ? <p style={{ color: "var(--text-muted)" }}>Building the comparison…</p> : null}
      {data?.message ? <AlertMessage tone="info" message={data.message} /> : null}

      {data?.comparison_note ? (
        /* Says WHICH term was empty. "No comparable term" alone leaves the
           reader wondering whether the report failed or the year is genuinely
           blank. */
        <AlertMessage tone="info" message={data.comparison_note} />
      ) : null}

      {noOverlap ? (
        <AlertMessage
          tone="warning"
          message="No student has a record in both terms, so the per-student changes below are empty. The two summaries still describe their own terms — they are just not describing the same people."
        />
      ) : null}
      {thinOverlap ? (
        <AlertMessage
          tone="warning"
          message={`Only ${overlap} ${overlap === 1 ? "student appears" : "students appear"} in both terms. The summary differences below are mostly a different intake, not a change in the same students.`}
        />
      ) : null}

      {current ? (
        <>
          <div style={CARD}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
              <strong style={{ fontSize: 14 }}>Attendance</strong>
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                {/* Naming the target on the card matters: two terms with
                    different targets produce "meets target" counts that are not
                    directly comparable, and the reader has to be able to see
                    that rather than infer it. */}
                target this term: {describeTarget(current.target)}
                {previous && previous.target ? ` · last term: ${describeTarget(previous.target)}` : ""}
              </span>
            </div>
            <StatCardGrid>
              <StatCard
                label="Met the target"
                value={currentAttendance?.meets_target ?? "—"}
                tone="success"
                meta={
                  previousAttendance
                    ? `${previousAttendance.meets_target} last term`
                    : "no comparable term"
                }
                progress={currentAttendance?.meets_target_rate ?? null}
              />
              <StatCard
                label="Missed the target"
                value={currentAttendance?.missed_target ?? "—"}
                tone="danger"
                meta={previousAttendance ? `${previousAttendance.missed_target} last term` : ""}
              />
              <StatCard
                label="Average attendance"
                value={percent(currentAttendance?.average_rate)}
                tone="info"
                meta={previousAttendance ? `was ${percent(previousAttendance.average_rate)}` : ""}
                progress={currentAttendance?.average_rate ?? null}
              />
              <StatCard
                label="Average absences"
                value={currentAttendance?.average_absences ?? "—"}
                tone="default"
                meta={previousAttendance ? `was ${previousAttendance.average_absences}` : ""}
              />
            </StatCardGrid>
            {previousAttendance ? (
              <p style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
                Change in average attendance:{" "}
                <Delta value={delta(currentAttendance?.average_rate, previousAttendance.average_rate)} suffix="%" goodWhen="up" />
                {"  ·  "}
                change in average absences:{" "}
                <Delta value={delta(currentAttendance?.average_absences, previousAttendance.average_absences)} goodWhen="down" />
              </p>
            ) : null}
          </div>

          {visibility.grades ? (
          <div style={CARD}>
            <strong style={{ fontSize: 14 }}>Grades</strong>
            <StatCardGrid>
              <StatCard
                label="Average pass rate"
                value={percent(currentGrades?.average_pass_rate)}
                tone="info"
                meta={previousGrades ? `was ${percent(previousGrades.average_pass_rate)}` : ""}
                progress={currentGrades?.average_pass_rate ?? null}
              />
              <StatCard
                label="Clean records"
                value={currentGrades?.clean ?? "—"}
                tone="success"
                meta={previousGrades ? `${previousGrades.clean} last term` : ""}
              />
              <StatCard
                label="With a failed mark"
                value={currentGrades?.with_failed_mark ?? "—"}
                tone="danger"
                meta={previousGrades ? `${previousGrades.with_failed_mark} last term` : ""}
              />
              <StatCard label="Records" value={currentGrades?.records ?? "—"} tone="default" meta="students with grades this term" />
            </StatCardGrid>
            {previousGrades ? (
              <p style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
                Change in average pass rate:{" "}
                <Delta value={delta(currentGrades?.average_pass_rate, previousGrades.average_pass_rate)} suffix="%" goodWhen="up" />
              </p>
            ) : null}
          </div>
          ) : null}

          {visibility.finance ? (
          <div style={CARD}>
            <strong style={{ fontSize: 14 }}>Finance</strong>
            <StatCardGrid>
              <StatCard
                label="Cleared"
                value={currentFinance?.cleared ?? "—"}
                tone="success"
                meta={previousFinance ? `${previousFinance.cleared} last term` : ""}
              />
              <StatCard
                label="Still owing"
                value={currentFinance?.with_balance ?? "—"}
                tone="warning"
                meta={previousFinance ? `${previousFinance.with_balance} last term` : ""}
              />
              <StatCard
                label="Average balance"
                value={peso(currentFinance?.average_balance)}
                tone="info"
                meta={previousFinance ? `was ${peso(previousFinance.average_balance)}` : ""}
              />
              <StatCard label="Total owed" value={peso(currentFinance?.total_balance)} tone="default" meta="across this term" />
            </StatCardGrid>
            {previousFinance ? (
              <p style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
                Change in average balance:{" "}
                {/* goodWhen="down": owing less is the good direction, so the
                    green arrow points at a falling number. */}
                <Delta value={delta(currentFinance?.average_balance, previousFinance.average_balance)} goodWhen="down" digits={2} />
              </p>
            ) : null}
          </div>
          ) : null}

          {current.attendance?.by_remark && Object.keys(current.attendance.by_remark).length ? (
            <div style={CARD}>
              <strong style={{ fontSize: 14 }}>Attendance remarks</strong>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                {Object.entries(current.attendance.by_remark).map(([name, count]) => (
                  <span
                    key={name}
                    style={{
                      padding: "4px 10px",
                      borderRadius: 999,
                      fontSize: 12.5,
                      border: "1px solid var(--border-base)",
                      background: "var(--surface-page)",
                    }}
                  >
                    {name}: <strong>{count}</strong>
                    {previous?.attendance?.by_remark?.[name] !== undefined ? (
                      <span style={{ color: "var(--text-muted)" }}> (was {previous.attendance.by_remark[name]})</span>
                    ) : null}
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div style={CARD}>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 10 }}>
              <strong style={{ fontSize: 14, marginRight: 6 }}>Students</strong>
              <select value={filter} onChange={(event) => setFilter(event.target.value)} style={selectStyle}>
                {FILTERS.filter(
                  (entry) =>
                    (entry.key !== "with_balance" || visibility.finance) &&
                    (entry.key !== "with_failed" || visibility.grades)
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
                    (entry.key !== "pass_rate" || visibility.grades)
                ).map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    Sort by {entry.label.toLowerCase()}
                  </option>
                ))}
              </select>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Name or student number"
                style={{ ...selectStyle, minWidth: 200 }}
              />
              <span style={{ fontSize: 11.5, color: "var(--text-muted)", marginLeft: "auto" }}>
                {data?.pagination?.total ?? 0} matching
              </span>
            </div>

            <Table
              loading={loading}
              emptyText="No student matches this filter."
              /*
               * Stacked two-line blocks, same as the logbook: a heading line
               * over a smaller detail line, each short. `nowrap` holds that
               * shape, so the hyphenated student number on the second line
               * cannot break after a hyphen into what reads as two numbers.
               */
              columns={[
                { key: "student", label: "Student", nowrap: true },
                { key: "attendance", label: "Attendance", nowrap: true },
                { key: "attendance_change", label: "Change", nowrap: true },
                { key: "target", label: "Target", nowrap: true },
                ...(visibility.grades ? [{ key: "grades", label: "Pass rate", nowrap: true }] : []),
                ...(visibility.finance ? [{ key: "balance", label: "Balance", nowrap: true }] : []),
              ]}
              rows={(data?.students || []).map((row) => {
                const meets = row.current.meets_target;
                const palette = meets === null ? null : tone(meets ? "success" : "danger");
                return {
                  key: row.student_id,
                  student: (
                    <div>
                      <div style={{ fontWeight: 600 }}>{row.name}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.student_number}
                        {row.course_code ? ` · ${row.course_code}` : ""}
                        {row.year_level ? ` · Year ${row.year_level}` : ""}
                      </div>
                    </div>
                  ),
                  attendance: (
                    <div>
                      <div>{percent(row.current.attendance_rate)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.current.absent === null
                          ? "no record"
                          : `${row.current.absent} of ${row.current.classes} missed`}
                      </div>
                    </div>
                  ),
                  attendance_change: (
                    <div>
                      <Delta value={row.change.attendance_rate} suffix="%" goodWhen="up" />
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.previous.has_record ? `was ${percent(row.previous.attendance_rate)}` : "not enrolled then"}
                      </div>
                    </div>
                  ),
                  target: palette ? (
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontSize: 11.5,
                        whiteSpace: "nowrap",
                        background: palette.bg,
                        color: palette.text,
                      }}
                    >
                      {row.current.attendance_remark || (meets ? "Met" : "Missed")}
                    </span>
                  ) : (
                    <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>no target</span>
                  ),
                  grades: (
                    <div>
                      <div>{percent(row.current.pass_rate)}</div>
                      <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                        {row.current.grade_remark || (row.current.failed ? `${row.current.failed} failed` : "—")}
                      </div>
                    </div>
                  ),
                  balance: (
                    <div>
                      <div>{peso(row.current.balance)}</div>
                      <div style={{ fontSize: 11 }}>
                        <Delta value={row.change.balance} goodWhen="down" digits={2} />
                      </div>
                    </div>
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
