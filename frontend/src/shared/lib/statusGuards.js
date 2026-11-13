/**
 * The statuses the backend finds by name, mirrored for the UI.
 *
 * The authority is `frontend/backend/api/lib/status_guard.php`. This copy
 * exists so the Edit and Archive actions do not appear against a row the server
 * is going to refuse — offering a control that always fails is worse than not
 * offering it, because the administrator reads the refusal as a bug rather than
 * as a rule.
 *
 * **Keep the two in step.** If a name is added to or removed from
 * STATUS_GUARDED_NAMES over there, change it here too. Drifting apart is not
 * dangerous — the server still refuses what it refuses, so the worst case is a
 * button that turns out not to work, which is exactly where this started — but
 * it is confusing, and the check at api/tests/status_management_check.php will
 * notice the backend half.
 *
 * See [[password-validation]] for the same arrangement: rules live in the
 * backend, with a frontend mirror kept deliberately thin.
 */

/** type:lowercased-name => the one-line reason, in the words the server uses. */
export const GUARDED_STATUS_NAMES = {
  "account:active":
    "Student logins are created with this status, so they work straight away.",
  "account:inactive":
    "The Surveys summary separates active from inactive surveys by this name.",
  "account:archived":
    "The Users screen moves accounts to this status instead of deleting them.",
  "enrollment:enrolled":
    "The retention matrix builds its previous-term cohort from this status.",
};

/**
 * Why this status cannot be renamed or archived, or null when it is free.
 *
 * Takes the row as the status endpoint returns it.
 */
export function statusGuardReason(row) {
  if (!row) return null;
  const key = `${String(row.status_type || "").trim().toLowerCase()}:${String(row.status_name || "")
    .trim()
    .toLowerCase()}`;
  return GUARDED_STATUS_NAMES[key] || null;
}

/**
 * True for a finance balance band.
 *
 * Bands are ordinary statuses in every respect but one: their range is shared
 * with the band next to them, so it is edited in Balance Bands rather than here.
 * The name is edited here like any other.
 */
export function isFinanceBand(row) {
  return String(row?.status_type || "").trim().toLowerCase() === "finance";
}

/** A band's range as a phrase, e.g. "3,000.01 – 5,000" or "Over 7,500". */
export function formatBandRange(rangeMin, rangeMax) {
  const min = rangeMin === null || rangeMin === undefined || rangeMin === "" ? null : Number(rangeMin);
  const max = rangeMax === null || rangeMax === undefined || rangeMax === "" ? null : Number(rangeMax);
  if (min === null && max === null) return "";

  const money = (value) =>
    value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  // The bounds are exclusive at the bottom and inclusive at the top, so a band
  // reading "0 – 3,000" starts just above zero. Written the way it behaves
  // rather than the way it is stored, because "3,000 – 5,000" on two adjacent
  // rows looks like an overlap when it is not.
  if (min === null) return `Up to ${money(max)}`;
  if (max === null) return `Over ${money(min)}`;
  return `${money(min)} – ${money(max)}`;
}
