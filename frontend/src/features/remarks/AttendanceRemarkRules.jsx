import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage, Button, SectionHeader } from "../../shared/components/ui";
import { PolicyRuleEditor, PolicyRuleTable } from "../../shared/components/policy/PolicyRules";
import { getBackendUrl } from "../../shared/lib/url";
import { confirmAction, notifyError, notifySuccess } from "../../shared/lib/notify";
import {
  ATTENDANCE_REMARK_FIELDS,
  ATTENDANCE_REMARK_OPERATORS,
  attendanceTarget,
  describeScope,
  describeTarget,
  matchAttendanceRemarkRule,
} from "../../shared/lib/attendanceRemarkPolicy";
import { PERIOD_TERM_WRITE_LABEL, periodWriteOptions } from "../../shared/lib/periods";
import { tone } from "../../shared/theme/tokens";

/**
 * The absence target, and the rules that read it.
 *
 * Two things on one screen because they are one decision. "No more than eight
 * absences" is the target; "past the target means Excessive Absences" is a rule
 * about it. On separate screens somebody moves the target here and leaves a rule
 * quoting the old number there, and nothing tells them.
 *
 * SCOPE IS THE POINT OF THIS SCREEN
 *
 * A target set per school year is not enough. A periodical runs about fifteen
 * class meetings and a semester about forty-five, so one absence count cannot
 * serve both -- which is exactly what the hardcoded 75 in
 * attendanceReportMetrics.js was doing before any of this existed. So a policy
 * is pinned to a year, optionally a semester, and optionally a period, and the
 * most specific one wins.
 *
 * THE FREEZE
 *
 * A finished year's policy is read-only, and shown rather than hidden. Its
 * target is the standard that year's records were judged against; an
 * administrator needs to be able to read it in order to compare, and needs to
 * see that it cannot be moved. `is_editable` arrives from the server rather than
 * being worked out here -- the comparison that decides it is on the year NAME,
 * because the school_year ids are insertion order and 2022-2023 has a higher id
 * than 2026-2027.
 */

const EMPTY_SAMPLE = { total_classes_conducted: "44", absent: "8" };

