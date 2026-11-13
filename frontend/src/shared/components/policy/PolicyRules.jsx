import React, { useEffect, useMemo, useRef, useState } from "react";
// Imported by file, not through the ui barrel: that barrel re-exports
// Breadcrumb, which reaches react-router-dom -- ESM-only and unresolvable by
// CRA’s Jest. Going through it would make this component untestable.
import AlertMessage from "../ui/AlertMessage";
import Button from "../ui/Button";
import Table from "../Table";
import { tone } from "../../theme/tokens";
import { remarkTone } from "../../lib/remarkTone";

/**
 * The rule ladder, and the form for one rung of it.
 *
 * Extracted from GradePolicyPanel when attendance grew a policy of its own.
 * Both engines store the same shape -- an ordered list of rules, each a set of
 * ANDed conditions resolving to a remark -- and the only thing that differs is
 * the vocabulary of fields a condition may name. So the vocabulary is a prop and
 * everything else is shared.
 *
 * Copying the panel instead would have meant two screens that start identical
 * and drift: the first fix to the condition editor lands in one of them, nobody
 * notices, and an administrator learns two slightly different ways to write the
 * same sentence.
 *
 * WHAT THE COMPONENT DELIBERATELY DOES NOT KNOW
 *
 * How to save. Both panels talk to different endpoints with different scope
 * rules and different reasons to refuse, and a shared component that tried to
 * own the request would need a prop for each of those differences. It renders
 * and it calls back. Reordering is a callback for the same reason: it is two
 * saves, and only the parent knows how to make one.
 */

/** "Failed subjects is at least 1" -- a condition as a sentence. */
export function describeCondition(condition, fieldLabels, operatorLabels) {
  const field = fieldLabels[condition.field_key] || condition.field_key;
  const operator = operatorLabels[condition.operator] || condition.operator;

  if (condition.operator === "eq_total") {
    return `${field} ${operator}`;
  }

  const min = Number(condition.value_min);
  const minText = Number.isFinite(min) ? String(min) : "?";

  if (condition.operator === "between") {
    const max = Number(condition.value_max);
    return `${field} ${operator} ${minText} and ${Number.isFinite(max) ? max : "?"}`;
  }
  return `${field} ${operator} ${minText}`;
}

export function describeRule(rule, fieldLabels, operatorLabels) {
  const conditions = rule.conditions || [];
  if (conditions.length === 0) return "Everything that reached this rule";
  return conditions.map((condition) => describeCondition(condition, fieldLabels, operatorLabels)).join(" and ");
}

/**
 * "1st", "2nd", "3rd" -- the position a rule is tried in.
 *
 * The table used to print `sort_order` instead, which is 10, 20, 30: a spacing
 * convention that leaves room to insert between, and meaningless to the person
 * reading it. "First match wins" is a statement about POSITION, so the column
 * that explains the policy should show position. The stored number is still
 * what orders them; it is just no longer the thing on screen.
 */
