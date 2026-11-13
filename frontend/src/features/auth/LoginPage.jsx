import React, { useState, useEffect } from "react";
import { getDashboardPathForUser } from "../../shared/lib/roles";
import { restoreAuthUser } from "../../shared/lib/auth";
import { startSession } from "../../shared/lib/session";
import { getAppUrl, getAssetUrl } from "../../shared/lib/url";
import LoginForm from "./components/LoginForm";
import ResetPasswordModal from "./components/ResetPasswordModal";

/**
 * Sign-in screen.
 *
 * Split layout: an institutional panel carrying the seal and the college name,
 * a white column carrying the wordmark and the form card.
 *
 * The background shards all share one rotation angle. That is what keeps them
 * reading as a deliberate pattern — vary the angle per shape and the same
 * shapes turn into scattered debris.
 *
 * Below `lg` the two columns stack, and the panel used to take roughly half the
 * viewport before the form began — on a phone that put every field under the
 * fold, so the first thing a user did on the sign-in screen was scroll looking
 * for it. Under `lg` the panel becomes a compact band instead: the seal and the
 * name sit on one line, the shards shrink to match, and the card starts about a
 * third of the way down. `lg` is the switch because that is already where the
 * grid changes shape; at and above it nothing here resolves differently than it
 * did before.
 *
 * The band is brand green with white type, where the panel is near-white with
 * slate type. That is not a second theme — it is what the small size asks for.
 * Shrunk to a header, the pale panel stopped reading as anything at all: a grey
 * strip with grey text above a white card. Inverting it gives the phone layout
 * the anchor the full-height panel gives the desktop one, and it lets the type
 * clear 6.6:1 instead of the 4.4:1 the address managed on #f3f5f8.
 */

/** Every shard sits on this angle. Change it here, not per shape. */
const SHARD_ANGLE = "rotate(14deg)";

/**
 * Shards, painted back to front. Two solid brand pieces anchor the corners;
 * everything else is a tint so the seal keeps the contrast.
 *
 * Split in two so the band and the panel stay legible side by side rather than
 * as one long class string. `panel` is the original composition untouched.
 *
 * In the band every shard is white at low alpha instead of a hue. Over a solid
 * green ground a green shape reads as a printing fault, and any tint of a
 * *different* hue reads as dirt. The alphas are capped at 0.14 because the
 * address is the binding constraint, not the name: over a 0.14 shard the name
 * still holds 5.5:1 but white/90 is down to 4.79:1, and one more step fails it.
 */
const SHARDS = [
  {
    band: "-left-12 -top-10 h-40 w-32 bg-white/10",
    panel: "lg:-left-28 lg:-top-20 lg:h-80 lg:w-72 lg:bg-slate-300/30",
  },
  {
    band: "left-1 top-10 h-32 w-20 bg-white/5",
    panel: "lg:left-4 lg:top-28 lg:h-64 lg:w-44 lg:bg-primary-700/20",
  },
  {
    band: "left-[36%] -top-2 h-14 w-14 bg-white/[0.14]",
    panel: "lg:left-[40%] lg:top-8 lg:h-28 lg:w-28 lg:bg-primary-200/60",
  },
  {
    band: "-right-8 -top-12 h-36 w-28 bg-white/[0.07]",
    panel: "lg:right-4 lg:-top-10 lg:h-72 lg:w-52 lg:bg-primary-800",
  },
  {
    band: "-left-10 bottom-6 h-32 w-28 bg-white/[0.11]",
    panel: "lg:-left-20 lg:bottom-28 lg:h-72 lg:w-56 lg:bg-primary-100/80",
  },
  {
    band: "left-[30%] -bottom-12 h-32 w-28 bg-white/5",
    panel: "lg:left-[28%] lg:-bottom-16 lg:h-64 lg:w-48 lg:bg-slate-200/60",
  },
  {
    band: "-right-4 -bottom-16 h-36 w-32 bg-white/[0.08]",
    panel: "lg:right-20 lg:-bottom-24 lg:h-80 lg:w-60 lg:bg-primary-800",
  },
];

