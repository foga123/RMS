import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateTime } from "../../shared/lib/dateTime";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import { AlertMessage, Button } from "../../shared/components/ui";
import { DashboardPanel, OverviewHeader, OverviewStatCards } from "../../shared/layout/dashboard";
import { readAuthUser } from "../../shared/lib/auth";
import {
  currentTermHint,
  currentTermPeriodFilter,
  useCurrentTermFilters,
} from "../../shared/lib/currentTerm";
import { matchesCohort, useCohortFilters } from "../../shared/lib/cohortFilters";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { assigneeLabelFor, assigneeRoleName, callersForStudentType } from "../../shared/lib/studentType";
import { getBackendUrl } from "../../shared/lib/url";
import { buildStatusLabelLookup, statusOptions } from "../../shared/lib/retentionStatusLabels";
import { getRetentionStatusLabels } from "../../shared/services/api";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { formatStudentName } from "../../shared/lib/studentName";

/*
 * Which retention period a case belongs to.
 *
 * NOT built from shared/lib/periods.js, though it uses the same words. That
 * helper's list ends in "Total", meaning P1+P2+P3 rolled into one figure, which
 * is the right question for a table of numbers. A case list is a list of
 * events: the useful choices are "every case regardless of period" and "the
 * semester-level cases only", and those are two different options rather than
 * one. Borrowing the helper would have quietly answered a question nobody
 * asked here.
 */
const CASE_PERIOD_OPTIONS = [
  { value: "", label: "All periods" },
  { value: "1", label: "P1" },
  { value: "2", label: "P2" },
  { value: "3", label: "P3" },
  { value: "term", label: "Semester-level" },
];

/*
 * The only two a limited interventionist may choose between.
 *
 * Not "the list minus P3": there is no "All periods" for them either. Both of
 * the choices this drops -- every period at once, and the semester-level cases
 * -- would ask the server for rows their window has already excluded, and an
 * empty board under a filter the user DID set is harder to read than one they
 * were never offered.
 */
const LIMITED_INTERVENTION_PERIOD_VALUES = ["1", "2"];

/**
 * The badge on a case row saying which period flagged it.
 *
 * A deliberately quiet style. The row already carries a priority badge that
 * reads "P1 - College", and on a screen where P1 means an urgency band, a
 * second P1 meaning a point in the calendar has to look like a different kind
 * of thing or the two get read as one.
 */
/**
 * Is this case inside the window a limited interventionist may act in?
 *
 * P1 and P2 only. Mirrors case_period_is_open_to_limited_intervention() in
 * backend/api/lib/retention_case_policy.php, which is what actually enforces
 * it -- this decides whether the controls are drawn, not whether the write is
 * allowed. A whole-semester case (no period) carries no timing, so it is
 * outside the window rather than inside it by default.
 */
function caseIsOpenToLimitedIntervention(caseRow) {
  const period = Number(caseRow?.period);
  return [1, 2].includes(period);
}

/**
 * Which periodical a limited interventionist's board opens on.
 *
 * The calendar's own, while it is inside the window. Past it -- the school has
 * reached P3 -- P2 is the honest landing: it is the last periodical they could
 * act on, so it is where the work they came to look at is. Anything unreadable
 * (a blank filter, "term") starts at P1.
 */
function clampPeriodToLimitedWindow(value) {
  const period = Number(value);
  if (!Number.isFinite(period) || period < 1) return "1";
  return period > 2 ? "2" : String(period);
}

function periodBadgeLabel(period) {
  const value = Number(period);
  return [1, 2, 3].includes(value) ? `Period ${value}` : "Whole semester";
}

const filterInputStyle = {
  padding: "6px 8px",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  background: "#fff",
  fontSize: 12.5,
};

const fieldStyle = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  background: "#fff",
  fontSize: 12.5,
  boxSizing: "border-box",
};

const textareaStyle = {
  ...fieldStyle,
  minHeight: 71,
  resize: "vertical",
  fontFamily: "inherit",
};

function getRoleFlags(user) {
  const roleName = String(user?.role_name || "").trim().toLowerCase();
  return {
    isAdmin: roleName === "admin",
    // Program Head included: they carry the dean's caseload, so a note they add
    // is the same "validation" note. Left out, their notes would be filed as
    // "intervention" — the fallback for a role this function does not know.
    isDean: roleName === "dean" || roleName === "program head",
    isCoordinator: roleName === "ssp coordinator",
    isCaller: roleName === "ssp caller",
  };
}

/*
 * How urgent this case is, from the RETENTION & MIGRATION segment matrix.
 *
 * Replaced a High/Moderate/Low "risk" badge. The scoring engine still computes
 * and stores combined_risk_level - it is what opens a case in the first place -
 * but what this page ranks and filters by is the sheet's Priority 1-4, computed
 * by the same code the caller screens and the prioritization list use. A case
 * that reads "high risk" here and "P1" on the screen someone acts on it from is
 * two scales for one question.
 *
 * The palette runs from alarm to all-clear so the ordering is legible without
 * reading the labels.
 */
