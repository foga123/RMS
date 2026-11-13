import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../hooks/useLatestRequest";
import { STUDENT_TYPE_NON_STAR, STUDENT_TYPE_STAR } from "../../lib/studentType";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getBackendUrl } from "../../lib/url";
import EvenGrid from "../ui/EvenGrid";
import ScopeFilter, { describeScope, scopeAfterCourseChange, scopeAfterDepartmentChange } from "../filters/ScopeFilter";
import { buildBalanceTiers, studentsWithNoBalance } from "./balanceTiers";
import { compactCount, summariseOverview, toPercentShares } from "./overviewMetrics";
import { romanizeYearLabel, yearLevelLabel } from "../../lib/yearLevel";

/**
 * The overview panel shared by the Dean, Admin and SSG dashboards.
 *
 * One component rather than three per-dashboard copies: the scoping rule is the
 * interesting part and it belongs in one place. The endpoint decides scope — a
 * dean is pinned to their own department server-side — so this only renders the
 * department chooser when the server says the viewer may choose.
 *
 * Five forms, one per job, because four bar charts in a row make every measure
 * look like the same kind of thing:
 *
 *   headline numbers    -> KPI row of stat tiles, not a chart at all
 *   students per year   -> horizontal bar (magnitude across an ordered scale)
 *   attendance per term -> stacked column (parts summing to sessions conducted,
 *                          over time)
 *   grade outcomes      -> 100% stacked horizontal bar (share, not volume)
 *   balance band        -> horizontal bar (headcount across an ordered scale)
 *
 * Every card also has a table view. A chart that can only be read by eye is not
 * readable by everyone, and the toggle costs one button.
 */

/**
 * The plot area, measured against the viewport instead of pinned at 232px.
 *
 * A fixed pixel height does not survive zoom. Browser zoom shrinks the viewport
 * in CSS pixels, so at 150% a 232px chart claimed half the visible page while
 * the cards beside it reflowed into one column — the panel stopped fitting and
 * had to be scrolled past. Sizing the plot in `vh` makes it a share of whatever
 * screen it is on, so zooming in and back out re-fits with no dead space and no
 * clipping.
 *
 * Clamped at both ends: below the floor the axis labels start colliding, and
 * above the ceiling a chart of four bars is just tall.
 */
const CHART_HEIGHT = "clamp(180px, 23vh, 264px)";

const TONE = {
  brand: "#059669",
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#94a3b8",
  grid: "#e2e8f0",
  danger: "#dc2626",
};

/**
 * Touching marks are separated by a 2px gap in the surface colour, not by a
 * border. A border adds ink that is not data; the gap is what makes adjacent
 * segments read as separate. Recharts has no gap property for stacked bars, so
 * it is painted as a stroke in the surface colour — which renders as the gap
 * rather than as an outline.
 *
 * Hardcoded white because the app has no dark theme: global.css defines no
 * prefers-color-scheme block and no data-theme selector, so the chart surface
 * is always --neutral-0.
 */
const SURFACE = "#ffffff";

/**
 * Grade outcomes. Worst on the axis, passed at the far end; the three
 * administrative outcomes in between have no severity order of their own, so
 * their sequence is free — and it is spent on colour separation.
 *
 * Measured, not eyeballed. The previous palette put slate #64748b next to green
 * and FAILED two checks: slate is below the chroma floor (it reads as gray
 * rather than as a colour) and the pair sat at ΔE 14.3 for normal vision,
 * under the 15 floor — meaning full-colour readers could not reliably tell
 * "No grade" from "Passed" where the two segments touched. Swapping slate for
 * blue and separating red from amber (which were themselves only 14.4 apart)
 * gives worst-adjacent ΔE 23.4 under protanopia and 30.6 for normal vision,
 * with every slot clearing the chroma floor and 3:1 on the surface.
 */
const GRADE_SERIES = [
  { key: "failed", label: "Failed", color: "#dc2626" },
  { key: "no_grade", label: "No grade", color: "#0284c7" },
  { key: "incomplete", label: "Incomplete", color: "#d97706" },
  { key: "no_credit", label: "No credit", color: "#7c3aed" },
  { key: "passed", label: "Passed", color: "#059669" },
];

const GRADE_KEYS = GRADE_SERIES.map((series) => series.key);

