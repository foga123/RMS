import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate } from "../../../shared/lib/dateTime";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import Table from "../../../shared/components/Table";
import { closeTerm, getTermRecords, previewTermClose, reopenTerm, restampTerm } from "../../../shared/services/api";
import { confirmAction, notifyError, notifySuccess, promptText } from "../../../shared/lib/notify";
import { canModuleAction } from "../../../shared/lib/roleAccess";
import { invalidateCurrentTerm } from "../../../shared/lib/currentTerm";

/**
 * Closing a semester: writing down what each student was, and locking the rest.
 *
 * The student record holds one row per student, so year level, section, course,
 * cohort and scholarship are current values that the next edit overwrites.
 * Closing a semester copies them into a per-term record, which is what lets the
 * migration matrix report what happened instead of projecting it.
 *
 * Closing also LOCKS the semester (backend lib/term_closure.php): its grades,
 * attendance, finance, enrollment standings and retention cases cannot be
 * added, changed or removed until an administrator reopens it - to correct a
 * wrong remark, say - with a reason that is kept. Calls and home visits that go
 * on afterwards are filed under the calendar's current semester instead.
 *
 * The panel's real job is making each act legible before it happens, so every
 * button goes through a preview or a question that says what will change.
 */

function termKey(term) {
  return `${term.school_year_id}:${term.semester_id}`;
}

