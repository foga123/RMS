import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as dateTime from "../../shared/lib/dateTime";
import { ManagementPage, ManagementTableCard } from "../../shared/components/management/ManagementPage";
/*
 * Imported a file at a time rather than through shared/components/ui.
 *
 * The barrel re-exports Breadcrumb, which imports react-router-dom, which jest
 * cannot resolve — so importing four buttons through it drags the router into
 * the module graph and this page becomes untestable for a reason that has
 * nothing to do with it. SurveyFolderShelf already reaches in directly for the
 * same reason.
 */
import Button from "../../shared/components/ui/Button";
import { StatCard, StatCardGrid } from "../../shared/components/ui/StatCard";
import Tabs from "../../shared/components/ui/Tabs";
import Pagination from "../../shared/components/ui/Pagination";
import usePagedRows from "../../shared/hooks/usePagedRows";
import { periodLabel } from "../../shared/lib/periods";
import Modal from "../../shared/components/Modal/Modal";
import { getBackendUrl } from "../../shared/lib/url";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { toRoman } from "../../shared/lib/yearLevel";

/**
 * How much work each caller on a supervisor's team has actually done.
 *
 * Which team is not chosen here — team_monitor.php works it out from the acting
 * role, because API_FOLLOW_UP_TEAMS already pairs an SSP Coordinator with their
 * SSP Callers and a KSH TL with their KASAMA workers. So this is one screen with
 * two audiences, and neither can reach the other's roster by editing a URL.
 *
 * The one visible difference between them is the Log a call action, which the
 * server decides with `can_record_contact`: a KSH TL is a working team leader
 * and rings students themselves, an SSP Coordinator monitors and assigns. The
 * flag only shows or hides the button — the write itself goes through the
 * Contact Workspace, which authorises it independently.
 *
 * A Dean or Program Head gets two boards rather than one, and switches between
 * them with the filter above the cards: their faculty, and the SSP Callers and
 * KASAMA coaches who hold students in their department. The second is scoped by
 * the STUDENT — a caller belongs to no department, so what puts them on a dean's
 * board is carrying that dean's students, and every number on the row counts
 * only those. The list of boards comes from the server on `boards`, so the
 * filter appears by having somewhere to go rather than by a role test here.
 *
 * The third board turns the screen around. Faculty and Callers are lists of
 * staff; Students is a list of the department's students that somebody has
 * logged a contact with, and who logged it. It is the same records read from
 * the other end, and it exists because the only way to answer "which of my
 * students have my faculty spoken to" from the first two was to open every
 * teacher in turn and add the lists up by hand.
 */

const OUTCOME_COLUMNS = [
  { key: "recovered", label: "Recovered", tone: "#047857" },
  { key: "not_recovered", label: "Not recovered", tone: "#b91c1c" },
  { key: "referred", label: "Referred", tone: "#b45309" },
  { key: "follow_up", label: "Follow up", tone: "#b45309" },
  { key: "unreachable", label: "Unreachable", tone: "#b91c1c" },
];

/*
 * The academic board counts different words.
 *
 * A Dean or Program Head supervises faculty, and faculty record the periodical
 * outcome — Continuing, Shifting, Stopping, Undecided — not the follow-up
 * teams' Recovered / Not recovered / Referred. The two lists share no keys, so
 * rendering one against the other would print five columns of zeros beside a
 * teacher who had logged forty contacts.
 *
 * The server says which set it is counting, on `vocabulary`. This map exists
 * only for the colours, which are a reading of the words rather than data:
 * Continuing is the good end of it and Stopping the bad one.
 */
const FACULTY_OUTCOME_COLUMNS = [
  { key: "continuing", label: "Continuing", tone: "#047857" },
  { key: "shifting", label: "Shifting", tone: "#b45309" },
  { key: "stopping", label: "Stopping", tone: "#b91c1c" },
  { key: "undecided", label: "Undecided", tone: "#b45309" },
];

/**
 * The date alone, and "Never" when there is none.
 *
 * This is a "last called" column on a supervisor's roster: the day is what gets
 * compared across a team, and the minute a call landed is noise at that zoom.
 * "Never" is the finding the column exists to surface, so it is spelled out.
 */
