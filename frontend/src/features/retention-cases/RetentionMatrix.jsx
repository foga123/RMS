import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateTime } from "../../shared/lib/dateTime";
import Modal from "../../shared/components/Modal/Modal";
import { getBackendUrl } from "../../shared/lib/url";
import { currentTermPeriodFilter, useCurrentTerm } from "../../shared/lib/currentTerm";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import Card from "../../shared/components/ui/Card";
import Badge from "../../shared/components/ui/Badge";
import { toRoman, yearLevelLabel } from "../../shared/lib/yearLevel";
import { cellBase, countButton, headBase, percentHead, sharePercent } from "../../shared/components/matrix/matrixStyles";
import { campusShortLabel } from "../../shared/lib/scopeOptionLabels";
import { enrollmentStatusKind, splitStatusGroup } from "../../shared/lib/enrollmentStatusKind";

/**
 * Retention matrix: where last term's enrolled students ended up.
 *
 * Rows are enrollment outcomes, columns are year levels. The baseline row is
 * the cohort — students who held an "Enrolled" status in the previous term —
 * and every percentage uses that column's cohort as the denominator. That is
 * what "vs 100% retention" means: 100% would be every student from last term
 * still enrolled.
 *
 * Every count is a button. A number nobody can open is a figure you have to
 * take on faith, and the first question anyone asks a retention report is
 * "which students are those?"
 */

/** Kept as a local name because the column headers read better unqualified. */
const yearLabel = toRoman;


/*
 * One signal, stated as a verdict with the numbers behind it.
 *
 * Built on the shared Card rather than a hand-rolled box: Card is the only
 * container in the design system, so a page that invents its own loses the
 * hairline border, the shadow and the padding scale everything else shares.
 *
 * The verdict comes from the server, not from thresholds re-derived here. The
 * same thresholds decide the student's risk score, and a second copy in the
 * browser is how a card starts disagreeing with the number beside it.
 */
/** Two letters for the avatar, or a dash when there is no name to shorten. */
function initialsOf(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "-";
  const first = parts[0][0] || "";
  const last = parts.length > 1 ? parts[parts.length - 1][0] || "" : "";
  return (first + last).toUpperCase();
}

const SIGNAL_TONES = { bad: "danger", warn: "warning", ok: "success", none: "neutral" };

