import React, { useCallback, useEffect, useMemo, useState } from "react";
import { getBackendUrl } from "../../shared/lib/url";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { STATUS_TONES, statusToneFor } from "./statusTone";

/**
 * Compact enrollment-standing strip for a dashboard Overview, with its own term picker.
 *
 * Asks for a single student row because only the summary block is rendered here,
 * and each tile opens the full module already filtered to that status so the
 * number and the list behind it can never disagree.
 */

const selectStyle = {
  padding: "4px 6px",
  border: "1px solid var(--border-base)",
  borderRadius: 5,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  fontSize: 11,
};

export default function StudentMigrationSummary({ onOpen }) {
  const beginRequest = useLatestRequest();
  const [data, setData] = useState(null);
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [schoolYearId, setSchoolYearId] = useState("");
  const [semesterId, setSemesterId] = useState("");

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "1" });
      if (schoolYearId) params.set("school_year_id", schoolYearId);
      if (semesterId) params.set("semester_id", semesterId);

      const res = await fetch(getBackendUrl(`student_migration.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });

      // Optional widget: no access renders nothing rather than an error box on someone else's Overview.
      if (res.status === 401 || res.status === 403) {
        if (!isCurrent()) return;
        setHidden(true);
        return;
      }

      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "");
      setData(json);
    } catch (_) {
      if (!isCurrent()) return;
      setHidden(true);
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, schoolYearId, semesterId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keeps the dashboard strip in step with the full module without a page reload.
  useLiveRefresh(["enrollment_status", "grades", "students"], load, { enabled: !hidden });

  // Empty statuses are dropped here; the full module is where the complete list lives.
  const tiles = useMemo(() => (data?.summary || []).filter((status) => status.student_count > 0), [data]);
  const term = data?.term || {};

  if (hidden) return null;

  return (
    <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, padding: 11 }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 6, marginBottom: 8 }}>
        <div style={{ minWidth: 0 }}>
          <h3 style={{ margin: 0, fontSize: 14, color: "var(--text-primary)" }}>Student Migration</h3>
          <p style={{ margin: "2px 0 0", fontSize: 11, color: "var(--text-secondary)" }}>
            {data?.scope?.department_name ? `${data.scope.department_name} · ` : ""}
            {term.label || "Latest term"}
            {term.has_previous ? " (▲▼ vs previous term)" : ""}
          </p>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
          <select
            value={schoolYearId}
            onChange={(event) => setSchoolYearId(event.target.value)}
            style={selectStyle}
            name="migration_summary_school_year"
            aria-label="School year"
          >
            <option value="">School year</option>
            {(data?.filters?.school_years || []).map((year) => (
              <option key={year.school_year_id} value={String(year.school_year_id)}>
                {year.schoolyear_name}
              </option>
            ))}
          </select>
          <select
            value={semesterId}
            onChange={(event) => setSemesterId(event.target.value)}
            style={selectStyle}
            name="migration_summary_semester"
            aria-label="Semester"
          >
            <option value="">Semester</option>
            {(data?.filters?.semesters || []).map((semester) => (
              <option key={semester.semester_id} value={String(semester.semester_id)}>
                {semester.semester_name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => onOpen?.("")}
            style={{ background: "transparent", border: 0, padding: 0, color: "var(--brand-700)", cursor: "pointer", fontSize: 11.5, fontWeight: 600 }}
          >
            View all {data?.total_students ?? 0} →
          </button>
        </div>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>Loading…</div>
      ) : tiles.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>No students recorded for this term.</div>
      ) : (
        <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(min(112px, 100%), 1fr))" }}>
          {tiles.map((status) => {
            const tone = STATUS_TONES[statusToneFor(status.status_name, status.status_id)];
            const change = status.change;
            return (
              <button
                key={String(status.status_id)}
                type="button"
                onClick={() => onOpen?.(String(status.status_id))}
                title={`Open the ${status.status_name} list`}
                style={{
                  textAlign: "left",
                  cursor: "pointer",
                  padding: "6px 8px",
                  borderRadius: 8,
                  background: tone.bg,
                  color: tone.fg,
                  border: `1px solid ${tone.br}`,
                }}
              >
                <div style={{ display: "flex", alignItems: "baseline", gap: 4 }}>
                  <span style={{ fontSize: 16, fontWeight: 700, lineHeight: 1.1 }}>{status.student_count}</span>
                  {change ? (
                    <span style={{ fontSize: 10.5, fontWeight: 700, opacity: 0.85 }}>
                      {change > 0 ? "▲" : "▼"} {Math.abs(change)}
                    </span>
                  ) : null}
                </div>
                <div style={{ fontSize: 10.5, marginTop: 2, opacity: 0.9 }}>{status.status_name}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
