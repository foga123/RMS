/**
 * The "students needing attention" tables' search box: a row stays when any of
 * its student number, name, course or section contains what was typed.
 *
 * Shared by the attendance and finance reports, which each carried an identical
 * copy. An empty search keeps every row.
 */
export function searchAttentionRows(rows, search) {
  const q = String(search || "").trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((row) =>
    [row.student_id, row.student_name, row.course_code, row.course_name, row.section]
      .some((value) => String(value || "").toLowerCase().includes(q))
  );
}
