/**
 * Answers in progress, and the three states a survey can be in for a student.
 *
 * "In Progress" was not a state the student page could report before, because
 * closing the dialog threw the answers away — someone four questions into a ten
 * question survey who lost their connection started again from nothing. A draft
 * makes the middle state real, which is what lets a card say Continue instead of
 * Start and mean it.
 *
 * Its own module, beside answerFormats and surveyBranching, because storage and
 * status are decisions that have to hold still while the screen around them
 * changes — and because a rule kept in a component cannot be tested without
 * rendering one.
 *
 * localStorage rather than the server: an unfinished survey is not a
 * submission, and giving it a row would force a decision about what the reports
 * should do with a half-answered one.
 */

const DRAFT_PREFIX = "coc-survey-draft";

export const SURVEY_STATUS = {
  notStarted: "not_started",
  inProgress: "in_progress",
  completed: "completed",
};

function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Keyed by student *and* survey.
 *
 * The student id is in the key rather than assumed, because these machines are
 * shared: a lab browser that kept one draft per survey would offer the next
 * student the previous one's answers.
 */
export function draftKey(studentId, surveyId) {
  return `${DRAFT_PREFIX}:${positiveInt(studentId)}:${positiveInt(surveyId)}`;
}

export function readDraft(studentId, surveyId) {
  if (!positiveInt(studentId) || !positiveInt(surveyId)) return null;
  try {
    const raw = window.localStorage.getItem(draftKey(studentId, surveyId));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    return parsed.answers && typeof parsed.answers === "object" ? parsed : null;
  } catch {
    // Corrupt JSON, or a browser refusing storage. Either way there is no draft
    // to resume, which is a smaller loss than throwing on page load.
    return null;
  }
}

export function writeDraft(studentId, surveyId, answers) {
  if (!positiveInt(studentId) || !positiveInt(surveyId)) return false;
  try {
    window.localStorage.setItem(
      draftKey(studentId, surveyId),
      JSON.stringify({ answers: answers || {}, updated_at: Date.now() })
    );
    return true;
  } catch {
    // A full or private-mode store costs the resume, never the submission.
    return false;
  }
}

export function clearDraft(studentId, surveyId) {
  try {
    window.localStorage.removeItem(draftKey(studentId, surveyId));
  } catch {
    // Ignore: the caller clears its in-memory copy either way.
  }
}

/**
 * Does this draft hold anything a student would recognise as progress?
 *
 * An empty string and an empty array are both "touched but not answered" — a
 * radio the student clicked and then cleared, a checkbox ticked and unticked.
 * Treating those as progress would put a card into In Progress that has nothing
 * in it to continue.
 */
export function draftHasProgress(draft) {
  const answers = draft?.answers;
  if (!answers || typeof answers !== "object") return false;
  return Object.values(answers).some((value) =>
    Array.isArray(value) ? value.length > 0 : String(value ?? "").trim() !== ""
  );
}

/**
 * Not started / In progress / Completed.
 *
 * Submitted always wins: a draft left behind by an interrupted attempt must not
 * make an answered survey look unfinished.
 */
export function surveyStatus({ submitted, studentId, surveyId }) {
  if (submitted) return SURVEY_STATUS.completed;
  if (draftHasProgress(readDraft(studentId, surveyId))) return SURVEY_STATUS.inProgress;
  return SURVEY_STATUS.notStarted;
}
