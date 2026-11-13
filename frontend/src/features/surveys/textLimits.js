/**
 * How long the text an author writes into a survey may be.
 *
 * The browser copy of backend/api/lib/survey_text_limits.php, which is the
 * authority — same arrangement as answerFormats.js and its PHP counterpart. The
 * server rejects anything over these numbers whatever the browser does; this
 * exists so the author is stopped while typing instead of after pressing Save.
 *
 * Why each limit is what it is:
 *
 *   question_text 300 - a question becomes a column header in the exported
 *                       response matrix. The longest question written so far is
 *                       68 characters; a paragraph makes the sheet unreadable
 *                       however the column wraps.
 *   option_text   120 - a choice has to fit on one line of a radio button on a
 *                       phone. Longest so far: 27.
 *   survey_title  120 - it is also the worksheet name in the export, which
 *                       Excel truncates at 31 characters, and the column is
 *                       varchar(255) which MySQL was silently cutting to fit.
 */

export const SURVEY_TEXT_LIMITS = {
  question_text: 300,
  option_text: 120,
  survey_title: 120,
};

/**
 * Show a counter only once it is worth showing.
 *
 * Matching StudentSurveyPage, which reveals its counter at 80% of the limit: a
 * counter that is always on reads as a warning about text that is perfectly
 * fine, and after a while stops being read at all.
 */
export const COUNTER_VISIBLE_AT = 0.8;

export function surveyTextLimit(field) {
  return SURVEY_TEXT_LIMITS[field] || 0;
}

/** `null` when the value fits, otherwise how far over it is. */
export function surveyTextCounter(field, value) {
  const limit = surveyTextLimit(field);
  const length = String(value ?? "").length;
  if (limit <= 0 || length < limit * COUNTER_VISIBLE_AT) return null;
  return { length, limit, over: length > limit };
}
