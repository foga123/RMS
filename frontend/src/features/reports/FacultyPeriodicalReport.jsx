import React, { useEffect, useState } from "react";
import { getBackendUrl } from "../../shared/lib/url";
import { formatDateTime } from "../../shared/lib/dateTime";
import { downloadCsvFile } from "../../shared/lib/spreadsheet";
import Table from "../../shared/components/Table";
import Button from "../../shared/components/ui/Button";
import Pagination from "../../shared/components/ui/Pagination";
import DashboardPanel from "../../shared/layout/dashboard/DashboardPanel";

const CONTROL = { padding: "7px 9px", border: "1px solid var(--border-base)", borderRadius: 8, background: "var(--surface-base)", color: "var(--text-primary)" };
const OUTCOMES = [["", "All faculty outcomes"], ["not_recorded", "Not recorded"], ["continuing", "Continuing"], ["shifting", "Shifting course"], ["stopping", "Stopping"], ["undecided", "Undecided - for follow up"]];

async function readReport(params, signal) {
  const response = await fetch(getBackendUrl(`faculty_periodical_report.php?${new URLSearchParams(params)}`), { credentials: "include", signal });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || "Could not load faculty updates.");
  return data;
}

export default function FacultyPeriodicalReport() {
  const [options, setOptions] = useState(null);
  const [filters, setFilters] = useState(null);
  const [search, setSearch] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [student, setStudent] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState("");

  useEffect(() => {
    const controller = new AbortController();
    readReport({ action: "options" }, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setOptions(result.options);
      setFilters({ school_year_id: result.term.school_year_id || "", semester_id: result.term.semester_id || "", period: result.term.period || "", outcome: "", search: "", page: 1, limit: 20 });
    }).catch((reason) => {
      if (!controller.signal.aborted) { setError(reason.message); setLoading(false); }
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!filters) return undefined;
    const controller = new AbortController();
    setStudent(null);
    setData(null);
    setError("");
    if (!filters.school_year_id || !filters.semester_id || !filters.period) {
      setLoading(false);
      return () => controller.abort();
    }
    setLoading(true);
    readReport(filters, controller.signal).then((result) => {
      if (!controller.signal.aborted) setData(result);
    }).catch((reason) => {
      if (!controller.signal.aborted) setError(reason.message);
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => controller.abort();
  }, [filters, refresh]);

  useEffect(() => {
    if (!student || !filters) return undefined;
    const controller = new AbortController();
    setHistory(null);
    setHistoryError("");
    // A detail must not inherit the list's search, outcome filter or page.
    readReport({ school_year_id: filters.school_year_id, semester_id: filters.semester_id, period: filters.period, student_id: student.student_id }, controller.signal)
      .then((result) => { if (!controller.signal.aborted) setHistory(result.history); })
      .catch((reason) => { if (!controller.signal.aborted) setHistoryError(reason.message); });
    return () => controller.abort();
  }, [student, filters]);

  function change(key, value) {
    setFilters((current) => ({ ...current, [key]: value, page: 1 }));
  }

  function exportPage() {
    const columns = [
      ["student_number", "Student number"], ["student_name", "Student"], ["course_code", "Course"],
      ["department_name", "Department"], ["year_level", "Year level"], ["section", "Section"],
      ["school_year", "School year"], ["semester", "Semester"], ["period", "Periodical"],
      ["priority_label", "Calculated risk"], ["faculty_outcome_label", "Faculty update"],
      ["reason", "Reason"], ["notes", "Faculty notes"], ["faculty_name", "Recorded by"],
      ["contacted_at", "Recorded at"], ["assigned_staff", "Currently assigned staff"],
      ["follow_up", "Later follow-up outcome"], ["follow_up_by", "Follow-up by"], ["follow_up_at", "Follow-up at"],
    ].map(([key, label]) => ({ key, label }));
    const rows = data.rows.map((row) => ({ ...row,
      school_year: options.school_years.find((option) => String(option.id) === String(filters.school_year_id))?.label,
      semester: options.semesters.find((option) => String(option.id) === String(filters.semester_id))?.label,
      period: `P${filters.period}`, assigned_staff: row.assigned_staff.join(", "),
    }));
    downloadCsvFile(`faculty-periodical-P${filters.period}-page-${data.page}.csv`, columns, rows);
  }

  const columns = [
    { key: "student_name", label: "Student", render: (row) => <><strong>{row.student_name}</strong><div>{row.student_number}</div><div>{row.course_code} · {row.section || "No section"}</div></> },
    { key: "priority_label", label: "Calculated risk" },
    { key: "faculty_outcome_label", label: "Faculty update", render: (row) => <><strong>{row.faculty_outcome_label}</strong><div>{row.reason}</div><div>{row.notes}</div></> },
    { key: "faculty_name", label: "Recorded by / date", render: (row) => <>{row.faculty_name || "—"}<div>{row.contacted_at ? formatDateTime(row.contacted_at) : ""}</div></> },
    { key: "assigned_staff", label: "Currently assigned staff", render: (row) => row.assigned_staff.join(", ") || "Unassigned" },
    { key: "follow_up", label: "Later follow-up", render: (row) => <>{row.follow_up}<div>{row.follow_up_by}</div><div>{row.follow_up_at ? formatDateTime(row.follow_up_at) : ""}</div></> },
    { key: "history", label: "History", render: (row) => <Button variant="secondary" onClick={() => setStudent(row)} aria-label={`History for ${row.student_name}`}>View history</Button> },
  ];

  return <div style={{ display: "grid", gap: 12 }}>
    <DashboardPanel>
      <h3>Faculty Periodical Report</h3>
      <p>Faculty observations and later follow-up on the students you may view. These updates do not change calculated risk or official enrollment status.</p>
      <p style={{ color: "var(--text-muted)", fontSize: 12 }}>Each row shows the latest faculty observation for the chosen periodical. Risk uses that periodical’s records. Student scope and assignments reflect current records. Follow-up shows a later outcome for this periodical or the semester; history includes conversations across the selected semester.</p>
      {filters && options ? <form onSubmit={(event) => { event.preventDefault(); change("search", search.trim()); }} style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "end" }}>
        <label>School year<select aria-label="School year" style={CONTROL} value={filters.school_year_id} onChange={(event) => change("school_year_id", event.target.value)}><option value="">Choose year</option>{options.school_years.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label>Semester<select aria-label="Semester" style={CONTROL} value={filters.semester_id} onChange={(event) => change("semester_id", event.target.value)}><option value="">Choose semester</option>{options.semesters.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
        <label>Periodical<select aria-label="Periodical" style={CONTROL} value={filters.period} onChange={(event) => change("period", event.target.value)}><option value="">Choose periodical</option>{[1, 2, 3].map((period) => <option key={period} value={period}>P{period}</option>)}</select></label>
        <label>Faculty outcome<select aria-label="Faculty outcome" style={CONTROL} value={filters.outcome} onChange={(event) => change("outcome", event.target.value)}>{OUTCOMES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
        <label>Search<input aria-label="Search students" style={CONTROL} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, number or section" /></label>
        <Button type="submit">Search</Button>
        <Button type="button" variant="secondary" onClick={() => setRefresh((value) => value + 1)}>Refresh</Button>
      </form> : null}
    </DashboardPanel>
    {error ? <div role="alert">{error}</div> : null}
    {!loading && filters && (!filters.school_year_id || !filters.semester_id || !filters.period) ? <p>Select a school year, semester and periodical to read the report.</p> : null}
    {data && !loading && !error ? <DashboardPanel>
      <p>{data.summary.total} students · {data.summary.continuing} continuing · {data.summary.concerns} with reported concerns · {data.summary.not_recorded} without a faculty update</p>
      <Button variant="secondary" onClick={exportPage} disabled={!data.rows.length}>Export this page (CSV)</Button>
    </DashboardPanel> : null}
    {!error ? <Table columns={columns} rows={data?.rows || []} loading={loading} emptyText="No students match this report scope and filters." /> : null}
    {data && !loading && !error ? <Pagination page={data.page} pageSize={data.limit} total={data.summary.total} onPageChange={(page) => setFilters((current) => ({ ...current, page }))} onPageSizeChange={(limit) => change("limit", limit)} itemLabel="students" /> : null}
    {student ? <DashboardPanel>
      <h4>Semester history: {student.student_name}</h4>
      <Button variant="secondary" onClick={() => setStudent(null)}>Close history</Button>
      {historyError ? <div role="alert">{historyError}</div> : null}
      {!history && !historyError ? <p>Loading history…</p> : null}
      {history ? <Table columns={[
        { key: "period", label: "Periodical", render: (row) => row.period ? `P${row.period}` : "Semester" },
        { key: "outcome_label", label: "Outcome" }, { key: "reason", label: "Reason" },
        { key: "notes", label: "Notes" }, { key: "actor_name", label: "Recorded by" }, { key: "actor_role_name", label: "Role" },
        { key: "contacted_at", label: "Date", render: (row) => formatDateTime(row.contacted_at) },
      ]} rows={history.map((row) => ({ ...row, id: row.attempt_id }))} emptyText="No conversations recorded in this semester." /> : null}
    </DashboardPanel> : null}
  </div>;
}
