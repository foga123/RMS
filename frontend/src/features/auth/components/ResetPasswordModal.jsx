import React from "react";
import TurnstileChallenge from "./TurnstileChallenge";
// Imported one by one rather than through the ui barrel: that barrel
// re-exports Breadcrumb, which pulls in react-router-dom v7 -- ESM-only, and
// unresolvable by CRA's Jest. Reaching for the barrel here makes this dialog
// untestable for a component it never uses.
import Button from "../../../shared/components/ui/Button";
import Input from "../../../shared/components/ui/Input";
import Label from "../../../shared/components/ui/Label";
import { validatePassword } from "../../../shared/lib/passwordValidation";
import PasswordRequirements from "./PasswordRequirements";
import { sendResetCode, verifyResetCode, resetPassword, getResetCaptcha } from "../../../shared/services/api";
import { clearFailedLoginAttempts } from "../../../shared/lib/securityPolicy";
import useCountdown, { formatCountdown, secondsUntil } from "../../../shared/hooks/useCountdown";
import Swal from "sweetalert2";

/**
 * Resetting a password, one step at a time.
 *
 * The dialog used to show all four fields at once: email, code, new password,
 * confirm. Verification happened invisibly inside the submit handler, so the
 * only way to find out the code was wrong was to choose a password, press
 * Reset, and be told the code was the problem. The server has always spoken as
 * though this were a gated flow -- verify-reset-code.php answers "Verification
 * code confirmed. You can now reset your password." -- but nothing in the
 * interface ever showed a gate.
 *
 * Now the three steps are three steps:
 *
 *   1  Email      ask for the code
 *   2  Code       prove it arrived, on its own, with its own button
 *   3  Password   only reachable once the code is confirmed
 *
 * The password fields are not disabled at steps 1 and 2, they are not rendered.
 * A disabled field still invites a click and still has to explain itself; a
 * field that is not there yet asks nothing.
 *
 * Verification is deliberately NOT fired automatically on the sixth digit,
 * which is the usual trick for one-time codes. The server allows five attempts
 * before the code dies, and auto-firing spends one on every wrong sixth digit
 * -- mistype and correct it twice and the code is gone through no real fault.
 * An explicit button costs one press and leaves all five under the user's
 * control.
 */

function normalizeResetEmail(value) {
  return String(value || "").trim().toLowerCase();
}

/**
 * The three steps, and the sentence each one is asking for.
 *
 * The blurb is carried here rather than inside the step's own markup because it
 * belongs in the header, under the title, where it reads as the dialog telling
 * you what it wants — the same place at every step. Hunting for instructions
 * that move around the body is the thing this replaces.
 */
const STEPS = [
  { label: "Email", blurb: "Tell us which account, and we'll send a 6-digit code." },
  { label: "Code", blurb: "Enter the code from your inbox to prove it's you." },
  { label: "New password", blurb: "Choose a new password. You'll be signed in with it." },
];

/**
 * The progress rail.
 *
 * Bigger than it was: the markers were 20px circles with 10px numerals, which
 * is smaller than the body text they sit above and reads as decoration rather
 * than as position. At 28px with a 12px numeral the rail is the first thing the
 * eye lands on, which is what a progress indicator is for.
 *
 * The current step is named, never carried by colour alone — a done step shows
 * a tick and a muted label, the active one is filled and haloed, and both say
 * so in `aria-current` too.
 */
