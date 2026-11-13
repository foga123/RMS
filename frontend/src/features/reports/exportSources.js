/**
 * What the multi-report export can produce, and how to name the result.
 *
 * Split from ExportChooser.jsx rather than living beside the component, for the
 * same reason courseFilter.js and financeReportMetrics.js are separate: this is
 * the part worth testing, and a test that reaches it through the component
 * pulls in shared/components/ui, whose barrel re-exports Breadcrumb, which
 * imports react-router-dom v7 — ESM-only, and unresolvable by CRA's Jest. Pure
 * logic in its own file sidesteps that entirely.
 */

import { STUDENT_TYPE_LABEL } from "../../shared/lib/studentType";

/**
 * The student-scoped endpoints answer with `{ data: [...] }`.
 *
 * This used to guess — `payload.students || payload.rows` for attendance and
 * finance — and neither key has ever existed, so both exports read zero rows
 * every time and the screen said "This report has no records to export" for a
 * report showing hundreds of students. Guessing at several key names looks
 * defensive but turns a wiring mistake into a plausible-sounding empty result,
 * which is the one failure nobody thinks to check. One key, and a shape that
 * does not match reads as empty rather than throwing mid-export.
 */
function dataRows(payload) {
  return Array.isArray(payload?.data) ? payload.data : [];
}

/**
 * "Dela Cruz, Juan Miguel" — the three name columns as one.
 *
 * student.php returns them apart, which is right for a spreadsheet: a sortable
 * last name in its own column is worth more there than a tidy one. A printout
 * has no room for three columns of name, so this is what its single one holds.
 */
function studentName(row) {
  const family = String(row?.last_name ?? "").trim();
  const given = [row?.first_name, row?.middle_name]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return [family, given].filter(Boolean).join(", ");
}

/**
 * survey-summary.php is shaped differently, and the export has to say so
 * rather than bend it into the others' shape.
 *
 * Its `data` is an object, not an array — it carries the headline totals, the
 * per-question breakdown and the filter dropdowns alongside the rows. The rows
 * themselves are `data.answers`, one per answer given, and the count to page
 * against is `data.answers_total` rather than a `pagination` block.
 */
function surveyAnswerRows(payload) {
  return Array.isArray(payload?.data?.answers) ? payload.data.answers : [];
}

/**
 * The separator for a question that was answered more than once.
 *
 * A checkbox question stores one survey_answer row per ticked option, so three
 * ticks arrive as three rows sharing a submission_id and a question_id. They
 * belong in one cell — a second row for the same student would break the one
 * row per student rule for no gain. ", " is what StudentSurveyPage already uses
 * when it shows a student their own multi-select answer back.
 */
const MULTI_ANSWER_SEPARATOR = ", ";

/** Student number sorts as a number when it is one, so 9 lands before 10. */
function compareStudentNumber(a, b) {
  const left = String(a ?? "");
  const right = String(b ?? "");
  const leftNum = Number(left);
  const rightNum = Number(right);
  if (Number.isFinite(leftNum) && Number.isFinite(rightNum) && left !== "" && right !== "") {
    return leftNum - rightNum;
  }
  return left.localeCompare(right);
}

/**
 * The identity columns every survey sheet opens with.
 *
 * Widths are pinned rather than measured because these hold short values whose
 * length says nothing about how wide the column should be — a name column sized
 * to its longest name looks ragged next to the next sheet's.
 */
const SURVEY_IDENTITY_COLUMNS = [
  { key: "student_number", label: "Student No.", width: 14, emphasis: true },
  { key: "student_name", label: "Student Name", width: 24, emphasis: true },
  { key: "course_code", label: "Course", width: 11 },
  { key: "year_level", label: "Year", width: 7 },
  { key: "submitted_at", label: "Submitted", width: 18 },
];

