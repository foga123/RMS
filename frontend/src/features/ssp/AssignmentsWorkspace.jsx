import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as dateTime from "../../shared/lib/dateTime";
import { canModuleAction } from "../../shared/lib/roleAccess";
import {
  STUDENT_TYPE_LABEL,
  STUDENT_TYPE_NON_STAR,
  STUDENT_TYPE_STAR,
  coachRoleFor,
} from "../../shared/lib/studentType";
import { getBackendUrl } from "../../shared/lib/url";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { formatStudentName } from "../../shared/lib/studentName";
import { confirmAction } from "../../shared/lib/notify";
import { PRIORITY_BANDS, UNRANKED_ACCENT } from "../../shared/lib/priorityAccent";
import usePagedRows from "../../shared/hooks/usePagedRows";
import Pagination from "../../shared/components/ui/Pagination";
import ImportDialog from "../../shared/components/import/ImportDialog";
import AlertMessage from "../../shared/components/ui/AlertMessage";

/**
 * The SSP student-assignment board.
 *
 * This used to live inline inside SspCoordinatorPage, which meant the
 * `assignments` module had no entry in MODULE_COMPONENTS — so every other role
 * granted it (Admin included) landed on the "this module is not wired yet"
 * placeholder instead of the workspace that already existed. Pulling it out
 * here is what lets one implementation serve both.
 *
 * It loads its own data so it can be dropped anywhere a module page is
 * rendered, with no props beyond the permission list.
 */

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 9px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

const thStyle = {
  padding: 9,
  position: "sticky",
  top: 0,
  background: "var(--surface-page)",
  borderBottom: "1px solid var(--border-base)",
  zIndex: 1,
};

const tdStyle = { padding: 9, borderBottom: "1px solid var(--border-base)" };

/*
 * How urgent this student is, from the RETENTION & MIGRATION segment matrix.
 *
 * This replaced a High/Moderate/Low "risk" badge. The board is ranked by the
 * sheet's Priority 1-4, computed server-side by the same code the Contact
 * Workspace and the PDO Prioritization screen use - so the same student reads
 * the same on all three screens a caller works in. Two scales for "how bad is
 * this" is how somebody ends up working the wrong list.
 *
 * The palette runs from alarm to all-clear rather than through four unrelated
 * hues, so the ordering is legible without reading the labels.
 */
const PRIORITY_BADGE_TONES = {
  1: { background: "#fee2e2", color: "#991b1b", borderColor: "#fecaca" },
  2: { background: "#fef3c7", color: "#92400e", borderColor: "#fcd34d" },
  3: { background: "#dbeafe", color: "#1e40af", borderColor: "#bfdbfe" },
  4: { background: "#dcfce7", color: "#166534", borderColor: "#bbf7d0" },
};

const UNRANKED_BADGE_TONE = { background: "#f1f5f9", color: "#64748b", borderColor: "#cbd5e1" };

function priorityBadgeStyle(level) {
  const tone = PRIORITY_BADGE_TONES[level] || UNRANKED_BADGE_TONE;
  return {
    display: "inline-block",
    padding: "1px 7px",
    borderRadius: 999,
    border: `1px solid ${tone.borderColor}`,
    background: tone.background,
    color: tone.color,
    fontWeight: 600,
  };
}

function priorityLabel(level, owner) {
  // "Not ranked" rather than a default level: a student the classifier has not
  // placed is a gap to notice, not a Priority 4 to relax about.
  if (!PRIORITY_BADGE_TONES[level]) return "Not ranked";
  return `P${level}${owner ? ` · ${owner}` : ""}`;
}

/*
 * What the board can show, in the order the "Show" dropdown lists them.
 *
 * A dropdown rather than the row of tabs it replaced: six choices with counts
 * did not fit one line on a laptop, and the tabs read as separate pages when
 * they are one list filtered. Each priority names who the matrix routes it to -
 * P1 to the College, the rest to the coaches - from PRIORITY_BANDS, the same
 * owners every other priority readout shows.
 *
 * "All students" is every student under this account with their priorities
 * mixed, worst first. "No survey yet" stays its own entry: never answering the
 * survey is a different question from academic risk.
 */
const QUEUE_HINTS = {
  1: "Worst standing on the matrix - the band the sheet routes to the College",
  2: "Two signals wrong, or one badly",
  3: "Something wrong, but not yet urgent",
  4: "Attending, passing, nothing owed",
};

const QUEUE_OPTIONS = [
  { key: "all", label: "All students", accent: UNRANKED_ACCENT, hint: "Every student under you, all priorities mixed, worst first" },
  ...PRIORITY_BANDS.map((band) => ({
    key: String(band.level),
    label: `P${band.level} · ${band.owner}`,
    accent: band.accent,
    hint: QUEUE_HINTS[band.level],
  })),
  { key: "survey", label: "No survey yet", accent: "#a78bfa", hint: "Never submitted a survey. Counted apart from the priorities, not instead of them" },
];

const CHIP_TONES = {
  good: { background: "#dcfce7", color: "#166534", borderColor: "#bbf7d0" },
  warn: { background: "#fef3c7", color: "#92400e", borderColor: "#fcd34d" },
  muted: { background: "#f1f5f9", color: "#475569", borderColor: "#cbd5e1" },
};

function Chip({ tone = "muted", children }) {
  const palette = CHIP_TONES[tone] || CHIP_TONES.muted;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 999,
        border: `1px solid ${palette.borderColor}`,
        background: palette.background,
        color: palette.color,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

const formatDay = (value) => dateTime.formatDate(value, { fallback: "" });

/**
 * Has the student answered a survey, and what did they say about enrolling.
 *
 * The answer comes from the server, resolved by the same code that turns a
 * submission into an enrollment standing - so "Will Enroll" here is the status
 * the survey itself wrote, not a second reading of the student's words.
 */
function SurveyStatusCell({ survey }) {
  if (!survey?.submitted) {
    return <Chip tone="warn">No survey yet</Chip>;
  }

  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
        <Chip tone="good">Answered</Chip>
        {survey.submitted_at ? (
          <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{formatDay(survey.submitted_at)}</span>
        ) : null}
      </div>
      {survey.answer ? (
        <div style={{ color: "var(--text-primary)", fontSize: 11.5 }}>
          <span style={{ fontWeight: 600 }}>{survey.answer_status || "Answer"}:</span> {survey.answer}
        </div>
      ) : (
        <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>No enrollment answer given</div>
      )}
      <div style={{ color: "var(--text-faint)", fontSize: 10.5 }}>
        {survey.answer_survey_title || survey.survey_title || "Survey"}
        {survey.submission_count > 1 ? ` · ${survey.submission_count} submissions` : ""}
      </div>
    </div>
  );
}

