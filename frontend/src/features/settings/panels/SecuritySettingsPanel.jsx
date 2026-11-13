import React from "react";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";

const PASSWORD_EXPIRATION_OPTIONS = [30, 60, 90, 180, 365];

function clampExpirationDays(value, limits) {
  const min = Math.max(1, Number(limits?.passwordExpiryDays?.min || 1));
  const max = Number(limits?.passwordExpiryDays?.max || 3650);
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function isPresetExpirationDays(value) {
  return PASSWORD_EXPIRATION_OPTIONS.includes(Number(value));
}

function customExpirationStyle({ active, disabled }) {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    minHeight: 32,
    border: active ? "1px solid #065f46" : "1px solid #e2e8f0",
    background: active ? "#ecfdf5" : "#ffffff",
    color: active ? "#065f46" : "#334155",
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 11.5,
    fontWeight: 700,
    opacity: disabled ? 0.5 : 1,
    cursor: disabled ? "not-allowed" : "default",
    transition: "background 120ms ease, border-color 120ms ease, color 120ms ease, box-shadow 120ms ease",
  };
}

function passwordExpirationTone(status) {
  if (status === "expired") {
    return { color: "var(--danger-800)", background: "var(--danger-100)", border: "var(--danger-200)" };
  }
  if (status === "red") {
    return { color: "var(--danger-700)", background: "var(--danger-50)", border: "var(--danger-200)" };
  }
  if (status === "orange") {
    return { color: "var(--warning-800)", background: "var(--warning-100)", border: "var(--warning-200)" };
  }
  if (status === "green") {
    return { color: "var(--brand-800)", background: "var(--brand-100)", border: "var(--brand-200)" };
  }
  return { color: "var(--text-secondary)", background: "var(--surface-page)", border: "var(--border-base)" };
}

/**
 * One number in the rate-limit row, with the range the server will accept.
 *
 * `min` and `max` come from the server rather than being repeated here, so the
 * spinner offers exactly what will be stored. A form that lets someone type 5
 * and then shows them a silently clamped 10 teaches them the field is broken.
 */
function RateLimitField({ id, label, hint, value, bounds, disabled, onChange }) {
  return (
    <div style={{ display: "grid", gap: 5 }}>
      <label htmlFor={id} style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={bounds?.min}
        max={bounds?.max}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        style={{
          padding: "7px 9px",
          borderRadius: 6,
          border: "1px solid var(--border-strong)",
          fontSize: 12.5,
          opacity: disabled ? 0.55 : 1,
        }}
      />
      <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
        {hint}
        {bounds ? ` (${bounds.min}–${bounds.max})` : ""}
      </span>
    </div>
  );
}

