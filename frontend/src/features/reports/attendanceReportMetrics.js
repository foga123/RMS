/**
 * Banding for the attendance report.
 *
 * The cut points are not invented: they are the two live attendance rules in
 * the retention model (risk_indicator, source 'attendance', field absent_rate)
 * — 30% or more scores 4.00 points, 15% to 29.99% scores 1.50. A report that
 * banded at, say, 25% would show a student as fine while the engine was
 * scoring them as a risk, so the report reads the same lines the engine does.
 *
 * Kept pure so the banding can be tested without mounting a chart. Putting a
 * student in the wrong band is the failure that matters here, and it is
 * invisible on screen.
 */

/**
 * Ordered least to most severe. Colours are a status ramp rather than
 * categorical identity — they mean "no signal / watch / at risk", which is
 * exactly what status colour is for.
 *
 * Measured: worst adjacent separation is 18.1 under protanopia and 20.8 for
 * normal vision, both well clear of the floors. The validator also reports the
 * gray as under the chroma floor; that is the point of a de-emphasis slot, not
 * an oversight — the floor exists to stop a series that carries identity from
 * reading as gray, and here "reads as gray" is the message.
 */
export const ABSENCE_BANDS = [
  { key: "clear", label: "Under 15%", min: 0, max: 15, points: 0, color: "#94a3b8" },
  { key: "watch", label: "15% to 29.9%", min: 15, max: 30, points: 1.5, color: "#f59e0b" },
  { key: "risk", label: "30% or more", min: 30, max: Infinity, points: 4, color: "#b91c1c" },
];

/** Sessions conducted = 0 means nothing was ever recorded, not perfect attendance. */
export const UNTRACKED = { key: "untracked", label: "No sessions recorded", color: "#cbd5e1" };

function conducted(row) {
  return Number(row?.total_classes_conducted) || 0;
}

function absenceRate(row) {
  return Number(row?.absent_percentage) || 0;
}

/**
 * A student with no attendance row at all comes back from the endpoint with
 * zeros, because the query LEFT JOINs attendance. Left alone they would land in
 * "Under 15%" and be reported as attending perfectly when in fact nothing is
 * known about them. They get their own bucket instead.
 */
export function bandKeyFor(row) {
  if (conducted(row) <= 0) return UNTRACKED.key;
  const rate = absenceRate(row);
  const band = ABSENCE_BANDS.find((entry) => rate >= entry.min && rate < entry.max);
  return band ? band.key : ABSENCE_BANDS[ABSENCE_BANDS.length - 1].key;
}

/** Counts per band, in severity order, plus the untracked bucket separately. */
export function buildAbsenceBands(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const counts = new Map();
  list.forEach((row) => {
    const key = bandKeyFor(row);
    counts.set(key, (counts.get(key) || 0) + 1);
  });

  const tracked = list.filter((row) => conducted(row) > 0).length;

  return {
    bands: ABSENCE_BANDS.map((band) => ({
      ...band,
      students: counts.get(band.key) || 0,
      // Share of tracked students, not of everyone: including students with no
      // record would quietly shrink every percentage.
      share: tracked > 0 ? ((counts.get(band.key) || 0) / tracked) * 100 : 0,
    })),
    untracked: counts.get(UNTRACKED.key) || 0,
    tracked,
  };
}

/** Everyone the model would score, worst first — the list the report exists for. */
export function studentsNeedingAttention(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter((row) => conducted(row) > 0 && absenceRate(row) >= ABSENCE_BANDS[1].min)
    .sort((a, b) => absenceRate(b) - absenceRate(a));
}

/** The points the retention engine would add for this row's absence alone. */
export function riskPointsFor(row) {
  const key = bandKeyFor(row);
  const band = ABSENCE_BANDS.find((entry) => entry.key === key);
  return band ? band.points : 0;
}

/**
 * The same students, totalled per course or per department, with the whole
 * scope as a final row.
 *
 * Grouped in the browser rather than by a second query, because the report
 * already pages the full result set into memory for the banding above — a
 * GROUP BY endpoint would be a second definition of "absent %" to keep in step
 * with this one, and the two disagreeing is exactly the failure the banding
 * comment warns about.
 *
 * Rates are recomputed from the summed sessions, never averaged from the
 * per-student rates: a student with 2 sessions and one with 200 do not carry
 * the same weight, and averaging percentages would let a tiny section swing a
 * department. The Total row is computed the same way over every row, so it is
 * the real figure for the scope rather than the sum of rounded parts.
 */
export function groupAttendance(rows, groupBy = "course") {
  const list = Array.isArray(rows) ? rows : [];

  const labelOf = (row) =>
    groupBy === "department"
      ? row?.program_name || "No department"
      : row?.course_code || row?.course_name || "No course";

  const blank = () => ({ students: 0, tracked: 0, conducted: 0, present: 0, absent: 0, watch: 0, risk: 0 });

  const add = (bucket, row) => {
    bucket.students += 1;
    bucket.conducted += conducted(row);
    bucket.present += Number(row?.present) || 0;
    bucket.absent += Number(row?.absent) || 0;
    if (conducted(row) > 0) {
      bucket.tracked += 1;
      const key = bandKeyFor(row);
      if (key === "risk") bucket.risk += 1;
      else if (key === "watch") bucket.watch += 1;
    }
    return bucket;
  };

  const finish = (label, bucket) => ({
    ...bucket,
    label,
    absent_rate: bucket.conducted > 0 ? (bucket.absent / bucket.conducted) * 100 : 0,
    present_rate: bucket.conducted > 0 ? (bucket.present / bucket.conducted) * 100 : 0,
  });

  const buckets = new Map();
  const total = blank();

  list.forEach((row) => {
    const label = labelOf(row);
    if (!buckets.has(label)) buckets.set(label, blank());
    add(buckets.get(label), row);
    add(total, row);
  });

  return {
    // Worst first: the reason to read a breakdown is to find where the problem
    // is, and alphabetical order buries it.
    groups: Array.from(buckets, ([label, bucket]) => finish(label, bucket))
      .sort((a, b) => b.absent_rate - a.absent_rate || b.students - a.students),
    total: finish("Total", total),
  };
}