function StepRail({ current }) {
  return (
    <ol className="flex items-center gap-2" aria-label="Reset progress">
      {STEPS.map(({ label }, index) => {
        const stepNumber = index + 1;
        const done = stepNumber < current;
        const active = stepNumber === current;
        return (
          <li key={label} className="flex flex-1 items-center gap-2">
            <span
              aria-current={active ? "step" : undefined}
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold transition-all duration-200 ${
                done
                  ? "bg-primary-800 text-white"
                  : active
                  ? "bg-primary-800 text-white ring-4 ring-primary-800/15 scale-105"
                  : "bg-slate-100 text-slate-400 ring-1 ring-inset ring-slate-200"
              }`}
            >
              {done ? "✓" : stepNumber}
            </span>
            <span
              className={`truncate text-xs font-semibold ${
                active ? "text-slate-800" : done ? "text-slate-500" : "text-slate-400"
              }`}
            >
              {label}
            </span>
            {stepNumber < STEPS.length ? (
              <span
                aria-hidden="true"
                className={`h-0.5 flex-1 rounded-full transition-colors ${done ? "bg-primary-800/40" : "bg-slate-200"}`}
              />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

export default function ResetPasswordModal({ open, onClose }) {
  const [resetForm, setResetForm] = React.useState({ email: "", code: "", new_password: "", confirm_password: "" });
  const [resetError, setResetError] = React.useState("");
  const [codeSent, setCodeSent] = React.useState(false);
  const [codeSending, setCodeSending] = React.useState(false);
  const [resetMsg, setResetMsg] = React.useState("");
  const [resetSubmitting, setResetSubmitting] = React.useState(false);
  const [verifying, setVerifying] = React.useState(false);
  const [verifiedReset, setVerifiedReset] = React.useState(null);
  const [captcha, setCaptcha] = React.useState(null);
  const [captchaToken, setCaptchaToken] = React.useState("");
  const [captchaReset, setCaptchaReset] = React.useState(0);
  const [captchaLoading, setCaptchaLoading] = React.useState(false);
  const [captchaError, setCaptchaError] = React.useState("");
  const captchaRequest = React.useRef(0);
  const refreshCaptcha = React.useCallback(async () => {
    const request = ++captchaRequest.current;
    setCaptcha(null);
    setCaptchaToken("");
    setCaptchaError("");
    setCaptchaLoading(true);
    try {
      const challenge = await getResetCaptcha();
      if (request === captchaRequest.current) {
        if (!challenge?.site_key) throw new Error("CAPTCHA is not configured. Please contact an administrator.");
        setCaptcha(challenge);
      }
    } catch (error) {
      if (request === captchaRequest.current) setCaptchaError(error.message || "Could not load the CAPTCHA.");
    } finally {
      if (request === captchaRequest.current) setCaptchaLoading(false);
    }
  }, []);
  React.useEffect(() => {
    if (open) void refreshCaptcha();
    return () => { captchaRequest.current += 1; };
  }, [open, refreshCaptcha]);

  /*
   * Reveal the password being chosen.
   *
   * Worth having precisely here. Everywhere else a masked field is guarding
   * against a shoulder, but on this screen the user is INVENTING a password
   * against a live checklist, cannot see what they typed, and has to type it
   * again correctly underneath. Masking both boxes turns a typo into two failed
   * attempts and no explanation. One switch covers both fields, because
   * revealing one and masking the other defeats the point of the second.
   *
   * Off by default, and it never persists past the dialog closing.
   */
  const [showPasswords, setShowPasswords] = React.useState(false);

  /*
   * Both limits are the server's, not ours: send-reset-code.php answers with
   * `expires_at` (the code's 10-minute life) and `cooldown_ends_at` (the 60s
   * before another can be sent). The modal used to throw both away, so the
   * only way to discover either limit was to be refused by the server.
   */
  const [codeExpiresAt, setCodeExpiresAt] = React.useState(null);
  const [resendReadyAt, setResendReadyAt] = React.useState(null);

  const resendIn = useCountdown(resendReadyAt);
  const expiresIn = useCountdown(codeExpiresAt);

  /*
   * Expiry is read off the clock, NOT off the countdown's rendered value.
   *
   * useCountdown seeds its state in a useState initialiser, which runs only on
   * mount. On the render where a deadline goes from null to a timestamp the
   * hook is still returning the previous 0, so `expiresIn <= 0` is true for one
   * render on a deadline ten minutes away. Here that flashed "Expired" over a
   * code that had just been sent; on the verification below it was worse, and
   * silently threw away a confirmation the moment it arrived.
   *
   * secondsUntil() is the same function the hook derives from, so this stays in
   * step with the displayed number, and the hook's ticking is what re-renders
   * this component when the moment actually passes.
   */
  const codeExpired = Boolean(codeExpiresAt) && secondsUntil(codeExpiresAt) <= 0;

  /*
   * A confirmed code does not stay confirmed.
   *
   * The verification token is good for ten minutes, and someone reading the
   * password checklist and trying three passwords against it can spend that.
   * Counting it down here lets step 3 say so, and lets the flow fall back to
   * step 2 rather than failing a Reset press on a token the dialog already knew
   * was dead.
   */
  const verifiedUntil = verifiedReset?.expiresAt || null;
  const verifiedIn = useCountdown(verifiedUntil);
  const verificationExpired = Boolean(verifiedUntil) && secondsUntil(verifiedUntil) <= 0;
  const isVerified = Boolean(verifiedReset?.token) && !verificationExpired;

  const step = isVerified ? 3 : codeSent ? 2 : 1;

  // Reset form when modal opens/closes
  React.useEffect(() => {
    if (open) {
      setResetForm({ email: "", code: "", new_password: "", confirm_password: "" });
      setResetError("");
      setResetMsg("");
      setCodeSent(false);
      setCodeSending(false);
      setVerifying(false);
      setVerifiedReset(null);
      setCodeExpiresAt(null);
      setResendReadyAt(null);
      // Never carried across an open. A dialog that reopens with the password
      // already revealed is a surprise on a shared machine.
      setShowPasswords(false);
    }
  }, [open]);

  /*
   * Drop a dead token rather than leaving it in state looking usable.
   *
   * Without this the rail falls back to step 2 while `verifiedReset` still
   * holds a token, and any later path that tests for its presence rather than
   * re-checking the clock would send an expired one.
   */
  React.useEffect(() => {
    if (verificationExpired) {
      setVerifiedReset(null);
      setResetMsg("");
      setResetError("That confirmation has expired. Enter the code again to continue.");
    }
  }, [verificationExpired]);

  if (!open) return null;

  /** Back to step 1, with the code and anything typed after it discarded. */
  const startOver = () => {
    setCodeSent(false);
    setVerifiedReset(null);
    setCodeExpiresAt(null);
    setResetForm((f) => ({ ...f, code: "", new_password: "", confirm_password: "" }));
    setResetError("");
    setResetMsg("");
    setShowPasswords(false);
  };

  const handleSendCode = async () => {
    if (codeSending || resendIn > 0) return;
    if (!resetForm.email) {
      setResetError("Email is required");
      return;
    }
    if (!captchaToken) {
      setResetError("Complete the CAPTCHA before requesting a code.");
      return;
    }
    setResetError("");
    setResetMsg("");
    setCodeSending(true);
    try {
      const response = await sendResetCode(resetForm.email, captchaToken);
      setCodeSent(true);
      setVerifiedReset(null);
      setCodeExpiresAt(response?.expires_at || null);
      setResendReadyAt(response?.cooldown_ends_at || null);
      // Sending replaces the stored code, so anything already typed is dead.
      // Clearing it beats letting the user submit it and be told it is wrong.
      setResetForm((f) => ({ ...f, code: "" }));
      setResetMsg(response?.message || "Verification code sent. Check your inbox and spam/junk folder.");
    } catch (err) {
      // A 429 carries the deadlines of the code that is still in play.
      const data = err?.data || {};
      if (data.cooldown_ends_at) setResendReadyAt(data.cooldown_ends_at);
      if (data.expires_at) {
        setCodeExpiresAt(data.expires_at);
        setCodeSent(true);
      }
      setResetError(err.message || "Failed to send code");
    } finally {
      setCodeSending(false);
      setCaptchaToken("");
      setCaptchaReset((value) => value + 1);
    }
  };

  /**
   * Step 2, on its own.
   *
   * This is the point of the change: the code is checked here, against a button
   * the user pressed, and the answer -- including the "3 attempts remaining"
   * the server already writes -- arrives before anyone has typed a password.
   */
  const handleVerifyCode = async () => {
    if (verifying) return;

    const trimmedCode = String(resetForm.code).trim();
    if (!/^[0-9]{6}$/.test(trimmedCode)) {
      setResetError("Enter the 6-digit verification code");
      return;
    }
    // The server would reject this anyway; saying so here costs the user
    // nothing and avoids spending one of their five verification attempts.
    if (codeExpired) {
      setResetError("That verification code has expired. Send a new one.");
      return;
    }

    setResetError("");
    setResetMsg("");
    setVerifying(true);
    try {
      const response = await verifyResetCode(resetForm.email, trimmedCode);
      const verificationToken = response?.verification?.verification_token || "";
      if (!verificationToken) {
        throw new Error("Verification completed but the server did not return a usable reset token.");
      }

      setVerifiedReset({
        email: normalizeResetEmail(resetForm.email),
        code: trimmedCode,
        token: verificationToken,
        expiresAt: response?.verification?.verification_expires_at || null,
      });
      setResetMsg(response?.message || "Code confirmed. Choose your new password.");
    } catch (err) {
      setResetError(err.message || "Failed to verify code");
    } finally {
      setVerifying(false);
    }
  };

  const handleSubmit = async () => {
    /*
     * Verification is a step now, not something this handler does on the way
     * past. It used to call verifyResetCode() itself whenever the token was
     * missing, which is exactly what made a wrong code surface as a failed
     * password reset.
     */
    if (!isVerified) {
      setResetError("Confirm the verification code first.");
      return;
    }
    if (!resetForm.new_password) {
      setResetError("New password is required");
      return;
    }
    if (resetForm.new_password !== resetForm.confirm_password) {
      setResetError("Passwords do not match");
      return;
    }
    const strength = validatePassword(resetForm.new_password);
    if (!strength.valid) {
      setResetError(strength.error);
      return;
    }

    setResetError("");
    setResetMsg("");
    setResetSubmitting(true);
    try {
      const res = await resetPassword(resetForm.email, resetForm.new_password, verifiedReset.token);
      clearFailedLoginAttempts(resetForm.email);
      setResetMsg(res?.message || "Password updated");
      setVerifiedReset(null);
      onClose();
      Swal.fire({
        icon: "success",
        title: "Password updated",
        text: "Please sign in with your new password.",
        confirmButtonColor: "#059669",
      });
    } catch (err) {
      setResetError(err.message || "Failed to reset password");
      Swal.fire({
        icon: "error",
        title: "Reset failed",
        text: err.message || "Failed to reset password",
        confirmButtonColor: "#ef4444",
      });
    } finally {
      setResetSubmitting(false);
    }
  };

  /** Enter does the step being filled in, not the one at the bottom. */
  const submitCurrentStep = () => {
    if (step === 1) {
      void handleSendCode();
      return;
    }
    if (step === 2) {
      void handleVerifyCode();
      return;
    }
    void handleSubmit();
  };

  return (
    <div className="auth-no-zoom fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-sm animate-fade-in" aria-modal="true" role="dialog" onClick={onClose}>
      {/* Four fields, a live checklist and two footer buttons add up to more
          than a phone screen. Without a ceiling the dialog simply grew past the
          viewport and the Reset button became unreachable — there is nothing to
          scroll, because the backdrop is fixed. Capping the height and letting
          the body scroll keeps the footer on screen at any size; on a desktop
          the content never reaches the cap, so nothing changes there. */}
      {/* max-w-md rather than max-w-sm: at 384px the code field, the step rail
          and the password checklist were all fighting for the same line width,
          and the three rail labels truncated on the narrowest phones. 448px
          gives each of them room without the dialog reading as a page. */}
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[calc(100dvh-2rem)] flex flex-col shadow-2xl border border-white overflow-hidden animate-slide-up" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="shrink-0 px-6 pt-5 pb-4 border-b border-slate-100 bg-slate-50/60">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-lg font-heading font-bold text-slate-800 leading-tight">Reset Password</h2>
              {/* What this step wants, in one sentence, in the same place every
                  time. Previously the only instruction was a line of small grey
                  text under the email field that vanished at step two, so steps
                  two and three explained themselves with nothing but a label. */}
              <p className="mt-1 text-sm text-slate-500 leading-snug">{STEPS[step - 1].blurb}</p>
            </div>
            <button
              onClick={onClose}
              className="-mr-1.5 -mt-1 shrink-0 p-2 text-slate-400 hover:text-slate-600 hover:bg-slate-200/70 rounded-full transition-colors touch-manipulation"
              aria-label="Close"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M18 6L6 18"></path>
                <path d="M6 6l12 12"></path>
              </svg>
            </button>
          </div>
          <div className="mt-4">
            <StepRail current={step} />
          </div>
        </div>

        {/* Body */}
        <form
          className="min-h-0 flex-1 overflow-y-auto px-6 py-5 space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            submitCurrentStep();
          }}
        >
          {resetError && (
            <div
              role="alert"
              className="flex items-start gap-2.5 bg-red-50 text-red-700 px-4 py-3 rounded-xl text-sm border border-red-100 font-medium"
            >
              <span
                aria-hidden="true"
                className="mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-red-600 text-[10px] font-bold text-white"
              >
                !
              </span>
              <span className="leading-snug">{resetError}</span>
            </div>
          )}

          {/* ------------------------------------------------------- step one */}
          {step === 1 ? (
            <div>
              <Label htmlFor="reset-email">Email Address</Label>
              {/* No Send button beside the field any more. The footer carries the
                  one action this step allows, and a second copy next to the input
                  was both a duplicate control and the thing that used to squeeze
                  the email box down to about ten visible characters on a phone --
                  "Resend in 09:41" is a wide label to hold beside a field. */}
              <Input
                id="reset-email"
                type="email"
                autoComplete="email"
                autoFocus
                value={resetForm.email}
                onChange={(event) => setResetForm((f) => ({ ...f, email: event.target.value }))}
                /* The same example as the sign-in field, so the two screens ask
                   for the same thing in the same words. */
                placeholder="admin@gmail.com"
                className="py-2.5"
              />
              <p className="mt-2 text-xs text-slate-500 leading-relaxed">
                Use your <span className="font-semibold text-slate-600">@phinmaed.com</span> email —
                the same one you sign in with. If it isn't registered no code is sent, and this page
                says the same thing either way, so nobody can use it to discover who has an account.
              </p>
            </div>
          ) : (
            /* The address the code went to, kept in view at every later step so
               nobody hunts an inbox for a code sent somewhere they mistyped. */
            <div className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
              <div className="flex min-w-0 items-center gap-3">
                <span
                  aria-hidden="true"
                  className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-slate-400 ring-1 ring-slate-200"
                >
                  <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="2" y="4" width="20" height="16" rx="2"></rect>
                    <path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"></path>
                  </svg>
                </span>
                <div className="min-w-0">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Code sent to</p>
                  <p className="truncate text-sm font-semibold text-slate-700">{resetForm.email}</p>
                </div>
              </div>
              <button
                type="button"
                onClick={startOver}
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 hover:text-primary-900"
              >
                Change
              </button>
            </div>
          )}

          {(step === 1 || step === 2) && (step === 1 || resendIn <= 0) ? (
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              {captchaLoading ? <p className="text-sm text-slate-500">Loading security verification...</p> : captcha?.site_key ?
                <TurnstileChallenge siteKey={captcha.site_key} action="password_reset" onToken={setCaptchaToken} resetKey={captchaReset} /> : null}
              {captchaError ? <button type="button" onClick={refreshCaptcha} className="mt-2 text-xs text-primary-700">Reload verification</button> : null}
              {captchaError ? <p role="alert" className="mt-2 text-xs text-red-600">{captchaError}</p> : null}
            </div>
          ) : null}

          {/* ------------------------------------------------------- step two */}
          {step === 2 ? (
            <div>
              <div className="flex items-baseline justify-between gap-2">
                <Label htmlFor="reset-code">Verification Code</Label>
                {/* The state is always spelled out, never carried by colour alone. */}
                {codeExpired ? (
                  <span className="text-xs font-semibold text-red-600">Expired</span>
                ) : expiresIn > 0 ? (
                  <span className={`text-xs font-medium tabular-nums ${expiresIn <= 60 ? "text-amber-600" : "text-slate-500"}`}>
                    Expires in {formatCountdown(expiresIn)}
                  </span>
                ) : null}
              </div>
              <Input
                id="reset-code"
                type="text"
                /* Brings up the number pad on a phone, and lets iOS and Android
                   offer the code straight from the notification. */
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                value={resetForm.code}
                onChange={(event) => {
                  // Digits only. A pasted "123 456" or "Code: 123456" otherwise
                  // fails the format check and reads as the user's mistake.
                  const nextCode = event.target.value.replace(/\D/g, "").slice(0, 6);
                  setResetForm((f) => ({ ...f, code: nextCode }));
                  if (resetError) setResetError("");
                }}
                placeholder="000000"
                /* The one field on this screen worth making large. It holds six
                   characters that are read off a phone and typed back, usually
                   in a hurry, and at body size a transposed digit is genuinely
                   hard to spot. Wide tracking separates the digits so the value
                   can be proofread against the email at a glance. */
                className="py-3.5 tracking-[0.45em] indent-[0.45em] font-mono text-center text-2xl font-semibold placeholder:tracking-[0.45em] placeholder:text-slate-300 placeholder:font-normal"
                /* No maxLength: the browser applies it to the raw pasted text,
                   before onChange gets to strip the separators out. Pasting the
                   perfectly good "123 456" was cut to "123 45" and then cleaned
                   to a five-digit code that could never verify. The handler
                   above already caps the value at six digits. */
              />
              {codeExpired ? (
                <p className="mt-2 text-xs font-medium text-red-500">
                  This code is no longer valid. Send a new one to continue.
                </p>
              ) : null}
              {resetMsg && !resetError ? (
                <div className="mt-2 text-primary-700 text-xs font-medium">{resetMsg}</div>
              ) : null}

              {/* A row rather than a bare link: the resend was an 11px underline
                  with no padding, which is under the 44px touch target a thumb
                  needs and gave the cooldown nowhere legible to appear. */}
              <div className="mt-4 flex items-center justify-between gap-3 border-t border-slate-100 pt-3">
                <p className="text-xs text-slate-500">Didn't get it? Check spam or junk.</p>
                <button
                  type="button"
                  onClick={handleSendCode}
                  disabled={codeSending || resendIn > 0 || captchaLoading || !captchaToken}
                  className="shrink-0 rounded-lg px-3 py-2 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 hover:text-primary-900 disabled:cursor-not-allowed disabled:bg-transparent disabled:text-slate-400"
                >
                  {codeSending ? "Sending..." : resendIn > 0 ? `Resend in ${formatCountdown(resendIn)}` : "Resend code"}
                </button>
              </div>
            </div>
          ) : null}

          {/* ----------------------------------------------------- step three */}
          {step === 3 ? (
            <>
              <div className="flex items-center gap-3 rounded-xl border border-emerald-100 bg-emerald-50 px-4 py-3">
                <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-emerald-600 text-sm font-bold text-white">
                  {"✓"}
                </span>
                <p className="text-sm font-semibold text-emerald-800">
                  Code confirmed
                  {verifiedIn > 0 ? (
                    <span className="block text-xs font-normal text-emerald-700">
                      Finish within {formatCountdown(verifiedIn)}
                    </span>
                  ) : null}
                </p>
              </div>

              <div>
                <div className="flex items-baseline justify-between gap-2">
                  <Label htmlFor="reset-new-password">New Password</Label>
                  {/* One switch for both fields — see the note on showPasswords. */}
                  <button
                    type="button"
                    onClick={() => setShowPasswords((shown) => !shown)}
                    aria-pressed={showPasswords}
                    className="-mt-0.5 rounded-lg px-2 py-1 text-xs font-semibold text-primary-700 transition-colors hover:bg-primary-50 hover:text-primary-900"
                  >
                    {showPasswords ? "Hide" : "Show"}
                  </button>
                </div>
                <Input
                  id="reset-new-password"
                  type={showPasswords ? "text" : "password"}
                  autoComplete="new-password"
                  autoFocus
                  value={resetForm.new_password}
                  onChange={(event) => setResetForm((f) => ({ ...f, new_password: event.target.value }))}
                  placeholder="Enter new password"
                  className="py-2.5"
                />
                <PasswordRequirements value={resetForm.new_password} style={{ marginTop: 10, gap: 5 }} />
              </div>

              <div>
                <Label htmlFor="reset-confirm-password">Confirm Password</Label>
                <Input
                  id="reset-confirm-password"
                  type={showPasswords ? "text" : "password"}
                  autoComplete="new-password"
                  value={resetForm.confirm_password}
                  onChange={(event) => setResetForm((f) => ({ ...f, confirm_password: event.target.value }))}
                  placeholder="Confirm new password"
                  className="py-2.5"
                />
                {/*
                  Both answers, not just the unhappy one. A confirm field that
                  is silent when correct leaves the user checking two masked
                  boxes against each other by eye before they dare press the
                  button; saying "Passwords match" costs a line and ends that.
                */}
                {resetForm.confirm_password ? (
                  resetForm.new_password !== resetForm.confirm_password ? (
                    <p className="mt-2 text-xs font-medium text-red-500">Passwords do not match.</p>
                  ) : (
                    <p className="mt-2 text-xs font-medium text-emerald-600">✓ Passwords match</p>
                  )
                ) : null}
              </div>
            </>
          ) : null}

          {/* Lets Enter submit the step being filled in. */}
          <button type="submit" className="hidden" tabIndex={-1} aria-hidden="true" />
        </form>

        {/*
          Footer.

          The primary action is full-width-ish and comes second in the DOM, so
          it is the last thing a screen reader reaches and the rightmost thing a
          thumb reaches. Cancel is deliberately quiet: on this screen it throws
          away a code the user waited for.
        */}
        <div className="shrink-0 px-6 py-4 border-t border-slate-100 bg-slate-50/60 flex justify-end gap-3">
          <Button variant="outline" className="!rounded-xl !px-5 !py-2.5" onClick={onClose}>
            Cancel
          </Button>
          {/* One action per step, so the primary button is never something the
              user is not yet allowed to do. */}
          {step === 1 ? (
            <Button
              className="!rounded-xl !px-6 !py-2.5 bg-primary-800 text-white hover:bg-primary-900 shadow-lg shadow-primary-900/20"
              onClick={handleSendCode}
              disabled={codeSending || resendIn > 0 || !resetForm.email || captchaLoading || !captchaToken}
            >
              {codeSending ? "Sending..." : resendIn > 0 ? `Resend in ${formatCountdown(resendIn)}` : "Send Code"}
            </Button>
          ) : step === 2 ? (
            <Button
              className="!rounded-xl !px-6 !py-2.5 bg-primary-800 text-white hover:bg-primary-900 shadow-lg shadow-primary-900/20"
              onClick={handleVerifyCode}
              disabled={verifying || codeExpired || resetForm.code.length !== 6}
            >
              {verifying ? "Verifying..." : "Verify Code"}
            </Button>
          ) : (
            <Button
              className="!rounded-xl !px-6 !py-2.5 bg-primary-800 text-white hover:bg-primary-900 shadow-lg shadow-primary-900/20"
              onClick={handleSubmit}
              disabled={resetSubmitting}
            >
              {resetSubmitting ? "Updating..." : "Reset Password"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
