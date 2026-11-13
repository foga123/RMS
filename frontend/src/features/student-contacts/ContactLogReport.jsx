import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, formatTime } from "../../shared/lib/dateTime";
import { localDateIsoDaysAgo } from "../../shared/lib/localDate";
import { TABLE_EXPORT_FORMATS, exportTable } from "../../shared/lib/tableExport";
import { formatStudentName } from "../../shared/lib/studentName";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { getBackendUrl } from "../../shared/lib/url";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
// Straight at the files rather than through the ui barrel, which drags in
// react-router-dom and makes the component untestable for no reason of its own.
import Button from "../../shared/components/ui/Button";
import ExportMenu from "../../shared/components/ui/ExportMenu";
import Pagination from "../../shared/components/ui/Pagination";
import { StatCard, StatCardGrid } from "../../shared/components/ui/StatCard";
import Table from "../../shared/components/Table";
import DashboardPanel from "../../shared/layout/dashboard/DashboardPanel";

/**
 * The contact log: every contact action logged on the students this account
 * works, filtered, paged and exported.
 *
 * The queue shows a student's five latest attempts inside that student's card.
 * That answers "what happened with this student" and nothing wider - not "what
 * did I do this week", not "every referral to CSDL in September", and nothing
 * that can be handed to anyone. This is the same attempt log, flat.
 *
 * Everything is filtered on the server (student_contact_log.php), so the export
 * can hold every matching row rather than the page on screen, the same way the
 * audit log's does.
 */

const SEARCH_DEBOUNCE_MS = 300;

/** The export walks the log in pages this size, up to a ceiling it reports. */
const EXPORT_PAGE_SIZE = 500;
const EXPORT_MAX_ROWS = 20000;

/** Offsets rather than dates, so a preset stays right across midnight. */
const DATE_PRESETS = [
  { key: "today", label: "Today", from: () => localDateIsoDaysAgo(0), to: () => localDateIsoDaysAgo(0) },
  { key: "7d", label: "Last 7 days", from: () => localDateIsoDaysAgo(6), to: () => "" },
  { key: "30d", label: "Last 30 days", from: () => localDateIsoDaysAgo(29), to: () => "" },
];

const filterControlStyle = {
  border: "1px solid var(--border-base)",
  borderRadius: 8,
  padding: "7px 9px",
  fontSize: 11.5,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
};

const EMPTY_FACETS = { channels: [], outcomes: [], conductors: [] };

/** One page of the log under these filters, as a query string. */
function logQuery(filters, page, limit) {
  const params = new URLSearchParams({ page: String(page), limit: String(limit) });
  Object.entries(filters).forEach(([key, value]) => {
    if (value) params.set(key, value);
  });
  return params.toString();
}

function yearAndSection(row) {
  return [row.year_level ? yearLevelLabel(row.year_level) : "", row.section].filter(Boolean).join(" · ");
}

/*
 * The file's columns, declared apart from the table's: the table renders
 * elements, and a spreadsheet wants text. The file carries what the screen has
 * no room for - the reason, the recovery plan - because a report somebody
 * files should not be less than what they saw.
 */
const EXPORT_COLUMNS = [
  { key: "date", label: "Date" },
  { key: "time", label: "Time" },
  { key: "student_number", label: "Student No." },
  { key: "student_name", label: "Student Name" },
  { key: "program", label: "Program" },
  { key: "year_section", label: "Year & Section" },
  { key: "channel", label: "Channel" },
  { key: "outcome", label: "Outcome" },
  { key: "contact_status", label: "Contact Status" },
  { key: "reason", label: "Reason" },
  { key: "recovery_plan", label: "Plan if Not Recovered" },
  { key: "notes", label: "Notes" },
  { key: "conducted_by", label: "Conducted By" },
  { key: "conducted_by_role", label: "Role" },
];

/** The printout: what one action was, when, and by whom. */
const PDF_COLUMNS = EXPORT_COLUMNS.filter((column) => (
  ["date", "time", "student_number", "student_name", "channel", "outcome", "conducted_by"].includes(column.key)
));

