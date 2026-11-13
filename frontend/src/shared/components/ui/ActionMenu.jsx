import React, { useCallback, useState } from "react";
import Icon from "./Icon";
import { MENU_ITEM, MenuSurface, useMenuDismiss } from "./menu";

/**
 * The row's actions, behind one button.
 *
 * A table that puts View, Edit and Archive side by side in every row spends a
 * third of its width on controls that are identical down the whole column, and
 * the width it spends is width the data does not get. Worse, the buttons grow:
 * Restore appears in the archived view, Archive turns into Delete for some
 * roles, and each addition pushes the columns further right.
 *
 * One kebab, and the choices inside it. The trade is a click, and it is worth
 * it here because none of these actions is the reason someone opened the page —
 * they are what you do to a row you have already found.
 *
 * `items` is a plain array so callers keep deciding what a row can do; this
 * never inspects permissions. An item is `{ key, label, icon, tone, onSelect }`
 * and a caller that may not archive simply does not pass the archive item.
 */

const TONE_COLOR = {
  default: "var(--text-primary)",
  danger: "var(--danger-700, #b91c1c)",
  brand: "var(--brand-700, #047857)",
};

export default function ActionMenu({ label = "Row actions", items = [], align = "right", disabled = false }) {
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState("");
  const dismiss = useCallback(() => setOpen(false), []);
  const { containerRef, menuRef } = useMenuDismiss(open, dismiss);

  // No actions is not an empty menu — it is no menu. A button that opens
  // nothing is worse than an absent one.
  if (items.length === 0) return null;

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={() => setOpen((isOpen) => !isOpen)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        title={label}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: 28,
          height: 28,
          padding: 0,
          borderRadius: 6,
          border: "1px solid transparent",
          background: open ? "var(--surface-muted, #f1f5f9)" : "transparent",
          color: "var(--text-secondary)",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.5 : 1,
        }}
      >
        <Icon name="more" size={15} />
      </button>

      <MenuSurface
        open={open}
        anchorRef={containerRef}
        menuRef={menuRef}
        align={align}
        role="menu"
        aria-label={label}
      >
        {items.map((item) => (
            <button
              key={item.key}
              type="button"
              role="menuitem"
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect?.();
              }}
              onMouseEnter={() => setHovered(item.key)}
              onMouseLeave={() => setHovered("")}
              onFocus={() => setHovered(item.key)}
              onBlur={() => setHovered("")}
              style={{
                ...MENU_ITEM,
                color: TONE_COLOR[item.tone] || TONE_COLOR.default,
                background: hovered === item.key ? "var(--surface-muted, #f1f5f9)" : "transparent",
                cursor: item.disabled ? "not-allowed" : "pointer",
                opacity: item.disabled ? 0.5 : 1,
              }}
            >
              {/* The icon is decoration beside a label that already says the
                  thing, so it is hidden from assistive tech rather than read
                  out twice. */}
              <span style={{ display: "flex", width: 15, justifyContent: "center", flexShrink: 0 }} aria-hidden="true">
                {item.icon ? <Icon name={item.icon} size={13} /> : null}
              </span>
              <span>{item.label}</span>
            </button>
          ))}
      </MenuSurface>
    </div>
  );
}
