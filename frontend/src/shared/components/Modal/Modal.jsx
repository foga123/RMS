import React from "react";
import { AnimatePresence, motion } from "framer-motion";
import AlertMessage from "../ui/AlertMessage";

// Shared with ProfileManagementModal, which draws its own frame but the same close button.
export const CloseIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M18 6 6 18M6 6l12 12" />
  </svg>
);

/**
 * The dialog had no height cap and no scroll container — the body was a plain
 * `<div style={{ padding: 12 }}>` and the card grew to whatever its content
 * needed.
 *
 * The overlay centres with `align-items: center`, and a flex item taller than
 * its container overflows *both* ends equally. So a long dialog (custom sidebar
 * access, the permission matrix) ran off the top and bottom of the screen at
 * once, and the part above the top edge could not be scrolled back into view.
 * Controls near the top were simply unreachable.
 *
 * The card is now capped to the viewport with the body scrolling inside it and
 * the header pinned. The overlay scrolls too, which covers the case where the
 * card still cannot shrink far enough on very short viewports.
 *
 * `error` / `success` are the second thing this fixes. Pages render their alert
 * box at the top of the page, and a dialog is `position: fixed` over the whole
 * page at z-index 1000 - so a save that failed FROM INSIDE the dialog painted
 * its reason underneath the dialog, where nobody can see it. The dialog stays
 * open, nothing visibly happens, and the reader presses Save again. Typing an
 * `<>` into a text field is the quickest way to see it: the server refuses the
 * value and the refusal lands behind the card that asked for it.
 *
 * The alert belongs to the dialog because that is where the action was taken,
 * and it is rendered BETWEEN the header and the scrolling body rather than
 * inside it. In the body it would scroll out of sight on a long form - which,
 * on a form long enough to scroll, is the same bug again.
 */
export default function Modal({ open, title, children, onClose, width = 420, error = "", success = "" }) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          role="dialog"
          aria-modal="true"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(15,23,42,0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 12,
            overflowY: "auto",
          }}
          onClick={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2 }}
        >
          <motion.div
            onClick={(event) => event.stopPropagation()}
            style={{
              width: "100%",
              maxWidth: width,
              maxHeight: "calc(100dvh - 24px)",
              display: "flex",
              flexDirection: "column",
              minHeight: 0,
              background: "var(--surface-base)",
              border: "1px solid var(--border-base)",
              borderRadius: 9,
              boxShadow: "0 24px 60px rgba(2,6,23,0.24)",
            }}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
          >
            <div
              style={{
                flexShrink: 0,
                padding: "11px 12px",
                borderBottom: "1px solid var(--border-base)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 9,
              }}
            >
              <strong style={{ color: "var(--text-primary)", minWidth: 0 }}>{title}</strong>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close"
                style={{
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                  width: 26,
                  height: 26,
                  padding: 0,
                  borderRadius: 6,
                  border: "1px solid var(--border-base)",
                  background: "var(--surface-base)",
                  color: "var(--text-secondary)",
                  cursor: "pointer",
                }}
              >
                <CloseIcon />
              </button>
            </div>
            {error || success ? (
              <div style={{ flexShrink: 0, padding: "9px 12px 0" }}>
                {/* The role is left to AlertMessage, which derives it from the
                    tone: assertive for an error, because the action the reader
                    just took did not happen, and polite for a success, so it
                    does not interrupt what they are typing next. Hardcoding
                    role="alert" here made a saved-successfully note shout.
                    marginBottom 0 because the body below has its own padding. */}
                <AlertMessage
                  message={error || success}
                  tone={error ? "error" : "success"}
                  style={{ marginBottom: 0 }}
                />
              </div>
            ) : null}
            <div style={{ padding: 12, overflowY: "auto", flex: 1, minHeight: 0 }}>{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