const formatWhen = (value) => dateTime.formatDate(value, { fallback: "Never" });

/**
 * Coverage as a bar, because the number alone does not rank.
 *
 * A column of "62.5%" and "58.3%" reads as two similar numbers; two bars of
 * visibly different length reads as an ordering, which is the thing a
 * supervisor is scanning for. Null — nobody assigned — is a dash rather than
 * 0%: "has not called anyone" and "has nobody to call" are different problems
 * with different fixes, and painting the second as the first sends the
 * supervisor after the wrong person.
 */
function CoverageBar({ percent }) {
  if (percent === null || percent === undefined) {
    return <span style={{ color: "var(--text-faint)" }} title="No students are assigned to this coach">&mdash;</span>;
  }

  const value = Math.max(0, Math.min(100, Number(percent) || 0));
  const tone = value >= 75 ? "#047857" : value >= 40 ? "#d97706" : "#b91c1c";

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 118 }}>
      <div style={{ flex: "1 1 0", height: 6, borderRadius: 999, background: "var(--surface-page)", overflow: "hidden" }}>
        <div style={{ width: `${value}%`, height: "100%", background: tone }} />
      </div>
      <span style={{ flex: "none", fontSize: 11.5, fontWeight: 600, color: tone, fontVariantNumeric: "tabular-nums" }}>
        {value}%
      </span>
    </div>
  );
}

