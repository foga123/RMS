import React, { useCallback, useEffect, useMemo, useState } from "react";
import TermLogbookReport from "../reports/TermLogbookReport";
import StudentTermHistory from "../students/StudentTermHistory";
import AuditLogsPanel from "../settings/panels/AuditLogsPanel";
import { AlertMessage, Button } from "../../shared/components/ui";
import { SelectControl } from "../../shared/components/Form/Form";
import useScopeOptions from "../../shared/hooks/useScopeOptions";
import { getBackendUrl } from "../../shared/lib/url";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { courseCampusSuffix } from "../../shared/lib/scopeOptionLabels";

/**
 * Records & History: the past, in one place.
 *
 * Three views of finished work already existed, and none of them was findable
 * as history:
 *
 *   the term register        one report type among twelve, inside Reports
 *   the per-student timeline behind a student row, inside Student Management
 *   the activity log         a panel inside Settings, next to backups
 *
 * So "what did last year look like" lived in a reports dropdown, "what happened
 * to this student" required finding the student first, and "who changed this"
 * was in a settings screen. Each is reasonable where it sits. None of them is
 * where somebody looking for past records would look.
 *
 * This module does not reimplement any of them -- it renders the same three
 * components against the same three endpoints, which keep serving their
 * original screens unchanged. What is new is the doorway.
 *
 * ---------------------------------------------------------------------------
 * THE REGISTER'S SCOPE
 *
 * TermLogbookReport takes the Reports page's campus/department/course/year
 * scope. This module used to pass a frozen empty one, so the register opened on
 * every student in the college and offered no way to narrow it — on a term with
 * a few thousand records that is a table nobody can read.
 *
 * The scope now lives in TermRegisterTab's state, which keeps its identity
 * stable between renders. That matters: the logbook memoises on the scope, and
 * a fresh `{}` on every render would refetch the register in a loop.
 *
 * Department is deliberately NOT a chooser for everyone. Deans and program
 * heads are pinned to their own department server-side by term_logbook.php, so
 * for them the field renders as a fixed label rather than a select — a filter
 * you cannot change is a control that lies about what it does.
 * ---------------------------------------------------------------------------
 */

const TABS = [
  { key: "register", label: "Term Register", hint: "Open a finished term: year, semester, periodical" },
  { key: "student", label: "Student Timeline", hint: "One student, every term they attended" },
  {
    key: "activity",
    label: "Activity Log",
    hint: "Who signed in, and who changed what",
    // Gated on the reader holding `settings`, not this module — see the block
    // comment in the component for why.
    requires: "settings",
  },
];

export default function RecordsHistoryPage({ permissions = null, modules = [] }) {
  const [tab, setTab] = useState("register");

  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canView = hasPermissionContext ? canModuleAction(permissions, "view") : true;

  /*
   * The Activity Log is gated on `settings`, not on this module.
   *
   * audit_log.php answers to `settings` alone and always has -- its role list
   * says 'admin' and nothing else, deliberately. This module is granted to SSG,
   * Dean and Program Head as well, and none of them can read the trail of every
   * sign-in and every permission change today. Widening the endpoint to match
   * the module would have handed it to all three as a side effect of adding a
   * menu item, which is not a permission decision anybody made.
   *
   * `modules` is the whole granted set the dashboard already passes down -- the
   * same thing the survey workspace uses to decide which of its tabs to show.
   * The tab is hidden rather than shown-and-refused: an Activity Log that 403s
   * teaches the reader the screen is broken.
   */
  const grantedModules = useMemo(
    () => new Set((Array.isArray(modules) ? modules : []).map((entry) => entry?.view).filter(Boolean)),
    [modules]
  );
  const visibleTabs = useMemo(
    () => TABS.filter((entry) => !entry.requires || grantedModules.has(entry.requires)),
    [grantedModules]
  );

  // A tab that disappears must not leave the page rendering nothing.
  useEffect(() => {
    if (!visibleTabs.some((entry) => entry.key === tab)) {
      setTab(visibleTabs[0]?.key || "register");
    }
  }, [visibleTabs, tab]);

  if (!canView) {
    return <AlertMessage tone="error" message="You do not have permission to open Records & History." />;
  }

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 4, color: "var(--brand-800)" }}>Records &amp; History</h2>
      <p style={{ margin: "0 0 12px", fontSize: 12.5, color: "var(--text-muted)" }}>
        Finished terms, student timelines and the activity trail. Everything here is read-only — a history you can
        rewrite is not a history.
      </p>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {visibleTabs.map((entry) => {
          const active = tab === entry.key;
          return (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              title={entry.hint}
              style={{
                padding: "7px 13px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: active ? 600 : 400,
                border: `1px solid ${active ? "var(--brand-600)" : "var(--border-base)"}`,
                background: active ? "var(--brand-600)" : "#fff",
                color: active ? "#fff" : "var(--text-secondary)",
              }}
            >
              {entry.label}
            </button>
          );
        })}
      </div>

      {tab === "register" ? <TermRegisterTab /> : null}
      {tab === "student" ? <StudentTimelineTab /> : null}
      {tab === "activity" && grantedModules.has("settings") ? <ActivityTab /> : null}
    </section>
  );
}

