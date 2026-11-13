/**
 * Picking a school year as a calendar year, not as a row that happens to exist.
 *
 * `school_year` held exactly one row — 2025-2026 — because nothing in the app
 * could create another, so every term picker offered one option and comparing a
 * term against the previous one was impossible to set up. A picker that only
 * lists existing rows makes that a permanent state: you cannot choose next year
 * until someone has already recorded next year.
 *
 * So the options are generated from the calendar and merged with whatever the
 * database already has. Choosing one that does not exist yet creates it —
 * school_year.php POST is idempotent by name, so two people picking 2026-2027
 * at the same time end up on the same row rather than two.
 */

/** "2026-2027" from 2026. */
export function schoolYearName(startYear) {
  const year = Number(startYear);
  return `${year}-${year + 1}`;
}

/**
 * The academic year a date falls in.
 *
 * June is the cutoff: the Philippine school year opens around August, so
 * anything from June onward belongs to the year that is about to start. A date
 * in March 2027 is still 2026-2027.
 */
export function academicYearStart(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  return d.getMonth() >= 5 ? d.getFullYear() : d.getFullYear() - 1;
}

/** Is this a well-formed school year name, spanning two consecutive years? */
export function isValidSchoolYearName(value) {
  const match = /^(\d{4})-(\d{4})$/.exec(String(value ?? "").trim());
  return Boolean(match) && Number(match[2]) === Number(match[1]) + 1;
}

/**
 * The options a school-year picker should show.
 *
 * A calendar span around this academic year, plus every year already recorded —
 * including ones outside the span, because a record from 2019-2020 must stay
 * selectable however long ago it was. Sorted newest first, the way a person
 * picking a term thinks.
 *
 * `exists` says whether choosing it will create a row, which the caller can
 * surface so nobody is surprised by a new year appearing.
 */
export function schoolYearOptions(existingRows = [], { back = 4, forward = 2, today } = {}) {
  const byName = new Map();

  const current = academicYearStart(today ? new Date(today) : undefined);
  for (let start = current - back; start <= current + forward; start++) {
    byName.set(schoolYearName(start), { value: schoolYearName(start), label: schoolYearName(start), exists: false, id: null });
  }

  (Array.isArray(existingRows) ? existingRows : []).forEach((row) => {
    const name = String(row?.schoolyear_name ?? "").trim();
    if (name === "") return;
    byName.set(name, {
      value: name,
      label: name,
      exists: true,
      id: Number(row.school_year_id) || null,
    });
  });

  return Array.from(byName.values()).sort((a, b) => b.value.localeCompare(a.value));
}

/**
 * The id for a school year name, creating the row when it is not there yet.
 *
 * Takes the fetch and URL builder rather than importing them, so this module
 * stays free of app wiring and can be tested on its own.
 */
export async function resolveSchoolYearId(name, existingRows, { fetchImpl = fetch, buildUrl }) {
  const wanted = String(name ?? "").trim();
  if (!isValidSchoolYearName(wanted)) {
    throw new Error(`"${wanted || "(blank)"}" is not a school year. Use a form like 2026-2027.`);
  }

  const already = (Array.isArray(existingRows) ? existingRows : []).find(
    (row) => String(row?.schoolyear_name ?? "").trim() === wanted
  );
  if (already && Number(already.school_year_id)) {
    return Number(already.school_year_id);
  }

  const res = await fetchImpl(buildUrl("school_year.php"), {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    credentials: "include",
    body: JSON.stringify({ schoolyear_name: wanted }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    /*
     * Creating a school year is Admin-only — school-year-management is not a
     * module a Dean or SSG holds, so their import would otherwise fail with a
     * bare "Forbidden" and no hint about what to do. Say which year and who can
     * add it.
     */
    if (res.status === 403) {
      throw new Error(`School year ${wanted} has not been set up yet, and only an admin can add it. Pick an existing year, or ask an admin to create ${wanted}.`);
    }
    throw new Error(json?.message || `Could not create school year ${wanted}`);
  }

  const id = Number(json?.data?.school_year_id) || 0;
  if (!id) throw new Error(`School year ${wanted} was saved without an id.`);
  return id;
}