/**
 * Answers pivoted into a response matrix — one sheet per survey, one row per
 * submission, one column per question.
 *
 * The endpoint answers in long format (a row per answer), which is the right
 * shape to page and filter but the wrong shape to read: a survey of 10
 * questions answered by 13 students arrives as 130 rows repeating each name ten
 * times. This turns that back into the grid the report is actually about.
 *
 * Three things decide the columns, in this order:
 *
 *   - Questions come from `filters.questions`, not from the answers. That list
 *     holds every question the survey has, so a question nobody answered still
 *     gets a column of blanks instead of vanishing — which is the difference
 *     between "nobody chose this" and "this was never asked".
 *   - They are matched to answers by question_id. Matching on question text
 *     would merge two genuinely different questions that happen to be worded
 *     the same, and this database has near-duplicate wording across terms.
 *   - Order is whatever the endpoint returned, which is
 *     `COALESCE(sort_order, 9999), question_id` — the author's own ordering,
 *     with unordered questions last. Never alphabetical.
 *
 * One exception to the full question list: when a filter has already narrowed
 * which questions are in play, the sheet shows only the questions that survived
 * it. Otherwise filtering to a single question would still produce every column,
 * nine of them blank, which reads as a broken export rather than a filtered one.
 */
export function buildSurveyMatrixSheets(rows, payload) {
  const answers = Array.isArray(rows) ? rows : [];
  const data = payload?.data || {};
  const applied = data.applied_filters || {};
  const allQuestions = Array.isArray(data?.filters?.questions) ? data.filters.questions : [];

  // A question-narrowing filter means the blank columns are noise, not news.
  const questionsAreNarrowed = Boolean(applied.question_id || applied.question_type || applied.search);

  // Surveys in the order the answers first mention them, so the sheet a filtered
  // export lands on is the survey the reader was looking at.
  const surveyOrder = [];
  const answersBySurvey = new Map();
  answers.forEach((answer) => {
    const surveyId = String(answer?.survey_id ?? "");
    if (!answersBySurvey.has(surveyId)) {
      answersBySurvey.set(surveyId, []);
      surveyOrder.push({ surveyId, title: answer?.survey_title || `Survey ${surveyId}` });
    }
    answersBySurvey.get(surveyId).push(answer);
  });

  return surveyOrder.map(({ surveyId, title }) => {
    const surveyAnswers = answersBySurvey.get(surveyId) || [];
    const answeredIds = new Set(surveyAnswers.map((answer) => String(answer?.question_id ?? "")));

    // The survey's declared questions, in the author's order.
    let questions = allQuestions
      .filter((question) => String(question?.survey_id ?? "") === surveyId)
      .map((question) => ({
        id: String(question.question_id),
        label: String(question.question_text || "").trim() || `Question #${question.question_id}`,
      }));

    if (questionsAreNarrowed) {
      questions = questions.filter((question) => answeredIds.has(question.id));
    }

    // Anything answered but absent from the declared list — a question deleted
    // after it was answered, say — is appended rather than dropped, so no answer
    // silently fails to reach the sheet.
    const declared = new Set(questions.map((question) => question.id));
    surveyAnswers.forEach((answer) => {
      const id = String(answer?.question_id ?? "");
      if (!id || declared.has(id)) return;
      declared.add(id);
      questions.push({
        id,
        label: String(answer?.question_text || "").trim() || `Question #${id}`,
      });
    });

    const columns = [
      ...SURVEY_IDENTITY_COLUMNS,
      ...questions.map((question) => ({ key: `q_${question.id}`, label: question.label, width: 24 })),
    ];

    /*
     * Keyed by submission, not by student.
     *
     * They are the same thing whenever a student answers a survey once, which is
     * every row in this database today. They stop being the same the moment
     * someone submits twice — and then two submissions are two events with two
     * timestamps, so they get two rows rather than being folded together and
     * losing one set of answers.
     */
    const bySubmission = new Map();
    surveyAnswers.forEach((answer) => {
      const submissionId = String(answer?.submission_id ?? "");
      if (!submissionId) return;

      if (!bySubmission.has(submissionId)) {
        bySubmission.set(submissionId, {
          student_number: answer?.student_number || "",
          student_name: answer?.student_name || "",
          course_code: answer?.course_code || "",
          year_level: answer?.year_level == null ? "" : String(answer.year_level),
          submitted_at: answer?.submitted_at || "",
        });
      }

      const row = bySubmission.get(submissionId);
      const key = `q_${answer?.question_id ?? ""}`;
      const value = String(answer?.answer_value ?? "").trim();
      if (value === "") return;
      row[key] = row[key] ? `${row[key]}${MULTI_ANSWER_SEPARATOR}${value}` : value;
    });

    const sheetRows = Array.from(bySubmission.values()).sort((a, b) => {
      const byNumber = compareStudentNumber(a.student_number, b.student_number);
      if (byNumber !== 0) return byNumber;
      return String(a.submitted_at).localeCompare(String(b.submitted_at));
    });

    return {
      name: title,
      columns,
      rows: sheetRows,
      options: { matrix: true },
    };
  });
}

