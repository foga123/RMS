import React, { useEffect, useState } from "react";
import Swal from "sweetalert2";
import TurnstileChallenge from "./TurnstileChallenge";
import { Label } from "../../../shared/components/ui";
import { getLoginCaptchaPolicy, login } from "../../../shared/services/api";
import { getUserFirstName, setAuthUser } from "../../../shared/lib/auth";
import { setAccessToken } from "../../../shared/lib/authToken";
import { logAuditEvent } from "../../../shared/lib/audit";
import { getDashboardPathForUser } from "../../../shared/lib/roles";
import { getAppUrl } from "../../../shared/lib/url";
import {
  clearFailedLoginAttempts,
  getLockoutStatus,
  getMaxPasswordLength,
  recordFailedLoginAttempt,
} from "../../../shared/lib/securityPolicy";
import { startSession } from "../../../shared/lib/session";
import useCountdown, { deadlineFromSeconds } from "../../../shared/hooks/useCountdown";

// Named for the glyph, not the field: this is a person, not an envelope.
const UserIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M20 21a8 8 0 0 0-16 0"></path><circle cx="12" cy="7" r="4"></circle>
  </svg>
);

const AlertIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <circle cx="12" cy="12" r="10"></circle><path d="M12 8v4"></path><path d="M12 16h.01"></path>
  </svg>
);

const SignInIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"></path>
    <path d="M10 17l5-5-5-5"></path><path d="M15 12H3"></path>
  </svg>
);

/**
 * Underline fields, icon parked on the right rail. The shared `Input` is built
 * for boxed fields and would need an `!important` override on every border and
 * ring utility to get here, so these are plain inputs sharing one class.
 */
// The underline is 2px at rest rather than 1px so the focus colour change is
// the only thing that moves — bumping the width on focus shifts the field.
//
// Two sizes. Below `sm` the row is 44px tall and the text is a full 16px:
// anything under 16px makes iOS Safari zoom the viewport the moment the field
// takes focus, and it does not zoom back out afterwards. From `sm` up the
// original 36px/13.6px field is restored unchanged.
const FIELD =
  "peer h-11 w-full appearance-none border-0 border-b-2 border-slate-200 bg-transparent px-0 pr-9 text-base text-slate-800 placeholder-slate-400 transition-colors hover:border-slate-300 focus:border-primary-700 focus:outline-none focus:ring-0 sm:h-9 sm:pr-8 sm:text-[0.85rem]";

/**
 * Invisible padding around the two icon-only buttons. Both draw a 15px glyph,
 * which leaves a hit area well under the 44px a fingertip needs; growing the
 * real padding instead would move the icons off the edge they are aligned to.
 */
const TOUCH_TARGET = "after:absolute after:-inset-2.5 after:content-[''] sm:after:hidden";

const EyeIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7z"></path><circle cx="12" cy="12" r="3"></circle>
  </svg>
);

const EyeOffIcon = ({ className }) => (
  <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.94 10.94 0 0 1 12 20c-7 0-11-8-11-8a21.77 21.77 0 0 1 5.06-5.94"></path><path d="M9.9 4.24A10.94 10.94 0 0 1 12 4c7 0 11 8 11 8a21.77 21.77 0 0 1-3.2 4.49"></path><path d="M1 1l22 22"></path>
  </svg>
);

