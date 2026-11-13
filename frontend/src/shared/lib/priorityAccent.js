/**
 * The one warm → cool ramp every priority readout is painted in.
 *
 * A friendly ramp rather than an alarm palette. The warmest colour still means
 * "most urgent", so the ordering reads without the labels, but Priority 1 is a
 * soft coral instead of a danger red — these are queues to work through, not
 * fires to put out.
 *
 * It lived in three files with a comment in two of them asking whoever changed
 * one to remember the others. That is the arrangement this replaces: the
 * queue's row accents, the retention snapshot's meters and the faculty
 * overview's meters are the same four facts in three places, and a reader who
 * learns the ramp on one screen has to find it unchanged on the next.
 *
 * Solid accents only — bars, dots, row rails. The PILL palettes are deliberately
 * NOT here: a pill needs a background, a text colour and a border that pass
 * contrast against each other, and StudentContactsPage, PdoPriorityPage and
 * FacultyWorkspacePage each resolve those differently (two from hex, one from
 * the theme tokens). Folding three triples into one table would be a visual
 * change to three screens dressed up as a cleanup.
 */

export const PRIORITY_ACCENT = {
  1: "#fb7185", // coral
  2: "#f59e0b", // amber
  3: "#38bdf8", // sky
  4: "#34d399", // green
};

/**
 * A student the classifier has not placed.
 *
 * Slate, and outside the ramp on purpose: this is a gap to notice, not a
 * Priority 4 to relax about.
 */
export const UNRANKED_ACCENT = "#94a3b8";

/**
 * Priority bands in reading order, with who the segment matrix routes each to.
 *
 * Owners come from the matrix's two-team split — Priority 1 is the College's to
 * chase, the rest go to the coaches — and are shown as a quiet hint rather than
 * a column, because on most screens the reader already knows which of the two
 * they are.
 *
 * Labelled "Priority 1", never "P1". On any screen that also shows a periodical
 * — the faculty board, its overview, anything carrying the term badge — "P1"
 * already means Periodical 1, and one page must not use one shorthand for two
 * different things. Screens with no periodical in sight may still abbreviate.
 */
export const PRIORITY_BANDS = [
  { level: 1, label: "Priority 1", owner: "College", accent: PRIORITY_ACCENT[1] },
  { level: 2, label: "Priority 2", owner: "Coaches", accent: PRIORITY_ACCENT[2] },
  { level: 3, label: "Priority 3", owner: "Coaches", accent: PRIORITY_ACCENT[3] },
  { level: 4, label: "Priority 4", owner: "Coaches", accent: PRIORITY_ACCENT[4] },
];