/** An attempt as the file should hold it: plain text, no markup. */
function exportRow(row) {
  return {
    date: formatDate(row.contacted_at),
    time: formatTime(row.contacted_at),
    student_number: row.student_number || "",
    student_name: formatStudentName(row),
    program: row.course_name || row.course_code || "",
    year_section: yearAndSection(row),
    channel: row.channel || "",
    outcome: row.outcome || "No outcome recorded",
    contact_status: row.contact_status || "",
    reason: row.reason || "",
    recovery_plan: row.recovery_plan || "",
    notes: row.notes || "",
    conducted_by: row.conducted_by || "Unknown user",
    conducted_by_role: row.conducted_by_role || "",
  };
}

const COLUMNS = [
  { key: "date", label: "Date", nowrap: true, render: (row) => formatDate(row.contacted_at, { fallback: "—" }) },
  { key: "time", label: "Time", nowrap: true, render: (row) => formatTime(row.contacted_at, { fallback: "—" }) },
  {
    key: "student",
    label: "Student",
    render: (row) => (
      <span style={{ display: "grid", gap: 2 }}>
        <span style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{row.student_number || "No student number"}</span>
        <span style={{ color: "var(--text-secondary)" }}>{formatStudentName(row)}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
          {[row.course_code || row.course_name, yearAndSection(row)].filter(Boolean).join(" · ")}
        </span>
      </span>
    ),
  },
  { key: "channel", label: "Channel", nowrap: true },
  {
    key: "outcome",
    label: "Outcome",
    render: (row) => (
      <span style={{ display: "grid", gap: 2 }}>
        <span style={{ fontWeight: 600, color: row.outcome ? "var(--text-primary)" : "var(--text-muted)" }}>
          {row.outcome || "No outcome recorded"}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{row.contact_status}</span>
        {row.reason ? <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>Reason: {row.reason}</span> : null}
      </span>
    ),
  },
  {
    key: "conducted_by",
    label: "Conducted by",
    render: (row) => (
      <span style={{ display: "grid", gap: 2 }}>
        <span>{row.conducted_by || "Unknown user"}</span>
        {row.conducted_by_role ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}>{row.conducted_by_role}</span> : null}
      </span>
    ),
  },
  {
    key: "notes",
    label: "Notes",
    render: (row) => (
      <span style={{ display: "block", minWidth: 180, maxWidth: 320, color: row.notes ? "var(--text-secondary)" : "var(--text-muted)" }}>
        {row.notes || "—"}
      </span>
    ),
  },
];

