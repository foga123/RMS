import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateTime } from "../../shared/lib/dateTime";
import { localDateIso } from "../../shared/lib/localDate";
import { AlertMessage } from "../../shared/components/ui";
import { DashboardPanel, OverviewHeader, OverviewStatCards } from "../../shared/layout/dashboard";
import { useCurrentTermBadge } from "../../shared/lib/currentTerm";
import { matchesCohort, useCohortFilters } from "../../shared/lib/cohortFilters";
import { PRIORITY_ACCENT } from "../../shared/lib/priorityAccent";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import Modal from "../../shared/components/Modal";
import usePagedRows from "../../shared/hooks/usePagedRows";
import Pagination from "../../shared/components/ui/Pagination";
import Tabs from "../../shared/components/ui/Tabs";
import ContactLogReport from "./ContactLogReport";
import { getRoleSlug } from "../../shared/lib/roles";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { formatStudentName } from "../../shared/lib/studentName";

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 9px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

function MessageBox({ message, tone = "error" }) {
  if (!message) return null;
  const palette = tone === "success"
    ? { background: "var(--brand-100)", color: "var(--brand-800)", border: "var(--brand-200)" }
    : { background: "var(--danger-100)", color: "var(--danger-800)", border: "var(--danger-200)" };

  return (
    <div
      style={{
        padding: 9,
        borderRadius: 8,
        border: `1px solid ${palette.border}`,
        background: palette.background,
        color: palette.color,
      }}
    >
      {message}
    </div>
  );
}

function normalizeStatusKey(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function enrollmentOutcomeNeedsReason(value) {
  const token = normalizeStatusKey(value);
  return token === "to_stop"
    || token === "not_enrolled"
    || token.includes("stop")
    || token.includes("will_not_continue");
}

/** The enrollment outcome that asks CSDL for a visit; see student_contact_sync_home_visit(). */
function enrollmentOutcomeWantsVisit(value) {
  return normalizeStatusKey(value) === "for_home_visit";
}

/** What saving a call did to the student's home visit, said after the save. */
const HOME_VISIT_CHANGE_MESSAGES = {
  queued: "The student is now queued for a home visit.",
  updated: "Their home visit stays open, with this call as the latest reason.",
  reopened: "Their finished home visit has been reopened and queued again.",
  completed: "Their home visit was closed as RECOVERED.",
};

function statusPill(value) {
  const token = normalizeStatusKey(value);
  const palette = {
    contacted: { background: "var(--brand-100)", color: "var(--brand-800)" },
    no_response: { background: "var(--danger-100)", color: "var(--danger-800)" },
    pending: { background: "var(--brand-100)", color: "var(--brand-700)" },
    follow_up_needed: { background: "var(--warning-100)", color: "var(--warning-800)" },
  }[token] || { background: "var(--border-base)", color: "var(--neutral-700)" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "3px 6px",
        borderRadius: 999,
        background: palette.background,
        color: palette.color,
        fontSize: 10.5,
        fontWeight: 700,
        whiteSpace: "nowrap",
      }}
    >
      {String(value || "Pending")}
    </span>
  );
}

/*
 * How urgent this student is, from the RETENTION & MIGRATION segment matrix.
 *
 * This replaced a High/Moderate/Low "risk" badge. The queue is now ranked by the
 * sheet's Priority 1-4, computed server-side by the same code the PDO
 * Prioritization screen uses — so a caller and a coordinator looking at the same
 * student read the same number. Two scales for "how bad is this" on one screen
 * is how somebody ends up working the wrong list.
 *
 * The palette runs from alarm to all-clear rather than through four unrelated
 * hues, so the ordering is legible without reading the labels.
 */
/*
 * A friendly warm -> cool ramp rather than an alarm palette. The warmest colour
 * still means "most urgent", so the ordering reads at a glance, but Priority 1 is
 * a soft coral instead of a danger red — this is a queue to work through, not a
 * fire to put out.
 */
const PRIORITY_TONES = {
  1: { background: "#ffe4e6", color: "#9f1239", borderColor: "#fecdd3" }, // coral
  2: { background: "#fef3c7", color: "#92400e", borderColor: "#fde68a" }, // amber
  3: { background: "#e0f2fe", color: "#075985", borderColor: "#bae6fd" }, // sky
  4: { background: "#dcfce7", color: "#166534", borderColor: "#bbf7d0" }, // green
};

const UNRANKED_TONE = { background: "#f1f5f9", color: "#64748b", borderColor: "#cbd5e1" };

function priorityPill(level, owner) {
  const tone = PRIORITY_TONES[level] || UNRANKED_TONE;
  return {
    // "Not ranked" rather than a default priority: a student the classifier has
    // not placed is a gap to notice, not a Priority 4 to relax about.
    // "Priority 1", not "P1" — "P1" reads as Periodical 1 on the grades side,
    // and one screen should not use the same shorthand for two different things.
    label: PRIORITY_TONES[level] ? `Priority ${level}${owner ? ` · ${owner}` : ""}` : "Not ranked",
    style: {
      display: "inline-block",
      padding: "1px 7px",
      borderRadius: 999,
      border: `1px solid ${tone.borderColor}`,
      background: tone.background,
      color: tone.color,
      fontWeight: 600,
      fontSize: 10.5,
    },
  };
}

/*
 * Row shading by priority: the same alarm -> all-clear ramp as the pill, as a
 * faint wash behind the whole row so the queue reads as a heat map at a glance.
 * A contacted student drops to grey — handled, colour spent — so the coloured
 * rows still on screen are exactly who is left to work.
 */
const PRIORITY_ROW_TINT = {
  1: "rgba(251, 113, 133, 0.10)", // coral
  2: "rgba(251, 191, 36, 0.12)",  // amber
  3: "rgba(56, 189, 248, 0.10)",  // sky
  4: "rgba(52, 211, 153, 0.10)",  // green
};
const PRIORITY_ROW_ACCENT = PRIORITY_ACCENT;

/*
 * Once a caller starts working a student the row colour stops being about
 * priority and becomes about the outcome, so the queue shows how the calling is
 * going, not just who to call. The journey:
 *
 *   not called yet  -> priority colour (which to call first)
 *   reached         -> green  (a good contact was made)
 *   no answer       -> coral  (tried, missed - keep trying)
 *   3+ no answers   -> orange, tagged "Refer to CSDL" for a final attempt
 *   home visit      -> violet, tagged "Home visit" - the last option
 *
 * Friendly tones throughout: this is a queue to work through, not a fire.
 */
const CSDL_ATTEMPT_THRESHOLD = 3;
const CONTACT_STATE_STYLES = {
  contacted: { tint: "rgba(52, 211, 153, 0.13)", accent: "#34d399", tag: "Contacted", tagColor: "#166534" },
  no_answer: { tint: "rgba(251, 113, 133, 0.12)", accent: "#fb7185", tag: "No answer", tagColor: "#9f1239" },
  refer_csdl: { tint: "rgba(251, 146, 60, 0.14)", accent: "#fb923c", tag: "Refer to CSDL", tagColor: "#9a3412" },
  home_visit: { tint: "rgba(167, 139, 250, 0.15)", accent: "#a78bfa", tag: "Home visit", tagColor: "#6d28d9" },
};

