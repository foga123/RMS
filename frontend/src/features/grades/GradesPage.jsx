import React, { useCallback, useEffect, useMemo, useState } from "react";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import { SkeletonTableRows } from "../../shared/components/ui/Skeleton";
import { StatCard, StatCardGrid } from "../../shared/components/ui/StatCard";
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
import ImportDialog from "../../shared/components/import/ImportDialog";
import { SHEET_IMPORT_MAX_ROWS, countExisting, describeTerm, overwriteWarning } from "../../shared/components/import/importPrecheck";
import { hasModulePermission } from "../../shared/lib/roleAccess";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import { remarkRiskLabel, remarkTone } from "../../shared/lib/remarkTone";
import { tone } from "../../shared/theme/tokens";
import ExportMenu from "../../shared/components/ui/ExportMenu";
import Button from "../../shared/components/ui/Button";
import Icon from "../../shared/components/ui/Icon";
import SectionHeader from "../../shared/components/ui/SectionHeader";
import { ManagementPagination } from "../../shared/components/management";
import { InputControl, SelectControl } from "../../shared/components/Form/Form";
import { TABLE_EXPORT_FORMATS, exportTable } from "../../shared/lib/tableExport";
import { fetchGradeRemarkPolicy, matchGradeRemarkRule } from "../../shared/lib/gradeRemarkPolicy";

/**
 * What an exported grades file holds: the table without its Action column.
 *
 * The full breakdown rather than a pass rate on its own — a Passed % with no
 * Total Subject beside it cannot be checked, and Incomplete, No Credit and No
 * Grade are three different reasons a subject has no mark that a single
 * "failed" count would flatten into one.
 */
/**
 * Rows per request while building an export file.
 *
 * Matches the ceiling grades.php enforces (`min(200, limit)`), so the walk
 * takes as few requests as the server allows. Asking for more does not fail —
 * it just silently returns 200, which is what made the first version of the
 * export write short files.
 */
const GRADES_EXPORT_PAGE_SIZE = 200;

const EXPORT_COLUMNS = [
  { key: "no", label: "No." },
  { key: "student_number", label: "Student No." },
  { key: "student_name", label: "Student Name" },
  { key: "period", label: "Periodical" },
  { key: "semester", label: "Semester" },
  { key: "school_year", label: "School Year" },
  { key: "total_subject", label: "Total Subject" },
  { key: "passed", label: "Passed" },
  { key: "failed", label: "Failed" },
  { key: "incomplete", label: "Incomplete" },
  { key: "no_credit", label: "No Credit" },
  { key: "no_grade", label: "No Grade" },
  { key: "passed_of_subject", label: "Passed %" },
  { key: "remarks", label: "Remarks" },
];

/*
 * The sticky header cell, which was the same eighteen-property style object
 * repeated once per column. Adding two columns meant pasting it twice more, and
 * a single divergent copy is invisible until the header scrolls.
 */
const HEAD_CELL = {
  position: "sticky",
  top: 0,
  // Brand-coloured so the header stands apart from the green/yellow/red rows.
  background: "var(--brand-700)",
  color: "#fff",
  fontWeight: 700,
  zIndex: 2,
  padding: 9,
  borderBottom: "1px solid var(--brand-800)",
  whiteSpace: "nowrap",
};

const BODY_CELL = { padding: 9, borderBottom: "1px solid var(--border-base)" };

function Th({ children, style }) {
  return <th style={style ? { ...HEAD_CELL, ...style } : HEAD_CELL}>{children}</th>;
}

function Td({ children, style }) {
  return <td style={style ? { ...BODY_CELL, ...style } : BODY_CELL}>{children}</td>;
}

const emptyForm = {
  grades_id: "",
  student_id: "",
  semester_id: "",
  school_year_id: "",
  total_subject: "",
  passed: "",
  failed: "",
  incomplete: "",
  no_credit: 0,
  no_grade: 0,
  passed_of_subject: "",
  remarks: "",
  // "" is a whole-term record, which is what every grade recorded before
  // 2026-08-21 is. It is a real answer, not an unfilled field.
  period: "",
};

/*
 * The columns before the optional Action column.
 *
 * Named rather than written as a literal in the two colSpan sites: those two
 * numbers were 12 and 13, and adding a column meant remembering to change both
 * or watching the "No grade records found" row sit short of the table edge.
 */
const COLUMN_COUNT = 14;

/**
 * "Last, First" - or something honest when the name is missing.
 *
 * The student number used to be glued onto the front of this. It now has its own
 * column, because the sheet asks for a name column and "02-0000-00111 - Alaba,
 * Francis" is not a name; it also could not be read or sorted as one.
 */
function studentDisplayName(row) {
  const last = String(row?.last_name || "").trim();
  const first = String(row?.first_name || "").trim();
  if (last && first) return `${last}, ${first}`;
  return last || first || "-";
}

