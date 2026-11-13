/**
 * Reading and describing the retention risk model.
 *
 * The model is a set of indicator rules — "absent rate at least 30% → 4 points"
 * — plus two thresholds that turn a total into Low, Moderate or High. It has
 * been configurable in the database since the scoring engine was made
 * data-driven; what was missing was any way to look at it, so the weights that
 * decide who gets called were only readable as 25 rows of SQL.
 *
 * This turns a rule row into a sentence and a model into the shape of its
 * bands. The matching itself stays on the server (risk_model_service.php is the
 * authority and the only thing that scores anybody) — nothing here evaluates a
 * student. What it does do is check the model against itself, which is the
 * failure nobody can see by reading the rows one at a time: a High threshold
 * set above the most any student can possibly score is a level that will never
 * be reached, and the screen has to say so.
 */

/** Mirrors RISK_OPERATORS in risk_model.php, in the order a person reads them. */
export const RISK_OPERATORS = [
  { key: "gte", label: "is at least", arity: 1 },
  { key: "gt", label: "is more than", arity: 1 },
  { key: "lte", label: "is at most", arity: 1 },
  { key: "lt", label: "is less than", arity: 1 },
  { key: "eq", label: "is exactly", arity: 1 },
  { key: "neq", label: "is anything but", arity: 1 },
  { key: "between", label: "is between", arity: 2 },
  // These two read the ABSENCE of data, which is itself a signal: a student
  // with no attendance record at all is not a student with perfect attendance.
  { key: "missing", label: "was never recorded", arity: 0 },
  { key: "present", label: "was recorded", arity: 0 },
];

const OPERATOR_LABEL = Object.fromEntries(RISK_OPERATORS.map((op) => [op.key, op.label]));
const OPERATOR_ARITY = Object.fromEntries(RISK_OPERATORS.map((op) => [op.key, op.arity]));

/** Where a signal comes from, as the tabs a reader expects. */
export const RISK_SOURCES = [
  { key: "grades", label: "Grades" },
  { key: "attendance", label: "Attendance" },
  { key: "finance", label: "Finance" },
  { key: "survey", label: "Survey" },
  { key: "student", label: "Student" },
];

/** How many values the operator needs, so a form can hide the ones it does not. */
export function operatorArity(operator) {
  return OPERATOR_ARITY[operator] ?? 1;
}

function tidyNumber(value) {
  // Checked before Number(), which turns null and "" into 0 — so an unset
  // bound would render as a configured zero. "between 50 and 0" reads as a
  // broken range somebody chose; "between 50 and ?" reads as the missing value
  // it is.
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  // 30.00 is how the column stores it; 30 is how a person writes it.
  return String(Number(number.toFixed(2)));
}

/**
 * "Absent rate (%) is at least 30" — a rule row as a sentence.
 *
 * `signalLabel` is the human name for source+field, looked up from the
 * vocabulary the server publishes. Falling back to the raw key matters: a rule
 * pointing at a field that no longer exists must read as the broken thing it
 * is rather than silently rendering as a blank.
 */
export function describeIndicator(indicator, signalLabel) {
  const subject = signalLabel || `${indicator?.source ?? "?"}.${indicator?.field_key ?? "?"}`;
  const operator = OPERATOR_LABEL[indicator?.operator] || indicator?.operator || "?";
  const arity = operatorArity(indicator?.operator);

  if (arity === 0) return `${subject} ${operator}`;

  // A text rule compares words, not numbers — remark_risk is "high"/"moderate".
  const text = indicator?.value_text;
  if (text !== null && text !== undefined && String(text).trim() !== "") {
    return `${subject} ${operator} "${String(text).trim()}"`;
  }

  const min = tidyNumber(indicator?.value_min);
  if (arity === 2) {
    const max = tidyNumber(indicator?.value_max);
    return `${subject} ${operator} ${min ?? "?"} and ${max ?? "?"}`;
  }
  return `${subject} ${operator} ${min ?? "?"}`;
}