/** Where the student sits in the contact journey, or null when not yet called. */
function rowContactState(row) {
  const attempts = Number(row?.contact_attempt_count) || 0;
  const reached = normalizeStatusKey(row?.current_status) === "contacted";
  // A recorded "Refer to CSDL" outcome wins over the home-visit colour it shares
  // a status with — the referral is a distinct step, so it reads as its own
  // orange rather than disappearing into the violet home-visit rows. Tagged in
  // the past tense: the student is CSDL's now and the card only reads, where
  // the same orange below is still a suggestion to act on.
  if (row?.referred_to_csdl) return { key: "refer_csdl", ...CONTACT_STATE_STYLES.refer_csdl, tag: "Referred to CSDL" };
  if (row?.needs_home_visit) return { key: "home_visit", ...CONTACT_STATE_STYLES.home_visit };
  if (reached) return { key: "contacted", ...CONTACT_STATE_STYLES.contacted };
  // Fallback cue before any outcome is recorded: a student dialled this many
  // times with nothing settled is heading for a referral.
  if (attempts >= CSDL_ATTEMPT_THRESHOLD) return { key: "refer_csdl", ...CONTACT_STATE_STYLES.refer_csdl };
  if (attempts >= 1) return { key: "no_answer", ...CONTACT_STATE_STYLES.no_answer };
  return null;
}

/*
 * The three signals, as filled chips coloured by their own state, so the reason
 * a student is Priority 1 reads at a glance rather than as prose. Fallbacks are
 * baked in so the colours hold whether or not the success/danger tokens exist.
 */
const SIGNAL_TONES = {
  danger: { bg: "#ffe4e6", fg: "#9f1239", bd: "#fecdd3" }, // coral - flags a bad signal without alarming
  warning: { bg: "#fef3c7", fg: "#92400e", bd: "#fde68a" }, // amber
  success: { bg: "#dcfce7", fg: "#166534", bd: "#bbf7d0" }, // green
  neutral: { bg: "var(--surface-page)", fg: "var(--text-secondary)", bd: "var(--border-base)" },
};

/*
 * One mapping for all three signals, on the one vocabulary they now share.
 *
 * grade_colour, attendance_colour and balance_colour are the same four
 * values -- green, yellow, red, or null for "nothing on record" -- each
 * decided server-side by the classifier that also decided the priority. So
 * the browser has no judgement left to make, which is the point: all three
 * of these were once separate functions and all three drifted.
 *
 * attendanceSignalTone read `attendance_status`, which is a POLICY answer
 * and is "attending" for a student nobody has recorded -- painting a green
 * chip on an empty record. balanceSignalTone named band keys directly, so
 * re-cutting the editable finance ladder left the new top band amber.
 */
function signalTone(colour) {
  return { red: "danger", yellow: "warning", green: "success" }[colour] || "neutral";
}

/** One highlighted signal box, coloured by the state it reports. */
function SignalChip({ label, value, tone }) {
  const t = SIGNAL_TONES[tone] || SIGNAL_TONES.neutral;
  return (
    <div style={{ flex: "1 1 116px", minWidth: 0, background: t.bg, border: `1px solid ${t.bd}`, borderRadius: 8, padding: "7px 9px" }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: t.fg, opacity: 0.85 }}>{label}</div>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: t.fg, wordBreak: "break-word" }}>{value || "—"}</div>
    </div>
  );
}

/*
 * When the contact happened: the clock, until the caller says otherwise.
 *
 * The draft used to open on the student's LAST contact - latest_contacted_at,
 * or failing that the enrollment record's date at midnight - and nothing moved
 * it. A caller who did not retype both boxes filed today's call under that old
 * moment: the six attempts saved from this screen on 2026-09-24 are all stamped
 * 00:00 on a date weeks earlier, three calls to one student inside three
 * minutes among them.
 *
 * So a draft now opens live. The boxes show the clock and follow it while the
 * card is open, and a live draft is stamped with the moment Save is pressed -
 * not the minute the card was opened, and not the last tick the boxes showed.
 *
 * Changing either box pins the time, so a call made this morning and logged
 * this afternoon is recorded when it happened and the clock stops overwriting
 * it. "Use current time" hands it back to the clock.
 */
const pad2 = (value) => String(value).padStart(2, "0");

/** A moment as the date and time inputs hold it: "YYYY-MM-DD" and "HH:MM". */
function clockParts(date = new Date()) {
  return {
    date: localDateIso(date),
    time: `${pad2(date.getHours())}:${pad2(date.getMinutes())}`,
  };
}

/** The current minute as one comparable string, "YYYY-MM-DD HH:MM". */
function clockMinute() {
  const { date, time } = clockParts();
  return `${date} ${time}`;
}

/**
 * The clock to the minute, kept current while `running`.
 *
 * Read every second so the boxes turn over within a second of the wall clock,
 * but held as one string: a tick inside the same minute sets the same value
 * and React skips the render, so the fields redraw once a minute, not sixty
 * times.
 */
function useClockMinute(running) {
  const [stamp, setStamp] = useState(clockMinute);

  useEffect(() => {
    if (!running) return undefined;
    // Straight away rather than on the first tick: a time handed back to the
    // clock would otherwise show the minute the clock stopped at for a second.
    setStamp(clockMinute());
    const intervalId = window.setInterval(() => setStamp(clockMinute()), 1000);
    return () => window.clearInterval(intervalId);
  }, [running]);

  const [date, time] = stamp.split(" ");
  return { date, time };
}

/**
 * The date and time a save records.
 *
 * A live draft is stamped to the second, the way the Faculty Workspace and a
 * home-visit outcome stamp theirs: the boxes show minutes, but the moment of
 * saving is known exactly. A pinned time is sent as the caller typed it.
 */
function contactedAt(draft, now = new Date()) {
  if (!draft.time_is_live) {
    return { date: draft.date_contacted, time: draft.time_contacted };
  }
  const { date, time } = clockParts(now);
  return { date, time: `${time}:${pad2(now.getSeconds())}` };
}

/**
 * The channels the sheet offers, and the one a fresh draft opens on.
 *
 * Call/Text is the default because it is the first channel on the sheet and the
 * one most attempts use. The four retired keys - message, call, online_meeting,
 * other - are not offered any more, so a draft seeded from a row that still
 * holds one falls back to the default rather than opening on a value the select
 * cannot show and the backend would refuse.
 */
const DEFAULT_CHANNEL = "call_text";

function seedChannel(row, channels) {
  const stored = row?.latest_contact_method_key || "";
  const offered = (channels || []).some((channel) => channel.key === stored);
  return offered ? stored : DEFAULT_CHANNEL;
}

function buildDraftFromRow(row, channels) {
  return {
    contact_method: seedChannel(row, channels),
    other_method_label: "",
    // Live: the boxes follow the clock and these two stay unused until the
    // caller pins a time. See clockParts() for why.
    time_is_live: true,
    date_contacted: "",
    time_contacted: "",
    /*
     * Blank, not the student's current standing.
     *
     * The outcome is what the caller heard on THIS call. Pre-filling it with the
     * existing standing would let an unanswered call be saved as a fresh
     * confirmation of something nobody said. It is required (since 2026-10-07),
     * so blank keeps Save off until the caller picks what they actually heard.
     */
    enrollment_status: "",
    /*
     * The reason and the intervention outcome, both blank on a fresh draft.
     *
     * Blank is a real answer for each of them: most attempts reach nobody, and a
     * call that went unanswered has no reason and no intervention outcome yet.
     * Pre-filling either would put words in the student's mouth.
     */
    reason_id: "",
    intervention_status: "",
    notes: row?.latest_contact_notes || "",
  };
}

