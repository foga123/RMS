import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import Modal from "../../shared/components/Modal/Modal";
import { getBackendUrl } from "../../shared/lib/url";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { toRoman } from "../../shared/lib/yearLevel";
import { MATRIX_TONE, cellBase, countButton, headBase, percentHead, sharePercent } from "../../shared/components/matrix/matrixStyles";

/**
 * Year-level migration: who is in each year now, and where next sem takes them.
 *
 * Rows are the year a student is in today, columns are the decision recorded
 * for the coming sem, and the row header names the year the continuing ones
 * move into — "Year I -> II".
 *
 * IT IS A PROJECTION, AND THE CARD SAYS SO. `year_level` exists only on the
 * student row, as a single current value; no table records the year a student
 * held in a past sem. So "Year I became Year II" cannot be measured, only
 * derived from who is recorded as continuing. Drawing that as though it were
 * observed history is the one way this card could actively mislead, so the
 * basis is carried in the payload and printed under the title rather than left
 * to a reader's assumption.
 *
 * Two of the columns exist for the students who do not simply move up one:
 * "Final year" is sitting exactly on the course's year_duration, choosing
 * between graduating and another year; "Over-term" is already past it and
 * still finishing. A four-year course with sixth-year students in it is normal
 * and invisible in every other view.
 */

const TONE_COLOR = {
  good: MATRIX_TONE.good,
  warn: MATRIX_TONE.warn,
  bad: MATRIX_TONE.bad,
  none: MATRIX_TONE.none,
};

/**
 * One number and what share of its year it is.
 *
 * The two used to be two whole tables side by side, counts on the left and
 * percentages on the right. Four of the ten columns — the year label, the
 * cohort total, the moving-up rate — were identical in both, so the pair read
 * as the same table printed twice, and a reader comparing "how many" with "what
 * share" had to cross a gap and find the row again.
 *
 * Stacked in one cell, the comparison is vertical and free. The count leads
 * because it is the countable thing; the share is smaller and muted because it
 * is derived from the count and from the row total already on the line.
 */
function Cell({ value, base, tone, onOpen }) {
  const count = Number(value) || 0;
  const share = sharePercent(count, base);
  const color = TONE_COLOR[tone] || MATRIX_TONE.ink;

  // Zero is not clickable: there is nothing behind it to open, and a link that
  // opens an empty dialog teaches the reader not to trust the others.
  if (count === 0) {
    return <td style={{ ...cellBase, color: MATRIX_TONE.faint }}>0</td>;
  }

  const body = (
    <>
      {count}
      {share === null ? null : (
        <span style={{ display: "block", fontSize: 10.5, color: MATRIX_TONE.muted, fontWeight: 400 }}>
          {share}%
        </span>
      )}
    </>
  );

  if (!onOpen) {
    return <td style={{ ...cellBase, color, fontWeight: 600 }}>{body}</td>;
  }

  return (
    <td style={cellBase}>
      <button
        type="button"
        onClick={onOpen}
        title="View these students"
        style={{ ...countButton, fontWeight: 600, color }}
      >
        {body}
      </button>
    </td>
  );
}

/**
 * "Of this year, what share are moving up" — the number the matrix exists for.
 *
 * Measured against the students whose intention is on record, not against the
 * whole year. A Year I nobody has contacted yet would otherwise report 0%,
 * which reads as "none of them survive" when it means "none of them have been
 * asked" — the opposite conclusion from the same data. The base is printed
 * beside the rate so it is never read without knowing how thin it is.
 */
function SurvivalCell({ rate, decided, students, onOpen }) {
  if (rate === null || rate === undefined) {
    return (
      <td style={{ ...cellBase, color: MATRIX_TONE.faint }} title="Nobody in this year has a recorded decision yet">
        no data
      </td>
    );
  }

  /*
   * Green when healthy, amber otherwise — never red.
   *
   * A low progression rate on a sparse base is the normal state of this grid
   * early in a sem, and painting it red says "something has gone wrong" when
   * the truth is "the calls have not been made yet". Red stays reserved for
   * counts of outcomes that really are bad, which a rate is not.
   */
  const tone = rate >= 75 ? MATRIX_TONE.good : MATRIX_TONE.warn;
  const body = (
    <>
      {rate}%
      <span style={{ display: "block", fontSize: 10.5, color: MATRIX_TONE.muted, fontWeight: 400 }}>
        {`of ${decided} decided`}
        {decided < students ? ` / ${students}` : ""}
      </span>
    </>
  );

  // The rate opens the students it is a rate OF - the continuing ones - rather
  // than the denominator it is measured against. "Which students are moving up"
  // is the question a reader has when they click a progression rate.
  if (!onOpen || !rate) {
    return <td style={{ ...cellBase, color: tone, fontWeight: 700 }}>{body}</td>;
  }

  return (
    <td style={cellBase}>
      <button
        type="button"
        onClick={onOpen}
        title="View the students moving up"
        style={{ ...countButton, fontWeight: 700, color: tone }}
      >
        {body}
      </button>
    </td>
  );
}

