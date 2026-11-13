import React, { useEffect } from "react";
import * as dateTime from "../../lib/dateTime";
import { AnimatePresence, motion } from "framer-motion";

/** "Not available" for a notification with no stored time. */
const formatTimestamp = (value) => dateTime.formatDateTime(value, { fallback: "Not available" });

function levelBadgeClasses(level) {
  if (level === "success") {
    return "bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200";
  }
  if (level === "warning") {
    return "bg-amber-50 text-amber-700 ring-1 ring-amber-200";
  }
  if (level === "error") {
    return "bg-rose-50 text-rose-700 ring-1 ring-rose-200";
  }
  return "bg-slate-100 text-slate-600 ring-1 ring-slate-200";
}

function getRelatedLabel(notification, relatedPageLabel) {
  const explicitLabel = String(relatedPageLabel || "").trim();
  if (explicitLabel) return explicitLabel;

  const targetLabel = String(notification?.target?.label || "").trim();
  return targetLabel || "Related page";
}

export default function NotificationDetailModal({
  open = false,
  notification = null,
  canOpenRelatedPage = false,
  relatedPageLabel = "",
  onClose,
  onOpenRelatedPage,
}) {
  useEffect(() => {
    if (!open) return undefined;

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleEscape = (event) => {
      if (event.key === "Escape") {
        onClose?.();
      }
    };

    window.addEventListener("keydown", handleEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleEscape);
    };
  }, [open, onClose]);

  const relatedLabel = getRelatedLabel(notification, relatedPageLabel);
  const statusLabel = notification?.read ? "Read" : "Unread";

  return (
    <AnimatePresence>
      {open && notification ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[90] flex items-end justify-center bg-slate-950/55 p-3 backdrop-blur-[2px] sm:items-center sm:p-5"
          onClick={() => onClose?.()}
        >
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.98 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            role="dialog"
            aria-modal="true"
            aria-label="Notification details"
            onClick={(event) => event.stopPropagation()}
            className="flex w-full max-w-lg flex-col overflow-hidden rounded-[18px] border border-slate-200 bg-white shadow-[0_28px_80px_rgba(15,23,42,0.28)]"
          >
            <div className="flex items-start justify-between gap-3 border-b border-slate-200 px-4 py-4 sm:px-5">
              <div className="min-w-0">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.18em] text-primary-700/70">
                  Notification Details
                </div>
                <h2 className="mt-1.5 truncate text-base font-semibold tracking-tight text-slate-900">
                  {notification?.title || "Notification"}
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Full notification content and activity details.
                </p>
              </div>

              <button
                type="button"
                onClick={() => onClose?.()}
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-base text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700"
                aria-label="Close notification details"
              >
                x
              </button>
            </div>

            <div className="max-h-[min(86vh,600px)] overflow-y-auto px-4 py-4 sm:px-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`inline-flex rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.12em] ${levelBadgeClasses(notification?.level)}`}>
                  {notification?.level || "info"}
                </span>
                <span className={`inline-flex rounded-full px-2.5 py-1 text-[10.5px] font-bold uppercase tracking-[0.12em] ring-1 ${
                  notification?.read
                    ? "bg-slate-100 text-slate-600 ring-slate-200"
                    : "bg-primary-50 text-primary-700 ring-primary-200"
                }`}>
                  {statusLabel}
                </span>
              </div>

              <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">Date & Time</div>
                  <div className="mt-2 text-sm font-medium text-slate-800">{formatTimestamp(notification?.created_at)}</div>
                </div>

                <div className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
                  <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">Related Module</div>
                  <div className="mt-2 text-sm font-medium text-slate-800">{relatedLabel}</div>
                </div>
              </div>

              <div className="mt-3 rounded-2xl border border-slate-200 bg-white p-3 sm:p-4">
                <div className="text-[10.5px] font-semibold uppercase tracking-[0.16em] text-slate-500">Message</div>
                <div className="mt-3 whitespace-pre-wrap break-words text-sm leading-7 text-slate-700 sm:text-[13px]">
                  {String(notification?.message || "").trim() || "No additional message was provided for this notification."}
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center justify-end gap-2.5 border-t border-slate-200 bg-slate-50/80 px-4 py-3 sm:px-5">
              <button
                type="button"
                onClick={() => onClose?.()}
                className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50"
              >
                Close
              </button>

              {canOpenRelatedPage ? (
                <button
                  type="button"
                  onClick={() => onOpenRelatedPage?.(notification)}
                  className="rounded-xl bg-primary-600 px-3 py-2 text-sm font-semibold text-white transition-colors hover:bg-primary-700"
                >
                  Go to {relatedLabel}
                </button>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}
