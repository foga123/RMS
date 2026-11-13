import React from "react";
import { yearLevelLabel } from "../../lib/yearLevel";
import { courseCampusSuffix, departmentCampusSuffix } from "../../lib/scopeOptionLabels";

/**
 * The Campus -> Department -> Course -> Year level chain.
 *
 * Lifted out of OverviewCharts so the Reports page can use the *same* control
 * rather than a second one that looks like it. Two copies of a dependent filter
 * chain drift within a release: one clears Year when Department changes and the
 * other does not, and the two screens quietly start answering for different
 * sets of students while both claim the same scope.
 *
 * Presentational and controlled — it owns no state and fetches nothing. The
 * option lists and the current selection come from whoever renders it, because
 * both screens already hold a server payload that carries them and neither
 * should pay for a second request to fill a dropdown.
 */

const labelStyle = {
  fontSize: 10.5,
  fontWeight: 600,
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "var(--text-muted)",
};

const selectStyle = {
  minWidth: 136,
  padding: "5px 8px",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  fontSize: 11.5,
  color: "var(--text-primary)",
};

/**
 * One step of the chain.
 *
 * Labelled and stacked rather than a bare row of selects: with three dependent
 * controls the reader has to be able to see which one feeds the next, and an
 * unlabelled row reading "All departments / All courses / All year levels" does
 * not say that picking the first is what fills the second.
 */
export function FilterStep({ id, label, value, onChange, disabled, hint, children }) {
  return (
    <label htmlFor={id} style={{ display: "grid", gap: 3, minWidth: 0 }}>
      <span style={labelStyle}>{label}</span>
      <select
        id={id}
        name={id}
        value={value}
        onChange={onChange}
        disabled={disabled}
        title={disabled ? hint : undefined}
        style={{
          ...selectStyle,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.55 : 1,
          background: disabled ? "var(--surface-muted, #f1f5f9)" : "var(--surface-base)",
        }}
      >
        {children}
      </select>
    </label>
  );
}

/** Drawn, not implied by adjacency — the arrow is the point of the layout. */
function Arrow() {
  return (
    <span aria-hidden="true" style={{ color: "var(--text-faint)", fontSize: 12.5, paddingBottom: 6 }}>
      →
    </span>
  );
}

/**
 * Clearing rules for a department change, exported so both screens obey them
 * and so they can be tested without rendering anything.
 *
 * A course belongs to exactly one department, so carrying a course across a
 * department change scopes everything to nothing. Year is cleared for a softer
 * reason: the new department may not run that year at all, and restarting the
 * chain is less confusing than a filter that silently drops on arrival.
 */
export function scopeAfterDepartmentChange(departmentId) {
  return { departmentId, courseId: "", yearLevel: "" };
}

/**
 * A campus change restarts the chain entirely.
 *
 * A department belongs to exactly one campus, so carrying the old department
 * across would scope everything to nothing — the same failure as carrying a
 * course across a department change, one level higher up. `campusId` is
 * returned alongside the cleared steps rather than merged into the old scope,
 * so nothing below it can survive by accident.
 */
export function scopeAfterCampusChange(campusId) {
  return { campusId, departmentId: "", courseId: "", yearLevel: "" };
}

/** Same reasoning one level down: year levels are listed per course. */
export function scopeAfterCourseChange(scope, courseId) {
  return { ...scope, courseId, yearLevel: "" };
}

/** "CCS · BSIT · Year 2" — what the current selection actually covers. */
export function describeScope({ campusName, departmentName, courseName, yearLevel } = {}) {
  return [campusName, departmentName, courseName, yearLevel ? yearLevelLabel(yearLevel) : null]
    .filter(Boolean)
    .join(" · ");
}

