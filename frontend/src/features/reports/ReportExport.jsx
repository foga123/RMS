import React, { useState } from "react";
import { ExportMenu } from "../../shared/components/ui";
import { getBackendUrl } from "../../shared/lib/url";
import { downloadFromApi } from "../../shared/lib/download";
import { downloadExcelFile, downloadExcelWorkbook } from "../../shared/lib/spreadsheet";
import { downloadPdfFile } from "../../shared/lib/pdf";
import { exportDateStamp } from "../../shared/lib/tableExport";
import { EXPORT_SOURCES, scopeToParams, buildExportName } from "./exportSources";

/**
 * Export for the report currently on screen — that report only.
 *
 * An earlier version of this put attendance, grades and finance into one
 * workbook with a sheet each. That was the wrong shape: these are separate
 * reports that are read separately, and someone exporting attendance for CITE
 * Year 2 wants an attendance file, not a workbook with two sheets they did not
 * ask for and have to delete.
 *
 * Two targets, because both are real jobs:
 *
 *   This selection - whatever the filter above is showing. Pick a department
 *                    and a year, and that is what lands in the file.
 *   Everything     - the whole report, filter ignored, for the end-of-term
 *                    pull where narrowing it first would be a step backwards.
 *
 * Rows come from the server at export time rather than from what the table is
 * holding, so a filtered export is filtered by the same WHERE clause the screen
 * used, and an unfiltered one is genuinely everything rather than the first
 * page of a paginated view.
 *
 * This is now the *only* export control on the page. The Attendance Report
 * carried its own Excel / CSV / PDF / Print row further down the screen, which
 * meant two export controls with no way to tell which one honoured the filter
 * above them — and until recently only one of them did. The formats that row
 * offered are in this menu instead.
 */

const SCOPED = "scoped";
const ALL = "all";

/** attendance-summary.php clamps to 200, and grades.php pages as well. */
const PAGE_SIZE = 200;
const MAX_PAGES = 50;

/** Where the row count lives when a source does not say otherwise. */
const defaultTotalFrom = (payload) => payload?.pagination?.total;

/**
 * Every row the endpoint has for this scope, not the first page of them.
 *
 * attendance-summary.php and grades.php default to 20 rows a page, so a
 * single unpaged request produced a 20-row "Everything in this report" file —
 * an export that is wrong in the one direction nobody notices, because it
 * opens fine and the rows in it are real. finance-summary.php answers in one
 * shot and reports no pagination block, which ends the loop on the first pass.
 *
 * The page/limit parameter names and the total's location are read off the
 * source, because they are not the same everywhere: survey-summary.php pages
 * with `page_size` and reports `data.answers_total`. Reading them from the
 * source keeps one loop rather than one per endpoint — and, more usefully, means
 * a new report declares its shape in exportSources.js where its columns already
 * live, instead of adding a branch here.
 */
