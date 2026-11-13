import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage } from "../../shared/components/ui";
import { DashboardPanel, MeterRow, OverviewStatCards } from "../../shared/layout/dashboard";
import { formatDateTime } from "../../shared/lib/dateTime";
import { formatStudentName } from "../../shared/lib/studentName";
import { getBackendUrl } from "../../shared/lib/url";

/*
 * The home-visit snapshot that leads the CSDL overview.
 *
 * CSDL landed on an empty "No activity yet" table: the overview had a snapshot
 * for callers (RetentionOverview) and for faculty (FacultyOverview), and none
 * for the one role whose whole job is the home-visit queue.
 *
 * It reads the very same queue the Home Visit Workspace works from
 * (home_visit_queue.php), so the landing page and the workspace can never
 * disagree about how many visits are waiting. The overview is the glance; the
 * workspace is the work.
 *
 * Colours mirror the workspace on purpose - amber queued, sky scheduled, green
 * completed, and the callers' orange for a referral - so CSDL reads the same
 * meaning in both places. If those change in HomeVisitsPage.jsx, change them
 * here too.
 */

const VISIT_META = [
  { key: "queued", label: "Queued", hint: "waiting to be scheduled", accent: "#f59e0b" },
  { key: "scheduled", label: "Scheduled", hint: "a visit is booked", accent: "#38bdf8" },
  { key: "completed", label: "Completed", hint: "final status saved", accent: "#34d399" },
];

const REASON_META = [
  { key: "referred", label: "Referred by a caller", accent: "#fb923c" },
  { key: "no_response", label: "No answer", accent: "#fb7185" },
  { key: "follow_up_needed", label: "Needs follow-up", accent: "#fbbf24" },
  { key: "other", label: "Other escalation", accent: "#94a3b8" },
];

/** How many booked visits the "Next visits" list shows. */
const NEXT_VISIT_LIMIT = 5;

function normalizeStatusKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Which work state a visit is in. Mirrors visitState() in the workspace. */
function visitKey(row) {
  const key = normalizeStatusKey(row?.queue_status);
  return key === "scheduled" || key === "completed" ? key : "queued";
}

/** Why the student was escalated. Mirrors reasonTone() in the workspace. */
function reasonKey(row) {
  if (row?.referred_to_csdl) return "referred";
  const key = normalizeStatusKey(row?.current_status_key || row?.current_status);
  return key === "no_response" || key === "follow_up_needed" ? key : "other";
}

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 11px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

function PanelHeading({ title, hint }) {
  return (
    <div>
      <h4 style={{ margin: 0, color: "var(--text-primary)", fontSize: 14 }}>{title}</h4>
      <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11 }}>{hint}</p>
    </div>
  );
}

/**
 * @param {() => void} [onOpenWorkspace] wired to jump into the Home Visit Workspace
 */