export default function AttendanceRemarkRules({ canEdit = true }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [selectedPolicyId, setSelectedPolicyId] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [targetDraft, setTargetDraft] = useState(null);
  const [sample, setSample] = useState({ ...EMPTY_SAMPLE });
  const [newPolicy, setNewPolicy] = useState({ name: "", school_year_id: "", semester_id: "", period: "" });

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(getBackendUrl("attendance_remark_policy.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not read the attendance policy.");
      setConfig(payload.data);
      setSelectedPolicyId((previous) =>
        previous && (payload.data.policies || []).some((policy) => policy.policy_id === previous)
          ? previous
          : payload.data.policies?.[0]?.policy_id ?? null
      );
    } catch (loadError) {
      setError(loadError?.message || "Could not read the attendance policy.");
    } finally {
      setLoading(false);
    }
  }, []);

  /*
   * Add a remark from inside the rule form.
   *
   * `applies_to` is pinned to 'attendance' rather than left as 'any': a remark
   * invented while writing attendance rules belongs to attendance, and letting it
   * default to 'any' would quietly add it to the other engine's dropdown too.
   *
   * Reloads before returning so the new remark is in `config.remarks` by the
   * time the editor selects it -- otherwise the select holds an id it has no
   * option for, and renders blank.
   */
  const createRemark = useCallback(
    async ({ remark_name, risk_level }) => {
      const response = await fetch(getBackendUrl("remarks.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({
          remark_name,
          risk_level,
          applies_to: "attendance",
          description: "",
          status: 1,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not add the remark.");
      await load();
      return payload?.data || null;
    },
    [load]
  );

  useEffect(() => {
    void load();
  }, [load]);

  const policies = useMemo(() => config?.policies || [], [config]);
  const selectedPolicy = policies.find((policy) => policy.policy_id === selectedPolicyId) || null;
  const isEditable = canEdit && selectedPolicy?.is_editable === 1;

  // The draft follows the selection rather than being seeded once, so switching
  // policies does not leave the previous one's numbers sitting in the boxes
  // waiting to be saved onto the wrong year.
  useEffect(() => {
    if (!selectedPolicy) {
      setTargetDraft(null);
      return;
    }
    setTargetDraft({
      target_max_absences: selectedPolicy.target_max_absences ?? "",
      target_min_rate: selectedPolicy.target_min_rate ?? "",
    });
  }, [selectedPolicy]);

  const sampleRow = useMemo(() => {
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    };
    const conducted = number(sample.total_classes_conducted);
    const absent = Math.min(conducted, number(sample.absent));
    return { total_classes_conducted: conducted, absent, present: Math.max(0, conducted - absent) };
  }, [sample]);

  /*
   * The preview evaluates the DRAFT target, not the saved one.
   *
   * Typing 6 into the box and seeing the answer still computed against 8 makes
   * the preview useless for the only thing anybody wants it for: deciding what
   * number to type. The rules come from the saved policy either way -- they are
   * saved one at a time and there is no draft of them.
   */
  const previewPolicy = useMemo(() => {
    if (!selectedPolicy) return null;
    return { ...selectedPolicy, ...(targetDraft || {}) };
  }, [selectedPolicy, targetDraft]);

  const sampleMatch = useMemo(() => matchAttendanceRemarkRule(sampleRow, previewPolicy), [sampleRow, previewPolicy]);
  const draftTarget = useMemo(() => attendanceTarget(previewPolicy), [previewPolicy]);

  const send = useCallback(async (path, method, body) => {
    const response = await fetch(getBackendUrl(`attendance_remark_policy.php${path}`), {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || "The change could not be saved.");
    return payload;
  }, []);

  async function saveTarget() {
    setBusy(true);
    try {
      await send("?action=policy", "PUT", {
        policy_id: selectedPolicyId,
        target_max_absences: targetDraft.target_max_absences,
        target_min_rate: targetDraft.target_min_rate,
      });
      notifySuccess("Target saved. It applies from now on; records already recorded keep what they were judged against.");
      await load();
    } catch (saveError) {
      notifyError(saveError?.message || "Could not save the target.");
    } finally {
      setBusy(false);
    }
  }

  async function saveRule(rule) {
    const conditions = (rule.conditions || []).filter((condition) => String(condition.value_min ?? "") !== "");
    setBusy(true);
    try {
      await send("?action=rule", rule.rule_id ? "PUT" : "POST", {
        rule_id: rule.rule_id,
        policy_id: selectedPolicyId,
        remark_id: Number(rule.remark_id),
        label: rule.label,
        sort_order: Number(rule.sort_order) || 0,
        is_active: rule.is_active === 0 ? 0 : 1,
        conditions,
      });
      notifySuccess("Rule saved.");
      setEditingRule(null);
      await load();
    } catch (saveError) {
      notifyError(saveError?.message || "Could not save the rule.");
    } finally {
      setBusy(false);
    }
  }

  /**
   * Move a rule up or down the ladder.
   *
   * Same shape as GradeRemarkRules.reorderRule, deliberately: this file and
   * that one are the same editor over different field vocabularies, and the
   * two are read side by side.
   *
   * Renumbers to 10, 20, 30... and saves only what changed. A bare swap fails
   * when two rules already share a number -- swapping is then a no-op and the
   * arrow looks broken. Each save sends the rule WHOLE: the endpoint rewrites
   * conditions on every PUT, so an order-only payload would empty them.
   */
  async function reorderRule(rule, direction) {
    const current = selectedPolicy?.rules || [];
    const from = current.findIndex((entry) => entry.rule_id === rule.rule_id);
    const to = from + direction;
    if (from < 0 || to < 0 || to >= current.length) return;

    const moved = current.slice();
    [moved[from], moved[to]] = [moved[to], moved[from]];

    const changed = moved
      .map((entry, index) => ({ entry, sort_order: (index + 1) * 10 }))
      .filter(({ entry, sort_order }) => Number(entry.sort_order) !== sort_order);

    if (!changed.length) return;

    setBusy(true);
    try {
      for (const { entry, sort_order } of changed) {
        // eslint-disable-next-line no-await-in-loop
        await send("?action=rule", "PUT", {
          rule_id: entry.rule_id,
          policy_id: selectedPolicyId,
          remark_id: Number(entry.remark_id),
          label: entry.label,
          sort_order,
          is_active: entry.is_active === 0 ? 0 : 1,
          conditions: entry.conditions || [],
        });
      }
      await load();
    } catch (reorderError) {
      notifyError(reorderError?.message || "Could not move the rule.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(rule) {
    const confirmed = await confirmAction({
      title: `Remove "${rule.label}"?`,
      message: "Attendance already recorded is unaffected. This only changes what future rows are called.",
      confirmLabel: "Remove rule",
      tone: "danger",
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      await send(`?action=rule&rule_id=${rule.rule_id}`, "DELETE");
      notifySuccess("Rule removed.");
      await load();
    } catch (deleteError) {
      notifyError(deleteError?.message || "Could not remove the rule.");
    } finally {
      setBusy(false);
    }
  }

  async function createPolicy() {
    if (!newPolicy.name.trim()) {
      notifyError("Give the target a name.");
      return;
    }
    setBusy(true);
    try {
      await send("?action=policy", "POST", {
        policy_name: newPolicy.name.trim(),
        school_year_id: newPolicy.school_year_id || null,
        semester_id: newPolicy.semester_id || null,
        period: newPolicy.period || null,
        target_max_absences: selectedPolicy?.target_max_absences ?? "",
        target_min_rate: selectedPolicy?.target_min_rate ?? "",
        is_active: 1,
      });
      notifySuccess("Target created, starting from a copy of the rules already in force for that term.");
      setNewPolicy({ name: "", school_year_id: "", semester_id: "", period: "" });
      await load();
    } catch (saveError) {
      notifyError(saveError?.message || "Could not create the target.");
    } finally {
      setBusy(false);
    }
  }

  const openYears = useMemo(() => (config?.school_years || []).filter((year) => year.is_open === 1), [config]);

  // describeScope() takes camelCase keys; the payload is snake_case. Mapped once
  // here rather than passing `config` straight through, which type-checked fine
  // and quietly handed the fallback lookup an empty list.
  const scopeNames = useMemo(
    () => ({ schoolYears: config?.school_years || [], semesters: config?.semesters || [] }),
    [config]
  );

  if (loading) return <p style={{ color: "var(--text-muted)" }}>Loading attendance policy…</p>;
  if (error) return <AlertMessage tone="error" message={error} />;

  return (
    <div>
      <SectionHeader
        title="Attendance target"
        subtitle="Set per school year, and narrower where a term needs it: a periodical of fifteen meetings and a semester of forty-five cannot share one absence count."
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "10px 0 4px" }}>
        <label htmlFor="attendance_policy_select" style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Applies to
        </label>
        <select
          id="attendance_policy_select"
          value={selectedPolicyId ?? ""}
          onChange={(event) => setSelectedPolicyId(Number(event.target.value))}
          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-strong)", fontSize: 12.5, minWidth: 320 }}
        >
          {policies.map((policy) => (
            <option key={policy.policy_id} value={policy.policy_id}>
              {policy.policy_name} — {describeScope(policy, scopeNames)}
              {policy.is_editable === 1 ? "" : " (frozen)"}
            </option>
          ))}
        </select>
      </div>

      {selectedPolicy && selectedPolicy.is_editable !== 1 ? (
        <AlertMessage
          tone="info"
          message={
            // A closed semester reading through this target freezes it too, and
            // the server says which one - "has finished" would be wrong for a
            // semester closed this year.
            selectedPolicy.frozen_reason
              || `${selectedPolicy.schoolyear_name} has finished. Its target is shown so it can be compared against, but it cannot be changed — those records keep the standard they were judged against.`
          }
        />
      ) : null}

      {selectedPolicy && targetDraft ? (
        <div
          style={{
            display: "flex",
            gap: 14,
            flexWrap: "wrap",
            alignItems: "flex-end",
            padding: 14,
            marginTop: 10,
            borderRadius: 10,
            border: "1px solid var(--border-strong)",
            background: "var(--surface-muted, #f8fafc)",
          }}
        >
          <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
            <span style={{ color: "var(--text-muted)" }}>Most absences allowed</span>
            <input
              type="number"
              min="0"
              disabled={!isEditable}
              value={targetDraft.target_max_absences}
              onChange={(event) => setTargetDraft((prev) => ({ ...prev, target_max_absences: event.target.value }))}
              placeholder="no limit"
              style={{ width: 120, padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
            />
          </label>
          <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
            <span style={{ color: "var(--text-muted)" }}>Lowest attendance rate (%)</span>
            <input
              type="number"
              min="0"
              max="100"
              step="0.5"
              disabled={!isEditable}
              value={targetDraft.target_min_rate}
              onChange={(event) => setTargetDraft((prev) => ({ ...prev, target_min_rate: event.target.value }))}
              placeholder="no minimum"
              style={{ width: 150, padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
            />
          </label>
          {isEditable ? (
            <Button size="sm" disabled={busy} onClick={() => void saveTarget()}>
              Save target
            </Button>
          ) : null}
          <p style={{ fontSize: 11.5, color: "var(--text-muted)", margin: 0, flex: "1 1 260px" }}>
            {/* Both halves are honoured because they catch different students: a
                count catches the one who missed nine of forty-five, a rate
                catches the one who missed four of twelve. Either alone lets one
                of those two through. */}
            A student must satisfy both to meet the target. Leave a box empty to drop that half.
          </p>
        </div>
      ) : null}

      <div style={{ marginTop: 26 }}>
        <SectionHeader
          title="Attendance remark rules"
          subtitle="Tried top to bottom, first match wins — so the order is part of the policy, not a display preference."
        />
        <div style={{ marginTop: 10 }}>
          {selectedPolicy ? (
            <PolicyRuleTable
              rules={selectedPolicy.rules || []}
              fields={ATTENDANCE_REMARK_FIELDS}
              operators={ATTENDANCE_REMARK_OPERATORS}
              readOnly={!isEditable}
              onEdit={(rule) => setEditingRule({ ...rule })}
              onRemove={(rule) => void deleteRule(rule)}
              onReorder={isEditable ? (rule, direction) => void reorderRule(rule, direction) : null}
              // The rung the sample below stops on. previewPolicy spreads the
              // selected policy, so these are the same rule objects and the
              // ids line up with the rows.
              matchedRuleId={sampleMatch?.rule_id ?? null}
              editingRuleId={editingRule?.rule_id ?? null}
              emptyText="This target has no rules yet, so no attendance remark is given."
            />
          ) : (
            <AlertMessage tone="info" message="No attendance target exists yet." />
          )}
        </div>

        {isEditable ? (
          <div style={{ marginTop: 10 }}>
            <Button
              size="sm"
              onClick={() =>
                setEditingRule({
                  rule_id: null,
                  label: "",
                  remark_id: config?.remarks?.[0]?.remark_id ?? "",
                  sort_order: ((selectedPolicy?.rules || []).at(-1)?.sort_order ?? 0) + 10,
                  is_active: 1,
                  conditions: [{ field_key: "absences_over_target", operator: "gte", value_min: "1", value_max: "" }],
                })
              }
            >
              Add a rule
            </Button>
          </div>
        ) : null}

        {editingRule ? (
          <PolicyRuleEditor
            rule={editingRule}
            remarks={config?.remarks || []}
            onCreateRemark={isEditable ? createRemark : null}
            fields={ATTENDANCE_REMARK_FIELDS}
            operators={ATTENDANCE_REMARK_OPERATORS}
            position={(selectedPolicy?.rules || []).findIndex((r) => r.rule_id === editingRule.rule_id) + 1 || null}
            totalRules={(selectedPolicy?.rules || []).length || null}
            onChange={setEditingRule}
            onCancel={() => setEditingRule(null)}
            onSave={() => void saveRule(editingRule)}
            busy={busy}
          />
        ) : null}
      </div>

      <div style={{ marginTop: 26 }}>
        <SectionHeader
          title="Try it"
          subtitle="What this target would call a student, worked out in the browser the same way the server does."
        />
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
          <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
            <span style={{ color: "var(--text-muted)" }}>Classes held</span>
            <input
              type="number"
              min="0"
              value={sample.total_classes_conducted}
              onChange={(event) => setSample((prev) => ({ ...prev, total_classes_conducted: event.target.value }))}
              style={{ width: 100, padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
            />
          </label>
          <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
            <span style={{ color: "var(--text-muted)" }}>Absences</span>
            <input
              type="number"
              min="0"
              value={sample.absent}
              onChange={(event) => setSample((prev) => ({ ...prev, absent: event.target.value }))}
              style={{ width: 100, padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
            />
          </label>
          <div style={{ fontSize: 12.5, paddingBottom: 5 }}>
            <div>
              →{" "}
              <strong>{sampleMatch?.remark_name || "no remark"}</strong>
              {sampleMatch ? (
                <span style={{ color: "var(--text-muted)" }}>
                  {" "}from “{sampleMatch.label}”, highlighted above
                </span>
              ) : (
                <span style={{ color: "var(--text-muted)" }}> — no rule matched these numbers</span>
              )}
            </div>
            <div style={{ color: "var(--text-muted)", fontSize: 11.5, marginTop: 2 }}>
              {sampleRow.total_classes_conducted > 0
                ? `${((sampleRow.present / sampleRow.total_classes_conducted) * 100).toFixed(1)}% attendance · target: ${describeTarget(draftTarget)}`
                : "No classes held, so there is nothing to judge."}
            </div>
          </div>
        </div>
      </div>

      {canEdit ? (
        <div style={{ marginTop: 26 }}>
          <SectionHeader
            title="A different target for one term"
            subtitle="Starts as a copy of the rules already governing that term, so there is something to edit rather than a target that remarks nothing."
          />
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
            <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>Name</span>
              <input
                value={newPolicy.name}
                onChange={(event) => setNewPolicy((prev) => ({ ...prev, name: event.target.value }))}
                placeholder="P1 target 2026-2027"
                style={{ padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-strong)", minWidth: 200 }}
              />
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>School year</span>
              <select
                value={newPolicy.school_year_id}
                onChange={(event) => setNewPolicy((prev) => ({ ...prev, school_year_id: event.target.value }))}
                style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
              >
                <option value="">Any term without its own</option>
                {/* Only open years. A target pinned to a finished year is refused
                    by the server: it would sit there looking authoritative while
                    disagreeing with every printout of that term. */}
                {openYears.map((year) => (
                  <option key={year.school_year_id} value={year.school_year_id}>
                    {year.schoolyear_name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>Semester</span>
              <select
                value={newPolicy.semester_id}
                onChange={(event) => setNewPolicy((prev) => ({ ...prev, semester_id: event.target.value }))}
                style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
              >
                <option value="">Every semester</option>
                {(config?.semesters || []).map((semester) => (
                  <option key={semester.semester_id} value={semester.semester_id}>
                    {semester.semester_name}
                  </option>
                ))}
              </select>
            </label>
            <label style={{ display: "grid", gap: 3, fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>Period</span>
              <select
                value={newPolicy.period}
                onChange={(event) => setNewPolicy((prev) => ({ ...prev, period: event.target.value }))}
                style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
              >
                {/* The same options every other write form offers, from
                    periods.js -- "P1 - First Periodical" rather than a bare
                    number, so the choice reads the same here as it does in the
                    importer. */}
                <option value="">{PERIOD_TERM_WRITE_LABEL}</option>
                {periodWriteOptions({ includeBlank: false }).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <Button size="sm" disabled={busy} onClick={() => void createPolicy()}>
              Create target
            </Button>
          </div>
          <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 8 }}>
            The most specific match wins: a target for one semester beats the year&apos;s, and a target for one period
            beats the semester&apos;s.
          </p>
        </div>
      ) : null}

      {policies.length > 1 ? (
        <div style={{ marginTop: 26 }}>
          <SectionHeader title="Every target in force" subtitle="Frozen years are kept so this year can be compared against them." />
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 10 }}>
            {policies.map((policy) => {
              const frozen = policy.is_editable !== 1;
              return (
                <button
                  key={policy.policy_id}
                  type="button"
                  onClick={() => setSelectedPolicyId(policy.policy_id)}
                  style={{
                    textAlign: "left",
                    padding: "8px 11px",
                    borderRadius: 8,
                    cursor: "pointer",
                    border: `1px solid ${policy.policy_id === selectedPolicyId ? tone("info").border : "var(--border-strong)"}`,
                    background: policy.policy_id === selectedPolicyId ? tone("info").bg : "var(--surface-base)",
                    color: frozen ? "var(--text-muted)" : "var(--text-primary)",
                    fontSize: 11.5,
                    minWidth: 210,
                  }}
                >
                  <div style={{ fontWeight: 600 }}>{describeScope(policy, scopeNames)}</div>
                  <div>{describeTarget(attendanceTarget(policy))}</div>
                  {frozen ? <div style={{ fontSize: 10.5 }}>frozen · read-only</div> : null}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </div>
  );
}
