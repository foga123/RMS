import React, { useCallback, useEffect, useMemo, useState } from "react";
import Table from "../../shared/components/Table";
import Modal from "../../shared/components/Modal";
import PeriodicalContactForm, { createContactDraft } from "../../shared/components/contact/PeriodicalContactForm";
import { AlertMessage, Button, SectionHeader, StatCard, StatCardGrid } from "../../shared/components/ui";
import Pagination from "../../shared/components/ui/Pagination";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import { courseCampusSuffix } from "../../shared/lib/scopeOptionLabels";
import { PERIOD_ALL, periodWriteOptions } from "../../shared/lib/periods";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import {
  currentTermHint,
  currentTermPeriodFilter,
  useCurrentTermFilters,
} from "../../shared/lib/currentTerm";

/**
 * The PDO (Potential Drop Out) prioritization list, section 2 of the RETENTION &
 * MIGRATION sheet.
 *
 * Every student is placed on the sheet's 48-square grid of
 * (attendance status | grade colour | balance band) and comes out with a
 * priority and an owning team. The classification runs server-side in
 * pdo_priority_lib.php; this screen is the reading of it.
 */

/*
 * Priority 1 is the alarm and Priority 4 is the all-clear, so the palette runs
 * from danger to success rather than through four arbitrary hues. Chosen from
 * the existing tone tokens so this screen sits inside the application's palette
 * instead of introducing a fifth one.
 */
const PRIORITY_TONE = {
  1: { bg: "var(--danger-100)", fg: "var(--danger-800)", tone: "danger" },
  2: { bg: "var(--warning-100, #fef3c7)", fg: "var(--warning-800, #92400e)", tone: "warning" },
  3: { bg: "var(--info-100, #dbeafe)", fg: "var(--info-800, #1e40af)", tone: "default" },
  4: { bg: "var(--brand-100)", fg: "var(--brand-800)", tone: "success" },
};

const GRADE_TONE = {
  red: { bg: "var(--danger-100)", fg: "var(--danger-800)" },
  yellow: { bg: "var(--warning-100, #fef3c7)", fg: "var(--warning-800, #92400e)" },
  green: { bg: "var(--brand-100)", fg: "var(--brand-800)" },
  no_data: { bg: "var(--surface-page)", fg: "var(--text-muted)" },
};

function Chip({ children, bg, fg, title }) {
  return (
    <span
      title={title}
      style={{
        display: "inline-block",
        padding: "1px 7px",
        borderRadius: 999,
        fontSize: 11,
        whiteSpace: "nowrap",
        background: bg,
        color: fg,
      }}
    >
      {children}
    </span>
  );
}