/**
 * Present sits on the baseline, absent above it, so the segment that matters is
 * the one breaking the line of the bars.
 *
 * Green and red are the pair the grades chart already uses for passed and
 * failed, so the dashboard says the same thing the same way twice. Worst CVD
 * separation 8.6 (deutan), above the 8 target, normal-vision 32.0, both
 * clearing 3:1 on white. Not a wide margin, so identity is carried by the
 * legend and the segment gap too, never by hue alone.
 */
const ATTENDANCE_SERIES = [
  { key: "present", label: "Present", color: TONE.brand },
  { key: "absent", label: "Absent", color: TONE.danger },
];

/**
 * The total bar's own shades, one step darker than the departments it sums.
 *
 * A summary bar drawn identically to the bars beside it reads as one more
 * department — "ALL" as a department code is exactly the kind of thing a reader
 * skims past. Darker rather than a different hue, because it is the same two
 * measures and a new colour would imply a new meaning.
 */
const ATTENDANCE_TOTAL_COLOR = { present: "#065f46", absent: "#991b1b" };

/**
 * Year levels are an ordered scale, so they take an ordinal ramp — one hue,
 * light to dark as the year rises — rather than four unrelated hues. The step
 * follows the year level itself, never the row's rank by size, so filtering the
 * chart never repaints a bar.
 *
 * Five steps because the data has five year levels — a fifth-year cohort does
 * exist, and a four-step ramp would have painted Year 4 and Year 5 identically.
 *
 * Validated with --ordinal: monotone in lightness, all ΔL gaps ≥ 0.06, single
 * hue (5° spread), light end clearing the surface at 2.47:1. Green has barely
 * enough room for five: the light end cannot go above #10b981 without dropping
 * under the 2:1 floor (#34d399 reaches only 1.87:1), and the dark end has to
 * run to #043524 to keep the last two steps far enough apart.
 */
const YEAR_RAMP = ["#10b981", "#059669", "#047857", "#06603f", "#043524"];

/** Outside the ordered scale, so outside the ramp. */
const YEAR_UNASSIGNED = TONE.faint;

function yearColor(yearLevel) {
  if (yearLevel == null) return YEAR_UNASSIGNED;
  const index = Math.min(Math.max(Number(yearLevel) - 1, 0), YEAR_RAMP.length - 1);
  return YEAR_RAMP[index];
}

/*
 * The balance ramp lives in ./balanceTiers with the tier arithmetic it
 * belongs to — an ordinal ramp for the same reason as the years above.
 */

const axisStyle = { fontSize: 10.5, fill: TONE.muted };

const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });

/** Axis ticks and bar labels: thousands and millions, so the axis stays narrow. */
function pesoCompact(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000) return `₱${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 2)}M`;
  if (Math.abs(n) >= 1_000) return `₱${Math.round(n / 1_000)}k`;
  return `₱${Math.round(n)}`;
}

/* ------------------------------------------------------------------ figures */

/**
 * The headline row. Four numbers that would each be a one-bar bar chart if they
 * were plotted, which is the classic way to bury a figure in chrome.
 */
