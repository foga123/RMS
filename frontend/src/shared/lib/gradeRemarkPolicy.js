/**
 * Reading the grade remark policy in the browser.
 *
 * The rules live in the database and the server is what actually assigns a
 * remark -- see grade_remark_service.php. This evaluates the same rules a second
 * time, in the browser, for one reason: the Add Grade form shows which remark a
 * row is heading for while the counts are still being typed, and asking the
 * server on every keystroke to answer a question about five numbers would be a
 * request per character.
 *
 * That is a duplicated *interpreter*, not a duplicated policy, and the
 * difference is the point. What was here before was the policy itself, written
 * out twice:
 *
 *   autoRemarkFromBreakdown()   in GradesPage.jsx
 *   gradeimport_auto_remark()   in grades-import.php
 *
 * whose own docblock admitted the problem -- "If that rule changes, both have to
 * move together" -- and which nobody could change at all without editing PHP and
 * JavaScript in step. Both are gone. The thresholds now come down the wire from
 * the one place that stores them, so editing the policy moves the form, the
 * importer and the API together, and the worst a stale interpreter can do is
 * lag a feature rather than disagree about a student.
 *
 * The functions below mirror grade_remark_signals() and
 * grade_remark_condition_holds() exactly, including the two decisions that are
 * easy to get subtly wrong: a term with no subjects has no pass rate and gets no
 * remark at all, and `problem_kinds` counts categories rather than subjects.
 */

import { getBackendUrl } from "./url";

/** Field keys a condition may name. Mirrors grade_remark_field_keys(). */
export const GRADE_REMARK_FIELDS = [
  { key: "failed", label: "Failed subjects" },
  { key: "incomplete", label: "Incomplete subjects" },
  { key: "no_credit", label: "No-credit subjects" },
  { key: "no_grade", label: "Unmarked subjects" },
  { key: "passed", label: "Passed subjects" },
  { key: "total_subject", label: "Total subjects" },
  { key: "pass_rate", label: "Pass rate (%)" },
  { key: "problem_kinds", label: "Kinds of problem" },
];

/** Operators a condition may use. Mirrors grade_remark_operators(). */
export const GRADE_REMARK_OPERATORS = [
  { key: "gte", label: "is at least" },
  { key: "gt", label: "is more than" },
  { key: "lte", label: "is at most" },
  { key: "lt", label: "is less than" },
  { key: "eq", label: "is exactly" },
  { key: "between", label: "is between" },
  // Grade-only field-to-field comparison. It deliberately needs no schema
  // change: value_min/value_max remain null and the total comes from signals.
  { key: "eq_total", label: "equals total subjects", requiresValue: false },
];

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * A grade row as the flat numbers rules are written against.
 *
 * `pass_rate` is null rather than zero when nothing has been recorded: zero
 * would read as "failed everything" to a `lt 50` rule and hand the worst remark
 * in the policy to a row nobody has entered marks for yet.
 */
export function gradeRemarkSignals(row) {
  const total = toNumber(row?.total_subject);
  const passed = toNumber(row?.passed);
  const failed = toNumber(row?.failed);
  const incomplete = toNumber(row?.incomplete);
  const noCredit = toNumber(row?.no_credit);
  const noGrade = toNumber(row?.no_grade);

  return {
    failed,
    incomplete,
    no_credit: noCredit,
    no_grade: noGrade,
    passed,
    total_subject: total,
    pass_rate: total > 0 ? (passed / total) * 100 : null,
    // Kinds of problem, not count of subjects: four failures is one kind, a
    // failure plus an incomplete is two. That is what "With Multiple Problems"
    // has always meant and it cannot be written as ANDed conditions without one
    // rule per pair.
    problem_kinds:
      (failed > 0 ? 1 : 0) + (incomplete > 0 ? 1 : 0) + (noCredit > 0 ? 1 : 0) + (noGrade > 0 ? 1 : 0),
  };
}

