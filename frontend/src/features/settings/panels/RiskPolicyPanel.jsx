import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../../shared/hooks/useLatestRequest";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import { getBackendUrl } from "../../../shared/lib/url";
import { confirmAction, notifySuccess } from "../../../shared/lib/notify";
import {
  RISK_OPERATORS,
  RISK_SOURCES,
  describeIndicator,
  groupIndicatorsBySource,
  maxPossibleScore,
  operatorArity,
  riskBands,
  signalLabelIndex,
  thresholdWarnings,
} from "../../../shared/lib/riskPolicy";

/**
 * The weights that decide who gets called before they drop out.
 *
 * The scoring engine has been data-driven for a while: 25 indicator rules, 7
 * categories and 39 survey keywords live in the database, and risk_model.php
 * has always been able to read and write them. Nothing on the client ever
 * called it. So the numbers that decide which students a caller sees first were
 * only inspectable as SQL, and — as it turned out — only half writable at all:
 * every POST and DELETE the endpoint offers was refused for every role
 * including admin, because the `settings` module defines no `create` and no
 * `delete`. A model that cannot be edited is a hardcoded model with extra
 * tables.
 *
 * Two things are on this screen because they are one decision:
 *
 *   the RULES, which say what earns points, and
 *   the THRESHOLDS, which say how many points make a student Moderate or High.
 *
 * Tuning one without seeing the other is how a model ends up with a High
 * threshold nothing can reach. That check is the reason the ceiling is shown
 * beside the thresholds rather than left to be worked out.
 */

const TONE = {
  low: { background: "var(--brand-100)", color: "var(--brand-800)", border: "var(--brand-200)" },
  moderate: { background: "var(--warning-100)", color: "var(--warning-800)", border: "var(--warning-200)" },
  high: { background: "var(--danger-100)", color: "var(--danger-800)", border: "var(--danger-200)" },
};

const inputStyle = {
  width: "100%",
  padding: "5px 8px",
  fontSize: 12.5,
  border: "1px solid var(--border-base)",
  borderRadius: 5,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  boxSizing: "border-box",
};

const EMPTY_INDICATOR = {
  category_id: "",
  label: "",
  source: "grades",
  field_key: "",
  operator: "gte",
  value_min: "",
  value_max: "",
  value_text: "",
  points: "1",
  reason_template: "",
  is_active: 1,
};

/** The bands drawn to scale, which is how an unreachable threshold looks wrong. */
function BandScale({ model, ceiling }) {
  const bands = riskBands(model, ceiling);

  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", height: 12, borderRadius: 999, overflow: "hidden", border: "1px solid var(--border-base)" }}>
        {bands.map((band) => (
          <div
            key={band.key}
            title={`${band.label}: ${band.from} to ${band.to}`}
            style={{ width: `${band.width * 100}%`, background: TONE[band.key].background }}
          />
        ))}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10.5, color: "var(--text-faint)" }}>
        <span>0</span>
        <span>
          Ceiling {Number(ceiling.toFixed(2))} — the most any one student can score with the rules switched on
        </span>
      </div>
    </div>
  );
}

