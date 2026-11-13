/**
 * Turning what the server recorded into what a person reads.
 *
 * The audit table stores an `action` like `grade_remark_rule_deleted` and, since
 * 2026-08-27, a `metadata` object beside the sentence rather than welded onto
 * the end of it. The panel used to render the action by swapping underscores for
 * spaces, which produced "Student contact status updated" — readable by luck,
 * because the identifiers happened to be English in the right order. It also
 * produced "Settings update" and "User inactivated", and it had nothing at all
 * to say about which of forty actions were routine and which were somebody
 * changing who can do what.
 *
 * Two jobs here:
 *
 *   describeAction()  the sentence-cased name of the event
 *   actionCategory()  what KIND of event it is, so the log can be scanned
 *
 * The category is the part that matters for reading a long log. A page of forty
 * rows is unreadable as forty equal sentences; the same page with sign-ins,
 * record edits and permission changes visibly distinct is scannable in a second.
 *
 * Rules first, overrides second. Almost every action in the system is
 * `<object>_<verb>`, so the general rule covers the ones that have not been
 * written yet — a new `campus_created` reads correctly the day it is added,
 * which a pure lookup table cannot do.
 */

/** Verbs the server uses as the last word of an action, and how to say them. */
const VERBS = {
  created: "created",
  updated: "updated",
  deleted: "deleted",
  removed: "removed",
  archived: "archived",
  restored: "restored",
  inactivated: "deactivated",
  imported: "imported",
  exported: "exported",
  reset: "reset",
  enabled: "turned on",
  disabled: "turned off",
  changed: "changed",
  update: "changed",
};

/**
 * The irregular ones.
 *
 * `login` has no object and no verb suffix, and "Login" is a noun where every
 * other row is a sentence. `settings_update` is the one action written in the
 * present tense. The rest are cases where the identifier is accurate and the
 * English is not: nobody calls it "user inactivated".
 */
const OVERRIDES = {
  login: "Signed in",
  logout: "Signed out",
  login_failed: "Sign-in failed",
  login_blocked: "Sign-in blocked",
  settings_update: "Settings changed",
  role_permissions_updated: "Role permissions changed",
  user_permissions_updated: "User permissions changed",
  user_password_changed: "Password changed",
  password_expiration_reset: "Password expiry reset",
  password_expiration_enabled: "Password expiry turned on",
  password_expiration_disabled: "Password expiry turned off",
  student_contact_status_updated: "Contact status updated",
  backup_created: "Backup created",
  backup_restored: "Database restored",
};

/** Words that are acronyms or proper nouns rather than things to sentence-case. */
const WORD_FIXES = {
  ip: "IP",
  id: "ID",
  sy: "SY",
  ssp: "SSP",
  url: "URL",
  otp: "OTP",
  inc: "INC",
};

function titleWords(text) {
  return String(text || "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => WORD_FIXES[word.toLowerCase()] || word)
    .join(" ");
}

/** "Grade remark rule deleted" — the event, as a sentence a person can scan. */
export function describeAction(action) {
  const key = String(action || "").trim().toLowerCase();
  if (!key) return "—";
  if (OVERRIDES[key]) return OVERRIDES[key];

  const parts = key.split("_");
  const verb = VERBS[parts[parts.length - 1]];

  // No recognised verb: say the identifier as words rather than inventing one.
  if (!verb || parts.length < 2) {
    const words = titleWords(key);
    return words.charAt(0).toUpperCase() + words.slice(1);
  }

  const object = titleWords(parts.slice(0, -1).join(" "));
  return `${object.charAt(0).toUpperCase()}${object.slice(1)} ${verb}`;
}

/**
 * What kind of event this is.
 *
 * Ordered most specific first: `user_permissions_updated` is an access change,
 * not an account change, and matching on "user" before "permissions" would file
 * it under the wrong one.
 */
const CATEGORY_RULES = [
  { key: "session", test: (a) => /^(login|logout)/.test(a) },
  { key: "access", test: (a) => a.includes("permission") || a.includes("password") || a.includes("role") },
  { key: "system", test: (a) => /^(settings|backup|grade_remark|risk_model|semester|school_year)/.test(a) },
  { key: "account", test: (a) => /^(user|profile)/.test(a) },
  { key: "records", test: (a) => a.endsWith("_imported") || /^(student|grades|attendance|finance|enrollment)/.test(a) },
];

export const AUDIT_CATEGORIES = {
  session: { label: "Sign-in", tone: "info" },
  access: { label: "Access", tone: "warning" },
  account: { label: "Account", tone: "primary" },
  records: { label: "Records", tone: "success" },
  system: { label: "System", tone: "default" },
  other: { label: "Other", tone: "default" },
};

export function actionCategory(action) {
  const key = String(action || "").trim().toLowerCase();
  const rule = CATEGORY_RULES.find((candidate) => candidate.test(key));
  return rule ? rule.key : "other";
}

/* ------------------------------------------------------------- metadata */

/** Keys that repeat what the sentence already said, or name a database row. */
const NOISE_KEYS = new Set(["role_id", "user_id", "student_id", "policy_id", "rule_id", "model_id", "audit_id"]);

function labelForKey(key) {
  const words = titleWords(String(key).replace(/_/g, " "));
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * A value as a short readable string, or null when it is better shown as a
 * count than as its contents.
 *
 * The permissions maps are the reason for the count: `before` and `after` each
 * list every module in the system, and printing them turns one audit row into a
 * wall of text. What changed is already in the sentence — see
 * api_permission_change_summary() — so here they read as "28 modules", which is
 * the useful fact about them.
 */
function formatValue(value) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (value.length === 0) return "none";
    if (value.every((item) => typeof item !== "object")) return value.join(", ");
    return `${value.length} entries`;
  }
  if (typeof value === "object") {
    const count = Object.keys(value).length;
    return count === 1 ? "1 entry" : `${count} entries`;
  }
  return String(value);
}

/**
 * The metadata as labelled fields, ready to render.
 *
 * Ids are dropped: a reader cannot do anything with `role_id: 3`, and the row
 * beside it already says "Dean". Everything else is kept, because the point of
 * storing it was that somebody might one day need to prove what happened.
 *
 * Returns [] for the rows written before the metadata column existed. Those
 * kept their sentence and lost their data — the two were concatenated into a
 * varchar(255) and cut mid-object — so an empty list here means "not recorded",
 * which is what the panel says.
 */
export function metadataFields(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return [];

  return Object.entries(metadata)
    .filter(([key]) => !NOISE_KEYS.has(key))
    .map(([key, value]) => ({ key, label: labelForKey(key), value: formatValue(value) }))
    .filter((field) => field.value !== "—");
}
