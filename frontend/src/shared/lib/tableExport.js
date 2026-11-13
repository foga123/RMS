import { downloadCsvFile, downloadExcelFile } from "./spreadsheet";
import { downloadPdfFile } from "./pdf";
import { localDateIso } from "./localDate";

/**
 * Exporting the table a page is showing.
 *
 * The Students, Grades and Finance pages all want the same thing: the rows that
 * survived the filters, in the columns on screen, as a file. This is the one
 * place that turns a column list and a row list into one, so the three pages
 * differ only in what their columns are.
 *
 * ---------------------------------------------------------------------------
 * Why these are built in the browser and not by PHP
 *
 * Attendance exports server-side, through `attendance-summary.php?format=`, and
 * copying that was the obvious move. It would have been wrong for these three.
 *
 * The search box on Students and on Finance filters CLIENT-side — Finance loads
 * every row and narrows it in a useMemo, Students does the same behind
 * fetchAllPages(). Their endpoints have never seen a `search` parameter. So a
 * server-built file would quietly ignore whatever was typed in the search box
 * and handed back the whole table, which is the one thing an export must not
 * do: it looks like it worked. Making it honest would mean reimplementing that
 * multi-field search in PHP, twice, against joined student-number and semester
 * names, and keeping it in step with the JavaScript forever.
 *
 * Building here sidesteps all of it, because what gets written is exactly the
 * array the table is rendering from. Grades is the exception that proves it
 * safe: it filters server-side and paginates at 20, so its page re-asks the
 * endpoint for the whole filtered set before calling this — see
 * GradesPage.exportRows().
 *
 * This file used to record a cost for that choice: PDF was on offer on
 * Attendance and not here, because "there is no PDF writer in the browser and
 * adding one for a printout of a table is not worth the dependency". The
 * premise was wrong rather than the conclusion — attendance-summary.php has
 * been writing PDFs with no dependency at all for as long as it has existed.
 * shared/lib/pdf.js is the same approach in the browser, so all three formats
 * are now built from the one column list, here, from the rows on screen.
 * ---------------------------------------------------------------------------
 */

/** What the Export menu offers on a client-built export. */
export const TABLE_EXPORT_FORMATS = [
  { key: "excel", label: "Excel", hint: ".xls" },
  { key: "csv", label: "CSV", hint: ".csv" },
  { key: "pdf", label: "PDF", hint: ".pdf" },
];

/**
 * Today, as `YYYY-MM-DD`, for a filename.
 *
 * Local date rather than toISOString(), which is UTC — at UTC+8 that names a
 * file exported at 7am with yesterday's date, and a folder of exports that
 * sorts wrongly is worse than no date at all.
 *
 * This file worked that out first and then kept the answer to itself: four other
 * places went on writing the UTC version, two of them into stored record dates.
 * The implementation moved to shared/lib/localDate.js so there is one of it, and
 * this name stays for the callers that already read well with it.
 */
export function exportDateStamp(date = new Date()) {
  return localDateIso(date);
}

/**
 * Write the file.
 *
 * `columns` is `[{ key, label }]` and `rows` is an array of plain objects keyed
 * by those `key`s, already formatted for a reader — a page decides how its own
 * dates and money should read, not this.
 *
 * Returns false when there is nothing to write, so the caller can say so rather
 * than handing over an empty file that looks like a failure.
 *
 * `pdfColumns` narrows just the printout, for a table too wide to fit a page.
 * It is optional and defaults to `columns`, because most tables here are not:
 * the PDF writer sizes columns to their contents and steps the font down before
 * it truncates anything, so a dozen columns still read. It exists for the tables
 * that carry every field a record has, where the spreadsheet is the thing you
 * filter and the PDF is the thing you hand someone.
 */
export function exportTable(format, { filename, sheet, columns, rows, pdfColumns }) {
  const safeRows = Array.isArray(rows) ? rows : [];
  if (safeRows.length === 0) return false;

  const stamped = `${filename}-${exportDateStamp()}`;

  if (format === "csv") {
    downloadCsvFile(stamped, columns, safeRows);
    return true;
  }

  if (format === "pdf") {
    downloadPdfFile(stamped, {
      title: sheet,
      columns: Array.isArray(pdfColumns) && pdfColumns.length > 0 ? pdfColumns : columns,
      rows: safeRows,
    });
    return true;
  }

  downloadExcelFile(stamped, sheet, columns, safeRows);
  return true;
}
