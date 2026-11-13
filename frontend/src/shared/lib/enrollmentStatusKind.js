/**
 * What an enrollment status means for retention, read from its NAME.
 *
 * Statuses are edited in Status Management and their ids differ between
 * installs, so every screen that colours or groups them goes by name. That rule
 * used to live in three places in the browser - the migration page's tones, the
 * retention matrix's green/amber split, and nowhere for the new names - and the
 * list was replaced on 2026-10-06 (latest.xlsx): "Will Continue", "Graduated"
 * and six "Will not continue - ..." values. The retired names stay recognised,
 * because records filed under them keep those names.
 *
 * Mirror of migration_year_bucket() in backend/api/student_migration.php -
 * change both together. Transfers are tried before "will not continue":
 * "Will not continue - Transfer to LUC/ SUC" is a student moving elsewhere.
 *
 *   continuing      Enrolled, Will Continue (and Will Enroll, For Enlistment)
 *   graduating      Graduated (and Graduating)
 *   moving          the two transfers (and To Shift, To Transfer)
 *   not_continuing  every other "Will not continue - ..." (and To Stop, ...)
 *   undecided       For Follow-up, For Home Visit, Undecided, anything unknown
 *   no_record       no status at all
 */
export function enrollmentStatusKind(statusName) {
  const name = String(statusName ?? "").trim().toLowerCase();
  if (!name) return "no_record";
  if (/^(enrolled|will enroll|will continue|for enlistment)$/.test(name)) return "continuing";
  if (name.includes("graduat")) return "graduating";
  if (/^(to shift|to transfer)$/.test(name) || name.includes("transfer to")) return "moving";
  if (/^(not enrolled|to stop|no show)$/.test(name) || name.startsWith("will not continue")) return "not_continuing";
  return "undecided";
}

const GROUP_PREFIX = /^(will not continue)\s*-\s*(.+)$/i;

/**
 * A status that belongs to a family, split into the family and its detail.
 *
 * Six statuses begin "Will not continue - ", so a label clipped to one line
 * reads the same six times. Screens that list them group under the family and
 * label each row by what follows the dash. Null for a status in no family.
 */
export function splitStatusGroup(statusName) {
  const match = String(statusName ?? "").trim().match(GROUP_PREFIX);
  if (!match) return null;
  const group = match[1].charAt(0).toUpperCase() + match[1].slice(1).toLowerCase();
  return { group, detail: match[2].trim() };
}
