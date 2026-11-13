/**
 * Pulling a server-rendered file down through fetch rather than navigating to it.
 *
 * The distinction stopped being cosmetic when auth moved to a bearer token. A
 * `window.open(endpoint)` is a browser navigation: it sends cookies and nothing
 * else, so it cannot carry an Authorization header, and against a token-only
 * backend it lands on a 401 rendered as raw JSON in a fresh tab — no error
 * message anywhere the user is looking, and no way for the app to know it
 * happened. Fetching the file goes through the same wrapper as every other API
 * call, so it is authenticated the same way and a failure comes back as a value
 * this code can act on.
 *
 * The download is then handed over from a blob, which also gets the filename
 * from Content-Disposition instead of leaving the browser to invent one from
 * the query string.
 */

import { getBackendUrl } from "./url";

/** `attachment; filename="report.csv"` -> `report.csv`. */
export function filenameFromDisposition(disposition, fallback) {
  const match = String(disposition || "").match(/filename="?([^";]+)"?/i);
  return match?.[1]?.trim() || fallback;
}

/**
 * Hand a blob to the browser as a download.
 *
 * The object URL is revoked straight after the click; the download has already
 * been handed to the browser by then and does not need the URL to stay alive.
 */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Fetch a file from an API endpoint and save it, or throw with the server's
 * own message.
 *
 * A failed export answers in JSON even though the successful one is a file, so
 * the error path reads the body as JSON and falls back to a generic message
 * when it is something else — an HTML error page, or nothing at all.
 */
export async function downloadFromApi(path, { fallbackName, errorMessage = "Download failed." } = {}) {
  const response = await fetch(getBackendUrl(path), { credentials: "include" });

  if (!response.ok) {
    const contentType = response.headers.get("Content-Type") || "";
    const payload = contentType.includes("application/json")
      ? await response.json().catch(() => ({}))
      : {};
    throw new Error(payload?.message || errorMessage);
  }

  const blob = await response.blob();
  saveBlob(blob, filenameFromDisposition(response.headers.get("Content-Disposition"), fallbackName));
}
