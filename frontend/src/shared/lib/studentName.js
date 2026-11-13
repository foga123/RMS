/**
 * How a student's name is written when it is shown to staff.
 *
 * Six screens had each defined their own formatStudentName, and one of them
 * disagreed with the other five: the SSP Assignments workspace rendered
 * "Juan Dela Cruz" where Home Visits, Retention Cases, Student Contacts, the
 * SSP Caller and the SSP Coordinator screens all rendered "Dela Cruz, Juan".
 * The same student therefore read as two different people depending on which
 * tab a caller had open, which is the one thing a name has to not do.
 *
 * "Last, First" is the one kept, on two grounds: it was already what five of
 * the six did, and it is the order the lists are sorted in, so a name and the
 * row order finally agree.
 *
 * Not folded into studentIdentity.js on purpose. That file is a mirror of
 * backend/api/lib/student_identity.php and its test fails when the two drift
 * apart; display formatting has no PHP counterpart and would only make that
 * comparison noisier.
 */

/**
 * "Dela Cruz, Juan" — or whichever half exists, when only one does.
 *
 * Accepts anything carrying `first_name` / `last_name`, which is the student
 * row on some screens and a case or assignment row that joined it on others.
 */
export function formatStudentName(record) {
  const lastName = String(record?.last_name || "").trim();
  const firstName = String(record?.first_name || "").trim();
  if (lastName && firstName) return `${lastName}, ${firstName}`;
  return lastName || firstName || "Unknown Student";
}

export default formatStudentName;