/**
 * Enrolled or not, for the upcoming term, as SSG has recorded it.
 *
 * Only the "Enrolled" standing counts. Anything else on the term's record - the
 * student's own "Will Enroll" from the survey, a "To Transfer" - is shown by
 * name under the verdict, because it is what SSG will be acting on.
 */
function EnrollmentStatusCell({ enrollment, term }) {
  if (!term?.label) {
    return <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>No upcoming term set</span>;
  }
  if (enrollment?.is_enrolled) {
    return <Chip tone="good">Enrolled</Chip>;
  }

  return (
    <div style={{ display: "grid", gap: 3 }}>
      <div><Chip tone="muted">Not yet enrolled</Chip></div>
      {enrollment?.status_name ? (
        <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Recorded: {enrollment.status_name}</div>
      ) : null}
    </div>
  );
}


function buildCallerName(caller) {
  return `${caller?.first_name || ""} ${caller?.last_name || ""}`.trim() || caller?.email || `User #${caller?.user_id || ""}`;
}

/** Assignments a student already holds, tolerating a response without the field. */
function assignmentsOf(student) {
  return Array.isArray(student?.assignments) ? student.assignments : [];
}

/*
 * Coaches.
 *
 * A student has ONE assignee, their coach: the worker of their unit - an SSP
 * Caller for a Non-STAR student, a KASAMA for a STAR one. The server reports it
 * as `student.coach` and `student.coaching_unit`, and choosing another coach
 * replaces the first (ssp_assignment.php, student_set_coach()). Supervisors are
 * not assigned students since 2026-10-01; before that the board stored a coach
 * and supervisor pair, and the supervisor read as a second coach.
 */
export function hasCoach(student) {
  return Boolean(student?.coach);
}

/** The coach role id for a student's cohort - 6 for SSP, 12 for KASAMA. */
function coachRoleIdFor(student) {
  return coachRoleFor(student?.student_type)?.roleId ?? null;
}

/** Active coaches of the student's own unit, to choose from. */
function coachesForStudent(callers, student) {
  const roleId = coachRoleIdFor(student);
  return (Array.isArray(callers) ? callers : []).filter(
    (caller) => Number(caller?.role_id) === roleId && Number(caller?.status) === 1
  );
}

const COACH_UNIT_BY_ROLE = { 6: "SSP", 12: "KASAMA" };

/** Every coach account on the board, of either unit - for the filter. */
function allCoaches(callers) {
  return (Array.isArray(callers) ? callers : []).filter((caller) => COACH_UNIT_BY_ROLE[Number(caller?.role_id)]);
}

