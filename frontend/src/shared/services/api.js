import axios from "axios";
import { getBackendUrl } from "../lib/url";
import { apiRequestHeaders, authHeader, getAccessToken, refreshAccessToken, setAccessToken } from "../lib/authToken";
import { adoptServerSessionPolicy } from "../lib/securityPolicy";

const apiClient = axios.create({
  withCredentials: true,
  timeout: 20000,
  headers: {
    Accept: "application/json",
  },
});

/*
 * The axios half of the token plumbing. The window.fetch wrapper in
 * authToken.js covers the ~137 raw fetch() call sites; this covers the ~20
 * auth/profile endpoints that go through axios, and the two have to behave the
 * same way or a token would work on most of the app and not the rest.
 */
apiClient.interceptors.request.use((config) => {
  config.headers = { ...apiRequestHeaders(), ...(config.headers || {}) };
  return config;
});

/** Same rule as the fetch wrapper: a 401 from these is an answer, not an expiry. */
function isAuthEndpoint(url) {
  return /\/(refresh|login|logout)\.php(\?|$)/.test(String(url || ""));
}

apiClient.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error?.config;
    const status = error?.response?.status;

    // Retried once and once only — `_retried` is what stops a persistently
    // rejecting endpoint from looping through refresh forever.
    if (
      status !== 401 ||
      !config ||
      config._retried ||
      !getAccessToken() ||
      isAuthEndpoint(config.url)
    ) {
      return Promise.reject(error);
    }

    config._retried = true;
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      return Promise.reject(error);
    }

    config.headers = { ...(config.headers || {}), ...authHeader() };
    return apiClient(config);
  }
);

/*
 * axios's own words for a request that never got an answer ("timeout of
 * 20000ms exceeded", "Network Error") meant nothing to the person reading them;
 * a password reset on the live site showed the first one on 2026-10-08.
 */
function noAnswerMessage(err) {
  if (err?.response) return "";
  if (err?.code === "ECONNABORTED" || err?.code === "ETIMEDOUT" || /timeout of \d+ms exceeded/i.test(err?.message || "")) {
    return "The server took too long to answer. Please try again in a moment.";
  }
  if (err?.code === "ERR_NETWORK" || err?.message === "Network Error") {
    return "Could not reach the server. Check your internet connection and try again.";
  }
  return "";
}

function toApiError(err, fallbackMessage) {
  const message =
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    noAnswerMessage(err) ||
    err?.message ||
    fallbackMessage;
  const error = new Error(message);
  error.status = err?.response?.status ?? null;
  error.data = err?.response?.data ?? null;
  return error;
}

export async function login(email, password, captchaToken) {
  try {
    const url = getBackendUrl("login.php");
    const res = await apiClient.post(url, { email, password, captcha_token: captchaToken }, {
      headers: { "Content-Type": "application/json" },
    });
    const data = res?.data;

    if (!data || !data.user) {
      throw new Error("Unexpected server response");
    }

    // Before the dashboard mounts, so the first idle check already measures
    // against the institution's timeout rather than this browser's last one.
    adoptServerSessionPolicy(data);

    return data;
  } catch (err) {
    throw toApiError(err, "Login failed");
  }
}

export async function getResetCaptcha() {
  try {
    const res = await apiClient.get(getBackendUrl("send-reset-code.php"));
    return res?.data?.captcha;
  } catch (err) {
    throw toApiError(err, "Could not load the CAPTCHA. Please refresh it.");
  }
}