export default function SecuritySettingsPanel({
  securityForm,
  setSecurityForm,
  limits,
  message,
  onSave,
  rateLimitForm = null,
  setRateLimitForm,
  rateLimitBounds = null,
  rateLimitSaving = false,
  rateLimitMsg = "",
  onSaveRateLimit,
  passwordExpirationUsers = [],
  passwordExpirationLoading = false,
  passwordExpirationError = "",
  passwordExpirationFilter = "all",
  passwordExpirationSearch = "",
  passwordExpirationPagination = null,
  onPasswordExpirationFilterChange,
  onPasswordExpirationSearchChange,
  onPasswordExpirationRefresh,
  onPasswordExpirationReset,
  onPasswordExpirationToggleDisabled,
}) {
  const passwordExpirationEnabled = Boolean(securityForm.passwordExpirationEnabled);
  const currentExpirationDays = Number(securityForm.passwordExpiryDays);
  const customExpirationActive = !isPresetExpirationDays(currentExpirationDays);

  return (
    <DashboardPanel>
      <SectionHeader
        title="Security Settings"
        actions={<Button onClick={onSave}>Save Settings</Button>}
      />
      <div style={{ padding: 9, display: "grid", gap: 9 }}>
        <AlertMessage
          tone="info"
          message="Configure password rules and login protections for all users."
        />
        <div style={{ display: "grid", gap: 9, gridTemplateColumns: "repeat(auto-fit, minmax(min(187px, 100%), 1fr))" }}>
          <div style={{ display: "grid", gap: 5 }}>
            <label htmlFor="max-password-length" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              Maximum Password Length
            </label>
            <input
              id="max-password-length"
              type="number"
              min={limits.maxPasswordLength.min}
              max={limits.maxPasswordLength.max}
              value={securityForm.maxPasswordLength}
              onChange={(e) => setSecurityForm((current) => ({ ...current, maxPasswordLength: e.target.value }))}
              className="settings-field"
            />
            <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Default 64. Range 6-256.</div>
          </div>

          <div style={{ display: "grid", gap: 5 }}>
            <label htmlFor="session-timeout" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              Session Timeout (minutes)
            </label>
            <input
              id="session-timeout"
              type="number"
              min={limits.sessionTimeoutMinutes.min}
              max={limits.sessionTimeoutMinutes.max}
              value={securityForm.sessionTimeoutMinutes}
              onChange={(e) => setSecurityForm((current) => ({ ...current, sessionTimeoutMinutes: e.target.value }))}
              className="settings-field"
            />
            {/* Says "every account" on purpose. This number used to be saved to
                the admin's own browser and nowhere else, so the natural reading
                — that it is a system-wide rule — was the one thing it was not. */}
            <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              Default 30. Every account is signed out after this much inactivity, from their next sign-in or page load.
            </div>
          </div>

          <div style={{ display: "grid", gap: 5 }}>
            <label htmlFor="lockout-attempts" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              Lockout After Failed Attempts
            </label>
            <input
              id="lockout-attempts"
              type="number"
              min={limits.lockoutAttempts.min}
              max={limits.lockoutAttempts.max}
              value={securityForm.lockoutAttempts}
              onChange={(e) => setSecurityForm((current) => ({ ...current, lockoutAttempts: e.target.value }))}
              className="settings-field"
            />
            <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Default 5. Account locks for 15 minutes after consecutive failures.</div>
          </div>
        </div>

        <div style={{ border: "1px solid var(--border-base)", borderRadius: 9, padding: 11, display: "grid", gap: 11, background: "var(--surface-base)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "flex-start", flexWrap: "wrap" }}>
            <div style={{ display: "grid", gap: 3 }}>
              <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>Password Expiration Policy</strong>
              <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                Countdown is calculated on the backend from account creation or last password change.
              </span>
            </div>
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-primary)", fontSize: 11.5, fontWeight: 700 }}>
              <input
                type="checkbox"
                checked={Boolean(securityForm.passwordExpirationEnabled)}
                onChange={(e) => setSecurityForm((current) => ({ ...current, passwordExpirationEnabled: e.target.checked }))}
              />
              Enable expiration
            </label>
          </div>

          <div style={{ display: "grid", gap: 5 }}>
            <label htmlFor="password-expiry-days" style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              Expiration Period
            </label>
            <div
              role="group"
              aria-label="Password expiration period"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                alignItems: "center",
              }}
            >
              {PASSWORD_EXPIRATION_OPTIONS.map((days) => (
                <button
                  key={days}
                  type="button"
                  className="settings-chip"
                  aria-pressed={Number(securityForm.passwordExpiryDays) === days}
                  disabled={!passwordExpirationEnabled}
                  onClick={() => setSecurityForm((current) => ({ ...current, passwordExpiryDays: days }))}
                >
                  {days} Days
                </button>
              ))}

              <label
                htmlFor="password-expiry-days"
                style={customExpirationStyle({ active: customExpirationActive, disabled: !passwordExpirationEnabled })}
              >
                <span>Custom:</span>
                <input
                  id="password-expiry-days"
                  type="number"
                  min={Math.max(1, limits.passwordExpiryDays.min)}
                  max={limits.passwordExpiryDays.max}
                  disabled={!passwordExpirationEnabled}
                  value={securityForm.passwordExpiryDays}
                  onFocus={(event) => event.target.select()}
                  onChange={(event) => setSecurityForm((current) => ({ ...current, passwordExpiryDays: event.target.value }))}
                  onBlur={(event) => {
                    const nextDays = clampExpirationDays(event.target.value, limits);
                    setSecurityForm((current) => ({ ...current, passwordExpiryDays: nextDays }));
                  }}
                  style={{
                    width: 65,
                    minWidth: 0,
                    border: "1px solid var(--border-strong)",
                    borderRadius: 5,
                    padding: "4px 5px",
                    background: passwordExpirationEnabled ? "#ffffff" : "#f8fafc",
                    color: passwordExpirationEnabled ? "#0f172a" : "#94a3b8",
                    fontSize: 11.5,
                    fontWeight: 700,
                    outline: "none",
                    opacity: 1,
                    cursor: passwordExpirationEnabled ? "text" : "not-allowed",
                  }}
                />
                <span>days</span>
              </label>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Supported range 1-3650 days.</div>
          </div>
        </div>

        <div style={{ border: "1px solid var(--border-base)", borderRadius: 9, padding: 11, display: "grid", gap: 9, background: "var(--surface-base)" }}>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "grid", gap: 3 }}>
              <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>User Password Expiration</strong>
              <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                View expiration dates, filter expired accounts, reset countdowns, or disable expiration per user.
              </span>
            </div>
            <Button variant="secondary" onClick={onPasswordExpirationRefresh} disabled={passwordExpirationLoading}>
              Refresh
            </Button>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <input
              type="search"
              value={passwordExpirationSearch}
              onChange={(e) => onPasswordExpirationSearchChange?.(e.target.value)}
              placeholder="Search user or email"
              style={{ minWidth: 187, flex: "1 1 220px", padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border-base)", fontSize: 12.5 }}
            />
            <select
              value={passwordExpirationFilter}
              onChange={(e) => onPasswordExpirationFilterChange?.(e.target.value)}
              style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid var(--border-base)", fontSize: 12.5, background: "var(--surface-base)" }}
            >
              <option value="all">All Accounts</option>
              <option value="expired">Expired Accounts</option>
              <option value="expiring_30">30 Days or Less</option>
              <option value="disabled">User Disabled</option>
            </select>
          </div>

          {passwordExpirationError ? (
            <AlertMessage tone="error" message={passwordExpirationError} />
          ) : null}

          <div style={{ overflowX: "auto", border: "1px solid var(--border-base)", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 646 }}>
              <thead>
                <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", fontSize: 10.5, textAlign: "left" }}>
                  <th style={{ padding: "8px 9px" }}>User</th>
                  <th style={{ padding: "8px 9px" }}>Expires On</th>
                  <th style={{ padding: "8px 9px" }}>Remaining</th>
                  <th style={{ padding: "8px 9px" }}>Policy</th>
                  <th style={{ padding: "8px 9px", textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {passwordExpirationLoading ? (
                  <tr>
                    <td colSpan="5" style={{ padding: 12, color: "var(--text-muted)", fontSize: 11.5 }}>Loading password expiration records...</td>
                  </tr>
                ) : passwordExpirationUsers.length === 0 ? (
                  <tr>
                    <td colSpan="5" style={{ padding: 12, color: "var(--text-muted)", fontSize: 11.5 }}>No users match the current filter.</td>
                  </tr>
                ) : passwordExpirationUsers.map((entry) => {
                  const expiration = entry?.password_expiration || {};
                  const tone = passwordExpirationTone(expiration.status);
                  return (
                    <tr key={entry.user_id} style={{ borderTop: "1px solid var(--border-base)" }}>
                      <td style={{ padding: "8px 9px", verticalAlign: "top" }}>
                        <div style={{ display: "grid", gap: 2 }}>
                          <strong style={{ color: "var(--text-primary)", fontSize: 11.5 }}>{entry.name || "User"}</strong>
                          <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{entry.email}</span>
                        </div>
                      </td>
                      <td style={{ padding: "8px 9px", color: "var(--text-primary)", fontSize: 11.5, verticalAlign: "top" }}>
                        {expiration.expires_at_display || "Not scheduled"}
                      </td>
                      <td style={{ padding: "8px 9px", verticalAlign: "top" }}>
                        <span style={{ display: "inline-flex", border: `1px solid ${tone.border}`, background: tone.background, color: tone.color, borderRadius: 999, padding: "3px 6px", fontSize: 10.5, fontWeight: 700 }}>
                          {expiration.remaining_label || "Unavailable"}
                        </span>
                      </td>
                      <td style={{ padding: "8px 9px", color: "var(--text-muted)", fontSize: 10.5, verticalAlign: "top" }}>
                        {expiration.user_disabled ? "Disabled for user" : expiration.policy_enabled ? `${expiration.expiration_days} days` : "Policy disabled"}
                      </td>
                      <td style={{ padding: "8px 9px", verticalAlign: "top" }}>
                        <div style={{ display: "flex", gap: 6, justifyContent: "flex-end", flexWrap: "wrap" }}>
                          <Button size="sm" variant="secondary" onClick={() => onPasswordExpirationReset?.(entry.user_id)}>
                            Reset
                          </Button>
                          <Button size="sm" variant={expiration.user_disabled ? "primary" : "secondary"} onClick={() => onPasswordExpirationToggleDisabled?.(entry.user_id, !expiration.user_disabled)}>
                            {expiration.user_disabled ? "Enable" : "Disable"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {passwordExpirationPagination ? (
            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
              Showing {passwordExpirationUsers.length} of {passwordExpirationPagination.total || passwordExpirationUsers.length} accounts.
            </div>
          ) : null}
        </div>
        {message ? <div style={{ color: "var(--brand-800)", fontSize: 11.5 }}>{message}</div> : null}

        {/*
          API rate limit.
          ----------------------------------------------------------------
          Its own block with its own Save, not part of the form above, because
          the server stores it separately and answers a PUT that names it before
          it reads anything else. One button for both would send both and save
          only this.

          Sits under the password rules rather than above them: this is the
          control an administrator touches once, when a bulk import or a shared
          campus address makes the shipped numbers wrong. The rules above are
          the ones they came here for.
        */}
        {rateLimitForm ? (
          <div style={{ display: "grid", gap: 9, paddingTop: 9, borderTop: "1px solid var(--border-base)" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
              <div>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>API Rate Limit</div>
                <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                  How many requests one device may send before the server starts refusing them.
                </div>
              </div>
              <Button onClick={onSaveRateLimit} disabled={rateLimitSaving}>
                {rateLimitSaving ? "Saving..." : "Save Rate Limit"}
              </Button>
            </div>

            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--text-primary)", fontSize: 11.5, fontWeight: 700 }}>
              <input
                type="checkbox"
                checked={rateLimitForm.enabled}
                onChange={(event) =>
                  setRateLimitForm?.((current) => ({ ...current, enabled: event.target.checked }))
                }
              />
              Rate limiting is on
            </label>

            {/* Stated plainly. Turning this off is a legitimate thing to do
                during a bulk load and a bad thing to leave off by accident. */}
            {!rateLimitForm.enabled ? (
              <AlertMessage
                tone="warning"
                message="Flood control is off. Every device can send as many requests as it likes, including the sign-in and password-reset pages. The per-account login lockout still applies."
              />
            ) : null}

            <div style={{ display: "grid", gap: 9, gridTemplateColumns: "repeat(auto-fit, minmax(min(187px, 100%), 1fr))" }}>
              <RateLimitField
                id="rate-limit-burst"
                label="Burst"
                hint="requests allowed at once, from idle"
                value={rateLimitForm.burst}
                bounds={rateLimitBounds?.burst}
                disabled={!rateLimitForm.enabled}
                onChange={(value) => setRateLimitForm?.((current) => ({ ...current, burst: value }))}
              />
              <RateLimitField
                id="rate-limit-per-minute"
                label="Sustained Rate"
                hint="requests per minute once the burst is spent"
                value={rateLimitForm.perMinute}
                bounds={rateLimitBounds?.per_minute}
                disabled={!rateLimitForm.enabled}
                onChange={(value) => setRateLimitForm?.((current) => ({ ...current, perMinute: value }))}
              />
              <RateLimitField
                id="rate-limit-strikes"
                label="Refusals Before Block"
                hint="refusals in one minute that earn a block"
                value={rateLimitForm.strikes}
                bounds={rateLimitBounds?.strikes}
                disabled={!rateLimitForm.enabled}
                onChange={(value) => setRateLimitForm?.((current) => ({ ...current, strikes: value }))}
              />
              <RateLimitField
                id="rate-limit-block"
                label="Block Duration"
                hint="minutes a blocked device waits"
                value={rateLimitForm.blockMinutes}
                bounds={
                  rateLimitBounds?.block_seconds
                    ? {
                        min: Math.round(rateLimitBounds.block_seconds.min / 60),
                        max: Math.round(rateLimitBounds.block_seconds.max / 60),
                      }
                    : null
                }
                disabled={!rateLimitForm.enabled}
                onChange={(value) => setRateLimitForm?.((current) => ({ ...current, blockMinutes: value }))}
              />
            </div>

            <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
              Counted per signed-in account, or per IP address for anyone not signed in. This is
              separate from the login lockout above, which counts failed sign-ins for one account.
            </div>

            {rateLimitMsg ? <div style={{ color: "var(--brand-800)", fontSize: 11.5 }}>{rateLimitMsg}</div> : null}
          </div>
        ) : null}
      </div>
    </DashboardPanel>
  );
}
