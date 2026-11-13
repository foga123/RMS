/**
 * How a stored timestamp is written when it is shown to a person.
 *
 * Eleven screens had written this themselves, under three names — formatDateTime,
 * formatTimestamp, formatWhen — and they did not agree. The same audit row could
 * read "Sep 06, 2026, 09:56 PM" on one screen and "9/6/2026, 9:56:00 PM" on the
 * next, because six copies pinned en-PH with an explicit option set and the rest
 * fell through to a bare toLocaleString(), whose output follows whatever locale
 * the browser happens to be in.
 *
 * Three things were wrong with having eleven of these:
 *
 *   - Bare toLocaleString() prints seconds and a numeric month. Nothing on these
 *     screens is precise to the second, so the seconds were noise on a column
 *     people scan.
 *   - The locale was the reader's, not the school's. Two staff comparing the
 *     same export on different machines saw different dates.
 *   - Only four of the eleven handled MySQL's "YYYY-MM-DD HH:MM:SS". The space
 *     between date and time is not in the format `Date` is required to accept;
 *     Chrome takes it anyway, which is why this has never broken here, but it is
 *     a parser bug waiting for a different browser.
 *
 * en-PH is pinned rather than left to the browser: this is one school's portal,
 * and a timestamp that changes shape depending on who opened it is a timestamp
 * two people cannot talk about.
 *
 * Not the same job as localDate.js. That one produces YYYY-MM-DD for storage and
 * for <input type="date">, where the value is data. This one produces prose for
 * reading, and its output must never be sent back to the server.
 */

/** "2026-09-06 21:56:00" — MySQL DATETIME, the one shape that needs repair. */
const MYSQL_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/;

const DATE_TIME_OPTIONS = {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
};

const DATE_OPTIONS = {
  year: "numeric",
  month: "short",
  day: "2-digit",
};

/**
 * A Date, or null when there is nothing to parse.
 *
 * The T is inserted only for a value that actually looks like MySQL's format.
 * Rewriting the first space of anything else would turn a string a browser could
 * read — "Sep 6 2026 9:56 PM" — into one it cannot, which is a failure mode the
 * copies that did an unconditional replace() all carried.
 *
 * No timezone is appended. The backend stores and returns wall-clock time in
 * +08:00 and the browser is in the same place; "…T21:56:00" with no offset is
 * parsed as local, which keeps the displayed hour the stored hour. Adding a Z
 * here would shift every timestamp in the portal by eight hours.
 */
function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;

  const raw = String(value ?? "").trim();
  if (raw === "") return null;

  const parsed = new Date(MYSQL_DATETIME.test(raw) ? raw.replace(" ", "T") : raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * "Sep 06, 2026, 09:56 PM".
 *
 * `fallback` is what an empty value reads as, which differs by screen on purpose
 * — a table cell wants "-", a settings row wants "Not available", a "last called"
 * column wants "Never". A value that is present but unparseable is returned as it
 * arrived rather than as the fallback: showing the raw string makes a bad row
 * visible, while hiding it behind "-" makes it look empty.
 */
export function formatDateTime(value, { fallback = "-" } = {}) {
  const raw = String(value ?? "").trim();
  if (value === null || value === undefined || raw === "") return fallback;

  const parsed = toDate(value);
  if (!parsed) return raw;

  return parsed.toLocaleString("en-PH", DATE_TIME_OPTIONS);
}

/** "Sep 06, 2026" — the same rules, without the time. */
export function formatDate(value, { fallback = "" } = {}) {
  const raw = String(value ?? "").trim();
  if (value === null || value === undefined || raw === "") return fallback;

  const parsed = toDate(value);
  if (!parsed) return raw;

  return parsed.toLocaleDateString("en-PH", DATE_OPTIONS);
}

const TIME_OPTIONS = {
  hour: "2-digit",
  minute: "2-digit",
};

/**
 * "09:56 PM" — the same rules, without the date.
 *
 * For a log that shows the date and the time as two columns, so a spreadsheet
 * can sort or filter on either without taking a string apart.
 */
export function formatTime(value, { fallback = "" } = {}) {
  const raw = String(value ?? "").trim();
  if (value === null || value === undefined || raw === "") return fallback;

  const parsed = toDate(value);
  if (!parsed) return raw;

  return parsed.toLocaleTimeString("en-PH", TIME_OPTIONS);
}
