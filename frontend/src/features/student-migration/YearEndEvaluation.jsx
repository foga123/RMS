import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import Modal from "../../shared/components/Modal/Modal";
import Badge from "../../shared/components/ui/Badge";
import Button from "../../shared/components/ui/Button";
import Pagination from "../../shared/components/ui/Pagination";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import { getBackendUrl } from "../../shared/lib/url";
import { confirmAction, notifyError, notifySuccess } from "../../shared/lib/notify";
import { toRoman } from "../../shared/lib/yearLevel";
import { MATRIX_TONE, cellBase, countButton, headBase } from "../../shared/components/matrix/matrixStyles";

/**
 * Year-end evaluation: classify every student for a school year, THEN move year levels.
 *
 * Moving up is the result of a classification, not a synonym for "add one".
 * year_migration.php classifies each student from the final grades of the
 * year's semesters, the latest balance and the attendance on record - Migrated,
 * Irregular - Advancing, Irregular - Retained, Retained, For Graduation, or
 * Pending Evaluation when the year is not on record in full - and Apply moves
 * the year level the way the classification says. The rules live in
 * backend/api/lib/year_migration.php; this screen only shows and asks.
 *
 * Grades are stored as subject COUNTS, so the rules cannot see which subject
 * was failed or whether it was a prerequisite. That is why every student can
 * be overridden, with a reason, before Apply.
 */

const BADGE_TONE = { good: "success", warn: "warning", bad: "danger", none: "neutral" };
const STATES = [
  { key: "ready", label: "Ready to apply" },
  { key: "applied", label: "Applied" },
  { key: "pending", label: "Pending" },
  { key: "superseded", label: "Later year applied" },
];

const controlStyle = {
  padding: "5px 6px",
  border: "1px solid var(--border-base)",
  borderRadius: 5,
  fontSize: 12,
  background: "var(--surface-base)",
};

