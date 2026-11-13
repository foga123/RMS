import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import { ManagementPage, ManagementPagination, ManagementTableCard } from "../../shared/components/management/ManagementPage";
import { Button, ExportMenu, Icon, StatCard, StatCardGrid } from "../../shared/components/ui";
import { InputControl, SelectControl } from "../../shared/components/Form/Form";
import ImportDialog from "../../shared/components/import/ImportDialog";
import { SHEET_IMPORT_MAX_ROWS, countExisting, describeTerm, overwriteWarning } from "../../shared/components/import/importPrecheck";
import AttendanceFilterPanel from "./AttendanceFilterPanel";
import { hasModulePermission } from "../../shared/lib/roleAccess";
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
  importSchoolYearField,
  useCurrentTermFilters,
  withCalendarSchoolYear,
  withCurrentTermDefaults,
} from "../../shared/lib/currentTerm";
import {
  PDO_FILTER_ALL,
  PDO_FILTER_OPTIONS,
  applyPdoParam,
  isPdoFiltered,
  pdoFilterLabel,
} from "../../shared/lib/pdoFilter";
import { getBackendUrl } from "../../shared/lib/url";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { courseCampusSuffix, departmentCampusSuffix } from "../../shared/lib/scopeOptionLabels";
import { uploadChipLabel, uploadOptionLabel, uploadOptionTitle, uploadTermFilters } from "./attendanceUploads";

const emptyStats = {
  total_students: 0,
  total_classes_conducted: 0,
  average_attendance_rate: 0,
  average_absence_rate: 0,
};

const sortableColumns = new Set([
  "student_id",
  "student_name",
  "total_classes_conducted",
  "present",
  "absent",
  "present_percentage",
  "absent_percentage",
  "p1_rate",
  "p2_rate",
  "p3_rate",
]);

/**
 * Names here must stay in step with attimport_map_header() in
 * attendance-import.php. Student Name and the two percentage columns are
 * accepted so an exported sheet round-trips, but they are not read: the
 * percentages are always recomputed from the counts.
 */
const ATTENDANCE_IMPORT_COLUMNS = [
  { name: "Student ID", required: true, example: "REPLACE-WITH-STUDENT-ID", hint: "Student number, or the numeric student ID" },
  { name: "Student Name", example: "Name is ignored on import", hint: "Kept for readability; not read on upload" },
  { name: "Total Classes Conducted", required: true, example: "20" },
  { name: "Present", required: true, example: "18" },
  { name: "Absent", required: true, example: "2" },
  { name: "Present %", example: "", hint: "Recomputed from the counts" },
  { name: "Absent %", example: "", hint: "Recomputed from the counts" },
];

function formatPercent(value) {
  const number = Number(value);
  return Number.isFinite(number) ? `${number.toFixed(2)}%` : "0.00%";
}

function formatNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

/**
 * One periodical's attendance rate for this student.
 *
 * A dash, not 0.00%, where the periodical holds no row. formatPercent() turns
 * null into "0.00%" - correct for a total that really is zero, and a lie here:
 * "attended none of the P2 classes" and "has not been recorded at P2 yet" are
 * opposite readings, and only one of them is a reason to call the student.
 *
 * The counts sit in the tooltip rather than the cell. Three periodicals in
 * "18/20" form is a wall of digits to scan across; the rate is the number being
 * compared, and the count is what confirms it once a row is worth a second
 * look.
 */
function PeriodRate({ row, period }) {
  const classes = Number(row[`p${period}_classes`]) || 0;
  /*
   * A periodical nobody has uploaded yet reads as 0%, not as a dash.
   *
   * The dash was the more precise statement - "no data" and "attended
   * nothing" are different facts - but it left a column of dashes early in
   * a semester that read as though the screen were broken. The tooltip
   * still says which of the two this is, and the risk model reads the
   * database rather than this cell, so nobody is flagged for a zero that
   * only means the file has not arrived.
   */
  if (classes <= 0) {
    return (
      <span style={{ color: "var(--text-muted)" }} title={`No P${period} attendance recorded for this student yet`}>
        {formatPercent(0)}
      </span>
    );
  }

  const present = Number(row[`p${period}_present`]) || 0;
  const absent = Number(row[`p${period}_absent`]) || 0;
  return (
    <span title={`P${period}: present ${formatNumber(present)}, absent ${formatNumber(absent)} of ${formatNumber(classes)} classes`}>
      {formatPercent(row[`p${period}_rate`])}
    </span>
  );
}

