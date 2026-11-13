/**
 * Keeping two scope options apart when they are spelled the same.
 *
 * A department runs on more than one campus, and each campus's department is
 * its own row. So CITE Carmen and CITE Puerto are two `department` rows both
 * coded CITE, and each offers a course coded BSIT — course.php allows that
 * deliberately, scoping its duplicate check to the department for exactly this
 * reason. They are different departments with different students, and filtering
 * by one must not sweep in the other.
 *
 * The lists that only ever show one campus never see this: pick Puerto and
 * there is one CITE and one BSIT. It shows up on the lists that span campuses,
 * where the reader gets two options spelled identically and no way to tell
 * which is which. That is what this fixes, and only that: the suffix appears
 * when a label is genuinely ambiguous in the list being drawn, so
 * single-campus dropdowns are left exactly as they were.
 */

/**
 * The short way this codebase names a campus: the code if there is one, else
 * the distinctive tail of the name.
 *
 * `campus_code || campus_name` is the existing idiom (ScopeFilter and the
 * charts both use it). The fallback trims the shared prefix off the full name —
 * "PHINMA Cagayan de Oro College - Carmen Campus" is "Carmen Campus" — because
 * a suffix whose job is to tell two options apart cannot be forty characters
 * of text both of them share.
 *
 * Endpoints disagree about what they send. course.php and department.php carry
 * the campus on the row; overview_analytics.php sends departments with only a
 * `campus_id`, and the campus list separately, so the chooser can narrow itself
 * without a round trip. Passing that list here resolves the id.
 */
export function campusShortLabel(item, campuses) {
  const shorten = (name) => {
    const text = String(name || "").trim();
    if (!text) return "";
    return text.split(" - ").pop().trim() || text;
  };

  const code = String(item?.campus_code || "").trim();
  if (code) return code;

  const direct = shorten(item?.campus_name);
  if (direct) return direct;

  const id = item?.campus_id;
  if (id == null || !Array.isArray(campuses)) return "";

  const match = campuses.find((campus) => String(campus?.campus_id) === String(id));
  if (!match) return "";

  return String(match.campus_code || "").trim() || shorten(match.campus_name);
}

/** What makes two options look the same to a reader: the code they lead with. */
function identityKey(code, name) {
  const text = String(code || "").trim().toUpperCase();
  if (text) return text;
  return String(name || "").trim().toUpperCase();
}

export function courseIdentityKey(course) {
  return identityKey(course?.course_code, course?.course_name);
}

export function departmentIdentityKey(department) {
  return identityKey(department?.department_code, department?.department_name);
}

/**
 * The campus qualifier an option needs, or "" when it needs none.
 *
 * Deliberately a suffix rather than a whole label: these lists lead their
 * options differently — one shows "CODE — Name", others just the code, and the
 * attendance filter leads with the name — and unifying that would change how
 * dropdowns read on screens that have no bug. Each caller keeps its own label
 * and appends this.
 *
 * Returns "" when the campus cannot be determined, so a list that does not
 * carry campus information degrades to today's behaviour instead of rendering
 * "CITE ()".
 */
function collisionSuffix(item, items, keyOf, campuses) {
  const key = keyOf(item);
  if (!key || !Array.isArray(items)) return "";

  let seen = 0;
  for (const other of items) {
    if (keyOf(other) === key) {
      seen += 1;
      if (seen > 1) break;
    }
  }
  if (seen < 2) return "";

  const campus = campusShortLabel(item, campuses);
  return campus ? ` (${campus})` : "";
}

export function courseCampusSuffix(course, courses, campuses) {
  return collisionSuffix(course, courses, courseIdentityKey, campuses);
}

export function departmentCampusSuffix(department, departments, campuses) {
  return collisionSuffix(department, departments, departmentIdentityKey, campuses);
}
