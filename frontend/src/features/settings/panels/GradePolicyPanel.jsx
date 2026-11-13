import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import { getBackendUrl } from "../../../shared/lib/url";
import { sendGradeRemarkPolicy } from "../../../shared/lib/gradeRemarkPolicy";
import { confirmAction, notifyError, notifySuccess } from "../../../shared/lib/notify";
import { tone } from "../../../shared/theme/tokens";

/**
 * Which school year is "now", and which grade-policy versions exist.
 *
 * Rule editing belongs to Remarks Management. Keeping another rule editor here
 * made two navigation paths mutate the same endpoint and left administrators
 * wondering which copy was authoritative. Settings still owns the year boundary
 * and policy creation: both decide which version is open or frozen, but neither
 * needs a second condition editor.
 *
 * The freeze is the load-bearing rule here: records in a finished year keep the
 * remarks they were given. That is why closed years appear in the year list at
 * all rather than being hidden -- an administrator needs to see that 2025-2026
 * is closed and cannot be edited, not wonder where it went.
 */

export default function GradePolicyPanel({ onSummaryChange, permissions }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [newPolicyYear, setNewPolicyYear] = useState("");
  const [newPolicyName, setNewPolicyName] = useState("");

  const canEdit = permissions?.canEdit !== false;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(getBackendUrl("grade_remark_policy.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not read the grade remark policy.");
      setConfig(payload.data);
    } catch (loadError) {
      setError(loadError?.message || "Could not read the grade remark policy.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const currentYear = config?.current_school_year || null;
  const policies = useMemo(() => config?.policies || [], [config]);

  useEffect(() => {
    if (!onSummaryChange) return;
    if (!currentYear) {
      onSummaryChange("No current school year is set");
      return;
    }
    onSummaryChange(`${currentYear.schoolyear_name} is current · ${policies.length} ${policies.length === 1 ? "policy" : "policies"}`);
  }, [currentYear, policies.length, onSummaryChange]);

  /**
   * Which years a policy may be written for: the current one and later.
   *
   * `is_open` is stamped by the server (lib/school_year_window.php) rather than
   * recomputed here. The comparison is on the year NAME because the ids are
   * insertion order, and having that subtlety written down in two languages is
   * how the two stop agreeing.
   */
  const openYears = useMemo(() => (config?.school_years || []).filter((year) => year.is_open === 1), [config]);

  const post = sendGradeRemarkPolicy;

  async function setCurrentYear(schoolYearId) {
    const year = (config?.school_years || []).find((y) => String(y.school_year_id) === String(schoolYearId));
    const confirmed = await confirmAction({
      title: `Make ${year?.schoolyear_name} the current school year?`,
      message:
        "Grade policies apply to the current year and later ones. Moving this line freezes every earlier year: their records keep the remarks they already have and stop being recalculated.",
      confirmLabel: "Set as current",
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      const response = await fetch(getBackendUrl("school_year.php?action=set_current"), {
        method: "PUT",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({ school_year_id: Number(schoolYearId) }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not change the current school year.");
      notifySuccess(`${year?.schoolyear_name} is now the current school year.`);
      await load();
    } catch (saveError) {
      notifyError(saveError?.message || "Could not change the current school year.");
    } finally {
      setBusy(false);
    }
  }

  async function createPolicy() {
    if (!newPolicyName.trim()) {
      notifyError("Give the policy a name.");
      return;
    }
    setBusy(true);
    try {
      await post("?action=policy", "POST", {
        policy_name: newPolicyName.trim(),
        school_year_id: newPolicyYear || null,
        is_active: 1,
      });
      // The new policy starts as a copy of whatever governs that year today, so
      // there is something to edit rather than an empty screen — see the server.
      notifySuccess("Policy created. Edit its copied rules in Remarks Management.");
      setNewPolicyName("");
      setNewPolicyYear("");
      await load();
    } catch (saveError) {
      notifyError(saveError?.message || "Could not create the policy.");
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <DashboardPanel><p style={{ color: "var(--text-muted)" }}>Loading grade policy…</p></DashboardPanel>;
  if (error) return <DashboardPanel><AlertMessage tone="error" message={error} /></DashboardPanel>;

  return (
    <DashboardPanel>
      <SectionHeader
        title="Current school year"
        subtitle="Policies apply to this year and later ones. Earlier years are frozen: their records keep the remarks they already have."
      />

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, margin: "10px 0 22px" }}>
        {(config?.school_years || []).map((year) => {
          const isCurrent = Number(year.is_current) === 1;
          const isOpen = year.is_open === 1;
          return (
            <button
              key={year.school_year_id}
              type="button"
              disabled={!canEdit || busy || isCurrent}
              onClick={() => void setCurrentYear(year.school_year_id)}
              title={isCurrent ? "This is the current school year" : "Make this the current school year"}
              style={{
                padding: "6px 11px",
                borderRadius: 999,
                fontSize: 12.5,
                cursor: !canEdit || isCurrent ? "default" : "pointer",
                border: `1px solid ${isCurrent ? tone("success").border : "var(--border-strong)"}`,
                background: isCurrent ? tone("success").bg : "var(--surface-base)",
                color: isCurrent ? tone("success").text : isOpen ? "var(--text-primary)" : "var(--text-muted)",
                fontWeight: isCurrent ? 600 : 400,
              }}
            >
              {year.schoolyear_name}
              {isCurrent ? " · current" : isOpen ? "" : " · frozen"}
            </button>
          );
        })}
      </div>

      <SectionHeader
        title="Grade policy versions"
        subtitle="This page controls the school-year boundary. Grade rule conditions are edited only in Remarks Management."
      />

      <AlertMessage
        tone="info"
        message="To add, reorder, test, or remove grade rules, open Remarks Management and choose Grade rules. Keeping one editor prevents two screens from appearing to hold separate settings."
      />

      {policies.length ? (
        <div style={{ display: "grid", gap: 7, marginTop: 10 }}>
          {policies.map((policy) => {
            const editable = policy.is_editable === 1;
            const ruleCount = (policy.rules || []).length;
            return (
              <div
                key={policy.policy_id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 12,
                  flexWrap: "wrap",
                  padding: "9px 11px",
                  border: "1px solid var(--border-base)",
                  borderRadius: 8,
                  background: "var(--surface-base)",
                }}
              >
                <span style={{ display: "grid", gap: 2 }}>
                  <strong style={{ fontSize: 12.5 }}>{policy.policy_name}</strong>
                  <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                    {policy.schoolyear_name || "Fallback for a year without its own policy"}
                  </span>
                </span>
                <span style={{ color: editable ? tone("success").text : "var(--text-muted)", fontSize: 11.5 }}>
                  {ruleCount} {ruleCount === 1 ? "rule" : "rules"} · {editable ? "open" : "frozen"}
                </span>
              </div>
            );
          })}
        </div>
      ) : (
        <AlertMessage tone="info" message="No policy exists yet." />
      )}

      {canEdit ? (
        <div style={{ marginTop: 26 }}>
          <SectionHeader
            title="New policy for a year"
            subtitle="Starts as a copy of the rules already governing that year. Continue rule editing in Remarks Management."
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
            <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>Name</span>
              <input
                value={newPolicyName}
                onChange={(event) => setNewPolicyName(event.target.value)}
                placeholder="2027-2028 targets"
                style={{ padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-strong)", minWidth: 200 }}
              />
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>School year</span>
              <select
                value={newPolicyYear}
                onChange={(event) => setNewPolicyYear(event.target.value)}
                style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
              >
                <option value="">Any year without its own policy</option>
                {/* Only open years: a policy pinned to a finished year is refused
                    by the server, because it would sit there looking
                    authoritative and never once be applied. */}
                {openYears.map((year) => (
                  <option key={year.school_year_id} value={year.school_year_id}>{year.schoolyear_name}</option>
                ))}
              </select>
            </label>
            <Button size="sm" disabled={busy} onClick={() => void createPolicy()}>Create policy</Button>
          </div>
        </div>
      ) : null}
    </DashboardPanel>
  );
}
