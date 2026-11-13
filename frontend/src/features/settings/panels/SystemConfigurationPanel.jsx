import React from "react";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";

const rowStyle = {
  display: "flex",
  alignItems: "flex-start",
  gap: 12,
  flexWrap: "wrap",
  padding: "10px 0",
};

const titleStyle = { fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" };
const bodyStyle = { fontSize: 11.5, color: "var(--neutral-700)", maxWidth: 560 };

/** One switch: its name, what it does, where it stands, and the button. */
function ToggleRow({ title, description, enabled, enabledLabel, disabledLabel, onToggle, saving, message, divider }) {
  return (
    <div style={{ ...rowStyle, borderTop: divider ? "1px solid var(--border-base)" : "none" }}>
      <div style={{ display: "grid", gap: 3, flex: "1 1 320px", minWidth: 0 }}>
        <span style={titleStyle}>{title}</span>
        <span style={bodyStyle}>{description}</span>
        <span style={{ fontSize: 11.5, color: "var(--neutral-700)" }}>
          Current status:{" "}
          <strong style={{ color: enabled ? "var(--brand-800)" : "var(--danger-800)" }}>
            {enabled ? enabledLabel : disabledLabel}
          </strong>
        </span>
        {message ? <span style={{ color: "var(--brand-800)", fontSize: 11.5 }}>{message}</span> : null}
      </div>
      <Button variant={enabled ? "secondary" : "primary"} onClick={onToggle} disabled={saving}>
        {saving ? "Saving..." : enabled ? `Turn off` : `Turn on`}
      </Button>
    </div>
  );
}

export default function SystemConfigurationPanel({
  captchaEnabled,
  captchaMsg,
  captchaSaving = false,
  onToggle,
  outboundEmailEnabled = true,
  outboundEmailMsg = "",
  outboundEmailSaving = false,
  onToggleOutboundEmail,
}) {
  return (
    <DashboardPanel>
      <SectionHeader title="System Configuration" />
      <div style={{ padding: 9 }}>
        {/* Loudest when off, because the failure mode is silent: accounts get
            created and nobody is told their password. */}
        {!outboundEmailEnabled ? (
          <AlertMessage
            tone="warning"
            message="Email sending is OFF. New students and users will not receive their sign-in details, and password reset codes will not be delivered. Turn this back on when you finish testing."
          />
        ) : null}

        <ToggleRow
          title="Send email (Gmail)"
          description={
            "Welcome emails for new students and users, password reset codes, and profile verification codes. "
            + "Turn this off while testing: each message waits on a live connection to Gmail, so adding students "
            + "in bulk is far quicker with it off. Their password is still shown on screen when the account is created."
          }
          enabled={outboundEmailEnabled}
          enabledLabel="Sending email"
          disabledLabel="Not sending email"
          onToggle={onToggleOutboundEmail}
          saving={outboundEmailSaving}
          message={outboundEmailMsg}
        />

        <ToggleRow
          divider
          title="Login CAPTCHA"
          description="Helps prevent automated logins. Disable only for trusted environments or testing."
          enabled={captchaEnabled}
          enabledLabel="Enabled"
          disabledLabel="Disabled"
          onToggle={onToggle}
          saving={captchaSaving}
          message={captchaMsg}
        />
      </div>
    </DashboardPanel>
  );
}
