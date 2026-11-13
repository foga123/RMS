import React, { useEffect, useMemo, useRef, useState } from "react";
import { formatDate, formatDateTime } from "../../shared/lib/dateTime";
import { DashboardPanel } from "../../shared/layout/dashboard";
import { AlertMessage, Button, Input, Label } from "../../shared/components/ui";
import { getProfile, refreshProfileCaptcha, sendProfileOtp, updateProfile } from "../../shared/services/api";
import { getUserInitials, setAuthUser } from "../../shared/lib/auth";
import { logAuditEvent } from "../../shared/lib/audit";
import { notifyError, notifySuccess } from "../../shared/lib/notify";
import ChangePasswordForm from "../auth/components/ChangePasswordForm";
import { CloseIcon } from "../../shared/components/Modal/Modal";

const overlayStyle = {
  position: "fixed",
  inset: 0,
  background: "rgba(15, 23, 42, 0.58)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 11,
  zIndex: 1600,
};

/**
 * Narrower than the old 1080px. The content is now one section at a time
 * instead of five stacked panels, so the extra width had nothing to fill and
 * only stretched form rows into unreadable lines.
 *
 * The height is fixed, not capped. The four tabs differ wildly in length —
 * Profile is six short read-only fields, Contact carries the whole verification
 * block, History runs from an empty state to a long list — and the footer only
 * exists on Contact. With a max-height the card resized on every tab switch and
 * the whole dialog jumped under the pointer. One constant height holds it still;
 * the panel inside scrolls when a tab needs more room.
 */
const modalStyle = {
  width: "min(697px, 100%)",
  height: "min(90vh, 765px)",
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  borderRadius: 12,
  border: "1px solid var(--border-base)",
  background: "var(--surface-base)",
  boxShadow: "0 24px 70px rgba(15, 23, 42, 0.24)",
};

const closeButtonStyle = {
  display: "grid",
  placeItems: "center",
  border: "1px solid var(--border-base)",
  background: "var(--surface-base)",
  color: "var(--text-secondary)",
  width: 27,
  height: 27,
  borderRadius: 6,
  cursor: "pointer",
  flexShrink: 0,
};

/**
 * The modal used to stack five panels behind one inner scrollbar: identity,
 * change history, contact fields, the verification gate and password. Finding
 * anything meant scrolling a dialog. Contact and verification stay together
 * because they are one task — edit, verify, save.
 */
const TABS = [
  { id: "profile", label: "Profile" },
  { id: "contact", label: "Contact" },
  { id: "password", label: "Password" },
  { id: "history", label: "History" },
];

