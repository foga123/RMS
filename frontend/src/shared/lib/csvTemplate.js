/**
 * Build and download a CSV import template.
 *
 * Import forms accept a specific set of column headers, and until now the only
 * way to learn them was to trigger a validation error one column at a time.
 * A template turns that into a starting point: correct headers, one example row
 * showing the expected format of each field.
 *
 * The leading BOM matters — Excel opens a plain UTF-8 CSV in the system
 * codepage and mangles non-ASCII names without it.
 */

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function buildCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function downloadCsvTemplate(filename, headers, exampleRows = []) {
  const csv = buildCsv([headers, ...exampleRows]);
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}