export default function HomeVisitOverview({ onOpenWorkspace }) {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async ({ background = false } = {}) => {
    if (background) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("home_visit_queue.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load the home visit snapshot.");
      setRows(Array.isArray(json?.data) ? json.data : []);
      setSummary(json?.summary || null);
    } catch (loadError) {
      if (!background) {
        setRows([]);
        setSummary(null);
      }
      setError(loadError?.message || "Failed to load the home visit snapshot.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const total = summary?.total_home_visits ?? rows.length;

  const visitCounts = useMemo(() => {
    const counts = { queued: 0, scheduled: 0, completed: 0 };
    rows.forEach((row) => {
      counts[visitKey(row)] += 1;
    });
    return counts;
  }, [rows]);

  const reasonCounts = useMemo(() => {
    const counts = { referred: 0, no_response: 0, follow_up_needed: 0, other: 0 };
    rows.forEach((row) => {
      counts[reasonKey(row)] += 1;
    });
    return counts;
  }, [rows]);

  /*
   * What CSDL decided for the visits it finished, by final status, most used
   * first. Only recorded outcomes count: a suggestion carried over from the
   * caller's plan is not a decision until CSDL saves it.
   */
  const outcomeCounts = useMemo(() => {
    const counts = new Map();
    rows.forEach((row) => {
      const label = String(row?.final_outcome || "").trim();
      if (visitKey(row) !== "completed" || !label) return;
      counts.set(label, (counts.get(label) || 0) + 1);
    });
    return Array.from(counts.entries())
      .map(([label, value]) => ({ label, value }))
      .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
  }, [rows]);

  // The booked visits still to happen, soonest first.
  const nextVisits = useMemo(
    () => rows
      .filter((row) => visitKey(row) === "scheduled" && row?.scheduled_visit_at)
      .sort((a, b) => String(a.scheduled_visit_at).localeCompare(String(b.scheduled_visit_at)))
      .slice(0, NEXT_VISIT_LIMIT),
    [rows]
  );

  const statCards = useMemo(() => ([
    {
      label: "Need Home Visit",
      value: total,
      meta: reasonCounts.referred ? `${reasonCounts.referred} referred by a caller` : "Escalated from the contact workflow",
    },
    { label: "Queued", value: summary?.queued_home_visits ?? visitCounts.queued, meta: "Waiting to be scheduled" },
    { label: "Scheduled", value: summary?.scheduled_home_visits ?? visitCounts.scheduled, meta: "A visit is booked" },
    { label: "Completed", value: summary?.completed_home_visits ?? visitCounts.completed, tone: "success", meta: "Visit done" },
  ]), [reasonCounts.referred, summary, total, visitCounts]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Home visit snapshot</h3>
          <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
            A live view of the students escalated to CSDL, and how the visits are going.
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => void load({ background: rows.length > 0 })}
            disabled={loading || refreshing}
            style={{ ...buttonStyle, background: "var(--border-base)", color: "var(--text-primary)", opacity: loading || refreshing ? 0.7 : 1 }}
          >
            {loading || refreshing ? "Refreshing..." : "Refresh"}
          </button>
          {onOpenWorkspace ? (
            <button type="button" onClick={onOpenWorkspace} style={{ ...buttonStyle, background: "var(--brand-700)", color: "#fff" }}>
              Open the workspace →
            </button>
          ) : null}
        </div>
      </div>

      {error ? <AlertMessage tone="error" message={error} /> : null}

      <OverviewStatCards items={statCards} minWidth={180} />

      {loading && rows.length === 0 ? (
        <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
          Loading the home visit snapshot...
        </DashboardPanel>
      ) : total === 0 ? (
        <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
          No students have been escalated for a home visit yet. They appear here when a caller cannot reach them or refers them to CSDL.
        </DashboardPanel>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
          <DashboardPanel>
            <div style={{ display: "grid", gap: 10 }}>
              <PanelHeading title="Visit progress" hint="Where each escalated student is, from queued to a saved final status." />
              <div style={{ display: "grid", gap: 9 }}>
                {VISIT_META.map((meta) => (
                  <MeterRow key={meta.key} accent={meta.accent} label={meta.label} hint={meta.hint} value={visitCounts[meta.key]} total={total} />
                ))}
              </div>
            </div>
          </DashboardPanel>

          <DashboardPanel>
            <div style={{ display: "grid", gap: 10 }}>
              <PanelHeading title="Why escalated" hint="How each student reached CSDL." />
              <div style={{ display: "grid", gap: 9 }}>
                {REASON_META.filter((meta) => meta.key !== "other" || reasonCounts.other > 0).map((meta) => (
                  <MeterRow key={meta.key} accent={meta.accent} label={meta.label} value={reasonCounts[meta.key]} total={total} />
                ))}
              </div>
            </div>
          </DashboardPanel>

          <DashboardPanel>
            <div style={{ display: "grid", gap: 10 }}>
              <PanelHeading title="Next visits" hint="Booked visits still to happen, soonest first." />
              {nextVisits.length === 0 ? (
                <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                  {visitCounts.queued > 0
                    ? `No visit is booked yet. ${visitCounts.queued} ${visitCounts.queued === 1 ? "student is" : "students are"} waiting to be scheduled.`
                    : "No visit is booked right now."}
                </div>
              ) : (
                <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 7 }}>
                  {nextVisits.map((row) => (
                    <li key={row.home_visit_id} style={{ display: "grid", gap: 2, paddingBottom: 7, borderBottom: "1px solid var(--border-base)" }}>
                      <span style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 12 }}>{formatStudentName(row)}</span>
                      <span style={{ color: "var(--text-secondary)", fontSize: 11 }}>
                        {formatDateTime(row.scheduled_visit_at)}
                        {row.assigned_staff_name ? ` · ${row.assigned_staff_name}` : " · unassigned"}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </DashboardPanel>

          {outcomeCounts.length > 0 ? (
            <DashboardPanel>
              <div style={{ display: "grid", gap: 10 }}>
                <PanelHeading title="Final outcomes" hint="The status CSDL saved for each completed visit." />
                <div style={{ display: "grid", gap: 9 }}>
                  {outcomeCounts.map((outcome) => (
                    <MeterRow key={outcome.label} accent="#34d399" label={outcome.label} value={outcome.value} total={visitCounts.completed} />
                  ))}
                </div>
              </div>
            </DashboardPanel>
          ) : null}
        </div>
      )}
    </div>
  );
}