export default function Login() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [resetOpen, setResetOpen] = useState(false);
  // Seconds the server asked us to wait when restoring the session was
  // throttled - the form counts them down instead of inviting a login that
  // would be refused the same way.
  const [restoreRetryAfter, setRestoreRetryAfter] = useState(null);
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    let active = true;

    async function bootstrapSession() {
      try {
        const user = await restoreAuthUser();
        if (!active || !user) return;
        startSession();
        const mustChangePassword = Boolean(user?.password_expiration?.force_password_change || user?.password_expiration?.is_expired);
        const destination = mustChangePassword ? "/change-password" : getDashboardPathForUser(user);
        // getAppUrl, not the bare route - the router is mounted at a basename.
        const target = getAppUrl(destination);
        if (destination && window.location.pathname !== target) {
          window.location.replace(target);
        }
      } catch (err) {
        // Session restore failed; user must login - unless it was only
        // throttled, in which case the session may be fine and they must wait.
        if (active && err?.status === 429) {
          setRestoreRetryAfter(err.retryAfter || 60);
        }
      } finally {
        if (active) setCheckingSession(false);
      }
    }

    void bootstrapSession();
    return () => {
      active = false;
    };
  }, []);

  if (checkingSession) {
    return (
      <div className="flex min-h-dvh items-center justify-center bg-slate-50 px-6">
        <div className="flex flex-col items-center gap-5" role="status">
          <img src={getAssetUrl("assets/coc.png")} alt="" className="h-12 w-12 object-contain" />
          <div className="flex items-center gap-2 text-xs font-medium text-slate-500">
            <svg className="h-4 w-4 animate-spin text-primary-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
            Restoring your session…
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-no-zoom min-h-dvh bg-white font-sans">
      <ResetPasswordModal open={resetOpen} onClose={() => setResetOpen(false)} />

      {/* Stacked, the two rows share the viewport evenly, which is what gave
          the band half a phone screen. `auto 1fr` sizes it to its contents and
          hands the remainder to the form. Cleared at `lg`, where the columns
          take over and rows go back to being implicit. */}
      <div className="grid min-h-dvh grid-rows-[auto_1fr] lg:grid-rows-none lg:grid-cols-[minmax(0,0.92fr)_minmax(0,1.08fr)]">
        {/* ------------------------------------------- institutional panel */}
        <section className="relative isolate flex items-center overflow-hidden bg-primary-800 px-5 py-6 sm:px-9 sm:py-7 lg:bg-[#f3f5f8] lg:px-11 lg:py-10 lg:[clip-path:polygon(0_0,100%_0,calc(100%_-_61px)_100%,0_100%)]">
          {SHARDS.map((shard) => (
            <span
              key={shard.band}
              aria-hidden="true"
              className={`pointer-events-none absolute -z-10 block ${shard.band} ${shard.panel}`}
              style={{ transform: SHARD_ANGLE }}
            />
          ))}

          <div className="relative mx-auto flex w-full max-w-lg items-center gap-4 text-left sm:gap-5 lg:flex-col lg:gap-0 lg:text-center">
            {/* Percent-encoded: the filename contains spaces and getAssetUrl
                concatenates the path without escaping it.

                The seal is transparent artwork whose quadrants are a dark
                green, so on the band's green it would lose everything but the
                gold laurel, so it sits on a white tile; the panel has no
                green behind it and so does not need one. */}
            <img
              src={getAssetUrl("assets/Login%20Logo%20Left.png")}
              alt="RMS PHINMA-COC seal"
              className="h-16 w-16 shrink-0 rounded-xl bg-white p-1.5 object-contain drop-shadow-sm sm:h-20 sm:w-20 sm:p-2 lg:h-36 lg:w-36 lg:rounded-none lg:bg-transparent lg:p-0"
            />

            <div className="min-w-0 lg:mt-7">
              <h1 className="font-heading text-[1.3rem] font-medium leading-tight tracking-tight text-white sm:text-[1.6rem] lg:text-[clamp(1.5rem,2.8vw,2.05rem)] lg:text-slate-700">
                RMS PHINMA-COC
              </h1>

              {/* white/90 rather than flat white, so the address sits under the
                  name instead of competing with it. It is the last step that
                  still clears 4.5:1 over the brightest shard — 4.79:1, against
                  4.16:1 at /80, which fails. */}
              <p className="mt-1 text-[0.72rem] leading-snug text-white/90 sm:text-[0.78rem] lg:mx-auto lg:mt-3 lg:max-w-sm lg:text-[0.82rem] lg:leading-relaxed lg:text-slate-500">
                Max Suniel St. Carmen, Cagayan de Oro City, Misamis Oriental,
                Philippines 9000
              </p>
            </div>
          </div>
        </section>

        {/* -------------------------------------------------- form column */}
        <section className="flex items-center justify-center px-5 py-7 sm:px-8 sm:py-9 lg:px-11">
          <div className="w-full max-w-[404px] animate-slide-up">
            {/* The mark keeps its own navy/green — it is official artwork, so
                it is not retinted to the portal palette. */}
            <header className="mb-6 flex items-center justify-center gap-3 sm:gap-4 lg:justify-start">
              <img
                src={getAssetUrl("assets/phinma-logo.png")}
                alt="PHINMA Education"
                className="h-[46px] w-[46px] shrink-0 object-contain sm:h-[56px] sm:w-[56px]"
              />
              <div className="min-w-0">
                <p className="font-heading text-[clamp(1.15rem,2.1vw,1.7rem)] font-normal leading-none tracking-[0.02em] text-slate-700">
                  PHINMA EDUCATION
                </p>
                <p className="mt-1.5 text-[0.6rem] font-medium uppercase tracking-[0.1em] text-slate-500 sm:text-[0.68rem]">
                  Making lives better through education
                </p>
              </div>
            </header>

            <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-[0_10px_30px_-22px_rgba(15,23,42,0.35)] sm:p-7">
              <div className="mb-5">
                <h2 className="font-heading text-[1.35rem] font-normal tracking-tight text-slate-600">
                  Sign In
                </h2>
                <div className="mt-2 h-[3px] w-[92px] rounded-full bg-primary-700" aria-hidden="true" />
              </div>

              <LoginForm onForgotClick={() => setResetOpen(true)} initialRetryAfter={restoreRetryAfter} />
            </div>

            <p className="mt-5 text-center text-xs text-slate-400">
              RMS PHINMA-COC &copy; {currentYear}
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}
