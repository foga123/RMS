/**
 * One line for a student's recorded enrollment update: the decision, the
 * status and the date, joined - or "Needs review" when nothing is recorded.
 *
 * Shared by the caller's and the coordinator's dashboards, which each carried
 * an identical copy. The assignment board writes its own, shorter label on
 * purpose (no date, a different empty state), so it does not use this.
 */
export function formatEnrollmentLabel(student) {
  const parts = [];
  if (student?.decision) parts.push(student.decision);
  if (student?.enrollment_status_name) parts.push(student.enrollment_status_name);
  if (student?.enrollment_date) parts.push(student.enrollment_date);
  return parts.length ? parts.join(" | ") : "Needs review";
}
