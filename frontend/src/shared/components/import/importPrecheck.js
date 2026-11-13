/**
 * "Is there already something here?" — asked before an import writes.
 *
 * The three sheet importers write with INSERT ... ON DUPLICATE KEY UPDATE, so a
 * row for a student who already has a record for the chosen term REPLACES it.
 * That is the right behaviour — it is how a corrected spreadsheet gets applied —
 * but the dialog asked for the term and the file in the same breath and then did
 * it, and the only evidence afterwards was an "updated" count in the summary. A
 * file uploaded against the wrong semester overwrites a term of real figures and
 * says "import complete".
 *
 * These build the warning ImportDialog shows before the second, deliberate
 * click. The counting differs per module — some endpoints page and report a
 * total, one returns everything and is counted here — so what is shared is the
 * wording and the shape, which is the part that should not drift between four
 * screens saying the same thing.
 */

import { getBackendUrl } from "../../lib/url";

/**
 * The most rows the sheet importers will read from one file.
 *
 * Mirrors SHEETIMPORT_MAX_ROWS in lib/spreadsheet_import.php (and the identical
 * ATTIMPORT_MAX_ROWS in attendance-import.php). It matters on this side because
 * of HOW the backends enforce it: all three do
 *
 *     array_slice($rows, $headerRowIndex + 1, SHEETIMPORT_MAX_ROWS, true)
 *
 * which TRUNCATES. A 6,000-row file imports the first 5,000, reports "5,000 rows
 * read", and says nothing at all about the 1,000 it dropped. Nobody finds out
 * until a thousand students are missing from a term.
 *
 * So the dialog refuses the file up front instead. This is the only place that
 * catches it.
 */
export const SHEET_IMPORT_MAX_ROWS = 5000;

/**
 * The note shown for importers that send one request per row.
 *
 * Student Management and Enrollment Status POST each row separately, and
 * middleware/throttle.php allows a burst of 120 requests then 120/min — with 20
 * refusals inside a minute earning a ten-minute block. So a 1,000-row file does
 * not fail at row 1,001 of a limit; it stalls partway through and locks the
 * account out, having written some unknown prefix of the file.
 *
 * Not a blocker, because the file is legitimate and the split is the reader's
 * call. It is the number they need in order to make that call.
 */
export function perRowRequestNotice(count, noun = "students") {
  if (!count) return "";
  if (count <= 100) {
    return `${count.toLocaleString()} ${count === 1 ? noun.replace(/s$/, "") : noun} will be sent, one request each.`;
  }
  return `This sends ${count.toLocaleString()} separate requests — one per row. Above roughly 120 in a minute the server starts refusing them, and enough refusals locks the account out for ten minutes. Uploading in parts of about 100 rows, a minute apart, avoids it.`;
}

/**
 * How many records an endpoint holds for these filters.
 *
 * Asks for a single row and reads `pagination.total`, so the size of the answer
 * does not depend on the size of the term.
 */
export async function countExisting(endpoint, params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== null && value !== undefined && value !== "") {
      query.set(key, String(value));
    }
  });
  query.set("page", "1");
  query.set("limit", "1");

  const response = await fetch(getBackendUrl(`${endpoint}?${query.toString()}`), {
    headers: { Accept: "application/json" },
    credentials: "include",
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload?.message || "Could not read what is already recorded for this term.");
  }
  return Number(payload?.pagination?.total) || 0;
}

/** "1st Semester 2026-2027, P2" — whatever parts the caller could name. */
export function describeTerm(parts) {
  return parts.filter(Boolean).join(" ");
}

/**
 * The warning for an importer that updates what it finds.
 *
 * Says the count and the term in the headline because those are the two things
 * that reveal the mistake: someone who meant 2nd Semester sees "1st Semester
 * 2026-2027" and stops, without having to reason about what an upsert does.
 */
export function overwriteWarning({ count, noun, termLabel }) {
  if (!count) return null;
  const plural = count === 1 ? noun : `${noun}s`;

  return {
    headline: `${termLabel} already has ${count.toLocaleString()} ${plural} on record.`,
    lines: [
      `Any row for a student who already has a ${noun} for this term replaces it. The figures on record now are overwritten, not kept beside the new ones.`,
      "Rows for students with nothing recorded for this term are added as usual.",
    ],
    confirmLabel: `Yes, update the ${count.toLocaleString()} existing ${plural}`,
  };
}

/**
 * The warning for an importer that adds alongside what it finds.
 *
 * Enrollment statuses POST a plain INSERT — no unique key, no upsert — so a term
 * imported twice ends up holding two standings per student. Nothing errors and
 * the summary reports every row as recorded, but the Student Migration board
 * counts these rows, so the term quietly reports twice the students it has.
 * This is the one importer where re-uploading is worse than doing nothing.
 */
export function duplicateAppendWarning({ count, noun, termLabel }) {
  if (!count) return null;
  const plural = count === 1 ? noun : `${noun}s`;

  return {
    headline: `${termLabel} already has ${count.toLocaleString()} ${plural} recorded.`,
    lines: [
      `These are ADDED, not replaced. A student who already has a ${noun} for this term ends up with two, and reports that count this term will count them twice.`,
      `Upload only if this file covers students not yet recorded for ${termLabel}.`,
    ],
    confirmLabel: "I know — record these as well",
  };
}
