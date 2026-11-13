import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateTime } from "../../shared/lib/dateTime";
import { AlertMessage } from "../../shared/components/ui";
import Modal from "../../shared/components/Modal";
import { DashboardPanel, OverviewHeader, OverviewStatCards } from "../../shared/layout/dashboard";
import { useCurrentTermBadge } from "../../shared/lib/currentTerm";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { formatStudentName } from "../../shared/lib/studentName";

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 9px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

function MessageBox({ message, tone = "error" }) {
  if (!message) return null;
  const palette = tone === "success"
    ? { background: "var(--brand-100)", color: "var(--brand-800)", border: "var(--brand-200)" }
    : { background: "var(--danger-100)", color: "var(--danger-800)", border: "var(--danger-200)" };

  return (
    <div style={{ padding: 9, borderRadius: 8, border: `1px solid ${palette.border}`, background: palette.background, color: palette.color }}>
      {message}
    </div>
  );
}

function normalizeStatusKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/*
 * A home visit moves through three work states, and the row is shaded by which
 * one it is in — a warm "to do" through to a green "done", so the queue reads as
 * a heat map of what still needs a visit at a glance. Friendly tones, not alarms:
 * this is a list to work through.
 */
const VISIT_STATES = {
  queued: { label: "Queued", tint: "rgba(251, 191, 36, 0.12)", accent: "#f59e0b" },
  scheduled: { label: "Scheduled", tint: "rgba(56, 189, 248, 0.10)", accent: "#38bdf8" },
  completed: { label: "Completed", tint: "rgba(52, 211, 153, 0.13)", accent: "#34d399" },
};

function visitState(row) {
  return VISIT_STATES[normalizeStatusKey(row?.queue_status)] || VISIT_STATES.queued;
}

/*
 * Why the student was escalated here, as a coloured chip. A caller's explicit
 * "Refer to CSDL" is orange and named as such — the same orange the caller and
 * KASAMA workspaces use — so a referral does not blend into the plain no-answer
 * escalations it shares a status with.
 */
const REASON_TONES = {
  referred_to_csdl: { label: "Referred to CSDL", bg: "#ffedd5", fg: "#9a3412", bd: "#fed7aa" },
  no_response: { label: "No answer", bg: "#ffe4e6", fg: "#9f1239", bd: "#fecdd3" },
  follow_up_needed: { label: "Needs follow-up", bg: "#fef3c7", fg: "#92400e", bd: "#fde68a" },
};

function reasonTone(row) {
  if (row?.referred_to_csdl) return REASON_TONES.referred_to_csdl;
  const key = normalizeStatusKey(row?.current_status_key || row?.current_status);
  return REASON_TONES[key] || {
    label: String(row?.current_status || "Escalated"),
    bg: "var(--surface-page)",
    fg: "var(--text-secondary)",
    bd: "var(--border-base)",
  };
}

function Chip({ label, bg, fg, bd }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "2px 8px",
        borderRadius: 999,
        background: bg,
        color: fg,
        border: `1px solid ${bd}`,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {label}
    </span>
  );
}

/** Columns in the table, so the two colSpans cannot drift apart. */
const COLUMN_COUNT = 7;

