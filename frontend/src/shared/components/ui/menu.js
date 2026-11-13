import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * The shared behaviour and surface of a popup menu.
 *
 * Extracted from ExportMenu, which was the only menu in the app until the row
 * action menu and the column chooser arrived. Three copies of "close on outside
 * click, close on Escape" is three chances for one of them to leak a document
 * listener or to miss the Escape key, and a menu that closes one way here and
 * another way there is a menu the reader has to learn twice.
 *
 * ---------------------------------------------------------------------------
 * Why the surface is portalled to <body> rather than sitting beside its button
 *
 * It used to be `position: absolute` inside the button's wrapper, which put it
 * inside whatever the page had wrapped around that button. Every table here
 * lives in a scroll box — StudentsPage uses `overflow: auto` with a
 * viewport-based maxHeight — and `overflow` clips absolutely positioned
 * descendants. With a full page of rows nobody noticed, because the box was
 * tall and the menu had somewhere to open into. Filter down to ONE row and the
 * box is one row tall, so the menu opened straight into the clipped region and
 * only a sliver of it was visible.
 *
 * Growing the container, or giving it `overflow: visible`, trades the clipped
 * menu for a table that will not scroll. So the surface leaves the container
 * entirely: rendered into <body>, positioned `fixed` against the button's
 * on-screen rectangle, and flipped above the button when there is more room
 * there. It cannot be clipped by an ancestor it no longer has.
 * ---------------------------------------------------------------------------
 */

/** Space between the button and its menu. */
const MENU_GAP = 4;
/** Space kept clear of the viewport edge, so a menu never touches the rim. */
const MENU_EDGE = 8;
/** Below this a menu is not worth shortening any further; it scrolls instead. */
const MENU_MIN_HEIGHT = 120;

export const MENU_SURFACE = {
  position: "fixed",
  /*
   * Above the modals. A menu is always opened from something already on screen,
   * including from inside a dialog, so it has to clear the tallest of them —
   * ProfileManagementModal at 1600. Portalled into <body> it no longer sits in
   * any dialog's stacking context, so this is measured against the whole page.
   */
  zIndex: 1700,
  minWidth: 168,
  padding: 4,
  display: "grid",
  gap: 1,
  background: "var(--surface-base, #fff)",
  border: "1px solid var(--border-base)",
  borderRadius: 7,
  boxShadow: "0 8px 20px rgba(15, 23, 42, 0.12)",
};

export const MENU_ITEM = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  width: "100%",
  padding: "6px 8px",
  border: 0,
  borderRadius: 5,
  background: "transparent",
  color: "var(--text-primary)",
  font: "inherit",
  fontSize: 11.5,
  textAlign: "left",
  cursor: "pointer",
};

/**
 * Where to put an open menu, given the button it belongs to.
 *
 * Measured rather than assumed: the panel is laid out hidden for one pass so
 * its real height is known before a side is chosen. `useLayoutEffect` runs
 * before the browser paints, so that pass is never seen.
 *
 * Returns null until that measurement has happened, which is the caller's cue
 * to keep the panel hidden.
 */
function useMenuPosition(open, anchorRef, menuRef, align, cap) {
  const [position, setPosition] = useState(null);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return undefined;
    }

    function place() {
      const anchor = anchorRef.current;
      if (!anchor) return;

      const rect = anchor.getBoundingClientRect();
      const height = menuRef.current?.offsetHeight ?? 0;
      const width = menuRef.current?.offsetWidth ?? 0;

      const below = window.innerHeight - rect.bottom - MENU_GAP - MENU_EDGE;
      const above = rect.top - MENU_GAP - MENU_EDGE;

      // Open upward only where that genuinely helps. A menu that does not fit
      // below and fits even less above should stay below and scroll.
      const flip = height > below && above > below;

      // The room available, and then the caller's own ceiling if it set one —
      // ColumnMenu caps itself at 340 so a forty-column table does not open a
      // menu the height of the screen. The smaller of the two wins.
      const room = Math.max(MENU_MIN_HEIGHT, flip ? above : below);
      const maxHeight = cap ? Math.min(cap, room) : room;
      const shown = Math.min(height || maxHeight, maxHeight);

      const top = flip ? rect.top - shown - MENU_GAP : rect.bottom + MENU_GAP;

      // `align` names the edge the menu shares with its button, which is what
      // the old `{ [align]: 0 }` meant back when the two were nested.
      const rawLeft = align === "left" ? rect.left : rect.right - width;
      const left = Math.max(
        MENU_EDGE,
        Math.min(rawLeft, window.innerWidth - width - MENU_EDGE)
      );

      setPosition({ top, left, maxHeight });
    }

    place();

    /*
     * Capturing, because the scroll that moves the button is usually a scroll
     * of the table it sits in rather than of the window, and those do not
     * bubble. Without the capture flag the menu would sit where the button
     * used to be.
     */
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open, align, cap, anchorRef, menuRef]);

  return position;
}

/**
 * The menu's panel: portalled out of the page and positioned against
 * `anchorRef`.
 *
 * `menuRef` comes from useMenuDismiss rather than being owned here, because the
 * panel is no longer a descendant of the wrapper that the dismiss listener
 * checks — the listener has to be able to ask about it separately.
 */
export function MenuSurface({ open, anchorRef, menuRef, align = "right", style, children, ...rest }) {
  const cap = typeof style?.maxHeight === "number" ? style.maxHeight : null;
  const position = useMenuPosition(open, anchorRef, menuRef, align, cap);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      style={{
        ...MENU_SURFACE,
        ...style,
        top: position?.top ?? 0,
        left: position?.left ?? 0,
        // Until the first measurement the position is a guess, so the panel is
        // laid out — and therefore measurable — but not shown.
        visibility: position ? "visible" : "hidden",
        maxHeight: position?.maxHeight,
        overflowY: "auto",
      }}
      {...rest}
    >
      {children}
    </div>,
    document.body
  );
}

/**
 * The refs a menu needs: `containerRef` for the wrapper holding the button, and
 * `menuRef` for the portalled panel.
 *
 * `mousedown` rather than `click`, so a menu closes on the press that starts
 * outside it rather than on the release — otherwise pressing on a control
 * behind the menu fires that control's click as its first interaction.
 *
 * Both listeners are attached only while the menu is open, so a page holding
 * forty rows of closed menus holds no listeners at all.
 */
export function useMenuDismiss(open, onDismiss) {
  const containerRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;

    function closeOnOutsideClick(event) {
      if (containerRef.current?.contains(event.target)) return;
      // The panel lives in <body> now, so it is not inside containerRef and has
      // to be asked about separately — without this, choosing an item would
      // read as a click outside and close the menu before the item ran.
      if (menuRef.current?.contains(event.target)) return;
      onDismiss();
    }
    function closeOnEscape(event) {
      if (event.key === "Escape") onDismiss();
    }

    document.addEventListener("mousedown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open, onDismiss]);

  return { containerRef, menuRef };
}
