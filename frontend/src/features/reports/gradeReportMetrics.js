/**
 * The Grade Report's aggregation, lifted out of the fetch that used to do it.
 *
 * It ran once inside loadGradeReport and wrote the result straight to state, so
 * every derived number was welded to one server response. Narrowing to a course
 * would have meant refetching the whole dataset to recount rows the browser was
 * already holding. As a pure function over rows it can be re-run against any
 * subset, which is what the course filter needs.
 *
 * Returns the same shape as the empty report, so "no rows" and "not loaded yet"
 * render identically instead of one of them throwing on a missing array.
 */

export const EMPTY_GRADE_REPORT = {
  total: 0,
  student_total: 0,
  average_passed_pct: 0,
  failing_records: 0,
  incomplete_records: 0,
  by_semester: [],
  by_school_year: [],
};

function round2(value) {
  return Number(value.toFixed(2));
}

export function summariseGrades(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) return { ...EMPTY_GRADE_REPORT, by_semester: [], by_school_year: [] };

  const studentIds = new Set();
  const bySemesterMap = new Map();
  const bySchoolYearMap = new Map();
  let passingAverageTotal = 0;
  let passingAverageCount = 0;
  let failingRecords = 0;
  let incompleteRecords = 0;

  list.forEach((row) => {
    if (row?.student_id != null) {
      studentIds.add(String(row.student_id));
    }

    const passedPct = Number(row?.passed_of_subject);
    if (Number.isFinite(passedPct)) {
      passingAverageTotal += passedPct;
      passingAverageCount += 1;
    }
    if (Number(row?.failed || 0) > 0 || Number(row?.no_credit || 0) > 0) {
      failingRecords += 1;
    }
    if (Number(row?.incomplete || 0) > 0) {
      incompleteRecords += 1;
    }

    const semesterKey = String(row?.semester_id ?? "semester_unknown");
    const semesterLabel = row?.semester_name || (row?.semester_id ? `Semester ${row.semester_id}` : "Unassigned");
    const semesterBucket = bySemesterMap.get(semesterKey) || {
      key: semesterKey,
      label: semesterLabel,
      total: 0,
      studentIds: new Set(),
      passedPctTotal: 0,
      passedPctCount: 0,
    };
    semesterBucket.total += 1;
    if (row?.student_id != null) semesterBucket.studentIds.add(String(row.student_id));
    if (Number.isFinite(passedPct)) {
      semesterBucket.passedPctTotal += passedPct;
      semesterBucket.passedPctCount += 1;
    }
    bySemesterMap.set(semesterKey, semesterBucket);

    const schoolYearKey = String(row?.school_year_id ?? "school_year_unknown");
    const schoolYearLabel = row?.schoolyear_name || (row?.school_year_id ? `School Year ${row.school_year_id}` : "Unassigned");
    const schoolYearBucket = bySchoolYearMap.get(schoolYearKey) || {
      key: schoolYearKey,
      label: schoolYearLabel,
      total: 0,
    };
    schoolYearBucket.total += 1;
    bySchoolYearMap.set(schoolYearKey, schoolYearBucket);
  });

  const by_semester = Array.from(bySemesterMap.values())
    .map((bucket) => ({
      key: bucket.key,
      label: bucket.label,
      total: bucket.total,
      student_total: bucket.studentIds.size,
      average_passed_pct: bucket.passedPctCount > 0 ? round2(bucket.passedPctTotal / bucket.passedPctCount) : 0,
    }))
    .sort((a, b) => (b.total - a.total) || String(a.label || "").localeCompare(String(b.label || "")));

  const by_school_year = Array.from(bySchoolYearMap.values())
    .sort((a, b) => (b.total - a.total) || String(a.label || "").localeCompare(String(b.label || "")));

  return {
    total: list.length,
    student_total: studentIds.size,
    average_passed_pct: passingAverageCount > 0 ? round2(passingAverageTotal / passingAverageCount) : 0,
    failing_records: failingRecords,
    incomplete_records: incompleteRecords,
    by_semester,
    by_school_year,
  };
}
