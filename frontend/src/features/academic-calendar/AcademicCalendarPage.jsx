import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AlertMessage, Button, SectionHeader } from "../../shared/components/ui";
import { DashboardPanel } from "../../shared/layout/dashboard";
import { getBackendUrl } from "../../shared/lib/url";
import { confirmAction, notifyError, notifySuccess } from "../../shared/lib/notify";
import { invalidateCurrentTerm } from "../../shared/lib/currentTerm";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { tone } from "../../shared/theme/tokens";

/**
 * Which term the portal is in, and the two ways of saying so.
 *
 * The office asked for both, and both are here for the same reason the backend
 * carries both (see api/lib/academic_calendar.php): dates are the answer that
 * keeps working when nobody remembers to change anything, and the pin is the
 * answer for the fortnight when the calendar and the work disagree — P1 grades
 * get encoded well into P2, and during those weeks the date is right about the
 * term and wrong about the upload.
 *
 * What this screen sets is a DEFAULT. The import dialogs still show all three
 * pickers and still let the person uploading change them; this decides what
 * they open on.
 *
 * A module rather than a Settings panel, and the difference is who it is for.
 * Settings is where an administrator configures the system and it is opened
 * rarely, by one person. This is opened at the start of every periodical by
 * whoever runs the term, and what it sets is read by Grades, Attendance and
 * Finance every time somebody opens them. A setting that three working screens
 * depend on is not a setting; it is a thing you maintain, and it belongs where
 * you can find it.
 *
 * This was two files until 2026-09-15: a ten-line AcademicCalendarPage that
 * translated the permission shape and rendered an AcademicCalendarPanel doing
 * everything else. The split was real while the panel also lived in Settings,
 * and stopped being real when it moved out - nothing else has rendered the
 * panel since, so the wrapper was a hop with no fork in it.
 */

/** The badge beside the resolved term, saying which rule produced it. */
const SOURCE_BADGE = {
  manual: { label: "Pinned", tone: "warning" },
  in_term: { label: "From the calendar", tone: "success" },
  after_term: { label: "Between terms", tone: "warning" },
  before_term: { label: "Not started yet", tone: "warning" },
  current_year: { label: "Year only", tone: "neutral" },
  none: { label: "Not set", tone: "danger" },
};

const PERIOD_CHOICES = [
  { value: "1", short: "P1", label: "P1 — First Periodical" },
  { value: "2", short: "P2", label: "P2 — Second Periodical" },
  { value: "3", short: "P3", label: "P3 — Third Periodical" },
];

const EMPTY_TERM_FORM = { school_year_id: "", semester_id: "", period: "", starts_on: "", ends_on: "" };

const EMPTY_PIN = { school_year_id: "", semester_id: "", period: "" };

/**
 * The three pin fields off a settings payload or a resolved term, as the
 * strings the pickers hold.
 *
 * One function rather than two, because the two shapes differ in nothing but
 * the key prefix: a settings payload spells them `manual_school_year_id` and a
 * resolved term spells the same field `school_year_id`. The conversion is the
 * part that matters and it was written twice -- null and undefined become "",
 * so a cleared pin and an absent one both read as "no choice", and everything
 * else becomes a string because a <select> compares its value as one and a
 * numeric id would never match its own option.
 */
function pinFrom(source, prefix = "") {
  const field = (name) => {
    const value = source?.[`${prefix}${name}`];
    return value != null ? String(value) : "";
  };

  return {
    school_year_id: field("school_year_id"),
    semester_id: field("semester_id"),
    period: field("period"),
  };
}

const samePin = (a, b) =>
  a.school_year_id === b.school_year_id && a.semester_id === b.semester_id && a.period === b.period;

const inputStyle = {
  padding: "6px 8px",
  borderRadius: 6,
  border: "1px solid var(--border-strong)",
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  fontSize: 12.5,
  width: "100%",
};

