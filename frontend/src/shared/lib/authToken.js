/**
 * The access token, and the machinery that keeps it fresh.
 *
 * Its own module rather than part of auth.js because auth.js imports
 * services/api.js, and api.js needs the token — putting it in either would
 * make that pair circular. Nothing here imports from either.
 *
 * The token lives in a module variable, deliberately not in localStorage.
 * The app already keeps the signed-in user in memory only (auth.js), so this
 * matches what is there; and a token in localStorage is readable by any script
 * that gets injected, which would be a step down from the httpOnly session
 * cookie this is replacing. Losing it on reload costs one refresh call, which
 * is cheaper than the me.php round trip the app already pays on every reload.
 */

import { getBackendUrl } from "./url";
// securityPolicy.js imports nothing, so this stays clear of the auth.js/api.js
// cycle the header above is about.
import { adoptServerSessionPolicy } from "./securityPolicy";

let accessToken = null;
let refreshPromise = null;

/**
 * Captured before installFetchAuth() replaces window.fetch, so a refresh can
 * never re-enter the interceptor that triggered it.
 *
 * Guarded because this module is imported at the top of the entry file, and a
 * bare window.fetch.bind() would throw at import time anywhere fetch is absent
 * — jsdom under Jest being the case that matters here. Throwing during import
 * would take the whole app down rather than one request.
 */
const nativeFetch =
  typeof window !== "undefined" && typeof window.fetch === "function"
    ? window.fetch.bind(window)
    : () => Promise.reject(new Error("fetch is unavailable"));

export function getAccessToken() {
  return accessToken;
}

export function setAccessToken(token) {
  accessToken = token || null;
  return accessToken;
}

export function clearAccessToken() {
  accessToken = null;
}

