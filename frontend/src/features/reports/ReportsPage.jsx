import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatDateTime } from "../../shared/lib/dateTime";
import { animate, motion } from "framer-motion";
import Table from "../../shared/components/Table";
import { Button, Pagination, StatCard, StatCardGrid } from "../../shared/components/ui";
import { getNotifications, getRetentionStatusLabels } from "../../shared/services/api";
import { buildStatusLabelLookup } from "../../shared/lib/retentionStatusLabels";
import { readAuditLogs, clearAuditLogs } from "../../shared/lib/audit";
import { getBackendUrl } from "../../shared/lib/url";
import AttendanceReport from "./AttendanceReport";
import FinanceReport from "./FinanceReport";
import TermComparisonReport from "./TermComparisonReport";
import TermLogbookReport from "./TermLogbookReport";
import ScopeFilter, { describeScope } from "../../shared/components/filters/ScopeFilter";
import useScopeOptions from "../../shared/hooks/useScopeOptions";
import usePagedRows from "../../shared/hooks/usePagedRows";
import ReportExport from "./ReportExport";
import { summariseGrades } from "./gradeReportMetrics";
import AuditLogsPanel from "../settings/panels/AuditLogsPanel";
import ContactLogReport from "../student-contacts/ContactLogReport";
import FacultyPeriodicalReport from "./FacultyPeriodicalReport";
import { yearLevelLabel } from "../../shared/lib/yearLevel";

const REPORT_OPTIONS = [
  { value: "students", label: "Student Report" },
  { value: "attendance", label: "Attendance Report" },
  { value: "finance", label: "Finance Report" },
  { value: "retention", label: "Retention Case Report" },
  { value: "users", label: "User Report" },
  { value: "audit", label: "Audit Trail Report" },
  { value: "notifications", label: "Notification Report" },
  { value: "archived", label: "Archived Records Report" },
  { value: "grades", label: "Grade Report" },
  { value: "survey", label: "Survey Report" },
  { value: "contacts", label: "Contact Workflow Report" },
  // Every contact action logged, by date, exportable: the Contact Workspace's
  // Contact log tab, offered here too so it sits with the other reports.
  { value: "contact_log", label: "Contact Log Report" },
  { value: "faculty_periodical", label: "Faculty Periodical Report" },
  // The only report that answers "compared with what". Every other entry above
  // describes one term; this one puts two side by side over the same students,
  // which is what says whether anything changed.
  { value: "comparison", label: "Term Comparison Report" },
  // The register behind the comparison: one term, opened by year then
  // semester then periodical, listing everyone who left a record in it.
  { value: "logbook", label: "Records Logbook" },
];

/**
 * The reports whose rows hang off a student, so department / course / year
 * level actually narrow them. A survey or audit report has no student to scope
 * by, and offering a filter that silently does nothing is worse than offering
 * none — the reader trusts the number they are shown.
 */
// `students` joins the three that were already here: student.php accepts
// department_id, course_id and year_level, which is exactly what the scope
// chooser sets, so the filter narrows the export the same way it narrows the
// other three.
const SCOPED_REPORTS = new Set(["students", "attendance", "grades", "finance", "comparison", "logbook"]);

const emptyUserSummary = {
  total: null,
  active: null,
  inactive: null,
  archived: null,
  student_users: null,
  by_role: [],
};

const emptySurveySummary = {
  total_surveys: null,
  active_surveys: null,
  inactive_surveys: null,
  total_questions: null,
  total_submissions: null,
  total_responses: null,
  average_responses_per_submission: 0,
  by_survey: [],
  filters: { surveys: [], questions: [], question_types: [] },
  question_breakdown: [],
  answers: [],
  answers_total: 0,
  page: 1,
  page_size: 50,
};

/** Blank = no filter. Mirrors the optional params on survey-summary.php. */
const emptySurveyFilters = {
  survey_id: "",
  question_type: "",
  question_id: "",
  search: "",
  page: 1,
};

const SURVEY_ANSWERS_PAGE_SIZE = 50;

const QUESTION_TYPE_LABELS = {
  text: "Text",
  radio: "Single choice",
  checkbox: "Multiple choice",
  rating: "Rating",
};

const surveyFilterLabelStyle = {
  display: "grid",
  gap: 2,
  fontSize: 10.5,
  fontWeight: 600,
  color: "#475569",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};

const surveyFilterControlStyle = {
  padding: "5px 7px",
  border: "1px solid #cbd5e1",
  borderRadius: 5,
  fontSize: 11.5,
  fontWeight: 400,
  color: "#0f172a",
  background: "#ffffff",
  textTransform: "none",
  letterSpacing: "normal",
  minWidth: 0,
};

function surveyPagerButtonStyle(disabled) {
  return {
    border: "1px solid #cbd5e1",
    background: disabled ? "#f1f5f9" : "#ffffff",
    color: disabled ? "#94a3b8" : "#334155",
    borderRadius: 5,
    padding: "4px 9px",
    fontSize: 10.5,
    cursor: disabled ? "not-allowed" : "pointer",
  };
}

const emptyStudentReport = {
  total: null,
  active: null,
  archived: null,
  course_total: null,
  by_course: [],
  by_year_level: [],
};

const emptyRetentionReport = {
  total_cases: null,
  pending_validation: null,
  assigned_cases: null,
  resolved_cases: null,
  high_risk: null,
  by_risk: [],
  by_intervention: [],
  by_course: [],
  recent_cases: [],
};

const emptyContactReport = {
  summary: {
    total_students: null,
    contacted_students: null,
    uncontacted_students: null,
    follow_up_students: null,
    escalated_cases: null,
    queued_home_visits: null,
    scheduled_home_visits: null,
    completed_home_visits: null,
  },
  by_status: [],
  by_home_visit_status: [],
  by_department: [],
  recent_escalations: [],
  completion_logs: [],
};

const statusTone = {
  active: { label: "Active", color: "#10b981", key: "active" },
  inactive: { label: "Inactive", color: "#ef4444", key: "inactive" },
  archived: { label: "Archived", color: "#f59e0b", key: "archived" },
};

const surveyStatusTone = {
  active: { label: "Active Surveys", color: "#047857", key: "active_surveys" },
  inactive: { label: "Inactive Surveys", color: "#dc2626", key: "inactive_surveys" },
};

const retentionRiskMeta = [
  { key: "high", label: "High Risk", color: "#dc2626" },
  { key: "moderate", label: "Moderate Risk", color: "#d97706" },
  { key: "low", label: "Low Risk", color: "#059669" },
];

const retentionInterventionMeta = [
  { key: "unassigned", label: "Unassigned", color: "#64748b" },
  { key: "assigned", label: "Assigned", color: "#059669" },
  { key: "in_progress", label: "In Progress", color: "#047857" },
  { key: "follow_up", label: "Follow Up", color: "#059669" },
  { key: "resolved", label: "Resolved", color: "#059669" },
];

const rolePalette = ["#0284c7", "#059669", "#f59e0b", "#ef4444", "#059669", "#0ea5e9", "#10b981", "#a16207"];
const studentPalette = ["#059669", "#0284c7", "#d97706", "#dc2626", "#059669", "#0ea5e9", "#059669", "#475569"];
const gradePalette = ["#047857", "#059669", "#d97706", "#dc2626", "#059669", "#059669", "#059669", "#475569"];
const surveyPalette = ["#059669", "#047857", "#d97706", "#dc2626", "#059669", "#059669", "#059669", "#475569"];
const CHART_APPEAR_DURATION = 0.6;
const CHART_FILL_DURATION = 1;
const STATUS_CHART_DELAY = 0;
const ROLE_CHART_DELAY = 0.3;

function buildPieData(items) {
  const list = Array.isArray(items) ? items : [];
  const total = list.reduce((sum, item) => sum + Number(item?.value || 0), 0);
  if (total <= 0) {
    return {
      total: 0,
      legend: list.map((item) => ({ ...item, value: Number(item?.value || 0), percent: 0 })),
      segments: [],
    };
  }

  let startRatio = 0;
  const segments = [];
  const legend = list.map((item) => {
    const value = Number(item?.value || 0);
    const percent = Math.round((value / total) * 100);
    const ratio = value / total;
    if (value > 0) {
      segments.push({
        key: item.key || item.label,
        color: item.color,
        startRatio,
        ratio,
      });
    }
    startRatio += ratio;
    return { ...item, value, percent };
  });

  return {
    total,
    legend,
    segments,
  };
}

function CountUpNumber({ value, delay = 0, duration = CHART_FILL_DURATION }) {
  const targetValue = Number(value || 0);
  const [displayValue, setDisplayValue] = useState(0);

  useEffect(() => {
    const controls = animate(0, targetValue, {
      duration,
      delay,
      ease: "easeOut",
      onUpdate: (latest) => setDisplayValue(latest),
    });
    return () => controls.stop();
  }, [targetValue, delay, duration]);

  return Math.round(displayValue).toLocaleString();
}

function PieChartCard({ title, subtitle, centerLabel, centerValue, data, loading, animationDelay = 0 }) {
  const chart = buildPieData(data);
  const chartSize = 220;
  const strokeWidth = 38;
  const radius = (chartSize - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  const labelRevealDelay = animationDelay + CHART_FILL_DURATION;

  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 9,
        padding: 12,
        display: "grid",
        gap: 9,
      }}
    >
      <div>
        <h3 style={{ margin: 0, color: "#0f172a" }}>{title}</h3>
        {subtitle ? <p style={{ margin: "3px 0 0", color: "#64748b", fontSize: 11.5 }}>{subtitle}</p> : null}
      </div>

      {loading ? (
        <div style={{ color: "#64748b", fontSize: 12.5 }}>Loading pie chart...</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 187px), 1fr))", gap: 11, alignItems: "center" }}>
          <motion.div
            style={{
              width: chartSize,
              height: chartSize,
              maxWidth: "100%",
              position: "relative",
              margin: "0 auto",
            }}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: CHART_APPEAR_DURATION, delay: animationDelay }}
          >
            <motion.svg
              width={chartSize}
              height={chartSize}
              viewBox={`0 0 ${chartSize} ${chartSize}`}
              style={{ display: "block", transform: "rotate(-90deg)" }}
            >
              <circle
                cx={chartSize / 2}
                cy={chartSize / 2}
                r={radius}
                fill="none"
                stroke="#e2e8f0"
                strokeWidth={strokeWidth}
              />
              {chart.segments.map((segment) => {
                const segmentLength = segment.ratio * circumference;
                const segmentGap = Math.max(circumference - segmentLength, 0);
                return (
                  <circle
                    key={segment.key}
                    cx={chartSize / 2}
                    cy={chartSize / 2}
                    r={radius}
                    fill="none"
                    stroke={segment.color}
                    strokeWidth={strokeWidth}
                    strokeDasharray={`${segmentLength} ${segmentGap}`}
                    strokeDashoffset={-segment.startRatio * circumference}
                  />
                );
              })}
              {chart.segments.length > 0 ? (
                <motion.circle
                  cx={chartSize / 2}
                  cy={chartSize / 2}
                  r={radius}
                  fill="none"
                  stroke="#e2e8f0"
                  strokeWidth={strokeWidth}
                  strokeDasharray={circumference}
                  initial={{ strokeDashoffset: 0 }}
                  animate={{ strokeDashoffset: circumference }}
                  transition={{ duration: CHART_FILL_DURATION, delay: animationDelay, ease: "easeInOut" }}
                />
              ) : null}
            </motion.svg>
            <div
              style={{
                position: "absolute",
                inset: 32,
                borderRadius: "50%",
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                display: "grid",
                placeItems: "center",
                textAlign: "center",
                padding: 6,
              }}
            >
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: labelRevealDelay }}>
                <div style={{ fontSize: 19.5, fontWeight: 700, color: "#0f172a", lineHeight: 1 }}>
                  <CountUpNumber value={centerValue} delay={labelRevealDelay} />
                </div>
                <div style={{ fontSize: 10.5, color: "#64748b" }}>{centerLabel}</div>
              </motion.div>
            </div>
          </motion.div>

          <motion.div
            style={{ display: "grid", gap: 6 }}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.25, delay: labelRevealDelay }}
          >
            {chart.legend.length === 0 ? (
              <div style={{ color: "#64748b", fontSize: 11.5 }}>No data available.</div>
            ) : (
              chart.legend.map((item) => (
                <div
                  key={item.key || item.label}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 9,
                    borderBottom: "1px solid #f1f5f9",
                    paddingBottom: 5,
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "#334155", fontSize: 11.5, minWidth: 0 }}>
                    <span style={{ width: 9, height: 9, borderRadius: 999, background: item.color, flexShrink: 0 }} />
                    <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{item.label}</span>
                  </span>
                  <span style={{ color: "#64748b", fontSize: 10.5, whiteSpace: "nowrap" }}>
                    <CountUpNumber value={item.value} delay={labelRevealDelay} /> ({item.percent}%)
                  </span>
                </div>
              ))
            )}
          </motion.div>
        </div>
      )}
    </div>
  );
}

