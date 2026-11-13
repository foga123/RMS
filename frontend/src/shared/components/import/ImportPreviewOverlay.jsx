import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Button from "../ui/Button";
import { PREVIEW_FILTERS, emptyPreviewMessage, filterPreviewRows, previewCounts } from "./previewFilter";

/**
 * The file, full size, before it is written.
 *
 * The review inside the import dialog is a verdict: how many rows will land,
 * which will not, and why. It is deliberately small, because the dialog is
 * 561px wide and a table in it can show six columns of truncated text and
 * nothing more. That is enough to catch a wrong file and not enough to check
 * one.
 *
 * This is where the checking happens. Every row, searchable, filterable to just
 * the problems, with the reason spelled out beside the row it belongs to — and
 * the Import button in the footer, so a reader who has just satisfied
 * themselves does not have to go back and find it.
 *
 * A floating card rather than a route: the import is a task in progress, the
 * chosen file lives in the dialog's state, and navigating away from it to look
 * at it would mean either losing the file or teaching the router about a
 * half-finished upload.
 */

const OVERLAY_Z = 1100;

function StatusPill({ status }) {
  const tone =
    status === "skip"
      ? { background: "var(--warning-100)", color: "var(--warning-800)", border: "var(--warning-200)", label: "Skip" }
      : status === "update"
        ? { background: "var(--brand-100)", color: "var(--brand-800)", border: "var(--brand-200)", label: "Update" }
        : { background: "var(--surface-page)", color: "var(--text-secondary)", border: "var(--border-base)", label: "New" };

  return (
    <span
      style={{
        display: "inline-block",
        padding: "1px 6px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
        background: tone.background,
        color: tone.color,
        border: `1px solid ${tone.border}`,
      }}
    >
      {tone.label}
    </span>
  );
}

function FilterTab({ active, label, count, onClick }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      style={{
        padding: "4px 10px",
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 600,
        cursor: "pointer",
        border: `1px solid ${active ? "var(--brand-600)" : "var(--border-base)"}`,
        background: active ? "var(--brand-100)" : "var(--surface-base)",
        color: active ? "var(--brand-800)" : "var(--text-secondary)",
      }}
    >
      {label}
      <span style={{ marginLeft: 5, opacity: 0.75, fontVariantNumeric: "tabular-nums" }}>{count.toLocaleString()}</span>
    </button>
  );
}

