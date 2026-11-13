import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage, Button, SectionHeader } from "../../shared/components/ui";
import { PolicyRuleEditor, PolicyRuleTable } from "../../shared/components/policy/PolicyRules";
import { getBackendUrl } from "../../shared/lib/url";
import { confirmAction, notifyError, notifySuccess } from "../../shared/lib/notify";
import {
  GRADE_REMARK_FIELDS,
  GRADE_REMARK_OPERATORS,
  matchGradeRemarkRule,
  sendGradeRemarkPolicy,
} from "../../shared/lib/gradeRemarkPolicy";

/**
 * The rules that decide which remark a grade row carries.
 *
 * This is the one grade-rule editor. Settings owns the current-school-year
 * switcher and policy creation, because moving the line that decides which
 * years are frozen has consequences well beyond remarks. Keeping each control
 * in one place makes it clear which screen is authoritative.
 *
 * It lives here because a remark and the rule that hands it out are one job.
 * Creating "Conditional" in the tab next door and then having to go to Settings
 * to say when anybody gets it is the kind of split that leaves a vocabulary full
 * of remarks nothing ever assigns.
 */

const EMPTY_CONDITION = { field_key: "failed", operator: "gte", value_min: "1", value_max: "" };
const FIELD_LABEL = Object.fromEntries(GRADE_REMARK_FIELDS.map((field) => [field.key, field.label]));

