/**
 * The words the retention board prints for its three status vocabularies.
 *
 * A retention case carries five workflow values - a validation status, an
 * intervention status and three risk levels - and the set each may hold is
 * fixed. It has to be: the server compares those strings literally, so a case
 * counts as resolved because `intervention_status === "resolved"` and for no
 * other reason. Renaming the stored value would take the resolved count to zero
 * on the board, in Team Monitor and in Reports, silently.
 *
 * So the code is fixed and the label is not. `retention_status_label` holds one
 * editable word per code, Settings edits it, and everything that displays a
 * status reads it through here. Same split as risk_category, which has carried
 * category_code alongside category_name from the start.
 *
 * Nothing in this file fetches. The page loads the groups from
 * retention_status_label.php and passes them in, which keeps the lookup pure and
 * lets the fallbacks below stand in whenever that request has not landed - or
 * the migration has not been run.
 */

/**
 * The codes each group may hold, and the words used before this table existed.
 *
 * Mirrors CASE_VALIDATION_STATUSES, CASE_INTERVENTION_STATUSES and
 * CASE_RISK_LEVELS in retention_case.php, in the order a reader expects rather
 * than alphabetically - a case moves down each list as it progresses.
 *
 * These are the fallback, not the source of truth. They are what renders on a
 * database that has not run the migration, and what a label lookup returns for
 * a code the server did not send.
 */
export const RETENTION_STATUS_FALLBACKS = {
  validation: [
    { status_code: "pending", label: "Pending" },
    { status_code: "approved", label: "Approved" },
    { status_code: "rejected", label: "Rejected" },
  ],
  intervention: [
    { status_code: "unassigned", label: "Unassigned" },
    { status_code: "assigned", label: "Assigned" },
    { status_code: "in_progress", label: "In Progress" },
    { status_code: "follow_up", label: "Follow Up" },
    { status_code: "resolved", label: "Resolved" },
  ],
  risk_level: [
    { status_code: "low", label: "Low" },
    { status_code: "moderate", label: "Moderate" },
    { status_code: "high", label: "High" },
  ],
};

/**
 * A code as a word, for anything the server did not send a label for.
 *
 * Underscore to space and capitalised, which is what the board did inline
 * before these labels were editable - so an un-migrated database renders the
 * same words it always did instead of an empty cell.
 */
export function prettifyStatusCode(code) {
  const text = String(code ?? "").trim();
  if (!text) return "";
  return text
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * Turn the endpoint's payload into `(group, code) => label`.
 *
 * Falls back twice, in order: to the built-in word for that code, then to
 * prettifying the code itself. The result is that a caller never has to decide
 * what to show when a label is missing, and never renders a blank.
 */
export function buildStatusLabelLookup(groups) {
  const byGroup = {};
  (Array.isArray(groups) ? groups : []).forEach((group) => {
    if (!group || !group.status_group) return;
    const items = Array.isArray(group.items) ? group.items : [];
    byGroup[group.status_group] = Object.fromEntries(
      items
        .filter((item) => item && item.status_code)
        .map((item) => [item.status_code, String(item.label ?? "").trim()]),
    );
  });

  return (group, code) => {
    const key = String(code ?? "");
    if (!key) return "";
    const stored = byGroup[group]?.[key];
    if (stored) return stored;
    const builtIn = (RETENTION_STATUS_FALLBACKS[group] || []).find((item) => item.status_code === key);
    return builtIn ? builtIn.label : prettifyStatusCode(key);
  };
}

/**
 * The options for one status dropdown, as `[{ value, label }]`.
 *
 * Order comes from the server's sort_order when the groups have loaded and from
 * the fallback list otherwise. The values are always the codes: a dropdown
 * built from renamed labels would post a label as if it were a status, which is
 * exactly the failure this whole split exists to prevent.
 */
export function statusOptions(groups, group) {
  const loaded = (Array.isArray(groups) ? groups : []).find((entry) => entry?.status_group === group);
  const source = loaded && Array.isArray(loaded.items) && loaded.items.length
    ? loaded.items
    : RETENTION_STATUS_FALLBACKS[group] || [];
  return source
    .filter((item) => item && item.status_code)
    .map((item) => ({
      value: item.status_code,
      label: String(item.label ?? "").trim() || prettifyStatusCode(item.status_code),
    }));
}
