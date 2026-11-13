import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, CalendarCheck, Coins, Database, FileText, Gauge, Shield, SlidersHorizontal, Tags, Users } from "lucide-react";
import { OverviewHeader } from "../../shared/layout/dashboard";
import { logAuditEvent, readAuditLogs, clearAuditLogs } from "../../shared/lib/audit";
import { readAuthUser } from "../../shared/lib/auth";
import { getInitialDashboardIntentValue, persistDashboardIntent } from "../../shared/lib/dashboardIntent";
import { canModuleAction } from "../../shared/lib/roleAccess";
import {
  adoptServerSessionPolicy,
  clearAllFailedLoginAttempts,
  clearFailedLoginAttempts,
  getCaptchaEnabled,
  getCaptchaEnabledFromPolicy,
  getFailedLoginAttemptsSnapshot,
  getSecurityPolicy,
  getSecurityPolicyLimits,
  setCaptchaEnabled as persistCaptchaEnabled,
  setSecurityPolicy,
} from "../../shared/lib/securityPolicy";
import { setSessionTimeoutMinutes } from "../../shared/lib/session";
import {
  getBackendSecurityPolicy,
  getLoginCaptchaPolicy,
  getPasswordExpirationUsers,
  resetPasswordExpiration,
  saveLoginCaptchaPolicy,
  saveApiRateLimit,
  saveOutboundEmailEnabled,
  saveBackendSecurityPolicy,
  setUserPasswordExpirationDisabled,
} from "../../shared/services/api";
import AuditLogsPanel from "./panels/AuditLogsPanel";
import BackupSettingsPanel from "./panels/BackupSettingsPanel";
import LockoutAttemptsPanel from "./panels/LockoutAttemptsPanel";
import RoleAccessPanel from "./panels/RoleAccessPanel";
import SecuritySettingsPanel from "./panels/SecuritySettingsPanel";
import SystemConfigurationPanel from "./panels/SystemConfigurationPanel";
import TermRecordsPanel from "./panels/TermRecordsPanel";
import GradePolicyPanel from "./panels/GradePolicyPanel";
import RiskPolicyPanel from "./panels/RiskPolicyPanel";
import RetentionStatusLabelsPanel from "./panels/RetentionStatusLabelsPanel";
import FinanceBandsPanel from "./panels/FinanceBandsPanel";

/**
 * One entry in the settings rail.
 *
 * There is no "Selected"/"Open" badge any more: the border, tint and icon
 * colour already carry that state three times over, and a fourth signal made
 * every unselected row shout "Open" at the reader.
 */
function SettingsNavItem({ item, selected, onSelect, onKeyDown }) {
  const Icon = item.icon;

  return (
    <button
      id={`settings-tab-${item.id}`}
      type="button"
      role="tab"
      aria-selected={selected}
      aria-controls={`settings-panel-${item.id}`}
      // Roving tabindex: the rail is one tab stop, arrows move within it.
      tabIndex={selected ? 0 : -1}
      onClick={() => onSelect(item.id)}
      onKeyDown={onKeyDown}
      className="settings-nav-item"
    >
      <span className="settings-nav-icon" aria-hidden="true">
        <Icon size={14} strokeWidth={2.1} />
      </span>
      <span style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span className="settings-nav-title">{item.title}</span>
        <span className="settings-nav-summary" title={item.summary}>{item.summary}</span>
      </span>
    </button>
  );
}

