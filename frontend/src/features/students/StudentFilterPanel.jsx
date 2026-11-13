import React, { useMemo, useRef } from "react";
import { Button } from "../../shared/components/ui";
import {
  FILTER_BLANK,
  STUDENT_FILTER_FIELDS,
  countActiveStudentFilters,
} from "./studentFilters";
import usePanelDismiss from "../../shared/hooks/usePanelDismiss";
import useDropdownOptions from "../../shared/lib/dropdownOptions";

/**
 * The conditions panel behind the Filters button.
 *
 * A panel rather than more controls in the toolbar: there are now nine ways to
 * narrow this list, and a row of nine dropdowns is unreadable and pushes the
 * Add Student button off the end of the bar on a laptop. Behind one button they
 * lay out in a grid with room for their labels, and the chips the page renders
 * underneath keep the active ones visible while the panel is shut.
 *
 * The campus -> course -> year chain is passed in as `chainedFields` rather than
 * declared here: those three clear each other when the step above them changes,
 * and that logic belongs with the state it clears.
 */
export default function StudentFilterPanel({
  open,
  onClose,
  filters,
  onChange,
  onClear,
  rowsInScope = [],
  chainedFields = null,
  matchCount = null,
  totalCount = null,
}) {
  const panelRef = useRef(null);
  const activeCount = countActiveStudentFilters(filters);

  usePanelDismiss(open, onClose, panelRef);

  // Gender, grant and modality choices come from the server; the panel
  // recomputes when they arrive rather than keeping the empty lists it saw
  // before the first answer.
  const lists = useDropdownOptions();
  const fields = useMemo(
    () => STUDENT_FILTER_FIELDS.map((field) => ({ ...field, choices: field.options(rowsInScope) })),
    // `lists` is what field.options() reads through getDropdownOptions().
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rowsInScope, lists]
  );

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Filter students"
      style={{
        position: "absolute",
        right: 11,
        zIndex: 20,
        marginTop: 6,
        width: "min(560px, calc(100vw - 32px))",
        background: "var(--surface-base)",
        border: "1px solid var(--border-base)",
        borderRadius: 9,
        boxShadow: "0 12px 28px rgba(2,6,23,0.16)",
        overflow: "hidden",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 9,
          padding: "10px 12px",
          borderBottom: "1px solid var(--border-base)",
        }}
      >
        <strong style={{ fontSize: 12.5, color: "var(--text-primary)" }}>Filter students</strong>
        <button
          onClick={onClose}
          aria-label="Close filters"
          style={{ background: "transparent", border: 0, fontSize: 14, cursor: "pointer", color: "var(--text-secondary)", lineHeight: 1 }}
        >
          &times;
        </button>
      </header>

      <div style={{ padding: 12, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 168px), 1fr))" }}>
        {chainedFields}

        {fields.map((field) => (
          <label key={field.key} style={{ display: "grid", gap: 3, minWidth: 0 }}>
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{field.label}</span>
            <select
              value={filters?.[field.key] ?? ""}
              onChange={(event) => onChange?.(field.key, event.target.value)}
              style={{ width: "100%", padding: "5px 7px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-base)" }}
              name={`student_filter_${field.key}`}
            >
              <option value="">Any</option>
              {field.choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
              {/* Last, and separated by its meaning rather than by a rule: this
                  matches the rows where the field is empty, which is how you
                  find the records somebody still has to complete. */}
              <option value={FILTER_BLANK}>{field.blankLabel || "Not recorded"}</option>
            </select>
          </label>
        ))}
      </div>

      <footer
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 9,
          padding: "9px 12px",
          borderTop: "1px solid var(--border-base)",
          background: "var(--surface-page)",
        }}
      >
        {/* The count is the point of the panel: it is what tells you whether the
            bulk action you are about to run will hit four students or four
            hundred. */}
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          {matchCount === null
            ? null
            : totalCount === null || matchCount === totalCount
              ? `${matchCount} students`
              : `${matchCount} of ${totalCount} students match`}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="secondary" onClick={onClear} disabled={activeCount === 0}>
            Clear all
          </Button>
          <Button onClick={onClose}>Done</Button>
        </div>
      </footer>
    </div>
  );
}