/** Does one condition hold? A field with no value never matches. */
export function gradeRemarkConditionHolds(condition, signals) {
  const key = String(condition?.field_key ?? "");
  if (!(key in signals)) return false;

  const actual = signals[key];
  if (actual === null || actual === undefined) return false;

  if (String(condition?.operator) === "eq_total") {
    const total = signals.total_subject;
    return total !== null && total !== undefined && Math.abs(actual - total) < 0.005;
  }

  const min = condition?.value_min === null || condition?.value_min === "" ? null : Number(condition.value_min);
  const max = condition?.value_max === null || condition?.value_max === "" ? null : Number(condition.value_max);

  switch (String(condition?.operator ?? "gte")) {
    case "gte":
      return min !== null && actual >= min;
    case "gt":
      return min !== null && actual > min;
    case "lte":
      return min !== null && actual <= min;
    case "lt":
      return min !== null && actual < min;
    case "eq":
      // A tolerance, because pass_rate is a division: exactly 50 arrives as
      // 49.999999999999993 often enough to matter.
      return min !== null && Math.abs(actual - min) < 0.005;
    case "between":
      return min !== null && max !== null && actual >= min && actual <= max;
    default:
      return false;
  }
}

/**
 * The rule a row matches, or null. First match wins, in the order given.
 *
 * Returns the rule rather than just its remark id so a caller can say WHY --
 * "Pass rate below the 75% target" is a far better thing to show someone than
 * the bare word the rule resolved to.
 */
export function matchGradeRemarkRule(row, rules) {
  const signals = gradeRemarkSignals(row);

  // A term with no subjects gets no remark. Not a rule, because it is not a
  // policy choice: every remark describes how a set of subjects went, and there
  // is no honest way to describe an empty one. Mirrors grade_remark_evaluate().
  if (!(signals.total_subject > 0)) return null;

  const list = Array.isArray(rules) ? rules : [];
  for (let index = 0; index < list.length; index += 1) {
    const rule = list[index];
    if (rule?.is_active === 0) continue;
    const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
    if (conditions.every((condition) => gradeRemarkConditionHolds(condition, signals))) {
      return rule;
    }
  }

  return null;
}

/**
 * One write to grade_remark_policy.php - `path` is the query string
 * ("?action=rule", "?action=policy"), and a refusal throws with the server's
 * message. The Grade Remarks editor and Settings -> Grade Policy both write
 * through this; each used to carry an identical copy.
 */
export async function sendGradeRemarkPolicy(path, method, body) {
  const response = await fetch(getBackendUrl(`grade_remark_policy.php${path}`), {
    method,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: body ? JSON.stringify(body) : undefined,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || "The change could not be saved.");
  return payload;
}

/**
 * The rules governing a term, ready to evaluate.
 *
 * Returns an empty list rather than throwing when the policy cannot be read --
 * a form that will not let anyone type because a settings endpoint is
 * unreachable is worse than a form with no live remark preview. The server
 * still assigns the remark on save either way, so the cost of failing here is
 * a missing hint, not a wrong record.
 */
export async function fetchGradeRemarkPolicy(schoolYearId) {
  try {
    const response = await fetch(getBackendUrl("grade_remark_policy.php"), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!response.ok) return { rules: [], policyName: null, yearIsOpen: false };

    const payload = await response.json();
    const policies = payload?.data?.policies || [];
    const wanted = schoolYearId === null || schoolYearId === undefined ? null : Number(schoolYearId);

    // The same resolution the server uses: a policy pinned to this year beats
    // the fallback. Sorted most-specific-first so the first active match wins.
    const candidates = policies
      .filter((policy) => policy.is_active !== 0)
      .filter((policy) => policy.school_year_id === null || Number(policy.school_year_id) === wanted)
      .sort((a, b) => (b.school_year_id === null ? 0 : 1) - (a.school_year_id === null ? 0 : 1));

    const chosen = candidates[0];
    if (!chosen) return { rules: [], policyName: null, yearIsOpen: false };

    const current = payload?.data?.current_school_year || null;
    const years = payload?.data?.school_years || [];
    const currentName = current?.schoolyear_name ?? null;
    const thisYear = years.find((year) => Number(year.school_year_id) === wanted);
    // Names sort chronologically where the ids do not -- id 1 is 2025-2026 and
    // id 3 is 2022-2023, so comparing ids would call a closed year open.
    const yearIsOpen = Boolean(
      currentName && thisYear && String(thisYear.schoolyear_name) >= String(currentName)
    );

    return { rules: chosen.rules || [], policyName: chosen.policy_name, yearIsOpen };
  } catch (error) {
    return { rules: [], policyName: null, yearIsOpen: false };
  }
}
