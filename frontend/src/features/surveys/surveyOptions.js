/**
 * A question's answer choices, as the editor sends them to be saved.
 *
 * Blank rows are dropped - they are the empty line the "Add choice" button
 * leaves - and each remaining choice is trimmed. A choice listed twice is
 * refused, not quietly dropped: dropping it lost the author's edit without a
 * word, and when the repeat was an existing choice renamed to match another,
 * the save then deleted that choice along with every answer filed under it.
 *
 * Compared the way the server compares (case and surrounding spaces ignored),
 * so the author hears about a repeat before a request is made. The server
 * refuses the same list with 409 either way; see survey_options_replace() in
 * backend/api/lib/survey_uniqueness.php.
 */
export function prepareOptionPayload(optionRows) {
  if (!Array.isArray(optionRows)) return [];
  const seen = new Set();
  const cleaned = [];
  for (const row of optionRows) {
    const optionText = String(row?.option_text ?? "").trim();
    if (!optionText) continue;
    const key = optionText.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`"${optionText}" is listed twice. Each choice must be different.`);
    }
    seen.add(key);
    const optionId = Number(row?.option_id || 0);
    const statusId = Number(row?.enrollment_status_id || 0);
    cleaned.push({
      option_id: optionId > 0 ? optionId : 0,
      option_text: optionText,
      // null rather than 0 or "": the API reads null as "clear the mapping".
      enrollment_status_id: statusId > 0 ? statusId : null,
    });
  }
  return cleaned;
}