/** "Maria Cruz: 3, Jose Reyes: 2" - whose students a reassignment takes. */
function previousCoachSummary(students) {
  const counts = new Map();
  students.forEach((student) => {
    const name = student.coach?.name || student.coach?.email || `User #${student.coach?.user_id}`;
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  const named = [...counts].map(([name, count]) => `${name}: ${count}`);
  return named.length > 4 ? `${named.slice(0, 4).join(", ")} and ${named.length - 4} more` : named.join(", ");
}

/** What the top bar's Assign did, from the server's own count. */
function tickedResultMessage(coachName, summary) {
  const parts = [
    summary.assigned ? `${summary.assigned} assigned` : "",
    summary.reassigned ? `${summary.reassigned} reassigned` : "",
    summary.unchanged ? `${summary.unchanged} already theirs` : "",
  ].filter(Boolean);
  return parts.length ? `${coachName} is now their coach: ${parts.join(", ")}.` : "No student was changed.";
}

/*
 * The coach file's columns. Named as the office names them; the server also
 * accepts "Student No." and the workbook's "FROM FACULTY /SSP ADVISER" heading
 * for the coach, so the College's own sheet can be saved as CSV and uploaded.
 */
const COACH_IMPORT_COLUMNS = [
  { name: "Student Number", required: true, example: "02-2526-000001", hint: "As it appears on the student's record." },
  { name: "Coach", required: true, example: "coach@email.com", hint: "The coach's email, or their name as it is on their account." },
  { name: "Coaching Unit", required: false, example: "SSP", hint: "SSP or KASAMA. Checked against the student if you fill it in." },
];

export default function AssignmentsWorkspace({ permissions = [] }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [callers, setCallers] = useState([]);
  const [students, setStudents] = useState([]);
  const [search, setSearch] = useState("");
  const [callerFilter, setCallerFilter] = useState("");
  const [typeFilter, setTypeFilter] = useState("");
  /*
   * Which band of the follow-up queue is on screen.
   *
   * The band IS the PDO priority — "1" through "4" — so the tab a caller works
   * and the badge on the row say the same thing. It used to be one "priority"
   * band meaning whatever the evaluator had scored moderate or high, which
   * depended on somebody having pressed Run Evaluation: on 2026-09-18 that was
   * 3 students out of 2,776, so the call list held ONE person while everyone
   * else sat under "no survey yet".
   *
   * "survey" stays a band of its own rather than becoming a fifth priority.
   * Never submitting a survey is a different question from academic risk and
   * covers most of the cohort, so folding it in would bury the students who
   * need a phone call under the ones who have not filled a form in.
   *
   * Backed by lib/follow_up_queue.php, which defines the same bands server-side
   * off the same matrix the row badges are drawn from.
   */
  const [queue, setQueue] = useState("1");
  const [queueCounts, setQueueCounts] = useState({ all: 0, 1: 0, 2: 0, 3: 0, 4: 0, survey: 0 });
  const [selectedCallerByStudent, setSelectedCallerByStudent] = useState({});
  const [assigningStudentId, setAssigningStudentId] = useState(null);
  const [autoAssigningStudentId, setAutoAssigningStudentId] = useState(null);
  const [bulkAssigning, setBulkAssigning] = useState(false);
  const [removingAssignmentId, setRemovingAssignmentId] = useState(null);
  /*
   * Rows ticked for the top bar's Assign / Reassign - the row's own control, for
   * many students at once. Cleared whenever the list under them changes, so a
   * tick can never act on a row that is no longer on screen.
   */
  const [tickedIds, setTickedIds] = useState(() => new Set());
  const [tickedCoachId, setTickedCoachId] = useState("");
  const [savingTicked, setSavingTicked] = useState(false);
  /*
   * When a student may be added to a team, as the server reports it.
   *
   * Not computed here from the current periodical: the rule and the calendar
   * would then both live in the browser, and the board could offer a control
   * the endpoint refuses. The server sends what it will apply and this prints
   * it. Same arrangement as `case_window` on the faculty board.
   */
  const [assignmentWindow, setAssignmentWindow] = useState(null);
  /*
   * The one cohort this board is limited to, as the server applied it - "STAR"
   * for a KSH TL, "Non-STAR" for the SSP Coordinator, null for Admin. With a
   * scope the type filter could only ever match everything or nothing, so it
   * is not drawn.
   */
  const [typeScope, setTypeScope] = useState(null);
  /*
   * Off for the SSP Coordinator and KSH TL, who choose each coach themselves.
   * Read from the server, which also refuses the request - so hiding the
   * button is presentation, not the rule. Starts off so it never flashes on.
   */
  const [canAutoAssign, setCanAutoAssign] = useState(false);
  // The term the Enrollment Status column reports on - the one after this.
  const [enrollmentTerm, setEnrollmentTerm] = useState(null);
  const [importOpen, setImportOpen] = useState(false);

  const canAssignStudents = canModuleAction(permissions, "assign")
    || canModuleAction(permissions, "create")
    || canModuleAction(permissions, "edit");
  const canUnassignStudents = canModuleAction(permissions, "delete") || canAssignStudents;

  /*
   * Permission AND timing. Two different reasons the button is off, and they
   * are kept apart deliberately: `canAssignStudents` answers "may this person
   * ever assign", this answers "may anyone assign today".
   *
   * `!== false` rather than a truth test, so a response without the field --
   * an older backend, or a shape this component is reused against -- leaves
   * the board working rather than silently locking it for everyone.
   *
   * REMOVAL IS NOT GATED. canUnassignStudents above is untouched: a calendar
   * that has rolled past P3 must not strand work already in flight, and a
   * mistake has to be undoable the moment it is spotted.
   */
  const windowOpen = assignmentWindow?.can_assign !== false;
  const canAddToTeam = canAssignStudents && windowOpen;

  const loadBoard = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl(`ssp_assignment.php?queue=${encodeURIComponent(queue)}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to load student assignments");

      const nextCallers = Array.isArray(data?.callers) ? data.callers : [];
      // A caller's own board comes back under `assignments`; a supervisor's under
      // `students`. Both are board rows of the same shape.
      const nextStudents = Array.isArray(data?.students)
        ? data.students
        : (Array.isArray(data?.assignments) ? data.assignments : []);
      setCallers(nextCallers);
      setStudents(nextStudents);
      setQueueCounts(data?.queue_counts || { all: 0, 1: 0, 2: 0, 3: 0, 4: 0, survey: 0 });
      setAssignmentWindow(data?.assignment_window || null);
      setTypeScope(data?.student_type_scope || null);
      setCanAutoAssign(data?.can_auto_assign === true);
      setEnrollmentTerm(data?.enrollment_term || null);
      // Cleared, not seeded with whoever is already on the team. The control
      // adds a member rather than replacing one, so pre-selecting an existing
      // member would leave Add permanently disabled against its own default.
      setSelectedCallerByStudent({});
      setTickedIds(new Set());
      setTickedCoachId("");
    } catch (loadError) {
      setCallers([]);
      setStudents([]);
      setSelectedCallerByStudent({});
      setTickedIds(new Set());
      setAssignmentWindow(null);
      setError(loadError?.message || "Failed to load student assignments");
    } finally {
      setLoading(false);
    }
  }, [queue]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  const filteredStudents = useMemo(() => {
    const query = search.trim().toLowerCase();
    const type = typeFilter.trim().toLowerCase();
    return students.filter((student) => {
      const assignments = assignmentsOf(student);

      // "Incomplete" rather than "has nobody": a student holding a caller but
      // no coordinator is exactly the row this filter is meant to surface, and
      // the old `assignment_id` test would have hidden them.
      if (callerFilter === "no_coach" && hasCoach(student)) return false;
      if (
        callerFilter
        && callerFilter !== "no_coach"
        && !assignments.some((assignment) => String(assignment?.caller_user_id || "") === callerFilter)
      ) {
        return false;
      }
      if (type && String(student?.student_type || "").trim().toLowerCase() !== type) return false;
      if (!query) return true;

      const haystack = [
        student?.student_number,
        student?.first_name,
        student?.last_name,
        student?.course_name,
        student?.course_code,
        student?.department_name,
        student?.decision,
        student?.enrollment_status_name,
        student?.survey?.answer,
        student?.survey?.answer_status,
        student?.next_enrollment?.status_name,
        ...assignments.map((assignment) => assignment?.caller_name),
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [callerFilter, search, students, typeFilter]);

  const uncoachedCount = useMemo(
    () => filteredStudents.filter((student) => !hasCoach(student)).length,
    [filteredStudents]
  );

  /*
   * Only one page of rows is rendered.
   *
   * The "No survey yet" band is 367 students against 24 who have submitted one,
   * and every row here carries a caller picker, a team of chips and two action
   * buttons. Rendering the whole band built several thousand DOM nodes on every
   * keystroke in the search box, which is what made this screen feel slow — the
   * server answers the query in about 45ms.
   *
   * Client-side rather than a server page: the counts above, the bulk-assign
   * action and the search all read the whole band, so the data has to be in hand
   * anyway. This just stops the browser drawing all of it at once.
   */
  const pagedStudents = usePagedRows(filteredStudents, 20);

  // A filter changes which rows are on screen, so ticks made in the old list go.
  useEffect(() => {
    setTickedIds((ticked) => (ticked.size ? new Set() : ticked));
  }, [callerFilter, search, typeFilter]);

  const tickedStudents = useMemo(
    () => filteredStudents.filter((student) => tickedIds.has(student.student_id)),
    [filteredStudents, tickedIds]
  );
  /*
   * The coaches every ticked student can take, which is one unit's. Ticks that
   * span both units - only Admin sees both cohorts - offer none, rather than a
   * coach the server would then refuse for half of them.
   */
  const tickedUnitCount = new Set(tickedStudents.map((student) => coachRoleIdFor(student) ?? null)).size;
  const tickedCoachChoices = useMemo(() => {
    const roleIds = new Set(tickedStudents.map((student) => coachRoleIdFor(student) ?? null));
    return roleIds.size === 1 && !roleIds.has(null) ? coachesForStudent(callers, tickedStudents[0]) : [];
  }, [callers, tickedStudents]);
  const tickedCoach = tickedCoachChoices.find((caller) => String(caller.user_id) === tickedCoachId) || null;
  const pageIds = pagedStudents.rows.map((student) => student.student_id);
  const pageAllTicked = pageIds.length > 0 && pageIds.every((id) => tickedIds.has(id));
  const pageSomeTicked = pageIds.some((id) => tickedIds.has(id));

  const activeQueue = QUEUE_OPTIONS.find((option) => option.key === queue) || QUEUE_OPTIONS[0];

  // Two optional columns: the tick, for anyone who may assign, and Action,
  // which holds auto-assign and is Admin's alone.
  const columnCount = 8 + (canAssignStudents ? 1 : 0) + (canAutoAssign ? 1 : 0);

  async function assignStudent(studentId) {
    if (!canAssignStudents) {
      setError("You do not have permission to assign students.");
      setSuccess("");
      return;
    }
    const callerUserId = selectedCallerByStudent[String(studentId)] || "";
    if (!callerUserId) {
      setError("Choose a coach first.");
      setSuccess("");
      return;
    }

    setAssigningStudentId(studentId);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl("ssp_assignment.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ student_id: studentId, caller_user_id: Number(callerUserId) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to assign student");
      setSuccess(data?.message || "Student assignment saved.");
      await loadBoard();
    } catch (assignError) {
      setError(assignError?.message || "Failed to assign student");
    } finally {
      setAssigningStudentId(null);
    }
  }

  function toggleTick(studentId) {
    setTickedIds((ticked) => {
      const next = new Set(ticked);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  }

  function togglePageTicks() {
    setTickedIds((ticked) => {
      const next = new Set(ticked);
      pageIds.forEach((id) => (pageAllTicked ? next.delete(id) : next.add(id)));
      return next;
    });
  }

  /**
   * The row's Assign / Reassign, for every ticked student: each ends with the
   * chosen coach and no other, since a student has one coach. One request, so
   * the server writes the batch in one transaction and checks every student as
   * it would a single row.
   */
  async function assignTickedStudents() {
    const coach = tickedCoach;
    if (!canAddToTeam || !coach || tickedStudents.length === 0) return;

    // A row's Reassign moves the one student in front of you; this can move a
    // coach's whole caseload, so who loses a coach is said before it happens.
    const moving = tickedStudents.filter(
      (student) => hasCoach(student) && Number(student.coach.user_id) !== Number(coach.user_id)
    );
    if (moving.length > 0) {
      const confirmed = await confirmAction({
        title: `Reassign ${moving.length} ${moving.length === 1 ? "student" : "students"}?`,
        text: `${moving.length} of the ${tickedStudents.length} ticked already ${moving.length === 1 ? "has a coach" : "have a coach"} (${previousCoachSummary(moving)}). They will be moved to ${buildCallerName(coach)}.`,
        confirmButtonText: "Reassign",
        cancelButtonText: "Cancel",
      });
      if (!confirmed) return;
    }

    setSavingTicked(true);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl("ssp_assignment.php?action=set_coach"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          student_ids: tickedStudents.map((student) => student.student_id),
          caller_user_id: Number(coach.user_id),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to assign the coach");

      // Reloading clears the error line, so the skips are written after it.
      await loadBoard();
      setSuccess(tickedResultMessage(buildCallerName(coach), data?.summary || {}));
      const skipped = data?.details?.row_errors || [];
      if (skipped.length > 0) {
        setError(`${skipped.length} skipped - ${skipped.slice(0, 3).join(" ")}${skipped.length > 3 ? " ..." : ""}`);
      }
    } catch (tickedError) {
      setError(tickedError?.message || "Failed to assign the coach");
    } finally {
      setSavingTicked(false);
    }
  }

  /**
   * Give a student the least-loaded coach of their unit (Admin only).
   *
   * The server picks the coach — it is the only side that can see everyone's
   * caseload, and letting the browser choose would hand two coordinators the
   * same student whenever two of them had the board open.
   */
  async function autoAssign(studentId) {
    if (!canAssignStudents) {
      setError("You do not have permission to assign students.");
      setSuccess("");
      return;
    }

    setAutoAssigningStudentId(studentId);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl("ssp_assignment.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ student_id: studentId, auto: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to assign a coach");
      setSuccess(data?.message || "Coach assigned.");
      await loadBoard();
    } catch (autoError) {
      setError(autoError?.message || "Failed to assign a coach");
    } finally {
      setAutoAssigningStudentId(null);
    }
  }

  /**
   * The same, for every visible student who has no coach.
   *
   * Sequential rather than Promise.all: each call reads the caseloads to pick
   * the least-loaded person, so firing them together would have every request
   * read the same starting numbers and hand the whole batch to one caller.
   */
  async function autoAssignAll() {
    const pending = filteredStudents.filter((student) => !hasCoach(student));
    if (pending.length === 0) return;

    setBulkAssigning(true);
    setError("");
    setSuccess("");

    let filled = 0;
    const failures = [];
    for (const student of pending) {
      try {
        const res = await fetch(getBackendUrl("ssp_assignment.php"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ student_id: student.student_id, auto: true }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.message || "Assignment refused");
        filled += 1;
      } catch (bulkError) {
        failures.push(`${formatStudentName(student)}: ${bulkError?.message || "failed"}`);
      }
    }

    await loadBoard();
    setBulkAssigning(false);

    if (filled > 0) {
      setSuccess(`Gave ${filled} ${filled === 1 ? "student a coach" : "students a coach"}.`);
    }
    if (failures.length > 0) {
      // Named, not counted: "3 failed" gives nobody anything to act on.
      setError(`${failures.length} could not be assigned - ${failures.slice(0, 3).join("; ")}${failures.length > 3 ? "; ..." : ""}`);
    }
  }

  async function unassignStudent(assignmentId) {
    if (!canUnassignStudents) {
      setError("You do not have permission to remove assignments.");
      setSuccess("");
      return;
    }
    if (!assignmentId) return;

    setRemovingAssignmentId(assignmentId);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl(`ssp_assignment.php?assignment_id=${encodeURIComponent(assignmentId)}`), {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to remove assignment");
      setSuccess(data?.message || "Assignment removed.");
      await loadBoard();
    } catch (removeError) {
      setError(removeError?.message || "Failed to remove assignment");
    } finally {
      setRemovingAssignmentId(null);
    }
  }

  function coachImportForm(file, dryRun) {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("dry_run", dryRun ? "1" : "0");
    return formData;
  }

  /**
   * Upload the coach file. The server matches every row and writes them in one
   * transaction, so an import lands whole or not at all.
   */
  async function importCoaches(file) {
    const response = await fetch(getBackendUrl("ssp_assignment.php?action=import_coaches"), {
      method: "POST",
      body: coachImportForm(file, false),
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || "Failed to import coaches.");
    await loadBoard();
    return payload;
  }

  /**
   * What the file would do, before it does it: the same request as a dry run.
   *
   * Asks for confirmation only when the file would REPLACE somebody's coach or
   * skip rows. A file that only fills empty slots goes straight through, as
   * the dialog's other importers do for new records.
   */
  async function precheckCoaches(file) {
    const response = await fetch(getBackendUrl("ssp_assignment.php?action=import_coaches"), {
      method: "POST",
      body: coachImportForm(file, true),
      credentials: "include",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || "The file could not be checked.");

    const summary = payload?.summary || {};
    const reassigned = payload?.details?.reassigned || [];
    const skipped = payload?.details?.row_errors || [];
    if (!summary.reassigned && !summary.skipped) return null;

    return {
      headline: `${summary.assigned || 0} to assign, ${summary.reassigned || 0} to reassign, ${summary.unchanged || 0} already right, ${summary.skipped || 0} skipped.`,
      lines: [
        ...reassigned.slice(0, 6).map((line) => `Reassign ${line}`),
        ...(reassigned.length > 6 ? [`...and ${reassigned.length - 6} more reassignments`] : []),
        ...skipped.slice(0, 4),
        ...(skipped.length > 4 ? [`...and ${skipped.length - 4} more skipped rows`] : []),
      ],
      confirmLabel: summary.reassigned ? "Replace these coaches" : "Import the rest",
    };
  }

  return (
    <>
      <AlertMessage message={error} tone="error" />
      <AlertMessage message={success} tone="success" />

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <div style={{ padding: 9, borderBottom: "1px solid var(--border-base)", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <label
              style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}
            >
              <span
                aria-hidden="true"
                style={{ width: 9, height: 9, borderRadius: 999, background: activeQueue.accent, flexShrink: 0 }}
              />
              Show
              <select
                value={queue}
                onChange={(event) => setQueue(event.target.value)}
                title={activeQueue.hint}
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 190, background: "#fff", fontWeight: 600, color: "var(--text-primary)" }}
                name="ssp_assignment_queue"
              >
                {QUEUE_OPTIONS.map((option) => (
                  <option key={option.key} value={option.key}>
                    {option.label} ({Number(queueCounts?.[option.key] || 0).toLocaleString()})
                  </option>
                ))}
              </select>
            </label>
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search name, number, coach..."
              style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 204 }}
              name="ssp_assignment_search"
            />
            {typeScope ? (
              <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>
                {typeScope} students only
              </span>
            ) : (
              <select
                value={typeFilter}
                onChange={(event) => setTypeFilter(event.target.value)}
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 136, background: "#fff" }}
                name="ssp_assignment_type_filter"
              >
                {/* The values are sent to the server as a WHERE clause on
                     student.student_type, so they have to be the stored spellings
                     rather than display words. "Nonstar" stopped matching anything
                     when the vocabulary changed on 2026-08-21. */}
                <option value="">All {STUDENT_TYPE_LABEL}</option>
                <option value={STUDENT_TYPE_STAR}>{STUDENT_TYPE_STAR} (KASAMA)</option>
                <option value={STUDENT_TYPE_NON_STAR}>{STUDENT_TYPE_NON_STAR} (SSP)</option>
              </select>
            )}
            <select
              value={callerFilter}
              onChange={(event) => setCallerFilter(event.target.value)}
              style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 187, background: "#fff" }}
              name="ssp_assignment_caller_filter"
            >
              <option value="">All coaches</option>
              <option value="no_coach">No coach yet</option>
              {allCoaches(callers).map((caller) => (
                <option key={caller.user_id} value={String(caller.user_id)}>
                  {buildCallerName(caller)} ({COACH_UNIT_BY_ROLE[Number(caller.role_id)]})
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            {canAutoAssign && canAddToTeam && uncoachedCount > 0 ? (
              <button
                type="button"
                onClick={() => void autoAssignAll()}
                disabled={bulkAssigning || loading}
                title="Give every student below who has no coach the least-loaded coach of their unit"
                style={{ ...buttonStyle, background: "var(--brand-800)", color: "#fff", opacity: bulkAssigning || loading ? 0.6 : 1 }}
              >
                {bulkAssigning ? "Assigning..." : `Auto-assign ${uncoachedCount} shown`}
              </button>
            ) : null}

            {/*
              * Why the controls are off, on the board rather than at Save.
              *
              * Without it somebody picks a student, picks a caller, presses Add
              * and only then learns that assignment does not open until P3 --
              * the work of choosing having already been done. The sentence is
              * the server's own refusal text, so the two cannot disagree.
              */}
            {canAssignStudents && !windowOpen && assignmentWindow?.reason ? (
              <span
                style={{
                  fontSize: 11,
                  lineHeight: 1.4,
                  color: "var(--warning-800)",
                  background: "var(--warning-50)",
                  border: "1px solid var(--warning-200)",
                  borderRadius: 6,
                  padding: "5px 8px",
                  maxWidth: 420,
                }}
              >
                {assignmentWindow.reason}
              </span>
            ) : null}

            {canAssignStudents ? (
              <button
                type="button"
                onClick={() => setImportOpen(true)}
                title="Assign or reassign coaches from a CSV or Excel file of student numbers"
                style={{ ...buttonStyle, background: "var(--surface-base)", color: "var(--brand-800)", border: "1px solid var(--brand-300, var(--border-strong))" }}
              >
                Import coaches
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => void loadBoard()}
              disabled={loading}
              style={{ ...buttonStyle, background: "var(--brand-700)", color: "#fff", opacity: loading ? 0.75 : 1 }}
            >
              {loading ? "Refreshing..." : "Refresh"}
            </button>
          </div>
        </div>

        {/*
          * The top bar's coach control: a row's Assign / Reassign for every
          * ticked student at once. A student has one coach, so the chosen coach
          * replaces whoever each of them had. "All coaches" above stays a
          * filter - it is how one coach's students are found before moving them.
          */}
        {canAssignStudents ? (
          <div
            style={{
              padding: "7px 9px",
              borderBottom: "1px solid var(--border-base)",
              display: "flex",
              flexWrap: "wrap",
              gap: 6,
              alignItems: "center",
              background: tickedStudents.length > 0 ? "var(--brand-50, #ecfdf5)" : "var(--surface-base)",
            }}
          >
            <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>
              {tickedStudents.length === 0
                ? "Tick students below to give them a coach together:"
                : `${tickedStudents.length.toLocaleString()} ticked - give them:`}
            </span>
            <select
              value={tickedCoachId}
              onChange={(event) => setTickedCoachId(event.target.value)}
              style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 187, background: "#fff" }}
              name="ssp_assignment_ticked_coach"
              aria-label="Coach for the ticked students"
              disabled={!canAddToTeam || tickedCoachChoices.length === 0 || savingTicked}
            >
              <option value="">
                {tickedStudents.length > 0 && tickedUnitCount > 1
                  ? "Tick one unit's students only"
                  : tickedStudents.length > 0 && tickedCoachChoices.length === 0
                    ? "No coach available"
                    : "Choose a coach..."}
              </option>
              {tickedCoachChoices.map((caller) => (
                <option key={caller.user_id} value={caller.user_id}>
                  {buildCallerName(caller)}
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => void assignTickedStudents()}
              disabled={!canAddToTeam || !tickedCoach || tickedStudents.length === 0 || savingTicked}
              title={
                !canAddToTeam
                  ? assignmentWindow?.reason || "You cannot assign students right now."
                  : tickedStudents.length === 0
                    ? "Tick the students first"
                    : !tickedCoach
                      ? "Choose the coach first"
                      : `Make ${buildCallerName(tickedCoach)} the coach of the ${tickedStudents.length} ticked`
              }
              style={{
                ...buttonStyle,
                background: "var(--brand-600)",
                color: "#fff",
                opacity: !canAddToTeam || !tickedCoach || tickedStudents.length === 0 || savingTicked ? 0.6 : 1,
              }}
            >
              {savingTicked
                ? "Saving..."
                : `${tickedStudents.some((student) => hasCoach(student)) ? "Reassign" : "Assign"}${tickedStudents.length > 0 ? ` ${tickedStudents.length.toLocaleString()}` : ""}`}
            </button>
            {filteredStudents.length > 0 && tickedStudents.length < filteredStudents.length ? (
              <button
                type="button"
                onClick={() => setTickedIds(new Set(filteredStudents.map((student) => student.student_id)))}
                disabled={loading || savingTicked}
                style={{ ...buttonStyle, background: "transparent", color: "var(--brand-700)", padding: "6px 4px" }}
              >
                Tick all {filteredStudents.length.toLocaleString()} shown
              </button>
            ) : null}
            {tickedStudents.length > 0 ? (
              <button
                type="button"
                onClick={() => setTickedIds(new Set())}
                disabled={savingTicked}
                style={{ ...buttonStyle, background: "transparent", color: "var(--text-muted)", padding: "6px 4px" }}
              >
                Clear ticks
              </button>
            ) : null}
          </div>
        ) : null}

        <div style={{ padding: "6px 11px", borderBottom: "1px solid var(--border-base)", color: "var(--text-muted)", fontSize: 11 }}>
          <strong style={{ color: "var(--text-secondary)" }}>{activeQueue.label}</strong> - {activeQueue.hint}.
        </div>

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 230px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                {canAssignStudents ? (
                  <th style={{ ...thStyle, width: 1, paddingRight: 0 }}>
                    <input
                      type="checkbox"
                      checked={pageAllTicked}
                      ref={(input) => {
                        if (input) input.indeterminate = pageSomeTicked && !pageAllTicked;
                      }}
                      onChange={togglePageTicks}
                      disabled={loading || pageIds.length === 0}
                      aria-label="Tick every student on this page"
                    />
                  </th>
                ) : null}
                <th style={thStyle}>No.</th>
                <th style={thStyle}>Student</th>
                <th style={thStyle}>Coaching Unit</th>
                <th style={thStyle}>Program</th>
                <th style={thStyle}>Priority</th>
                <th style={thStyle}>Survey Status</th>
                <th style={thStyle}>
                  Enrollment Status
                  {enrollmentTerm?.label ? (
                    <div style={{ fontSize: 10.5, fontWeight: 500, color: "var(--text-muted)" }}>{enrollmentTerm.label}</div>
                  ) : null}
                </th>
                <th style={thStyle}>Coaches</th>
                {canAutoAssign ? <th style={thStyle}>Action</th> : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={columnCount} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                    Loading assignments...
                  </td>
                </tr>
              ) : filteredStudents.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                    No students matched the current filters.
                  </td>
                </tr>
              ) : (
                pagedStudents.rows.map((student, index) => {
                  const selectedCallerId = selectedCallerByStudent[String(student.student_id)] || "";
                  const assignments = assignmentsOf(student);
                  const coach = student.coach || null;
                  // The unit's coaches, minus the one the student already has.
                  const coachChoices = coachesForStudent(callers, student).filter(
                    (caller) => Number(caller.user_id) !== Number(coach?.user_id)
                  );
                  const coachRoleId = coachRoleIdFor(student);
                  const coachRole = coachRoleFor(student?.student_type);
                  const isStar = String(student?.student_type || "").trim().toLowerCase() === "star";
                  const saveDisabled = !canAddToTeam
                    || assigningStudentId === student.student_id
                    || !selectedCallerId;

                  const ticked = tickedIds.has(student.student_id);

                  return (
                    <tr key={student.student_id} style={ticked ? { background: "var(--brand-50, #ecfdf5)" } : undefined}>
                      {canAssignStudents ? (
                        <td style={{ ...tdStyle, width: 1, paddingRight: 0 }}>
                          <input
                            type="checkbox"
                            checked={ticked}
                            onChange={() => toggleTick(student.student_id)}
                            aria-label={`Tick ${student.student_number || formatStudentName(student)}`}
                          />
                        </td>
                      ) : null}
                      {/* Numbered against the whole band, not the page, so row 21
                          is "21" on page two rather than a second "1". */}
                      <td style={{ ...tdStyle, color: "var(--text-muted)" }}>
                        {(pagedStudents.page - 1) * pagedStudents.pageSize + index + 1}
                      </td>
                      <td style={{ ...tdStyle, minWidth: 170 }}>
                        <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                          {student.student_number || `ID:${student.student_id}`}
                        </div>
                        <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>{formatStudentName(student)}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{student.email_address || "No email"}</div>
                      </td>
                      <td style={{ ...tdStyle, minWidth: 96 }}>
                        {/* Which unit coaches this student, from their cohort:
                            SSP for Non-STAR, KASAMA for STAR. */}
                        {student.coaching_unit ? (
                          <>
                            <span
                              style={{
                                display: "inline-block",
                                padding: "2px 7px",
                                borderRadius: 999,
                                fontSize: 10.5,
                                fontWeight: 700,
                                border: `1px solid ${isStar ? "#fde68a" : "#bfdbfe"}`,
                                background: isStar ? "#fffbeb" : "#eff6ff",
                                color: isStar ? "#92400e" : "#1e40af",
                              }}
                            >
                              {student.coaching_unit}
                            </span>
                            <div style={{ color: "var(--text-faint)", fontSize: 10.5, marginTop: 3 }}>
                              {isStar ? STUDENT_TYPE_STAR : STUDENT_TYPE_NON_STAR}
                            </div>
                          </>
                        ) : (
                          <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>No {STUDENT_TYPE_LABEL}</span>
                        )}
                      </td>
                      <td style={{ ...tdStyle, minWidth: 120 }}>
                        {/* The code, not the degree name: the full name wrapped to
                            four lines and pushed Add Member off the screen. The
                            name and department stay in the tooltip. */}
                        <div
                          style={{ color: "var(--text-primary)", fontWeight: 600 }}
                          title={[student.course_name, student.department_name].filter(Boolean).join(" - ") || undefined}
                        >
                          {student.course_code || student.course_name || "No course"}
                        </div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                          {student.year_level ? yearLevelLabel(student.year_level) : "No year"}
                        </div>
                        {student.section ? (
                          <div style={{ color: "var(--text-faint)", fontSize: 10.5 }}>{student.section}</div>
                        ) : null}
                      </td>
                      {/* 118, not 130: the tick column needed the room to keep the
                          board inside a 1440px screen. The segment text wraps. */}
                      <td style={{ ...tdStyle, minWidth: 118 }}>
                        {/* Why this student is on the list: the priority, and the
                            segment of the matrix it came from. */}
                        <span
                          style={{ ...priorityBadgeStyle(student.priority), fontSize: 10.5 }}
                          title={student.segment ? `Segment: ${student.segment}` : undefined}
                        >
                          {priorityLabel(student.priority, student.priority_owner)}
                        </span>
                        <div style={{ color: "var(--text-muted)", fontSize: 11, marginTop: 3 }}>
                          {student.segment || "Not yet classified."}
                        </div>
                      </td>
                      <td style={{ ...tdStyle, minWidth: 160 }}>
                        <SurveyStatusCell survey={student.survey} />
                      </td>
                      <td style={{ ...tdStyle, minWidth: 125 }}>
                        <EnrollmentStatusCell enrollment={student.next_enrollment} term={enrollmentTerm} />
                      </td>
                      <td style={{ ...tdStyle, minWidth: 230 }}>
                        {/* The coach and the control that assigns or reassigns -
                            one cell, so the picker stays on screen at laptop
                            width. Any other row is a leftover from when a
                            supervisor was stored beside the coach (until
                            2026-10-01), labelled as not a coach so it is not
                            read as a second one; Reassign clears it too. */}
                        <div style={{ display: "grid", gap: 7 }}>
                          {assignments.length === 0 ? (
                            <span style={{ color: "var(--warning-700)", fontSize: 11.5, fontWeight: 600 }}>No coach yet</span>
                          ) : (
                            <div style={{ display: "grid", gap: 5 }}>
                              {!coach ? (
                                <span style={{ color: "var(--warning-700)", fontSize: 11.5, fontWeight: 600 }}>No coach yet</span>
                              ) : null}
                              {assignments.map((assignment) => {
                                const isCoach = Number(assignment?.caller_role_id) === coachRoleId;
                                return (
                                  <div
                                    key={assignment.assignment_id}
                                    style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 6 }}
                                  >
                                    <div style={{ minWidth: 0 }}>
                                      <div style={{ color: "var(--text-primary)", fontWeight: isCoach ? 700 : 500, fontSize: isCoach ? 12.5 : 11.5 }}>
                                        {assignment.caller_name || assignment.caller_email || `User #${assignment.caller_user_id}`}
                                      </div>
                                      <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                                        {isCoach
                                          ? `${student.coaching_unit || ""} coach`.trim()
                                          : `${assignment.caller_role_name ? `${assignment.caller_role_name} - ` : ""}not a coach, remove`}
                                        {assignment.caller_status_name && assignment.caller_status_name !== "Active" ? ` | ${assignment.caller_status_name}` : ""}
                                        {` | since ${formatDay(assignment.created_at || assignment.updated_at) || "-"}`}
                                      </div>
                                    </div>
                                    {canUnassignStudents ? (
                                      <button
                                        type="button"
                                        onClick={() => void unassignStudent(assignment.assignment_id)}
                                        disabled={removingAssignmentId === assignment.assignment_id}
                                        title={`Remove ${assignment.caller_name || "this person"} from this student`}
                                        aria-label={`Remove ${assignment.caller_name || "this person"} from this student`}
                                        style={{
                                          ...buttonStyle,
                                          flexShrink: 0,
                                          padding: "2px 7px",
                                          background: "transparent",
                                          color: "var(--text-muted)",
                                          border: "1px solid var(--border-base)",
                                        }}
                                      >
                                        {removingAssignmentId === assignment.assignment_id ? "..." : "Remove"}
                                      </button>
                                    ) : null}
                                  </div>
                                );
                              })}
                            </div>
                          )}
                          <div style={{ display: "flex", gap: 6, alignItems: "center", paddingTop: 7, borderTop: "1px dashed var(--border-base)" }}>
                            <select
                              value={selectedCallerId}
                              onChange={(event) =>
                                setSelectedCallerByStudent((prev) => ({
                                  ...prev,
                                  [String(student.student_id)]: event.target.value,
                                }))
                              }
                              style={{ flex: 1, minWidth: 0, padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, background: "#fff" }}
                              name={`ssp_assignment_select_${student.student_id}`}
                              aria-label={coach ? "Choose a new coach" : "Choose a coach"}
                              disabled={!canAddToTeam || coachChoices.length === 0}
                            >
                              <option value="">
                                {coachChoices.length === 0
                                  ? coach
                                    ? "No other coach available"
                                    : `No ${student.coaching_unit || ""} coach available`.replace("  ", " ")
                                  : coach
                                    ? "Change coach..."
                                    : "Choose a coach..."}
                              </option>
                              {coachChoices.map((caller) => (
                                <option key={caller.user_id} value={caller.user_id}>
                                  {buildCallerName(caller)}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => void assignStudent(student.student_id)}
                              disabled={saveDisabled}
                              title={coach ? `Replace ${coach.name || "the current coach"} with the coach you chose` : "Make the chosen coach this student's coach"}
                              style={{ ...buttonStyle, flexShrink: 0, background: "var(--brand-600)", color: "#fff", opacity: saveDisabled ? 0.6 : 1 }}
                            >
                              {assigningStudentId === student.student_id ? "Saving..." : coach ? "Reassign" : "Assign"}
                            </button>
                          </div>
                        </div>
                      </td>
                      {canAutoAssign ? (
                        <td style={{ ...tdStyle, minWidth: 110 }}>
                          {/* Admin only: the supervisors choose each coach. */}
                          {!coach && coachRole ? (
                            <button
                              type="button"
                              onClick={() => void autoAssign(student.student_id)}
                              disabled={!canAddToTeam || autoAssigningStudentId === student.student_id || bulkAssigning}
                              title={`Assign the least-loaded ${coachRole.roleName} as this student's coach`}
                              style={{
                                ...buttonStyle,
                                background: "var(--brand-800)",
                                color: "#fff",
                                opacity: !canAddToTeam || autoAssigningStudentId === student.student_id || bulkAssigning ? 0.6 : 1,
                              }}
                            >
                              {autoAssigningStudentId === student.student_id ? "Assigning..." : "Auto-assign"}
                            </button>
                          ) : (
                            <span style={{ color: "var(--text-faint)", fontSize: 11 }}>-</span>
                          )}
                        </td>
                      ) : null}
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Below the table and outside its scroll box, which is where every
            other list in the portal puts it. */}
        {!loading && pagedStudents.total > 0 ? (
          <div style={{ padding: "0 11px 11px" }}>
            <Pagination
              page={pagedStudents.page}
              pageSize={pagedStudents.pageSize}
              total={pagedStudents.total}
              onPageChange={pagedStudents.setPage}
              onPageSizeChange={pagedStudents.setPageSize}
              itemLabel="students"
              compact
            />
          </div>
        ) : null}
      </div>

      <ImportDialog
        open={importOpen && canAssignStudents}
        onClose={() => setImportOpen(false)}
        title="Import coaches"
        description={`Gives each student in the file their coach. A student who already has a different coach is reassigned - the old coach is taken off - and you are shown who before anything is saved.${typeScope ? ` Only your ${typeScope} students are matched.` : ""}`}
        templateFileName="coach-import-template.csv"
        columns={COACH_IMPORT_COLUMNS}
        onSubmit={(file) => importCoaches(file)}
        precheck={(file) => precheckCoaches(file)}
        submitLabel="Import coaches"
        summarize={(result) => [
          { label: "Rows read", value: result?.summary?.rows_read ?? 0 },
          { label: "Assigned", value: result?.summary?.assigned ?? 0, tone: "good" },
          { label: "Reassigned", value: result?.summary?.reassigned ?? 0, tone: result?.summary?.reassigned ? "warn" : undefined },
          { label: "Already right", value: result?.summary?.unchanged ?? 0 },
          ...(result?.summary?.skipped ? [{ label: "Skipped", value: result.summary.skipped, tone: "bad" }] : []),
        ]}
        detail={(result) => [
          { label: "Rows skipped", items: result?.details?.row_errors || [] },
          { label: "Reassigned (old -> new coach)", items: result?.details?.reassigned || [] },
          { label: "Assigned", items: result?.details?.assigned || [] },
        ]}
      />
    </>
  );
}
