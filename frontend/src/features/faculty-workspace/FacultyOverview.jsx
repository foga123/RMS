import React, { useCallback, useEffect, useMemo, useState } from "react";
// Deep imports rather than the two shared barrels.
//
// shared/components/ui re-exports Breadcrumb and shared/layout/dashboard
// re-exports DashboardShell; both reach react-router-dom, which jest cannot
// resolve, and the second also pulls in sweetalert2. Going through either
// would make this file untestable for reasons that have nothing to do with
// it. Same as RetentionWorkspace and TeamMonitorPage.
import AlertMessage from "../../shared/components/ui/AlertMessage";
import DashboardPanel from "../../shared/layout/dashboard/DashboardPanel";
import MeterRow from "../../shared/layout/dashboard/MeterRow";
import OverviewStatCards from "../../shared/layout/dashboard/OverviewStatCards";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import { currentTermBadge } from "../../shared/lib/currentTerm";
import { PRIORITY_ACCENT, PRIORITY_BANDS } from "../../shared/lib/priorityAccent";
import { getBackendUrl } from "../../shared/lib/url";

/*
 * What a faculty account sees when it logs in.
 *
 * Until now: an empty activity table reading "No activity yet." Faculty hold
 * `overview`, `reports`, `faculty_workspace` and `retention_cases`, and none of
 * those is `student_contacts` — so the snapshot that leads the caller and
 * KASAMA dashboards was correctly withheld from them and nothing took its
 * place. The landing page of the one role this portal exists to help said
 * nothing at all.
 *
 * It reads faculty_workspace.php — the same endpoint, the same classifier and
 * the same department scope the My Students board runs on, asked for in its
 * `?view=overview` shape. That is the whole design: the overview and the board
 * cannot disagree about how many students are in trouble, because the numbers
 * are one server-side count narrowed rather than a second one computed. The
 * overview is the glance; the board is the work.
 *
 * `?view=overview` returns the summary, the term, and the five students the
 * shortlist names — not the department. A full board is 2,776 rows and 2.4MB
 * of JSON, and this page exists to be opened every morning.
 *
 * WHY THIS ENDPOINT AND NOT pdo_priority.php
 *
 * Both classify the same students through pdo_priority_lib.php, and the PDO
 * board is a tab faculty can open. But only this one already scopes to the
 * caller's department without being asked, and only this one knows whether a
 * student has been spoken to IN THIS PERIODICAL — which is the number that
 * makes the page worth reloading. It is also the grant a faculty account most
 * certainly holds: the endpoint is gated on `faculty_workspace.view`, the same
 * permission that decides whether this component renders at all.
 */

/**
 * Priority 1-3: every student with something wrong.
 *
 * Mirrors PDO_FLAGGED_PRIORITIES in pdo_priority_lib.php, which is the
 * authority. Nothing here derives a priority — the server sends the number and
 * this only reads it.
 */
const FLAGGED_LEVELS = [1, 2, 3];

/**
 * How many students the shortlist names before it stops and counts the rest.
 *
 * Matches faculty_overview_shortlist_size() in lib/faculty_workspace.php, which
 * is what actually trims the payload. This is the slice that keeps the page
 * right when a FULL board response arrives instead — see the note on `waiting`
 * below — so the two only have to agree to keep the wire from carrying rows
 * this would throw away.
 */
const SHORTLIST_SIZE = 5;

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 11px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

/**
 * One student on the shortlist: band colour, name, and the rule that put them
 * there.
 *
 * `priority_reason` is the server's own sentence, produced by the same branch
 * order that decided the number — so the reason and the band can never
 * disagree. Composing a reason here from the three signal labels would be a
 * second implementation of the matrix in the browser.
 */