function formatDecimal(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "0.00";
  return num.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatTokenLabel(value) {
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

async function fetchAllPages(path, query = {}, limit = 200) {
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  const rows = [];

  while (rows.length < total) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(limit));

    Object.entries(query || {}).forEach(([key, value]) => {
      if (value == null || value === "") return;
      params.set(key, String(value));
    });

    const res = await fetch(getBackendUrl(`${path}?${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.message || `Failed to load ${path}`);

    const batch = Array.isArray(json?.data) ? json.data : [];
    rows.push(...batch);

    const reportedTotal = Number(json?.pagination?.total);
    total = Number.isFinite(reportedTotal) ? reportedTotal : rows.length;
    if (batch.length === 0) break;
    page += 1;
    if (page > 100) break;
  }

  return rows;
}

function buildTopPieRows(rows, palette, valueKey = "total") {
  const normalized = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      key: row?.key || row?.label || "item",
      label: row?.label || "Unknown",
      value: Number(row?.[valueKey] || 0),
    }))
    .filter((item) => item.value > 0)
    .sort((a, b) => b.value - a.value);

  const top = normalized.slice(0, 7).map((item, idx) => ({ ...item, color: palette[idx % palette.length] }));
  if (normalized.length > 7) {
    const others = normalized.slice(7).reduce((sum, item) => sum + item.value, 0);
    if (others > 0) {
      top.push({ key: `${valueKey}_others`, label: "Others", value: others, color: "#94a3b8" });
    }
  }

  return top;
}

function downloadCsv(filename, columns, rows) {
  const escapeCell = (value) => {
    const text = String(value ?? "");
    if (/[",\r\n]/.test(text)) {
      return `"${text.replace(/"/g, '""')}"`;
    }
    return text;
  };
  const csv = [
    columns.map((column) => escapeCell(column.label)).join(","),
    ...rows.map((row) => columns.map((column) => escapeCell(typeof column.value === "function" ? column.value(row) : row[column.key])).join(",")),
  ].join("\r\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function ReportCard({ title, children, actions = null }) {
  return (
    <div
      style={{
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 9,
        padding: 11,
        display: "grid",
        gap: 9,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>{title}</h3>
        {actions}
      </div>
      {children}
    </div>
  );
}

function NotificationReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(25);
  const [total, setTotal] = useState(0);

  const loadNotifications = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const payload = await getNotifications({ page, limit });
      const data = payload?.data || {};
      setRows(Array.isArray(data.items) ? data.items : []);
      setTotal(Number(data.total || 0));
    } catch (notificationError) {
      setRows([]);
      setTotal(0);
      setError(notificationError?.message || "Failed to load notifications.");
    } finally {
      setLoading(false);
    }
  }, [limit, page]);

  useEffect(() => {
    void loadNotifications();
  }, [loadNotifications]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      const isRead = Boolean(row?.is_read);
      if (status === "read" && !isRead) return false;
      if (status === "unread" && isRead) return false;
      if (!q) return true;
      return [row?.title, row?.message, row?.level, row?.module_key]
        .some((value) => String(value || "").toLowerCase().includes(q));
    });
  }, [rows, search, status]);

  const unreadCount = rows.filter((row) => !row?.is_read).length;
  const totalPages = Math.max(1, Math.ceil(total / limit));
  // Title and Message are the prose here and wrap; the stamp and the two labels
  // hold one line, a formatted date being a string CSS will break after a slash.
  const columns = [
    { key: "created_at", label: "Created", nowrap: true, render: (row) => formatDateTime(row.created_at) },
    { key: "level", label: "Level", nowrap: true, render: (row) => formatTokenLabel(row.level || "info") },
    { key: "title", label: "Title" },
    { key: "message", label: "Message" },
    { key: "status", label: "Status", nowrap: true, render: (row) => (row.is_read ? "Read" : "Unread") },
  ];
  const exportColumns = [
    { key: "created_at", label: "Created", value: (row) => formatDateTime(row.created_at) },
    { key: "level", label: "Level", value: (row) => formatTokenLabel(row.level || "info") },
    { key: "title", label: "Title" },
    { key: "message", label: "Message" },
    { key: "status", label: "Status", value: (row) => (row.is_read ? "Read" : "Unread") },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>{error}</div> : null}
      <StatCardGrid minWidth={190}>
        <StatCard label="Loaded Notifications" value={loading ? "..." : rows.length} />
        <StatCard label="Unread On Page" value={loading ? "..." : unreadCount} tone="danger" />
        <StatCard label="Total Available" value={loading ? "..." : total} />
      </StatCardGrid>
      <ReportCard
        title="Notification Activity"
        actions={(
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button variant="secondary" onClick={() => void loadNotifications()} disabled={loading}>Refresh</Button>
            <Button variant="secondary" onClick={() => downloadCsv("notification-report.csv", exportColumns, filteredRows)} disabled={filteredRows.length === 0}>Excel</Button>
            <Button variant="secondary" onClick={() => window.print()}>Print</Button>
          </div>
        )}
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search notifications..."
            style={{ minWidth: 187, flex: "1 1 240px", border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 11.5 }}
          />
          <select
            value={status}
            onChange={(event) => setStatus(event.target.value)}
            style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 11.5 }}
          >
            <option value="all">All statuses</option>
            <option value="unread">Unread</option>
            <option value="read">Read</option>
          </select>
          <select
            value={limit}
            onChange={(event) => {
              setLimit(Number(event.target.value));
              setPage(1);
            }}
            style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 11.5 }}
          >
            {[10, 25, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
          </select>
        </div>
        <Table columns={columns} rows={filteredRows.map((row) => ({ ...row, id: row.notification_id }))} loading={loading} emptyText="No notifications found." />
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center", flexWrap: "wrap", color: "#475569", fontSize: 11.5 }}>
          <span>Showing {filteredRows.length} of {rows.length} loaded rows</span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <Button variant="secondary" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1}>Prev</Button>
            <span>Page <strong>{page}</strong> of <strong>{totalPages}</strong></span>
            <Button variant="secondary" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages}>Next</Button>
          </div>
        </div>
      </ReportCard>
    </div>
  );
}

function ArchivedRecordsReport() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [recordType, setRecordType] = useState("all");

  const loadArchivedRecords = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [archivedUsersResult, allStudentsResult] = await Promise.allSettled([
        fetchAllPages("user.php", { archived: 1 }),
        // The whole cohort, so ask for it in the largest pages student.php
        // allows: the per-request floor dwarfs the row cost, and 200 made this
        // fourteen round trips where three will do.
        fetchAllPages("student.php", { include_archived: 1 }, 1000),
      ]);
      const archivedUsers = archivedUsersResult.status === "fulfilled" ? archivedUsersResult.value : [];
      const allStudents = allStudentsResult.status === "fulfilled" ? allStudentsResult.value : [];
      if (archivedUsersResult.status === "rejected" && allStudentsResult.status === "rejected") {
        throw archivedUsersResult.reason || allStudentsResult.reason;
      }

      const userRows = archivedUsers.map((row) => ({
        id: `user-${row.user_id}`,
        type: "User",
        name: `${row.first_name || ""} ${row.last_name || ""}`.trim() || row.email || `User ${row.user_id}`,
        identifier: row.email || row.user_id,
        status: row.status_name || "Archived",
        archived_at: row.archived_at || row.updated_at || null,
      }));
      const studentRows = allStudents
        .filter((row) => Boolean(row?.archived_at))
        .map((row) => ({
          id: `student-${row.student_id}`,
          type: "Student",
          name: `${row.first_name || ""} ${row.last_name || ""}`.trim() || row.student_number || `Student ${row.student_id}`,
          identifier: row.student_number || row.student_id,
          status: row.status_name || "Archived",
          archived_at: row.archived_at || null,
        }));

      setRows([...userRows, ...studentRows].sort((a, b) => String(b.archived_at || "").localeCompare(String(a.archived_at || ""))));
    } catch (archivedError) {
      setRows([]);
      setError(archivedError?.message || "Failed to load archived records.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadArchivedRecords();
  }, [loadArchivedRecords]);

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (recordType !== "all" && row.type.toLowerCase() !== recordType) return false;
      if (!q) return true;
      return [row.type, row.name, row.identifier, row.status]
        .some((value) => String(value || "").toLowerCase().includes(q));
    });
  }, [recordType, rows, search]);

  // The table pages; the counts and the export below still see every row.
  const pagedRows = usePagedRows(filteredRows);

  const userCount = rows.filter((row) => row.type === "User").length;
  const studentCount = rows.filter((row) => row.type === "Student").length;
  // Identifier holds a student number or a username — never break it, which is
  // the whole point of the column. Name is the only prose row here.
  const columns = [
    { key: "type", label: "Record Type", nowrap: true },
    { key: "name", label: "Name" },
    { key: "identifier", label: "Identifier", nowrap: true },
    { key: "status", label: "Status", nowrap: true },
    { key: "archived_at", label: "Archived On", nowrap: true, render: (row) => formatDateTime(row.archived_at) },
  ];
  const exportColumns = [
    { key: "type", label: "Record Type" },
    { key: "name", label: "Name" },
    { key: "identifier", label: "Identifier" },
    { key: "status", label: "Status" },
    { key: "archived_at", label: "Archived On", value: (row) => formatDateTime(row.archived_at) },
  ];

  return (
    <div style={{ display: "grid", gap: 12 }}>
      {error ? <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>{error}</div> : null}
      <StatCardGrid minWidth={190}>
        <StatCard label="Archived Records" value={loading ? "..." : rows.length} />
        <StatCard label="Archived Users" value={loading ? "..." : userCount} />
        <StatCard label="Archived Students" value={loading ? "..." : studentCount} />
      </StatCardGrid>
      <ReportCard
        title="Archived Records"
        actions={(
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <Button variant="secondary" onClick={() => void loadArchivedRecords()} disabled={loading}>Refresh</Button>
            <Button variant="secondary" onClick={() => downloadCsv("archived-records-report.csv", exportColumns, filteredRows)} disabled={filteredRows.length === 0}>Excel</Button>
            <Button variant="secondary" onClick={() => window.print()}>Print</Button>
          </div>
        )}
      >
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search archived records..."
            style={{ minWidth: 187, flex: "1 1 240px", border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 11.5 }}
          />
          <select
            value={recordType}
            onChange={(event) => setRecordType(event.target.value)}
            style={{ border: "1px solid #cbd5e1", borderRadius: 8, padding: "7px 9px", fontSize: 11.5 }}
          >
            <option value="all">All record types</option>
            <option value="user">Users</option>
            <option value="student">Students</option>
          </select>
        </div>
        <Table columns={columns} rows={pagedRows.rows} loading={loading} emptyText="No archived records found." />

        {pagedRows.total > pagedRows.pageSize ? (
          <Pagination
            page={pagedRows.page}
            pageSize={pagedRows.pageSize}
            total={pagedRows.total}
            onPageChange={pagedRows.setPage}
            onPageSizeChange={pagedRows.setPageSize}
            itemLabel="archived records"
            compact
          />
        ) : null}
      </ReportCard>
    </div>
  );
}