function priorityBadgeStyle(level) {
  if (level === 1) {
    return { background: "var(--danger-100)", color: "var(--danger-700)", borderColor: "var(--danger-200)" };
  }
  if (level === 2) {
    return { background: "var(--warning-100)", color: "var(--warning-800)", borderColor: "var(--warning-200)" };
  }
  if (level === 3) {
    return { background: "var(--info-100, #dbeafe)", color: "var(--info-800, #1e40af)", borderColor: "var(--info-200, #bfdbfe)" };
  }
  if (level === 4) {
    return { background: "var(--brand-100)", color: "var(--brand-800)", borderColor: "var(--brand-200)" };
  }
  return { background: "var(--surface-page)", color: "var(--text-muted)", borderColor: "var(--border-base)" };
}

function priorityBadgeLabel(level, owner) {
  // "Not ranked" rather than a default level: a case the classifier has not
  // placed is a gap to notice, not a Priority 4 to relax about.
  if (![1, 2, 3, 4].includes(level)) return "Not ranked";
  return `P${level}${owner ? ` \u00b7 ${owner}` : ""}`;
}

function statusBadgeStyle(value) {
  const token = String(value || "").toLowerCase();
  if (token === "pending" || token === "unassigned") {
    return { background: "var(--brand-50)", color: "var(--brand-700)", borderColor: "var(--brand-200)" };
  }
  if (token === "approved" || token === "resolved") {
    return { background: "var(--brand-100)", color: "var(--brand-800)", borderColor: "var(--brand-200)" };
  }
  if (token === "rejected") {
    return { background: "var(--danger-100)", color: "var(--danger-700)", borderColor: "var(--danger-200)" };
  }
  return { background: "var(--surface-page)", color: "var(--text-secondary)", borderColor: "var(--border-strong)" };
}

function normalizeDrafts(caseRows) {
  return (caseRows || []).reduce((acc, caseRow) => {
    acc[String(caseRow.case_id)] = {
      validation_status: caseRow.validation_status || "pending",
      assigned_to_user_id: caseRow.assigned_to_user_id ? String(caseRow.assigned_to_user_id) : "",
      intervention_status: caseRow.intervention_status || "unassigned",
      follow_up_date: caseRow.follow_up_date || "",
      outcome_summary: caseRow.outcome_summary || "",
      note_body: "",
    };
    return acc;
  }, {});
}

function hasModulePermission(permissions, action) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return true;
  }
  return canModuleAction(permissions, action);
}

