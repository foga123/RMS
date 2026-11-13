/**
 * A student's terms, shaped for reading.
 *
 * The endpoint returns the figures; this decides what a person is actually
 * looking for in them. Two things, mostly:
 *
 *   - the DIRECTION. A list of terms is a filing cabinet. What makes it a
 *     history is that attendance went from 89% to 84% and the balance went from
 *     nothing to ₱6,416 — the change is the finding, and a reader should not
 *     have to hold two cards in their head to see it.
 *   - the DIFFERENCE between "nobody recorded this" and "you may not see this".
 *     An empty Finance card reads as "owes nothing", which is the opposite of
 *     what it means for a reader whose role does not include finance.
 *
 * Terms arrive newest-first, so the term BEFORE any given one is the next item
 * in the array. Every trend here is computed against that neighbour and nothing
 * else — no averages, no projections. The only claim being made is "this is
 * what it was last term".
 */

/** Which way a change should read, given what the number means. */
const HIGHER_IS_BETTER = { pass_rate: true, present_rate: true, balance: false };

/** "2025-2026 · 2nd Semester" */
export function termLabel(term) {
  return [term?.school_year, term?.semester].filter(Boolean).join(" · ") || "Unrecorded term";
}

/**
 * The change from the term before, or null when there is nothing to compare.
 *
 * Null for the oldest term on record and for a figure the previous term did not
 * carry — "up from nothing" is not a fact about a student, it is a fact about
 * what happened to be imported.
 */
export function termTrend(current, previous, key) {
  const now = current?.[key];
  const before = previous?.[key];
  if (typeof now !== "number" || typeof before !== "number") return null;

  const change = now - before;
  if (change === 0) return { change: 0, direction: "flat", better: null };

  const rising = change > 0;
  const better = HIGHER_IS_BETTER[key] === undefined ? null : HIGHER_IS_BETTER[key] === rising;
  return { change, direction: rising ? "up" : "down", better };
}

/**
 * Every term with its comparison to the one before it.
 *
 * Attached here rather than computed in the render so the arrow and the number
 * cannot disagree, and so the rule about which direction is good lives in one
 * place instead of three JSX branches.
 */
export function withTrends(terms) {
  const list = Array.isArray(terms) ? terms : [];

  return list.map((term, index) => {
    const older = list[index + 1] || null;
    return {
      ...term,
      trends: {
        pass_rate: termTrend(term.grades, older?.grades, "pass_rate"),
        present_rate: termTrend(term.attendance, older?.attendance, "present_rate"),
        balance: termTrend(term.finance, older?.finance, "balance"),
      },
    };
  });
}

/** Pesos, grouped, with the centavos that a balance actually has. */
export function formatBalance(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `₱${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function formatRate(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  return `${Number(value.toFixed(2))}%`;
}

/**
 * What to say where a block has no figures.
 *
 * Three different silences, and conflating them is the failure this exists to
 * prevent: a withheld block is not an empty one, and an empty one is not a zero.
 */
export function absenceReason(visible) {
  return visible ? "Nothing recorded for this term" : "Not shown — your role does not include this module";
}

/**
 * "3 terms · 2025-2026 to 2026-2027", or the honest short version.
 *
 * Reads the first and last school year rather than counting distinct years, so
 * a student with two semesters inside one year is described as that year rather
 * than as a range from itself to itself.
 */
export function historySpan(terms) {
  const list = Array.isArray(terms) ? terms : [];
  if (list.length === 0) return "";

  const count = `${list.length} ${list.length === 1 ? "term" : "terms"}`;
  const years = list.map((term) => term?.school_year).filter(Boolean);
  if (years.length === 0) return count;

  const newest = years[0];
  const oldest = years[years.length - 1];
  return newest === oldest ? `${count} · ${newest}` : `${count} · ${oldest} to ${newest}`;
}

/**
 * The year level and section the student held during a term.
 *
 * This is the one question the live tables cannot answer. A student now in Year
 * 4 has a Year 2 grade row from two years ago, and the `student` table only
 * knows about Year 4 — so labelling an old term with today's year level would
 * be inventing a fact. `student_term_snapshot` is where the answer belongs, and
 * it is filled in when a term is closed.
 *
 * Until then this returns `recorded: false`, and the screen says the standing
 * was not captured rather than showing today's and hoping.
 */
export function standingAtTerm(term) {
  const snapshot = term?.snapshot;
  if (!snapshot) return { recorded: false };

  return {
    recorded: true,
    year_level: snapshot.year_level ?? null,
    section: snapshot.section ?? null,
    course_code: snapshot.course_code ?? null,
    student_type: snapshot.student_type ?? null,
    recorded_at: snapshot.recorded_at ?? null,
  };
}