async function fetchAllPages(path, limit = 200) {
  const rows = [];
  let page = 1;
  let total = Number.POSITIVE_INFINITY;

  while (rows.length < total) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(limit));

    const response = await fetch(getBackendUrl(`${path}?${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || `Failed to load ${path}`);

    const batch = Array.isArray(payload?.data) ? payload.data : [];
    rows.push(...batch);

    const nextTotal = Number(payload?.pagination?.total);
    total = Number.isFinite(nextTotal) ? nextTotal : rows.length;
    if (batch.length === 0 || batch.length < limit) break;
    page += 1;
  }

  return rows;
}

function buildQuery({
  page,
  limit,
  search,
  section,
  courseId,
  departmentId,
  semesterId,
  schoolYearId,
  period,
  uploadId,
  pdoFilter,
  sort,
  direction,
  format,
  permissionAction,
}) {
  const params = new URLSearchParams();
  if (page) params.set("page", String(page));
  if (limit) params.set("limit", String(limit));
  if (search.trim()) params.set("search", search.trim());
  if (section.trim()) params.set("section", section.trim());
  if (courseId) params.set("course_id", String(courseId));
  // attendance-summary.php reads program_id first and falls back to
  // department_id; both name the same column, c.department_id.
  if (departmentId) params.set("department_id", String(departmentId));
  /*
   * date_from / date_to are gone from the client.
   *
   * The endpoint still accepts them - a saved link or a script may carry them,
   * and removing a working query parameter breaks those for nothing. What this
   * module no longer does is offer them: attendance is filed against a term and
   * a periodical, not a date range, so two date boxes beside the semester and
   * periodical selects invited a reader to narrow by a window that cuts across
   * both and returns a partial periodical with no indication it is partial.
   */
  if (semesterId) params.set("semester_id", String(semesterId));
  if (schoolYearId) params.set("school_year_id", String(schoolYearId));
  if (period) params.set("period", String(period));
  if (uploadId) params.set("upload_id", String(uploadId));
  applyPdoParam(params, pdoFilter);
  if (sort) params.set("sort", sort);
  if (direction) params.set("direction", direction);
  if (format) params.set("format", format);
  if (permissionAction) params.set("permission_action", permissionAction);
  return params;
}

function getFilenameFromDisposition(disposition, fallback) {
  const match = String(disposition || "").match(/filename="?([^"]+)"?/i);
  return match?.[1] || fallback;
}

/** The three formats attendance-summary.php renders server-side. */
const EXPORT_FORMATS = [
  { key: "excel", label: "Excel", hint: ".xls" },
  { key: "csv", label: "CSV", hint: ".csv" },
  { key: "pdf", label: "PDF", hint: ".pdf" },
];

export default function AttendanceManagement({ permissions = [] }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [stats, setStats] = useState(emptyStats);
  const [loading, setLoading] = useState(false);
  const [lookupsLoading, setLookupsLoading] = useState(false);
  const [exporting, setExporting] = useState("");
  const [error, setError] = useState("");

  const [search, setSearch] = useState("");
  const [section, setSection] = useState("");
  const [courseId, setCourseId] = useState("");
  const [departmentId, setDepartmentId] = useState("");

  const [semesterId, setSemesterId] = useState("");
  const [schoolYearId, setSchoolYearId] = useState("");
  const [period, setPeriod] = useState(PERIOD_ALL);
  // Narrow the list to the students the PDO board is worried about. The
  // classification is server-side; this only passes the choice through.
  const [pdoFilter, setPdoFilter] = useState(PDO_FILTER_ALL);
  const [periodBuckets, setPeriodBuckets] = useState([]);
  /*
   * One upload, by when it was uploaded. Attendance has no daily records:
   * every row comes from a sheet, so "which sheet, and when" is the time
   * filter that means something here. The list comes with each summary, so
   * an import shows up in it as soon as the table reloads.
   */
  const [uploadId, setUploadId] = useState("");
  const [uploads, setUploads] = useState([]);
  const [sort, setSort] = useState("student_id");
  const [direction, setDirection] = useState("asc");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);

  const [filterPanelOpen, setFilterPanelOpen] = useState(false);

  const [courses, setCourses] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [schoolYears, setSchoolYears] = useState([]);

  // ImportDialog owns the file, the busy state, the errors and the result
  // summary. Only the target term stays here.
  const [importOpen, setImportOpen] = useState(false);
  const [importTerm, setImportTerm] = useState({ semester_id: "", school_year_id: "", period: "" });
  /*
   * What term the office says it is.
   *
   * This page has all three filters, so it takes all three: the table opens on
   * the school year, semester and periodical the Academic Calendar names,
   * rather than on every term ever recorded added together. Applied once, when
   * the calendar arrives — see useCurrentTermFilters().
   */
  const { term: currentTerm, closedTerms } = useCurrentTermFilters((term) => {
    const filter = currentTermPeriodFilter(term);
    if (filter) setPeriod(filter);
    if (term?.semester_id != null) setSemesterId(String(term.semester_id));
    if (term?.school_year_id != null) setSchoolYearId(String(term.school_year_id));
  });
  // What the import dialog shows and sends: the pickers, with the school year
  // always the calendar's - it is not a choice there.
  const importValues = useMemo(() => withCalendarSchoolYear(importTerm, currentTerm), [importTerm, currentTerm]);

  const canExport = hasModulePermission(permissions, "export");
  /*
   * Import asks for `import`, not for `export`.
   *
   * Reading a sheet out and writing one in are different powers, and tying
   * them together offered the button to everyone who could export while the
   * server still allowed only admin. SSG holds attendance export, so SSG got
   * an Import button and a bare "Forbidden" on using it.
   *
   * attendance_management now declares `import` and attendance-import.php is
   * gated on it, so this is the same question the server will ask.
   */
  const canImport = hasModulePermission(permissions, "import");

  const filteredCourses = useMemo(() => {
    if (!departmentId) return courses;
    return courses.filter((course) => String(course?.department_id ?? "") === String(departmentId));
  }, [courses, departmentId]);

  useEffect(() => {
    if (!departmentId || !courseId) return;
    const courseStillMatches = filteredCourses.some((course) => String(course?.course_id ?? "") === String(courseId));
    if (!courseStillMatches) {
      setCourseId("");
      setPage(1);
    }
  }, [courseId, filteredCourses, departmentId]);

  // "All courses in CITE" rather than a bare "All courses", so the two
  // dropdowns read as one chain instead of two filters that both say course.
  const departmentLabel = useMemo(() => {
    const picked = departments.find((department) => String(department?.department_id ?? "") === String(departmentId));
    return picked?.department_code || picked?.department_name || "";
  }, [departmentId, departments]);

  /*
   * The chosen option's name, for the chip that reports it.
   *
   * A chip reading "Course: 12" is worse than no chip: the reader has to open
   * the panel to find out what 12 was, which is the trip the chip exists to
   * save. Falls back to the id only when the lookup has not loaded yet, so a
   * chip never renders blank.
   */
  const labelFor = (list, idKey, value, ...nameKeys) => {
    if (!value) return "";
    const picked = list.find((row) => String(row?.[idKey] ?? "") === String(value));
    if (!picked) return String(value);
    for (const key of nameKeys) {
      if (picked[key]) return String(picked[key]);
    }
    return String(value);
  };

  const courseLabel = labelFor(courses, "course_id", courseId, "course_code", "course_name");
  const semesterLabel = labelFor(semesters, "semester_id", semesterId, "semester_name");
  const schoolYearLabel = labelFor(schoolYears, "school_year_id", schoolYearId, "schoolyear_name");

  const loadLookups = useCallback(async () => {
    setLookupsLoading(true);
    try {
      const [courseRows, departmentRows, semesterRows, schoolYearRows] = await Promise.all([
        fetchAllPages("course.php", 200),
        fetchAllPages("department.php", 200),
        fetchAllPages("semester.php", 200),
        fetchAllPages("school_year.php", 500),
      ]);
      setCourses(courseRows);
      setDepartments(departmentRows);
      setSemesters(semesterRows);
      setSchoolYears(schoolYearRows);
    } catch (lookupError) {
      setError(lookupError?.message || "Failed to load attendance filters");
    } finally {
      setLookupsLoading(false);
    }
  }, []);

  const loadSummary = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = buildQuery({
        page,
        limit,
        search,
        section,
        courseId,
        departmentId,
        semesterId,
        schoolYearId,
        period,
        uploadId,
        pdoFilter,
        sort,
        direction,
      });
      const response = await fetch(getBackendUrl(`attendance-summary.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Failed to load attendance summary");

      if (!isCurrent()) return;

      setRows(Array.isArray(payload?.data) ? payload.data : []);
      setStats({ ...emptyStats, ...(payload?.stats || {}) });
      setPeriodBuckets(Array.isArray(payload?.periods) ? payload.periods : []);
      setUploads(Array.isArray(payload?.uploads) ? payload.uploads : []);
      setTotal(Number(payload?.pagination?.total || 0));
    } catch (summaryError) {
      if (!isCurrent()) return;
      setRows([]);
      setStats(emptyStats);
      setTotal(0);
      setError(summaryError?.message || "Failed to load attendance summary");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, courseId, departmentId, direction, limit, page, pdoFilter, period, schoolYearId, search, section, semesterId, sort, uploadId]);

  useEffect(() => {
    void loadLookups();
  }, [loadLookups]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  useLiveRefresh(["attendance", "students"], loadSummary);

  function updateFilter(setter, value) {
    setter(value);
    setPage(1);
  }

  /*
   * A term filter changed by hand lets go of the chosen upload: an upload
   * belongs to one term, so keeping it would narrow the new term to nothing.
   */
  function updateTermFilter(setter, value) {
    setUploadId("");
    updateFilter(setter, value);
  }

  // Choosing an upload moves the term filters onto its term; see uploadTermFilters().
  function selectUpload(value) {
    updateFilter(setUploadId, value);
    const picked = uploads.find((upload) => String(upload.upload_id) === String(value));
    if (!picked) return;
    const term = uploadTermFilters(picked);
    setSemesterId(term.semesterId);
    setSchoolYearId(term.schoolYearId);
    setPeriod(term.period);
  }

  const selectedUpload = uploads.find((upload) => String(upload.upload_id) === String(uploadId));

  // useCallback so the identity is stable across renders: the `columns` memo
  // below depends on sortLabel, which depends on this. Without it both would be
  // rebuilt on every render and the memo would do nothing.
  // sortableColumns is a module-level constant and the setters are stable, so
  // there are no dependencies.
  const toggleSort = useCallback((columnKey) => {
    if (!sortableColumns.has(columnKey)) return;
    setPage(1);
    setSort((currentSort) => {
      if (currentSort !== columnKey) {
        setDirection("asc");
        return columnKey;
      }
      setDirection((currentDirection) => (currentDirection === "asc" ? "desc" : "asc"));
      return currentSort;
    });
  }, []);

  const sortLabel = useCallback((columnKey, label) => {
    const active = sort === columnKey;
    const symbol = active ? (direction === "asc" ? " ▲" : " ▼") : "";
    return (
      <button
        type="button"
        onClick={() => toggleSort(columnKey)}
        style={{
          border: 0,
          background: "transparent",
          color: active ? "#065f46" : "#475569",
          font: "inherit",
          fontWeight: 700,
          cursor: "pointer",
          padding: 0,
          whiteSpace: "nowrap",
        }}
      >
        {label}{symbol}
      </button>
    );
  }, [sort, direction, toggleSort]);

  async function downloadExport(format) {
    if (!canExport) {
      setError("You do not have permission to export attendance summaries.");
      return;
    }

    setExporting(format);
    setError("");
    try {
      const params = buildQuery({
        search,
        section,
        courseId,
        departmentId,
        semesterId,
        schoolYearId,
        period,
        uploadId,
        pdoFilter,
        sort,
        direction,
        format,
        permissionAction: "export",
      });
      const response = await fetch(getBackendUrl(`attendance-summary.php?${params.toString()}`), {
        credentials: "include",
      });
      const contentType = response.headers.get("Content-Type") || "";
      if (!response.ok) {
        const payload = contentType.includes("application/json") ? await response.json().catch(() => ({})) : {};
        throw new Error(payload?.message || "Failed to export attendance summary");
      }

      const blob = await response.blob();
      const fallbackName = `attendance-summary.${format === "excel" ? "xls" : format}`;
      const filename = getFilenameFromDisposition(response.headers.get("Content-Disposition"), fallbackName);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (exportError) {
      setError(exportError?.message || "Failed to export attendance summary");
    } finally {
      setExporting("");
    }
  }

  function openImport() {
    /*
     * The filters on screen first, the academic calendar for whatever they
     * leave blank.
     *
     * That order is the point. A filter is something the reader chose a moment
     * ago while looking at it; the calendar is what the office set in August.
     * When both have an opinion the one in front of them wins — the calendar is
     * only answering the parts nobody has said anything about, which on a
     * freshly opened page is all three.
     *
     * Semester and periodical only, in effect: the school year seeded here is
     * replaced by the calendar's in importValues, because an import always
     * files under the calendar's school year.
     */
    setImportTerm(
      withCurrentTermDefaults(
        {
          semester_id: semesterId ? String(semesterId) : "",
          school_year_id: schoolYearId ? String(schoolYearId) : "",
          // The periodical on screen too, for the same reason: uploading the one you
          // are looking at is the common case.
          period: period && period !== PERIOD_TERM ? String(period) : "",
        },
        currentTerm
      )
    );
    setImportOpen(true);
  }

  async function handleImport(file, termValues) {
    if (!canImport) {
      throw new Error("You do not have permission to import attendance.");
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("semester_id", String(termValues.semester_id));
    formData.append("school_year_id", String(termValues.school_year_id));
    // Blank is meaningful and is sent as such: the backend files the rows as a
    // semester-total upload, which is how every import before 2026-08-21 behaved.
    formData.append("period", String(termValues.period ?? ""));

    const response = await fetch(getBackendUrl("attendance-import.php"), {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || "Failed to import attendance.");

    await loadSummary();
    return payload;
  }

  /**
   * What is already filed under the term picked in the dialog.
   *
   * Period defaults to PERIOD_TERM, not blank: blank means "the whole semester"
   * to the importer and "every periodical" to the summary query, so counting
   * with it would name P1, P2 and P3 rows this upload is not going to touch.
   */
  const importPrecheck = useCallback(
    async (_file, termValues = {}) => {
      const count = await countExisting("attendance-summary.php", {
        semester_id: termValues.semester_id,
        school_year_id: termValues.school_year_id,
        period: termValues.period || PERIOD_TERM,
      });

      return overwriteWarning({
        count,
        noun: "attendance record",
        termLabel: describeTerm([
          semesters.find((s) => String(s.semester_id) === String(termValues.semester_id))?.semester_name,
          schoolYears.find((y) => String(y.school_year_id) === String(termValues.school_year_id))?.schoolyear_name,
          periodLabel(termValues.period === "" || termValues.period === undefined ? null : termValues.period),
        ]),
      });
    },
    [schoolYears, semesters]
  );

  function clearFilters() {
    setSearch("");
    setSection("");
    setCourseId("");
    setDepartmentId("");
    setSemesterId("");
    setSchoolYearId("");
    setPeriod(PERIOD_ALL);
    setUploadId("");
    setSort("student_id");
    setDirection("asc");
    setPage(1);
  }

  const columns = useMemo(
    () => [
      {
        key: "student_id",
        label: sortLabel("student_id", "Student ID"),
        render: (row) => row.student_id || "-",
      },
      {
        key: "student_name",
        label: sortLabel("student_name", "Student Name"),
        render: (row) => row.student_name || "-",
      },
      {
        key: "total_classes_conducted",
        label: sortLabel("total_classes_conducted", "Total Classes Conducted"),
        render: (row) => formatNumber(row.total_classes_conducted),
      },
      {
        key: "present",
        label: sortLabel("present", "Present"),
        render: (row) => formatNumber(row.present),
      },
      {
        key: "absent",
        label: sortLabel("absent", "Absent"),
        render: (row) => formatNumber(row.absent),
      },
      {
        key: "present_percentage",
        label: sortLabel("present_percentage", "Present %"),
        render: (row) => formatPercent(row.present_percentage),
      },
      {
        key: "absent_percentage",
        label: sortLabel("absent_percentage", "Absent %"),
        render: (row) => formatPercent(row.absent_percentage),
      },
      /*
       * The periodical breakdown, on the Total view only.
       *
       * The period filter is applied to the join, so with P2 selected the P1
       * and P3 columns come back empty for everybody - two columns of dashes
       * that look like missing data rather than a narrowed query. On Total the
       * columns say what the figures to their left are made of, which is the
       * whole reason to show them.
       */
      ...(period === PERIOD_ALL
        ? [1, 2, 3].map((n) => ({
            key: `p${n}_rate`,
            label: sortLabel(`p${n}_rate`, `P${n} %`),
            render: (row) => <PeriodRate row={row} period={n} />,
          }))
        : []),
    ],
    [period, sortLabel]
  );

  const tableRows = useMemo(
    () => rows.map((row) => ({ ...row, id: row.student_record_id ?? row.student_id })),
    [rows]
  );

  /*
   * What the cards above the table are totalling.
   *
   * The figure changes meaning with the filter, so the card says which. On
   * Total it is the student's periodicals added up - or their whole-semester
   * row where no periodical has been recorded, which is the choice the query
   * makes per student. Saying "total" stops "713 classes" being read as one
   * periodical's worth.
   */
  const periodScopeLabel =
    period === PERIOD_ALL ? "total" : period === PERIOD_TERM ? "semester rows only" : periodLabel(period);

  const activeFilterCount = [
    search.trim(),
    section.trim(),
    courseId,
    departmentId,
    semesterId,
    schoolYearId,
    period,
    uploadId,
    pdoFilter,
  ].filter(Boolean).length;

  /*
   * What is currently narrowing the table, in words, each one removable.
   *
   * The panel below is shut most of the time, so without this the only way to
   * find out why a table looks short is to open the panel and read seven
   * dropdowns. A chip says "Course: BSIT" and takes one click to undo.
   *
   * Search and Period are deliberately absent: both are in the toolbar where
   * their own control already shows their value, and repeating them here would
   * be the same fact twice on one screen.
   */
  const filterChips = [
    { key: "section", label: "Section", value: section, onRemove: () => updateFilter(setSection, "") },
    { key: "department", label: "Department", value: departmentLabel, onRemove: () => updateFilter(setDepartmentId, "") },
    { key: "course", label: "Course", value: courseLabel, onRemove: () => updateFilter(setCourseId, "") },
    { key: "semester", label: "Semester", value: semesterLabel, onRemove: () => updateTermFilter(setSemesterId, "") },
    { key: "school_year", label: "School year", value: schoolYearLabel, onRemove: () => updateTermFilter(setSchoolYearId, "") },
    {
      key: "upload",
      label: "Upload",
      // The id only while the list is still loading, so the chip is never blank.
      value: uploadId ? uploadChipLabel(selectedUpload) || `#${uploadId}` : "",
      onRemove: () => updateFilter(setUploadId, ""),
    },
    {
      key: "pdo",
      label: "Drop-out risk",
      value: isPdoFiltered(pdoFilter) ? pdoFilterLabel(pdoFilter) : "",
      onRemove: () => updateFilter(setPdoFilter, PDO_FILTER_ALL),
    },
  ].filter((chip) => Boolean(chip.value));

  // The five fields the panel holds, in the order they narrow: who, then where
  // they study, then which term.
  const panelFields = [
    {
      key: "section",
      label: "Section",
      control: (
        <InputControl
          value={section}
          onChange={(event) => updateFilter(setSection, event.target.value)}
          placeholder="Any section"
          style={{ width: "100%" }}
          name="attendance_summary_section"
        />
      ),
    },
    {
      /* Department then course, the same chain the overview and the reports
         use. The course select used to be labelled "All programs" while
         listing departments, which put two course-sounding filters side by
         side with nothing to tell them apart. */
      key: "department",
      label: "Department",
      control: (
        <SelectControl
          value={departmentId}
          onChange={(event) => updateFilter(setDepartmentId, event.target.value)}
          style={{ width: "100%" }}
          name="attendance_summary_department"
        >
          <option value="">All departments</option>
          {departments.map((department) => (
            <option key={department.department_id} value={department.department_id}>
              {department.department_name || department.department_code || `Department ${department.department_id}`}
              {departmentCampusSuffix(department, departments)}
            </option>
          ))}
        </SelectControl>
      ),
    },
    {
      key: "course",
      label: "Course",
      hint: departmentLabel ? `Courses in ${departmentLabel}` : "",
      control: (
        <SelectControl
          value={courseId}
          onChange={(event) => updateFilter(setCourseId, event.target.value)}
          style={{ width: "100%" }}
          name="attendance_summary_course"
        >
          <option value="">{departmentLabel ? `All courses in ${departmentLabel}` : "All courses"}</option>
          {filteredCourses.map((course) => (
            <option key={course.course_id} value={course.course_id}>
              {course.course_code || course.course_name || `Course ${course.course_id}`}
              {/* Two campuses can offer the same code; a no-op once a
                  department is chosen, since that leaves one of them. */}
              {courseCampusSuffix(course, filteredCourses)}
            </option>
          ))}
        </SelectControl>
      ),
    },
    {
      key: "semester",
      label: "Semester",
      control: (
        <SelectControl
          value={semesterId}
          onChange={(event) => updateTermFilter(setSemesterId, event.target.value)}
          style={{ width: "100%" }}
          name="attendance_summary_semester"
        >
          <option value="">All semesters</option>
          {semesters.map((semester) => (
            <option key={semester.semester_id} value={semester.semester_id}>
              {semester.semester_name || `Semester ${semester.semester_id}`}
            </option>
          ))}
        </SelectControl>
      ),
    },
    {
      key: "school_year",
      label: "School year",
      control: (
        <SelectControl
          value={schoolYearId}
          onChange={(event) => updateTermFilter(setSchoolYearId, event.target.value)}
          style={{ width: "100%" }}
          name="attendance_summary_school_year"
        >
          <option value="">All school years</option>
          {schoolYears.map((schoolYear) => (
            <option key={schoolYear.school_year_id} value={schoolYear.school_year_id}>
              {schoolYear.schoolyear_name || `School Year ${schoolYear.school_year_id}`}
            </option>
          ))}
        </SelectControl>
      ),
    },
    {
      /* After the term, because an upload is filed under one: choosing it
         sets the three term filters to match. */
      key: "upload",
      label: "Upload",
      hint: uploads.length > 0 ? "Newest first. Choosing one sets the term to match it." : "No attendance uploaded yet",
      control: (
        <SelectControl
          value={uploadId}
          onChange={(event) => selectUpload(event.target.value)}
          style={{ width: "100%" }}
          name="attendance_summary_upload"
          aria-label="Upload"
        >
          <option value="">All uploads</option>
          {uploads.map((upload) => (
            <option key={upload.upload_id} value={upload.upload_id} title={uploadOptionTitle(upload)}>
              {uploadOptionLabel(upload)}
            </option>
          ))}
        </SelectControl>
      ),
    },
    {
      /* Last, because it narrows by a conclusion rather than by an attribute:
         the others ask where a student studies, this one asks what the PDO
         board already thinks of them. */
      key: "pdo",
      label: "Drop-out risk",
      hint: "Priority comes from grades, attendance and balance together",
      control: (
        <SelectControl
          value={pdoFilter}
          onChange={(event) => updateFilter(setPdoFilter, event.target.value)}
          style={{ width: "100%" }}
          name="attendance_summary_pdo"
        >
          {PDO_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </SelectControl>
      ),
    },
  ];

  return (
    <ManagementPage
      title="Attendance Management"
      subtitle="Student attendance summaries are calculated from attendance records on the backend."
      error={error}
      warning={lookupsLoading ? "Loading filter options..." : ""}
    >
      <div style={{ display: "grid", gap: 11 }}>
        <StatCardGrid minWidth={190}>
          <StatCard label="Total Students" value={formatNumber(stats.total_students)} />
          <StatCard label={`Total Classes Conducted (${periodScopeLabel})`} value={formatNumber(stats.total_classes_conducted)} />
          <StatCard label="Average Attendance Rate" value={formatPercent(stats.average_attendance_rate)} tone="success" />
          <StatCard label="Average Absence Rate" value={formatPercent(stats.average_absence_rate)} tone="danger" />
        </StatCardGrid>

        <ManagementTableCard
          title="Student Attendance Summary"
          columns={columns}
          rows={tableRows}
          loading={loading}
          emptyText="No attendance summary rows found."
          maxHeight="calc(100vh - 390px)"
          actions={
            /*
             * Six controls, not thirteen.
             *
             * Search stays because it is typed at constantly; the periodical
             * stays because it is the question this whole module is arranged
             * around, and burying the P1/P2/P3 switch would hide the control
             * people came for. The other seven are one click away in a labelled
             * panel, and what they are currently set to is on the chips below.
             */
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", width: "100%" }}>
              <InputControl
                value={search}
                onChange={(event) => updateFilter(setSearch, event.target.value)}
                placeholder="Search student ID or name"
                style={{ minWidth: 204, flex: "1 1 240px" }}
                name="attendance_summary_search"
              />
              {/* Attendance adds up across rows, so with no periodical chosen
                  the totals above already are the whole periodical. Picking one
                  narrows the same sum to that periodical. */}
              <SelectControl
                value={period}
                onChange={(event) => updateTermFilter(setPeriod, event.target.value)}
                style={{ minWidth: 158 }}
                name="attendance_summary_period"
                aria-label="Periodical"
              >
                {periodFilterOptions(periodBuckets).map((option) => (
                  <option key={option.value} value={option.value} title={option.title}>
                    {option.label}
                  </option>
                ))}
              </SelectControl>
              <Button
                variant={filterPanelOpen || filterChips.length > 0 ? "primary" : "secondary"}
                onClick={() => setFilterPanelOpen((current) => !current)}
                aria-expanded={filterPanelOpen}
                aria-haspopup="dialog"
              >
                {filterChips.length > 0 ? `Filters (${filterChips.length})` : "Filters"}
              </Button>
              <Button variant="secondary" onClick={() => void loadSummary()} disabled={loading}>
                Refresh
              </Button>
              {canImport ? (
                <Button variant="primary" onClick={openImport}>
                  <Icon name="upload" size={13} />
                  <span>Import</span>
                </Button>
              ) : null}
              {canExport ? (
                <ExportMenu
                  options={EXPORT_FORMATS}
                  busyKey={exporting}
                  onSelect={(format) => void downloadExport(format)}
                />
              ) : null}
            </div>
          }
          banner={
            /*
             * Positioned against this strip rather than the toolbar, so the
             * panel hangs below the bar instead of inside its scroll area.
             */
            <div style={{ position: "relative" }}>
              <AttendanceFilterPanel
                open={filterPanelOpen}
                onClose={() => setFilterPanelOpen(false)}
                onClear={clearFilters}
                activeCount={activeFilterCount}
                fields={panelFields}
              />

              {filterChips.length > 0 ? (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexWrap: "wrap",
                    padding: "7px 11px",
                    borderBottom: "1px solid var(--border-base)",
                    background: "var(--surface-page)",
                  }}
                >
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Showing</span>
                  {filterChips.map((chip) => (
                    <span
                      key={chip.key}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        gap: 5,
                        padding: "2px 4px 2px 8px",
                        borderRadius: 999,
                        fontSize: 11,
                        background: "var(--brand-100)",
                        color: "var(--brand-800)",
                      }}
                    >
                      {chip.label}: {chip.value}
                      <button
                        type="button"
                        onClick={chip.onRemove}
                        aria-label={`Remove the ${chip.label} filter`}
                        style={{
                          background: "transparent",
                          border: 0,
                          cursor: "pointer",
                          color: "inherit",
                          fontSize: 12.5,
                          lineHeight: 1,
                          padding: "0 3px",
                        }}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                  <button
                    type="button"
                    onClick={clearFilters}
                    style={{
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                      color: "var(--text-secondary)",
                      fontSize: 11,
                      textDecoration: "underline",
                    }}
                  >
                    Clear all
                  </button>
                </div>
              ) : null}
            </div>
          }
          footer={
            /* Rows per page sits with the pager it controls — the pager owns
               that select now, so this is just the pager. */
            <ManagementPagination
              page={page}
              limit={limit}
              total={total}
              onPageChange={setPage}
              onLimitChange={(size) => {
                setLimit(size);
                setPage(1);
              }}
              itemLabel="students"
            />
          }
        />
      </div>

      <ImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        title="Import Attendance"
        description="Each row is matched by Student ID. School year comes from Academic Calendar; choose the semester and periodical below. Percentages are recomputed from the counts."
        templateFileName="attendance-import-template.csv"
        columns={ATTENDANCE_IMPORT_COLUMNS}
        fields={[
          importSchoolYearField("school_year_id", currentTerm?.schoolyear_name),
          { key: "semester_id", label: "Semester", options: semesters.map((s) => ({ value: String(s.semester_id), label: s.semester_name || `Semester ${s.semester_id}` })) },
          { key: "period", label: "Periodical", required: false, placeholder: PERIOD_TERM_WRITE_LABEL, options: periodWriteOptions({ includeBlank: false }) },
        ]}
        values={importValues}
        closedNotice={closedTermNotice(closedTermFor(closedTerms, importValues.school_year_id, importValues.semester_id))}
        onFieldChange={(key, value) => setImportTerm((prev) => ({ ...prev, [key]: value }))}
        onSubmit={handleImport}
        precheck={importPrecheck}
        maxRows={SHEET_IMPORT_MAX_ROWS}
        summarize={(r) => [
          { label: "Rows read", value: formatNumber(r.summary?.rows_read) },
          { label: "New", value: formatNumber(r.summary?.inserted), tone: "good" },
          { label: "Updated", value: formatNumber(r.summary?.updated), tone: "good" },
          ...(Number(r.summary?.unmatched) > 0 ? [{ label: "ID not found", value: formatNumber(r.summary.unmatched), tone: "warn" }] : []),
          ...(Number(r.summary?.invalid) > 0 ? [{ label: "Invalid counts", value: formatNumber(r.summary.invalid), tone: "bad" }] : []),
          ...(Number(r.summary?.over_total) > 0 ? [{ label: "Over total", value: formatNumber(r.summary.over_total), tone: "bad" }] : []),
          ...(Number(r.summary?.warnings) > 0 ? [{ label: "Below total", value: formatNumber(r.summary.warnings), tone: "warn" }] : []),
          ...(Number(r.summary?.duplicates) > 0 ? [{ label: "Duplicate IDs", value: formatNumber(r.summary.duplicates), tone: "warn" }] : []),
        ]}
        detail={(r) => [
          { label: "Student IDs with no matching student", items: r.details?.unmatched_student_ids || [] },
          { label: "Rows with non-numeric counts", items: r.details?.invalid_student_ids || [] },
          { label: "Present + absent more than the total classes (not imported)", items: r.details?.over_total_rows || [], error: true },
          { label: "Present + absent less than the total (imported anyway)", items: r.details?.mismatch_warnings || [] },
          { label: "Student IDs listed more than once (last value kept)", items: r.details?.duplicate_student_ids || [] },
        ]}
        submitLabel="Upload & Import"
      />
    </ManagementPage>
  );
}
