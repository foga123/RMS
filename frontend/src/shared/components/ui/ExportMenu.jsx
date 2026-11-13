import React, { useCallback, useState } from "react";
import Button from "./Button";
import Icon from "./Icon";
import { MenuSurface, useMenuDismiss } from "./menu";

/**
 * One Export button with the formats behind it.
 *
 * Rows of sibling format buttons — Excel, CSV, PDF, Print — read as four
 * unrelated actions and take as much of a toolbar as every filter beside them,
 * when they are really one action with a choice inside it. Worse, a screen with
 * a second export control somewhere else (the Reports page had one in the card
 * header and another in the report body) gives no way to tell which one honours
 * the filter that is on screen.
 *
 * Controlled and presentational: it owns only whether the menu is open. The
 * caller decides what the formats are and what choosing one does, because
 * "Excel" means a client-built workbook on one screen and a server-rendered
 * file on another.
 */

export default function ExportMenu({
  label = "Export",
  options = [],
  busyKey = "",
  busyLabel = "",
  disabled = false,
  align = "right",
  onSelect,
}) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState("");
  const dismiss = useCallback(() => setOpen(false), []);
  const { containerRef, menuRef } = useMenuDismiss(open, dismiss);

  if (options.length === 0) return null;

  const busy = options.find((option) => option.key === busyKey);
  // The button reports what is happening rather than staying on "Export" while
  // a file is being built, which otherwise reads as a click that did nothing.
  const buttonText = busy ? busyLabel || `${busy.label}...` : label;

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <Button
        variant="secondary"
        onClick={() => setOpen((isOpen) => !isOpen)}
        disabled={disabled || Boolean(busy)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Icon name="download" size={13} />
        <span>{buttonText}</span>
        <span aria-hidden="true" style={{ fontSize: 10.5, opacity: 0.7 }}>▾</span>
      </Button>

      <MenuSurface
        open={open}
        anchorRef={containerRef}
        menuRef={menuRef}
        align={align}
        role="menu"
        aria-label={label}
      >
        {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onSelect?.(option.key);
              }}
              onMouseEnter={() => setHovered(option.key)}
              onMouseLeave={() => setHovered("")}
              onFocus={() => setHovered(option.key)}
              onBlur={() => setHovered("")}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
                width: "100%",
                padding: "6px 8px",
                border: 0,
                borderRadius: 5,
                background: hovered === option.key ? "var(--surface-muted, #f1f5f9)" : "transparent",
                color: "var(--text-primary)",
                font: "inherit",
                fontSize: 11.5,
                textAlign: "left",
                cursor: "pointer",
              }}
            >
              <span>{option.label}</span>
              {option.hint ? (
                <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{option.hint}</span>
              ) : null}
            </button>
          ))}
      </MenuSurface>
    </div>
  );
}
