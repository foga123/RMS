import React from "react";
import { anim, color, font, radius, shadow } from "../../theme/tokens";

/**
 * One row of tabs.
 *
 * Four places had grown their own copy of this: the same role="tablist" wrapper,
 * the same map over a views array, the same twelve-property style object
 * recomputed per button with `active ?` on half of it. They had already drifted —
 * different radii, different weights for the selected tab, one missing
 * type="button" so a tab inside a form submitted it.
 *
 * The retention workspace and the audit log use this. Still on their own copies,
 * and why:
 *
 *   SurveyWorkspace, ProfileManagementModal  horizontal tabs styled by the
 *       `.survey-tab` / `.profile-tab` CSS classes. Same shape as `underline`
 *       and worth converting, but it is a visible change to two screens with no
 *       test coverage, so it is not being done as a drive-by.
 *   SettingsPage  aria-orientation="vertical" — a side nav, not this. Vertical
 *       tabs take Up/Down, not Left/Right, so folding it in here would mean one
 *       component with two keyboard contracts.
 *
 * Two looks, because both were already in use and both are right in their place:
 *
 *   pill       a segmented control on its own background. Reads as a switch
 *              between peers, which is what a workspace's views are.
 *   underline  tabs sitting on the edge of the content below them. Reads as
 *              sections of one thing, which is what a panel's tabs are.
 *
 * Keyboard behaviour is the tablist pattern: Left/Right move between tabs, Home
 * and End jump to the ends. That was missing from all three copies — arrow keys
 * did nothing and every tab was a separate Tab stop.
 */

const baseButton = {
  border: 0,
  cursor: "pointer",
  fontFamily: "inherit",
  fontSize: font.size.md,
  lineHeight: 1.2,
  transition: `background ${anim.fast}, color ${anim.fast}, box-shadow ${anim.fast}`,
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
};

/** The little total beside a tab's label. */
function countStyle(active) {
  return {
    fontSize: font.size.xs,
    fontWeight: 600,
    padding: "1px 5px",
    borderRadius: radius.pill,
    background: active ? color.brand.subtle : "var(--surface-page)",
    color: active ? color.text.brand : color.text.muted,
    border: `1px solid ${active ? color.brand.border : color.border.base}`,
  };
}

export default function Tabs({
  /** [{ key, label, count, hint, disabled }] */
  tabs = [],
  value,
  onChange,
  variant = "pill",
  /** Named for screen readers: "Retention views", "Audit trails". */
  label = "Views",
  style,
}) {
  const usable = tabs.filter(Boolean);
  if (usable.length === 0) return null;

  const isUnderline = variant === "underline";

  function move(offset) {
    const index = usable.findIndex((tab) => tab.key === value);
    if (index < 0) return;
    // Wraps, which is what the pattern specifies: pressing Right on the last tab
    // returns to the first rather than doing nothing.
    const next = (index + offset + usable.length) % usable.length;
    if (!usable[next]?.disabled) onChange?.(usable[next].key);
  }

  function handleKeyDown(event) {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      move(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      move(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      onChange?.(usable[0].key);
    } else if (event.key === "End") {
      event.preventDefault();
      onChange?.(usable[usable.length - 1].key);
    }
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      style={{
        display: "flex",
        gap: isUnderline ? 2 : 4,
        flexWrap: "wrap",
        alignSelf: "flex-start",
        ...(isUnderline
          ? { borderBottom: `1px solid ${color.border.base}`, width: "100%" }
          : {
              padding: 3,
              borderRadius: radius.lg,
              background: "var(--surface-page)",
              border: `1px solid ${color.border.base}`,
            }),
        ...style,
      }}
    >
      {usable.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={active}
            /*
             * Only the selected tab is in the Tab order. Arrow keys move within
             * the list — the whole point of the pattern — so making every tab a
             * separate Tab stop would put a keyboard user through all of them on
             * the way to the content.
             */
            tabIndex={active ? 0 : -1}
            disabled={tab.disabled}
            title={tab.hint || undefined}
            onClick={() => !tab.disabled && onChange?.(tab.key)}
            className="ui-tab"
            style={{
              ...baseButton,
              fontWeight: active ? 600 : 400,
              opacity: tab.disabled ? 0.5 : 1,
              cursor: tab.disabled ? "not-allowed" : "pointer",
              ...(isUnderline
                ? {
                    padding: "7px 13px",
                    background: "transparent",
                    color: active ? color.text.brand : color.text.secondary,
                    // Always drawn, transparent when inactive, so selecting a tab
                    // does not shift the row by two pixels.
                    borderBottom: `2px solid ${active ? color.brand.base : "transparent"}`,
                    marginBottom: -1,
                    borderRadius: `${radius.xs}px ${radius.xs}px 0 0`,
                  }
                : {
                    padding: "6px 13px",
                    borderRadius: radius.sm,
                    background: active ? color.surface.base : "transparent",
                    color: active ? color.text.brand : color.text.secondary,
                    boxShadow: active ? shadow.sm : "none",
                  }),
            }}
          >
            {tab.label}
            {tab.count !== undefined && tab.count !== null ? (
              <span style={countStyle(active)}>{Number(tab.count).toLocaleString()}</span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