function toTimestamp(value) {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatCountdown(targetTimestamp, nowTimestamp) {
  if (!targetTimestamp) return "00:00";
  const totalSeconds = Math.max(0, Math.ceil((targetTimestamp - nowTimestamp) / 1000));
  const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizePhone(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const hasPlus = raw.startsWith("+");
  const digits = raw.replace(/\D+/g, "");
  return digits ? `${hasPlus ? "+" : ""}${digits}` : "";
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function isValidPhone(value) {
  const normalized = normalizePhone(value);
  if (!normalized) return true;
  const digits = normalized.replace(/\D+/g, "");
  return digits.length >= 10 && digits.length <= 15;
}

function maskEmail(value) {
  const email = String(value || "").trim();
  if (!email || !email.includes("@")) return email;
  const [localPart, domain] = email.split("@");
  const safeLocal = localPart ? `${localPart.slice(0, 1)}${"*".repeat(Math.max(1, localPart.length - 1))}` : "*";
  const [domainName = "", ...domainRest] = domain.split(".");
  const safeDomain = domainName ? `${domainName.slice(0, 1)}${"*".repeat(Math.max(1, domainName.length - 1))}` : "*";
  return `${safeLocal}@${safeDomain}${domainRest.length ? `.${domainRest.join(".")}` : ""}`;
}

function buildFormErrors(form) {
  const errors = { email: "", phone_number: "" };
  if (!isValidEmail(form.email)) {
    errors.email = "Enter a valid email address.";
  }
  if (!isValidPhone(form.phone_number)) {
    errors.phone_number = "Phone number must be 10 to 15 digits.";
  }
  return errors;
}

function buildChangeList(changes) {
  if (!changes || typeof changes !== "object") return [];
  return Object.entries(changes).map(([field, value]) => {
    const label = field === "phone_number" ? "Phone number" : "Email address";
    return {
      field,
      label,
      before: value?.before || "Not set",
      after: value?.after || "Not set",
    };
  });
}

/**
 * Read-only values are typography, not disabled inputs. Boxing them made the
 * dialog look like a form where nothing could be edited.
 */
function ReadOnlyField({ label, value, children }) {
  return (
    <div style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={{ color: "var(--text-muted)", fontSize: 10.5, fontWeight: 600, letterSpacing: 0.3, textTransform: "uppercase" }}>
        {label}
      </span>
      {children || (
        <span style={{ color: "var(--text-primary)", fontSize: 12.5, fontWeight: 500, overflowWrap: "anywhere", lineHeight: 1.45 }}>
          {value || "—"}
        </span>
      )}
    </div>
  );
}

/**
 * The Profile tab was one flat six-field grid, which gave a name, a campus and
 * a role all the same weight and left the lower half of the dialog empty.
 * Grouping into labelled cards creates the hierarchy that was missing and fills
 * the fixed height honestly, without padding it out with invented fields.
 */
function InfoSection({ title, children }) {
  return (
    <section
      style={{
        border: "1px solid var(--border-base)",
        borderRadius: 9,
        background: "var(--surface-base)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          background: "var(--surface-page)",
          borderBottom: "1px solid var(--border-base)",
          color: "var(--text-muted)",
          fontSize: 10.5,
          fontWeight: 700,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {title}
      </div>
      <div
        style={{
          padding: 12,
          display: "grid",
          gap: 13,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 195px), 1fr))",
        }}
      >
        {children}
      </div>
    </section>
  );
}

/**
 * Account status is deliberately not shown here. The session refresh destroys
 * the session unless api_user_is_active() passes, so anyone who can open this
 * dialog is active — the field would read "Active" and nothing else, forever.
 */
/**
 * Password expiry, in the dialog that is about the account.
 *
 * The header's account menu has shown this all along while the Profile dialog —
 * the screen with a Password tab on it — said nothing about when the current
 * password dies. Reads `user.password_expiration`, which DashboardShell already
 * keeps fresh on the session user, so this costs no request.
 *
 * Tone comes from the server's own status word rather than from re-deriving a
 * threshold here, so the dialog and the header cannot disagree about whether a
 * password is nearly expired.
 */
function describePasswordExpiry(expiration) {
  if (!expiration) return null;

  const status = String(expiration.status || "").toLowerCase();
  const remaining = String(expiration.remaining_label || "").trim();
  const on = String(expiration.expires_at_display || "").trim();

  const tones = {
    expired: { border: "var(--danger-200)", background: "var(--danger-50)" },
    red: { border: "var(--danger-200)", background: "var(--danger-50)" },
    orange: { border: "var(--warning-200, #fde68a)", background: "var(--warning-50, #fffbeb)" },
  };

  return {
    ...(tones[status] || { border: "var(--border-base)", background: "var(--surface-page)" }),
    headline:
      status === "expired"
        ? "Your password has expired"
        : remaining
        ? `Password expires ${remaining}`
        : "Password expiry",
    detail: on ? `Expires on ${on}.` : "No expiry date scheduled for this account.",
  };
}

/** Ordinal for the verification steps. Decorative, so it is hidden from AT — the
 *  labels already read in order. */
function StepMarker({ n }) {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-grid",
        placeItems: "center",
        width: 15,
        height: 15,
        borderRadius: 999,
        background: "var(--brand-100)",
        color: "var(--brand-800)",
        fontSize: 10.5,
        fontWeight: 700,
        marginRight: 5,
        verticalAlign: "middle",
      }}
    >
      {n}
    </span>
  );
}

function SectionHeading({ title, description }) {
  return (
    <div style={{ display: "grid", gap: 3 }}>
      <h3 style={{ margin: 0, color: "var(--text-primary)", fontSize: 14, fontWeight: 600 }}>{title}</h3>
      {description ? (
        <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.55 }}>{description}</p>
      ) : null}
    </div>
  );
}

