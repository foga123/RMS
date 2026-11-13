/**
 * Student field vocabulary, and STAR / Non-STAR routing.
 *
 * The backend splits caseload by student type: role 12 (KASAMA) may only open
 * STAR students, role 6 (SSP Caller) only Non-STAR. That rule lives in
 * api_student_type_for_role_id() in middleware/auth.php and is enforced on both
 * reads and writes.
 *
 * These helpers are the UI side of the same rule. They exist so an assignment
 * dropdown never offers someone who would then be unable to see the student —
 * an assignment that saves cleanly and then vanishes from the assignee's own
 * queue is far more confusing than a shorter list of options.
 *
 * The type comes from the row, so anything unrecognised (blank, legacy value)
 * falls back to "no restriction" rather than hiding every option.
 */

export const STAR = "star";
export const NONSTAR = "nonstar";

/**
 * What the field is called, and what it holds.
 *
 * The label and the values are different words on purpose: a cell reading
 * "STAR E-Profile" under a column headed "STAR E-Profile" says the same thing
 * twice and never says which cohort the student is in.
 *
 * Here rather than in StudentsPage.jsx so Users, Students and the assignment
 * board can all name the field the same way without importing a page component
 * into their bundle to do it.
 */
export const STUDENT_TYPE_LABEL = "STAR E-Profile";
export const STUDENT_TYPE_STAR = "STAR";
export const STUDENT_TYPE_NON_STAR = "Non-STAR";
export const STUDENT_TYPES = [STUDENT_TYPE_STAR, STUDENT_TYPE_NON_STAR];

/*
 * The scholarship grants and genders used to be constants here - and in PHP,
 * and in the columns' enum definitions - and the Users screen still kept a
 * stale fourth copy offering grants the server refuses. They are the office's
 * lists now, served by the server and edited on the Dropdown Management
 * screen: see shared/lib/dropdownOptions.js. The cohort below stays in code,
 * because who can see which students is decided by it.
 */

/**
 * Every spelling that has ever been stored, folded to one of two tokens.
 *
 * The list is not history for its own sake - each entry was the stored value at
 * some point, and a row still carrying one has to route to a team rather than
 * fall through to "no restriction" and offer every caller in the school:
 *
 *   "unstar"          stored until 2026-08-17
 *   "star"/"nonstar"  stored until 2026-08-21
 *   "star e-profile"  stored for part of 2026-08-21
 *
 * "non-star" is the current value and the one this function existed without:
 * lowercasing it yields "non-star", which matched neither token, so every
 * Non-STAR student silently became unrestricted the moment the values changed.
 */
const TYPE_TOKENS = {
  unstar: NONSTAR,
  nonstar: NONSTAR,
  "non-star": NONSTAR,
  "non star": NONSTAR,
  star: STAR,
  "star e-profile": STAR,
  "star eprofile": STAR,
};

export function normalizeStudentType(value) {
  const token = String(value || "").trim().toLowerCase();
  return TYPE_TOKENS[token] || "";
}

/** Human name of the role that handles this student type. */
export function assigneeRoleName(studentType) {
  // "KASAMA" is what role 12 is actually called in the role table; the code
  // said "KSH Coach", which named no role anyone could be assigned.
  return normalizeStudentType(studentType) === STAR ? "KASAMA" : "SSP Caller";
}

/** Field label for the assignment dropdown. */
export function assigneeLabelFor(studentType) {
  const type = normalizeStudentType(studentType);
  if (!type) return "Assign Caller";
  return `Assign ${assigneeRoleName(type)}`;
}

/**
 * Narrow a caller list to those whose role covers this student's type.
 *
 * Falls back to the full list when the payload carries no `handles_student_type`
 * labels at all — an older backend response should degrade to the previous
 * behaviour, not to an empty dropdown.
 */
export function callersForStudentType(callers, studentType) {
  const list = Array.isArray(callers) ? callers : [];
  const type = normalizeStudentType(studentType);
  if (!type) return list;

  const labelled = list.filter((caller) => normalizeStudentType(caller?.handles_student_type));
  if (labelled.length === 0) return list;

  return labelled.filter((caller) => normalizeStudentType(caller.handles_student_type) === type);
}

/* ---------------------------------------------------------------------------
 * Coaches.
 *
 * The assignment board gives each student ONE assignee, their coach: an SSP
 * Caller for a Non-STAR student, a KASAMA for a STAR one. Until 2026-10-01 it
 * stored a pair, the coach and their supervisor, and listed both under the
 * student, so the supervisor read as a second coach. The supervisors are not
 * assigned students any more; they see their whole cohort without a row.
 *
 * Role ids are the first member of each team in API_FOLLOW_UP_TEAMS
 * (middleware/auth.php). The server is the authority — it validates every write
 * against its own copy — and this exists so the board can name the role.
 * ------------------------------------------------------------------------- */

const COACH_BY_TYPE = {
  [NONSTAR]: { roleId: 6, roleName: "SSP Caller" },
  [STAR]: { roleId: 12, roleName: "KASAMA" },
};

/** The coach role for a student of this type, or null when it has no unit. */
export function coachRoleFor(studentType) {
  const type = normalizeStudentType(studentType);
  return type ? COACH_BY_TYPE[type] : null;
}
