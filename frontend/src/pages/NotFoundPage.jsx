import React from "react";
import { Link, useRouteError, isRouteErrorResponse } from "react-router-dom";
import { readAuthUser } from "../shared/lib/auth";
import { getDashboardPathForUser } from "../shared/lib/roles";
import { getAssetUrl } from "../shared/lib/url";
import { Button } from "../shared/components/ui";

/**
 * The screen for a URL that goes nowhere, and for a route that threw.
 *
 * Both jobs are here because react-router hands them to the same place. Wired
 * in index.jsx as the catch-all route AND as the parent errorElement:
 *
 *   - catch-all      -> a URL that matched no route. useRouteError() returns
 *                       null, because nothing went wrong; the address was
 *                       simply not one of ours.
 *   - errorElement   -> a route that threw while rendering. useRouteError()
 *                       returns the error.
 *
 * useRouteError() is safe in both: outside an error boundary it reads
 * RouteErrorContext, finds null, and returns that rather than throwing. So one
 * component covers both without a second copy of the layout — as long as the
 * no-error test is `== null` and not `!== undefined`; see below.
 *
 * Before this existed, either case fell through to react-router's own
 * DefaultErrorComponent — unstyled serif on white, reading "Unexpected
 * Application Error!" over a message that told the *end user* to "provide your
 * own ErrorBoundary or errorElement prop". That advice ships to production:
 * react-router 7's exports map has no "production" condition, so every entry
 * resolves to dist/development, where ENABLE_DEV_WARNINGS is true. There is a
 * dist/production with it set false, but no export path reaches it.
 */
export default function NotFoundPage() {
  const error = useRouteError();
  const user = readAuthUser();

  /*
   * A thrown error and a missing page are different apologies. Conflating them
   * tells someone whose page crashed to "check the address", which sends them
   * hunting for a typo that is not there.
   *
   * `== null` on purpose, covering null and undefined both. Rendered as the
   * catch-all route, useRouteError() returns **null** — not undefined — because
   * it reads RouteErrorContext, whose value outside an error boundary is null.
   * An `!== undefined` test therefore called every 404 a crash. Caught by
   * loading the page and reading the value, not by the compiler: both branches
   * render fine, so nothing failed, it just said the wrong thing.
   */
  const notFound = error == null || (isRouteErrorResponse(error) && error.status === 404);
  const crashed = !notFound;

  // An ErrorResponse carries status/statusText and no message; a thrown Error is
  // the other way round.
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`.trim()
    : error?.message;

  /*
   * Where "back" goes depends on who is asking.
   *
   * readAuthUser() is the in-memory user, not a request — this page must paint
   * instantly and must never depend on the network, since a failed API call is
   * one of the ways a route gets here in the first place. On a cold load the
   * user is null and the link points at the login screen, which is the right
   * destination for someone with no session anyway.
   *
   * <Link>, not window.location: the router adds the basename itself. Sending
   * a raw path through window.location is the bug that landed people on
   * Apache's 404 in the first place — see getAppUrl in shared/lib/url.js.
   */
  const homePath = user ? getDashboardPathForUser(user) : "/";
  const homeLabel = user ? "Back to my dashboard" : "Back to sign in";

  return (
    <main className="flex min-h-dvh flex-col items-center justify-center bg-[#f3f5f8] px-6 py-12 text-slate-800">
      <div className="w-full max-w-lg animate-fade-in text-center">
        <img
          src={getAssetUrl("assets/coc.png")}
          alt=""
          className="mx-auto mb-8 h-14 w-14 object-contain"
        />

        <p className="font-heading text-[64px] font-bold leading-none text-primary-800 sm:text-[80px]">
          {crashed ? "!" : "404"}
        </p>

        <h1 className="mt-4 font-heading text-2xl font-semibold text-slate-900">
          {crashed ? "Something went wrong on this page" : "We can't find that page"}
        </h1>

        <p className="mt-3 text-[15px] leading-relaxed text-slate-600">
          {crashed
            ? "The page failed to load. This one is on us, not on you — try again, and tell IT support if it keeps happening."
            : "The link may be out of date, or the address may have a typo in it. The page you want is still reachable from your dashboard."}
        </p>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Link to={homePath}>
            <Button variant="primary" size="md">
              {homeLabel}
            </Button>
          </Link>
          {/* Reloading is the fix often enough for a crash to be worth offering,
              and never the fix for a wrong address — so it is shown only for a
              crash rather than as permanent furniture. */}
          {crashed ? (
            <Button variant="secondary" size="md" onClick={() => window.location.reload()}>
              Try again
            </Button>
          ) : null}
        </div>

        {/*
          The error's own text, for a screenshot to IT support. Kept to
          error.message: a stack trace names internal files and bundle paths,
          which helps nobody reading this screen and tells an unauthenticated
          visitor more about the app than they need. react-router's default
          rendered the whole stack.
        */}
        {crashed && detail ? (
          <p className="mt-8 break-words rounded-lg bg-slate-100 px-4 py-3 text-left font-mono text-xs text-slate-500">
            {String(detail).slice(0, 300)}
          </p>
        ) : null}
      </div>

      <p className="mt-12 text-xs text-slate-400">RMS PHINMA-COC</p>
    </main>
  );
}
