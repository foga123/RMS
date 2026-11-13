import React, { useRef } from "react";
import { Button } from "../../shared/components/ui";
import usePanelDismiss from "../../shared/hooks/usePanelDismiss";

/**
 * The conditions panel behind the Filters button.
 *
 * The attendance toolbar carried thirteen controls in one wrapping row: a
 * search box, a section box, four scope dropdowns, a period dropdown, two bare
 * date inputs, a page-size select and four buttons. None of the dropdowns had a
 * label, so the only clue to what each one filtered was its currently selected
 * value — and once one was set, "BSIT" beside "First Semester" beside a date
 * told you nothing about which was which. On a laptop the row wrapped to three
 * lines and pushed Import and Export onto the third, while leaving a ragged gap
 * on the first.
 *
 * Behind one button the same fields lay out in a labelled grid, and the chips
 * the page renders under the header keep the active ones visible while the
 * panel is shut. That is the pattern StudentFilterPanel already established for
 * the same problem on the student list; this is the same panel with attendance's
 * fields in it rather than a second design for the same job.
 *
 * Search and Period stay in the toolbar deliberately. Search is typed at
 * constantly and hiding it behind a click would be a step backwards, and the
 * periodical is the question this whole module is arranged around — burying the
 * P1/P2/P3 switch in a panel would hide the control people came for.
 */
export default function AttendanceFilterPanel({
  open,
  onClose,
  onClear,
  activeCount = 0,
  fields = [],
}) {
  const panelRef = useRef(null);

  usePanelDismiss(open, onClose, panelRef);

  if (!open) return null;

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label="Filter attendance"
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
        <strong style={{ fontSize: 12.5, color: "var(--text-primary)" }}>Filter attendance</strong>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close filters"
          style={{
            background: "transparent",
            border: 0,
            fontSize: 14,
            cursor: "pointer",
            color: "var(--text-secondary)",
            lineHeight: 1,
          }}
        >
          &times;
        </button>
      </header>

      <div
        style={{
          padding: 12,
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 168px), 1fr))",
        }}
      >
        {fields.map((field) => (
          <label
            key={field.key}
            style={{
              display: "grid",
              gap: 3,
              minWidth: 0,
              // A field that reads as a pair — the two halves of a date range —
              // says so by sitting on a row of its own across the grid.
              gridColumn: field.wide ? "1 / -1" : "auto",
            }}
          >
            <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{field.label}</span>
            {field.control}
            {field.hint ? (
              <span style={{ fontSize: 10.5, color: "var(--text-faint)", lineHeight: 1.4 }}>{field.hint}</span>
            ) : null}
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
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {activeCount === 0
            ? "No filters applied"
            : `${activeCount} filter${activeCount === 1 ? "" : "s"} applied`}
        </span>
        <div style={{ display: "flex", gap: 6 }}>
          <Button variant="secondary" size="sm" onClick={onClear} disabled={activeCount === 0}>
            Clear all
          </Button>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      </footer>
    </div>
  );
}
