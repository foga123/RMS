import React, { useCallback, useEffect, useMemo, useState } from "react";
import Modal from "../../shared/components/Modal";
import { AlertMessage, Button, Tabs } from "../../shared/components/ui";
import { OverviewHeader } from "../../shared/layout/dashboard";
import { getBackendUrl } from "../../shared/lib/url";
import { courseCampusSuffix } from "../../shared/lib/scopeOptionLabels";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { STATUS_TONES, statusNeedsRemark, statusToneFor, NO_STATUS } from "./statusTone";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { localDateIso } from "../../shared/lib/localDate";
import RetentionMatrix from "../retention-cases/RetentionMatrix";
import YearMigrationMatrix from "./YearMigrationMatrix";
import YearEndEvaluation from "./YearEndEvaluation";

/** Where students stand in a chosen term, compared against the term before it, with per-student history. */

const PAGE_SIZE = 25;

const controlStyle = {
  padding: "6px 8px",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  fontSize: 12.5,
};

const thStyle = {
  padding: 9,
  position: "sticky",
  top: 0,
  background: "var(--surface-page)",
  borderBottom: "1px solid var(--border-base)",
  textAlign: "left",
  color: "var(--text-secondary)",
  fontSize: 11.5,
  zIndex: 1,
};

const tdStyle = { padding: 9, borderBottom: "1px solid var(--border-base)", fontSize: 11.5 };

/** Kept next to the <thead> it describes; a stale count breaks the empty row. */
const MIGRATION_COLUMN_COUNT = 15;

/**
 * Add the decision questions a re-read row brought with it to the page's list.
 * Those already listed are replaced by the fresher copy.
 */
function mergeDecisionQuestions(filters, incoming) {
  if (!filters || !Array.isArray(incoming) || incoming.length === 0) return filters;
  const ids = new Set(incoming.map((question) => Number(question.question_id)));
  const kept = (filters.decision_questions || []).filter((question) => !ids.has(Number(question.question_id)));
  return { ...filters, decision_questions: [...kept, ...incoming] };
}

/**
 * `student.gender` is free-ish text ("Male", "female", "M"), but the registrar's
 * sheet uses a single letter. Anything unrecognised is shown as typed rather
 * than forced into M or F.
 */
function sexLabel(gender) {
  const normalized = String(gender || "").trim().toLowerCase();
  if (normalized === "") return "—";
  if (normalized.startsWith("m")) return "M";
  if (normalized.startsWith("f")) return "F";
  return String(gender).trim();
}

/**
 * Campus names are stored in full ("PHINMA Cagayan de Oro College - Carmen
 * Campus"). The sheet uses just the distinguishing word, which is all that fits
 * in a column and all a reader needs.
 */
function campusLabel(campusName) {
  const full = String(campusName || "").trim();
  if (full === "") return "—";
  const afterDash = full.includes(" - ") ? full.split(" - ").pop() : full;
  return afterDash.replace(/\s*campus$/i, "").trim() || full;
}

/**
 * The priority behind the filter.
 *
 * The column exists because the filter does: choosing "P1" and getting back a
 * list with no visible reason to believe it is a filter you have to take on
 * faith. A student the classifier has not placed reads as a dash rather than as
 * a Priority 4 - those are different facts, and calling the second one P4 would
 * be a reassurance nobody gave.
 *
 * Replaced a High/Moderate/Low retention-risk badge. The scoring engine's risk
 * level still exists and still drives the retention module; what this page ranks
 * by is the sheet's Priority 1-4, computed by the same code the caller screens
 * and the prioritization list use, so the same student reads the same on all of
 * them.
 */
/*
 * Borrowed from STATUS_TONES rather than picked again, for the reason that file
 * gives for existing: two colour maps in one module drift, and then the same
 * severity reads as two different things one column apart.
 */
const PRIORITY_TONES = {
  1: { tone: "bad" },
  2: { tone: "warn" },
  3: { tone: "info" },
  4: { tone: "good" },
};

