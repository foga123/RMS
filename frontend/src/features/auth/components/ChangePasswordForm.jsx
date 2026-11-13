import React, { useState } from "react";
import { Button, Input, Label } from "../../../shared/components/ui";
import PasswordRequirements from "./PasswordRequirements";
import { changeOwnPassword, requestPasswordChangeCode } from "../../../shared/services/api";
import { validatePassword } from "../../../shared/lib/passwordValidation";
import useCountdown, { deadlineFromSeconds, formatCountdown } from "../../../shared/hooks/useCountdown";
import { color, font, radius } from "../../../shared/theme/tokens";

/**
 * OTP-gated password change, as a standalone form.
 *
 * Both the forced /change-password page and the Profile modal render this, so
 * the rules (current password + emailed code, single-use, 60s resend cooldown)
 * can only be defined once. The backend enforces the same rules regardless of
 * which surface calls it — this component just drives change-password.php.
 */
export default function ChangePasswordForm({
  onSuccess,
  footer = null,
  submitLabel = "Update Password",
  autoFocus = false,
}) {
  const [form, setForm] = useState({
    current_password: "",
    new_password: "",
    confirm_password: "",
    otp: "",
  });
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sendingCode, setSendingCode] = useState(false);
  const [codeNotice, setCodeNotice] = useState("");

  /*
   * Both limits come from change-password.php: `cooldown_seconds` before another
   * code can be sent, `expires_in` for how long this one lives. They are held as
   * deadlines rather than as counters so a backgrounded tab cannot fall behind —
   * see useCountdown.
   */
  const [resendReadyAt, setResendReadyAt] = useState(null);
  const [codeExpiresAt, setCodeExpiresAt] = useState(null);

  const resendIn = useCountdown(resendReadyAt);
  const expiresIn = useCountdown(codeExpiresAt);
  const codeExpired = Boolean(codeExpiresAt) && expiresIn <= 0;

  const setField = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const handleSendCode = async () => {
    if (sendingCode || resendIn > 0) return;
    setError("");
    setCodeNotice("");
    setSendingCode(true);
    try {
      const result = await requestPasswordChangeCode();
      setCodeNotice(
        result?.sent_to ? `Verification code sent to ${result.sent_to}.` : "Verification code sent."
      );
      setResendReadyAt(deadlineFromSeconds(result?.cooldown_seconds ?? 60));
      setCodeExpiresAt(deadlineFromSeconds(result?.expires_in ?? 600));
      // Issuing a code replaces the last one, so anything already typed is dead.
      setField("otp", "");
    } catch (err) {
      // The backend returns the remaining wait on a 429.
      const wait = Number(err?.data?.cooldown_seconds);
      if (Number.isFinite(wait) && wait > 0) setResendReadyAt(deadlineFromSeconds(wait));
      setError(err?.message || "Failed to send the verification code.");
    } finally {
      setSendingCode(false);
    }
  };

  const handleSubmit = async (event) => {
    event.preventDefault();
    setError("");

    if (!form.current_password || !form.new_password) {
      setError("Current password and new password are required.");
      return;
    }
    if (!form.otp.trim()) {
      setError("Enter the verification code we emailed you.");
      return;
    }
    // Saying so here avoids spending one of the five server-side attempts.
    if (codeExpired) {
      setError("That verification code has expired. Send a new one.");
      return;
    }
    if (form.new_password !== form.confirm_password) {
      setError("Passwords do not match.");
      return;
    }
    const strength = validatePassword(form.new_password);
    if (!strength.valid) {
      setError(strength.error);
      return;
    }

    setSubmitting(true);
    try {
      const payload = await changeOwnPassword(form);
      setForm({ current_password: "", new_password: "", confirm_password: "", otp: "" });
      setCodeNotice("");
      setCodeExpiresAt(null);
      await onSuccess?.(payload);
    } catch (err) {
      setError(err?.message || "Failed to change password.");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="grid gap-4">
      {error ? (
        <div
          style={{
            borderRadius: radius.xl,
            border: `1px solid ${color.status.dangerBorder}`,
            background: color.status.dangerBg,
            color: color.status.dangerText,
            padding: "9px 12px",
            fontSize: font.size.md,
            fontWeight: font.weight.medium,
          }}
        >
          {error}
        </div>
      ) : null}

      <div className="grid gap-2">
        <Label htmlFor="current-password" required>Current Password</Label>
        <Input
          id="current-password"
          type="password"
          autoFocus={autoFocus}
          value={form.current_password}
          onChange={(event) => setField("current_password", event.target.value)}
          autoComplete="current-password"
          placeholder="Enter current password"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="new-password" required>New Password</Label>
        <Input
          id="new-password"
          type="password"
          value={form.new_password}
          onChange={(event) => setField("new_password", event.target.value)}
          autoComplete="new-password"
          placeholder="Enter new password"
        />
        <PasswordRequirements value={form.new_password} style={{ marginTop: 2 }} />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="confirm-password" required>Confirm New Password</Label>
        <Input
          id="confirm-password"
          type="password"
          value={form.confirm_password}
          onChange={(event) => setField("confirm_password", event.target.value)}
          autoComplete="new-password"
          placeholder="Confirm new password"
        />
        {form.confirm_password && form.new_password !== form.confirm_password ? (
          <p style={{ fontSize: font.size.sm, fontWeight: font.weight.medium, color: color.status.dangerText }}>
            Passwords do not match.
          </p>
        ) : null}
      </div>

      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-2">
          <Label htmlFor="otp-code" required>Email Verification Code</Label>
          {/* Never colour alone: the timer and the word both say what state it is in. */}
          {codeExpired ? (
            <span style={{ fontSize: font.size.sm, fontWeight: font.weight.semibold, color: color.status.dangerText }}>
              Expired
            </span>
          ) : expiresIn > 0 ? (
            <span
              style={{
                fontSize: font.size.sm,
                fontWeight: font.weight.medium,
                fontVariantNumeric: "tabular-nums",
                color: expiresIn <= 60 ? color.status.warningText : color.text.muted,
              }}
            >
              Expires in {formatCountdown(expiresIn)}
            </span>
          ) : null}
        </div>
        <div className="flex items-start gap-2">
          <Input
            id="otp-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={form.otp}
            onChange={(event) => setField("otp", event.target.value.replace(/\D/g, "").slice(0, 6))}
            placeholder="6-digit code"
            style={{ letterSpacing: 4, fontFamily: font.mono }}
          />
          <Button
            type="button"
            variant="secondary"
            onClick={() => { void handleSendCode(); }}
            disabled={sendingCode || resendIn > 0}
            style={{ whiteSpace: "nowrap" }}
          >
            {sendingCode
              ? "Sending..."
              : resendIn > 0
              ? `Resend in ${formatCountdown(resendIn)}`
              : "Send code"}
          </Button>
        </div>
        {codeExpired ? (
          <p style={{ fontSize: font.size.sm, fontWeight: font.weight.medium, color: color.status.dangerText }}>
            This code is no longer valid. Send a new one to continue.
          </p>
        ) : codeNotice ? (
          <p style={{ fontSize: font.size.sm, fontWeight: font.weight.medium, color: color.brand.active }}>
            {codeNotice}
          </p>
        ) : (
          <p style={{ fontSize: font.size.sm, color: color.text.muted }}>
            We email a 6-digit code to confirm this change. Request one, then enter it here.
          </p>
        )}
      </div>

      <div className="mt-2 flex flex-col-reverse gap-3 sm:flex-row sm:justify-between">
        {footer}
        <Button type="submit" disabled={submitting} style={{ marginLeft: footer ? undefined : "auto" }}>
          {submitting ? "Updating..." : submitLabel}
        </Button>
      </div>
    </form>
  );
}
