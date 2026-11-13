import React, { useCallback, useEffect, useMemo, useState } from "react";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import ActionMenu from "../../shared/components/ui/ActionMenu";
import { SkeletonTableRows } from "../../shared/components/ui/Skeleton";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import ImportDialog from "../../shared/components/import/ImportDialog";
import { countExisting, describeTerm, overwriteWarning, perRowRequestNotice } from "../../shared/components/import/importPrecheck";
import { confirmAction } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import { parseSpreadsheetRows } from "../../shared/lib/spreadsheet";
import { localDateIso } from "../../shared/lib/localDate";
import { resolveSchoolYearId } from "../../shared/lib/schoolYears";
import {
  closedTermForYearName,
  closedTermNotice,
  currentTermSchoolYearName,
  importSchoolYearField,
  useCurrentTerm,
} from "../../shared/lib/currentTerm";
import usePagedRows from "../../shared/hooks/usePagedRows";
import Pagination from "../../shared/components/ui/Pagination";
import SectionHeader from "../../shared/components/ui/SectionHeader";


function trimToNull(value) {
  const text = String(value ?? "").trim();
  return text === "" ? null : text;
}

function firstNonEmptyValue(record, keys) {
  for (const key of keys) {
    const value = trimToNull(record?.[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Loose match on a status name: "not enrolled", "Not Enrolled", "NOT_ENROLLED". */
function statusKey(value) {
  return String(value ?? "").trim().toLowerCase().replace(/[\s_-]+/g, " ");
}

/**
 * The Enrolled standing, as the `status` table numbers it.
 *
 * This module lists enrolled students and nothing else, so this is the rule
 * rather than a default. The id is the seeded one, used until status.php comes
 * back with the row that carries the name - after which the id is read from
 * there, so a reseeded database with a different id still resolves.
 */
const ENROLLED_STATUS_ID = "3";
const ENROLLED_STATUS_NAME = "enrolled";

export default function EnrollmentStatusManagementPage({ permissions = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [termFilter, setTermFilter] = useState({ school_year_id: "", semester_id: "" });
  const [viewMode, setViewMode] = useState("active");
  const [students, setStudents] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [schoolYears, setSchoolYears] = useState([]);
  const [statusOptions, setStatusOptions] = useState([]);
  const [importOpen, setImportOpen] = useState(false);
  /**
   * The semester an imported file is filed under. The
   * school year is not held here: it is always the calendar's (importValues).
   */
  const [importTerm, setImportTerm] = useState({
    semester_id: "",
  });
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canImport = hasPermissionContext ? (canModuleAction(permissions, "import") || canModuleAction(permissions, "create")) && canModuleAction(permissions, "edit") : true;
  const canArchive = hasPermissionContext ? canModuleAction(permissions, "archive") : true;
  const canRestore = hasPermissionContext ? canModuleAction(permissions, "restore") : true;

  /**
   * Students keyed by id, so a row resolves its student in one lookup rather
   * than scanning the whole list. The table did `students.find(...)` per row,
   * which is fine at six students and quadratic at six hundred.
   */
  const studentById = useMemo(() => {
    const map = new Map();
    students.forEach((student) => map.set(String(student.student_id), student));
    return map;
  }, [students]);

  /** Number and name as two separate values, since they are now two columns. */
  const studentParts = useCallback(
    (studentId) => {
      const student = studentById.get(String(studentId));
      /*
       * A student the list does not cover - archived, or outside a dean's
       * department - used to render as a bare "637" under a heading reading
       * Student Number. A row id is not a student number and looks exactly like
       * one when it stands alone, so it is labelled rather than shown plain.
       */
      if (!student) return { number: `ID:${studentId ?? "?"}`, name: "Not in your student list" };
      const name = [student.last_name, student.first_name].filter(Boolean).join(", ");
      return {
        number: student.student_number || `ID:${student.student_id}`,
        name: name || "-",
      };
    },
    [studentById]
  );

  const filtered = useMemo(() => {
    /*
     * Rows whose student this viewer cannot see are dropped, not labelled.
     *
     * They used to render as "ID:345 - Not in your student list": a three-digit
     * row id sitting under a Student Number heading, naming a student the
     * reader is not allowed to open. That is noise in every column of the row,
     * and it inflates the count at the top of the page with entries nobody can
     * act on.
     *
     * Guarded on the map being populated, because the students list and the
     * status list arrive from two requests — filtering against an empty map
     * mid-load would blank the table and then refill it.
     */
    let list = studentById.size > 0
      ? rows.filter((row) => studentById.has(String(row.student_id)))
      : rows;
    const q = search.trim().toLowerCase();
    if (!q) return list;
    return list.filter((row) => {
      // The name is a column of its own now, so it has to be searchable - a
      // visible column that search ignores reads as a broken search box.
      const { name } = studentParts(row.student_id);
      return (
        String(row.student_number || row.student_id || "").toLowerCase().includes(q) ||
        name.toLowerCase().includes(q) ||
        String(row.decision || "").toLowerCase().includes(q) ||
        String(row.response || "").toLowerCase().includes(q) ||
        String(row.reason || "").toLowerCase().includes(q)
      );
    });
  }, [rows, search, studentById, studentParts]);

  /*
   * This table was the one list in the portal with no paging at all: it loads
   * every enrollment record and drew all of them, so a full term rendered as one
   * unbroken scroll with no way to tell how many rows there were.
   */
  const pagedRows = usePagedRows(filtered, 20);

  /*
   * The Enrolled row's id, from the status list the page already loads.
   *
   * Matched on the name rather than trusting the seeded id outright, because a
   * database restored from a different seed can number the statuses differently
   * and a hardcoded 3 would then quietly list somebody else's standing. The
   * seeded id is the fallback for the first paint and for a role that cannot
   * read status.php at all.
   */
  const enrolledStatusId = useMemo(() => {
    const match = statusOptions.find(
      (option) => String(option.status_name ?? "").trim().toLowerCase() === ENROLLED_STATUS_NAME
    );
    return match ? String(match.status_id) : ENROLLED_STATUS_ID;
  }, [statusOptions]);

  const termLabel = useMemo(() => {
    const year = schoolYears.find((row) => String(row.school_year_id) === String(termFilter.school_year_id));
    const semester = semesters.find((row) => String(row.semester_id) === String(termFilter.semester_id));
    const parts = [year?.schoolyear_name, semester?.semester_name].filter(Boolean);
    return parts.length > 0 ? parts.join(" · ") : "All terms";
  }, [termFilter, schoolYears, semesters]);

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (viewMode === "archived") params.set("archived", "1");
      /*
       * Filtered on the server, not in the browser.
       *
       * The list is paged at 200 rows, so a client-side filter reads "the
       * enrolled students among the most recent 200 records" and calls it "the
       * enrolled students" - a number that silently stops being true as the
       * table grows.
       */
      params.set("status_type", enrolledStatusId);
      if (termFilter.school_year_id) params.set("school_year_id", String(termFilter.school_year_id));
      if (termFilter.semester_id) params.set("semester_id", String(termFilter.semester_id));
      const query = params.toString();
      const res = await fetch(getBackendUrl(`enrollment_status.php${query ? `?${query}` : ""}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to load records");
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      if (!isCurrent()) return;
      setRows(arr);
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setError(e.message || "Failed to load records");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, enrolledStatusId, termFilter.school_year_id, termFilter.semester_id, viewMode]);

  useLiveRefresh(["enrollment_status"], load);

  const loadStudents = useCallback(async () => {
    try {
      const res = await fetch(getBackendUrl("student.php?limit=1000"));
      const data = await res.json();
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      setStudents(arr);
    } catch (_) {
      setStudents([]);
    }
  }, []);

  /**
   * Semester and school year were typed in as raw integers. Nothing on screen
   * said which number meant which term, so the only way to fill the form
   * correctly was to already know the primary keys — and a wrong-but-valid id
   * filed the record against the wrong term with no error at all.
   */
  const loadTerms = useCallback(async () => {
    const readList = async (path) => {
      try {
        const res = await fetch(getBackendUrl(path));
        if (!res.ok) return [];
        const data = await res.json();
        return Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      } catch (_) {
        return [];
      }
    };

    const [semesterRows, schoolYearRows, statusRows] = await Promise.all([
      readList("semester.php?limit=200"),
      readList("school_year.php?limit=500"),
      readList("status.php?status_type=enrollment&limit=200"),
    ]);
    setSemesters(semesterRows);
    setSchoolYears(schoolYearRows);
    // A fallback so the form is never unusable if the status list cannot be
    // read (a role without statuses:view, for instance). Ids 3 and 5 kept their
    // rows when the list was replaced on 2026-10-06 (latest.xlsx); 5 was renamed
    // Will Enroll -> Will Continue, and Not Enrolled (4) was retired.
    setStatusOptions(
      statusRows.length > 0
        ? statusRows
        : [
            { status_id: 3, status_name: "Enrolled", fallback: true },
            { status_id: 5, status_name: "Will Continue", fallback: true },
          ]
    );
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadStudents();
    void loadTerms();
  }, [loadStudents, loadTerms]);

  /* ---- import ------------------------------------------------------------
   * A term's standings, from the registrar's list.
   *
   * This is what makes the migration board's "against last term" column mean
   * anything: it counts enrollment_status rows per school year and semester, so
   * a term nobody has recorded compares against zero. Entering a few hundred by
   * hand is replaced by importing the enrolled student list.
   */
  const studentIdByNumber = useMemo(() => {
    const map = new Map();
    students.forEach((row) => {
      const number = String(row?.student_number ?? "").trim().toLowerCase();
      if (number !== "") map.set(number, Number(row.student_id));
    });
    return map;
  }, [students]);

  /*
   * The school year every import files under: the Academic Calendar's, by name.
   * Held as a name because the handler resolves it with resolveSchoolYearId(),
   * which creates the year's row if it has none yet.
   */
  const { term: currentTerm, closedTerms } = useCurrentTerm();
  const importSchoolYear = currentTermSchoolYearName(currentTerm);
  const importValues = useMemo(() => ({ ...importTerm, school_year: importSchoolYear }), [importTerm, importSchoolYear]);

  const importFields = useMemo(
    () => [
      importSchoolYearField("school_year", importSchoolYear),
      { key: "semester_id", label: "Semester", placeholder: "Select semester", options: semesters.map((row) => ({ value: String(row.semester_id), label: row.semester_name || `Semester ${row.semester_id}` })) },
    ],
    [importSchoolYear, semesters]
  );

  /*
   * Sensible defaults: the semester the Academic Calendar says the school is
   * in. Imported students always receive the Enrolled standing.
   *
   * The semester is seeded because this dialog refuses to upload without one,
   * so leaving it blank meant the one field the calendar could always answer
   * was the one the reader had to fill in every time.
   */
  useEffect(() => {
    setImportTerm((prev) => {
      if (prev.semester_id !== "") return prev;
      return {
        ...prev,
        semester_id: prev.semester_id
          || (currentTerm?.semester_id != null ? String(currentTerm.semester_id) : ""),
      };
    });
  }, [currentTerm]);

  const importColumns = useMemo(
    () => [
      { name: "student_number", required: true, example: students[0]?.student_number || "BSIT-2025-001" },
      {
        name: "status",
        example: "Enrolled",
        hint: "Optional; only Enrolled is accepted. Blank defaults to Enrolled.",
      },
      { name: "reason", example: "", hint: "Free text, kept against the record" },
    ],
    [students]
  );

  /**
   * What this term already holds, before matching standings are updated.
   *
   * The school year is matched against the years that exist rather than being
   * resolved through resolveSchoolYearId, which CREATES the year when it is
   * missing. A check is not allowed to write; and a year that does not exist yet
   * cannot be holding standings, so "not found" is already the answer.
   */
  const importPrecheck = useCallback(
    async (_file, termValues = {}) => {
      const schoolYear = schoolYears.find(
        (year) => String(year.schoolyear_name).trim() === String(termValues.school_year).trim()
      );
      if (!schoolYear) return null;

      const count = await countExisting("enrollment_status.php", {
        school_year_id: schoolYear.school_year_id,
        semester_id: termValues.semester_id,
      });

      return overwriteWarning({
        count,
        noun: "standing",
        termLabel: describeTerm([
          semesters.find((s) => String(s.semester_id) === String(termValues.semester_id))?.semester_name,
          schoolYear.schoolyear_name,
        ]),
      });
    },
    [schoolYears, semesters]
  );

  const handleImport = useCallback(
    async (file, termValues = {}) => {
      if (!canImport) throw new Error("You do not have permission to import enrollment statuses.");
      if (!termValues.school_year) throw new Error("Choose the school year this file belongs to.");
      if (!termValues.semester_id) throw new Error("Choose the semester this file belongs to.");
      if (!statusOptions.some((row) => statusKey(row.status_name) === ENROLLED_STATUS_NAME)) throw new Error("The Enrolled status is unavailable. Check Settings.");

      // Resolved once, before anything is written, and created if this is the
      // year's first use — so a bad year fails the run rather than half of it.
      const schoolYearId = await resolveSchoolYearId(termValues.school_year, schoolYears, {
        buildUrl: getBackendUrl,
      });
      const semesterId = Number(termValues.semester_id);
      const defaultStatusId = Number(enrolledStatusId);

      const parsedRows = parseSpreadsheetRows(await file.text(), file.name);
      if (parsedRows.length === 0) {
        throw new Error("No rows found. Add a header row and at least one student.");
      }

      const rowErrors = [];
      const valid = [];
      const seen = new Set();

      parsedRows.forEach(({ lineNumber, values }) => {
        try {
          const number = firstNonEmptyValue(values, ["student_number", "student_no", "studentid", "student_id"]);
          if (!number) throw new Error("student_number is required");

          const key = number.trim().toLowerCase();
          const studentId = studentIdByNumber.get(key);
          if (!studentId) throw new Error(`no student with number "${number}"`);
          if (seen.has(key)) throw new Error(`duplicate student number "${number}" in file`);

          const statusText = firstNonEmptyValue(values, ["status", "enrollment_status", "standing"]);
          if (statusText && statusKey(statusText) !== ENROLLED_STATUS_NAME) {
            throw new Error(`Only Enrolled status can be imported; received "${statusText}"`);
          }
          const statusId = defaultStatusId;

          seen.add(key);
          valid.push({
            lineNumber,
            payload: {
              import: true,
              student_id: studentId,
              status_type: statusId,
              school_year_id: schoolYearId,
              semester_id: semesterId,
              date: localDateIso(),
              reason: firstNonEmptyValue(values, ["reason", "remarks", "note"]),
            },
          });
        } catch (rowError) {
          rowErrors.push(`Line ${lineNumber}: ${rowError?.message || "invalid row"}`);
        }
      });

      let saved = 0;
      const failed = [];
      let closedMessage = "";
      let closedAtLine = null;
      for (const row of valid) {
        try {
          const res = await fetch(getBackendUrl("enrollment_status.php"), {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            credentials: "include",
            body: JSON.stringify(row.payload),
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok) {
            // Every row is filed under the one semester chosen above, so one
            // closed-semester refusal answers for all of them. Stop rather
            // than send the rest to be refused one by one.
            if (json?.code === "TERM_CLOSED") {
              closedMessage = json?.message || "That semester is closed.";
              closedAtLine = row.lineNumber;
              break;
            }
            throw new Error(json?.message || "Failed to save");
          }
          saved += 1;
        } catch (saveError) {
          failed.push(`Line ${row.lineNumber}: ${saveError?.message || "Failed to save"}`);
        }
      }

      if (closedMessage && saved === 0) throw new Error(closedMessage);
      if (closedMessage) failed.push(`Line ${closedAtLine} onward: ${closedMessage} Those rows were not sent.`);

      if (saved > 0) await load();

      const semesterName = semesters.find((s) => Number(s.semester_id) === semesterId)?.semester_name || "";
      return {
        message:
          saved > 0
            ? `${saved} standing${saved === 1 ? "" : "s"} recorded for ${termValues.school_year}${semesterName ? ` · ${semesterName}` : ""}.`
            : "Nothing was recorded.",
        summary: {
          rows_read: parsedRows.length,
          saved,
          skipped: rowErrors.length,
          failed: failed.length,
        },
        details: { row_errors: rowErrors, failed_rows: failed },
      };
    },
    [canImport, load, schoolYears, semesters, enrolledStatusId, statusOptions, studentIdByNumber]
  );

  async function remove(id) {
    if (!canArchive) {
      setError("No permission for this action.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Archive record?",
      text: "Archive this record?",
      confirmButtonText: "Archive",
    });
    if (!confirmed) return;
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl(`enrollment_status.php?id=${id}&permission_action=archive`), { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to archive record");
      setSuccess("Record archived");
      await load();
    } catch (e) {
      setError(e.message || "Failed to archive record");
    }
  }

  async function restore(id) {
    if (!canRestore) {
      setError("No permission for this action.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Restore record?",
      text: "Restore this archived enrollment status record?",
      confirmButtonText: "Restore",
      confirmButtonColor: "var(--brand-600)",
    });
    if (!confirmed) return;
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl(`enrollment_status.php?id=${id}&permission_action=restore`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to restore record");
      setSuccess("Record restored");
      await load();
    } catch (e) {
      setError(e.message || "Failed to restore record");
    }
  }

  const statusLabel = (id) => {
    // Only reached when a row arrives without its status_name. Not Enrolled is
    // retired but stays here: records filed under it keep that name.
    const map = {
      3: "Enrolled",
      4: "Not Enrolled",
      5: "Will Continue",
    };
    if (id == null || id === "") return "-";
    const parsed = Number(id);
    return Number.isFinite(parsed) && map[parsed] ? map[parsed] : String(id);
  };

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Enrollment Status</h2>
      <AlertMessage message={error} tone="error" />
      <AlertMessage message={success} tone="success" />

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        {/* The heading names what is actually on screen. "All Enrollment
            Status" over a list of enrolled students in one term is the kind of
            label a reader takes at face value and then miscounts from. */}
        <SectionHeader sticky
          title={
            viewMode === "archived"
              ? "Archived Enrollment Status"
              : `Enrolled Students · ${termLabel}`
          }
        >
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="enrollment_status_manage_input_177" />

            <select
              value={termFilter.school_year_id}
              onChange={(e) => setTermFilter((prev) => ({ ...prev, school_year_id: e.target.value }))}
              style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }}
              name="enrollment_status_school_year_filter"
              aria-label="School year"
            >
              <option value="">All school years</option>
              {schoolYears.map((row) => (
                <option key={row.school_year_id} value={String(row.school_year_id)}>
                  {row.schoolyear_name || `SY ${row.school_year_id}`}
                </option>
              ))}
            </select>
            <select
              value={termFilter.semester_id}
              onChange={(e) => setTermFilter((prev) => ({ ...prev, semester_id: e.target.value }))}
              style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }}
              name="enrollment_status_semester_filter"
              aria-label="Semester"
            >
              <option value="">All semesters</option>
              {semesters.map((row) => (
                <option key={row.semester_id} value={String(row.semester_id)}>
                  {row.semester_name || `Semester ${row.semester_id}`}
                </option>
              ))}
            </select>
            <ArchiveViewToggle view={viewMode} onChange={setViewMode} />
            {viewMode === "active" && canImport ? (
              <button onClick={() => setImportOpen(true)} style={{ background: "var(--surface-base)", color: "var(--text-primary)", border: "1px solid var(--border-strong)", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}>Import</button>
            ) : null}
          </div>
        </SectionHeader>

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 221px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>No.</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>Student No.</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Student Name</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Decision</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Status</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Date</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Semester</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>School Year</th>
                {viewMode === "archived" ? <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Archived On</th> : null}
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows columns={viewMode === "archived" ? 10 : 9} />
              ) : filtered.length === 0 ? (
                <tr><td colSpan={viewMode === "archived" ? 10 : 9} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>{viewMode === "archived" ? "No archived records found" : "No records found"}</td></tr>
              ) : (
                pagedRows.rows.map((row, idx) => {
                  const { number: studentNumber, name: studentName } = studentParts(row.student_id);
                  return (
                    <tr key={row.enrollment_status_id}>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                        {(pagedRows.page - 1) * pagedRows.pageSize + idx + 1}
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>{studentNumber}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{studentName}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.decision || "-"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.status_name && row.status_name !== "" ? row.status_name : statusLabel(row.status_type)}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.date || "-"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.semester_name || (row.semester_id ?? "-")}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.schoolyear_name || (row.school_year_id ?? "-")}</td>
                      {viewMode === "archived" ? (
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.archived_at ? new Date(row.archived_at).toLocaleString() : "-"}</td>
                      ) : null}
                      {/* One kebab, matching every other management table. */}
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                        <ActionMenu
                          label="Actions for this enrollment status"
                          items={
                            viewMode === "archived"
                              ? canRestore
                                ? [{ key: "restore", label: "Restore", icon: "archiveRestore", tone: "brand", onSelect: () => void restore(row.enrollment_status_id) }]
                                : []
                              : [
                                  ...(canArchive
                                    ? [{ key: "archive", label: "Archive", icon: "archive", tone: "danger", onSelect: () => void remove(row.enrollment_status_id) }]
                                    : []),
                                ]
                          }
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {!loading && pagedRows.total > 0 ? (
          <div style={{ padding: "0 11px 11px" }}>
            <Pagination
              page={pagedRows.page}
              pageSize={pagedRows.pageSize}
              total={pagedRows.total}
              onPageChange={pagedRows.setPage}
              onPageSizeChange={pagedRows.setPageSize}
              itemLabel="records"
              compact
            />
          </div>
        ) : null}
      </div>

      <ImportDialog
        open={importOpen && canImport}
        onClose={() => setImportOpen(false)}
        title="Import Enrolled Students"
        description="Import the enrolled student list for the selected term. Every accepted row is recorded as Enrolled. To update a record, import the student again."
        templateFileName="enrollment-status-import-template.csv"
        columns={importColumns}
        fields={importFields}
        closedNotice={closedTermNotice(closedTermForYearName(closedTerms, importValues.school_year, importValues.semester_id))}
        values={importValues}
        onFieldChange={(key, value) => setImportTerm((prev) => ({ ...prev, [key]: value }))}
        onSubmit={handleImport}
        precheck={importPrecheck}
        rowNotice={(count) => perRowRequestNotice(count, "standings")}
        submitLabel="Import enrolled students"
        summarize={(r) => [
          { label: "Rows read", value: r.summary?.rows_read ?? 0 },
          { label: "Recorded", value: r.summary?.saved ?? 0, tone: "good" },
          ...(r.summary?.skipped ? [{ label: "Skipped", value: r.summary.skipped, tone: "warn" }] : []),
          ...(r.summary?.failed ? [{ label: "Failed to save", value: r.summary.failed, tone: "bad" }] : []),
        ]}
        detail={(r) => [
          { label: "Rows skipped during validation", items: r.details?.row_errors || [] },
          { label: "Rows the server rejected", items: r.details?.failed_rows || [] },
        ]}
      />
    </section>
  );
}