/**
 * The term register, with the scope chooser it never had.
 *
 * Course and year level are the two the register is actually read by — "who
 * was in BSIT year 2 that semester" — so they lead. Campus and department come
 * first in the chain because they decide which courses exist, but they collapse
 * to a label the moment the server has pinned them.
 *
 * The option lists come from useScopeOptions, which reads overview_analytics.php
 * — the same source the Overview filter uses, and already department-scoped
 * server-side. A dean is never offered a course outside their own department,
 * because the list they are offered is not assembled here.
 */
function TermRegisterTab() {
  const [scope, setScope] = useState({ campusId: "", departmentId: "", courseId: "", yearLevel: "" });
  const options = useScopeOptions(scope);

  /*
   * Narrowing an outer field invalidates the inner ones: the course chosen
   * under one department does not exist under another, and year levels are
   * offered per course. Left alone, the stale id stays in the query string and
   * the register comes back empty for a reason nothing on screen explains.
   */
  const update = useCallback((key, value) => {
    setScope((current) => {
      const next = { ...current, [key]: value };
      if (key === "campusId") {
        next.departmentId = "";
        next.courseId = "";
        next.yearLevel = "";
      }
      if (key === "departmentId") {
        next.courseId = "";
        next.yearLevel = "";
      }
      if (key === "courseId") next.yearLevel = "";
      return next;
    });
  }, []);

  const clearAll = useCallback(
    () => setScope({ campusId: "", departmentId: "", courseId: "", yearLevel: "" }),
    []
  );

  const hasScope = Boolean(scope.campusId || scope.departmentId || scope.courseId || scope.yearLevel);

  return (
    <>
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "flex-end",
          gap: 9,
          marginBottom: 12,
          padding: 11,
          border: "1px solid var(--border-base)",
          borderRadius: 9,
          background: "var(--surface-base)",
        }}
      >
        {options.canChooseDepartment ? (
          <ScopeField label="Department">
            <SelectControl value={scope.departmentId} onChange={(e) => update("departmentId", e.target.value)}>
              <option value="">All departments</option>
              {options.departments.map((d) => (
                <option key={d.department_id} value={d.department_id}>
                  {d.department_name || d.department_code}
                </option>
              ))}
            </SelectControl>
          </ScopeField>
        ) : options.departmentName ? (
          /* Pinned by the server. Shown so the reader knows the register is
             already narrowed, rather than wondering why the totals look small. */
          <ScopeField label="Department">
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                height: 31,
                padding: "0 9px",
                borderRadius: 8,
                border: "1px solid var(--border-base)",
                background: "var(--surface-muted)",
                color: "var(--text-secondary)",
                fontSize: 12.5,
                whiteSpace: "nowrap",
              }}
              title="Your account is pinned to this department"
            >
              {options.departmentName}
            </span>
          </ScopeField>
        ) : null}

        <ScopeField label="Course">
          <SelectControl value={scope.courseId} onChange={(e) => update("courseId", e.target.value)}>
            <option value="">All courses</option>
            {options.courses.map((c) => (
              <option key={c.course_id} value={c.course_id}>
                {c.course_code || c.course_name}
                {courseCampusSuffix(c, options.courses)}
              </option>
            ))}
          </SelectControl>
        </ScopeField>

        <ScopeField label="Year level">
          <SelectControl value={scope.yearLevel} onChange={(e) => update("yearLevel", e.target.value)}>
            <option value="">All year levels</option>
            {options.yearLevels.map((y) => {
              const value = y?.year_level ?? y;
              return (
                <option key={String(value)} value={value}>
                  {yearLevelLabel(value)}
                </option>
              );
            })}
          </SelectControl>
        </ScopeField>

        {hasScope ? (
          <Button variant="secondary" onClick={clearAll}>
            Clear filters
          </Button>
        ) : null}
      </div>

      {options.error ? <AlertMessage tone="warning" message={options.error} /> : null}

      <TermLogbookReport scope={scope} />
    </>
  );
}

function ScopeField({ label, children }) {
  return (
    <label style={{ display: "grid", gap: 4, minWidth: 0 }}>
      <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-muted)" }}>{label}</span>
      {children}
    </label>
  );
}