export default function GradeRemarkRules({ canEdit = true }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [selectedPolicyId, setSelectedPolicyId] = useState(null);
  const [editingRule, setEditingRule] = useState(null);
  const [sample, setSample] = useState({
    total_subject: "8",
    failed: "1",
    incomplete: "0",
    no_credit: "0",
    no_grade: "0",
  });

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
      setSelectedPolicyId((previous) =>
        previous && (payload.data.policies || []).some((policy) => policy.policy_id === previous)
          ? previous
          : payload.data.policies?.[0]?.policy_id ?? null
      );
    } catch (loadError) {
      setError(loadError?.message || "Could not read the grade remark policy.");
    } finally {
      setLoading(false);
    }
  }, []);

  /*
   * Add a remark from inside the rule form.
   *
   * `applies_to` is pinned to 'grades' rather than left as 'any': a remark
   * invented while writing grades rules belongs to grades, and letting it
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
          applies_to: "grades",
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

  const sampleRow = useMemo(() => {
    const number = (value) => {
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
    };
    const total = number(sample.total_subject);
    const failed = number(sample.failed);
    const incomplete = number(sample.incomplete);
    const noCredit = number(sample.no_credit);
    const noGrade = number(sample.no_grade);
    return {
      total_subject: total,
      passed: Math.max(0, total - failed - incomplete - noCredit - noGrade),
      failed,
      incomplete,
      no_credit: noCredit,
      no_grade: noGrade,
    };
  }, [sample]);

  // Evaluated with the same interpreter the Add Grade form uses, so what this
  // preview says is what that form will say.
  const sampleMatch = useMemo(
    () => (selectedPolicy ? matchGradeRemarkRule(sampleRow, selectedPolicy.rules || []) : null),
    [selectedPolicy, sampleRow]
  );

  const send = sendGradeRemarkPolicy;

  async function saveRule(rule) {
    const conditions = (rule.conditions || []).filter(
      (condition) => condition.operator === "eq_total" || String(condition.value_min ?? "") !== ""
    );
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
   * Renumbers the whole list to 10, 20, 30... and saves only the rules whose
   * number actually changed. A bare swap of two sort_orders looks simpler and
   * fails on the case that matters: two rules already sharing a number, where
   * swapping is a no-op and the arrow appears broken. Renumbering also
   * repairs that list on the way past.
   *
   * Every save sends the rule WHOLE, conditions included: the endpoint rewrites
   * a rule's conditions on each PUT, so a payload carrying only the new order
   * would quietly empty them.
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
      // Put the list back to whatever the server actually holds, rather than
      // leaving the screen showing an order that was never saved.
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function deleteRule(rule) {
    const confirmed = await confirmAction({
      title: `Remove "${rule.label}"?`,
      message: "Grades already recorded keep the remark they have. This only changes what future rows are given.",
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

  if (loading) return <p style={{ color: "var(--text-muted)" }}>Loading grade remark rules…</p>;
  if (error) return <AlertMessage tone="error" message={error} />;

  return (
    <div>
      <SectionHeader
        title="Grade remark rules"
        subtitle="Tried top to bottom, first match wins — so the order is part of the policy, not a display preference."
      />

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", margin: "10px 0" }}>
        <label htmlFor="grade_rules_policy" style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
          Policy
        </label>
        <select
          id="grade_rules_policy"
          value={selectedPolicyId ?? ""}
          onChange={(event) => setSelectedPolicyId(Number(event.target.value))}
          style={{ padding: "5px 8px", borderRadius: 6, border: "1px solid var(--border-strong)", fontSize: 12.5, minWidth: 300 }}
        >
          {policies.map((policy) => (
            <option key={policy.policy_id} value={policy.policy_id}>
              {policy.policy_name} — {policy.schoolyear_name || "any year without its own policy"}
              {policy.is_editable === 1 ? "" : " (frozen)"}
            </option>
          ))}
        </select>
      </div>

      {selectedPolicy && selectedPolicy.is_editable !== 1 ? (
        <AlertMessage
          tone="info"
          message={`${selectedPolicy.schoolyear_name} has finished. Its rules are shown so they can be compared against, but they cannot be changed — those records keep the remarks they were given.`}
        />
      ) : null}

      {selectedPolicy ? (
        <PolicyRuleTable
          rules={selectedPolicy.rules || []}
          fields={GRADE_REMARK_FIELDS}
          operators={GRADE_REMARK_OPERATORS}
          readOnly={!isEditable}
          onEdit={(rule) => setEditingRule({ ...rule })}
          onRemove={(rule) => void deleteRule(rule)}
          onReorder={isEditable ? (rule, direction) => void reorderRule(rule, direction) : null}
          // Which rung the sample below stops on. The preview named a remark
          // but not the rule that produced it, which is the actual question
          // when a ladder of similar rules behaves unexpectedly.
          matchedRuleId={sampleMatch?.rule_id ?? null}
          editingRuleId={editingRule?.rule_id ?? null}
          emptyText="This policy has no rules, so no grade remark is given."
        />
      ) : (
        <AlertMessage tone="info" message="No grade remark policy exists yet." />
      )}

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
                conditions: [{ ...EMPTY_CONDITION }],
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
          fields={GRADE_REMARK_FIELDS}
          operators={GRADE_REMARK_OPERATORS}
          position={(selectedPolicy?.rules || []).findIndex((r) => r.rule_id === editingRule.rule_id) + 1 || null}
          totalRules={(selectedPolicy?.rules || []).length || null}
          onChange={setEditingRule}
          onCancel={() => setEditingRule(null)}
          onSave={() => void saveRule(editingRule)}
          busy={busy}
        />
      ) : null}

      <div style={{ marginTop: 26 }}>
        <SectionHeader
          title="Try it"
          subtitle="What this policy would call a row, worked out the same way the Add Grade form does."
        />
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
          {["total_subject", "failed", "incomplete", "no_credit", "no_grade"].map((key) => (
            <label key={key} style={{ display: "grid", gap: 3, fontSize: 11 }}>
              <span style={{ color: "var(--text-muted)" }}>{FIELD_LABEL[key]}</span>
              <input
                type="number"
                min="0"
                value={sample[key]}
                onChange={(event) => setSample((prev) => ({ ...prev, [key]: event.target.value }))}
                style={{ width: 92, padding: "5px 7px", borderRadius: 6, border: "1px solid var(--border-strong)" }}
              />
            </label>
          ))}
          <div style={{ fontSize: 12.5, paddingBottom: 5 }}>
            → <strong>{sampleMatch?.remark_name || "no remark"}</strong>
            {sampleMatch ? (
              <span style={{ color: "var(--text-muted)" }}>
                {" "}from “{sampleMatch.label}”, highlighted above
              </span>
            ) : (
              <span style={{ color: "var(--text-muted)" }}> — no rule matched these numbers</span>
            )}
          </div>
        </div>
      </div>

      <p style={{ fontSize: 11.5, color: "var(--text-muted)", marginTop: 22 }}>
        Which school year is current — the line that decides which policies are frozen — is set in Settings, because it
        governs far more than remarks.
      </p>
    </div>
  );
}