/** Columns before the expandable row, so the two colSpans cannot drift apart. */
const COLUMN_COUNT = 6;

const DASH = "\u2014";

function detailValue(value) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text === "" ? DASH : text;
}

/**
 * One labelled, read-only field.
 *
 * Rendered as text rather than as a disabled input on purpose. A greyed-out
 * input still looks like something you could edit if only you had permission,
 * and invites the reader to try; plain text reads as a record, which is what
 * this is.
 */
function DetailField({ label, value, wide = false }) {
  return (
    <div style={{ minWidth: 0, gridColumn: wide ? "1 / -1" : "auto" }}>
      <div style={{ fontSize: 10.5, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 12.5, color: "var(--text-primary)", wordBreak: "break-word" }}>
        {detailValue(value)}
      </div>
    </div>
  );
}

function DetailGroup({ title, children }) {
  return (
    <div style={{ display: "grid", gap: 7 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--brand-800)" }}>{title}</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 128px), 1fr))", gap: 8 }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Everything the student record holds, for the caller to read while they dial.
 *
 * Read-only, and deliberately so: a caller's job is to record what happened on
 * the call, not to correct the registrar's record from what they heard on it.
 * Student Management is where these are edited, by the people who own them.
 *
 * Grouped rather than listed, because which of twenty-seven fields matters
 * depends entirely on what the student says once they answer — the caller is
 * scanning for one of them, not reading all of them.
 */
function StudentDetails({ row }) {
  const details = row?.student_details;

  const fullName = details
    ? [details.last_name, [details.first_name, details.middle_name, details.extension_name].filter(Boolean).join(" ")]
        .filter(Boolean)
        .join(", ")
    : formatStudentName(row);

  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        padding: 12,
        borderRadius: 9,
        border: "1px solid var(--border-base)",
        background: "var(--surface-base)",
        alignContent: "start",
      }}
    >
      {/* Name and number lead the card; the raw student_id fallback is gone -
          an internal key is not something a caller identifies a student by. */}
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ color: "var(--text-primary)", fontSize: 14 }}>{fullName}</strong>
          {details?.student_number || row?.student_number ? (
            <span style={{ color: "var(--text-muted)", fontSize: 11.5, marginLeft: 8 }}>
              {details?.student_number || row?.student_number}
            </span>
          ) : null}
        </div>
        <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
          Read-only &middot; edited in Student Management
        </span>
      </div>

      {/*
        Why they are on the list, first. A caller opening this to dial reads the
        reason before anything else — the plain-language verdict, then the three
        signals it was computed from. Everything below is context for the call,
        so it comes after.
      */}
      <DetailGroup title="Why this priority">
        <DetailField
          label="Priority"
          value={row?.priority ? (row?.priority_label || `Priority ${row.priority}`) : "Not ranked"}
          wide
        />
        <DetailField label="Reason" value={row?.priority_reason} wide />
        {/* The three signals, highlighted in their own colour — a caller opening
            this to call sees the grade / attendance / finance state at a glance
            rather than reading it as prose. */}
        <div style={{ gridColumn: "1 / -1", display: "flex", flexWrap: "wrap", gap: 8, marginTop: 2 }}>
          <SignalChip
            label="Grades"
            tone={signalTone(row?.grade_colour)}
            value={row?.grade_label ? `${row.grade_label}${row.total_subject ? ` · ${row.problem_subjects}/${row.total_subject}` : ""}` : null}
          />
          <SignalChip
            label="Attendance"
            tone={signalTone(row?.attendance_colour)}
            value={row?.attendance_label ? `${row.attendance_label}${row.present_rate === null || row.present_rate === undefined ? "" : ` · ${row.present_rate}%`}` : null}
          />
          <SignalChip
            label="Balance"
            tone={signalTone(row?.balance_colour)}
            value={row?.balance_amount === null || row?.balance_amount === undefined
              ? row?.balance_label
              : `${row.balance_label} · ${Number(row.balance_amount).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`}
          />
        </div>
        <DetailField label="Standing" value={row?.enrollment_status_name} />
      </DetailGroup>

      {/* Contact numbers together — the student's own plus the parents', since a
          caller reaching for one reaches for all of them. */}
      <DetailGroup title="How to reach them">
        <DetailField label="Mobile" value={details?.mobile_number || row?.mobile_number} />
        <DetailField label="Email" value={details?.email_address || row?.email_address} />
        <DetailField label="Facebook" value={details?.facebook_name} />
        <DetailField label="Mother's No." value={details?.mother_number} />
        <DetailField label="Father's No." value={details?.father_number} />
        <DetailField label="Home Address" value={details?.home_address || row?.home_address} wide />
      </DetailGroup>

      {/* The few academic facts a call actually turns on. Campus, school year,
          modality, batch and coaching unit were dropped from this card: they are
          rarely what a retention call is about and were most of the clutter. */}
      <DetailGroup title="Student">
        <DetailField label="Course" value={details?.course_name || row?.course_name} wide />
        <DetailField label="Department" value={details?.department_name || row?.department_name} />
        <DetailField label="Year Level" value={details?.year_level ? yearLevelLabel(details.year_level) : row?.year_level ? yearLevelLabel(row.year_level) : null} />
        <DetailField label="Section" value={details?.section || row?.section} />
        <DetailField label="STAR E-Profile" value={details?.student_type || row?.student_type} />
        <DetailField label="Scholarship" value={details?.final_scholarship_grant} />
      </DetailGroup>
    </div>
  );
}


/**
 * The date and time boxes, live until the caller changes one of them.
 *
 * Its own component so the once-a-minute redraw is these two boxes, not the
 * whole card with the student record and the attempt history in it.
 */