function peso(value) {
  if (value === null || value === undefined) return "-";
  return `₱${Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function YearMove({ from, to }) {
  const a = from?.year_level;
  const b = to?.year_level;
  if (!a) return <span style={{ color: MATRIX_TONE.faint }}>-</span>;
  if (b === a) return <span>{toRoman(a)}</span>;
  return (
    <span style={{ whiteSpace: "nowrap", fontWeight: 600, color: MATRIX_TONE.good }}>
      {toRoman(a)} → {toRoman(b)}
    </span>
  );
}

/** The cut-offs in force, editable by Settings editors. */
function RulesPanel({ settings, specs, canEdit, onSaved }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(settings);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => setDraft(settings), [settings]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("year_migration.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({ action: "settings", values: draft }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Could not save the cut-offs");
      setEditing(false);
      onSaved();
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const sentence = `Up to ${settings.advance_max_failed} failed subject${Number(settings.advance_max_failed) === 1 ? "" : "s"} still move up (as Irregular – Advancing); more stay as Irregular – Retained; `
    + `${settings.retained_min_failed_share}% or more failed is Retained. `
    + `A balance above ${peso(settings.balance_limit)} holds a student at Pending`
    + (Number(settings.require_attendance) ? ", and so does missing final attendance." : ". Missing attendance does not.");

  return (
    <div style={{ border: "1px solid var(--border-base)", borderRadius: 7, padding: 9, background: "var(--surface-page)", display: "grid", gap: 6 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
        <strong style={{ fontSize: 12 }}>Rules</strong>
        <span style={{ fontSize: 11.5, color: "var(--text-secondary)", flex: 1, minWidth: 220 }}>{sentence}</span>
        {canEdit && !editing ? (
          <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Edit cut-offs</Button>
        ) : null}
      </div>
      <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
        The defaults are placeholders, not registrar policy. Change them before the first real Apply.
      </span>
      {editing ? (
        <div style={{ display: "grid", gap: 7 }}>
          <AlertMessage message={error} tone="error" style={{ marginBottom: 0 }} />
          <div style={{ display: "grid", gap: 7, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 210px), 1fr))" }}>
            {Object.entries(specs).map(([key, spec]) => (
              <label key={key} style={{ display: "grid", gap: 3, fontSize: 11 }}>
                <span style={{ color: "var(--text-muted)" }}>{spec.label}</span>
                {spec.type === "bool" ? (
                  <select
                    value={String(draft[key] ?? spec.default)}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
                    style={controlStyle}
                  >
                    <option value="1">Yes</option>
                    <option value="0">No</option>
                  </select>
                ) : (
                  <input
                    type="number"
                    min={spec.min}
                    max={spec.max}
                    step={spec.type === "money" ? "0.01" : "1"}
                    value={draft[key] ?? ""}
                    onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
                    style={controlStyle}
                  />
                )}
              </label>
            ))}
          </div>
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <Button size="sm" variant="secondary" onClick={() => { setEditing(false); setDraft(settings); setError(""); }}>Cancel</Button>
            <Button size="sm" onClick={save} disabled={saving}>{saving ? "Saving..." : "Save cut-offs"}</Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Year level by classification: the board the Apply button acts on. */
function SummaryGrid({ classes, summary, activeClass, onPick }) {
  const totals = summary.by_class || {};
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th style={{ ...headBase, textAlign: "left" }}>Year level</th>
            {classes.map((c) => (
              <th key={c.key} style={{ ...headBase, color: MATRIX_TONE[c.tone] || MATRIX_TONE.ink }} title={c.meaning}>
                {c.label}
              </th>
            ))}
            <th style={headBase}>Students</th>
          </tr>
        </thead>
        <tbody>
          {(summary.by_year || []).map((row) => {
            const sum = Object.values(row.by_class).reduce((a, b) => a + b, 0);
            return (
              <tr key={row.year_level ?? "none"}>
                <td style={{ ...cellBase, textAlign: "left", fontWeight: 600 }}>
                  {row.year_level ? `Year ${toRoman(row.year_level)}` : "No year level"}
                </td>
                {classes.map((c) => (
                  <td key={c.key} style={{ ...cellBase, color: row.by_class[c.key] ? MATRIX_TONE[c.tone] : MATRIX_TONE.faint }}>
                    {row.by_class[c.key] || 0}
                  </td>
                ))}
                <td style={{ ...cellBase, fontWeight: 600 }}>{sum}</td>
              </tr>
            );
          })}
          <tr>
            <td style={{ ...cellBase, textAlign: "left", fontWeight: 700 }}>Total</td>
            {classes.map((c) => (
              <td key={c.key} style={cellBase}>
                <button
                  type="button"
                  onClick={() => onPick(activeClass === c.key ? "" : c.key)}
                  title={activeClass === c.key ? "Show every classification" : `List the ${c.label} students`}
                  style={{
                    ...countButton,
                    fontWeight: 700,
                    color: totals[c.key] ? MATRIX_TONE[c.tone] : MATRIX_TONE.faint,
                    outline: activeClass === c.key ? `2px solid ${MATRIX_TONE[c.tone]}` : "none",
                  }}
                >
                  {totals[c.key] || 0}
                </button>
              </td>
            ))}
            <td style={{ ...cellBase, fontWeight: 700 }}>{summary.students}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export default function YearEndEvaluation({ departmentId = null, courseId = null, onOpenStudent = null }) {
  const beginRequest = useLatestRequest();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [schoolYearId, setSchoolYearId] = useState("");
  const [classFilter, setClassFilter] = useState("");
  const [stateFilter, setStateFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [applying, setApplying] = useState(false);
  const [overrideFor, setOverrideFor] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => setPage(1), [classFilter, stateFilter, search, schoolYearId, departmentId, courseId]);

  useEffect(() => {
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    const query = new URLSearchParams({ page: String(page), limit: String(pageSize) });
    if (schoolYearId) query.set("school_year_id", schoolYearId);
    if (departmentId) query.set("department_id", String(departmentId));
    if (courseId) query.set("course_id", String(courseId));
    if (classFilter) query.set("classification", classFilter);
    if (stateFilter) query.set("state", stateFilter);
    if (search.trim()) query.set("search", search.trim());

    (async () => {
      try {
        const res = await fetch(getBackendUrl(`year_migration.php?${query.toString()}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.message || "Could not load the year-end evaluation");
        if (!isCurrent()) return;
        setData(json);
      } catch (e) {
        if (!isCurrent()) return;
        setData(null);
        setError(e.message);
      } finally {
        if (isCurrent()) setLoading(false);
      }
    })();
  }, [beginRequest, classFilter, courseId, departmentId, page, pageSize, reloadKey, schoolYearId, search, stateFilter]);

  const classes = useMemo(() => data?.classes || [], [data]);
  const classByKey = useMemo(() => Object.fromEntries(classes.map((c) => [c.key, c])), [classes]);
  const summary = data?.summary;
  const readyCount = summary?.by_state?.ready || 0;
  const yearName = data?.school_year?.schoolyear_name || "";

  const post = async (body) => {
    const res = await fetch(getBackendUrl("year_migration.php"), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      credentials: "include",
      body: JSON.stringify({ school_year_id: data?.school_year?.school_year_id, ...body }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || "The request was refused");
    return json;
  };

  const apply = async () => {
    const lines = classes
      .filter((c) => summary.ready_by_class[c.key])
      .map((c) => `${summary.ready_by_class[c.key]} ${c.label}`);
    const confirmed = await confirmAction({
      title: `Apply the ${yearName} evaluation?`,
      text: `${readyCount} student${readyCount === 1 ? "" : "s"} will be recorded (${lines.join(", ")}). `
        + `${summary.ready_moves_up} move up a year level, and their sections follow. `
        + `Pending students are not touched. Each student can be reverted one at a time afterwards.`,
      confirmButtonText: "Apply",
    });
    if (!confirmed) return;
    setApplying(true);
    try {
      const json = await post({
        action: "apply",
        ...(departmentId ? { department_id: departmentId } : {}),
        ...(courseId ? { course_id: courseId } : {}),
      });
      notifySuccess("Applied", json.message);
      reload();
    } catch (e) {
      notifyError("Not applied", e.message);
    } finally {
      setApplying(false);
    }
  };

  const revert = async (row) => {
    const confirmed = await confirmAction({
      title: "Revert this student?",
      text: `${row.name} goes back to Year ${toRoman(row.from.year_level)}${row.from.section ? `, ${row.from.section}` : ""}, as before Apply.`,
      confirmButtonText: "Revert",
    });
    if (!confirmed) return;
    try {
      const json = await post({ action: "revert", student_id: row.student_id });
      notifySuccess("Reverted", json.message);
      reload();
    } catch (e) {
      notifyError("Not reverted", e.message);
    }
  };

  if (error && !data) {
    return <AlertMessage message={error} tone="error" style={{ marginBottom: 0 }} />;
  }
  if (!data) {
    return <div style={{ padding: 12, textAlign: "center", color: MATRIX_TONE.muted, fontSize: 11.5 }}>Loading the evaluation...</div>;
  }

  const allPending = summary.students > 0 && summary.by_class.pending === summary.students;

  return (
    <div style={{ display: "grid", gap: 10, opacity: loading ? 0.6 : 1 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ fontSize: 11.5, color: "var(--text-muted)" }} htmlFor="year_end_school_year">School year evaluated</label>
        <select
          id="year_end_school_year"
          value={schoolYearId || String(data.school_year.school_year_id)}
          onChange={(e) => setSchoolYearId(e.target.value)}
          style={controlStyle}
        >
          {data.school_years.map((y) => (
            <option key={y.school_year_id} value={String(y.school_year_id)}>{y.schoolyear_name}</option>
          ))}
        </select>
        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>
          {data.semesters.map((s) => `${s.semester_name}: final grades for ${s.students_with_final_grades} of ${summary.students}`).join(" · ")}
        </span>
      </div>

      {allPending ? (
        <AlertMessage
          tone="info"
          style={{ marginBottom: 0 }}
          message={`Every student is Pending Evaluation for ${yearName}: the year is not on record in full yet. A semester counts once its final (P3) grades are in. That is the expected state until the year ends, not an error.`}
        />
      ) : null}

      <SummaryGrid classes={classes} summary={summary} activeClass={classFilter} onPick={setClassFilter} />

      <RulesPanel settings={data.settings} specs={data.setting_specs} canEdit={data.can_edit_settings} onSaved={reload} />

      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", padding: "7px 9px", borderRadius: 7, background: readyCount ? "var(--brand-100)" : "var(--surface-page)" }}>
        <span style={{ fontSize: 12, flex: 1, minWidth: 220 }}>
          {readyCount
            ? `${readyCount} student${readyCount === 1 ? "" : "s"} ready to apply; ${summary.ready_moves_up} would move up a year level.`
            : "Nobody is ready to apply."}
          {summary.by_state.applied ? ` ${summary.by_state.applied} already applied.` : ""}
        </span>
        {data.can_apply ? (
          <Button size="sm" onClick={apply} disabled={!readyCount || applying}>
            {applying ? "Applying..." : "Apply"}
          </Button>
        ) : (
          <span style={{ fontSize: 11, color: "var(--text-muted)" }}>Applying needs Student Management edit access.</span>
        )}
      </div>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search number or name" style={{ ...controlStyle, minWidth: 180 }} aria-label="Search students" />
        <select value={classFilter} onChange={(e) => setClassFilter(e.target.value)} style={controlStyle} aria-label="Classification">
          <option value="">All classifications</option>
          {classes.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
        </select>
        <select value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} style={controlStyle} aria-label="State">
          <option value="">Any state</option>
          {STATES.map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...headBase, textAlign: "left" }}>Student No.</th>
              <th style={{ ...headBase, textAlign: "left" }}>Name</th>
              <th style={headBase}>Year</th>
              <th style={headBase}>Classification</th>
              <th style={headBase}>Failed</th>
              <th style={{ ...headBase, textAlign: "left" }}>Why</th>
              <th style={headBase}>Action</th>
            </tr>
          </thead>
          <tbody>
            {data.students.length === 0 ? (
              <tr><td colSpan={7} style={{ ...cellBase, color: MATRIX_TONE.muted, padding: 12 }}>No students match.</td></tr>
            ) : data.students.map((row) => {
              const cls = classByKey[row.classification];
              return (
                <tr key={row.student_id}>
                  <td style={{ ...cellBase, textAlign: "left", whiteSpace: "nowrap" }}>
                    {onOpenStudent ? (
                      <button
                        type="button"
                        title="See this student's sem history"
                        onClick={() => onOpenStudent({ student_id: row.student_id, student_number: row.student_number, full_name: row.name, year_level: row.from?.year_level })}
                        style={{ ...countButton, fontWeight: 600, color: "var(--brand-700)" }}
                      >
                        {row.student_number}
                      </button>
                    ) : row.student_number}
                  </td>
                  <td style={{ ...cellBase, textAlign: "left" }}>{row.name}</td>
                  <td style={cellBase}><YearMove from={row.from} to={row.to} /></td>
                  <td style={cellBase}>
                    <div style={{ display: "grid", gap: 3, justifyItems: "center" }}>
                      <Badge tone={BADGE_TONE[cls?.tone] || "neutral"}>{cls?.label || row.classification}</Badge>
                      {row.override ? (
                        <span style={{ fontSize: 10, color: "var(--text-muted)" }} title={row.override.reason}>
                          overridden (rules: {classByKey[row.computed_classification]?.label})
                        </span>
                      ) : null}
                      {row.to?.is_irregular && !row.from?.is_irregular ? <span style={{ fontSize: 10, color: MATRIX_TONE.warn }}>becomes irregular</span> : null}
                    </div>
                  </td>
                  <td style={cellBase}>
                    {row.subjects_total !== null ? `${row.subjects_failed} of ${row.subjects_total}` : "-"}
                  </td>
                  <td style={{ ...cellBase, textAlign: "left", fontSize: 11 }}>
                    {row.override ? <div><strong>Override:</strong> {row.override.reason}</div> : null}
                    {row.superseded_by ? <div>{row.superseded_by} is already applied, so this year cannot move them.</div> : null}
                    {(row.reasons || []).map((r) => <div key={r}>{r}</div>)}
                  </td>
                  <td style={{ ...cellBase, whiteSpace: "nowrap" }}>
                    {!data.can_apply ? null : row.state === "applied" ? (
                      <Button size="sm" variant="secondary" onClick={() => revert(row)}>Revert</Button>
                    ) : row.state !== "superseded" ? (
                      <Button size="sm" variant="secondary" onClick={() => setOverrideFor(row)}>Override</Button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Pagination
        page={data.pagination.page}
        pageSize={pageSize}
        total={data.pagination.total}
        onPageChange={setPage}
        onPageSizeChange={(size) => { setPageSize(size); setPage(1); }}
        itemLabel="students"
        compact
      />

      <OverrideDialog
        row={overrideFor}
        classes={classes}
        onClose={() => setOverrideFor(null)}
        onSave={async (classification, reason) => {
          const json = await post({ action: "override", student_id: overrideFor.student_id, classification, reason });
          setOverrideFor(null);
          notifySuccess("Saved", json.message);
          reload();
        }}
      />
    </div>
  );
}

/** One student's decision, with the reason the next reader will need. */
function OverrideDialog({ row, classes, onClose, onSave }) {
  const [classification, setClassification] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setClassification(row?.override?.classification || "");
    setReason(row?.override?.reason || "");
    setError("");
  }, [row]);

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(classification || null, reason);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal open={Boolean(row)} title={row ? `Override: ${row.name}` : "Override"} onClose={onClose} width={480} error={error}>
      {row ? (
        <div style={{ display: "grid", gap: 9, padding: 2 }}>
          <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
            The rules say <strong>{classes.find((c) => c.key === row.computed_classification)?.label}</strong>. An override wins over them and is applied with everyone else when Apply is pressed.
          </span>
          {/* Labels only in the list: a description per option made the select
              wider than the dialog and pushed its buttons out of view. The
              chosen one's meaning is spelled out underneath instead. */}
          <label style={{ display: "grid", gap: 3, fontSize: 11, minWidth: 0 }}>
            <span style={{ color: "var(--text-muted)" }}>Classification</span>
            <select value={classification} onChange={(e) => setClassification(e.target.value)} style={{ ...controlStyle, width: "100%", boxSizing: "border-box" }}>
              <option value="">Let the rules decide (clear override)</option>
              {classes.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </select>
            {classification ? (
              <span style={{ color: "var(--text-secondary)" }}>{classes.find((c) => c.key === classification)?.meaning}</span>
            ) : null}
          </label>
          {classification ? (
            <label style={{ display: "grid", gap: 3, fontSize: 11, minWidth: 0 }}>
              <span style={{ color: "var(--text-muted)" }}>Reason (kept with the record)</span>
              <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={255} style={{ ...controlStyle, width: "100%", boxSizing: "border-box", resize: "vertical" }} />
            </label>
          ) : null}
          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <Button size="sm" variant="secondary" onClick={onClose}>Cancel</Button>
            <Button size="sm" onClick={submit} disabled={saving || (classification !== "" && reason.trim().length < 3)}>
              {saving ? "Saving..." : classification ? "Save decision" : "Clear override"}
            </Button>
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
