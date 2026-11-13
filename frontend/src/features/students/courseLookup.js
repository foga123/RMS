import { normalizeCsvToken } from "../../shared/lib/spreadsheet";

/**
 * Turning a course code in a spreadsheet into the course it means.
 *
 * Its own module because it stopped being a one-liner and started being a
 * decision. Course codes were unique across the school when the importer was
 * written, so a flat Map<code, id> was enough. They are not unique any more:
 * a department can run on more than one campus, so BSIT exists as a Carmen
 * course and a Puerto course, and the flat map kept only whichever came last.
 * An import naming BSIT resolved by array order - a file of Carmen students
 * would have been enrolled into Puerto with no row rejected and nothing said.
 *
 * A rule that can put students on the wrong campus in silence is a rule that
 * has to be testable without rendering a two-thousand-line page, which is the
 * other reason it lives here.
 */

/**
 * Every course a token could mean, keyed by the tokens a file might use.
 *
 * An explicit course_id is registered on its own, because an id is never
 * ambiguous however the codes collide.
 */
export function buildCourseMatchIndex(courses) {
  const index = new Map();

  const add = (token, entry) => {
    if (!token) return;
    const existing = index.get(token);
    if (existing) {
      if (!existing.some((match) => match.course_id === entry.course_id)) existing.push(entry);
      return;
    }
    index.set(token, [entry]);
  };

  (courses || []).forEach((course) => {
    const courseId = Number(course?.course_id);
    if (!Number.isFinite(courseId)) return;

    const campusId = Number(course?.campus_id);
    const entry = {
      course_id: courseId,
      campus_id: Number.isFinite(campusId) && campusId > 0 ? campusId : null,
      campus_label: course?.campus_name || course?.campus_code || "",
      course_code: course?.course_code || "",
    };

    add(String(courseId), entry);
    add(normalizeCsvToken(course?.course_code), entry);
    add(normalizeCsvToken(course?.course_name), entry);
  });

  return index;
}

/**
 * Which course this row means, or why the file cannot say.
 *
 * The campus chosen in the import dialog is what tells two courses of the same
 * code apart - that is the work it does, beyond rejecting rows from elsewhere.
 * Where it cannot settle the question the row is refused and names the campuses
 * it could have meant, because guessing is how students end up somewhere nobody
 * intended.
 *
 * A course whose department has no campus on file matches either way:
 * unassigned is not the same as somewhere else.
 *
 * Returns the course id. Throws with a message meant for the row's error list.
 */
export function resolveImportCourse({ index, courseValue, campusId = null, campusName = "" }) {
  const token = courseValue ? normalizeCsvToken(courseValue) : "";
  const matches = token ? index.get(token) || [] : [];

  if (matches.length === 0) {
    throw new Error("course must match one of your department courses");
  }

  if (matches.length === 1) {
    const only = matches[0];
    if (campusId && only.campus_id !== null && only.campus_id !== campusId) {
      throw new Error(`${courseValue} is on ${only.campus_label || "another campus"}, not ${campusName}`);
    }
    return only.course_id;
  }

  if (!campusId) {
    const campuses = matches.map((match) => match.campus_label || "an unnamed campus");
    throw new Error(
      `"${courseValue}" is offered on ${campuses.join(" and ")} — choose a campus above so this file can say which`
    );
  }

  const onChosenCampus = matches.filter(
    (match) => match.campus_id === null || match.campus_id === campusId
  );

  if (onChosenCampus.length === 1) return onChosenCampus[0].course_id;
  if (onChosenCampus.length === 0) {
    throw new Error(`${courseValue} is not offered on ${campusName}`);
  }
  throw new Error(`"${courseValue}" matches more than one course on ${campusName}`);
}