export function ordinal(n) {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

const inputStyle = {
  padding: "5px 7px",
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
};

const selectStyle = { ...inputStyle, padding: "5px 8px" };

/**
 * The ladder as a table.
 *
 * `readOnly` renders the rules without the Edit and Remove buttons rather than
 * hiding the table. A frozen year's policy is the thing an administrator most
 * wants to LOOK at -- it is the standard last year's records were judged
 * against -- and hiding it to signal "you cannot edit this" hides the answer
 * along with the button.
 *
 * `matchedRuleId` marks the rule a preview landed on. Without it the "Try it"
 * box answers with a remark name and leaves the reader to work out WHICH rung
 * produced it -- which is the actual question when a policy is behaving
 * unexpectedly, and the one a list of near-identical rules is worst at
 * answering.
 *
 * `onReorder(rule, direction)` moves a rule up or down the ladder. Optional:
 * omit it and the arrows are not rendered.
 */
export function PolicyRuleTable({
  rules = [],
  fields,
  operators,
  onEdit,
  onRemove,
  onReorder = null,
  readOnly = false,
  emptyText,
  matchedRuleId = null,
  editingRuleId = null,
}) {
  const fieldLabels = Object.fromEntries(fields.map((field) => [field.key, field.label]));
  const operatorLabels = Object.fromEntries(operators.map((operator) => [operator.key, operator.label]));

  if (!rules.length) {
    return <AlertMessage tone="info" message={emptyText || "This policy has no rules yet."} />;
  }

  return (
    <Table
      columns={[
        { key: "sort_order", label: "Tried" },
        { key: "label", label: "Rule" },
        { key: "conditions", label: "When" },
        { key: "remark", label: "Remark" },
        { key: "actions", label: "" },
      ]}
      rows={rules.map((rule, index) => {
        const isMatch = matchedRuleId != null && rule.rule_id === matchedRuleId;
        const isEditing = editingRuleId != null && rule.rule_id === editingRuleId;
        const dimmed = rule.is_active === 0;

        return {
          key: rule.rule_id,
          sort_order: (
            <span style={{ display: "flex", alignItems: "center", gap: 6, whiteSpace: "nowrap" }}>
              <span style={{ fontVariantNumeric: "tabular-nums", opacity: dimmed ? 0.55 : 1 }}>
                {ordinal(index + 1)}
              </span>
              {onReorder && !readOnly ? (
                <span style={{ display: "inline-flex", gap: 2 }}>
                  {/* Arrows rather than a number box: "first match wins" is about
                      what sits above what, and asking someone to reach that by
                      typing 15 between 10 and 20 is asking them to hold the
                      spacing convention in their head. */}
                  <button
                    type="button"
                    aria-label="Move this rule earlier"
                    title="Move earlier"
                    disabled={index === 0}
                    onClick={() => onReorder(rule, -1)}
                    style={arrowStyle(index === 0)}
                  >
                    ↑
                  </button>
                  <button
                    type="button"
                    aria-label="Move this rule later"
                    title="Move later"
                    disabled={index === rules.length - 1}
                    onClick={() => onReorder(rule, 1)}
                    style={arrowStyle(index === rules.length - 1)}
                  >
                    ↓
                  </button>
                </span>
              ) : null}
            </span>
          ),
          label: (
            <span style={{ opacity: dimmed ? 0.55 : 1 }}>
              {rule.label}
              {isEditing ? (
                <span style={{ color: "var(--brand-600)", fontSize: 11, fontWeight: 600 }}> · editing</span>
              ) : null}
              {dimmed ? <span style={{ color: "var(--text-muted)", fontSize: 11 }}> · switched off</span> : null}
            </span>
          ),
          conditions: (
            <span style={{ opacity: dimmed ? 0.55 : 1 }}>
              {describeRule(rule, fieldLabels, operatorLabels)}
              {isMatch ? (
                <span
                  style={{
                    marginLeft: 8,
                    padding: "1px 7px",
                    borderRadius: 999,
                    fontSize: 10.5,
                    fontWeight: 600,
                    whiteSpace: "nowrap",
                    background: "var(--brand-600)",
                    color: "var(--text-inverse, #fff)",
                  }}
                >
                  ← your sample stops here
                </span>
              ) : null}
            </span>
          ),
          remark: (
            <span
              style={{
                padding: "2px 8px",
                borderRadius: 999,
                fontSize: 11.5,
                whiteSpace: "nowrap",
                opacity: dimmed ? 0.55 : 1,
                background: tone(remarkTone({ remark_risk: rule.risk_level })).bg,
                color: tone(remarkTone({ remark_risk: rule.risk_level })).text,
              }}
            >
              {rule.remark_name}
            </span>
          ),
          actions: readOnly ? null : (
            <span style={{ display: "flex", gap: 6 }}>
              <Button size="sm" variant="ghost" onClick={() => onEdit(rule)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onRemove(rule)}>
                Remove
              </Button>
            </span>
          ),
        };
      })}
    />
  );
}

function arrowStyle(disabled) {
  return {
    width: 20,
    height: 18,
    lineHeight: "16px",
    padding: 0,
    fontSize: 11,
    borderRadius: 4,
    border: "1px solid var(--border-base)",
    background: "var(--surface-base)",
    color: disabled ? "var(--text-muted)" : "var(--text-primary)",
    cursor: disabled ? "default" : "pointer",
    opacity: disabled ? 0.4 : 1,
  };
}

/** Editing one rule: what it assigns, when, and where it sits in the order. */
export function PolicyRuleEditor({
  rule,
  remarks,
  fields,
  operators,
  onChange,
  onCancel,
  onSave,
  busy,
  position = null,
  totalRules = null,
  onCreateRemark = null,
}) {
  const setField = (key, value) => onChange({ ...rule, [key]: value });
  const setCondition = (index, patch) =>
    onChange({
      ...rule,
      conditions: rule.conditions.map((condition, i) => (i === index ? { ...condition, ...patch } : condition)),
    });

  /*
   * Naming a remark without leaving the rule.
   *
   * A rule assigns a remark, and until this existed the remark had to already
   * exist -- so writing "absence rate >= 20% means Slip" meant going to
   * Remarks, adding Slip, coming back, finding the policy again and starting
   * the rule over. The name and the condition are one thought; splitting them
   * across two screens is what made this feel hard.
   *
   * Optional: a screen that passes no onCreateRemark keeps the plain dropdown.
   */
  const [namingRemark, setNamingRemark] = useState(false);
  const [newRemark, setNewRemark] = useState({ remark_name: "", risk_level: "Medium Risk" });
  const [remarkError, setRemarkError] = useState("");
  const [savingRemark, setSavingRemark] = useState(false);

  async function createRemark() {
    const name = newRemark.remark_name.trim();
    if (!name) {
      setRemarkError("Give the remark a name.");
      return;
    }
    // Caught here rather than at the server, because the server's refusal
    // would close nothing and the typed name would be lost.
    if (remarks.some((r) => r.remark_name.trim().toLowerCase() === name.toLowerCase())) {
      setRemarkError(`There is already a remark called "${name}".`);
      return;
    }
    setSavingRemark(true);
    setRemarkError("");
    try {
      const created = await onCreateRemark({ remark_name: name, risk_level: newRemark.risk_level });
      const id = created?.remark_id;
      if (!id) throw new Error("The remark was not created.");
      setField("remark_id", String(id));
      setNamingRemark(false);
      setNewRemark({ remark_name: "", risk_level: "Medium Risk" });
    } catch (e) {
      setRemarkError(e.message || "Could not add the remark.");
    } finally {
      setSavingRemark(false);
    }
  }

  const emptyCondition = { field_key: fields[0]?.key, operator: "gte", value_min: "1", value_max: "" };

  /*
   * The form opens BELOW the ladder, which on the attendance screen can be a
   * long way below. Pressing Edit and having nothing visibly happen is the
   * oldest bug in this panel; scrolling the form into view is the whole fix.
   */
  const boxRef = useRef(null);
  const ruleKey = rule.rule_id ?? "new";
  useEffect(() => {
    boxRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [ruleKey]);

  const fieldLabels = useMemo(() => Object.fromEntries(fields.map((f) => [f.key, f.label])), [fields]);
  const operatorLabels = useMemo(
    () => Object.fromEntries(operators.map((o) => [o.key, o.label])),
    [operators]
  );

  const assigns = remarks.find((r) => String(r.remark_id) === String(rule.remark_id));

  /*
   * The sentence, built with the SAME function the table prints. Two wordings
   * of one rule is how somebody ends up believing the editor and the list
   * disagree -- so there is only one, and it updates as the dropdowns move.
   */
  const sentence = describeRule(rule, fieldLabels, operatorLabels);

  return (
    <div
      ref={boxRef}
      style={{
        marginTop: 14,
        padding: 14,
        border: "1px solid var(--brand-600)",
        borderRadius: 10,
        background: "var(--surface-muted, #f8fafc)",
        display: "grid",
        gap: 12,
      }}
    >
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ display: "grid", gap: 3, fontSize: 11, flex: "1 1 240px" }}>
          <span style={{ color: "var(--text-muted)" }}>What this rule is for</span>
          <input
            value={rule.label}
            onChange={(event) => setField("label", event.target.value)}
            placeholder="Within two absences of the target"
            style={inputStyle}
          />
        </label>
        <div style={{ display: "grid", gap: 3, fontSize: 11 }}>
          <span style={{ color: "var(--text-muted)" }}>Assigns</span>
          {namingRemark ? (
            <div
              role="group"
              aria-label="New remark"
              style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}
            >
              <input
                autoFocus
                value={newRemark.remark_name}
                onChange={(event) => setNewRemark({ ...newRemark, remark_name: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") { event.preventDefault(); createRemark(); }
                  if (event.key === "Escape") { setNamingRemark(false); setRemarkError(""); }
                }}
                placeholder="Slip"
                aria-label="Name for the new remark"
                style={{ ...inputStyle, minWidth: 150 }}
              />
              <select
                value={newRemark.risk_level}
                onChange={(event) => setNewRemark({ ...newRemark, risk_level: event.target.value })}
                aria-label="Risk level for the new remark"
                style={selectStyle}
              >
                <option value="Low Risk">Low Risk</option>
                <option value="Medium Risk">Medium Risk</option>
                <option value="High Risk">High Risk</option>
              </select>
              <Button size="sm" onClick={createRemark} disabled={savingRemark}>
                {savingRemark ? "Adding..." : "Add"}</Button>
              <Button size="sm" variant="ghost" onClick={() => { setNamingRemark(false); setRemarkError(""); }}>
                Cancel</Button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <select value={rule.remark_id} onChange={(event) => setField("remark_id", event.target.value)} style={selectStyle}>
                {remarks.map((remark) => (
                  <option key={remark.remark_id} value={remark.remark_id}>
                    {remark.remark_name} ({remark.risk_level})
                  </option>
                ))}
              </select>
              {onCreateRemark ? (
                <Button size="sm" variant="ghost" onClick={() => setNamingRemark(true)}>
                  + New</Button>
              ) : null}
            </div>
          )}
          {remarkError ? (
            <span style={{ color: tone("danger").text, fontSize: 11 }}>{remarkError}</span>
          ) : null}
        </div>
        <label style={{ display: "flex", gap: 6, alignItems: "center", fontSize: 11.5, paddingBottom: 6 }}>
          <input
            type="checkbox"
            checked={rule.is_active !== 0}
            onChange={(event) => setField("is_active", event.target.checked ? 1 : 0)}
          />
          <span>In use</span>
        </label>
      </div>

      {/*
        * Where it sits, as words rather than as the stored number.
        *
        * This was a number input holding values like 10, 20, 30. Nobody could
        * act on it without first working out the spacing convention, and
        * typing the wrong number silently moved a rule past one it was meant
        * to come after -- changing the policy while looking like a typo.
        * Position is read here and changed with the arrows in the list.
        */}
      <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
        {rule.rule_id
          ? `Tried ${position ? ordinal(position) : ""}${totalRules ? ` of ${totalRules}` : ""}. Use the ↑ ↓ arrows in the list to move it.`
          : "Will be added at the end of the list. Use the ↑ ↓ arrows afterwards to move it."}
      </div>

      <div style={{ display: "grid", gap: 7 }}>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          When all of these are true
          {rule.conditions.length === 0 ? " — with none, this rule matches everything that reaches it" : ""}
        </span>
        {rule.conditions.map((condition, index) => (
          // eslint-disable-next-line react/no-array-index-key
          <div key={index} style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
            {/* The joiner, shown rather than implied by stacking: these are
                ANDed, and a list of rows reads just as naturally as OR. */}
            <span
              style={{
                fontSize: 11,
                width: 26,
                textAlign: "right",
                color: "var(--text-muted)",
                fontStyle: index === 0 ? "normal" : "italic",
              }}
            >
              {index === 0 ? "" : "and"}
            </span>
            <select
              value={condition.field_key}
              onChange={(event) => setCondition(index, { field_key: event.target.value })}
              style={selectStyle}
            >
              {fields.map((field) => (
                <option key={field.key} value={field.key}>
                  {field.label}
                </option>
              ))}
            </select>
            <select
              value={condition.operator}
              onChange={(event) => {
                const nextOperator = event.target.value;
                const needsValue = operators.find((operator) => operator.key === nextOperator)?.requiresValue !== false;
                setCondition(index, {
                  operator: nextOperator,
                  ...(needsValue ? {} : { value_min: "", value_max: "" }),
                });
              }}
              style={selectStyle}
            >
              {operators.map((operator) => (
                <option key={operator.key} value={operator.key}>
                  {operator.label}
                </option>
              ))}
            </select>
            {operators.find((operator) => operator.key === condition.operator)?.requiresValue !== false ? (
              <input
                type="number"
                value={condition.value_min ?? ""}
                onChange={(event) => setCondition(index, { value_min: event.target.value })}
                style={{ ...inputStyle, width: 84 }}
              />
            ) : null}
            {condition.operator === "between" ? (
              <input
                type="number"
                value={condition.value_max ?? ""}
                placeholder="and"
                onChange={(event) => setCondition(index, { value_max: event.target.value })}
                style={{ ...inputStyle, width: 84 }}
              />
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_c, i) => i !== index) })}
            >
              Remove
            </Button>
          </div>
        ))}
        <div>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => onChange({ ...rule, conditions: [...rule.conditions, { ...emptyCondition }] })}
          >
            Add a condition
          </Button>
        </div>
      </div>

      {/*
        * The rule read back as one sentence, before it is saved.
        *
        * Three dropdowns and a number do not read as a sentence, so the thing
        * being written was only legible after saving it and looking at the
        * table. This is that table's wording, live.
        */}
      <div
        style={{
          fontSize: 12.5,
          lineHeight: 1.5,
          padding: "8px 10px",
          borderRadius: 8,
          background: "var(--surface-base)",
          border: "1px solid var(--border-base)",
        }}
      >
        <span style={{ color: "var(--text-muted)" }}>This rule says: </span>
        <strong>{sentence}</strong>
        <span style={{ color: "var(--text-muted)" }}> → </span>
        <span
          style={{
            padding: "2px 8px",
            borderRadius: 999,
            fontSize: 11.5,
            whiteSpace: "nowrap",
            background: tone(remarkTone({ remark_risk: assigns?.risk_level })).bg,
            color: tone(remarkTone({ remark_risk: assigns?.risk_level })).text,
          }}
        >
          {assigns?.remark_name || "choose a remark"}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8 }}>
        <Button size="sm" disabled={busy} onClick={onSave}>
          Save rule
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
