import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "../Modal";
/*
 * Button directly, not through the `../ui` barrel.
 *
 * The barrel re-exports Breadcrumb, which imports react-router-dom v7 — ESM
 * only, and unresolvable by CRA's Jest (the same trap noted in
 * features/reports/exportSources.js). Pulling one button through it made this
 * whole dialog untestable for a router nothing here uses.
 */
import Button from "../ui/Button";
import ImportPreviewOverlay from "./ImportPreviewOverlay";
import { downloadCsvTemplate } from "../../lib/csvTemplate";
import { downloadExcelTemplate, parseSpreadsheetRows } from "../../lib/spreadsheet";

/**
 * One import dialog for every bulk upload in the app.
 *
 * The three importers (attendance, grades, students) had grown three different
 * designs: attendance opened a modal with a template link buried under the file
 * input, grades repeated the same markup with different spacing, and students
 * had no dialog at all — it opened a bare OS file picker, so the only way to
 * discover the required columns was to upload something wrong and read the
 * error. Nothing told you the format up front.
 *
 * It offers a template pre-filled with a valid example row before asking for a
 * file. The column names are in the template rather than listed here: a list of
 * twenty names the reader had to check against their sheet was more to take in
 * than it helped, and a wrong column is named by the importer anyway. The steps
 * are numbered because the order genuinely matters — pick the term before
 * uploading, or the rows land in the wrong semester.
 *
 * Everything file-related lives here (drag and drop, size formatting, clearing,
 * submit state, the result summary). A caller supplies the column contract, any
 * extra fields, and a submit handler.
 */

const ACCEPT = ".csv,.xls,.xml,text/csv,application/vnd.ms-excel,application/xml,text/xml";

/*
 * How much of a big file the inline review puts on screen.
 *
 * Not much, on purpose. The dialog is 561px wide, which fits six columns of
 * truncated text; a table there can show that the file was READ correctly and
 * cannot be used to check it. So the inline part is the verdict — the counts,
 * the rows that will not land, and three rows as a sample — and "Review all N
 * rows" opens the whole file full size, where it can be searched and filtered.
 *
 * The counts always cover every row. These only cap what is drawn.
 */
const MAX_PREVIEW_ROWS = 3;
const MAX_LISTED_PROBLEMS = 12;

function UploadIcon({ size = 22 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M17 8l-5-5-5 5" />
      <path d="M12 3v12" />
    </svg>
  );
}

function SheetIcon({ size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
      <path d="M8 13h8M8 17h8" />
    </svg>
  );
}

function DownloadIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <path d="M7 10l5 5 5-5" />
      <path d="M12 15V3" />
    </svg>
  );
}

function ExpandIcon({ size = 14 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
    </svg>
  );
}

function WarningIcon({ size = 15 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      <path d="M12 9v4M12 17h.01" />
    </svg>
  );
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function StepHeading({ index, title, hint }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 6 }}>
      <span
        style={{
          flexShrink: 0,
          display: "grid",
          placeItems: "center",
          width: 17,
          height: 17,
          borderRadius: 999,
          background: "var(--brand-100)",
          color: "var(--brand-800)",
          fontSize: 10.5,
          fontWeight: 700,
        }}
      >
        {index}
      </span>
      <span style={{ color: "var(--text-primary)", fontWeight: 600, fontSize: 12.5 }}>{title}</span>
      {hint ? <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>{hint}</span> : null}
    </div>
  );
}

const cardStyle = {
  border: "1px solid var(--border-base)",
  borderRadius: 8,
  background: "var(--surface-page)",
  padding: 9,
};

const selectStyle = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid var(--border-base)",
  borderRadius: 6,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  fontSize: 12.5,
};

