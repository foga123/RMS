import React, { useCallback, useEffect, useMemo, useState } from "react";
// Deep imports rather than the two shared barrels. shared/components/ui
// re-exports Breadcrumb and shared/layout/dashboard re-exports DashboardShell;
// both reach react-router-dom, which jest cannot resolve, and the second also
// pulls in sweetalert2 — so going through either leaves this file untestable
// for reasons that have nothing to do with it. Same as FacultyOverview and
// RetentionWorkspace.
import AlertMessage from "../../shared/components/ui/AlertMessage";
import Button from "../../shared/components/ui/Button";
import Pagination from "../../shared/components/ui/Pagination";
import Modal from "../../shared/components/Modal";
import DashboardPanel from "../../shared/layout/dashboard/DashboardPanel";
import OverviewHeader from "../../shared/layout/dashboard/OverviewHeader";
import OverviewStatCards from "../../shared/layout/dashboard/OverviewStatCards";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import usePagedRows from "../../shared/hooks/usePagedRows";
import { useCurrentTermBadge } from "../../shared/lib/currentTerm";
import { useCohortFilters, matchesCohort } from "../../shared/lib/cohortFilters";
import { PDO_FILTER_OPTIONS } from "../../shared/lib/pdoFilter";
import PeriodicalContactForm, { createContactDraft } from "../../shared/components/contact/PeriodicalContactForm";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import { yearLevelLabel } from "../../shared/lib/yearLevel";

/*
 * Three modules read as one, for one periodical.
 *
 * Faculty were opening Grades, then Attendance, then Finance, then the
 * retention board, and holding one student's situation in their head across
 * four screens. The question all four visits were really asking is "which of my
 * students is in trouble this periodical, and why" — so it is asked once here,
 * and the answer can be acted on without leaving.
 *
 * The list is a summary on purpose. A row carries only what decides whether to
 * open it; the P1–P3 breakdown of every signal lives behind the click, because
 * a table showing three periodicals of three modules for two hundred students
 * is a spreadsheet, not a work queue.
 */

const filterStyle = {
  padding: "6px 8px",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  background: "#fff",
  fontSize: 12.5,
};

const cellStyle = { padding: "8px 9px", borderBottom: "1px solid var(--border-base)", fontSize: 12.5 };
const headStyle = { ...cellStyle, background: "var(--surface-page)", fontWeight: 700, textAlign: "left", whiteSpace: "nowrap" };

/** The filter value for "no grades encoded for this student yet". */
const PDO_FILTER_UNASSESSED = "unassessed";

/*
 * The shared PDO filters plus one this board alone can answer.
 *
 * Not a priority and not a slice of one. Until 2026-09-12 the sheet put every
 * ungraded student in Priority 1, so this began life as a way to read that band
 * honestly; now a missing grade decides no priority at all, and these students
 * sit wherever their attendance and balance put them — mostly Priority 4, where
 * nothing is known. What the filter answers is a different question from all
 * the others in this list: not "how at risk is this student" but "is the board
 * even in a position to say".
 *
 * Built here rather than added to PDO_FILTER_OPTIONS, which Grades, Attendance
 * and Finance also render: their endpoints resolve `?pdo=` through
 * pdo_students_matching() and would not know this key, so offering it there
 * would be a dropdown entry that quietly returns everything.
 */
const FACULTY_PDO_OPTIONS = PDO_FILTER_OPTIONS.flatMap((option) =>
  option.value === "1"
    ? [option, { value: PDO_FILTER_UNASSESSED, label: "Not graded yet" }]
    : [option],
);

function displayValue(value) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text || "-";
}

/**
 * The priority band's colour, matching the boards faculty already read.
 *
 * Same four bands, same meanings — a student who is "P1" here and "P1" on the
 * prioritisation screen has to look like the same fact, or the two screens
 * teach different vocabularies for one number.
 */
const PRIORITY_TONE = {
  1: { background: "var(--danger-100)", color: "var(--danger-800)", borderColor: "var(--danger-200)" },
  2: { background: "var(--warning-50)", color: "var(--warning-800)", borderColor: "var(--warning-200)" },
  3: { background: "var(--brand-50)", color: "var(--brand-700)", borderColor: "var(--brand-200)" },
  4: { background: "var(--surface-muted)", color: "var(--text-secondary)", borderColor: "var(--border-base)" },
};