function SignalCard({ label, verdict, detail, tone }) {
  return (
    <Card padding="sm" style={{ display: "grid", gap: 5, alignContent: "start" }}>
      <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-faint)" }}>
        {label}
      </div>
      <Badge tone={SIGNAL_TONES[tone] || "neutral"}>{verdict}</Badge>
      {detail ? (
        <div style={{ fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{detail}</div>
      ) : null}
    </Card>
  );
}

/** The share, set small and quiet so the count stays the thing you read first. */
const shareStyle = { fontSize: 9.5, color: "#64748b", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" };

/*
 * The height every cell reserves, whatever is in it.
 *
 * A cell holding a number contains a button, and countButton carries a 24px
 * min-height for the WCAG target size. A cell holding a plain 0 was bare text
 * and collapsed to its line box -- so on a grid that is mostly zeros, the few
 * rows carrying numbers stood taller than the rest and the table looked
 * buckled. Both branches sit in the same box now.
 */
/*
 * The shared cell, narrowed for this screen only.
 *
 * Nine numeric columns pay the horizontal padding nine times, and the last
 * of them (UPPER) was being clipped at the panel border -- scrollable, but a
 * cut-off final column reads as broken rather than as scrollable. 6px to 4px
 * buys back about 36px, which is the column.
 *
 * Local rather than edited into matrixStyles: that file is shared with the
 * year-level migration grid, which has four columns, no crowding and no
 * reason to have its spacing changed from here.
 */
const tightCell = { ...cellBase, padding: "5px 4px" };
const valueBox = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  // 3px, not 4: nine columns of "1172 100%" overran the panel and the last
  // one (UPPER) was cut off at the border. The gap is paid nine times per row.
  gap: 3,
  minHeight: 24,
};

/**
 * One cell: how many, and what share of the cohort, side by side.
 *
 * These were two whole grids drawn one beside the other — the same rows, once
 * in counts and once in percent. "12 did not enrol" and "that is 40% of Year
 * IV" are the same fact, and reading them together meant finding the same row
 * twice. One cell carries both now, so the eye never has to travel.
 *
 * The count stays the only clickable part. The share is derived from it, so a
 * second target in the same cell would open the same student list twice.
 */
function ValueCell({ value, base, tone = "#047857", emphasis = false, onOpen = null }) {
  const share = sharePercent(value, base);

  /*
   * A real zero, kept visible rather than blanked.
   *
   * An empty cell reads as "not loaded"; a 0 reads as "none of them", which is
   * the answer. Its share is dropped because "0 0%" is two ways of saying
   * nothing and only adds noise to a grid that is mostly zeros.
   */
  if (!value) {
    return (
      <td style={tightCell}>
        <span style={{ ...valueBox, color: "#cbd5e1" }}>0</span>
      </td>
    );
  }

  return (
    <td style={tightCell}>
      <span style={valueBox}>
        {onOpen ? (
          <button
            type="button"
            onClick={onOpen}
            title="View these students"
            style={{ ...countButton, fontWeight: emphasis ? 700 : 600, color: tone }}
          >
            {value}
          </button>
        ) : (
          <span style={{ fontWeight: emphasis ? 700 : 600, color: tone }}>{value}</span>
        )}
        {share === null ? null : <span style={shareStyle}>{share}%</span>}
      </span>
    </td>
  );
}

/** The columns every matrix row ends with, so the two tables cannot drift apart. */
function MatrixHead({ years, firstColumn }) {
  return (
    <thead>
      {/*
        * The green band, on both tables.
        *
        * percentHead was written for the old percentage grid and went unused
        * when counts and shares merged into one cell. It is the right style to
        * bring back: #047857 measures 5.48:1 against white, so the header text
        * clears AA at normal weight -- the brand green one step lighter is
        * 3.77:1, which only passes for large text, and a header is not large.
        */}
      <tr>
        <th style={{ ...percentHead, textAlign: "left", minWidth: 118 }}>{firstColumn}</th>
        {years.map((year) => (
          <th key={`h_${firstColumn}_${year}`} style={percentHead}>{yearLabel(year)}</th>
        ))}
        <th style={percentHead}>TOTAL</th>
        <th style={percentHead}>UPPER</th>
      </tr>
    </thead>
  );
}

/*
 * The bordered box the grid sits in.
 *
 * flex:1 inside a stretched column is what makes the two tables finish level.
 * The outcome table has fifteen rows and the department table has seven, so
 * left to themselves the two bordered boxes ended at different heights and the
 * pair read as broken rather than as two lists of different lengths.
 */
const tableShell = {
  overflowX: "auto",
  border: "1px solid #e2e8f0",
  borderRadius: 8,
  background: "#fff",
  flex: 1,
};

/** Each table is a column: caption, then a box that takes the rest of the height. */
/*
 * Alternating row tint.
 *
 * These grids are wide -- seven columns of digits -- and a reader carrying
 * their eye from a status on the left to the UPPER column on the right had
 * nothing holding the line. The tint is very faint on purpose: enough to keep
 * the row, not enough to read as a highlight or to fight the amber the
 * variance row uses to mean something.
 */
/*
 * The row label: one line, always.
 *
 * "WFR (Waiting for Response)" is long enough to wrap in a column this
 * narrow, and a wrapped label makes that one row twice the height of its
 * neighbours -- which is the buckled look, arriving from the other side of
 * the table after the value cells were evened out. Clipped with an ellipsis
 * instead; the full text is on the cell title, and the part that identifies
 * the row ("WFR", "CBR") leads, so the clipped tail is the expansion.
 */
const labelCell = {
  ...tightCell,
  textAlign: "left",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 134,
};
const zebra = (index) => (index % 2 === 1 ? { background: "#fbfcfd" } : undefined);
const tableColumn = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
  minWidth: 0,
};

/** A table's heading and the line under it that says how to read the cells. */
function TableCaption({ title, hint }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
      <strong style={{ fontSize: 11, color: "#0f172a" }}>{title}</strong>
      <span style={{ fontSize: 10.5, color: "#94a3b8" }}>{hint}</span>
    </div>
  );
}

/**
 * Where last term's students ended up, by outcome.
 *
 * Every percentage divides by its OWN column's baseline — Year II against the
 * Year II cohort, not against the whole school. A single institution-wide
 * denominator would make a small year level look like a rounding error.
 */
