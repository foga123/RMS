/**
 * What colour a grade remark is, and why.
 *
 * A remark is a row in the `remarks` table, and that row carries a `risk_level`
 * — Low / Medium / High — which Remarks Management lets an administrator edit.
 * That field is the answer, so it is what this reads. Inferring the colour from
 * the remark's wording instead would look identical today and be wrong the first
 * time someone adds a remark or changes an existing one's risk level: the table
 * would go on colouring "With INC" amber because of its name, while the database
 * says the school now treats it as high risk.
 *
 * The name is only a fallback, for the one path that cannot supply a risk level:
 * a database still on the legacy free-text `grades.remarks` column has no
 * `remarks` row to join to, so grades.php returns NULL there. Matching the five
 * seeded names keeps those installs coloured rather than uniformly grey.
 */

/** The tone names in shared/theme/tokens.js, so callers can use `tone()`. */
const LOW = "success";
const MEDIUM = "warning";
const HIGH = "danger";
const NEUTRAL = "default";

const RISK_TONE = {
  "low risk": LOW,
  low: LOW,
  "medium risk": MEDIUM,
  medium: MEDIUM,
  moderate: MEDIUM,
  "high risk": HIGH,
  high: HIGH,
};

/** The seeded remark names, used only when no risk level came back. */
const NAME_TONE = {
  "regular standing": LOW,
  "with inc": MEDIUM,
  "with no grade": MEDIUM,
  "with failed mark": HIGH,
  "with multiple problems": HIGH,
};

function normalize(value) {
  return String(value ?? "").trim().toLowerCase();
}

/**
 * The tone for one grade row.
 *
 * @param {{ remark_risk?: string, remarks?: string }} row
 * @returns {"success"|"warning"|"danger"|"default"}
 */
export function remarkTone(row) {
  const risk = normalize(row?.remark_risk);
  if (risk && RISK_TONE[risk]) return RISK_TONE[risk];

  const name = normalize(row?.remarks);
  if (name && NAME_TONE[name]) return NAME_TONE[name];

  /*
   * An unrecognised remark stays neutral rather than being guessed at. A remark
   * someone added last week is not evidence of anything until its risk level is
   * set, and painting it green would say the opposite of "unknown".
   */
  return NEUTRAL;
}

/** The risk level to show beside the remark, when the row carries one. */
export function remarkRiskLabel(row) {
  const risk = String(row?.remark_risk ?? "").trim();
  if (!risk) return "";
  // "Low Risk" already says Risk; "Low" on its own does not.
  return /risk/i.test(risk) ? risk : `${risk} Risk`;
}