function ContactTimeFields({ draft, studentId, onChange }) {
  const live = draft.time_is_live;
  const clock = useClockMinute(live);
  const shown = live ? clock : { date: draft.date_contacted, time: draft.time_contacted };

  // Changing one box pins BOTH where they stand, so a caller who only moves
  // the time back keeps today's date rather than an empty one.
  const pin = (patch) => onChange({
    time_is_live: false,
    date_contacted: shown.date,
    time_contacted: shown.time,
    ...patch,
  });

  return (
    <>
      <input
        type="date"
        value={shown.date}
        onChange={(event) => pin({ date_contacted: event.target.value })}
        style={{ padding: "6px 8px", border: "1px solid var(--brand-200)", borderRadius: 6 }}
        name={`student_contact_date_${studentId}`}
        aria-label="Date contacted"
      />
      <input
        type="time"
        value={shown.time}
        onChange={(event) => pin({ time_contacted: event.target.value })}
        style={{ padding: "6px 8px", border: "1px solid var(--brand-200)", borderRadius: 6 }}
        name={`student_contact_time_${studentId}`}
        aria-label="Time contacted"
      />
      <div style={{ gridColumn: "1 / -1", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, fontSize: 10.5, color: "var(--text-muted)" }}>
        {live ? (
          <>
            <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 999, background: "#34d399" }} />
            Live &mdash; the time you press Save is recorded. Change it to log an earlier call.
          </>
        ) : (
          <>
            Set by hand &mdash; recorded as shown.
            <button
              type="button"
              onClick={() => onChange({ time_is_live: true })}
              style={{ border: "none", background: "none", padding: 0, cursor: "pointer", fontSize: 10.5, fontWeight: 600, color: "var(--brand-700)", textDecoration: "underline" }}
            >
              Use current time
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * What a referred student's card shows in place of the contact form.
 *
 * REFERRED TO CSDL hands the student over: CSDL works them from the Home Visit
 * Workspace, and the server refuses any further attempt from this one - see
 * student_contact_record_attempt(). The card still opens, because the record
 * is worth reading: who referred them, when, and what the calls before found.
 *
 * The same tones the Home Visit Workspace gives a referral, so the two screens
 * show one handover in one colour.
 */
function ReferralNotice({ row }) {
  const by = row.referred_by_name
    ? `${row.referred_by_name}${row.referred_by_role_name ? ` · ${row.referred_by_role_name}` : ""}`
    : "";

  return (
    <div
      role="note"
      style={{ display: "grid", gap: 4, padding: 11, borderRadius: 9, border: "1px solid #fed7aa", background: "#ffedd5", color: "#9a3412", fontSize: 11.5 }}
    >
      <strong style={{ fontSize: 12.5 }}>Referred to CSDL</strong>
      {row.referred_at || by ? (
        <span>{[row.referred_at ? formatDateTime(row.referred_at) : "", by ? `by ${by}` : ""].filter(Boolean).join(" ")}</span>
      ) : null}
      <span>
        CSDL handles this student now, in the Home Visit Workspace, so no more
        contact updates can be logged here. Past updates are listed below.
      </span>
    </div>
  );
}

/*
 * Where the student's home visit stands in CSDL's workspace. The call logged
 * here moves it (student_contact_sync_home_visit()): an escalating outcome or
 * For Home Visit queues it, RECOVERED completes it.
 */
const HOME_VISIT_NOTICE_TONES = {
  queued: { border: "var(--warning-200)", background: "var(--warning-100)", color: "var(--warning-800)" },
  scheduled: { border: "var(--brand-200)", background: "var(--brand-50)", color: "var(--brand-800)" },
  completed: { border: "var(--brand-200)", background: "var(--brand-100)", color: "var(--brand-800)" },
};

function HomeVisitNotice({ row }) {
  const state = normalizeStatusKey(row.home_visit_queue_status);
  const palette = HOME_VISIT_NOTICE_TONES[state] || HOME_VISIT_NOTICE_TONES.queued;
  const text = state === "completed"
    ? "Home visit: completed. A call that needs another visit will reopen it."
    : state === "scheduled"
      ? `Home visit: scheduled${row.home_visit_scheduled_at ? ` for ${formatDateTime(row.home_visit_scheduled_at)}` : ""}. A RECOVERED call closes it.`
      : "Home visit: queued, waiting for CSDL to schedule it. A RECOVERED call closes it.";

  return (
    <div style={{ padding: 11, borderRadius: 9, border: `1px solid ${palette.border}`, background: palette.background, color: palette.color, fontSize: 11.5 }}>
      {text}
    </div>
  );
}

/**
 * Everything a caller needs for one student, in a floating card.
 *
 * This used to expand inline underneath the row. Two problems with that: the
 * card is a two-column layout and a table row is the narrowest place in the
 * page to put one, and opening it pushed every row below it down, so the list
 * a caller was working reflowed under the pointer that clicked.
 *
 * As a dialog it gets the width the two columns actually need, the table
 * behind it stays still, and Escape or a backdrop click closes it - none of
 * which an accordion row offers.
 */
function ContactCard({
  row, draft, caseKey, settings, reasonTextById, canManageContacts,
  savingCaseId, setDrafts, onSave, onClose,
}) {
  const stopOutcomeNeedsReason = enrollmentOutcomeNeedsReason(draft.enrollment_status);
  // RECOVERED ends the need for a visit and For Home Visit asks for one; the
  // server refuses the pair, so the form says so before the caller presses Save.
  const outcomesContradict = enrollmentOutcomeWantsVisit(draft.enrollment_status)
    && draft.intervention_status === "recovered";
  const saveDisabled = !canManageContacts
    || savingCaseId === row.student_id
    || !draft.enrollment_status
    || !draft.intervention_status
    || (stopOutcomeNeedsReason && !draft.reason_id)
    || outcomesContradict;

  /*
   * Two columns: the record on the left to read while dialling, the form on the
   * right to fill while talking. Stacked, logging a call meant scrolling away
   * from the details of the person you were on the phone to.
   *
   * Collapses to one column under roughly 900px, where two columns of form
   * fields would each be too narrow to read their own labels — which is also
   * what happens on a phone, where the dialog is full width.
   */
  return (
    <div
      style={{
        display: "grid",
        gap: 12,
        gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 420px), 1fr))",
        alignItems: "start",
      }}
    >
      <StudentDetails row={row} />

    <div style={{ display: "grid", gap: 11, alignContent: "start" }}>
      {row.referred_to_csdl ? (
        <ReferralNotice row={row} />
      ) : row.home_visit_queue_status ? (
        <HomeVisitNotice row={row} />
      ) : row.needs_home_visit ? (
        <div style={{ padding: 11, borderRadius: 9, border: "1px solid var(--warning-200)", background: "var(--warning-100)", color: "var(--warning-800)", fontSize: 11.5 }}>
          Escalated for a home visit &mdash; status is {row.current_status}.
        </div>
      ) : null}

      {/* Nothing to fill in once the student is CSDL's: see ReferralNotice. */}
      {row.referred_to_csdl ? null : (
      <div style={{ display: "grid", gap: 9, padding: 11, borderRadius: 9, border: "1px solid var(--brand-100)", background: "var(--brand-50)" }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 153px), 1fr))", gap: 8 }}>
          <select
            value={draft.contact_method}
            onChange={(event) => setDrafts((current) => ({
              ...current,
              [caseKey]: { ...draft, contact_method: event.target.value },
            }))}
            style={{ padding: "6px 8px", border: "1px solid var(--brand-200)", borderRadius: 6, background: "#fff" }}
            name={`student_contact_method_${row.student_id}`}
            aria-label="Channel used"
          >
            {/* The sheet's CHANNEL USED list. The four
                words that used to be hard-coded here
                -- Message, Call, Online Meeting, Other
                -- were this module's own invention and
                did not match what callers actually
                record. */}
            {(settings.channels || []).map((channel) => (
              <option key={channel.key} value={channel.key}>
                {channel.label}
              </option>
            ))}
          </select>
          <ContactTimeFields
            draft={draft}
            studentId={row.student_id}
            onChange={(patch) => setDrafts((current) => ({
              ...current,
              [caseKey]: { ...draft, ...patch },
            }))}
          />
          {/* The contact-status dropdown that used to sit
              here is gone. It asked the same question as
              Intervention Status below and could disagree
              with it -- an attempt could read "No Response"
              with an outcome of RECOVERED -- and the case
              followed the dropdown, so the outcome the
              caller actually recorded changed nothing. The
              status is now derived from the outcome; see
              student_contact_status_for_intervention(). */}
        </div>

        {/*
          * What the caller confirmed about enrolling —
          * separate from how the call went above.
          *
          * Options come from the server, which reads the
          * `status` table, so this list is whatever the
          * institution actually defines. Required since
          * 2026-10-07: every call states an outcome, and
          * the list has the ones an unanswered call gives
          * (For Follow-up, For Home Visit, Undecided).
          */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 187px), 1fr))", gap: 6 }}>
          <select
            value={draft.enrollment_status}
            onChange={(event) => setDrafts((current) => ({
              ...current,
              [caseKey]: { ...draft, enrollment_status: event.target.value },
            }))}
            required
            aria-required="true"
            aria-label="Enrollment outcome"
            style={{
              padding: "6px 8px",
              border: `1px solid ${draft.enrollment_status ? "var(--brand-200)" : "var(--warning-200)"}`,
              borderRadius: 6,
              background: "#fff",
            }}
            name={`student_enrollment_status_${row.student_id}`}
          >
            <option value="">Enrollment outcome (required)</option>
            {(settings.enrollment_statuses || []).map((option) => (
              <option key={option.status_id} value={option.status_name}>
                {option.status_name}
              </option>
            ))}
          </select>
          {/*
            * Reason, from the sheet's grouped list. Always shown since
            * 2026-10-07, whatever the outcome; required only with a stop
            * outcome. Setting it fills the enrollment record's reason as well
            * as the attempt's reason id.
            */}
          <select
            value={draft.reason_id}
            onChange={(event) => {
              const reasonId = event.target.value;
              setDrafts((current) => ({
                ...current,
                [caseKey]: {
                  ...draft,
                  reason_id: reasonId,
                  enrollment_reason: reasonTextById[reasonId] || "",
                },
              }));
            }}
            style={{
              padding: "6px 8px",
              border: `1px solid ${stopOutcomeNeedsReason && !draft.reason_id ? "var(--warning-200)" : "var(--brand-200)"}`,
              borderRadius: 6,
              background: "#fff",
            }}
            name={`student_contact_reason_${row.student_id}`}
            aria-label="Reason"
            aria-required={stopOutcomeNeedsReason ? "true" : undefined}
          >
            <option value="">{stopOutcomeNeedsReason ? "Reason (required)" : "Reason (optional)"}</option>
            {(settings.reason_groups || []).map((group) => (
              <optgroup key={group.category} label={group.category}>
                {group.reasons.map((reason) => (
                  <option key={reason.reason_id} value={String(reason.reason_id)}>
                    {reason.reason_text}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/*
          * Intervention Status: where the call leaves the case.
          *
          * The "Plan if not recovered" dropdown that sat beside it was removed
          * on 2026-10-07 at Francis's request. Plans already saved on older
          * attempts still show in the Home Visit Workspace and the contact log.
          *
          * The "Specify contact method" box that used
          * to sit here is gone with the Other channel
          * it belonged to -- the sheet names all seven
          * channels, so there is nothing left to
          * specify.
          */}
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", gap: 6 }}>
          <select
            value={draft.intervention_status}
            onChange={(event) => setDrafts((current) => ({
              ...current,
              [caseKey]: { ...draft, intervention_status: event.target.value },
            }))}
            style={{ padding: "6px 8px", border: "1px solid var(--brand-200)", borderRadius: 6, background: "#fff" }}
            name={`student_contact_intervention_${row.student_id}`}
            aria-label="Intervention status"
            required
          >
            <option value="">Intervention status - decides the case (required)</option>
            {(settings.intervention_statuses || []).map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        {outcomesContradict ? (
          <div style={{ fontSize: 11, color: "var(--danger-800)" }}>
            RECOVERED and For Home Visit contradict each other. Change one of them to save.
          </div>
        ) : null}
        {/* The one outcome this screen cannot take back, so it says so first. */}
        {draft.intervention_status === "referred_to_csdl" ? (
          <div style={{ fontSize: 11, color: "#9a3412" }}>
            Saving hands this student to CSDL. Their card becomes read-only and no
            more contact updates can be logged for them here.
          </div>
        ) : null}

        <textarea
          value={draft.notes}
          onChange={(event) => setDrafts((current) => ({
            ...current,
            [caseKey]: { ...draft, notes: event.target.value },
          }))}
          placeholder="Notes or remarks"
          style={{ minHeight: 82, padding: "8px 9px", border: "1px solid var(--brand-200)", borderRadius: 8, resize: "vertical" }}
          name={`student_contact_notes_${row.student_id}`}
        />

        <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          <button
            type="button"
            onClick={() => void onSave(row)}
            disabled={saveDisabled}
            style={{
              ...buttonStyle,
              background: "var(--brand-700)",
              color: "#fff",
              opacity: saveDisabled ? 0.65 : 1,
            }}
          >
            {savingCaseId === row.student_id ? "Saving..." : "Save Contact Update"}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{ ...buttonStyle, background: "var(--border-base)", color: "var(--text-primary)" }}
          >
            Cancel
          </button>
        </div>
      </div>
      )}

      <div style={{ display: "grid", gap: 6 }}>
        <strong style={{ color: "var(--text-primary)" }}>
          Previous Contact Updates
          {row.contact_attempt_count ? (
            <span style={{ marginLeft: 6, fontWeight: 400, color: "var(--text-muted)", fontSize: 11 }}>
              {row.contact_attempt_count} total
            </span>
          ) : null}
        </strong>
        {row.attempts?.length ? (
          row.attempts.map((attempt) => (
            <div key={attempt.attempt_id} style={{ padding: "8px 9px", borderRadius: 8, border: "1px solid var(--border-base)", background: "#fff" }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                <span style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                  {attempt.contact_method || "Not Recorded"} | {attempt.contact_status || "Pending"}
                  {/* The outcome by name, so the referral - and CSDL's answer
                      to it - can be found in the list. */}
                  {attempt.intervention_status ? ` · ${attempt.intervention_status}` : ""}
                </span>
                <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{formatDateTime(attempt.contacted_at || attempt.updated_at)}</span>
              </div>
              <div style={{ color: "var(--text-secondary)", fontSize: 11.5, marginTop: 5 }}>
                {attempt.notes || "No remarks recorded."}
              </div>
              <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 5 }}>
                {`Contacted by ${attempt.attempted_by_name || "Unknown user"}`}
                {attempt.attempted_by_role_name ? ` · ${attempt.attempted_by_role_name}` : ""}
              </div>
            </div>
          ))
        ) : (
          <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
            No contact updates recorded yet.
          </DashboardPanel>
        )}
      </div>
    </div>
    </div>
  );
}

