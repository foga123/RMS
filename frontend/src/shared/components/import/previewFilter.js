/**
 * Finding one row in a file of five thousand.
 *
 * The review step inside the import dialog answers "is this the right file" —
 * counts, and the list of rows that will not land. It cannot answer "what does
 * line 1,482 say", because a 561px dialog is not a place to read a table.
 *
 * The full-size preview is, and at that size the two questions people actually
 * arrive with are "show me only the problems" and "where is this student". Both
 * are here rather than in the component, because a filter that quietly drops
 * rows is exactly the kind of thing that should be provable.
 */

/** The buckets the preview offers, in the order they are shown. */
export const PREVIEW_FILTERS = [
  { key: "all", label: "All rows" },
  { key: "keep", label: "Will be imported" },
  { key: "skip", label: "Will be skipped" },
];

export function previewCounts(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const skip = list.filter((row) => row?.status === "skip").length;
  return { all: list.length, keep: list.length - skip, skip };
}

/**
 * The rows a reader asked to see.
 *
 * The search reads the row's own cells and its line number, and nothing else. A
 * match against the skip reason was tried and removed: typing "exists" then
 * returned every duplicate in the file, which reads as a search result about
 * students and is a search result about error messages.
 *
 * Matching is case-insensitive and substring-based on purpose — people paste a
 * partial student number as often as a whole one, and "dela" has to find
 * "DELA CRUZ".
 */
export function filterPreviewRows(rows, { status = "all", query = "" } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const needle = String(query || "").trim().toLowerCase();

  return list.filter((row) => {
    if (status === "skip" && row?.status !== "skip") return false;
    if (status === "keep" && row?.status === "skip") return false;
    if (!needle) return true;

    if (String(row?.lineNumber ?? "") === needle) return true;
    return Object.values(row?.cells || {}).some((value) =>
      String(value ?? "").toLowerCase().includes(needle)
    );
  });
}

/**
 * What to say when a filter or a search has emptied the table.
 *
 * Three different empties, and "No rows" for all three would leave a reader
 * looking at a blank table wondering whether the file was misread.
 */
export function emptyPreviewMessage({ status, query, counts }) {
  if (query) return `No row matches "${query}".`;
  if (status === "skip") return "Every row in this file will be imported — nothing is being skipped.";
  if (status === "keep") {
    return counts?.all > 0
      ? "Not one row in this file can be imported."
      : "This file has no rows.";
  }
  return "This file has no rows.";
}