/** Header object to spread into a request, or nothing when signed out. */
export function authHeader() {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

const CLIENT_ID_KEY = "api_client_id";
let clientId = null;

function generateClientId() {
  const cryptoApi = typeof window !== "undefined" ? window.crypto : undefined;
  // randomUUID exists only in a secure context (HTTPS or localhost). A plain
  // HTTP deployment on a campus LAN is not one, but getRandomValues still is.
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  if (cryptoApi?.getRandomValues) {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`.slice(0, 32).padEnd(16, "0");
}

/**
 * A random id for this browser, sent as X-Client-ID on every API call.
 *
 * It lets the server count anonymous requests per browser instead of per IP,
 * so one person signing in badly on a campus network no longer spends the
 * whole network's allowance (see backend middleware/rate_limit_policy.php).
 *
 * It is an anti-abuse hint and nothing else. It is not a secret and proves
 * nothing about who is asking: the server only ever uses it to split a budget
 * that an IP-wide ceiling still bounds, so a client that rewrites it gains no
 * more than one that does not send it. That is also why localStorage is fine
 * here when it is not fine for the access token.
 *
 * Storage can be unavailable (private windows, blocked site data). An id kept
 * in memory still works for this page; it just changes on reload.
 */
export function getClientId() {
  if (clientId) return clientId;

  try {
    const stored = window.localStorage.getItem(CLIENT_ID_KEY);
    if (stored && /^[A-Za-z0-9-]{16,64}$/.test(stored)) {
      clientId = stored;
      return clientId;
    }
  } catch {
    // Unreadable storage: fall through to a fresh id.
  }

  clientId = generateClientId();
  try {
    window.localStorage.setItem(CLIENT_ID_KEY, clientId);
  } catch {
    // Unwritable storage: the in-memory id serves this page.
  }
  return clientId;
}

/**
 * The headers every call to our own API carries: the token when there is one,
 * and the browser id always. Only ever spread into requests that
 * isTrustedApiUrl() (or the axios client, which only talks to our API) sends,
 * so neither leaves for another origin.
 */
export function apiRequestHeaders() {
  return { ...authHeader(), "X-Client-ID": getClientId() };
}

/**
 * Endpoints that must never trigger the refresh-and-retry path.
 *
 * refresh.php is the obvious one — a 401 from it means the refresh token is
 * dead, and retrying would recurse. login and logout are here because a 401
 * from them is a real answer about credentials, not an expired access token.
 */
function isAuthEndpoint(url) {
  return /\/(refresh|login|logout)\.php(\?|$)/.test(String(url || ""));
}

/**
 * The origin our own API lives on.
 *
 * Derived from getBackendUrl(), which is the app's build-time configuration —
 * never from the URL being fetched. Normally identical to the page's origin;
 * it differs only when REACT_APP_SITE_URL points the API at another host, which
 * url.js documents as the dev-tunnel and LAN case.
 *
 * Resolved once and cached: this runs on every fetch.
 */
let apiOrigin;
function getApiOrigin() {
  if (apiOrigin !== undefined) return apiOrigin;

  try {
    apiOrigin = new URL(getBackendUrl(""), window.location.href).origin;
  } catch {
    apiOrigin = null;
  }

  return apiOrigin;
}

/**
 * May this URL be given the access token?
 *
 * Compared by parsed origin, never matched as a substring. The previous test
 * asked whether the URL *contained* "localhost" or "127.0.0.1", which was
 * tolerable while it only chose `credentials: "include"` — the browser's own
 * same-origin cookie rules bounded the damage. It stopped being tolerable the
 * moment the same branch decided whether to attach the bearer token, because
 *
 *     https://evil.example.com/?next=http://localhost:3000
 *     https://localhost.attacker.net/collect
 *
 * both contain the string and would have been handed a live access token. This
 * wrapper replaces window.fetch globally, so that applied to any request the app
 * or any dependency makes.
 *
 * Two origins qualify: the page's own, and the configured API origin. The second
 * is not a loosening — it is the same deployment url.js already sends every
 * request to, and it is read from our configuration rather than inferred from
 * the URL under test. Dropping it would have silently stopped authenticating a
 * REACT_APP_SITE_URL setup, which fails exactly like a broken backend.
 *
 * A relative URL resolves against the document and is therefore always ours.
 * An unparseable one is treated as foreign: refusing to send the token to
 * something we cannot identify is the safe direction to fail.
 */
function isTrustedApiUrl(url) {
  const target = String(url || "");
  if (target === "") return false;

  let origin;
  try {
    origin = new URL(target, window.location.href).origin;
  } catch {
    return false;
  }

  return origin === window.location.origin || origin === getApiOrigin();
}

/** Named lock, so the serialisation below is the same one in every tab. */
const REFRESH_LOCK = "auth:refresh";

/**
 * Run a refresh with no other tab refreshing at the same time.
 *
 * The `refreshPromise` dedupe below covers one tab. It cannot see another, and
 * the refresh cookie is shared across all of them — so two tabs restoring on
 * browser launch, or a second tab being opened and reloaded, both POST
 * refresh.php with the *same* cookie value. The server consumes it for whichever
 * arrives first; the second presents a token already marked spent, which is
 * indistinguishable from a stolen one, so api_refresh_token_consume() revokes
 * the entire family and both tabs are signed out. Restoring two tabs is not
 * theft, and it should not look like it.
 *
 * Serialising fixes it rather than merely narrowing the window: the second tab
 * waits, and by the time it runs the cookie has been rotated, so it presents the
 * *new* value and rotates again. Two legitimate rotations instead of one replay.
 * Nothing about the server's replay detection is weakened — a genuinely replayed
 * token still revokes the family.
 *
 * Web Locks is unavailable in jsdom and in older Safari, where this falls
 * through to running unlocked. That is the current behaviour, so the fallback is
 * no worse than what it replaces.
 */
function withRefreshLock(run) {
  if (typeof navigator === "undefined" || !navigator.locks?.request) {
    return run();
  }

  return navigator.locks.request(REFRESH_LOCK, run);
}

/**
 * Swap the refresh cookie for a new access token, and the user it belongs to.
 *
 * Concurrent callers share one in-flight request. Without that, a dashboard
 * firing eight parallel requests would answer a single expired token with
 * eight refreshes — and since every refresh rotates the token, seven of them
 * would present an already-spent one and trip the server's replay detection,
 * revoking the whole family and logging the user out. The dedupe is not an
 * optimisation; it is what stops normal page load from looking like theft.
 *
 * That handles one tab. withRefreshLock() above handles the rest of them.
 *
 * The endpoint returns the user alongside the token so that restoring a reloaded
 * tab costs one request instead of a refresh followed by a me.php.
 *
 * Resolves to `{ ok, user }`.
 */
export async function refreshSession() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const response = await withRefreshLock(() =>
        nativeFetch(getBackendUrl("refresh.php"), {
          method: "POST",
          credentials: "include",
          headers: { Accept: "application/json", "X-Client-ID": getClientId() },
        })
      );

      // Throttled is not signed out. The refresh cookie is still good, so
      // nothing is cleared; the caller is told to wait rather than shown a
      // login form as if the session had ended.
      if (response.status === 429) {
        // The body first: Retry-After is not a CORS-safelisted header, so a
        // cross-origin dev setup cannot read it, but the throttle puts the
        // same number in its JSON.
        const body = await response.json().catch(() => null);
        const retryAfter = Number(body?.retry_after ?? response.headers.get("Retry-After"));
        return {
          ok: false,
          user: null,
          rateLimited: true,
          retryAfter: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null,
        };
      }

      if (!response.ok) {
        clearAccessToken();
        return { ok: false, user: null };
      }

      const payload = await response.json().catch(() => null);
      if (!payload?.access_token) {
        clearAccessToken();
        return { ok: false, user: null };
      }

      setAccessToken(payload.access_token);
      // The reload path never touches me.php, so this is the only place a
      // freshly opened tab learns the current idle timeout.
      adoptServerSessionPolicy(payload);
      return { ok: true, user: payload.user || null };
    } catch {
      // A network failure is not proof the session is gone, so the token is
      // left alone and the caller simply sees its original 401.
      return { ok: false, user: null };
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

/**
 * The 401-retry path's view of the above: it only needs to know whether it can
 * try again, and shares the same in-flight request as a session restore.
 */
export async function refreshAccessToken() {
  const { ok } = await refreshSession();
  return ok;
}

/**
 * Wrap window.fetch so every local API call carries the token and a 401 gets
 * one refresh-and-retry.
 *
 * Extends the existing same-origin credentials patch rather than replacing it:
 * five files call fetch() with no `credentials` of their own and rely on it,
 * and the session cookie is still load-bearing for the reset/OTP flows.
 *
 * The retry only happens when an access token is actually held. While the app
 * is still session-authenticated — which is the whole of this phase — a 401
 * passes through exactly as it did before, so nothing about the current
 * behaviour changes until a token is in play.
 */
export function installFetchAuth() {
  window.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : input?.url ?? "";

    if (!isTrustedApiUrl(url)) {
      return nativeFetch(input, init);
    }

    const build = () => ({
      credentials: "include",
      ...init,
      headers: { ...apiRequestHeaders(), ...(init.headers || {}) },
    });

    const response = await nativeFetch(input, build());

    if (
      response.status !== 401 ||
      !accessToken ||
      isAuthEndpoint(url)
    ) {
      return response;
    }

    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      return response;
    }

    // build() is re-evaluated so the retry picks up the new token. init.body is
    // reused as given; a stream body would not survive this, but nothing in the
    // app sends one — bodies here are JSON strings or FormData.
    return nativeFetch(input, build());
  };
}