/**
 * The most points a single student could collect.
 *
 * Only the active rules, and only this model's. Inactive rules stay in the
 * table on purpose — turning one off is how you park it — but they cannot be
 * scored, so counting them would overstate the ceiling and hide exactly the
 * problem this number exists to reveal.
 */
export function maxPossibleScore(indicators, modelId) {
  return (Array.isArray(indicators) ? indicators : [])
    .filter((row) => Number(row?.model_id) === Number(modelId) && Number(row?.is_active) === 1)
    .reduce((sum, row) => sum + (Number(row?.points) || 0), 0);
}

/**
 * The three bands as ranges, for drawing the scale.
 *
 * Returned even when the thresholds are nonsense, because the drawing is how
 * the nonsense becomes obvious. `width` is the share of the ceiling each band
 * covers, clamped so a threshold past the ceiling does not produce a bar wider
 * than the chart.
 */
export function riskBands(model, ceiling) {
  const moderate = Number(model?.moderate_threshold) || 0;
  const high = Number(model?.high_threshold) || 0;
  const top = Math.max(Number(ceiling) || 0, high, moderate);
  const share = (from, to) => (top <= 0 ? 0 : Math.max(0, Math.min(to, top) - Math.min(from, top)) / top);

  return [
    { key: "low", label: "Low", from: 0, to: moderate, width: share(0, moderate) },
    { key: "moderate", label: "Moderate", from: moderate, to: high, width: share(moderate, high) },
    { key: "high", label: "High", from: high, to: top, width: share(high, top) },
  ];
}

/**
 * What is wrong with this model, said plainly.
 *
 * Each of these is silently true of the rows in the database and invisible when
 * reading them one at a time. The first is the one that matters most: a High
 * threshold above the ceiling does not raise the bar, it removes the level, and
 * every student who should have been urgent is filed as Moderate instead.
 */
export function thresholdWarnings(model, ceiling) {
  const moderate = Number(model?.moderate_threshold);
  const high = Number(model?.high_threshold);
  const top = Number(ceiling) || 0;
  const warnings = [];

  if (Number.isFinite(high) && high > top) {
    warnings.push(
      `No student can reach High. The most any student can score with the rules that are switched on is ${tidyNumber(top)}, and High starts at ${tidyNumber(high)} — every at-risk student would be filed as Moderate.`
    );
  }
  if (Number.isFinite(moderate) && moderate > top) {
    warnings.push(
      `No student can reach Moderate either, so every student would be scored Low whatever happens to them.`
    );
  }
  if (Number.isFinite(moderate) && Number.isFinite(high) && moderate > high) {
    warnings.push(
      `Moderate (${tidyNumber(moderate)}) starts above High (${tidyNumber(high)}). Nothing can land in the Moderate band.`
    );
  }
  if (Number.isFinite(moderate) && moderate <= 0) {
    warnings.push("Moderate starts at zero, so a student with nothing recorded against them is already Moderate.");
  }
  return warnings;
}

/** This model's rules, bucketed by where their signal comes from. */
export function groupIndicatorsBySource(indicators, modelId) {
  const mine = (Array.isArray(indicators) ? indicators : []).filter(
    (row) => Number(row?.model_id) === Number(modelId)
  );

  return RISK_SOURCES.map((source) => ({
    ...source,
    indicators: mine.filter((row) => row.source === source.key),
  })).filter((group) => group.indicators.length > 0);
}

/**
 * A flat lookup from "source.field_key" to its human label.
 *
 * Built from the vocabulary the server publishes rather than hardcoded here,
 * because survey.<category> keys are generated from whatever categories the
 * institution has defined — a copy on this side would go stale the first time
 * somebody adds one.
 */
export function signalLabelIndex(signals) {
  const index = {};
  Object.entries(signals || {}).forEach(([source, fields]) => {
    (fields || []).forEach((field) => {
      index[`${source}.${field.field_key}`] = field.label;
    });
  });
  return index;
}