export default function ReportsPage({
  allowedReports = ["users", "survey"],
  defaultReport = "",
  title = "Reports",
  description = "Switch between admin user metrics and survey result totals from one report screen.",
  onReportChange,
  reportPermissions = {},
}) {
  const allowedReportsKey = (Array.isArray(allowedReports) ? allowedReports : [])
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean)
    .join("|");
  const reportOptions = useMemo(() => {
    const allowedValues = allowedReportsKey ? allowedReportsKey.split("|") : [];
    if (allowedValues.length === 0) return [];

    const allowed = new Set(allowedValues);
    const filtered = REPORT_OPTIONS.filter((option) => allowed.has(option.value));
    return filtered;
  }, [allowedReportsKey]);
  const normalizedDefaultReport = useMemo(() => String(defaultReport || "").trim().toLowerCase(), [defaultReport]);
  const resolvedDefaultReport = useMemo(() => {
    if (reportOptions.some((option) => option.value === normalizedDefaultReport)) {
      return normalizedDefaultReport;
    }
    return reportOptions[0]?.value || "";
  }, [normalizedDefaultReport, reportOptions]);
  const [selectedReport, setSelectedReport] = useState(resolvedDefaultReport);
  const lastAppliedDefaultReportRef = useRef(resolvedDefaultReport);
  const [userSummary, setUserSummary] = useState(emptyUserSummary);
  const [userLoading, setUserLoading] = useState(true);
  const [userError, setUserError] = useState("");
  const [surveySummary, setSurveySummary] = useState(emptySurveySummary);
  const [surveyLoading, setSurveyLoading] = useState(true);
  const [surveyError, setSurveyError] = useState("");
  const [surveyFilters, setSurveyFilters] = useState(emptySurveyFilters);
  const [studentReport, setStudentReport] = useState(emptyStudentReport);
  const [studentLoading, setStudentLoading] = useState(true);
  const [studentError, setStudentError] = useState("");
  // The raw rows are kept rather than the summary, so the panels below can each
  // aggregate them differently without a request apiece.
  const [gradeRows, setGradeRows] = useState([]);
  const [gradeLoading, setGradeLoading] = useState(true);
  const [gradeError, setGradeError] = useState("");
  const [retentionReport, setRetentionReport] = useState(emptyRetentionReport);

  /*
   * The retention statuses are renameable in Settings, so the two pie charts
   * below have to read their legends from the same place the board does -
   * otherwise renaming "Resolved" to "Closed" changes the board and leaves the
   * report still saying "Resolved" for the same number.
   *
   * Relabelled here at render rather than where the report is assembled: the
   * loader bakes key, colour and value together in an async effect, and making
   * that effect depend on the labels would refetch the whole report every time
   * they arrived. Keys and colours are untouched; only the word changes.
   */
  const [statusLabelGroups, setStatusLabelGroups] = useState([]);

  useEffect(() => {
    let cancelled = false;
    getRetentionStatusLabels()
      .then((data) => {
        if (!cancelled && Array.isArray(data?.groups)) setStatusLabelGroups(data.groups);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const statusLabelFor = useMemo(() => buildStatusLabelLookup(statusLabelGroups), [statusLabelGroups]);

  const retentionByRisk = useMemo(
    () => (retentionReport.by_risk || []).map((item) => ({ ...item, label: statusLabelFor("risk_level", item.key) })),
    [retentionReport.by_risk, statusLabelFor],
  );
  const retentionByIntervention = useMemo(
    () => (retentionReport.by_intervention || []).map((item) => ({ ...item, label: statusLabelFor("intervention", item.key) })),
    [retentionReport.by_intervention, statusLabelFor],
  );
  const [retentionLoading, setRetentionLoading] = useState(true);
  const [retentionError, setRetentionError] = useState("");
  const [contactReport, setContactReport] = useState(emptyContactReport);
  const [contactLoading, setContactLoading] = useState(true);
  const [contactError, setContactError] = useState("");
  const [auditLogs, setAuditLogs] = useState(() => readAuditLogs());

  const refreshAuditLogs = () => {
    setAuditLogs(readAuditLogs());
  };

  const clearAuditReportLogs = () => {
    clearAuditLogs();
    setAuditLogs([]);
  };

  useEffect(() => {
    if (reportOptions.length === 0) {
      lastAppliedDefaultReportRef.current = "";
      setSelectedReport("");
      return;
    }

    setSelectedReport((current) => {
      if (reportOptions.some((option) => option.value === current)) {
        return current;
      }

      lastAppliedDefaultReportRef.current = resolvedDefaultReport;
      return resolvedDefaultReport;
    });
  }, [reportOptions, resolvedDefaultReport]);

  useEffect(() => {
    if (!normalizedDefaultReport || normalizedDefaultReport === lastAppliedDefaultReportRef.current) {
      return;
    }

    if (reportOptions.some((option) => option.value === normalizedDefaultReport)) {
      lastAppliedDefaultReportRef.current = normalizedDefaultReport;
      setSelectedReport(normalizedDefaultReport);
    }
  }, [normalizedDefaultReport, reportOptions]);

  useEffect(() => {
    if (selectedReport && typeof onReportChange === "function") {
      onReportChange(selectedReport);
    }
  }, [onReportChange, selectedReport]);

  /*
   * One scope for the whole page, not one per report. Switching from Attendance
   * to Grades while looking at BSIT Year 2 should keep looking at BSIT Year 2 —
   * a filter that resets on every tab change is a filter nobody uses twice.
   *
   * Declared up here because the loader effect below reads it: a dependency
   * array is evaluated during render, so a `const` declared further down would
   * still be in its temporal dead zone when the effect is registered.
   */
  const [scope, setScope] = useState({ campusId: "", departmentId: "", courseId: "", yearLevel: "" });

  useEffect(() => {
    let active = true;
    const canLoadUsers = selectedReport === "users" && reportOptions.some((option) => option.value === "users");
    const canLoadStudents = selectedReport === "students" && reportOptions.some((option) => option.value === "students");
    const canLoadRetention = selectedReport === "retention" && reportOptions.some((option) => option.value === "retention");
    const canLoadContact = selectedReport === "contacts" && reportOptions.some((option) => option.value === "contacts");
    const canLoadGrades = selectedReport === "grades" && reportOptions.some((option) => option.value === "grades");
    const canLoadSurvey = selectedReport === "survey" && reportOptions.some((option) => option.value === "survey");

    async function loadUserReport() {
      if (!canLoadUsers) {
        setUserSummary(emptyUserSummary);
        setUserError("");
        setUserLoading(false);
        return;
      }

      setUserLoading(true);
      setUserError("");
      try {
        const res = await fetch(getBackendUrl("user-summary.php"), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load report");
        const data = json?.data || {};
        if (!active) return;
        setUserSummary({
          total: typeof data.total === "number" ? data.total : null,
          active: typeof data.active === "number" ? data.active : null,
          inactive: typeof data.inactive === "number" ? data.inactive : null,
          archived: typeof data.archived === "number" ? data.archived : 0,
          student_users: typeof data.student_users === "number" ? data.student_users : 0,
          by_role: Array.isArray(data.by_role) ? data.by_role : [],
        });
      } catch (e) {
        if (!active) return;
        setUserSummary(emptyUserSummary);
        setUserError(e.message || "Failed to load report");
      } finally {
        if (active) setUserLoading(false);
      }
    }

    async function loadSurveyReport() {
      if (!canLoadSurvey) {
        setSurveySummary(emptySurveySummary);
        setSurveyError("");
        setSurveyLoading(false);
        return;
      }

      setSurveyLoading(true);
      setSurveyError("");
      try {
        const query = new URLSearchParams();
        if (surveyFilters.survey_id) query.set("survey_id", surveyFilters.survey_id);
        if (surveyFilters.question_type) query.set("question_type", surveyFilters.question_type);
        if (surveyFilters.question_id) query.set("question_id", surveyFilters.question_id);
        if (surveyFilters.search.trim()) query.set("search", surveyFilters.search.trim());
        query.set("page", String(surveyFilters.page || 1));
        query.set("page_size", String(SURVEY_ANSWERS_PAGE_SIZE));

        const res = await fetch(getBackendUrl(`survey-summary.php?${query.toString()}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load survey report");
        const data = json?.data || {};
        if (!active) return;
        setSurveySummary({
          total_surveys: typeof data.total_surveys === "number" ? data.total_surveys : null,
          active_surveys: typeof data.active_surveys === "number" ? data.active_surveys : null,
          inactive_surveys: typeof data.inactive_surveys === "number" ? data.inactive_surveys : null,
          total_questions: typeof data.total_questions === "number" ? data.total_questions : null,
          total_submissions: typeof data.total_submissions === "number" ? data.total_submissions : null,
          total_responses: typeof data.total_responses === "number" ? data.total_responses : null,
          average_responses_per_submission: Number(data.average_responses_per_submission || 0),
          by_survey: Array.isArray(data.by_survey) ? data.by_survey : [],
          filters: {
            surveys: Array.isArray(data?.filters?.surveys) ? data.filters.surveys : [],
            questions: Array.isArray(data?.filters?.questions) ? data.filters.questions : [],
            question_types: Array.isArray(data?.filters?.question_types) ? data.filters.question_types : [],
          },
          question_breakdown: Array.isArray(data.question_breakdown) ? data.question_breakdown : [],
          answers: Array.isArray(data.answers) ? data.answers : [],
          answers_total: Number(data.answers_total || 0),
          page: Number(data.page || 1),
          page_size: Number(data.page_size || SURVEY_ANSWERS_PAGE_SIZE),
        });
      } catch (e) {
        if (!active) return;
        setSurveySummary(emptySurveySummary);
        setSurveyError(e.message || "Failed to load survey report");
      } finally {
        if (active) setSurveyLoading(false);
      }
    }

    async function loadStudentReport() {
      if (!canLoadStudents) {
        setStudentReport(emptyStudentReport);
        setStudentError("");
        setStudentLoading(false);
        return;
      }

      setStudentLoading(true);
      setStudentError("");
      try {
        const [studentRows, courseRows] = await Promise.all([
          // The whole cohort, so ask for it in the largest pages student.php
          // allows: the per-request floor dwarfs the row cost, and 200 made this
          // fourteen round trips where three will do.
          fetchAllPages("student.php", { include_archived: 1 }, 1000),
          fetchAllPages("course.php"),
        ]);

        const courseNameById = courseRows.reduce((acc, row) => {
          acc[String(row?.course_id ?? "")] = row?.course_name || row?.course_code || `Course ${row?.course_id}`;
          return acc;
        }, {});

        const byCourseMap = new Map();
        const byYearLevelMap = new Map();
        let archivedCount = 0;

        studentRows.forEach((row) => {
          const isArchived = Boolean(row?.archived_at);
          if (isArchived) archivedCount += 1;

          const courseKey = String(row?.course_id ?? "unassigned");
          const courseLabel = courseNameById[courseKey] || (row?.course_id ? `Course ${row.course_id}` : "Unassigned");
          const existingCourse = byCourseMap.get(courseKey) || {
            key: courseKey,
            label: courseLabel,
            total: 0,
            active: 0,
            archived: 0,
          };
          existingCourse.total += 1;
          existingCourse.active += isArchived ? 0 : 1;
          existingCourse.archived += isArchived ? 1 : 0;
          byCourseMap.set(courseKey, existingCourse);

          const yearLabel = Number(row?.year_level) > 0 ? yearLevelLabel(row.year_level) : "Unassigned";
          const yearKey = Number(row?.year_level) > 0 ? `year_${row.year_level}` : "year_unassigned";
          const existingYear = byYearLevelMap.get(yearKey) || {
            key: yearKey,
            label: yearLabel,
            total: 0,
            active: 0,
            archived: 0,
          };
          existingYear.total += 1;
          existingYear.active += isArchived ? 0 : 1;
          existingYear.archived += isArchived ? 1 : 0;
          byYearLevelMap.set(yearKey, existingYear);
        });

        if (!active) return;

        const sortByCountAndLabel = (a, b) => {
          if (b.total !== a.total) return b.total - a.total;
          return String(a.label || "").localeCompare(String(b.label || ""));
        };

        setStudentReport({
          total: studentRows.length,
          active: studentRows.length - archivedCount,
          archived: archivedCount,
          course_total: byCourseMap.size,
          by_course: Array.from(byCourseMap.values()).sort(sortByCountAndLabel),
          by_year_level: Array.from(byYearLevelMap.values()).sort(sortByCountAndLabel),
        });
      } catch (e) {
        if (!active) return;
        setStudentReport(emptyStudentReport);
        setStudentError(e.message || "Failed to load student report");
      } finally {
        if (active) setStudentLoading(false);
      }
    }

    async function loadGradeReport() {
      if (!canLoadGrades) {
        setGradeRows([]);
        setGradeError("");
        setGradeLoading(false);
        return;
      }

      setGradeLoading(true);
      setGradeError("");
      try {
        // Scoped by the page chain, same as the attendance and finance
        // reports. grades.php filters on all three steps; the rows it returns
        // carry neither department nor year level, so narrowing them in the
        // browser could only ever honour Course and would leave the other two
        // steps looking applied while doing nothing.
        const rows = await fetchAllPages("grades.php", {
          campus_id: scope.campusId,
          department_id: scope.departmentId,
          course_id: scope.courseId,
          year_level: scope.yearLevel,
        });
        if (!active) return;
        setGradeRows(rows);
      } catch (e) {
        if (!active) return;
        setGradeRows([]);
        setGradeError(e.message || "Failed to load grade report");
      } finally {
        if (active) setGradeLoading(false);
      }
    }

    async function loadRetentionReport() {
      if (!canLoadRetention) {
        setRetentionReport(emptyRetentionReport);
        setRetentionError("");
        setRetentionLoading(false);
        return;
      }

      setRetentionLoading(true);
      setRetentionError("");
      try {
        const res = await fetch(getBackendUrl("retention_case.php"), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load retention report");

        const rows = Array.isArray(json?.data) ? json.data : [];
        const summary = json?.summary || {};
        const riskCounts = { high: 0, moderate: 0, low: 0 };
        const interventionCounts = {
          unassigned: 0,
          assigned: 0,
          in_progress: 0,
          follow_up: 0,
          resolved: 0,
        };
        const byCourseMap = new Map();

        rows.forEach((row) => {
          const riskKey = String(row?.combined_risk_level || "low").toLowerCase();
          if (Object.prototype.hasOwnProperty.call(riskCounts, riskKey)) {
            riskCounts[riskKey] += 1;
          }

          const interventionKey = String(row?.intervention_status || "unassigned").toLowerCase();
          if (Object.prototype.hasOwnProperty.call(interventionCounts, interventionKey)) {
            interventionCounts[interventionKey] += 1;
          }

          const courseKey = String(row?.course_name || row?.course_code || "unassigned").trim().toLowerCase() || "unassigned";
          const courseLabel = row?.course_name || row?.course_code || "Unassigned";
          const existingCourse = byCourseMap.get(courseKey) || {
            key: courseKey,
            label: courseLabel,
            total: 0,
            high_risk: 0,
            pending_validation: 0,
            resolved_cases: 0,
          };

          existingCourse.total += 1;
          if (riskKey === "high") existingCourse.high_risk += 1;
          if (String(row?.validation_status || "").toLowerCase() === "pending") existingCourse.pending_validation += 1;
          if (interventionKey === "resolved") existingCourse.resolved_cases += 1;
          byCourseMap.set(courseKey, existingCourse);
        });

        const sortByCountAndLabel = (a, b) => {
          if (b.total !== a.total) return b.total - a.total;
          return String(a.label || "").localeCompare(String(b.label || ""));
        };

        if (!active) return;

        setRetentionReport({
          total_cases: typeof summary.total_cases === "number" ? summary.total_cases : rows.length,
          pending_validation: typeof summary.pending_validation === "number" ? summary.pending_validation : 0,
          assigned_cases: typeof summary.assigned_cases === "number" ? summary.assigned_cases : 0,
          resolved_cases: typeof summary.resolved_cases === "number" ? summary.resolved_cases : 0,
          high_risk: typeof summary.high_risk === "number" ? summary.high_risk : riskCounts.high,
          by_risk: retentionRiskMeta.map((item) => ({ ...item, value: riskCounts[item.key] || 0 })),
          by_intervention: retentionInterventionMeta.map((item) => ({ ...item, value: interventionCounts[item.key] || 0 })),
          by_course: Array.from(byCourseMap.values()).sort(sortByCountAndLabel),
          recent_cases: rows.slice(0, 8),
          latest_evaluation_at: rows.map((row) => row.evaluated_at).filter(Boolean).sort().pop() || null,
        });
      } catch (e) {
        if (!active) return;
        setRetentionReport(emptyRetentionReport);
        setRetentionError(e.message || "Failed to load retention report");
      } finally {
        if (active) setRetentionLoading(false);
      }
    }

    async function loadContactReport() {
      if (!canLoadContact) {
        setContactReport(emptyContactReport);
        setContactError("");
        setContactLoading(false);
        return;
      }

      setContactLoading(true);
      setContactError("");
      try {
        const res = await fetch(getBackendUrl("student_contact_report.php"), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load contact workflow report");

        if (!active) return;
        setContactReport({
          summary: json?.summary || emptyContactReport.summary,
          by_status: Array.isArray(json?.by_status) ? json.by_status : [],
          by_home_visit_status: Array.isArray(json?.by_home_visit_status) ? json.by_home_visit_status : [],
          by_department: Array.isArray(json?.by_department) ? json.by_department : [],
          recent_escalations: Array.isArray(json?.recent_escalations) ? json.recent_escalations : [],
          completion_logs: Array.isArray(json?.completion_logs) ? json.completion_logs : [],
        });
      } catch (e) {
        if (!active) return;
        setContactReport(emptyContactReport);
        setContactError(e.message || "Failed to load contact workflow report");
      } finally {
        if (active) setContactLoading(false);
      }
    }

    if (selectedReport === "users") {
      void loadUserReport();
    } else if (selectedReport === "students") {
      void loadStudentReport();
    } else if (selectedReport === "retention") {
      void loadRetentionReport();
    } else if (selectedReport === "contacts") {
      void loadContactReport();
    } else if (selectedReport === "grades") {
      void loadGradeReport();
    } else if (selectedReport === "survey") {
      void loadSurveyReport();
    }

    return () => {
      active = false;
    };
    // surveyFilters drives the survey report's server-side filtering, so a
    // filter change has to re-run this effect. `scope` is here for the same
    // reason — the grade report is filtered by the server, so narrowing the
    // scope has to refetch. Only the selected report loads, so this costs
    // nothing on the reports the scope row is not even shown for.
  }, [reportOptions, scope, selectedReport, surveyFilters]);

  const compactTableWrapStyle = {
    overflow: "auto",
    maxWidth: "100%",
    maxHeight: "min(42vh, 306px)",
    border: "1px solid #f1f5f9",
    borderRadius: 8,
    scrollbarGutter: "stable",
  };
  const compactThStyle = {
    padding: "6px 8px",
    borderBottom: "1px solid #e2e8f0",
    color: "#475569",
    fontSize: 10.5,
    fontWeight: 700,
    position: "sticky",
    top: 0,
    zIndex: 1,
    backgroundColor: "#f8fafc",
    whiteSpace: "nowrap",
    lineHeight: 1.2,
  };
  const compactTdStyle = {
    padding: "6px 8px",
    borderBottom: "1px solid #f1f5f9",
    fontSize: 11.5,
    lineHeight: 1.2,
  };
  const numberCellStyle = { ...compactTdStyle, textAlign: "right", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" };

  const totalUsers = Number(userSummary.total || 0);
  const activeUsers = Number(userSummary.active || 0);
  const inactiveUsers = Number(userSummary.inactive || 0);
  const archivedUsers = Number(userSummary.archived || 0);
  const statusPieData = useMemo(
    () => [
      { ...statusTone.active, value: activeUsers },
      { ...statusTone.inactive, value: inactiveUsers },
      { ...statusTone.archived, value: archivedUsers },
    ],
    [activeUsers, inactiveUsers, archivedUsers]
  );
  const rolePieData = useMemo(() => {
    const rows = Array.isArray(userSummary.by_role) ? userSummary.by_role : [];
    const normalized = rows
      .map((row) => ({
        key: `role_${row.role_id ?? row.role_name}`,
        label: row.role_name || "Unknown",
        value: Number(row.total_users || 0),
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);

    const top = normalized.slice(0, 7).map((item, idx) => ({ ...item, color: rolePalette[idx % rolePalette.length] }));
    if (normalized.length > 7) {
      const others = normalized.slice(7).reduce((sum, item) => sum + item.value, 0);
      if (others > 0) top.push({ key: "others", label: "Others", value: others, color: "#94a3b8" });
    }
    return top;
  }, [userSummary.by_role]);

  const totalSurveys = Number(surveySummary.total_surveys || 0);

  /**
   * What the survey filters currently add up to, in words.
   *
   * Used twice: on screen above the Export button, and in the filename. Titles
   * are resolved from the filter dropdowns rather than shown as raw ids, so a
   * file lands in someone's Downloads named for the survey it holds instead of
   * `survey-4`. Empty when nothing is filtered, which is what makes the label
   * read "Every answer in this report".
   */
  const surveyExportLabel = useMemo(() => {
    const parts = [];

    if (surveyFilters.survey_id) {
      const match = (surveySummary.filters?.surveys || []).find(
        (row) => String(row.survey_id) === String(surveyFilters.survey_id)
      );
      parts.push(match?.survey_title || `Survey ${surveyFilters.survey_id}`);
    }
    if (surveyFilters.question_id) {
      const match = (surveySummary.filters?.questions || []).find(
        (row) => String(row.question_id) === String(surveyFilters.question_id)
      );
      // Questions are full sentences; enough to identify it, not the whole thing.
      const text = match?.question_text || `Question ${surveyFilters.question_id}`;
      parts.push(text.length > 40 ? `${text.slice(0, 40).trim()}…` : text);
    }
    if (surveyFilters.question_type) {
      parts.push(QUESTION_TYPE_LABELS[surveyFilters.question_type] || surveyFilters.question_type);
    }
    if (surveyFilters.search.trim()) {
      parts.push(`"${surveyFilters.search.trim()}"`);
    }

    return parts.join(" · ");
  }, [
    surveyFilters.survey_id,
    surveyFilters.question_id,
    surveyFilters.question_type,
    surveyFilters.search,
    surveySummary.filters,
  ]);

  const surveyStatusPieData = useMemo(
    () => [
      { ...surveyStatusTone.active, value: Number(surveySummary.active_surveys || 0) },
      { ...surveyStatusTone.inactive, value: Number(surveySummary.inactive_surveys || 0) },
    ],
    [surveySummary.active_surveys, surveySummary.inactive_surveys]
  );
  const surveyResultsPieData = useMemo(() => {
    const rows = Array.isArray(surveySummary.by_survey) ? surveySummary.by_survey : [];
    const normalized = rows
      .map((row) => ({
        key: `survey_${row.survey_id}`,
        label: row.survey_title || `Survey #${row.survey_id}`,
        value: Number(row.response_count || 0),
      }))
      .filter((item) => item.value > 0)
      .sort((a, b) => b.value - a.value);

    const top = normalized.slice(0, 7).map((item, idx) => ({ ...item, color: surveyPalette[idx % surveyPalette.length] }));
    if (normalized.length > 7) {
      const others = normalized.slice(7).reduce((sum, item) => sum + item.value, 0);
      if (others > 0) top.push({ key: "survey_others", label: "Others", value: others, color: "#94a3b8" });
    }
    return top;
  }, [surveySummary.by_survey]);

  /**
   * Question dropdown, narrowed by the survey and type already chosen — so it
   * never offers a question that would return nothing.
   */
  const filteredSurveyQuestions = useMemo(() => {
    return surveySummary.filters.questions.filter((question) => {
      if (surveyFilters.survey_id && String(question.survey_id) !== String(surveyFilters.survey_id)) return false;
      if (surveyFilters.question_type && question.question_type !== surveyFilters.question_type) return false;
      return true;
    });
  }, [surveySummary.filters.questions, surveyFilters.survey_id, surveyFilters.question_type]);

  const hasSurveyFilters = Boolean(
    surveyFilters.survey_id || surveyFilters.question_type || surveyFilters.question_id || surveyFilters.search.trim()
  );

  const surveyAnswerPageCount = Math.max(
    1,
    Math.ceil((surveySummary.answers_total || 0) / (surveySummary.page_size || SURVEY_ANSWERS_PAGE_SIZE))
  );
  const studentCoursePieData = useMemo(() => buildTopPieRows(studentReport.by_course, studentPalette), [studentReport.by_course]);
  const studentYearPieData = useMemo(() => buildTopPieRows(studentReport.by_year_level, studentPalette), [studentReport.by_year_level]);
  const totalRetentionCases = Number(retentionReport.total_cases || 0);
  const totalContactStudents = Number(contactReport.summary?.total_students || 0);
  /*
   * gradeRows already arrived scoped, so everything derived from it — the stat
   * cards, both pies and the semester table — describes the same records with
   * no second filter in between.
   */
  const gradeReport = useMemo(() => summariseGrades(gradeRows), [gradeRows]);

  const gradeSemesterPieData = useMemo(() => buildTopPieRows(gradeReport.by_semester, gradePalette), [gradeReport.by_semester]);
  const gradeSchoolYearPieData = useMemo(() => buildTopPieRows(gradeReport.by_school_year, gradePalette), [gradeReport.by_school_year]);

  const scopeOptions = useScopeOptions(scope);
  const campusName = (scopeOptions.campuses || []).find(
    (campus) => String(campus.campus_id) === String(scope.campusId)
  );
  const scopeLabel = describeScope({
    campusName: campusName?.campus_code || campusName?.campus_name || "",
    departmentName: scopeOptions.departmentName,
    courseName: scopeOptions.courseName,
    yearLevel: scope.yearLevel,
  });

  const selectedReportMeta = reportOptions.find((option) => option.value === selectedReport) || reportOptions[0] || REPORT_OPTIONS[0];
  const reportBody = (() => {
    if (reportOptions.length === 0) {
      return (
        <ReportCard title="No Available Reports">
          <div style={{ color: "#64748b", fontSize: 12.5 }}>
            No report types are available for your current permissions.
          </div>
        </ReportCard>
      );
    }

    // Deliberately not the attendance management page. That screen answers
    // "what does this record say"; a report has to answer "who do I act on".
    // Both take the page scope rather than carrying a Course dropdown of their
    // own. They used to do the latter, which left the scope row scoping only
    // the export while the report body answered for the whole school.
    if (selectedReport === "attendance") {
      return <AttendanceReport scope={scope} />;
    }

    // Same split as attendance: the finance module edits balance rows, this
    // names the students those balances put at risk.
    if (selectedReport === "finance") {
      return <FinanceReport scope={scope} scopeLabel={scopeLabel} />;
    }

    // Takes the page scope like the other three student-rooted reports, so
    // narrowing to a course narrows both terms at once. Comparing a scoped term
    // against an unscoped one would be worse than no comparison.
    if (selectedReport === "comparison") {
      return <TermComparisonReport scope={scope} />;
    }

    if (selectedReport === "logbook") {
      return <TermLogbookReport scope={scope} />;
    }

    if (selectedReport === "audit") {
      return (
        <AuditLogsPanel
          logs={auditLogs}
          onRefresh={refreshAuditLogs}
          onClear={clearAuditReportLogs}
        />
      );
    }

    if (selectedReport === "notifications") {
      return <NotificationReport />;
    }

    // Its own filters (dates, channel, outcome, who) and export travel with it;
    // the page's scope row does not apply, as with the survey report.
    if (selectedReport === "contact_log") {
      return <ContactLogReport />;
    }
    if (selectedReport === "faculty_periodical") {
      return <FacultyPeriodicalReport />;
    }

    if (selectedReport === "archived") {
      return <ArchivedRecordsReport />;
    }

    if (selectedReport === "users") {
      return (
        <>
          {userError ? (
            <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>
              {userError}
            </div>
          ) : null}

          <StatCardGrid minWidth={220}>
            <StatCard label="Total Users" value={userLoading ? "..." : userSummary.total} />
            <StatCard label="Active Users" value={userLoading ? "..." : userSummary.active} tone="success" />
            <StatCard label="Inactive Users" value={userLoading ? "..." : userSummary.inactive} tone="danger" />
            <StatCard label="Archived Users" value={userLoading ? "..." : userSummary.archived} />
            <StatCard label="Student Users" value={userLoading ? "..." : userSummary.student_users} />
          </StatCardGrid>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 272px), 1fr))", gap: 12 }}>
            <PieChartCard
              title="Status Pie Chart"
              subtitle="Distribution of account statuses."
              centerLabel="Total Users"
              centerValue={totalUsers}
              data={statusPieData}
              loading={userLoading}
              animationDelay={STATUS_CHART_DELAY}
            />
            <PieChartCard
              title="Role Pie Chart"
              subtitle="User distribution by role."
              centerLabel="Roles with Users"
              centerValue={rolePieData.length}
              data={rolePieData}
              loading={userLoading}
              animationDelay={ROLE_CHART_DELAY}
            />
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 9,
              padding: 9,
              display: "grid",
              gap: 6,
            }}
          >
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Users by Role</h3>
            <div style={compactTableWrapStyle}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "36%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "16%" }} />
                  <col style={{ width: "16%" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Role</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Total</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Active</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Inactive</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Archived</th>
                  </tr>
                </thead>
                <tbody>
                  {userLoading ? (
                    <tr>
                      <td colSpan={5} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        Loading role summary...
                      </td>
                    </tr>
                  ) : userSummary.by_role.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        No role data found.
                      </td>
                    </tr>
                  ) : (
                    userSummary.by_role.map((row) => (
                      <tr key={row.role_id ?? row.role_name}>
                        <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.role_name || "-"}>
                          {row.role_name || "-"}
                        </td>
                        <td style={{ ...numberCellStyle, color: "#334155" }}>{row.total_users ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#065f46" }}>{row.active_users ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#b91c1c" }}>{row.inactive_users ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#92400e" }}>{row.archived_users ?? 0}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      );
    }

    if (selectedReport === "students") {
      return (
        <>
          {studentError ? (
            <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>
              {studentError}
            </div>
          ) : null}

          <StatCardGrid minWidth={220}>
            <StatCard label="Total Students" value={studentLoading ? "..." : studentReport.total} />
            <StatCard label="Active Students" value={studentLoading ? "..." : studentReport.active} tone="success" />
            <StatCard label="Archived Students" value={studentLoading ? "..." : studentReport.archived} />
            <StatCard label="Courses Covered" value={studentLoading ? "..." : studentReport.course_total} />
          </StatCardGrid>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 272px), 1fr))", gap: 12 }}>
            <PieChartCard
              title="Students by Course"
              subtitle="Distribution of student records across courses."
              centerLabel="Courses"
              centerValue={studentCoursePieData.length}
              data={studentCoursePieData}
              loading={studentLoading}
              animationDelay={STATUS_CHART_DELAY}
            />
            <PieChartCard
              title="Students by Year Level"
              subtitle="Distribution of student records across year levels."
              centerLabel="Year Levels"
              centerValue={studentYearPieData.length}
              data={studentYearPieData}
              loading={studentLoading}
              animationDelay={ROLE_CHART_DELAY}
            />
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 9,
              padding: 9,
              display: "grid",
              gap: 6,
            }}
          >
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Students by Course</h3>
            <div style={compactTableWrapStyle}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "46%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "18%" }} />
                  <col style={{ width: "18%" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Course</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Total</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Active</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Archived</th>
                  </tr>
                </thead>
                <tbody>
                  {studentLoading ? (
                    <tr>
                      <td colSpan={4} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        Loading student summary...
                      </td>
                    </tr>
                  ) : studentReport.by_course.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        No student data found.
                      </td>
                    </tr>
                  ) : (
                    studentReport.by_course.map((row) => (
                      <tr key={row.key}>
                        <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.label || "-"}>
                          {row.label || "-"}
                        </td>
                        <td style={{ ...numberCellStyle, color: "#334155" }}>{row.total ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#065f46" }}>{row.active ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#92400e" }}>{row.archived ?? 0}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      );
    }

    if (selectedReport === "retention") {
      return (
        <>
          <p style={{ fontSize: 12, color: "var(--text-muted)" }}>This report summarizes stored evaluations, which require re-evaluation after source records change. Latest evaluation: {retentionReport.latest_evaluation_at ? formatDateTime(retentionReport.latest_evaluation_at) : "not available"}.</p>
          {retentionError ? (
            <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>
              {retentionError}
            </div>
          ) : null}

          <StatCardGrid minWidth={220}>
            <StatCard label="Total Cases" value={retentionLoading ? "..." : retentionReport.total_cases} />
            <StatCard label="Pending Validation" value={retentionLoading ? "..." : retentionReport.pending_validation} />
            <StatCard label="Assigned Cases" value={retentionLoading ? "..." : retentionReport.assigned_cases} tone="success" />
            <StatCard label="Resolved Cases" value={retentionLoading ? "..." : retentionReport.resolved_cases} />
            <StatCard label="High Risk" value={retentionLoading ? "..." : retentionReport.high_risk} tone="danger" />
          </StatCardGrid>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 272px), 1fr))", gap: 12 }}>
            <PieChartCard
              title="Cases by Risk Level"
              subtitle="Distribution of retention cases across risk levels."
              centerLabel="Total Cases"
              centerValue={totalRetentionCases}
              data={retentionByRisk}
              loading={retentionLoading}
              animationDelay={STATUS_CHART_DELAY}
            />
            <PieChartCard
              title="Cases by Intervention Status"
              subtitle="Progress of case handling from assignment to resolution."
              centerLabel="Total Cases"
              centerValue={totalRetentionCases}
              data={retentionByIntervention}
              loading={retentionLoading}
              animationDelay={ROLE_CHART_DELAY}
            />
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 9,
              padding: 9,
              display: "grid",
              gap: 6,
            }}
          >
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Potential Drop Out by Course</h3>
            <div style={compactTableWrapStyle}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "40%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                  <col style={{ width: "15%" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Course</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Total</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>High Risk</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Pending</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Resolved</th>
                  </tr>
                </thead>
                <tbody>
                  {retentionLoading ? (
                    <tr>
                      <td colSpan={5} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        Loading retention summary...
                      </td>
                    </tr>
                  ) : retentionReport.by_course.length === 0 ? (
                    <tr>
                      <td colSpan={5} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        No retention case data found.
                      </td>
                    </tr>
                  ) : (
                    retentionReport.by_course.map((row) => (
                      <tr key={row.key}>
                        <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.label || "-"}>
                          {row.label || "-"}
                        </td>
                        <td style={{ ...numberCellStyle, color: "#334155" }}>{row.total ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#b91c1c" }}>{row.high_risk ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#92400e" }}>{row.pending_validation ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#065f46" }}>{row.resolved_cases ?? 0}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 9,
              padding: 9,
              display: "grid",
              gap: 6,
            }}
          >
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Recent Potential Drop Out Cases</h3>
            <div style={compactTableWrapStyle}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "26%" }} />
                  <col style={{ width: "24%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "10%" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Student</th>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Course</th>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Risk</th>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Validation</th>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Intervention</th>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {retentionLoading ? (
                    <tr>
                      <td colSpan={6} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        Loading cases...
                      </td>
                    </tr>
                  ) : retentionReport.recent_cases.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        No retention case data found.
                      </td>
                    </tr>
                  ) : (
                    retentionReport.recent_cases.map((row) => (
                      <tr key={row.case_id}>
                        <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${row.student_number || `ID:${row.student_id}`} | ${row.last_name || ""}, ${row.first_name || ""}`.trim()}>
                          {row.student_number || `ID:${row.student_id}`} | {row.last_name || ""}{row.last_name && row.first_name ? ", " : ""}{row.first_name || ""}
                        </td>
                        <td style={{ ...compactTdStyle, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.course_name || row.course_code || "-"}>
                          {row.course_name || row.course_code || "-"}
                        </td>
                        <td style={{ ...compactTdStyle, color: "#b91c1c", whiteSpace: "nowrap" }}>{formatTokenLabel(row.combined_risk_level || "low")}</td>
                        <td style={{ ...compactTdStyle, color: "#92400e", whiteSpace: "nowrap" }}>{formatTokenLabel(row.validation_status || "pending")}</td>
                        <td style={{ ...compactTdStyle, color: "#047857", whiteSpace: "nowrap" }}>{formatTokenLabel(row.intervention_status || "unassigned")}</td>
                        <td style={{ ...compactTdStyle, color: "#475569", whiteSpace: "nowrap" }}>{formatDateTime(row.updated_at)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      );
    }

    if (selectedReport === "contacts") {
      return (
        <>
          {contactError ? (
            <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>
              {contactError}
            </div>
          ) : null}

          <StatCardGrid minWidth={220}>
            <StatCard label="Tracked Students" value={contactLoading ? "..." : contactReport.summary?.total_students} />
            <StatCard label="Contacted" value={contactLoading ? "..." : contactReport.summary?.contacted_students} tone="success" />
            <StatCard label="Uncontacted" value={contactLoading ? "..." : contactReport.summary?.uncontacted_students} tone="danger" />
            <StatCard label="Follow-up Needed" value={contactLoading ? "..." : contactReport.summary?.follow_up_students} />
            <StatCard label="Escalated Cases" value={contactLoading ? "..." : contactReport.summary?.escalated_cases} />
            <StatCard label="Completed Home Visits" value={contactLoading ? "..." : contactReport.summary?.completed_home_visits} tone="success" />
          </StatCardGrid>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 272px), 1fr))", gap: 12 }}>
            <PieChartCard
              title="Contact Status Mix"
              subtitle="Distribution of contacted, pending, and escalated workflow records."
              centerLabel="Tracked Students"
              centerValue={totalContactStudents}
              data={contactReport.by_status}
              loading={contactLoading}
              animationDelay={STATUS_CHART_DELAY}
            />
            <PieChartCard
              title="Home Visit Progress"
              subtitle="Queue status for escalated Role 8 follow-up work."
              centerLabel="Escalated Cases"
              centerValue={Number(contactReport.summary?.escalated_cases || 0)}
              data={contactReport.by_home_visit_status}
              loading={contactLoading}
              animationDelay={ROLE_CHART_DELAY}
            />
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 9,
              padding: 9,
              display: "grid",
              gap: 6,
            }}
          >
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Contact Workflow by Department</h3>
            <div style={compactTableWrapStyle}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "34%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "14%" }} />
                  <col style={{ width: "12%" }} />
                  <col style={{ width: "12%" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Department</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Total</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Contacted</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Escalated</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Completed</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Completion %</th>
                  </tr>
                </thead>
                <tbody>
                  {contactLoading ? (
                    <tr>
                      <td colSpan={6} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        Loading department summary...
                      </td>
                    </tr>
                  ) : contactReport.by_department.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        No contact workflow data found.
                      </td>
                    </tr>
                  ) : (
                    contactReport.by_department.map((row) => {
                      const escalated = Number(row.escalated || 0);
                      const completed = Number(row.completed_home_visits || 0);
                      const completionRate = escalated > 0 ? (completed / escalated) * 100 : 0;
                      return (
                        <tr key={row.key}>
                          <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.label || "-"}>
                            {row.label || "-"}
                          </td>
                          <td style={{ ...numberCellStyle, color: "#334155" }}>{row.total ?? 0}</td>
                          <td style={{ ...numberCellStyle, color: "#065f46" }}>{row.contacted ?? 0}</td>
                          <td style={{ ...numberCellStyle, color: "#047857" }}>{row.escalated ?? 0}</td>
                          <td style={{ ...numberCellStyle, color: "#047857" }}>{row.completed_home_visits ?? 0}</td>
                          <td style={{ ...numberCellStyle, color: "#475569" }}>{formatDecimal(completionRate)}</td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 289px), 1fr))", gap: 12 }}>
            <div
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 9,
                padding: 9,
                display: "grid",
                gap: 6,
              }}
            >
              <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Recent Escalations</h3>
              <div style={compactTableWrapStyle}>
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "32%" }} />
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "16%" }} />
                    <col style={{ width: "16%" }} />
                  </colgroup>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Student</th>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Department</th>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Status</th>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Assigned</th>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contactLoading ? (
                      <tr>
                        <td colSpan={5} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                          Loading escalations...
                        </td>
                      </tr>
                    ) : contactReport.recent_escalations.length === 0 ? (
                      <tr>
                        <td colSpan={5} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                          No escalated cases found.
                        </td>
                      </tr>
                    ) : (
                      contactReport.recent_escalations.map((row) => (
                        <tr key={row.home_visit_id}>
                          <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${row.student_number || `ID:${row.student_id}`} | ${row.last_name || ""}, ${row.first_name || ""}`.trim()}>
                            {row.student_number || `ID:${row.student_id}`} | {row.last_name || ""}{row.last_name && row.first_name ? ", " : ""}{row.first_name || ""}
                          </td>
                          <td style={{ ...compactTdStyle, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.department_name || "-"}>
                            {row.department_name || "-"}
                          </td>
                          <td style={{ ...compactTdStyle, color: "#047857", whiteSpace: "nowrap" }}>{formatTokenLabel(row.queue_status || "queued")}</td>
                          <td style={{ ...compactTdStyle, color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.assigned_staff_name || "Unassigned"}>
                            {row.assigned_staff_name || "Unassigned"}
                          </td>
                          <td style={{ ...compactTdStyle, color: "#475569", whiteSpace: "nowrap" }}>{formatDateTime(row.created_at)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div
              style={{
                background: "#ffffff",
                border: "1px solid #e2e8f0",
                borderRadius: 9,
                padding: 9,
                display: "grid",
                gap: 6,
              }}
            >
              <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Home Visit Completion Logs</h3>
              <div style={compactTableWrapStyle}>
                <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                  <colgroup>
                    <col style={{ width: "34%" }} />
                    <col style={{ width: "22%" }} />
                    <col style={{ width: "20%" }} />
                    <col style={{ width: "24%" }} />
                  </colgroup>
                  <thead>
                    <tr style={{ background: "#f8fafc" }}>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Student</th>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Department</th>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Assigned Staff</th>
                      <th style={{ ...compactThStyle, textAlign: "left" }}>Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {contactLoading ? (
                      <tr>
                        <td colSpan={4} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                          Loading completion logs...
                        </td>
                      </tr>
                    ) : contactReport.completion_logs.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                          No completed home visits found.
                        </td>
                      </tr>
                    ) : (
                      contactReport.completion_logs.map((row) => (
                        <tr key={row.home_visit_id}>
                          <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={`${row.student_number || `ID:${row.student_id}`} | ${row.last_name || ""}, ${row.first_name || ""}`.trim()}>
                            {row.student_number || `ID:${row.student_id}`} | {row.last_name || ""}{row.last_name && row.first_name ? ", " : ""}{row.first_name || ""}
                          </td>
                          <td style={{ ...compactTdStyle, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.department_name || "-"}>
                            {row.department_name || "-"}
                          </td>
                          <td style={{ ...compactTdStyle, color: "#475569", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.assigned_staff_name || "Unassigned"}>
                            {row.assigned_staff_name || "Unassigned"}
                          </td>
                          <td style={{ ...compactTdStyle, color: "#065f46", whiteSpace: "nowrap" }}>{formatDateTime(row.completed_at)}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </>
      );
    }

    if (selectedReport === "grades") {
      return (
        <>
          {gradeError ? (
            <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>
              {gradeError}
            </div>
          ) : null}

          {/* No filter row here on purpose — the page's Department -> Course
              -> Year chain above is the only one, and grades.php was asked
              with it. */}
          <StatCardGrid minWidth={220}>
            <StatCard label="Grade Records" value={gradeLoading ? "..." : gradeReport.total} />
            <StatCard label="Students Covered" value={gradeLoading ? "..." : gradeReport.student_total} />
            <StatCard label="Avg Passed %" value={gradeLoading ? "..." : formatDecimal(gradeReport.average_passed_pct)} tone="success" />
            <StatCard label="With Failed / No Credit" value={gradeLoading ? "..." : gradeReport.failing_records} tone="danger" />
            <StatCard label="With Incomplete" value={gradeLoading ? "..." : gradeReport.incomplete_records} />
          </StatCardGrid>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 272px), 1fr))", gap: 12 }}>
            <PieChartCard
              title="Grades by Semester"
              subtitle="Distribution of grade records across semesters."
              centerLabel="Semesters"
              centerValue={gradeSemesterPieData.length}
              data={gradeSemesterPieData}
              loading={gradeLoading}
              animationDelay={STATUS_CHART_DELAY}
            />
            <PieChartCard
              title="Grades by School Year"
              subtitle="Distribution of grade records across school years."
              centerLabel="School Years"
              centerValue={gradeSchoolYearPieData.length}
              data={gradeSchoolYearPieData}
              loading={gradeLoading}
              animationDelay={ROLE_CHART_DELAY}
            />
          </div>

          <div
            style={{
              background: "#ffffff",
              border: "1px solid #e2e8f0",
              borderRadius: 9,
              padding: 9,
              display: "grid",
              gap: 6,
            }}
          >
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Grades by Semester</h3>
            <div style={compactTableWrapStyle}>
              <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                <colgroup>
                  <col style={{ width: "40%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "20%" }} />
                  <col style={{ width: "20%" }} />
                </colgroup>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...compactThStyle, textAlign: "left" }}>Semester</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Records</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Students</th>
                    <th style={{ ...compactThStyle, textAlign: "right" }}>Avg Passed %</th>
                  </tr>
                </thead>
                <tbody>
                  {gradeLoading ? (
                    <tr>
                      <td colSpan={4} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        Loading grade summary...
                      </td>
                    </tr>
                  ) : gradeReport.by_semester.length === 0 ? (
                    <tr>
                      <td colSpan={4} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                        No grade data found.
                      </td>
                    </tr>
                  ) : (
                    gradeReport.by_semester.map((row) => (
                      <tr key={row.key}>
                        <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.label || "-"}>
                          {row.label || "-"}
                        </td>
                        <td style={{ ...numberCellStyle, color: "#334155" }}>{row.total ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#047857" }}>{row.student_total ?? 0}</td>
                        <td style={{ ...numberCellStyle, color: "#047857" }}>{formatDecimal(row.average_passed_pct)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </>
      );
    }

    return (
      <>
        {surveyError ? (
          <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6 }}>
            {surveyError}
          </div>
        ) : null}

        <StatCardGrid minWidth={220}>
          <StatCard label="Total Surveys" value={surveyLoading ? "..." : surveySummary.total_surveys} />
          <StatCard label="Active Surveys" value={surveyLoading ? "..." : surveySummary.active_surveys} tone="success" />
          <StatCard label="Inactive Surveys" value={surveyLoading ? "..." : surveySummary.inactive_surveys} tone="danger" />
          <StatCard label="Total Questions" value={surveyLoading ? "..." : surveySummary.total_questions} />
          <StatCard label="Total Submissions" value={surveyLoading ? "..." : surveySummary.total_submissions} />
          <StatCard label="Total Results" value={surveyLoading ? "..." : surveySummary.total_responses} />
          <StatCard label="Avg Results / Submission" value={surveyLoading ? "..." : formatDecimal(surveySummary.average_responses_per_submission)} />
        </StatCardGrid>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 272px), 1fr))", gap: 12 }}>
          <PieChartCard
            title="Survey Status Pie Chart"
            subtitle="Distribution of survey records by active and inactive status."
            centerLabel="Total Surveys"
            centerValue={totalSurveys}
            data={surveyStatusPieData}
            loading={surveyLoading}
            animationDelay={STATUS_CHART_DELAY}
          />
          <PieChartCard
            title="Survey Results Pie Chart"
            subtitle="Top surveys by total recorded results."
            centerLabel="Surveys with Results"
            centerValue={surveyResultsPieData.length}
            data={surveyResultsPieData}
            loading={surveyLoading}
            animationDelay={ROLE_CHART_DELAY}
          />
        </div>

        <div
          style={{
            background: "#ffffff",
            border: "1px solid #e2e8f0",
            borderRadius: 9,
            padding: 9,
            display: "grid",
            gap: 6,
          }}
        >
          <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Survey Result Totals</h3>
          <div style={compactTableWrapStyle}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "24%" }} />
                <col style={{ width: "13%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "11%" }} />
                <col style={{ width: "10%" }} />
                <col style={{ width: "10%" }} />
              </colgroup>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Survey</th>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Semester</th>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Status</th>
                  <th style={{ ...compactThStyle, textAlign: "right" }}>Questions</th>
                  <th style={{ ...compactThStyle, textAlign: "right" }}>Submissions</th>
                  <th style={{ ...compactThStyle, textAlign: "right" }}>Results</th>
                  <th style={{ ...compactThStyle, textAlign: "right" }}>Avg / Sub</th>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Latest</th>
                </tr>
              </thead>
              <tbody>
                {surveyLoading ? (
                  <tr>
                    <td colSpan={8} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                      Loading survey summary...
                    </td>
                  </tr>
                ) : surveySummary.by_survey.length === 0 ? (
                  <tr>
                    <td colSpan={8} style={{ ...compactTdStyle, padding: 9, color: "#64748b", textAlign: "center" }}>
                      No survey data found.
                    </td>
                  </tr>
                ) : (
                  surveySummary.by_survey.map((row) => (
                    <tr key={row.survey_id}>
                      <td style={{ ...compactTdStyle, color: "#0f172a", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.survey_title || "-"}>
                        {row.survey_title || "-"}
                      </td>
                      <td style={{ ...compactTdStyle, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={row.semester_name || "-"}>
                        {row.semester_name || "-"}
                      </td>
                      <td style={{ ...compactTdStyle, color: "#475569", whiteSpace: "nowrap" }}>{row.status_name || "-"}</td>
                      <td style={{ ...numberCellStyle, color: "#334155" }}>{row.question_count ?? 0}</td>
                      <td style={{ ...numberCellStyle, color: "#047857" }}>{row.submission_count ?? 0}</td>
                      <td style={{ ...numberCellStyle, color: "#047857" }}>{row.response_count ?? 0}</td>
                      <td style={{ ...numberCellStyle, color: "#92400e" }}>{formatDecimal(row.average_responses_per_submission)}</td>
                      <td style={{ ...compactTdStyle, color: "#475569", whiteSpace: "nowrap" }}>{formatDateTime(row.latest_submission_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* ------------------------------------------------------------------
            Answer drill-down.

            Everything above is counts. This is what the answers actually were,
            filtered by survey, question type, or a specific question. The
            breakdown aggregates repeated answers; the table below it lists the
            individual responses behind those numbers.
           ------------------------------------------------------------------ */}
        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 9, padding: 9, display: "grid", gap: 9 }}>
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 6 }}>
            <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Answer Breakdown</h3>
            <span style={{ fontSize: 10.5, color: "#64748b" }}>
              {surveyLoading ? "Loading..." : `${surveySummary.answers_total} answer${surveySummary.answers_total === 1 ? "" : "s"} match`}
            </span>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 162px), 1fr))", gap: 6 }}>
            <label style={surveyFilterLabelStyle}>
              Survey
              <select
                value={surveyFilters.survey_id}
                // Changing the survey invalidates any question chosen under the
                // previous one, so clear it rather than filtering by a question
                // that cannot appear in the new result set.
                onChange={(event) =>
                  setSurveyFilters((prev) => ({ ...prev, survey_id: event.target.value, question_id: "", page: 1 }))
                }
                style={surveyFilterControlStyle}
              >
                <option value="">All surveys</option>
                {surveySummary.filters.surveys.map((survey) => (
                  <option key={survey.survey_id} value={String(survey.survey_id)}>
                    {survey.survey_title}
                  </option>
                ))}
              </select>
            </label>

            <label style={surveyFilterLabelStyle}>
              Question type
              <select
                value={surveyFilters.question_type}
                onChange={(event) =>
                  setSurveyFilters((prev) => ({ ...prev, question_type: event.target.value, question_id: "", page: 1 }))
                }
                style={surveyFilterControlStyle}
              >
                <option value="">All types</option>
                {surveySummary.filters.question_types.map((type) => (
                  <option key={type} value={type}>
                    {QUESTION_TYPE_LABELS[type] || type}
                  </option>
                ))}
              </select>
            </label>

            <label style={surveyFilterLabelStyle}>
              Question
              <select
                value={surveyFilters.question_id}
                onChange={(event) => setSurveyFilters((prev) => ({ ...prev, question_id: event.target.value, page: 1 }))}
                style={surveyFilterControlStyle}
              >
                <option value="">All questions</option>
                {filteredSurveyQuestions.map((question) => (
                  <option key={question.question_id} value={String(question.question_id)}>
                    {question.question_text.length > 60
                      ? `${question.question_text.slice(0, 60)}...`
                      : question.question_text}
                  </option>
                ))}
              </select>
            </label>

            <label style={surveyFilterLabelStyle}>
              Search answer
              <input
                value={surveyFilters.search}
                onChange={(event) => setSurveyFilters((prev) => ({ ...prev, search: event.target.value, page: 1 }))}
                placeholder="e.g. financial"
                style={surveyFilterControlStyle}
              />
            </label>
          </div>

          {hasSurveyFilters ? (
            <div>
              <button
                type="button"
                onClick={() => setSurveyFilters(emptySurveyFilters)}
                style={{
                  border: "1px solid #cbd5e1", background: "#f8fafc", color: "#475569",
                  borderRadius: 5, padding: "4px 8px", fontSize: 10.5, cursor: "pointer",
                }}
              >
                Clear filters
              </button>
            </div>
          ) : null}

          {surveyLoading ? (
            <div style={{ padding: 12, textAlign: "center", color: "#64748b", fontSize: 11.5 }}>Loading answers...</div>
          ) : surveySummary.question_breakdown.length === 0 ? (
            <div style={{ padding: 12, textAlign: "center", color: "#64748b", fontSize: 11.5 }}>
              No answers match these filters.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {surveySummary.question_breakdown.map((question) => (
                <div key={question.question_id} style={{ border: "1px solid #e2e8f0", borderRadius: 8, padding: 8 }}>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 5, alignItems: "baseline", justifyContent: "space-between" }}>
                    <strong style={{ fontSize: 11.5, color: "#0f172a" }}>{question.question_text}</strong>
                    <span style={{ fontSize: 10.5, color: "#64748b" }}>
                      {QUESTION_TYPE_LABELS[question.question_type] || question.question_type}
                      {" · "}
                      {question.survey_title}
                      {" · "}
                      {question.answer_count} answer{question.answer_count === 1 ? "" : "s"}
                    </span>
                  </div>

                  <div style={{ display: "grid", gap: 3, marginTop: 6 }}>
                    {question.values.map((value) => (
                      <div key={`${question.question_id}_${value.label}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", gap: 6, alignItems: "center" }}>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontSize: 10.5, color: "#334155", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {value.label}
                          </div>
                          {/* A bar makes the shape of the distribution readable
                              without reaching for a chart library. */}
                          <div style={{ height: 4, background: "#f1f5f9", borderRadius: 2, marginTop: 2, overflow: "hidden" }}>
                            <div style={{ width: `${value.percent}%`, height: "100%", background: "#059669", borderRadius: 2 }} />
                          </div>
                        </div>
                        <span style={{ fontSize: 10.5, color: "#475569", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>
                          {value.count} ({value.percent}%)
                        </span>
                      </div>
                    ))}
                    {question.distinct_values > question.values.length ? (
                      <span style={{ fontSize: 10.5, color: "#94a3b8" }}>
                        + {question.distinct_values - question.values.length} more distinct answer
                        {question.distinct_values - question.values.length === 1 ? "" : "s"} not shown
                      </span>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: "#ffffff", border: "1px solid #e2e8f0", borderRadius: 9, padding: 9, display: "grid", gap: 6 }}>
          <h3 style={{ margin: 0, color: "#0f172a", fontSize: 14 }}>Individual Answers</h3>
          <div style={compactTableWrapStyle}>
            <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
              <colgroup>
                <col style={{ width: "16%" }} />
                <col style={{ width: "16%" }} />
                <col style={{ width: "26%" }} />
                <col style={{ width: "26%" }} />
                <col style={{ width: "16%" }} />
              </colgroup>
              <thead>
                <tr style={{ background: "#f8fafc" }}>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Student</th>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Survey</th>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Question</th>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Answer</th>
                  <th style={{ ...compactThStyle, textAlign: "left" }}>Submitted</th>
                </tr>
              </thead>
              <tbody>
                {surveyLoading ? (
                  <tr>
                    <td colSpan={5} style={{ ...compactTdStyle, textAlign: "center", color: "#64748b" }}>Loading...</td>
                  </tr>
                ) : surveySummary.answers.length === 0 ? (
                  <tr>
                    <td colSpan={5} style={{ ...compactTdStyle, textAlign: "center", color: "#64748b" }}>
                      No answers match these filters.
                    </td>
                  </tr>
                ) : (
                  /*
                   * Student, survey and timestamp are printed once per
                   * submission, not once per answer.
                   *
                   * They are constant across every answer in a submission, so
                   * repeating them turned a ten-question submission into the
                   * same name ten times and buried the only columns that
                   * actually differ. The endpoint orders by submitted_at then
                   * answer_id, so a submission's answers arrive together and
                   * comparing against the previous row is enough to find the
                   * start of each group. A group split across a page boundary
                   * simply reprints the name at the top of the next page, which
                   * is what a reader wants there anyway.
                   */
                  surveySummary.answers.map((answer, index) => {
                    const previous = index > 0 ? surveySummary.answers[index - 1] : null;
                    const startsGroup =
                      !previous || String(previous.submission_id) !== String(answer.submission_id);

                    return (
                      <tr
                        key={answer.answer_id}
                        style={startsGroup && index > 0 ? { borderTop: "1px solid #e2e8f0" } : undefined}
                      >
                        <td style={{ ...compactTdStyle, color: "#0f172a", fontWeight: startsGroup ? 600 : 400 }}>
                          {startsGroup ? answer.student_name || answer.student_number || "-" : ""}
                        </td>
                        <td style={{ ...compactTdStyle, color: "#475569" }}>
                          {startsGroup ? answer.survey_title : ""}
                        </td>
                        <td style={{ ...compactTdStyle, color: "#475569" }}>{answer.question_text}</td>
                        <td style={{ ...compactTdStyle, color: "#0f172a" }}>{answer.answer_value || "(blank)"}</td>
                        <td style={{ ...compactTdStyle, color: "#475569", whiteSpace: "nowrap" }}>
                          {startsGroup ? formatDateTime(answer.submitted_at) : ""}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {surveyAnswerPageCount > 1 ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
              <span style={{ fontSize: 10.5, color: "#64748b" }}>
                Page {surveySummary.page} of {surveyAnswerPageCount}
              </span>
              <div style={{ display: "flex", gap: 5 }}>
                <button
                  type="button"
                  disabled={surveySummary.page <= 1 || surveyLoading}
                  onClick={() => setSurveyFilters((prev) => ({ ...prev, page: Math.max(1, prev.page - 1) }))}
                  style={surveyPagerButtonStyle(surveySummary.page <= 1 || surveyLoading)}
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={surveySummary.page >= surveyAnswerPageCount || surveyLoading}
                  onClick={() => setSurveyFilters((prev) => ({ ...prev, page: prev.page + 1 }))}
                  style={surveyPagerButtonStyle(surveySummary.page >= surveyAnswerPageCount || surveyLoading)}
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </>
    );
  })();

  return (
    <section style={{ display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", gap: 12, height: "100%", minHeight: 0 }}>
      <div
        style={{
          background: "#ffffff",
          border: "1px solid #e2e8f0",
          borderRadius: 9,
          padding: 14,
          display: "grid",
          gap: 11,
          flexShrink: 0,
        }}
      >
        {/* The Report Type <select> that used to sit here is gone: the sidebar
            Reports group now lists every permitted report, so the page-level
            picker was a second control doing the same job. What remains is a
            read-only marker of which report is on screen — the sidebar sets it,
            this confirms it. */}
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "end", justifyContent: "space-between", gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <h2 style={{ margin: 0, color: "#0f172a" }}>{title}</h2>
            <p style={{ margin: "5px 0 0", color: "#64748b", fontSize: 12.5 }}>
              {description}
            </p>
          </div>

          {reportOptions.length === 0 ? (
            <span style={{ color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 999, padding: "4px 9px", fontSize: 10.5, fontWeight: 600, whiteSpace: "nowrap" }}>
              No reports available
            </span>
          ) : (
            <span style={{ color: "#065f46", background: "#ecfdf5", border: "1px solid #a7f3d0", borderRadius: 999, padding: "4px 9px", fontSize: 10.5, fontWeight: 700, whiteSpace: "nowrap" }}>
              {selectedReportMeta.label}
            </span>
          )}
        </div>

        {/* The survey report is exportable but not scopable, so it gets the
            export control on its own — no ScopeFilter, because department,
            course and year cannot narrow an answer. It carries its own filters
            (survey, question, search) and the export honours those instead. */}
        {selectedReport === "survey" ? (
          <div
            style={{
              borderTop: "1px solid #e2e8f0",
              paddingTop: 11,
              display: "flex",
              justifyContent: "flex-end",
            }}
          >
            <ReportExport
              sourceKey="survey"
              filters={{
                survey_id: surveyFilters.survey_id,
                question_id: surveyFilters.question_id,
                question_type: surveyFilters.question_type,
                search: surveyFilters.search,
              }}
              filterLabel={surveyExportLabel}
            />
          </div>
        ) : null}

        {/* Only on the reports the scope can actually narrow. Students,
            attendance, grades and finance all hang off a student, so
            department, course and year level mean something to each; a survey
            or audit report has no student to scope by, and a filter that
            silently does nothing is worse than no filter. */}
        {SCOPED_REPORTS.has(selectedReport) ? (
          <div
            style={{
              borderTop: "1px solid #e2e8f0",
              paddingTop: 11,
              display: "flex",
              flexWrap: "wrap",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
              <ScopeFilter
                idPrefix="reports_scope"
                scope={scope}
                onChange={setScope}
                campuses={scopeOptions.campuses}
                departments={scopeOptions.departments}
                courses={scopeOptions.courses}
                yearLevels={scopeOptions.yearLevels}
                canChooseDepartment={scopeOptions.canChooseDepartment}
                departmentLocked={scopeOptions.departmentLocked}
                departmentLabel={scopeOptions.departmentLabel}
              />
              {scopeLabel ? (
                <span style={{ fontSize: 10.5, color: "#64748b" }}>Showing {scopeLabel}</span>
              ) : null}
            </div>

            <ReportExport sourceKey={selectedReport} scope={scope} scopeLabel={scopeLabel} />
          </div>
        ) : null}
      </div>

      <div style={{ display: "grid", gap: 12, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 2, scrollbarGutter: "stable" }}>
        {reportBody}
      </div>
    </section>
  );
}