/**
 * Columns name keys the endpoints actually return — checked against the SELECT
 * in each PHP file, not against what the column would ideally be called. A key
 * that does not exist is not an error anywhere; it is a column of blanks in a
 * file someone is about to hand to a dean.
 */
export const EXPORT_SOURCES = {
  /*
   * The Student Report had no export at all.
   *
   * It was the only one of the four student-facing reports without one:
   * attendance, grades and finance each had a source here and a place in
   * SCOPED_REPORTS, so ReportExport rendered for them and returned null for
   * students — a report you could read and not take away.
   *
   * `include_archived` is fixed on rather than offered as a choice, because the
   * report itself counts archived students in its own totals. An export that
   * silently left them out would disagree with the chart directly above it, and
   * the difference would look like a bug in one of the two.
   */
  students: {
    label: "Students",
    sheet: "Students",
    endpoint: "student.php",
    rowsFrom: dataRows,
    fixedParams: { include_archived: 1 },
    columns: [
      { key: "student_number", label: "Student No." },
      { key: "last_name", label: "Last Name" },
      { key: "first_name", label: "First Name" },
      { key: "middle_name", label: "Middle Name" },
      { key: "student_type", label: STUDENT_TYPE_LABEL },
      { key: "course_code", label: "Course" },
      { key: "course_name", label: "Course Name" },
      { key: "department_name", label: "Department" },
      { key: "year_level", label: "Year Level" },
      { key: "section", label: "Section" },
      { key: "schoolyear_name", label: "School Year" },
      { key: "gender", label: "Sex" },
      { key: "modality", label: "Modality" },
      { key: "email_address", label: "Email" },
      { key: "mobile_number", label: "Mobile" },
      { key: "final_scholarship_grant", label: "Scholarship" },
      // Derived rather than raw: `archived_at` is a timestamp or NULL, and a
      // column of blanks and datetimes is not a status anyone can filter in a
      // spreadsheet.
      { key: "status", label: "Status" },
    ],

    /*
     * The printout is nine of those columns, not seventeen.
     *
     * This is the widest export in the app, and a landscape page divided
     * seventeen ways gives each column about 40 points — enough for "College
     * of..." and not the name of the department. The spreadsheet is the copy you
     * filter and widen, so it keeps every field; the PDF is the copy you hand
     * someone, so it keeps the ones that identify a student and drops the
     * contact details and the scholarship note nobody reads off a printout.
     */
    pdfColumns: [
      { key: "student_number", label: "Student No." },
      { key: "student_name", label: "Student" },
      { key: "student_type", label: STUDENT_TYPE_LABEL },
      { key: "course_code", label: "Course" },
      { key: "department_name", label: "Department" },
      { key: "year_level", label: "Year" },
      { key: "section", label: "Section" },
      { key: "schoolyear_name", label: "School Year" },
      { key: "status", label: "Status" },
    ],

    toRows: (rows) =>
      rows.map((row) => ({
        ...row,
        status: row?.archived_at ? "Archived" : "Active",
        // One column for the printout, which has no room for three. The
        // spreadsheet still gets the parts separately, because a sortable last
        // name is worth more there than a tidy one.
        student_name: studentName(row),
      })),
  },
  attendance: {
    label: "Attendance",
    sheet: "Attendance",
    endpoint: "attendance-summary.php",
    rowsFrom: dataRows,
    // attendance-summary.php renders these itself from `?format=`. It is the
    // only one of the three that does, so it is the only report offering more
    // than the workbook the browser builds — see ReportExport.
    serverFormats: ["csv", "pdf"],
    columns: [
      { key: "student_id", label: "Student No." },
      { key: "student_name", label: "Student" },
      { key: "course_code", label: "Course" },
      { key: "section", label: "Section" },
      { key: "total_classes_conducted", label: "Sessions" },
      { key: "present", label: "Present" },
      { key: "absent", label: "Absent" },
      { key: "present_percentage", label: "Present %" },
      { key: "absent_percentage", label: "Absent %" },
    ],
  },
  grades: {
    label: "Grades",
    sheet: "Grades",
    endpoint: "grades.php",
    rowsFrom: dataRows,
    // grades.php returns the name in two halves and has no per-subject rows —
    // it stores the per-term tallies, so that is what the sheet carries.
    columns: [
      { key: "student_number", label: "Student No." },
      { key: "last_name", label: "Last Name" },
      { key: "first_name", label: "First Name" },
      { key: "course_code", label: "Course" },
      { key: "total_subject", label: "Subjects" },
      { key: "passed", label: "Passed" },
      { key: "failed", label: "Failed" },
      { key: "incomplete", label: "Incomplete" },
      { key: "passed_of_subject", label: "Passed %" },
      { key: "remarks", label: "Remarks" },
      { key: "semester_name", label: "Semester" },
      { key: "schoolyear_name", label: "School Year" },
    ],
  },
  finance: {
    label: "Finance",
    sheet: "Finance",
    endpoint: "finance-summary.php",
    rowsFrom: dataRows,
    columns: [
      { key: "student_id", label: "Student No." },
      { key: "student_name", label: "Student" },
      { key: "course_code", label: "Course" },
      { key: "year_level", label: "Year" },
      { key: "balance", label: "Balance" },
      { key: "previous_balance", label: "Previous Balance" },
      { key: "balance_unchanged", label: "Unchanged" },
    ],
  },
  survey: {
    label: "Survey",
    sheet: "Survey Answers",
    endpoint: "survey-summary.php",
    rowsFrom: surveyAnswerRows,

    /*
     * Not student-scoped. Department, course and year level do not narrow this
     * report — a survey answer hangs off a submission, not off a course — so the
     * export offers no scope chooser and honours the survey / question / search
     * filters on screen instead. Those come through as `filters` on the
     * component rather than being assumed here.
     */
    scoped: false,

    // survey-summary.php pages with `page_size`, not `limit`, and reports the
    // count as `data.answers_total` rather than a `pagination` block. Naming
    // both here keeps the paging loop in ReportExport generic instead of
    // growing a special case for this one report.
    limitParam: "page_size",
    totalFrom: (payload) => payload?.data?.answers_total,

    /*
     * The workbook is a response matrix, not the long list the endpoint sends.
     *
     * toSheets pivots the paged answer rows into one sheet per survey. An
     * earlier version of this exported long format — a row per answer — on the
     * argument that it survives a survey gaining a question. It does, but it is
     * not what anyone opens the file to read: ten questions and thirteen
     * students arrived as 130 rows with each name repeated ten times. The pivot
     * rebuilds the columns from the survey's live question list on every export,
     * so a question added or removed since the last export is simply a column
     * that appears or disappears.
     */
    toSheets: buildSurveyMatrixSheets,

    /*
     * Still declared, and still accurate: this is the shape the endpoint answers
     * with and the shape the paging loop accumulates. toSheets consumes these
     * rows; `columns` is what they would look like unpivoted, and is what the
     * CSV path would use if this report ever grows one.
     */
    columns: [
      { key: "submitted_at", label: "Submitted" },
      { key: "student_number", label: "Student No." },
      { key: "student_name", label: "Student" },
      { key: "survey_title", label: "Survey" },
      { key: "question_text", label: "Question" },
      { key: "question_type", label: "Type" },
      { key: "answer_value", label: "Answer" },
      { key: "submission_id", label: "Submission ID" },
    ],
  },
};

/**
 * The scope, as query params all three endpoints understand.
 *
 * Blank steps are dropped rather than sent empty: the endpoints test for an
 * empty string, and a `course_id=` that slipped through as 0 would match
 * nobody and silently produce an empty export.
 */
export function scopeToParams(scope) {
  const params = new URLSearchParams();
  if (scope?.campusId) params.set("campus_id", scope.campusId);
  if (scope?.departmentId) params.set("department_id", scope.departmentId);
  if (scope?.courseId) params.set("course_id", scope.courseId);
  if (scope?.yearLevel) params.set("year_level", scope.yearLevel);
  return params;
}

/** "attendance-finance-ccs-bsit-year-2" — the file says what is in it. */
export function buildExportName(keys, scopeLabel) {
  const scopePart = String(scopeLabel || "")
    .replace(/·/g, "-")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return [keys.join("-"), scopePart || "all"].filter(Boolean).join("-").toLowerCase();
}