export default function ProfileManagementModal({ open = true, user, onClose, onUserUpdate }) {
  const [loading, setLoading] = useState(false);
  const [sendingOtp, setSendingOtp] = useState(false);
  const [saving, setSaving] = useState(false);
  const [banner, setBanner] = useState({ tone: "info", message: "" });
  const [profileUser, setProfileUser] = useState(user || null);
  const [history, setHistory] = useState([]);
  const [verification, setVerification] = useState(null);
  const [form, setForm] = useState({
    email: user?.email || "",
    phone_number: user?.phone_number || "",
  });
  const [otpCode, setOtpCode] = useState("");
  const [captchaAnswer, setCaptchaAnswer] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [activeTab, setActiveTab] = useState("profile");
  const panelRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const intervalId = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(intervalId);
  }, [open]);

  // One scroll container is reused for every tab, so a scrolled Contact tab
  // would otherwise hand Profile over already scrolled down.
  useEffect(() => {
    if (panelRef.current) panelRef.current.scrollTop = 0;
  }, [activeTab]);

  useEffect(() => {
    if (!open) return undefined;

    function handleEscape(event) {
      if (event.key === "Escape") {
        onClose?.();
      }
    }

    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;

    async function loadModalProfile() {
      setLoading(true);
      setBanner({ tone: "info", message: "" });

      try {
        const payload = await getProfile();
        if (cancelled) return;

        const nextUser = payload?.user || null;
        setProfileUser(nextUser);
        setHistory(Array.isArray(payload?.history) ? payload.history : []);
        setVerification(payload?.verification || null);
        setForm({
          email: nextUser?.email || "",
          phone_number: nextUser?.phone_number || "",
        });
        setOtpCode("");
        setCaptchaAnswer("");
      } catch (error) {
        if (cancelled) return;
        setBanner({ tone: "error", message: error?.message || "Failed to load profile." });
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void loadModalProfile();
    return () => {
      cancelled = true;
    };
  }, [open, user?.user_id]);

  const formErrors = useMemo(() => buildFormErrors(form), [form]);
  const hasValidationErrors = Boolean(formErrors.email || formErrors.phone_number);
  const hasChanges =
    normalizeEmail(form.email) !== normalizeEmail(profileUser?.email) ||
    normalizePhone(form.phone_number) !== normalizePhone(profileUser?.phone_number);

  const cooldownEndsAtMs = toTimestamp(verification?.otp?.cooldown_ends_at);
  const otpExpiresAtMs = toTimestamp(verification?.otp?.expires_at);
  const otpPending = Boolean(verification?.otp?.pending);
  // Students may change their contact number only; the server refuses an
  // email change from them as well, see profile_is_student() in profile.php.
  const emailLocked = verification?.email_locked === true;
  const emailOtpAvailable = verification?.email_otp?.available !== false;
  const emailOtpMessage = verification?.email_otp?.message || "";
  const otpTargetMismatch =
    otpPending &&
    (
      normalizeEmail(form.email) !== normalizeEmail(verification?.otp?.pending_email) ||
      normalizePhone(form.phone_number) !== normalizePhone(verification?.otp?.pending_phone_number)
    );
  const otpPreviewEmail = isValidEmail(form.email) ? maskEmail(form.email) : "";
  const canSendOtp =
    hasChanges &&
    !hasValidationErrors &&
    !sendingOtp &&
    isValidEmail(form.email) &&
    emailOtpAvailable &&
    (!cooldownEndsAtMs || cooldownEndsAtMs <= nowMs);
  const canSave =
    hasChanges &&
    !hasValidationErrors &&
    otpPending &&
    !otpTargetMismatch &&
    otpCode.trim() !== "" &&
    captchaAnswer.trim() !== "" &&
    !saving;

  /**
   * Closing discards whatever is typed, and the overlay covers the whole
   * viewport — a stray click outside used to throw away a half-finished edit
   * with no warning.
   */
  function requestClose() {
    if (hasChanges && !window.confirm("Discard your unsaved contact changes?")) return;
    onClose?.();
  }

  function handleTabKeyDown(event) {
    const navigationKeys = ["ArrowLeft", "ArrowRight", "Home", "End"];
    if (!navigationKeys.includes(event.key)) return;
    event.preventDefault();

    const lastIndex = TABS.length - 1;
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex;
    if (event.key === "Home") nextIndex = 0;
    else if (event.key === "End") nextIndex = lastIndex;
    else if (event.key === "ArrowRight") nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
    else nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;

    const nextTab = TABS[nextIndex];
    if (!nextTab) return;
    setActiveTab(nextTab.id);
    document.getElementById(`profile-tab-${nextTab.id}`)?.focus();
  }

  async function handleRefreshCaptcha() {
    try {
      const payload = await refreshProfileCaptcha();
      if (payload?.verification?.captcha) {
        setVerification((current) => ({
          ...(current || {}),
          captcha: payload.verification.captcha,
        }));
      }
      setCaptchaAnswer("");
    } catch (error) {
      setBanner({ tone: "error", message: error?.message || "Failed to refresh CAPTCHA." });
    }
  }

  async function handleSendOtp() {
    if (!canSendOtp) return;

    setSendingOtp(true);
    setBanner({ tone: "info", message: "" });

    try {
      const payload = await sendProfileOtp({
        email: form.email.trim(),
        phone_number: normalizePhone(form.phone_number),
      });

      if (payload?.verification?.otp) {
        setVerification((current) => ({
          ...(current || {}),
          otp: payload.verification.otp,
        }));
      }
      if (payload?.verification?.email_otp) {
        setVerification((current) => ({
          ...(current || {}),
          email_otp: payload.verification.email_otp,
        }));
      }
      setOtpCode("");
      void notifySuccess(
        "OTP sent",
        `A verification code was sent to ${payload?.verification?.otp?.masked_destination || otpPreviewEmail || "your email address"}. Check spam or junk if it does not appear.`,
        {
          toast: true,
          position: "top-end",
          timer: 2200,
          timerProgressBar: true,
          showConfirmButton: false,
        }
      );
    } catch (error) {
      if (error?.data?.verification?.email_otp) {
        setVerification((current) => ({
          ...(current || {}),
          email_otp: error.data.verification.email_otp,
        }));
      }
      if (error?.data?.verification?.otp) {
        setVerification((current) => ({
          ...(current || {}),
          otp: error.data.verification.otp,
        }));
      }
      setBanner({ tone: "error", message: error?.message || "Failed to send OTP." });
      void notifyError("OTP send failed", error?.message || "Failed to send OTP.");
    } finally {
      setSendingOtp(false);
    }
  }

  // ChangePasswordForm owns the whole flow; the modal only reports the outcome
  // and refreshes the cached auth user so expiry state stays current.
  async function handlePasswordChanged(payload) {
    const message = payload?.message || "Your password was updated successfully.";
    if (payload?.user) {
      setAuthUser(payload.user);
      onUserUpdate?.(payload.user);
    }
    setBanner({ tone: "success", message });
    logAuditEvent({
      action: "password_changed",
      user: payload?.user || profileUser,
      detail: "Changed account password from the profile modal.",
    });
    void notifySuccess("Password changed", message, { toast: true });
  }

  async function handleSave() {
    if (!canSave) return;

    setSaving(true);
    setBanner({ tone: "info", message: "" });

    try {
      const payload = await updateProfile({
        email: form.email.trim(),
        phone_number: normalizePhone(form.phone_number),
        otp_code: otpCode.trim(),
        captcha_token: verification?.captcha?.token || "",
        captcha_answer: captchaAnswer.trim(),
      });

      const nextUser = payload?.user || profileUser;
      setProfileUser(nextUser);
      setHistory(Array.isArray(payload?.history) ? payload.history : []);
      setVerification(payload?.verification || null);
      setForm({
        email: nextUser?.email || "",
        phone_number: nextUser?.phone_number || "",
      });
      setOtpCode("");
      setCaptchaAnswer("");
      setAuthUser(nextUser);
      onUserUpdate?.(nextUser);
      logAuditEvent({
        action: "profile_updated",
        user: nextUser,
        detail: "Updated profile contact information.",
        metadata: {
          email: nextUser?.email || "",
          phone_number: nextUser?.phone_number || "",
        },
      });

      void notifySuccess("Profile updated", payload?.message || "Your profile changes were saved.", {
        toast: true,
        position: "top-end",
        timer: 2400,
        timerProgressBar: true,
        showConfirmButton: false,
      });
    } catch (error) {
      if (error?.data?.verification?.captcha) {
        setVerification((current) => ({
          ...(current || {}),
          captcha: error.data.verification.captcha,
        }));
        setCaptchaAnswer("");
      }
      setBanner({ tone: "error", message: error?.message || "Failed to update profile." });
      void notifyError("Profile update failed", error?.message || "Failed to update profile.");
    } finally {
      setSaving(false);
    }
  }

  if (!open) return null;

  const initials = getUserInitials(profileUser || user || {});
  // `user` is the live session object DashboardShell refreshes; `profileUser`
  // comes from the profile fetch and may not carry expiry at all.
  const passwordExpiry = describePasswordExpiry(user?.password_expiration || profileUser?.password_expiration);

  return (
    <div style={overlayStyle} onClick={requestClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Profile management"
        style={modalStyle}
        onClick={(event) => event.stopPropagation()}
      >
        {/* ------------------------------------------------------- header */}
        <div
          style={{
            padding: "14px 16px 0",
            borderBottom: "1px solid var(--border-base)",
            flexShrink: 0,
          }}
        >
          {/*
            * The identity band carries name, role and posting together. It used
            * to show name and role only, and the Profile tab repeated both — so
            * the default tab opened on two facts already on screen. Putting the
            * whole standing here lets that tab hold what is actually its own.
            */}
          <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "flex-start" }}>
            <div style={{ display: "flex", gap: 11, alignItems: "center", minWidth: 0 }}>
              {/* Flat brand tint, not a gradient. The dialog had three separate
                  gradient treatments competing for attention. */}
              <div
                style={{
                  width: 44,
                  height: 44,
                  borderRadius: 11,
                  background: "var(--brand-100)",
                  color: "var(--brand-800)",
                  fontSize: 14,
                  fontWeight: 700,
                  display: "grid",
                  placeItems: "center",
                  flexShrink: 0,
                }}
                aria-hidden="true"
              >
                {initials}
              </div>
              <div style={{ minWidth: 0, display: "grid", gap: 3 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap", minWidth: 0 }}>
                  <h2 style={{ margin: 0, color: "var(--text-primary)", fontSize: 16, fontWeight: 650, lineHeight: 1.2 }}>
                    {profileUser?.name || "My Profile"}
                  </h2>
                  {profileUser?.role_name ? (
                    <span
                      style={{
                        borderRadius: 999,
                        background: "var(--brand-50)",
                        border: "1px solid var(--brand-200)",
                        color: "var(--brand-800)",
                        fontSize: 10.5,
                        fontWeight: 600,
                        padding: "1.5px 8px",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {profileUser.role_name}
                    </span>
                  ) : null}
                </div>
                {/* Middot-joined so an account with no department or campus
                    simply reads shorter, instead of showing "— · —". */}
                <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 11.5, overflowWrap: "anywhere", lineHeight: 1.4 }}>
                  {[profileUser?.department_name, profileUser?.campus_name, profileUser?.email]
                    .map((part) => String(part || "").trim())
                    .filter(Boolean)
                    .join(" · ") || "User account"}
                </p>
              </div>
            </div>
            <button type="button" onClick={requestClose} style={closeButtonStyle} aria-label="Close profile management">
              <CloseIcon />
            </button>
          </div>

          <div role="tablist" aria-label="Profile sections" style={{ display: "flex", gap: 2, marginTop: 12, overflowX: "auto" }}>
            {TABS.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  id={`profile-tab-${tab.id}`}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={`profile-panel-${tab.id}`}
                  tabIndex={selected ? 0 : -1}
                  onClick={() => setActiveTab(tab.id)}
                  onKeyDown={handleTabKeyDown}
                  className="profile-tab"
                >
                  {tab.label}
                  {/* Unsaved edits live on the Contact tab, which may not be the
                      one on screen — the dot keeps that visible from anywhere. */}
                  {tab.id === "contact" && hasChanges ? (
                    <span className="profile-tab-dot" aria-label="unsaved changes" />
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        {/* ------------------------------------------------------- content */}
        <div
          ref={panelRef}
          id={`profile-panel-${activeTab}`}
          role="tabpanel"
          aria-labelledby={`profile-tab-${activeTab}`}
          style={{ padding: 16, overflowY: "auto", flex: 1, minHeight: 0 }}
        >
          {banner.message ? <AlertMessage tone={banner.tone} message={banner.message} /> : null}

          {loading ? (
            <DashboardPanel variant="dashed" style={{ fontSize: 12.5 }}>
              Loading profile details...
            </DashboardPanel>
          ) : activeTab === "profile" ? (
            <div style={{ display: "grid", gap: 12 }}>
              <SectionHeading
                title="Account details"
                description="Set by your administrator. Only your contact details can be changed here."
              />

              {/*
                * Name, role, department and campus all moved into the header
                * band, and email/phone are the Contact tab's entire subject.
                * Repeating them made this tab open on nothing new, so what is
                * left is what only this tab says: who the account is on paper,
                * and where its two editable values currently stand.
                */}
              <InfoSection title="Account">
                {profileUser?.student_number ? (
                  <ReadOnlyField label="Student number" value={profileUser.student_number} />
                ) : null}
                <ReadOnlyField label="Member since" value={formatDate(profileUser?.created_at)} />
                <ReadOnlyField
                  label="Contact last changed"
                  value={history.length > 0 ? formatDateTime(history[0]?.created_at) : "Never"}
                />
              </InfoSection>

              <section
                style={{
                  border: "1px solid var(--border-base)",
                  borderRadius: 9,
                  padding: 12,
                  display: "grid",
                  gap: 11,
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 10.5, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase" }}>
                    Editable details
                  </span>
                  {/* The tab said contact was editable elsewhere and then made
                      you find it. Naming the destination is not enough — go
                      there. */}
                  <button
                    type="button"
                    onClick={() => setActiveTab("contact")}
                    style={{
                      border: "1px solid var(--border-base)",
                      background: "var(--surface-base)",
                      color: "var(--text-secondary)",
                      borderRadius: 6,
                      fontSize: 11,
                      fontWeight: 600,
                      padding: "3px 9px",
                      cursor: "pointer",
                    }}
                  >
                    Edit
                  </button>
                </div>

                <div style={{ display: "grid", gap: 13, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 195px), 1fr))" }}>
                  <ReadOnlyField label="Email address" value={profileUser?.email} />
                  <ReadOnlyField label="Phone number" value={profileUser?.phone_number || "Not set"} />
                </div>
              </section>

              {passwordExpiry ? (
                <section
                  style={{
                    border: `1px solid ${passwordExpiry.border}`,
                    background: passwordExpiry.background,
                    borderRadius: 9,
                    padding: "10px 12px",
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 9,
                    alignItems: "center",
                    flexWrap: "wrap",
                  }}
                >
                  <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <span style={{ color: "var(--text-primary)", fontSize: 12.5, fontWeight: 600 }}>
                      {passwordExpiry.headline}
                    </span>
                    <span style={{ color: "var(--text-secondary)", fontSize: 11, lineHeight: 1.5 }}>
                      {passwordExpiry.detail}
                    </span>
                  </div>
                  <Button variant="secondary" onClick={() => setActiveTab("password")} style={{ height: 30 }}>
                    Change password
                  </Button>
                </section>
              ) : null}
            </div>
          ) : activeTab === "contact" ? (
            <div style={{ display: "grid", gap: 16 }}>
              <SectionHeading
                title="Contact information"
                description={emailLocked
                  ? "You can change your contact number here. Your school email cannot be changed. Saving needs a one-time code sent to your email and a CAPTCHA."
                  : "Changing your email or phone requires a one-time code and a CAPTCHA. Duplicates are re-checked on the server before saving."}
              />

              <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 204px), 1fr))" }}>
                <div>
                  <Label htmlFor="profile_email">Email address</Label>
                  <Input
                    id="profile_email"
                    type="email"
                    autoComplete="email"
                    value={form.email}
                    onChange={(event) => setForm((current) => ({ ...current, email: event.target.value }))}
                    placeholder="name@example.com"
                    error={formErrors.email}
                    readOnly={emailLocked}
                    aria-readonly={emailLocked || undefined}
                    title={emailLocked ? "Students cannot change their email address" : undefined}
                    className={emailLocked ? "h-11 !bg-slate-100 !text-slate-500 cursor-not-allowed" : "h-11"}
                  />
                  {emailLocked ? (
                    <div style={{ marginTop: 4, color: "var(--text-muted)", fontSize: 11 }}>
                      Set by the school. It cannot be changed here.
                    </div>
                  ) : null}
                </div>

                <div>
                  <Label htmlFor="profile_phone">{emailLocked ? "Contact number" : "Phone number"}</Label>
                  <Input
                    id="profile_phone"
                    type="tel"
                    autoComplete="tel"
                    value={form.phone_number}
                    onChange={(event) => setForm((current) => ({ ...current, phone_number: event.target.value }))}
                    placeholder="+639171234567"
                    error={formErrors.phone_number}
                    className="h-11"
                  />
                </div>
              </div>

              {!hasChanges ? (
                <AlertMessage
                  tone="info"
                  message={emailLocked ? "Edit your contact number to begin verification." : "Edit your email or phone number to begin verification."}
                  style={{ marginBottom: 0 }}
                />
              ) : otpTargetMismatch ? (
                <AlertMessage tone="warning" message="Your pending code was sent for older values. Resend it before saving." style={{ marginBottom: 0 }} />
              ) : null}

              {/* Verification stays on this tab: editing, verifying and saving
                  are one task, and splitting them would hide the gate behind a
                  tab the user has no reason to open. */}
              <div style={{ borderTop: "1px solid var(--border-base)", paddingTop: 16, display: "grid", gap: 12 }}>
                {/*
                  * Numbered, because this is a sequence and it used to render as
                  * three stacked boxes of equal weight — a status panel, a code
                  * row and a CAPTCHA row — with nothing saying the code has to
                  * be sent before it can be typed.
                  */}
                <SectionHeading title="Verification" description="Two steps, in order." />

                <div
                  style={{
                    borderRadius: 8,
                    border: `1px solid ${emailOtpAvailable ? "var(--brand-200)" : "var(--danger-200)"}`,
                    background: emailOtpAvailable ? "var(--brand-50)" : "var(--danger-50)",
                    padding: "9px 11px",
                    display: "grid",
                    gap: 3,
                  }}
                >
                  <div style={{ color: "var(--text-primary)", fontSize: 12.5, fontWeight: 600, overflowWrap: "anywhere" }}>
                    {otpPreviewEmail || "Enter a valid email address to receive your code."}
                  </div>
                  <div style={{ color: emailOtpAvailable ? "var(--text-secondary)" : "var(--danger-800)", fontSize: 11.5, lineHeight: 1.5 }}>
                    {!emailOtpAvailable
                      ? emailOtpMessage || "Email OTP service is not configured on the server."
                      : emailLocked
                        ? "The code goes to your school email."
                        : "If you changed the email field, the code goes to the new address. Otherwise it goes to your registered email."}
                  </div>
                </div>

                <div style={{ display: "flex", gap: 9, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div style={{ flex: "1 1 200px", minWidth: 0 }}>
                    <Label htmlFor="profile_otp">
                      <StepMarker n={1} /> One-time code
                    </Label>
                    <Input
                      id="profile_otp"
                      type="text"
                      inputMode="numeric"
                      maxLength={6}
                      value={otpCode}
                      onChange={(event) => setOtpCode(event.target.value.replace(/\D+/g, "").slice(0, 6))}
                      placeholder="6-digit code"
                      className="h-11"
                    />
                  </div>
                  <Button onClick={handleSendOtp} disabled={!canSendOtp} style={{ height: 37 }}>
                    {sendingOtp ? "Sending..." : otpPending ? "Resend code" : "Send code"}
                  </Button>
                </div>

                {otpPending ? (
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap", color: "var(--text-muted)", fontSize: 11 }}>
                    <span>
                      Sent to <strong style={{ color: "var(--text-secondary)" }}>{verification?.otp?.masked_destination || otpPreviewEmail || "-"}</strong>
                    </span>
                    <span>
                      {cooldownEndsAtMs && cooldownEndsAtMs > nowMs
                        ? `Resend in ${formatCountdown(cooldownEndsAtMs, nowMs)}`
                        : otpExpiresAtMs
                        ? `Expires ${formatDateTime(verification?.otp?.expires_at)}`
                        : "Code ready"}
                    </span>
                  </div>
                ) : null}

                <div style={{ display: "flex", gap: 9, alignItems: "flex-end", flexWrap: "wrap" }}>
                  <div>
                    <Label htmlFor="profile_captcha">
                      <StepMarker n={2} /> Security check
                    </Label>
                    <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                      <div
                        style={{
                          height: 37,
                          borderRadius: 8,
                          border: "1px solid var(--border-base)",
                          background: "var(--surface-page)",
                          padding: "0 11px",
                          display: "flex",
                          alignItems: "center",
                          gap: 6,
                          color: "var(--text-primary)",
                          fontSize: 12.5,
                          fontWeight: 600,
                          fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                        }}
                        aria-hidden="true"
                      >
                        <span>{verification?.captcha?.left ?? "-"}</span>
                        <span style={{ color: "var(--text-faint)" }}>+</span>
                        <span>{verification?.captcha?.right ?? "-"}</span>
                        <span style={{ color: "var(--text-faint)" }}>=</span>
                      </div>
                      <Input
                        id="profile_captcha"
                        type="text"
                        inputMode="numeric"
                        value={captchaAnswer}
                        onChange={(event) => setCaptchaAnswer(event.target.value.replace(/\D+/g, "").slice(0, 3))}
                        placeholder="?"
                        aria-label={`What is ${verification?.captcha?.left ?? ""} plus ${verification?.captcha?.right ?? ""}?`}
                        className="h-11 w-[61px] text-center font-mono font-semibold"
                      />
                    </div>
                  </div>
                  <Button variant="secondary" onClick={handleRefreshCaptcha} style={{ height: 37 }}>
                    New question
                  </Button>
                </div>
              </div>
            </div>
          ) : activeTab === "password" ? (
            <div style={{ display: "grid", gap: 16 }}>
              <SectionHeading
                title="Change password"
                description="Requires your current password plus a 6-digit code emailed to you. The code expires in 10 minutes and works only once."
              />

              {/* The one tab where expiry is directly actionable, so it leads. */}
              {passwordExpiry ? (
                <div
                  style={{
                    border: `1px solid ${passwordExpiry.border}`,
                    background: passwordExpiry.background,
                    borderRadius: 9,
                    padding: "9px 11px",
                    display: "grid",
                    gap: 2,
                  }}
                >
                  <span style={{ color: "var(--text-primary)", fontSize: 12.5, fontWeight: 600 }}>
                    {passwordExpiry.headline}
                  </span>
                  <span style={{ color: "var(--text-secondary)", fontSize: 11, lineHeight: 1.5 }}>
                    {passwordExpiry.detail}
                  </span>
                </div>
              ) : null}

              <div style={{ maxWidth: 391 }}>
                <ChangePasswordForm onSuccess={handlePasswordChanged} submitLabel="Change Password" />
              </div>
            </div>
          ) : (
            <div style={{ display: "grid", gap: 16 }}>
              <SectionHeading
                title="Change history"
                description="Contact detail updates recorded against your account."
              />

              {history.length === 0 ? (
                <DashboardPanel variant="dashed" style={{ fontSize: 12.5 }}>
                  No profile changes recorded yet.
                </DashboardPanel>
              ) : (
                <div style={{ display: "grid", gap: 8 }}>
                  {history.map((entry) => (
                    <div
                      key={entry.id}
                      style={{
                        border: "1px solid var(--border-base)",
                        borderRadius: 8,
                        padding: "9px 11px",
                        display: "grid",
                        gap: 6,
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "baseline", flexWrap: "wrap" }}>
                        <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>{entry?.detail || "Profile updated"}</strong>
                        <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{formatDateTime(entry?.created_at)}</span>
                      </div>
                      {buildChangeList(entry?.changes).map((change) => (
                        <div key={`${entry.id}-${change.field}`} style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
                          <span style={{ color: "var(--text-muted)" }}>{change.label}: </span>
                          <span style={{ textDecoration: "line-through", color: "var(--text-faint)" }}>{change.before}</span>
                          <span style={{ color: "var(--text-faint)" }}> → </span>
                          <span style={{ color: "var(--text-primary)" }}>{change.after}</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Footer is fixed rather than buried at the bottom of a long scroll, so
            Save is reachable without hunting for it. */}
        {!loading && activeTab === "contact" ? (
          <div
            style={{
              flexShrink: 0,
              borderTop: "1px solid var(--border-base)",
              background: "var(--surface-page)",
              padding: "9px 16px",
              display: "flex",
              justifyContent: "flex-end",
              gap: 8,
              flexWrap: "wrap",
            }}
          >
            <Button variant="secondary" onClick={requestClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!canSave}>
              {saving ? "Saving..." : "Save changes"}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
