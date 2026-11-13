import React from "react";
import { Button, Icon } from "../../components/ui";
import NotificationDropdown from "./NotificationDropdown";

function passwordExpirationClassName(expiration) {
  const status = String(expiration?.status || "").toLowerCase();
  if (status === "expired") {
    return "border-red-200 bg-red-50 text-red-700";
  }
  if (status === "red") {
    return "border-red-200 bg-red-50 text-red-600";
  }
  if (status === "orange") {
    return "border-orange-200 bg-orange-50 text-orange-700";
  }
  if (status === "green") {
    return "border-green-200 bg-green-50 text-green-700";
  }
  return "border-slate-200 bg-slate-50 text-slate-600";
}

export default function Header({
  title,
  menuRef,
  menuOpen,
  onToggleMenu,
  initials,
  email,
  notificationCount = 0,
  onNotifications,
  notificationOpen = false,
  notifications = [],
  notificationsLoading = false,
  notificationsError = "",
  notificationsUnreadCount = 0,
  notificationsHasMore = false,
  notificationsLoadingMore = false,
  notificationsMarkingAll = false,
  notificationsClearingRead = false,
  onNotificationView,
  onNotificationMarkRead,
  onNotificationMarkAllRead,
  onNotificationClearRead,
  onNotificationLoadMore,
  onProfile,
  /**
   * Optional. When a dashboard passes this, Settings sits under Profile in the
   * account menu instead of in the sidebar rail. Only the dashboards that grant
   * the settings module pass it, so the item cannot appear for a role that has
   * no access to it.
   */
  onSettings = null,
  settingsLabel = "Settings",
  onLogout,
  passwordExpiration = null,
}) {
  const showPasswordExpiration = Boolean(passwordExpiration);
  const passwordExpirationClasses = passwordExpirationClassName(passwordExpiration);

  /*
   * py-3 below lg, py-2 from lg up: the bar measured 66px tall on desktop,
   * where an enterprise shell wants the mid-50s. The padding is the only part
   * worth taking — the two title lines and the 32px avatar are the content, and
   * shrinking those costs legibility rather than chrome. Narrow viewports keep
   * the roomier padding, where the header doubles as a touch target.
   */
  return (
    <header className="sticky top-0 z-30 shrink-0 border-b border-slate-200/80 bg-white px-4 py-3 text-slate-800 shadow-sm transition-colors duration-200 sm:px-6 lg:py-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10.5px] font-semibold uppercase tracking-[0.28em] text-primary-700/70">
            Dashboard Workspace
          </p>
          <strong className="mt-1 block truncate text-base font-heading font-bold tracking-tight text-slate-800 sm:text-lg">
            {title}
          </strong>
        </div>

        <div ref={menuRef} className="relative flex min-w-0 items-center gap-2 sm:gap-4">
          <span className="hidden max-w-[min(28vw,260px)] truncate text-sm font-medium text-slate-500 xl:block">{email}</span>

          <Button
            onClick={onNotifications}
            aria-label="Notifications"
            aria-haspopup="dialog"
            aria-expanded={notificationOpen}
            variant="ghost"
            title="Notifications"
            className="relative flex h-10 w-10 min-w-10 items-center justify-center rounded-xl border border-slate-200 bg-slate-50 p-0 text-slate-700 transition-colors hover:bg-slate-100 hover:text-slate-900 focus:ring-2 focus:ring-primary-500/20"
          >
            <Icon name="bell" size={15} />
            {notificationCount > 0 && (
              <span className="absolute -right-1.5 -top-1.5 inline-flex h-5 min-w-[17px] items-center justify-center rounded-full bg-red-500 px-1.5 text-[10px] font-bold leading-none text-white shadow-sm ring-2 ring-white">
                {notificationCount > 99 ? "99+" : notificationCount}
              </span>
            )}
          </Button>

          <NotificationDropdown
            open={notificationOpen}
            items={notifications}
            loading={notificationsLoading}
            error={notificationsError}
            unreadCount={notificationsUnreadCount}
            hasMore={notificationsHasMore}
            loadingMore={notificationsLoadingMore}
            markingAll={notificationsMarkingAll}
            clearingRead={notificationsClearingRead}
            onView={onNotificationView}
            onMarkRead={onNotificationMarkRead}
            onMarkAllRead={onNotificationMarkAllRead}
            onClearRead={onNotificationClearRead}
            onLoadMore={onNotificationLoadMore}
          />

          <Button
            onClick={onToggleMenu}
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            variant="ghost"
            title="Account menu"
            className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-primary-100 bg-primary-50 p-0 font-bold text-primary-700 shadow-sm transition-all hover:border-primary-200 hover:bg-primary-100 focus:ring-2 focus:ring-primary-500/20"
          >
            {initials}
          </Button>

          {menuOpen && (
            <div
              role="menu"
              className="absolute right-0 top-[calc(100%+0.5rem)] z-50 min-w-[170px] max-w-[min(90vw,240px)] origin-top-right overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl ring-1 ring-slate-900/5 animate-slide-up"
            >
              <div className="py-1">
                <button
                  role="menuitem"
                  className="group flex w-full cursor-pointer items-center justify-start gap-3 bg-transparent px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                  onClick={onProfile}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-slate-400 transition-colors group-hover:text-slate-600">
                    <path d="M20 21a8 8 0 0 0-16 0"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                  </svg>
                  Profile
                </button>

                {onSettings ? (
                  <button
                    role="menuitem"
                    className="group flex w-full cursor-pointer items-center justify-start gap-3 bg-transparent px-4 py-2 text-sm font-medium text-slate-700 transition-colors hover:bg-slate-50"
                    onClick={onSettings}
                  >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-slate-400 transition-colors group-hover:text-slate-600">
                      <circle cx="12" cy="12" r="3"></circle>
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                    {settingsLabel}
                  </button>
                ) : null}
              </div>

              <div className="h-px bg-slate-100" />

              {showPasswordExpiration ? (
                <>
                  <div className="px-3 py-2">
                    <div className={`rounded-lg border px-3 py-2.5 ${passwordExpirationClasses}`}>
                      <div className="flex items-start gap-2.5">
                        <Icon name="lock" size={14} className="mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="text-xs font-bold uppercase tracking-[0.12em]">
                            Password Expires
                          </div>
                          <div className="mt-1 text-sm font-bold">
                            {passwordExpiration.remaining_label || "Unavailable"}
                          </div>
                          <div className="mt-2 grid gap-0.5 text-xs font-medium opacity-90">
                            <span>Expires On:</span>
                            <span>{passwordExpiration.expires_at_display || "Not scheduled"}</span>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div className="h-px bg-slate-100" />
                </>
              ) : null}

              <div className="py-1">
                <button
                  role="menuitem"
                  className="group flex w-full cursor-pointer items-center justify-start gap-3 bg-transparent px-4 py-2 text-sm font-medium text-red-600 transition-colors hover:bg-red-50"
                  onClick={onLogout}
                >
                  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="shrink-0 text-red-500 transition-colors group-hover:text-red-600">
                    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path>
                    <path d="M16 17l5-5-5-5"></path>
                    <path d="M21 12H9"></path>
                  </svg>
                  Logout
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}