/**
 * One grid, drawn as counts or as each year's own percentages.
 *
 * The denominator is the row, never the school: "of the students in Year I,
 * 67% are continuing" is the sentence a year-level table is read for. A
 * school-wide denominator would make every small year look negligible.
 */
/**
 * The grid, laid out like the retention matrix it sits beside.
 *
 * Year levels are the COLUMNS, in roman, and outcomes are the rows. It was the
 * other way round to begin with, which read as a different kind of report
 * entirely — the two are swapped by one dropdown, and a reader who has just
 * been looking at "I II III IV" across the top should not have to re-learn the
 * axes to answer the neighbouring question.
 *
 * Each header is the move itself — I-II, II-III, III-IV — so the column says
 * both which year it counts and where that year is headed, on the one line the
 * retention matrix beside it uses for a plain roman numeral.
 */
function MigrationGrid({ buckets, rows, totals, openDrill }) {
  return (
    <div style={{ display: "grid", gap: 5, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 11, color: MATRIX_TONE.ink }}>Students</strong>
        <span style={{ fontSize: 10.5, color: "#94a3b8" }}>
          count, with its share of that year underneath — newest decision per student this sem. Click any number for the
          students behind it.
        </span>
      </div>

      <div style={{ overflowX: "auto", border: `1px solid ${MATRIX_TONE.rule}`, borderRadius: 8, background: "#fff" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 408 }}>
          <thead>
            {/* The same green band the retention matrix uses, so the two grids
                a dropdown apart do not differ in furniture -- which is the whole
                reason matrixStyles is shared. #047857 is 5.48:1 on white. */}
            <tr>
              <th style={{ ...percentHead, textAlign: "left", minWidth: 128 }}>Outcome</th>
              {rows.map((row) => (
                <th key={row.year_level} style={percentHead}>
                  {`${toRoman(row.year_level)}-${toRoman(row.next_year_level)}`}
                </th>
              ))}
              <th style={percentHead}>TOTAL</th>
            </tr>
          </thead>

          <tbody>
            {buckets.map((bucket) => (
              <tr key={bucket.key}>
                <td style={{ ...cellBase, textAlign: "left", color: "#334155" }}>{bucket.label}</td>
                {rows.map((row) => (
                  <Cell
                    key={row.year_level}
                    value={row.buckets[bucket.key]}
                    base={row.students}
                    tone={bucket.tone}
                    onOpen={() => openDrill({ bucket: bucket.key, label: bucket.label, yearLevel: row.year_level })}
                  />
                ))}
                <Cell
                  value={totals.buckets[bucket.key]}
                  base={totals.students}
                  tone={bucket.tone}
                  onOpen={() => openDrill({ bucket: bucket.key, label: bucket.label })}
                />
              </tr>
            ))}

            {/* The denominator every share above is measured against, so it sits
                directly under them rather than in a corner of the header. */}
            <tr style={{ background: "#f1f5f9" }}>
              <td style={{ ...cellBase, textAlign: "left", fontWeight: 700, color: MATRIX_TONE.ink }}>
                Students in year
              </td>
              {rows.map((row) => (
                <Cell
                  key={row.year_level}
                  value={row.students}
                  base={null}
                  tone="ink"
                  onOpen={() => openDrill({ bucket: "all", label: "Students in year", yearLevel: row.year_level })}
                />
              ))}
              <Cell
                value={totals.students}
                base={null}
                tone="ink"
                onOpen={() => openDrill({ bucket: "all", label: "Students in year" })}
              />
            </tr>

            {/* The figure the whole grid exists for, on its own banded row. */}
            <tr style={{ background: "#ecfdf5" }}>
              <td style={{ ...cellBase, textAlign: "left", fontWeight: 700, color: MATRIX_TONE.good }}>Moving up</td>
              {rows.map((row) => (
                <SurvivalCell
                  key={row.year_level}
                  rate={row.progression_rate}
                  decided={row.decided}
                  students={row.students}
                  onOpen={() => openDrill({ bucket: "continuing", label: "Moving up", yearLevel: row.year_level })}
                />
              ))}
              <SurvivalCell
                rate={totals.progression_rate}
                decided={totals.decided}
                students={totals.students}
                onOpen={() => openDrill({ bucket: "continuing", label: "Moving up" })}
              />
            </tr>

            <tr>
              <td style={{ ...cellBase, textAlign: "left", color: "#334155" }}>Final year of course</td>
              {rows.map((row) => (
                <Cell
                  key={row.year_level}
                  value={row.final_year}
                  base={row.students}
                  tone="warn"
                  onOpen={() => openDrill({ bucket: "final_year", label: "Final year of course", yearLevel: row.year_level })}
                />
              ))}
              {/* Per-course fact: Year IV is final for a four-year course and not
                  for a five-year one, so a school-wide sum would be a fiction. */}
              <td style={{ ...cellBase, color: MATRIX_TONE.faint }}>—</td>
            </tr>

            <tr>
              <td style={{ ...cellBase, textAlign: "left", color: "#334155" }}>Beyond course length</td>
              {rows.map((row) => (
                <Cell
                  key={row.year_level}
                  value={row.over_term}
                  base={row.students}
                  tone="bad"
                  onOpen={() => openDrill({ bucket: "over_term", label: "Beyond course length", yearLevel: row.year_level })}
                />
              ))}
              <Cell
                value={totals.over_term}
                base={totals.students}
                tone="bad"
                onOpen={() => openDrill({ bucket: "over_term", label: "Beyond course length" })}
              />
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default function YearMigrationMatrix({
  campusId = null,
  departmentId = null,
  courseId = null,
  schoolYearId = null,
  semesterId = null,
  /*
   * The second click, handed up rather than handled here.
   *
   * The page that hosts this grid already opens a student's term-by-term
   * history from its own table, so a student clicked in a drill-down should
   * land in that same dialog rather than in a second one this component built
   * for itself. When the prop is absent the rows are simply not clickable,
   * which is the honest thing for a grid mounted somewhere with nowhere to go.
   */
  onOpenStudent = null,
}) {
  const beginRequest = useLatestRequest();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  // Same reasoning as the retention matrix: a 403 means this viewer cannot see
  // migration data, and an optional card must not make its page look broken.
  const [forbidden, setForbidden] = useState(false);

  // { title, students, loading, truncated, error }
  const [drill, setDrill] = useState(null);

  const [reloadToken, setReloadToken] = useState(0);
  useLiveRefresh(["enrollment_status", "students"], () => setReloadToken((n) => n + 1), {
    enabled: !forbidden,
  });

  /**
   * Open the students behind one cell.
   *
   * The scope sent is the same one the grid was drawn with, so the list can
   * never describe a wider or narrower population than the number that was
   * clicked. The bucket is a key the server validates against its own column
   * list; the label is only for the dialog title.
   */
  const openDrill = useCallback(
    async ({ bucket, label, yearLevel }) => {
      const scopeLabel = yearLevel ? `Year ${toRoman(yearLevel)}` : "All year levels";
      setDrill({ title: `${label} — ${scopeLabel}`, students: [], loading: true, truncated: false });

      try {
        const query = new URLSearchParams({ action: "year_students", bucket });
        if (campusId) query.set("campus_id", String(campusId));
        if (departmentId) query.set("department_id", String(departmentId));
        if (courseId) query.set("course_id", String(courseId));
        if (schoolYearId) query.set("school_year_id", String(schoolYearId));
        if (semesterId) query.set("semester_id", String(semesterId));
        if (yearLevel) query.set("year_level", String(yearLevel));

        const res = await fetch(getBackendUrl(`student_migration.php?${query.toString()}`), {
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

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams({ action: "year_migration" });
      if (campusId) query.set("campus_id", String(campusId));
      if (departmentId) query.set("department_id", String(departmentId));
      if (courseId) query.set("course_id", String(courseId));
      if (schoolYearId) query.set("school_year_id", String(schoolYearId));
      if (semesterId) query.set("semester_id", String(semesterId));

      const res = await fetch(getBackendUrl(`student_migration.php?${query.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });

      if (res.status === 401 || res.status === 403) {
        if (!isCurrent()) return;
        setForbidden(true);
        setData(null);
        return;
      }

      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to load the migration matrix");
      setData(json?.data || null);
    } catch (e) {
      if (!isCurrent()) return;
      setData(null);
      setError(e?.message || "Failed to load the migration matrix");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, campusId, courseId, departmentId, schoolYearId, semesterId]);

  useEffect(() => {
    void load();
  }, [load, reloadToken]);

  const rows = useMemo(() => data?.rows || [], [data]);
  const buckets = useMemo(() => data?.buckets || [], [data]);

  if (forbidden) return null;
  if (loading) {
    return <div style={{ padding: 16, textAlign: "center", color: MATRIX_TONE.muted, fontSize: 11.5 }}>Loading migration matrix...</div>;
  }
  if (error) {
    return <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>{error}</div>;
  }
  if (!data) return null;

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {/*
        * The heading, and everything it has to disclaim, in one line each.
        *
        * Four paragraphs stood here: what the grid shows, a coloured band
        * saying whether the school year is finished, the per-semester counts
        * behind that, and the projection caveat. Every one of them is true and
        * worth saying -- and together they were taller than the grid they
        * introduced, so the screen opened on an essay and the reader scrolled
        * past all of it, caveats included.
        *
        * What stays visible is what changes a reading: the term, and a chip
        * saying whether this year is finished. The rest moves into a details
        * disclosure -- still one click away, still on the page, still found by
        * a page search, and no longer the first thing between the reader and
        * the numbers.
        */}
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12.5, color: MATRIX_TONE.ink }}>Year-Level Migration</strong>
        <span style={{ fontSize: 10.5, color: MATRIX_TONE.muted }}>
          {data.term?.label || "the selected sem"} · a continuing student moves up one year
        </span>
        {data.completeness ? (
          <span
            style={{
              marginLeft: "auto",
              flex: "none",
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.2,
              padding: "2px 7px",
              borderRadius: 999,
              color: data.completeness.complete ? "#065f46" : "#92400e",
              background: data.completeness.complete ? "#ecfdf5" : "#fffbeb",
              border: `1px solid ${data.completeness.complete ? "#a7f3d0" : "#fde68a"}`,
            }}
          >
            {data.completeness.complete ? "Complete year" : "Year in progress"}
          </span>
        ) : null}
      </div>

      {/*
        * Closed by default, and deliberately so.
        *
        * `open` would put the same wall back with a triangle beside it. The
        * two things a reader must not miss are already outside it: the chip
        * above says whether the year is finished, and the caveat below is one
        * short line rather than a banner.
        */}
      <details style={{ fontSize: 10.5, color: MATRIX_TONE.muted, lineHeight: 1.5 }}>
        <summary style={{ cursor: "pointer", color: MATRIX_TONE.ink, fontWeight: 600, listStyle: "revert" }}>
          How to read this
        </summary>
        <div style={{ display: "grid", gap: 6, padding: "6px 0 0 2px" }}>
          <p style={{ margin: 0 }}>
            Where each year level is headed in {data.term?.label || "the selected sem"}. A continuing student
            moves up one level, so Year I becomes Year II and so on. &ldquo;Moving up&rdquo; is how many of them
            survive that step.
          </p>

          {/*
            * Is this a finished year or a year in progress?
            *
            * A year-level migration is a statement about a whole school year -
            * a student moves up when they finish it, not when they finish its
            * first semester. The grid rendered identically either way, so a
            * reader in October read "42% moving up" as the year’s outcome when
            * it was the first semester’s answers and nothing else. The chip
            * above now carries that; this is the sentence behind the chip.
            */}
          {data.completeness ? (
            <p style={{ margin: 0 }}>
              <strong style={{ color: data.completeness.complete ? MATRIX_TONE.good : "#b45309" }}>
                {data.completeness.complete ? "Complete year." : "Year in progress."}
              </strong>{" "}
              {data.completeness.note}
              {/* The per-semester counts, so "not finished" is a number rather
                  than an assertion the reader has to take on trust. */}
              {(data.completeness.terms || []).length > 0 ? (
                <span style={{ display: "block", marginTop: 3 }}>
                  {data.completeness.terms
                    .map((term) => `${term.semester_name}: ${term.students} student${term.students === 1 ? "" : "s"} recorded`)
                    .join(" · ")}
                </span>
              ) : null}
            </p>
          ) : null}

          {/* The caveat, from the server rather than written twice. */}
          {data.basis === "projected" && data.basis_note ? (
            <p style={{ margin: 0 }}>{data.basis_note}</p>
          ) : null}
        </div>
      </details>
      {rows.length === 0 ? (
        <div
          style={{
            border: "1px dashed #cbd5e1",
            borderRadius: 8,
            padding: 18,
            textAlign: "center",
            color: MATRIX_TONE.muted,
            fontSize: 11.5,
            background: "#f8fafc",
          }}
        >
          No students with a year level in this scope.
        </div>
      ) : (
        <MigrationGrid buckets={buckets} rows={rows} totals={data.totals} openDrill={openDrill} />
      )}

      <Modal
        open={Boolean(drill)}
        title={drill?.title || "Students"}
        onClose={() => setDrill(null)}
        width={646}
      >
        {drill?.loading ? (
          <div style={{ padding: 12, textAlign: "center", color: MATRIX_TONE.muted, fontSize: 11.5 }}>
            Loading students...
          </div>
        ) : drill?.error ? (
          <div style={{ background: "#fee2e2", color: "#991b1b", padding: 8, borderRadius: 6, fontSize: 11.5 }}>
            {drill.error}
          </div>
        ) : (drill?.students?.length ?? 0) === 0 ? (
          <div style={{ padding: 12, textAlign: "center", color: MATRIX_TONE.muted, fontSize: 11.5 }}>
            No students in this cell.
          </div>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            <span style={{ fontSize: 10.5, color: MATRIX_TONE.muted }}>
              {drill.students.length} student{drill.students.length === 1 ? "" : "s"}
              {drill.truncated ? " (showing the first 500)" : ""}
              {onOpenStudent ? " — click a student for their sem history" : ""}
            </span>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead>
                  <tr style={{ background: "#f8fafc" }}>
                    <th style={{ ...headBase, textAlign: "left" }}>Student No.</th>
                    <th style={{ ...headBase, textAlign: "left" }}>Name</th>
                    <th style={{ ...headBase, textAlign: "left" }}>Course</th>
                    <th style={headBase}>Year</th>
                    {/* What the student is actually recorded as. In a bucket
                        column that groups several statuses — Shift/Transfer is
                        two, Undecided is four — the header alone does not say
                        which one this student is. */}
                    <th style={{ ...headBase, textAlign: "left" }}>Standing</th>
                    <th style={{ ...headBase, textAlign: "left" }}>Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {drill.students.map((student) => (
                    <tr
                      key={student.student_id}
                      onClick={onOpenStudent ? () => void onOpenStudent(student) : undefined}
                      title={onOpenStudent ? "See this student's sem history" : undefined}
                      style={onOpenStudent ? { cursor: "pointer" } : undefined}
                    >
                      <td style={{ ...cellBase, textAlign: "left", color: MATRIX_TONE.ink }}>
                        {student.student_number || "-"}
                      </td>
                      <td style={{ ...cellBase, textAlign: "left", color: MATRIX_TONE.good, fontWeight: 600 }}>
                        {student.full_name || "-"}
                      </td>
                      <td style={{ ...cellBase, textAlign: "left", color: "#475569" }}>
                        {student.course_code || student.course_name || "-"}
                      </td>
                      <td style={{ ...cellBase, color: "#475569" }}>{toRoman(student.year_level) || "-"}</td>
                      <td style={{ ...cellBase, textAlign: "left", color: "#475569" }}>
                        {student.status_name || "No record"}
                      </td>
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

      {data.totals?.over_term > 0 ? (
        <div style={{ fontSize: 10.5, color: "#b45309", background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 6, padding: "6px 8px" }}>
          {data.totals.over_term} student{data.totals.over_term === 1 ? " is" : "s are"} past the standard length of their
          course and still finishing. They keep a year level above their course duration, which is why a four-year course
          can hold a sixth-year student.
        </div>
      ) : null}
    </div>
  );
}