/**
 * A summary figure as a readable number.
 *
 * SUM() comes back from PDO as a string, so these arrive as "2006" rather than
 * 2006 and would render without a thousands separator if passed straight
 * through.
 */
function formatCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toLocaleString() : "0";
}

/** The periodical a row belongs to, as a small tag. */
function PeriodTag({ period }) {
  const isTerm = period === null || period === undefined || period === "";
  return (
    <span
      title={isTerm ? "Recorded for the whole semester rather than a periodical" : undefined}
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: 11,
        whiteSpace: "nowrap",
        background: isTerm ? "var(--surface-page)" : "var(--brand-100)",
        color: isTerm ? "var(--text-muted)" : "var(--brand-800)",
        border: `1px solid ${isTerm ? "var(--border-base)" : "var(--brand-100)"}`,
      }}
    >
      {periodLabel(period)}
    </span>
  );
}

/**
 * The Remarks cell, coloured by the remark's own risk level.
 *
 * The remark was plain grey text in a row of fourteen numbers, so the one column
 * that says whether a student is in trouble read exactly like the ones counting
 * subjects. Colour puts it back where the eye lands first.
 *
 * The wording stays in the pill rather than being replaced by a colour, and the
 * risk level rides along in the tooltip: a table that encodes "at risk" as red
 * alone is unreadable to a colour-blind reader and prints as grey.
 */
function RemarkTag({ row }) {
  const label = row?.remarks;
  if (!label || label === "-") return <span style={{ color: "var(--text-muted)" }}>-</span>;

  const shade = tone(remarkTone(row));
  const risk = remarkRiskLabel(row);

  return (
    <span
      title={risk ? `${label} — ${risk}` : label}
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        whiteSpace: "nowrap",
        background: shade.bg,
        color: shade.text,
        border: `1px solid ${shade.border}`,
      }}
    >
      {label}
    </span>
  );
}

/*
 * The row background, by how many subjects were not passed: green for all
 * passed, yellow for one, red for two or more.
 *
 * The colour comes from the server (`grade_colour`), which takes it from the
 * same rule as the PDO board's grade chip, so a student is never green here and
 * yellow there. A row covering no subjects has no colour: nothing was graded.
 */
const GRADE_ROW_TONE = { green: "success", yellow: "warning", red: "danger" };

// The -100 step of each hue, so green reads as strongly as yellow and red: the
// success tone's own fill is the paler -50 and looked almost white on a row.
const GRADE_ROW_BG = { green: "var(--brand-100)", yellow: "var(--warning-100)", red: "var(--danger-100)" };

const GRADE_COLOUR_LABEL = {
  green: "All subjects passed",
  yellow: "1 subject not passed",
  red: "2 or more subjects not passed",
};

function gradeRowStyle(row) {
  const background = GRADE_ROW_BG[row?.grade_colour];
  return background ? { background } : undefined;
}

/** What the three row colours mean, said once above the table. */
function GradeColourLegend() {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 12px", padding: "6px 12px", fontSize: 11, color: "var(--text-secondary)", borderBottom: "1px solid var(--border-base)" }}>
      {Object.entries(GRADE_COLOUR_LABEL).map(([key, label]) => (
        <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span
            aria-hidden="true"
            style={{ width: 12, height: 12, borderRadius: 3, background: GRADE_ROW_BG[key], border: `1px solid ${tone(GRADE_ROW_TONE[key]).border}` }}
          />
          {label}
        </span>
      ))}
      <span style={{ color: "var(--text-muted)" }}>Not passed = failed, incomplete, no credit or no grade.</span>
    </div>
  );
}

/**
 * Names here must stay in step with gradeimport_header_map() in
 * grades-import.php. Only the student and the subject count are required —
 * Passed and Remarks are recomputed from the problem counts when left blank,
 * the same way the Add Grade form fills them in.
 */
const GRADE_IMPORT_COLUMNS = [
  { name: "Student ID", required: true, example: "REPLACE-WITH-STUDENT-NUMBER", hint: "Student number, or the numeric student ID" },
  { name: "Total Subject", required: true, example: "8", hint: "How many subjects were enrolled" },
  { name: "Passed", example: "", hint: "Left blank: calculated as Total minus the problem counts" },
  { name: "Failed", example: "1" },
  { name: "Incomplete", example: "0" },
  { name: "No Credit", example: "0" },
  { name: "No Grade", example: "0" },
  { name: "Remarks", example: "", hint: "Left blank: derived from the counts above" },
];

