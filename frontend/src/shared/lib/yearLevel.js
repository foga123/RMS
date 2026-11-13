/**
 * Year levels, written the way the college writes them: I, II, III, IV.
 *
 * One module rather than a private ROMAN array per page. The retention matrix
 * already had one, and a second copy is how "Year IV" in one report ends up
 * beside "Year 4" in the next — the same cohort, looking like two.
 *
 * Arabic numerals stay in the data and in form inputs. `year_level` is an int
 * in the database and the value a <select> posts back, so this converts on the
 * way to the screen only; nothing here ever feeds a request.
 */

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/**
 * "IV" from 4. Anything outside the table falls back to the number it was
 * given, because a year level nobody planned for is still better shown than
 * swallowed.
 */
export function toRoman(year) {
  const level = Number(year);
  if (!Number.isFinite(level) || level < 1) return "";
  return ROMAN[level - 1] || String(level);
}

/** "Year IV", or the fallback when there is no year on the record. */
export function yearLevelLabel(year, fallback = "") {
  const roman = toRoman(year);
  return roman === "" ? fallback : `Year ${roman}`;
}

/**
 * Rewrites a label the server already composed — "Year 4" becomes "Year IV",
 * "Unassigned" is left alone.
 *
 * The overview endpoint builds its own labels for the charts, and this converts
 * them at the edge instead of forking the query to send a second display string.
 */
export function romanizeYearLabel(label) {
  return String(label ?? "").replace(/\bYear\s+(\d+)\b/gi, (match, digits) => `Year ${toRoman(digits)}`);
}