export default function RetentionCaseWorkspace({ user: userProp, permissions: modulePermissions = [] }) {
  const user = userProp || readAuthUser();
  const roleFlags = useMemo(() => getRoleFlags(user), [user]);
  const canEditModule = useMemo(() => hasModulePermission(modulePermissions, "edit"), [modulePermissions]);
  const canAssignModule = useMemo(() => hasModulePermission(modulePermissions, "assign"), [modulePermissions]);
  const canAnalyzeModule = useMemo(() => hasModulePermission(modulePermissions, "analyze"), [modulePermissions]);
  /*
   * Recording what was done, as opposed to approving it. Faculty hold this and
   * not `edit`; see require_case_access() in retention_case.php for why the two
   * were split.
   */
  const canInterveneModule = useMemo(() => hasModulePermission(modulePermissions, "intervene"), [modulePermissions]);
  /*
   * A role with `intervene` but no `edit` may only act on P1 and P2 - the
   * periodicals where the work is still preventive. The same rule runs on the
   * server, which is what actually enforces it; this exists so the controls are
   * not offered and then refused, which reads as a broken screen rather than as
   * a boundary.
   */
  const isLimitedInterventionist = canInterveneModule && !canEditModule;
  const beginRequest = useLatestRequest();
  const [loading, setLoading] = useState(false);
  const [evaluating, setEvaluating] = useState(false);
  const [savingCaseId, setSavingCaseId] = useState(null);
  const [savingNoteCaseId, setSavingNoteCaseId] = useState(null);
  // Which case is expanded. One at a time: the board is a list to scan, and
  // every card open at once is the thing that made it unreadable.
  const [openCaseId, setOpenCaseId] = useState(null);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [cases, setCases] = useState([]);
  const [summary, setSummary] = useState({
    total_cases: 0,
    pending_validation: 0,
    assigned_cases: 0,
    resolved_cases: 0,
    priority_1: 0,
    priority_2: 0,
    priority_3: 0,
    priority_4: 0,
  });
  const [callers, setCallers] = useState([]);
  const [permissions, setPermissions] = useState({
    can_run_evaluation: false,
    can_validate: false,
    can_assign: false,
    can_update_intervention: false,
  });
  /*
   * What the server narrowed this board to, or null when it narrowed nothing.
   *
   * Reported rather than assumed. The scope is enforced in SQL, and a page that
   * describes it from its own copy of the rule will one day describe a scope
   * that is no longer the one being applied.
   */
  const [caseWindow, setCaseWindow] = useState(null);
  const [search, setSearch] = useState("");
  const [priorityFilter, setPriorityFilter] = useState("");
  const [periodFilter, setPeriodFilter] = useState("");
  /*
   * Which period the next evaluation run judges. Separate from periodFilter:
   * reading P1 cases and then running P2 is an ordinary sequence, and tying the
   * two together would make looking at last period's results change what the
   * button does.
   */
  const [evaluationPeriod, setEvaluationPeriod] = useState("");

  /*
   * Open on the periodical the academic calendar says the school is in.
   *
   * The board used to open on "All periods", which stacked P1, P2 and P3 cases
   * for the same student on top of each other and read as one long list of
   * duplicates. During P1 there is exactly one period worth looking at, and it
   * is the one the calendar names.
   *
   * Both dropdowns are seeded, for different reasons: the filter so the list
   * shows this period's flags, the run so pressing Run evaluation writes to the
   * period being looked at rather than to the whole semester. They stay
   * independent afterwards - this only chooses where each one starts.
   */
  const { term: currentTerm } = useCurrentTermFilters((term) => {
    const filter = currentTermPeriodFilter(term);
    if (!filter) return;
    setPeriodFilter(filter);
    setEvaluationPeriod(filter);
  });
  /*
   * Keep the period filter inside the window for a role that has one.
   *
   * Runs after the calendar seed rather than instead of it: during P1 and P2
   * the calendar is already right and this changes nothing, and it is only the
   * P3 case -- where the seed names a periodical the role cannot work -- that
   * needs an answer. Without it the select sits on a value that is not one of
   * its options, which renders blank and reads as a filter nobody set.
   */
  useEffect(() => {
    if (!isLimitedInterventionist) return;
    if (LIMITED_INTERVENTION_PERIOD_VALUES.includes(periodFilter)) return;
    setPeriodFilter(clampPeriodToLimitedWindow(periodFilter));
  }, [isLimitedInterventionist, periodFilter]);

  const periodFilterOptions = useMemo(
    () => (isLimitedInterventionist
      ? CASE_PERIOD_OPTIONS.filter((option) => LIMITED_INTERVENTION_PERIOD_VALUES.includes(option.value))
      : CASE_PERIOD_OPTIONS),
    [isLimitedInterventionist],
  );

  const [validationFilter, setValidationFilter] = useState("");
  const [interventionFilter, setInterventionFilter] = useState("");
  const [assignedFilter, setAssignedFilter] = useState("");
  /*
   * Which cohort to look at. The same pair the Contact Workspace offers, from
   * the same hook, and the same reason: a department's board is a few hundred
   * cases and the work is done a section or a year at a time.
   *
   * Applied here rather than sent to the server, which is where the priority
   * filter already sits. The board fetches its rows in one go, so narrowing
   * them in the browser costs a round trip less and keeps the summary cards
   * counting the whole board - the behaviour the priority filter deliberately
   * has, so choosing one cohort does not rewrite what the cards report.
   */
  const {
    yearLevel: yearLevelFilter,
    setYearLevel: setYearLevelFilter,
    section: sectionFilter,
    setSection: setSectionFilter,
    years: cohortYears,
    sections: cohortSections,
    filters: cohortFilters,
  } = useCohortFilters(cases, yearLevelLabel);
  const [drafts, setDrafts] = useState({});

  /*
   * The words this board prints for each status.
   *
   * The codes are fixed - the server counts a case as resolved by comparing
   * `intervention_status` to the literal "resolved" - but what a college calls
   * them is editable in Settings. Loaded once; a failure is not surfaced,
   * because the helpers fall back to the built-in names and a board that says
   * "Resolved" instead of somebody's preferred word is not worth an error
   * banner over the cases themselves.
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

  const labelFor = useMemo(() => buildStatusLabelLookup(statusLabelGroups), [statusLabelGroups]);
  const validationOptions = useMemo(() => statusOptions(statusLabelGroups, "validation"), [statusLabelGroups]);
  const interventionOptions = useMemo(() => statusOptions(statusLabelGroups, "intervention"), [statusLabelGroups]);

  /*
   * The term the window is pinned to, named the way the office names it:
   * "1st Semester 2026-2027". Built from the two names rather than reusing the
   * calendar's own label, which reads "P1 - 1st Semester - 2026-2027" and would
   * drop a second, differently-meant P1 into a sentence already about P1 and P2.
   */
  const caseWindowTermName = useMemo(() => {
    if (!caseWindow) return "";
    return [caseWindow.semester_name, caseWindow.schoolyear_name].filter(Boolean).join(" ");
  }, [caseWindow]);

  const caseWindowHint = useMemo(() => {
    if (!caseWindow) return "";
    const where = caseWindowTermName ? ` for ${caseWindowTermName}` : "";
    return `Showing P1 and P2 cases${where}. Your role works the periodicals where a `
      + `drop-out can still be prevented - P3 and semester-level cases belong to the retention team.`;
  }, [caseWindow, caseWindowTermName]);

  const visibleCases = useMemo(
    () => cases.filter((caseRow) => matchesCohort(caseRow, cohortFilters)),
    [cases, cohortFilters],
  );

  /*
   * Why the board is empty, when the reason is knowable.
   *
   * "No retention cases matched the current filters" is a true sentence and a
   * useless one on a board narrowed by a rule instead of by a filter: the user
   * reads it, looks at filters they did not set, and cannot tell an empty
   * period from a broken screen. It is still the right answer once they HAVE
   * narrowed something themselves, so a search or a priority hands it back.
   */
  const emptyBoardMessage = useMemo(() => {
    const userNarrowedIt = Boolean(
      search.trim() || priorityFilter || validationFilter || interventionFilter || assignedFilter
        || yearLevelFilter || sectionFilter,
    );
    if (!caseWindow || userNarrowedIt) {
      return "No retention cases matched the current filters.";
    }
    const where = caseWindowTermName ? ` for ${caseWindowTermName}` : "";
    return `No ${periodBadgeLabel(periodFilter).toLowerCase()} cases${where} yet. `
      + `Cases appear here once the retention team runs an evaluation for that period.`;
  }, [
    assignedFilter,
    sectionFilter,
    yearLevelFilter,
    caseWindow,
    caseWindowTermName,
    interventionFilter,
    periodFilter,
    priorityFilter,
    search,
    validationFilter,
  ]);

  const loadBoard = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (priorityFilter) params.set("priority", priorityFilter);
      if (periodFilter) params.set("period", periodFilter);
      if (validationFilter) params.set("validation_status", validationFilter);
      if (interventionFilter) params.set("intervention_status", interventionFilter);
      if (assignedFilter) params.set("assigned_to_user_id", assignedFilter);

      const query = params.toString();
      const endpoint = `retention_case.php${query ? `?${query}` : ""}`;
      const res = await fetch(getBackendUrl(endpoint), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load retention cases");

      const nextCases = Array.isArray(json?.data) ? json.data : [];
      if (!isCurrent()) return;
      setCases(nextCases);
      setSummary(json?.summary || {
        total_cases: nextCases.length,
        pending_validation: 0,
        assigned_cases: 0,
        resolved_cases: 0,
        priority_1: 0,
    priority_2: 0,
    priority_3: 0,
    priority_4: 0,
      });
      setCallers(Array.isArray(json?.callers) ? json.callers : []);
      setPermissions(json?.permissions || {});
      setCaseWindow(json?.case_window || null);
      setDrafts(normalizeDrafts(nextCases));
    } catch (loadError) {
      if (!isCurrent()) return;
      setCases([]);
      setSummary({
        total_cases: 0,
        pending_validation: 0,
        assigned_cases: 0,
        resolved_cases: 0,
        priority_1: 0,
    priority_2: 0,
    priority_3: 0,
    priority_4: 0,
      });
      setCallers([]);
      setDrafts({});
      // Cleared with the rows: the empty-board notice explains a window, and
      // explaining one over a request that failed says the window is why the
      // board is empty when the error is.
      setCaseWindow(null);
      setError(loadError?.message || "Failed to load retention cases");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [assignedFilter, beginRequest, interventionFilter, periodFilter, priorityFilter, search, validationFilter]);

  useEffect(() => {
    if (!user) return;
    void loadBoard();
  }, [loadBoard, user]);

  useEffect(() => {
    if (!user) return undefined;

    const handleFocus = () => {
      void loadBoard();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadBoard();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadBoard, user]);

  const summaryCards = useMemo(() => {
    return [
      { label: "Total Cases", value: summary.total_cases ?? 0 },
      /* These two count one status each, so they follow whatever it has been
         renamed to. The card below them does not: assigned_cases is every case
         with an owner - assigned, in_progress, follow_up and resolved together -
         so it is a union rather than the "assigned" status, and naming it after
         that one status would misreport what the number counts. */
      { label: `${labelFor("validation", "pending")} Validation`, value: summary.pending_validation ?? 0 },
      { label: "Assigned", value: summary.assigned_cases ?? 0 },
      { label: labelFor("intervention", "resolved"), value: summary.resolved_cases ?? 0 },
      // The band the sheet routes to College, which is the same question the
      // old "High Risk" card was asking.
      { label: "Priority 1", value: summary.priority_1 ?? 0 },
    ];
  }, [summary, labelFor]);

  const callerNameById = useMemo(() => {
    return callers.reduce((acc, caller) => {
      acc[String(caller.user_id)] = `${caller.first_name || ""} ${caller.last_name || ""}`.trim() || caller.email || `User #${caller.user_id}`;
      return acc;
    }, {});
  }, [callers]);

  const handleDraftChange = useCallback((caseId, field, value) => {
    setDrafts((prev) => ({
      ...prev,
      [String(caseId)]: {
        ...(prev[String(caseId)] || {}),
        [field]: value,
      },
    }));
  }, []);

  const runEvaluation = useCallback(async () => {
    setEvaluating(true);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(getBackendUrl("retention_case.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        // Blank means the whole semester, which is what every run before
        // periods existed did. Sent as omitted rather than as "" so the server
        // reads it as absent rather than as an unparseable period.
        body: JSON.stringify(
          evaluationPeriod
            ? { action: "run_evaluation", period: Number(evaluationPeriod) }
            : { action: "run_evaluation" }
        ),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to run retention evaluation");
      setSuccess(`${json?.message || "Retention evaluation completed."} ${json?.created ?? 0} created, ${json?.updated ?? 0} updated.`);
      await loadBoard();
    } catch (evaluationError) {
      setError(evaluationError?.message || "Failed to run retention evaluation");
    } finally {
      setEvaluating(false);
    }
  }, [evaluationPeriod, loadBoard]);

  const saveCase = useCallback(async (caseRow) => {
    const caseId = Number(caseRow?.case_id);
    if (!caseId) return;

    const draft = drafts[String(caseId)] || {};
    const canManageValidation = Boolean(permissions?.can_validate) && canEditModule && !roleFlags.isCaller;
    const canManageAssignment = Boolean(permissions?.can_assign) && canAssignModule && !roleFlags.isCaller;
    const callerOwnsCase = Number(caseRow?.assigned_to_user_id || 0) === Number(user?.user_id || 0);
    const canManageIntervention = Boolean(permissions?.can_update_intervention)
      && (canEditModule || canInterveneModule)
      && (!roleFlags.isCaller || callerOwnsCase)
      && (!isLimitedInterventionist || caseIsOpenToLimitedIntervention(caseRow));

    const payload = { case_id: caseId };
    if (canManageValidation) payload.validation_status = draft.validation_status || caseRow.validation_status || "pending";
    if (canManageAssignment) payload.assigned_to_user_id = draft.assigned_to_user_id ? Number(draft.assigned_to_user_id) : null;
    if (canManageIntervention) {
      payload.intervention_status = draft.intervention_status || caseRow.intervention_status || "unassigned";
      payload.follow_up_date = draft.follow_up_date || null;
      payload.outcome_summary = draft.outcome_summary || null;
    }

    setSavingCaseId(caseId);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(getBackendUrl("retention_case.php"), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to update retention case");
      setSuccess(json?.message || "Retention case updated.");
      await loadBoard();
    } catch (saveError) {
      setError(saveError?.message || "Failed to update retention case");
    } finally {
      setSavingCaseId(null);
    }
  }, [canAssignModule, canEditModule, canInterveneModule, drafts, isLimitedInterventionist, loadBoard, permissions, roleFlags.isCaller, user?.user_id]);

  const saveNote = useCallback(async (caseRow) => {
    const caseId = Number(caseRow?.case_id);
    const draft = drafts[String(caseId)] || {};
    const noteBody = String(draft.note_body || "").trim();
    if (!caseId || !noteBody) return;
    if (!canEditModule) return;

    const noteType = roleFlags.isCaller ? "follow_up" : roleFlags.isDean ? "validation" : "intervention";

    setSavingNoteCaseId(caseId);
    setError("");
    setSuccess("");

    try {
      const res = await fetch(getBackendUrl("retention_case.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({
          action: "add_note",
          case_id: caseId,
          note_type: noteType,
          note_body: noteBody,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to add case note");
      setSuccess(json?.message || "Case note added.");
      await loadBoard();
    } catch (noteError) {
      setError(noteError?.message || "Failed to add case note");
    } finally {
      setSavingNoteCaseId(null);
    }
  }, [canEditModule, drafts, loadBoard, roleFlags.isCaller, roleFlags.isDean]);

  if (!user) return null;

  return (
    <section style={{ marginBottom: 19, display: "grid", gridTemplateRows: "auto minmax(0, 1fr)", gap: 12, height: "100%", minHeight: 0 }}>
      <div style={{ display: "grid", gap: 12 }}>
        <OverviewHeader title="Retention and Intervention Cases" />
        <AlertMessage
          tone="info"
          message={
            roleFlags.isCaller
              ? "Only cases assigned to your SSP Caller account are shown here."
              : "Cases are opened from grade markers and survey responses, then ranked by the Priority 1-4 segment matrix. Deans validate cases; SSP users track interventions."
          }
        />
        <AlertMessage tone="error" message={error} />
        <AlertMessage tone="success" message={success} />

        <OverviewStatCards items={summaryCards} minWidth={180} />
      </div>

      <DashboardPanel style={{ display: "grid", gridTemplateRows: "auto auto minmax(0, 1fr)", gap: 9, minHeight: 0, overflow: "hidden" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Case Board</h3>
            <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
              Review evaluation outcomes, approve cases, assign SSP callers, and track follow-up work.
            </p>
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {permissions?.can_run_evaluation && canAnalyzeModule ? (
              <>
                {/* Beside the button, not buried in the filter row: which
                    period a run writes to is part of pressing it, and a run
                    aimed at the wrong period overwrites that period's flags. */}
                <select
                  value={evaluationPeriod}
                  onChange={(event) => setEvaluationPeriod(event.target.value)}
                  style={filterInputStyle}
                  name="retention_case_evaluation_period"
                  aria-label="Retention period to evaluate"
                  title="Which retention period this run judges. Each period keeps its own case."
                >
                  <option value="">Evaluate: whole semester</option>
                  <option value="1">Evaluate: Period 1</option>
                  <option value="2">Evaluate: Period 2</option>
                  <option value="3">Evaluate: Period 3</option>
                </select>
                <Button onClick={runEvaluation} disabled={evaluating}>
                  {evaluating ? "Evaluating..." : "Run Evaluation"}
                </Button>
              </>
            ) : null}
            <Button variant="secondary" onClick={() => void loadBoard()} disabled={loading}>
              {loading ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        </div>

        {/* Says which periodical the board opened on and why, so a filter the
            user did not set does not read as a list that is missing rows. For a
            role whose board is narrowed to a window, that narrowing is the more
            important half and replaces it: two notices saying almost the same
            thing is how a notice stops being read. */}
        {caseWindow ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 6 }}>
            {caseWindowHint}
          </div>
        ) : currentTermHint(currentTerm) ? (
          <div style={{ fontSize: 12.5, color: "var(--text-muted)", marginBottom: 6 }}>
            {currentTermHint(currentTerm)}
          </div>
        ) : null}

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(153px, 100%), 1fr))", gap: 6 }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search student, program, reason..."
            style={filterInputStyle}
            name="retention_case_search"
          />
          {/* Spelled out since retention periods arrived on this screen. "P1"
              was unambiguous when it could only mean an urgency band; beside a
              Period 1 filter it is not. The priority levels keep their meaning,
              they just say which scale they are on. */}
          <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value)} style={filterInputStyle} name="retention_case_priority_filter" aria-label="Priority">
            <option value="">All priorities</option>
            <option value="1">Priority 1 &middot; College</option>
            <option value="2">Priority 2 &middot; Coaches</option>
            <option value="3">Priority 3 &middot; Coaches</option>
            <option value="4">Priority 4 &middot; Coaches</option>
          </select>
          <select value={periodFilter} onChange={(event) => setPeriodFilter(event.target.value)} style={filterInputStyle} name="retention_case_period_filter" aria-label="Retention period">
            {periodFilterOptions.map((option) => (
              <option key={option.value || "all"} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select value={validationFilter} onChange={(event) => setValidationFilter(event.target.value)} style={filterInputStyle} name="retention_case_validation_filter">
            <option value="">All validation states</option>
            {validationOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          <select value={interventionFilter} onChange={(event) => setInterventionFilter(event.target.value)} style={filterInputStyle} name="retention_case_intervention_filter">
            <option value="">All intervention states</option>
            {interventionOptions.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
          {/* Only offered when the board actually holds more than one, so a
              department running a single section is not handed a dropdown with
              one thing in it. */}
          {cohortYears.length > 1 ? (
            <select value={yearLevelFilter} onChange={(event) => setYearLevelFilter(event.target.value)} style={filterInputStyle} name="retention_case_year_level_filter" aria-label="Year level">
              <option value="">All year levels</option>
              {cohortYears.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : null}
          {cohortSections.length > 1 ? (
            <select value={sectionFilter} onChange={(event) => setSectionFilter(event.target.value)} style={filterInputStyle} name="retention_case_section_filter" aria-label="Section">
              <option value="">All sections</option>
              {cohortSections.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : null}
          {callers.length > 0 && !roleFlags.isCaller ? (
            <select value={assignedFilter} onChange={(event) => setAssignedFilter(event.target.value)} style={filterInputStyle} name="retention_case_assigned_filter">
              <option value="">All assignees</option>
              {callers.map((caller) => (
                <option key={caller.user_id} value={String(caller.user_id)}>
                  {callerNameById[String(caller.user_id)]}
                </option>
              ))}
            </select>
          ) : null}
        </div>

        <div style={{ display: "grid", gap: 9, minHeight: 0, overflowY: "auto", overflowX: "hidden", paddingRight: 3 }}>
          {loading ? (
            <DashboardPanel variant="dashed">Loading retention cases...</DashboardPanel>
          ) : visibleCases.length === 0 ? (
            <DashboardPanel variant="dashed">{emptyBoardMessage}</DashboardPanel>
          ) : (
            <div style={{ display: "grid", gap: 9 }}>
              {visibleCases.map((caseRow) => {
                const caseId = String(caseRow.case_id);
                const isOpen = String(openCaseId) === caseId;
                const draft = drafts[caseId] || {};
                const priorityStyle = priorityBadgeStyle(caseRow.priority);
                const validationStyle = statusBadgeStyle(caseRow.validation_status);
                const interventionStyle = statusBadgeStyle(caseRow.intervention_status);
                const callerOwnsCase = Number(caseRow.assigned_to_user_id || 0) === Number(user?.user_id || 0);
                const canManageValidation = Boolean(permissions?.can_validate) && canEditModule && !roleFlags.isCaller;
                const canManageAssignment = Boolean(permissions?.can_assign) && canAssignModule && !roleFlags.isCaller;
                const withinWindow = !isLimitedInterventionist || caseIsOpenToLimitedIntervention(caseRow);
                const canManageIntervention = Boolean(permissions?.can_update_intervention)
                  && (canEditModule || canInterveneModule)
                  && (!roleFlags.isCaller || callerOwnsCase)
                  && withinWindow;
                const canAddNote = (canEditModule || canInterveneModule)
                  && (!roleFlags.isCaller || callerOwnsCase)
                  && withinWindow;

                return (
                  <article key={caseId} style={{ border: "1px solid var(--border-base)", borderRadius: 11, background: "#fff", padding: 12, display: "grid", gap: 9 }}>
                    <div style={{ display: "flex", flexWrap: "wrap", justifyContent: "space-between", gap: 9, alignItems: "flex-start" }}>
                      <div style={{ minWidth: 0 }}>
                        {/* The name is the control. Everything below the
                            summary lines stays shut until it is clicked. */}
                        <button
                          type="button"
                          onClick={() => setOpenCaseId(isOpen ? null : caseRow.case_id)}
                          aria-expanded={isOpen}
                          title={isOpen ? "Hide case details" : "Show case details"}
                          style={{
                            border: "none",
                            background: "none",
                            padding: 0,
                            font: "inherit",
                            cursor: "pointer",
                            textAlign: "left",
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            color: "var(--text-primary)",
                            fontWeight: 700,
                            fontSize: 14,
                          }}
                        >
                          <span
                            aria-hidden="true"
                            style={{
                              color: "var(--text-muted)",
                              fontSize: 10.5,
                              transform: isOpen ? "none" : "rotate(-90deg)",
                              transition: "transform 140ms ease",
                            }}
                          >
                            ▼
                          </span>
                          <span style={{ textDecoration: "underline", textUnderlineOffset: 3 }}>
                            {formatStudentName(caseRow)}
                          </span>
                        </button>
                        <div style={{ color: "var(--text-secondary)", fontSize: 12.5, marginTop: 3 }}>
                          {caseRow.student_number || `ID:${caseRow.student_id}`}
                          {` | ${caseRow.course_name || caseRow.course_code || "No program"}`}
                          {caseRow.year_level ? ` | ${yearLevelLabel(caseRow.year_level)}` : ""}
                          {caseRow.section ? ` | Section ${caseRow.section}` : ""}
                        </div>
                        {/* Score and owner stay on the closed row: they are what
                            decides which case you open next. */}
                        <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginTop: 3 }}>
                          {`Score ${Number(caseRow.evaluation_score || 0).toFixed(2)}`}
                          {` | ${caseRow.assigned_to_name || "Unassigned"}`}
                        </div>
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "flex-end" }}>
                        <span
                          title={caseRow.segment ? `Segment: ${caseRow.segment}` : undefined}
                          style={{ border: `1px solid ${priorityStyle.borderColor}`, background: priorityStyle.background, color: priorityStyle.color, borderRadius: 999, padding: "4px 8px", fontSize: 10.5, fontWeight: 700 }}
                        >
                          {priorityBadgeLabel(caseRow.priority, caseRow.priority_owner)}
                        </span>
                        {/* Muted on purpose - see periodBadgeLabel. This says
                            when the case was raised, not how urgent it is. */}
                        <span
                          title="The retention period this evaluation belongs to"
                          style={{ border: "1px solid var(--border-base)", background: "var(--surface-page)", color: "var(--text-secondary)", borderRadius: 999, padding: "4px 8px", fontSize: 10.5, fontWeight: 600 }}
                        >
                          {periodBadgeLabel(caseRow.period)}
                        </span>
                        {/* No textTransform: these words are chosen in Settings
                            now, so "capitalize" would overrule the casing
                            somebody deliberately typed. The fallback labels
                            already read the way they always did. */}
                        <span style={{ border: `1px solid ${validationStyle.borderColor}`, background: validationStyle.background, color: validationStyle.color, borderRadius: 999, padding: "4px 8px", fontSize: 10.5, fontWeight: 700 }}>
                          {labelFor("validation", caseRow.validation_status || "pending")}
                        </span>
                        <span style={{ border: `1px solid ${interventionStyle.borderColor}`, background: interventionStyle.background, color: interventionStyle.color, borderRadius: 999, padding: "4px 8px", fontSize: 10.5, fontWeight: 700 }}>
                          {labelFor("intervention", caseRow.intervention_status || "unassigned")}
                        </span>
                      </div>
                    </div>

                    {isOpen ? (
                    <>
                    {/* Says why the controls below are missing. A role that can
                        act on some cases and not others, with no explanation on
                        the ones it cannot, reads as a screen that is broken for
                        this row rather than as a boundary that was set. */}
                    {isLimitedInterventionist && !withinWindow ? (
                      <AlertMessage
                        tone="info"
                        message={`This case is ${periodBadgeLabel(caseRow.period).toLowerCase()}, and your role records interventions on P1 and P2 cases only. The retention team handles it from here.`}
                      />
                    ) : null}
                    <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                      {caseRow.department_name || "No department"}
                      {caseRow.semester_name ? ` | ${caseRow.semester_name}` : ""}
                      {caseRow.schoolyear_name ? ` | ${caseRow.schoolyear_name}` : ""}
                    </div>

                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(153px, 100%), 1fr))", gap: 6 }}>
                      <div style={{ background: "var(--surface-page)", border: "1px solid var(--border-base)", borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Academic Signal</div>
                        <div style={{ color: "var(--text-primary)", fontWeight: 600, textTransform: "capitalize" }}>{caseRow.academic_risk_level || "low"}</div>
                      </div>
                      <div style={{ background: "var(--surface-page)", border: "1px solid var(--border-base)", borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Survey Signal</div>
                        <div style={{ color: "var(--text-primary)", fontWeight: 600, textTransform: "capitalize" }}>{caseRow.survey_risk_level || "low"}</div>
                      </div>
                      <div style={{ background: "var(--surface-page)", border: "1px solid var(--border-base)", borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Evaluation Score</div>
                        <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{Number(caseRow.evaluation_score || 0).toFixed(2)}</div>
                      </div>
                      <div style={{ background: "var(--surface-page)", border: "1px solid var(--border-base)", borderRadius: 8, padding: 8 }}>
                        <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Assigned SSP Caller</div>
                        <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{caseRow.assigned_to_name || "Unassigned"}</div>
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 5 }}>
                      <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 700 }}>Evaluation Reason</div>
                      <div style={{ color: "var(--neutral-700)", fontSize: 12.5, lineHeight: 1.5 }}>
                        {caseRow.evaluation_reason || "No evaluation reason recorded."}
                        <div className="mt-1 text-xs text-slate-500">Stored evaluation: {caseRow.evaluated_at ? formatDateTime(caseRow.evaluated_at) : "Date unavailable"}. Source changes require re-evaluation.</div>
                      </div>
                    </div>

                    <div style={{ display: "grid", gap: 5 }}>
                      <div style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 700 }}>Latest Note</div>
                      <div style={{ color: "var(--neutral-700)", fontSize: 12.5, lineHeight: 1.5 }}>
                        {caseRow.last_note_body || "No case notes yet."}
                      </div>
                      <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                        {caseRow.last_note_body ? `${caseRow.last_note_type || "intervention"} note | ${formatDateTime(caseRow.last_note_created_at)} | ${caseRow.note_count || 0} total note(s)` : ""}
                      </div>
                    </div>

                    {(canManageValidation || canManageAssignment || canManageIntervention) ? (
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(187px, 100%), 1fr))", gap: 8 }}>
                        {canManageValidation ? (
                          <label style={{ display: "grid", gap: 5 }}>
                            <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>Validation Status</span>
                            <select value={draft.validation_status || "pending"} onChange={(event) => handleDraftChange(caseId, "validation_status", event.target.value)} style={fieldStyle} name={`retention_case_validation_${caseId}`}>
                              {validationOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {canManageAssignment ? (
                          <label style={{ display: "grid", gap: 5 }}>
                            <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>
                              {assigneeLabelFor(caseRow?.student_type)}
                            </span>
                            <select value={draft.assigned_to_user_id || ""} onChange={(event) => handleDraftChange(caseId, "assigned_to_user_id", event.target.value)} style={fieldStyle} name={`retention_case_assignee_${caseId}`}>
                              <option value="">Unassigned</option>
                              {callersForStudentType(callers, caseRow?.student_type).map((caller) => (
                                <option key={caller.user_id} value={String(caller.user_id)}>
                                  {callerNameById[String(caller.user_id)]}
                                </option>
                              ))}
                            </select>
                            {callersForStudentType(callers, caseRow?.student_type).length === 0 ? (
                              <span style={{ color: "var(--warning-700)", fontSize: 10.5 }}>
                                No {assigneeRoleName(caseRow?.student_type)} account is available for this student type.
                              </span>
                            ) : null}
                          </label>
                        ) : null}
                        {canManageIntervention ? (
                          <label style={{ display: "grid", gap: 5 }}>
                            <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>Intervention Status</span>
                            <select value={draft.intervention_status || "unassigned"} onChange={(event) => handleDraftChange(caseId, "intervention_status", event.target.value)} style={fieldStyle} name={`retention_case_intervention_${caseId}`}>
                              {interventionOptions.map((option) => (
                                <option key={option.value} value={option.value}>{option.label}</option>
                              ))}
                            </select>
                          </label>
                        ) : null}
                        {canManageIntervention ? (
                          <label style={{ display: "grid", gap: 5 }}>
                            <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>Follow-Up Date</span>
                            <input type="date" value={draft.follow_up_date || ""} onChange={(event) => handleDraftChange(caseId, "follow_up_date", event.target.value)} style={fieldStyle} name={`retention_case_followup_${caseId}`} />
                          </label>
                        ) : null}
                      </div>
                    ) : null}

                    {canManageIntervention ? (
                      <label style={{ display: "grid", gap: 5 }}>
                        <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>Outcome Summary</span>
                        <textarea value={draft.outcome_summary || ""} onChange={(event) => handleDraftChange(caseId, "outcome_summary", event.target.value)} style={textareaStyle} name={`retention_case_outcome_${caseId}`} />
                      </label>
                    ) : null}

                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "space-between", alignItems: "flex-start" }}>
                      {canAddNote ? (
                        <div style={{ flex: "1 1 340px", display: "grid", gap: 5 }}>
                          <span style={{ color: "var(--text-secondary)", fontSize: 11.5, fontWeight: 600 }}>Add Note</span>
                          <textarea value={draft.note_body || ""} onChange={(event) => handleDraftChange(caseId, "note_body", event.target.value)} style={textareaStyle} name={`retention_case_note_${caseId}`} />
                        </div>
                      ) : (
                        <div />
                      )}

                      <div style={{ display: "flex", gap: 6, alignSelf: "flex-end", flexWrap: "wrap" }}>
                        {(canManageValidation || canManageAssignment || canManageIntervention) ? (
                          <Button onClick={() => void saveCase(caseRow)} disabled={savingCaseId === Number(caseId)}>
                            {savingCaseId === Number(caseId) ? "Saving..." : "Save Case"}
                          </Button>
                        ) : null}
                        {canAddNote ? (
                          <Button variant="secondary" onClick={() => void saveNote(caseRow)} disabled={savingNoteCaseId === Number(caseId) || !String(draft.note_body || "").trim()}>
                            {savingNoteCaseId === Number(caseId) ? "Adding..." : "Add Note"}
                          </Button>
                        ) : null}
                      </div>
                    </div>
                    </>
                    ) : null}
                  </article>
                );
              })}
            </div>
          )}
        </div>
      </DashboardPanel>
    </section>
  );
}