function formatCountdown(totalSeconds) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = String(Math.floor(safeSeconds / 60)).padStart(2, "0");
  const seconds = String(safeSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

export default function LoginForm({ onForgotClick, initialRetryAfter = null }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  /*
   * When the server answers 429 it says how long to wait, and the button stays
   * off until then. Submitting anyway would only be refused again - and on a
   * device limit, every refusal is another strike toward a longer block.
   * The server enforces this regardless; the countdown is so the person can see
   * it instead of guessing.
   */
  const [rateLimitDeadline, setRateLimitDeadline] = useState(null);
  const rateLimitSeconds = useCountdown(rateLimitDeadline);

  useEffect(() => {
    if (!initialRetryAfter) return;
    setRateLimitDeadline(deadlineFromSeconds(initialRetryAfter));
    setError("Too many requests from this device. Please wait before signing in.");
  }, [initialRetryAfter]);
  const [captchaEnabled, setCaptchaEnabled] = useState(true);
  const [captchaPolicyLoading, setCaptchaPolicyLoading] = useState(true);
  const [siteKey, setSiteKey] = useState("");
  const [captchaToken, setCaptchaToken] = useState("");
  const [captchaReset, setCaptchaReset] = useState(0);
  useEffect(() => {
    let active = true;
    getLoginCaptchaPolicy().then((data) => {
      if (!active) return;
      setCaptchaEnabled(data?.policy?.login_captcha_enabled !== false);
      setSiteKey(data?.policy?.captcha?.site_key || "");
    }).catch(() => { if (active) setError("Security settings could not load. Please refresh the page."); })
      .finally(() => { if (active) setCaptchaPolicyLoading(false); });
    return () => { active = false; };
  }, []);

  const handleSubmit = async (e) => {
    e.preventDefault();
    // Enter in a field submits even while the button is disabled.
    if (loading || rateLimitSeconds > 0) return;
    setError("");

    if (captchaPolicyLoading) {
      setError("Security settings are still loading. Try again in a moment.");
      return;
    }

    // Validations
    const lockStatus = getLockoutStatus(email);
    if (lockStatus.locked) {
      const minutesRemaining = Math.max(1, Math.ceil(lockStatus.remainingMs / 60000));
      const message = `Account locked due to failed login attempts. Try again in ${minutesRemaining} minute(s).`;
      setError(message);
      logAuditEvent({ action: "login_locked", detail: message, user: { email } });
      await Swal.fire({ icon: "error", title: "Account Locked", text: message, confirmButtonColor: "var(--danger-600)" });
      return;
    }

    const maxPasswordLength = getMaxPasswordLength();
    if (String(password || "").length > maxPasswordLength) {
      const detail = `Password exceeds maximum length (${maxPasswordLength}).`;
      setError(detail);
      logAuditEvent({ action: "login_rejected", detail, user: { email } });
      return;
    }

    if (captchaEnabled && !captchaToken) {
      setError("Complete the security verification before signing in.");
      return;
    }

    setLoading(true);
    try {
      const res = await login(email, password, captchaToken);
      setAuthUser(res.user);
      // Present from JWT phase 2 onward. Absent on an older backend, in which
      // case the session cookie keeps authenticating exactly as before.
      if (res.access_token) {
        setAccessToken(res.access_token);
      }
      startSession();
      clearFailedLoginAttempts(email);
      logAuditEvent({ action: "login", user: res.user });

      const mustChangePassword = Boolean(res.user?.password_expiration?.force_password_change || res.user?.password_expiration?.is_expired);
      const destination = mustChangePassword ? "/change-password" : getDashboardPathForUser(res.user);
      const firstName = getUserFirstName(res.user);

      await Swal.fire({
        icon: "success",
        title: `Welcome, ${firstName}!`,
        text: "Login successful.",
        toast: true,
        position: "top-end",
        timer: 1500,
        timerProgressBar: true,
        showConfirmButton: false,
      });

      // getAppUrl, not the bare route: the router is mounted at a basename, so
      // the raw path asks Apache for it at the site root and 404s in the built
      // app. See getAppUrl in lib/url.js.
      const target = getAppUrl(destination);
      if (destination && window.location.pathname !== target) {
        window.location.replace(target);
      }
    } catch (err) {
      setError(err.message);

      // Refused before the password was even checked: not a failed attempt, so
      // the local counter is left alone, and the server's own wait is shown
      // rather than one this browser invented.
      if (err?.status === 429) {
        const wait = Number(err?.data?.retry_after ?? err?.data?.retry_after_seconds);
        setRateLimitDeadline(deadlineFromSeconds(Number.isFinite(wait) && wait > 0 ? wait : 60));
        logAuditEvent({ action: "login_rate_limited", detail: err?.message || "Too many attempts.", user: { email } });
        return;
      }

      if (err?.status !== 401) return;
      const lockInfo = recordFailedLoginAttempt(email);
      logAuditEvent({ action: "login_failed", detail: err?.message || "Login failed.", user: { email } });
      if (lockInfo.locked) await handleLock(lockInfo);
    } finally {
      setLoading(false);
      setCaptchaToken("");
      setCaptchaReset((value) => value + 1);
    }
  };

  const handleLock = async (lockInfo) => {
    const minutesRemaining = Math.max(1, Math.ceil(lockInfo.remainingMs / 60000));
    await Swal.fire({
      icon: "error",
      title: "Account Locked",
      text: `Account locked due to failed login attempts. Try again in ${minutesRemaining} minute(s).`,
      confirmButtonColor: "var(--danger-600)",
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex w-full flex-col gap-5">
      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 rounded-md border border-red-200 bg-red-50 px-3.5 py-3 text-sm leading-relaxed text-red-700"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/*
        The field is called Username and accepts an email address, and nothing
        else: login.php matches on `u.email` alone — there is no username column
        to match against. "Enter Username" was therefore an instruction the
        server could not honour, and the only way to discover that was to be
        told "no account matches this email" after guessing wrong.

        The label keeps the word people here already use for this box. What
        changed is that the placeholder and the hint now show the shape of the
        thing to type: 203 of the 216 staff accounts are first.mi.last, so the
        example is a real pattern rather than a generic user@example.com.
      */}
      <div>
        <Label htmlFor="login-email" required>
          Username
        </Label>
        <div className="relative">
          <input
            id="login-email"
            /* type="email" is deliberately NOT used. It would add the browser's
               own "please include an @" bubble on top of this form's error
               handling, and it rejects the trailing space people paste in from
               a directory rather than trimming it the way login.php does. */
            type="text"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            autoComplete="username"
            placeholder="admin@gmail.com"
            aria-describedby="login-email-hint"
            aria-invalid={error ? "true" : undefined}
            className={FIELD}
          />
          <UserIcon className="pointer-events-none absolute right-0 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-slate-400 transition-colors peer-focus:text-primary-700" />
        </div>
        <p id="login-email-hint" className="mt-1.5 text-xs leading-snug text-slate-500">
          Use your <span className="font-semibold text-slate-600">@phinmaed.com</span> email address.
        </p>
      </div>

      <div>
        <Label htmlFor="login-password" required>
          Password
        </Label>
        <div className="relative">
          <input
            id="login-password"
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="Enter Password"
            autoComplete="current-password"
            aria-invalid={error ? "true" : undefined}
            className={FIELD}
          />
          <button
            type="button"
            onClick={() => setShowPassword((s) => !s)}
            className={`absolute right-0 top-1/2 -translate-y-1/2 touch-manipulation p-1 text-slate-400 transition-colors hover:text-primary-700 focus-visible:text-primary-700 focus-visible:outline-none ${TOUCH_TARGET}`}
            aria-label={showPassword ? "Hide password" : "Show password"}
            aria-pressed={showPassword}
          >
            {/* The glyph reports the state, not the action: a slashed eye while
                the password is masked, an open eye once it is readable. The
                aria-label still names the action, which is what a screen reader
                wants from a button. */}
            {showPassword ? <EyeIcon className="h-[15px] w-[15px]" /> : <EyeOffIcon className="h-[15px] w-[15px]" />}
          </button>
        </div>
      </div>

      {captchaPolicyLoading ? <p className="text-xs text-slate-500">Checking security settings...</p>
        : captchaEnabled ? <TurnstileChallenge siteKey={siteKey} action="login" onToken={setCaptchaToken} resetKey={captchaReset} /> : null}

      <div className="mt-1 flex flex-col items-center gap-3">
        <button
          type="submit"
          disabled={loading || captchaPolicyLoading || rateLimitSeconds > 0 || (captchaEnabled && !captchaToken)}
          /* Full width and 44px tall on a phone — a touch screen has no hover,
             so `active:` is the only press feedback there is. The 204px cap
             and the 40px height come back at `sm`. */
          className="group inline-flex h-11 w-full touch-manipulation items-center justify-center gap-2 rounded-md bg-primary-800 text-[0.85rem] font-semibold text-white shadow-sm transition-colors hover:bg-primary-900 active:bg-primary-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:bg-primary-800 sm:h-10 sm:max-w-[204px]"
        >
          {loading ? (
            <>
              <svg className="h-4 w-4 animate-spin" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" aria-hidden="true">
                <path d="M21 12a9 9 0 1 1-6.219-8.56" />
              </svg>
              Signing in…
            </>
          ) : captchaPolicyLoading ? (
            "Checking security…"
          ) : rateLimitSeconds > 0 ? (
            <span className="tabular-nums">Try again in {formatCountdown(rateLimitSeconds)}</span>
          ) : (
            <>
              Sign In
              <SignInIcon className="h-[15px] w-[15px] transition-transform group-hover:translate-x-0.5" />
            </>
          )}
        </button>

        <button
          type="button"
          onClick={onForgotClick}
          className="touch-manipulation py-2 text-sm font-medium text-primary-700 underline-offset-4 transition-colors hover:text-primary-900 hover:underline focus-visible:underline focus-visible:outline-none sm:py-0"
        >
          Forgot Password
        </button>
      </div>
    </form>
  );
}
