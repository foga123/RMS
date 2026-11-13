const SECURITY_POLICY_KEY = "security_policy";
const FAILED_LOGIN_KEY = "failed_login_attempts";
const PASSWORD_CHANGE_KEY = "password_change_at";

const DEFAULT_POLICY = {
  maxPasswordLength: 64,
  passwordExpirationEnabled: false,
  passwordExpiryDays: 90,
  sessionTimeoutMinutes: 30,
  lockoutAttempts: 5,
};

const LIMITS = {
  maxPasswordLength: { min: 6, max: 256 },
  passwordExpiryDays: { min: 0, max: 3650 },
  sessionTimeoutMinutes: { min: 1, max: 1440 },
  lockoutAttempts: { min: 1, max: 20 },
};

const LOCKOUT_DURATION_MINUTES = 15;

/**
 * How long a run of failures stays on the clock.
 *
 * Matches the 900-second login_account window in the backend's
 * middleware/rate_limit_policy.php, and that
 * is the whole point of the number: the server counts five failures inside a
 * fifteen-minute window, and this counter has to agree with it or the browser
 * refuses a user the server would still let in.
 *
 * Without a window at all — which is how this shipped — the count simply never
 * came down. Three fumbled sign-ins last week were still banked this morning,
 * so the next two failures hit the threshold and the user was locked out "on
 * the second attempt". The counter was correct; it was just measuring since
 * forever.
 */
const ATTEMPT_WINDOW_MINUTES = 15;
const ATTEMPT_WINDOW_MS = ATTEMPT_WINDOW_MINUTES * 60 * 1000;

/** True once a run of failures is old enough to stop counting. */
function attemptRunExpired(entry, now) {
  const startedAt = Number(entry?.first_failed_at ?? entry?.last_failed_at);
  if (!Number.isFinite(startedAt)) return false;
  return now - startedAt > ATTEMPT_WINDOW_MS;
}

function clampNumber(value, min, max, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, Math.round(num)));
}

function readJson(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function normalizePolicy(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    maxPasswordLength: clampNumber(
      source.maxPasswordLength,
      LIMITS.maxPasswordLength.min,
      LIMITS.maxPasswordLength.max,
      DEFAULT_POLICY.maxPasswordLength
    ),
    passwordExpirationEnabled: Boolean(source.passwordExpirationEnabled ?? DEFAULT_POLICY.passwordExpirationEnabled),
    passwordExpiryDays: clampNumber(
      source.passwordExpiryDays,
      LIMITS.passwordExpiryDays.min,
      LIMITS.passwordExpiryDays.max,
      DEFAULT_POLICY.passwordExpiryDays
    ),
    sessionTimeoutMinutes: clampNumber(
      source.sessionTimeoutMinutes,
      LIMITS.sessionTimeoutMinutes.min,
      LIMITS.sessionTimeoutMinutes.max,
      DEFAULT_POLICY.sessionTimeoutMinutes
    ),
    lockoutAttempts: clampNumber(
      source.lockoutAttempts,
      LIMITS.lockoutAttempts.min,
      LIMITS.lockoutAttempts.max,
      DEFAULT_POLICY.lockoutAttempts
    ),
  };
}

export function getSecurityPolicy() {
  const stored = readJson(SECURITY_POLICY_KEY);
  const normalized = normalizePolicy(stored);
  return {
    ...normalized,
    sessionTimeoutMinutes: getSessionTimeoutPolicyMinutes(),
  };
}

export function setSecurityPolicy(next) {
  const normalized = normalizePolicy(next);
  writeJson(SECURITY_POLICY_KEY, normalized);
  localStorage.setItem("session_timeout_minutes", String(normalized.sessionTimeoutMinutes));
  return normalized;
}

export function getMaxPasswordLength() {
  return getSecurityPolicy().maxPasswordLength;
}

export function getSessionTimeoutPolicyMinutes() {
  const stored = readJson(SECURITY_POLICY_KEY);
  if (stored && typeof stored === "object" && stored.sessionTimeoutMinutes !== undefined) {
    return normalizePolicy(stored).sessionTimeoutMinutes;
  }
  const legacyRaw = localStorage.getItem("session_timeout_minutes");
  const legacyNum = Number(legacyRaw);
  if (Number.isFinite(legacyNum) && legacyNum > 0) return legacyNum;
  return DEFAULT_POLICY.sessionTimeoutMinutes;
}

