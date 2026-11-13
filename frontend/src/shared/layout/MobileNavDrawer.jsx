import React, { useCallback, useEffect, useRef } from "react";

/**
 * The phone-and-small-tablet navigation, as an off-canvas drawer.
 *
 * It began as an inline block under the header, permanently expanded and capped
 * at 38vh — which meant a third of a phone screen was navigation before the
 * page started. Then as an inline disclosure, which fixed the height but still
 * pushed the page down when open and still occupied a row when closed.
 *
 * A drawer takes the nav out of the document flow entirely: closed, it costs
 * nothing but the trigger; open, it floats over the page and the content
 * underneath keeps its position, so dismissing it does not reflow what the
 * reader was looking at.
 *
 * Below the shared Modal's z-index on purpose. A dialog opened from a page must
 * sit above the navigation, not under it — and while a dialog is up, the nav is
 * not the thing being asked for.
 */
const OVERLAY_Z = 940;
const PANEL_Z = 950;

export default function MobileNavDrawer({ open, onClose, children, labelledBy }) {
  const panelRef = useRef(null);
  const previouslyFocused = useRef(null);

  /*
   * Escape closes, and the page behind stops scrolling.
   *
   * Without the scroll lock, dragging on the overlay scrolls the page under the
   * drawer — the drawer stays put while the content slides behind it, which
   * reads as the app being broken rather than as a menu being open.
   */
  useEffect(() => {
    if (!open) return undefined;

    previouslyFocused.current = document.activeElement;
    const { body } = document;
    const previousOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    const onKeyDown = (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKeyDown);

    // Focus moves into the panel so the keyboard and a screen reader follow the
    // drawer open, instead of staying behind on a trigger that is now covered.
    const frame = window.requestAnimationFrame(() => {
      const target = panelRef.current?.querySelector("a,button,[tabindex]:not([tabindex='-1'])");
      (target || panelRef.current)?.focus?.();
    });

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      window.cancelAnimationFrame(frame);
      body.style.overflow = previousOverflow;
      // Focus goes back where it was, so closing does not dump the reader at
      // the top of the document.
      const restore = previouslyFocused.current;
      if (restore && typeof restore.focus === "function") restore.focus();
    };
  }, [open, onClose]);

  /*
   * Any control inside closes the drawer.
   *
   * Route changes cannot drive this: most dashboards switch modules through
   * component state rather than the URL, so `location` never moves and an
   * effect keyed on it would never fire.
   */
  const handlePanelClick = useCallback(
    (event) => {
      if (event.target.closest("a,button")) onClose();
    },
    [onClose]
  );

  return (
    <>
      {/* Both nodes stay mounted so the transition has something to animate
          from, and `hidden` keeps the closed drawer out of the accessibility
          tree and off the tab order rather than merely invisible. */}
      <div
        hidden={!open}
        onClick={onClose}
        aria-hidden="true"
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(15, 23, 42, 0.45)",
          zIndex: OVERLAY_Z,
        }}
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        hidden={!open}
        onClick={handlePanelClick}
        style={{
          position: "fixed",
          top: 0,
          left: 0,
          height: "100dvh",
          // Never the full width: the strip of page still showing on the right
          // is what tells the reader this is a layer over the page, and is the
          // most obvious place to tap to dismiss it.
          width: "min(84vw, 320px)",
          maxWidth: "100%",
          zIndex: PANEL_Z,
          background: "var(--surface-base, #fff)",
          borderRight: "1px solid var(--border-base)",
          boxShadow: "0 0 40px rgba(2, 6, 23, 0.28)",
          overflowY: "auto",
          overscrollBehavior: "contain",
          WebkitOverflowScrolling: "touch",
        }}
      >
        {children}
      </div>
    </>
  );
}
