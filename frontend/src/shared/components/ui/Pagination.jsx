import React from "react";
import { color, font, radius, anim, focusRing } from "../../theme/tokens";

/**
 * Builds the page list with ellipses, always the same length so the control
 * does not resize as you page through it — a moving Next button is the classic
 * way to make someone mis-click.
 *
 * Returns numbers and the strings "start-gap" / "end-gap".
 */
export function buildPageList(page, pageCount, siblings = 1) {
  const total = 5 + siblings * 2; // first, last, current, 2 gaps, siblings
  if (pageCount <= total) {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const left = Math.max(page - siblings, 1);
  const right = Math.min(page + siblings, pageCount);
  // > 3 and < pageCount - 2, not > 2 and < pageCount - 1: at the tighter
  // thresholds a gap could stand in for a single hidden page, so page 4 of 40
  // rendered "1 … 3 4 5 … 40" — an ellipsis wider than the 2 it replaced, and
  // one fewer page you could reach in a click.
  const showLeftGap = left > 3;
  const showRightGap = right < pageCount - 2;

  if (!showLeftGap && showRightGap) {
    const count = 3 + siblings * 2;
    return [...Array.from({ length: count }, (_, i) => i + 1), "end-gap", pageCount];
  }

  if (showLeftGap && !showRightGap) {
    const count = 3 + siblings * 2;
    return [1, "start-gap", ...Array.from({ length: count }, (_, i) => pageCount - count + 1 + i)];
  }

  return [1, "start-gap", ...Array.from({ length: right - left + 1 }, (_, i) => left + i), "end-gap", pageCount];
}

function PageButton({ children, active, disabled, onClick, label }) {
  const [hovered, setHovered] = React.useState(false);
  const [focused, setFocused] = React.useState(false);

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      aria-current={active ? "page" : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 5,
        minWidth: 31,
        height: 31,
        padding: "0 8px",
        borderRadius: radius.md,
        border: `1px solid ${active ? color.brand.base : color.border.base}`,
        background: active ? color.brand.base : hovered && !disabled ? color.surface.tinted : color.surface.base,
        color: active ? color.text.onBrand : disabled ? color.text.muted : color.text.secondary,
        fontSize: font.size.small,
        fontWeight: active ? font.weight.semibold : font.weight.medium,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        transition: `background-color ${anim.fast} ${anim.ease}, border-color ${anim.fast} ${anim.ease}, color ${anim.fast} ${anim.ease}`,
        ...(focused ? { boxShadow: focusRing } : null),
      }}
    >
      {children}
    </button>
  );
}

function Chevron({ direction = "right" }) {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ transform: direction === "left" ? "rotate(180deg)" : "none" }}
    >
      <path d="M9 18l6-6-6-6" />
    </svg>
  );
}

/**
 * Pagination for every list in the system.
 *
 * The range summary ("Showing 21–40 of 137") is not decoration — without it a
 * page number tells you nothing about how much is left. It is also the only
 * part that survives on mobile, where the numbered buttons collapse to
 * Prev/Next to keep tap targets at 36px.
 */
export default function Pagination({
  page = 1,
  pageSize = 10,
  total = 0,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50, 100],
  itemLabel = "records",
  compact = false,
}) {
  const safeSize = Math.max(1, Number(pageSize) || 10);
  const pageCount = Math.max(1, Math.ceil((Number(total) || 0) / safeSize));
  const current = Math.min(Math.max(1, Number(page) || 1), pageCount);
  const firstItem = total === 0 ? 0 : (current - 1) * safeSize + 1;
  const lastItem = Math.min(current * safeSize, total);

  /*
   * A pager with more than one page and no way to change it is always a wiring
   * mistake, and it is a silent one: `onPageChange?.()` swallows the click, so
   * the control renders perfectly, counts the pages correctly, highlights the
   * right one, and simply refuses to move. Nothing throws and nothing logs.
   *
   * Faculty Workspace shipped like that. It passed `{...paged}` straight from
   * usePagedRows, whose setters are named `setPage` / `setPageSize` — so every
   * handler here was undefined and the only symptom was a dead Next button.
   *
   * Dev-only, and gated on pageCount so a genuinely single-page list stays
   * quiet. Stripped from the production bundle with the NODE_ENV check.
   */
  if (process.env.NODE_ENV !== "production" && pageCount > 1 && typeof onPageChange !== "function") {
    // eslint-disable-next-line no-console
    console.error(
      "[Pagination] rendered %d pages but got no onPageChange, so paging is dead. " +
        "If this came from usePagedRows, its setters are setPage/setPageSize — " +
        "map them: onPageChange={paged.setPage} onPageSizeChange={paged.setPageSize}.",
      pageCount
    );
  }

  const go = (next) => {
    const clamped = Math.min(Math.max(1, next), pageCount);
    if (clamped !== current) onPageChange?.(clamped);
  };

  return (
    <nav
      aria-label="Pagination"
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 9,
        padding: compact ? "12px 0 0" : "16px 0 0",
      }}
    >
      <p style={{ margin: 0, fontSize: font.size.small, color: color.text.secondary }}>
        {total === 0 ? (
          `No ${itemLabel} found`
        ) : (
          <>
            Showing <strong style={{ color: color.text.primary, fontWeight: font.weight.semibold }}>{firstItem}–{lastItem}</strong>{" "}
            of <strong style={{ color: color.text.primary, fontWeight: font.weight.semibold }}>{total}</strong> {itemLabel}
          </>
        )}
      </p>

      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        {onPageSizeChange ? (
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: font.size.small, color: color.text.secondary }}>
            Rows
            <select
              value={String(safeSize)}
              onChange={(event) => onPageSizeChange(Number(event.target.value))}
              style={{
                height: 31,
                padding: "0 6px",
                borderRadius: radius.md,
                border: `1px solid ${color.border.base}`,
                background: color.surface.base,
                color: color.text.primary,
                fontSize: font.size.small,
                cursor: "pointer",
              }}
            >
              {pageSizeOptions.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
          </label>
        ) : null}

        <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
          <PageButton onClick={() => go(current - 1)} disabled={current <= 1} label="Previous page">
            <Chevron direction="left" />
            <span className="hidden sm:inline">Prev</span>
          </PageButton>

          {/* Numbered pages are desktop-only: at 36px each they overflow a
              phone, and Prev/Next plus the range summary cover the same ground. */}
          <span className="hidden items-center gap-1.5 sm:inline-flex">
            {buildPageList(current, pageCount).map((entry) =>
              typeof entry === "number" ? (
                <PageButton
                  key={entry}
                  active={entry === current}
                  onClick={() => go(entry)}
                  label={`Page ${entry}${entry === current ? ", current page" : ""}`}
                >
                  {entry}
                </PageButton>
              ) : (
                <span
                  key={entry}
                  aria-hidden="true"
                  style={{ padding: "0 2px", color: color.text.faint, fontSize: font.size.small }}
                >
                  …
                </span>
              )
            )}
          </span>

          {/* Mobile fallback: no numbers, so say where you are. */}
          <span
            className="sm:hidden"
            style={{ padding: "0 3px", fontSize: font.size.small, color: color.text.secondary, whiteSpace: "nowrap" }}
          >
            {current} / {pageCount}
          </span>

          <PageButton onClick={() => go(current + 1)} disabled={current >= pageCount} label="Next page">
            <span className="hidden sm:inline">Next</span>
            <Chevron />
          </PageButton>
        </div>
      </div>
    </nav>
  );
}