export default function ScopeFilter({
  idPrefix,
  scope,
  onChange,
  campuses = [],
  departments = [],
  courses = [],
  yearLevels = [],
  canChooseDepartment = true,
  departmentLocked = false,
  departmentLabel = "this department",
}) {
  const { campusId = "", departmentId = "", courseId = "", yearLevel = "" } = scope || {};

  /*
   * Departments narrow to the chosen campus here rather than on the server.
   *
   * The list already carries campus_id, so filtering it is a comparison — and
   * doing it client-side means changing campus repaints the next step instead
   * of waiting on a round trip to find out which departments survived. A
   * department row without campus_id is kept: it is unassigned, not excluded.
   */
  const campusDepartments = campusId
    ? departments.filter((d) => d.campus_id == null || String(d.campus_id) === String(campusId))
    : departments;

  // A dean is pinned to one department server-side, so for them the chain
  // starts already answered and Course is live immediately.
  const departmentChosen = departmentLocked || departmentId !== "";
  const courseStepReady = departmentChosen && courses.length > 0;

  return (
    <div style={{ display: "flex", alignItems: "flex-end", gap: 7, flexWrap: "wrap" }}>
      {/* Campus rides on the same permission as department: whoever may not
          choose a department is pinned inside one campus already, so the step
          would have a single meaningful setting for them. */}
      {canChooseDepartment && campuses.length > 0 ? (
        <>
          <FilterStep
            id={`${idPrefix}_campus`}
            label="Campus"
            value={campusId}
            onChange={(event) => onChange(scopeAfterCampusChange(event.target.value))}
          >
            <option value="">All campuses</option>
            {campuses.map((campus) => (
              <option key={campus.campus_id} value={String(campus.campus_id)}>
                {campus.campus_code || campus.campus_name}
              </option>
            ))}
          </FilterStep>
          <Arrow />
        </>
      ) : null}

      {canChooseDepartment ? (
        <>
          <FilterStep
            id={`${idPrefix}_department`}
            label="Department"
            value={departmentId}
            onChange={(event) => onChange({ campusId, ...scopeAfterDepartmentChange(event.target.value) })}
          >
            <option value="">{campusId ? "All departments on this campus" : "All departments"}</option>
            {campusDepartments.map((department) => (
              <option key={department.department_id} value={String(department.department_id)}>
                {department.department_code || department.department_name}
                {departmentCampusSuffix(department, campusDepartments, campuses)}
              </option>
            ))}
          </FilterStep>
          <Arrow />
        </>
      ) : null}

      <FilterStep
        id={`${idPrefix}_course`}
        label="Course"
        value={courseId}
        onChange={(event) => onChange(scopeAfterCourseChange({ campusId, departmentId, courseId, yearLevel }, event.target.value))}
        disabled={!courseStepReady}
        hint="Choose a department first"
      >
        {/* The empty option carries the state of the step, so a disabled
            control still explains itself instead of showing a blank box. */}
        {!departmentChosen ? (
          <option value="">Choose a department first</option>
        ) : courses.length === 0 ? (
          <option value="">No courses with students</option>
        ) : (
          <option value="">All courses in {departmentLabel}</option>
        )}
        {courses.map((course) => (
          <option key={course.course_id} value={String(course.course_id)}>
            {course.course_code || course.course_name}
            {/* A no-op unless this list actually holds two courses with
                one code, which the department step normally prevents. */}
            {courseCampusSuffix(course, courses)}
          </option>
        ))}
      </FilterStep>

      <Arrow />

      <FilterStep
        id={`${idPrefix}_year`}
        label="Year level"
        value={yearLevel}
        onChange={(event) => onChange({ campusId, departmentId, courseId, yearLevel: event.target.value })}
        disabled={yearLevels.length === 0}
        hint="No year levels recorded in this scope"
      >
        <option value="">{yearLevels.length === 0 ? "No year levels recorded" : "All year levels"}</option>
        {yearLevels.map((year) => (
          <option key={year} value={String(year)}>
            {yearLevelLabel(year)}
          </option>
        ))}
      </FilterStep>
    </div>
  );
}