async function fetchAllRows(source, query) {
  const rows = [];
  const pageParam = source.pageParam || "page";
  const limitParam = source.limitParam || "limit";
  const totalFrom = source.totalFrom || defaultTotalFrom;
  // Kept because a pivoted export needs more than the rows: the survey matrix
  // builds its columns from the question list and the applied filters, which
  // ride alongside the answers in every page of the envelope.
  let firstPayload = null;
  let page = 1;

  while (page <= MAX_PAGES) {
    const params = new URLSearchParams(query);
    params.set(pageParam, String(page));
    params.set(limitParam, String(PAGE_SIZE));

    const res = await fetch(getBackendUrl(`${source.endpoint}?${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(payload?.message || `Failed to load ${source.label.toLowerCase()}`);
    if (firstPayload === null) firstPayload = payload;

    const batch = source.rowsFrom(payload);
    rows.push(...batch);

    const total = Number(totalFrom(payload));
    if (!Number.isFinite(total) || rows.length >= total || batch.length === 0) break;
    page += 1;
  }

  return { rows, firstPayload };
}

/** Excel is built here from the JSON; the rest are whatever the endpoint renders. */
const FORMAT_LABELS = {
  excel: { label: "Excel", hint: ".xls" },
  csv: { label: "CSV", hint: ".csv" },
  pdf: { label: "PDF", hint: ".pdf" },
};

/**
 * `filters` carries the on-screen filters of a report the student scope cannot
 * narrow — the survey report's survey / question / search boxes, for instance.
 * They are always applied: unlike the scope, they are not a choice the export
 * offers, they are what the reader is currently looking at.
 */
export default function ReportExport({ sourceKey, scope, scopeLabel, filters = null, filterLabel = "" }) {
  const source = EXPORT_SOURCES[sourceKey];
  const [target, setTarget] = useState(SCOPED);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // Nothing to offer for a report with no export source wired up.
  if (!source) return null;

  // A source that opts out of scoping never shows the target chooser: offering
  // "This selection" for a filter that cannot narrow the report would promise
  // something the export does not do.
  const scopable = source.scoped !== false;
  const hasScope = scopable && Boolean(scope?.departmentId || scope?.courseId || scope?.yearLevel);
  // With no filter set the two targets mean the same thing, so only one is
  // offered rather than asking a question with one answer.
  const effectiveTarget = hasScope ? target : ALL;

  const serverFormats = source.serverFormats || [];
  /*
   * PDF for every report, rendered wherever it can be.
   *
   * Attendance renders its own through `?format=pdf`, and keeps doing so — that
   * endpoint has produced this file for years and there is no reason to take it
   * off it. The other reports have no server-side renderer, so theirs is built
   * in the browser from the same column list the Excel path uses, which is also
   * how the Students, Grades, Finance and Audit tables do it.
   */
  const buildsPdfHere = !serverFormats.includes("pdf");

  const options = [
    { key: "excel", ...FORMAT_LABELS.excel },
    ...serverFormats.map((format) => ({ key: format, ...FORMAT_LABELS[format] })),
    ...(buildsPdfHere ? [{ key: "pdf", ...FORMAT_LABELS.pdf }] : []),
    // Not a file, but it is what someone reaches for in the same moment and it
    // was sitting in the row this menu replaced.
    { key: "print", label: "Print", hint: "this page" },
  ];

  /** The scope, the report's own filters, or both — whichever apply. */
  const scopeQuery = () => {
    const params =
      effectiveTarget === SCOPED && scopable ? scopeToParams(scope) : new URLSearchParams();

    /*
     * Parameters the source always sends, whatever the reader has chosen.
     *
     * Not a filter and not offered as one: the student export sets
     * include_archived because the report it belongs to counts archived
     * students in its own totals, and a file that quietly disagreed with the
     * chart above it would look like a bug in one of the two. Applied before
     * the on-screen filters so a real filter can still override it.
     */
    Object.entries(source.fixedParams || {}).forEach(([key, value]) => {
      params.set(key, String(value));
    });

    Object.entries(filters || {}).forEach(([key, value]) => {
      // Empty means "no filter" on every one of these endpoints, and sending
      // `survey_id=` would be read as an id of zero and match nothing.
      const text = String(value ?? "").trim();
      if (text !== "") params.set(key, text);
    });

    return params.toString();
  };

  /** What the filename should say this file contains. */
  const exportLabel = effectiveTarget === SCOPED && scopable ? scopeLabel : filterLabel;

  /**
   * Every row for this scope, or null when there are none — in which case the
   * message is already on screen.
   *
   * Better than handing over a file with only headers and letting someone wonder
   * whether the export broke or the filter simply matched nobody. Shared by the
   * two formats built here so they cannot disagree about what "empty" means.
   */
  const collectRows = async () => {
    const { rows: rawRows, firstPayload } = await fetchAllRows(source, scopeQuery());
    /*
     * A last pass over the rows, for the columns an endpoint does not store.
     *
     * The student export's Status is "Active" or "Archived", derived from an
     * `archived_at` that is either a timestamp or NULL — a column of blanks
     * and datetimes is not a status anyone can sort or filter in a
     * spreadsheet. Done here rather than in the source's columns because
     * `columns` names keys, it does not compute them.
     */
    const rows = typeof source.toRows === "function" ? source.toRows(rawRows) : rawRows;
    if (rows.length === 0) {
      const narrowed = (effectiveTarget === SCOPED && scopable) || Boolean(exportLabel);
      setError(
        narrowed
          ? "No records match the current filter, so there is nothing to export."
          : "This report has no records to export."
      );
      return null;
    }
    return { rows, firstPayload };
  };

  /**
   * The workbook is assembled in the browser from the curated column list, so
   * this path can say "nothing matched" before writing anything.
   */
  const runExcelExport = async () => {
    setBusy("excel");
    setError("");
    try {
      const collected = await collectRows();
      if (!collected) return;
      const { rows, firstPayload } = collected;

      const filename = buildExportName([sourceKey], exportLabel);

      // A source that pivots says so by declaring toSheets, and gets a workbook
      // of however many sheets that produces. Everything else is one flat sheet
      // of the columns it declared, exactly as before.
      if (typeof source.toSheets === "function") {
        const sheets = source.toSheets(rows, firstPayload);
        if (sheets.length === 0) {
          setError("No records match the current filter, so there is nothing to export.");
          return;
        }
        downloadExcelWorkbook(filename, sheets);
        return;
      }

      downloadExcelFile(filename, source.sheet, source.columns, rows);
    } catch (exportError) {
      setError(exportError?.message || "Export failed.");
    } finally {
      setBusy("");
    }
  };

  /**
   * The same rows as a printout.
   *
   * The source's flat `columns`, even where it declares toSheets. A workbook can
   * hold a sheet per survey; a PDF cannot, and the survey matrix is the wrong
   * shape for a page anyway — its headers are whole questions, and ten of those
   * across a landscape page truncate to nothing useful. The flat columns are
   * declared and accurate for exactly this, which is what the note beside them
   * in exportSources.js anticipated.
   *
   * A source may name `pdfColumns` to print fewer of them, which the student
   * report does because it carries every field a student record has.
   */
  const runPdfExport = async () => {
    setBusy("pdf");
    setError("");
    try {
      const collected = await collectRows();
      if (!collected) return;
      const { rows } = collected;

      const scopeNote = exportLabel || (scopable ? "Everything in this report" : "");
      downloadPdfFile(buildExportName([sourceKey], exportLabel), {
        title: `${source.label} Report`,
        subtitle: [scopeNote, `${rows.length.toLocaleString("en-US")} records`, `exported ${exportDateStamp()}`]
          .filter(Boolean)
          .join(" · "),
        columns: source.pdfColumns || source.columns,
        rows,
      });
    } catch (exportError) {
      setError(exportError?.message || "Export failed.");
    } finally {
      setBusy("");
    }
  };

  /**
   * CSV and PDF are rendered by the endpoint, so this asks for the file rather
   * than building it — with the same scope the Excel path would have used, or
   * the export would quietly be wider than the selection above it says.
   *
   * Fetched rather than opened in a new tab. A navigation carries cookies only,
   * so once the API authenticates with a bearer token it would arrive
   * unauthenticated and show the user a tab full of 401 JSON with nothing on
   * this screen to explain it. Going through fetch also means a failure lands in
   * the same error line as the Excel path instead of somewhere else entirely.
   */
  const runServerExport = async (format) => {
    setBusy(format);
    setError("");
    try {
      const params = new URLSearchParams(scopeQuery());
      params.set("format", format);
      await downloadFromApi(`${source.endpoint}?${params.toString()}`, {
        fallbackName: `${buildExportName([sourceKey], exportLabel)}.${format}`,
        errorMessage: `Failed to export ${source.label.toLowerCase()}.`,
      });
    } catch (exportError) {
      setError(exportError?.message || "Export failed.");
    } finally {
      setBusy("");
    }
  };

  const handleSelect = (key) => {
    if (key === "print") {
      window.print();
      return;
    }
    if (key === "excel") {
      void runExcelExport();
      return;
    }
    if (key === "pdf" && buildsPdfHere) {
      void runPdfExport();
      return;
    }
    void runServerExport(key);
  };

  return (
    <div style={{ display: "grid", gap: 4, justifyItems: "end" }}>
      <div style={{ display: "flex", alignItems: "flex-end", gap: 7, flexWrap: "wrap" }}>
        {/* An unscoped report has no target to choose between, so it says what
            the file will hold instead of offering a dropdown with one option —
            and, more importantly, instead of a disabled control telling the
            reader to pick a department this report does not have. */}
        {!scopable ? (
          <div style={{ display: "grid", gap: 3, minWidth: 0, textAlign: "right" }}>
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
                color: "var(--text-muted)",
              }}
            >
              Export {source.label.toLowerCase()}
            </span>
            <span style={{ fontSize: 11.5, color: "var(--text-primary)" }}>
              {filterLabel ? `Matching ${filterLabel}` : "Every answer in this report"}
            </span>
          </div>
        ) : (
        <label htmlFor="report_export_target" style={{ display: "grid", gap: 3, minWidth: 0 }}>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              letterSpacing: "0.04em",
              textTransform: "uppercase",
              color: "var(--text-muted)",
            }}
          >
            Export {source.label.toLowerCase()}
          </span>
          <select
            id="report_export_target"
            name="report_export_target"
            value={effectiveTarget}
            onChange={(event) => {
              setError("");
              setTarget(event.target.value);
            }}
            disabled={!hasScope}
            title={hasScope ? undefined : "Choose a department, course or year to narrow the export"}
            style={{
              minWidth: 187,
              padding: "5px 8px",
              border: "1px solid var(--border-strong)",
              borderRadius: 6,
              fontSize: 11.5,
              background: hasScope ? "var(--surface-base)" : "var(--surface-muted, #f1f5f9)",
              cursor: hasScope ? "pointer" : "not-allowed",
              color: "var(--text-primary)",
            }}
          >
            {hasScope ? <option value={SCOPED}>This selection — {scopeLabel}</option> : null}
            <option value={ALL}>Everything in this report</option>
          </select>
        </label>
        )}

        <ExportMenu options={options} busyKey={busy} busyLabel="Preparing..." onSelect={handleSelect} />
      </div>

      {error ? (
        <span role="alert" style={{ fontSize: 10.5, color: "var(--danger-700, #b91c1c)", maxWidth: 320, textAlign: "right" }}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