function ShortlistRow({ row }) {
  const level = Number(row?.priority);
  const accent = PRIORITY_ACCENT[level] || PRIORITY_ACCENT[4];
  return (
    <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
      <span
        aria-hidden="true"
        style={{ width: 4, alignSelf: "stretch", minHeight: 30, borderRadius: 999, background: accent, flex: "0 0 auto" }}
      />
      <div style={{ minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
          <span style={{ color: "var(--text-primary)", fontSize: 12.5, fontWeight: 600 }}>
            {row.student_name || row.student_number || "Unnamed student"}
          </span>
          {/* "Priority 1", not "P1" — the term badge at the top of this very
              page already spends "P1" on the periodical. */}
          <span style={{ color: "var(--text-faint)", fontSize: 10.5, whiteSpace: "nowrap" }}>
            {`Priority ${level}`}
            {row.section ? ` · ${row.section}` : ""}
          </span>
        </div>
        <div style={{ color: "var(--text-secondary)", fontSize: 11, marginTop: 2 }}>
          {row.priority_reason || row.segment || ""}
        </div>
      </div>
    </div>
  );
}

/**
 * @param {() => void} [onOpenWorkspace] jumps into Potential Drop Out, which
 *   opens on My Students for an account holding the workspace grant
 */
export default function FacultyOverview({ onOpenWorkspace }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [term, setTerm] = useState(null);
  const [scope, setScope] = useState(null);
  /*
   * The most recent periodical this term holds marks for, sent only when the
   * current one holds none. See the ungraded message below for why it matters.
   */
  const [latestGraded, setLatestGraded] = useState(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(async ({ background = false } = {}) => {
    const isCurrent = beginRequest();
    if (background) setRefreshing(true);
    else setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("faculty_workspace.php?view=overview"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load your students.");
      if (!isCurrent()) return;
      setRows(Array.isArray(json?.data) ? json.data : []);
      setSummary(json?.summary || null);
      setTerm(json?.term || null);
      setScope(json?.scope || null);
      setLatestGraded(json?.latest_graded_period ?? null);
    } catch (loadError) {
      if (!isCurrent()) return;
      // A background refresh keeps what is on screen. Blanking a working page
      // because one poll failed is worse than showing numbers a minute old.
      if (!background) {
        setRows([]);
        setSummary(null);
        setScope(null);
        setLatestGraded(null);
      }
      setError(loadError?.message || "Failed to load your students.");
    } finally {
      if (isCurrent()) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, [beginRequest]);

  useEffect(() => {
    void load();
  }, [load]);

  const total = Number(summary?.students ?? rows.length) || 0;
  /*
   * "P1", not 1. The endpoint sends the periodical as the integer the calendar
   * stores, and currentTermBadge is where every other screen turns that into
   * the word people read — including the term badge at the top of this very
   * page. Formatting it here instead is how one screen ends up saying
   * "Spoken to this 1".
   */
  const period = currentTermBadge(term).period;

  const priorityCounts = useMemo(() => ({
    1: Number(summary?.priority_1) || 0,
    2: Number(summary?.priority_2) || 0,
    3: Number(summary?.priority_3) || 0,
    4: Number(summary?.priority_4) || 0,
  }), [summary]);

  /*
   * Whose students, in one phrase.
   *
   * Three sentences on this page said "your department" and none of them said
   * which, or that the figures cover more than one campus — a department is one
   * row PER CAMPUS sharing a code, so a CITE account's board is Carmen AND
   * Puerto. Nobody would guess that from the department's name alone, and it is
   * the sort of thing that gets found out by someone disputing a total.
   *
   * It is not an OverviewHeader `scope` chip, which is where a dean's
   * department appears, only because the answer arrives inside this component's
   * own fetch: lifting it to GenericRoleDashboard would mean either a second
   * request or the dashboard guessing from `user.department_name`. That guess
   * is the trap — callers carry a department on their user row and are NOT
   * scoped by it, so the same chip over a caseload snapshot would be false.
   */
  const scopeLine = useMemo(() => {
    const name = String(scope?.department_name || "").trim();
    if (!name) return "";
    const campuses = Number(scope?.campus_count) || 0;
    return campuses > 1 ? `${name} · all ${campuses} campuses` : name;
  }, [scope]);

  const flagged = priorityCounts[1] + priorityCounts[2] + priorityCounts[3];
  /*
   * DEALT WITH, not spoken to — `contacted`, the PDO board's number, counting
   * conversations that concluded something.
   *
   * `contacted_this_period` is still in the summary and counts every attempt,
   * which is the right answer to "did the calling happen" and the wrong one
   * here: a student who said "Undecided — for follow up" is still on the board
   * and still on the shortlist below, so counting them as done would make this
   * card contradict the panel beside it.
   */
  const contacted = Number(summary?.contacted) || 0;
  const outstanding = Number(summary?.outstanding) || 0;
  const unassessed = Number(summary?.unassessed) || 0;
  /*
   * How many of them nobody has recorded attendance for this periodical.
   *
   * Counted server-side off `attendance_colour`, which is null exactly when
   * there is no record. It matters more than the grade equivalent because an
   * empty attendance column does not LOOK empty: the matrix has two attendance
   * values and no third, so a student nobody has recorded classifies as
   * attending -- and until the label was fixed, printed as it too.
   */
  const unrecordedAttendance = Number(summary?.unrecorded_attendance) || 0;
  /*
   * The board has nothing to judge anybody on.
   *
   * Every student is classified, so a periodical with no grades encoded does
   * not produce an empty screen — it produces a full one where everybody is
   * Priority 4, by the matrix's "Attending, nothing else recorded" rule. It is
   * the state every periodical opens in, which makes it common rather than
   * exotic: the calendar rolled to P2 on 20 Sep 2026 and this is exactly what
   * the department looked like that morning.
   *
   * Whole-board only. A department that is nine-tenths ungraded still has a
   * tenth the board CAN speak for, and "nobody is flagged" is the honest
   * reading of that tenth.
   */
  const nothingGradedYet = total > 0 && unassessed >= total;

  /*
   * The same state for attendance, and it is the common one right now: the
   * board asks for the CURRENT periodical, and attendance is imported per
   * periodical, so the whole column is empty from the moment the calendar
   * rolls over until somebody uploads.
   */
  const noAttendanceYet = total > 0 && unrecordedAttendance >= total;

  /*
   * What to say about it, and why it is not just "nothing is graded yet".
   *
   * One click away is the Potential Drop Outs tab, which defaults `?period=` to
   * null — and pdo_priority_lib reads that as "the latest periodical on
   * record". So on the morning a periodical rolls over, this screen reports
   * nobody at risk while the tab beside it ranks the same students on last
   * periodical's marks. Both are deliberate: My Students is for acting in the
   * term in progress, the board is for who is at risk on their most recent
   * marks. Seen together and unexplained, they read as one of the two being
   * broken.
   *
   * So the sentence names where the marks are. It does not reconcile the two
   * screens — that is a decision about what the faculty board is FOR, not a
   * wording problem — it stops the reader having to guess which one to believe.
   */
  const ungradedMessage = useMemo(() => {
    const here = period ? ` for ${period}` : "";
    const elsewhere = [1, 2, 3].includes(Number(latestGraded)) ? `P${Number(latestGraded)}` : "";
    const base = `No grades are encoded${here} yet, so nobody can be flagged.`;
    if (elsewhere && elsewhere !== period) {
      return `${base} The most recent marks on record are ${elsewhere}'s — Potential Drop Outs still ranks on those.`;
    }
    return `${base} This fills in once the periodical's grades are in.`;
  }, [latestGraded, period]);

  const statCards = useMemo(() => ([
    // Not the department name again — the line under the heading already says
    // it, and a card repeating it reads as a second, narrower scope.
    { label: "My Students", value: total, meta: "Everyone in your department" },
    {
      label: "Potential drop outs",
      value: flagged,
      // Red only when the College-owned band is occupied. An amber card for a
      // board that is all Priority 3 would cry wolf every term.
      tone: priorityCounts[1] > 0 ? "danger" : flagged > 0 ? "warning" : "default",
      /*
       * A zero here is the loudest all-clear on the page, and it is not one
       * while a whole signal is missing — it means nothing has been measured.
       *
       * Both signals get named, because they go missing for different reasons
       * and at different times: grades wait on encoding at the end of a
       * periodical, attendance on an upload at the start of one.
       */
      meta: nothingGradedYet && noAttendanceYet
        ? "No grades or attendance yet — not an all-clear"
        : nothingGradedYet
          ? "Nothing graded yet — not an all-clear"
          : noAttendanceYet
            ? "No attendance recorded yet — not an all-clear"
            : "Priority 1 to 3",
    },
    {
      label: "Not graded yet",
      value: unassessed,
      meta: "Waiting on encoding, not on a decision",
    },
    {
      label: period ? `Dealt with this ${period}` : "Dealt with this periodical",
      value: contacted,
      tone: "success",
      progress: total > 0 ? Math.round((contacted / total) * 100) : 0,
      // The board's own tile says the same pair. An Undecided outcome raises
      // neither number, which is the point of counting them separately.
      meta: outstanding > 0 ? `${outstanding.toLocaleString()} still to speak to` : "",
    },
  ]), [contacted, flagged, noAttendanceYet, nothingGradedYet, outstanding, period, priorityCounts, total, unassessed]);

  /*
   * Who to open first: flagged, and not yet spoken to in this periodical.
   *
   * Both halves matter. Priority alone repeats the same five names every day
   * however much calling gets done, which is how a shortlist stops being read;
   * `periodical_contact` is what lets the list empty out as the work happens,
   * and it resets when the calendar moves to the next periodical because a P1
   * conversation is not an answer about P2.
   *
   * `?view=overview` already applies exactly this rule and sends back only the
   * handful, so against that payload the filter and sort below are a no-op.
   * They are kept because the same component renders correctly against a full
   * board response — which is what a mistaken `view=` typo, an older backend,
   * or a test feeding the whole thing would hand it — and a page that silently
   * shows five Priority 4 students as "who needs you" is worse than one that
   * costs a filter over five rows.
   */
  const waiting = useMemo(() => (
    rows
      .filter((row) => FLAGGED_LEVELS.includes(Number(row?.priority)) && !row?.periodical_contact)
      .sort((a, b) => Number(a.priority) - Number(b.priority))
  ), [rows]);

  const shortlist = waiting.slice(0, SHORTLIST_SIZE);
  /*
   * How many are waiting in total, which the shortlist cannot know once the
   * payload is trimmed to five. Falls back to what arrived, so a full-board
   * response still counts correctly.
   */
  const waitingTotal = Math.max(Number(summary?.flagged_waiting ?? waiting.length) || 0, shortlist.length);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
        <div>
          <h3 style={{ margin: 0, color: "var(--text-primary)" }}>My students right now</h3>
          <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
            Grades, attendance and balance reduced to one priority each.
            {period ? ` Contacts are counted for ${period} only.` : ""}
          </p>
          {scopeLine ? (
            <p style={{ margin: "3px 0 0", color: "var(--text-faint)", fontSize: 10.5 }}>{scopeLine}</p>
          ) : null}
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button
            type="button"
            onClick={() => void load({ background: rows.length > 0 })}
            disabled={loading || refreshing}
            style={{ ...buttonStyle, background: "var(--border-base)", color: "var(--text-primary)", opacity: loading || refreshing ? 0.7 : 1 }}
          >
            {loading || refreshing ? "Refreshing..." : "Refresh"}
          </button>
          {onOpenWorkspace ? (
            <button type="button" onClick={onOpenWorkspace} style={{ ...buttonStyle, background: "var(--brand-700)", color: "#fff" }}>
              Open My Students →
            </button>
          ) : null}
        </div>
      </div>

      {error ? <AlertMessage tone="error" message={error} /> : null}

      <OverviewStatCards items={statCards} minWidth={200} />

      {loading && rows.length === 0 ? (
        <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
          Loading your students...
        </DashboardPanel>
      ) : total === 0 ? (
        <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
          No students are recorded against {scopeLine || "your department"} yet. Nothing here is
          broken — this page fills in once a roster is imported for the current term.
        </DashboardPanel>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 300px), 1fr))", gap: 12 }}>
          <DashboardPanel>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <h4 style={{ margin: 0, color: "var(--text-primary)", fontSize: 14 }}>Priority mix</h4>
                <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11 }}>
                  How your department falls across the four bands. Warmest is most urgent.
                </p>
              </div>
              <div style={{ display: "grid", gap: 9 }}>
                {PRIORITY_BANDS.map((band) => (
                  <MeterRow
                    key={band.level}
                    accent={band.accent}
                    label={band.label}
                    hint={band.owner}
                    value={priorityCounts[band.level]}
                    total={total}
                  />
                ))}
              </div>
              {/*
                Set apart from the four bands, because it is not a fifth one.
                A missing grade has decided no priority since 2026-09-12, so
                these students sit wherever attendance and balance put them —
                mostly Priority 4, where nothing is known — and this count will
                routinely exceed Priority 1 rather than being a slice of it.
              */}
              {unassessed > 0 || unrecordedAttendance > 0 ? (
                <div style={{ display: "grid", gap: 4, color: "var(--text-muted)", fontSize: 10.5, borderTop: "1px solid var(--border-base)", paddingTop: 8 }}>
                  {unassessed > 0 ? (
                    <p style={{ margin: 0 }}>
                      {nothingGradedYet
                        ? `None of these ${unassessed} students has grades encoded${period ? ` for ${period}` : ""} yet, which is why they all sit in Priority 4 — the band for "nothing is known".`
                        : `${unassessed} of these have no grades encoded yet, spread across the bands. They are ranked on attendance and balance alone.`}
                    </p>
                  ) : null}
                  {/*
                    Said separately from the grades line, and in the same place,
                    because a reader who knows one signal is missing will assume
                    the others are present. Until the board learned to say "No
                    attendance data" it actively encouraged that: the column read
                    "Attending" in full, for every student, off no rows at all.
                  */}
                  {unrecordedAttendance > 0 ? (
                    <p style={{ margin: 0 }}>
                      {noAttendanceYet
                        ? `No attendance has been recorded${period ? ` for ${period}` : ""} for any of them. The attendance column reads "No attendance data" rather than a rate, and it is deciding nobody’s priority.`
                        : `${unrecordedAttendance} of these have no attendance recorded${period ? ` for ${period}` : ""} yet.`}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </div>
          </DashboardPanel>

          <DashboardPanel>
            <div style={{ display: "grid", gap: 10 }}>
              <div>
                <h4 style={{ margin: 0, color: "var(--text-primary)", fontSize: 14 }}>Start with these</h4>
                <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11 }}>
                  Flagged, and not spoken to yet{period ? ` in ${period}` : ""}.
                </p>
              </div>

              {waiting.length === 0 ? (
                <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                  {/*
                    Three different silences, and only one of them is good news.
                    The board says "nobody is flagged" whenever no student is in
                    Priority 1 to 3 — which is also what it says when it has
                    nothing to judge anybody on. That is the state a new
                    periodical opens in: the calendar moves, the grades for it
                    have not been encoded, and every student falls to Priority 4
                    on the matrix's own "nothing to go on" rule. Reading that as
                    "my department is fine" is the single most expensive way to
                    misread this page, so it does not get to look like the
                    sentence that means it.
                  */}
                  {flagged > 0
                    ? "Every flagged student has been spoken to this periodical. Nothing waiting."
                    : nothingGradedYet
                      ? ungradedMessage
                      : "Nobody is flagged in your department right now."}
                </DashboardPanel>
              ) : (
                <div style={{ display: "grid", gap: 10 }}>
                  {shortlist.map((row) => (
                    <ShortlistRow key={row.student_id} row={row} />
                  ))}
                  {waitingTotal > shortlist.length ? (
                    <p style={{ margin: 0, color: "var(--text-muted)", fontSize: 10.5 }}>
                      {`and ${waitingTotal - shortlist.length} more waiting.`}
                    </p>
                  ) : null}
                </div>
              )}
            </div>
          </DashboardPanel>
        </div>
      )}
    </div>
  );
}