function PriorityBadge({ priority, label }) {
  const tone = PRIORITY_TONE[Number(priority)] || PRIORITY_TONE[4];
  return (
    <span
      title={label}
      style={{
        display: "inline-block",
        border: `1px solid ${tone.borderColor}`,
        background: tone.background,
        color: tone.color,
        borderRadius: 999,
        padding: "3px 8px",
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {`P${priority}`}
    </span>
  );
}

/*
 * The four tones the three signals are painted in.
 *
 * Deliberately the same four as PRIORITY_TONE above, in the same order of
 * severity, because the priority IS these three signals reduced to one number:
 * a red Grades chip and a P1 badge are the same news, and giving them two
 * palettes would make the reader learn the board twice. Green here is the brand
 * ramp rather than a separate green — that is what `success` resolves to in
 * shared/theme/tokens.js, so this stays one vocabulary with the rest of the
 * portal instead of introducing a second.
 */
const SIGNAL_TONE = {
  danger: { background: "var(--danger-100)", color: "var(--danger-800)", borderColor: "var(--danger-200)" },
  warning: { background: "var(--warning-50)", color: "var(--warning-800)", borderColor: "var(--warning-200)" },
  success: { background: "var(--brand-50)", color: "var(--brand-800)", borderColor: "var(--brand-200)" },
  neutral: { background: "var(--surface-muted)", color: "var(--text-secondary)", borderColor: "var(--border-base)" },
};

/*
 * What each signal is worth, read off the classifier's own keys.
 *
 * `grade_colour`, `attendance_status` and `balance_band` rather than the three
 * *_label strings beside them: the labels are display text and the balance ones
 * are administrator-editable (finance bands are data — see lib/finance_bands.php),
 * so colouring by what a label happens to say today would repaint the board the
 * first time somebody renames a band. The keys are the classification.
 *
 * Missing data stays neutral rather than green. A student with no grades and no
 * attendance row is not a student doing well, and painting the gap the same
 * colour as a pass is the one reading this screen exists to prevent.
 */
/*
 * Three signals, one vocabulary, decided by the classifier that decided the
 * priority.
 *
 * `grade_colour`, `attendance_colour` and `balance_colour` are each green /
 * yellow / red, or null when nothing is on record. Reading one key instead
 * of three different shapes is what stops the board disagreeing with itself:
 * this took `attendance_status`, which is "attending" for a student nobody
 * has recorded, and drew a green chip on an empty record; and it read
 * `balance_band` by name, which is administrator-editable.
 *
 * Missing data stays neutral rather than green. A student with no grades and
 * no attendance row is not a student doing well, and painting the gap the
 * same colour as a pass is the one reading this screen exists to prevent.
 */
function signalTone(colour) {
  return { red: "danger", yellow: "warning", green: "success" }[colour] || "neutral";
}

/**
 * One status, on the background its standing earns.
 *
 * Its own component because the same three statuses are read twice — once per
 * student on the board, and once per periodical inside a student — and a green
 * that means "passing" in the table has to mean "passing" in the detail too.
 */
function ToneChip({ tone = "neutral", muted = false, children }) {
  const painted = SIGNAL_TONE[tone] || SIGNAL_TONE.neutral;
  return (
    <span
      style={{
        display: "inline-block",
        border: `1px solid ${painted.borderColor}`,
        background: painted.background,
        color: painted.color,
        borderRadius: 999,
        padding: "2px 8px",
        fontSize: 11.5,
        fontWeight: muted ? 400 : 600,
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

/** A signal as one short phrase, under the name of the module it came from. */
function Signal({ label, value, muted, tone = "neutral" }) {
  return (
    <div style={{ display: "grid", gap: 1, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</span>
      <ToneChip tone={tone} muted={muted}>{value}</ToneChip>
    </div>
  );
}

function StudentDetailBlock({ student }) {
  if (!student) return null;

  const yearSection = [
    student.year_level ? yearLevelLabel(student.year_level) : "",
    student.section ? `Section ${student.section}` : "",
  ].filter(Boolean).join(" / ");

  const details = [
    ["Student No.", student.student_number],
    ["Mobile", student.mobile_number],
    ["Email", student.email_address],
    ["Program", student.course_code || student.course_name],
    ["Year / Section", yearSection],
    ["Department", student.department_name],
  ];

  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 160px), 1fr))", gap: 8, padding: 10, border: "1px solid var(--border-base)", borderRadius: 8, background: "var(--surface-page)" }}>
      {details.map(([label, value]) => (
        <div key={label} style={{ minWidth: 0 }}>
          <div style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>{label}</div>
          <div style={{ fontSize: 12.5, color: "var(--text-primary)", wordBreak: "break-word" }}>{displayValue(value)}</div>
        </div>
      ))}
    </div>
  );
}

function peso(amount) {
  if (amount === null || amount === undefined) return null;
  return `PHP ${Number(amount).toLocaleString("en-PH", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function FacultyWorkspacePage({ module, user, permissions = [] }) {
  const beginRequest = useLatestRequest();
  const termBadge = useCurrentTermBadge();

  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [term, setTerm] = useState(null);
  const [settings, setSettings] = useState({ outcomes: [], reasons: [], channels: [] });
  const [serverPermissions, setServerPermissions] = useState({ can_record_contact: false });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");

  const [search, setSearch] = useState("");
  const [pdoFilter, setPdoFilter] = useState("");
  /*
   * Whether students already dealt with this periodical are still on the list.
   *
   * Server-side now, and the same `?contacted=` the PDO board sends, because
   * the two screens are one body of work and a student taken off one list has
   * to be off the other. It was a client-side "Spoken to this period" toggle,
   * and that was wrong in a way a toggle cannot express: it counted ANY contact
   * as done, so a student who answered "Undecided — for follow up" vanished
   * from the board and was never asked again. The server decides settledness
   * from faculty_outcome_is_settled(), which is the same rule the PDO board
   * uses and deliberately leaves Undecided outstanding.
   *
   * `outstanding` is the default: the board's job is "who do I still need to
   * talk to".
   */
  const [contactedView, setContactedView] = useState("outstanding");

  const {
    yearLevel: yearLevelFilter,
    setYearLevel: setYearLevelFilter,
    section: sectionFilter,
    setSection: setSectionFilter,
    years: cohortYears,
    sections: cohortSections,
    filters: cohortFilters,
  } = useCohortFilters(rows, yearLevelLabel);

  // The open student, their P1-P3 detail, and the contact being written.
  const [openStudent, setOpenStudent] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [draft, setDraft] = useState(() => createContactDraft());
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");

  const canRecord = useMemo(
    () => canModuleAction(permissions, "create") && Boolean(serverPermissions.can_record_contact),
    [permissions, serverPermissions],
  );

  const load = useCallback(async () => {
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("search", search.trim());
      if (pdoFilter) params.set("pdo", pdoFilter);
      params.set("contacted", contactedView);
      const query = params.toString();

      const res = await fetch(getBackendUrl(`faculty_workspace.php${query ? `?${query}` : ""}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load the workspace.");
      if (!isCurrent()) return;

      setRows(Array.isArray(json?.data) ? json.data : []);
      setSummary(json?.summary || null);
      setTerm(json?.term || null);
      setSettings({
        outcomes: json?.settings?.outcomes || [],
        reasons: json?.settings?.reasons || [],
        channels: json?.settings?.channels || [],
      });
      setServerPermissions(json?.permissions || { can_record_contact: false });
    } catch (loadError) {
      if (!isCurrent()) return;
      setRows([]);
      setSummary(null);
      setError(loadError?.message || "Failed to load the workspace.");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, contactedView, pdoFilter, search]);

  useEffect(() => {
    void load();
  }, [load]);

  // Cohort narrowing stays client-side — those lists are built from the rows
  // themselves. The contact state is the server's, so nothing re-applies it.
  const visibleRows = useMemo(
    () => rows.filter((row) => matchesCohort(row, cohortFilters)),
    [rows, cohortFilters],
  );

  const paged = usePagedRows(visibleRows, 15);
  const { setPage } = paged;
  useEffect(() => {
    setPage(1);
  }, [search, pdoFilter, contactedView, cohortFilters, setPage]);

  /*
   * The cards are the filter.
   *
   * They were already the first thing read on this screen and already named the
   * exact slices people go looking for — "the Priority 1 ones", "the ones I have
   * not spoken to yet" — and then the reader had to go and find the same words
   * again in a dropdown. Pressing the number now does what reading it makes you
   * want to do.
   *
   * Pressing the active card clears it rather than doing nothing, so no card is
   * a one-way door. `Students` is the explicit way out of any combination.
   *
   * The counts stay whole-population while the table narrows — see the summary
   * note in backend/api/faculty_workspace.php. That is deliberate: a filter
   * control that only counts what survives the filter cannot offer you anywhere
   * else to go.
   */
  const selectPdo = useCallback((value) => {
    setPdoFilter((current) => (current === value ? "" : value));
  }, []);

  const summaryCards = useMemo(() => ([
    {
      label: "Students",
      value: summary?.students ?? 0,
      active: !pdoFilter && contactedView === "all",
      onClick: () => { setPdoFilter(""); setContactedView("all"); },
      hint: "Show every student in the list, contacted or not",
    },
    {
      label: "Priority 1",
      value: summary?.priority_1 ?? 0,
      // Same tones as PriorityBadge above, so a band is one colour on this
      // screen rather than one colour in the table and another in the header.
      tone: "danger",
      filled: true,
      active: pdoFilter === "1",
      onClick: () => selectPdo("1"),
      hint: "Show only Priority 1 students",
    },
    {
      label: "Priority 2",
      value: summary?.priority_2 ?? 0,
      tone: "warning",
      filled: true,
      active: pdoFilter === "2",
      onClick: () => selectPdo("2"),
      hint: "Show only Priority 2 students",
    },
    /*
     * All four bands, not just the two that need chasing.
     *
     * P3 and P4 were left off while the cards were a readout of "who to worry
     * about", and that reasoning stopped holding when the cards became the
     * filter: every student carries a priority, so a board offering only P1 and
     * P2 could not be asked the other half of the question at all. Reaching P3
     * meant going back to the dropdown the cards were meant to replace, and the
     * four numbers no longer added up to the Students card, which is the first
     * thing anyone checks a set of counts against.
     *
     * P4 is not a concern and is deliberately the quietest card on the row — it
     * earns its place by completing the total, not by asking to be clicked.
     */
    {
      label: "Priority 3",
      value: summary?.priority_3 ?? 0,
      tone: "brand",
      filled: true,
      active: pdoFilter === "3",
      onClick: () => selectPdo("3"),
      hint: "Show only Priority 3 students",
    },
    {
      label: "Priority 4",
      value: summary?.priority_4 ?? 0,
      tone: "default",
      filled: true,
      active: pdoFilter === "4",
      onClick: () => selectPdo("4"),
      hint: "Show only Priority 4 students - no concern flagged",
    },
    /*
     * Deliberately NOT filled, and placed after the four bands rather than
     * among them: it is not a fifth priority, it cuts across them.
     *
     * It used to be a slice of Priority 1, because the sheet put every ungraded
     * student there. Since 2026-09-12 a missing grade no longer decides a
     * priority at all (see pdo_priority_for), so these students are spread
     * across the bands on their attendance and balance instead — mostly P4 when
     * nothing else is known. The count still matters, because it says how much
     * of the board is waiting on encoding rather than on a decision.
     */
    {
      label: "Not graded yet",
      value: summary?.unassessed ?? 0,
      tone: "default",
      active: pdoFilter === PDO_FILTER_UNASSESSED,
      onClick: () => selectPdo(PDO_FILTER_UNASSESSED),
      hint: "Show the students no grades have been encoded for yet",
    },
    /*
     * The same tile the PDO board carries, with the same two numbers and the
     * same toggle: click to see who has been dealt with, click again to get
     * the call list back. `all` is reachable from the Students card rather
     * than as a third click nobody would guess at.
     *
     * It counts SETTLED conversations, not attempts — so it will read lower
     * than "spoken to" did whenever somebody logged an Undecided, and the
     * difference is exactly the set of conversations that are not finished.
     */
    {
      label: "Contacted",
      value: summary?.contacted ?? 0,
      meta: `${Number(summary?.outstanding ?? 0).toLocaleString()} still to speak to`,
      tone: "success",
      active: contactedView === "done",
      onClick: () => setContactedView((current) => (current === "done" ? "outstanding" : "done")),
      hint: "Show the students already dealt with this periodical. An Undecided outcome stays on the list.",
    },
  ]), [summary, pdoFilter, contactedView, selectPdo]);

  /*
   * Shown only when the two numbers genuinely differ, so an unfiltered board
   * does not carry a line explaining that nothing has been left out.
   *
   * It names the contact state as well as the count, which the PDO board does
   * in its table heading. "Showing 412 of 2,777" on its own is the kind of line
   * a reader takes as a page size rather than as a list that has had the worked
   * students taken out of it — and that reading is how somebody concludes the
   * board has lost most of their department.
   */
  const totalStudents = summary?.students ?? 0;
  const stateNote = contactedView === "outstanding"
    ? "still to speak to"
    : contactedView === "done"
      ? "already dealt with"
      : "";
  const showingNote = visibleRows.length !== totalStudents
    ? `Showing ${visibleRows.length} of ${totalStudents}${stateNote ? ` · ${stateNote}` : ""}`
    : "";

  const openDetail = useCallback(async (row) => {
    setOpenStudent(row);
    setDetail(null);
    setModalError("");
    setDraft(createContactDraft());
    setDetailLoading(true);
    try {
      const res = await fetch(getBackendUrl(`faculty_workspace.php?student_id=${row.student_id}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to open this student.");
      setDetail(json);
    } catch (detailError) {
      setModalError(detailError?.message || "Failed to open this student.");
    } finally {
      setDetailLoading(false);
    }
  }, []);

  /*
   * Which outcomes have to explain themselves, which reasons need free text,
   * and which channels are offered are all decided inside
   * PeriodicalContactForm now — from the server's own `needs_reason` and
   * `needs_detail` flags, and with Home Visit withheld because it is an
   * escalation with its own workspace rather than a way of ringing somebody.
   * They lived here until the PDO board grew the same form; keeping them here
   * would have meant two screens deciding separately what a contact must say.
   */

  async function recordContact() {
    setSaving(true);
    setModalError("");
    try {
      const res = await fetch(getBackendUrl("faculty_workspace.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          student_id: openStudent.student_id,
          contact_method: draft.contact_method,
          outcome: draft.outcome,
          reason_id: draft.reason_id || null,
          other_reason_label: draft.other_reason_label,
          note: draft.note,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to record the contact.");

      setDetail((current) => (current ? { ...current, contacts: json.contacts || current.contacts } : current));
      setDraft(createContactDraft());
      setSuccess(json?.message || "Contact recorded.");
      await load();
    } catch (saveError) {
      setModalError(saveError?.message || "Failed to record the contact.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
      <OverviewHeader
        title={module?.label || "Faculty Workspace"}
        user={user}
        term={termBadge}
      />

      <AlertMessage
        tone="info"
        message={
          `Your department's students, with ${term?.label ? `${term.label}'s` : "this periodical's"} grades, `
          + `attendance and balance on one row. Open a student for the P1-P3 breakdown and to record what `
          + `they decided.`
        }
      />
      {/* Stands down while the dialog is open: that shows its own failures. */}
      <AlertMessage message={openStudent ? "" : error} tone="error" />
      <AlertMessage message={success} tone="success" />

      <OverviewStatCards items={summaryCards} minWidth={180} />

      <DashboardPanel style={{ display: "grid", gap: 9 }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search name, student number, section..."
            style={{ ...filterStyle, minWidth: 220 }}
            name="faculty_workspace_search"
          />
          <select
            value={pdoFilter}
            /* The band and the contact state narrow independently, the same
               way they do on the PDO board — picking a priority should not
               silently put worked students back on the list. */
            onChange={(event) => setPdoFilter(event.target.value)}
            style={filterStyle}
            name="faculty_workspace_pdo_filter"
            aria-label="Potential drop out filter"
          >
            {FACULTY_PDO_OPTIONS.map((option) => (
              <option key={option.value || "all"} value={option.value}>{option.label}</option>
            ))}
          </select>
          {/* Year first, then section — the section list is this year's only. */}
          {cohortYears.length > 1 ? (
            <select
              value={yearLevelFilter}
              onChange={(event) => setYearLevelFilter(event.target.value)}
              style={filterStyle}
              name="faculty_workspace_year_filter"
              aria-label="Year level"
            >
              <option value="">All year levels</option>
              {cohortYears.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : null}
          {cohortSections.length > 1 ? (
            <select
              value={sectionFilter}
              onChange={(event) => setSectionFilter(event.target.value)}
              style={filterStyle}
              name="faculty_workspace_section_filter"
              aria-label="Section"
            >
              <option value="">All sections</option>
              {cohortSections.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          ) : null}
          {showingNote ? (
            <span style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {showingNote}
            </span>
          ) : null}
        </div>

        {loading ? (
          <DashboardPanel variant="dashed">Loading your students...</DashboardPanel>
        ) : visibleRows.length === 0 ? (
          <DashboardPanel variant="dashed">
            {contactedView === "done"
              ? "Nobody has been dealt with yet this periodical."
              : contactedView === "outstanding"
                ? "Everyone here has been dealt with this periodical. Nothing left to work through."
                : "No students matched the current filters."}
          </DashboardPanel>
        ) : (
          <>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 860 }}>
                <thead>
                  <tr>
                    <th style={headStyle}>Student</th>
                    <th style={headStyle}>Year / Section</th>
                    <th style={headStyle}>Priority</th>
                    <th style={headStyle}>This periodical</th>
                    <th style={headStyle}>Contacted</th>
                    <th style={headStyle} />
                  </tr>
                </thead>
                <tbody>
                  {paged.rows.map((row) => {
                    const contact = row.periodical_contact;
                    return (
                      <tr key={row.student_id}>
                        <td style={cellStyle}>
                          <div style={{ fontWeight: 600, color: "var(--text-primary)" }}>{row.student_name}</div>
                          {row.mobile_number || row.email_address ? (
                            <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 2 }}>
                              {row.mobile_number ? `Mobile: ${row.mobile_number}` : row.email_address}
                            </div>
                          ) : null}
                          <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                            {row.student_number}{row.course_code ? ` · ${row.course_code}` : ""}
                          </div>
                        </td>
                        <td style={cellStyle}>
                          {row.year_level ? yearLevelLabel(row.year_level) : "-"}
                          {row.section ? <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{row.section}</div> : null}
                        </td>
                        <td style={cellStyle}>
                          <PriorityBadge priority={row.priority} label={row.priority_label} />
                        </td>
                        <td style={cellStyle}>
                          {/* The three modules, as three phrases. This is the
                              whole reason the screen exists. */}
                          <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
                            <Signal
                              label="Grades"
                              value={row.grade_label}
                              muted={!row.grade_colour}
                              tone={signalTone(row.grade_colour)}
                            />
                            <Signal
                              label="Attendance"
                              value={row.attendance_label}
                              muted={!row.attendance_colour}
                              tone={signalTone(row.attendance_colour)}
                            />
                            <Signal
                              label="Balance"
                              value={peso(row.balance_amount) || row.balance_label}
                              muted={!row.balance_colour}
                              tone={signalTone(row.balance_colour)}
                            />
                          </div>
                        </td>
                        <td style={cellStyle}>
                          {/*
                            Coloured by whether the conversation CONCLUDED, the
                            same way the PDO board colours it. On the default
                            list this is what explains why a student somebody
                            rang is still here: they said "Undecided", so they
                            are still owed a call. Without it the board looks as
                            though it ignored the contact.
                          */}
                          {contact ? (
                            <>
                              <div
                                style={{
                                  fontWeight: 600,
                                  fontSize: 11.5,
                                  color: contact.settled ? "var(--text-primary)" : "var(--warning-800)",
                                }}
                              >
                                {contact.outcome_label}
                                {contact.settled ? "" : " · still open"}
                              </div>
                              {contact.reason_label ? (
                                <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{contact.reason_label}</div>
                              ) : null}
                              <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 2 }}>
                                Contacted by {contact.attempted_by_name?.trim() || "Unknown user"}
                                {contact.attempted_by_role_name ? ` · ${contact.attempted_by_role_name}` : ""}
                              </div>
                            </>
                          ) : (
                            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Not yet</span>
                          )}
                        </td>
                        <td style={cellStyle}>
                          <Button variant="secondary" size="sm" onClick={() => void openDetail(row)}>Open</Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {/*
              Named props, not {...paged}.

              The spread looked right and did nothing: usePagedRows returns
              `setPage` / `setPageSize`, while Pagination takes `onPageChange` /
              `onPageSizeChange`. So every handler arrived undefined, and
              Pagination calls them as `onPageChange?.(next)` — optional
              chaining, so the click was swallowed in silence. The control
              rendered correctly, showed the right page count, highlighted the
              right page, and simply would not move off page 1. No error
              anywhere, which is why it survived: the only symptom was a button
              that did nothing.
            */}
            <Pagination
              page={paged.page}
              pageSize={paged.pageSize}
              total={paged.total}
              onPageChange={paged.setPage}
              onPageSizeChange={paged.setPageSize}
              itemLabel="students"
              compact
            />
          </>
        )}
      </DashboardPanel>

      <Modal
        open={Boolean(openStudent)}
        title={openStudent ? `${openStudent.student_name} · ${openStudent.student_number}` : ""}
        onClose={() => { setOpenStudent(null); setDetail(null); }}
        width={880}
        error={modalError}
      >
        {detailLoading ? (
          <DashboardPanel variant="dashed">Loading this student...</DashboardPanel>
        ) : detail ? (
          <div style={{ display: "grid", gap: 12 }}>
            <StudentDetailBlock student={detail.student || openStudent} />

            <div>
              <h4 style={{ margin: "0 0 6px", color: "var(--text-primary)" }}>Across the semester</h4>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 620 }}>
                  <thead>
                    <tr>
                      <th style={headStyle}>Periodical</th>
                      <th style={headStyle}>Grades</th>
                      <th style={headStyle}>Attendance</th>
                      <th style={headStyle}>Balance</th>
                      <th style={headStyle}>Priority</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.periods.map((period) => (
                      <tr key={period.period}>
                        <td style={{ ...cellStyle, fontWeight: 700 }}>{period.period_label}</td>
                        {period.has_records ? (
                          <>
                            <td style={cellStyle}>
                              <ToneChip tone={signalTone(period.grade_colour)}>{period.grade_label}</ToneChip>
                              {period.total_subject ? (
                                <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                                  {period.problem_subjects} of {period.total_subject} subjects a problem
                                </div>
                              ) : null}
                            </td>
                            <td style={cellStyle}>
                              <ToneChip tone={signalTone(period.attendance_colour)}>{period.attendance_label}</ToneChip>
                              {period.total_classes_conducted ? (
                                <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                                  {period.absent} absent of {period.total_classes_conducted}
                                  {period.present_rate !== null ? ` · ${period.present_rate}% present` : ""}
                                </div>
                              ) : null}
                            </td>
                            <td style={cellStyle}>
                              <ToneChip tone={signalTone(period.balance_colour)}>
                                {peso(period.balance_amount) || period.balance_label}
                              </ToneChip>
                            </td>
                            <td style={cellStyle}>
                              <PriorityBadge priority={period.priority} label={period.priority_label} />
                            </td>
                          </>
                        ) : (
                          /*
                           * Said, not left blank. "Nothing recorded for P3" and
                           * "P3 looks fine" are opposite conclusions, and a row
                           * of dashes reads as the second.
                           */
                          <td style={{ ...cellStyle, color: "var(--text-muted)" }} colSpan={4}>
                            Nothing recorded for this periodical yet.
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {canRecord ? (
              <div style={{ borderTop: "1px solid var(--border-base)", paddingTop: 11 }}>
                {/*
                  * The same form the PDO board records through, and the same
                  * write behind it. One student can be worked from either
                  * screen, so a second copy here would be a second set of rules
                  * about what a contact must say.
                  */}
                <PeriodicalContactForm
                  settings={settings}
                  draft={draft}
                  onChange={setDraft}
                  onSubmit={recordContact}
                  saving={saving}
                  heading={`What did they decide? (${detail.term?.label || "this periodical"})`}
                  namePrefix="faculty_contact"
                />
              </div>
            ) : null}

            {detail.contacts?.length ? (
              <div style={{ borderTop: "1px solid var(--border-base)", paddingTop: 11 }}>
                <h4 style={{ margin: "0 0 6px", color: "var(--text-primary)" }}>Earlier conversations</h4>
                <div style={{ display: "grid", gap: 6 }}>
                  {detail.contacts.map((contact) => (
                    <div key={contact.attempt_id} style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                      <strong style={{ color: "var(--text-primary)" }}>{contact.period_label}</strong>
                      {" — "}{contact.outcome_label}
                      {contact.reason_label ? ` · ${contact.reason_label}` : ""}
                      {contact.attempted_by_name?.trim() ? ` · Contacted by ${contact.attempted_by_name.trim()}` : ""}
                      {contact.attempted_by_role_name ? ` (${contact.attempted_by_role_name})` : ""}
                      {contact.notes ? (
                        <div style={{ color: "var(--text-muted)" }}>{contact.notes}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
      </Modal>
    </section>
  );
}