/**
 * Take the idle timeout the server just handed us.
 *
 * The stored copy is a cache, not the record. It has to stay a local read
 * because the enforcement loop in DashboardShell checks it every five seconds
 * and cannot go to the network for it — but it is refreshed from the server on
 * every sign-in and every page load, which is what makes an admin's change
 * reach the other thirty accounts instead of only their own browser.
 *
 * A payload without the field leaves the cache alone. That is a server older
 * than this field, not a policy of "no timeout", and clobbering the stored
 * value would be reading a missing answer as an answer.
 *
 * Returns the minutes now in force, or null when there was nothing to take.
 */
export function adoptServerSessionPolicy(payload) {
  const source = payload?.session_policy ?? payload?.sessionPolicy ?? payload;
  const raw = source?.timeout_minutes ?? source?.session_timeout_minutes ?? source?.sessionTimeoutMinutes;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) return null;

  const normalized = normalizePolicy({ sessionTimeoutMinutes: minutes }).sessionTimeoutMinutes;
  if (normalized === getSessionTimeoutPolicyMinutes()) return normalized;

  return setSessionTimeoutPolicyMinutes(normalized);
}

export function setSessionTimeoutPolicyMinutes(value) {
  const normalized = normalizePolicy({ sessionTimeoutMinutes: value }).sessionTimeoutMinutes;
  const current = getSecurityPolicy();
  const next = { ...current, sessionTimeoutMinutes: normalized };
  writeJson(SECURITY_POLICY_KEY, next);
  localStorage.setItem("session_timeout_minutes", String(normalized));
  return normalized;
}

export function getLockoutAttempts() {
  return getSecurityPolicy().lockoutAttempts;
}

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function readFailedLogins() {
  const stored = readJson(FAILED_LOGIN_KEY);
  return stored && typeof stored === "object" ? stored : {};
}

function writeFailedLogins(map) {
  writeJson(FAILED_LOGIN_KEY, map);
}

function pruneExpiredFailedLogins(now = Date.now()) {
  const map = readFailedLogins();
  let changed = false;

  Object.entries(map).forEach(([key, entry]) => {
    // An expired lockout goes, as before.
    if (entry?.locked_until && now >= entry.locked_until) {
      delete map[key];
      changed = true;
      return;
    }

    // ...and so does a run of failures that never reached the threshold. That
    // second clause is the one that was missing: an entry sitting at three
    // attempts carries no `locked_until`, so nothing here ever removed it and
    // it stayed banked against the account indefinitely.
    if (!entry?.locked_until && attemptRunExpired(entry, now)) {
      delete map[key];
      changed = true;
    }
  });

  if (changed) {
    writeFailedLogins(map);
  }

  return map;
}

export function getLockoutStatus(email, now = Date.now()) {
  const key = normalizeEmail(email);
  if (!key) return { locked: false, attempts: 0, threshold: getLockoutAttempts(), remainingMs: 0 };

  const map = pruneExpiredFailedLogins(now);
  const entry = map[key];
  const threshold = getLockoutAttempts();

  if (entry?.locked_until && now < entry.locked_until) {
    return {
      locked: true,
      attempts: entry.attempts || 0,
      threshold,
      remainingMs: Math.max(0, entry.locked_until - now),
    };
  }

  return {
    locked: false,
    attempts: entry?.attempts || 0,
    threshold,
    remainingMs: 0,
  };
}

export function recordFailedLoginAttempt(email, now = Date.now()) {
  const key = normalizeEmail(email);
  if (!key) return { locked: false, attempts: 0, threshold: getLockoutAttempts(), remainingMs: 0 };

  const map = readFailedLogins();
  const previous = map[key] || {};
  const threshold = getLockoutAttempts();
  if (previous.locked_until && now < previous.locked_until) {
    return {
      locked: true,
      attempts: previous.attempts || 0,
      threshold,
      remainingMs: Math.max(0, previous.locked_until - now),
    };
  }

  // The count restarts on two triggers: a lockout that has served its time, and
  // a run of failures that has aged out of the window. The second is what stops
  // last week's mistakes from being spent today.
  const lockoutServed = previous.locked_until && now >= previous.locked_until;
  const runExpired = attemptRunExpired(previous, now);
  const startingFresh = lockoutServed || runExpired || !previous.attempts;

  const baseAttempts = startingFresh ? 0 : previous.attempts;
  const nextAttempts = baseAttempts + 1;

  const entry = {
    attempts: nextAttempts,
    // The window is measured from the first failure of the run, matching how
    // api_rate_limit_hit() measures it against first_attempt_at.
    first_failed_at: startingFresh ? now : (previous.first_failed_at ?? now),
    last_failed_at: now,
  };

  let locked = false;
  let remainingMs = 0;
  if (threshold > 0 && nextAttempts >= threshold) {
    locked = true;
    const lockedUntil = now + LOCKOUT_DURATION_MINUTES * 60 * 1000;
    entry.locked_until = lockedUntil;
    remainingMs = LOCKOUT_DURATION_MINUTES * 60 * 1000;
  }

  map[key] = entry;
  writeFailedLogins(map);

  return { locked, attempts: nextAttempts, threshold, remainingMs };
}

