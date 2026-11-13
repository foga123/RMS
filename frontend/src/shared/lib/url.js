/**
 * Where the PHP backend and the static assets live.
 *
 * This matters more than it looks, because the React dev server does not run
 * PHP. Under `npm start` the page comes from port 3000 while every API call has
 * to reach Apache on port 80, so the app cannot simply use relative paths — it
 * has to know where Apache is. Three answers, in order:
 *
 *   1. REACT_APP_SITE_URL, when set. This is the only answer available when the
 *      browser is not on the same machine as XAMPP — a forwarded port, a dev
 *      tunnel, a phone on the LAN. In those cases nothing in window.location
 *      can point at Apache, because the address the browser is using does not
 *      belong to this machine at all. Point it at the URL that serves
 *      frontend/, with no trailing slash:
 *
 *        REACT_APP_SITE_URL=https://abc123-80.asse.devtunnels.ms/capstone2.0/frontend
 *
 *      Set it in frontend/.env.local and restart the dev server; CRA reads it at
 *      build time, so a running server will not pick it up.
 *
 *   2. The dev server, detected by NODE_ENV rather than by guessing from the
 *      port. Port sniffing missed anything not on the hardcoded list — a dev
 *      server on 3002, or any address where the port is implied rather than
 *      written, which is every https URL — and silently fell back to relative
 *      paths that the dev server answers with index.html. An API call that
 *      returns HTML fails at JSON parsing, which reads as "the backend is
 *      broken" when the request never reached PHP at all.
 *
 *   3. Otherwise Apache is serving the build, so everything hangs off wherever
 *      frontend/ is mounted: /capstone2.0/frontend/ under XAMPP, or the site
 *      root in the container, where the vhost aliases /frontend explicitly.
 */

const SITE_URL = String(process.env.REACT_APP_SITE_URL || "").trim().replace(/\/+$/, "");
const IS_DEV_SERVER = process.env.NODE_ENV === "development";

const FRONTEND_MARKER = "/frontend/";

function frontendBase() {
  if (SITE_URL) {
    return SITE_URL;
  }

  const { origin, pathname } = window.location;

  if (IS_DEV_SERVER) {
    // Relative on purpose, so the call goes back to whatever address the page
    // was opened from and setupProxy.js hands it to Apache.
    //
    // This used to be an absolute URL to port 80 on the same hostname. That
    // works only when the browser is on this machine. Open the app from another
    // device as http://192.168.x.x:3000 and the page is one origin while the
    // API is another — different port is a different origin — so the browser
    // needs the API to opt in with Access-Control-Allow-Origin, and
    // api_allowed_origins() lists only localhost and 127.0.0.1. Every request
    // was being discarded by the browser, which looks exactly like the database
    // being down: the app loads, nothing in it works, and logging in fails.
    //
    // Staying on one origin sidesteps that entirely — no CORS involved, and the
    // SameSite=Strict session cookie is sent as a matter of course.
    return "/RMS-v3-public/frontend";
  }

  // Find where frontend/ is mounted instead of hardcoding one prefix, so a
  // XAMPP checkout and a container serving the build at the site root both
  // resolve without a special case each.
  const at = pathname.indexOf(FRONTEND_MARKER);
  if (at !== -1) {
    return `${origin}${pathname.slice(0, at + FRONTEND_MARKER.length - 1)}`;
  }

  return "/frontend";
}

/**
 * An in-app route, as an address the browser can actually be sent to.
 *
 * The router is mounted at a basename (`PUBLIC_URL` — see index.jsx), so
 * "/dashboard/dean" is a ROUTE, not a URL. React Router adds the basename
 * itself, but three places bypass the router and hand the path straight to
 * window.location.replace(): the two login screens after a successful sign-in,
 * and replacePath() in auth.js on logout or a refused dashboard.
 *
 * Under `npm start` PUBLIC_URL is empty, the basename is "/", and those raw
 * paths are correct — which is why this went unnoticed. In the built app served
 * from /capstone2.0/frontend/build/, window.location.replace("/dashboard/dean")
 * asks Apache for /dashboard/dean at the SITE root. Nothing is mounted there and
 * build/.htaccess only rewrites under the build directory, so signing in landed
 * on Apache's 404 page. Found by signing in to the built app in a real browser;
 * no test covered it because the failure needs the production basename.
 */
const APP_BASE = String(process.env.PUBLIC_URL || "").replace(/\/+$/, "");

export function getAppUrl(routePath) {
  const path = String(routePath || "/");
  // Absolute URLs and anything not root-relative are already whatever the
  // caller meant; only a route needs the basename in front of it.
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || !path.startsWith("/")) return path;
  return `${APP_BASE}${path}` || "/";
}

export function getAssetUrl(relativePath) {
  const path = String(relativePath || "").replace(/^\/+/, "");
  return `${frontendBase()}/${path}`;
}

export function getBackendUrl(path) {
  const normalizedPath = String(path || "").replace(/^\/+/, "");
  return `${frontendBase()}/backend/api/${normalizedPath}`;
}
