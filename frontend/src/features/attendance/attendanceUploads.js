import { formatDateTime } from "../../shared/lib/dateTime";
import { PERIOD_ALL, periodLabel } from "../../shared/lib/periods";

/**
 * How one upload reads in the Attendance page's Upload filter.
 *
 * Each upload arrives from attendance-summary.php's `uploads` list: when it
 * ran, the file, who ran it, the term it was filed under, and how many rows it
 * still holds. Kept apart from the page so the wording is tested on its own.
 */

/** "P1 · 1st Semester 2026-2027", or "Semester total · ..." for a blank periodical. */
export function uploadTermLabel(upload) {
  const period = upload?.period == null ? "Semester total" : periodLabel(upload.period);
  const term = [upload?.semester_name, upload?.schoolyear_name].filter(Boolean).join(" ");
  return term ? `${period} · ${term}` : period;
}

/** The option text: the time first, since that is what the list is ordered and picked by. */
export function uploadOptionLabel(upload) {
  const records = Number(upload?.records) || 0;
  return `${formatDateTime(upload?.uploaded_at)} · ${uploadTermLabel(upload)} (${records.toLocaleString()})`;
}

/**
 * The option's tooltip: the file, who uploaded it, and whether a later upload
 * has since replaced some of its rows. An upload only lists the rows it still
 * holds, so without this a sheet of 1,392 showing 1,200 would look like lost data.
 */
export function uploadOptionTitle(upload) {
  const records = Number(upload?.records) || 0;
  const written = Number(upload?.rows_written) || 0;
  const parts = [
    upload?.file_name || "File name not recorded",
    upload?.uploaded_by ? `uploaded by ${upload.uploaded_by}` : "",
    `${records.toLocaleString()} ${records === 1 ? "row" : "rows"}`,
  ];
  if (written > records) {
    parts.push(`${(written - records).toLocaleString()} of the ${written.toLocaleString()} it wrote were replaced by a later upload`);
  }
  return parts.filter(Boolean).join(" · ");
}

/** The chip under the toolbar: when, and which file. */
export function uploadChipLabel(upload) {
  if (!upload) return "";
  const when = formatDateTime(upload.uploaded_at);
  return upload.file_name ? `${when} · ${upload.file_name}` : when;
}

/**
 * The term filters that match an upload, so choosing one never leaves the
 * page filtered to a term the upload is not in (an empty table).
 *
 * A semester-total upload maps to the whole-periodical view rather than to
 * PERIOD_TERM: the period filter offers no option for PERIOD_TERM, and on that
 * view a student with no periodical rows is shown their semester-total row,
 * which is exactly what such an upload wrote.
 */
export function uploadTermFilters(upload) {
  return {
    semesterId: String(upload.semester_id),
    schoolYearId: String(upload.school_year_id),
    period: upload.period == null ? PERIOD_ALL : String(upload.period),
  };
}