export async function sendResetCode(email, captchaToken) {
  try {
    const url = getBackendUrl("send-reset-code.php");
    const res = await apiClient.post(url, { email, captcha_token: captchaToken }, {
      timeout: 45000,
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to send reset code");
  }
}

export async function verifyResetCode(email, code) {
  try {
    const url = getBackendUrl("verify-reset-code.php");
    const res = await apiClient.post(url, { email, code }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to verify reset code");
  }
}

export async function resetPassword(email, new_password, verification_token) {
  try {
    const url = getBackendUrl("reset-password.php");
    const res = await apiClient.post(url, { email, new_password, verification_token }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to reset password");
  }
}

export async function getCurrentUser() {
  try {
    const res = await apiClient.get(getBackendUrl("me.php"));
    adoptServerSessionPolicy(res?.data);
    return res?.data;
  } catch (err) {
    // 401 means not authenticated — return null user instead of throwing
    if (err?.response?.status === 401) {
      return { user: null };
    }
    throw toApiError(err, "Failed to restore session");
  }
}

export async function logoutSession() {
  try {
    const res = await apiClient.post(getBackendUrl("logout.php"));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to logout");
  }
}

export async function getProfile(options = {}) {
  try {
    const params = new URLSearchParams();
    if (options?.refreshCaptcha) {
      params.set("refresh_captcha", "1");
    }

    const path = params.toString() ? `profile.php?${params.toString()}` : "profile.php";
    const res = await apiClient.get(getBackendUrl(path));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load profile");
  }
}

export async function refreshProfileCaptcha() {
  try {
    const res = await apiClient.post(getBackendUrl("profile.php"), { action: "refresh_captcha" }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to refresh CAPTCHA");
  }
}

export async function sendProfileOtp(payload) {
  try {
    const res = await apiClient.post(getBackendUrl("profile.php"), { action: "send_otp", ...payload }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to send OTP");
  }
}

export async function updateProfile(payload) {
  try {
    const res = await apiClient.put(getBackendUrl("profile.php"), payload, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to update profile");
  }
}

export async function getBackendSecurityPolicy() {
  try {
    const res = await apiClient.get(getBackendUrl("security_policy.php"));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load security policy");
  }
}

export async function getLoginCaptchaPolicy() {
  try {
    const res = await apiClient.get(getBackendUrl("captcha_policy.php"));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load CAPTCHA policy");
  }
}

export async function saveLoginCaptchaPolicy(enabled) {
  try {
    const res = await apiClient.put(getBackendUrl("captcha_policy.php"), {
      login_captcha_enabled: Boolean(enabled),
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to save CAPTCHA policy");
  }
}

/**
 * Switch every outgoing email on or off.
 *
 * Shares security_policy.php because it is one Settings screen and access is
 * granted per endpoint file. The server keeps this separate from the password
 * policy, so sending only this key leaves that policy untouched.
 */
export async function saveOutboundEmailEnabled(enabled) {
  try {
    const res = await apiClient.put(getBackendUrl("security_policy.php"), {
      outbound_email_enabled: Boolean(enabled),
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to save the outbound email switch");
  }
}

/**
 * The API flood limits.
 *
 * Its own call rather than a few more fields on saveBackendSecurityPolicy(),
 * because the server handles this branch first and answers from it — a PUT
 * carrying both the password policy and these limits would save the limits and
 * silently drop the rest. One concern per request keeps that impossible.
 *
 * `block_seconds` is sent in seconds; the form works in minutes, because
 * "600 seconds" is a number an administrator has to convert and "10 minutes" is
 * the sentence the 429 actually shows the person who hit it.
 */
export async function saveApiRateLimit(limits) {
  try {
    const res = await apiClient.put(getBackendUrl("security_policy.php"), {
      rate_limit_enabled: Boolean(limits.enabled),
      rate_limit_burst: Number(limits.burst),
      rate_limit_per_minute: Number(limits.perMinute),
      rate_limit_strikes: Number(limits.strikes),
      rate_limit_block_seconds: Math.round(Number(limits.blockMinutes) * 60),
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to save the API rate limit");
  }
}

export async function saveBackendSecurityPolicy(payload) {
  try {
    const res = await apiClient.put(getBackendUrl("security_policy.php"), payload, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to save security policy");
  }
}

/**
 * Term records — the snapshot of what each student was in a term, and the
 * semester lock that closing it applies.
 *
 * closeTerm rejects with status 409 and data.code "TERM_ALREADY_CLOSED" when the
 * semester is already closed, and reopenTerm with 409 "TERM_NOT_CLOSED" when it
 * is not. Neither is an error to swallow: both mean someone else acted first,
 * and the panel reloads to show what they did.
 *
 * restampTerm rejects with status 423 and data.code "TERM_CLOSED" on a closed
 * semester: its record is part of what closing froze.
 */
export async function getTermRecords() {
  try {
    const res = await apiClient.get(getBackendUrl("term_snapshot.php"));
    return res?.data?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load term records");
  }
}

export async function previewTermClose(schoolYearId, semesterId) {
  try {
    const res = await apiClient.get(getBackendUrl("term_snapshot.php"), {
      params: { action: "preview", school_year_id: schoolYearId, semester_id: semesterId },
    });
    return res?.data?.data;
  } catch (err) {
    throw toApiError(err, "Failed to preview the term close");
  }
}

async function postTermAction(body, fallbackMessage) {
  try {
    const res = await apiClient.post(getBackendUrl("term_snapshot.php"), body, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, fallbackMessage);
  }
}

/** Records the semester's students and locks its records, in one step. */
export function closeTerm({ schoolYearId, semesterId }) {
  return postTermAction(
    { action: "close", school_year_id: schoolYearId, semester_id: semesterId },
    "Failed to close the semester"
  );
}

/** Unlocks a closed semester. The reason is required and kept with it. */
export function reopenTerm({ schoolYearId, semesterId, reason }) {
  return postTermAction(
    { action: "reopen", school_year_id: schoolYearId, semester_id: semesterId, reason },
    "Failed to reopen the semester"
  );
}

/** Overwrites an open semester's student record with today's values. */
export function restampTerm({ schoolYearId, semesterId }) {
  return postTermAction(
    { action: "restamp", school_year_id: schoolYearId, semester_id: semesterId },
    "Failed to re-record the semester"
  );
}

export async function getPasswordExpirationUsers({ search = "", filter = "all", page = 1, limit = 50 } = {}) {
  try {
    const params = new URLSearchParams();
    params.set("scope", "users");
    params.set("filter", filter);
    params.set("page", String(page));
    params.set("limit", String(limit));
    if (String(search || "").trim()) {
      params.set("search", String(search).trim());
    }
    const res = await apiClient.get(getBackendUrl(`password_expiration.php?${params.toString()}`));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load password expiration users");
  }
}

export async function resetPasswordExpiration(userId) {
  try {
    const res = await apiClient.put(getBackendUrl("password_expiration.php"), {
      action: "reset",
      user_id: userId,
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to reset password expiration");
  }
}

export async function setUserPasswordExpirationDisabled(userId, disabled) {
  try {
    const res = await apiClient.put(getBackendUrl("password_expiration.php"), {
      action: "set_user_disabled",
      user_id: userId,
      disabled,
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to update user password expiration");
  }
}

export async function changeOwnPassword(payload) {
  try {
    const res = await apiClient.post(getBackendUrl("change-password.php"), payload, {
      headers: { "Content-Type": "application/json" },
    });

    /*
     * Changing the password revokes every token the account had, including the
     * one this request was made with. The endpoint issues a replacement pair for
     * exactly this tab; taking it here keeps the user signed in.
     *
     * Skipping this would still recover — the refresh cookie was rotated too, so
     * the next call would 401 and refresh — but it would spend a failed request
     * to learn something the response already said.
     */
    if (res?.data?.access_token) {
      setAccessToken(res.data.access_token);
    }

    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to change password");
  }
}

// Emails a one-time code to the signed-in user, required to confirm a password change.
export async function requestPasswordChangeCode() {
  try {
    const res = await apiClient.post(
      getBackendUrl("change-password.php"),
      { action: "send_code" },
      { headers: { "Content-Type": "application/json" } }
    );
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to send the verification code");
  }
}

// `getAllUsers` was removed: it requested `get-all.php`, which does not exist,
// so the call could only ever 404. Nothing imported it. UsersPage reads
// `user.php`, which is the real endpoint.

export async function getNotifications({ page = 1, limit = 10 } = {}) {
  try {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(limit));
    const res = await apiClient.get(getBackendUrl(`notifications.php?${params.toString()}`));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load notifications");
  }
}

export async function markNotificationRead(notificationId) {
  try {
    const res = await apiClient.put(getBackendUrl("notifications.php"), {
      action: "mark_read",
      notification_id: notificationId,
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to mark notification as read");
  }
}

export async function markAllNotificationsRead() {
  try {
    const res = await apiClient.put(getBackendUrl("notifications.php"), {
      action: "mark_all_read",
    }, {
      headers: { "Content-Type": "application/json" },
    });
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to mark all notifications as read");
  }
}

export async function clearReadNotifications() {
  try {
    const res = await apiClient.delete(getBackendUrl("notifications.php"));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to clear notifications");
  }
}

/**
 * The editable words for the retention statuses.
 *
 * Returns `{ installed, groups }`. `installed` is false when the migration has
 * not been run - the groups still come back, filled from the built-in
 * fallbacks, so the board renders either way and only the settings panel needs
 * to care about the difference.
 */
export async function getRetentionStatusLabels() {
  try {
    const res = await apiClient.get(getBackendUrl("retention_status_label.php"));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load retention status labels");
  }
}

/** Rename one status. The code it points at is fixed and never sent. */
export async function renameRetentionStatusLabel(labelId, label) {
  try {
    const res = await apiClient.put(
      getBackendUrl(`retention_status_label.php?id=${encodeURIComponent(labelId)}`),
      { label },
      { headers: { "Content-Type": "application/json" } },
    );
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to rename status");
  }
}

/**
 * The finance balance bands, as one ladder.
 *
 * Returns `{ installed, bands, using_fallback, problems }`. `using_fallback`
 * means the table holds a ladder the server had to reject, so the bands shown
 * are the built-in ones and NOT what the database says.
 */
export async function getFinanceBands() {
  try {
    const res = await apiClient.get(getBackendUrl("finance_bands.php"));
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to load balance bands");
  }
}

/**
 * Replace the whole ladder.
 *
 * All of it, every time — a band's lower bound is the band below it's upper
 * bound, so the bands cannot be saved one at a time without passing through a
 * state where some balance belongs to none of them. A band absent from `bands`
 * is retired; one with no `status_id` is created.
 */
export async function saveFinanceBands(bands) {
  try {
    const res = await apiClient.put(
      getBackendUrl("finance_bands.php"),
      { bands },
      { headers: { "Content-Type": "application/json" } },
    );
    return res?.data;
  } catch (err) {
    throw toApiError(err, "Failed to save balance bands");
  }
}