export default function ImportPreviewOverlay({
  open,
  onClose,
  title = "Review the file",
  fileName = "",
  columns = [],
  rows = [],
  counts = [],
  note = "",
  confirmLabel = "",
  onConfirm,
  busy = false,
  blocked = "",
}) {
  const [status, setStatus] = useState("all");
  const [query, setQuery] = useState("");

  // A reopened preview starts where a reader expects: the whole file, unfiltered.
  useEffect(() => {
    if (open) {
      setStatus("all");
      setQuery("");
    }
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape" && !busy) onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose, open]);

  const bucketCounts = useMemo(() => previewCounts(rows), [rows]);
  const visibleRows = useMemo(() => filterPreviewRows(rows, { status, query }), [rows, status, query]);
  const showReason = status !== "keep" && bucketCounts.skip > 0;

  const headerCell = {
    position: "sticky",
    top: 0,
    zIndex: 1,
    background: "var(--surface-page)",
    borderBottom: "1px solid var(--border-base)",
    padding: "6px 9px",
    textAlign: "left",
    fontSize: 10.5,
    fontWeight: 700,
    letterSpacing: 0.3,
    textTransform: "uppercase",
    color: "var(--text-faint)",
    whiteSpace: "nowrap",
  };
  const bodyCell = {
    borderBottom: "1px solid var(--border-base)",
    padding: "5px 9px",
    color: "var(--text-secondary)",
    verticalAlign: "top",
  };

  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          aria-label={title}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.55)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 12,
            zIndex: OVERLAY_Z,
          }}
          onClick={busy ? undefined : onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <motion.div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: 1120,
              height: "min(88dvh, 900px)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              background: "var(--surface-base)",
              border: "1px solid var(--border-base)",
              borderRadius: 11,
              boxShadow: "0 28px 70px rgba(2,6,23,0.3)",
            }}
            initial={{ opacity: 0, scale: 0.97, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.16, ease: "easeOut" }}
          >
            {/* ---- header ---- */}
            <div
              style={{
                flexShrink: 0,
                padding: "11px 13px",
                borderBottom: "1px solid var(--border-base)",
                display: "flex",
                alignItems: "center",
                gap: 9,
                flexWrap: "wrap",
              }}
            >
              <div style={{ minWidth: 0 }}>
                <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>{title}</strong>
                {fileName ? (
                  <div
                    style={{
                      fontSize: 10.5,
                      color: "var(--text-faint)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                    title={fileName}
                  >
                    {fileName}
                  </div>
                ) : null}
              </div>

              {counts.length > 0 ? (
                <div style={{ display: "flex", gap: 13, marginLeft: "auto", flexWrap: "wrap" }}>
                  {counts.map((tile) => (
                    <div key={tile.label} style={{ textAlign: "right" }}>
                      <div
                        style={{
                          fontSize: 16,
                          fontWeight: 700,
                          lineHeight: 1.15,
                          color:
                            tile.tone === "good"
                              ? "var(--brand-700)"
                              : tile.tone === "warn"
                                ? "var(--warning-800)"
                                : tile.tone === "bad"
                                  ? "var(--danger-800)"
                                  : "var(--text-primary)",
                        }}
                      >
                        {tile.value}
                      </div>
                      <div style={{ fontSize: 10.5, color: "var(--text-faint)" }}>{tile.label}</div>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>

            {/* ---- filters and search ---- */}
            <div
              style={{
                flexShrink: 0,
                padding: "8px 13px",
                borderBottom: "1px solid var(--border-base)",
                display: "flex",
                alignItems: "center",
                gap: 7,
                flexWrap: "wrap",
              }}
            >
              {PREVIEW_FILTERS.map((filter) => (
                <FilterTab
                  key={filter.key}
                  active={status === filter.key}
                  label={filter.label}
                  count={bucketCounts[filter.key === "all" ? "all" : filter.key]}
                  onClick={() => setStatus(filter.key)}
                />
              ))}
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a student number, name or line"
                aria-label="Search the rows in this file"
                name="import_preview_search"
                style={{
                  marginLeft: "auto",
                  flex: "0 1 268px",
                  minWidth: 158,
                  padding: "5px 9px",
                  fontSize: 11.5,
                  borderRadius: 6,
                  border: "1px solid var(--border-base)",
                  background: "var(--surface-base)",
                  color: "var(--text-primary)",
                }}
              />
            </div>

            {/* ---- the rows ---- */}
            <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
              {visibleRows.length === 0 ? (
                <div style={{ padding: 22, textAlign: "center", color: "var(--text-faint)", fontSize: 12.5 }}>
                  {emptyPreviewMessage({ status, query, counts: bucketCounts })}
                </div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                  <thead>
                    <tr>
                      <th style={{ ...headerCell, width: 46 }}>Line</th>
                      <th style={{ ...headerCell, width: 62 }}>Status</th>
                      {columns.map((column) => (
                        <th key={column.key} style={headerCell}>
                          {column.label}
                        </th>
                      ))}
                      {showReason ? <th style={headerCell}>Why it is skipped</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => (
                      <tr
                        key={row.lineNumber}
                        style={{ background: row.status === "skip" ? "var(--warning-50)" : undefined }}
                      >
                        <td style={{ ...bodyCell, color: "var(--text-faint)", fontVariantNumeric: "tabular-nums" }}>
                          {row.lineNumber}
                        </td>
                        <td style={bodyCell}>
                          <StatusPill status={row.status} />
                        </td>
                        {columns.map((column) => (
                          <td key={column.key} style={bodyCell}>
                            {/* An em dash, not an empty cell: blank here means
                                the file left it blank, which is worth seeing. */}
                            {row.cells?.[column.key] || "—"}
                          </td>
                        ))}
                        {showReason ? (
                          <td style={{ ...bodyCell, color: "var(--warning-800)" }}>{row.reason || ""}</td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* ---- act on it from here ---- */}
            <div
              style={{
                flexShrink: 0,
                padding: "10px 13px",
                borderTop: "1px solid var(--border-base)",
                display: "flex",
                alignItems: "center",
                gap: 9,
                flexWrap: "wrap",
              }}
            >
              <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>
                {blocked
                  ? blocked
                  : visibleRows.length === bucketCounts.all
                    ? `${bucketCounts.all.toLocaleString()} ${bucketCounts.all === 1 ? "row" : "rows"} · nothing has been written yet`
                    : `Showing ${visibleRows.length.toLocaleString()} of ${bucketCounts.all.toLocaleString()} rows · nothing has been written yet`}
              </span>
              <div style={{ display: "flex", gap: 6, marginLeft: "auto" }}>
                <Button variant="secondary" onClick={onClose} disabled={busy}>
                  Back
                </Button>
                {onConfirm ? (
                  <Button onClick={onConfirm} disabled={busy || Boolean(blocked)}>
                    {busy ? "Uploading…" : confirmLabel || "Import"}
                  </Button>
                ) : null}
              </div>
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
