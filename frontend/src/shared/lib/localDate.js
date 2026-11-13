/**
 * Today, as the calendar on the wall has it.
 *
 * `new Date().toISOString().slice(0, 10)` is the obvious way to write this and
 * it is wrong here. toISOString() is UTC, and this school is at UTC+8: between
 * midnight and 08:00 local it returns YESTERDAY. Four places had written it that
 * way, and two of them were not labels but stored values —
 *
 *   EnrollmentStatusPage   the `date` on an imported enrolment standing
 *   StudentMigrationPage   the `date` on a standing recorded from the board
 *
 * — so a registrar working before 8am filed standings against the previous day,
 * silently, and the Student Migration comparison that reads those dates saw them
 * in the wrong term boundary. The other two were an export filename and the
 * audit log's "Today" filter, which sent a range the reader had not chosen.
 *
 * Built from the local calendar fields instead, which is what every one of those
 * callers meant and what `<input type="date">` and MySQL DATE both expect.
 */

const pad = (value) => String(value).padStart(2, "0");

/** YYYY-MM-DD for a date, in local time. Defaults to now. */
export function localDateIso(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** YYYY-MM-DD for `days` ago, in local time. */
export function localDateIsoDaysAgo(days) {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localDateIso(date);
}