function StatTile({ label, value, meta, delta, deltaGoodWhenUp = true }) {
  const hasDelta = delta != null && Number.isFinite(delta) && delta !== 0;
  const isUp = Number(delta) > 0;
  const deltaColor = hasDelta && isUp === deltaGoodWhenUp ? TONE.brand : TONE.danger;

  return (
    <div
      style={{
        border: "1px solid var(--border-base)",
        borderRadius: 9,
        background: "var(--surface-base)",
        padding: "10px 12px",
        display: "grid",
        gap: 2,
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{label}</span>
      <span
        style={{
          fontSize: 19.5,
          fontWeight: 600,
          color: "var(--text-primary)",
          lineHeight: 1.15,
          // Proportional figures on purpose: tabular-nums gives every digit the
          // width of a zero, which makes a number like 121 look loose at this size.
          fontVariantNumeric: "normal",
        }}
      >
        {value}
      </span>
      <span style={{ fontSize: 10.5, color: "var(--text-faint)", display: "flex", gap: 5, minHeight: 14 }}>
        {hasDelta ? (
          <span style={{ color: deltaColor, fontWeight: 600 }}>
            {isUp ? "▲" : "▼"} {Math.abs(delta)} pts
          </span>
        ) : null}
        {meta ? <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{meta}</span> : null}
      </span>
    </div>
  );
}

/* -------------------------------------------------------------------- cards */

/**
 * A chart and its table are the same data, so they are the same card with a
 * switch rather than two places to look. The tooltip enhances the chart; the
 * table is what makes every value reachable without hovering.
 */
function ChartCard({ title, description, children, table, empty, emptyText, dimmed }) {
  const [showTable, setShowTable] = useState(false);
  const canToggle = Boolean(table && table.rows?.length);

  return (
    <section
      style={{
        border: "1px solid var(--border-base)",
        borderRadius: 9,
        background: "var(--surface-base)",
        padding: 14,
        display: "grid",
        gap: 10,
        minWidth: 0,
        alignContent: "start",
      }}
    >
      <header style={{ display: "flex", alignItems: "start", gap: 8 }}>
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>{title}</h3>
          {description ? (
            <p style={{ margin: 0, fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{description}</p>
          ) : null}
        </div>

        {canToggle && !empty ? (
          <button
            type="button"
            onClick={() => setShowTable((current) => !current)}
            aria-pressed={showTable}
            style={{
              marginLeft: "auto",
              flex: "none",
              border: "1px solid var(--border-base)",
              borderRadius: 6,
              background: showTable ? "var(--surface-muted, #f1f5f9)" : "var(--surface-base)",
              color: "var(--text-secondary)",
              fontSize: 10.5,
              padding: "3px 8px",
              cursor: "pointer",
            }}
          >
            {showTable ? "Chart" : "Table"}
          </button>
        ) : null}
      </header>

      {empty ? (
        <div
          style={{
            height: CHART_HEIGHT,
            display: "grid",
            placeItems: "center",
            border: "1px dashed var(--border-base)",
            borderRadius: 8,
            color: "var(--text-faint)",
            fontSize: 11.5,
            textAlign: "center",
            padding: 12,
          }}
        >
          {emptyText}
        </div>
      ) : (
        <div
          style={{
            height: CHART_HEIGHT,
            minWidth: 0,
            overflow: showTable ? "auto" : "visible",
            // Held at reduced opacity while refetching rather than replaced by a
            // skeleton, so the panel never jumps and the previous answer stays
            // readable until the new one arrives.
            opacity: dimmed ? 0.55 : 1,
            transition: "opacity 140ms ease",
          }}
        >
          {showTable ? <DataTable {...table} /> : children}
        </div>
      )}
    </section>
  );
}

function DataTable({ head = [], rows = [] }) {
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
      <thead>
        <tr>
          {head.map((cell, index) => (
            <th
              key={cell}
              style={{
                textAlign: index === 0 ? "left" : "right",
                padding: "4px 6px",
                borderBottom: "1px solid var(--border-base)",
                color: "var(--text-muted)",
                fontWeight: 600,
                position: "sticky",
                top: 0,
                background: "var(--surface-base)",
              }}
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={String(row[0])}>
            {row.map((cell, index) => (
              <td
                key={head[index] ?? index}
                style={{
                  textAlign: index === 0 ? "left" : "right",
                  padding: "4px 6px",
                  borderBottom: "1px solid var(--border-subtle, #f1f5f9)",
                  color: index === 0 ? "var(--text-secondary)" : "var(--text-primary)",
                  // Columns of numbers do align vertically, so here tabular is right.
                  fontVariantNumeric: index === 0 ? "normal" : "tabular-nums",
                }}
              >
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/* ----------------------------------------------------------------- tooltips */

const tooltipStyle = {
  border: "1px solid var(--border-base)",
  borderRadius: 8,
  fontSize: 11.5,
  padding: "6px 9px",
  boxShadow: "0 8px 24px -16px rgba(15,23,42,0.4)",
};

function TooltipShell({ heading, rows }) {
  return (
    <div style={{ ...tooltipStyle, background: "var(--surface-base)" }}>
      <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 3 }}>{heading}</div>
      {rows.map((row) => (
        <div key={row.label} style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)" }}>
          {/* The swatch carries the identity so the text can stay in ink
              rather than being painted the series colour. */}
          {row.color ? (
            <span style={{ width: 8, height: 8, borderRadius: 2, background: row.color, flex: "none" }} />
          ) : null}
          <span>{row.label}</span>
          <span style={{ marginLeft: "auto", fontWeight: 600, color: "var(--text-primary)" }}>{row.value}</span>
        </div>
      ))}
    </div>
  );
}

function StudentsTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <TooltipShell
      heading={label}
      rows={[
        { label: "Students", color: yearColor(row.year_level), value: (Number(row.students) || 0).toLocaleString() },
        { label: STUDENT_TYPE_STAR, value: (Number(row.star) || 0).toLocaleString() },
        { label: STUDENT_TYPE_NON_STAR, value: (Number(row.nonstar) || 0).toLocaleString() },
      ]}
    />
  );
}

function AttendanceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  const conducted = (Number(row.present) || 0) + (Number(row.absent) || 0);
  return (
    <TooltipShell
      // The axis shows the department code to keep the labels upright; the
      // tooltip has room for the name someone would actually say out loud.
      heading={row.name || label}
      rows={[
        ...ATTENDANCE_SERIES.map((series) => ({
          label: series.label,
          color: series.color,
          value: (Number(row[series.key]) || 0).toLocaleString(),
        })),
        { label: "Conducted", value: conducted.toLocaleString() },
        { label: "Attendance rate", value: `${row.rate ?? 0}%` },
      ]}
    />
  );
}

/**
 * The chart plots shares, so the tooltip carries the counts the shares came
 * from — otherwise a year with 12 subjects and a year with 900 look identical.
 */
function GradesTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  const total = Number(row.share_total) || 0;
  return (
    <TooltipShell
      heading={label}
      rows={[
        ...[...GRADE_SERIES].reverse().map((series) => {
          const count = Number(row[series.key]) || 0;
          const share = total > 0 ? Math.round((count / total) * 100) : 0;
          return { label: series.label, color: series.color, value: `${share}% · ${count.toLocaleString()}` };
        }),
        { label: "Subjects taken", value: total.toLocaleString() },
      ]}
    />
  );
}

/**
 * The bar is a headcount, so the tooltip carries the money — otherwise a band
 * of 75 students and a band of 77 look equally important when one of them owes
 * ten times as much.
 *
 * The share is here too, which is the one thing the single stacked bar this
 * replaced said better: in a bar chart of counts the reader can see which band
 * is biggest but not what fraction of the college it is.
 */
function BalanceTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <TooltipShell
      heading={label}
      rows={[
        { label: "Students", color: row.color, value: (Number(row.students) || 0).toLocaleString() },
        { label: "Share of students", value: `${Math.round(Number(row.share) || 0)}%` },
        { label: "Owed by this band", value: peso.format(Number(row.amount) || 0) },
      ]}
    />
  );
}

/* ---------------------------------------------------------------- the panel */

export default function OverviewCharts({ title = "At a glance", className = "" }) {
  const beginRequest = useLatestRequest();
  const [data, setData] = useState(null);
  const [campusId, setCampusId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [yearLevel, setYearLevel] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (campusId) params.set("campus_id", campusId);
      if (departmentId) params.set("department_id", departmentId);
      if (courseId) params.set("course_id", courseId);
      if (yearLevel) params.set("year_level", yearLevel);
      const query = params.toString();
      const res = await fetch(getBackendUrl(`overview_analytics.php${query ? `?${query}` : ""}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load overview charts");
      if (!isCurrent()) return;
      setData(json);
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(loadError?.message || "Failed to load overview charts");
      setData(null);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, campusId, courseId, departmentId, yearLevel]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The server labels these "Year 1"; the college writes them "Year I". The
   * label is rewritten here rather than in the query so the endpoint keeps
   * returning one plain display string, and the numeral convention stays a
   * front-end decision made in one module.
   */
  const students = useMemo(
    () => (data?.students_by_year || []).map((row) => ({ ...row, label: romanizeYearLabel(row.label) })),
    [data]
  );
  const attendance = useMemo(() => data?.attendance_by_term || [], [data]);

  /*
   * Attendance split one level down, with the scope's own total as a final bar.
   *
   * The endpoint decides the level from where the reader already is:
   * departments while none is chosen, then that department's courses once one
   * is. Only one of the two arrives filled, so the card reads whichever it is
   * and the drill needs no second request. The total comes from the server
   * rather than being re-added here, so the last bar cannot disagree with the
   * ones it summarises.
   *
   * Two parts is the fewest that makes a comparison; one bar plus a total of
   * itself is the same number drawn twice, so below that the card falls back to
   * the per-term shape.
   */
  const attendanceSplit = useMemo(() => {
    const departmentRows = data?.attendance_by_department || [];
    const courseRows = data?.attendance_by_course || [];

    const by = departmentRows.length > 1 ? "department" : courseRows.length > 1 ? "course" : "term";
    if (by === "term") return { by, rows: [] };

    const parts = by === "department" ? departmentRows : courseRows;
    const total = data?.attendance_total;
    return { by, rows: total ? [...parts, total] : parts };
  }, [data]);

  const attendanceBy = attendanceSplit.by;
  /** Whichever shape the attendance card is drawing. */
  const attendanceSeries = attendanceBy === "term" ? attendance : attendanceSplit.rows;

  /** One writer for the scope, so the filter row and a bar click cannot drift. */
  const applyScope = useCallback((next) => {
    setCampusId(next.campusId ?? "");
    setDepartmentId(next.departmentId ?? "");
    setCourseId(next.courseId ?? "");
    setYearLevel(next.yearLevel ?? "");
  }, []);

  /*
   * Clicking a bar is the same move as picking that step in the filter row, so
   * it goes through the same clearing rules rather than a second set written
   * here — carrying a course across a department change is exactly the drift
   * ScopeFilter exists to prevent. The total bar summarises the others rather
   * than being one of them, so there is nothing under it to open.
   */
  const drillInto = useCallback((row) => {
    if (!row || row.is_total) return;

    if (row.department_id != null) {
      applyScope({ campusId, ...scopeAfterDepartmentChange(String(row.department_id)) });
      return;
    }
    if (row.course_id != null) {
      applyScope(scopeAfterCourseChange({ campusId, departmentId, courseId, yearLevel }, String(row.course_id)));
    }
  }, [applyScope, campusId, courseId, departmentId, yearLevel]);

  const attendanceDrillable = attendanceBy !== "term";

  const gradeShares = useMemo(
    () => toPercentShares(data?.grades_by_year, GRADE_KEYS).map((row) => ({ ...row, label: romanizeYearLabel(row.label) })),
    [data]
  );
  const balanceTiers = useMemo(() => buildBalanceTiers(data?.balance_by_tier), [data]);
  const noBalanceStudents = useMemo(() => studentsWithNoBalance(data?.balance_by_tier), [data]);
  const summary = useMemo(() => summariseOverview(data), [data]);

  const canChooseDepartment = Boolean(data?.scope?.can_choose_department);
  const departments = useMemo(() => data?.filters?.departments || [], [data]);
  const campuses = useMemo(() => data?.filters?.campuses || [], [data]);

  /*
   * Course is offered to everyone who can see the panel, including a dean: it
   * only narrows what they can already see, unlike department, which is a
   * permission boundary the server pins.
   */
  const courses = useMemo(() => data?.filters?.courses || [], [data]);

  const yearLevels = useMemo(() => data?.filters?.year_levels || [], [data]);

  /*
   * A dean is pinned to one department server-side, so for them the chain
   * starts already answered and Course is live immediately. Admin and SSG pick
   * a department first: with thirty courses spread across every department, an
   * ungrouped list of all of them is a worse control than two short ones, and
   * a course belongs to exactly one department so nothing is unreachable by
   * going through it.
   */
  const departmentLocked = Boolean(data?.scope?.department_locked);
  const departmentLabel = data?.scope?.department_name || "this department";
  const campusName = useMemo(() => {
    if (!campusId) return "";
    const match = campuses.find((campus) => String(campus.campus_id) === String(campusId));
    return match?.campus_code || match?.campus_name || "";
  }, [campusId, campuses]);

  const scopeLabel = describeScope({
    campusName,
    departmentName: data?.scope?.department_name,
    courseName: data?.scope?.course_name,
    yearLevel: data?.scope?.year_level,
  });

  // Refetching with something already on screen: dim it, do not tear it down.
  const dimmed = loading && data != null;

  return (
    <div className={className} style={{ display: "grid", gap: 12, minWidth: 0 }}>
      {/* One filter row above everything it scopes, never inside a card. Both
          controls narrow the same scope, so every card below always answers for
          the same set of students. */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 1, minWidth: 0 }}>
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>{title}</h2>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{scopeLabel}</span>
        </div>

        {/* Department feeds Course. The arrow between them is the whole point
            of the layout, so it is drawn rather than implied by adjacency. */}
        {/* Department feeds Course feeds Year level. The chain itself lives in
            ScopeFilter so the Reports page renders the same control rather than
            a second one that merely resembles it. */}
        <div style={{ marginLeft: "auto" }}>
          <ScopeFilter
            idPrefix="overview_charts"
            scope={{ campusId, departmentId, courseId, yearLevel }}
            onChange={applyScope}
            campuses={campuses}
            departments={departments}
            courses={courses}
            yearLevels={yearLevels}
            canChooseDepartment={canChooseDepartment}
            departmentLocked={departmentLocked}
            departmentLabel={departmentLabel}
          />
        </div>
      </div>

      {/* The server drops a course that is not in the department in scope. Left
          unsaid, every card would just render empty and read as "no data". */}
      {data?.scope?.course_dropped || data?.scope?.year_dropped ? (
        <div
          role="status"
          style={{
            background: "var(--warning-50, #fffbeb)",
            border: "1px solid var(--warning-200, #fde68a)",
            color: "var(--warning-800, #92400e)",
            borderRadius: 6,
            padding: "7px 9px",
            fontSize: 11,
          }}
        >
          {data?.scope?.course_dropped
            ? `That course is not in ${departmentLabel}, so the course filter was cleared.`
            : "No students are in that year level here, so the year filter was cleared."}
        </div>
      ) : null}

      {error ? (
        <div
          role="alert"
          style={{
            background: "var(--danger-100)",
            color: "var(--danger-800)",
            border: "1px solid var(--danger-200)",
            borderRadius: 6,
            padding: "8px 9px",
            fontSize: 11.5,
          }}
        >
          {error}
        </div>
      ) : null}

      {/* ------------------------------------------------------ KPI row */}
      <EvenGrid
        minItem={148}
        style={{ opacity: dimmed ? 0.55 : 1, transition: "opacity 140ms ease" }}
      >
        <StatTile label="Students in scope" value={compactCount(summary.students)} meta={scopeLabel} />
        <StatTile
          label="Attendance rate"
          value={summary.attendanceRate == null ? "—" : `${summary.attendanceRate}%`}
          meta={summary.attendanceTerm || "No terms recorded"}
          delta={summary.attendanceDelta}
          deltaGoodWhenUp
        />
        <StatTile
          label="Pass rate"
          value={summary.passRate == null ? "—" : `${summary.passRate}%`}
          meta={summary.subjectsGraded > 0 ? `${compactCount(summary.subjectsGraded)} subjects` : "No grades recorded"}
        />
        <StatTile
          label="Outstanding balance"
          value={pesoCompact(summary.balanceTotal)}
          meta={noBalanceStudents != null ? `${noBalanceStudents} owe nothing` : ""}
        />
      </EvenGrid>

      {/* Four cards, so never three-and-one: see EvenGrid. */}
      <EvenGrid minItem={320}>
        {/* ------------------------------------ students: horizontal bar */}
        <ChartCard
          title="Students by year level"
          description={
            // A single bar is the honest result of filtering to one year, but
            // without saying so it reads as missing data.
            data?.scope?.year_level
              ? `Filtered to ${yearLevelLabel(data.scope.year_level)}, so this card shows that year alone. Clear the year filter to compare across years.`
              : "Grouped by year rather than by course — thirty courses would make the axis unreadable. Shaded light to dark as the year rises."
          }
          empty={!loading && students.length === 0}
          emptyText={loading ? "Loading…" : "No students in scope yet."}
          dimmed={dimmed}
          table={{
            head: ["Year", "Students", STUDENT_TYPE_STAR, STUDENT_TYPE_NON_STAR],
            rows: students.map((row) => [
              row.label,
              (Number(row.students) || 0).toLocaleString(),
              (Number(row.star) || 0).toLocaleString(),
              (Number(row.nonstar) || 0).toLocaleString(),
            ]),
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            {/* Horizontal: the category labels read left-to-right at their
                natural size instead of being rotated under a column. */}
            <BarChart data={students} layout="vertical" margin={{ top: 4, right: 34, left: 4, bottom: 4 }}>
              <CartesianGrid stroke={TONE.grid} horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey="label"
                tick={axisStyle}
                tickLine={false}
                axisLine={{ stroke: TONE.grid }}
                width={66}
              />
              <Tooltip cursor={{ fill: "rgba(15,23,42,0.04)" }} content={<StudentsTooltip />} />
              {/* One series, so no legend box — the card title already names it. */}
              <Bar dataKey="students" name="Students" radius={[0, 4, 4, 0]} maxBarSize={24}>
                {students.map((entry) => (
                  <Cell key={entry.label} fill={yearColor(entry.year_level)} />
                ))}
                <LabelList
                  dataKey="students"
                  position="right"
                  formatter={(value) => (Number(value) || 0).toLocaleString()}
                  style={{ fontSize: 10.5, fill: TONE.muted, fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* -------------------------------------- attendance: stacked column */}
        <ChartCard
          title={
            attendanceBy === "department"
              ? "Attendance by department"
              : attendanceBy === "course"
                ? `Attendance by course in ${departmentLabel}`
                : "Attendance by sem"
          }
          description={
            attendanceBy === "department"
              ? "One bar per department, then the whole scope as the last, darker bar to compare them against. Click a department to break it down into its own courses. Sessions present and absent sum to the sessions conducted, so bar height is the department's load and red is what was missed."
              : attendanceBy === "course"
                ? `One bar per course, then ${departmentLabel} as a whole in the last, darker bar. Click a course to narrow every card to it.${
                    // A dean is pinned to one department, so there is no way
                    // back up for them and offering one would be a dead end.
                    canChooseDepartment ? " Clear the department filter to go back to comparing departments." : ""
                  }`
                : "Sessions present and absent. They sum to the sessions conducted, so bar height is the sem's load and red is what was missed. The rate is labelled because raw counts move with cohort size."
          }
          empty={!loading && attendanceSeries.length === 0}
          emptyText={loading ? "Loading…" : "No attendance recorded yet. Import an attendance file to populate this."}
          dimmed={dimmed}
          table={{
            head: [
              attendanceBy === "department" ? "Department" : attendanceBy === "course" ? "Course" : "Sem",
              "Present",
              "Absent",
              "Rate",
            ],
            rows: attendanceSeries.map((row) => [
              attendanceBy === "term" ? row.label : (row.name || row.label),
              (Number(row.present) || 0).toLocaleString(),
              (Number(row.absent) || 0).toLocaleString(),
              `${row.rate ?? 0}%`,
            ]),
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={attendanceSeries} margin={{ top: 18, right: 10, left: -18, bottom: 0 }}>
              <CartesianGrid stroke={TONE.grid} vertical={false} />
              <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: TONE.grid }} />
              <YAxis allowDecimals={false} tick={axisStyle} tickLine={false} axisLine={false} width={46} />
              <Tooltip cursor={{ fill: "rgba(15,23,42,0.04)" }} content={<AttendanceTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10.5, paddingTop: 4 }} iconSize={9} />
              {ATTENDANCE_SERIES.map((series, index) => (
                <Bar
                  key={series.key}
                  dataKey={series.key}
                  name={series.label}
                  stackId="attendance"
                  fill={series.color}
                  stroke={SURFACE}
                  strokeWidth={2}
                  maxBarSize={24}
                  radius={index === ATTENDANCE_SERIES.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]}
                  /* Recharts hands the bar's own datum here, so the click is
                     read off the row rather than off an index into the series. */
                  onClick={attendanceDrillable ? (entry) => drillInto(entry?.payload || entry) : undefined}
                >
                  {/* Only the summary bar differs, so a Cell per row is cheaper
                      than a second <Bar> with a filtered dataset. */}
                  {attendanceSeries.map((row) => (
                    <Cell
                      key={`${series.key}_${row.label}`}
                      fill={row.is_total ? ATTENDANCE_TOTAL_COLOR[series.key] : series.color}
                      /* The total summarises the bars beside it rather than
                         being one of them, so there is nothing under it to
                         open. Saying so with the cursor costs nothing. */
                      cursor={attendanceDrillable && !row.is_total ? "pointer" : "default"}
                    />
                  ))}
                  {/* The rate is the thing a dean acts on, and stacking counts
                      hides it — a taller bar can be a bigger cohort rather than
                      worse attendance. One label per bar, on the top segment
                      only, so it is not repeated per series. */}
                  {index === ATTENDANCE_SERIES.length - 1 ? (
                    <LabelList
                      dataKey="rate"
                      position="top"
                      formatter={(value) => `${value}%`}
                      style={{ fontSize: 10.5, fill: TONE.muted, fontWeight: 600 }}
                    />
                  ) : null}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* ------------------------------- grades: 100% stacked horizontal */}
        <ChartCard
          title="Grade outcomes by year level"
          description={
            data?.scope?.year_level
              ? `Share of subjects taken by ${yearLevelLabel(data.scope.year_level)}. Clear the year filter to compare years against each other.`
              : "Share of subjects taken, so a small year and a large one can be compared directly. The counts behind each share are in the tooltip and the table."
          }
          empty={!loading && gradeShares.length === 0}
          emptyText={loading ? "Loading…" : "No grades recorded yet. Import a grades file to populate this."}
          dimmed={dimmed}
          table={{
            head: ["Year", "Passed", "Failed", "Inc.", "No cr.", "No gr."],
            rows: gradeShares.map((row) => [
              row.label,
              (Number(row.passed) || 0).toLocaleString(),
              (Number(row.failed) || 0).toLocaleString(),
              (Number(row.incomplete) || 0).toLocaleString(),
              (Number(row.no_credit) || 0).toLocaleString(),
              (Number(row.no_grade) || 0).toLocaleString(),
            ]),
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={gradeShares} layout="vertical" margin={{ top: 4, right: 8, left: 4, bottom: 0 }}>
              <CartesianGrid stroke={TONE.grid} horizontal={false} />
              <XAxis
                type="number"
                domain={[0, 100]}
                ticks={[0, 25, 50, 75, 100]}
                tickFormatter={(value) => `${value}%`}
                tick={axisStyle}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="label"
                tick={axisStyle}
                tickLine={false}
                axisLine={{ stroke: TONE.grid }}
                width={66}
              />
              <Tooltip cursor={{ fill: "rgba(15,23,42,0.04)" }} content={<GradesTooltip />} />
              <Legend wrapperStyle={{ fontSize: 10.5, paddingTop: 4 }} iconSize={9} />
              {/* No inline segment labels: at five segments the thin ones cannot
                  fit text without clipping, and a clipped label is worse than
                  none. The axis, the tooltip and the table carry the values. */}
              {GRADE_SERIES.map((series, index) => (
                <Bar
                  key={series.key}
                  dataKey={`${series.key}_pct`}
                  name={series.label}
                  stackId="grades"
                  fill={series.color}
                  stroke={SURFACE}
                  strokeWidth={2}
                  maxBarSize={24}
                  radius={index === GRADE_SERIES.length - 1 ? [0, 4, 4, 0] : [0, 0, 0, 0]}
                />
              ))}
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>

        {/* --------------------------------- finance: one bar, whole cohort */}
        <ChartCard
          title="Students by balance band"
          description="Headcount per band, on what each student owes on their most recent bill. Green owes nothing; the amber deepens as the balance grows. Hover a bar for its share and the pesos behind it — the total owed is the KPI above."
          empty={!loading && balanceTiers.length === 0}
          emptyText={loading ? "Loading…" : "No outstanding balances recorded. Import a finance file to populate this."}
          dimmed={dimmed}
          table={{
            head: ["Tier", "Students", "Balance"],
            rows: (data?.balance_by_tier || []).map((row) => [
              row.label,
              (Number(row.students) || 0).toLocaleString(),
              peso.format(Number(row.amount) || 0),
            ]),
          }}
        >
          <ResponsiveContainer width="100%" height="100%">
            {/* Horizontal, like the students chart directly above it: the band
                names are phrases ("7.5K and Up") and would have to be rotated
                under a column. */}
            <BarChart data={balanceTiers} layout="vertical" margin={{ top: 4, right: 34, left: 4, bottom: 4 }}>
              <CartesianGrid stroke={TONE.grid} horizontal={false} />
              <XAxis type="number" allowDecimals={false} tick={axisStyle} tickLine={false} axisLine={false} />
              <YAxis
                type="category"
                dataKey="label"
                tick={axisStyle}
                tickLine={false}
                axisLine={{ stroke: TONE.grid }}
                width={78}
              />
              <Tooltip cursor={{ fill: "rgba(15,23,42,0.04)" }} content={<BalanceTooltip />} />
              {/* One series, so no legend box — the card title already names it. */}
              <Bar dataKey="students" name="Students" radius={[0, 4, 4, 0]} maxBarSize={24}>
                {balanceTiers.map((tier) => (
                  <Cell key={tier.label} fill={tier.color} />
                ))}
                <LabelList
                  dataKey="students"
                  position="right"
                  formatter={(value) => (Number(value) || 0).toLocaleString()}
                  style={{ fontSize: 10.5, fill: TONE.muted, fontWeight: 600 }}
                />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </ChartCard>
      </EvenGrid>
    </div>
  );
}