/**
 * Find a student, then read their whole record.
 *
 * A picker rather than the full student table: this tab is not for browsing
 * students -- Student Management is -- it is for the case where you already know
 * whose history you want. So the search is the screen, and the timeline replaces
 * it once somebody is chosen.
 */
function StudentTimelineTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState(null);

  const trimmed = query.trim();

  useEffect(() => {
    // Two characters, because one letter matches most of the school and the
    // request is thrown away before it can be read.
    if (trimmed.length < 2) {
      setResults([]);
      return undefined;
    }

    const controller = new AbortController();
    // Debounced: without it every keystroke fires a query and the answers race,
    // so the list can settle on the results for a prefix already typed past.
    const timer = setTimeout(async () => {
      setSearching(true);
      setError("");
      try {
        const response = await fetch(
          getBackendUrl(`student.php?search=${encodeURIComponent(trimmed)}&limit=10`),
          { headers: { Accept: "application/json" }, credentials: "include", signal: controller.signal }
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload?.message || "Could not search students.");
        setResults(Array.isArray(payload?.data) ? payload.data : []);
      } catch (searchError) {
        if (searchError.name !== "AbortError") {
          setError(searchError.message || "Could not search students.");
          setResults([]);
        }
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [trimmed]);

  if (selected) {
    return (
      <div>
        <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap", marginBottom: 10 }}>
          <strong style={{ fontSize: 14 }}>
            {selected.last_name}, {selected.first_name}
          </strong>
          <span style={{ fontSize: 12.5, color: "var(--text-muted)" }}>
            {selected.student_number}
            {selected.course_code ? ` · ${selected.course_code}` : ""}
          </span>
          <button
            type="button"
            onClick={() => setSelected(null)}
            style={{
              marginLeft: "auto",
              padding: "5px 11px",
              borderRadius: 6,
              border: "1px solid var(--border-strong)",
              background: "var(--surface-base)",
              cursor: "pointer",
              fontSize: 12.5,
            }}
          >
            Choose another student
          </button>
        </div>
        <StudentTermHistory studentId={selected.student_id} />
      </div>
    );
  }

  return (
    <div style={{ background: "#fff", border: "1px solid var(--border-base)", borderRadius: 9, padding: 16 }}>
      <label style={{ display: "grid", gap: 4, fontSize: 11, maxWidth: 420 }}>
        <span style={{ color: "var(--text-muted)" }}>Find a student by name or student number</span>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="e.g. Labrador, or 02-2526-000049"
          style={{ padding: "7px 9px", borderRadius: 6, border: "1px solid var(--border-strong)", fontSize: 12.5 }}
        />
      </label>

      {error ? <div style={{ marginTop: 10 }}><AlertMessage tone="error" message={error} /></div> : null}

      <div style={{ marginTop: 12 }}>
        {trimmed.length < 2 ? (
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>Type at least two characters.</p>
        ) : searching ? (
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>Searching…</p>
        ) : results.length === 0 ? (
          <p style={{ fontSize: 12.5, color: "var(--text-muted)", margin: 0 }}>No student matches that.</p>
        ) : (
          <div style={{ display: "grid", gap: 6 }}>
            {results.map((student) => (
              <button
                key={student.student_id}
                type="button"
                onClick={() => setSelected(student)}
                style={{
                  textAlign: "left",
                  padding: "8px 11px",
                  borderRadius: 8,
                  border: "1px solid var(--border-base)",
                  background: "var(--surface-base)",
                  cursor: "pointer",
                  fontSize: 12.5,
                }}
              >
                <div style={{ fontWeight: 600 }}>
                  {student.last_name}, {student.first_name}
                </div>
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>
                  {student.student_number}
                  {student.course_code ? ` · ${student.course_code}` : ""}
                  {student.year_level ? ` · Year ${student.year_level}` : ""}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The audit trail.
 *
 * The same panel Settings shows, with one difference that matters: no `onClear`.
 * That prop draws a "Clear Logs" button, and a history module that can erase the
 * history is a contradiction. Clearing stays in Settings, where it sits beside
 * the backup tools and reads as the administrative act it is.
 */
function ActivityTab() {
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((current) => current + 1), []);

  // The panel keeps its own server-side pagination and filters; `logs` is its
  // legacy client-side list, which this module has none of.
  const emptyLogs = useMemo(() => [], []);

  return (
    <div style={{ background: "#fff", border: "1px solid var(--border-base)", borderRadius: 9, padding: 16 }}>
      <AuditLogsPanel key={refreshKey} logs={emptyLogs} onRefresh={refresh} />
    </div>
  );
}
