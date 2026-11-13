import React, { useCallback, useEffect, useMemo, useState } from "react";
import RetentionMatrix from "../../../features/retention-cases/RetentionMatrix";
import YearMigrationMatrix from "../../../features/student-migration/YearMigrationMatrix";
import { getBackendUrl } from "../../lib/url";
import { departmentCampusSuffix } from "../../lib/scopeOptionLabels";

/**
 * The overview's matrix panel: retention or year-level migration, one at a time.
 *
 * Two questions about the same population, asked with the same filters. The
 * dropdown swaps which one is on screen rather than stacking both, because they
 * are read one at a time and a second full grid would push everything below it
 * off the fold on every dashboard that mounts this.
 *
 * Scope is decided by retention_matrix.php, not here: it returns
 * can_choose_department and the option lists, and pins a dean to their own
 * department whatever the query string claims. This makes one cheap probe
 * request to learn that, then hands the chosen scope to whichever matrix is
 * showing. Both endpoints re-check that scope server-side, so the shared
 * chooser is a convenience and never the thing enforcing it.
 */

/** Remembered per browser: which question this reader opens the panel on. */
const MATRIX_VIEW_KEY = "coc-overview-matrix-view";

const MATRIX_VIEWS = {
  retention: {
    heading: "Retention Matrix",
    option: "Retention — where last sem's students ended up",
  },
  migration: {
    heading: "Year-Level Migration",
    option: "Migration — how many move up a year level",
  },
};
const selectStyle = {
  padding: "5px 8px",
  border: "1px solid var(--border-base)",
  borderRadius: 6,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  fontSize: 11.5,
};

