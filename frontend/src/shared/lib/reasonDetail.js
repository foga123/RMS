/*
 * Finding the reason the user picked, and asking whether it needs free text.
 *
 * Seven of the fifty-four reasons only name a category — "Financial – Others",
 * "Others – Others (specify in remarks)". Recording one on its own says a
 * student stopped for a financial reason nobody wrote down, so the form asks
 * which.
 *
 * WHICH reasons those are is not decided here. The server ships `needs_detail`
 * on every reason option, and this module only reads it. Testing the label for
 * "Others" in the browser would be a second copy of a vocabulary the office
 * maintains, and the copy is what goes stale the first time they add a
 * category — the same arrangement as `needs_reason` on the outcome options.
 */

/**
 * The reason with this id, from options that may be grouped or flat.
 *
 * The server groups them by category, but the dropdown already tolerates a flat
 * list, so this does too — a lookup that only understood one shape would return
 * null for the other, and a null reason silently means "needs no detail", which
 * is the failure that looks like a working form.
 */
export function findReason(reasonOptions, reasonId) {
  if (!reasonId) return null;
  const wanted = String(reasonId);

  for (const group of reasonOptions || []) {
    const candidates = group?.reasons || [group];
    const hit = candidates.find((reason) => String(reason?.reason_id) === wanted);
    if (hit) return hit;
  }

  return null;
}

/** Does the picked reason have to say which one? The server's answer. */
export function reasonNeedsDetail(reasonOptions, reasonId) {
  return Boolean(findReason(reasonOptions, reasonId)?.needs_detail);
}

/**
 * Is the free-text box on screen and still empty?
 *
 * Blocked at the button as well as at the server, because the alternative is
 * letting somebody press Record and read a refusal about a box they cannot see
 * without scrolling. The server still refuses — this only saves the trip.
 *
 * `outcomeNeedsReason` is the gate, and it has to be passed rather than guessed
 * from the outcome's name: the reason dropdown itself only appears for outcomes
 * the server flags, so without it this returns true for a draft whose reason —
 * and therefore whose free-text box — is not rendered at all. That is a Record
 * button disabled over a field nobody can see, which reads as a broken button
 * rather than as a missing answer.
 *
 * It is the same flag the form opens the reason dropdown from, so the box being
 * required and the box being visible cannot come apart.
 */
export function contactDetailMissing({ outcomeNeedsReason, reasonId, detail }, reasonOptions) {
  if (!outcomeNeedsReason) return false;
  if (!reasonNeedsDetail(reasonOptions, reasonId)) return false;
  return String(detail || "").trim() === "";
}