function PriorityBadge({ level, owner, segment }) {
  const tone = PRIORITY_TONES[level];

  if (!tone) {
    return <span style={{ color: "var(--text-faint)" }} title="This student has not been classified yet">&mdash;</span>;
  }

  const palette = STATUS_TONES[tone.tone] || STATUS_TONES.good;
  return (
    <span
      title={segment ? `Segment: ${segment}` : undefined}
      style={{
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.br}`,
      }}
    >
      P{level}{owner ? ` \u00b7 ${owner}` : ""}
    </span>
  );
}

/**
 * How the student did last term, and what they owe.
 *
 * Two columns of the retention workbook - "Academics standing last sem"
 * and "Balances" - that are filled in by hand there and were blank in every
 * row of the copy this page was modelled on. Both are shown here because the
 * system already has them: they are two of the three signals that decided the
 * Priority badge immediately to the left, so this column pair is that badge
 * explaining itself rather than a new claim about the student.
 *
 * Tone comes from STATUS_TONES for the reason PRIORITY_TONES does: a third
 * palette in the same table would let one severity read as two different
 * colours a column apart.
 */
/*
 * One tone table for both signals.
 *
 * grade_colour and balance_colour are the same three words, computed the
 * same way server-side, so a failing student and a student deep in arrears
 * read at the same severity instead of one being a colour scale and the
 * other a yes/no.
 */
const SIGNAL_TONES = { green: "good", yellow: "warn", red: "bad" };

/** A pill in one of the shared tones, sized for this table. */
function CellBadge({ tone, title, children }) {
  const palette = STATUS_TONES[tone] || STATUS_TONES.neutral;
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
        background: palette.bg,
        color: palette.fg,
        border: `1px solid ${palette.br}`,
      }}
    >
      {children}
    </span>
  );
}

/**
 * The term a figure came from, shown only when it is not the term in the
 * heading.
 *
 * The backend sends null when they match, so this renders nothing on the
 * ordinary row. A column that repeated "2025-2026 2nd Semester" on all 2,776
 * rows would be noise, and noise is what stops the one disagreeing row from
 * being noticed.
 *
 * It earns its place: every grade and balance in this database sits in
 * 2026-2027 1st Semester, while the page opens on the newest term holding
 * enrolment DECISIONS, which is the year before. Without this line the page
 * prints last year's heading over this year's marks and says nothing.
 */
function FromOtherTerm({ term }) {
  if (!term) return null;
  return (
    <div
      title={`These figures were recorded in ${term}, not the term selected above`}
      style={{ color: "var(--warning-800)", fontSize: 10, fontWeight: 600, marginTop: 2 }}
    >
      from {term}
    </div>
  );
}

/** Nothing on record reads as a dash that says so, never as a clean sheet. */
function NoRecord({ title }) {
  return <span title={title} style={{ color: "var(--text-faint)" }}>&mdash;</span>;
}

/*
 * "Problems" is the sheet's own grouping: failed, incomplete, no credit and
 * no grade counted together, which is what the priority matrix reads too. It
 * is spelled out in the tooltip because four different outcomes hiding behind
 * one number is exactly the sort of thing a reader should be able to check.
 */
function StandingBadge({ colour, problems, total }) {
  const tone = SIGNAL_TONES[colour];
  if (!tone) {
    return <NoRecord title="No grades have been uploaded for this student" />;
  }

  const problemCount = Number(problems) || 0;
  const subjects = Number(total) || 0;
  return (
    <>
      <CellBadge
        tone={tone}
        title="Counts failed, incomplete, no credit and no grade together"
      >
        {problemCount > 0
          ? `${problemCount} problem${problemCount === 1 ? "" : "s"}`
          : "Clear"}
      </CellBadge>
      {subjects > 0 ? (
        <div style={{ color: "var(--text-faint)", fontSize: 10.5, marginTop: 3 }}>
          {problemCount > 0 ? `of ${subjects} subjects` : `${subjects} subjects`}
        </div>
      ) : null}
    </>
  );
}

/*
 * The band is the headline and the figure is the detail, matching how the
 * sheet files a balance: what the office acts on is which band a student is
 * in, and the peso amount is there so nobody has to open Finance to check it.
 *
 * A real band with no amount cannot happen - both come off the same finance
 * row - but the figure is still guarded, because a band shown beside "PHP
 * 0.00" that actually meant "unknown" would be worse than no figure at all.
 */
function BalanceBadge({ band, colour, label, amount }) {
  if (!band || band === "no_data") {
    return <NoRecord title="No finance record for this student" />;
  }

  const owed = Number(amount);
  return (
    <>
      {/*
        * Toned from the server’s balance_colour, not from the band key.
        *
        * This read `band === "no_balance" ? "good" : "warn"`, so a five-rung
        * ladder rendered as two colours and PHP 1 looked exactly like PHP
        * 80,000. The rung-to-colour decision belongs with the ladder, which
        * is the thing Status Management edits.
        */}
      <CellBadge tone={SIGNAL_TONES[colour] || "warn"}>{label || band}</CellBadge>
      {Number.isFinite(owed) && owed > 0 ? (
        <div style={{ color: "var(--text-faint)", fontSize: 10.5, marginTop: 3 }}>
          PHP {owed.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
        </div>
      ) : null}
    </>
  );
}

function StatusBadge({ statusName, statusId }) {
  const tone = STATUS_TONES[statusToneFor(statusName, statusId)];
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 7px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        border: `1px solid ${tone.br}`,
        background: tone.bg,
        color: tone.fg,
        whiteSpace: "nowrap",
      }}
    >
      {statusName || "No status"}
    </span>
  );
}

/**
 * Signed delta against the previous term; null means there is nothing to compare
 * with, or the count did not move. Sits beside the status dropdown, which is why
 * it spells out what it is measuring rather than relying on a nearby label.
 */
function ChangeTag({ change }) {
  if (change === null || change === undefined || change === 0) return null;
  const up = change > 0;
  return (
    <span
      title="Change since the previous sem"
      style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)", whiteSpace: "nowrap" }}
    >
      {up ? "▲" : "▼"} {Math.abs(change)} vs last sem
    </span>
  );
}

/** The two top-level views, in the order they are read. */
const MATRIX_VIEWS = [
  { key: "retention", label: "Retention" },
  { key: "migration", label: "Year-level Migration" },
  // Where year levels actually move: classify first, then apply. See YearEndEvaluation.
  { key: "evaluation", label: "Year-end Evaluation" },
];

const MATRIX_VIEW_NOTES = {
  retention: "Where last semester's students ended up.",
  migration: "Where each year level is headed.",
  evaluation: "Classify each student for the school year, then move year levels by that classification.",
};

/** Remembered choice of matrix. See matrixView. */
const MATRIX_VIEW_KEY = "coc-migration-matrix-view";

export default function StudentMigrationPage({ user = null, initialStatus = "" }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [forbidden, setForbidden] = useState(false);

  const [statusFilter, setStatusFilter] = useState(initialStatus);
  const [departmentId, setDepartmentId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [yearLevel, setYearLevel] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [schoolYearId, setSchoolYearId] = useState("");
  const [semesterId, setSemesterId] = useState("");
  const [decisionQuestionId, setDecisionQuestionId] = useState("");
  /*
   * Which matrix the card is showing.
   *
   * One at a time rather than both stacked: they are two answers to the same
   * question — where are the students going — read one at a time, and printing
   * both would push the student list, which is what this page is for, below the
   * fold on every screen. Remembered per browser so a reader who works from the
   * migration view is not switched back to retention on every visit.
   *
   * Chosen with tabs, not a dropdown: see the note at the render site. Both
   * names have to be visible, or the second view is only found by accident.
   */
  const [matrixView, setMatrixView] = useState(() => {
    try {
      const stored = window.localStorage.getItem(MATRIX_VIEW_KEY);
      return MATRIX_VIEWS.some((view) => view.key === stored) ? stored : "retention";
    } catch {
      return "retention";
    }
  });
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);

  const [savingId, setSavingId] = useState(null);
  const [history, setHistory] = useState(null);
  const [historyLoading, setHistoryLoading] = useState(false);

  /**
   * Refetch the page.
   *
   * `quiet` skips the loading state. The table is swapped for a skeleton while
   * `loading` is true, which is right when the page is opening or the filters
   * changed, and wrong for a background poll — there the rows are already on
   * screen and correct, so blanking them repaints for no reason and throws away
   * the scroll position.
   */
  const load = useCallback(async ({ quiet = false } = {}) => {
    if (!quiet) setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(PAGE_SIZE));
      if (statusFilter) params.set("status_id", statusFilter);
      if (priorityFilter) params.set("priority", priorityFilter);
      if (departmentId) params.set("department_id", departmentId);
      if (courseId) params.set("course_id", courseId);
      if (yearLevel) params.set("year_level", yearLevel);
      if (schoolYearId) params.set("school_year_id", schoolYearId);
      if (semesterId) params.set("semester_id", semesterId);
      if (decisionQuestionId) params.set("decision_question_id", decisionQuestionId);
      if (search.trim()) params.set("search", search.trim());

      const res = await fetch(getBackendUrl(`student_migration.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });

      // 403 means "not for this viewer", not "broken".
      if (res.status === 401 || res.status === 403) {
        setForbidden(true);
        setData(null);
        return;
      }

      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load student migration");
      setData(json);
    } catch (loadError) {
      setError(loadError?.message || "Failed to load student migration");
    } finally {
      setLoading(false);
    }
  }, [courseId, decisionQuestionId, departmentId, page, priorityFilter, schoolYearId, search, semesterId, statusFilter, yearLevel]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Read one student's row back and swap it in place.
   *
   * Saving an edit moves more than the field that was touched: the standing,
   * the date it was set, the note written alongside it, and — for a student who
   * had no row for the term — the enrollment_status_id the next edit needs in
   * order to update rather than insert. So the row is re-read rather than
   * patched from the request that was just sent, which would be guessing.
   *
   * Every other row keeps its object identity, so the table does not repaint:
   * the scroll position holds and no other cell flickers.
   *
   * A row that cannot be re-read on its own falls back to a full load. Stale is
   * worse than slow.
   */
  const refreshRow = useCallback(
    async (studentId) => {
      const params = new URLSearchParams();
      params.set("action", "row");
      params.set("student_id", String(studentId));
      if (departmentId) params.set("department_id", departmentId);
      if (courseId) params.set("course_id", courseId);
      if (yearLevel) params.set("year_level", yearLevel);
      if (schoolYearId) params.set("school_year_id", schoolYearId);
      if (semesterId) params.set("semester_id", semesterId);
      if (decisionQuestionId) params.set("decision_question_id", decisionQuestionId);

      try {
        const res = await fetch(getBackendUrl(`student_migration.php?${params.toString()}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json().catch(() => null);
        if (!res.ok || !json?.student) {
          await load({ quiet: true });
          return;
        }

        setData((prev) => {
          if (!prev) return prev;
          const index = (prev.students || []).findIndex(
            (row) => String(row.student_id) === String(studentId)
          );
          if (index < 0) return prev;

          const students = prev.students.slice();
          students[index] = json.student;
          return {
            ...prev,
            students,
            // The counts move with the status, so the filter dropdown is kept
            // honest rather than showing last minute's totals.
            summary: json.summary || prev.summary,
            total_students: json.total_students ?? prev.total_students,
            filters: mergeDecisionQuestions(prev.filters, json.decision_questions),
          };
        });
      } catch (rowError) {
        await load({ quiet: true });
      }
    },
    [courseId, decisionQuestionId, departmentId, load, schoolYearId, semesterId, yearLevel]
  );

  // Standing and grades both feed this view, so either one moving is a reason to
  // refetch — quietly, because this fires on a timer and nobody asked for it.
  const loadQuietly = useCallback(() => load({ quiet: true }), [load]);
  useLiveRefresh(["enrollment_status", "grades", "students", "surveys", "survey_questions", "survey_answers"], loadQuietly);

  useEffect(() => {
    setPage(1);
  }, [courseId, departmentId, priorityFilter, schoolYearId, semesterId, statusFilter, yearLevel]);

  useEffect(() => {
    setStatusFilter(initialStatus);
  }, [initialStatus]);

  /**
   * Save a status or a student update for one row.
   *
   * Writes go to enrollment_status.php, not here: that module owns enrollment
   * standing, and student_migration.php is read-only by design. A student with
   * no row for the term gets one created (POST); an existing row is patched
   * (PUT), so editing never silently forks a second record for the same term.
   */
  const saveRow = useCallback(
    async (student, patch) => {
      const rowId = student.enrollment_status_id;
      const termSchoolYear = schoolYearId || data?.term?.school_year_id || null;
      const termSemester = semesterId || data?.term?.semester_id || null;

      if (!rowId && (!termSchoolYear || !termSemester)) {
        setError("Pick a school year and semester before setting a status for a student who has none.");
        return;
      }

      setSavingId(student.student_id);
      setError("");
      try {
        const res = await fetch(getBackendUrl("enrollment_status.php"), {
          method: rowId ? "PUT" : "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "include",
          body: JSON.stringify(
            rowId
              ? { enrollment_status_id: rowId, ...patch }
              : {
                  student_id: student.student_id,
                  school_year_id: Number(termSchoolYear),
                  semester_id: Number(termSemester),
                  date: localDateIso(),
                  ...patch,
                }
          ),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.message || "Failed to save.");
        await refreshRow(student.student_id);
      } catch (saveError) {
        setError(saveError?.message || "Failed to save.");
      } finally {
        setSavingId(null);
      }
    },
    [data?.term?.school_year_id, data?.term?.semester_id, refreshRow, schoolYearId, semesterId]
  );

  /**
   * Record the student's enrolment decision.
   *
   * Writes a survey answer rather than a column: the decision *is* the answer to
   * the survey's enrolment question, and student_migration.php reads it back
   * from there. survey_response.php opens a submission for the student if they
   * never filled the form, which is the usual case here — staff are recording
   * what the student said on the phone.
   *
   * replace_existing keeps it to one answer per question, so a decision changed
   * twice does not become three answers the reports would count separately.
   * `question` is the one the row's answer belongs to (or, for a student with
   * no answer yet, the term's decision survey), and a student who has answered
   * has that very submission edited. Writing to a fixed survey instead left the
   * column reading an answer the edit never touched, so it snapped back.
   *
   * Because the chosen option carries an enrollment status, the same request
   * also moves the student's standing - filed under the term on screen, or the
   * status beside the decision would not move. The row is re-read afterwards
   * instead of being patched with the value that was just sent.
   */
  const saveDecision = useCallback(
    async (student, question, optionId) => {
      if (!question) return;
      const choice = question.choices.find((option) => String(option.option_id) === String(optionId));
      if (!choice) return;
      // Same term rule as saveRow, and read off `data` for the same reason.
      const termSchoolYear = schoolYearId || data?.term?.school_year_id || null;
      const termSemester = semesterId || data?.term?.semester_id || null;
      if (!termSchoolYear || !termSemester) {
        setError("Choose a school year and semester before recording a decision.");
        return;
      }
      const editsOwnAnswer = Boolean(student.survey_decision_submission_id)
        && Number(student.survey_decision_question_id) === Number(question.question_id);

      setSavingId(student.student_id);
      setError("");
      try {
        const res = await fetch(getBackendUrl("survey_response.php"), {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "include",
          body: JSON.stringify({
            survey_id: question.survey_id,
            student_id: student.student_id,
            question_id: question.question_id,
            ...(editsOwnAnswer ? { submission_id: student.survey_decision_submission_id } : {}),
            answer: choice.option_text,
            option_id: Number(choice.option_id),
            migration_decision: true,
            replace_existing: true,
            ...(termSchoolYear && termSemester
              ? { school_year_id: Number(termSchoolYear), semester_id: Number(termSemester) }
              : {}),
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.message || "Failed to save the decision.");
        await refreshRow(student.student_id);
      } catch (saveError) {
        setError(saveError?.message || "Failed to save the decision.");
      } finally {
        setSavingId(null);
      }
    },
    [data?.term?.school_year_id, data?.term?.semester_id, refreshRow, schoolYearId, semesterId]
  );

  const openHistory = useCallback(async (student) => {
    setHistoryLoading(true);
    setHistory({ student, rows: null });
    try {
      const res = await fetch(
        getBackendUrl(`student_migration.php?action=history&student_id=${encodeURIComponent(student.student_id)}`),
        { headers: { Accept: "application/json" }, credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load history");
      setHistory({ student: json.student || student, rows: json.history || [] });
    } catch (historyError) {
      setHistory({ student, rows: [], error: historyError?.message || "Failed to load history" });
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  const summary = useMemo(() => data?.summary || [], [data]);
  const students = useMemo(() => data?.students || [], [data]);
  const pagination = data?.pagination || { page: 1, pages: 0, total: 0 };
  const term = data?.term || {};
  const canChooseDepartment = Boolean(data?.scope?.can_choose_department);
  // Both are needed: setting a status on a student who has none inserts a row.
  // enrollment_status.php re-checks this — the flag only hides a dead control.
  const canEditStatus = Boolean(data?.scope?.can_edit_status && data?.scope?.can_create_status);
  const enrollmentStatuses = useMemo(() => data?.filters?.enrollment_statuses || [], [data?.filters?.enrollment_statuses]);
  // Named because the option needs the whole list as well as its own row: two campuses
  // can offer the same course code, and the label says which only when they do.
  const courseOptions = useMemo(() => data?.filters?.courses || [], [data?.filters?.courses]);
  // Recording a decision writes a survey answer, so it is gated on the survey
  // responses module — a role can hold this without holding status editing, or
  // the other way round.
  const surveyDecision = data?.filters?.survey_decision || null;
  const canEditDecision = Boolean(!loading && data?.scope?.can_edit_decision && surveyDecision
    && (!decisionQuestionId || Number(decisionQuestionId) === Number(surveyDecision.question_id)));
  // Rows and edits share the selected survey question and its configured choices.
  const decisionQuestionsById = useMemo(() => {
    const byId = new Map();
    (data?.filters?.decision_questions || []).forEach((question) => byId.set(Number(question.question_id), question));
    return byId;
  }, [data?.filters?.decision_questions]);
  const decisionQuestionFor = useCallback(
    (student) => decisionQuestionsById.get(Number(student.survey_decision_question_id)) || surveyDecision,
    [decisionQuestionsById, surveyDecision]
  );

  // Drives the delta beside the dropdown. Null while "All statuses" is chosen,
  // where a single figure would have nothing to describe.
  const selectedStatus = useMemo(
    () => (statusFilter ? summary.find((s) => String(s.status_id) === String(statusFilter)) || null : null),
    [statusFilter, summary]
  );

  const yearLevels = useMemo(
    () => Array.from(new Set(students.map((s) => Number(s.year_level)).filter(Boolean))).sort((a, b) => a - b),
    [students]
  );

  /*
   * Ordered and counted by the endpoint, not here: the counts describe every
   * student in scope, and this page only ever holds one page of them.
   */
  const priorityOptions = useMemo(
    () => data?.filters?.priorities || [],
    [data?.filters?.priorities]
  );

  const hasFilters = Boolean(statusFilter || priorityFilter || departmentId || courseId || yearLevel || schoolYearId || semesterId || search.trim());

  function clearFilters() {
    setStatusFilter("");
    setPriorityFilter("");
    setDepartmentId("");
    setCourseId("");
    setYearLevel("");
    setSchoolYearId("");
    setSemesterId("");
    setDecisionQuestionId("");
    setSearch("");
  }

  if (forbidden) {
    return (
      <section style={{ marginBottom: 19 }}>
        <AlertMessage tone="info" message="You do not have access to student migration." />
      </section>
    );
  }

  const scopeLabel = data?.scope?.department_name || user?.department_name || "";

  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
      <OverviewHeader
        title="Student Migration"
        subtitle={`Enrollment standing${scopeLabel ? ` in ${scopeLabel}` : ""}${term.label ? ` for ${term.label}` : ""}. Click a status to list it, or a student to see their sem history.`}
      />

      {error ? <AlertMessage tone="error" message={error} /> : null}

      {/* ---- term selector ---- */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
          padding: 9,
          background: "var(--surface-base)",
          border: "1px solid var(--border-base)",
          borderRadius: 9,
        }}
      >
        <span style={{ fontSize: 10.5, fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: 0.4 }}>
          Term
        </span>
        <select value={schoolYearId} onChange={(e) => setSchoolYearId(e.target.value)} style={controlStyle} name="student_migration_school_year">
          <option value="">{term.label ? `School year (${term.label.split(" · ")[0]})` : "School year"}</option>
          {(data?.filters?.school_years || []).map((year) => (
            <option key={year.school_year_id} value={String(year.school_year_id)}>
              {year.schoolyear_name}
            </option>
          ))}
        </select>
        <select value={semesterId} onChange={(e) => { setSemesterId(e.target.value); setDecisionQuestionId(""); }} style={controlStyle} name="student_migration_semester">
          <option value="">Semester</option>
          {(data?.filters?.semesters || []).map((semester) => (
            <option key={semester.semester_id} value={String(semester.semester_id)}>
              {semester.semester_name}
            </option>
          ))}
        </select>

        {canChooseDepartment ? (
          <select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)} style={controlStyle} name="student_migration_department">
            <option value="">All departments</option>
            {(data?.filters?.departments || []).map((dept) => (
              <option key={dept.department_id} value={String(dept.department_id)}>
                {dept.department_name}
              </option>
            ))}
          </select>
        ) : null}

        <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-faint)" }}>
          {term.has_previous ? "▲▼ compared with the previous sem" : "No earlier sem to compare with"}
        </span>
      </div>

      {/* ---- filters ---- */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 6,
          alignItems: "center",
          padding: 9,
          background: "var(--surface-base)",
          border: "1px solid var(--border-base)",
          borderRadius: 9,
        }}
      >
        {/* Every status is listed, including the empty ones: a count of 0 is an
            answer, and the old card strip had to hide them behind a toggle to
            stay readable. The count rides in the label so choosing a status no
            longer costs the figure the cards used to show. */}
        <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={controlStyle} name="student_migration_status">
          <option value="">All statuses ({data?.total_students ?? 0})</option>
          {summary.map((status) => (
            <option key={String(status.status_id)} value={String(status.status_id)}>
              {status.status_name}{status.retired ? " (retired)" : ""} ({status.student_count})
            </option>
          ))}
        </select>
        {selectedStatus ? <ChangeTag change={selectedStatus.change} /> : null}

        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              setPage(1);
              void load();
            }
          }}
          placeholder="Search student number, name or email..."
          style={{ ...controlStyle, minWidth: 221 }}
          name="student_migration_search"
        />
        <select value={courseId} onChange={(e) => setCourseId(e.target.value)} style={controlStyle} name="student_migration_course">
          <option value="">All courses</option>
          {courseOptions.map((course) => (
            <option key={course.course_id} value={String(course.course_id)}>
              {course.course_code} — {course.course_name}
              {courseCampusSuffix(course, courseOptions)}
            </option>
          ))}
        </select>
        <select value={yearLevel} onChange={(e) => setYearLevel(e.target.value)} style={controlStyle} name="student_migration_year">
          <option value="">All year levels</option>
          {yearLevels.map((year) => (
            <option key={year} value={String(year)}>{yearLevelLabel(year)}</option>
          ))}
        </select>
        {/* Priority, counted over the whole scope rather than over what is
            currently filtered - a figure that moved as you narrowed would be no
            use for deciding what to narrow to. "Not assessed" is offered as a
            choice because a student nobody has evaluated is exactly who this
            page exists to find. */}
        <select
          value={priorityFilter}
          onChange={(e) => setPriorityFilter(e.target.value)}
          style={controlStyle}
          name="student_migration_priority"
          aria-label="Priority"
          title="The student's most recent retention assessment"
        >
          <option value="">All priorities</option>
          {priorityOptions.map((option) => (
            <option key={option.priority} value={option.priority}>
              {option.label} ({option.student_count})
            </option>
          ))}
        </select>
        {hasFilters ? (
          <Button variant="secondary" size="sm" onClick={clearFilters}>
            Clear
          </Button>
        ) : null}
        <span style={{ marginLeft: "auto", color: "var(--text-faint)", fontSize: 10.5 }}>
          {loading ? "Loading…" : `${pagination.total} student${pagination.total === 1 ? "" : "s"}`}
        </span>
      </div>

      {/* ---- matrix ---- */}
      <div
        style={{
          background: "var(--surface-base)",
          border: "1px solid var(--border-base)",
          borderRadius: 9,
          padding: 11,
          display: "grid",
          gap: 9,
        }}
      >
        {/*
          * Two headers rather than a dropdown.
          *
          * These are the page's two top-level views, and a <select> hid that:
          * the second answer was only discoverable by opening a control most
          * readers took for another filter, sitting in a row of actual filters.
          * Tabs put both names on screen, which is also what the rest of the
          * portal uses for a choice of view — the retention module and the
          * survey workspace both read this way.
          *
          * The sentence under them keeps what the option labels used to say;
          * a tab is a name, not a description, but the description was the
          * useful half and is not worth losing.
          */}
        <div style={{ display: "grid", gap: 5 }}>
          <Tabs
            tabs={MATRIX_VIEWS}
            value={matrixView}
            onChange={(next) => {
              setMatrixView(next);
              try {
                window.localStorage.setItem(MATRIX_VIEW_KEY, next);
              } catch {
                // Ignore: the choice still applies for this session.
              }
            }}
            label="Matrix view"
          />
          <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>
            {MATRIX_VIEW_NOTES[matrixView] || MATRIX_VIEW_NOTES.retention}
          </p>
        </div>

        {/*
          * Both take the page's own filters, so switching the selector never
          * changes the population being described — only the question asked of
          * it. Year level is deliberately not passed: a matrix whose rows are
          * year levels, filtered to one year level, is a single row.
          */}
        {/*
          * The evaluation picks its own school year rather than taking the
          * page's term: it reviews the year that is ending, which in a 1st
          * Semester is last year, not the term the other two views show.
          */}
        {matrixView === "evaluation" ? (
          <YearEndEvaluation
            departmentId={departmentId || null}
            courseId={courseId || null}
            onOpenStudent={openHistory}
          />
        ) : matrixView === "migration" ? (
          <YearMigrationMatrix
            departmentId={departmentId || null}
            onOpenStudent={openHistory}
            courseId={courseId || null}
            schoolYearId={schoolYearId || term.school_year_id || null}
            semesterId={semesterId || term.semester_id || null}
          />
        ) : (
          <RetentionMatrix
            departmentId={departmentId || null}
            courseId={courseId || null}
            schoolYearId={schoolYearId || term.school_year_id || null}
            semesterId={semesterId || term.semester_id || null}
          />
        )}
      </div>

      {/* ---- table ---- */}
      <div style={{ marginBottom: 12 }}>
        <label htmlFor="migration-decision-source" style={{ display: "block", marginBottom: 5 }}>Enrollment decision survey / question</label>
        <select
          id="migration-decision-source"
          value={decisionQuestionId || String(surveyDecision?.question_id || "")}
          onChange={(event) => setDecisionQuestionId(event.target.value)}
          style={{ ...controlStyle, maxWidth: "100%" }}
          disabled={loading || savingId !== null}
        >
          <option value="">Choose a survey question</option>
          {(data?.filters?.decision_sources || []).map((source) => (
            <option key={source.question_id} value={String(source.question_id)}>{source.survey_title} — {source.question_text}</option>
          ))}
        </select>
        {!surveyDecision && !loading ? (
          <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
            {data?.filters?.decision_sources?.length ? "Choose the survey question to view and edit its decisions." : "No single-choice enrollment question is configured for this semester. Map its choices to active enrollment statuses in Survey Questions."}
          </p>
        ) : null}
      </div>
      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 391px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            {/* Column order mirrors the registrar's enrolment sheet, so a
                coordinator reading both is not re-mapping fields in their head.
                Name is split into its four parts for the same reason. */}
            <thead>
              <tr>
                <th style={thStyle}>Student ID</th>
                <th style={{ ...thStyle, textAlign: "center" }}>Year Level</th>
                <th style={thStyle}>Last Name</th>
                <th style={thStyle}>First Name</th>
                <th style={thStyle}>Middle Name</th>
                <th style={thStyle}>Ext.</th>
                <th style={{ ...thStyle, textAlign: "center" }}>Sex</th>
                <th style={thStyle}>Campus</th>
                <th style={{ ...thStyle, textAlign: "center" }}>Priority</th>
                <th style={thStyle}>Academic Standing</th>
                <th style={thStyle}>Balance</th>
                <th style={thStyle}>Enrollment Decision [Survey]</th>
                <th style={thStyle}>Enrollment Status</th>
                <th style={thStyle}>Update From The Student</th>
                <th style={thStyle}>History</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={MIGRATION_COLUMN_COUNT} style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>
                    Loading students…
                  </td>
                </tr>
              ) : students.length === 0 ? (
                <tr>
                  <td colSpan={MIGRATION_COLUMN_COUNT} style={{ padding: 16, textAlign: "center", color: "var(--text-muted)" }}>
                    {/*
                      * Two different nothings, and saying the wrong one sends
                      * somebody hunting for a filter they never set. The page
                      * now opens on 2nd Semester whether or not anybody has
                      * recorded decisions for it, so "no records yet" is the
                      * ordinary case early in a term -- not a mistake.
                      */}
                    {hasFilters
                      ? "No students matched these filters."
                      : "No enrollment records have been entered for "
                        + (term.label || "this term")
                        + " yet."}
                  </td>
                </tr>
              ) : (
                students.map((student) => {
                  // A leaving status with nothing written next to it is the one
                  // gap this page can actually close, so the row says so.
                  const needsRemark = statusNeedsRemark(student.status_name);
                  const remarkMissing = needsRemark && !String(student.response || "").trim();
                  const decisionQuestion = decisionQuestionFor(student);
                  const decisionChoices = decisionQuestion?.choices || [];

                  return (
                  <tr key={student.student_id}>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap", fontWeight: 600, color: "var(--text-primary)" }}>
                      {student.student_number || `ID:${student.student_id}`}
                      {/* Course and department were their own columns before the
                          sheet layout; kept here so neither is lost. */}
                      <div style={{ color: "var(--text-faint)", fontSize: 10.5, fontWeight: 400 }}>
                        {[student.course_code, data?.scope?.sees_all_departments ? student.department_name : null]
                          .filter(Boolean)
                          .join(" · ") || ""}
                      </div>
                    </td>
                    <td style={{ ...tdStyle, textAlign: "center", color: "var(--text-primary)" }}>
                      {student.year_level || "—"}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--text-primary)" }}>{student.last_name || "—"}</td>
                    <td style={{ ...tdStyle, color: "var(--text-primary)" }}>{student.first_name || "—"}</td>
                    <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>{student.middle_name || "—"}</td>
                    <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>{student.extension_name || ""}</td>
                    <td style={{ ...tdStyle, textAlign: "center", color: "var(--text-secondary)" }}>
                      {sexLabel(student.gender)}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>{campusLabel(student.campus_name)}</td>
                    <td style={{ ...tdStyle, textAlign: "center" }}>
                      <PriorityBadge
                        level={student.priority}
                        owner={student.priority_owner}
                        segment={student.segment}
                      />
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <StandingBadge
                        colour={student.grade_colour}
                        problems={student.problem_subjects}
                        total={student.total_subject}
                      />
                      <FromOtherTerm term={student.standing_term} />
                    </td>
                    <td style={{ ...tdStyle, whiteSpace: "nowrap" }}>
                      <BalanceBadge
                        band={student.balance_band}
                        colour={student.balance_colour}
                        label={student.balance_label}
                        amount={student.balance_amount}
                      />
                      <FromOtherTerm term={student.balance_term} />
                    </td>
                    {/* The student's own survey answer. Editable because staff
                        often learn the decision on a call the student never
                        turns into a submission — saving here records exactly the
                        answer they would have given, and moves their status with
                        it. A blank means unanswered, not "no". */}
                    <td style={{ ...tdStyle, color: "var(--text-secondary)", minWidth: 150 }}>
                      {canEditDecision ? (
                        <select
                          value={String(student.survey_decision_option_id || decisionChoices.find((choice) => choice.option_text === student.survey_decision)?.option_id || (student.survey_decision ? "previous" : ""))}
                          disabled={savingId === student.student_id}
                          onChange={(event) => {
                            if (event.target.value === "") return;
                            void saveDecision(student, decisionQuestion, event.target.value);
                          }}
                          style={{ ...controlStyle, width: "100%", minWidth: 140 }}
                          name={`migration_decision_${student.student_id}`}
                          aria-label={`Enrollment decision for ${student.student_number || student.student_id}`}
                        >
                          <option value="">Not answered</option>
                          {/* A decision recorded before the choices changed would
                              otherwise vanish from a select that cannot show it. */}
                          {student.survey_decision
                            && !decisionChoices.some((c) => c.option_text === student.survey_decision) ? (
                            <option value="previous" disabled>{student.survey_decision} (previous choice)</option>
                          ) : null}
                          {decisionChoices.map((choice) => (
                            <option key={choice.option_id} value={String(choice.option_id)}>
                              {choice.option_text}
                            </option>
                          ))}
                        </select>
                      ) : (
                        student.survey_decision || "—"
                      )}
                    </td>
                    <td style={tdStyle}>
                      {canEditStatus ? (
                        <select
                          value={student.status_id ? String(student.status_id) : ""}
                          disabled={savingId === student.student_id}
                          onChange={(event) =>
                            void saveRow(student, { status_type: event.target.value === "" ? null : Number(event.target.value) })
                          }
                          style={{ ...controlStyle, minWidth: 125 }}
                          name={`migration_status_${student.student_id}`}
                          aria-label={`Enrollment status for ${student.student_number || student.student_id}`}
                        >
                          <option value="">No status recorded</option>
                          {/* A status retired from the list (2026-10-06) is not
                              offered, but a record that holds one must still
                              read as it is rather than as "No status recorded". */}
                          {student.status_id
                            && !enrollmentStatuses.some((s) => String(s.status_id) === String(student.status_id)) ? (
                            <option value={String(student.status_id)} disabled>
                              {student.status_name} (retired)
                            </option>
                          ) : null}
                          {enrollmentStatuses.map((status) => (
                            <option key={status.status_id} value={String(status.status_id)}>
                              {status.status_name}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <StatusBadge statusName={student.status_name} statusId={student.status_name ? student.status_id : NO_STATUS} />
                      )}
                      {student.status_date ? (
                        <div style={{ color: "var(--text-faint)", fontSize: 10.5, marginTop: 3 }}>{student.status_date}</div>
                      ) : null}
                    </td>
                    <td style={{ ...tdStyle, color: "var(--text-secondary)", minWidth: 190 }}>
                      {canEditStatus ? (
                        // A note, not a field: what a coordinator learns on a call
                        // rarely fits one line, so this takes several and can be
                        // dragged taller. Committed on blur rather than per
                        // keystroke - one save per edit instead of one per
                        // character - which also leaves Enter free for newlines.
                        <textarea
                          defaultValue={student.response || ""}
                          key={`resp-${student.student_id}-${student.response || ""}`}
                          disabled={savingId === student.student_id}
                          rows={2}
                          onBlur={(event) => {
                            const next = event.target.value.trim();
                            if (next === (student.response || "").trim()) return;
                            void saveRow(student, { response: next === "" ? null : next });
                          }}
                          placeholder={needsRemark ? "Reason, e.g. personal problem" : "Add a note about this student…"}
                          style={{
                            ...controlStyle,
                            width: "100%",
                            minWidth: 170,
                            resize: "vertical",
                            // Textareas default to a monospace stack; without this
                            // the note reads in a different face to every other
                            // cell in the row.
                            fontFamily: "inherit",
                            lineHeight: 1.4,
                            ...(remarkMissing
                              ? { borderColor: "var(--warning-800)", background: "var(--warning-50)" }
                              : null),
                          }}
                          name={`migration_response_${student.student_id}`}
                          aria-label={`Note about ${student.student_number || student.student_id}`}
                        />
                      ) : (
                        // pre-wrap so a multi-line note still reads as it was typed
                        // for viewers who cannot edit it.
                        <span style={{ whiteSpace: "pre-wrap" }}>{student.response || "—"}</span>
                      )}
                      {/* Nudge, not a block: the coordinator often sets the status
                          before they have spoken to the student and learned why. */}
                      {remarkMissing ? (
                        <div style={{ color: "var(--warning-800)", fontSize: 10.5, fontWeight: 600, marginTop: 3 }}>
                          Add why they are “{student.status_name}”
                        </div>
                      ) : null}
                      {Number(student.failed_terms) > 0 ? (
                        <div style={{ color: "var(--danger-800)", fontSize: 10.5, fontWeight: 700, marginTop: 3 }}>
                          {student.failed_terms} problem sem{Number(student.failed_terms) === 1 ? "" : "s"}
                        </div>
                      ) : null}
                    </td>
                    <td style={tdStyle}>
                      <Button variant="secondary" size="sm" onClick={() => void openHistory(student)}>
                        View
                      </Button>
                    </td>
                  </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {pagination.pages > 1 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 6,
              padding: 9,
              borderTop: "1px solid var(--border-base)",
            }}
          >
            <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
              Page {pagination.page} of {pagination.pages}
            </span>
            <div style={{ display: "flex", gap: 6 }}>
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pagination.page <= 1 || loading}>
                Previous
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setPage((p) => p + 1)} disabled={pagination.page >= pagination.pages || loading}>
                Next
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      {/* ---- per-student term history ---- */}
      <Modal
        open={Boolean(history)}
        title={
          history?.student
            ? `${history.student.student_number || history.student.student_id} — sem history`
            : "Term history"
        }
        onClose={() => setHistory(null)}
        width={646}
      >
        {history?.student ? (
          <div style={{ marginBottom: 9, color: "var(--text-secondary)", fontSize: 11.5 }}>
            {`${history.student.last_name || ""}, ${history.student.first_name || ""}`.replace(/^, |, $/g, "")}
            {history.student.course_code ? ` · ${history.student.course_code}` : ""}
            {history.student.year_level ? ` · ${yearLevelLabel(history.student.year_level)}` : ""}
            {history.student.section ? ` · ${history.student.section}` : ""}
          </div>
        ) : null}

        {history?.error ? <AlertMessage tone="error" message={history.error} /> : null}

        {historyLoading || history?.rows === null ? (
          <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>Loading history…</div>
        ) : (history?.rows || []).length === 0 ? (
          <AlertMessage tone="info" message="No enrollment or grade records on file for this student yet." />
        ) : (
          <div style={{ overflow: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, position: "static" }}>Term</th>
                  <th style={{ ...thStyle, position: "static" }}>Status</th>
                  <th style={{ ...thStyle, position: "static" }}>Subjects</th>
                  <th style={{ ...thStyle, position: "static" }}>Problems</th>
                  <th style={{ ...thStyle, position: "static" }}>Remark</th>
                </tr>
              </thead>
              <tbody>
                {history.rows.map((row, index) => {
                  const problems =
                    Number(row.failed || 0) + Number(row.incomplete || 0) + Number(row.no_credit || 0) + Number(row.no_grade || 0);
                  const parts = [
                    Number(row.failed) ? `${row.failed} failed` : null,
                    Number(row.incomplete) ? `${row.incomplete} INC` : null,
                    Number(row.no_credit) ? `${row.no_credit} NC` : null,
                    Number(row.no_grade) ? `${row.no_grade} NG` : null,
                  ].filter(Boolean);

                  return (
                    <tr key={`${row.school_year_id}-${row.semester_id}-${index}`}>
                      <td style={tdStyle}>
                        <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{row.schoolyear_name || "Unknown year"}</div>
                        <div style={{ color: "var(--text-faint)", fontSize: 10.5 }}>{row.semester_name || "Unknown semester"}</div>
                      </td>
                      <td style={tdStyle}>
                        <StatusBadge statusName={row.status_name} statusId={row.status_name ? row.status_id : NO_STATUS} />
                        {row.decision ? (
                          <div style={{ color: "var(--text-faint)", fontSize: 10.5, marginTop: 3 }}>{row.decision}</div>
                        ) : null}
                        {/* The remark sits under the status it explains: reading
                            "To Stop" and "personal problem" apart loses the link. */}
                        {row.response ? (
                          <div style={{ color: "var(--text-secondary)", fontSize: 10.5, marginTop: 3, fontStyle: "italic", whiteSpace: "pre-wrap" }}>
                            “{row.response}”
                          </div>
                        ) : null}
                      </td>
                      <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>
                        {row.total_subject === null
                          ? "No grades filed"
                          : `${row.passed ?? 0} of ${row.total_subject} passed`}
                      </td>
                      <td style={tdStyle}>
                        {row.total_subject === null ? (
                          <span style={{ color: "var(--text-faint)" }}>—</span>
                        ) : problems === 0 ? (
                          <span style={{ color: "var(--brand-800)", fontWeight: 600 }}>Clean</span>
                        ) : (
                          <span style={{ color: "var(--danger-800)", fontWeight: 600 }}>{parts.join(", ")}</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, color: "var(--text-secondary)" }}>{row.remark_name || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Modal>
    </section>
  );
}