function MatrixTable({ years, baseline, rows, columnTotals, variance, hasVariance, openDrill }) {
  return (
    <div style={tableColumn}>
      <TableCaption
        title="By outcome"
        hint="count and share of that year's cohort — click any number to see the students"
      />

      <div style={tableShell}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 404 }}>
          <MatrixHead years={years} firstColumn="Status" />

          <tbody>
            {/* The cohort every percentage is measured against, so it is 100% of itself. */}
            <tr style={{ background: "#f1f5f9" }}>
              <td style={{ ...labelCell, fontWeight: 700, color: "#0f172a" }}>Enrolled last sem</td>
              {years.map((year, index) => (
                <ValueCell
                  key={`b_${year}`}
                  value={baseline.by_year[index]}
                  base={baseline.by_year[index]}
                  tone="#334155"
                  emphasis
                  onOpen={() => openDrill({ statusId: null, statusName: "Enrolled last sem", yearLevel: year })}
                />
              ))}
              <ValueCell
                value={baseline.total}
                base={baseline.total}
                tone="#334155"
                emphasis
                onOpen={() => openDrill({ statusId: null, statusName: "Enrolled last sem" })}
              />
              <ValueCell
                value={baseline.upper_years}
                base={baseline.upper_years}
                tone="#334155"
                emphasis
                onOpen={() => openDrill({ statusId: null, statusName: "Enrolled last sem", upperYears: true })}
              />
            </tr>

            {rows.map((row, index) => {
              /*
               * Re-enrolment is the good outcome; everything else is attrition.
               *
               * Attrition is amber rather than red. Red is the colour this app
               * uses for a fault — a failed request, a destructive action — and
               * on this grid it was carrying half the rows of an ordinary
               * report, which both alarms the reader about normal numbers and
               * spends the strongest colour available before anything is
               * actually wrong. Amber reads as "look here" without that.
               */
              const kind = enrollmentStatusKind(row.status_name);
              const isRetained = kind === "continuing" || kind === "graduating";
              const tone = isRetained ? "#047857" : "#b45309";

              /*
               * Six statuses share the "Will not continue - " prefix, and this
               * cell clips to one line - so all six would read "Will not
               * continue - ..." and nothing else. The family gets one heading
               * row and each status is labelled by what follows the dash; the
               * full name stays on the title and in the drill-down.
               */
              const split = splitStatusGroup(row.status_name);
              const previous = index > 0 ? splitStatusGroup(rows[index - 1].status_name) : null;
              const opensGroup = split && (!previous || previous.group !== split.group);
              const label = (split ? split.detail : row.status_name) + (row.retired ? " (retired)" : "");
              const title = row.retired
                ? `${row.status_name} - retired on the new list; these records were filed before it changed`
                : row.status_name;

              return (
                <React.Fragment key={row.status_id}>
                {opensGroup ? (
                  <tr>
                    <td
                      colSpan={years.length + 3}
                      style={{ ...labelCell, maxWidth: "none", fontWeight: 700, color: "#334155", background: "#f8fafc", fontSize: 10.5 }}
                    >
                      {split.group}
                    </td>
                  </tr>
                ) : null}
                <tr style={zebra(index)}>
                  <td
                    style={{ ...labelCell, color: row.retired ? "#94a3b8" : "#334155", ...(split ? { paddingLeft: 14 } : {}) }}
                    title={title}
                  >
                    {label}
                  </td>
                  {years.map((year, index) => (
                    <ValueCell
                      key={`${row.status_id}_${year}`}
                      value={row.counts[index]}
                      base={baseline.by_year[index]}
                      tone={tone}
                      onOpen={() => openDrill({ statusId: row.status_id, statusName: row.status_name, yearLevel: year })}
                    />
                  ))}
                  <ValueCell
                    value={row.total}
                    base={baseline.total}
                    tone={tone}
                    onOpen={() => openDrill({ statusId: row.status_id, statusName: row.status_name })}
                  />
                  <ValueCell
                    value={row.upper_years}
                    base={baseline.upper_years}
                    tone={tone}
                    onOpen={() => openDrill({ statusId: row.status_id, statusName: row.status_name, upperYears: true })}
                  />
                </tr>
                </React.Fragment>
              );
            })}

            <tr style={{ background: "#f8fafc" }}>
              <td style={{ ...labelCell, color: "#0f172a", fontWeight: 700 }}>Total</td>
              {years.map((year, index) => (
                <ValueCell
                  key={`t_${year}`}
                  value={columnTotals.by_year[index]}
                  base={baseline.by_year[index]}
                  tone="#0f172a"
                  emphasis
                />
              ))}
              <ValueCell value={columnTotals.total} base={baseline.total} tone="#0f172a" emphasis />
              <ValueCell value={columnTotals.upper_years} base={baseline.upper_years} tone="#0f172a" emphasis />
            </tr>

            {/* Variance is the cohort minus everything accounted for. Non-zero
                means students from last term have no status recorded this term
                — a data gap, not a rounding artefact, so it stays visible. */}
            <tr style={{ background: hasVariance ? "#fffbeb" : "#ffffff" }}>
              <td style={{ ...labelCell, color: hasVariance ? "#b45309" : "#94a3b8" }}>
                No status recorded
              </td>
              {years.map((year, index) => (
                <ValueCell key={`v_${year}`} value={variance.by_year[index]} base={baseline.by_year[index]} tone="#b45309" />
              ))}
              <ValueCell value={variance.total} base={baseline.total} tone="#b45309" />
              <ValueCell value={variance.upper_years} base={baseline.upper_years} tone="#b45309" />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

