import { getSessionTimeoutPolicyMinutes, setSessionTimeoutPolicyMinutes } from "./securityPolicy";
const SESSION_TIMEOUT_KEY = "session_timeout_minutes";
const SESSION_STARTED_KEY = "session_started_at";
const LAST_ACTIVITY_KEY = "last_activity_at";
const DEFAULT_TIMEOUT_MINUTES = 30;

export function getSessionTimeoutMinutes() {
  const policyMinutes = getSessionTimeoutPolicyMinutes();
  if (Number.isFinite(policyMinutes) && policyMinutes > 0) return policyMinutes;
  const raw = localStorage.getItem(SESSION_TIMEOUT_KEY);
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return DEFAULT_TIMEOUT_MINUTES;
}

export function setSessionTimeoutMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes) || minutes <= 0) return getSessionTimeoutMinutes();
  const rounded = Math.round(minutes);
  localStorage.setItem(SESSION_TIMEOUT_KEY, String(rounded));
  setSessionTimeoutPolicyMinutes(rounded);
  return rounded;
}

export function getSessionStartedAt() {
  const raw = localStorage.getItem(SESSION_STARTED_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getLastActivityAt() {
  const raw = localStorage.getItem(LAST_ACTIVITY_KEY);
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function recordActivity(at = Date.now()) {
  localStorage.setItem(LAST_ACTIVITY_KEY, String(at));
  return at;
}

export function startSession(startAt = Date.now()) {
  localStorage.setItem(SESSION_STARTED_KEY, String(startAt));
  recordActivity(startAt);
}

export function ensureSessionStart() {
  if (!getSessionStartedAt()) {
    startSession();
  } else if (!getLastActivityAt()) {
    recordActivity();
  }
}

export function clearSession() {
  localStorage.removeItem(SESSION_STARTED_KEY);
  localStorage.removeItem(LAST_ACTIVITY_KEY);
}

export function isSessionExpired(now = Date.now()) {
  const lastActivityAt = getLastActivityAt() ?? getSessionStartedAt();
  if (!lastActivityAt) return false;
  const timeoutMs = getSessionTimeoutMinutes() * 60 * 1000;
  return now - lastActivityAt >= timeoutMs;
}

export function getSessionRemainingMs(now = Date.now()) {
  const lastActivityAt = getLastActivityAt() ?? getSessionStartedAt();
  if (!lastActivityAt) return null;
  const timeoutMs = getSessionTimeoutMinutes() * 60 * 1000;
  return Math.max(0, timeoutMs - (now - lastActivityAt));
}
