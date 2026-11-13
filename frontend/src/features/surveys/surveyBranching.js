/**
 * Which questions a student is currently asked.
 *
 * This lives in its own module because the test used to keep a hand-copied
 * duplicate of it — and the duplicate was fed option *objects* while the page
 * actually loaded option *strings*, so the suite passed green against a shape
 * the app never produced while every branching question stayed hidden on
 * screen. One copy, imported by both, is the point of the file.
 *
 * Conditions are stored against option ids (survey_question_condition), but an
 * answer is recorded as the option's text — that is how survey_answer has
 * always stored choices, and the enrolment-status mapping reads it back the
 * same way. So options must reach here with their ids intact, and the
 * comparison happens on text.
 */

export function toOptionId(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/**
 * Option rows as the rest of the app needs them: id kept, text trimmed, blanks
 * dropped, duplicate texts collapsed.
 *
 * The id is what makes branching work at all. An earlier version of this
 * reduced each row to its text, which silently broke every condition.
 */
export function normalizeOptionRows(rows) {
  if (!Array.isArray(rows)) return [];
  const seen = new Set();
  return rows
    .map((row) => ({
      option_id: toOptionId(row?.option_id),
      option_text: String(row?.option_text ?? "").trim(),
    }))
    .filter((row) => {
      if (row.option_text === "" || seen.has(row.option_text)) return false;
      seen.add(row.option_text);
      return true;
    });
}

/** Just the labels, for rendering. */
export function optionTextsOf(list) {
  return (Array.isArray(list) ? list : []).map((row) => row?.option_text ?? "");
}

/** The option ids that reveal a question. Empty means always shown. */
export function showWhenOptionIdsOf(question) {
  const raw = question?.show_when_option_ids;
  if (!Array.isArray(raw)) return [];
  return raw.map(toOptionId).filter((id) => id > 0);
}

/**
 * A question is shown when it has no conditions, or when any one of them is
 * satisfied (OR, never AND). Checkbox answers are arrays, so "satisfied" means
 * the option is among the ticked ones.
 *
 * Answers to questions that are hidden again are deliberately left in state
 * rather than cleared: a student who flips from "No" to "Yes" and back finds
 * what they typed still there. They are filtered out at submit time instead, so
 * nothing invisible is ever saved.
 */
export function visibleQuestions(questions, optionsByQuestion, answers) {
  const optionIndex = new Map();
  Object.entries(optionsByQuestion || {}).forEach(([questionId, list]) => {
    (Array.isArray(list) ? list : []).forEach((option) => {
      const id = toOptionId(option?.option_id);
      if (id > 0) {
        optionIndex.set(id, {
          questionId: toOptionId(questionId),
          text: String(option?.option_text ?? "").trim(),
        });
      }
    });
  });

  const isChosen = (optionId) => {
    const entry = optionIndex.get(optionId);
    if (!entry) return false;
    const given = answers?.[entry.questionId] ?? answers?.[String(entry.questionId)];
    if (Array.isArray(given)) return given.some((value) => String(value).trim() === entry.text);
    return String(given ?? "").trim() === entry.text;
  };

  return (Array.isArray(questions) ? questions : []).filter((question) => {
    const gate = showWhenOptionIdsOf(question);
    return gate.length === 0 || gate.some(isChosen);
  });
}

/**
 * The branching rule as a sentence.
 *
 * The condition editor is a grid of ticked pills, which says WHAT is set but
 * never says what it MEANS -- and the meaning is the part an author needs to
 * check before saving. Two ticks on one question is "either answer"; two ticks
 * across different questions is still "either", because visibleQuestions()
 * matches if ANY chosen option was answered. Reading that off the pills is
 * guesswork; reading it off this is not.
 *
 * @param {Array<number|string>} showWhenOptionIds what the question is keyed to
 * @param {Array<{question_text: string, options: Array<{option_id: number, option_text: string}>}>} sources
 * @returns {string} a sentence, always non-empty
 */
export function describeBranching(showWhenOptionIds, sources) {
  const ids = new Set((Array.isArray(showWhenOptionIds) ? showWhenOptionIds : []).map(toOptionId).filter(Boolean));
  if (ids.size === 0) return "Always asked.";

  const parts = [];
  (Array.isArray(sources) ? sources : []).forEach((source) => {
    const picked = (source?.options || []).filter((o) => ids.has(toOptionId(o?.option_id)));
    if (picked.length === 0) return;
    const answers = picked.map((o) => `"${o.option_text}"`);
    const joined =
      answers.length === 1
        ? answers[0]
        : `${answers.slice(0, -1).join(", ")} or ${answers[answers.length - 1]}`;
    parts.push(`${source.question_text} is answered ${joined}`);
  });

  /*
   * Ticks whose option has since been deleted or renamed away leave ids that no
   * source can explain. Saying so is better than silently describing a narrower
   * rule than the one that will actually run.
   */
  if (parts.length === 0) return "Asked only on an answer that no longer exists — retick this.";

  return `Asked only when ${parts.join(" or ")}.`;
}