export default function ImportDialog({
  open,
  onClose,
  title = "Import",
  /** One-line statement of what an upload does. Keep it about consequences. */
  description = "",
  /** [{ name, required, example, hint }] — the template's columns and example row. */
  columns = [],
  templateFileName = "import-template.csv",
  /**
   * [{ key, label, options: [{ value, label }], required }] shown as step 2.
   *
   * A field with `readOnly: true` is shown as its value rather than as a
   * dropdown - the school year, which follows the academic calendar. `display`
   * is what to show (else the matching option's label, else the raw value),
   * `hint` says where it comes from, and `missingMessage` is why Upload is off
   * when it has no value, since there is nothing here the reader could pick.
   */
  fields = [],
  /**
   * Optional line under the fields saying where their values came from.
   *
   * The three import screens fill this step in from the academic calendar. A
   * pre-filled dropdown with no explanation is indistinguishable from one the
   * reader filled in themselves last time, so this says which term was chosen
   * and why — otherwise the first thing anyone does is re-pick all three to be
   * sure.
   */
  fieldsNote = "",
  /**
   * Set when the term chosen above is a closed semester (see closedTermNotice()
   * in shared/lib/currentTerm.js). Shown under the pickers, and Upload stays off:
   * the server would refuse the file whatever it held, and saying so after the
   * reader has picked and previewed a sheet wastes the part that took effort.
   */
  closedNotice = "",
  values = {},
  onFieldChange,
  /** async (file, values) => resultPayload. Throw to surface an error. */
  onSubmit,
  /**
   * Optional look-before-you-write check, run on the first Upload click.
   *
   * `async (file, values) => null | { headline, lines: [], confirmLabel }`.
   * Return null when the upload adds only new records; return the object to
   * make the reader confirm. Advice, not a gate — a check that throws warns
   * that it could not run and still offers to continue.
   *
   * A third argument carries what this dialog already parsed out of the file
   * (`{ rows, count }`), so a caller that needs the rows does not read and parse
   * the same file twice.
   */
  precheck,
  /**
   * Optional read-only verdict on the chosen file, shown before Upload.
   *
   * `(rows, values) => null | { counts, columns, rows, note, confirmLabel, blocked }`
   * where each row is `{ lineNumber, status: "create" | "update" | "skip",
   * reason, cells }`. Must be pure and synchronous — it runs on every keystroke
   * of the term picker, and a preview that wrote anything would make looking at
   * a file a side effect.
   *
   * `blocked` refuses the upload outright: an importer that can say up front
   * that no row would land should say so rather than let someone press Import
   * and watch nothing happen.
   */
  preview,
  /**
   * The importer's row ceiling, if it has one. Over it, Upload is refused with
   * the file's own count rather than the server's after-the-fact complaint.
   */
  maxRows,
  /**
   * Optional `(count) => string`: a note about what uploading this many rows
   * will do. Student Management uses it to say how many batches that is.
   */
  rowNotice,
  /**
   * `{ sent, total }` while a chunked upload is running, or null.
   *
   * A file sent in batches is several seconds of silence, and silence during a
   * write reads as a hang — which is when somebody closes the tab halfway
   * through and leaves the import half applied.
   */
  progress,
  /** (result) => [{ label, value, tone }] rendered as tiles after a run. */
  summarize,
  /**
   * (result) => [{ label, items, error }] rendered under the tiles. A group
   * marked `error` holds rows that were refused: it starts open and turns the
   * headline red, so a partly refused file does not read as a clean import.
   */
  detail,
  submitLabel = "Upload",
}) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  /*
   * What the precheck found, and the reason the Upload button turns into a
   * confirmation. Cleared whenever the file or the term changes, because a
   * warning about last selection's overlap is worse than no warning at all —
   * it reads as approved when it describes a different upload.
   */
  const [warning, setWarning] = useState(null);
  /*
   * What is actually in the chosen file, read as soon as it is chosen.
   *
   * `{ status, rows, count, error }`. Until now the dialog said only a name and
   * a size, and a size answers nothing anyone wants to know: 84 KB could be
   * twelve students or twelve hundred. People uploaded a file and found out how
   * much they had just written from the summary afterwards — which for the sheet
   * importers is after it has already overwritten a term.
   *
   * The parsed rows are kept, not just the count, so `precheck` can be handed
   * them instead of reading and parsing the same file a second time.
   */
  const [contents, setContents] = useState({ status: "idle", rows: null, count: 0, error: "" });
  /*
   * The full-size review, over the top of this dialog.
   *
   * Kept here rather than inside the overlay so that submitting from it lands
   * back in the dialog: the result summary, the per-row errors and the Done
   * button all live here, and an overlay that stayed open over its own outcome
   * would hide the only report of what happened.
   */
  const [previewOpen, setPreviewOpen] = useState(false);

  // A reopened dialog must not show the previous run's outcome.
  useEffect(() => {
    if (open) {
      setFile(null);
      setDragging(false);
      setBusy(false);
      setChecking(false);
      setError("");
      setResult(null);
      setWarning(null);
      setPreviewOpen(false);
      setContents({ status: "idle", rows: null, count: 0, error: "" });
    }
  }, [open]);

  // A preview of a file that is no longer chosen would be a preview of nothing.
  useEffect(() => {
    if (contents.status !== "ready") setPreviewOpen(false);
  }, [contents.status]);

  // Stringified so a caller re-creating the same object each render does not
  // clear the confirmation the reader is currently looking at.
  const valuesKey = JSON.stringify(values ?? {});
  useEffect(() => {
    setWarning(null);
  }, [valuesKey]);

  // Round-tripped through the key so the preview below re-runs when the term
  // actually changes rather than on every render of a caller that rebuilds the
  // object each time. Re-checking a few thousand rows per keystroke is the one
  // way this step could be slower than reading the file.
  const stableValues = useMemo(() => JSON.parse(valuesKey), [valuesKey]);

  /**
   * What the caller says will happen to this file.
   *
   * A failed preview is reported rather than swallowed, and does not block:
   * whatever is wrong with the check, the reader is still entitled to upload,
   * and the importer's own errors are the authoritative ones.
   */
  const previewed = useMemo(() => {
    if (!preview || contents.status !== "ready" || !contents.rows) return null;
    try {
      return preview(contents.rows, stableValues) || null;
    } catch (previewError) {
      return { failed: previewError?.message || "The file could not be checked." };
    }
  }, [contents.rows, contents.status, preview, stableValues]);

  // Split once, together: the review shows what will not land and what will,
  // and two separate memos over the same array would each re-run on a `|| []`
  // that is a new array every render.
  const { skippedRows, keptRows } = useMemo(() => {
    const rows = previewed?.rows || [];
    return {
      skippedRows: rows.filter((row) => row.status === "skip"),
      keptRows: rows.filter((row) => row.status !== "skip"),
    };
  }, [previewed]);

  const overRowLimit = Boolean(maxRows) && contents.status === "ready" && contents.count > maxRows;

  const missingFields = useMemo(
    () => fields.filter((field) => field.required !== false && !values?.[field.key]),
    [fields, values]
  );

  const blockedReason = useMemo(() => {
    // A read-only field cannot be picked here, so say what is missing and who
    // can set it rather than "Select School Year first" with nothing to select.
    const missingFixed = missingFields.find((field) => field.readOnly);
    if (missingFixed) return missingFixed.missingMessage || `${missingFixed.label} is not set.`;
    if (missingFields.length > 0) {
      return `Select ${missingFields.map((field) => field.label).join(" and ")} first.`;
    }
    // Ahead of the file: a closed semester refuses whatever the file holds, so
    // there is no point in choosing one for it. The full sentence is under the
    // pickers; this line only has to say why the button is off.
    if (closedNotice) return "That semester is closed. Choose an open one.";
    if (!file) return "Choose a file to upload.";
    // Reading is fast, but a 5 MB sheet is not instant, and letting Upload be
    // pressed mid-read would send a file whose size nothing has checked.
    if (contents.status === "reading") return "Reading the file…";
    /*
     * A file over the importer's ceiling is refused here rather than sent.
     * The server rejects it too — but only after the whole upload has crossed
     * the wire, and its message names a limit the reader has no way to compare
     * against, because nothing on screen had said how many rows they had.
     */
    if (maxRows && contents.status === "ready" && contents.count > maxRows) {
      return `This file has ${contents.count.toLocaleString()} rows. The most that can be uploaded at once is ${maxRows.toLocaleString()} — split it and upload the parts.`;
    }
    if (contents.status === "ready" && contents.count === 0) {
      return "This file has no data rows. It needs a header row and at least one row under it.";
    }
    // Last, so a file that is unreadable or oversized is described as that
    // rather than as "nothing would be imported" — which would be true of it,
    // and useless.
    if (previewed?.blocked) return previewed.blocked;
    return "";
  }, [closedNotice, contents, file, maxRows, missingFields, previewed]);

  const handleTemplate = useCallback(() => {
    downloadCsvTemplate(
      templateFileName,
      columns.map((column) => column.name),
      [columns.map((column) => column.example ?? "")]
    );
  }, [columns, templateFileName]);

  /**
   * The same columns as the CSV, as a formatted worksheet: columns sized to
   * their contents, a coloured header that stays put when scrolling, and the
   * example row in gray italic so it reads as a hint to overwrite.
   *
   * CSV stays on offer beside it. It carries no formatting at all — that is
   * why this exists — but it is the more forgiving import format and some
   * people build their sheet in Google Sheets.
   */
  const handleExcelTemplate = useCallback(() => {
    downloadExcelTemplate(
      String(templateFileName).replace(/\.csv$/i, ""),
      columns.map((column) => column.name),
      columns.map((column) => column.example ?? "")
    );
  }, [columns, templateFileName]);

  const acceptFile = useCallback((nextFile) => {
    if (!nextFile) return;
    setFile(nextFile);
    setError("");
    setResult(null);
    setWarning(null);
    setContents({ status: "reading", rows: null, count: 0, error: "" });
  }, []);

  /*
   * Counting happens in an effect keyed on the file rather than inside
   * acceptFile, so a file swapped while the previous one is still being read
   * cannot have the older result land on top of the newer one. `cancelled`
   * closes that race: a stale read finishes into nothing.
   *
   * A file that will not parse is NOT treated as an error here. The row count is
   * a convenience; the authoritative complaint comes from the importer, which
   * can say which line and why. Refusing to proceed on a parse this component
   * did only as an aside would block uploads the server would have accepted —
   * the .xls reader here is stricter than some of the backends'.
   */
  useEffect(() => {
    if (!file) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const rows = parseSpreadsheetRows(await file.text(), file.name);
        if (!cancelled) {
          setContents({ status: "ready", rows, count: rows.length, error: "" });
        }
      } catch (readError) {
        if (!cancelled) {
          setContents({
            status: "unreadable",
            rows: null,
            count: 0,
            error: readError?.message || "This file could not be read.",
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [file]);

  const handleDrop = useCallback(
    (event) => {
      event.preventDefault();
      setDragging(false);
      acceptFile(event.dataTransfer?.files?.[0] || null);
    },
    [acceptFile]
  );

  async function handleSubmit() {
    if (blockedReason) {
      setError(blockedReason);
      return;
    }

    // Submitting from the full-size review hands the reader back to the dialog,
    // which is where the outcome is reported.
    setPreviewOpen(false);

    /*
     * An import is not undoable from this dialog: the sheet importers upsert, so
     * a file uploaded against the wrong term silently overwrites a term's worth
     * of real records and the only sign is a count in the summary afterwards.
     * The check runs once, on the first click; the second click is the consent.
     */
    if (precheck && !warning) {
      setChecking(true);
      setError("");
      try {
        // The parsed rows go with it: this dialog has already read the file to
        // count them, and a caller that needs them should not read it again.
        const found = await precheck(file, values, { rows: contents.rows, count: contents.count });
        if (found && (found.lines || []).length > 0) {
          setWarning(found);
          return;
        }
      } catch (checkError) {
        // The check is advice. A failed one must not stand between someone and
        // an upload they are entitled to make — but it must not pass silently
        // either, or a broken check reads as "nothing will be overwritten".
        setWarning({
          headline: "Could not check what is already recorded.",
          lines: [checkError?.message || "The check did not complete."],
          confirmLabel: "Upload anyway",
        });
        return;
      } finally {
        setChecking(false);
      }
    }

    setBusy(true);
    setError("");
    setResult(null);
    try {
      const payload = await onSubmit(file, values);
      setResult(payload ?? {});
    } catch (submitError) {
      setError(submitError?.message || "The import failed.");
    } finally {
      setBusy(false);
      setWarning(null);
    }
  }

  const tiles = result && summarize ? summarize(result) : [];
  const detailGroups = (result && detail ? detail(result) : []).filter((group) => (group?.items || []).length > 0);
  const hasRefusedRows = detailGroups.some((group) => group.error);
  const stepOffset = fields.length > 0 ? 1 : 0;

  return (
    <>
    <Modal open={open} title={title} onClose={busy ? () => {} : onClose} width={561}>
      <div style={{ display: "grid", gap: 14 }}>
        {description ? (
          <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 11.5, lineHeight: 1.5 }}>{description}</p>
        ) : null}

        {error ? (
          <div
            role="alert"
            style={{
              background: "var(--danger-100)",
              color: "var(--danger-800)",
              border: "1px solid var(--danger-200)",
              borderRadius: 6,
              padding: "8px 9px",
              fontSize: 11.5,
            }}
          >
            {error}
          </div>
        ) : null}

        {/* ---- Step 1: the column contract, stated before a file is asked for ---- */}
        <section>
          <StepHeading index={1} title="Start from the template" hint="recommended" />
          <div style={{ ...cardStyle, display: "grid", gap: 8 }}>
            <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text-secondary)", fontSize: 11.5 }}>
                <SheetIcon />
                <span>Correct headers, with one example row filled in.</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button variant="secondary" size="sm" onClick={handleExcelTemplate}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <DownloadIcon />
                    Excel template
                  </span>
                </Button>
                <Button variant="secondary" size="sm" onClick={handleTemplate}>
                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <DownloadIcon />
                    CSV template
                  </span>
                </Button>
              </div>
            </div>

          </div>
        </section>

        {/* ---- Step 2: term (or whatever else the caller needs) ---- */}
        {fields.length > 0 ? (
          <section>
            <StepHeading index={2} title="Choose where the rows belong" />
            <div style={{ display: "grid", gap: 8, gridTemplateColumns: fields.length > 1 ? "1fr 1fr" : "1fr" }}>
              {fields.map((field) =>
                field.readOnly ? (
                  <ReadOnlyField key={field.key} field={field} value={values?.[field.key]} />
                ) : (
                <label key={field.key} style={{ display: "grid", gap: 3 }}>
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{field.label}</span>
                  <select
                    value={values?.[field.key] ?? ""}
                    onChange={(event) => onFieldChange?.(field.key, event.target.value)}
                    style={selectStyle}
                    name={`import_field_${field.key}`}
                    disabled={busy}
                  >
                    <option value="">{field.placeholder || `Select ${field.label.toLowerCase()}`}</option>
                    {(field.options || []).map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
                )
              )}
            </div>
            {fieldsNote ? (
              <p style={{ margin: "6px 0 0", fontSize: 10.5, lineHeight: 1.45, color: "var(--text-muted)" }}>
                {fieldsNote}
              </p>
            ) : null}
            {closedNotice ? (
              <p
                role="alert"
                style={{
                  margin: "6px 0 0",
                  padding: "6px 8px",
                  fontSize: 11.5,
                  lineHeight: 1.45,
                  color: "var(--warning-800, #92400e)",
                  background: "var(--warning-50, #fffbeb)",
                  border: "1px solid var(--warning-200, #fde68a)",
                  borderRadius: 6,
                }}
              >
                {closedNotice}
              </p>
            ) : null}
          </section>
        ) : null}

        {/* ---- Step 3: the file ---- */}
        <section>
          <StepHeading index={2 + stepOffset} title="Upload the file" hint="CSV or Excel .xls" />

          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            onChange={(event) => {
              acceptFile(event.target.files?.[0] || null);
              event.target.value = "";
            }}
            style={{ display: "none" }}
            name="import_dialog_file"
          />

          {file ? (
            <>
              <div style={{ ...cardStyle, display: "flex", alignItems: "center", gap: 9 }}>
                <span
                  style={{
                    display: "grid",
                    placeItems: "center",
                    width: 29,
                    height: 29,
                    flexShrink: 0,
                    borderRadius: 6,
                    background: "var(--brand-100)",
                    color: "var(--brand-800)",
                  }}
                >
                  <SheetIcon size={14} />
                </span>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div
                    style={{
                      color: "var(--text-primary)",
                      fontWeight: 600,
                      fontSize: 11.5,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={file.name}
                  >
                    {file.name}
                  </div>
                  {/* The row count leads and the size follows it, because the
                      count is the number anyone actually wants: it is what will
                      be written, and it is what makes a wrong file obvious
                      before it is sent rather than after. A size answers
                      nothing — 84 KB could be twelve students or twelve
                      hundred. */}
                  <div style={{ color: "var(--text-faint)", fontSize: 10.5, display: "flex", alignItems: "center", gap: 5, flexWrap: "wrap" }}>
                    {contents.status === "reading" ? (
                      <span>counting rows…</span>
                    ) : contents.status === "ready" ? (
                      <strong style={{ color: overRowLimit ? "var(--danger-800)" : "var(--text-secondary)", fontWeight: 700 }}>
                        {contents.count.toLocaleString()} {contents.count === 1 ? "row" : "rows"}
                      </strong>
                    ) : contents.status === "unreadable" ? (
                      <span style={{ color: "var(--warning-800)" }}>row count unavailable</span>
                    ) : null}
                    {contents.status !== "idle" ? <span aria-hidden="true">·</span> : null}
                    <span>{formatBytes(file.size)}</span>
                  </div>
                </div>
                <Button variant="ghost" size="sm" onClick={() => setFile(null)} disabled={busy}>
                  Remove
                </Button>
              </div>

              {/* What uploading this many rows means, when the caller has
                  something to say about it. Sits under the file rather than in
                  the blocked line, because it is not a reason to stop. */}
              {contents.status === "ready" && !overRowLimit && rowNotice?.(contents.count) ? (
                <div
                  style={{
                    marginTop: 6,
                    border: "1px solid var(--border-base)",
                    background: "var(--surface-page)",
                    borderRadius: 6,
                    padding: "6px 9px",
                    color: "var(--text-secondary)",
                    fontSize: 10.5,
                    lineHeight: 1.5,
                  }}
                >
                  {rowNotice(contents.count)}
                </div>
              ) : null}
            </>
          ) : (
            <div
              role="button"
              tabIndex={0}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  inputRef.current?.click();
                }
              }}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              style={{
                display: "grid",
                placeItems: "center",
                gap: 5,
                padding: "17px 12px",
                borderRadius: 8,
                border: `1.5px dashed ${dragging ? "var(--brand-600)" : "var(--border-strong)"}`,
                background: dragging ? "var(--brand-100)" : "var(--surface-page)",
                color: "var(--text-secondary)",
                cursor: "pointer",
                textAlign: "center",
                transition: "background 0.15s ease, border-color 0.15s ease",
              }}
            >
              <span style={{ color: dragging ? "var(--brand-700)" : "var(--text-muted)" }}>
                <UploadIcon />
              </span>
              <span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--text-primary)" }}>
                {dragging ? "Drop the file here" : "Drag a file here, or click to browse"}
              </span>
              <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>Up to 5 MB. Excel .xlsx must be saved as CSV first.</span>
            </div>
          )}
        </section>

        {/* ---- Step 4: what this file will actually do ---- */}
        {previewed && !result ? (
          <section>
            <StepHeading index={3 + stepOffset} title="Review before importing" hint="nothing is written yet" />

            {previewed.failed ? (
              <div style={{ ...cardStyle, color: "var(--warning-800)", fontSize: 11.5, lineHeight: 1.5, display: "grid", gap: 4 }}>
                {/* Two blocks rather than one sentence, because the reason is
                    an error message and may not arrive with punctuation. */}
                <div style={{ fontWeight: 600 }}>This file could not be checked ahead of time.</div>
                <div>{previewed.failed}</div>
                <div style={{ color: "var(--text-secondary)" }}>
                  You can still import it — every row is checked again on the way in, and anything wrong with one is
                  listed afterwards.
                </div>
              </div>
            ) : (
              <div style={{ display: "grid", gap: 8 }}>
                {(previewed.counts || []).length > 0 ? (
                  <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(min(102px, 100%), 1fr))" }}>
                    {previewed.counts.map((tile) => (
                      <ResultTile key={tile.label} {...tile} />
                    ))}
                  </div>
                ) : null}

                {/* The rows that will NOT land, first — they are the reason to
                    look at this step at all, and burying them under a table of
                    the ones that are fine is how they get missed. */}
                {skippedRows.length > 0 ? (
                  <div
                    style={{
                      border: "1px solid var(--warning-200)",
                      background: "var(--warning-50)",
                      borderRadius: 8,
                      padding: 9,
                      display: "grid",
                      gap: 5,
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warning-800)", fontWeight: 700, fontSize: 12.5 }}>
                      <WarningIcon />
                      {skippedRows.length.toLocaleString()} {skippedRows.length === 1 ? "row will be skipped" : "rows will be skipped"}
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18, color: "var(--warning-800)", fontSize: 11, lineHeight: 1.6 }}>
                      {skippedRows.slice(0, MAX_LISTED_PROBLEMS).map((row) => (
                        <li key={row.lineNumber}>
                          <strong style={{ fontWeight: 700 }}>Line {row.lineNumber}</strong>
                          {row.cells?.student_number ? ` · ${row.cells.student_number}` : ""} — {row.reason}
                        </li>
                      ))}
                    </ul>
                    {skippedRows.length > MAX_LISTED_PROBLEMS ? (
                      <div style={{ color: "var(--warning-800)", fontSize: 10.5 }}>
                        …and {(skippedRows.length - MAX_LISTED_PROBLEMS).toLocaleString()} more. Fix the file and choose it
                        again to see the rest.
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {/* A sample, and the door to the rest.
                    Three rows is enough to see that the columns were read the
                    way they were meant — that a course spelled out in full
                    resolved to its code — and it is all this width can show
                    honestly. Checking the file is a different job, and it
                    happens full size. */}
                {keptRows.length > 0 && (previewed.columns || []).length > 0 ? (
                  <PreviewTable columns={previewed.columns} rows={keptRows} />
                ) : null}

                {(previewed.rows || []).length > 0 ? (
                  <Button variant="secondary" size="sm" onClick={() => setPreviewOpen(true)}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                      <ExpandIcon />
                      Review all {previewed.rows.length.toLocaleString()} rows
                    </span>
                  </Button>
                ) : null}

                {previewed.note ? (
                  <div style={{ color: "var(--text-secondary)", fontSize: 10.5, lineHeight: 1.5 }}>{previewed.note}</div>
                ) : null}
              </div>
            )}
          </section>
        ) : null}

        {/* ---- What this upload will overwrite ---- */}
        {warning && !result ? (
          <section
            role="alert"
            style={{
              border: "1px solid var(--warning-200)",
              background: "var(--warning-50)",
              borderRadius: 8,
              padding: 9,
              display: "grid",
              gap: 5,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--warning-800)", fontWeight: 700, fontSize: 12.5 }}>
              <WarningIcon />
              {warning.headline}
            </div>
            <ul style={{ margin: 0, paddingLeft: 18, color: "var(--warning-800)", fontSize: 11.5, lineHeight: 1.6 }}>
              {warning.lines.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div style={{ color: "var(--text-secondary)", fontSize: 10.5 }}>
              Check the term above if this is not what you meant. Nothing has been written yet.
            </div>
          </section>
        ) : null}

        {/* ---- Outcome ---- */}
        {result ? (
          <section>
            <div
              role={hasRefusedRows ? "alert" : undefined}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 6,
                color: hasRefusedRows ? "var(--danger-800)" : "var(--text-primary)",
                fontWeight: 600,
                fontSize: 12.5,
                marginBottom: 6,
              }}
            >
              {hasRefusedRows ? <WarningIcon /> : null}
              <span>{result.message || "Import complete."}</span>
            </div>

            {tiles.length > 0 ? (
              <div style={{ display: "grid", gap: 6, gridTemplateColumns: "repeat(auto-fit, minmax(min(102px, 100%), 1fr))" }}>
                {tiles.map((tile) => (
                  <ResultTile key={tile.label} {...tile} />
                ))}
              </div>
            ) : null}

            {detailGroups.length > 0 ? (
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {detailGroups.map((group) => (
                  <details
                    key={group.label}
                    open={group.error ? true : undefined}
                    style={{
                      ...cardStyle,
                      padding: "6px 9px",
                      fontSize: 11.5,
                      ...(group.error ? { borderColor: "var(--danger-200)", background: "var(--danger-50)" } : null),
                    }}
                  >
                    <summary style={{ cursor: "pointer", color: group.error ? "var(--danger-800)" : "var(--text-secondary)" }}>
                      {group.label} ({group.items.length})
                    </summary>
                    <div style={{ marginTop: 5, color: "var(--text-muted)", fontSize: 10.5, lineHeight: 1.6, wordBreak: "break-word" }}>
                      {group.items.slice(0, 25).join(", ")}
                      {group.items.length > 25 ? ` … and ${group.items.length - 25} more` : ""}
                    </div>
                  </details>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}

        {/* ---- Actions ---- */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 9,
            flexWrap: "wrap",
            borderTop: "1px solid var(--border-base)",
            paddingTop: 11,
          }}
        >
          <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>
            {busy
              ? progress?.total
                ? `Imported ${progress.sent.toLocaleString()} of ${progress.total.toLocaleString()} — do not close this window.`
                : "Working — do not close this window."
              : checking
                ? "Checking what is already recorded…"
                : result
                  ? ""
                  : blockedReason}
          </span>
          <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
            <Button variant="secondary" onClick={onClose} disabled={busy || checking}>
              {result ? "Done" : "Cancel"}
            </Button>
            {result ? null : (
              /* After a warning this is the second, deliberate click, so it is
                 styled as the destructive act it is and says what it will do
                 rather than repeating "Upload". */
              <Button
                onClick={handleSubmit}
                disabled={busy || checking || Boolean(blockedReason)}
                variant={warning ? "danger" : undefined}
              >
                {busy
                  ? "Uploading…"
                  : checking
                    ? "Checking…"
                    : warning
                      ? warning.confirmLabel || "Yes, update the existing records"
                      : /* Once the file has been read, the button says what
                           pressing it does to THIS file — "Import 118 students"
                           rather than "Import students", which is the number
                           someone who has just read the review is checking. */
                        previewed?.confirmLabel || submitLabel}
              </Button>
            )}
          </div>
        </div>
      </div>
    </Modal>

    {/* Above the dialog, not inside it: the dialog body scrolls, and a
        full-size table nested in a scrolling column would scroll twice. */}
    <ImportPreviewOverlay
      open={previewOpen && Boolean(previewed) && !previewed?.failed && !result}
      onClose={() => setPreviewOpen(false)}
      title={title}
      fileName={file?.name || ""}
      columns={previewed?.columns || []}
      rows={previewed?.rows || []}
      counts={previewed?.counts || []}
      note={previewed?.note || ""}
      confirmLabel={previewed?.confirmLabel || submitLabel}
      onConfirm={handleSubmit}
      busy={busy || checking}
      blocked={blockedReason}
    />
    </>
  );
}

/**
 * A step-2 value the reader does not choose, shown as text in the space a
 * dropdown would take, so the row of fields still lines up.
 */
function ReadOnlyField({ field, value }) {
  const option = (field.options || []).find((candidate) => String(candidate.value) === String(value ?? ""));
  const shown = field.display || option?.label || value || "";

  return (
    <div style={{ display: "grid", gap: 3 }}>
      <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
        {field.label}
        {field.hint ? <span style={{ color: "var(--text-faint)" }}> · {field.hint}</span> : null}
      </span>
      <div
        aria-label={field.label}
        data-import-field={field.key}
        style={{
          ...selectStyle,
          background: "var(--surface-page)",
          color: shown ? "var(--text-primary)" : "var(--text-faint)",
          fontWeight: shown ? 600 : 400,
        }}
      >
        {shown || "Not set"}
      </div>
    </div>
  );
}

/**
 * The rows that will land, as they will land.
 *
 * Deliberately shows the RESOLVED values rather than the file's raw text where
 * the two differ: a course written as "Bachelor of Science in Information
 * Technology" appears as BSIT, which is the only way to see from the dialog
 * that the column was understood. The header stays put while the body scrolls,
 * because the whole point is comparing a row against what its column means.
 */
function PreviewTable({ columns, rows }) {
  const shown = rows.slice(0, MAX_PREVIEW_ROWS);
  const headerCell = {
    position: "sticky",
    top: 0,
    background: "var(--surface-page)",
    borderBottom: "1px solid var(--border-base)",
    padding: "5px 7px",
    textAlign: "left",
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: "var(--text-faint)",
    whiteSpace: "nowrap",
  };

  return (
    <div>
      <div
        style={{
          border: "1px solid var(--border-base)",
          borderRadius: 8,
          maxHeight: 208,
          overflow: "auto",
          background: "var(--surface-base)",
        }}
      >
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr>
              <th style={{ ...headerCell, width: 34 }}>Line</th>
              {columns.map((column) => (
                <th key={column.key} style={headerCell}>
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.lineNumber}>
                <td style={{ ...previewCell, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                  {row.lineNumber}
                </td>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    style={previewCell}
                    title={row.cells?.[column.key] ? String(row.cells[column.key]) : ""}
                  >
                    {/* An em dash, not an empty cell: blank here means the file
                        left it blank, which is a fact worth seeing. */}
                    {row.cells?.[column.key] || "—"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > shown.length ? (
        <div style={{ marginTop: 5, color: "var(--text-faint)", fontSize: 10.5 }}>
          Showing the first {shown.length} of {rows.length.toLocaleString()} rows. The counts above cover all of them.
        </div>
      ) : null}
    </div>
  );
}

const previewCell = {
  borderBottom: "1px solid var(--border-base)",
  padding: "4px 7px",
  color: "var(--text-secondary)",
  maxWidth: 132,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

function ResultTile({ label, value, tone = "neutral" }) {
  const palette = {
    good: { background: "var(--brand-100)", color: "var(--brand-800)", border: "var(--brand-200)" },
    warn: { background: "var(--warning-50)", color: "var(--warning-800)", border: "var(--warning-200)" },
    bad: { background: "var(--danger-100)", color: "var(--danger-800)", border: "var(--danger-200)" },
    neutral: { background: "var(--surface-page)", color: "var(--text-primary)", border: "var(--border-base)" },
  }[tone];

  return (
    <div style={{ border: `1px solid ${palette.border}`, background: palette.background, borderRadius: 8, padding: "6px 8px" }}>
      <div style={{ fontSize: 16, fontWeight: 700, color: palette.color, lineHeight: 1.1 }}>{value}</div>
      <div style={{ fontSize: 10.5, color: palette.color, opacity: 0.85, marginTop: 2 }}>{label}</div>
    </div>
  );
}
