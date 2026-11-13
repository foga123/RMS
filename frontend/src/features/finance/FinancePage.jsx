import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import Modal from "../../shared/components/Modal";
import Form, { FormActions, FormField } from "../../shared/components/Form";
import Table from "../../shared/components/Table";
import { AlertMessage, Button, ExportMenu, Icon, SectionHeader, StatCard, StatCardGrid } from "../../shared/components/ui";
import { InputControl, SelectControl } from "../../shared/components/Form/Form";
import { TABLE_EXPORT_FORMATS, exportTable } from "../../shared/lib/tableExport";
import {
  PERIOD_ALL,
  PERIOD_TERM,
  PERIOD_TERM_WRITE_LABEL,
  periodFilterOptions,
  periodLabel,
  periodWriteOptions,
} from "../../shared/lib/periods";
import {
  closedTermFor,
  closedTermNotice,
  currentTermPeriodFilter,
  currentTermValues,
  importSchoolYearField,
  useCurrentTermFilters,
  withCalendarSchoolYear,
} from "../../shared/lib/currentTerm";
import { PDO_FILTER_ALL, PDO_FILTER_OPTIONS, applyPdoParam } from "../../shared/lib/pdoFilter";
import { confirmAction } from "../../shared/lib/notify";
import { hasRole } from "../../shared/lib/auth";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import ImportDialog from "../../shared/components/import/ImportDialog";
import { SHEET_IMPORT_MAX_ROWS, describeTerm, overwriteWarning } from "../../shared/components/import/importPrecheck";
import Pagination from "../../shared/components/ui/Pagination";
import { FINANCE_IMPORT_COLUMNS, balanceRangeHeader, financeExportColumns } from "./financeFileFormat";

/*
 * The import template and the export columns follow the office's template
 * (latest.xlsx, 2026-10-06): Student Number, Balance to Date, S2 Balance Range.
 * They live in financeFileFormat.js so the two cannot drift apart.
 */

const fieldStyle = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 12.5,
  border: "1px solid var(--border-base)",
  borderRadius: 5,
  boxSizing: "border-box",
  background: "#fff",
};

const emptyForm = {
  id: "",
  student_id: "",
  amount: "",
  date: "",
  semester_id: "",
  school_year_id: "",
  // "" is a semester-total reading, which is what every balance recorded before
  // 2026-08-21 is. It is a real answer, not an unfilled field.
  period: "",
};

/** A peso figure, grouped, with both decimal places. */
function peso(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "-";
  return number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function normalizeRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
}

