import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Table from "../../shared/components/Table";
import { Button, Pagination, StatCard, StatCardGrid } from "../../shared/components/ui";
import { getBackendUrl } from "../../shared/lib/url";
import usePagedRows from "../../shared/hooks/usePagedRows";
import { buildAbsenceBands, groupAttendance, riskPointsFor, studentsNeedingAttention } from "./attendanceReportMetrics";
import { scopeToParams } from "./exportSources";
import { searchAttentionRows } from "./reportSearch";

/**
 * The Attendance Report.
 *
 * This used to render the attendance *management* page — the same grid of
 * editable rows, the same importer — so picking "Attendance Report" from the
 * report menu just showed the Attendance module again. A management screen
 * answers "what does this student's record say"; a report has to answer "who
 * do I act on", and those are different screens.
 *
 * So this one is built around the only attendance question the system actually
 * acts on: the retention model scores absence at 30% or more as 4.00 points and
 * 15% to 29.99% as 1.50. The bands here are those exact rules (see
 * attendanceReportMetrics.js), so the report and the engine can never disagree
 * about the same student.
 *
 * Data comes from attendance-summary.php, which already aggregated per student
 * and already knows how to export — it was written and then never wired to
 * anything.
 *
 * Scoping is the page's Department -> Course -> Year chain and nothing else.
 * This report used to carry its own Course dropdown as well, which meant the
 * page could read "Showing SCCJ · BSCRIM · Year 1" directly above tiles
 * counting all 509 students in the school: the page filter reached the export
 * only, the local one reached the body only, and neither said so. One filter,
 * sent to the server, so the tiles, the bands, the table and the export are
 * all answering the same question.
 */

const CARD = {
  background: "#ffffff",
  border: "1px solid #e2e8f0",
  borderRadius: 9,
  padding: 11,
  display: "grid",
  gap: 9,
};

const axisStyle = { fontSize: 10.5, fill: "#64748b" };