/**
 * One choice in a row of choices: a button that stays on screen showing what it
 * is, rather than a value hidden behind a closed dropdown.
 *
 * The pin row exists because moving the term is usually a one-token change —
 * P1 to P2, nothing else — and a <select> makes that three interactions (open,
 * find, pick) before any save. Buttons make it one, and they show the
 * alternatives without being opened, which is the part that matters when
 * somebody is checking whether the portal is on the periodical they think it is.
 *
 * `aria-pressed` rather than a radio group: these are toggles over one value, so
 * a screen reader should hear "P2, pressed" the way the eye sees the fill.
 */
function Segment({ active, disabled, onClick, children, title }) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        padding: "7px 13px",
        borderRadius: 8,
        border: `1px solid ${active ? "var(--brand-500)" : "var(--border-base)"}`,
        background: active ? "var(--brand-100)" : "var(--surface-base)",
        color: active ? "var(--text-brand)" : "var(--text-secondary)",
        fontSize: 12.5,
        fontWeight: active ? 700 : 500,
        lineHeight: 1,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
        // P1/P2/P3 should not shift width as the weight changes between states.
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </button>
  );
}

/** A stored date as something a person reads, without moving it. */
function readableDate(value) {
  if (!value) return "—";
  const [year, month, day] = String(value).split("-").map(Number);
  if (!year || !month || !day) return String(value);
  // Constructed from the parts rather than parsed from the string: new
  // Date("2026-08-10") is UTC midnight, which renders as 9 August anywhere west
  // of Greenwich — the sort of off-by-one that makes a calendar untrustworthy.
  return new Date(year, month - 1, day).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

export default function AcademicCalendarPage({ permissions = null }) {
  const [config, setConfig] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // What the pin row is showing. Seeded from the resolved term below, so it
  // opens on the answer rather than on a blank form.
  const [pin, setPin] = useState(EMPTY_PIN);
  const [termForm, setTermForm] = useState(EMPTY_TERM_FORM);

  /*
   * A module page is handed an array of action strings, where the Settings
   * panel was handed an object with a canEdit flag. With no context at all -
   * a direct render in a test, say - both stay open rather than locking a
   * screen nobody has described yet.
   */
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canView = hasPermissionContext ? canModuleAction(permissions, "view") : true;
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch(getBackendUrl("academic_calendar.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not read the academic calendar.");
      applyConfig(payload.data);
    } catch (loadError) {
      setError(loadError?.message || "Could not read the academic calendar.");
    } finally {
      setLoading(false);
    }
  }, []);

  /**
   * Adopts a server payload, and drops the cached answer the import dialogs
   * hold.
   *
   * Every write here returns the whole new state, so the panel never has to
   * refetch to show what it just did — and never has to guess, either, since
   * what "current" resolves to after a save is the server's conclusion and not
   * something a browser should work out for itself.
   */
  function applyConfig(data) {
    setConfig(data || null);
    invalidateCurrentTerm();
  }

  useEffect(() => {
    void load();
  }, [load]);

  const current = config?.current || null;
  const terms = useMemo(() => config?.terms || [], [config]);
  const schoolYears = useMemo(() => config?.school_years || [], [config]);
  const semesters = useMemo(() => config?.semesters || [], [config]);

  /*
   * The pin row opens on whatever is current, so the ordinary move is one
   * press: P1 is already filled in, you press P2, you set it.
   *
   * Seeded from the RESOLVED term rather than from the stored pin, and the
   * difference shows in auto mode — where the pin is usually blank but the dates
   * have an answer. Starting from the blank pin would mean re-choosing a year
   * and a semester that are already on screen just to nudge the periodical.
   *
   * `current` is a new object on every applyConfig() and on nothing else, so
   * this re-seeds exactly when the server says something changed, and never
   * underneath somebody mid-edit.
   */
  useEffect(() => {
    setPin(pinFrom(current));
  }, [current]);

  // What is actually saved, as opposed to the radios below that the reader may
  // have moved without submitting. The pin row compares against this.
  const savedMode = config?.settings?.mode || "auto";
  const savedPin = useMemo(() => pinFrom(config?.settings, "manual_"), [config]);

  /*
   * The draft as a sentence for the button to name.
   *
   * Unknown ids resolve to nothing rather than to their raw number: a school
   * year deleted underneath the reader should read as absent, not as "17".
   */
  const pinPreview = useMemo(() => {
    const year = schoolYears.find((row) => String(row.school_year_id) === pin.school_year_id);
    const semester = semesters.find((row) => String(row.semester_id) === pin.semester_id);
    return [
      pin.period ? `P${pin.period}` : "",
      semester?.semester_name || "",
      year?.schoolyear_name || "",
    ].filter(Boolean).join(" · ");
  }, [pin, schoolYears, semesters]);

  // Pinning is the only thing this row does, so "nothing to save" means the pin
  // is already on and already says this. In auto mode an identical-looking
  // draft is still a change, because applying it stops the dates driving.
  const pinIsCurrent = savedMode === "manual" && samePin(pin, savedPin);
  const pinReady = canEdit && !busy && Boolean(pin.school_year_id) && !pinIsCurrent;

  const send = useCallback(async (method, query, body) => {
    const response = await fetch(getBackendUrl(`academic_calendar.php${query}`), {
      method,
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload?.message || "The change could not be saved.");
    return payload;
  }, []);

  async function saveMode(nextMode, nextPin = pin) {
    setBusy(true);
    try {
      const payload = await send("PUT", "", {
        mode: nextMode,
        manual_school_year_id: nextPin.school_year_id || "",
        manual_semester_id: nextPin.semester_id || "",
        manual_period: nextPin.period || "",
      });
      applyConfig(payload.data);
      notifySuccess(payload.message || "Saved.");
    } catch (saveError) {
      notifyError(saveError?.message || "Could not save the current term.");
    } finally {
      setBusy(false);
    }
  }

  /*
   * Sets the current term from the pin row.
   *
   * Routed through saveMode() rather than given a request of its own: there is
   * one way to set the term by hand and it is the manual pin, so this is the
   * write the panel already makes, from a shorter path. A second endpoint — or a
   * second shape of the same one — is how the pin row and the form below would
   * start disagreeing about what "now" is.
   *
   * It pins, and the button says so, because there is no other honest reading:
   * choosing a term by hand while the dates say otherwise is what the pin is
   * for. Authorization is unchanged either way — academic_calendar.php's PUT
   * still requires academic_calendar:edit or settings:edit.
   */
  async function applyPin() {
    await saveMode("manual", pin);
  }

  /*
   * Hands the term back to the dates and forgets where it was pinned.
   *
   * One action rather than the two this briefly had. "Unpin" and "Clear pin"
   * did the same visible thing — the term goes back to following the calendar —
   * and differed only in whether the three fields stayed on file afterwards.
   * A pair of buttons distinguished by invisible state is a coin toss at the
   * moment of pressing, so this does the whole job and shows its work: the
   * manual selects empty out where you can see them.
   *
   * The cost is the remembered pin. Somebody who pinned P1 each encoding
   * fortnight used to find P1 still sitting there next time; now they re-choose
   * it. That is the trade for a control whose effect is entirely on screen.
   *
   * The backend clears on empty strings of its own accord: academic_calendar.php
   * only insists on a school year when the mode being saved is `manual`.
   */
  async function unpin() {
    await saveMode("auto", EMPTY_PIN);
  }

  async function saveTerm() {
    setBusy(true);
    try {
      const payload = await send("POST", "", {
        school_year_id: termForm.school_year_id,
        semester_id: termForm.semester_id,
        period: termForm.period,
        starts_on: termForm.starts_on,
        ends_on: termForm.ends_on,
      });
      applyConfig(payload.data);
      setTermForm(EMPTY_TERM_FORM);
      notifySuccess(payload.message || "Term dates saved.");
    } catch (saveError) {
      notifyError(saveError?.message || "Could not save those term dates.");
    } finally {
      setBusy(false);
    }
  }

  async function removeTerm(row) {
    const confirmed = await confirmAction({
      title: `Remove ${row.period_label} of ${row.semester_name}, ${row.schoolyear_name}?`,
      message:
        "Only the dates are removed. Records already filed under this term are untouched — but imports will stop defaulting to it.",
      confirmLabel: "Remove dates",
    });
    if (!confirmed) return;

    setBusy(true);
    try {
      const payload = await send("DELETE", `?term_id=${encodeURIComponent(row.term_id)}`);
      applyConfig(payload.data);
      notifySuccess(payload.message || "Removed.");
    } catch (deleteError) {
      notifyError(deleteError?.message || "Could not remove those dates.");
    } finally {
      setBusy(false);
    }
  }

  const termFormReady =
    termForm.school_year_id && termForm.semester_id && termForm.period && termForm.starts_on && termForm.ends_on;

  // Below the hooks on purpose: an early return above them would change how
  // many run between renders.
  if (!canView) {
    return (
      <DashboardPanel>
        <AlertMessage tone="error" message="You do not have permission to open the Academic Calendar." />
      </DashboardPanel>
    );
  }
  if (loading) {
    return (
      <DashboardPanel>
        <p style={{ color: "var(--text-muted)" }}>Loading the academic calendar…</p>
      </DashboardPanel>
    );
  }
  if (error) {
    return (
      <DashboardPanel>
        <AlertMessage tone="error" message={error} />
      </DashboardPanel>
    );
  }

  const badge = SOURCE_BADGE[current?.source] || SOURCE_BADGE.none;
  const badgeTone = tone(badge.tone === "neutral" ? "info" : badge.tone);

  return (
    <DashboardPanel>
      <SectionHeader
        title="Current term"
        subtitle="What Grades, Attendance and Finance open their import dialogs on. Anyone importing can still change it."
      />

      {/* The answer first, and the reason under it. Everything below this card
          is the machinery that produced it. */}
      <div
        style={{
          margin: "10px 0 22px",
          padding: 14,
          borderRadius: 10,
          border: `1px solid ${badgeTone.border}`,
          background: badgeTone.bg,
          display: "grid",
          gap: 6,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
          <span style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
            {current?.label || "Not set"}
          </span>
          <span
            style={{
              padding: "2px 8px",
              borderRadius: 999,
              fontSize: 11,
              fontWeight: 600,
              color: badgeTone.text,
              border: `1px solid ${badgeTone.border}`,
              background: "var(--surface-base)",
            }}
          >
            {badge.label}
          </span>
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>{current?.note}</p>
      </div>

      {canEdit ? (
        <div
          style={{
            margin: "0 0 22px",
            padding: 14,
            borderRadius: 10,
            border: "1px solid var(--border-base)",
            background: "var(--surface-page)",
            display: "grid",
            gap: 12,
          }}
        >
          <SectionHeader
            title="Set the term now"
            subtitle="The start-of-periodical move, in one press. Change the parts that changed — the dates and the full calendar are below when you need them."
          />

          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ display: "grid", gap: 4, maxWidth: 260 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>School year</span>
              <input
                value={current?.schoolyear_name || "No active school year"}
                readOnly
                style={inputStyle}
                name="academic_calendar_pin_year"
              />
            </label>

            {/* Read from the table rather than hardcoded to two, because a
                summer term is a row somebody can add. */}
            <div style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Semester</span>
              <div role="group" aria-label="Semester" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {semesters.map((semester) => (
                  <Segment
                    key={semester.semester_id}
                    active={pin.semester_id === String(semester.semester_id)}
                    disabled={busy}
                    onClick={() => setPin((prev) => ({ ...prev, semester_id: String(semester.semester_id) }))}
                  >
                    {semester.semester_name}
                  </Segment>
                ))}
                {/*
                  Naming no semester pins the YEAR, which is a real setting and
                  was the one thing the select below could express and this row
                  could not. It is kept here so folding the two controls into one
                  took nothing away.

                  Choosing it clears the periodical too: a pin that named P1 but
                  no semester would be asking which P1, and the backend stores
                  the two independently, so the answer would be whatever was left
                  over from the last edit.
                */}
                <Segment
                  active={pin.semester_id === ""}
                  disabled={busy}
                  title="Pin the school year without naming a semester"
                  onClick={() => setPin((prev) => ({ ...prev, semester_id: "", period: "" }))}
                >
                  Any semester
                </Segment>
              </div>
            </div>

            <div style={{ display: "grid", gap: 4 }}>
              <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Periodical</span>
              <div role="group" aria-label="Periodical" style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {/*
                  Unreachable while no semester is named, because "P1 of no
                  particular semester" is not a term anybody can act on -- the
                  import dialogs would have to guess which one, and the backend
                  stores the two fields independently so nothing downstream would
                  catch it.
                */}
                {PERIOD_CHOICES.map((choice) => (
                  <Segment
                    key={choice.value}
                    active={pin.period === choice.value}
                    disabled={busy || !pin.semester_id}
                    title={pin.semester_id ? choice.label : "Choose a semester first"}
                    onClick={() => setPin((prev) => ({ ...prev, period: choice.value }))}
                  >
                    {choice.short}
                  </Segment>
                ))}
                {/* A pin with no periodical is a real setting, not an unfinished
                    one — it is what the import dialogs open on while a semester is
                    being encoded whole. Same choice as the pin select below. */}
                <Segment
                  active={pin.period === ""}
                  disabled={busy}
                  title="Pin the semester without naming a periodical"
                  onClick={() => setPin((prev) => ({ ...prev, period: "" }))}
                >
                  Whole semester
                </Segment>
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
            <Button variant="primary" disabled={!pinReady} onClick={() => void applyPin()}>
              {pinIsCurrent ? "Already the current term" : `Pin ${pinPreview || "this term"}`}
            </Button>
            {/* "Unpin" rather than "Follow the dates instead": the button is the
                way out of the pin, and naming it after its side effect meant
                nobody looking to unpin could find it. The hint keeps the
                consequence, which is the part the old label was carrying. */}
            {savedMode === "manual" || savedPin.school_year_id ? (
              <Button
                variant="secondary"
                disabled={busy}
                title="Let the calendar dates decide the term again, and empty the pinned year, semester and periodical"
                onClick={() => void unpin()}
              >
                Unpin
              </Button>
            ) : null}
            {!pin.school_year_id ? (
              <span style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Choose a school year first.</span>
            ) : null}
          </div>

          {/* Said here rather than discovered afterwards further down the panel.
              Setting a term by hand turns the dates off, and somebody pressing a
              button labelled "Pin" should not have to already know that. */}
          <p style={{ margin: 0, fontSize: 11.5, lineHeight: 1.55, color: "var(--text-muted)" }}>
            {savedMode === "manual"
              ? "The term is pinned, so the dates below are not being used. Imports default here until you switch back."
              : "The term follows the calendar dates right now. Setting it here pins it instead, and it stays put until you switch back."}
          </p>
        </div>
      ) : null}

      <SectionHeader
        title="How the term is decided"
        subtitle="Follow the dates and it advances P1 to P2 to P3 on its own. Pin it and it stays where you put it until you move it."
      />

      {/*
        * Description, not a second set of controls.
        *
        * This section carried its own school year, semester and periodical
        * selects, its own "Pin this term" and its own "Unpin" -- a complete
        * duplicate of the row above, differing only in widget. Two places to do
        * one thing is two places to disagree about what "now" is.
        *
        * The radios went with the fields, because the mode was never really
        * theirs to set: pinning a term IS choosing manual and unpinning IS
        * choosing auto, so the two buttons above have already decided it by the
        * time anyone reads this far. What is left is the part only this section
        * ever did -- saying which rule is running, and why you would want the
        * other one.
        */}
      <div style={{ display: "grid", gap: 10, margin: "10px 0 22px" }}>
        {[
          {
            value: "auto",
            title: "Follow the calendar dates",
            body:
              "Today's date picks the term from the dates below, and it rolls forward by itself. Between terms it stays on the periodical that just ended, because encoding runs behind the calendar.",
          },
          {
            value: "manual",
            title: "Pinned to one term",
            body:
              "Imports default to the term set above and ignore the dates. Useful while a finished periodical is still being encoded — and it stays put until somebody moves it.",
          },
        ].map((option) => {
          const active = savedMode === option.value;
          return (
            <div
              key={option.value}
              style={{
                display: "grid",
                gap: 3,
                padding: 11,
                borderRadius: 9,
                border: `1px solid ${active ? "var(--brand-500, var(--border-strong))" : "var(--border-base)"}`,
                background: active ? "var(--brand-100)" : "var(--surface-base)",
              }}
            >
              <span style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 7 }}>
                <span style={{ fontWeight: 600, fontSize: 12.5, color: "var(--text-primary)" }}>{option.title}</span>
                {active ? (
                  <span
                    style={{
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: 0.3,
                      textTransform: "uppercase",
                      padding: "2px 7px",
                      borderRadius: 999,
                      color: "var(--text-brand)",
                      background: "var(--surface-base)",
                      border: "1px solid var(--brand-500, var(--border-strong))",
                    }}
                  >
                    In use
                  </span>
                ) : null}
              </span>
              <span style={{ fontSize: 11.5, lineHeight: 1.5, color: "var(--text-muted)" }}>{option.body}</span>
            </div>
          );
        })}
      </div>

      <SectionHeader
        title="Term dates"
        subtitle="One row per periodical. Terms cannot share a day — an overlap is refused rather than resolved, because only one term can be now."
      />

      {/* savedMode, not a draft: this describes what the dates are doing now. */}
      {savedMode === "manual" ? (
        <AlertMessage
          tone="info"
          message="A term is pinned, so these dates are not being used right now. They are kept, and take over again the moment you switch back to following the calendar."
        />
      ) : null}

      <div style={{ overflowX: "auto", margin: "10px 0" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
          <thead>
            <tr style={{ textAlign: "left", color: "var(--text-muted)" }}>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }}>School year</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }}>Semester</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }}>Periodical</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }}>Starts</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }}>Ends</th>
              <th style={{ padding: "6px 8px", borderBottom: "1px solid var(--border-base)" }} />
            </tr>
          </thead>
          <tbody>
            {terms.length === 0 ? (
              <tr>
                <td colSpan={6} style={{ padding: "14px 8px", color: "var(--text-muted)" }}>
                  No term dates yet. Until there are, imports default to the current school year and leave the semester
                  and periodical blank — exactly as they behaved before this screen existed.
                </td>
              </tr>
            ) : (
              terms.map((row) => (
                <tr
                  key={row.term_id}
                  style={{
                    background: row.is_today ? tone("success").bg : "transparent",
                  }}
                >
                  <td style={{ padding: "7px 8px", borderBottom: "1px solid var(--border-base)" }}>
                    {row.schoolyear_name}
                  </td>
                  <td style={{ padding: "7px 8px", borderBottom: "1px solid var(--border-base)" }}>
                    {row.semester_name}
                  </td>
                  <td style={{ padding: "7px 8px", borderBottom: "1px solid var(--border-base)", fontWeight: 600 }}>
                    {row.period_label}
                    {row.is_today ? (
                      <span style={{ marginLeft: 6, fontSize: 11, fontWeight: 500, color: tone("success").text }}>
                        today
                      </span>
                    ) : null}
                  </td>
                  <td style={{ padding: "7px 8px", borderBottom: "1px solid var(--border-base)" }}>
                    {readableDate(row.starts_on)}
                  </td>
                  <td style={{ padding: "7px 8px", borderBottom: "1px solid var(--border-base)" }}>
                    {readableDate(row.ends_on)}
                  </td>
                  <td style={{ padding: "7px 8px", borderBottom: "1px solid var(--border-base)", textAlign: "right" }}>
                    <Button
                      variant="secondary"
                      disabled={!canEdit || busy}
                      onClick={() =>
                        setTermForm({
                          school_year_id: String(row.school_year_id),
                          semester_id: String(row.semester_id),
                          period: String(row.period),
                          starts_on: row.starts_on,
                          ends_on: row.ends_on,
                        })
                      }
                    >
                      Edit
                    </Button>{" "}
                    <Button variant="danger" disabled={!canEdit || busy} onClick={() => void removeTerm(row)}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {canEdit ? (
        <div
          style={{
            display: "grid",
            gap: 8,
            gridTemplateColumns: "repeat(auto-fit, minmax(min(140px, 100%), 1fr))",
            alignItems: "end",
            padding: 12,
            borderRadius: 9,
            border: "1px solid var(--border-base)",
            background: "var(--surface-page)",
          }}
        >
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>School year</span>
            <select
              value={termForm.school_year_id}
              disabled={busy}
              onChange={(event) => setTermForm((prev) => ({ ...prev, school_year_id: event.target.value }))}
              style={inputStyle}
              name="academic_calendar_form_year"
            >
              <option value="">Select</option>
              {schoolYears.map((year) => (
                <option key={year.school_year_id} value={year.school_year_id}>
                  {year.schoolyear_name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Semester</span>
            <select
              value={termForm.semester_id}
              disabled={busy}
              onChange={(event) => setTermForm((prev) => ({ ...prev, semester_id: event.target.value }))}
              style={inputStyle}
              name="academic_calendar_form_semester"
            >
              <option value="">Select</option>
              {semesters.map((semester) => (
                <option key={semester.semester_id} value={semester.semester_id}>
                  {semester.semester_name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Periodical</span>
            <select
              value={termForm.period}
              disabled={busy}
              onChange={(event) => setTermForm((prev) => ({ ...prev, period: event.target.value }))}
              style={inputStyle}
              name="academic_calendar_form_period"
            >
              <option value="">Select</option>
              {PERIOD_CHOICES.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Starts on</span>
            <input
              type="date"
              value={termForm.starts_on}
              disabled={busy}
              onChange={(event) => setTermForm((prev) => ({ ...prev, starts_on: event.target.value }))}
              style={inputStyle}
              name="academic_calendar_form_starts_on"
            />
          </label>
          <label style={{ display: "grid", gap: 3 }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Ends on</span>
            <input
              type="date"
              value={termForm.ends_on}
              disabled={busy}
              onChange={(event) => setTermForm((prev) => ({ ...prev, ends_on: event.target.value }))}
              style={inputStyle}
              name="academic_calendar_form_ends_on"
            />
          </label>
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="primary" disabled={busy || !termFormReady} onClick={() => void saveTerm()}>
              Save dates
            </Button>
            {termForm.school_year_id ? (
              <Button variant="secondary" disabled={busy} onClick={() => setTermForm(EMPTY_TERM_FORM)}>
                Clear
              </Button>
            ) : null}
          </div>
        </div>
      ) : null}

      <p style={{ margin: "10px 0 0", fontSize: 11.5, lineHeight: 1.55, color: "var(--text-muted)" }}>
        Saving dates for a periodical that already has them replaces them — there is only ever one P1 per semester.
      </p>
    </DashboardPanel>
  );
}
