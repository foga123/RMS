import React from "react";

/**
 * Notification panel.
 *
 * Every row used to carry four interactive targets and five status indicators:
 * a big button that both expanded an inline preview and marked the item read, a
 * "Mark read" button, a "View" button that opened the detail modal, plus a
 * coloured dot, a READ/UNREAD/OPEN word, an INFO/SUCCESS level pill, and an
 * "Expand preview / Collapse preview" hint. Nothing said which one was the
 * thing to click.
 *
 * The row is now one button that opens the notification — the detail popup
 * already existed behind the third-level "View" control — and marks it read on
 * the way, which is what opening a notification means everywhere else. The only
 * other control is a quiet check to dismiss an unread item without reading it.
 *
 * A dropdown rather than a modal: this is a glanceable list anchored to the
 * bell, and a modal would block the page behind it for something you usually
 * only skim. The modal is the right shape for one notification's detail, which
 * is exactly where it is used.
 */

const LEVEL_DOT = {
  success: "bg-emerald-500",
  warning: "bg-amber-500",
  error: "bg-rose-500",
  info: "bg-sky-500",
};

function formatRelativeTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return raw;

  const diffMs = Date.now() - parsed.getTime();
  if (diffMs < 0) return "Just now";

  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;

  return parsed.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatExactTime(value) {
  const parsed = new Date(String(value || "").trim());
  return Number.isNaN(parsed.getTime()) ? "" : parsed.toLocaleString();
}

const CheckIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M20 6 9 17l-5-5" />
  </svg>
);

const BellOffIcon = () => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M18 8a6 6 0 0 0-9.33-5" />
    <path d="M6.26 6.26A6 6 0 0 0 6 8c0 7-3 9-3 9h14" />
    <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    <path d="m2 2 20 20" />
  </svg>
);

export default function NotificationDropdown({
  open,
  items = [],
  loading = false,
  error = "",
  unreadCount = 0,
  hasMore = false,
  loadingMore = false,
  markingAll = false,
  clearingRead = false,
  onView,
  onMarkRead,
  onMarkAllRead,
  onClearRead,
  onLoadMore,
}) {
  if (!open) return null;

  const hasReadItems = items.some((item) => item?.read);

  return (
    <div
      role="dialog"
      aria-label="Notifications"
      className="absolute right-0 top-[calc(100%+0.5rem)] z-50 w-[min(92vw,340px)] overflow-hidden rounded-xl border border-slate-200 bg-white shadow-2xl ring-1 ring-slate-900/5"
    >
      <div className="flex items-center justify-between gap-2 border-b border-slate-100 px-3 py-2.5">
        <div className="min-w-0">
          <strong className="block text-sm font-semibold text-slate-900">Notifications</strong>
          <span className="text-xs text-slate-500">
            {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
          </span>
        </div>

        {/* Bulk actions only appear when they would do something. Two permanently
            disabled buttons sat here on an empty list. */}
        <div className="flex shrink-0 items-center gap-1">
          {unreadCount > 0 ? (
            <button
              type="button"
              disabled={markingAll}
              onClick={onMarkAllRead}
              className="rounded-md px-2 py-1 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {markingAll ? "Saving…" : "Mark all read"}
            </button>
          ) : null}
          {hasReadItems ? (
            <button
              type="button"
              disabled={clearingRead}
              onClick={onClearRead}
              className="rounded-md px-2 py-1 text-xs font-semibold text-slate-500 transition-colors hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {clearingRead ? "Clearing…" : "Clear read"}
            </button>
          ) : null}
        </div>
      </div>

      <div className="max-h-[min(62vh,400px)] overflow-y-auto">
        {loading ? (
          <div className="px-3 py-6 text-center text-sm text-slate-500">Loading notifications…</div>
        ) : error ? (
          <div className="px-3 py-6 text-center text-sm text-rose-600">{error}</div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-3 py-8 text-slate-400">
            <BellOffIcon />
            <span className="text-sm text-slate-500">No notifications yet</span>
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {items.map((notification) => {
              const isRead = Boolean(notification?.read);
              const notificationId = notification?.notification_id;
              const dotClass = LEVEL_DOT[notification?.level] || LEVEL_DOT.info;

              return (
                <li key={notificationId ?? `${notification?.created_at}:${notification?.title}`} className="relative border-b border-slate-100 last:border-b-0">
                  {/* Unread reads as an edge marker plus a tinted row — the word
                      "UNREAD" on every line was doing the dot's job again. */}
                  {!isRead ? (
                    <span className="absolute inset-y-0 left-0 w-[3px] bg-primary-600" aria-hidden="true" />
                  ) : null}

                  <div className={`flex items-start gap-2 pr-2 transition-colors ${isRead ? "bg-white hover:bg-slate-50" : "bg-primary-50/50 hover:bg-primary-50"}`}>
                    <button
                      type="button"
                      onClick={() => onView?.(notification)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 px-3 py-2.5 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500"
                    >
                      <span className={`mt-1.5 block h-2 w-2 shrink-0 rounded-full ${isRead ? "bg-slate-300" : dotClass}`} aria-hidden="true" />

                      <span className="min-w-0 flex-1">
                        <span className="flex items-baseline justify-between gap-3">
                          <span className={`truncate text-sm ${isRead ? "font-medium text-slate-700" : "font-semibold text-slate-900"}`}>
                            {notification?.title}
                          </span>
                          <span
                            className="shrink-0 text-[10.5px] text-slate-400"
                            title={formatExactTime(notification?.created_at)}
                          >
                            {formatRelativeTime(notification?.created_at)}
                          </span>
                        </span>
                        <span className="mt-0.5 line-clamp-2 block text-[11.5px] leading-snug text-slate-500">
                          {notification?.message}
                        </span>
                      </span>
                    </button>

                    {!isRead ? (
                      <button
                        type="button"
                        onClick={() => onMarkRead?.(notificationId)}
                        title="Mark as read"
                        aria-label={`Mark "${notification?.title || "notification"}" as read`}
                        className="mt-2.5 shrink-0 rounded-md p-1.5 text-slate-400 transition-colors hover:bg-white hover:text-primary-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                      >
                        <CheckIcon />
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {!loading && !error && hasMore ? (
        <div className="border-t border-slate-100 p-2">
          <button
            type="button"
            disabled={loadingMore}
            onClick={onLoadMore}
            className="w-full rounded-lg py-2 text-sm font-semibold text-slate-600 transition-colors hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {loadingMore ? "Loading…" : "Load older"}
          </button>
        </div>
      ) : null}
    </div>
  );
}
