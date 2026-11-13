import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Bar, BarChart, Cell, LabelList, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import Table from "../../shared/components/Table";
import { Button, Pagination, StatCard, StatCardGrid } from "../../shared/components/ui";
import usePagedRows from "../../shared/hooks/usePagedRows";
import { getBackendUrl } from "../../shared/lib/url";
import { downloadExcelFile } from "../../shared/lib/spreadsheet";
import { buildExportName, scopeToParams } from "./exportSources";
import {
  NO_RECORD,
  UNCHANGED_POINTS,
  bandKeyFor,
  buildBalanceBands,
  riskPointsFor,
  studentsNeedingAttention,
  unchangedBalanceCoverage,
} from "./financeReportMetrics";
import { searchAttentionRows } from "./reportSearch";

/**
 * The Finance Report.
 *
 * Built like the Attendance Report and for the same reason: a report has to
 * answer "who do I act on", which is not what the finance module answers (that
 * one edits balance rows). The bands here are the retention model's own finance
 * indicators, so a student this calls at risk is a student the engine is
 * already scoring — see financeReportMetrics.js.
 *
 * The overview already plots money as a waterfall building to the total owed.
 * This counts *students* per band instead, because the question here is how
 * many people need a conversation, not how the total is composed.
 *
 * Scoped by the page's Department -> Course -> Year chain and nothing else,
 * for the reason spelled out in AttendanceReport.jsx: a local Course dropdown
 * beside a page-level one gives the screen two answers to the same question
 * and no way to tell which one the numbers came from.
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

const peso = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", maximumFractionDigits: 0 });
const pesoExact = new Intl.NumberFormat("en-PH", { style: "currency", currency: "PHP", minimumFractionDigits: 2 });

async function fetchFinanceSummary(scopeQuery) {
  const res = await fetch(getBackendUrl(`finance-summary.php${scopeQuery ? `?${scopeQuery}` : ""}`), {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.message || "Failed to load finance report");

  return {
    rows: Array.isArray(json?.data) ? json.data : [],
    stats: json?.stats || null,
  };
}

function BandTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload || {};
  return (
    <div style={{ ...CARD, padding: "6px 9px", gap: 2, fontSize: 11.5, boxShadow: "0 8px 24px -16px rgba(15,23,42,0.4)" }}>
      <div style={{ fontWeight: 600, color: "#0f172a" }}>{row.label}</div>
      <div style={{ color: "#475569" }}>
        {(row.students || 0).toLocaleString()} student{row.students === 1 ? "" : "s"} · {Math.round(row.share || 0)}% of
        those with a record
      </div>
      <div style={{ color: "#475569" }}>{pesoExact.format(row.amount || 0)} owed in this band</div>
      <div style={{ color: "#475569" }}>
        {row.points > 0 ? `Adds ${row.points.toFixed(2)} risk points` : "No risk points"}
      </div>
    </div>
  );
}

export default function FinanceReport({ scope, scopeLabel = "" }) {
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  // A string, not the object: the page rebuilds `scope` on every render, so
  // depending on it directly would refetch forever.
  const scopeQuery = scopeToParams(scope).toString();

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      // Scoped server-side. Everything below derives from this one array, so
      // the tiles, the bands and the table cannot be a request apart.
      const { rows: loaded, stats: loadedStats } = await fetchFinanceSummary(scopeQuery);
      setRows(loaded);
      setStats(loadedStats);
    } catch (loadError) {
      setRows([]);
      setStats(null);
      setError(loadError?.message || "Failed to load finance report");
    } finally {
      setLoading(false);
    }
  }, [scopeQuery]);

  useEffect(() => {
    void load();
  }, [load]);

  const banding = useMemo(() => buildBalanceBands(rows), [rows]);
  const attention = useMemo(() => studentsNeedingAttention(rows), [rows]);
  const coverage = useMemo(() => unchangedBalanceCoverage(rows), [rows]);

  const filteredAttention = useMemo(() => searchAttentionRows(attention, search), [attention, search]);

  // The table pages; the tiles and the bands above still count every student.
  const pagedAttention = usePagedRows(filteredAttention);

  const overTenK = banding.bands.find((band) => band.key === "high")?.students ?? 0;

  const exportColumns = [
    { key: "student_id", label: "Student Number" },
    { key: "student_name", label: "Name" },
    { key: "course", label: "Course" },
    { key: "year_level", label: "Year" },
    { key: "section", label: "Section" },
    { key: "balance", label: "Outstanding Balance" },
    { key: "band", label: "Band" },
    { key: "unchanged", label: "Not Paid Down" },
    { key: "points", label: "Risk Points" },
    { key: "recorded_on", label: "Recorded On" },
  ];

  /*
   * Exported from what is on screen rather than from a second server query.
   * The whole point of the filter is that the export matches the report — an
   * export endpoint that re-runs its own query is how "Excel" ends up handing
   * back every course while the screen shows one.
   */
  const exportRows = () =>
    filteredAttention.map((row) => ({
      student_id: row.student_id,
      student_name: row.student_name,
      course: row.course_code || row.course_name || "",
      year_level: row.year_level ?? "",
      section: row.section || "",
      balance: (Number(row.balance) || 0).toFixed(2),
      band: banding.bands.find((band) => band.key === bandKeyFor(row))?.label || "",
      unchanged: row.balance_unchanged === true ? "Yes" : row.balance_unchanged === false ? "No" : "No prior term",
      points: riskPointsFor(row).toFixed(2),
      recorded_on: row.recorded_on || "",
    }));

  const handleExport = () => {
    // Named the same way every other export on the page is, so the file says
    // "finance-report-sccj-bscrim-year-1" rather than repeating the query
    // string back at whoever opens their downloads folder.
    downloadExcelFile(buildExportName(["finance-report"], scopeLabel), "Finance Report", exportColumns, exportRows());
  };

  // `nowrap` on the identifier columns: student number, course code and section
  // are all hyphenated, and a line break after a hyphen turns one value into
  // what reads as two. Name is prose and still wraps.
  const columns = [
    { key: "student_id", label: "Student No.", nowrap: true },
    { key: "student_name", label: "Name" },
    { key: "course_code", label: "Course", nowrap: true, render: (row) => row.course_code || row.course_name || "-" },
    { key: "section", label: "Section", nowrap: true, render: (row) => row.section || "-" },
    {
      key: "balance",
      label: "Balance",
      nowrap: true,
      render: (row) => {
        const band = banding.bands.find((entry) => entry.key === bandKeyFor(row));
        const points = riskPointsFor(row);
        return (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            {/* The dot carries the band, the text stays in ink, and the points
                are spelled out — the band never rests on colour alone. */}
            <span
              style={{ width: 8, height: 8, borderRadius: 2, background: band?.color || "#cbd5e1", flex: "none" }}
            />
            <strong style={{ color: "#0f172a", fontVariantNumeric: "tabular-nums" }}>
              {pesoExact.format(Number(row.balance) || 0)}
            </strong>
            <span style={{ color: "#64748b", fontSize: 10.5 }}>+{points.toFixed(2)}</span>
          </span>
        );
      },
    },
    {
      key: "balance_unchanged",
      label: "Paid down?",
      nowrap: true,
      render: (row) => {
        if (row.balance_unchanged === null || row.balance_unchanged === undefined) {
          return <span style={{ color: "#94a3b8", fontSize: 11 }}>No prior term</span>;
        }
        return row.balance_unchanged ? (
          <span style={{ color: "#991b1b", fontWeight: 600, fontSize: 11 }}>
            No (+{UNCHANGED_POINTS.toFixed(2)})
          </span>
        ) : (
          <span style={{ color: "#047857", fontSize: 11 }}>Yes</span>
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
        <StatCard label="Students With A Record" value={loading ? "..." : banding.tracked} />
        <StatCard label="Total Outstanding" value={loading ? "..." : peso.format(banding.totalOwed)} />
        <StatCard label="Owing ₱10,000+" value={loading ? "..." : overTenK} tone="danger" />
        <StatCard label="The Model Would Score" value={loading ? "..." : attention.length} />
      </StatCardGrid>

      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
          <div>
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Balances Against The Retention Thresholds</h3>
            <p style={{ margin: "3px 0 0", color: "#64748b", fontSize: 11.5 }}>
              These are the retention model&apos;s own cut points, so a student shown here as at risk is one the engine is
              already scoring.
              {banding.noRecord > 0
                ? ` ${banding.noRecord} student${banding.noRecord === 1 ? " has" : "s have"} no finance record and ${
                    banding.noRecord === 1 ? "is" : "are"
                  } left out — no record is not the same as owing nothing.`
                : ""}
            </p>
          </div>
          <Button variant="secondary" onClick={() => void load()} disabled={loading}>Refresh</Button>
        </div>

        {loading ? (
          <div style={{ color: "#64748b", fontSize: 12.5, padding: 12 }}>Loading balance bands...</div>
        ) : (
          <div style={{ height: 190 }}>
            <ResponsiveContainer width="100%" height="100%">
              {/* Horizontal so the band labels read at their natural size, and
                  ordered light-to-dark by severity rather than by size, so the
                  scale never repaints when the data moves. */}
              <BarChart data={banding.bands} layout="vertical" margin={{ top: 4, right: 92, left: 4, bottom: 4 }}>
                <XAxis type="number" allowDecimals={false} tick={axisStyle} tickLine={false} axisLine={false} />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={axisStyle}
                  tickLine={false}
                  axisLine={{ stroke: "#e2e8f0" }}
                  width={124}
                />
                <Tooltip cursor={{ fill: "rgba(15,23,42,0.04)" }} content={<BandTooltip />} />
                <Bar dataKey="students" radius={[0, 4, 4, 0]} maxBarSize={24}>
                  {banding.bands.map((band) => (
                    <Cell key={band.key} fill={band.color} />
                  ))}
                  {/* Required relief, not decoration: the amber step is under
                      3:1 on white, so the value must be readable as text. */}
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

        {!loading ? (
          <p style={{ margin: 0, fontSize: 10.5, color: "#64748b" }}>
            {coverage.comparable > 0
              ? `${coverage.unchanged} of ${coverage.comparable} students with a previous term have not paid anything down (+${UNCHANGED_POINTS.toFixed(2)} each).`
              : "The model adds 2.00 points for a balance that has not gone down since the previous term. No student here has a second finance record yet, so that rule cannot fire — it is not that everyone is paying down."}
          </p>
        ) : null}
      </div>

      <div style={CARD}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
          <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>
            Students The Model Would Score ({filteredAttention.length})
          </h3>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button variant="secondary" onClick={handleExport} disabled={loading || filteredAttention.length === 0}>
              Excel
            </Button>
            <Button variant="secondary" onClick={() => window.print()}>Print</Button>
          </div>
        </div>

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
            stats && stats.with_record === 0
              ? "No finance records yet. Import a finance file to populate this."
              : "No student is carrying a balance the model would score."
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

        {!loading && banding.noRecord > 0 ? (
          <p style={{ margin: 0, fontSize: 10.5, color: "#b45309" }}>
            {banding.noRecord.toLocaleString()} student{banding.noRecord === 1 ? "" : "s"} in this scope have no finance
            record at all and appear in none of the totals above. {NO_RECORD.label} is a gap in the data, not a settled
            account.
          </p>
        ) : null}
      </div>
    </div>
  );
}
