/**
 * Grouping the status table by the module that reads each type.
 *
 * `status` is one table shared by six modules, and Status Management showed it
 * as one flat list with a "Type" column. Thirty-odd rows in seeded order meant
 * the three account states, the thirteen enrollment answers and the balance
 * bands were interleaved, and the question an administrator actually arrives
 * with - "where do I add the status I need?" - had no answer on screen.
 *
 * The catalogue itself lives on the server, in api/lib/status_types.php, and
 * arrives with the list response. Nothing here hardcodes a type: a copy of that
 * list in the frontend would be a second place to forget when a module starts or
 * stops reading one.
 */

/** A type the catalogue does not describe, so unknown rows still get a heading. */
export function fallbackTypeEntry(key) {
  const name = String(key || "").trim();
  return {
    key: name,
    label: name || "No type",
    // Said plainly, because this is the state the free-text box used to produce
    // and the row is invisible everywhere else in the app.
    used_by: name
      ? "No screen reads this type, so these statuses do not appear anywhere else in the app."
      : "These rows have no type at all and are not offered by any screen.",
    can_add: false,
    unknown: true,
  };
}

/**
 * Rows grouped under their type, in catalogue order.
 *
 * Types the catalogue lists come first and in its order, so the headings do not
 * reshuffle as rows are added or archived. Anything left over - a legacy type,
 * or rows with none - follows, because those are the ones worth noticing.
 *
 * Empty catalogue types are kept when `keepEmpty` is set: on the active view a
 * module with no statuses yet is exactly where somebody needs the Add button,
 * and dropping the heading hides the place they were looking for.
 */
export function groupStatusesByType(rows, types, { keepEmpty = false } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const catalogue = Array.isArray(types) ? types : [];

  const byKey = new Map();
  for (const row of list) {
    const key = String(row?.status_type || "").trim().toLowerCase();
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  const groups = [];
  const claimed = new Set();

  for (const entry of catalogue) {
    const key = String(entry?.key || "").trim().toLowerCase();
    if (!key) continue;
    claimed.add(key);
    const items = byKey.get(key) || [];
    if (items.length === 0 && !keepEmpty) continue;
    groups.push({ ...entry, key, items });
  }

  // Whatever the catalogue did not claim, in a stable order.
  const leftovers = [...byKey.keys()].filter((key) => !claimed.has(key)).sort();
  for (const key of leftovers) {
    groups.push({ ...fallbackTypeEntry(key), items: byKey.get(key) });
  }

  return groups;
}

/** The types a new status may be filed under, for the dialog's dropdown. */
export function addableTypes(types) {
  return (Array.isArray(types) ? types : []).filter((t) => (t?.can_add ?? true) !== false);
}

/** Where a type's rows are created instead, when they are not created here. */
export function addElsewhereHint(entry) {
  if (!entry || (entry.can_add ?? true) !== false) return "";
  return entry.add_hint ? `Added in ${entry.add_hint}` : "Added elsewhere";
}