export default function FinanceManage({ user = null, permissions = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  /*
   * Server-side paging state.
   *
   * finance.php used to answer with every row — 3,349 of them, 1.3 MB — and the
   * page sliced it in the browser. The fetch is the page now, so these three
   * live here rather than inside usePagedRows.
   *
   * `total` is the whole filtered set, which is what the pager counts against;
   * `rows` only ever holds the page on screen.
   */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [total, setTotal] = useState(0);
  /*
   * The search actually sent, behind the search actually typed.
   *
   * With the filtering in the browser a keystroke cost nothing. It is a request
   * now, so typing "dela cruz" would fire nine of them and render whichever
   * happened to come back last. A short delay makes it one.
   */
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Narrow the list to the students the PDO board is worried about. The
  // classification is server-side; this only passes the choice through.
  const [pdoFilter, setPdoFilter] = useState(PDO_FILTER_ALL);
  const [period, setPeriod] = useState(PERIOD_ALL);
  const [summary, setSummary] = useState(null);
  const [periodBuckets, setPeriodBuckets] = useState([]);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [students, setStudents] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [schoolYears, setSchoolYears] = useState([]);
  const financeRoleOnly = hasRole(user, { id: 10, name: "finance" }) && !hasRole(user, { id: 1, name: "admin" });
  const hasPermissionContext = Array.isArray(permissions);
  const canCreate = hasPermissionContext ? canModuleAction(permissions, "create") : !financeRoleOnly;
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;
  const canDelete = hasPermissionContext ? canModuleAction(permissions, "delete") : !financeRoleOnly;
  const canImport = hasPermissionContext ? canModuleAction(permissions, "import") || canCreate : !financeRoleOnly;
  /*
   * Export falls back to "anyone who can read this page", including the finance
   * role, rather than following create/delete. Reading a table and saving that
   * same table to a file are the same act — a role trusted to see every balance
   * on screen is not protected by being unable to save it, it is just made to
   * retype it.
   */
  const canExport = hasPermissionContext ? canModuleAction(permissions, "export") || canEdit : true;

  const [exporting, setExporting] = useState("");
  const [importOpen, setImportOpen] = useState(false);
  const [importTerm, setImportTerm] = useState({ semester_id: "", school_year_id: "", period: "" });
  /*
   * What term the office says it is.
   *
   * Fills the import pickers in AND opens the periodical filter on that
   * periodical, so a page that says P1 in the Academic Calendar shows P1 here
   * rather than three periodicals added together under "Whole Periodical".
   * Applied once, when the calendar arrives — see useCurrentTermFilters().
   */
  const { term: currentTerm, closedTerms } = useCurrentTermFilters((term) => {
    const filter = currentTermPeriodFilter(term);
    if (filter) setPeriod(filter);
  });
  // What the import dialog shows and sends: the pickers, with the school year
  // always the calendar's - it is not a choice there.
  const importValues = useMemo(() => withCalendarSchoolYear(importTerm, currentTerm), [importTerm, currentTerm]);
  const amountOnlyEdit = financeRoleOnly && canEdit && !canCreate && !canDelete;

  const studentNumberById = useMemo(() => {
    const map = {};
    students.forEach((student) => {
      if (student?.student_id != null) {
        map[String(student.student_id)] = student.student_number || String(student.student_id);
      }
    });
    return map;
  }, [students]);

  const studentLabelById = useMemo(() => {
    const map = {};
    students.forEach((student) => {
      if (student?.student_id == null) return;
      const studentNumber = student.student_number || `ID:${student.student_id}`;
      const lastName = String(student?.last_name || "").trim();
      const firstName = String(student?.first_name || "").trim();
      const suffix = [lastName, firstName].filter(Boolean).join(", ");
      map[String(student.student_id)] = suffix ? `${studentNumber} - ${suffix}` : studentNumber;
    });
    return map;
  }, [students]);

  const semesterNameById = useMemo(() => {
    const map = {};
    semesters.forEach((semester) => {
      if (semester?.semester_id != null) {
        map[String(semester.semester_id)] = semester.semester_name || "";
      }
    });
    return map;
  }, [semesters]);

  const schoolYearNameById = useMemo(() => {
    const map = {};
    schoolYears.forEach((schoolYear) => {
      if (schoolYear?.school_year_id != null) {
        map[String(schoolYear.school_year_id)] = schoolYear.schoolyear_name || "";
      }
    });
    return map;
  }, [schoolYears]);

  /*
   * What the rollup is counting, said plainly.
   *
   * With no periodical chosen it is one reading per student across the whole
   * semester; with one chosen it is that periodical. Naming it avoids the card
   * reading "Students 306" beside a table of a different length with no
   * explanation of why the two numbers differ.
   */
  const summaryHeading = useMemo(() => {
    if (period === PERIOD_ALL) return "Students (total)";
    // No option offers this any more; a bookmarked URL can still ask for it.
    if (period === PERIOD_TERM) return "Students (semester rows only)";
    return `Students (${periodLabel(period)})`;
  }, [period]);

  /*
   * The search moved to the server, so there is nothing left to filter here:
   * `rows` is already the page the server chose for this search. Filtering
   * again in the browser would only ever narrow those rows, which is how a
   * paginated table ends up claiming a record does not exist because it sits
   * on page four.
   */

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  // A changed search or periodical starts at the top, rather than leaving the
  // reader on a page number that now points somewhere else in the list.
  useEffect(() => {
    setPage(1);
  }, [debouncedSearch, period]);

  const loadRecords = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({
        action: "list",
        page: String(page),
        limit: String(pageSize),
      });
      if (period !== PERIOD_ALL) params.set("period", period);
      if (debouncedSearch) params.set("search", debouncedSearch);
      applyPdoParam(params, pdoFilter);
      const res = await fetch(getBackendUrl(`finance.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.message || "Failed to load records");
      if (!isCurrent()) return;
      setRows(normalizeRows(payload));
      setTotal(Number(payload?.pagination?.total ?? 0));
      setSummary(payload?.summary || null);
      setPeriodBuckets(Array.isArray(payload?.periods) ? payload.periods : []);
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setSummary(null);
      setError(e?.message || "Failed to load records");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, debouncedSearch, page, pageSize, pdoFilter, period]);

  async function handleImport(file, termValues) {
    if (!canImport) {
      throw new Error("You do not have permission to import finance records.");
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("semester_id", String(termValues.semester_id));
    formData.append("school_year_id", String(termValues.school_year_id));
    // Blank is meaningful and is sent as such: the backend files the rows as a
    // semester-total upload, which is how every import before 2026-08-21 behaved.
    formData.append("period", String(termValues.period ?? ""));

    const response = await fetch(getBackendUrl("finance-import.php"), {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || "Failed to import finance records.");

    await loadRecords();
    return payload;
  }

  /**
   * What is already filed under the term picked in the dialog.
   *
   * Asks the server for the count now. It used to download every finance row
   * and count the matches in JavaScript, because the list action returned all
   * of them and had no total to read; it now filters by semester and school
   * year and reports a total, so this asks for ONE row and reads that instead
   * of pulling 1.3 MB to arrive at a number.
   *
   * PERIOD_TERM, not blank: blank is "the whole semester" on the way in and
   * "every periodical" on the way out, and counting with it would warn about P1,
   * P2 and P3 rows the upload will not touch.
   */
  const importPrecheck = useCallback(
    async (_file, termValues = {}) => {
      const params = new URLSearchParams({
        action: "list",
        period: termValues.period || PERIOD_TERM,
        semester_id: String(termValues.semester_id ?? ""),
        school_year_id: String(termValues.school_year_id ?? ""),
        // One row, purely so the response carries the total. Nothing reads it.
        limit: "1",
      });
      const res = await fetch(getBackendUrl(`finance.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.message || "Could not read what is already recorded for this term.");

      const count = Number(payload?.pagination?.total ?? 0);

      return overwriteWarning({
        count,
        noun: "balance",
        termLabel: describeTerm([
          semesters.find((s) => String(s.semester_id) === String(termValues.semester_id))?.semester_name,
          schoolYears.find((y) => String(y.school_year_id) === String(termValues.school_year_id))?.schoolyear_name,
          periodLabel(termValues.period === "" || termValues.period === undefined ? null : termValues.period),
        ]),
      });
    },
    [schoolYears, semesters]
  );

  useLiveRefresh(["finance"], loadRecords);

  const loadLookups = useCallback(async () => {
    try {
      const [studentRes, semesterRes, schoolYearRes] = await Promise.all([
        fetch(getBackendUrl("student.php?limit=1000"), { headers: { Accept: "application/json" } }),
        fetch(getBackendUrl("semester.php?limit=200"), { headers: { Accept: "application/json" } }),
        fetch(getBackendUrl("school_year.php?limit=1000"), { headers: { Accept: "application/json" } }),
      ]);

      const [studentPayload, semesterPayload, schoolYearPayload] = await Promise.all([
        studentRes.json(),
        semesterRes.json(),
        schoolYearRes.json(),
      ]);

      setStudents(normalizeRows(studentPayload));
      setSemesters(normalizeRows(semesterPayload));
      setSchoolYears(normalizeRows(schoolYearPayload));
    } catch {
      setStudents([]);
      setSemesters([]);
      setSchoolYears([]);
    }
  }, []);

  useEffect(() => {
    void loadRecords();
  }, [loadRecords]);

  useEffect(() => {
    void loadLookups();
  }, [loadLookups]);

  const openCreateModal = useCallback(() => {
    if (!canCreate) return;
    setForm(emptyForm);
    setIsModalOpen(true);
  }, [canCreate]);

  const openEditModal = useCallback((row) => {
    if (!canEdit) return;
    setForm({
      id: row?.id ?? "",
      student_id: row?.student_id != null ? String(row.student_id) : "",
      amount: row?.amount != null ? String(row.amount) : "",
      date: row?.date || "",
      semester_id: row?.semester_id != null ? String(row.semester_id) : "",
      school_year_id: row?.school_year_id != null ? String(row.school_year_id) : "",
      period: row?.period != null ? String(row.period) : "",
    });
    setIsModalOpen(true);
  }, [canEdit]);

  const saveRecord = useCallback(async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const isEdit = Boolean(form.id);
      if (!isEdit && !canCreate) throw new Error("You do not have permission to create finance records");
      if (isEdit && !canEdit) throw new Error("You do not have permission to edit finance records");
      const amountValue = Number(form.amount);
      const payload = amountOnlyEdit
        ? {
            amount: form.amount !== "" && form.amount !== null ? amountValue : 0,
          }
        : {
            student_id: String(form.student_id || "").trim(),
            amount: form.amount !== "" && form.amount !== null ? amountValue : 0,
            date: form.date ? String(form.date) : undefined,
            semester_id: form.semester_id !== "" ? Number(form.semester_id) : undefined,
            school_year_id: form.school_year_id !== "" ? Number(form.school_year_id) : undefined,
            // Sent as null rather than omitted, so clearing the periodical on an
            // existing record actually moves it back to a whole-term reading.
            period: form.period === "" ? null : Number(form.period),
          };

      if (amountOnlyEdit && !isEdit) throw new Error("Finance users can only edit existing student balances");
      if (!amountOnlyEdit && !payload.student_id) throw new Error("Student is required");
      if (Number.isNaN(payload.amount)) throw new Error("Amount must be a number");

      const url = getBackendUrl(`finance.php${isEdit ? `?id=${encodeURIComponent(form.id)}` : "?action=create"}`);
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(payload),
      });
      const response = await res.json();
      if (!res.ok) throw new Error(response?.message || "Failed to save record");

      setSuccess(isEdit ? "Balance updated" : "Record created");
      setIsModalOpen(false);
      setForm(emptyForm);
      await loadRecords();
    } catch (e) {
      setError(e?.message || "Failed to save record");
    } finally {
      setSaving(false);
    }
  }, [amountOnlyEdit, canCreate, canEdit, form, loadRecords]);

  const removeRecord = useCallback(
    async (id) => {
      if (!canDelete) {
        setError("You do not have permission to delete finance records");
        return;
      }
      const confirmed = await confirmAction({
        title: "Delete record?",
        text: "Delete this record?",
        confirmButtonText: "Delete",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`finance.php?id=${encodeURIComponent(id)}`), {
          method: "DELETE",
          headers: { Accept: "application/json" },
        });
        const response = await res.json();
        if (!res.ok) throw new Error(response?.message || "Failed to delete record");
        setSuccess("Record deleted");
        await loadRecords();
      } catch (e) {
        setError(e?.message || "Failed to delete record");
      }
    },
    [canDelete, loadRecords]
  );

  /*
   * One page at a time.
   *
   * This list arrived unpaged: every finance record in the database rendered at
   * once, eight columns each, rebuilt on every keystroke in the search box. It
   * was the last module in the app without paging.
   *
   * Client-side rather than server-side, for the reason StudentsPage gives for
   * the same choice: the search runs across joined fields the endpoint does not
   * index, so the page needs the whole set in hand. What paging fixes here is
   * the rendering, not the fetch.
   */
  // Paging is the fetch now — see loadRecords. usePagedRows sliced an array
  // the page no longer holds.

  /**
   * One record, spelled for a reader.
   *
   * Lifted out of the table so the export can run the same mapping over every
   * filtered row rather than only the twenty on screen. The two must not drift:
   * a file whose Balance Range column says something different from the table
   * is worse than one without the column.
   *
   * `offset` is where the numbering starts — the page offset for the table, and
   * zero for a file, which is read from the top.
   */
  const displayRow = useCallback(
    (row, index, offset = 0) => ({
      ...row,
      display_no: offset + index + 1,
      // The API now returns the student number and name it joined from the
      // student table. The local lookup stays as the fallback, for a row whose
      // student has since been removed.
      display_student: row?.student_number || studentNumberById[String(row?.student_id)] || row?.student_id || "-",
      display_student_name: row?.student_name || "-",
      display_amount: peso(row?.amount),
      display_range: row?.balance_range_name || "-",
      display_period: periodLabel(row?.period),
      display_date: row?.date || "-",
      display_semester: row?.semester_name || semesterNameById[String(row?.semester_id)] || "-",
      display_school_year: row?.schoolyear_name || schoolYearNameById[String(row?.school_year_id)] || "-",
    }),
    [schoolYearNameById, semesterNameById, studentNumberById]
  );

  const tableRows = useMemo(() => {
    // Numbered from the page offset, not from 1 on every page.
    const offset = (page - 1) * pageSize;
    return rows.map((row, index) => displayRow(row, index, offset));
  }, [rows, page, pageSize, displayRow]);

  /**
   * Every record the filters left, as a file.
   *
   * The file is the search result, not the page on screen — so it fetches the
   * whole filtered set with `all=1` rather than exporting the twenty rows in
   * hand. That is the one caller that legitimately wants every row, which is
   * why the endpoint keeps a way to ask for them.
   *
   * The columns are the record as stored: not the balance on its own, but the
   * band it falls in, the periodical, the date, the semester and the school
   * year with it. A column of pesos with no periodical or semester beside it
   * cannot be reconciled against anything once it has left the page.
   */
  async function handleExport(format) {
    if (!canExport) return;

    setExporting(format);
    setError("");
    try {
      const params = new URLSearchParams({ action: "list", all: "1" });
      if (period !== PERIOD_ALL) params.set("period", period);
      if (debouncedSearch) params.set("search", debouncedSearch);
      applyPdoParam(params, pdoFilter);

      const res = await fetch(getBackendUrl(`finance.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.message || "Failed to load records for export");

      const exportRows = normalizeRows(payload).map((row, index) => displayRow(row, index));
      const wrote = exportTable(format, {
        filename: "finance-records",
        sheet: "Finance",
        columns: financeExportColumns(balanceRangeHeader(exportRows.map((row) => row.display_semester))),
        rows: exportRows,
      });
      if (!wrote) setError("There is nothing to export with these filters.");
    } catch (e) {
      setError(e?.message || "Failed to export finance records");
    } finally {
      setExporting("");
    }
  }

  const columns = useMemo(
    () => [
      // `nowrap` on everything that is an identifier, an amount or a date:
      // 02-2526-000001, 2025-2026 and a formatted date all carry hyphens or
      // slashes that CSS will happily break a line after, splitting one value
      // across two lines. Student Name is prose and still wraps.
      { key: "display_no", label: "No.", nowrap: true },
      { key: "display_student", label: "Student Number", nowrap: true },
      { key: "display_student_name", label: "Student Name" },
      { key: "display_period", label: "Periodical", nowrap: true },
      { key: "display_amount", label: "Balance", nowrap: true },
      // The band the balance falls in, as stored: balance_range is a foreign key
      // to the status table, and the page used to show neither the key nor its
      // name. It is what the retention matrix scores against.
      { key: "display_range", label: "Balance Range", nowrap: true },
      { key: "display_date", label: "Date", nowrap: true },
      { key: "display_semester", label: "Semester", nowrap: true },
      { key: "display_school_year", label: "School Year", nowrap: true },
      {
        key: "action",
        label: "Action",
        render: (row) => {
          if (!canEdit && !canDelete) {
            return <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>View only</span>;
          }

          return (
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {canEdit ? (
                <Button
                  size="sm"
                  onClick={() => openEditModal(row)}
                  style={{ background: "var(--info-500)", borderColor: "var(--info-500)", color: "var(--surface-base)" }}
                >
                  {amountOnlyEdit ? "Edit Balance" : "Edit"}
                </Button>
              ) : null}
              {canDelete ? (
                <Button size="sm" variant="danger" onClick={() => void removeRecord(row?.id)}>
                  Remove
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [amountOnlyEdit, canDelete, canEdit, openEditModal, removeRecord]
  );

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Finance Management</h2>

      <AlertMessage tone="error" message={error} />
      <AlertMessage tone="success" message={success} />

      {/*
        The semester rollup, above the records it summarises.

        One reading per student, not a sum of the rows below: a balance is a
        running figure, so a student owing 5,000 at P1 and 2,000 at P3 owes
        2,000, not 7,000. The backend takes the latest reading per student —
        see the summary query in finance.php.
      */}
      {summary ? (
        <div style={{ marginBottom: 11 }}>
          <StatCardGrid minWidth={180}>
            <StatCard label={summaryHeading} value={Number(summary.student_records || 0).toLocaleString()} />
            <StatCard label="Outstanding Balance" value={`PHP ${peso(summary.total_balance)}`} tone="danger" />
            <StatCard label="With a Balance" value={Number(summary.with_balance || 0).toLocaleString()} tone="danger" />
            <StatCard label="Fully Paid" value={Number(summary.cleared || 0).toLocaleString()} tone="success" />
          </StatCardGrid>
        </div>
      ) : null}

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <SectionHeader
          title="All Finance Records"
          sticky
          actions={
            <>
              <InputControl
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search..."
                style={{ minWidth: 240, flex: "1 1 240px" }}
                name="finance_manage_search"
              />
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>Periodical</span>
                <SelectControl
                  value={period}
                  onChange={(event) => setPeriod(event.target.value)}
                  style={{ width: "auto", minWidth: 66, fontSize: 11.5, padding: "5px 6px" }}
                  name="finance_manage_period"
                  aria-label="Periodical"
                >
                  {periodFilterOptions(periodBuckets).map((option) => (
                    <option key={option.value} value={option.value} title={option.title}>
                      {option.label}
                    </option>
                  ))}
                </SelectControl>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>Drop-out risk</span>
                <SelectControl
                  value={pdoFilter}
                  onChange={(event) => {
                    setPdoFilter(event.target.value);
                    setPage(1);
                  }}
                  style={{ width: "auto", minWidth: 96, fontSize: 11.5, padding: "5px 6px" }}
                  name="finance_manage_pdo"
                  aria-label="Drop-out risk"
                  title="Narrow to the students the PDO list is worried about"
                >
                  {PDO_FILTER_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </SelectControl>
              </div>
              {canImport ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    // Opens on the term the office is in rather than on blanks.
                    // Semester and periodical can be changed; the school year
                    // is the calendar's either way (importValues).
                    setImportTerm(currentTermValues(currentTerm));
                    setImportOpen(true);
                  }}
                >
                  <Icon name="upload" size={14} />
                  <span>Import</span>
                </Button>
              ) : null}
              {canExport ? (
                <ExportMenu
                  options={TABLE_EXPORT_FORMATS}
                  busyKey={exporting}
                  onSelect={(format) => handleExport(format)}
                />
              ) : null}
              {canCreate ? (
                <Button onClick={openCreateModal}>
                  <Icon name="plus" size={14} />
                  <span>Add Record</span>
                </Button>
              ) : null}
            </>
          }
        />

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 289px)" }}>
          <Table
            columns={columns}
            rows={tableRows}
            loading={loading}
            emptyText="No records found"
          />
        </div>

        {total > 0 ? (
          <div style={{ padding: 9, borderTop: "1px solid var(--border-base)" }}>
            <Pagination
              page={page}
              pageSize={pageSize}
              total={total}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size);
                setPage(1);
              }}
              itemLabel="records"
            />
          </div>
        ) : null}
      </div>

      <Modal open={isModalOpen} title={amountOnlyEdit ? "Edit Student Balance" : form.id ? "Edit Record" : "Add Record"} onClose={() => setIsModalOpen(false)} width={459} error={error}>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRecord();
          }}
          style={{ gap: 11 }}
        >
          {amountOnlyEdit ? (
            <FormField label="Student Number" htmlFor="finance_student_label">
              <input
                id="finance_student_label"
                value={studentLabelById[String(form.student_id)] || form.student_id || ""}
                style={fieldStyle}
                disabled
                name="finance_manage_student_label"
              />
            </FormField>
          ) : (
            <FormField label="Student Number" htmlFor="finance_student_id" required>
              <select
                id="finance_student_id"
                value={String(form.student_id)}
                onChange={(event) => setForm((prev) => ({ ...prev, student_id: event.target.value }))}
                style={fieldStyle}
                name="finance_manage_student_id"
              >
                <option value="">Select a student</option>
                {students.map((student) => (
                  <option key={student.student_id} value={student.student_id}>
                    {studentLabelById[String(student.student_id)] || student.student_number || `ID:${student.student_id}`}
                  </option>
                ))}
              </select>
            </FormField>
          )}

          <FormField label="Amount" htmlFor="finance_amount" required>
            <input
              id="finance_amount"
              type="number"
              step="0.01"
              value={String(form.amount)}
              onChange={(event) => setForm((prev) => ({ ...prev, amount: event.target.value }))}
              style={fieldStyle}
              name="finance_manage_amount"
            />
          </FormField>

          {!amountOnlyEdit ? (
            <>
              <FormField label="Date" htmlFor="finance_date">
                <input
                  id="finance_date"
                  type="date"
                  value={form.date}
                  onChange={(event) => setForm((prev) => ({ ...prev, date: event.target.value }))}
                  style={fieldStyle}
                  name="finance_manage_date"
                />
              </FormField>

              <FormField label="Semester (optional)" htmlFor="finance_semester_id">
                <select
                  id="finance_semester_id"
                  value={String(form.semester_id)}
                  onChange={(event) => setForm((prev) => ({ ...prev, semester_id: event.target.value }))}
                  style={fieldStyle}
                  name="finance_manage_semester_id"
                >
                  <option value="">Select semester</option>
                  {semesters.map((semester) => (
                    <option key={semester.semester_id} value={semester.semester_id}>
                      {semester.semester_name || `Semester ${semester.semester_id}`}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="School Year (optional)" htmlFor="finance_school_year_id">
                <select
                  id="finance_school_year_id"
                  value={String(form.school_year_id)}
                  onChange={(event) => setForm((prev) => ({ ...prev, school_year_id: event.target.value }))}
                  style={fieldStyle}
                  name="finance_manage_school_year_id"
                >
                  <option value="">Select school year</option>
                  {schoolYears.map((schoolYear) => (
                    <option key={schoolYear.school_year_id} value={schoolYear.school_year_id}>
                      {schoolYear.schoolyear_name || `School Year ${schoolYear.school_year_id}`}
                    </option>
                  ))}
                </select>
              </FormField>

              <FormField label="Periodical (optional)" htmlFor="finance_period">
                <select
                  id="finance_period"
                  value={String(form.period ?? "")}
                  onChange={(event) => setForm((prev) => ({ ...prev, period: event.target.value }))}
                  style={fieldStyle}
                  name="finance_manage_period_field"
                >
                  {periodWriteOptions().map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </FormField>
            </>
          ) : null}

          <FormActions>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </FormActions>
        </Form>
      </Modal>

      <ImportDialog
        open={importOpen && canImport}
        onClose={() => setImportOpen(false)}
        title="Import Finance Balances"
        description="Uses Student Number, Balance to Date and Balance Range. The range is calculated from the balance. School year comes from Academic Calendar; choose the semester and periodical below. Matching records are updated."
        templateFileName="finance-import-template.csv"
        columns={FINANCE_IMPORT_COLUMNS}
        fields={[
          importSchoolYearField("school_year_id", currentTerm?.schoolyear_name),
          { key: "semester_id", label: "Semester", options: semesters.map((s) => ({ value: String(s.semester_id), label: s.semester_name })) },
          { key: "period", label: "Periodical", required: false, placeholder: PERIOD_TERM_WRITE_LABEL, options: periodWriteOptions({ includeBlank: false }) },
        ]}
        values={importValues}
        closedNotice={closedTermNotice(closedTermFor(closedTerms, importValues.school_year_id, importValues.semester_id))}
        onFieldChange={(key, value) => setImportTerm((prev) => ({ ...prev, [key]: value }))}
        onSubmit={handleImport}
        precheck={importPrecheck}
        maxRows={SHEET_IMPORT_MAX_ROWS}
        summarize={(r) => [
          { label: "Rows read", value: r.summary?.rows_read ?? 0 },
          { label: "Added", value: r.summary?.inserted ?? 0, tone: "good" },
          { label: "Updated", value: r.summary?.updated ?? 0, tone: "good" },
          ...(r.summary?.unmatched ? [{ label: "Unmatched", value: r.summary.unmatched, tone: "warn" }] : []),
          ...(r.summary?.invalid ? [{ label: "Invalid rows", value: r.summary.invalid, tone: "bad" }] : []),
          ...(r.summary?.negatives ? [{ label: "Credit balances", value: r.summary.negatives, tone: "warn" }] : []),
          ...(r.summary?.range_mismatches
            ? [{ label: "Range differs from balance", value: r.summary.range_mismatches, tone: "warn" }]
            : []),
          ...(r.summary?.skipped_out_of_scope
            ? [{ label: "Out of scope", value: r.summary.skipped_out_of_scope, tone: "warn" }]
            : []),
        ]}
        detail={(r) => [
          { label: "Student IDs with no matching student", items: r.details?.unmatched_student_ids || [] },
          { label: "Rows with an unreadable balance or date", items: r.details?.invalid_student_ids || [] },
          { label: "Negative balances (imported as credits)", items: r.details?.negative_balances || [] },
          { label: "Student IDs listed more than once", items: r.details?.duplicate_student_ids || [] },
          // Imported anyway, by the amount: the range is worked out from it.
          { label: "Ranges that disagree with the balance (imported by the balance)", items: r.details?.range_mismatches || [] },
        ]}
      />
    </section>
  );
}