export function clearFailedLoginAttempts(email) {
  const key = normalizeEmail(email);
  if (!key) return;
  const map = readFailedLogins();
  if (map[key]) {
    delete map[key];
    writeFailedLogins(map);
  }
}

export function clearAllFailedLoginAttempts() {
  writeFailedLogins({});
}

export function getFailedLoginAttemptsSnapshot(now = Date.now()) {
  const threshold = getLockoutAttempts();
  const map = pruneExpiredFailedLogins(now);

  return Object.entries(map)
    .map(([email, entry]) => {
      const attempts = Number(entry?.attempts || 0);
      const lockedUntil = Number(entry?.locked_until || 0);
      const lastFailedAt = Number(entry?.last_failed_at || 0);
      const locked = lockedUntil > now;

      return {
        email,
        attempts,
        threshold,
        locked,
        remainingMs: locked ? Math.max(0, lockedUntil - now) : 0,
        lockedUntil: lockedUntil > 0 ? lockedUntil : null,
        lastFailedAt: lastFailedAt > 0 ? lastFailedAt : null,
      };
    })
    .filter((entry) => entry.attempts > 0 || entry.locked)
    .sort((left, right) => {
      const leftTime = Number(left.lastFailedAt || 0);
      const rightTime = Number(right.lastFailedAt || 0);
      return rightTime - leftTime;
    });
}

function readPasswordChanges() {
  const stored = readJson(PASSWORD_CHANGE_KEY);
  return stored && typeof stored === "object" ? stored : {};
}

function writePasswordChanges(map) {
  writeJson(PASSWORD_CHANGE_KEY, map);
}

export function recordPasswordChange(email, at = Date.now()) {
  const key = normalizeEmail(email);
  if (!key) return null;
  const map = readPasswordChanges();
  map[key] = Number(at);
  writePasswordChanges(map);
  return map[key];
}

export function getSecurityPolicyLimits() {
  return LIMITS;
}

/* --------------------------------------------------------------- login CAPTCHA
 * Merged from the former utils/security.js. The CAPTCHA toggle is one more
 * locally-cached security policy value, so it belongs with the rest of them
 * rather than in a 35-line file of its own. */

const CAPTCHA_ENABLED_KEY = "captcha_enabled";

function normalizeCaptchaEnabled(value, fallback = true) {
  if (value === null || value === undefined || value === "") return Boolean(fallback);
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on", "enabled"].includes(normalized)) return true;
  if (["0", "false", "no", "off", "disabled"].includes(normalized)) return false;
  return Boolean(fallback);
}

export function hasStoredCaptchaEnabled() {
  return localStorage.getItem(CAPTCHA_ENABLED_KEY) !== null;
}

export function getCaptchaEnabled() {
  const raw = localStorage.getItem(CAPTCHA_ENABLED_KEY);
  if (raw === null) return true;
  return normalizeCaptchaEnabled(raw, true);
}

export function setCaptchaEnabled(enabled) {
  const normalized = normalizeCaptchaEnabled(enabled, true);
  localStorage.setItem(CAPTCHA_ENABLED_KEY, String(normalized));
  window.dispatchEvent(new CustomEvent("captcha-policy-changed", { detail: { enabled: normalized } }));
  return normalized;
}

export function getCaptchaEnabledFromPolicy(payload, fallback = true) {
  const policy = payload?.policy && typeof payload.policy === "object" ? payload.policy : payload;
  return normalizeCaptchaEnabled(
    policy?.login_captcha_enabled ?? policy?.loginCaptchaEnabled ?? policy?.captcha_enabled ?? policy?.enabled,
    fallback
  );
}