function termLabel(term) {
  return `${term.school_year_name} ${term.semester_name}`;
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

/** The snapshot's columns in words; "star e-profile" and "course id" are the database's. */
const FIELD_LABELS = {
  year_level: "year level",
  course_id: "course",
  "star e-profile": "STAR or Non-STAR",
  coaching_unit: "coaching unit",
  final_scholarship_grant: "scholarship",
};

function describeFields(fields) {
  return fields.map((field) => FIELD_LABELS[field] || field.replace(/_/g, " ")).join(", ");
}

/** Status as a sentence: closed by whom and when, or open - and why, if reopened. */
function termStatus(term) {
  if (term.is_closed) {
    return `Closed ${formatDate(term.closed_at)}${term.closed_by ? ` by ${term.closed_by}` : ""}`;
  }
  if (term.reopened_at) {
    return `Open - reopened ${formatDate(term.reopened_at)}${term.reopened_by ? ` by ${term.reopened_by}` : ""}`
      + (term.reopen_reason ? `: ${term.reopen_reason}` : "");
  }
  return "Open";
}

export default function TermRecordsPanel({ permissions = null, onSummaryChange }) {
  const [terms, setTerms] = useState([]);
  const [storageReady, setStorageReady] = useState(true);
  const [closureReady, setClosureReady] = useState(true);
  const [fields, setFields] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [busyKey, setBusyKey] = useState("");

  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  // The backend asks for settings.edit on the write. Mirroring it here keeps the
  // button from appearing for someone the endpoint will refuse — the button is
  // the courtesy, the endpoint is the control.
  const canClose = hasPermissionContext ? canModuleAction(permissions, "edit") : true;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await getTermRecords();
      setTerms(Array.isArray(data?.terms) ? data.terms : []);
      setStorageReady(data?.storage_ready !== false);
      setClosureReady(data?.closure_ready !== false);
      setFields(Array.isArray(data?.snapshot_fields) ? data.snapshot_fields : []);
    } catch (err) {
      setError(err?.message || "Failed to load term records.");
      setTerms([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const closedCount = useMemo(() => terms.filter((term) => term.is_closed).length, [terms]);

  useEffect(() => {
    if (typeof onSummaryChange !== "function") return;
    if (!storageReady || !closureReady) {
      onSummaryChange("Storage not set up yet");
      return;
    }
    if (!terms.length) {
      onSummaryChange("No semester has any records yet");
      return;
    }
    onSummaryChange(`${closedCount} of ${plural(terms.length, "semester", "semesters")} closed`);
  }, [closedCount, closureReady, onSummaryChange, storageReady, terms.length]);

  /**
   * After any change: the list here, and the calendar every other screen reads
   * its closed semesters from, which is cached for the session.
   */
  const reloadAll = useCallback(async () => {
    invalidateCurrentTerm();
    await load();
  }, [load]);

  /** Someone else acted first: say so and show what they did. */
  const handleConflict = useCallback(async (err, title) => {
    if (err?.status === 409 || err?.status === 423) {
      notifyError(title, err.message || "Someone else changed this semester. Reloading so you can see it.");
      await reloadAll();
      return true;
    }
    return false;
  }, [reloadAll]);

  /**
   * Preview, describe, confirm, write.
   *
   * The preview is fetched before the dialog rather than after, so the numbers
   * in the confirmation are the ones the write will actually produce.
   */
  const handleClose = useCallback(async (term) => {
    setBusyKey(termKey(term));
    try {
      const preview = await previewTermClose(term.school_year_id, term.semester_id);

      const lines = [
        `${plural(preview.students_with_records, "student has", "students have")} a record in ${termLabel(term)}.`,
        "",
        term.has_snapshot
          ? `Their record from ${formatDate(term.recorded_at)} is kept as it is; `
            + `${plural(preview.would_insert, "student", "students")} recorded since will be added.`
          : `Each student's ${fields.length ? describeFields(fields) : "details"} will be recorded (${plural(preview.would_insert, "record", "records")}).`,
        "",
        "Its grades, attendance, finance, enrollment standings and retention cases become read-only "
          + "until an administrator reopens it.",
      ];

      if (term.is_calendar_term) {
        lines.push("");
        lines.push(
          "This is the semester the Academic Calendar is in now. Imports, calls and case work that default "
          + "to it will be refused until the calendar moves on or the semester is reopened."
        );
      }

      if (!term.is_latest_term && !term.has_snapshot) {
        lines.push("");
        lines.push(
          `${termLabel(term)} is not the most recent semester with data. Its students are recorded as the `
          + "student files say now, so anything that has changed since is recorded as if it were true then."
        );
      }

      const confirmed = await confirmAction({
        title: `Close ${termLabel(term)}?`,
        text: lines.join("\n"),
        confirmButtonText: "Close semester",
        confirmButtonColor: "var(--brand-700)",
      });
      if (!confirmed) return;

      const response = await closeTerm({ schoolYearId: term.school_year_id, semesterId: term.semester_id });
      notifySuccess("Semester closed", response?.message || `${termLabel(term)} is closed.`);
      await reloadAll();
    } catch (err) {
      if (await handleConflict(err, "Already closed")) return;
      notifyError("Could not close the semester", err?.message || "Please try again.");
    } finally {
      setBusyKey("");
    }
  }, [fields, handleConflict, reloadAll]);

  const handleReopen = useCallback(async (term) => {
    setBusyKey(termKey(term));
    try {
      const reason = await promptText({
        title: `Reopen ${termLabel(term)}?`,
        text: "Its grades, attendance, finance, enrollment standings and cases can be changed again until it is "
          + "closed. The reason is kept with the semester and in the activity log.",
        inputLabel: "Why is it being reopened?",
        placeholder: "e.g. Wrong remarks on three students' grades",
        confirmButtonText: "Reopen",
      });
      if (reason === null) return;

      const response = await reopenTerm({ schoolYearId: term.school_year_id, semesterId: term.semester_id, reason });
      notifySuccess("Semester reopened", response?.message || `${termLabel(term)} is open again.`);
      await reloadAll();
    } catch (err) {
      if (await handleConflict(err, "Not closed")) return;
      notifyError("Could not reopen the semester", err?.message || "Please try again.");
    } finally {
      setBusyKey("");
    }
  }, [handleConflict, reloadAll]);

  /** Overwrite the record with today's values - open semesters only. */
  const handleRestamp = useCallback(async (term) => {
    setBusyKey(termKey(term));
    try {
      const preview = await previewTermClose(term.school_year_id, term.semester_id);
      const lines = [
        `New records to write: ${preview.would_insert}`,
        `Already recorded and unchanged: ${preview.already_matching}`,
        `Already recorded but now different: ${preview.would_rewrite}`,
      ];
      if (preview.would_rewrite > 0) {
        lines.push("");
        lines.push(
          `Re-recording replaces ${plural(preview.would_rewrite, "record", "records")} with what the student `
          + "file says today. If those students have since changed course, section or year level, the "
          + "semester's history changes to match."
        );
      }

      const confirmed = await confirmAction({
        title: `Re-record ${termLabel(term)}?`,
        text: lines.join("\n"),
        confirmButtonText: "Re-record",
        confirmButtonColor: "var(--danger-700)",
      });
      if (!confirmed) return;

      const response = await restampTerm({ schoolYearId: term.school_year_id, semesterId: term.semester_id });
      notifySuccess("Semester re-recorded", response?.message || `${termLabel(term)} was re-recorded.`);
      await reloadAll();
    } catch (err) {
      if (await handleConflict(err, "Semester is closed")) return;
      notifyError("Could not re-record the semester", err?.message || "Please try again.");
    } finally {
      setBusyKey("");
    }
  }, [handleConflict, reloadAll]);

  // A term label carries a hyphenated school year ("2026-2027 1st Semester"),
  // which CSS will break after the hyphen into what reads as two terms. Status
  // names the person who closed it, so it stays free to wrap.
  const columns = useMemo(() => [
    { key: "term", label: "Semester", nowrap: true },
    { key: "students", label: "Students", nowrap: true },
    { key: "status", label: "Status" },
    { key: "recorded", label: "Records Held", nowrap: true },
    {
      key: "actions",
      label: "Action",
      nowrap: true,
      render: (row) => {
        const term = row._term;
        const busy = busyKey === termKey(term);
        const disabled = !canClose || !storageReady || !closureReady || busy;
        if (term.is_closed) {
          return (
            <Button size="sm" variant="secondary" disabled={disabled} onClick={() => handleReopen(term)}>
              {busy ? "Working…" : "Reopen"}
            </Button>
          );
        }
        return (
          <div style={{ display: "flex", gap: 6 }}>
            <Button size="sm" variant="primary" disabled={disabled} onClick={() => handleClose(term)}>
              {busy ? "Working…" : "Close semester"}
            </Button>
            {term.has_snapshot ? (
              <Button size="sm" variant="secondary" disabled={disabled} onClick={() => handleRestamp(term)}>
                Re-record
              </Button>
            ) : null}
          </div>
        );
      },
    },
  ], [busyKey, canClose, closureReady, handleClose, handleReopen, handleRestamp, storageReady]);

  const rows = useMemo(() => terms.map((term) => ({
    id: termKey(term),
    term: termLabel(term) + (term.is_calendar_term ? " · current" : ""),
    students: term.students_with_records,
    status: termStatus(term),
    recorded: term.has_snapshot ? term.snapshot_students : "-",
    _term: term,
  })), [terms]);

  return (
    <DashboardPanel>
      <SectionHeader
        title="Close Semester"
        actions={<Button variant="secondary" onClick={load} disabled={loading}>Refresh</Button>}
      />
      <div style={{ padding: 9, display: "grid", gap: 9 }}>
        {!storageReady || !closureReady ? (
          <AlertMessage
            tone="warning"
            message={
              "Closing a semester is not set up yet. Apply "
              + (!storageReady ? "migrations/2026_08_22_student_term_snapshot.sql and " : "")
              + "migrations/2026_09_27_term_closure.sql, then reload this panel."
            }
          />
        ) : (
          <AlertMessage
            tone="info"
            message={
              "Closing a semester does two things. It writes down what every student in it was"
              + (fields.length ? ` (${describeFields(fields)})` : "")
              + ", which the student record would otherwise overwrite. And it locks the semester: its grades, "
              + "attendance, finance, enrollment standings and retention cases cannot be added, changed or removed. "
              + "Reopen it to correct something - a wrong remark, say - and close it again when done."
            }
          />
        )}

        {error ? <AlertMessage tone="error" message={error} /> : null}

        {!canClose && storageReady ? (
          <AlertMessage
            tone="info"
            message="You can review which semesters are closed. Closing or reopening one needs Settings edit permission."
          />
        ) : null}

        <Table
          columns={columns}
          rows={rows}
          loading={loading}
          emptyText="No semester has any student records yet, so there is nothing to close."
        />
      </div>
    </DashboardPanel>
  );
}