/** One page is 200 rows; the banding needs every student, not the first page. */
async function fetchAllAttendance(scopeQuery) {
  const rows = [];
  let page = 1;
  let stats = null;
  let total = Number.POSITIVE_INFINITY;

  while (rows.length < total && page <= 50) {
    const params = new URLSearchParams(scopeQuery);
    params.set("page", String(page));
    params.set("limit", "200");
    const res = await fetch(getBackendUrl(`attendance-summary.php?${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || "Failed to load attendance report");

    const batch = Array.isArray(json?.data) ? json.data : [];
    rows.push(...batch);
    if (stats === null) stats = json?.stats || null;

    const reported = Number(json?.pagination?.total);
    total = Number.isFinite(reported) ? reported : rows.length;
    if (batch.length === 0) break;
    page += 1;
  }

  return { rows, stats };
}

function BandTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div style={{ ...CARD, padding: "6px 9px", gap: 2, fontSize: 11.5, boxShadow: "0 8px 24px -16px rgba(15,23,42,0.4)" }}>
      <div style={{ fontWeight: 600, color: "#0f172a" }}>{row.label} absent</div>
      <div style={{ color: "#475569" }}>
        {(row.students || 0).toLocaleString()} student{row.students === 1 ? "" : "s"} · {Math.round(row.share || 0)}% of tracked
      </div>
      <div style={{ color: "#475569" }}>
        {row.points > 0 ? `Adds ${row.points.toFixed(2)} risk points` : "No risk points"}
      </div>
    </div>
  );
}

/*
 * One line of the breakdown. The total is the same row with a rule above it and
 * bold text — a separate component would be a second place to change a column.
 */
function BreakdownRow({ row, total = false }) {
  const cell = {
    padding: "6px 8px",
    borderTop: total ? "2px solid #cbd5e1" : "1px solid #e2e8f0",
    fontSize: 11.5,
    textAlign: "right",
    fontVariantNumeric: "tabular-nums",
    color: total ? "#0f172a" : "#475569",
    fontWeight: total ? 700 : 400,
  };
  const rate = Number(row.absent_rate) || 0;

  return (
    <tr>
      <td style={{ ...cell, textAlign: "left", color: "#0f172a", fontWeight: total ? 700 : 500 }}>{row.label}</td>
      <td style={cell}>{row.students.toLocaleString()}</td>
      <td style={cell}>{row.conducted.toLocaleString()}</td>
      <td style={cell}>{row.present.toLocaleString()}</td>
      <td style={cell}>{row.absent.toLocaleString()}</td>
      <td style={{ ...cell, color: rate >= 30 ? "#b91c1c" : rate >= 15 ? "#b45309" : cell.color, fontWeight: 600 }}>
        {rate.toFixed(2)}%
      </td>
      <td style={cell}>{row.watch.toLocaleString()}</td>
      <td style={{ ...cell, color: row.risk > 0 && !total ? "#b91c1c" : cell.color }}>{row.risk.toLocaleString()}</td>
    </tr>
  );
}

export default function AttendanceReport({ scope }) {
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  /*
   * Course or department. Not part of the page's scope chain: that chain
   * narrows *which* students are counted, and this only decides how the same
   * students are added up, so it stays local and costs no refetch.
   */
  const [groupBy, setGroupBy] = useState("course");

  // A string, not the object: `scope` is rebuilt on every render of the page
  // above, so depending on it directly would refetch forever.
  const scopeQuery = scopeToParams(scope).toString();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const { rows: loaded, stats: loadedStats } = await fetchAllAttendance(scopeQuery);
      setRows(loaded);
      setStats(loadedStats);
    } catch (loadError) {
      setRows([]);
      setStats(null);
      setError(loadError?.message || "Failed to load attendance report");
    } finally {
      setLoading(false);
    }
  }, [scopeQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const banding = useMemo(() => buildAbsenceBands(rows), [rows]);
  const breakdown = useMemo(() => groupAttendance(rows, groupBy), [rows, groupBy]);
  const attention = useMemo(() => studentsNeedingAttention(rows), [rows]);

  const filteredAttention = useMemo(() => searchAttentionRows(attention, search), [attention, search]);

  // The table pages; the tiles and the bands above still count every student,
  // because "36 at risk" has to mean 36 at risk and not 20 of them.
  const pagedAttention = usePagedRows(filteredAttention);

  const atRisk = banding.bands.find((band) => band.key === "risk")?.students ?? 0;
  const watch = banding.bands.find((band) => band.key === "watch")?.students ?? 0;

  /*
   * Straight from the server now. attendance-summary.php computes its stats
   * over the same filtered set it returns rows from, so once the scope travels
   * with the request this number already describes the students on screen —
   * the client-side recompute that used to sit here existed only because the
   * local course dropdown filtered rows the server knew nothing about.
   */
  const averageRate = stats ? Number(stats.average_attendance_rate) || 0 : null;

  // `nowrap` on the identifier and figure columns: student number, course code
  // and section are all hyphenated, and a line break after a hyphen turns one
  // value into what reads as two. Name is prose and still wraps.
  const columns = [
    { key: "student_id", label: "Student No.", nowrap: true },
    { key: "student_name", label: "Name" },
    { key: "course_code", label: "Course", nowrap: true, render: (row) => row.course_code || row.course_name || "-" },
    { key: "section", label: "Section", nowrap: true, render: (row) => row.section || "-" },
    { key: "total_classes_conducted", label: "Sessions", nowrap: true, render: (row) => (Number(row.total_classes_conducted) || 0).toLocaleString() },
    { key: "absent", label: "Absent", nowrap: true, render: (row) => (Number(row.absent) || 0).toLocaleString() },
    {
      key: "absent_percentage",
      label: "Absent %",
      nowrap: true,
      render: (row) => {
        const rate = Number(row.absent_percentage) || 0;
        const points = riskPointsFor(row);
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {/* The dot carries the band, the text stays in ink — and the points
                are spelled out, so the band never rests on colour alone. */}
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: points >= 4 ? "#b91c1c" : "#f59e0b",
                flex: "none",
              }}
            />
            <strong style={{ color: "#0f172a" }}>{rate.toFixed(2)}%</strong>
            <span style={{ color: "#64748b", fontSize: 10.5 }}>+{points.toFixed(2)}</span>
          </span>
        );
      },
    },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>{error}</div> : null}

      {/* No filter row here on purpose — the page's Department -> Course ->
          Year chain above is the only one, and it already scopes this fetch. */}
      <StatCardGrid minWidth={190}>
        <StatCard label="Students Tracked" value={loading ? "..." : banding.tracked} />
        <StatCard
          label="Average Attendance"
          value={loading ? "..." : averageRate == null ? "-" : `${averageRate.toFixed(2)}%`}
        />
        <StatCard label="At Risk (30%+ absent)" value={loading ? "..." : atRisk} tone="danger" />
        <StatCard label="Watchlist (15-29.9%)" value={loading ? "..." : watch} />
      </StatCardGrid>

      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
          <div>
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Absence Against The Retention Thresholds</h3>
            <p style={{ margin: "3px 0 0", color: "#64748b", fontSize: 11.5 }}>
              These are the retention model&apos;s own cut points, so a student shown here as at risk is one the engine is
              already scoring.
              {banding.untracked > 0
                ? ` ${banding.untracked} student${banding.untracked === 1 ? " has" : "s have"} no sessions recorded and ${
                    banding.untracked === 1 ? "is" : "are"
                  } left out — no record is not the same as perfect attendance.`
                : ""}
            </p>
          </div>
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>Refresh</Button>
        </div>

        {loading ? (
          <div style={{ color: "#64748b", fontSize: 12.5, padding: 12 }}>Loading attendance bands...</div>
        ) : (
          <div style={{ height: 168 }}>
            <ResponsiveContainer width="100%" height="100%">
              {/* Emphasis, not identity: the two bands that cost risk points
                  carry colour and the safe band recedes to gray. The story is
                  "how many are past the line", not "here are three categories". */}
              <BarChart data={banding.bands} layout="vertical" margin={{ top: 4, right: 56, left: 4, bottom: 4 }}>
                <XAxis type="number" allowDecimals={false} tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={axisStyle}
                  tickLine={false}
                  axisLine={{ stroke: "#e2e8f0" }}
                  width={96}
                />
                <Tooltip cursor={{ fill: "rgba(15,23,42,0.04)" }} content={<BandTooltip />} />
                <Bar dataKey="students" radius={[0, 4, 4, 0]} maxBarSize={24}>
                  {banding.bands.map((band) => (
                    <Cell key={band.key} fill={band.color} />
                  ))}
                  <LabelList
                    dataKey="students"
                    position="right"
                    formatter={(value) => (Number(value) || 0).toLocaleString()}
                    style={{ fontSize: 10.5, fill: "#64748b", fontWeight: 600 }}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
          <div>
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>
              Attendance By {groupBy === "department" ? "Department" : "Course"}
            </h3>
            <p style={{ margin: "3px 0 0", color: "#64748b", fontSize: 11.5 }}>
              Rates are recomputed from the sessions in each group, not averaged from the students in it, so a small
              section cannot swing the figure. The last row is the whole scope on the same basis.
            </p>
          </div>

          {/* Two buttons rather than a select: there are exactly two answers,
              and a two-option dropdown hides one of them behind a click. */}
          <div style={{ display: "inline-flex", gap: 6 }}>
            {[
              { key: "course", label: "By course" },
              { key: "department", label: "By department" },
            ].map((option) => (
              <Button
                key={option.key}
                variant={groupBy === option.key ? "primary" : "secondary"}
                onClick={() => setGroupBy(option.key)}
                aria-pressed={groupBy === option.key}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={{ color: "#64748b", fontSize: 12.5, padding: 12 }}>Loading breakdown...</div>
        ) : breakdown.groups.length === 0 ? (
          <div style={{ color: "#64748b", fontSize: 12.5, padding: 12 }}>
            No attendance recorded yet. Import an attendance file to populate this.
          </div>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
              <thead>
                <tr>
                  {[
                    { label: groupBy === "department" ? "Department" : "Course", align: "left" },
                    { label: "Students" },
                    { label: "Sessions" },
                    { label: "Present" },
                    { label: "Absent" },
                    { label: "Absent %" },
                    { label: "Watchlist" },
                    { label: "At risk" },
                  ].map((head) => (
                    <th
                      key={head.label}
                      style={{
                        padding: "6px 8px",
                        borderBottom: "2px solid #cbd5e1",
                        fontSize: 10.5,
                        fontWeight: 700,
                        color: "#0f172a",
                        textAlign: head.align || "right",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {head.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {breakdown.groups.map((group) => (
                  <BreakdownRow key={group.label} row={group} />
                ))}
                {/* The total sits at the end of the table, under everything it
                    is the total of — a figure above its parts reads as a
                    heading rather than as a sum. */}
                <BreakdownRow row={breakdown.total} total />
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={CARD}>
        {/* Excel, CSV, PDF and Print used to sit here, a second export control
            below the one in the page header. They are in that one now. */}
        <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>
          Students The Model Would Score ({attention.length})
        </h3>

        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search by name, student number, course or section..."
          style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 11.5, width: "100%" }}
        />

        <Table
          columns={columns}
          rows={pagedAttention.rows.map((row) => ({ ...row, id: row.student_record_id ?? row.student_id }))}
          loading={loading}
          emptyText={
            rows.length === 0
              ? "No attendance recorded yet. Import an attendance file to populate this."
              : "No student is at or past the 15% absence line."
          }
        />

        {/* Only once there is more than a page of them — a pagination bar under
            a nine-row table is furniture. */}
        {pagedAttention.total > pagedAttention.pageSize ? (
          <Pagination
            page={pagedAttention.page}
            pageSize={pagedAttention.pageSize}
            total={pagedAttention.total}
            onPageChange={pagedAttention.setPage}
            onPageSizeChange={pagedAttention.setPageSize}
            itemLabel="students"
            compact
          />
        ) : null}
      </div>
    </div>
  );
}
