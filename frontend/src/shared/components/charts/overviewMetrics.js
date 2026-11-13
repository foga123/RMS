/**
 * The arithmetic behind the overview, kept out of the chart components.
 *
 * Same reasoning as balanceWaterfall.js: a share that is computed wrong still
 * draws a plausible chart, and a headline number that is wrong is worse than
 * one that is missing. Both are testable without mounting Recharts.
 */

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

/**
 * Turn counts into percentage shares for a 100% stacked bar.
 *
 * The total is summed from the parts rather than taken from a total column, so
 * the segments always add to exactly 100 and the bar cannot end short of its
 * own axis. A row whose parts are all zero yields zero shares rather than NaN,
 * which would render as an invisible bar with no explanation.
 */
export function toPercentShares(rows, keys) {
  const safeKeys = Array.isArray(keys) ? keys : [];
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const total = safeKeys.reduce((sum, key) => sum + (Number(row?.[key]) || 0), 0);
    const shares = {};
    safeKeys.forEach((key) => {
      shares[`${key}_pct`] = total > 0 ? ((Number(row?.[key]) || 0) / total) * 100 : 0;
    });
    return { ...row, ...shares, share_total: total };
  });
}

/**
 * The headline numbers above the charts.
 *
 * A delta is only produced where a real earlier value exists to compare
 * against — the previous term for attendance. Nothing else in the payload has
 * a prior period, so nothing else gets a delta rather than an invented one.
 */
export function summariseOverview(data) {
  const attendance = Array.isArray(data?.attendance_by_term) ? data.attendance_by_term : [];
  const grades = Array.isArray(data?.grades_by_year) ? data.grades_by_year : [];

  const latest = attendance.length > 0 ? attendance[attendance.length - 1] : null;
  const previous = attendance.length > 1 ? attendance[attendance.length - 2] : null;

  // Summed across year levels: a mean of per-year rates would weight a year of
  // 12 students the same as a year of 300.
  const totals = grades.reduce(
    (acc, row) => {
      acc.passed += Number(row?.passed) || 0;
      acc.subjects += Number(row?.total_subject) || 0;
      return acc;
    },
    { passed: 0, subjects: 0 }
  );

  return {
    students: Number(data?.totals?.students) || 0,
    attendanceRate: latest ? round1(Number(latest.rate) || 0) : null,
    attendanceTerm: latest ? latest.label ?? null : null,
    attendanceDelta:
      latest && previous ? round1((Number(latest.rate) || 0) - (Number(previous.rate) || 0)) : null,
    passRate: totals.subjects > 0 ? round1((totals.passed / totals.subjects) * 100) : null,
    subjectsGraded: totals.subjects,
    balanceTotal: Number(data?.balance_total) || 0,
  };
}

/**
 * Stat-tile values are auto-compact. Proportional figures, not tabular — at
 * display size tabular digits make a number like 121 look loose.
 */
export function compactCount(value) {
  const n = Number(value) || 0;
  if (Math.abs(n) >= 1_000_000) return `${round1(n / 1_000_000)}M`;
  if (Math.abs(n) >= 10_000) return `${round1(n / 1_000)}K`;
  return n.toLocaleString();
}
