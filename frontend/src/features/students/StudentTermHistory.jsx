import ExportMenu from "../../shared/components/ui/ExportMenu";
import { TABLE_EXPORT_FORMATS, exportTable } from "../../shared/lib/tableExport";
import React, { useCallback, useEffect, useState } from "react";
import Card from "../../shared/components/ui/Card";
import { getBackendUrl } from "../../shared/lib/url";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import {
  absenceReason,
  formatBalance,
  formatRate,
  historySpan,
  standingAtTerm,
  termLabel,
  withTrends,
} from "./studentHistory";

/**
 * One student, term by term.
 *
 * The data has been in the database the whole time — 2,352 grade rows for
 * 2025-2026 alone, and as many again for attendance and finance — but reading
 * one student across terms meant opening Grades, filtering to the term,
 * searching the number, and then doing it twice more in Attendance and Finance.
 * Nobody did that, so nobody looked at last semester.
 *
 * Newest term first, each one showing what was recorded and how it moved since
 * the term before it. The movement is the reason this exists: 84% attendance is
 * a number, 84% down from 90% is a reason to call someone.
 */

function ArrowUp() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 19V5M5 12l7-7 7 7" />
    </svg>
  );
}

function ArrowDown() {
  return (
    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12l7 7 7-7" />
    </svg>
  );
}

/**
 * The change since the term before, coloured by whether it is good news.
 *
 * Direction and judgement are separate: a falling balance is an up-arrow's
 * worth of good news, and colouring by direction alone would paint every
 * student who paid their fees in red.
 */
function Trend({ trend, format }) {
  if (!trend || trend.direction === "flat") return null;

  const tone =
    trend.better === null
      ? "var(--text-faint)"
      : trend.better
        ? "var(--brand-700)"
        : "var(--danger-800)";
  const magnitude = format ? format(Math.abs(trend.change)) : Math.abs(trend.change);

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 2, color: tone, fontSize: 10.5, fontWeight: 700 }}
      title={`${trend.direction === "up" ? "Up" : "Down"} ${magnitude} from the term before`}
    >
      {trend.direction === "up" ? <ArrowUp /> : <ArrowDown />}
      {magnitude}
    </span>
  );
}

/** One figure with its label, its movement, and the basis it was read on. */
function Figure({ label, value, trend, format, basis, muted }) {
  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-faint)" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 5, flexWrap: "wrap" }}>
        <span style={{ fontSize: 14, fontWeight: 700, color: muted ? "var(--text-faint)" : "var(--text-primary)" }}>
          {value ?? "—"}
        </span>
        <Trend trend={trend} format={format} />
      </div>
      {/* Which rows the figure was read from. Grades take the latest
          periodical and attendance sums all three, so two cards on the same
          term legitimately rest on different rows — saying so is cheaper than
          someone re-deriving it by hand and concluding the page is wrong. */}
      {basis ? <div style={{ fontSize: 10.5, color: "var(--text-faint)" }}>{basis}</div> : null}
    </div>
  );
}

function Block({ title, visible, data, children }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-base)",
        borderRadius: 8,
        padding: "7px 9px",
        background: "var(--surface-base)",
        display: "grid",
        gap: 6,
        alignContent: "start",
      }}
    >
      <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text-secondary)" }}>{title}</div>
      {data ? children : (
        <div style={{ fontSize: 10.5, color: "var(--text-faint)", lineHeight: 1.45 }}>{absenceReason(visible)}</div>
      )}
    </div>
  );
}

