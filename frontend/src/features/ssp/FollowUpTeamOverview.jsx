import React, { useCallback, useEffect, useMemo, useState } from "react";
// Straight at the file, not through the ui barrel - see OverviewStatCards.jsx.
import AlertMessage from "../../shared/components/ui/AlertMessage";
import { OverviewStatCards } from "../../shared/layout/dashboard";
import { getBackendUrl } from "../../shared/lib/url";

/*
 * The supervisor's own team, as the SSP Coordinator and the KSH TL land on it.
 *
 * Every number comes from ssp_assignment.php?view=team_overview, which counts
 * the supervisor's WHOLE cohort - every live Non-STAR student for the
 * coordinator, every STAR one for the TL. The coordinator's cards used to count
 * whichever queue band the board happened to load, and its user count included
 * the other team's people, so neither said how many students or coaches were
 * actually theirs.
 *
 * "Coaches" are the team's workers: SSP Callers on the Non-STAR side, KASAMA on
 * the STAR side. Renders nothing for an account that supervises no team - the
 * server answers null for it.
 */

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 11px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

function formatCount(value) {
  return Number(value || 0).toLocaleString();
}

/**
 * The four cards only. The per-coach "Your coaches" list that sat under them
 * was taken off both supervisors' overviews on 2026-10-01; the Coaches card
 * still counts them, and the assignment board shows who holds whom.
 *
 * @param {() => void} [onOpenAssignments] jump to the assignment board
 */
export default function FollowUpTeamOverview({ onOpenAssignments }) {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("ssp_assignment.php?view=team_overview"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load your team overview.");
      setOverview(json?.team_overview || null);
    } catch (loadError) {
      setOverview(null);
      setError(loadError?.message || "Failed to load your team overview.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const cohort = overview?.student_type || "";
  const total = Number(overview?.students_total || 0);
  const withCoach = Number(overview?.students_with_coach || 0);
  const inactiveCoaches = Number(overview?.coaches_total || 0) - Number(overview?.coaches_active || 0);

  const cards = useMemo(() => [
    {
      label: cohort ? `${cohort} Students` : "Students",
      value: formatCount(total),
      meta: "Every active student under you",
      loading,
    },
    {
      label: "Coaches",
      value: formatCount(overview?.coaches_active),
      meta: inactiveCoaches > 0 ? `Active - ${inactiveCoaches} inactive not counted` : "Active accounts on your team",
      loading,
    },
    {
      label: "With a Coach",
      value: formatCount(withCoach),
      tone: "success",
      meta: total > 0 ? `${((withCoach / total) * 100).toFixed(1)}% of your students` : "No students yet",
      progress: total > 0 ? (withCoach / total) * 100 : undefined,
      loading,
    },
    {
      label: "Without a Coach",
      value: formatCount(overview?.students_without_coach),
      tone: Number(overview?.students_without_coach || 0) > 0 ? "warning" : "default",
      meta: "Not yet assigned to a coach",
      loading,
    },
  ], [cohort, inactiveCoaches, loading, overview, total, withCoach]);

  if (!loading && !error && !overview) return null;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Your team</h3>
          <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
            {cohort
              ? `Only ${cohort} students are shown to you, here and on every other screen.`
              : "The students under you and the coaches who work them."}
          </p>
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading}
            style={{ ...buttonStyle, background: "var(--border-base)", color: "var(--text-primary)", opacity: loading ? 0.7 : 1 }}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
          {onOpenAssignments ? (
            <button type="button" onClick={onOpenAssignments} style={{ ...buttonStyle, background: "var(--brand-700)", color: "#fff" }}>
              Assign students →
            </button>
          ) : null}
        </div>
      </div>

      {error ? <AlertMessage tone="error" message={error} /> : null}

      <OverviewStatCards items={cards} minWidth={200} />
    </div>
  );
}
