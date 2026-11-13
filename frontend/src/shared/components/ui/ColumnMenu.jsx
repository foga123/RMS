import React, { useCallback, useState } from "react";
import Icon from "./Icon";
import { MENU_ITEM, MenuSurface, useMenuDismiss } from "./menu";

/**
 * Which columns the table draws.
 *
 * A record can hold twenty-five fields and still only be scanned by eight of
 * them, so the table shows the eight and keeps the rest one checkbox away. The
 * alternative — every column, always — is a table nobody can read without
 * scrolling sideways past the columns they came for.
 *
 * "Show all" is the escape hatch that answers "can I see everything the
 * database holds": tick it and the table becomes the whole record, scrolling
 * horizontally, which is the right shape for a check rather than for daily use.
 *
 * Controlled: the caller owns the list and the selection, because which columns
 * exist is a fact about that screen's data and not about this control.
 */
export default function ColumnMenu({
  columns = [],
  visibleKeys = [],
  onChange,
  lockedKeys = [],
  label = "Columns",
  align = "right",
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState("");
  const dismiss = useCallback(() => setOpen(false), []);
  const { containerRef, menuRef } = useMenuDismiss(open, dismiss);

  if (columns.length === 0) return null;

  const visible = new Set(visibleKeys);
  const locked = new Set(lockedKeys);
  const shownCount = columns.filter((column) => visible.has(column.key)).length;
  const allShown = shownCount === columns.length;

  const toggle = (key) => {
    // A locked column is the row's own identity — dropping Student Number
    // leaves a grid of values with nothing to say who each row is about.
    if (locked.has(key)) return;
    const next = columns
      .filter((column) => (column.key === key ? !visible.has(key) : visible.has(column.key)))
      .map((column) => column.key);
    onChange?.(next);
  };

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          padding: "5px 9px",
          borderRadius: 6,
          border: "1px solid var(--border-base)",
          background: open ? "var(--surface-muted, #f1f5f9)" : "var(--surface-base, #fff)",
          color: "var(--text-secondary)",
          font: "inherit",
          fontSize: 11.5,
          cursor: "pointer",
        }}
      >
        <Icon name="columns" size={13} />
        <span>{label}</span>
        {/* The count is the whole point of the button when it is closed: it says
            "you are not looking at everything" without opening anything. */}
        <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>
          {shownCount}/{columns.length}
        </span>
      </button>

      <MenuSurface
        open={open}
        anchorRef={containerRef}
        menuRef={menuRef}
        align={align}
        role="menu"
        aria-label={label}
        style={{ minWidth: 210, maxHeight: 340 }}
      >
          <div style={{ display: "flex", gap: 4, padding: "2px 4px 5px", borderBottom: "1px solid var(--border-base)" }}>
            <button
              type="button"
              onClick={() => onChange?.(columns.map((column) => column.key))}
              disabled={allShown}
              style={{
                flex: 1,
                padding: "4px 6px",
                borderRadius: 5,
                border: "1px solid var(--border-base)",
                background: "var(--surface-base, #fff)",
                color: "var(--text-secondary)",
                font: "inherit",
                fontSize: 10.5,
                cursor: allShown ? "not-allowed" : "pointer",
                opacity: allShown ? 0.5 : 1,
              }}
            >
              Show all
            </button>
            <button
              type="button"
              onClick={() => onChange?.(columns.filter((column) => column.default || locked.has(column.key)).map((column) => column.key))}
              style={{
                flex: 1,
                padding: "4px 6px",
                borderRadius: 5,
                border: "1px solid var(--border-base)",
                background: "var(--surface-base, #fff)",
                color: "var(--text-secondary)",
                font: "inherit",
                fontSize: 10.5,
                cursor: "pointer",
              }}
            >
              Reset
            </button>
          </div>

          {columns.map((column) => {
            const checked = visible.has(column.key);
            const isLocked = locked.has(column.key);
            return (
              <button
                key={column.key}
                type="button"
                role="menuitemcheckbox"
                aria-checked={checked}
                disabled={isLocked}
                onClick={() => toggle(column.key)}
                onMouseEnter={() => setHovered(column.key)}
                onMouseLeave={() => setHovered("")}
                onFocus={() => setHovered(column.key)}
                onBlur={() => setHovered("")}
                title={isLocked ? "This column identifies the row and cannot be hidden" : undefined}
                style={{
                  ...MENU_ITEM,
                  background: hovered === column.key && !isLocked ? "var(--surface-muted, #f1f5f9)" : "transparent",
                  cursor: isLocked ? "default" : "pointer",
                  color: isLocked ? "var(--text-muted)" : "var(--text-primary)",
                }}
              >
                <span
                  aria-hidden="true"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: 14,
                    height: 14,
                    flexShrink: 0,
                    borderRadius: 4,
                    border: `1px solid ${checked ? "var(--brand-600, #059669)" : "var(--border-strong)"}`,
                    background: checked ? "var(--brand-600, #059669)" : "transparent",
                    color: "#fff",
                  }}
                >
                  {checked ? <Icon name="check" size={10} strokeWidth={3} /> : null}
                </span>
                <span>{column.label}</span>
              </button>
            );
          })}
      </MenuSurface>
    </div>
  );
}
