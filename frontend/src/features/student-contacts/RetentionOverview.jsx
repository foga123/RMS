import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage } from "../../shared/components/ui";
import { DashboardPanel, MeterRow, OverviewStatCards } from "../../shared/layout/dashboard";
import { PRIORITY_BANDS, UNRANKED_ACCENT } from "../../shared/lib/priorityAccent";
import { getBackendUrl } from "../../shared/lib/url";

/*
 * The retention snapshot that leads the SSP Caller and KASAMA hub overviews.
 *
 * It reads the very same queue the Contact Workspace works from
 * (student_contact_workflow.php?queue=priority), so the landing page and the
 * workspace can never disagree about how many students are waiting or how the
 * calling is going. The overview is the glance; the workspace is the work.
 *
 * Colours mirror the workspace on purpose — the warm→cool priority ramp and the
 * contact-journey states — so a caller reads the same meaning in both places.
 * If those change in StudentContactsPage.jsx, change them here too.
 */

// The contact journey, in the order a student travels it. Same tones and
// threshold as the workspace rows.
const CSDL_ATTEMPT_THRESHOLD = 3;
const PROGRESS_META = [
  { key: "not_called", label: "Not yet called", accent: "#94a3b8" },
  { key: "contacted", label: "Contacted", accent: "#34d399" },
  { key: "no_answer", label: "No answer — keep trying", accent: "#fb7185" },
  { key: "refer_csdl", label: "Refer to CSDL", accent: "#fb923c" },
  { key: "home_visit", label: "Home visit", accent: "#a78bfa" },
];

function normalizeStatusKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

/** Where a row sits in the contact journey. Mirrors rowContactState() in the workspace. */
function contactStateKey(row) {
  const attempts = Number(row?.contact_attempt_count) || 0;
  const reached = normalizeStatusKey(row?.current_status) === "contacted";
  if (row?.referred_to_csdl) return "refer_csdl";
  if (row?.needs_home_visit) return "home_visit";
  if (reached) return "contacted";
  if (attempts >= CSDL_ATTEMPT_THRESHOLD) return "refer_csdl";
  if (attempts >= 1) return "no_answer";
  return "not_called";
}

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 11px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

/**
 * @param {() => void} [onOpenWorkspace] wired to jump into the Contact Workspace
 * @param {string} [scopeNote] one line naming what limits this queue
 */
export default function RetentionOverview({ onOpenWorkspace, scopeNote = "" }) {
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
      const res = await fetch(getBackendUrl("student_contact_workflow.php?queue=priority"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load the retention snapshot.");
      setRows(Array.isArray(json?.data) ? json.data : []);
      setSummary(json?.summary || null);
    } catch (loadError) {
      if (!background) {
        setRows([]);
        setSummary(null);
      }
      setError(loadError?.message || "Failed to load the retention snapshot.");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * The queue without the students already handed to CSDL. Their cards only
   * read now, so they are counted beside the queue rather than in it - the same
   * split the workspace's cards make - and the two breakdowns below describe the
   * students the Students in Queue card counts, not a larger set it leaves out.
   */
  const queueRows = useMemo(() => rows.filter((row) => !row?.referred_to_csdl), [rows]);
  const total = summary?.total_students ?? queueRows.length;

  const statCards = useMemo(() => ([
    { label: "Students in Queue", value: total, meta: "Contacted + follow-up + home visit" },
    { label: "Contacted", value: summary?.contacted_students ?? 0, tone: "success", meta: "A good contact was made" },
    { label: "Need Follow-up", value: summary?.follow_up_students ?? 0, meta: "Not reached yet" },
    { label: "Need Home Visit", value: summary?.escalated_students ?? 0, meta: "Last option — escalated" },
    { label: "Referred to CSDL", value: summary?.referred_students ?? 0, meta: "Out of the queue — view only" },
  ]), [summary, total]);

  const priorityCounts = useMemo(() => {
    const counts = { 1: 0, 2: 0, 3: 0, 4: 0, unranked: 0 };
    queueRows.forEach((row) => {
      const level = Number(row?.priority);
      if (level >= 1 && level <= 4) counts[level] += 1;
      else counts.unranked += 1;
    });
    return counts;
  }, [queueRows]);

  const progressCounts = useMemo(() => {
    const counts = { not_called: 0, contacted: 0, no_answer: 0, refer_csdl: 0, home_visit: 0 };
    queueRows.forEach((row) => {
      counts[contactStateKey(row)] += 1;
    });
    return counts;
  }, [queueRows]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Retention snapshot</h3>
          <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
            {scopeNote || "A live view of the students waiting on a call, and how the calling is going."}
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
          Loading the retention snapshot...
        </DashboardPanel>
      ) : total === 0 ? (
        <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
          No students are waiting on a call right now. Nothing to work through — nice.
        </DashboardPanel>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
          <DashboardPanel>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <h4 style={{ margin: 0, color: "var(--text-primary)", fontSize: 14 }}>Priority mix</h4>
                <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11 }}>
                  Which students to call first. Warmest is most urgent.
                </p>
              </div>
              <div style={{ display: "grid", gap: 9 }}>
                {PRIORITY_BANDS.map((meta) => (
                  <MeterRow
                    key={meta.level}
                    accent={meta.accent}
                    label={meta.label}
                    hint={meta.owner}
                    value={priorityCounts[meta.level]}
                    total={total}
                  />
                ))}
                {priorityCounts.unranked > 0 ? (
                  <MeterRow accent={UNRANKED_ACCENT} label="Not ranked" hint="no priority yet" value={priorityCounts.unranked} total={total} />
                ) : null}
              </div>
            </div>
          </DashboardPanel>

          <DashboardPanel>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <h4 style={{ margin: 0, color: "var(--text-primary)", fontSize: 14 }}>Contact progress</h4>
                <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11 }}>
                  How the calling is going, from first dial to a home visit.
                </p>
              </div>
              <div style={{ display: "grid", gap: 9 }}>
                {PROGRESS_META.map((meta) => (
                  <MeterRow
                    key={meta.key}
                    accent={meta.accent}
                    label={meta.label}
                    value={progressCounts[meta.key]}
                    total={total}
                  />
                ))}
              </div>
            </div>
          </DashboardPanel>
        </div>
      )}
    </div>
  );
}
