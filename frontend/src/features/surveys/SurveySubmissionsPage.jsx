import React, { useEffect, useMemo, useState } from "react";
import { ManagementPagination } from "../../shared/components/management";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import Button from "../../shared/components/ui/Button";
import Icon from "../../shared/components/ui/Icon";
import { SkeletonTableRows, SkeletonText } from "../../shared/components/ui/Skeleton";
import Modal from "../../shared/components/Modal";
import { confirmAction, notifySuccess } from "../../shared/lib/notify";
import { downloadExcelFile } from "../../shared/lib/spreadsheet";
import { hasModulePermission } from "../../shared/lib/roleAccess";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import { localDateIso } from "../../shared/lib/localDate";
import SurveyFolderShelf, { SurveyFolderHeader } from "./SurveyFolderShelf";

/**
 * `initialSurvey` is the workspace handing off from Surveys or Questions: open
 * on that survey's folder rather than on the shelf.
 */
export default function SurveyMangeSubmission({ permissions = [], initialSurvey = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [exporting, setExporting] = useState(false);
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [studentNumberFilter, setStudentNumberFilter] = useState("");
  const [applied, setApplied] = useState({ search: "", student_number: "" });

  /*
   * ---- the shelf --------------------------------------------------------
   *
   * The screen asks which survey before it shows anybody's answers, because
   * "which survey" is the question the reader already has: nobody opens this
   * page to read every survey's submissions interleaved. Picking one first
   * also means the table below it is a table of one thing, which is what lets
   * the survey column go away and the search box mean "find a student".
   *
   * `openSurvey` is the whole mode switch: null is the shelf, a row is the
   * folder that row opened.
   */
  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [folderSearch, setFolderSearch] = useState("");
  const [folderStatus, setFolderStatus] = useState("all");
  const [openSurvey, setOpenSurvey] = useState(initialSurvey);
  /*
   * Inside a folder: the live submissions, or the archived ones.
   *
   * Submissions are archived, never deleted (2026-10-07). An archived one keeps
   * its answers and can be restored, but counts nowhere - not in this folder's
   * number, the results or the reports - and the student may answer again.
   */
  const [view, setView] = useState("active");
  const [busyId, setBusyId] = useState(null);

  /** Which student's answers the floating panel is showing, if any. */
  const [answerDialog, setAnswerDialog] = useState({ open: false, submissionId: "", studentNumber: "", studentName: "", surveyTitle: "" });

  /**
   * Fetched answers, keyed by submission_id: { loading, error, answers }.
   *
   * Kept separate from the dialog so closing the panel does not discard what was
   * already loaded - reopening the same student costs nothing. A submission that
   * previously failed is refetched on the next open, which is the one case where
   * asking again is what the user wants.
   */
  const [answerCache, setAnswerCache] = useState({});
  // Archiving and restoring take the permission Delete used to: whoever could
  // remove a submission can now set it aside instead.
  const canArchive = hasModulePermission(permissions, "delete");
  const canExport = hasModulePermission(permissions, "analyze") || hasModulePermission(permissions, "view");
  const showingArchived = view === "archived";
  // The Archived list has one more column: when, and by whom.
  const columnCount = showingArchived ? 7 : 6;

  const totalSubmissionsOnShelf = useMemo(
    () => folders.reduce((sum, folder) => sum + Number(folder.submission_count || 0), 0),
    [folders]
  );

  /*
   * The open folder's counts, kept current. `openSurvey` is the folder as it was
   * when it was opened; archiving or restoring changes both of its numbers, so
   * the toggle reads them from the latest folder list when there is one.
   */
  const openFolderCounts = useMemo(() => {
    const latest = openSurvey ? folders.find((folder) => folder.survey_id === openSurvey.survey_id) : null;
    const source = latest || openSurvey || {};
    return {
      live: source.submission_count,
      archived: source.archived_count,
    };
  }, [folders, openSurvey]);

  async function resolveStudentIdByStudentNumber(studentNumber) {
    const q = String(studentNumber || "").trim();
    if (!q) return "";
    const params = new URLSearchParams({ page: "1", limit: "20", search: q });
    const res = await fetch(getBackendUrl(`student.php?${params.toString()}`), { credentials: "include" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to resolve student number");
    const list = Array.isArray(data.data) ? data.data : [];
    const exact = list.find((s) => String(s.student_number || "").trim() === q);
    const picked = exact || list[0];
    return picked?.student_id ? String(picked.student_id) : "";
  }

  /**
   * The shelf.
   *
   * Counted by the endpoint rather than here. The submissions list is paged on
   * the server, so anything this page counted for itself would be a count of
   * the current page: a survey with twelve answers split across two pages used
   * to show "8 students" on one and "4 students" on the next, and neither
   * number was the survey's.
   */
  async function loadFolders() {
    setFoldersLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("survey_submission.php?group_by=survey"), {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load surveys");
      setFolders(Array.isArray(data.data) ? data.data : []);
    } catch (e) {
      setFolders([]);
      setError(e.message || "Failed to load surveys");
    } finally {
      setFoldersLoading(false);
    }
  }

  /**
   * The folder counts again, without the shelf's loading state or its errors:
   * run from inside a folder, where the shelf is not on screen and a failed
   * recount must not replace a message the reader is looking at.
   */
  async function refreshFolderCounts() {
    try {
      const res = await fetch(getBackendUrl("survey_submission.php?group_by=survey"), {
        credentials: "include",
      });
      const data = await res.json();
      if (res.ok && Array.isArray(data.data)) setFolders(data.data);
    } catch {
      // The toggle keeps its last counts.
    }
  }

  async function load() {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change and from useLiveRefresh, so a slower earlier request must
    // not land last. Two awaits deep here — the student-number lookup and the
    // submissions fetch — which only widens the window. See useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      let resolvedStudentId = "";
      if (applied.student_number) {
        resolvedStudentId = await resolveStudentIdByStudentNumber(applied.student_number);
        if (!resolvedStudentId) throw new Error("Student number not found");
      }

      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (applied.search) params.set("search", applied.search);
      // The open folder *is* the survey filter — there is no separate control
      // for it, and no way to be looking at this table without one open.
      if (openSurvey?.survey_id) params.set("survey_id", String(openSurvey.survey_id));
      if (resolvedStudentId) params.set("student_id", resolvedStudentId);
      if (showingArchived) params.set("archived", "1");

      const res = await fetch(getBackendUrl(`survey_submission.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load survey submissions");

      if (!isCurrent()) return;

      setRows(Array.isArray(data.data) ? data.data : []);
      setTotal(typeof data?.pagination?.total === "number" ? data.pagination.total : 0);
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setTotal(0);
      setError(e.message || "Failed to load survey submissions");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  async function fetchAllSurveySubmissions(filters = {}) {
    const all = [];
    const pageSize = 200;
    let currentPage = 1;
    let reportedTotal = Number.POSITIVE_INFINITY;

    while (all.length < reportedTotal) {
      const params = new URLSearchParams();
      params.set("page", String(currentPage));
      params.set("limit", String(pageSize));

      Object.entries(filters).forEach(([key, value]) => {
        const normalized = String(value ?? "").trim();
        if (normalized !== "") params.set(key, normalized);
      });

      const res = await fetch(getBackendUrl(`survey_submission.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load survey submissions");

      const list = Array.isArray(data.data) ? data.data : [];
      all.push(...list);

      const totalRows = Number(data?.pagination?.total);
      reportedTotal = Number.isFinite(totalRows) ? totalRows : all.length;

      if (list.length < pageSize) break;
      currentPage += 1;
    }

    return all;
  }

  async function fetchAllSurveyResponses(filters = {}) {
    const all = [];
    const pageSize = 200;
    let currentPage = 1;
    let reportedTotal = Number.POSITIVE_INFINITY;

    while (all.length < reportedTotal) {
      const params = new URLSearchParams();
      params.set("page", String(currentPage));
      params.set("limit", String(pageSize));

      Object.entries(filters).forEach(([key, value]) => {
        const normalized = String(value ?? "").trim();
        if (normalized !== "") params.set(key, normalized);
      });

      const res = await fetch(getBackendUrl(`survey_response.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load survey responses");

      const list = Array.isArray(data.data) ? data.data : [];
      all.push(...list);

      const totalRows = Number(data?.pagination?.total);
      reportedTotal = Number.isFinite(totalRows) ? totalRows : all.length;

      if (list.length < pageSize) break;
      currentPage += 1;
    }

    return all;
  }

  function getQuestionLabel(answerRow) {
    const questionText = String(answerRow?.question_text || "").trim();
    if (questionText) return questionText;
    if (answerRow?.question_id != null && answerRow.question_id !== "") return `Question #${answerRow.question_id}`;
    return "Question";
  }

  function buildQuestionAnswerWorkbook(submissions, answers) {
    const submissionIds = new Set(submissions.map((row) => String(row?.submission_id ?? "")));
    const relevantAnswers = answers.filter((row) => submissionIds.has(String(row?.submission_id ?? "")));
    const questionMetaMap = new Map();
    const answerMap = new Map();

    relevantAnswers.forEach((answerRow) => {
      const questionId = String(answerRow?.question_id ?? "");
      const label = getQuestionLabel(answerRow);
      const numericQuestionId = Number(answerRow?.question_id);
      const sortOrder = Number.isFinite(numericQuestionId) ? numericQuestionId : Number.MAX_SAFE_INTEGER;
      const current = questionMetaMap.get(questionId);

      if (questionId && (!current || sortOrder < current.sortOrder)) {
        questionMetaMap.set(questionId, {
          key: `q_${questionId}`,
          label,
          sortOrder,
        });
      }

      const submissionId = String(answerRow?.submission_id ?? "");
      if (!submissionId) return;
      const submissionAnswers = answerMap.get(submissionId) || {};
      const questionMeta = questionId ? questionMetaMap.get(questionId) : null;
      if (!questionMeta) return;
      const nextAnswer = String(answerRow?.answer ?? "");

      submissionAnswers[questionMeta.key] = submissionAnswers[questionMeta.key]
        ? `${submissionAnswers[questionMeta.key]} | ${nextAnswer}`
        : nextAnswer;
      answerMap.set(submissionId, submissionAnswers);
    });

    const questionColumns = Array.from(questionMetaMap.values()).sort((a, b) => {
      if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
      return a.label.localeCompare(b.label);
    });

    const columns = [
      { key: "row_no", label: "No." },
      { key: "student_number", label: "Student Number" },
      { key: "student_name", label: "Student Name" },
      ...questionColumns.map((column) => ({ key: column.key, label: column.label })),
    ];

    const exportRows = submissions.map((submission, index) => {
      const row = {
        row_no: index + 1,
        student_number: submission?.student_number || "-",
        student_name: submission?.student_name || "-",
      };

      questionColumns.forEach((column) => {
        row[column.key] = "";
      });

      Object.assign(row, answerMap.get(String(submission?.submission_id ?? "")) || {});
      return row;
    });

    return { columns, exportRows };
  }

  async function exportSubmissions() {
    setExporting(true);
    setError("");
    try {
      let resolvedStudentId = "";
      if (applied.student_number) {
        resolvedStudentId = await resolveStudentIdByStudentNumber(applied.student_number);
        if (!resolvedStudentId) throw new Error("Student number not found");
      }

      const submissions = await fetchAllSurveySubmissions({
        search: applied.search,
        survey_id: openSurvey?.survey_id ? String(openSurvey.survey_id) : "",
        student_id: resolvedStudentId,
      });

      if (submissions.length === 0) {
        throw new Error("No survey submissions found for export");
      }

      const answers = await fetchAllSurveyResponses({
        survey_id: openSurvey?.survey_id ? String(openSurvey.survey_id) : "",
        student_id: resolvedStudentId,
      });

      const { columns, exportRows } = buildQuestionAnswerWorkbook(submissions, answers);

      // Named after the survey when one is open, so three exports in a row do
      // not land in Downloads as three files with the same name.
      const surveySlug = String(openSurvey?.survey_title || "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);

      downloadExcelFile(
        `survey-submissions-${surveySlug ? `${surveySlug}-` : ""}${localDateIso()}`,
        "Survey Results",
        columns,
        exportRows
      );
    } catch (e) {
      setError(e.message || "Failed to export survey submissions");
    } finally {
      setExporting(false);
    }
  }

  useEffect(() => {
    if (openSurvey) load();
    else loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, limit, applied, openSurvey, view]);

  // New submissions are the whole point of this screen, so it watches them
  // closely — whichever of the two views is the one on screen.
  useLiveRefresh(
    ["survey_submissions"],
    () => {
      if (openSurvey) {
        load();
        void refreshFolderCounts();
      } else {
        loadFolders();
      }
    },
    { intervalMs: 10000 }
  );

  /** Open a survey's folder, from a clean slate rather than the last one's filters. */
  function openFolder(folder) {
    setOpenSurvey(folder);
    setView("active");
    setPage(1);
    setSearch("");
    setStudentNumberFilter("");
    setApplied({ search: "", student_number: "" });
    setError("");
  }

  /**
   * Back to the shelf. The effect recounts it on the way out, because an
   * archive inside the folder has just changed the number written on it.
   */
  function closeFolder() {
    setOpenSurvey(null);
    setView("active");
    setPage(1);
    setError("");
  }

  function switchView(next) {
    if (next === view) return;
    setView(next);
    setPage(1);
    setError("");
  }

  /** Open the floating answer panel for one student, fetching only if needed. */
  async function openAnswers(row) {
    const key = String(row?.submission_id ?? "");
    if (!key) return;

    setAnswerDialog({
      open: true,
      submissionId: key,
      studentNumber: row?.student_number || "-",
      studentName: row?.student_name || "",
      surveyTitle: row?.survey_title || (row?.survey_id ? `Survey #${row.survey_id}` : ""),
    });

    const cached = answerCache[key];
    if (cached && !cached.error) return;

    setAnswerCache((prev) => ({ ...prev, [key]: { loading: true, error: "", answers: [] } }));
    try {
      const params = new URLSearchParams({ page: "1", limit: "500", submission_id: key });
      const res = await fetch(getBackendUrl(`survey_response.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load answers");
      setAnswerCache((prev) => ({
        ...prev,
        [key]: { loading: false, error: "", answers: Array.isArray(data.data) ? data.data : [] },
      }));
    } catch (e) {
      setAnswerCache((prev) => ({
        ...prev,
        [key]: { loading: false, error: e.message || "Failed to load answers", answers: [] },
      }));
    }
  }

  /**
   * Set a submission aside. Its answers stay saved and can be restored; until
   * then it counts nowhere and the student may answer the survey again.
   */
  async function archiveSubmission(row) {
    if (!canArchive) {
      setError("You do not have permission to archive submissions.");
      return;
    }
    const who = row.student_name || row.student_number || "this student";
    const confirmed = await confirmAction({
      title: "Archive submission?",
      text: `${who}'s answers stay saved, but leave this survey's results and counts. You can restore them from the Archived list.`,
      confirmButtonText: "Archive",
    });
    if (!confirmed) return;
    setBusyId(row.submission_id);
    setError("");
    try {
      const res = await fetch(getBackendUrl(`survey_submission.php?id=${row.submission_id}`), {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to archive submission");
      notifySuccess("Submission archived", `${who}'s answers were moved to Archived.`);
      await load();
      void refreshFolderCounts();
    } catch (e) {
      setError(e.message || "Failed to archive submission");
    } finally {
      setBusyId(null);
    }
  }

  /** Put an archived submission back into the results and counts. */
  async function restoreSubmission(row) {
    if (!canArchive) {
      setError("You do not have permission to restore submissions.");
      return;
    }
    const who = row.student_name || row.student_number || "this student";
    const confirmed = await confirmAction({
      title: "Restore submission?",
      text: `${who}'s answers return to this survey's results and counts.`,
      confirmButtonText: "Restore",
    });
    if (!confirmed) return;
    setBusyId(row.submission_id);
    setError("");
    try {
      // PUT nominating `delete`: restoring is checked against the permission
      // that archives (see the restore branch in survey_submission.php).
      const res = await fetch(getBackendUrl(`survey_submission.php?id=${row.submission_id}&permission_action=delete`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ restore: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to restore submission");
      notifySuccess("Submission restored", `${who}'s answers are back in the results.`);
      await load();
      void refreshFolderCounts();
    } catch (e) {
      setError(e.message || "Failed to restore submission");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Survey Submission Management</h2>
      {error && (
        <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 6, marginBottom: 9 }}>
          {error}
        </div>
      )}

      {!openSurvey ? (
        /* ---------------------------------------------------------- the shelf
           Surveys as folders, each carrying the one number that decides whether
           it is worth opening. Nothing here is a student yet. */
        <SurveyFolderShelf
          hint={
            foldersLoading
              ? "Loading surveys..."
              : `Open a folder to read the students who answered it. ${folders.length} survey${folders.length === 1 ? "" : "s"}, ${totalSubmissionsOnShelf} submission${totalSubmissionsOnShelf === 1 ? "" : "s"} in all.`
          }
          folders={folders}
          loading={foldersLoading}
          search={folderSearch}
          onSearchChange={setFolderSearch}
          status={folderStatus}
          onStatusChange={setFolderStatus}
          onOpen={openFolder}
          primary={(folder) => ({ value: folder.submission_count, noun: "submission" })}
          caption={(folder) =>
            folder.latest_submission_at ? `Last answered ${folder.latest_submission_at}` : "No answers yet"
          }
        />
      ) : (
        /* ------------------------------------------------------ inside a folder
           One survey's students. The survey column is gone because every row
           here answers the same survey — it is named once, in the header. */
        <div style={{ background: "#fff", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
          <div style={{ position: "sticky", top: 0, zIndex: 3, background: "#fff", borderBottom: "1px solid var(--border-base)" }}>
            <SurveyFolderHeader
              survey={openSurvey}
              onBack={closeFolder}
              subtitle={
                showingArchived
                  ? `${loading ? "Loading..." : `${total} archived submission${total === 1 ? "" : "s"}`} · Kept with their answers, counted nowhere until restored`
                  : `${loading ? "Loading..." : `${total} submission${total === 1 ? "" : "s"}`} · Click a student number to read their answers`
              }
            />

            <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, flexWrap: "wrap", padding: 9 }}>
              <div style={{ marginRight: "auto" }}>
                <ArchiveViewToggle
                  view={view}
                  onChange={switchView}
                  activeLabel={openFolderCounts.live !== undefined ? `Submissions (${openFolderCounts.live})` : "Submissions"}
                  archivedLabel={openFolderCounts.archived !== undefined ? `Archived (${openFolderCounts.archived})` : "Archived"}
                />
              </div>
              <input value={studentNumberFilter} onChange={(e) => setStudentNumberFilter(e.target.value)} placeholder="Student Number" aria-label="Student number" style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, width: 145 }} name="survey_mange_submission_input_2" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search students..." aria-label="Search students" style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, width: 170 }} name="survey_mange_submission_input_3" />
              <button
                onClick={() => {
                  setPage(1);
                  setApplied({
                    search: String(search || "").trim(),
                    student_number: String(studentNumberFilter || "").trim(),
                  });
                }}
                style={{ background: "var(--info-500)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}
              >
                Apply
              </button>
              {/* Export is of the live submissions - the survey's results. */}
              {canExport && !showingArchived ? (
                <button
                  onClick={() => {
                    void exportSubmissions();
                  }}
                  disabled={exporting || loading}
                  title="Export this survey's submissions"
                  style={{ background: "var(--brand-600)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: exporting || loading ? "not-allowed" : "pointer", opacity: exporting || loading ? 0.7 : 1 }}
                >
                  {exporting ? "Exporting..." : "Export this survey"}
                </button>
              ) : null}
              <select
                value={String(limit)}
                onChange={(e) => {
                  setLimit(Number(e.target.value));
                  setPage(1);
                }}
                aria-label="Rows per page"
                style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                name="survey_mange_submission_select_1"
              >
                <option value="10">10</option>
                <option value="20">20</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </div>
          </div>

          <div style={{ overflow: "auto", maxHeight: "calc(100vh - 262px)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>No.</th>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Student Number</th>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Student Name</th>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Submitted At</th>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Answers</th>
                  {showingArchived ? (
                    <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Archived</th>
                  ) : null}
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <SkeletonTableRows columns={columnCount} />
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={columnCount} style={{ padding: 14, textAlign: "center", color: "var(--text-muted)" }}>
                      {applied.search || applied.student_number
                        ? `No ${showingArchived ? "archived submission" : "student"} in this survey matches that search.`
                        : showingArchived
                          ? "No archived submissions in this survey."
                          : "Nobody has answered this survey yet."}
                    </td>
                  </tr>
                ) : (
                  rows.map((r, idx) => (
                    <tr key={r.submission_id}>
                      {/* Numbered across the whole survey rather than restarted
                          per page: row 21 is the 21st student, not the 1st again. */}
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", fontVariantNumeric: "tabular-nums" }}>
                        {(page - 1) * limit + idx + 1}
                      </td>
                      <td style={{ padding: 0, borderBottom: "1px solid var(--border-base)" }}>
                        {/* The student number is the control: clicking it
                            floats that student's answers over the page. */}
                        <button
                          type="button"
                          onClick={() => openAnswers(r)}
                          title="View answers"
                          style={{ width: "100%", padding: 9, border: 0, background: "transparent", cursor: "pointer", textAlign: "left", font: "inherit", color: "var(--brand-800)", fontWeight: 600, textDecoration: "underline", textUnderlineOffset: 2 }}
                        >
                          {r.student_number || "-"}
                        </button>
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.student_name || "-"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.submitted_at || "-"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", fontVariantNumeric: "tabular-nums" }}>{r.answer_count ?? 0}</td>
                      {showingArchived ? (
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                          <div>{r.archived_at || "-"}</div>
                          {r.archived_by_name ? (
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>by {r.archived_by_name}</div>
                          ) : null}
                        </td>
                      ) : null}
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                        {/* Archive, never delete: the answers stay and can be restored. */}
                        {canArchive && !showingArchived ? (
                          <Button size="sm" variant="secondary" disabled={busyId === r.submission_id} onClick={() => void archiveSubmission(r)}>
                            <Icon name="archive" size={12} /><span>Archive</span>
                          </Button>
                        ) : null}
                        {canArchive && showingArchived ? (
                          <Button size="sm" variant="secondary" disabled={busyId === r.submission_id} onClick={() => void restoreSubmission(r)}>
                            <Icon name="archiveRestore" size={12} /><span>Restore</span>
                          </Button>
                        ) : null}
                      </td>
                    </tr>
                  ))
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
              itemLabel="submissions"
            />
          </div>
        </div>
      )}

      {/* The shared Modal rather than a hand-rolled overlay, so this panel picks
          up the same width, corners, scroll behaviour and close affordance as
          every other dialog in the portal. */}
      <Modal
        open={answerDialog.open}
        // Named, then numbered. Whoever opens this is reading one student's
        // answers and thinking of them by name; the number stays because it is
        // what they would search or paste elsewhere.
        title={
          answerDialog.studentName
            ? `Answers - ${answerDialog.studentName} (${answerDialog.studentNumber})`
            : answerDialog.studentNumber
              ? `Answers - ${answerDialog.studentNumber}`
              : "Answers"
        }
        onClose={() => setAnswerDialog((d) => ({ ...d, open: false }))}
        width={660}
      >
        {(() => {
          const panel = answerCache[answerDialog.submissionId];
          if (panel?.error) {
            return <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 6 }}>{panel.error}</div>;
          }
          if (!panel || panel.loading) return <SkeletonText lines={4} />;
          if (!panel.answers.length) {
            return <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>No answers recorded for this submission.</div>;
          }
          return (
            <>
              {answerDialog.surveyTitle ? (
                <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginBottom: 9 }}>{answerDialog.surveyTitle}</div>
              ) : null}
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                    <th style={{ padding: 8, borderBottom: "1px solid var(--border-base)", width: 31 }}>#</th>
                    <th style={{ padding: 8, borderBottom: "1px solid var(--border-base)" }}>Question</th>
                    <th style={{ padding: 8, borderBottom: "1px solid var(--border-base)" }}>Answer</th>
                  </tr>
                </thead>
                <tbody>
                  {panel.answers.map((a, i) => (
                    <tr key={`${a.answer_id ?? i}-${a.question_id ?? i}`}>
                      <td style={{ padding: 8, borderBottom: "1px solid var(--surface-muted)", verticalAlign: "top" }}>{i + 1}</td>
                      <td style={{ padding: 8, borderBottom: "1px solid var(--surface-muted)", verticalAlign: "top" }}>{a.question_text || `Question #${a.question_id}`}</td>
                      <td style={{ padding: 8, borderBottom: "1px solid var(--surface-muted)", verticalAlign: "top", overflowWrap: "anywhere" }}>{a.answer ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          );
        })()}
      </Modal>
    </section>
  );
}