function peso(value) {
  if (value === null || value === undefined) return "—";
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function PdoPriorityPage() {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [settings, setSettings] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [priority, setPriority] = useState("");
  const [search, setSearch] = useState("");
  const [courses, setCourses] = useState([]);
  const [courseId, setCourseId] = useState("");
  const [yearLevel, setYearLevel] = useState("");
  const [semesters, setSemesters] = useState([]);
  const [semesterId, setSemesterId] = useState("");
  const [period, setPeriod] = useState(PERIOD_ALL);
  /*
   * Whether students already spoken to this term are still on the list.
   *
   * Defaults to "outstanding" — who is left to ring. The board is a call list,
   * and a student who stays on it after the conversation is a student two
   * callers ring in the same afternoon. The priority itself does not move
   * (nothing about grades, attendance or balance changes on the phone), so the
   * tiles keep counting them and "Contacted" brings them back.
   *
   * An outcome of "Undecided - for follow up" does NOT clear a student: it is
   * a reason to ring again, which is the rule faculty_outcome_is_settled()
   * applies server-side.
   */
  const [contactedView, setContactedView] = useState("outstanding");

  /*
   * Paging is the server's now.
   *
   * This screen used to fetch the whole board and slice it in the browser,
   * which was 2.1MB down the wire to draw twenty-five rows once the
   * registrar's roster arrived. The sort is global and the priority tiles
   * are whole-cohort, so both still describe every student in scope - only
   * the rows themselves are now fetched a page at a time.
   */
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [pageTotal, setPageTotal] = useState(0);

  /*
   * Logging a contact from this board.
   *
   * The board is where a Dean finds the student; making them leave it to say
   * what they did about one is what kept the two apart. `contact` is the
   * server's answer about both halves — whether this account may record at all,
   * and the words the form may offer — so nothing here decides either.
   */
  const [contact, setContact] = useState(null);
  const [callTarget, setCallTarget] = useState(null);
  const [draft, setDraft] = useState(() => createContactDraft());
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  const [success, setSuccess] = useState("");

  /*
   * The list opens on the term the Academic Calendar names.
   *
   * Without it this screen answered "who is at risk on their most recent marks,
   * whenever those were" -- across every semester on record, using whichever
   * periodical each student happened to be graded in last. That is a different
   * question from "who is at risk right now", and it is the second one the
   * board is for. Applied once, when the calendar arrives.
   */
  const { term: currentTerm } = useCurrentTermFilters((term) => {
    const filter = currentTermPeriodFilter(term);
    if (filter) setPeriod(filter);
    if (term?.semester_id != null) setSemesterId(String(term.semester_id));
  });

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (priority !== "") params.set("priority", priority);
      if (search.trim() !== "") params.set("search", search.trim());
      if (courseId !== "") params.set("course_id", courseId);
      if (yearLevel !== "") params.set("year_level", yearLevel);
      if (semesterId !== "") params.set("semester_id", semesterId);
      if (period !== PERIOD_ALL) params.set("period", period);
      params.set("contacted", contactedView);
      params.set("page", String(page));
      params.set("limit", String(pageSize));

      const res = await fetch(getBackendUrl(`pdo_priority.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await res.json();
      if (!res.ok) throw new Error(payload?.message || "Failed to load the prioritization list");

      if (!isCurrent()) return;

      setRows(Array.isArray(payload?.data) ? payload.data : []);
      // The server clamps the page, so a stale page number comes back as the
      // last real one rather than as an empty table.
      if (Number.isFinite(Number(payload?.pagination?.page))) setPage(Number(payload.pagination.page));
      setPageTotal(Number(payload?.pagination?.total) || 0);
      setSummary(payload?.summary || null);
      setSettings(payload?.settings || null);
      setContact(payload?.contact || null);
    } catch (loadError) {
      if (!isCurrent()) return;
      setRows([]);
      setPageTotal(0);
      setSummary(null);
      setError(loadError?.message || "Failed to load the prioritization list");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, contactedView, courseId, page, pageSize, period, priority, search, semesterId, yearLevel]);

  useEffect(() => {
    void load();
  }, [load]);

  // The list is computed from all three, so a new grade, balance or attendance
  // upload changes who is on it.
  useLiveRefresh(["grades", "finance", "attendance", "students"], load);

  useEffect(() => {
    async function loadLookups() {
      const [courseRes, semesterRes] = await Promise.all([
        fetch(getBackendUrl("course.php?limit=500"), { credentials: "include" }).catch(() => null),
        fetch(getBackendUrl("semester.php?limit=200"), { credentials: "include" }).catch(() => null),
      ]);
      if (courseRes?.ok) {
        const json = await courseRes.json();
        setCourses(Array.isArray(json?.data) ? json.data : []);
      }
      if (semesterRes?.ok) {
        const json = await semesterRes.json();
        setSemesters(Array.isArray(json?.data) ? json.data : []);
      }
    }
    void loadLookups();
  }, []);

  /*
   * Narrowing the list puts you back on page one, before the fetch goes out.
   *
   * Adjusted during render rather than in an effect: an effect would notice
   * afterwards, so searching from page nine would fetch page nine of the
   * shorter result first and correct itself in a second request. Comparing
   * against the previous value here means `load` is built with the reset
   * page already in hand, and only one request is made.
   */
  const filterKey = JSON.stringify([priority, search, courseId, yearLevel, semesterId, period, contactedView, pageSize]);
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (filterKey !== lastFilterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  const tableRows = useMemo(
    () => rows.map((row) => ({ ...row, id: row.student_id })),
    [rows]
  );

  const canRecordContact = Boolean(contact?.can_record);

  const openCall = useCallback((row) => {
    setModalError("");
    setSuccess("");
    setDraft(createContactDraft());
    setCallTarget(row);
  }, []);

  /*
   * The Contacted card represents one complete cross-priority list.
   *
   * It used to preserve a selected priority tile, so clicking Contacted after
   * Priority 1 silently meant "contacted Priority 1" even though the card's
   * number counts every band. Clear only the priority filter here; the active
   * term, course, year and search remain useful scope controls.
   */
  const toggleContactedView = useCallback(() => {
    setPriority("");
    setContactedView((current) => (current === "done" ? "outstanding" : "done"));
  }, []);

  /*
   * Posted back to this board's own endpoint, which writes through the same
   * function the Faculty Workspace writes through. The term it is stamped with
   * is the calendar's and not this page's `period` filter — reading P1 in
   * December must not file today's conversation into a periodical that closed
   * months ago.
   */
  const recordContact = useCallback(async () => {
    if (!callTarget) return;
    setSaving(true);
    setModalError("");
    try {
      const res = await fetch(getBackendUrl("pdo_priority.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          student_id: callTarget.student_id,
          contact_method: draft.contact_method,
          outcome: draft.outcome,
          reason_id: draft.reason_id || null,
          other_reason_label: draft.other_reason_label,
          note: draft.note,
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(payload?.message || "Failed to record the contact.");

      setCallTarget(null);
      setDraft(createContactDraft());
      setSuccess(
        `${payload?.message || "Contact recorded."} — ${callTarget.student_name || callTarget.student_number}`
      );
      // The signals behind a priority do not move because somebody rang the
      // student, but the board is reloaded anyway: a contact can change the
      // enrolment picture the next evaluation reads, and a stale list after a
      // save is the thing that makes a save look like it failed.
      await load();
    } catch (saveError) {
      setModalError(saveError?.message || "Failed to record the contact.");
    } finally {
      setSaving(false);
    }
  }, [callTarget, draft, load]);

  const columns = useMemo(
    () => [
      {
        key: "priority",
        label: "Priority",
        nowrap: true,
        render: (row) => (
          <Chip {...PRIORITY_TONE[row.priority]} title={`Owned by ${row.owner}`}>
            P{row.priority} &middot; {row.owner}
          </Chip>
        ),
      },
      // Hyphenated identifiers, so they hold one line rather than breaking after
      // a hyphen into what reads as two different values.
      { key: "student_number", label: "Student No.", nowrap: true, render: (row) => row.student_number || "—" },
      { key: "student_name", label: "Student Name", render: (row) => row.student_name || "—" },
      {
        key: "course",
        label: "Course",
        nowrap: true,
        render: (row) => row.course_code || row.course_name || "—",
      },
      {
        key: "year_section",
        label: "Year/Section",
        nowrap: true,
        render: (row) => [row.year_level ? `Year ${row.year_level}` : null, row.section].filter(Boolean).join(" / ") || "—",
      },
      {
        key: "attendance",
        label: "Attendance",
        nowrap: true,
        /*
         * Coloured from attendance_colour, which is null when nothing is on
         * record. `attendance_status` is not: it answers the policy question
         * the matrix asks, and reads "attending" for a student with no row at
         * all.
         */
        render: (row) => (
          <Chip
            bg={row.attendance_colour === "red" ? "var(--danger-100)" : "var(--surface-page)"}
            fg={row.attendance_colour === "red" ? "var(--danger-800)" : "var(--text-secondary)"}
            title={row.present_rate === null ? "No attendance recorded for this term" : `${row.present_rate}% present`}
          >
            {row.attendance_label}
            {row.present_rate === null ? "" : ` ${row.present_rate}%`}
          </Chip>
        ),
      },
      {
        key: "grade",
        label: "Grades",
        nowrap: true,
        render: (row) => (
          <Chip
            {...GRADE_TONE[row.grade_colour]}
            title={
              row.total_subject === null
                ? "No grade record for this term"
                : `${row.problem_subjects} problem subject(s) of ${row.total_subject}`
            }
          >
            {row.grade_label}
            {row.problem_subjects ? ` (${row.problem_subjects})` : ""}
          </Chip>
        ),
      },
      {
        key: "balance",
        label: "Balance",
        nowrap: true,
        render: (row) => (
          <span title={row.balance_label}>
            {row.balance_amount === null ? row.balance_label : peso(row.balance_amount)}
          </span>
        ),
      },
      /*
       * What was concluded, and when.
       *
       * Carried on every view rather than only on "Already contacted": on the
       * default list it is how an Undecided student explains why they are
       * still here after somebody rang them, which otherwise reads as the
       * board having ignored the call.
       */
      {
        key: "contact_state",
        label: "Contacted",
        nowrap: true,
        render: (row) => {
          const contact = row.last_contact;
          if (!contact) {
            return <span style={{ color: "var(--text-faint)" }}>&mdash;</span>;
          }
          const when = contact.contacted_at
            ? new Date(String(contact.contacted_at).replace(" ", "T")).toLocaleDateString()
            : "";
          return (
            <span
              title={[contact.by_name, contact.by_role_name, when, contact.contact_method].filter(Boolean).join(" · ")}
              style={{ display: "grid", gap: 2, color: contact.settled ? "var(--text-secondary)" : "var(--warning-700, #92400e)" }}
            >
              <span>
                {contact.outcome_label || "Recorded"}
                {when ? <span style={{ color: "var(--text-faint)" }}> · {when}</span> : null}
              </span>
              <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>
                Contacted by {contact.by_name?.trim() || "Unknown staff"}
                {contact.by_role_name ? ` · ${contact.by_role_name}` : ""}
              </span>
            </span>
          );
        },
      },
      /*
       * Offered only where the server said it may be. `can_record` is the same
       * edit-or-intervene test that gates the write, so the button cannot
       * appear for an account whose POST would be refused — a control that is
       * present and always fails is worse than no control.
       */
      ...(canRecordContact
        ? [
            {
              key: "log_contact",
              label: "",
              render: (row) => (
                // nowrap because the column is as narrow as its contents and
                // the label broke across two lines on all twenty-five rows.
                <Button variant="secondary" style={{ whiteSpace: "nowrap" }} onClick={() => openCall(row)}>
                  Log a call
                </Button>
              ),
            },
          ]
        : []),
    ],
    [canRecordContact, openCall]
  );

  const controlStyle = {
    padding: "5px 7px",
    border: "1px solid var(--border-base)",
    borderRadius: 5,
    background: "var(--surface-base)",
  };

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 4, color: "var(--brand-800)" }}>PDO Prioritization List</h2>
      <p style={{ marginTop: 0, marginBottom: 11, color: "var(--text-secondary)", fontSize: 12.5 }}>
        Probable drop-outs, ranked by the RETENTION &amp; MIGRATION segment matrix. Each student is
        placed by attendance, grade colour and balance, then handed to the team that owns that square.
      </p>

      <AlertMessage tone="error" message={error} />
      <AlertMessage tone="success" message={success} />

      {/*
        Which term these priorities were worked out from.

        The list is a judgement, not a record, and the same student is a
        different priority in P1 and P3. Stating the term is what stops the
        board being read as a permanent verdict — and it is the only thing on
        screen that says the grades behind it are P1's rather than the latest
        ones on file.
      */}
      {currentTermHint(currentTerm) ? (
        <p style={{ margin: "0 0 11px", fontSize: 11.5, lineHeight: 1.5, color: "var(--text-muted)" }}>
          {currentTermHint(currentTerm)}
        </p>
      ) : null}

      {/* How much of the list has been worked is on the Contacted tile below,
          which carries both halves and is the control for them. Saying it again
          in a paragraph is a second copy to keep in step. */}

      {/*
        The four priority bands, and a way in.

        Clicking one filters the table to it — the counts are the first question
        anyone asks of this screen ("how many are Priority 1?") and the second is
        always "show me them".
      */}
      {summary ? (
        <div style={{ marginBottom: 11 }}>
          <StatCardGrid minWidth={180}>
            {/*
              StatCard's own onClick, not a <button> wrapped around it.

              These were hand-rolled wrappers drawing their own outline for the
              pressed state, which put two different pressable tiles in one grid
              once Contacted arrived beside them -- a brand outline offset from
              the card on four of them, the design system's inset ring on the
              fifth. StatCard already handles being pressable: it sets type,
              aria-pressed and the ring, and keeps the card looking identical
              whether or not it happens to be interactive.
            */}
            {summary.by_priority.map((band) => (
              <StatCard
                key={band.priority}
                label={band.label}
                value={band.count.toLocaleString()}
                tone={PRIORITY_TONE[band.priority]?.tone}
                onClick={() => setPriority(String(priority) === String(band.priority) ? "" : String(band.priority))}
                active={String(priority) === String(band.priority)}
                hint={`Show only ${band.label}`}
              />
            ))}

            {/*
              Contacted is a STATE, not a filter, so it sits with the bands
              rather than in the control row below them.

              A student leaves the call list by being spoken to, the same way
              they are on it by being Priority 1 — both are things that are
              true of the student, and the reader's question is the same one
              either way: how many, and show me them. It was a dropdown in the
              filter bar first, which put the one control that changes what the
              list MEANS among the controls that narrow it.

              Toggles rather than cycling through three values: clicking it
              shows the students already dealt with, clicking it again gives
              the call list back. `all` is still served by the endpoint for
              anything that asks, it is just not a third click nobody would
              guess at.
            */}
            <StatCard
              label="Contacted"
              value={Number(summary.contacted ?? 0).toLocaleString()}
              meta={`${Number(summary.outstanding ?? 0).toLocaleString()} still to contact`}
              tone="success"
              onClick={toggleContactedView}
              active={contactedView === "done"}
              hint="Show contacted students from every priority. An Undecided outcome stays on the call list."
            />
          </StatCardGrid>
        </div>
      ) : null}

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <SectionHeader
          /*
           * The state first, then the band. A table headed "All students"
           * while it is showing only the ones already dealt with is a heading
           * that contradicts its own contents -- and the Contacted view is the
           * one a reader arrives at by clicking a tile, so it is exactly the
           * one that has to say what it is.
           */
          title={
            [
              contactedView === "done" ? "Contacted" : null,
              priority === ""
                ? (contactedView === "done" ? "All priorities" : "All students")
                : `Priority ${priority}: ${summary?.by_priority?.find((b) => String(b.priority) === String(priority))?.owner || ""}`,
            ]
              .filter(Boolean)
              .join(" · ")
          }
          sticky
          actions={
            <>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search student number or name"
                style={{ ...controlStyle, minWidth: 221 }}
                name="pdo_search"
              />
              <select
                value={courseId}
                onChange={(event) => setCourseId(event.target.value)}
                style={{ ...controlStyle, minWidth: 162 }}
                name="pdo_course"
                aria-label="Filter by course"
              >
                <option value="">All courses</option>
                {courses.map((course) => (
                  <option key={course.course_id} value={String(course.course_id)}>
                    {course.course_code || course.course_name || `Course ${course.course_id}`}
                    {courseCampusSuffix(course, courses)}
                  </option>
                ))}
              </select>
              {/* Year level sits beside course because the two are read
                  together — "first years in BSIT" is one question, not two.
                  The options are fixed 1-5 rather than fetched: they are a
                  property of the curriculum, not of who happens to be
                  enrolled, and deriving them from the rows would make a year
                  vanish from the filter exactly when it has nobody at risk in
                  it — which is the moment you most want to confirm that. */}
              <select
                value={yearLevel}
                onChange={(event) => setYearLevel(event.target.value)}
                style={{ ...controlStyle, minWidth: 142 }}
                name="pdo_year_level"
                aria-label="Filter by year level"
              >
                <option value="">All year levels</option>
                {[1, 2, 3, 4, 5].map((year) => (
                  <option key={year} value={String(year)}>
                    {yearLevelLabel(year)}
                  </option>
                ))}
              </select>
              <select
                value={semesterId}
                onChange={(event) => setSemesterId(event.target.value)}
                style={{ ...controlStyle, minWidth: 136 }}
                name="pdo_semester"
                aria-label="Filter by semester"
              >
                <option value="">All semesters</option>
                {semesters.map((semester) => (
                  <option key={semester.semester_id} value={String(semester.semester_id)}>
                    {semester.semester_name || `Semester ${semester.semester_id}`}
                  </option>
                ))}
              </select>
              <select
                value={period}
                onChange={(event) => setPeriod(event.target.value)}
                style={{ ...controlStyle, minWidth: 150 }}
                name="pdo_period"
                aria-label="Filter by periodical"
                title="Judge every student on this periodical's grades, attendance and balance"
              >
                <option value={PERIOD_ALL}>Whole semester</option>
                {periodWriteOptions({ includeBlank: false }).map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {/* Contacted is not here: it is a state, and it lives with the
                  bands above. See the note on that tile. */}
              {priority !== "" || search !== "" || courseId !== "" || semesterId !== "" || period !== PERIOD_ALL ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setPriority("");
                    setSearch("");
                    setCourseId("");
                    setSemesterId("");
                    setPeriod(PERIOD_ALL);
                  }}
                >
                  Clear
                </Button>
              ) : null}
            </>
          }
        />

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 400px)" }}>
          <Table
            columns={columns}
            rows={tableRows}
            loading={loading}
            emptyText="No students match this view."
          />
        </div>

        <div style={{ padding: 9, borderTop: "1px solid var(--border-base)" }}>
          <Pagination
            page={page}
            pageSize={pageSize}
            total={pageTotal}
            onPageChange={setPage}
            onPageSizeChange={(size) => setPageSize(Math.max(1, Number(size) || 25))}
            itemLabel="students"
          />
        </div>
      </div>

      {/*
        The two thresholds the sheet leaves undefined, said out loud.

        The matrix names Green/Yellow/Red and Attending/SLIP but never defines
        them, so these are the school's policy and they live in the pdo_setting
        table. Printing them here means nobody has to read the source to find out
        why a student came out Yellow.
      */}
      {settings ? (
        <p style={{ marginTop: 11, marginBottom: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.6 }}>
          <strong>How students are classified.</strong>{" "}
          Grades: no record is <em>No Grade Data</em>; no problem subjects is <em>Green</em>; up to{" "}
          {settings.grade_yellow_max_problems} is <em>Yellow</em>; more is <em>Red</em>. A problem subject is
          one failed, incomplete, no-credit or no-grade.{" "}
          Attendance: absent for {settings.attendance_slip_min_absent_rate}% of classes or more is <em>SLIP</em>
          {Number(settings.attendance_missing_is_slip) === 1
            ? ", and a student with no attendance record counts as SLIP"
            : ", and a student with no attendance record counts as Attending"}.{" "}
          The sheet does not define these, so they are settings rather than code — change them in{" "}
          <code>pdo_setting</code>.
        </p>
      ) : null}

      <Modal
        open={Boolean(callTarget)}
        title={
          callTarget
            ? `Log a call — ${callTarget.student_name || callTarget.student_number}`
            : "Log a call"
        }
        onClose={() => setCallTarget(null)}
        width={620}
      >
        {callTarget ? (
          <div style={{ display: "grid", gap: 10 }}>
            <AlertMessage tone="error" message={modalError} />

            <div style={{ fontSize: 11.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
              {[callTarget.student_number, callTarget.course_code || callTarget.course_name,
                callTarget.year_level ? `Year ${callTarget.year_level}` : null, callTarget.section]
                .filter(Boolean)
                .join(" · ")}
              <span style={{ display: "block", color: "var(--text-muted)" }}>
                Currently P{callTarget.priority} · {callTarget.segment}
              </span>
            </div>

            {/*
              * Which periodical this will be filed under, said before it is
              * written rather than after.
              *
              * The board's own period filter can be pointed at P1 while the
              * calendar is in P3, and the contact is always stamped with the
              * calendar's — acting happens in the term in progress. Saying so
              * here is what stops that from being a surprise.
              */}
            {contact?.term?.label ? (
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                This will be recorded against <strong>{contact.term.label}</strong>, the term in progress.
              </div>
            ) : null}

            <PeriodicalContactForm
              settings={contact}
              draft={draft}
              onChange={setDraft}
              onSubmit={recordContact}
              saving={saving}
              heading={null}
              submitLabel="Record contact"
              namePrefix="pdo_contact"
            />
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