export default function ContactLogReport() {
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [summary, setSummary] = useState(null);
  const [facets, setFacets] = useState(EMPTY_FACETS);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [channel, setChannel] = useState("");
  const [outcome, setOutcome] = useState("");
  const [conductedBy, setConductedBy] = useState("");

  const [exporting, setExporting] = useState("");
  const [exportNote, setExportNote] = useState(null);

  const beginRequest = useLatestRequest();

  const filters = useMemo(
    () => ({ search, from, to, channel, outcome, conducted_by: conductedBy }),
    [search, from, to, channel, outcome, conductedBy]
  );
  const hasFilters = Object.values(filters).some(Boolean);

  // A filter and the return to page 1 in one update, so one change is one
  // request - the audit log's reasoning, and its bug before it had this.
  const applyFilter = useCallback((setter, value) => {
    setter(value);
    setPage(1);
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => {
      setSearch(searchInput.trim());
      setPage(1);
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(async () => {
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl(`student_contact_log.php?${logQuery(filters, page, pageSize)}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load the contact log.");
      if (!isCurrent()) return;
      setRows(Array.isArray(json?.data) ? json.data : []);
      setTotal(Number(json?.pagination?.total) || 0);
      setSummary(json?.summary || null);
      setFacets({
        channels: json?.facets?.channels || [],
        outcomes: json?.facets?.outcomes || [],
        conductors: json?.facets?.conductors || [],
      });
    } catch (loadError) {
      if (!isCurrent()) return;
      setRows([]);
      setTotal(0);
      setSummary(null);
      setError(loadError?.message || "Failed to load the contact log.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, filters, page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The filters are in the file name, so two exports taken a month apart can
   * be told apart in a folder without opening either.
   */
  const exportFileName = useMemo(() => {
    const parts = ["contact-log"];
    if (channel) parts.push(channel);
    if (outcome) parts.push(outcome);
    if (from || to) parts.push(`${from || "start"}_to_${to || "today"}`);
    if (search || conductedBy) parts.push("filtered");
    return parts.join("-");
  }, [channel, conductedBy, from, outcome, search, to]);

  const runExport = useCallback(async (format) => {
    setExporting(format);
    setExportNote(null);
    try {
      // Every matching row, not the page on screen.
      const collected = [];
      let matched = 0;
      for (let next = 1; collected.length < EXPORT_MAX_ROWS; next += 1) {
        const res = await fetch(getBackendUrl(`student_contact_log.php?${logQuery(filters, next, EXPORT_PAGE_SIZE)}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.message || "Failed to read the contact log for export.");

        const batch = Array.isArray(json?.data) ? json.data : [];
        matched = Number(json?.pagination?.total) || 0;
        collected.push(...batch);
        if (batch.length < EXPORT_PAGE_SIZE || collected.length >= matched) break;
      }

      const wrote = exportTable(format, {
        filename: exportFileName,
        sheet: "Contact Log",
        columns: EXPORT_COLUMNS,
        pdfColumns: PDF_COLUMNS,
        rows: collected.map(exportRow),
      });

      if (!wrote) {
        setExportNote({
          tone: "error",
          text: hasFilters
            ? "Nothing matches these filters, so there is nothing to export."
            : "No contact actions have been logged yet, so there is nothing to export.",
        });
      } else if (collected.length < matched) {
        // A cut file that says nothing looks complete. This one says so.
        setExportNote({
          tone: "info",
          text: `The file holds the newest ${collected.length.toLocaleString()} of ${matched.toLocaleString()} matching actions. Narrow the dates to export the rest.`,
        });
      }
    } catch (exportError) {
      setExportNote({ tone: "error", text: exportError?.message || "Export failed." });
    } finally {
      setExporting("");
    }
  }, [exportFileName, filters, hasFilters]);

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setFrom("");
    setTo("");
    setChannel("");
    setOutcome("");
    setConductedBy("");
    setPage(1);
  }

  function applyPreset(preset) {
    setFrom(preset.from());
    setTo(preset.to());
    setPage(1);
  }

  const activePreset = DATE_PRESETS.find((preset) => preset.from() === from && preset.to() === to)?.key || "";

  return (
    <DashboardPanel>
      <div style={{ display: "grid", gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 9, flexWrap: "wrap" }}>
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, fontSize: 15, color: "var(--text-primary)" }}>Contact log</h3>
            <p style={{ margin: "3px 0 0", fontSize: 11.5, color: "var(--text-secondary)", maxWidth: 640 }}>
              Every contact action logged on the students you work: when it happened, how, what came of it and who
              conducted it. The export holds every row these filters match, not just this page.
            </p>
          </div>
          <ExportMenu
            options={TABLE_EXPORT_FORMATS}
            busyKey={exporting}
            onSelect={runExport}
            disabled={loading || total === 0}
          />
        </div>

        {error ? (
          <div role="alert" style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>
            {error}
          </div>
        ) : null}
        {exportNote ? (
          <div
            role={exportNote.tone === "error" ? "alert" : "status"}
            style={{
              padding: 8,
              borderRadius: 6,
              fontSize: 11.5,
              background: exportNote.tone === "error" ? "#fee2e2" : "var(--brand-50)",
              color: exportNote.tone === "error" ? "#991b1b" : "var(--brand-800)",
            }}
          >
            {exportNote.text}
          </div>
        ) : null}

        <StatCardGrid minWidth={180}>
          <StatCard
            label="Contact actions"
            value={total.toLocaleString()}
            loading={loading}
            meta={hasFilters ? "matching these filters" : "logged on your students"}
          />
          <StatCard label="Students" value={(summary?.students ?? 0).toLocaleString()} loading={loading} meta="with at least one action" />
          <StatCard label="Conducted by" value={(summary?.conductors ?? 0).toLocaleString()} loading={loading} meta="people who logged them" />
        </StatCardGrid>

        {/* All of these go to the server, so they search the whole log, not
            the page on screen - and the export honours exactly the same set. */}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Search by student number or name..."
            style={{ ...filterControlStyle, flex: "1 1 220px", minWidth: 0 }}
            aria-label="Search the contact log"
          />
          <select
            value={channel}
            onChange={(event) => applyFilter(setChannel, event.target.value)}
            style={{ ...filterControlStyle, maxWidth: 200 }}
            aria-label="Filter by channel"
          >
            <option value="">All channels</option>
            {facets.channels.map((option) => (
              <option key={option.key} value={option.key}>{`${option.label} (${option.count})`}</option>
            ))}
          </select>
          <select
            value={outcome}
            onChange={(event) => applyFilter(setOutcome, event.target.value)}
            style={{ ...filterControlStyle, maxWidth: 220 }}
            aria-label="Filter by outcome"
          >
            <option value="">All outcomes</option>
            {facets.outcomes.map((option) => (
              <option key={option.key} value={option.key}>{`${option.label} (${option.count})`}</option>
            ))}
          </select>
          <select
            value={conductedBy}
            onChange={(event) => applyFilter(setConductedBy, event.target.value)}
            style={{ ...filterControlStyle, maxWidth: 230 }}
            aria-label="Filter by who conducted it"
          >
            <option value="">Conducted by anyone</option>
            {facets.conductors.map((option) => (
              <option key={option.user_id} value={String(option.user_id)}>
                {`${option.name}${option.role ? ` · ${option.role}` : ""} (${option.count})`}
              </option>
            ))}
          </select>
        </div>

        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Between</span>
          <input
            type="date"
            value={from}
            max={to || undefined}
            onChange={(event) => applyFilter(setFrom, event.target.value)}
            style={{ ...filterControlStyle, colorScheme: "light" }}
            aria-label="Show actions from this date"
          />
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>and</span>
          <input
            type="date"
            value={to}
            min={from || undefined}
            onChange={(event) => applyFilter(setTo, event.target.value)}
            style={{ ...filterControlStyle, colorScheme: "light" }}
            aria-label="Show actions up to this date"
          />
          {DATE_PRESETS.map((preset) => (
            <button
              key={preset.key}
              type="button"
              onClick={() => applyPreset(preset)}
              aria-pressed={activePreset === preset.key}
              style={{
                ...filterControlStyle,
                cursor: "pointer",
                fontWeight: activePreset === preset.key ? 600 : 400,
                background: activePreset === preset.key ? "var(--brand-50)" : "var(--surface-base)",
                borderColor: activePreset === preset.key ? "var(--brand-200)" : "var(--border-base)",
                color: activePreset === preset.key ? "var(--brand-800)" : "var(--text-secondary)",
              }}
            >
              {preset.label}
            </button>
          ))}
          {hasFilters || searchInput ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          ) : null}
        </div>

        <Table
          columns={COLUMNS}
          rows={rows}
          loading={loading}
          emptyText={hasFilters ? "No contact actions match these filters." : "No contact actions have been logged on your students yet."}
        />

        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          onPageChange={setPage}
          onPageSizeChange={(size) => applyFilter(setPageSize, size)}
          pageSizeOptions={[20, 50, 100]}
          itemLabel="actions"
        />
      </div>
    </DashboardPanel>
  );
}