export default function HomeVisitQueueWorkspace({ module, permissions = [] }) {
  // Which term the visits being scheduled belong to. See useCurrentTermBadge().
  const termBadge = useCurrentTermBadge();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  /*
   * A background refresh is not a load. Every thirty seconds — and on every
   * window focus — a load would blank the table, taking the open row, the
   * keyboard focus and the scroll position with it, so a background refresh
   * leaves `loading` alone and the rows stay on screen.
   *
   * It now says nothing at all. It used to drive a Refresh button's label, so
   * the button announced "Refreshing..." twice a minute on its own — a control
   * flickering at somebody who never pressed it. The button went with it: this
   * queue already reloads on focus, on tab return and every thirty seconds.
   */
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [progressFilter, setProgressFilter] = useState("");
  const [expandedVisitId, setExpandedVisitId] = useState(null);
  const [finalOutcomes, setFinalOutcomes] = useState([]);
  const [enrollmentOutcomes, setEnrollmentOutcomes] = useState([]);
  const [reasonGroups, setReasonGroups] = useState([]);
  const [finalDraft, setFinalDraft] = useState({ final_outcome: "", visit_remarks: "" });
  const [savingFinal, setSavingFinal] = useState(false);
  const [modalError, setModalError] = useState("");
  const [modalSuccess, setModalSuccess] = useState("");

  const canViewVisits = canModuleAction(permissions, "view")
    || canModuleAction(permissions, "edit")
    || canModuleAction(permissions, "assign");
  const canEditVisits = canModuleAction(permissions, "edit");

  const loadQueue = useCallback(async ({ background = false } = {}) => {
    if (!background) setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("home_visit_queue.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load the home visit workspace.");
      setRows(Array.isArray(json?.data) ? json.data : []);
      setSummary(json?.summary || null);
      setFinalOutcomes(Array.isArray(json?.final_outcomes) ? json.final_outcomes : []);
      setEnrollmentOutcomes(json?.enrollment_outcomes || []);
      setReasonGroups(json?.reason_groups || []);
    } catch (loadError) {
      if (!background) {
        setRows([]);
        setSummary(null);
      }
      setError(loadError?.message || "Failed to load the home visit workspace.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    // Not while a visit is open: coming back to the tab should not reload the
    // list out from under a record already being read.
    if (expandedVisitId !== null) return undefined;

    const handleFocus = () => {
      void loadQueue({ background: true });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadQueue({ background: true });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadQueue, expandedVisitId]);

  // The thirty-second poll, paused while a visit is expanded.
  useEffect(() => {
    if (expandedVisitId !== null) return undefined;
    const intervalId = window.setInterval(() => {
      void loadQueue({ background: true });
    }, 30000);
    return () => window.clearInterval(intervalId);
  }, [loadQueue, expandedVisitId]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      if (progressFilter && normalizeStatusKey(row?.queue_status) !== progressFilter) return false;
      if (!query) return true;

      const haystack = [
        row?.student_number, row?.first_name, row?.last_name, row?.email_address,
        row?.mobile_number, row?.home_address, row?.department_name, row?.course_name,
        row?.updated_by_name, row?.current_status, row?.assigned_staff_name, row?.visit_remarks,
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [rows, search, progressFilter]);

  const referredCount = useMemo(
    () => rows.filter((row) => row?.referred_to_csdl).length,
    [rows],
  );

  const selectedVisit = useMemo(
    () => rows.find((row) => row.home_visit_id === expandedVisitId) || null,
    [rows, expandedVisitId],
  );

  useEffect(() => {
    if (!selectedVisit) return;
    setFinalDraft({
      // A mapped plan is a starting suggestion only. CSDL still has to review
      // it and press Save Final Status before it becomes the recorded result.
      final_outcome: selectedVisit.final_outcome_key
        || selectedVisit.suggested_final_outcome_key
        || "",
      visit_remarks: selectedVisit.visit_remarks || "",
      enrollment_status: "",
      reason_id: "",
    });
  }, [selectedVisit]);

  const saveFinalOutcome = useCallback(async () => {
    if (!selectedVisit || savingFinal) return;
    if (!finalDraft.final_outcome) {
      setModalError("Select the final CSDL status before saving.");
      return;
    }

    setSavingFinal(true);
    setModalError("");
    setModalSuccess("");
    try {
      const res = await fetch(getBackendUrl("home_visit_queue.php"), {
        method: "PUT",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          home_visit_id: selectedVisit.home_visit_id,
          final_outcome: finalDraft.final_outcome,
          visit_remarks: finalDraft.visit_remarks,
          ...(finalDraft.enrollment_status ? {
            enrollment_status: finalDraft.enrollment_status,
            reason_id: finalDraft.reason_id || null,
          } : {}),
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to save the final CSDL status.");

      if (json?.data) {
        setRows((current) => current.map((row) => (
          row.home_visit_id === json.data.home_visit_id ? json.data : row
        )));
        if (normalizeStatusKey(selectedVisit.queue_status) !== "completed") {
          const previousKey = normalizeStatusKey(selectedVisit.queue_status);
          setSummary((current) => current ? {
            ...current,
            queued_home_visits: previousKey === "queued"
              ? Math.max(0, Number(current.queued_home_visits || 0) - 1)
              : current.queued_home_visits,
            scheduled_home_visits: previousKey === "scheduled"
              ? Math.max(0, Number(current.scheduled_home_visits || 0) - 1)
              : current.scheduled_home_visits,
            completed_home_visits: Number(current.completed_home_visits || 0) + 1,
          } : current);
        }
      }
      setModalSuccess("Final CSDL status saved. This visit is now completed.");
    } catch (saveError) {
      setModalError(saveError?.message || "Failed to save the final CSDL status.");
    } finally {
      setSavingFinal(false);
    }
  }, [finalDraft, savingFinal, selectedVisit]);

  /*
   * Cards read as the CSDL work state — what is waiting, booked and done —
   * rather than the caller-side status the students arrived with. "Completed" is
   * green because a finished visit is the good outcome here.
   */
  const summaryCards = useMemo(() => ([
    { label: "Need Home Visit", value: summary?.total_home_visits ?? rows.length, meta: referredCount ? `${referredCount} referred by a caller` : "" },
    { label: "Queued", value: summary?.queued_home_visits ?? 0, meta: "Waiting to be scheduled" },
    { label: "Scheduled", value: summary?.scheduled_home_visits ?? 0, meta: "A visit is booked" },
    { label: "Completed", value: summary?.completed_home_visits ?? 0, tone: "success", meta: "Visit done" },
  ]), [rows.length, summary, referredCount]);

  const th = {
    padding: 9,
    position: "sticky",
    top: 0,
    background: "var(--surface-page)",
    borderBottom: "1px solid var(--border-base)",
    zIndex: 1,
  };

  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
      <OverviewHeader title={module?.label || "Home Visit Workspace"} term={termBadge} />
      <AlertMessage
        tone="info"
        message="Students land here when a caller could not reach them or referred them to CSDL for a home visit. The list refreshes on its own — no need to reload."
      />
      <MessageBox message={error} />

      <OverviewStatCards items={summaryCards} minWidth={210} />

      <DashboardPanel>
        <div style={{ display: "grid", gap: 9 }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "space-between", alignItems: "center" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search student, staff, contact info..."
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 204 }}
                name="home_visit_search"
              />
              <select
                value={progressFilter}
                onChange={(event) => setProgressFilter(event.target.value)}
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 162, background: "#fff" }}
                name="home_visit_progress_filter"
                aria-label="Filter by visit progress"
              >
                <option value="">All visits</option>
                <option value="queued">Queued — to schedule</option>
                <option value="scheduled">Scheduled</option>
                <option value="completed">Completed</option>
              </select>
            </div>
          </div>

          {/* The row colour tracks the visit's progress; the chip in Reason says
              why the student was escalated. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "1px 0 4px", fontSize: 10.5, color: "var(--text-muted)", flexWrap: "wrap" }}>
            {Object.entries(VISIT_STATES).map(([key, meta]) => (
              <span key={key} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: 3, background: meta.accent }} />
                {meta.label}
              </span>
            ))}
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: 3, background: "#fb923c" }} />
              Referred to CSDL
            </span>
          </div>

          <div style={{ overflow: "auto", maxHeight: "calc(100dvh - 250px)", border: "1px solid var(--border-base)", borderRadius: 9 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                  <th style={th}>No.</th>
                  <th style={th}>Student</th>
                  <th style={th}>How to reach them</th>
                  <th style={th}>Visit progress</th>
                  <th style={th}>Why escalated</th>
                  <th style={th}>Last update</th>
                  <th style={th}>Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMN_COUNT} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                      Loading the home visit workspace...
                    </td>
                  </tr>
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMN_COUNT} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                      No students matched the current filters.
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((row, index) => {
                    const progress = visitState(row);
                    const reason = reasonTone(row);
                    const rowStyle = { background: progress.tint };
                    const firstCellStyle = {
                      padding: 9,
                      borderBottom: "1px solid var(--border-base)",
                      color: "var(--text-muted)",
                      // Orange accent bar for a caller's referral, otherwise the
                      // progress colour — so a referral is spotted down the No. column.
                      boxShadow: `inset 4px 0 0 0 ${row.referred_to_csdl ? "#fb923c" : progress.accent}`,
                    };

                    return (
                      <React.Fragment key={row.home_visit_id}>
                        <tr style={rowStyle}>
                          <td style={firstCellStyle}>{index + 1}</td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 190 }}>
                            <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                              {row.student_number || "No student number"}
                            </div>
                            <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>{formatStudentName(row)}</div>
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                              {row.course_name || "No course"}
                              {row.department_name ? ` · ${row.department_name}` : ""}
                              {row.year_level ? ` · ${yearLevelLabel(row.year_level)}` : ""}
                              {row.section ? ` · ${row.section}` : ""}
                            </div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 190 }}>
                            <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{row.mobile_number || "No mobile number"}</div>
                            <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>{row.email_address || "No email address"}</div>
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{row.home_address || "No home address on file"}</div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 150 }}>
                            <Chip label={progress.label} bg={progress.tint} fg={progress.accent} bd={progress.accent} />
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 5 }}>
                              {row.scheduled_visit_at
                                ? `Visit ${formatDateTime(row.scheduled_visit_at)}`
                                : row.completed_at
                                  ? `Done ${formatDateTime(row.completed_at)}`
                                  : "Not scheduled yet"}
                            </div>
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                              {row.assigned_staff_name ? `Assigned to ${row.assigned_staff_name}` : "Unassigned"}
                            </div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 140 }}>
                            <Chip label={reason.label} bg={reason.bg} fg={reason.fg} bd={reason.bd} />
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 5 }}>
                              {row.updated_by_name ? `by ${row.updated_by_name}` : "Escalated automatically"}
                            </div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 140 }}>
                            <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{formatDateTime(row.last_updated_at)}</div>
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                              {row.latest_contacted_at ? `Last call ${formatDateTime(row.latest_contacted_at)}` : "No prior contact logged"}
                            </div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 108 }}>
                            <button
                              type="button"
                              onClick={() => {
                                setModalError("");
                                setModalSuccess("");
                                setExpandedVisitId(row.home_visit_id);
                              }}
                              style={{ ...buttonStyle, background: "var(--brand-600)", color: "#fff", width: "100%", opacity: !canViewVisits ? 0.6 : 1 }}
                              disabled={!canViewVisits}
                            >
                              View
                            </button>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </DashboardPanel>

      <Modal
        open={Boolean(selectedVisit)}
        title={selectedVisit ? `${formatStudentName(selectedVisit)} — CSDL referral` : "CSDL referral"}
        onClose={() => {
          setExpandedVisitId(null);
          setModalError("");
          setModalSuccess("");
        }}
        width={780}
        error={modalError}
        success={modalSuccess}
      >
        {selectedVisit ? (
          <div style={{ display: "grid", gap: 12 }}>
            {/* The identity stays at the top of the floating card. A referral
                can remain open for weeks, and a CSDL user must not infer who
                they are updating from contact details or a table row behind
                the modal. */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))",
                gap: 9,
                padding: 11,
                borderRadius: 9,
                background: "var(--surface-page)",
                border: "1px solid var(--border-base)",
              }}
            >
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Student name</div>
                <strong style={{ color: "var(--text-primary)" }}>{formatStudentName(selectedVisit)}</strong>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Student ID</div>
                <strong style={{ color: "var(--text-primary)" }}>{selectedVisit.student_number || `Record ${selectedVisit.student_id}`}</strong>
              </div>
              <div>
                <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Program</div>
                <strong style={{ color: "var(--text-primary)" }}>{selectedVisit.course_name || "No course"}</strong>
                <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                  {selectedVisit.year_level ? yearLevelLabel(selectedVisit.year_level) : ""}
                  {selectedVisit.section ? ` · ${selectedVisit.section}` : ""}
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 9 }}>
              <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                <strong style={{ color: "var(--text-primary)" }}>Referred by</strong>
                <div style={{ marginTop: 5, color: "var(--text-secondary)" }}>
                  {selectedVisit.referred_by_name || selectedVisit.updated_by_name || "Unknown user"}
                  {selectedVisit.referred_by_role_name ? ` · ${selectedVisit.referred_by_role_name}` : ""}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                  {selectedVisit.referred_at ? formatDateTime(selectedVisit.referred_at) : "Referral date not recorded"}
                </div>
              </DashboardPanel>

              <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                <strong style={{ color: "var(--text-primary)" }}>Plan if Not Recovered</strong>
                <div style={{ marginTop: 5, color: "var(--text-secondary)" }}>
                  {selectedVisit.recovery_plan || "No plan recorded by the caller."}
                </div>
              </DashboardPanel>

              <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                <strong style={{ color: "var(--text-primary)" }}>Final outcome</strong>
                <div style={{ marginTop: 5, color: selectedVisit.final_outcome ? "var(--text-primary)" : "var(--warning-800)", fontWeight: 700 }}>
                  {selectedVisit.final_outcome || "PENDING CSDL OUTCOME"}
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                  {selectedVisit.final_outcome_source === "recorded"
                    ? `Recorded by ${selectedVisit.final_outcome_by_name || "CSDL"}${selectedVisit.final_outcome_at ? ` · ${formatDateTime(selectedVisit.final_outcome_at)}` : ""}`
                    : "CSDL has not saved a final status yet."}
                </div>
                {!selectedVisit.final_outcome && selectedVisit.suggested_final_outcome ? (
                  <div style={{ marginTop: 7, color: "var(--brand-700)", fontSize: 11 }}>
                    Suggested from caller plan: <strong>{selectedVisit.suggested_final_outcome}</strong>
                  </div>
                ) : null}
              </DashboardPanel>
            </div>

            {canEditVisits ? (
              <DashboardPanel variant="dashed" style={{ display: "grid", gap: 9 }}>
                <div>
                  <strong style={{ color: "var(--text-primary)" }}>CSDL final update</strong>
                  <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 3 }}>
                    Review the caller’s plan, choose the final status, then save. Saving marks the visit completed.
                  </div>
                </div>
                <label style={{ display: "grid", gap: 4, color: "var(--text-secondary)", fontSize: 11.5 }}>
                  Intervention Status (CSDL)
                  <select
                    aria-label="Intervention Status (CSDL)"
                    value={finalDraft.final_outcome}
                    onChange={(event) => setFinalDraft((current) => ({ ...current, final_outcome: event.target.value }))}
                    disabled={savingFinal}
                    style={{ padding: "7px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, background: "var(--surface-base)" }}
                  >
                    <option value="">Select final status</option>
                    {finalOutcomes.map((outcome) => (
                      <option key={outcome.key} value={outcome.key}>{outcome.label}</option>
                    ))}
                  </select>
                </label>
                <label style={{ display: "grid", gap: 4 }}>
                  Final enrollment outcome
                  <select
                    aria-label="Final enrollment outcome"
                    value={finalDraft.enrollment_status || ""}
                    onChange={(event) => setFinalDraft((current) => ({ ...current, enrollment_status: event.target.value }))}
                    disabled={savingFinal}
                  >
                    <option value="">Keep current enrollment outcome</option>
                    {enrollmentOutcomes.map((outcome) => (
                      <option key={outcome.status_id} value={outcome.status_name}>{outcome.status_name}</option>
                    ))}
                  </select>
                </label>
                {finalDraft.enrollment_status ? (
                  <label style={{ display: "grid", gap: 4 }}>
                    Enrollment reason (required for stop outcomes)
                    <select
                      aria-label="Enrollment reason"
                      value={finalDraft.reason_id || ""}
                      onChange={(event) => setFinalDraft((current) => ({ ...current, reason_id: event.target.value }))}
                      disabled={savingFinal}
                    >
                      <option value="">Select reason</option>
                      {reasonGroups.map((group) => (
                        <optgroup key={group.category} label={group.category}>
                          {group.reasons.map((reason) => (
                            <option key={reason.reason_id} value={reason.reason_id}>{reason.reason_text}</option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </label>
                ) : null}
                <label style={{ display: "grid", gap: 4, color: "var(--text-secondary)", fontSize: 11.5 }}>
                  Visit notes
                  <textarea
                    aria-label="Visit notes"
                    value={finalDraft.visit_remarks}
                    onChange={(event) => setFinalDraft((current) => ({ ...current, visit_remarks: event.target.value }))}
                    disabled={savingFinal}
                    rows={3}
                    style={{ padding: "7px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, resize: "vertical", background: "var(--surface-base)" }}
                  />
                </label>
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <button
                    type="button"
                    onClick={() => void saveFinalOutcome()}
                    disabled={savingFinal || !finalDraft.final_outcome}
                    style={{
                      ...buttonStyle,
                      background: "var(--brand-600)",
                      color: "#fff",
                      opacity: savingFinal || !finalDraft.final_outcome ? 0.6 : 1,
                    }}
                  >
                    {savingFinal ? "Saving..." : "Save Final Status"}
                  </button>
                </div>
              </DashboardPanel>
            ) : null}

            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))", gap: 9 }}>
              <div style={{ color: "var(--neutral-700)", fontSize: 11.5 }}>
                <strong style={{ color: "var(--text-primary)" }}>Why escalated</strong>
                <div style={{ marginTop: 5 }}>{selectedVisit.escalation_reason || reasonTone(selectedVisit).label}</div>
              </div>
              <div style={{ color: "var(--neutral-700)", fontSize: 11.5 }}>
                <strong style={{ color: "var(--text-primary)" }}>Home address</strong>
                <div style={{ marginTop: 5 }}>{selectedVisit.home_address || "No address on file."}</div>
              </div>
              <div style={{ color: "var(--neutral-700)", fontSize: 11.5 }}>
                <strong style={{ color: "var(--text-primary)" }}>Visit</strong>
                <div style={{ marginTop: 5 }}>
                  {visitState(selectedVisit).label}
                  {selectedVisit.assigned_staff_name ? ` · ${selectedVisit.assigned_staff_name}` : " · unassigned"}
                  {selectedVisit.scheduled_visit_at ? ` · ${formatDateTime(selectedVisit.scheduled_visit_at)}` : ""}
                </div>
              </div>
            </div>

            {!canEditVisits ? (
              <div style={{ display: "grid", gap: 6 }}>
                <strong style={{ color: "var(--text-primary)" }}>Visit notes</strong>
                <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                  {selectedVisit.visit_remarks || "No visit notes recorded yet."}
                </DashboardPanel>
              </div>
            ) : null}

            <div style={{ display: "grid", gap: 6 }}>
              <strong style={{ color: "var(--text-primary)" }}>Contact history</strong>
              {selectedVisit.attempts?.length ? (
                selectedVisit.attempts.map((attempt) => (
                  <div key={attempt.attempt_id} style={{ padding: "8px 9px", borderRadius: 8, border: "1px solid var(--border-base)", background: "var(--surface-page)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                        {attempt.contact_method || "Not recorded"} · {attempt.intervention_status || attempt.contact_status || "Pending"}
                      </span>
                      <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{formatDateTime(attempt.contacted_at || attempt.updated_at)}</span>
                    </div>
                    {attempt.recovery_plan ? (
                      <div style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 5 }}>
                        Plan: {attempt.recovery_plan}
                      </div>
                    ) : null}
                    <div style={{ color: "var(--text-secondary)", fontSize: 11.5, marginTop: 5 }}>
                      {attempt.notes || "No remarks recorded."}
                    </div>
                    <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 5 }}>
                      {attempt.attempted_by_name || "Unknown user"}
                      {attempt.attempted_by_role_name ? ` · ${attempt.attempted_by_role_name}` : ""}
                    </div>
                  </div>
                ))
              ) : (
                <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                  No contact history available.
                </DashboardPanel>
              )}
            </div>
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