function Pill({ children, tone = "low" }) {
  const palette = TONE[tone] || TONE.low;
  return (
    <span
      style={{
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        background: palette.background,
        color: palette.color,
        border: `1px solid ${palette.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** Add or change one rule. Fields appear according to what the operator needs. */
function IndicatorEditor({ draft, categories, signals, onChange, onSave, onCancel, busy }) {
  const arity = operatorArity(draft.operator);
  const fields = signals?.[draft.source] || [];
  const chosen = fields.find((field) => field.field_key === draft.field_key);
  // remark_risk and the like compare words. Offering a number box for them is
  // how a rule gets written that can never match anything.
  const isText = Boolean(chosen?.values) && chosen?.type === "text";

  return (
    <div style={{ border: "1px solid var(--brand-200)", borderRadius: 8, padding: 10, display: "grid", gap: 8, background: "var(--surface-page)" }}>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(148px, 100%), 1fr))" }}>
        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>What it is called</span>
          <input
            value={draft.label}
            onChange={(event) => onChange({ ...draft, label: event.target.value })}
            style={inputStyle}
            name="risk_indicator_label"
            placeholder="Absent rate 30% or more"
          />
        </label>

        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Category</span>
          <select
            value={draft.category_id}
            onChange={(event) => onChange({ ...draft, category_id: event.target.value })}
            style={inputStyle}
            name="risk_indicator_category"
          >
            <option value="">Select a category</option>
            {categories.map((category) => (
              <option key={category.category_id} value={category.category_id}>
                {category.category_name}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Reads from</span>
          <select
            value={draft.source}
            onChange={(event) => onChange({ ...draft, source: event.target.value, field_key: "" })}
            style={inputStyle}
            name="risk_indicator_source"
          >
            {RISK_SOURCES.map((source) => (
              <option key={source.key} value={source.key}>
                {source.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Signal</span>
          {/* A dropdown, never free text: a field_key with a typo in it is a
              rule that silently never fires, and nothing about the row would
              look wrong. */}
          <select
            value={draft.field_key}
            onChange={(event) => onChange({ ...draft, field_key: event.target.value })}
            style={inputStyle}
            name="risk_indicator_field"
          >
            <option value="">Select a signal</option>
            {fields.map((field) => (
              <option key={field.field_key} value={field.field_key}>
                {field.label}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Condition</span>
          <select
            value={draft.operator}
            onChange={(event) => onChange({ ...draft, operator: event.target.value })}
            style={inputStyle}
            name="risk_indicator_operator"
          >
            {RISK_OPERATORS.map((operator) => (
              <option key={operator.key} value={operator.key}>
                {operator.label}
              </option>
            ))}
          </select>
        </label>

        {arity > 0 && isText ? (
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Value</span>
            <select
              value={draft.value_text}
              onChange={(event) => onChange({ ...draft, value_text: event.target.value, value_min: "" })}
              style={inputStyle}
              name="risk_indicator_value_text"
            >
              <option value="">Select a value</option>
              {(chosen?.values || []).map((value) => (
                <option key={String(value)} value={String(value)}>
                  {String(value)}
                </option>
              ))}
            </select>
          </label>
        ) : null}

        {arity > 0 && !isText ? (
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{arity === 2 ? "From" : "Value"}</span>
            <input
              type="number"
              step="0.01"
              value={draft.value_min}
              onChange={(event) => onChange({ ...draft, value_min: event.target.value, value_text: "" })}
              style={inputStyle}
              name="risk_indicator_value_min"
            />
          </label>
        ) : null}

        {arity === 2 && !isText ? (
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>To</span>
            <input
              type="number"
              step="0.01"
              value={draft.value_max}
              onChange={(event) => onChange({ ...draft, value_max: event.target.value })}
              style={inputStyle}
              name="risk_indicator_value_max"
            />
          </label>
        ) : null}

        <label style={{ display: "grid", gap: 3 }}>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Points</span>
          <input
            type="number"
            step="0.5"
            min="0"
            value={draft.points}
            onChange={(event) => onChange({ ...draft, points: event.target.value })}
            style={inputStyle}
            name="risk_indicator_points"
          />
        </label>
      </div>

      <label style={{ display: "grid", gap: 3 }}>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
          Reason shown on the case ({"{value}"} is replaced with what was recorded)
        </span>
        <input
          value={draft.reason_template}
          onChange={(event) => onChange({ ...draft, reason_template: event.target.value })}
          style={inputStyle}
          name="risk_indicator_reason"
          placeholder="Missed {value}% of classes this term"
        />
      </label>

      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--text-secondary)" }}>
          <input
            type="checkbox"
            checked={Number(draft.is_active) === 1}
            onChange={(event) => onChange({ ...draft, is_active: event.target.checked ? 1 : 0 })}
            name="risk_indicator_active"
          />
          Switched on
        </label>
        <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
          <Button variant="secondary" size="sm" onClick={onCancel} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={onSave} disabled={busy}>
            {busy ? "Saving…" : "Save rule"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function RiskPolicyPanel({ onSummaryChange, permissions }) {
  const beginRequest = useLatestRequest();
  const [config, setConfig] = useState(null);
  const [signals, setSignals] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState(null);
  const [thresholds, setThresholds] = useState({ moderate: "", high: "" });

  const canEdit = permissions?.canEdit !== false;

  const apply = useCallback((payload) => {
    setConfig(payload);
    const active = (payload.models || []).find((model) => model.is_active) || payload.models?.[0] || null;
    if (active) {
      setThresholds({
        moderate: String(active.moderate_threshold),
        high: String(active.high_threshold),
      });
    }
  }, []);

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const [configResponse, signalResponse] = await Promise.all([
        fetch(getBackendUrl("risk_model.php"), { headers: { Accept: "application/json" }, credentials: "include" }),
        fetch(getBackendUrl("risk_model.php?action=signals"), { headers: { Accept: "application/json" }, credentials: "include" }),
      ]);
      const configPayload = await configResponse.json().catch(() => ({}));
      if (!configResponse.ok) throw new Error(configPayload?.message || "Could not read the risk model.");
      const signalPayload = await signalResponse.json().catch(() => ({}));

      apply(configPayload);
      if (!isCurrent()) return;
      setSignals(signalPayload?.signals || null);
    } catch (loadError) {
      if (!isCurrent()) return;
      setError(loadError?.message || "Could not read the risk model.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [apply, beginRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const categories = config?.categories || [];
  // One memo over config rather than two over a `|| []` that is a new array on
  // every render — which would re-run the model lookup for nothing.
  const { activeModel, shownModel } = useMemo(() => {
    const models = config?.models || [];
    const active = models.find((model) => model.is_active) || null;
    return { activeModel: active, shownModel: active || models[0] || null };
  }, [config]);
  const ceiling = useMemo(
    () => (shownModel ? maxPossibleScore(config?.indicators, shownModel.model_id) : 0),
    [config, shownModel]
  );
  const groups = useMemo(
    () => (shownModel ? groupIndicatorsBySource(config?.indicators, shownModel.model_id) : []),
    [config, shownModel]
  );
  const labels = useMemo(() => signalLabelIndex(signals), [signals]);

  /*
   * Warnings are computed against what is TYPED, not what is saved. The whole
   * point is to see that a threshold is unreachable before pressing Save, not
   * to be told afterwards.
   */
  const warnings = useMemo(
    () =>
      shownModel
        ? thresholdWarnings(
            { moderate_threshold: thresholds.moderate, high_threshold: thresholds.high },
            ceiling
          )
        : [],
    [ceiling, shownModel, thresholds]
  );

  useEffect(() => {
    if (!onSummaryChange) return;
    if (!activeModel) {
      onSummaryChange("No model active — scoring falls back to the built-in defaults");
      return;
    }
    const count = (config?.indicators || []).filter(
      (row) => Number(row.model_id) === Number(activeModel.model_id) && Number(row.is_active) === 1
    ).length;
    onSummaryChange(`${activeModel.model_name} · ${count} ${count === 1 ? "rule" : "rules"} scoring`);
  }, [activeModel, config, onSummaryChange]);

  const send = useCallback(
    async (path, options, successMessage) => {
      setBusy(true);
      setError("");
      try {
        const response = await fetch(getBackendUrl(path), {
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "include",
          ...options,
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || "The change could not be saved.");
        apply(payload);
        notifySuccess("Risk model", payload?.message || successMessage);
        return true;
      } catch (sendError) {
        // The panel renders `error` inline, directly above these controls, so a
        // popup carrying the same sentence was the second copy of one problem —
        // and the one that had to be dismissed before the settings underneath it
        // could be read.
        setError(sendError?.message || "The change could not be saved.");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [apply]
  );

  async function saveThresholds() {
    if (!shownModel) return;
    await send(
      `risk_model.php?action=model&id=${shownModel.model_id}`,
      {
        method: "PUT",
        body: JSON.stringify({
          moderate_threshold: Number(thresholds.moderate),
          high_threshold: Number(thresholds.high),
        }),
      },
      "Thresholds saved."
    );
  }

  async function saveIndicator() {
    if (!draft || !shownModel) return;
    const body = {
      ...draft,
      model_id: shownModel.model_id,
      points: Number(draft.points) || 0,
      category_id: Number(draft.category_id) || null,
      value_min: draft.value_min === "" ? null : Number(draft.value_min),
      value_max: draft.value_max === "" ? null : Number(draft.value_max),
      value_text: draft.value_text === "" ? null : draft.value_text,
      reason_template: draft.reason_template === "" ? null : draft.reason_template,
    };

    if (!body.label || !body.field_key || !body.category_id) {
      setError("A rule needs a name, a category and a signal.");
      return;
    }

    const saved = draft.indicator_id
      ? await send(`risk_model.php?action=indicator&id=${draft.indicator_id}`, { method: "PUT", body: JSON.stringify(body) }, "Rule saved.")
      : await send("risk_model.php?action=indicator", { method: "POST", body: JSON.stringify(body) }, "Rule added.");

    if (saved) setDraft(null);
  }

  async function toggleIndicator(indicator) {
    await send(
      `risk_model.php?action=indicator&id=${indicator.indicator_id}`,
      { method: "PUT", body: JSON.stringify({ is_active: Number(indicator.is_active) === 1 ? 0 : 1 }) },
      "Rule updated."
    );
  }

  async function removeIndicator(indicator) {
    const confirmed = await confirmAction({
      title: "Delete this rule?",
      text: `"${indicator.label}" stops counting towards every student's score. Switching it off instead keeps it here for later.`,
      confirmButtonText: "Delete",
    });
    if (!confirmed) return;
    await send(`risk_model.php?action=indicator&id=${indicator.indicator_id}`, { method: "DELETE" }, "Rule deleted.");
  }

  async function setActive(makeActive) {
    if (!shownModel) return;
    if (!makeActive) {
      const confirmed = await confirmAction({
        title: "Switch the model off?",
        text: "Scoring falls back to the built-in defaults in the code, which nobody can tune from here. The rules below are kept.",
        confirmButtonText: "Switch off",
      });
      if (!confirmed) return;
    }
    await send(
      makeActive ? `risk_model.php?action=activate&id=${shownModel.model_id}` : "risk_model.php?action=deactivate",
      { method: "POST", body: "{}" },
      makeActive ? "Model activated." : "Model switched off."
    );
  }

  return (
    <DashboardPanel>
      <SectionHeader
        title="Risk Policy"
        subtitle="What earns a student risk points, and how many points make them Moderate or High."
        actions={
          canEdit && shownModel ? (
            <div style={{ display: "flex", gap: 6 }}>
              <Button variant="secondary" size="sm" onClick={() => void load()} disabled={busy}>
                Refresh
              </Button>
              <Button
                size="sm"
                variant={activeModel ? "secondary" : undefined}
                onClick={() => void setActive(!activeModel)}
                disabled={busy}
              >
                {activeModel ? "Switch off" : "Activate"}
              </Button>
            </div>
          ) : null
        }
      />

      {error ? <AlertMessage tone="error" message={error} /> : null}

      {loading ? (
        <div style={{ color: "var(--text-faint)", fontSize: 12.5 }}>Reading the risk model…</div>
      ) : !shownModel ? (
        <AlertMessage
          tone="info"
          message="No risk model is configured. Scoring uses the built-in defaults in the code until one is added."
        />
      ) : (
        <div style={{ display: "grid", gap: 13 }}>
          {/* ---- which model, and whether it is the one being used ---- */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <strong style={{ fontSize: 12.5, color: "var(--text-primary)" }}>{shownModel.model_name}</strong>
            {activeModel ? <Pill tone="low">Scoring now</Pill> : <Pill tone="moderate">Not in use</Pill>}
            {shownModel.description ? (
              <span style={{ fontSize: 11, color: "var(--text-faint)" }}>{shownModel.description}</span>
            ) : null}
          </div>

          {!activeModel ? (
            <AlertMessage
              tone="warning"
              message="Nothing here is being applied. With no model active the scoring falls back to the ladders written into retention_case.php, which cannot be tuned from this screen."
            />
          ) : null}

          {/* ---- thresholds, against the ceiling the rules can reach ---- */}
          <div style={{ border: "1px solid var(--border-base)", borderRadius: 8, padding: 10, display: "grid", gap: 9 }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>Levels</div>

            <BandScale
              model={{ moderate_threshold: thresholds.moderate, high_threshold: thresholds.high }}
              ceiling={ceiling}
            />

            <div style={{ display: "flex", gap: 9, alignItems: "flex-end", flexWrap: "wrap" }}>
              <label style={{ display: "grid", gap: 3, width: 128 }}>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Moderate starts at</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={thresholds.moderate}
                  onChange={(event) => setThresholds((prev) => ({ ...prev, moderate: event.target.value }))}
                  style={inputStyle}
                  name="risk_threshold_moderate"
                  disabled={!canEdit}
                />
              </label>
              <label style={{ display: "grid", gap: 3, width: 128 }}>
                <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>High starts at</span>
                <input
                  type="number"
                  step="0.5"
                  min="0"
                  value={thresholds.high}
                  onChange={(event) => setThresholds((prev) => ({ ...prev, high: event.target.value }))}
                  style={inputStyle}
                  name="risk_threshold_high"
                  disabled={!canEdit}
                />
              </label>
              {canEdit ? (
                <Button size="sm" onClick={() => void saveThresholds()} disabled={busy}>
                  Save levels
                </Button>
              ) : null}
            </div>

            {/* Computed from what is typed, so the mistake is visible before it
                is saved rather than reported after. */}
            {warnings.map((warning) => (
              <div key={warning} style={{ fontSize: 11, lineHeight: 1.5, color: "var(--danger-800)" }}>
                {warning}
              </div>
            ))}
          </div>

          {/* ---- the rules ---- */}
          <div style={{ display: "grid", gap: 9 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>What earns points</span>
              {canEdit ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => setDraft({ ...EMPTY_INDICATOR })}
                  disabled={busy || Boolean(draft)}
                  style={{ marginLeft: "auto" }}
                >
                  Add a rule
                </Button>
              ) : null}
            </div>

            {draft && !draft.indicator_id ? (
              <IndicatorEditor
                draft={draft}
                categories={categories}
                signals={signals}
                onChange={setDraft}
                onSave={() => void saveIndicator()}
                onCancel={() => setDraft(null)}
                busy={busy}
              />
            ) : null}

            {groups.map((group) => (
              <div key={group.key} style={{ display: "grid", gap: 5 }}>
                <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-faint)" }}>
                  {group.label}
                </div>

                {group.indicators.map((indicator) =>
                  draft?.indicator_id === indicator.indicator_id ? (
                    <IndicatorEditor
                      key={indicator.indicator_id}
                      draft={draft}
                      categories={categories}
                      signals={signals}
                      onChange={setDraft}
                      onSave={() => void saveIndicator()}
                      onCancel={() => setDraft(null)}
                      busy={busy}
                    />
                  ) : (
                    <div
                      key={indicator.indicator_id}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 9,
                        padding: "6px 9px",
                        borderRadius: 7,
                        border: "1px solid var(--border-base)",
                        background: Number(indicator.is_active) === 1 ? "var(--surface-base)" : "var(--surface-page)",
                        opacity: Number(indicator.is_active) === 1 ? 1 : 0.66,
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" }}>
                          {indicator.label}
                        </div>
                        {/* The rule as it will actually be evaluated, not as it
                            was named. A label and its condition drift apart the
                            first time somebody retunes a number. */}
                        <div style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>
                          {describeIndicator(indicator, labels[`${indicator.source}.${indicator.field_key}`])}
                        </div>
                      </div>

                      <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)", whiteSpace: "nowrap" }}>
                        {Number(Number(indicator.points).toFixed(2))} pts
                      </span>
                      <Pill tone={Number(indicator.is_active) === 1 ? "low" : "moderate"}>
                        {Number(indicator.is_active) === 1 ? "On" : "Off"}
                      </Pill>

                      {canEdit ? (
                        <div style={{ display: "flex", gap: 5 }}>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => void toggleIndicator(indicator)}
                            disabled={busy}
                          >
                            {Number(indicator.is_active) === 1 ? "Switch off" : "Switch on"}
                          </Button>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setDraft({
                                ...EMPTY_INDICATOR,
                                ...indicator,
                                value_min: indicator.value_min ?? "",
                                value_max: indicator.value_max ?? "",
                                value_text: indicator.value_text ?? "",
                                reason_template: indicator.reason_template ?? "",
                              })
                            }
                            disabled={busy}
                          >
                            Edit
                          </Button>
                          <Button variant="ghost" size="sm" onClick={() => void removeIndicator(indicator)} disabled={busy}>
                            Delete
                          </Button>
                        </div>
                      ) : null}
                    </div>
                  )
                )}
              </div>
            ))}

            {groups.length === 0 ? (
              <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>
                This model has no rules, so every student scores zero and nobody is ever flagged.
              </div>
            ) : null}
          </div>
        </div>
      )}
    </DashboardPanel>
  );
}
