import { confirmAction } from "./notify";
import { logAuditEvent } from "./audit";
import { clearSession } from "./session";
import { clearAccessToken, getAccessToken, refreshSession } from "./authToken";
import { getCurrentUser, logoutSession } from "../services/api";
import { getAppUrl } from "./url";

let authUser = null;
let restorePromise = null;

export function readAuthUser() {
  return authUser;
}

export function setAuthUser(user) {
  authUser = user || null;
  return authUser;
}

export function clearAuthUser() {
  authUser = null;
}

export async function restoreAuthUser({ force = false } = {}) {
  if (!force && authUser) {
    return authUser;
  }

  if (!force && restorePromise) {
    return restorePromise;
  }

  /*
   * Two different questions wear the same name here, and they need different
   * endpoints.
   *
   * With no access token in hand this is a cold start — a reload, or a new tab.
   * The token lives in memory only, so the httpOnly refresh cookie is the only
   * credential that survived, and refresh.php is the one endpoint that accepts
   * it. It answers with the user as well, so the restore costs one request.
   *
   * With a token already held the caller is asking something narrower: reload my
   * permissions, after a role change. me.php authenticates off the token and
   * returns exactly that. Routing it through refresh.php would work but would
   * rotate the refresh token every time an admin edits a role — spending a
   * single-use credential to answer a question that did not need it.
   */
  const restore = getAccessToken()
    ? getCurrentUser().then((payload) => payload?.user || null)
    : refreshSession().then(({ user, rateLimited, retryAfter }) => {
        // A throttled refresh says nothing about the session, so it must not
        // resolve to "no user" - that reads as signed out. Thrown with a 429,
        // it passes the 401 check below untouched and the caller can say
        // "wait" (LoginPage does) instead of presenting a fresh login.
        if (rateLimited) {
          const error = new Error("Too many requests. Please wait a moment and try again.");
          error.status = 429;
          error.retryAfter = retryAfter;
          throw error;
        }
        return user;
      });

  restorePromise = restore
    .then((user) => setAuthUser(user || null))
    .catch((error) => {
      if (error?.status === 401) {
        clearAuthUser();
        return null;
      }
      throw error;
    })
    .finally(() => {
      restorePromise = null;
    });

  return restorePromise;
}

export function hasRole(user, { id, name }) {
  if (!user) return false;
  const roleName = String(user.role_name || "").toLowerCase();
  const expectedName = String(name || "").toLowerCase();
  return user.role_id === id || roleName === expectedName;
}

export function replacePath(path) {
  // Through getAppUrl, because `path` is a route and the router is mounted at a
  // basename. Sending the raw route asked Apache for it at the site root, which
  // is a 404 in the built app. See getAppUrl in lib/url.js.
  const target = getAppUrl(path);
  if (window.location.pathname !== target) {
    window.location.replace(target);
  }
}

/**
 * How a sign-out in one tab reaches the others.
 *
 * The access token lives in a module variable, so every tab holds its own copy
 * and none of them can see the others. The server now rejects all of those
 * copies the moment logout bumps the account's token_version — but a tab only
 * discovers that on its next request, so until someone clicks something it goes
 * on showing a dashboard for a session that is already over.
 *
 * A `storage` write is the cheapest way across: the event fires in every *other*
 * tab of the same origin and never in the one that wrote it, which is exactly
 * the audience wanted.
 */
const LOGOUT_BROADCAST_KEY = "auth:logout";

/** Called once at startup, before the router mounts. */
export function installCrossTabLogout(path = "/") {
  if (typeof window === "undefined") return;

  window.addEventListener("storage", (event) => {
    if (event.key !== LOGOUT_BROADCAST_KEY || !event.newValue) return;
    // No logoutSession() here: the tab that signed out already revoked
    // everything server-side, and a second call would only 401.
    clearAuthUser();
    clearAccessToken();
    clearSession();
    replacePath(path);
  });
}

export async function logoutTo(path = "/") {
  const user = readAuthUser();
  if (user) {
    logAuditEvent({ action: "logout", user });
  }
  try {
    await logoutSession();
  } catch {}
  clearAuthUser();
  // Dropped after logoutSession() so that call still carries the token and the
  // server can match it to the right refresh-token row to revoke.
  clearAccessToken();
  clearSession();

  // Announced after the server has actually revoked, so a sibling tab is never
  // sent to the login screen by a logout that then failed.
  try {
    window.localStorage.setItem(LOGOUT_BROADCAST_KEY, String(Date.now()));
  } catch {
    // Private browsing or a full quota. The other tab still logs itself out on
    // its next request; it just takes until then.
  }

  replacePath(path);
}

export async function confirmLogout({
  title = "Logout?",
  text = "Are you sure you want to logout?",
  confirmText = "Yes, logout",
  cancelText = "Cancel",
} = {}) {
  return confirmAction({
    title,
    text,
    confirmButtonText: confirmText,
    cancelButtonText: cancelText,
  });
}

export async function confirmLogoutTo(path = "/") {
  const confirmed = await confirmLogout();
  if (!confirmed) return false;
  await logoutTo(path);
  return true;
}

export function getUserInitials(user) {
  return String(user?.name || "U")
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

export function getUserFirstName(user) {
  if (!user) return "User";
  const first = String(user.first_name || "").trim();
  if (first) return first;
  const fullName = String(user.name || "").trim();
  if (fullName) return fullName.split(/\s+/)[0];
  const email = String(user.email || "").trim();
  if (email.includes("@")) return email.split("@")[0];
  return email || "User";
}
