/**
 * Reading the attendance target and its rules in the browser.
 *
 * The rules live in the database and attendance_remark_service.php is what
 * actually decides. This evaluates the same rules a second time, in the browser,
 * for the reason gradeRemarkPolicy.js does: the policy editor shows what a
 * target would call a student while somebody is still typing the numbers, and
 * asking the server about three integers on every keystroke is a request per
 * character.
 *
 * A duplicated INTERPRETER, not a duplicated policy. The thresholds come down
 * the wire from the one place that stores them, so editing a target moves the
 * editor, the comparison report and the API together. The worst a stale
 * interpreter can do is lag a feature; it cannot disagree about a student.
 *
 * What was here before was worse than a duplicate. There was no policy at all:
 * attendanceReportMetrics.js carried a bare `75` as the line between acceptable
 * and not, applied identically to a fifteen-meeting periodical and a
 * fifty-meeting semester, editable only by editing JavaScript.
 *
 * The functions mirror attendance_remark_signals() and
 * attendance_remark_condition_holds() exactly, including the three decisions
 * that are easy to get subtly wrong:
 *
 *   - a term with no classes conducted has no rate, no verdict and no remark
 *   - the target has two halves and a row must satisfy BOTH
 *   - "meets the target" is three-valued: true, false, or nobody set one
 */

import { periodLabel } from "./periods";

/** Field keys a condition may name. Mirrors attendance_remark_field_keys(). */
export const ATTENDANCE_REMARK_FIELDS = [
  { key: "absent", label: "Absences" },
  { key: "present", label: "Classes attended" },
  { key: "total_classes_conducted", label: "Classes held" },
  { key: "attendance_rate", label: "Attendance rate (%)" },
  { key: "absence_rate", label: "Absence rate (%)" },
  { key: "absences_over_target", label: "Absences over target" },
  { key: "meets_target", label: "Meets the target (1 or 0)" },
];

/** Operators a condition may use. The same six the grade engine publishes. */
export const ATTENDANCE_REMARK_OPERATORS = [
  { key: "gte", label: "is at least" },
  { key: "gt", label: "is more than" },
  { key: "lte", label: "is at most" },
  { key: "lt", label: "is less than" },
  { key: "eq", label: "is exactly" },
  { key: "between", label: "is between" },
];

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** The target a policy sets, or null when it sets none. */
export function attendanceTarget(policy) {
  if (!policy) return null;

  const rawMax = policy.target_max_absences;
  const rawRate = policy.target_min_rate;
  const maxAbsences = rawMax === null || rawMax === undefined || rawMax === "" ? null : Number(rawMax);
  const minRate = rawRate === null || rawRate === undefined || rawRate === "" ? null : Number(rawRate);

  if (!Number.isFinite(maxAbsences) && !Number.isFinite(minRate)) return null;

  return {
    max_absences: Number.isFinite(maxAbsences) ? maxAbsences : null,
    min_rate: Number.isFinite(minRate) ? minRate : null,
  };
}

/**
 * An attendance row as the flat numbers rules are written against.
 *
 * `meets_target` is null rather than false when no target is set or no classes
 * were held. Folding either into false would report a term nobody configured as
 * a term where every student failed attendance.
 */
