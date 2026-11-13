import React from "react";
import Button from "./Button";

/**
 * Dashboard greeting, with one optional shortcut into the work that matters on
 * that dashboard.
 *
 * It used to render a bell with a red count badge fed by a generic
 * `notificationCount` prop, and every dashboard filled that prop with whatever
 * number it had: SSG passed the lifetime total of survey submissions, SSP
 * Caller passed all assignments rather than new ones, the generic dashboard
 * passed a hardcoded 0. A red badge on a bell promises "N new things need you",
 * and only the SSP Coordinator's count ever meant that.
 *
 * Real notifications already live in the header — NotificationDropdown, backed
 * by notifications.php, with genuine unread counts and mark-as-read. A second
 * bell a few hundred pixels below it was competing with the real one.
 *
 * So the shortcut now states what it is: a labelled button, and the caller
 * writes the label. If there is nothing worth pointing at, pass no label and no
 * button renders.
 */
export default function WelcomeCard({
  firstName = "User",
  subtitle = "Here is your current overview.",
  actionLabel = "",
  onActionClick,
}) {
  return (
    <section className="relative flex flex-wrap items-start justify-between gap-5 overflow-hidden rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6 xl:p-8">
      <div className="absolute -right-12 -top-12 h-32 w-32 rounded-full bg-primary-50 opacity-60 blur-2xl" aria-hidden="true" />

      <div className="relative z-10 min-w-0 flex-1 basis-[18rem]">
        <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary-600">
          <span className="h-2 w-2 rounded-full bg-primary-500" aria-hidden="true" />
          Dashboard
        </div>
        <h3 className="mb-2 font-heading text-[clamp(1.75rem,1vw+1.25rem,2rem)] font-bold tracking-tight text-slate-800">
          Welcome, {firstName}
        </h3>
        <p className="text-sm font-medium text-slate-500 sm:text-base">{subtitle}</p>
      </div>

      {actionLabel ? (
        <div className="relative z-10 ml-auto">
          <Button variant="secondary" onClick={onActionClick}>
            {actionLabel}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