export default function AdminSettings({ permissions = null, defaultSection = "" }) {
  const user = readAuthUser();
  const [activeSection, setActiveSection] = useState(() => getInitialDashboardIntentValue("section", "security", { lowercase: false }));
  const [securityForm, setSecurityForm] = useState(() => getSecurityPolicy());
  const [securityMsg, setSecurityMsg] = useState("");
  const [passwordExpirationUsers, setPasswordExpirationUsers] = useState([]);
  const [passwordExpirationLoading, setPasswordExpirationLoading] = useState(false);
  const [passwordExpirationError, setPasswordExpirationError] = useState("");
  const [passwordExpirationFilter, setPasswordExpirationFilter] = useState("all");
  const [passwordExpirationSearch, setPasswordExpirationSearch] = useState("");
  const [passwordExpirationPagination, setPasswordExpirationPagination] = useState(null);
  const [captchaEnabled, setCaptchaEnabledState] = useState(getCaptchaEnabled());
  const [captchaSaving, setCaptchaSaving] = useState(false);
  const [captchaMsg, setCaptchaMsg] = useState("");
  // Defaults to on so a failed load never implies "email is off" — the state
  // where accounts get created and nobody is told their password.
  /*
   * The API flood limits.
   *
   * Held apart from securityForm, and saved by their own button, because the
   * server treats them as a separate concern: its PUT answers from the rate
   * limit branch first, so a request carrying both these and the password
   * policy would save these and drop the other. Two forms, two saves, no way to
   * express the request that loses data.
   *
   * blockMinutes is the form's unit. The server stores seconds.
   */
  const [rateLimitForm, setRateLimitForm] = useState({
    enabled: true,
    burst: 120,
    perMinute: 120,
    strikes: 20,
    blockMinutes: 10,
  });
  // Sent by the server so the inputs offer exactly what it will accept. Without
  // them the form would happily take a 5 and show a silently clamped 10 back.
  const [rateLimitBounds, setRateLimitBounds] = useState(null);
  const [rateLimitSaving, setRateLimitSaving] = useState(false);
  const [rateLimitMsg, setRateLimitMsg] = useState("");

  const [outboundEmailEnabled, setOutboundEmailEnabled] = useState(true);
  const [outboundEmailSaving, setOutboundEmailSaving] = useState(false);
  const [outboundEmailMsg, setOutboundEmailMsg] = useState("");
  const [backupSummary, setBackupSummary] = useState("Manage scheduled backups, restore points, and backup history.");
  const [termRecordsSummary, setTermRecordsSummary] = useState("Review which semesters are closed");
  const [gradePolicySummary, setGradePolicySummary] = useState("Set the current year and manage grade policy versions");
  const [riskPolicySummary, setRiskPolicySummary] = useState("Tune what makes a student count as at risk");
  const [retentionStatusSummary, setRetentionStatusSummary] = useState("Rename the retention statuses");
  const [financeBandsSummary, setFinanceBandsSummary] = useState("Set the balance ranges");
  const [logs, setLogs] = useState(() => readAuditLogs());
  const [lockoutEntries, setLockoutEntries] = useState(() => getFailedLoginAttemptsSnapshot());
  const [lockoutMsg, setLockoutMsg] = useState("");
  const limits = getSecurityPolicyLimits();
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const isAdmin = Number(user?.role_id) === 1 || String(user?.role_name || user?.role || "").trim().toLowerCase() === "admin";
  const canManageSettings = isAdmin || (hasPermissionContext ? canModuleAction(permissions, "manage") : true);

  const refreshLogs = () => {
    setLogs(readAuditLogs());
  };

  const refreshLockouts = () => {
    setLockoutEntries(getFailedLoginAttemptsSnapshot());
  };

  const applyBackendPasswordPolicy = useCallback((policy) => {
    if (!policy) return;
    setSecurityForm((current) => ({
      ...current,
      passwordExpirationEnabled: Boolean(policy.password_expiration_enabled),
      passwordExpiryDays: Number(policy.password_expiration_days || current.passwordExpiryDays || 90),
    }));
  }, []);

  const loadBackendPasswordPolicy = useCallback(async () => {
    try {
      const payload = await getBackendSecurityPolicy();
      applyBackendPasswordPolicy(payload?.policy);
      /*
       * The idle timeout comes back on the same request. Taking it here is what
       * makes the field show the institution's setting rather than whatever
       * this particular browser last cached — an admin signing in from a second
       * machine used to read their own stale number back as policy.
       */
      const serverTimeout = adoptServerSessionPolicy(payload?.policy);
      if (serverTimeout) {
        setSecurityForm((current) => ({ ...current, sessionTimeoutMinutes: serverTimeout }));
      }
      // Same request carries the mail switch, so it costs nothing extra. Only
      // an explicit false turns the UI off, matching the server's own rule.
      if (payload?.policy && "outbound_email_enabled" in payload.policy) {
        setOutboundEmailEnabled(payload.policy.outbound_email_enabled !== false);
      }

      // Same request again — the limits and the bounds the server clamps to.
      if (payload?.policy && "rate_limit_burst" in payload.policy) {
        setRateLimitForm({
          enabled: payload.policy.rate_limit_enabled !== false,
          burst: Number(payload.policy.rate_limit_burst),
          perMinute: Number(payload.policy.rate_limit_per_minute),
          strikes: Number(payload.policy.rate_limit_strikes),
          blockMinutes: Math.round(Number(payload.policy.rate_limit_block_seconds) / 60),
        });
      }
      if (payload?.rate_limit_bounds) {
        setRateLimitBounds(payload.rate_limit_bounds);
      }
    } catch (error) {
      setSecurityMsg(error?.message || "Failed to load password expiration policy.");
    }
  }, [applyBackendPasswordPolicy]);

  const handleToggleOutboundEmail = useCallback(async () => {
    const next = !outboundEmailEnabled;
    const previous = outboundEmailEnabled;
    setOutboundEmailSaving(true);
    setOutboundEmailMsg(next ? "Turning email on..." : "Turning email off...");
    try {
      const payload = await saveOutboundEmailEnabled(next);
      const saved = payload?.policy?.outbound_email_enabled !== false;
      setOutboundEmailEnabled(saved);
      setOutboundEmailMsg(payload?.message || (saved ? "Email sending is on." : "Email sending is off."));
      logAuditEvent({
        action: "settings_update",
        detail: `Outbound email ${saved ? "switched on" : "switched off"}.`,
        user,
      });
    } catch (error) {
      // Snap back: showing "off" while the server still sends is the one wrong
      // answer here.
      setOutboundEmailEnabled(previous);
      setOutboundEmailMsg(error?.message || "Failed to save the outbound email switch.");
    } finally {
      setOutboundEmailSaving(false);
    }
  }, [outboundEmailEnabled, user]);

  const loadCaptchaPolicy = useCallback(async () => {
    try {
      const payload = await getLoginCaptchaPolicy();
      const enabled = getCaptchaEnabledFromPolicy(payload, getCaptchaEnabled());
      setCaptchaEnabledState(persistCaptchaEnabled(enabled));
    } catch (error) {
      setCaptchaMsg(error?.message || "Failed to load CAPTCHA policy.");
    }
  }, []);

  const loadPasswordExpirationUsers = useCallback(async () => {
    setPasswordExpirationLoading(true);
    setPasswordExpirationError("");
    try {
      const payload = await getPasswordExpirationUsers({
        search: passwordExpirationSearch,
        filter: passwordExpirationFilter,
        page: 1,
        limit: 50,
      });
      const data = payload?.data || {};
      setPasswordExpirationUsers(Array.isArray(data?.items) ? data.items : []);
      setPasswordExpirationPagination(data?.pagination || null);
    } catch (error) {
      setPasswordExpirationError(error?.message || "Failed to load password expiration records.");
      setPasswordExpirationUsers([]);
      setPasswordExpirationPagination(null);
    } finally {
      setPasswordExpirationLoading(false);
    }
  }, [passwordExpirationFilter, passwordExpirationSearch]);

  useEffect(() => {
    function syncAdminSettings() {
      setSecurityForm((current) => ({
        ...getSecurityPolicy(),
        passwordExpirationEnabled: current.passwordExpirationEnabled,
        passwordExpiryDays: current.passwordExpiryDays,
      }));
      setCaptchaEnabledState(getCaptchaEnabled());
      setLogs(readAuditLogs());
      setLockoutEntries(getFailedLoginAttemptsSnapshot());
    }

    const intervalId = window.setInterval(() => {
      setLockoutEntries(getFailedLoginAttemptsSnapshot());
    }, 30000);

    window.addEventListener("storage", syncAdminSettings);
    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("storage", syncAdminSettings);
    };
  }, []);

  useEffect(() => {
    void loadBackendPasswordPolicy();
    void loadCaptchaPolicy();
  }, [loadBackendPasswordPolicy, loadCaptchaPolicy]);

  useEffect(() => {
    if (activeSection !== "security") return;
    void loadPasswordExpirationUsers();
  }, [activeSection, loadPasswordExpirationUsers]);

  /**
   * Save the flood limits.
   *
   * The server clamps, so the form adopts what came back rather than what was
   * typed. Reporting "saved" beside a number the server rejected is the failure
   * this avoids: an administrator who asked for a burst of 5 needs to see the
   * 10 that is actually in force, not their own input echoed at them.
   */
  const handleSaveRateLimit = useCallback(async () => {
    setRateLimitSaving(true);
    setRateLimitMsg("");
    try {
      const payload = await saveApiRateLimit(rateLimitForm);
      const policy = payload?.policy || {};
      if ("rate_limit_burst" in policy) {
        setRateLimitForm({
          enabled: policy.rate_limit_enabled !== false,
          burst: Number(policy.rate_limit_burst),
          perMinute: Number(policy.rate_limit_per_minute),
          strikes: Number(policy.rate_limit_strikes),
          blockMinutes: Math.round(Number(policy.rate_limit_block_seconds) / 60),
        });
      }
      if (payload?.rate_limit_bounds) {
        setRateLimitBounds(payload.rate_limit_bounds);
      }
      setRateLimitMsg(payload?.message || "API rate limit saved.");
    } catch (error) {
      setRateLimitMsg(error?.message || "Failed to save the API rate limit.");
    } finally {
      setRateLimitSaving(false);
    }
  }, [rateLimitForm]);

  const handleSaveSecurity = async () => {
    const normalized = setSecurityPolicy(securityForm);
    try {
      const payload = await saveBackendSecurityPolicy({
        password_expiration_enabled: Boolean(securityForm.passwordExpirationEnabled),
        password_expiration_days: normalized.passwordExpiryDays,
        // The line that makes the timeout a policy instead of a preference:
        // until this was sent, the number never left the admin's own browser.
        session_timeout_minutes: normalized.sessionTimeoutMinutes,
      });
      const backendPolicy = payload?.policy || {};
      // What the server clamped it to wins over what was typed, so the form and
      // every other browser end up agreeing on one number.
      const savedTimeout = adoptServerSessionPolicy(backendPolicy) || normalized.sessionTimeoutMinutes;
      const nextForm = {
        ...normalized,
        passwordExpirationEnabled: Boolean(backendPolicy.password_expiration_enabled),
        passwordExpiryDays: Number(backendPolicy.password_expiration_days || normalized.passwordExpiryDays),
        sessionTimeoutMinutes: savedTimeout,
      };
      setSessionTimeoutMinutes(savedTimeout);
      setSecurityForm(nextForm);
      setSecurityMsg("Security settings saved.");
      refreshLockouts();
      void loadPasswordExpirationUsers();
      logAuditEvent({
        action: "settings_update",
        detail: `Security policy updated (max password length ${normalized.maxPasswordLength}, password expiration ${nextForm.passwordExpirationEnabled ? `${nextForm.passwordExpiryDays} days` : "disabled"}, timeout ${savedTimeout} minutes, lockout ${normalized.lockoutAttempts} attempts).`,
        user,
      });
    } catch (error) {
      setSessionTimeoutMinutes(normalized.sessionTimeoutMinutes);
      setSecurityForm((current) => ({ ...normalized, passwordExpirationEnabled: current.passwordExpirationEnabled }));
      setSecurityMsg(error?.message || "Failed to save security settings.");
    }
  };

  const handleResetPasswordExpiration = async (userId) => {
    try {
      await resetPasswordExpiration(userId);
      setSecurityMsg("Password expiration reset.");
      void loadPasswordExpirationUsers();
    } catch (error) {
      setPasswordExpirationError(error?.message || "Failed to reset password expiration.");
    }
  };

  const handleTogglePasswordExpirationDisabled = async (userId, disabled) => {
    try {
      await setUserPasswordExpirationDisabled(userId, disabled);
      setSecurityMsg(disabled ? "Password expiration disabled for user." : "Password expiration enabled for user.");
      void loadPasswordExpirationUsers();
    } catch (error) {
      setPasswordExpirationError(error?.message || "Failed to update user password expiration.");
    }
  };

  const handleToggleCaptcha = async () => {
    const next = !captchaEnabled;
    const previous = captchaEnabled;
    setCaptchaSaving(true);
    setCaptchaEnabledState(persistCaptchaEnabled(next));
    setCaptchaMsg("Saving CAPTCHA policy...");

    try {
      const payload = await saveLoginCaptchaPolicy(next);
      const saved = getCaptchaEnabledFromPolicy(payload, next);
      setCaptchaEnabledState(persistCaptchaEnabled(saved));
      setCaptchaMsg(`Login CAPTCHA ${saved ? "enabled" : "disabled"}.`);
      logAuditEvent({ action: "settings_update", detail: `Login CAPTCHA ${saved ? "enabled" : "disabled"}.`, user });
    } catch (error) {
      setCaptchaEnabledState(persistCaptchaEnabled(previous));
      setCaptchaMsg(error?.message || "Failed to save CAPTCHA policy.");
    } finally {
      setCaptchaSaving(false);
    }
  };

  const handleClearLogs = () => {
    clearAuditLogs();
    const entry = logAuditEvent({ action: "audit_logs_cleared", detail: "Audit logs cleared by admin.", user });
    setLogs([entry]);
  };

  const handleResetLockout = (email) => {
    clearFailedLoginAttempts(email);
    setLockoutMsg(`Failed login attempts reset for ${email}.`);
    refreshLockouts();
    logAuditEvent({ action: "lockout_reset", detail: `Failed login attempts reset for ${email}.`, user });
  };

  const handleResetAllLockouts = () => {
    clearAllFailedLoginAttempts();
    setLockoutMsg("All tracked failed login attempts were reset.");
    refreshLockouts();
    logAuditEvent({ action: "lockout_reset_all", detail: "All tracked failed login attempts were reset.", user });
  };

  // Memoised because two effects below depend on it; rebuilt each render it
  // made them re-run on every keystroke in the panels.
  const sectionItems = useMemo(() => [
    {
      id: "security",
      title: "Security Settings",
      description: "Manage password limits, expiry rules, session timeout, and lockout thresholds.",
      summary: `Password expiration: ${securityForm.passwordExpirationEnabled ? `${securityForm.passwordExpiryDays} days` : "disabled"}`,
      icon: Shield,
    },
    {
      id: "system",
      title: "System Configuration",
      description: "Control platform-wide login safeguards and core environment protections.",
      summary: `CAPTCHA is currently ${captchaEnabled ? "enabled" : "disabled"}`,
      icon: SlidersHorizontal,
    },
    {
      id: "lockouts",
      title: "Failed Login Attempts",
      description: "Review tracked failed sign-ins and reset account attempts when needed.",
      summary: `${lockoutEntries.length} ${lockoutEntries.length === 1 ? "account" : "accounts"} tracked`,
      icon: AlertTriangle,
    },
    canManageSettings ? {
      id: "roleAccess",
      title: "Role-Based Access",
      description: "Review role defaults, inspect assigned users, and manage custom sidebar access overrides.",
      summary: "Inspect role access, module coverage, and user overrides",
      icon: Users,
    } : null,
    {
      id: "termRecords",
      title: "Close Semester",
      description: "Close a finished semester: its students are recorded and its records become read-only until it is reopened.",
      summary: termRecordsSummary,
      icon: CalendarCheck,
    },
    {
      id: "gradePolicy",
      title: "School Year & Grade Policies",
      description: "Set the current school year and create year-specific grade policies. Edit their rules in Remarks Management.",
      summary: gradePolicySummary,
      icon: SlidersHorizontal,
    },
    {
      id: "riskPolicy",
      title: "Risk Policy",
      description: "Tune what earns a student risk points and how many points make them Moderate or High. Applies from the next evaluation.",
      summary: riskPolicySummary,
      icon: Gauge,
    },
    {
      id: "retentionStatusLabels",
      title: "Retention Status Names",
      description: "Change the words the retention board prints for each status. The status itself, and everything counted from it, stays the same.",
      summary: retentionStatusSummary,
      icon: Tags,
    },
    {
      id: "financeBands",
      title: "Balance Bands",
      description: "The balance ranges an imported record is filed under. Move a boundary and both bands either side of it move with it.",
      summary: financeBandsSummary,
      icon: Coins,
    },
    {
      id: "backup",
      title: "Backup Data",
      description: "Manage automated backup schedules, on-demand backups, restore points, and recovery history.",
      summary: backupSummary,
      icon: Database,
    },
    {
      id: "audit",
      title: "Audit Logs",
      description: "Inspect administrative activity history and refresh or clear recorded entries.",
      summary: `${logs.length} ${logs.length === 1 ? "log entry" : "log entries"} available`,
      icon: FileText,
    },
  ].filter(Boolean), [
    backupSummary,
    canManageSettings,
    captchaEnabled,
    lockoutEntries.length,
    logs.length,
    securityForm.passwordExpirationEnabled,
    securityForm.passwordExpiryDays,
    termRecordsSummary,
    gradePolicySummary,
    riskPolicySummary,
    retentionStatusSummary,
    financeBandsSummary,
  ]);

  const activeItem = sectionItems.find((item) => item.id === activeSection) || null;

  /**
   * Arrow keys move between sections, Home/End jump to the ends — the keyboard
   * contract a tablist is expected to honour once it claims the role.
   */
  const handleNavKeyDown = useCallback((event) => {
    const navigationKeys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
    if (!navigationKeys.includes(event.key)) return;
    event.preventDefault();

    const lastIndex = sectionItems.length - 1;
    if (lastIndex < 0) return;

    const currentIndex = sectionItems.findIndex((item) => item.id === activeSection);
    let nextIndex;
    if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = lastIndex;
    } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
      nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
    } else {
      nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
    }

    const nextItem = sectionItems[nextIndex];
    if (!nextItem) return;
    setActiveSection(nextItem.id);
    document.getElementById(`settings-tab-${nextItem.id}`)?.focus();
  }, [activeSection, sectionItems]);

  useEffect(() => {
    if (!sectionItems.some((item) => item.id === activeSection)) {
      setActiveSection(sectionItems[0]?.id || "security");
    }
  }, [activeSection, sectionItems]);

  useEffect(() => {
    const nextSection = String(defaultSection || "").trim();
    if (!nextSection) return;
    if (!sectionItems.some((item) => item.id === nextSection)) return;
    setActiveSection(nextSection);
  }, [defaultSection, sectionItems]);

  useEffect(() => {
    persistDashboardIntent({ section: activeSection });
  }, [activeSection]);

  const activeSectionPanel = {
    security: (
      <SecuritySettingsPanel
        rateLimitForm={rateLimitForm}
        setRateLimitForm={setRateLimitForm}
        rateLimitBounds={rateLimitBounds}
        rateLimitSaving={rateLimitSaving}
        rateLimitMsg={rateLimitMsg}
        onSaveRateLimit={handleSaveRateLimit}
        limits={limits}
        message={securityMsg}
        onSave={handleSaveSecurity}
        securityForm={securityForm}
        setSecurityForm={setSecurityForm}
        passwordExpirationUsers={passwordExpirationUsers}
        passwordExpirationLoading={passwordExpirationLoading}
        passwordExpirationError={passwordExpirationError}
        passwordExpirationFilter={passwordExpirationFilter}
        passwordExpirationSearch={passwordExpirationSearch}
        passwordExpirationPagination={passwordExpirationPagination}
        onPasswordExpirationFilterChange={setPasswordExpirationFilter}
        onPasswordExpirationSearchChange={setPasswordExpirationSearch}
        onPasswordExpirationRefresh={loadPasswordExpirationUsers}
        onPasswordExpirationReset={handleResetPasswordExpiration}
        onPasswordExpirationToggleDisabled={handleTogglePasswordExpirationDisabled}
      />
    ),
    system: (
      <SystemConfigurationPanel
        captchaEnabled={captchaEnabled}
        captchaMsg={captchaMsg}
        captchaSaving={captchaSaving}
        outboundEmailEnabled={outboundEmailEnabled}
        outboundEmailMsg={outboundEmailMsg}
        outboundEmailSaving={outboundEmailSaving}
        onToggleOutboundEmail={handleToggleOutboundEmail}
        onToggle={handleToggleCaptcha}
      />
    ),
    lockouts: (
      <LockoutAttemptsPanel
        entries={lockoutEntries}
        message={lockoutMsg}
        onRefresh={refreshLockouts}
        onReset={handleResetLockout}
        onResetAll={handleResetAllLockouts}
      />
    ),
    roleAccess: canManageSettings ? <RoleAccessPanel /> : null,
    termRecords: <TermRecordsPanel onSummaryChange={setTermRecordsSummary} permissions={permissions} />,
    gradePolicy: <GradePolicyPanel onSummaryChange={setGradePolicySummary} permissions={permissions} />,
    riskPolicy: <RiskPolicyPanel onSummaryChange={setRiskPolicySummary} permissions={permissions} />,
    retentionStatusLabels: <RetentionStatusLabelsPanel onSummaryChange={setRetentionStatusSummary} permissions={permissions} />,
    financeBands: <FinanceBandsPanel onSummaryChange={setFinanceBandsSummary} permissions={permissions} />,
    backup: <BackupSettingsPanel onSummaryChange={setBackupSummary} permissions={permissions} />,
    audit: (
      <AuditLogsPanel
        logs={logs}
        onClear={handleClearLogs}
        onRefresh={refreshLogs}
      />
    ),
  };

  return (
    <section style={{ display: "grid", gap: 12 }}>
      {/* The page subtitle carries the active section's description. It gives
          that copy a home now the cards are gone, and it changes as you move
          through the rail instead of restating the page title. */}
      <OverviewHeader
        title="System Settings"
        subtitle={activeItem?.description || "Configure security, access control, and auditing across the platform."}
      />

      <div className="settings-layout">
        <div
          className="settings-nav"
          role="tablist"
          aria-orientation="vertical"
          aria-label="Settings sections"
        >
          {sectionItems.map((item) => (
            <SettingsNavItem
              key={item.id}
              item={item}
              selected={activeSection === item.id}
              onSelect={setActiveSection}
              onKeyDown={handleNavKeyDown}
            />
          ))}
        </div>

        <div
          id={`settings-panel-${activeSection}`}
          role="tabpanel"
          aria-labelledby={`settings-tab-${activeSection}`}
          style={{ minWidth: 0 }}
        >
          {activeSectionPanel[activeSection]}
        </div>
      </div>
    </section>
  );
}