export function attendanceRemarkSignals(row, target = null) {
  const conducted = toNumber(row?.total_classes_conducted);
  const present = toNumber(row?.present);
  const absent = toNumber(row?.absent);

  const hasClasses = conducted > 0;
  const attendanceRate = hasClasses ? (present / conducted) * 100 : null;
  const absenceRate = hasClasses ? (absent / conducted) * 100 : null;

  const maxAbsences = target?.max_absences ?? null;
  const minRate = target?.min_rate ?? null;

  // Negative means headroom. A rule written "absences_over_target >= -2" says
  // "within two of the limit" and stays true to whatever the limit becomes,
  // where "absent >= 6" quietly disagrees the moment the target moves.
  const over = maxAbsences === null ? null : absent - maxAbsences;

  let meets = null;
  if (target && hasClasses) {
    meets = true;
    if (maxAbsences !== null && absent > maxAbsences) meets = false;
    // A tolerance, because the rate is a division: a student on exactly the 80%
    // line arrives as 79.99999999999999 often enough to matter, and being
    // failed by floating point is not a policy.
    if (minRate !== null && attendanceRate !== null && attendanceRate < minRate - 0.005) meets = false;
  }

  return {
    absent,
    present,
    total_classes_conducted: conducted,
    attendance_rate: attendanceRate,
    absence_rate: absenceRate,
    absences_over_target: over,
    meets_target: meets === null ? null : meets ? 1 : 0,
  };
}

/** Does one condition hold? A field with no value never matches. */
export function attendanceRemarkConditionHolds(condition, signals) {
  const key = String(condition?.field_key ?? "");
  if (!(key in signals)) return false;

  const actual = signals[key];
  if (actual === null || actual === undefined) return false;

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
      return min !== null && Math.abs(actual - min) < 0.005;
    case "between":
      return min !== null && max !== null && actual >= min && actual <= max;
    default:
      return false;
  }
}

/**
 * The rule a row matches under this policy, or null. First match wins.
 *
 * Takes the whole policy rather than a rules array, for the reason the PHP does:
 * the target and the rules have to come from the same policy, and the cheapest
 * way to guarantee that is to make handing over a mismatched pair impossible.
 *
 * Returns the rule rather than its remark id so a caller can say WHY -- "Within
 * two absences of the target" is a far better thing to put in front of somebody
 * than the bare word the rule resolved to.
 */
export function matchAttendanceRemarkRule(row, policy) {
  if (!policy) return null;

  const signals = attendanceRemarkSignals(row, attendanceTarget(policy));

  // No classes held, no remark. Every remark in the vocabulary describes how a
  // set of meetings went and there is no honest way to describe an empty one.
  if (!(signals.total_classes_conducted > 0)) return null;

  const rules = Array.isArray(policy.rules) ? policy.rules : [];
  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    if (rule?.is_active === 0) continue;
    const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
    if (conditions.every((condition) => attendanceRemarkConditionHolds(condition, signals))) {
      return rule;
    }
  }

  return null;
}

/** "2026-2027 · 1st Semester · P1", or "Any term without its own policy". */
export function describeScope(policy, { schoolYears = [], semesters = [] } = {}) {
  if (!policy) return "";
  if (policy.school_year_id === null || policy.school_year_id === undefined) {
    return "Any term without its own policy";
  }

  const year =
    policy.schoolyear_name ||
    schoolYears.find((entry) => Number(entry.school_year_id) === Number(policy.school_year_id))?.schoolyear_name ||
    "Unknown year";

  const parts = [year];
  if (policy.semester_id !== null && policy.semester_id !== undefined) {
    parts.push(
      policy.semester_name ||
        semesters.find((entry) => Number(entry.semester_id) === Number(policy.semester_id))?.semester_name ||
        "Unknown semester"
    );
  } else {
    parts.push("every semester");
  }

  // periodLabel() answers "Whole Periodical" for a null, which is exactly what
  // a policy with no period means: the semester as a whole rather than one of
  // its three periodicals.
  parts.push(periodLabel(policy.period));
  return parts.join(" · ");
}

/** "at most 8 absences and at least 80% attendance" — a target as a sentence. */
export function describeTarget(target) {
  if (!target) return "No target set";

  const parts = [];
  if (target.max_absences !== null && target.max_absences !== undefined) {
    parts.push(`at most ${target.max_absences} ${target.max_absences === 1 ? "absence" : "absences"}`);
  }
  if (target.min_rate !== null && target.min_rate !== undefined) {
    parts.push(`at least ${target.min_rate}% attendance`);
  }
  return parts.length ? parts.join(" and ") : "No target set";
}
