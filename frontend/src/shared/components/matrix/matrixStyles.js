/**
 * The look of a matrix grid, shared by the retention matrix and the year-level
 * migration matrix.
 *
 * The two grids answer different questions and have genuinely different shapes
 * — retention is outcomes by year, migration is years by outcome — so they are
 * separate components. What they must not differ in is the type size, the row
 * height and the rule weight, because they sit one dropdown apart and switching
 * between them should change the numbers, not the furniture.
 */

export const cellBase = {
  padding: "5px 6px",
  borderBottom: "1px solid #e2e8f0",
  fontSize: 11.5,
  textAlign: "center",
  fontVariantNumeric: "tabular-nums",
};

export const headBase = {
  padding: "6px",
  borderBottom: "2px solid #cbd5e1",
  fontSize: 10.5,
  fontWeight: 700,
  color: "#0f172a",
  textAlign: "center",
  whiteSpace: "nowrap",
};

/**
 * The percentage grid's header band.
 *
 * #047857 measures 5.48:1 against white text, so the label clears AA at normal
 * weight. The brand green one step lighter (#059669) is 3.77:1, which only
 * passes for large text — and a header is not large.
 */
export const percentHead = {
  ...headBase,
  background: "#047857",
  color: "#ffffff",
  borderBottom: "2px solid #065f46",
};

/**
 * A clickable count inside a matrix cell.
 *
 * Shared because both grids had their own copy of the same style block, and
 * both copies were too small to hit: padding "2px 5px" around a two-digit
 * number renders a 17x21 target. WCAG 2.2 AA (Target Size, Minimum) asks for
 * 24x24 CSS pixels, and on a phone a 17px-wide underline between two other
 * numbers is a genuine mis-tap, not a technicality.
 *
 * min-width/min-height rather than bigger padding, so a three-digit count does
 * not gain extra width the columns would have to pay for — the box grows only
 * when the number is too small to fill it.
 *
 * Callers pass `color` and `fontWeight`, which is all the two grids differed in.
 */
export const countButton = {
  border: "none",
  background: "none",
  minWidth: 24,
  minHeight: 24,
  padding: "2px 5px",
  borderRadius: 4,
  cursor: "pointer",
  font: "inherit",
  fontVariantNumeric: "tabular-nums",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

/** Retained/attrition tones, so both grids call the same outcome the same colour. */
export const MATRIX_TONE = {
  good: "#047857",
  warn: "#b45309",
  bad: "#dc2626",
  none: "#94a3b8",
  ink: "#0f172a",
  muted: "#64748b",
  faint: "#cbd5e1",
  rule: "#e2e8f0",
};

/** A share of a row's own cohort, or null when the row is empty. */
export function sharePercent(value, base) {
  if (!base) return null;
  return Math.round((value / base) * 1000) / 10;
}
