import { useEffect } from "react";

/**
 * Close a filter panel on Escape or on a click anywhere outside it.
 *
 * Shared by the Students and Attendance filter panels, which each carried an
 * identical copy. Not the same as useMenuDismiss() in ui/menu.js, and it must
 * not be swapped for it: that one listens in the bubble phase and knows about a
 * portalled menu, while this listens in the CAPTURE phase - the toolbar button
 * that opens the panel would otherwise see its own click bubble up and shut the
 * panel again immediately.
 *
 * Both listeners exist only while the panel is open. A listener left on the
 * document for the whole session makes every click on the page a little
 * slower for nothing.
 */
export default function usePanelDismiss(open, onClose, panelRef) {
  useEffect(() => {
    if (!open) return undefined;

    function onKeyDown(event) {
      if (event.key === "Escape") onClose?.();
    }
    function onPointerDown(event) {
      if (panelRef.current && !panelRef.current.contains(event.target)) onClose?.();
    }

    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onPointerDown, true);
    };
  }, [open, onClose, panelRef]);
}
