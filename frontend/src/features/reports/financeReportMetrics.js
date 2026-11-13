/**
 * The Finance Report's bands are the retention model's own cut points.
 *
 * These four numbers are not a design choice — they are the seeded, active
 * finance indicators in `risk_indicator` (source='finance'):
 *
 *   balance >= 10000                 -> 3.00 points
 *   balance between 3000 and 9999.99 -> 2.00 points
 *   balance between 0.01 and 2999.99 -> 1.00 point
 *   balance did not go down          -> 2.00 points
 *
 * Mirrored here for the same reason attendanceReportMetrics.js mirrors the
 * absence thresholds: a student the report calls at risk has to be a student
 * the engine is already scoring, or the report is arguing with the system it
 * is reporting on.
 *
 * The model is configurable, so these can drift if someone edits the indicators.
 * That is the accepted trade in this codebase — the alternative is a second
 * round trip on every report load.
 */

/*
 * Colour is severity, not identity: warning -> serious -> critical, with the
 * settled band recessive in gray so the eye lands on what costs points.
 *
 * Measured, not picked. The first attempt put #ea580c next to #b91c1c, which
 * the validator failed at ΔE 14.8 for normal vision — under the 15 floor,
 * meaning full-colour readers could not reliably separate "₱3,000 to ₱9,999"
 * from "₱10,000 or more" where the bars sit together, and those two bands are
 * exactly the ones a decision differs on. Deepening the top step to #991b1b
 * clears every check: worst adjacent 15.5 normal, 12.1 deutan, and the ramp is
 * monotone light-to-dark so severity reads even in grayscale.
 *
 * #f59e0b sits at 2.09:1 on white, which is a contrast WARN, not a pass — so
 * the bars carry direct value labels and the card has a table view. Those are
 * the required relief, not decoration.
 */
export const BALANCE_BANDS = [
  { key: "clear", label: "No balance", min: 0, max: 0.01, points: 0, color: "#94a3b8" },
  { key: "small", label: "Under ₱3,000", min: 0.01, max: 3000, points: 1, color: "#f59e0b" },
  { key: "mid", label: "₱3,000 to ₱9,999", min: 3000, max: 10000, points: 2, color: "#ea580c" },
  { key: "high", label: "₱10,000 or more", min: 10000, max: Infinity, points: 3, color: "#991b1b" },
];

/** Not a band: a student with no finance row scores nothing and is not "clear". */
export const NO_RECORD = { key: "no_record", label: "No finance record", color: "#cbd5e1" };

/** The engine's separate 2.00 for a balance that has not gone down. */
export const UNCHANGED_POINTS = 2;

export function bandKeyFor(row) {
  if (!row?.has_record) return NO_RECORD.key;

  const balance = Number(row.balance);
  if (!Number.isFinite(balance)) return NO_RECORD.key;
  if (balance <= 0) return "clear";

  const band = BALANCE_BANDS.find((entry) => balance >= entry.min && balance < entry.max);
  return band ? band.key : "high";
}

/** What the engine would add for this student's finance signals alone. */
export function riskPointsFor(row) {
  const band = BALANCE_BANDS.find((entry) => entry.key === bandKeyFor(row));
  const base = band ? band.points : 0;
  // Only counts where an earlier row exists to compare against; `null` means
  // unknown, and unknown is not evidence.
  const unchanged = row?.balance_unchanged === true ? UNCHANGED_POINTS : 0;
  return base + unchanged;
}

/**
 * Students per band, plus the money behind each one.
 *
 * `share` is of students who have a record, not of everyone: a school where
 * two thirds of students were never billed would otherwise report most of its
 * cohort as fine.
 */
export function buildBalanceBands(rows) {
  const list = Array.isArray(rows) ? rows : [];

  const counts = new Map(BALANCE_BANDS.map((band) => [band.key, { students: 0, amount: 0 }]));
  let noRecord = 0;

  list.forEach((row) => {
    const key = bandKeyFor(row);
    if (key === NO_RECORD.key) {
      noRecord += 1;
      return;
    }
    const bucket = counts.get(key);
    bucket.students += 1;
    bucket.amount += Math.max(0, Number(row.balance) || 0);
  });

  const tracked = list.length - noRecord;

  return {
    tracked,
    noRecord,
    totalOwed: [...counts.values()].reduce((sum, bucket) => sum + bucket.amount, 0),
    bands: BALANCE_BANDS.map((band) => {
      const bucket = counts.get(band.key);
      return {
        ...band,
        students: bucket.students,
        amount: Math.round(bucket.amount * 100) / 100,
        share: tracked > 0 ? (bucket.students / tracked) * 100 : 0,
      };
    }),
  };
}

/** Everyone the finance rules would put points on, heaviest first. */
export function studentsNeedingAttention(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => riskPointsFor(row) > 0)
    .sort((a, b) => {
      const points = riskPointsFor(b) - riskPointsFor(a);
      if (points !== 0) return points;
      return (Number(b.balance) || 0) - (Number(a.balance) || 0);
    });
}

/** How many carry a balance that has not gone down, and how many could be judged. */
export function unchangedBalanceCoverage(rows) {
  const list = Array.isArray(rows) ? rows : [];
  return {
    comparable: list.filter((row) => row.balance_unchanged !== null && row.balance_unchanged !== undefined).length,
    unchanged: list.filter((row) => row.balance_unchanged === true).length,
  };
}