export default function StudentTermHistory({ studentId }) {
  const [state, setState] = useState({ status: "idle", payload: null, error: "" });

  const load = useCallback(async (id, signal) => {
    setState({ status: "loading", payload: null, error: "" });
    try {
      const response = await fetch(getBackendUrl(`student_history.php?student_id=${encodeURIComponent(id)}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
        signal,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload?.message || "Could not load this student's history.");
      setState({ status: "ready", payload, error: "" });
    } catch (loadError) {
      if (loadError?.name === "AbortError") return;
      setState({ status: "failed", payload: null, error: loadError?.message || "Could not load this student's history." });
    }
  }, []);

  useEffect(() => {
    if (!studentId) return undefined;
    const controller = new AbortController();
    void load(studentId, controller.signal);
    return () => controller.abort();
  }, [load, studentId]);

  if (!studentId) return null;

  const visibility = state.payload?.visibility || {};
  const terms = withTrends(state.payload?.terms || []);

  const exportHistory = (format) => {
    const student = state.payload?.student || {};
    const columns = [
      { key: "number", label: "Student number" }, { key: "name", label: "Student name" },
      { key: "term", label: "Term" }, { key: "standing", label: "Historical standing" },
      { key: "recorded", label: "Snapshot recorded" },
      ...(visibility.grades ? [{ key: "grades", label: "Grades" }] : []),
      ...(visibility.attendance ? [{ key: "attendance", label: "Attendance" }] : []),
      ...(visibility.finance ? [{ key: "balance", label: "Balance (PHP)" }] : []),
      ...(visibility.enrollment ? [{ key: "decision", label: "Enrollment decision" }, { key: "reason", label: "Enrollment reason" }] : []),
    ];
    exportTable(format, {
      filename: `student-history-${String(student.student_number || studentId).replace(/[^a-zA-Z0-9_-]/g, "_")}`,
      sheet: "Student History", columns,
      rows: terms.map((term) => {
        const standing = standingAtTerm(term);
        return {
          number: student.student_number, name: student.name, term: termLabel(term),
          standing: standing.recorded ? [standing.year_level ? yearLevelLabel(standing.year_level) : null, standing.section, standing.course_code].filter(Boolean).join(" / ") : "Standing at the time was not captured",
          recorded: standing.recorded_at || "",
          grades: visibility.grades ? (term.grades ? `${term.grades.passed}/${term.grades.total_subject} passed (${formatRate(term.grades.pass_rate)}); ${term.grades.basis || ""}` : "No record") : "",
          attendance: visibility.attendance ? (term.attendance ? `${formatRate(term.attendance.present_rate)} present; ${term.attendance.absent} absent; ${term.attendance.basis || ""}` : "No record") : "",
          balance: visibility.finance ? (term.finance?.balance ?? "No record") : "",
          decision: visibility.enrollment ? (term.enrollment?.decision || "No record") : "",
          reason: visibility.enrollment ? (term.enrollment?.reason || "") : "",
        };
      }),
    });
  };

  return (
    <Card padding="md" style={{ display: "grid", gap: 9, alignContent: "start" }}>
      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>Term history</h3>
        <ExportMenu options={TABLE_EXPORT_FORMATS} disabled={state.status !== "ready" || terms.length === 0} onSelect={exportHistory} />
        {state.status === "ready" && terms.length > 0 ? (
          <span style={{ fontSize: 10.5, color: "var(--text-faint)" }}>{historySpan(terms)}</span>
        ) : null}
      </div>

      {state.status === "loading" ? (
        <div style={{ fontSize: 11.5, color: "var(--text-faint)" }}>Reading past terms…</div>
      ) : null}

      {state.status === "failed" ? (
        <div style={{ fontSize: 11.5, color: "var(--danger-800)" }}>{state.error}</div>
      ) : null}

      {state.status === "ready" && terms.length === 0 ? (
        <div style={{ fontSize: 11.5, color: "var(--text-faint)", lineHeight: 1.5 }}>
          {/* Not "no history": the student may simply be new, and the two
              readings call for different actions. */}
          No grades, attendance, finance or enrolment have been recorded against this student in any term yet.
        </div>
      ) : null}

      {terms.map((term) => {
        const standing = standingAtTerm(term);

        return (
          <section
            key={`${term.school_year_id}:${term.semester_id}`}
            style={{
              border: "1px solid var(--border-base)",
              borderRadius: 9,
              background: "var(--surface-page)",
              padding: 9,
              display: "grid",
              gap: 8,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
              <span style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>{termLabel(term)}</span>
              {term.is_current_year ? (
                <span
                  style={{
                    fontSize: 10.5,
                    fontWeight: 700,
                    padding: "1px 6px",
                    borderRadius: 999,
                    background: "var(--brand-100)",
                    color: "var(--brand-800)",
                  }}
                >
                  Current year
                </span>
              ) : null}
              <span style={{ marginLeft: "auto", fontSize: 10.5, color: "var(--text-faint)" }}>
                {standing.recorded
                  ? [
                      standing.year_level ? yearLevelLabel(standing.year_level) : null,
                      standing.section,
                      standing.course_code,
                    ]
                      .filter(Boolean)
                      .join(" · ")
                  : /* Deliberately not today's year level. A student now in Year
                       4 has Year 2 rows from two years ago, and stamping the
                       current one onto them would be inventing a record. */
                    "Standing at the time was not captured"}
              </span>
            </div>

            <div style={{ display: "grid", gap: 7, gridTemplateColumns: "repeat(auto-fit, minmax(min(158px, 100%), 1fr))" }}>
              <Block title="Grades" visible={visibility.grades} data={term.grades}>
                <div style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1fr" }}>
                  <Figure
                    label="Pass rate"
                    value={formatRate(term.grades?.pass_rate)}
                    trend={term.trends.pass_rate}
                    format={(change) => `${Number(change.toFixed(2))} pts`}
                    basis={term.grades?.basis}
                  />
                  <Figure
                    label="Passed"
                    value={
                      term.grades && typeof term.grades.passed === "number"
                        ? `${term.grades.passed} of ${term.grades.total_subject ?? "?"}`
                        : null
                    }
                  />
                </div>
                {term.grades?.remark ? (
                  <div style={{ fontSize: 10.5, color: "var(--text-secondary)" }}>{term.grades.remark}</div>
                ) : null}
              </Block>

              <Block title="Attendance" visible={visibility.attendance} data={term.attendance}>
                <div style={{ display: "grid", gap: 6, gridTemplateColumns: "1fr 1fr" }}>
                  <Figure
                    label="Present"
                    value={formatRate(term.attendance?.present_rate)}
                    trend={term.trends.present_rate}
                    format={(change) => `${Number(change.toFixed(2))} pts`}
                    basis={term.attendance?.basis}
                  />
                  <Figure
                    label="Absences"
                    value={
                      term.attendance && typeof term.attendance.absent === "number"
                        ? `${term.attendance.absent} of ${term.attendance.total_classes_conducted}`
                        : null
                    }
                  />
                </div>
              </Block>

              <Block title="Finance" visible={visibility.finance} data={term.finance}>
                <Figure
                  label="Balance"
                  value={formatBalance(term.finance?.balance)}
                  trend={term.trends.balance}
                  format={(change) => formatBalance(change)}
                  basis={term.finance?.basis}
                  muted={term.finance?.balance === 0}
                />
              </Block>

              <Block title="Enrolment" visible={visibility.enrollment} data={term.enrollment}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)" }}>
                  {term.enrollment?.decision || "—"}
                </div>
                {term.enrollment?.reason ? (
                  <div style={{ fontSize: 10.5, color: "var(--text-secondary)", lineHeight: 1.45 }}>
                    {term.enrollment.reason}
                  </div>
                ) : null}
              </Block>
            </div>
          </section>
        );
      })}
    </Card>
  );
}
