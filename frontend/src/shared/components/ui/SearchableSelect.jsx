import React, { useEffect, useMemo, useRef, useState } from "react";
import { MenuSurface, useMenuDismiss } from "./menu";

/**
 * A dropdown you can type into.
 *
 * A native <select> is fine at seven options and miserable at eighty. Cagayan de
 * Oro has eighty barangays, Misamis Oriental twenty-six cities and
 * municipalities, and the country eighty-four provinces — every one of those is
 * a list somebody has to scroll, on a phone, hunting for a name they already
 * know. Typing three letters of it is the whole feature.
 *
 * Filtering is local: the options are already in hand by the time the list
 * opens, so there is no request per keystroke and no spinner.
 *
 * The panel is a MenuSurface, so it is portalled out to <body> and cannot be
 * clipped by whatever the page has wrapped around the field — the same problem,
 * and the same fix, as the row action menus.
 *
 * `options` is `[{ code, name }]`. `code` is what comes back through onChange,
 * and "" means nothing is chosen.
 */

const CONTROL = {
  width: "100%",
  padding: "10px 11px",
  fontSize: 14,
  borderRadius: 10,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  boxSizing: "border-box",
};

export default function SearchableSelect({
  value = "",
  options = [],
  onChange,
  placeholder = "Select",
  searchPlaceholder = "Type to filter...",
  emptyText = "Nothing matches that.",
  disabled = false,
  invalid = false,
  label = "",
  name,
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  /** Which row the keyboard is on. -1 while the filter has not moved yet. */
  const [active, setActive] = useState(-1);
  /** Set when opening, so the panel is exactly as wide as the field. */
  const [width, setWidth] = useState(undefined);

  const dismiss = useRef(() => setOpen(false));
  const { containerRef, menuRef } = useMenuDismiss(open, dismiss.current);
  const inputRef = useRef(null);
  const listRef = useRef(null);

  const selected = options.find((option) => option.code === value) || null;

  const shown = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (!needle) return options;
    /*
     * Every word has to appear, in any order, so "de oro" and "oro de" both
     * find "Cagayan de Oro City". Matching the words separately rather than
     * as one string is what makes a half-remembered name work.
     */
    const words = needle.split(/\s+/);
    return options.filter((option) => {
      const hay = String(option.name || "").toLowerCase();
      return words.every((word) => hay.includes(word));
    });
  }, [options, filter]);

  // Typing changes what is under the cursor, so the highlight goes back to the
  // top rather than staying on a row that has moved or vanished.
  useEffect(() => { setActive(shown.length ? 0 : -1); }, [filter, shown.length]);

  useEffect(() => {
    if (!open) {
      setFilter("");
      return;
    }
    // The point of opening this is to type, so the caret starts in the filter.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open]);

  // Keep the highlighted row on screen when arrowing past the fold. Called
  // optionally: scrolling a row into view is a nicety, and not every
  // environment that renders this implements it — jsdom does not — so it must
  // never be the thing that breaks the control.
  useEffect(() => {
    if (!open || active < 0) return;
    const row = listRef.current?.querySelector(`[data-index="${active}"]`);
    row?.scrollIntoView?.({ block: "nearest" });
  }, [active, open]);

  function choose(option) {
    onChange?.(option ? option.code : "");
    setOpen(false);
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!shown.length) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + shown.length) % shown.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (active >= 0 && shown[active]) choose(shown[active]);
    }
    // Escape is handled by useMenuDismiss, for every menu in the app at once.
  }

  return (
    <div ref={containerRef} style={{ position: "relative" }}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={label || placeholder}
        onClick={() => {
          if (disabled) return;
          setWidth(containerRef.current?.offsetWidth);
          setOpen((isOpen) => !isOpen);
        }}
        style={{
          ...CONTROL,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          textAlign: "left",
          font: "inherit",
          fontSize: 14,
          border: `1px solid ${invalid ? "var(--danger-500)" : "var(--border-strong)"}`,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
        }}
        name={name}
      >
        <span style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: selected ? "var(--text-primary)" : "var(--text-muted)",
        }}>
          {selected ? selected.name : placeholder}
        </span>
        <span aria-hidden="true" style={{ flexShrink: 0, opacity: 0.6, fontSize: 10.5 }}>▾</span>
      </button>

      <MenuSurface
        open={open}
        anchorRef={containerRef}
        menuRef={menuRef}
        align="left"
        role="listbox"
        aria-label={label || placeholder}
        style={{ width, minWidth: 200, padding: 0, gap: 0 }}
      >
        <div style={{ padding: 6, borderBottom: "1px solid var(--border-base)" }}>
          <input
            ref={inputRef}
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={searchPlaceholder}
            aria-label={`Filter ${label || placeholder}`}
            style={{
              ...CONTROL,
              padding: "7px 9px",
              fontSize: 12.5,
              borderRadius: 7,
              border: "1px solid var(--border-base)",
            }}
            name={name ? `${name}_filter` : undefined}
          />
        </div>

        <div ref={listRef} style={{ maxHeight: 232, overflowY: "auto", padding: 4 }}>
          {shown.length === 0 ? (
            <div style={{ padding: "9px 10px", fontSize: 12.5, color: "var(--text-muted)" }}>{emptyText}</div>
          ) : (
            shown.map((option, index) => {
              const isSelected = option.code === value;
              return (
                <button
                  key={option.code}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-index={index}
                  onMouseEnter={() => setActive(index)}
                  onClick={() => choose(option)}
                  style={{
                    display: "block",
                    width: "100%",
                    textAlign: "left",
                    font: "inherit",
                    fontSize: 14,
                    padding: "7px 9px",
                    border: 0,
                    borderRadius: 6,
                    cursor: "pointer",
                    color: "var(--text-primary)",
                    fontWeight: isSelected ? 600 : 400,
                    background: index === active ? "var(--surface-muted, #f1f5f9)" : "transparent",
                  }}
                >
                  {option.name}
                </button>
              );
            })
          )}
        </div>
      </MenuSurface>
    </div>
  );
}