export default function StudentContactWorkspace({ module, user, permissions = [] }) {
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  /*
   * A background refresh is not a load, and conflating the two was the bug.
   *
   * Every thirty seconds - and on every window focus - loadQueue() set
   * `loading`, and the table body renders "Loading contact workspace..." in
   * place of every row while that is true. So the list a caller was working in
   * blanked twice a minute, taking the open row, the keyboard focus and the
   * scroll position with it.
   *
   * A background refresh now says NOTHING. It used to drive a Refresh button's
   * label, which meant the button announced "Refreshing..." twice a minute on
   * its own - a control flickering at somebody who never pressed it, reporting
   * work they did not ask for and cannot do anything about. The button is gone
   * with it: the queue already reloads on focus, on tab return and every thirty
   * seconds, so pressing it could only ever repeat what had just happened.
   */
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  /*
   * Which cohort to work. Faculty asked for these: a department queue is a few
   * hundred students, and the way somebody actually works it is one section or
   * one year at a time rather than straight down a ranked list.
   *
   * Year first, then section - the section list is only the chosen year's, and
   * a section the new year does not contain lets go of itself. Both live in the
   * shared hook so that reset cannot be right on one screen and missing on the
   * other.
   */
  const {
    yearLevel: yearLevelFilter,
    setYearLevel: setYearLevelFilter,
    section: sectionFilter,
    setSection: setSectionFilter,
    years: cohortYears,
    sections: cohortSections,
    filters: cohortFilters,
  } = useCohortFilters(rows, yearLevelLabel);
  // "Work my Priority 1s first" is the reason the queue is ranked at all, so it
  // is a filter and not just a sort.
  const [priorityFilter, setPriorityFilter] = useState("");
  const [expandedCaseId, setExpandedCaseId] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [savingCaseId, setSavingCaseId] = useState(null);
  /*
   * Which band of the follow-up queue is on screen: the students the segment
   * matrix puts in its top two bands, or the ones who have simply never
   * returned a survey. Two jobs, so two tabs — survey non-response covers most
   * of the cohort and would bury the call list.
   *
   * "priority" now means P1 + P2, from the same matrix as the badge on the row.
   * It used to mean whatever the evaluator had scored moderate or high, which
   * depended on somebody having pressed Run Evaluation — so this tab read 1
   * student on 2026-09-18 while the badges beside it said otherwise.
   *
   * Deliberately NOT four priority tabs the way the assignment board has: this
   * page already carries a Priority 1-4 filter in the row above, and a tab
   * strip doing the same job is the kind of duplicate control that makes two
   * screens disagree. The tab picks the JOB, the filter narrows within it.
   */
  const [queue, setQueue] = useState("priority");
  const [queueCounts, setQueueCounts] = useState({ priority: 0, survey: 0 });
  // Status and method vocabularies come from the server, which reads them from
  // the `status` table. Never hardcoded here, or the two drift.
  const [settings, setSettings] = useState({
    enrollment_statuses: [],
    contact_methods: [],
    channels: [],
    reason_groups: [],
    intervention_statuses: [],
  });

  /*
   * reason_id -> the words, so choosing a reason can fill the enrollment
   * record's free-text reason at the same time.
   *
   * Flattened out of the grouped list the server sends: the groups are for
   * reading the dropdown, this is for looking one up.
   */
  const reasonTextById = useMemo(() => {
    const map = {};
    (settings.reason_groups || []).forEach((group) => {
      (group.reasons || []).forEach((reason) => {
        map[String(reason.reason_id)] = reason.reason_text;
      });
    });
    return map;
  }, [settings.reason_groups]);

  const roleSlug = getRoleSlug(user);
  const canManageContacts = canModuleAction(permissions, "create") || canModuleAction(permissions, "edit");

  /*
   * The contact log, beside the queue, for the roles that may report on it.
   * `analyze` is what student_contact_log.php asks for, so a role without it is
   * not offered a tab that could only answer 403.
   */
  const canViewLog = canModuleAction(permissions, "analyze");
  const [view, setView] = useState("queue");
  const showingLog = canViewLog && view === "log";

  /*
   * Which term the work on this screen belongs to.
   *
   * A contact attempt is dated but not termed, and the standing it opens is
   * filed under a semester and a school year the caller never picks. Until this
   * was on screen there was nothing on the page that said which -- the queue is
   * live and unfiltered by term, so it looks the same in August and in March,
   * and the answer was only visible afterwards in the enrollment record.
   *
   * It is not a filter and must not be read as one: the queue is every student
   * who still needs a call. It says which term the calls being logged land in.
   */
  const termBadge = useCurrentTermBadge();

  const loadQueue = useCallback(async ({ background = false } = {}) => {
    if (!background) setLoading(true);
    setError("");
    try {
      const res = await fetch(
        getBackendUrl(`student_contact_workflow.php?queue=${encodeURIComponent(queue)}`),
        { headers: { Accept: "application/json" }, credentials: "include" }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load contact workspace.");
      setRows(Array.isArray(json?.data) ? json.data : []);
      setSummary(json?.summary || null);
      setQueueCounts(json?.queue_counts || { priority: 0, survey: 0 });
      setSettings({
        enrollment_statuses: json?.settings?.enrollment_statuses || [],
        contact_methods: json?.settings?.contact_methods || [],
        channels: json?.settings?.channels || [],
        reason_groups: json?.settings?.reason_groups || [],
        // Already filtered to this account's role by the server: a coach never
        // receives UNREACHABLE, CSDL never receives REFERRED TO CSDL.
        intervention_statuses: json?.settings?.intervention_statuses || [],
      });
    } catch (loadError) {
      /*
       * A failed background refresh keeps the rows it already had.
       *
       * Blanking a working queue because one poll timed out replaces a list the
       * caller can still use with an error about a request they never made.
       */
      if (!background) {
        setRows([]);
        setSummary(null);
      }
      setError(loadError?.message || "Failed to load contact workspace.");
    } finally {
      setLoading(false);
    }
  }, [queue]);

  useEffect(() => {
    void loadQueue();
  }, [loadQueue]);

  useEffect(() => {
    // Not while a row is open: coming back to the tab should not re-sort the
    // list out from under a call that is already in progress. Nor while the
    // log is on screen, where nobody is looking at the queue.
    if (expandedCaseId !== null || showingLog) return undefined;

    const handleFocus = () => {
      void loadQueue({ background: true });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadQueue({ background: true });
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadQueue, expandedCaseId, showingLog]);

  /*
   * The thirty-second poll, paused while a row is expanded.
   *
   * The queue is sorted by priority, so a refresh can reorder it. Doing that
   * while somebody is mid-call would slide the row they are working on to a
   * different place in the list. The poll resumes the moment the row is closed,
   * and closing it triggers a refresh anyway. Paused on the log view too: a
   * poll for a list nobody can see is a request every thirty seconds for
   * nothing.
   */
  useEffect(() => {
    if (expandedCaseId !== null || showingLog) return undefined;

    const intervalId = window.setInterval(() => {
      void loadQueue({ background: true });
    }, 30000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [loadQueue, expandedCaseId, showingLog]);

  // Back from the log the queue may be minutes old, its polls having paused.
  const changeView = useCallback((next) => {
    setView(next);
    if (next === "queue") void loadQueue({ background: true });
  }, [loadQueue]);

  const filteredRows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return rows.filter((row) => {
      const rowStatus = normalizeStatusKey(row?.current_status_key || row?.current_status || row?.latest_contact_status || "pending");
      if (statusFilter && rowStatus !== statusFilter) return false;
      if (priorityFilter && String(row?.priority ?? "") !== priorityFilter) return false;
      if (!matchesCohort(row, cohortFilters)) return false;
      if (!query) return true;

      const haystack = [
        row?.student_number,
        row?.first_name,
        row?.last_name,
        row?.course_name,
        row?.department_name,
        row?.email_address,
        row?.mobile_number,
        row?.current_status,
        row?.latest_contact_notes,
        row?.updated_by_name,
        row?.segment,
        row?.priority_label,
        row?.section,
        row?.student_type,
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [rows, search, statusFilter, priorityFilter, cohortFilters]);

  /*
   * One page at a time.
   *
   * The queue arrived unpaged, which on a full workspace is several hundred
   * rows of multi-line cells rendered on every keystroke in the search box. It
   * is also simply a long scroll for somebody working down a call list.
   */
  const pagedRows = usePagedRows(filteredRows, 15);

  // A new search, filter or queue tab starts at the top rather than leaving the
  // reader on a page number that now points somewhere else in the list.
  const { setPage: goToQueuePage } = pagedRows;
  useEffect(() => {
    goToQueuePage(1);
  }, [search, statusFilter, priorityFilter, yearLevelFilter, sectionFilter, queue, goToQueuePage]);

  /*
   * The student whose card is open.
   *
   * Looked up in `rows` (everything the queue returned) rather than in the
   * current page, so paging or a background refresh cannot close the card out
   * from under a call in progress.
   */
  const expandedRow = useMemo(
    () => rows.find((row) => row.student_id === expandedCaseId) || null,
    [rows, expandedCaseId]
  );

  /*
   * Buckets that add up, and each one says so. The three after the first are
   * the queue split three ways, and a student referred to CSDL is counted
   * beside the queue rather than in it. See student_contact_queue_summary()
   * for the overlapping counts this replaced, which made two students read as
   * five.
   */
  const summaryCards = useMemo(() => ([
    { label: "Students in Queue", value: summary?.total_students ?? rows.length, meta: "Contacted + follow-up + home visit" },
    { label: "Contacted", value: summary?.contacted_students ?? 0, meta: "A good contact was made" },
    { label: "Need Follow-up", value: summary?.follow_up_students ?? 0, meta: "Not reached yet" },
    { label: "Need Home Visit", value: summary?.escalated_students ?? 0, meta: "Last option — escalated" },
    { label: "Referred to CSDL", value: summary?.referred_students ?? 0, meta: "Out of the queue — view only" },
  ]), [rows.length, summary]);

  /*
   * What limits this queue, said plainly.
   *
   * Every one of these is enforced server-side in
   * student_contact_visibility_clause() — this only names the rule that is
   * already being applied. A queue that is short because of the scope looks
   * exactly like a queue that is short because the work is done, and only one
   * of those is worth investigating.
   */
  const scopeLabel = roleSlug === "dept-caller" || roleSlug === "faculty"
    ? "Only students in your department are shown here."
    : roleSlug === "ssp-caller"
      ? "Only students assigned to your SSP caller account are shown here."
      : "This queue covers students currently under the shared contact workflow.";

  async function saveAttempt(row) {
    const studentId = row?.student_id;
    const draft = drafts[String(studentId)] || buildDraftFromRow(row, settings.channels);
    if (!studentId) return;
    if (!draft.intervention_status) {
      setError("Choose the intervention status before saving the call.");
      return;
    }
    const when = contactedAt(draft);

    setSavingCaseId(studentId);
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl("student_contact_workflow.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          student_id: studentId,
          contact_method: draft.contact_method,
          other_method_label: draft.other_method_label,
          // Sent with every outcome now; the server requires it only for a stop.
          reason_id: draft.reason_id || null,
          intervention_status: draft.intervention_status || null,
          date_contacted: when.date,
          time_contacted: when.time,
          // No contact_status: the server derives it from intervention_status.
          // Required; the Save button stays off until one is chosen.
          enrollment_status: draft.enrollment_status || null,
          enrollment_reason: draft.reason_id ? (draft.enrollment_reason || null) : null,
          notes: draft.notes,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to save contact update.");

      setRows((current) => current.map((entry) => (
        entry.student_id === studentId ? json.data : entry
      )));
      const visitNote = HOME_VISIT_CHANGE_MESSAGES[json?.data?.home_visit_change] || "";
      setSuccess([json?.message || "Contact update saved.", visitNote].filter(Boolean).join(" "));
      setExpandedCaseId(null);
      setDrafts((current) => {
        const next = { ...current };
        delete next[String(studentId)];
        return next;
      });
      await loadQueue({ background: true });
    } catch (saveError) {
      setError(saveError?.message || "Failed to save contact update.");
    } finally {
      setSavingCaseId(null);
    }
  }

  const viewTabs = canViewLog ? (
    <Tabs
      tabs={[
        { key: "queue", label: "Call queue", hint: "The students still to reach, and the card to log a contact" },
        { key: "log", label: "Contact log", hint: "Every contact action logged, with filters and an export" },
      ]}
      value={showingLog ? "log" : "queue"}
      onChange={changeView}
      label="Contact Workspace views"
    />
  ) : null;

  // The log replaces the queue rather than stacking under it: two long tables
  // on one screen, each with its own filters, is two screens badly.
  if (showingLog) {
    return (
      <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
        <OverviewHeader title={module?.label || "Contact Workspace"} term={termBadge} />
        {viewTabs}
        <ContactLogReport />
      </section>
    );
  }

  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
      <OverviewHeader title={module?.label || "Contact Workspace"} term={termBadge} />
      {viewTabs}
      <AlertMessage
        tone="info"
        message={`${scopeLabel} Every call needs an enrollment outcome and an Intervention Status. RECOVERED closes the case and any open home visit; anything else, or the outcome For Home Visit, sends the student to the Home Visit Workspace.`}
      />
      <MessageBox message={error} />
      <MessageBox message={success} tone="success" />

      <OverviewStatCards items={summaryCards} minWidth={180} />

      <DashboardPanel>
        <div style={{ display: "grid", gap: 9 }}>
          {/*
            * The two bands of the follow-up queue. Tabs rather than another filter
            * in the row above, because they answer different questions: "who do I
            * ring today" and "who still owes us a survey".
            */}
          <div style={{ display: "flex", gap: 2, borderBottom: "1px solid var(--border-base)" }}>
            {[
              {
                key: "priority",
                label: "Needs a call",
                count: queueCounts.priority,
                hint: "Priority 1 and 2 on the segment matrix - attendance, grades and balance",
              },
              {
                key: "survey",
                label: "No survey yet",
                count: queueCounts.survey,
                hint: "Never submitted a survey. Counted separately from the priority bands, not instead of them",
              },
            ].map((tab) => {
              const active = queue === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  title={tab.hint}
                  onClick={() => setQueue(tab.key)}
                  style={{
                    padding: "7px 13px",
                    border: "1px solid var(--border-base)",
                    borderBottom: active ? "1px solid var(--surface-base)" : "1px solid var(--border-base)",
                    borderRadius: "7px 7px 0 0",
                    marginBottom: -1,
                    background: active ? "var(--surface-base)" : "var(--surface-page)",
                    color: active ? "var(--text-primary)" : "var(--text-faint)",
                    fontWeight: active ? 600 : 500,
                    fontSize: 12.5,
                    cursor: "pointer",
                  }}
                >
                  {tab.label}
                  <span style={{ marginLeft: 6, opacity: 0.75 }}>{tab.count}</span>
                </button>
              );
            })}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search student, status, program, department..."
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 204 }}
                name="student_contact_search"
              />
              <select
                value={priorityFilter}
                onChange={(event) => setPriorityFilter(event.target.value)}
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 162, background: "#fff" }}
                name="student_contact_priority_filter"
                aria-label="Filter by priority"
              >
                <option value="">All priorities</option>
                <option value="1">Priority 1 &middot; College</option>
                <option value="2">Priority 2 &middot; Coaches</option>
                <option value="3">Priority 3 &middot; Coaches</option>
                <option value="4">Priority 4 &middot; Coaches</option>
              </select>
              <select
                value={statusFilter}
                onChange={(event) => setStatusFilter(event.target.value)}
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 153, background: "#fff" }}
                name="student_contact_status_filter"
              >
                <option value="">All statuses</option>
                <option value="contacted">Contacted</option>
                <option value="no_response">No Response</option>
                <option value="pending">Pending</option>
                <option value="follow_up_needed">Follow Up Needed</option>
              </select>
              {/* Only offered when the queue actually holds more than one, so a
                  department that runs a single section is not given a dropdown
                  with one thing in it. */}
              {cohortYears.length > 1 ? (
                <select
                  value={yearLevelFilter}
                  onChange={(event) => setYearLevelFilter(event.target.value)}
                  style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 130, background: "#fff" }}
                  name="student_contact_year_level_filter"
                  aria-label="Filter by year level"
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
                  style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 130, background: "#fff" }}
                  name="student_contact_section_filter"
                  aria-label="Filter by section"
                >
                  <option value="">All sections</option>
                  {cohortSections.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              ) : null}
            </div>
          </div>

          {/* The row colour tracks the contact journey: priority until the
              student is called, then the outcome of the calling. */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "1px 0 8px", fontSize: 10.5, color: "var(--text-muted)", flexWrap: "wrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span aria-hidden="true" style={{ display: "inline-flex", borderRadius: 4, overflow: "hidden", border: "1px solid var(--border-base)" }}>
                {[1, 2, 3, 4].map((p) => (
                  <span key={p} style={{ width: 13, height: 11, background: PRIORITY_ROW_ACCENT[p] }} />
                ))}
              </span>
              Priority (to call)
            </span>
            {[
              ["#34d399", "Contacted"],
              ["#fb7185", "No answer"],
              ["#fb923c", "Refer to CSDL"],
              ["#a78bfa", "Home visit"],
            ].map(([c, label]) => (
              <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                <span aria-hidden="true" style={{ width: 11, height: 11, borderRadius: 3, background: c }} />
                {label}
              </span>
            ))}
          </div>

          <div style={{ overflow: "auto", maxHeight: "calc(100dvh - 250px)", border: "1px solid var(--border-base)", borderRadius: 9 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                  <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>No.</th>
                  <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Student</th>
                  <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Program</th>
                  <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Contact Status</th>
                  <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Last Update</th>
                  <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {/* Only the very first load blanks the table. A refresh that
                    already has rows keeps showing them. */}
                {loading && rows.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMN_COUNT} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                      Loading contact workspace...
                    </td>
                  </tr>
                ) : pagedRows.rows.length === 0 ? (
                  <tr>
                    <td colSpan={COLUMN_COUNT} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                      No students matched the current filters.
                    </td>
                  </tr>
                ) : (
                  pagedRows.rows.map((row, index) => {
                    const caseKey = String(row.student_id);
                    const priorityLevel = Number(row.priority);
                    /*
                     * Before any call the row wears its priority colour (which to
                     * call first); once calling starts it wears its outcome colour
                     * (how it is going). Low-alpha tints so the same colour holds on
                     * a light or dark row background.
                     */
                    const contactState = rowContactState(row);
                    const rowTint = contactState ? contactState.tint : PRIORITY_ROW_TINT[priorityLevel];
                    const rowAccent = contactState ? contactState.accent : PRIORITY_ROW_ACCENT[priorityLevel];
                    const rowStyle = rowTint ? { background: rowTint } : undefined;
                    const firstCellStyle = {
                      padding: 9,
                      borderBottom: "1px solid var(--border-base)",
                      color: "var(--text-muted)",
                      // An accent bar rather than a full left border, so the row
                      // content never shifts 4px sideways.
                      ...(rowAccent ? { boxShadow: `inset 4px 0 0 0 ${rowAccent}` } : null),
                    };

                    return (
                      <React.Fragment key={row.student_id}>
                        <tr style={rowStyle}>
                          <td style={firstCellStyle}>
                            {(pagedRows.page - 1) * pagedRows.pageSize + index + 1}
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 160 }}>
                            <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                              {row.student_number || "No student number"}
                            </div>
                            <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>{formatStudentName(row)}</div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 170 }}>
                            {/* Priority leads — it is what the row is triaged by. The
                                segment and the full signals are one click away in the
                                card, so they no longer crowd the row. */}
                            <span
                              style={priorityPill(row.priority, row.priority_owner).style}
                              title={row.segment ? `Segment: ${row.segment}` : undefined}
                            >
                              {priorityPill(row.priority, row.priority_owner).label}
                            </span>
                            <div style={{ color: "var(--text-primary)", marginTop: 4 }}>{row.course_name || "No course"}</div>
                            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                              {row.department_name || "No department"}{row.year_level ? ` · ${yearLevelLabel(row.year_level)}` : ""}{row.section ? ` · ${row.section}` : ""}
                            </div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 120 }}>
                            {statusPill(row.current_status || "Pending")}
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 5 }}>
                              Attempts: {row.contact_attempt_count || 0}
                            </div>
                            {contactState && (contactState.key === "refer_csdl" || contactState.key === "home_visit") ? (
                              <div style={{ marginTop: 4, fontSize: 10.5, fontWeight: 700, color: contactState.tagColor }}>
                                {contactState.tag}
                              </div>
                            ) : null}
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 180 }}>
                            <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                              {row.latest_contact_method || "No contact yet"}
                            </div>
                            <div style={{ color: "var(--text-muted)", fontSize: 11 }}>
                              {row.last_updated_at || row.latest_contacted_at
                                ? formatDateTime(row.last_updated_at || row.latest_contacted_at)
                                : "—"}
                            </div>
                            <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                              {row.updated_by_name
                                ? `Contacted by ${row.updated_by_name}${row.updated_by_role_name ? ` · ${row.updated_by_role_name}` : ""}`
                                : "Not contacted yet"}
                            </div>
                          </td>
                          <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 136 }}>
                            <button
                              type="button"
                              onClick={() => {
                                setExpandedCaseId(row.student_id);
                                setDrafts((current) => ({
                                  ...current,
                                  [caseKey]: current[caseKey] || buildDraftFromRow(row, settings.channels),
                                }));
                              }}
                              style={{
                                ...buttonStyle,
                                background: "var(--brand-600)",
                                color: "#fff",
                                width: "100%",
                                opacity: !canManageContacts ? 0.6 : 1,
                              }}
                              disabled={!canManageContacts}
                            >
                              {/* A referred student's card only reads. */}
                              {row.referred_to_csdl ? "View" : "Open"}
                            </button>
                          </td>
                        </tr>
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {pagedRows.total > 0 ? (
            <div style={{ paddingTop: 9 }}>
              <Pagination
                page={pagedRows.page}
                pageSize={pagedRows.pageSize}
                total={pagedRows.total}
                onPageChange={pagedRows.setPage}
                onPageSizeChange={pagedRows.setPageSize}
                itemLabel="students"
              />
            </div>
          ) : null}
        </div>
      </DashboardPanel>

      {/*
        One dialog for the whole table, not one per row.

        Driven by expandedCaseId, so the card is mounted only while a student is
        open — which also means the thirty-second poll stays paused for exactly
        as long as somebody is working in it.

        The row is looked up in `rows` rather than in the current page, so the
        card survives a background refresh reordering the queue underneath it.
      */}
      <Modal
        open={Boolean(expandedRow)}
        title={expandedRow ? `${formatStudentName(expandedRow)}${expandedRow.student_number ? ` · ${expandedRow.student_number}` : ""}` : ""}
        onClose={() => setExpandedCaseId(null)}
        width={1040}
        error={error}
      >
        {expandedRow ? (
          <ContactCard
            row={expandedRow}
            caseKey={String(expandedRow.student_id)}
            draft={drafts[String(expandedRow.student_id)] || buildDraftFromRow(expandedRow, settings.channels)}
            settings={settings}
            reasonTextById={reasonTextById}
            canManageContacts={canManageContacts}
            savingCaseId={savingCaseId}
            setDrafts={setDrafts}
            onSave={saveAttempt}
            onClose={() => setExpandedCaseId(null)}
          />
        ) : null}
      </Modal>
    </section>
  );
}