export default function TeamMonitorPage({ module }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // { worker, students, loading, error }
  const [detail, setDetail] = useState(null);
  /*
   * { student, attempts, loading, error } — the students board's own modal.
   *
   * Kept apart from `detail` rather than folded into it with a `kind` field.
   * The two show different things (a worker's students; one student's
   * attempts), and a single piece of state holding either would need a
   * discriminator checked at every read, which is how the wrong table ends up
   * rendering against the right data.
   */
  const [studentDetail, setStudentDetail] = useState(null);
  /*
   * Which board, for the accounts that have two. Sent on every request so the
   * roster and the worker detail are always read from the same one — the server
   * ignores it for everyone else, and falls back to the faculty board on a value
   * it does not recognise.
   */
  const [board, setBoard] = useState("faculty");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl(`team_monitor.php?board=${encodeURIComponent(board)}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load the team monitor");
      setData(json?.data || null);
    } catch (loadError) {
      setData(null);
      setError(loadError?.message || "Failed to load the team monitor");
    } finally {
      setLoading(false);
    }
  }, [board]);

  useEffect(() => {
    void load();
  }, [load]);

  /*
   * An attempt logged in the Contact Workspace has to move these numbers, or a
   * supervisor watching this board sees a caller working and the board idle.
   *
   * Both names must match changes_topic_map() in backend/api/changes.php
   * exactly. `ssp_assignment` was singular here and plural there, and
   * `student_contacts` had no entry at all, so the probe answered with an empty
   * token set on every tick and this board never refreshed once. The endpoint
   * now reports unknown topics back and useLiveRefresh warns about them in
   * development, so the next typo is visible instead of silent.
   */
  useLiveRefresh(["student_contacts", "ssp_assignments"], load);

  /** One student's contacts, newest first — who rang, when, and how it ended. */
  const openStudent = useCallback(async (student) => {
    setStudentDetail({ student, attempts: [], loading: true });
    try {
      const res = await fetch(
        getBackendUrl(
          `team_monitor.php?action=student&student_id=${encodeURIComponent(student.student_id)}`
            + "&board=students"
        ),
        { headers: { Accept: "application/json" }, credentials: "include" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load this student's contacts");
      setStudentDetail((current) =>
        current ? { ...current, loading: false, attempts: json?.data?.attempts || [] } : current
      );
    } catch (detailError) {
      setStudentDetail((current) =>
        current ? { ...current, loading: false, error: detailError?.message || "Failed to load" } : current
      );
    }
  }, []);

  const openWorker = useCallback(async (worker) => {
    setDetail({ worker, students: [], loading: true });
    try {
      const res = await fetch(
        getBackendUrl(
          `team_monitor.php?action=worker&user_id=${encodeURIComponent(worker.user_id)}`
            + `&board=${encodeURIComponent(board)}`
        ),
        { headers: { Accept: "application/json" }, credentials: "include" }
      );
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load this coach's students");
      setDetail((current) =>
        current ? { ...current, loading: false, students: json?.data?.students || [] } : current
      );
    } catch (detailError) {
      setDetail((current) =>
        current ? { ...current, loading: false, error: detailError?.message || "Failed to load" } : current
      );
    }
  }, [board]);

  const team = useMemo(() => data?.team || [], [data]);
  /*
   * Which board this is, decided by the server rather than by the role in the
   * browser. The endpoint already resolves supervision to answer whether this
   * account may see anything at all, so the same answer names the vocabulary —
   * a client that worked it out from its own role would be a second copy of a
   * rule that gates access.
   */
  const academic = (data?.vocabulary || "intervention") === "faculty";
  /*
   * Three flags where there used to be one, because a Dean's two boards agree on
   * the scope and disagree on everything else:
   *
   *   academic         which outcome words the columns are in. True only on the
   *                    faculty board — the dean's callers write the follow-up
   *                    vocabulary like any other caller.
   *   departmentScoped this board is one department's, so the headline numbers
   *                    are about a department rather than a team.
   *   hasCaseload      these workers carry students of their own, which is what
   *                    makes Assigned and Coverage mean anything. False for
   *                    faculty, true for callers on either board.
   *
   * Collapsing them back into one would put a coverage percentage on a faculty
   * row or take it off a caller's, which is the bug the server's own comments
   * spend a paragraph each avoiding.
   */
  const departmentScoped = (data?.scope || "") === "department";
  const hasCaseload = data?.has_caseload !== false;
  const boards = useMemo(() => data?.boards || [], [data]);
  const totals = data?.totals || {};
  const canRecord = Boolean(data?.can_record_contact);
  const cohorts = data?.cohorts || [];
  /*
   * Read from the response rather than from the `board` state, so the table and
   * the rows under it always come from the same answer. Switching boards leaves
   * the previous rows on screen for the length of one fetch; taken from the
   * state, the columns would change first and render student columns against
   * worker rows for that moment.
   */
  const studentsBoard = (data?.board || "") === "students";
  const contactedStudents = useMemo(() => data?.students || [], [data]);

  const columns = useMemo(
    () => [
      {
        key: "name",
        label: academic ? "Faculty" : "Coach",
        render: (row) => (
          <button
            type="button"
            onClick={() => void openWorker(row)}
            title={
              academic
                ? "See the students this faculty member has spoken to"
                : departmentScoped
                  ? "See this coach's students from your department"
                  : "See the students assigned to this coach"
            }
            style={{
              border: "none",
              background: "none",
              padding: 0,
              font: "inherit",
              cursor: "pointer",
              color: "var(--brand-700)",
              fontWeight: 600,
              textAlign: "left",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {row.name || `User ${row.user_id}`}
          </button>
        ),
      },
      {
        key: "role_name",
        label: "Role",
        render: (row) => (
          <span style={{ color: "var(--text-secondary)" }}>
            {row.role_name || "-"}
            {row.student_type ? (
              <span style={{ display: "block", fontSize: 10.5, color: "var(--text-faint)" }}>{row.student_type}</span>
            ) : null}
          </span>
        ),
      },
      /*
       * Assigned and Coverage are a caseload's columns, and are dropped on the
       * faculty board because faculty have no caseload to be a share OF: the
       * Faculty Workspace is department-scoped, so every teacher in a
       * department is looking at the same students. A percentage against that
       * shared total would read as a personal coverage figure while actually
       * dividing by a number nobody owns — and on a screen that names
       * colleagues, an invented denominator is a performance judgement.
       *
       * The department's student count is still shown, once, in the header.
       *
       * They stay on the dean's CALLERS board, where both numbers are that
       * caller's own and both are narrowed to this department: 1 of 5 here is a
       * real coverage figure, not a slice of a college-wide 1 of 77.
       */
      ...(hasCaseload
        ? [
            {
              key: "assigned_students",
              label: "Assigned",
              render: (row) => (
                <span
                  style={{ fontVariantNumeric: "tabular-nums" }}
                  title={departmentScoped ? "Students in your department assigned to this coach" : undefined}
                >
                  {row.assigned_students}
                </span>
              ),
            },
          ]
        : []),
      {
        key: "students_contacted",
        label: academic ? "Students spoken to" : "Contacted",
        render: (row) => (
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{row.students_contacted}</span>
        ),
      },
      ...(hasCaseload
        ? [
            {
              key: "coverage_percent",
              label: "Coverage",
              render: (row) => <CoverageBar percent={row.coverage_percent} />,
            },
          ]
        : []),
      {
        key: "total_attempts",
        label: "Attempts",
        render: (row) => (
          <span
            style={{ fontVariantNumeric: "tabular-nums" }}
            title={
              departmentScoped && !academic
                ? "Every attempt logged against one of your department's students, including repeat calls"
                : "Every attempt logged, including repeat calls to the same student"
            }
          >
            {row.total_attempts}
          </span>
        ),
      },
      ...(academic ? FACULTY_OUTCOME_COLUMNS : OUTCOME_COLUMNS).map((outcome) => ({
        key: outcome.key,
        label: outcome.label,
        render: (row) => {
          const value = row.outcomes?.[outcome.key] || 0;
          return (
            <span style={{ fontVariantNumeric: "tabular-nums", color: value ? outcome.tone : "var(--text-faint)" }}>
              {value}
            </span>
          );
        },
      })),
      {
        key: "last_contacted_at",
        label: "Last activity",
        render: (row) => (
          <span style={{ color: row.last_contacted_at ? "var(--text-secondary)" : "var(--text-faint)" }}>
            {formatWhen(row.last_contacted_at)}
          </span>
        ),
      },
    ],
    [openWorker, academic, departmentScoped, hasCaseload]
  );

  /*
   * The students board's columns. A separate list rather than more branches
   * inside the roster's: they share not one column, and every `studentsBoard ?`
   * inside a worker column would be a place for a student value to be rendered
   * with a worker's formatting.
   */
  const studentColumns = useMemo(
    () => [
      {
        key: "student_number",
        label: "Student No.",
        render: (row) => <span style={{ whiteSpace: "nowrap" }}>{row.student_number || "-"}</span>,
      },
      {
        key: "student_name",
        label: "Student",
        render: (row) => (
          <button
            type="button"
            onClick={() => void openStudent(row)}
            title="See every contact logged with this student"
            style={{
              border: "none",
              background: "none",
              padding: 0,
              font: "inherit",
              cursor: "pointer",
              color: "var(--brand-700)",
              fontWeight: 600,
              textAlign: "left",
              textDecoration: "underline",
              textUnderlineOffset: 2,
            }}
          >
            {row.student_name || `Student ${row.student_id}`}
          </button>
        ),
      },
      {
        key: "course_code",
        label: "Course",
        render: (row) => (
          <span style={{ color: "var(--text-secondary)" }}>
            {row.course_code || "-"}
            {row.section ? (
              <span style={{ display: "block", fontSize: 10.5, color: "var(--text-faint)" }}>{row.section}</span>
            ) : null}
          </span>
        ),
      },
      {
        key: "year_level",
        label: "Year",
        render: (row) => (
          <span style={{ color: "var(--text-secondary)" }}>{row.year_level ? toRoman(row.year_level) : "-"}</span>
        ),
      },
      {
        /*
         * The column the board was asked for: who actually spoke to them.
         *
         * The role is printed under the name because it is the answer to a
         * different question than the name is. A dean scanning for "have my
         * faculty done their periodical calls" needs to tell a teacher's
         * contact from an SSP caller's at a glance, and two names alone do not
         * say which was which.
         */
        key: "contacted_by",
        label: "Contacted by",
        render: (row) => {
          const staff = row.contacted_by || [];
          if (staff.length === 0) return <span style={{ color: "var(--text-faint)" }}>&mdash;</span>;

          return (
            <span style={{ display: "grid", gap: 2 }}>
              {staff.map((person) => (
                <span key={`${row.student_id}-${person.user_id ?? person.name}`}>
                  {person.name}
                  <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>
                    {person.role_name ? ` · ${person.role_name}` : ""}
                    {person.attempts > 1 ? ` · ${person.attempts} attempts` : ""}
                  </span>
                </span>
              ))}
            </span>
          );
        },
      },
      {
        key: "attempts",
        label: "Attempts",
        render: (row) => (
          <span style={{ fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>{row.attempts}</span>
        ),
      },
      {
        key: "latest_outcome",
        label: "Latest outcome",
        render: (row) => (
          <span style={{ color: row.latest_outcome ? "var(--text-primary)" : "var(--text-faint)" }}>
            {row.latest_outcome || "Not recorded"}
          </span>
        ),
      },
      {
        key: "last_contacted_at",
        label: "Last contact",
        render: (row) => (
          <span style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
            {formatWhen(row.last_contacted_at)}
          </span>
        ),
      },
    ],
    [openStudent]
  );

  const tableRows = useMemo(() => team.map((row) => ({ ...row, id: row.user_id })), [team]);
  /*
   * Paged, because this list grows with the term while the roster does not: a
   * department has a few dozen staff forever, and one contacted student per
   * contact made. Clamped on read by the hook, so narrowing the list while deep
   * in it cannot leave the reader on a page that no longer exists.
   */
  const pagedStudents = usePagedRows(contactedStudents, 25);
  const studentRows = useMemo(
    () => pagedStudents.rows.map((row) => ({ ...row, id: row.student_id })),
    [pagedStudents.rows]
  );

  return (
    <ManagementPage
      title={module?.label || "Team Monitoring"}
      subtitle={
        studentsBoard
          ? "Every student in your department somebody has logged a contact with, and who logged it. Click a student for the contacts themselves; the students nobody has reached are counted above and listed in the Faculty Workspace."
          : academic
          /* "this periodical" for two years, and none of these numbers were
             ever filtered by one — the roster counts every attempt a teacher
             has logged, and so does the list behind each row. */
          ? "Every periodical contact each faculty member in your department has logged. Click one to see the students they have spoken to."
          : departmentScoped
            ? "The SSP and KASAMA coaches holding students from your department. Every number counts your students only — click one for the part of their caseload that is yours."
            : cohorts.length > 0
              ? `How much of the ${cohorts.join(" and ")} follow-up work your team has covered. Click a coach for their students.`
              : "How much of the follow-up work your team has covered. Click a coach for their students."
      }
      error={error}
    >
      <div style={{ display: "grid", gap: 11 }}>
        {/*
          * The board filter, for the accounts the server offered more than one
          * to. Everyone else gets `boards: []` and no control at all, rather
          * than a single disabled tab explaining a choice they do not have.
          */}
        {boards.length > 1 ? (
          <Tabs
            tabs={boards.map((entry) => ({
              key: entry.key,
              label: entry.label,
              hint:
                entry.key === "faculty"
                  ? "The faculty in your department and their periodical contacts"
                  : entry.key === "callers"
                    ? "The coaches who hold students from your department"
                    : "Your students that somebody has logged a contact with",
            }))}
            value={board}
            onChange={setBoard}
            label="Monitoring boards"
          />
        ) : null}

        {studentsBoard ? (
          /*
           * The students board's own headline, and the only one on this screen
           * where a coverage figure is honest: each student is counted once
           * however many people rang them, against the department they are
           * actually in, so it cannot pass 100% the way a sum of caseloads
           * could.
           */
          <StatCardGrid minWidth={190}>
            <StatCard
              label="Students contacted"
              value={loading ? "..." : totals.students_contacted ?? 0}
              tone="success"
              meta={
                totals.workers
                  ? `By ${totals.workers} member${totals.workers === 1 ? "" : "s"} of staff`
                  : "Nobody has logged a contact yet"
              }
            />
            {/*
              * The number the board is really for. "5 contacted" reads as
              * progress; "247 not yet" reads as the work, and it is the same
              * two numbers either way.
              */}
            <StatCard
              label="Not yet contacted"
              value={
                loading
                  ? "..."
                  : Math.max(0, (totals.assigned_students ?? 0) - (totals.students_contacted ?? 0))
              }
              tone="warning"
              meta="Nobody has logged a contact with them yet"
            />
            <StatCard
              label="Students in your department"
              value={loading ? "..." : totals.assigned_students ?? 0}
              meta={
                totals.coverage_percent === null || totals.coverage_percent === undefined
                  ? ""
                  : `${totals.coverage_percent}% reached`
              }
            />
            <StatCard
              label="Attempts logged"
              value={loading ? "..." : totals.total_attempts ?? 0}
              meta="Every contact logged, including repeats to the same student"
            />
          </StatCardGrid>
        ) : (
        <StatCardGrid minWidth={190}>
          <StatCard
            label={
              academic
                ? "Faculty in your department"
                : departmentScoped
                  ? "Coaches with your students"
                  : "Coaches on your team"
            }
            value={loading ? "..." : totals.workers ?? 0}
            meta={departmentScoped && !academic ? "A coach appears once one of your students is theirs" : ""}
          />
          <StatCard
            label={departmentScoped ? "Students in your department" : "Students assigned"}
            value={loading ? "..." : totals.assigned_students ?? 0}
            /* On either departmental board this is context, not a caseload: it
               is the department's whole population, counted the same way the
               Faculty Workspace counts it. On the callers board it is
               deliberately NOT the sum of the Assigned column — two callers can
               hold the same student, so that sum is not a population. */
            meta={
              academic
                ? "Shared by every faculty member here"
                : departmentScoped
                  ? "The whole department, however it is split between coaches"
                  : ""
            }
          />
          <StatCard
            label={academic ? "Contacts logged" : "Students reached"}
            value={loading ? "..." : totals.students_contacted ?? 0}
            tone="success"
            meta={
              academic
                ? "One per faculty member per student; two teachers reaching the same student counts twice"
                : departmentScoped
                  ? "Counted once each, and only your department's students"
                  : "Counted once each, however many times they were called"
            }
          />
          {/* No team coverage card on either departmental board — there is no
              shared denominator to be a percentage of, and one student reached
              by two workers would push a ratio past 100%. Attempts is the honest
              headline there; per-caller coverage is in the table, where the
              numerator and denominator belong to the same person. */}
          <StatCard
            label={departmentScoped ? "Attempts logged" : "Team coverage"}
            value={
              departmentScoped
                ? (loading ? "..." : totals.total_attempts ?? 0)
                : (loading ? "..." : totals.coverage_percent === null || totals.coverage_percent === undefined ? "-" : `${totals.coverage_percent}%`)
            }
            meta={
              academic
                ? "Every contact attempt, including repeats"
                : departmentScoped
                  ? "Every call logged to one of your students, including repeats"
                  : totals.assigned_students
                    ? `${totals.students_contacted ?? 0} of ${totals.assigned_students} assigned`
                    : "Nobody is assigned yet"
            }
          />
        </StatCardGrid>
        )}

        {/*
          * What this account may do, said once and plainly.
          *
          * A supervisor who cannot see why there is no Log a call button assumes
          * the screen is broken. Saying it is a role rule turns a missing control
          * into an answered question.
          */}
        {!loading && !error ? (
          <div
            style={{
              fontSize: 11,
              lineHeight: 1.5,
              color: canRecord ? "var(--brand-800)" : "var(--text-secondary)",
              background: canRecord ? "var(--brand-50)" : "var(--surface-page)",
              border: `1px solid ${canRecord ? "var(--brand-200)" : "var(--border-base)"}`,
              borderRadius: 7,
              padding: "8px 10px",
            }}
          >
            {canRecord
              ? "You can log calls of your own as well as monitor your team — open a coach and use Log a call, which takes you to the Contact Workspace."
              : studentsBoard
                ? "This board is read-only, and it shows contacts from everyone: faculty record theirs in the Faculty Workspace, coaches theirs in the Contact Workspace. A student with no row here has not been contacted by either."
                : academic
                ? "This board is read-only: periodical contacts are recorded by faculty in the Faculty Workspace, which is where the term is stamped on them."
                : departmentScoped
                  ? "This board is read-only: these coaches are not your staff. They work the SSP and KASAMA cohorts across the college and are assigned their students by their own coordinator — you are seeing the part of that work which lands on your department."
                  : "This board is read-only for your role: you monitor your coaches and assign their students, and they make the calls."}
          </div>
        ) : null}

        <ManagementTableCard
          title={
            studentsBoard
              ? "Students your staff have contacted"
              : academic
                ? "Faculty in your department"
                : departmentScoped
                  ? "Coaches with your students"
                  : "Coaches on your team"
          }
          columns={studentsBoard ? studentColumns : columns}
          rows={studentsBoard ? studentRows : tableRows}
          loading={loading}
          emptyText={
            studentsBoard
              ? "Nobody has logged a contact with a student in your department yet. Rows appear here as faculty record periodical contacts and coaches log their calls."
              : academic
                ? "No faculty accounts in your department yet. They appear here as soon as their accounts exist."
                : departmentScoped
                  ? "No coach holds a student from your department yet. One appears here as soon as a student of yours is assigned to them."
                  : "No coaches are on your team yet. Coaches appear here as soon as their accounts exist."
          }
          maxHeight="calc(100vh - 420px)"
          actions={
            <Button variant="secondary" onClick={() => void load()} disabled={loading}>
              Refresh
            </Button>
          }
          /* Only the students board pages: the roster is a few dozen staff and
             stays that way, while this list grows with every contact made. */
          footer={
            studentsBoard && pagedStudents.total > 0 ? (
              <Pagination
                page={pagedStudents.page}
                pageSize={pagedStudents.pageSize}
                total={pagedStudents.total}
                onPageChange={pagedStudents.setPage}
                onPageSizeChange={pagedStudents.setPageSize}
                pageSizeOptions={[25, 50, 100, 200]}
                itemLabel="students"
                compact
              />
            ) : null
          }
        />
      </div>

      <Modal
        open={Boolean(detail)}
        /* "Assigned" is a caller's word. Faculty are handed no list — these
           are the students they went and spoke to, which is also why the
           roster leaves their denominator null. A dean reading a caller gets
           the department said out loud, because this is a slice of a caseload
           and not the caseload. */
        title={
          detail?.worker
            ? `${detail.worker.name} — ${
                academic
                  ? "students spoken to"
                  : departmentScoped
                    ? "assigned students from your department"
                    : "assigned students"
              }`
            : (academic ? "Students spoken to" : "Assigned students")
        }
        onClose={() => setDetail(null)}
        width={760}
      >
        {detail?.loading ? (
          <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 11.5 }}>
            Loading students...
          </div>
        ) : detail?.error ? (
          <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 6, fontSize: 11.5 }}>
            {detail.error}
          </div>
        ) : (detail?.students?.length ?? 0) === 0 ? (
          <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 11.5 }}>
            {academic
              ? "This faculty member has not logged a periodical contact yet."
              : departmentScoped
                ? "None of your department's students are assigned to this coach."
                : "No students are assigned to this coach."}
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)" }}>
              <span>
                {academic
                  ? `${detail.students.length} spoken to`
                  : `${detail.students.length} assigned · ${detail.worker.students_contacted} reached`}{" · "}
                {detail.worker.total_attempts} attempt{detail.worker.total_attempts === 1 ? "" : "s"}
              </span>
              {canRecord ? (
                <a
                  href="#/?view=student_contacts"
                  style={{ marginLeft: "auto", fontSize: 11, color: "var(--brand-700)" }}
                >
                  Log a call in the Contact Workspace
                </a>
              ) : null}
            </div>

            {/* Sorted with the never-contacted students first by the endpoint.
                They are the reason a supervisor opens a caller's list, and
                putting them last means scrolling past the finished work. */}
            <div style={{ overflowX: "auto", maxHeight: "58vh" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: "var(--surface-page)" }}>
                    {["Student No.", "Name", "Course", "Year", "Attempts", "Latest outcome", "Last called"].map((head, index) => (
                      <th
                        key={head}
                        style={{
                          position: "sticky",
                          top: 0,
                          background: "var(--surface-page)",
                          textAlign: index >= 3 && index !== 5 ? "right" : "left",
                          padding: "6px 8px",
                          borderBottom: "1px solid var(--border-base)",
                          color: "var(--text-muted)",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {detail.students.map((student) => (
                    <tr key={student.student_id}>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                        {student.student_number || "-"}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }}>
                        {student.student_name || "-"}
                        {student.contact ? (
                          <span style={{ display: "block", fontSize: 10.5, color: "var(--text-faint)" }}>{student.contact}</span>
                        ) : null}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", color: "var(--text-secondary)" }}>
                        {student.course_code || "-"}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", textAlign: "right", color: "var(--text-secondary)" }}>
                        {student.year_level ? toRoman(student.year_level) : "-"}
                      </td>
                      <td
                        style={{
                          padding: "6px 8px",
                          borderBottom: "1px solid var(--border-base)",
                          textAlign: "right",
                          fontVariantNumeric: "tabular-nums",
                          color: student.attempts ? "var(--text-primary)" : "#b91c1c",
                          fontWeight: student.attempts ? 400 : 700,
                        }}
                      >
                        {student.attempts}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", color: "var(--text-secondary)" }}>
                        {student.latest_outcome || (student.attempts ? "Not recorded" : "Never called")}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", textAlign: "right", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                        {formatWhen(student.last_contacted_at)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>

      {/*
        * One student's contacts, newest first.
        *
        * The roster's modal answers "what has this person done"; this one
        * answers "what has been done for this student", which is the question a
        * dean asks about a name they recognise. Every attempt is shown rather
        * than the latest, because two calls a week apart and two calls in
        * September are different stories about the same student.
        */}
      <Modal
        open={Boolean(studentDetail)}
        title={
          studentDetail?.student
            ? `${studentDetail.student.student_name} — contacts logged`
            : "Contacts logged"
        }
        onClose={() => setStudentDetail(null)}
        width={720}
      >
        {studentDetail?.loading ? (
          <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 11.5 }}>
            Loading contacts...
          </div>
        ) : studentDetail?.error ? (
          <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 6, fontSize: 11.5 }}>
            {studentDetail.error}
          </div>
        ) : (studentDetail?.attempts?.length ?? 0) === 0 ? (
          <div style={{ padding: 12, textAlign: "center", color: "var(--text-muted)", fontSize: 11.5 }}>
            No contacts are logged for this student.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap", fontSize: 11, color: "var(--text-muted)" }}>
              <span>
                {studentDetail.student.student_number || "-"}
                {studentDetail.student.course_code ? ` · ${studentDetail.student.course_code}` : ""}
                {studentDetail.student.year_level ? ` · ${toRoman(studentDetail.student.year_level)}` : ""}
                {studentDetail.student.contact ? ` · ${studentDetail.student.contact}` : ""}
              </span>
              <span style={{ marginLeft: "auto" }}>
                {studentDetail.attempts.length} contact{studentDetail.attempts.length === 1 ? "" : "s"}
              </span>
            </div>

            <div style={{ overflowX: "auto", maxHeight: "58vh" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: "var(--surface-page)" }}>
                    {["When", "Contacted by", "Method", "Result", "Periodical", "Outcome"].map((head) => (
                      <th
                        key={head}
                        style={{
                          position: "sticky",
                          top: 0,
                          background: "var(--surface-page)",
                          textAlign: "left",
                          padding: "6px 8px",
                          borderBottom: "1px solid var(--border-base)",
                          color: "var(--text-muted)",
                          fontWeight: 600,
                          whiteSpace: "nowrap",
                        }}
                      >
                        {head}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {studentDetail.attempts.map((attempt) => (
                    <tr key={attempt.attempt_id}>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                        {formatWhen(attempt.contacted_at)}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }}>
                        {attempt.staff_name}
                        {attempt.role_name ? (
                          <span style={{ display: "block", fontSize: 10.5, color: "var(--text-faint)" }}>{attempt.role_name}</span>
                        ) : null}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", color: "var(--text-secondary)" }}>
                        {attempt.method || "-"}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", color: "var(--text-secondary)" }}>
                        {attempt.contact_status || "-"}
                      </td>
                      {/* Faculty stamp the periodical on a contact; a caller's
                          has none, and a dash says so rather than guessing. */}
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                        {attempt.period ? periodLabel(attempt.period) : "-"}
                      </td>
                      <td style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)", color: attempt.outcome ? "var(--text-primary)" : "var(--text-faint)" }}>
                        {attempt.outcome || "Not recorded"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>
    </ManagementPage>
  );
}