/**
 * The same cohort again, by where the students are rather than by what became
 * of them: departments, or the courses inside one when a single department is
 * already in scope — which is what a dean sees, being pinned to one.
 *
 * Shares divide by the same year's cohort the outcome table divides by, so a
 * column here adds to 100% and a percentage means the same thing in both
 * tables. That is what makes them readable side by side.
 */
function GroupTable({ years, baseline, groups, dimension, openDrill }) {
  /*
   * The campus is printed only where it tells two rows apart.
   *
   * Every row carries one, and spelling out "PHINMA Cagayan de Oro College -
   * Carmen Campus" under all seven put forty characters of identical text on a
   * grid whose job is numbers -- and the one distinction that mattered, CITE
   * Carmen against CITE Puerto, was buried in the middle of it. So the campus
   * appears on the codes that repeat and nowhere else, which is the same rule
   * scopeOptionLabels applies to the scope dropdowns.
   *
   * The full name stays on the cell title, so hovering still answers it.
   */
  const repeated = useMemo(() => {
    const seen = new Map();
    for (const group of groups) {
      const key = String(group.group_code || group.group_name || "").toUpperCase();
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    return seen;
  }, [groups]);

  const campusOf = (group) => {
    const key = String(group.group_code || group.group_name || "").toUpperCase();
    if ((repeated.get(key) || 0) < 2) return "";
    return campusShortLabel(group, null);
  };

  if (!groups.length) return null;
  const isCourse = dimension === "course";

  return (
    <div style={tableColumn}>
      <TableCaption
        title={isCourse ? "By course" : "By department"}
        hint="count and share of that year's cohort — click any number to see the students"
      />

      <div style={tableShell}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 404 }}>
          <MatrixHead years={years} firstColumn={isCourse ? "Course" : "Department"} />

          <tbody>
            {groups.map((group, index) => (
              <tr key={group.group_id} style={zebra(index)}>
                {/*
                 * Code over name, with the campus under it.
                 *
                 * The same college — and the same course inside it — has a row
                 * per campus, so the name alone repeats and two rows read
                 * identically. The campus is the part that tells them apart, so
                 * it gets its own line rather than a long run-on label.
                 */}
                <td style={{ ...labelCell, color: "#334155" }} title={group.label}>
                  <span style={{ fontWeight: 600 }}>{group.group_code || group.group_name}</span>
                  {campusOf(group) ? (
                    <span style={{ color: "#94a3b8", fontWeight: 400 }}> · {campusOf(group)}</span>
                  ) : null}
                </td>
                {years.map((year, index) => (
                  <ValueCell
                    key={`${group.group_id}_${year}`}
                    value={group.counts[index]}
                    base={baseline.by_year[index]}
                    tone="#0f766e"
                    onOpen={() => openDrill({ statusName: group.label, yearLevel: year, group, dimension })}
                  />
                ))}
                <ValueCell
                  value={group.total}
                  base={baseline.total}
                  tone="#0f766e"
                  onOpen={() => openDrill({ statusName: group.label, group, dimension })}
                />
                <ValueCell
                  value={group.upper_years}
                  base={baseline.upper_years}
                  tone="#0f766e"
                  onOpen={() => openDrill({ statusName: group.label, upperYears: true, group, dimension })}
                />
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/*
 * One student's standing, as a card that floats over the list it was opened
 * from.
 *
 * Floating rather than replacing the grid, because the list behind it is a work
 * queue: a caller opens a student, reads the four signals, closes, opens the
 * next. Replacing the view turned each of those into a navigation and back.
 */
function StudentDetailCard({ detail }) {
  if (!detail) return null;

  if (detail.loading) {
    return (
      <div style={{ padding: 16, textAlign: "center", color: "var(--text-muted)", fontSize: 11.5 }}>
        Loading student detail...
      </div>
    );
  }
  if (detail.error) {
    return (
      <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>
        {detail.error}
      </div>
    );
  }

  const d = detail.data;
  if (!d) return null;

  return (
    <div style={{ display: "grid", gap: 11 }}>
      {/*
        * The student, as a card rather than a run of pipe-separated text.
        * This is the header of the record a caller is about to act on, so
        * the identity gets the same container weight as the signals below.
        */}
      <Card accent padding="lg">
        <div style={{ display: "flex", gap: 13, alignItems: "flex-start", flexWrap: "wrap" }}>
          <div
            aria-hidden="true"
            style={{
              width: 46,
              height: 46,
              borderRadius: 999,
              background: "var(--brand-100)",
              color: "var(--brand-800)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              fontWeight: 700,
              fontSize: 14,
              flexShrink: 0,
            }}
          >
            {initialsOf(d.student.full_name)}
          </div>

          <div style={{ display: "grid", gap: 5, minWidth: 0, flex: 1 }}>
            <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
                {d.student.full_name || "Student"}
              </span>
              {d.student.student_type ? <Badge tone="brand">{d.student.student_type}</Badge> : null}
              {d.risk ? (
                <Badge tone={d.risk.level === "high" ? "danger" : d.risk.level === "moderate" ? "warning" : "neutral"}>
                  {`${d.risk.level} risk (stored evaluation)`}
                </Badge>
              ) : null}
            </div>

            <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              {d.student.student_number || "-"}
              {d.student.year_level ? ` | ${yearLevelLabel(d.student.year_level)}` : ""}
              {d.student.section ? ` | ${d.student.section}` : ""}
              {d.student.course_code ? ` | ${d.student.course_code}` : ""}
            </div>

            <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
              {d.student.department_name || "No department"}
            </div>

            {/* Contact details last and plainly, because this is the row a
                caller reads off the screen while dialling. */}
            <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
              {d.student.mobile_number || "No contact number"}
              {d.student.email_address ? `  |  ${d.student.email_address}` : ""}
            </div>
          </div>
        </div>
      </Card>

      {/* Which periodical the three cards below were read for. Without it the
          numbers read as the whole semester's, and during P1 they are not. */}
      {d.period ? (
        <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
          {`Grades, balance and attendance for ${d.period_label || `P${d.period}`} only.`}
        </div>
      ) : null}

      <div style={{ display: "grid", gap: 7, gridTemplateColumns: "repeat(auto-fit, minmax(min(238px, 100%), 1fr))" }}>
        <SignalCard
          label="Grades"
          verdict={d.grades.verdict}
          tone={!d.grades.has_record ? "none" : (d.grades.failed > 0 ? "bad" : "ok")}
          detail={d.grades.has_record
            ? `Passed ${d.grades.passed ?? "-"} of ${d.grades.total_subject ?? "-"}`
              + `  |  Failed ${d.grades.failed ?? 0}`
              + `  |  Incomplete ${d.grades.incomplete ?? 0}`
              + (d.grades.pass_rate != null ? `  |  ${d.grades.pass_rate}% pass rate` : "")
            : ""}
        />
        <SignalCard
          label="Finance"
          verdict={d.finance.verdict}
          tone={!d.finance.has_record ? "none" : (Number(d.finance.balance_amount) > 0 ? "warn" : "ok")}
          detail={d.finance.has_record
            ? `Balance ${Number(d.finance.balance_amount || 0).toLocaleString()}`
              + (d.finance.balance_unchanged ? "  |  unchanged since the last snapshot" : "")
            : ""}
        />
        <SignalCard
          label="Attendance"
          verdict={d.attendance.verdict}
          tone={!d.attendance.has_record ? "none" : (Number(d.attendance.absent_rate) >= 30 ? "bad" : "ok")}
          detail={d.attendance.has_record
            ? `Absent ${d.attendance.absent ?? "-"} of ${d.attendance.conducted ?? "-"} classes`
              + (d.attendance.absent_rate != null ? `  |  ${d.attendance.absent_rate}% absent` : "")
            : ""}
        />
        {/*
          * The survey card reports the ANSWER, not the fact of replying.
          * "Submitted" tells a caller nothing; "Will Enroll" or "To Stop" is
          * the reason they are or are not about to pick up the phone.
          */}
        <SignalCard
          label="Survey"
          verdict={
            !d.survey.submitted
              ? "No survey submitted"
              : (d.survey.answer_status || "Submitted, no enrolment answer")
          }
          tone={
            !d.survey.submitted
              ? "warn"
              : (d.survey.answer_status ? "ok" : "none")
          }
          detail={
            d.survey.submitted
              ? [
                  d.survey.answer_text ? `Answered: ${d.survey.answer_text}` : "",
                  d.survey.remark ? `"${d.survey.remark}"` : "",
                ].filter(Boolean).join("  |  ")
              : ""
          }
        />
      </div>

      {d.risk ? (
        <Card padding="md" style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-faint)" }}>
            Stored retention evaluation
          </div>
          <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--text-primary)", textTransform: "capitalize" }}>
            {d.risk.level} ({d.risk.score})
          </div>
          <div style={{ fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>{d.risk.reason || ""}</div>
          <p style={{ fontSize: 11, color: "var(--text-muted)" }}>Evaluated: {d.risk.evaluated_at ? formatDateTime(d.risk.evaluated_at) : "Date unavailable"}. Re-evaluate after records change.</p>
        </Card>
      ) : (
        <Card padding="md">
          <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
            No retention case has been evaluated for this student yet.
          </div>
        </Card>
      )}
    </div>
  );
}

export default function RetentionMatrix({ campusId = null, departmentId = null, courseId = null, schoolYearId = null, semesterId = null }) {
  const [matrix, setMatrix] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // A 403 is not an error worth shouting about: it means this viewer simply
  // cannot see retention data. An optional widget must never make the page it
  // sits on look broken, so it removes itself instead.
  const [forbidden, setForbidden] = useState(false);

  const [drill, setDrill] = useState(null); // { title, students, loading, truncated }
  /*
   * The second click. A cell names a group, the list names the people, and this
   * says why one of them is there — grades, balance and absences for the term.
   *
   * Held beside `drill` rather than replacing it, so closing the detail returns to
   * the list the caller was reading instead of dropping them back to the grid.
   */
  const [detail, setDetail] = useState(null); // { student, loading, error, data }

  /*
   * The periodical the drill-down reads.
   *
   * The grid itself is unaffected - an enrollment outcome is a decision about
   * next term, not a mark inside this one, so it has no periodical to be shown
   * for. The per-student panel does: it quotes the grades, balance and absences
   * the risk score was computed from, and during P1 those have to be P1's or the
   * panel and the score disagree about the same student.
   */
  const { term: currentTerm } = useCurrentTerm();
  const detailPeriod = currentTermPeriodFilter(currentTerm);

  // `load` lives inside the effect below, so the live probe re-runs it by
  // bumping this instead of holding a reference to it.
  const [reloadToken, setReloadToken] = useState(0);
  useLiveRefresh(["enrollment_status", "students"], () => setReloadToken((n) => n + 1), {
    enabled: !forbidden,
  });

  /*
   * Fetches one student's standing. Scope is re-checked server-side against the
   * same cohort the grid uses, so a student id typed by hand buys nothing: the
   * endpoint answers "Student not found" for anyone outside the caller's scope,
   * the same answer it gives for an id that does not exist.
   */
  const openDetail = useCallback(async (student) => {
    setDetail({ student, loading: true, error: "", data: null });
    try {
      const query = new URLSearchParams({
        action: "student_detail",
        student_id: String(student.student_id),
      });
      // The detail endpoint re-checks scope against the same cohort the grid
      // is built from, so it needs the same filters the grid was drawn with.
      if (campusId) query.set("campus_id", String(campusId));
      if (departmentId) query.set("department_id", String(departmentId));
      if (courseId) query.set("course_id", String(courseId));
      if (schoolYearId) query.set("school_year_id", String(schoolYearId));
      if (semesterId) query.set("semester_id", String(semesterId));
      if (detailPeriod) query.set("period", detailPeriod);

      const res = await fetch(getBackendUrl(`retention_matrix.php?${query.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load student detail");
      setDetail((current) => (current ? { ...current, loading: false, data: json?.data || null } : current));
    } catch (detailError) {
      setDetail((current) => (
        current ? { ...current, loading: false, error: detailError?.message || "Failed to load student detail" } : current
      ));
    }
  }, [campusId, courseId, departmentId, schoolYearId, semesterId, detailPeriod]);

  useEffect(() => {
    let active = true;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const query = new URLSearchParams();
        if (campusId) query.set("campus_id", String(campusId));
        if (departmentId) query.set("department_id", String(departmentId));
        if (courseId) query.set("course_id", String(courseId));
        if (schoolYearId) query.set("school_year_id", String(schoolYearId));
        if (semesterId) query.set("semester_id", String(semesterId));

        const res = await fetch(getBackendUrl(`retention_matrix.php?${query.toString()}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });

        if (res.status === 403 || res.status === 401) {
          if (!active) return;
          setForbidden(true);
          setMatrix(null);
          return;
        }

        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load the retention matrix");
        if (!active) return;
        setMatrix(json?.data || null);
      } catch (e) {
        if (!active) return;
        setMatrix(null);
        setError(e.message || "Failed to load the retention matrix");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [campusId, departmentId, courseId, schoolYearId, semesterId, reloadToken]);

  const openDrill = useCallback(
    async ({ statusId, statusName, yearLevel, upperYears, group = null, dimension = null }) => {
      const scopeLabel = yearLevel
        ? `Year ${yearLabel(yearLevel)}`
        : upperYears
          ? "Upper years"
          : "All year levels";
      setDrill({ title: `${statusName} — ${scopeLabel}`, students: [], loading: true, truncated: false });

      try {
        const query = new URLSearchParams({ action: "students" });
        if (campusId) query.set("campus_id", String(campusId));
        if (departmentId) query.set("department_id", String(departmentId));
        if (courseId) query.set("course_id", String(courseId));
        if (schoolYearId) query.set("school_year_id", String(schoolYearId));
        if (semesterId) query.set("semester_id", String(semesterId));
        /*
         * A cell from the department/course table narrows to its own row.
         *
         * Set after the page scope above so it overrides it, and only ever
         * narrower: the server re-applies dean pinning to whatever arrives, so
         * a group id from outside the caller’s scope cannot widen the list.
         */
        if (group && dimension === "course") query.set("course_id", String(group.group_id));
        else if (group && dimension === "department") query.set("department_id", String(group.group_id));
        if (statusId) query.set("status_id", String(statusId));
        if (yearLevel) query.set("year_level", String(yearLevel));
        if (upperYears) query.set("upper_years", "1");

        const res = await fetch(getBackendUrl(`retention_matrix.php?${query.toString()}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load students");
        setDrill((prev) =>
          prev
            ? {
                ...prev,
                loading: false,
                students: json?.data?.students || [],
                truncated: Boolean(json?.data?.truncated),
              }
            : prev
        );
      } catch (e) {
        setDrill((prev) => (prev ? { ...prev, loading: false, error: e.message } : prev));
      }
    },
    [campusId, departmentId, courseId, schoolYearId, semesterId]
  );

  const years = useMemo(() => matrix?.year_levels || [], [matrix]);

  if (forbidden) return null;
  if (loading) {
    return <div style={{ padding: 16, textAlign: "center", color: "#64748b", fontSize: 11.5 }}>Loading retention matrix...</div>;
  }
  if (error) {
    return <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>{error}</div>;
  }
  if (!matrix) return null;

  const { baseline, rows, column_totals: columnTotals, variance } = matrix;
  const groups = matrix.groups || [];
  const groupDimension = matrix.group_dimension || "department";
  const hasVariance = variance.total !== 0 || variance.by_year.some((n) => n !== 0);

  /*
   * A term nobody has recorded anything for yet.
   *
   * Picking a future school year used to draw a full grid, because the server
   * fell back to every student and to each student's last known status. It now
   * answers honestly with zeros, and this says why — otherwise a term with no
   * records and a term where every student vanished look identical on screen.
   */
  const termHasRecords = matrix.current_term?.has_records !== false;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, justifyContent: "space-between", alignItems: "baseline" }}>
        <div>
          <strong style={{ fontSize: 12.5, color: "#0f172a" }}>Retention Matrix</strong>
          <div style={{ fontSize: 10.5, color: "#64748b", marginTop: 2 }}>
            {/* Two different fallbacks reach the same grid, and they do not
                mean the same thing — one is "no history yet", the other is
                "nobody was recorded as enrolled". Saying which keeps the
                denominator honest. */}
            {!termHasRecords
              ? `No enrollment records have been entered for ${matrix.current_term?.label || "this sem"} yet.`
              : matrix.baseline_term?.is_fallback
                ? matrix.baseline_term?.fallback_reason === "no_enrolled_rows"
                  ? `No student has an "Enrolled" record for ${matrix.baseline_term?.label || "the previous sem"}, so every student in scope is the baseline instead. Percentages are against that.`
                  : "No earlier sem on record — showing all students in scope as the baseline."
                : `Students enrolled in ${matrix.baseline_term?.label || "the previous sem"}, and where they are in ${matrix.current_term?.label || "the current sem"}.`}
          </div>
        </div>
      </div>

      {!termHasRecords ? (
        <div
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 8,
            padding: 18,
            textAlign: "center",
            color: "#64748b",
            fontSize: 11.5,
            background: "#f8fafc",
          }}
        >
          Nothing to show for {matrix.current_term?.label || "this sem"}. Choose a sem that has enrollment records,
          or record this term's enrollment decisions first.
        </div>
      ) : (
        <>

      {/*
        * Two tables of the same cohort: what became of them, and where they are.
        *
        * They share a denominator — every cell in both is a share of its own
        * year’s cohort — so a reader can carry a percentage straight across.
        * Counts and percentages used to be the two tables here; they sit in one
        * cell now, which freed the second slot for a breakdown that answers a
        * different question: not what happened, but to whom.
        */}
      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(460px, 100%), 1fr))",
          alignItems: "stretch",
        }}
      >
        <MatrixTable
          years={years}
          baseline={baseline}
          rows={rows}
          columnTotals={columnTotals}
          variance={variance}
          hasVariance={hasVariance}
          openDrill={openDrill}
        />
        <GroupTable
          years={years}
          baseline={baseline}
          groups={groups}
          dimension={groupDimension}
          openDrill={openDrill}
        />
      </div>

      {hasVariance ? (
        <div style={{ fontSize: 10.5, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 8px" }}>
          {variance.total} student{variance.total === 1 ? "" : "s"} from last sem have no enrollment status recorded this
          sem. They are counted in the baseline but sit in no outcome row, so the percentages understate the picture
          until those statuses are entered.
        </div>
      ) : null}
        </>
      )}

      {/* Outside the branch above: the drill-down closes itself, and unmounting
          it mid-close would strand an open dialog. */}
      <Modal
        open={Boolean(drill)}
        title={drill?.title || "Students"}
        onClose={() => setDrill(null)}
        width={646}
      >
        {drill?.loading ? (
          <div style={{ padding: 12, textAlign: "center", color: "#64748b", fontSize: 11.5 }}>Loading students...</div>
        ) : drill?.error ? (
          <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>{drill.error}</div>
        ) : (drill?.students?.length ?? 0) === 0 ? (
          <div style={{ padding: 12, textAlign: "center", color: "#64748b", fontSize: 11.5 }}>No students in this cell.</div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 10.5, color: "#64748b" }}>
              {drill.students.length} student{drill.students.length === 1 ? "" : "s"}
              {drill.truncated ? " (showing the first 500)" : ""} — click a student for grades, balance and attendance
            </span>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...headBase, textAlign: "left" }}>Student No.</th>
                    <th style={{ ...headBase, textAlign: "left" }}>Name</th>
                    <th style={{ ...headBase, textAlign: "left" }}>Course</th>
                    <th style={headBase}>Year</th>
                    <th style={{ ...headBase, textAlign: "left" }}>Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.students.map((student) => (
                    <tr
                      key={student.student_id}
                      onClick={() => void openDetail(student)}
                      title="See grades, balance and attendance"
                      style={{ cursor: "pointer" }}
                    >
                      <td style={{ ...cellBase, textAlign: "left", color: "#0f172a" }}>{student.student_number || "-"}</td>
                      <td style={{ ...cellBase, textAlign: "left", color: "#047857", fontWeight: 600 }}>{student.full_name || "-"}</td>
                      <td style={{ ...cellBase, textAlign: "left", color: "#475569" }}>{student.course_code || student.course_name || "-"}</td>
                      <td style={{ ...cellBase, color: "#475569" }}>{toRoman(student.year_level) || "-"}</td>
                      <td style={{ ...cellBase, textAlign: "left", color: "#475569" }}>
                        {student.mobile_number || student.email_address || "-"}
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
        * The second click, floating above the first.
        *
        * Rendered after the list dialog so it paints on top of it, and closing
        * it leaves that list open underneath — the caller lands back on the row
        * they just read instead of at the grid, which is what makes working
        * down a cell of students one pass rather than a round trip each time.
        */}
      <Modal
        open={Boolean(detail)}
        title={detail?.student?.full_name || "Student"}
        onClose={() => setDetail(null)}
        width={724}
      >
        <StudentDetailCard detail={detail} />
      </Modal>
    </div>
  );
}