export default function ScopedRetentionMatrix({ title = "", onScopeChange = null }) {
  const [matrixView, setMatrixView] = useState(() => {
    try {
      return window.localStorage.getItem(MATRIX_VIEW_KEY) === "migration" ? "migration" : "retention";
    } catch {
      // Private mode, or storage disabled. Not a reason to fail to render.
      return "retention";
    }
  });
  const [campusId, setCampusId] = useState("");
  const [departmentId, setDepartmentId] = useState("");
  const [schoolYearId, setSchoolYearId] = useState("");
  const [semesterId, setSemesterId] = useState("");
  const [canChoose, setCanChoose] = useState(false);
  const [departments, setDepartments] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [schoolYears, setSchoolYears] = useState([]);
  const [semesters, setSemesters] = useState([]);
  const [error, setError] = useState("");

  const probeScope = useCallback(async () => {
    try {
      const res = await fetch(getBackendUrl("retention_matrix.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.message || "Failed to load retention scope");
      const payload = json?.data || {};
      setCanChoose(Boolean(payload.can_choose_department));
      setDepartments(Array.isArray(payload.departments) ? payload.departments : []);
      setCampuses(Array.isArray(payload.campuses) ? payload.campuses : []);
      setSchoolYears(Array.isArray(payload.school_years) ? payload.school_years : []);
      setSemesters(Array.isArray(payload.semesters) ? payload.semesters : []);

      // Seed the term controls with what the server defaulted to, so they read
      // as the current selection rather than as an empty "no filter" state.
      const term = payload.selected_term || {};
      if (term.school_year_id) setSchoolYearId((current) => current || String(term.school_year_id));
      if (term.semester_id) setSemesterId((current) => current || String(term.semester_id));
    } catch (probeError) {
      // A failure here only costs the choosers; the matrix below fetches its own
      // data and will surface any real problem itself.
      setError(probeError?.message || "");
      setCanChoose(false);
    }
  }, []);

  useEffect(() => {
    void probeScope();
  }, [probeScope]);

  /*
   * Departments narrow to the chosen campus. The list carries campus_id, so
   * this is a comparison rather than a second request — and a department with
   * no campus recorded stays offered rather than disappearing.
   */
  const campusDepartments = useMemo(() => {
    if (!campusId) return departments;
    return departments.filter((d) => d.campus_id == null || String(d.campus_id) === String(campusId));
  }, [campusId, departments]);

  /*
   * Hand the chosen scope up, so a panel above this one can answer for the same
   * term rather than for all time.
   *
   * The choosers live here because the probe that populates them lives here.
   * Anything else on the page that wants to follow them - the survey stat cards
   * on the SSG overview - subscribes rather than growing a second copy of this
   * control row.
   *
   * The dependency list is the four values, not the callback: a parent that
   * passes an inline arrow would otherwise re-fire this on every one of its own
   * renders, and the fetch on the other end would loop.
   */
  useEffect(() => {
    if (!onScopeChange) return;
    onScopeChange({
      campusId: campusId || null,
      departmentId: departmentId || null,
      schoolYearId: schoolYearId || null,
      semesterId: semesterId || null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [campusId, departmentId, schoolYearId, semesterId]);

  const selectedLabel = useMemo(() => {
    // A dean cannot choose, and the server pins them to their own department —
    // saying "All departments" here would be plainly wrong for them. The matrix
    // states the terms it compared in its own caption, so nothing is lost.
    if (!canChoose) return "";
    const campus = campuses.find((c) => String(c.campus_id) === String(campusId));
    const campusLabel = campus ? (campus.campus_code || campus.campus_name) : (campusId ? "" : "All campuses");
    const match = departments.find((d) => String(d.department_id) === String(departmentId));
    const departmentLabel = departmentId ? (match?.department_name || "") : "All departments";
    return [campusLabel, departmentLabel].filter(Boolean).join(" · ");
  }, [campusId, campuses, canChoose, departmentId, departments]);

  return (
    <div style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 1 }}>
          {/* The heading follows the dropdown. A panel headed "Retention
              matrix" while showing migration is worse than no heading. */}
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, color: "var(--text-primary)" }}>
            {title || MATRIX_VIEWS[matrixView].heading}
          </h2>
          <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{selectedLabel}</span>
        </div>

        {/* One control row. Department appears only for admin and SSG; the term
            pair appears for everyone, a dean included — they cannot change
            which department they see, but they can change which term. */}
        <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
          {/* First in the row, because it decides what the rest are filtering. */}
          <select
            value={matrixView}
            onChange={(event) => {
              const next = event.target.value;
              setMatrixView(next);
              try {
                window.localStorage.setItem(MATRIX_VIEW_KEY, next);
              } catch {
                // Ignore: the choice still applies for this session.
              }
            }}
            style={{ ...selectStyle, fontWeight: 600 }}
            name="overview_matrix_view"
            aria-label="Choose which matrix to show"
          >
            {Object.entries(MATRIX_VIEWS).map(([key, view]) => (
              <option key={key} value={key}>{view.option}</option>
            ))}
          </select>

          {canChoose && campuses.length > 0 ? (
            <select
              value={campusId}
              onChange={(event) => {
                // A department belongs to one campus, so carrying the old one
                // across would scope the matrix to nothing.
                setCampusId(event.target.value);
                setDepartmentId("");
              }}
              style={selectStyle}
              name="retention_matrix_campus"
              aria-label="Filter the matrix by campus"
            >
              <option value="">All campuses</option>
              {campuses.map((campus) => (
                <option key={campus.campus_id} value={String(campus.campus_id)}>
                  {campus.campus_code || campus.campus_name}
                </option>
              ))}
            </select>
          ) : null}

          {canChoose ? (
            <select
              value={departmentId}
              onChange={(event) => setDepartmentId(event.target.value)}
              style={selectStyle}
              name="retention_matrix_department"
              aria-label="Filter the matrix by department"
            >
              <option value="">{campusId ? "All departments on this campus" : "All departments"}</option>
              {campusDepartments.map((department) => (
                <option key={department.department_id} value={String(department.department_id)}>
                  {department.department_code || department.department_name}
                  {departmentCampusSuffix(department, departments, campuses)}
                </option>
              ))}
            </select>
          ) : null}

          <select
            value={schoolYearId}
            onChange={(event) => setSchoolYearId(event.target.value)}
            style={selectStyle}
            name="retention_matrix_school_year"
            aria-label="Filter the matrix by school year"
          >
            <option value="">Latest school year</option>
            {schoolYears.map((year) => (
              <option key={year.school_year_id} value={String(year.school_year_id)}>
                {year.schoolyear_name}
              </option>
            ))}
          </select>

          <select
            value={semesterId}
            onChange={(event) => setSemesterId(event.target.value)}
            style={selectStyle}
            name="retention_matrix_semester"
            aria-label="Filter the matrix by semester"
          >
            <option value="">Latest semester</option>
            {semesters.map((semester) => (
              <option key={semester.semester_id} value={String(semester.semester_id)}>
                {semester.semester_name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {error ? (
        <div
          role="alert"
          style={{
            background: "var(--danger-100)",
            color: "var(--danger-800)",
            border: "1px solid var(--danger-200)",
            borderRadius: 6,
            padding: "8px 9px",
            fontSize: 11.5,
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, padding: 11 }}>
        {/* Remounts on any scope change so the matrix refetches cleanly rather
            than leaving the previous selection's rows on screen. The view is in
            the key too: switching must not show the other grid's rows for a
            frame while the new request is in flight. */}
        {matrixView === "migration" ? (
          <YearMigrationMatrix
            key={`mig-${campusId || "all"}-${departmentId || "all"}-${schoolYearId || "latest"}-${semesterId || "latest"}`}
            campusId={campusId || null}
            departmentId={departmentId || null}
            schoolYearId={schoolYearId || null}
            semesterId={semesterId || null}
          />
        ) : (
          <RetentionMatrix
            key={`ret-${campusId || "all"}-${departmentId || "all"}-${schoolYearId || "latest"}-${semesterId || "latest"}`}
            campusId={campusId || null}
            departmentId={departmentId || null}
            schoolYearId={schoolYearId || null}
            semesterId={semesterId || null}
          />
        )}
      </div>
    </div>
  );
}