export default function GradesManagementPage({ permissions = [] }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [search, setSearch] = useState("");
  const [period, setPeriod] = useState(PERIOD_ALL);
  const [summary, setSummary] = useState(null);
  const [periodBuckets, setPeriodBuckets] = useState([]);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);

  const [students, setStudents] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [schoolYears, setSchoolYears] = useState([]);

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState(emptyForm);
  /*
   * The remark rules for the school year the form is on.
   *
   * Fetched rather than hardcoded, and re-fetched when the year changes, because
   * a policy is per-year: the same counts can imply different remarks in
   * 2026-2027 and 2027-2028, which is the point of the feature. Empty until it
   * arrives, and empty if it cannot be read, which shows no remark rather than
   * one from the wrong year.
   */
  const [policyRules, setPolicyRules] = useState([]);

  // ImportDialog owns the file, the progress state and the result summary; only
  // the target term lives here, because the dialog cannot know what a term is.
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

  const canCreate = hasModulePermission(permissions, "create");
  const canEdit = hasModulePermission(permissions, "edit");
  const canImport = hasModulePermission(permissions, "import") || canCreate;
  // Reading the table and saving it to a file are the same act; see the note on
  // FinancePage's canExport.
  const canExport = hasModulePermission(permissions, "export") || canEdit;
  const [exporting, setExporting] = useState("");
  /*
   * Grades are not archived here any more; students are, in Student Management.
   *
   * Archiving a grade row hid one term of one student's record while leaving
   * the student active everywhere else, so the reports and the risk score
   * silently disagreed with the grades page about the same person. A student
   * leaving is one decision about one record, and it now lives in exactly one
   * module. grades.php still honours ?archived=1 for rows archived before this,
   * so nothing already hidden was resurrected — there is simply no way to hide
   * another one from here.
   */
  const showActionColumn = canEdit;

  async function load() {
    // Stale answers are dropped rather than rendered. This runs again on every
    // filter change, so switching periodical while the previous request is in
    // flight would otherwise let the older reply land last. See useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (search.trim() !== "") params.set("search", search.trim());
      if (period !== PERIOD_ALL) params.set("period", period);

      const res = await fetch(getBackendUrl(`grades.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to load grades");
      if (!isCurrent()) return;
      setRows(Array.isArray(data?.data) ? data.data : []);
      setTotal(typeof data?.pagination?.total === "number" ? data.pagination.total : 0);
      setSummary(data?.summary || null);
      setPeriodBuckets(Array.isArray(data?.periods) ? data.periods : []);
    } catch (e) {
      if (!isCurrent()) return;
      setError(e.message || "Failed to load grades");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  /**
   * Every grade the filters left, as a file.
   *
   * Unlike Finance and Students, this page never has the whole set in hand:
   * `search` and `period` are applied by grades.php and
   * the table holds one page of twenty. So the export asks the endpoint again
   * for the same filters, and keeps asking until it has them all.
   *
   * ---------------------------------------------------------------------------
   * It asks page by page because one big ask does not work.
   *
   * grades.php clamps the page size: `min(200, limit)`. Requesting `limit=2352`
   * returns 200 rows and a pagination block that cheerfully reports
   * `total: 2352` — no error, no warning. The first version of this did exactly
   * that and would have written a 200-row file for a 2,352-row table, which is
   * the one way an export must never fail: silently, and looking complete.
   *
   * The cap is right and stays; this walks it instead. GRADES_EXPORT_PAGE_SIZE
   * matches the server's ceiling so the walk is as few requests as it can be.
   * ---------------------------------------------------------------------------
   */
  async function handleExport(format) {
    if (!canExport) return;

    setExporting(format);
    setError("");
    try {
      const all = [];
      let page = 1;
      let expected = Number.POSITIVE_INFINITY;

      while (all.length < expected) {
        const params = new URLSearchParams();
        params.set("page", String(page));
        params.set("limit", String(GRADES_EXPORT_PAGE_SIZE));
        if (search.trim() !== "") params.set("search", search.trim());
        if (period !== PERIOD_ALL) params.set("period", period);

        const res = await fetch(getBackendUrl(`grades.php?${params.toString()}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "Failed to export grades");

        const batch = Array.isArray(data?.data) ? data.data : [];
        all.push(...batch);

        // Re-read every time: a record can land between two of these requests,
        // and the count that matters is the one the server last reported.
        const reported = Number(data?.pagination?.total);
        if (Number.isFinite(reported)) expected = reported;

        /*
         * A short page means the end, whatever the total claims. Without this,
         * a total that disagrees with the rows on offer — a record deleted
         * mid-walk — spins forever.
         */
        if (batch.length < GRADES_EXPORT_PAGE_SIZE) break;
        page += 1;
      }

      const wrote = exportTable(format, {
        filename: "grades",
        sheet: "Grades",
        columns: EXPORT_COLUMNS,
        rows: all.map((r, index) => ({
          no: index + 1,
          student_number: r.student_number || `ID:${r.student_id}`,
          student_name: studentDisplayName(r),
          // The table shows this as a coloured tag; a spelled-out periodical is
          // what that tag stands for.
          period: periodLabel(r.period),
          semester: r.semester_name || r.semester_id || "-",
          school_year: r.schoolyear_name || r.school_year_id || "-",
          total_subject: r.total_subject ?? "-",
          passed: r.passed ?? "-",
          failed: r.failed ?? "-",
          incomplete: r.incomplete ?? "-",
          no_credit: r.no_credit ?? "-",
          no_grade: r.no_grade ?? "-",
          passed_of_subject: r.passed_of_subject ?? "-",
          remarks: r.remarks || "-",
        })),
      });
      if (!wrote) setError("There is nothing to export with these filters.");
    } catch (e) {
      setError(e.message || "Failed to export grades");
    } finally {
      setExporting("");
    }
  }

  async function loadLookups() {
    try {
      // School years are fetched for the import dialog, which writes one term at
      // a time. allSettled so a role without school_year access still gets the
      // students and semesters the rest of the page needs.
      const [studentsRes, semestersRes, schoolYearsRes] = await Promise.all([
        fetch(getBackendUrl("student.php?limit=1000"), { credentials: "include" }),
        fetch(getBackendUrl("semester.php?limit=200"), { credentials: "include" }),
        fetch(getBackendUrl("school_year.php?limit=200"), { credentials: "include" }).catch(() => null),
      ]);
      const studentsData = await studentsRes.json();
      const semestersData = await semestersRes.json();

      if (!studentsRes.ok) throw new Error(studentsData?.message || "Failed to load students");
      if (!semestersRes.ok) throw new Error(semestersData?.message || "Failed to load semesters");

      setStudents(Array.isArray(studentsData?.data) ? studentsData.data : []);
      setSemesters(Array.isArray(semestersData?.data) ? semestersData.data : []);

      if (schoolYearsRes?.ok) {
        const schoolYearsData = await schoolYearsRes.json();
        setSchoolYears(Array.isArray(schoolYearsData?.data) ? schoolYearsData.data : []);
      }
    } catch (e) {
      setError(e.message || "Failed to load options");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, limit, search, period]);

  // `load` is redefined every render; the hook keeps it in a ref, so passing it
  // directly is safe and always calls the latest closure.
  useLiveRefresh(["grades", "remarks"], load);

  useEffect(() => {
    loadLookups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /*
   * What the rollup is counting, said plainly.
   *
   * With no periodical chosen it is one reading per student across the whole
   * semester; with one chosen it is that periodical. Naming it avoids the card
   * reading "Students 308" beside a table showing 311 rows with no explanation
   * of why the two numbers differ.
   */
  const summaryHeading = useMemo(() => {
    if (period === PERIOD_ALL) return "Students (total)";
    // No option offers this any more; a bookmarked URL can still ask for it.
    if (period === PERIOD_TERM) return "Students (semester rows only)";
    return `Students (${periodLabel(period)})`;
  }, [period]);

  const studentLabelById = useMemo(() => {
    const map = {};
    students.forEach((s) => {
      map[String(s.student_id)] = `${s.student_number || `ID:${s.student_id}`} - ${s.last_name || ""}, ${s.first_name || ""}`;
    });
    return map;
  }, [students]);

  const studentById = useMemo(() => {
    const map = {};
    students.forEach((s) => {
      map[String(s.student_id)] = s;
    });
    return map;
  }, [students]);

  function toNumberOrNull(v) {
    if (v === "" || v === null || typeof v === "undefined") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  function toNonNegativeInt(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) return 0;
    return Math.floor(n);
  }

  /**
   * What is already filed under the term picked in the dialog.
   *
   * The period is deliberately defaulted to PERIOD_TERM rather than left blank.
   * Blank means "the whole semester" to the importer — it writes rows with a
   * NULL period — but blank means "every periodical" to the list query, so
   * counting with it would report P1, P2 and P3 as records this upload is about
   * to overwrite when it will not touch them.
   */
  const importPrecheck = useCallback(
    async (_file, termValues = {}) => {
      const period = termValues.period || PERIOD_TERM;
      const count = await countExisting("grades.php", {
        semester_id: termValues.semester_id,
        school_year_id: termValues.school_year_id,
        period,
      });

      return overwriteWarning({
        count,
        noun: "grade record",
        termLabel: describeTerm([
          semesters.find((s) => String(s.semester_id) === String(termValues.semester_id))?.semester_name,
          schoolYears.find((y) => String(y.school_year_id) === String(termValues.school_year_id))?.schoolyear_name,
          periodLabel(termValues.period === "" || termValues.period === undefined ? null : termValues.period),
        ]),
      });
    },
    [schoolYears, semesters]
  );

  async function handleImport(file, termValues) {
    if (!canImport) {
      throw new Error("You do not have permission to import grades.");
    }

    const formData = new FormData();
    formData.append("file", file);
    formData.append("semester_id", String(termValues.semester_id));
    formData.append("school_year_id", String(termValues.school_year_id));
    // Blank is meaningful and is sent as such: the backend files the rows as a
    // semester-total upload, which is how every import before 2026-08-21 behaved.
    formData.append("period", String(termValues.period ?? ""));

    const response = await fetch(getBackendUrl("grades-import.php"), {
      method: "POST",
      body: formData,
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || "Failed to import grades.");

    await load();
    return payload;
  }

  function withAutoComputedFields(nextForm) {
    const totalSubject = toNonNegativeInt(nextForm.total_subject);
    const failed = toNonNegativeInt(nextForm.failed);
    const incomplete = toNonNegativeInt(nextForm.incomplete);
    const noCredit = toNonNegativeInt(nextForm.no_credit);
    const noGrade = toNonNegativeInt(nextForm.no_grade);
    const deductions = failed + incomplete + noCredit + noGrade;
    const passed = Math.max(0, totalSubject - deductions);
    const passedPercent = totalSubject > 0 ? Number(((passed * 100) / totalSubject).toFixed(2)) : null;
    /*
     * The remark comes from the policy, not from a ladder written here.
     *
     * This used to be autoRemarkFromBreakdown(), a hardcoded copy of the same
     * ladder grades-import.php carried -- two implementations of a rule nobody
     * could change without editing both. Both are gone. What is left is a
     * preview of what the server will decide on save, evaluated from the rules
     * the server sent, so an edited policy moves this and the record together.
     *
     * An unreadable policy leaves `policyRules` empty, which shows no remark
     * rather than a stale guess. The server still assigns one on save.
     */
    const matched = matchGradeRemarkRule(
      {
        total_subject: totalSubject,
        passed,
        failed,
        incomplete,
        no_credit: noCredit,
        no_grade: noGrade,
      },
      policyRules
    );
    const remarks = matched?.remark_name || "";

    return {
      ...nextForm,
      passed: totalSubject > 0 || deductions > 0 ? String(passed) : "",
      passed_of_subject: passedPercent !== null ? String(passedPercent) : "",
      remarks,
    };
  }

  useEffect(() => {
    let cancelled = false;
    const yearId = form.school_year_id ? Number(form.school_year_id) : null;

    fetchGradeRemarkPolicy(yearId).then((policy) => {
      // A slow response for a year the form has since moved off would overwrite
      // the rules for the year it is on now.
      if (!cancelled) setPolicyRules(policy.rules);
    });

    return () => {
      cancelled = true;
    };
  }, [form.school_year_id]);

  function setFormWithAuto(updater) {
    setForm((prev) => {
      const next = typeof updater === "function" ? updater(prev) : { ...prev, ...updater };
      return withAutoComputedFields(next);
    });
  }

  async function save() {
    const isEdit = !!form.grades_id;
    if (isEdit && !canEdit) {
      setError("You do not have permission to edit grade records.");
      return;
    }
    if (!isEdit && !canCreate) {
      setError("You do not have permission to create grade records.");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const payload = {
        student_id: toNumberOrNull(form.student_id),
        semester_id: toNumberOrNull(form.semester_id),
        school_year_id: toNumberOrNull(form.school_year_id),
        total_subject: toNumberOrNull(form.total_subject),
        passed: toNumberOrNull(form.passed),
        failed: toNumberOrNull(form.failed),
        incomplete: toNumberOrNull(form.incomplete),
        no_credit: toNumberOrNull(form.no_credit),
        no_grade: toNumberOrNull(form.no_grade),
        passed_of_subject: toNumberOrNull(form.passed_of_subject),
        remarks: form.remarks && String(form.remarks).trim() !== "" ? String(form.remarks).trim() : null,
        // Sent as null rather than omitted, so clearing the periodical on an
        // existing record actually moves it back to a whole-term row.
        period: form.period === "" ? null : Number(form.period),
      };

      if (!payload.student_id) throw new Error("Student is required");
      if (!payload.semester_id) throw new Error("Semester is required");
      if (!payload.school_year_id) throw new Error("School year ID is required");
      if (payload.total_subject !== null && payload.total_subject < 0) throw new Error("Total Subject cannot be negative");
      if (payload.passed !== null && payload.passed < 0) throw new Error("Passed cannot be negative");
      if (payload.failed !== null && payload.failed < 0) throw new Error("Failed cannot be negative");
      if (payload.incomplete !== null && payload.incomplete < 0) throw new Error("Incomplete cannot be negative");
      if (payload.no_credit !== null && payload.no_credit < 0) throw new Error("No Credit cannot be negative");
      if (payload.no_grade !== null && payload.no_grade < 0) throw new Error("No Grade cannot be negative");

      const totalCount =
        (payload.passed || 0) +
        (payload.failed || 0) +
        (payload.incomplete || 0) +
        (payload.no_credit || 0) +
        (payload.no_grade || 0);
      if (payload.total_subject !== null && totalCount > payload.total_subject) {
        throw new Error("Passed + Failed + Incomplete + No Credit + No Grade cannot exceed Total Subject");
      }

      if (
        payload.passed_of_subject === null &&
          payload.total_subject !== null && payload.total_subject > 0 &&
          payload.passed !== null
      ) {
        payload.passed_of_subject = Number((((payload.passed * 100) / payload.total_subject).toFixed(2)));
      }

      const url = getBackendUrl("grades.php" + (isEdit ? `?id=${form.grades_id}` : ""));
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to save grade");

      setIsModalOpen(false);
      setForm(emptyForm);
      setSuccess(isEdit ? "Grade record updated" : "Grade record created");
      await load();
    } catch (e) {
      setError(e.message || "Failed to save grade");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Grades Management</h2>
      {/* One error on screen at a time. While the dialog is open it shows the
          failure itself, and this box sits behind the overlay saying the same
          sentence to nobody — so it stands down rather than duplicating it. */}
      <AlertMessage message={isModalOpen ? "" : error} tone="error" />
      <AlertMessage message={success} tone="success" />

      {/*
        The semester rollup, above the records it summarises.

        One reading per student, not a sum of the rows below: a student carries
        the same subjects at P1, P2 and P3, so adding the periodicals together
        would report three times the subjects anyone is enrolled in. The backend
        picks the whole-term row if there is one and the latest periodical
        otherwise — see the summary query in grades.php.
      */}
      {summary ? (
        <div style={{ marginBottom: 11 }}>
          <StatCardGrid minWidth={170}>
            <StatCard label={summaryHeading} value={formatCount(summary.student_records)} />
            <StatCard label="Total Subjects" value={formatCount(summary.total_subject)} />
            <StatCard label="Passed" value={formatCount(summary.passed)} tone="success" />
            <StatCard label="Failed" value={formatCount(summary.failed)} tone="danger" />
            <StatCard label="Pass Rate" value={`${Number(summary.passed_of_subject || 0).toFixed(2)}%`} tone="success" />
          </StatCardGrid>
        </div>
      ) : null}

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
        <SectionHeader
          title="All Grades"
          sticky
          actions={(
            <>
              <InputControl
                value={search}
                onChange={(e) => {
                  setPage(1);
                  setSearch(e.target.value);
                }}
                placeholder="Search student, semester, remarks..."
                style={{ minWidth: 240, flex: "1 1 240px" }}
                name="grades_manage_input_247"
              />
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>Periodical</span>
                <SelectControl
                  value={period}
                  onChange={(e) => {
                    setPeriod(e.target.value);
                    setPage(1);
                  }}
                  style={{ width: "auto", minWidth: 66, fontSize: 11.5, padding: "5px 6px" }}
                  name="grades_manage_period"
                >
                  {periodFilterOptions(periodBuckets).map((option) => (
                    <option key={option.value} value={option.value} title={option.title}>
                      {option.label}
                    </option>
                  ))}
                </SelectControl>
              </div>
              {/* Rows-per-page lives with the pager under the table, not here. */}
              {/* One entry point: the template now lives inside the dialog, next to
                  the column list it describes, instead of as a second toolbar button
                  whose purpose was not obvious until you had already guessed wrong. */}
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
                  onSelect={(format) => void handleExport(format)}
                />
              ) : null}
              {canCreate ? (
                <Button
                  onClick={() => {
                    setForm(withAutoComputedFields(emptyForm));
                    setError("");
                    setSuccess("");
                    setIsModalOpen(true);
                  }}
                >
                  <Icon name="plus" size={14} />
                  <span>Add Grade</span>
                </Button>
              ) : null}
            </>
          )}
        />

        <GradeColourLegend />

        <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--brand-700)", color: "#fff", textAlign: "left" }}>
                <Th>No.</Th>
                <Th>Student No.</Th>
                <Th>Student Name</Th>
                <Th>Periodical</Th>
                <Th>Semester</Th>
                <Th>School Year</Th>
                <Th>Total Subject</Th>
                <Th>Passed</Th>
                <Th>Failed</Th>
                <Th>Incomplete</Th>
                <Th>No Credit</Th>
                <Th>No Grade</Th>
                <Th>Passed %</Th>
                <Th>Remarks</Th>
                {showActionColumn ? <Th>Action</Th> : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows columns={showActionColumn ? COLUMN_COUNT + 1 : COLUMN_COUNT} />
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={showActionColumn ? COLUMN_COUNT + 1 : COLUMN_COUNT} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                    No grade records found
                  </td>
                </tr>
              ) : (
                rows.map((r, idx) => {
                  const studentName = studentDisplayName(r);
                  return (
                    <tr key={r.grades_id} style={gradeRowStyle(r)} title={GRADE_COLOUR_LABEL[r.grade_colour]}>
                      <Td>{(page - 1) * limit + idx + 1}</Td>
                      <Td>{r.student_number || `ID:${r.student_id}`}</Td>
                      <Td>{studentName}</Td>
                      <Td><PeriodTag period={r.period} /></Td>
                      <Td>{r.semester_name || r.semester_id || "-"}</Td>
                      <Td>{r.schoolyear_name || r.school_year_id || "-"}</Td>
                      <Td>{r.total_subject ?? "-"}</Td>
                      <Td>{r.passed ?? "-"}</Td>
                      <Td>{r.failed ?? "-"}</Td>
                      <Td>{r.incomplete ?? "-"}</Td>
                      <Td>{r.no_credit ?? "-"}</Td>
                      <Td>{r.no_grade ?? "-"}</Td>
                      <Td>{r.passed_of_subject ?? "-"}</Td>
                      <Td><RemarkTag row={r} /></Td>
                      {showActionColumn ? (
                        <Td>
                          {canEdit ? (
                            <Button
                              size="sm"
                              style={{ background: "var(--info-500)", borderColor: "var(--info-500)", color: "var(--surface-base)" }}
                              onClick={() => {
                                setForm(withAutoComputedFields({
                                  grades_id: r.grades_id,
                                  student_id: r.student_id != null ? String(r.student_id) : "",
                                  semester_id: r.semester_id != null ? String(r.semester_id) : "",
                                  school_year_id: r.school_year_id != null ? String(r.school_year_id) : "",
                                  total_subject: r.total_subject != null ? String(r.total_subject) : "",
                                  passed: r.passed != null ? String(r.passed) : "",
                                  failed: r.failed != null ? String(r.failed) : "",
                                  incomplete: r.incomplete != null ? String(r.incomplete) : "",
                                  no_credit: r.no_credit != null ? String(r.no_credit) : "0",
                                  no_grade: r.no_grade != null ? String(r.no_grade) : "0",
                                  passed_of_subject: r.passed_of_subject != null ? String(r.passed_of_subject) : "",
                                  remarks: r.remarks || "",
                                  period: r.period != null ? String(r.period) : "",
                                }));
                                setError("");
                                setSuccess("");
                                setIsModalOpen(true);
                              }}
                            >
                              Edit
                            </Button>
                          ) : null}
                        </Td>
                      ) : null}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div style={{ padding: 9, borderTop: "1px solid var(--border-base)" }}>
          <ManagementPagination
            page={page}
            limit={limit}
            total={total}
            onPageChange={setPage}
            onLimitChange={(size) => {
              setLimit(size);
              setPage(1);
            }}
            itemLabel="grade records"
          />
        </div>
      </div>

      <ImportDialog
        open={importOpen && canImport}
        onClose={() => setImportOpen(false)}
        title="Import Grades"
        description="School year comes from Academic Calendar. Choose the semester and periodical below. Matching records are updated rather than duplicated."
        templateFileName="grades-import-template.csv"
        columns={GRADE_IMPORT_COLUMNS}
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
          ...(r.summary?.over_total ? [{ label: "Over total", value: r.summary.over_total, tone: "bad" }] : []),
          ...(r.summary?.warnings ? [{ label: "Below total", value: r.summary.warnings, tone: "warn" }] : []),
          ...(r.summary?.skipped_out_of_scope
            ? [{ label: "Out of scope", value: r.summary.skipped_out_of_scope, tone: "warn" }]
            : []),
        ]}
        detail={(r) => [
          { label: "Student IDs with no matching student", items: r.details?.unmatched_student_ids || [] },
          { label: "Rows with invalid numbers", items: r.details?.invalid_student_ids || [] },
          { label: "Counts more than the student's total subjects (not imported)", items: r.details?.over_total_rows || [], error: true },
          { label: "Counts that add up to less than the total (imported anyway)", items: r.details?.mismatch_warnings || [] },
          { label: "Student IDs listed more than once", items: r.details?.duplicate_student_ids || [] },
        ]}
      />

      {isModalOpen && (canCreate || canEdit) ? (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }}
          onClick={() => setIsModalOpen(false)}
        >
          <div
            style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 731, maxHeight: "85vh", overflow: "auto", border: "1px solid var(--border-base)", boxShadow: "0 12px 24px rgba(2,6,23,0.12)", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--text-primary)" }}>{form.grades_id ? "Edit Grade" : "Add Grade"}</strong>
              <Button variant="ghost" size="sm" onClick={() => setIsModalOpen(false)} aria-label="Close">
                <Icon name="close" size={15} />
              </Button>
            </div>
            {/* Inside the dialog, because this is where the action was taken. The
                page-level box below is painted UNDER this overlay, so a save the
                server refuses used to look like nothing happening at all. */}
            {error ? (
              <div style={{ flexShrink: 0, padding: "9px 12px 0" }}>
                <AlertMessage message={error} tone="error" style={{ marginBottom: 0 }} />
              </div>
            ) : null}

            <div style={{ padding: 12, display: "grid", gap: 9, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))" }}>
              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Student</label>
                <select
                  value={String(form.student_id || "")}
                  onChange={(e) => {
                    const nextStudentId = e.target.value;
                    const picked = studentById[String(nextStudentId)];
                    setFormWithAuto((f) => ({
                      ...f,
                      student_id: nextStudentId,
                      school_year_id:
                        String(f.school_year_id || "").trim() !== ""
                          ? f.school_year_id
                          : picked?.schoolyear_id != null
                            ? String(picked.schoolyear_id)
                            : f.school_year_id,
                    }));
                  }}
                  style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                  name="grades_manage_select_413"
                >
                  <option value="">Select student</option>
                  {students.map((s) => (
                    <option key={s.student_id} value={s.student_id}>
                      {studentLabelById[String(s.student_id)]}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Semester</label>
                <select value={String(form.semester_id || "")} onChange={(e) => setFormWithAuto((f) => ({ ...f, semester_id: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="grades_manage_select_425">
                  <option value="">Select semester</option>
                  {semesters.map((s) => (
                    <option key={s.semester_id} value={s.semester_id}>
                      {s.semester_name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>School Year ID</label>
                <input type="number" value={String(form.school_year_id || "")} onChange={(e) => setFormWithAuto((f) => ({ ...f, school_year_id: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }} placeholder="e.g. 1"  name="grades_manage_input_437"/>
                {String(form.student_id || "").trim() !== "" && studentById[String(form.student_id)]?.schoolyear_id != null ? (
                  <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-muted)" }}>
                    Student default school year: {studentById[String(form.student_id)].schoolyear_id}
                  </div>
                ) : null}
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Periodical</label>
                <select
                  value={String(form.period ?? "")}
                  onChange={(e) => setFormWithAuto((f) => ({ ...f, period: e.target.value }))}
                  style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                  name="grades_manage_period_field"
                >
                  {periodWriteOptions().map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Total Subject</label>
                <input type="number" value={String(form.total_subject || "")} onChange={(e) => setFormWithAuto((f) => ({ ...f, total_subject: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}  name="grades_manage_input_442"/>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Passed</label>
                <input type="number" value={String(form.passed ?? "")} readOnly style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-page)", color: "var(--neutral-700)" }} name="grades_manage_input_447"/>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Failed</label>
                <input type="number" value={String(form.failed || "")} onChange={(e) => setFormWithAuto((f) => ({ ...f, failed: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}  name="grades_manage_input_452"/>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Incomplete</label>
                <input type="number" value={String(form.incomplete || "")} onChange={(e) => setFormWithAuto((f) => ({ ...f, incomplete: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}  name="grades_manage_input_457"/>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>No Credit</label>
                <input type="number" value={String(form.no_credit ?? "")} onChange={(e) => setFormWithAuto((f) => ({ ...f, no_credit: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}  name="grades_manage_input_462"/>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>No Grade</label>
                <input type="number" value={String(form.no_grade ?? "")} onChange={(e) => setFormWithAuto((f) => ({ ...f, no_grade: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}  name="grades_manage_input_467"/>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Passed of Subject (%)</label>
                <input type="number" step="0.01" value={String(form.passed_of_subject ?? "")} readOnly style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-page)", color: "var(--neutral-700)" }}  name="grades_manage_input_472"/>
              </div>

              <div style={{ gridColumn: "1 / -1" }}>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Remarks</label>
                {/* Read-only and derived from the counts above, so it changes as
                    they are typed — and now changes colour with them, which is
                    the fastest way to see that entering one more failed subject
                    just moved this student from Regular Standing to a problem. */}
                <textarea
                  value={form.remarks || ""}
                  readOnly
                  rows={3}
                  style={{
                    width: "100%",
                    padding: "6px 8px",
                    borderRadius: 5,
                    boxSizing: "border-box",
                    fontWeight: form.remarks ? 600 : 400,
                    border: `1px solid ${form.remarks ? tone(remarkTone(form)).border : "var(--border-base)"}`,
                    background: form.remarks ? tone(remarkTone(form)).bg : "var(--surface-page)",
                    color: form.remarks ? tone(remarkTone(form)).text : "var(--neutral-700)",
                  }}
                  name="grades_manage_textarea_477"
                />
              </div>
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
