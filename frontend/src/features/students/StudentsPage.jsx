import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Modal from "../../shared/components/Modal";
import Form, { FormActions, FormField } from "../../shared/components/Form";
import Table from "../../shared/components/Table";
import { ActionMenu, AlertMessage, Button, ColumnMenu, ExportMenu, Pagination, SectionHeader } from "../../shared/components/ui";
import { TABLE_EXPORT_FORMATS, exportTable } from "../../shared/lib/tableExport";
import Card from "../../shared/components/ui/Card";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import ImportDialog from "../../shared/components/import/ImportDialog";
import StudentTermHistory from "./StudentTermHistory";
import { buildCourseMatchIndex } from "./courseLookup";
import { DEFAULT_YEAR_DURATION, buildStudentImportRows, trimToNull } from "./studentImportRows";
import { STUDENT_IMPORT_BATCH_SIZE, sendStudentBatches } from "./studentImportBatches";
import StudentFilterPanel from "./StudentFilterPanel";
import {
  EMPTY_STUDENT_FILTERS,
  applyStudentFilters,
  countActiveStudentFilters,
  describeStudentFilters,
} from "./studentFilters";
import useDropdownOptions, { getDropdownDefault, optionsWithCurrent } from "../../shared/lib/dropdownOptions";
import {
  STUDENT_TYPES,
  STUDENT_TYPE_LABEL,
  STUDENT_TYPE_NON_STAR,
  STUDENT_TYPE_STAR,
} from "../../shared/lib/studentType";
import { confirmAction } from "../../shared/lib/notify";
import { normalizeCsvToken, parseSpreadsheetRows } from "../../shared/lib/spreadsheet";
import { getBackendUrl } from "../../shared/lib/url";
import { courseIdentityKey } from "../../shared/lib/scopeOptionLabels";
import { resolveSchoolYearId } from "../../shared/lib/schoolYears";
import { currentTermSchoolYearName, importSchoolYearField, useCurrentTerm } from "../../shared/lib/currentTerm";
import {
  composeSection,
  normalizeSection,
  sanitizeSectionInput,
  sectionMatchesCourse,
  validateSection,
  validateStudentNumber,
} from "../../shared/lib/studentIdentity";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import usePagedRows from "../../shared/hooks/usePagedRows";
import { yearLevelLabel } from "../../shared/lib/yearLevel";

const fieldStyle = {
  width: "100%",
  padding: "6px 8px",
  fontSize: 12.5,
  border: "1px solid var(--border-base)",
  borderRadius: 5,
  boxSizing: "border-box",
  background: "#fff",
};

/**
 * Department and campus are not editable here — neither is a column on the
 * student, and both are read through the course. A department-scoped reader is
 * pinned to one of each already, and institution-wide the Course picker below
 * decides them, so a second control could only contradict the first. This
 * states the destination instead, so it is clear where a new student lands.
 */
const scopeBannerStyle = {
  gridColumn: "1 / -1",
  display: "flex",
  flexWrap: "wrap",
  gap: 19,
  padding: "8px 11px",
  background: "var(--surface-page)",
  border: "1px solid var(--border-base)",
  borderRadius: 6,
};
const scopeLabelStyle = { display: "block", fontSize: 10.5, color: "var(--text-faint)", marginBottom: 2 };
const scopeValueStyle = { fontSize: 12.5, fontWeight: 600, color: "var(--text-primary)" };

/**
 * A name as the record will store it.
 *
 * toLocaleUpperCase rather than toUpperCase so an accented name -- Muñoz,
 * Peña -- uppercases the accented letter too, matching what
 * normalize_student_name() does with MB_CASE_UPPER on the server.
 */
const upperName = (value) => String(value ?? "").toLocaleUpperCase();

// One empty list for "not loaded yet", so a memo keyed on the choices does not
// recompute on every render while the lists are on their way.
const NO_CHOICES = [];

const emptyForm = {
  id: "",
  student_number: "",
  student_type: "Non-STAR",
  first_name: "",
  last_name: "",
  middle_name: "",
  extension_name: "",
  email_address: "",
  gender: "",
  // Blank until picked; the select shows the list's default and the server
  // applies it, so the default is named in one place (the server's list).
  modality: "",
  mobile_number: "",
  course_id: "",
  year_level: "",
  section: "",
  schoolyear_id: "",
  final_scholarship_grant: "",
};

async function fetchAllPages(path, limit = 200) {
  let page = 1;
  let total = Number.POSITIVE_INFINITY;
  const rows = [];

  while (rows.length < total) {
    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("limit", String(limit));

    // The path may already carry a filter, e.g. status.php?status_type=enrollment.
    // Joining with a second "?" would send the whole thing as one malformed
    // parameter and quietly return the unfiltered first page.
    const res = await fetch(getBackendUrl(`${path}${path.includes("?") ? "&" : "?"}${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json?.message || `Failed to load ${path}`);

    const batch = Array.isArray(json?.data) ? json.data : [];
    rows.push(...batch);

    const reportedTotal = Number(json?.pagination?.total);
    total = Number.isFinite(reportedTotal) ? reportedTotal : rows.length;
    if (batch.length === 0) break;
    page += 1;
    if (page > 100) break;
  }

  return rows;
}

/**
 * The columns the review step shows for each row that will be created.
 *
 * Six of the twenty-odd the importer reads, chosen for what they prove: that
 * the right people are in the file (number and name), that the course column
 * was understood (it renders resolved, so a row written as "Bachelor of Science
 * in Information Technology" shows BSIT), and that year, section and school
 * year are what the reader meant. The rest are carried through unseen — they
 * are copied, not interpreted, so there is nothing to check.
 */
const IMPORT_PREVIEW_COLUMNS = [
  { key: "student_number", label: "Student no." },
  { key: "name", label: "Name" },
  { key: "course", label: "Course" },
  { key: "year_level", label: "Year" },
  { key: "section", label: "Section" },
  { key: "school_year", label: "School year" },
];

function hasModuleAction(permissions, action) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return true;
  }

  const normalized = permissions.map((entry) => String(entry || "").trim().toLowerCase());
  if (normalized.includes("manage")) return true;
  if (action === "view") return normalized.includes("view") || normalized.length > 0;
  return normalized.includes(String(action || "").trim().toLowerCase());
}

/* --------------------------------------------------------- bulk selection */

/**
 * The select-all box, which has three states rather than two.
 *
 * "Some of these rows are selected" is not the same as either checked or
 * unchecked, and `indeterminate` is the only way to say it — it cannot be set
 * from JSX because it is a DOM property with no matching attribute, so it goes
 * on through a ref.
 */
function SelectAllCheckbox({ checked, indeterminate, onChange, disabled, label }) {
  const ref = useRef(null);

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      aria-label={label}
      title={label}
      style={{ cursor: disabled ? "not-allowed" : "pointer", width: 14, height: 14 }}
    />
  );
}

/* ----------------------------------------------------------- the columns */

/**
 * Every column the table can draw, and the eight it draws by default.
 *
 * One list rather than a default set plus an "extra" set, because the moment
 * they are two lists a field ends up in neither. `default: true` marks what a
 * fresh install shows; Reset in the column menu goes back to exactly these.
 *
 * The values come off the row as stored — this is the same data the record view
 * shows, laid out the other way round. A field with nothing in it renders a
 * dash, for the reason in DetailField.
 */
const STUDENT_COLUMN_STORAGE_KEY = "coc-student-columns";

/** Student Number identifies the row, so it can never be switched off. */
const LOCKED_STUDENT_COLUMNS = ["display_student_number"];

function textOr(value) {
  const text = value === null || value === undefined ? "" : String(value).trim();
  return text === "" ? "\u2014" : text;
}

function stampOr(value) {
  if (!value) return "\u2014";
  const parsed = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

/*
 * `nowrap` on every column whose value is an identifier rather than prose.
 *
 * Student number, section, school year and course code are all hyphenated, and
 * CSS treats a hyphen as a break opportunity — so without this the table splits
 * 02-2526-000001 into "02-2526-" and "000001" across two lines, which reads as
 * two different students. Names, addresses and anything else a person wrote in
 * sentences are left to wrap, which is what they should do.
 */
const STUDENT_COLUMNS = [
  { key: "display_no", label: "No.", default: true, nowrap: true },
  { key: "display_student_number", label: "Student Number", default: true, nowrap: true },
  { key: "display_student_type", label: STUDENT_TYPE_LABEL, default: true, nowrap: true },
  /*
   * Who coaches the student, and which unit that is - SSP for Non-STAR, KASAMA
   * for STAR. Read from the assignment board's record by student.php
   * (`coach_unit`, `coach_name`), so this and the board name the same coach.
   *
   * Keyed "coaching_unit" because that key already existed here, bound to the
   * raw foreign key column nothing has ever filled - keeping the key keeps
   * anybody's saved column choice pointing at the right column.
   */
  { key: "coaching_unit", label: "Coaching Unit", default: true, nowrap: true, render: (row) => textOr(row.coach_unit) },
  { key: "coach_name", label: "Coach", default: true, nowrap: true, render: (row) => textOr(row.coach_name) },
  { key: "display_name", label: "Name", default: true },
  { key: "display_course", label: "Course", default: true, nowrap: true },
  /*
   * Campus, next to Course and on by default.
   *
   * It was available but unticked, which was fine while a course named a
   * campus on its own. It does not any more: CITE runs on Carmen and Puerto
   * and each offers a course coded BSIT, so two rows reading "BSIT" can be two
   * different courses with different students. Course alone stopped being an
   * answer to "which one is this", and the column that completes it should not
   * be something a reader has to know to go and tick.
   *
   * Read through the same chain the campus filter walks - the row's course
   * names the department, and the department names the campus.
   */
  { key: "display_campus", label: "Campus", default: true, nowrap: true },
  // Year and Section are two facts, so they are two columns - a reader sorting
  // or exporting by year should not have to split "1 / COC-FAB-BSIT1-01" back
  // apart by hand. Year reads through yearLevelLabel so the header says
  // "1st Year" here and in the detail panel alike.
  { key: "year_level", label: "Year", default: true, nowrap: true, render: (row) => textOr(row.year_level ? yearLevelLabel(row.year_level) : "") },
  { key: "section", label: "Section", default: true, nowrap: true, render: (row) => textOr(row.section) },
  { key: "display_school_year", label: "School Year", default: true, nowrap: true },

  { key: "first_name", label: "First Name", render: (row) => textOr(row.first_name) },
  { key: "middle_name", label: "Middle Name", render: (row) => textOr(row.middle_name) },
  { key: "last_name", label: "Last Name", render: (row) => textOr(row.last_name) },
  { key: "extension_name", label: "Extension", nowrap: true, render: (row) => textOr(row.extension_name) },
  { key: "gender", label: "Gender", nowrap: true, render: (row) => textOr(row.gender) },
  { key: "email_address", label: "Email", render: (row) => textOr(row.email_address) },
  { key: "mobile_number", label: "Mobile", nowrap: true, render: (row) => textOr(row.mobile_number) },
  { key: "facebook_name", label: "Facebook", render: (row) => textOr(row.facebook_name) },
  { key: "home_address", label: "Home Address", render: (row) => textOr(row.home_address) },
  { key: "mother_number", label: "Mother's Number", nowrap: true, render: (row) => textOr(row.mother_number) },
  { key: "father_number", label: "Father's Number", nowrap: true, render: (row) => textOr(row.father_number) },
  { key: "display_department", label: "Department" },
  { key: "modality", label: "Modality", nowrap: true, render: (row) => textOr(row.modality) },
  { key: "final_scholarship_grant", label: "Scholarship", render: (row) => textOr(row.final_scholarship_grant) },
  { key: "batch_id", label: "Batch", nowrap: true, render: (row) => textOr(row.batch_id) },
  // student_id is the internal row key, not something a reader identifies a
  // student by — it stays out of the column list. The student number is the
  // human-facing identifier. (The id is still used behind the scenes for row
  // selection and the archive/restore/delete actions.)
  { key: "updated_at", label: "Last Updated", nowrap: true, render: (row) => stampOr(row.updated_at) },
];

const DEFAULT_STUDENT_COLUMN_KEYS = STUDENT_COLUMNS.filter((column) => column.default).map((column) => column.key);

/*
 * Default columns added after people had already saved a choice.
 *
 * A saved list wins over the defaults, so a new column would never appear for
 * anyone who had once customised the table. Each one here is offered once -
 * slotted in after the cohort column - and remembered as offered, so taking it
 * off again sticks.
 */
const STUDENT_COLUMN_ADDITIONS = ["coaching_unit", "coach_name"];
const STUDENT_COLUMN_ADDITIONS_KEY = `${STUDENT_COLUMN_STORAGE_KEY}:offered`;

function offerNewStudentColumns(kept) {
  let offered = [];
  try {
    offered = JSON.parse(window.localStorage.getItem(STUDENT_COLUMN_ADDITIONS_KEY) || "[]");
  } catch {
    offered = [];
  }
  if (!Array.isArray(offered)) offered = [];

  const toOffer = STUDENT_COLUMN_ADDITIONS.filter((key) => !offered.includes(key) && !kept.includes(key));
  const next = [...kept];
  if (toOffer.length > 0) {
    const anchor = next.indexOf("display_student_type");
    next.splice(anchor >= 0 ? anchor + 1 : next.length, 0, ...toOffer);
  }
  try {
    window.localStorage.setItem(STUDENT_COLUMN_ADDITIONS_KEY, JSON.stringify([...new Set([...offered, ...STUDENT_COLUMN_ADDITIONS])]));
  } catch {
    // Private mode: the column is offered again next time, which is harmless.
  }
  return next;
}

/** Stored choice, filtered against the catalogue so a renamed key cannot break the table. */
function readStudentColumns() {
  try {
    const raw = JSON.parse(window.localStorage.getItem(STUDENT_COLUMN_STORAGE_KEY) || "null");
    // The defaults already include every addition; mark them offered so that
    // removing one later is not undone on the next visit.
    if (!Array.isArray(raw) || raw.length === 0) return offerNewStudentColumns(DEFAULT_STUDENT_COLUMN_KEYS);
    // "Year/Section" was one column and is now two. Expand a saved copy in place
    // so a returning reader keeps both where the combined column used to sit,
    // rather than silently losing it to the unknown-key filter below.
    const expanded = raw.flatMap((key) =>
      key === "display_year_section" ? ["year_level", "section"] : [key]
    );
    const known = new Set(STUDENT_COLUMNS.map((column) => column.key));
    const seen = new Set();
    const kept = expanded.filter((key) => known.has(key) && !seen.has(key) && seen.add(key));
    return offerNewStudentColumns(kept.length > 0 ? kept : DEFAULT_STUDENT_COLUMN_KEYS);
  } catch {
    return DEFAULT_STUDENT_COLUMN_KEYS;
  }
}

/* ------------------------------------------------------- the whole record */

/**
 * One stored value, labelled.
 *
 * A field with nothing in it renders an em dash rather than disappearing. The
 * point of this view is to show what the record actually holds, and a missing
 * row reads as "this system does not track that" when the truth is "nobody has
 * filled it in" — which is the thing a registrar needs to see.
 */
function DetailField({ label, value, wide = false }) {
  const text = value === null || value === undefined || String(value).trim() === "" ? null : String(value);

  return (
    <div style={{ display: "grid", gap: 2, minWidth: 0, gridColumn: wide ? "1 / -1" : undefined }}>
      <dt style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: 0.4, color: "var(--text-faint)" }}>
        {label}
      </dt>
      <dd
        style={{
          margin: 0,
          fontSize: 12.5,
          lineHeight: 1.45,
          color: text ? "var(--text-primary)" : "var(--text-faint)",
          overflowWrap: "anywhere",
        }}
      >
        {text ?? "\u2014"}
      </dd>
    </div>
  );
}

/** A titled band of fields, two columns where there is room for two. */
function DetailGroup({ title, children }) {
  return (
    <Card padding="md" style={{ display: "grid", gap: 8, alignContent: "start" }}>
      <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>{title}</h3>
      <dl
        style={{
          margin: 0,
          display: "grid",
          gap: 9,
          gridTemplateColumns: "repeat(auto-fit, minmax(min(150px, 100%), 1fr))",
        }}
      >
        {children}
      </dl>
    </Card>
  );
}

/** Dates as the reader's local time, or nothing at all. */
function formatStamp(value) {
  if (!value) return "";
  const parsed = new Date(String(value).replace(" ", "T"));
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toLocaleString();
}

/**
 * Every column the `student` table carries, for one student.
 *
 * The list above is deliberately eight scannable columns; this is the record
 * behind a row. Nothing here is fetched: student.php already returns SELECT *,
 * so the full row has always been in the browser and only the columns chosen
 * for the table were ever drawn. Ids are resolved to names where a lookup is
 * already loaded, and shown as ids where one is not — an unresolved id is still
 * the truth, and inventing a second request to prettify it would be a worse
 * trade than showing the number.
 */
function StudentDetail({ student, courseById, courseNameById, schoolYearNameById }) {
  if (!student) return null;

  const course = courseById[String(student.course_id)] || null;
  const fullName = [student.last_name, student.first_name].filter(Boolean).join(", ")
    + (student.middle_name ? ` ${student.middle_name}` : "")
    + (student.extension_name ? ` ${student.extension_name}` : "");

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <Card accent padding="lg" style={{ display: "grid", gap: 5 }}>
        <div style={{ display: "flex", gap: 7, alignItems: "center", flexWrap: "wrap" }}>
          <span style={{ fontSize: 14, fontWeight: 700, color: "var(--text-primary)" }}>
            {fullName || "Unnamed student"}
          </span>
          <span
            style={{
              fontSize: 10.5,
              fontWeight: 600,
              padding: "2px 7px",
              borderRadius: 999,
              background: "var(--brand-100)",
              color: "var(--brand-800)",
            }}
          >
            {student.student_type || "Non-STAR"}
          </span>
          {student.archived_at ? (
            <span
              style={{
                fontSize: 10.5,
                fontWeight: 600,
                padding: "2px 7px",
                borderRadius: 999,
                background: "var(--danger-100)",
                color: "var(--danger-800)",
              }}
            >
              Archived
            </span>
          ) : null}
        </div>
        <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
          {student.student_number || "No student number"}
          {course ? ` \u00b7 ${course.course_code || course.course_name}` : ""}
          {student.year_level ? ` \u00b7 ${yearLevelLabel(student.year_level)}` : ""}
          {student.section ? ` \u00b7 ${student.section}` : ""}
        </div>
      </Card>

      <DetailGroup title="Identity">
        <DetailField label="Student number" value={student.student_number} />
        <DetailField label="Student type" value={student.student_type} />
        <DetailField label="First name" value={student.first_name} />
        <DetailField label="Middle name" value={student.middle_name} />
        <DetailField label="Last name" value={student.last_name} />
        <DetailField label="Extension" value={student.extension_name} />
        <DetailField label="Gender" value={student.gender} />
      </DetailGroup>

      <DetailGroup title="Contact">
        <DetailField label="Email address" value={student.email_address} />
        <DetailField label="Mobile number" value={student.mobile_number} />
        <DetailField label="Facebook name" value={student.facebook_name} />
        <DetailField label="Home address" value={student.home_address} wide />
      </DetailGroup>

      <DetailGroup title="Academic">
        <DetailField label="Course" value={course ? (course.course_name || course.course_code) : courseNameById[String(student.course_id)]} />
        <DetailField label="Department" value={course?.department_name || course?.department_code} />
        <DetailField label="Year level" value={student.year_level ? yearLevelLabel(student.year_level) : ""} />
        <DetailField label="Section" value={student.section} />
        <DetailField label="School year" value={schoolYearNameById[String(student.schoolyear_id)]} />
        <DetailField label="Modality" value={student.modality} />
        <DetailField label="Scholarship grant" value={student.final_scholarship_grant} />
        <DetailField label="Batch" value={student.batch_id} />
        <DetailField label="Coaching unit" value={student.coach_unit} />
        <DetailField label="Coach" value={student.coach_name} />
      </DetailGroup>

      <DetailGroup title="Family">
        <DetailField label="Mother's Number" value={student.mother_number} />
        <DetailField label="Father's Number" value={student.father_number} />
      </DetailGroup>

      <DetailGroup title="Record">
        <DetailField label="Archived on" value={formatStamp(student.archived_at)} />
        <DetailField label="Last updated" value={formatStamp(student.updated_at)} />
      </DetailGroup>
    </div>
  );
}

export default function StudentManage({ departmentId, departmentName, campusName = "", permissions = [], requireDepartment = true, archiveMode = false }) {
  const [students, setStudents] = useState([]);
  const [courses, setCourses] = useState([]);
  const [schoolYears, setSchoolYears] = useState([]);
  /**
   * The school year an import belongs to.
   *
   * Read from Academic Calendar for the whole file. An older template may
   * carry the same school year; a different year is rejected.
   */
  const [importTerm, setImportTerm] = useState({ campus_id: "" });
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  // ImportDialog owns the file and the progress/result state.
  const [importOpen, setImportOpen] = useState(false);
  /*
   * How far through the batches the current run is.
   *
   * A 5,000-row import is several seconds of one-request-at-a-time silence,
   * and silence during a write reads as a hang — which is when people close
   * the tab halfway through.
   */
  const [importProgress, setImportProgress] = useState(null);
  const [search, setSearch] = useState("");
  /*
   * Active or archived. Archiving is now the only place a student can be
   * withdrawn from the portal, so this module also has to be the place they
   * can be found again — an archive with no way to read it is a delete with
   * extra steps.
   */
  const [viewMode, setViewMode] = useState("active");
  /*
   * Campus, the step above course.
   *
   * A student carries no campus of its own — it is reached through
   * course -> department -> campus — so this narrows by the campus the row's
   * course sits on. Only offered on the institution-wide view: a department
   * belongs to exactly one campus, so for a dean the control would have a
   * single meaningful setting.
   */
  const [selectedCampusFilter, setSelectedCampusFilter] = useState("");
  const [selectedCourseFilter, setSelectedCourseFilter] = useState("");
  const [selectedYearLevelFilter, setSelectedYearLevelFilter] = useState("");
  /*
   * Which school year's students are on screen.
   *
   * "School Year" was already a column here but nothing could narrow by it, so
   * every intake ever enrolled sat in one list and the only way to look at this
   * year's cohort was to read the column and scroll. It stands apart from the
   * campus -> course -> year-level chain rather than joining it: a school year
   * does not belong to a campus, so changing campus must not clear it.
   */
  const [selectedSchoolYearFilter, setSelectedSchoolYearFilter] = useState("");
  /*
   * The conditions behind the Filters button.
   *
   * Held separately from the three above, which chain into one another and have
   * their own clearing effects. Folding all nine into one object would mean
   * rewriting that chain, and it works.
   */
  const [conditionFilters, setConditionFilters] = useState(EMPTY_STUDENT_FILTERS);
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [openModal, setOpenModal] = useState(false);
  /*
   * The student whose full record is open, or null.
   *
   * Holds the row itself rather than an id: the row already carries every
   * column, so keeping an id would mean looking it up again on every render for
   * no gain. Cleared, not refreshed, when the list reloads — a stale record on
   * screen is better than one that changes under the reader mid-read.
   */
  const [detailStudent, setDetailStudent] = useState(null);
  /*
   * Which columns are drawn. Remembered per browser for the same reason as the
   * sidebar: it is a decision about this screen and this monitor, and losing it
   * on every navigation would make the control not worth using.
   */
  const [visibleColumnKeys, setVisibleColumnKeys] = useState(readStudentColumns);
  /*
   * Ticked rows, by student id.
   *
   * Ids rather than rows, because the list reloads under the selection every
   * time a live refresh lands and object identity would not survive it. Held
   * across search and filter changes — a selection that evaporated when you
   * typed would be unusable — so the count in the bar, not what is on screen,
   * is what the bulk action operates on, and the confirmation says the number.
   */
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Holds the one-time credentials for a just-created student login.
  const [newAccount, setNewAccount] = useState(null);
  const [form, setForm] = useState(emptyForm);
  // Gender, grant and modality choices - the office's lists, from the server.
  const dropdownLists = useDropdownOptions();
  const genderChoices = dropdownLists.genders || NO_CHOICES;
  const modalityChoices = dropdownLists.modalities || NO_CHOICES;
  const grantChoices = dropdownLists.scholarship_grants || NO_CHOICES;
  /*
   * Campus chosen inside the Add/Edit form, kept apart from the table's
   * selectedCampusFilter so narrowing the form does not re-scope the list
   * behind it. A student has no campus column — it is reached through
   * course -> department -> campus — so this is a picker that narrows the
   * Course dropdown, not a value that is saved. What gets stored is course_id,
   * and the course carries the campus.
   */
  const [formCampusId, setFormCampusId] = useState("");

  const normalizedDepartmentId = useMemo(() => {
    const id = Number(departmentId);
    return Number.isFinite(id) && id > 0 ? id : null;
  }, [departmentId]);
  const isDepartmentScoped = Boolean(requireDepartment);
  const canLoadData = !isDepartmentScoped || Boolean(normalizedDepartmentId);
  const canCreate = hasModuleAction(permissions, "create");
  const canEdit = hasModuleAction(permissions, "edit");
  const canDelete = hasModuleAction(permissions, "delete");
  const canArchive = archiveMode && (hasModuleAction(permissions, "archive") || canEdit);
  const canRestore = hasModuleAction(permissions, "restore") || canEdit;
  const isArchivedView = viewMode === "archived";
  // One tick column serves both tabs: Archive on the active list, Restore on
  // the archived one, so the reader learns one control rather than two.
  const canBulk = isArchivedView ? canRestore : canArchive || canDelete;
  const canImport = hasModuleAction(permissions, "import") || canCreate;
  /*
   * Anyone who can read the list can save it. Withholding export from a reader
   * who can already page through every record does not protect the records, it
   * just makes them retype what is on the screen. Explicit `export` still wins
   * where a role has been given it.
   */
  const canExport = hasModuleAction(permissions, "export") || hasModuleAction(permissions, "view") || canEdit;
  const [exporting, setExporting] = useState("");
  const sectionTitle = isArchivedView
    ? "Archived Students"
    : isDepartmentScoped
      ? "Students In My Department"
      : "All Students";
  const sectionLabel = isDepartmentScoped ? (departmentName || "Not Assigned") : "All Departments";
  const campusLabel = isDepartmentScoped ? (campusName || "Not Assigned") : "All Campuses";

  /**
   * The department code this account is scoped to, read off the course list.
   *
   * The signed-in user carries a department *id*, which names one row — and the
   * same college now has a row per campus. The code is what identifies the
   * department itself, so it is resolved from the courses already loaded rather
   * than by asking department.php, which needs a permission a dean does not have.
   */
  const scopeDepartmentCode = useMemo(() => {
    if (!normalizedDepartmentId) return "";
    const match = courses.find((course) => Number(course?.department_id) === normalizedDepartmentId);
    return String(match?.department_code || "").trim().toUpperCase();
  }, [courses, normalizedDepartmentId]);

  /**
   * Courses this account may see.
   *
   * Matched on department code, not id: a dean is appointed to CITE, and CITE
   * running on Carmen and Puerto is two department rows of one department.
   * Scoping to the single row would hide half their own students. The server
   * draws the same line in api_department_scope_sql(), so this cannot show a
   * course the API would then refuse.
   *
   * Falls back to the id when the code cannot be resolved — a department with
   * no courses yet — which narrows rather than widens.
   */
  const departmentCourses = useMemo(() => {
    if (!isDepartmentScoped) return courses;
    if (!normalizedDepartmentId) return [];
    if (!scopeDepartmentCode) {
      return courses.filter((course) => Number(course?.department_id) === normalizedDepartmentId);
    }
    return courses.filter(
      (course) => String(course?.department_code || "").trim().toUpperCase() === scopeDepartmentCode
    );
  }, [courses, isDepartmentScoped, normalizedDepartmentId, scopeDepartmentCode]);

  const allowedCourseIds = useMemo(() => {
    return new Set(departmentCourses.map((course) => Number(course?.course_id)).filter((id) => Number.isFinite(id)));
  }, [departmentCourses]);

  /**
   * The campuses the courses in view actually sit on.
   *
   * Read off the course rows rather than fetched from campus.php: course.php
   * already carries the campus of the department that owns the course, and a
   * second request would need the `campuses` module permission that a reader of
   * this page is not otherwise given.
   *
   * Derived from the courses *in scope*, so a dean is offered the campuses their
   * own department runs on and not every campus in the school.
   */
  const campusOptions = useMemo(() => {
    const byId = new Map();
    departmentCourses.forEach((course) => {
      const id = Number(course?.campus_id);
      if (!Number.isFinite(id) || id <= 0 || byId.has(id)) return;
      byId.set(id, { campus_id: id, label: course.campus_code || course.campus_name || `Campus ${id}` });
    });
    return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [departmentCourses]);

  /*
   * Shown when there is a choice to make, rather than by role.
   *
   * This used to be Admin and SSG only, on the reasoning that a department sits
   * on exactly one campus — true when a department was a single row, and no
   * longer true now that CITE runs on Carmen and Puerto. A dean whose
   * department spans campuses needs this control more than anyone.
   *
   * Institution-wide readers see it as soon as one campus has courses; a
   * department-scoped reader only once their own department runs on two, since
   * below that it would be a dropdown with one answer.
   */
  const showCampusFilter = campusOptions.length > (isDepartmentScoped ? 1 : 0);

  /**
   * Courses left after the campus choice — the list every step below it is
   * built from, so Course, Year level and the table can never offer something
   * the campus has already excluded.
   */
  const scopedCourses = useMemo(() => {
    const filterValue = String(selectedCampusFilter || "").trim();
    if (!filterValue) return departmentCourses;
    return departmentCourses.filter((course) => String(course?.campus_id ?? "") === filterValue);
  }, [departmentCourses, selectedCampusFilter]);

  const scopedCourseIds = useMemo(() => {
    return new Set(scopedCourses.map((course) => Number(course?.course_id)).filter((id) => Number.isFinite(id)));
  }, [scopedCourses]);

  /**
   * One entry per course code, not per course row.
   *
   * CITE runs on Carmen and Puerto, and each campus's CITE owns its own BSIT
   * row, so the plain course list offered "Bachelor of Science in Information
   * Technology" twice with nothing to choose between them. On the screens with
   * no campus control the answer is to label the two apart; here it is not,
   * because Campus is already the step above this one. Asking the reader to
   * pick a campus and then pick it again inside the course list is asking the
   * same question twice.
   *
   * So an option carries the code and every course id wearing it. With a
   * campus chosen that is one id, because scopedCourses is already narrowed to
   * that campus; with none it is both, and "BSIT" honestly means BSIT anywhere.
   */
  const courseFilterOptions = useMemo(() => {
    const byKey = new Map();
    scopedCourses.forEach((course) => {
      const key = courseIdentityKey(course);
      if (!key) return;
      const existing = byKey.get(key);
      if (existing) {
        existing.courseIds.push(Number(course.course_id));
        return;
      }
      byKey.set(key, {
        key,
        label: course.course_name || course.course_code || `Course ${course.course_id}`,
        code: course.course_code || "",
        courseIds: [Number(course.course_id)],
      });
    });
    return [...byKey.values()];
  }, [scopedCourses]);

  /** The course ids the chosen code stands for - null when nothing is chosen. */
  const selectedCourseIds = useMemo(() => {
    const chosen = String(selectedCourseFilter || "").trim();
    if (!chosen) return null;
    const option = courseFilterOptions.find((entry) => entry.key === chosen);
    return option ? new Set(option.courseIds.filter((id) => Number.isFinite(id))) : new Set();
  }, [courseFilterOptions, selectedCourseFilter]);

  /** The whole course row, so the detail view can name the department too. */
  const courseById = useMemo(() => {
    const map = {};
    courses.forEach((course) => {
      if (course?.course_id != null) map[String(course.course_id)] = course;
    });
    return map;
  }, [courses]);

  /*
   * Where a new record will land, for the banner at the top of the form.
   *
   * A student carries neither department nor campus of its own; both are read
   * through its course, so the chosen course is what the banner reports —
   * including for a dean, whose department may run on more than one campus and
   * whose home campus is therefore no longer the answer. Only with no course
   * picked yet does it fall back to the scope the module was opened in.
   */
  const formCourse = courseById[String(form.course_id || "")] || null;
  const formDepartmentLabel = formCourse?.department_name
    || formCourse?.department_code
    || (isDepartmentScoped ? sectionLabel : "Set by the course below");
  const formCampusLabel = formCourse?.campus_name
    || formCourse?.campus_code
    || (isDepartmentScoped ? campusLabel : "Set by the course below");

  /**
   * The courses offered by the Course dropdown, narrowed to the campus picked
   * in the form. With no campus chosen it is every course the account may see,
   * so the picker only ever removes ambiguity, never options the user needs.
   */
  const formCourseOptions = useMemo(() => {
    const campus = String(formCampusId || "").trim();
    if (!campus) return departmentCourses;
    return departmentCourses.filter((course) => String(course?.campus_id ?? "") === campus);
  }, [departmentCourses, formCampusId]);

  const courseNameById = useMemo(() => {
    const map = {};
    courses.forEach((course) => {
      if (course?.course_id != null) {
        map[String(course.course_id)] = course.course_name || course.course_code || `Course ${course.course_id}`;
      }
    });
    return map;
  }, [courses]);

  /**
   * Year levels are capped by the programme, not by a fixed 1-5.
   *
   * BS Architecture runs five years; every other course here runs four. The
   * length lives on the course row (course.year_duration), so this reads it
   * rather than naming any course code — a programme changing length is a data
   * edit, and the server enforces the same rule in student.php.
   */
  const courseYearDurationById = useMemo(() => {
    const map = {};
    courses.forEach((course) => {
      if (course?.course_id != null) {
        const duration = Number(course.year_duration);
        map[String(course.course_id)] = Number.isFinite(duration) && duration > 0 ? duration : DEFAULT_YEAR_DURATION;
      }
    });
    return map;
  }, [courses]);

  const selectedCourseYearDuration = useMemo(() => {
    const key = String(form.course_id || "");
    return courseYearDurationById[key] ?? DEFAULT_YEAR_DURATION;
  }, [courseYearDurationById, form.course_id]);

  const selectedCourseCode = useMemo(() => {
    const match = courses.find((course) => String(course?.course_id) === String(form.course_id));
    return match?.course_code || match?.course_name || "This course";
  }, [courses, form.course_id]);

  /** Course code by id, for checking a section name against the row it sits on. */
  const courseCodeById = useMemo(() => {
    const map = new Map();
    courses.forEach((course) => {
      if (course?.course_id != null && course?.course_code) {
        map.set(String(course.course_id), String(course.course_code));
      }
    });
    return map;
  }, [courses]);

  /**
   * What a section for the course and year already chosen would look like.
   *
   * The name is fully determined by the record except for the last two digits,
   * so showing it turns "what is the format again?" into a two-character edit.
   */
  const suggestedSection = useMemo(() => {
    const code = courseCodeById.get(String(form.course_id));
    const year = Number(form.year_level);
    if (!code || !Number.isFinite(year) || year < 1) return "";
    return composeSection(code, year, 1);
  }, [courseCodeById, form.course_id, form.year_level]);

  /**
   * Widest programme *in view* — bounds the filter dropdown.
   *
   * Measuring across the whole catalogue offered Year 5 to every dean, because
   * BS Architecture is five years and a catalogue-wide max is 5 no matter who
   * is looking. A CITE dean picking Year 5 then gets an empty table for a year
   * their department does not run. Narrowing to the courses actually in scope —
   * the dean's own department, or the single course they filtered to — offers
   * Year 5 only where a five-year programme exists.
   */
  const maxYearDuration = useMemo(() => {
    const inScope = selectedCourseIds
      ? scopedCourses.filter((course) => selectedCourseIds.has(Number(course?.course_id)))
      : scopedCourses;
    const durations = inScope
      .map((course) => courseYearDurationById[String(course?.course_id ?? "")])
      .filter((duration) => Number.isFinite(duration));
    return durations.length > 0 ? Math.max(...durations) : DEFAULT_YEAR_DURATION;
  }, [courseYearDurationById, scopedCourses, selectedCourseIds]);

  const schoolYearNameById = useMemo(() => {
    const map = {};
    schoolYears.forEach((schoolYear) => {
      if (schoolYear?.school_year_id != null) {
        map[String(schoolYear.school_year_id)] = schoolYear.schoolyear_name || `School Year ${schoolYear.school_year_id}`;
      }
    });
    return map;
  }, [schoolYears]);

  /**
   * Import lookup: a token to every course that answers to it, not just one.
   *
   * The rule itself is in courseLookup.js, with the tests that pin it down.
   * It stopped being a Map<code, id> when the same code became able to name a
   * course on two campuses - see that file for what went wrong before it did.
   */
  const courseMatchIndex = useMemo(() => buildCourseMatchIndex(departmentCourses), [departmentCourses]);

  /*
   * The same guard one step up. A campus that has left the list — its last
   * course archived, the row deleted — would otherwise leave a select showing
   * a value it no longer offers, over an empty table with no hint why.
   *
   * An empty list is left alone: that is a load in flight, not a campus going
   * away, and clearing on it would drop the choice on every refresh.
   */
  useEffect(() => {
    if (selectedCampusFilter === "" || campusOptions.length === 0) return;
    const stillOffered = campusOptions.some((campus) => String(campus.campus_id) === String(selectedCampusFilter));
    if (!stillOffered) {
      setSelectedCampusFilter("");
    }
  }, [campusOptions, selectedCampusFilter]);

  useEffect(() => {
    if (selectedCourseFilter === "") return;
    const stillOffered = courseFilterOptions.some((option) => option.key === selectedCourseFilter);
    if (!stillOffered) {
      setSelectedCourseFilter("");
    }
  }, [courseFilterOptions, selectedCourseFilter]);

  // The same guard for the year filter: narrowing the course can put the chosen
  // year out of range — Year 5 under BSAR, then switching to BSCE — and a year
  // the programme does not run shows an empty table with no hint why.
  useEffect(() => {
    if (selectedYearLevelFilter === "") return;
    if (Number(selectedYearLevelFilter) > maxYearDuration) {
      setSelectedYearLevelFilter("");
    }
  }, [maxYearDuration, selectedYearLevelFilter]);

  const schoolYearIdByLookup = useMemo(() => {
    const map = new Map();
    schoolYears.forEach((schoolYear) => {
      const numericId = Number(schoolYear?.school_year_id);
      if (!Number.isFinite(numericId)) return;
      map.set(String(numericId), numericId);

      const schoolYearName = normalizeCsvToken(schoolYear?.schoolyear_name);
      if (schoolYearName) map.set(schoolYearName, numericId);
    });
    return map;
  }, [schoolYears]);

  const rows = useMemo(() => {
    if (!canLoadData) return [];
    if (!isDepartmentScoped) return students;
    return students.filter((student) => allowedCourseIds.has(Number(student?.course_id)));
  }, [students, canLoadData, isDepartmentScoped, allowedCourseIds]);

  /*
   * Every school year on record, newest first.
   *
   * This listed only the years students were already recorded under, on the
   * reasoning that a year nobody is enrolled in can only ever empty the table.
   * That reasoning was wrong in the way that matters: 2026-2027 is a real term,
   * it is the current one, and nobody is filed under it yet — so the filter
   * quietly had no entry for the year the reader was looking for, and the
   * control read as broken rather than as empty. "No students in 2026-2027" is
   * an answer worth being able to ask for.
   *
   * A year a student points at but school_year.php does not list is kept too,
   * so a stale reference cannot make its students unfilterable.
   */
  const schoolYearFilterOptions = useMemo(() => {
    const byId = new Map();
    schoolYears.forEach((schoolYear) => {
      const id = String(schoolYear?.school_year_id ?? "").trim();
      if (id !== "") byId.set(id, schoolYear.schoolyear_name || `School Year ${id}`);
    });
    rows.forEach((student) => {
      const id = String(student?.schoolyear_id ?? "").trim();
      if (id !== "" && !byId.has(id)) byId.set(id, schoolYearNameById[id] || `School Year ${id}`);
    });
    return Array.from(byId, ([id, label]) => ({ id, label }))
      .sort((a, b) => b.label.localeCompare(a.label));
  }, [rows, schoolYears, schoolYearNameById]);

  // The same "no longer offered" guard the campus and course filters have: the
  // archived view, or a reload returning a different set of students, can drop
  // the year that was chosen and leave an empty table with no hint why.
  useEffect(() => {
    if (selectedSchoolYearFilter === "") return;
    if (schoolYearFilterOptions.length === 0) return;
    const stillOffered = schoolYearFilterOptions.some((option) => option.id === String(selectedSchoolYearFilter));
    if (!stillOffered) {
      setSelectedSchoolYearFilter("");
    }
  }, [schoolYearFilterOptions, selectedSchoolYearFilter]);

  /*
   * The campus step, applied to the rows rather than to the request: the list
   * is already in the browser, and a student is on a campus only by way of the
   * course it is enrolled in.
   */
  const campusScopedRows = useMemo(() => {
    if (!selectedCampusFilter) return rows;
    return rows.filter((student) => scopedCourseIds.has(Number(student?.course_id)));
  }, [rows, scopedCourseIds, selectedCampusFilter]);

  const courseScopedRows = useMemo(() => {
    if (!selectedCourseIds) return campusScopedRows;
    return campusScopedRows.filter((student) => selectedCourseIds.has(Number(student?.course_id)));
  }, [campusScopedRows, selectedCourseIds]);

  const yearLevelScopedRows = useMemo(() => {
    const filterValue = String(selectedYearLevelFilter || "").trim();
    if (!filterValue) return courseScopedRows;
    return courseScopedRows.filter((student) => String(student?.year_level ?? "") === filterValue);
  }, [courseScopedRows, selectedYearLevelFilter]);

  /* Matched on schoolyear_id, the column the row actually carries — the name is
     only ever resolved for display. */
  const schoolYearScopedRows = useMemo(() => {
    const filterValue = String(selectedSchoolYearFilter || "").trim();
    if (!filterValue) return yearLevelScopedRows;
    return yearLevelScopedRows.filter((student) => String(student?.schoolyear_id ?? "") === filterValue);
  }, [yearLevelScopedRows, selectedSchoolYearFilter]);

  /*
   * Everything the Filters button counts, and everything Clear all clears.
   *
   * The chained three are counted alongside the six conditions because to the
   * reader they are all just filters — a badge reading "Filters" while a course
   * filter is hiding four hundred rows is the bug this is here to prevent.
   */
  const activeFilterCount =
    countActiveStudentFilters(conditionFilters) +
    [selectedCampusFilter, selectedCourseFilter, selectedYearLevelFilter, selectedSchoolYearFilter].filter(Boolean).length;

  const clearAllFilters = useCallback(() => {
    setConditionFilters(EMPTY_STUDENT_FILTERS);
    setSelectedCampusFilter("");
    setSelectedCourseFilter("");
    setSelectedYearLevelFilter("");
    setSelectedSchoolYearFilter("");
  }, []);

  const activeFilterChips = useMemo(() => {
    const chips = [];
    if (selectedCampusFilter) {
      const campus = campusOptions.find((option) => String(option.campus_id) === String(selectedCampusFilter));
      chips.push({
        key: "campus",
        label: "Campus",
        value: campus?.label || selectedCampusFilter,
        // Clearing campus clears the two steps below it, exactly as changing it
        // does — otherwise a course from the cleared campus survives and scopes
        // the table to nothing.
        onRemove: () => {
          setSelectedCampusFilter("");
          setSelectedCourseFilter("");
          setSelectedYearLevelFilter("");
        },
      });
    }
    if (selectedCourseFilter) {
      const option = courseFilterOptions.find((entry) => entry.key === selectedCourseFilter);
      chips.push({
        key: "course",
        label: "Course",
        value: option?.code || option?.label || selectedCourseFilter,
        onRemove: () => setSelectedCourseFilter(""),
      });
    }
    if (selectedYearLevelFilter) {
      chips.push({
        key: "year_level",
        label: "Year",
        value: yearLevelLabel(Number(selectedYearLevelFilter)),
        onRemove: () => setSelectedYearLevelFilter(""),
      });
    }
    if (selectedSchoolYearFilter) {
      chips.push({
        key: "school_year",
        label: "School Year",
        value: schoolYearNameById[String(selectedSchoolYearFilter)] || selectedSchoolYearFilter,
        onRemove: () => setSelectedSchoolYearFilter(""),
      });
    }
    describeStudentFilters(conditionFilters).forEach((chip) => {
      chips.push({
        ...chip,
        onRemove: () => setConditionFilters((prev) => ({ ...prev, [chip.key]: "" })),
      });
    });
    return chips;
  }, [campusOptions, conditionFilters, courseFilterOptions, schoolYearNameById, selectedCampusFilter, selectedCourseFilter, selectedSchoolYearFilter, selectedYearLevelFilter]);

  const existingStudentNumbers = useMemo(() => {
    return new Set(rows.map((student) => normalizeCsvToken(student?.student_number)).filter(Boolean));
  }, [rows]);

  /*
   * The extra conditions, applied after the campus/course/year chain and before
   * the search box. Order does not change the result - they all AND together -
   * but it keeps the search running over the smallest set.
   */
  const conditionScopedRows = useMemo(
    () => applyStudentFilters(schoolYearScopedRows, conditionFilters),
    [schoolYearScopedRows, conditionFilters]
  );

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return conditionScopedRows;

    return conditionScopedRows.filter((row) => {
      const fullName = `${row?.last_name || ""}, ${row?.first_name || ""} ${row?.middle_name || ""}`;
      const courseName = courseNameById[String(row?.course_id)] || "";
      return (
        String(row?.student_number || "").toLowerCase().includes(q) ||
        String(row?.student_type || "").toLowerCase().includes(q) ||
        fullName.toLowerCase().includes(q) ||
        String(row?.email_address || "").toLowerCase().includes(q) ||
        String(row?.section || "").toLowerCase().includes(q) ||
        courseName.toLowerCase().includes(q)
      );
    });
  }, [conditionScopedRows, search, courseNameById]);

  /**
   * One page of the filtered list.
   *
   * Client-side, over rows already in hand, because this module needs the whole
   * set for things the table is not: the importer checks every student number
   * for duplicates, and search runs across fields the server does not index.
   * Paging the fetch would break both. What it does fix is the rendering — five
   * hundred rows of ten columns is five thousand cells built on every keystroke.
   *
   * The hook clamps the page on read, so narrowing a search from page nine down
   * to a two-page result lands on page two rather than on an empty table.
   */
  const pagedRows = usePagedRows(filteredRows);

  /*
   * A new search or a changed filter starts at the top.
   *
   * Clamping already covers the broken case — page nine of a result that now
   * has two. This covers the merely disorienting one, where the new set is long
   * enough that page nine still exists and someone who just typed a name is
   * dropped into the middle of the answer instead of the start of it.
   *
   * The setter is pulled out into its own binding rather than read off
   * `pagedRows` inside the effect. It is a useState setter and so stable, but
   * the linter can only see that through a direct reference — asked for the
   * whole object instead, the effect would re-run on every render and pin the
   * reader to page one permanently.
   */
  const { setPage: goToStudentPage } = pagedRows;
  useEffect(() => {
    goToStudentPage(1);
  }, [search, selectedCampusFilter, selectedCourseFilter, selectedYearLevelFilter, selectedSchoolYearFilter, conditionFilters, viewMode, goToStudentPage]);

  const loadAll = useCallback(async () => {
    if (!canLoadData) return;
    setLoading(true);
    setError("");
    try {
      const [courseRows, schoolYearRows, studentRows] = await Promise.all([
        fetchAllPages("course.php"),
        fetchAllPages("school_year.php", 500),
      // The whole cohort, so ask for it in the largest pages student.php
      // allows: the per-request floor dwarfs the row cost, and 200 made this
      // fourteen round trips where three will do.
        fetchAllPages(isArchivedView ? "student.php?archived=1" : "student.php", 1000),
      ]);
      setCourses(courseRows);
      setSchoolYears(schoolYearRows);
      setStudents(studentRows);
    } catch (e) {
      setError(e?.message || "Failed to load student module");
      setCourses([]);
      setSchoolYears([]);
      setStudents([]);
    } finally {
      setLoading(false);
    }
  }, [canLoadData, isArchivedView]);

  // Switching between Active and Archived changes what the ids mean — the ones
  // ticked on the other tab are no longer actionable here.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [isArchivedView]);

  useLiveRefresh(["students", "courses"], loadAll, { enabled: canLoadData });

  useEffect(() => {
    if (!canLoadData) {
      setCourses([]);
      setSchoolYears([]);
      setStudents([]);
      return;
    }
    void loadAll();
  }, [canLoadData, loadAll]);

  const openCreateModal = useCallback(() => {
    setForm(emptyForm);
    setFormCampusId("");
    setOpenModal(true);
  }, []);

  const openEditModal = useCallback((row) => {
    // Pre-fill the campus picker from the student's own course, so editing opens
    // with the Course dropdown already scoped to where they actually are.
    const editCourse = courseById[String(row?.course_id ?? "")] || null;
    setFormCampusId(editCourse?.campus_id != null ? String(editCourse.campus_id) : "");
    setForm({
      id: row?.student_id ?? "",
      student_number: row?.student_number || "",
      student_type: row?.student_type || "Non-STAR",
      first_name: row?.first_name || "",
      last_name: row?.last_name || "",
      middle_name: row?.middle_name || "",
      extension_name: row?.extension_name || "",
      email_address: row?.email_address || "",
      gender: row?.gender || "",
      modality: row?.modality || "",
      mobile_number: row?.mobile_number || "",
      course_id: row?.course_id != null ? String(row.course_id) : "",
      year_level: row?.year_level != null ? String(row.year_level) : "",
      section: row?.section || "",
      schoolyear_id: row?.schoolyear_id != null ? String(row.schoolyear_id) : "",
      final_scholarship_grant: row?.final_scholarship_grant || "",
    });
    setOpenModal(true);
  }, [courseById]);

  const saveStudent = useCallback(async () => {
    if (!canLoadData) {
      setError("This account is not linked to a department.");
      return;
    }

    const isEdit = Boolean(form.id);
    if ((isEdit && !canEdit) || (!isEdit && !canCreate)) {
      setError(isEdit ? "You do not have permission to edit student records." : "You do not have permission to create student records.");
      return;
    }

    const studentNumber = trimToNull(form.student_number);
    const firstName = trimToNull(form.first_name);
    const lastName = trimToNull(form.last_name);
    const selectedCourseId = Number(form.course_id);
    const selectedYearLevel = trimToNull(form.year_level) != null ? Number(form.year_level) : null;

    if (!studentNumber) {
      setError("Student number is required.");
      return;
    }
    const studentNumberError = validateStudentNumber(studentNumber);
    if (studentNumberError) {
      setError(studentNumberError);
      return;
    }
    if (!firstName) {
      setError("First name is required.");
      return;
    }
    if (!lastName) {
      setError("Last name is required.");
      return;
    }
    if (!Number.isFinite(selectedCourseId) || !allowedCourseIds.has(selectedCourseId)) {
      setError("Please select a valid course under your department.");
      return;
    }
    if (selectedYearLevel !== null) {
      const maxYear = courseYearDurationById[String(selectedCourseId)] ?? DEFAULT_YEAR_DURATION;
      if (!Number.isFinite(selectedYearLevel) || selectedYearLevel < 1 || selectedYearLevel > maxYear) {
        setError(`${selectedCourseCode} is a ${maxYear}-year programme, so year level must be between 1 and ${maxYear}.`);
        return;
      }
    }

    const section = trimToNull(form.section) ? normalizeSection(form.section) : null;
    if (section) {
      const sectionError =
        validateSection(section) ||
        sectionMatchesCourse(section, courseCodeById.get(String(selectedCourseId)) || "", selectedYearLevel);
      if (sectionError) {
        setError(sectionError);
        return;
      }
    }

    const payload = {
      student_number: studentNumber,
      student_type: trimToNull(form.student_type) || "Non-STAR",
      first_name: firstName,
      last_name: lastName,
      middle_name: trimToNull(form.middle_name),
      extension_name: trimToNull(form.extension_name),
      email_address: trimToNull(form.email_address),
      gender: trimToNull(form.gender),
      // Blank is sent as blank: the server fills in the list's default.
      modality: trimToNull(form.modality),
      mobile_number: trimToNull(form.mobile_number),
      course_id: selectedCourseId,
      year_level: selectedYearLevel,
      section,
      schoolyear_id: trimToNull(form.schoolyear_id) != null ? Number(form.schoolyear_id) : null,
      final_scholarship_grant: trimToNull(form.final_scholarship_grant),
    };

    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const url = getBackendUrl(`student.php${isEdit ? `?id=${encodeURIComponent(form.id)}` : ""}`);
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.message || "Failed to save student");

      // The temp password is returned exactly once (it is only stored hashed),
      // so surface it in a dialog the user has to dismiss rather than a toast.
      const account = json?.account;
      if (!isEdit && account?.created && account?.temporary_password) {
        setNewAccount({
          email: account.email || "",
          password: account.temporary_password,
          mustChange: Boolean(account.must_change_password),
          emailSent: Boolean(account.email_sent),
          emailSkipped: Boolean(account.email_skipped),
          emailError: account.email_error || "",
        });
        setSuccess("");
      } else if (!isEdit && account?.linked) {
        setSuccess("Student created and linked to the existing account for that email.");
      } else {
        setSuccess(isEdit ? "Student updated." : "Student created.");
      }
      setOpenModal(false);
      setForm(emptyForm);
      await loadAll();
    } catch (e) {
      setError(e?.message || "Failed to save student");
    } finally {
      setSaving(false);
    }
  }, [allowedCourseIds, canCreate, canEdit, canLoadData, courseCodeById, courseYearDurationById, form, loadAll, selectedCourseCode]);

  /**
   * The import contract, shown in the dialog and used to build the template.
   *
   * The example row draws on this account's own first course and school year
   * rather than placeholder text, so the downloaded file is one the importer
   * will actually accept. Every name here is a header handleImport recognises.
   */
  const studentImportColumns = useMemo(() => {
    const sampleCourse = departmentCourses[0] || courses[0];

    return [
      /*
       * The placeholder stays deliberately invalid. A row reading
       * "REPLACE-WITH-STUDENT-NUMBER", "Juan Dela Cruz", section "A" is sitting
       * in the student table right now because someone uploaded this template
       * unedited and nothing rejected it. Putting a well-formed example here
       * would make that quieter, not rarer - the format belongs in the hint,
       * where it cannot be imported.
       */
      {
        name: "student_number",
        required: true,
        example: "REPLACE-WITH-STUDENT-NUMBER",
        hint: "Format 02-2324-10233 - campus, school year, then the sequence",
      },
      /*
       * Named for the field, not for the column that stores it.
       *
       * This said "student_type", the database's name for it, which appeared
       * nowhere else a user can see: the table heads this column "STAR
       * E-Profile", the filter calls it that, the assignment board calls it
       * that, and so does the export. The import template was the one place
       * still asking for it under its schema name, so the registrar had to know
       * that the thing they filter by as "STAR E-Profile" is spelled
       * "student_type" in a spreadsheet.
       *
       * Both ends now read STUDENT_TYPE_LABEL, so this column also survives an
       * export-then-import — which the file as a whole does not, and is not
       * meant to: the export writes "Name" and a course's name, where the
       * template wants first_name, last_name and a course_code.
       *
       * The VALUES are untouched and stay STAR / Non-STAR. They are the stored
       * enum, and they are compared in WHERE clauses that decide which students
       * KASAMA and SSP Caller can open — renaming one is an access-control
       * change wearing a vocabulary change's clothes.
       */
      {
        name: STUDENT_TYPE_LABEL,
        required: true,
        example: STUDENT_TYPE_NON_STAR,
        hint: `${STUDENT_TYPE_STAR} or ${STUDENT_TYPE_NON_STAR}`,
      },
      { name: "first_name", required: true, example: "Juan" },
      { name: "last_name", required: true, example: "Dela Cruz" },
      {
        name: "course_code",
        required: true,
        example: sampleCourse?.course_code || "COURSE-CODE",
        // The same code can now name a course on two campuses, so the hint has
        // to say what settles it rather than just what is allowed.
        hint: isDepartmentScoped
          ? "Must be a course in your department. Pick the campus below if your department runs this code on more than one"
          : "Any active course code. Pick the campus below when the same code is offered on more than one",
      },
      { name: "middle_name", example: "" },
      { name: "extension_name", example: "", hint: "Suffix such as JR, SR or III" },
      { name: "email_address", example: "juan.delacruz@example.com" },
      // Hints read from the live lists, so the template never names a value
      // the server would refuse (this said "Male, Female or Other" long after
      // "Other" stopped being accepted).
      {
        name: "gender",
        example: genderChoices[0]?.value || "",
        hint: genderChoices.map((option) => option.value).join(", "),
      },
      {
        name: "modality",
        example: getDropdownDefault("modalities") || modalityChoices[0]?.value || "",
        hint: `${modalityChoices.map((option) => option.value).join(", ")}. Blank means ${getDropdownDefault("modalities") || "the default"}`,
      },
      { name: "mobile_number", example: "09171234567" },
      { name: "mother_number", example: "", hint: "Mother's contact number" },
      { name: "father_number", example: "", hint: "Father's contact number" },
      { name: "home_address", example: "", hint: "Full home address" },
      { name: "facebook_name", example: "", hint: "Name the student uses on Facebook" },
      { name: "year_level", example: "1", hint: "Capped by the length of the course on the same row" },
      {
        name: "section",
        // Built from the same course the course_code example uses, so the two
        // columns of the downloaded row agree with each other.
        example: composeSection(sampleCourse?.course_code || "BSIT", 1, 1),
        hint: "Campus, department, course, year level, then the section number. Letters such as \"A\" are no longer used",
      },
      { name: "final_scholarship_grant", example: "", hint: `Blank, or one of: ${grantChoices.map((option) => option.value).join(", ")}` },
    ];
  }, [courses, departmentCourses, isDepartmentScoped, genderChoices, modalityChoices, grantChoices]);

  /*
   * The school year every import files under: the Academic Calendar's, by
   * name, shown in the dialog rather than chosen. A file's own school_year
   * column must match the calendar year. The handler resolves the name with
   * resolveSchoolYearId(), which creates the year's row if it has none yet.
   */
  const { term: currentTerm } = useCurrentTerm();
  const importSchoolYear = currentTermSchoolYearName(currentTerm);
  const importValues = useMemo(() => ({ ...importTerm, school_year: importSchoolYear }), [importTerm, importSchoolYear]);

  /** Step 2 of the import dialog: the school year, and the campus where there is a choice. */
  const importFields = useMemo(
    () => [
      importSchoolYearField("school_year", importSchoolYear),
      /*
       * Campus, chosen the same way the school year is.
       *
       * Nothing is written from it - a student is on a campus by way of its
       * course - but it does two jobs on the way in. It decides which course a
       * code means when the same code is offered on more than one campus, and
       * it rejects any row naming a course from somewhere else, so a
       * registrar's export for one campus cannot land on another.
       *
       * Left optional on purpose: a file whose course codes are unambiguous
       * still imports in one run without it. A file whose codes are not says so
       * per row, naming the campuses it could have meant.
       */
      ...(showCampusFilter
        ? [{
          key: "campus_id",
          label: "Campus",
          required: false,
          placeholder: "All campuses",
          options: campusOptions.map((campus) => ({ value: String(campus.campus_id), label: campus.label })),
        }]
        : []),
    ],
    [campusOptions, importSchoolYear, showCampusFilter]
  );

  /**
   * Everything buildStudentImportRows needs in order to decide a row.
   *
   * Built from the term picked in the dialog, and shared by the review step and
   * the import itself. That sharing is the point: the review is only worth
   * trusting because it is the same function over the same context, not a
   * second opinion that happens to agree most of the time.
   *
   * termSchoolYearId is deliberately not here. The import resolves it — and
   * creates the school year if this is its first use — which is exactly the
   * kind of thing looking at a file must not do, so the preview passes null.
   */
  const buildImportContext = useCallback(
    (termValues = {}) => {
      const campusId = showCampusFilter ? Number(termValues.campus_id) || null : null;
      return {
        existingStudentNumbers,
        courseMatchIndex,
        courseCodeById,
        courseYearDurationById,
        schoolYearIdByLookup,
        termSchoolYearLabel: termValues.school_year || "",
        campusId,
        campusName: campusId
          ? campusOptions.find((campus) => campus.campus_id === campusId)?.label || "the chosen campus"
          : "",
      };
    },
    [
      campusOptions,
      courseCodeById,
      courseMatchIndex,
      courseYearDurationById,
      existingStudentNumbers,
      schoolYearIdByLookup,
      showCampusFilter,
    ]
  );

  /**
   * What this file would do, worked out before anything is written.
   *
   * Student Management is the importer where a preview matters most, because it
   * creates portal accounts: a row for a student number that already exists is
   * REJECTED, not updated, so someone re-uploading a corrected registrar export
   * used to get "already exists" against every line and no corrections applied —
   * after the upload, in a list of line numbers. Every other reason a row can
   * fail was equally invisible until then, and each one costs a round trip to
   * find out about.
   *
   * Now the whole verdict is on screen first: how many students will be created,
   * which rows will not be and why, and the resolved course, year and section
   * for each row that will land. Nothing here writes; the button below is what
   * writes.
   */
  const importPreview = useCallback(
    (parsedRows, termValues) => {
      if (!parsedRows || parsedRows.length === 0) return null;

      const { rows, valid } = buildStudentImportRows(parsedRows, buildImportContext(termValues));
      const skipped = rows.length - valid.length;

      return {
        counts: [
          { label: "Rows in file", value: rows.length.toLocaleString() },
          { label: "Will be created", value: valid.length.toLocaleString(), tone: valid.length > 0 ? "good" : "bad" },
          ...(skipped > 0 ? [{ label: "Will be skipped", value: skipped.toLocaleString(), tone: "warn" }] : []),
        ],
        columns: IMPORT_PREVIEW_COLUMNS,
        rows,
        // Said here rather than only in the summary afterwards, because it
        // changes where the students land and it is fixable by editing the file.
        note: `School year comes from Academic Calendar: ${termValues?.school_year || "not set"}. The file does not need a school_year column.`,
        confirmLabel:
          valid.length > 0 ? `Import ${valid.length.toLocaleString()} student${valid.length === 1 ? "" : "s"}` : undefined,
        blocked:
          valid.length === 0
            ? "Not one row in this file can be imported, so there is nothing to send. The reasons are listed above."
            : "",
      };
    },
    [buildImportContext]
  );

  /**
   * Import students from a spreadsheet.
   *
   * Validation is per row rather than all-or-nothing. It used to `throw` from
   * inside a .map(), so a single bad line rejected the whole file and reported
   * only that one problem — on a 300-row export that meant 300 upload attempts
   * to find every mistake. Now every row is checked, the valid ones are saved,
   * and the dialog lists what was skipped and why.
   */
  const handleImport = useCallback(
    async (file, termValues = {}) => {
      if (!canImport) throw new Error("You do not have permission to import students.");
      if (!canLoadData) throw new Error("This account is not linked to a department.");

      if (!termValues.school_year) throw new Error("Choose the school year this file belongs to.");

      const context = buildImportContext(termValues);

      // Resolved once for the file, not per row, and created if this is the
      // year's first use. Done before any student is written so a bad year
      // fails the whole run rather than half of it.
      const termSchoolYearId = await resolveSchoolYearId(termValues.school_year, schoolYears, {
        buildUrl: getBackendUrl,
      });

      const parsedRows = parseSpreadsheetRows(await file.text(), file.name);
      if (parsedRows.length === 0) {
        throw new Error("No rows found. Add a header row and at least one student.");
      }

      /*
       * The same reading the review step showed, re-run rather than carried
       * over. The file is read again here on purpose: the dialog's copy was
       * parsed for display and may be minutes old, and what decides who gets an
       * account should be the file as it is now, checked against the students
       * as they are now.
       */
      const { valid, errors: rowErrors } = buildStudentImportRows(parsedRows, {
        ...context,
        termSchoolYearId,
      });

      /*
       * Sent in batches of a thousand, not one request per student.
       *
       * This loop used to POST to student.php once per row. middleware/throttle
       * allows a burst of 120 requests then 120 a minute, and twenty refusals
       * inside a minute locks the account out for ten — so a 1,000-row file
       * burned the burst in seconds, locked the account, and then kept firing
       * for the remaining 880 rows because each failure was caught and skipped.
       * The result was an unpredictable prefix of the file written and hundreds
       * of errors that were about rate limiting, reported as if they were about
       * the data.
       */
      let batchOutcome = null;
      let stoppedEarly = null;

      try {
        batchOutcome = await sendStudentBatches(valid, {
          send: async (batch) => {
            const response = await fetch(getBackendUrl("student-import.php"), {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              credentials: "include",
              body: JSON.stringify({
                rows: batch.map((row) => ({ line: row.lineNumber, ...row.payload })),
              }),
            });
            const payload = await response.json().catch(() => ({}));
            return { response, payload };
          },
          onProgress: ({ sent, total }) => setImportProgress({ sent, total }),
        });
      } catch (batchError) {
        // A run that stopped halfway has still written rows. Reporting zero
        // would be a lie, and reporting success would be a worse one.
        stoppedEarly = batchError;
        batchOutcome = batchError.partial || null;
      } finally {
        setImportProgress(null);
      }

      const importedCount = batchOutcome?.inserted ?? 0;
      const failedRows = batchOutcome?.errors ?? [];

      if (importedCount > 0) {
        await loadAll();
      }

      // Every accepted row uses the Academic Calendar school year.
      const termPhrase = ` into ${termValues.school_year}`;

      const accountsNote = batchOutcome?.accounts_created
        ? `${batchOutcome.accounts_created} portal login${batchOutcome.accounts_created === 1 ? " was" : "s were"} created. Sign-in details were NOT emailed — that would be one message per student — so they set their own password through Forgot Password.`
        : "";

      return {
        message: stoppedEarly
          ? `${stoppedEarly.offline ? "The connection dropped" : "The import stopped"} after ${importedCount} of ${valid.length} students. ${stoppedEarly.message} Those ${importedCount} are saved — upload the same file again to finish, the ones already in are skipped rather than duplicated.`
          : importedCount > 0
            ? `${importedCount} student${importedCount === 1 ? "" : "s"} imported${termPhrase}${context.campusName ? ` on ${context.campusName}` : ""}.`
            : "No students were imported.",
        summary: {
          rows_read: parsedRows.length,
          inserted: importedCount,
          skipped: rowErrors.length,
          failed: failedRows.length,
        },
        accountsNote,
        details: {
          row_errors: rowErrors,
          failed_rows: failedRows,
          // Surfaced as its own group so it is not lost among per-row errors.
        },
      };
    },
    [buildImportContext, canImport, canLoadData, loadAll, schoolYears]
  );

  const removeStudent = useCallback(
    async (studentId) => {
      if (!canDelete) {
        setError("You do not have permission to archive student records.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Archive student?",
        text: "This will hide the selected student from active lists without deleting the record.",
        confirmButtonText: "Archive",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`student.php?id=${encodeURIComponent(studentId)}`), {
          method: "DELETE",
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to archive student");
        setSuccess("Student archived.");
        await loadAll();
      } catch (e) {
        setError(e?.message || "Failed to archive student");
      }
    },
    [canDelete, loadAll]
  );

  const archiveStudent = useCallback(
    async (studentId) => {
      if (!canArchive) {
        setError("You do not have permission to archive student records.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Archive student?",
        text: "This will hide the selected student from active lists without deleting the record.",
        confirmButtonText: "Archive",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`student.php?id=${encodeURIComponent(studentId)}&permission_action=archive`), {
          method: "PUT",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "include",
          body: JSON.stringify({ archived: true }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to archive student");
        setSuccess("Student archived.");
        await loadAll();
      } catch (e) {
        setError(e?.message || "Failed to archive student");
      }
    },
    [canArchive, loadAll]
  );

  /*
   * Puts the student back. The same PUT the edit form uses, with archived:false
   * — there is no separate restore table to keep in step, so a restored record
   * is the record it always was rather than a copy of it.
   */
  const restoreStudent = useCallback(
    async (studentId) => {
      if (!canRestore) {
        setError("You do not have permission to restore student records.");
        return;
      }
      const confirmed = await confirmAction({
        title: "Restore student?",
        text: "Put this student back into the active list?",
        confirmButtonText: "Restore",
        confirmButtonColor: "var(--brand-600)",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`student.php?id=${encodeURIComponent(studentId)}&permission_action=restore`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ archived: false }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.message || "Failed to restore student");
        setSuccess("Student restored.");
        await loadAll();
      } catch (e) {
        setError(e?.message || "Failed to restore student");
      }
    },
    [canRestore, loadAll]
  );

  const toggleSelected = useCallback((studentId) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(studentId)) next.delete(studentId);
      else next.add(studentId);
      return next;
    });
  }, []);

  /*
   * Select-all covers the rows currently on screen, not every student loaded.
   * Ticking a box that quietly selects three hundred students hidden behind a
   * search box is how a bulk archive goes wrong — and since the list is paged,
   * "on screen" now means this page rather than every row that survived the
   * filters. The selection itself still spans pages, so ticking a page, moving
   * to the next and ticking again archives forty rather than twenty.
   */
  const visibleIds = useMemo(
    () => pagedRows.rows.map((row) => row?.student_id).filter((id) => id != null),
    [pagedRows.rows]
  );

  const selectedVisibleCount = useMemo(
    () => visibleIds.filter((id) => selectedIds.has(id)).length,
    [visibleIds, selectedIds]
  );

  /*
   * Every student the filters left behind, not just the page on screen.
   *
   * This is what makes a filtered bulk archive worth having: narrowing to
   * "Non-STAR, no scholarship, Section B" and then ticking twenty pages by hand
   * is not a workflow anybody completes. Offered only once the visible page is
   * fully ticked, so it reads as a deliberate second step rather than a way to
   * select four hundred students by mis-clicking once.
   */
  const selectAllFiltered = useCallback(() => {
    setSelectedIds(new Set(filteredRows.map((row) => row?.student_id).filter((id) => id != null)));
  }, [filteredRows]);

  const canOfferSelectAllFiltered =
    visibleIds.length > 0 &&
    selectedVisibleCount === visibleIds.length &&
    filteredRows.length > selectedIds.size;

  const toggleSelectAllVisible = useCallback(() => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const everyVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => next.has(id));
      visibleIds.forEach((id) => {
        if (everyVisibleSelected) next.delete(id);
        else next.add(id);
      });
      return next;
    });
  }, [visibleIds]);

  /**
   * Archive or restore every ticked student, one request each.
   *
   * Sequential rather than a Promise.all: three hundred simultaneous writes to
   * one MariaDB instance behind XAMPP is a way to find its connection limit,
   * and the ordering costs nothing here because the user is waiting on the
   * whole batch either way.
   *
   * Failures are counted, not swallowed and not fatal. One student who cannot
   * be archived — a scope refusal, a row deleted from another tab — must not
   * abandon the other ninety-nine, and the reader has to be told the number
   * that actually went through rather than a success message covering both.
   */
  const runBulk = useCallback(
    async (mode) => {
      const ids = Array.from(selectedIds);
      if (ids.length === 0) return;

      const archiving = mode === "archive";
      const noun = ids.length === 1 ? "student" : "students";
      /*
       * Named in the confirmation when filters are on.
       *
       * The selection can outlive the filter that produced it and can span
       * pages, so the number in this dialog may be larger than anything on
       * screen. Saying which conditions produced it is the last chance to
       * notice that it is not the set you meant.
       */
      const filterNote =
        activeFilterChips.length > 0
          ? ` Selected under: ${activeFilterChips.map((chip) => `${chip.label} ${chip.value}`).join(", ")}.`
          : "";
      const confirmed = await confirmAction({
        title: `${archiving ? "Archive" : "Restore"} ${ids.length} ${noun}?`,
        text: archiving
          ? `${ids.length} ${noun} will be hidden from active lists. Nothing is deleted — you can restore them from the Archived tab.${filterNote}`
          : `${ids.length} ${noun} will be returned to the active list.${filterNote}`,
        confirmButtonText: archiving ? "Archive" : "Restore",
        confirmButtonColor: archiving ? undefined : "var(--brand-600)",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      setBulkBusy(true);

      let done = 0;
      const failures = [];

      for (const studentId of ids) {
        try {
          const action = archiving ? "archive" : "restore";
          const res = await fetch(
            getBackendUrl(`student.php?id=${encodeURIComponent(studentId)}&permission_action=${action}`),
            {
              method: "PUT",
              headers: { "Content-Type": "application/json", Accept: "application/json" },
              credentials: "include",
              body: JSON.stringify({ archived: archiving }),
            }
          );
          const json = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(json?.message || "Request refused");
          done += 1;
        } catch (bulkError) {
          failures.push(`${studentId}: ${bulkError?.message || "failed"}`);
        }
      }

      setBulkBusy(false);
      setSelectedIds(new Set());
      await loadAll();

      const verb = archiving ? "Archived" : "Restored";
      if (failures.length === 0) {
        setSuccess(`${verb} ${done} ${done === 1 ? "student" : "students"}.`);
      } else {
        // The first reason is shown rather than all of them: a list of ninety
        // identical scope refusals is not more informative than one.
        setError(
          `${verb} ${done} of ${ids.length}. ${failures.length} could not be ${archiving ? "archived" : "restored"} (${failures[0]}).`
        );
      }
    },
    [activeFilterChips, loadAll, selectedIds]
  );

  /**
   * The columns this page composes rather than reads straight off the record —
   * a name assembled from three fields, a course resolved through its id, the
   * department and campus the course belongs to.
   *
   * Separated from the row's action list so the export can build the same
   * values over every filtered student without also building a kebab menu for
   * each one. The table and the file must agree: a Course column that says
   * something different in the download than on screen is a bug the reader
   * finds only after sending the file on.
   */
  const displayFieldsFor = useCallback(
    (row, index, offset = 0) => ({
      display_select: row?.student_id,
      display_no: offset + index + 1,
      display_student_number: row?.student_number || "-",
      display_student_type: row?.student_type || STUDENT_TYPE_NON_STAR,
      display_name: `${row?.last_name || ""}, ${row?.first_name || ""}${row?.middle_name ? ` ${row.middle_name}` : ""}`,
      display_course: courseNameById[String(row?.course_id)] || "-",
      display_school_year: schoolYearNameById[String(row?.schoolyear_id)] || "-",
      display_department: courseById[String(row?.course_id)]?.department_name
        || courseById[String(row?.course_id)]?.department_code
        || "—",
      // The same chain the campus filter walks: the row's course names the
      // department, and the department names the campus.
      display_campus: courseById[String(row?.course_id)]?.campus_code
        || courseById[String(row?.course_id)]?.campus_name
        || "—",
      display_archived_at: row?.archived_at ? new Date(row.archived_at).toLocaleString() : "-",
    }),
    [courseById, courseNameById, schoolYearNameById]
  );

  /**
   * Every student the filters left, as a file.
   *
   * `filteredRows`, not `pagedRows`: the file is the search result. And the
   * columns are the ones the reader chose in the column menu, so the download
   * is the table they built rather than a fixed set they have to trim
   * afterwards.
   *
   * Values come from each column's own `render` where it has one, so the file
   * says exactly what the cell said — including the em dash a blank field
   * renders as.
   */
  function handleExport(format) {
    if (!canExport) return;

    setExporting(format);
    try {
      const chosen = new Set(visibleColumnKeys);
      const exportColumns = STUDENT_COLUMNS
        .filter((column) => chosen.has(column.key))
        .map((column) => ({ key: column.key, label: column.label, render: column.render }));

      const rows = filteredRows.map((row, index) => {
        const fields = displayFieldsFor(row, index);
        const out = {};
        exportColumns.forEach((column) => {
          out[column.key] = column.render ? column.render(row) : fields[column.key];
        });
        return out;
      });

      const wrote = exportTable(format, {
        filename: isArchivedView ? "students-archived" : "students",
        sheet: "Students",
        columns: exportColumns.map(({ key, label }) => ({ key, label })),
        rows,
      });
      if (!wrote) setError("There is nothing to export with these filters.");
    } catch (e) {
      setError(e?.message || "Failed to export students");
    } finally {
      setExporting("");
    }
  }

  const tableRows = useMemo(() => {
    // Where this page starts in the filtered list, so the No. column keeps
    // counting across pages instead of restarting at 1 on every one of them.
    const pageOffset = (pagedRows.page - 1) * pagedRows.pageSize;

    return pagedRows.rows.map((row, index) => {
      /*
       * The row's choices, as data for one kebab menu rather than a row of
       * buttons. Three or four buttons repeated down every row cost a third of
       * the table's width and grow every time an action is added.
       */
      const actions = [];
      // First, and offered in both views: reading the record is the one thing
      // that is safe to do to an archived student.
      actions.push({ key: "view", label: "View record", icon: "eye", onSelect: () => setDetailStudent(row) });

      if (isArchivedView) {
        // Nothing else applies to an archived record: editing or re-archiving
        // one is a question about a student who is no longer in the portal.
        if (canRestore) {
          actions.push({
            key: "restore",
            label: "Restore",
            icon: "archiveRestore",
            tone: "brand",
            onSelect: () => void restoreStudent(row?.student_id),
          });
        }
      } else {
        if (canEdit) {
          actions.push({ key: "edit", label: "Edit", icon: "edit", onSelect: () => openEditModal(row) });
        }
        if (canArchive) {
          actions.push({
            key: "archive",
            label: "Archive",
            icon: "archive",
            tone: "danger",
            onSelect: () => void archiveStudent(row?.student_id),
          });
        } else if (canDelete) {
          actions.push({
            key: "delete",
            label: "Archive",
            icon: "archive",
            tone: "danger",
            onSelect: () => void removeStudent(row?.student_id),
          });
        }
      }

      return {
        ...row,
        ...displayFieldsFor(row, index, pageOffset),
        display_actions: actions,
      };
    });
  }, [archiveStudent, canArchive, canDelete, canEdit, canRestore, displayFieldsFor, isArchivedView, openEditModal, pagedRows.page, pagedRows.pageSize, pagedRows.rows, removeStudent, restoreStudent]);

  const columns = useMemo(
    () => {
      // Catalogue order, not click order, so ticking a column puts it where the
      // reader expects rather than on the end.
      const chosen = new Set(visibleColumnKeys);
      const baseColumns = STUDENT_COLUMNS.filter((column) => chosen.has(column.key));

      /*
       * The tick column, only where a bulk action exists to run on it. A column
       * of checkboxes that can do nothing is furniture, so a reader with no
       * archive or restore right never sees it.
       */
      if (canBulk) {
        baseColumns.unshift({
          key: "select",
          nowrap: true,
          label: (
            <SelectAllCheckbox
              checked={visibleIds.length > 0 && selectedVisibleCount === visibleIds.length}
              indeterminate={selectedVisibleCount > 0 && selectedVisibleCount < visibleIds.length}
              onChange={toggleSelectAllVisible}
              disabled={visibleIds.length === 0}
              label="Select every student in view"
            />
          ),
          render: (row) => (
            <input
              type="checkbox"
              checked={selectedIds.has(row.display_select)}
              onChange={() => toggleSelected(row.display_select)}
              aria-label={`Select ${row.display_name || row.display_student_number}`}
              style={{ cursor: "pointer", width: 14, height: 14 }}
            />
          ),
        });
      }

      if (isArchivedView) {
        baseColumns.push({ key: "display_archived_at", label: "Archived On", nowrap: true });
      }

      // Unconditional: View lives in this menu and needs no permission beyond
      // the one that let the reader see the row at all. The column used to be
      // gated on edit/archive/restore, which hid the record from anyone holding
      // view alone — exactly the reader it is for.
      baseColumns.push({
        key: "actions",
        label: "",
        nowrap: true,
        render: (row) => <ActionMenu label="Student actions" items={row.display_actions} />,
      });

      return baseColumns;
    },
    [
      canBulk,
      isArchivedView,
      selectedIds,
      selectedVisibleCount,
      toggleSelectAllVisible,
      toggleSelected,
      visibleColumnKeys,
      visibleIds.length,
    ]
  );

  const applyVisibleColumns = useCallback((keys) => {
    // Locked keys are re-added rather than trusted from the menu, so a stale
    // stored list from before a column was locked cannot drop it.
    const next = STUDENT_COLUMNS
      .filter((column) => keys.includes(column.key) || LOCKED_STUDENT_COLUMNS.includes(column.key))
      .map((column) => column.key);
    setVisibleColumnKeys(next);
    try {
      window.localStorage.setItem(STUDENT_COLUMN_STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore: the choice still applies for this session.
    }
  }, []);

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 6, color: "var(--brand-800)" }}>Student Management</h2>
      <p style={{ marginTop: 0, marginBottom: 9, color: "var(--text-secondary)", fontSize: 12.5 }}>
        Department: <strong>{sectionLabel}</strong>
      </p>

      {/*
        Hidden while the dialog is open.

        This banner sits at the top of the PAGE. The Add/Edit dialog is a fixed
        overlay covering the whole screen, so an error raised by the form
        rendered here — underneath it, invisible — and the dialog just sat there
        looking like nothing had happened. The dialog shows its own copy
        instead; see the one beside the Save button.
      */}
      <AlertMessage tone="error" message={openModal ? "" : error} />
      <AlertMessage tone="success" message={success} />

      {!canLoadData ? (
        <AlertMessage
          tone="warning"
          message="This account is not linked to a department yet. Ask admin to set the department if this module should be department-scoped."
          style={{ marginBottom: 0 }}
        />
      ) : (
        <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
          <SectionHeader
            title={sectionTitle}
            sticky
            actions={
              <>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search student number, name, email..."
                  style={{ minWidth: 221, flex: "1 1 260px", padding: "5px 7px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                  name="dean_student_manage_search"
                />
                {/* Nine conditions behind one button. They used to be three
                    dropdowns sitting in this bar, which left no room for the
                    other six and pushed Add Student off the end on a laptop. */}
                <Button
                  variant={activeFilterCount > 0 ? "primary" : "secondary"}
                  onClick={() => setFilterPanelOpen((open) => !open)}
                  aria-expanded={filterPanelOpen}
                  aria-haspopup="dialog"
                >
                  {activeFilterCount > 0 ? `Filters (${activeFilterCount})` : "Filters"}
                </Button>
                {/* Every field the student table stores is one tick away —
                    the nine defaults are what the list is scanned by, not
                    what the record contains. */}
                <ColumnMenu
                  columns={STUDENT_COLUMNS}
                  visibleKeys={visibleColumnKeys}
                  onChange={applyVisibleColumns}
                  lockedKeys={LOCKED_STUDENT_COLUMNS}
                />
                {/* Archiving lives here and only here, so the tab that reads
                    the archive belongs beside the list that fills it. */}
                <ArchiveViewToggle view={viewMode} onChange={setViewMode} />
                {!isArchivedView && canImport ? (
                  <Button variant="secondary" onClick={() => setImportOpen(true)} disabled={loading}>
                    Import
                  </Button>
                ) : null}
                {/* Offered on the archived tab too: a list of who was archived,
                    and when, is exactly the sort of thing that gets asked for in
                    writing. */}
                {canExport ? (
                  <ExportMenu
                    options={TABLE_EXPORT_FORMATS}
                    busyKey={exporting}
                    disabled={loading}
                    onSelect={(format) => handleExport(format)}
                  />
                ) : null}
                {!isArchivedView && canCreate ? <Button onClick={openCreateModal}>+ Add Student</Button> : null}
              </>
            }
          />

          {/* Positioned against this wrapper rather than the toolbar, so the
              panel hangs below the bar instead of inside its scroll area. */}
          <div style={{ position: "relative" }}>
            <StudentFilterPanel
              open={filterPanelOpen}
              onClose={() => setFilterPanelOpen(false)}
              filters={conditionFilters}
              onChange={(key, value) => setConditionFilters((prev) => ({ ...prev, [key]: value }))}
              onClear={clearAllFilters}
              rowsInScope={rows}
              matchCount={filteredRows.length}
              totalCount={rows.length}
              chainedFields={
                <>
                  {/* Campus feeds Course feeds Year level, the same chain the
                      overview filters use. Clearing the two steps below it is
                      what makes the chain a chain: a course belongs to exactly
                      one campus, so carrying one across scopes the table to
                      nothing. */}
                  {showCampusFilter ? (
                    <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
                      <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Campus</span>
                      <select
                        value={selectedCampusFilter}
                        onChange={(event) => {
                          setSelectedCampusFilter(event.target.value);
                          setSelectedCourseFilter("");
                          setSelectedYearLevelFilter("");
                        }}
                        style={{ width: "100%", padding: "5px 7px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-base)" }}
                        name="dean_student_manage_campus_filter"
                      >
                        <option value="">All campuses</option>
                        {campusOptions.map((campus) => (
                          <option key={campus.campus_id} value={String(campus.campus_id)}>
                            {campus.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                  <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Course</span>
                    <select
                      value={selectedCourseFilter}
                      onChange={(event) => setSelectedCourseFilter(event.target.value)}
                      style={{ width: "100%", padding: "5px 7px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-base)" }}
                      name="dean_student_manage_course_filter"
                    >
                      <option value="">{selectedCampusFilter ? "All courses on this campus" : "All courses"}</option>
                      {courseFilterOptions.map((option) => (
                        <option key={option.key} value={option.key}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Year Level</span>
                    <select
                      value={selectedYearLevelFilter}
                      onChange={(event) => setSelectedYearLevelFilter(event.target.value)}
                      style={{ width: "100%", padding: "5px 7px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-base)" }}
                      name="dean_student_manage_year_level_filter"
                    >
                      <option value="">All year levels</option>
                      {/* Bounded by the longest programme in scope, so a Year 5
                          filter appears only where a five-year course is in view. */}
                      {Array.from({ length: maxYearDuration }, (_, index) => index + 1).map((year) => (
                        <option key={year} value={String(year)}>{yearLevelLabel(year)}</option>
                      ))}
                    </select>
                  </label>
                  {/* Independent of the chain to its left: a school year does not
                      belong to a campus, so changing campus leaves it alone. */}
                  <label style={{ display: "grid", gap: 3, minWidth: 0 }}>
                    <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>School Year</span>
                    <select
                      value={selectedSchoolYearFilter}
                      onChange={(event) => setSelectedSchoolYearFilter(event.target.value)}
                      style={{ width: "100%", padding: "5px 7px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-base)" }}
                      name="dean_student_manage_school_year_filter"
                    >
                      <option value="">All school years</option>
                      {schoolYearFilterOptions.map((option) => (
                        <option key={option.id} value={option.id}>{option.label}</option>
                      ))}
                    </select>
                  </label>
                </>
              }
            />
          </div>

          {/*
            The active conditions, spelled out while the panel is shut.

            Without this a filtered list looks exactly like the whole list, and
            the bulk actions below act on what the filters left behind - which is
            how somebody archives four hundred students meaning to archive four.
          */}
          {activeFilterChips.length > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                flexWrap: "wrap",
                padding: "7px 11px",
                borderBottom: "1px solid var(--border-base)",
                background: "var(--surface-page)",
              }}
            >
              <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Showing</span>
              {activeFilterChips.map((chip) => (
                <span
                  key={chip.key}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    padding: "2px 4px 2px 8px",
                    borderRadius: 999,
                    fontSize: 11,
                    background: "var(--brand-100)",
                    color: "var(--brand-800)",
                  }}
                >
                  {chip.label}: {chip.value}
                  <button
                    onClick={() => chip.onRemove()}
                    aria-label={`Remove the ${chip.label} filter`}
                    style={{ background: "transparent", border: 0, cursor: "pointer", color: "inherit", fontSize: 12.5, lineHeight: 1, padding: "0 3px" }}
                  >
                    &times;
                  </button>
                </span>
              ))}
              <button
                onClick={clearAllFilters}
                style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--text-secondary)", fontSize: 11, textDecoration: "underline" }}
              >
                Clear all
              </button>
              <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--text-secondary)" }}>
                {filteredRows.length} of {rows.length} students
              </span>
            </div>
          ) : null}

          {/* Appears only with a selection, so the toolbar does not carry a
              disabled control the rest of the time. */}
          {canBulk && selectedIds.size > 0 ? (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 9,
                flexWrap: "wrap",
                padding: "8px 11px",
                borderBottom: "1px solid var(--border-base)",
                background: "var(--brand-50, #ecfdf5)",
              }}
            >
              <strong style={{ fontSize: 12.5, color: "var(--text-primary)" }}>
                {selectedIds.size} selected
              </strong>
              {/* Said out loud, because the selection survives both the search
                  box and the page you are on, and the reader may not be looking
                  at all of them. */}
              {selectedIds.size !== selectedVisibleCount ? (
                <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>
                  {selectedVisibleCount} on this page, the rest on other pages or hidden by the filters
                </span>
              ) : null}
              {canOfferSelectAllFiltered ? (
                <button
                  onClick={selectAllFiltered}
                  style={{ background: "transparent", border: 0, cursor: "pointer", color: "var(--brand-800)", fontSize: 11, textDecoration: "underline", padding: 0 }}
                >
                  Select all {filteredRows.length} matching the filters
                </button>
              ) : null}

              <div style={{ marginLeft: "auto", display: "flex", gap: 6, flexWrap: "wrap" }}>
                <Button variant="secondary" onClick={() => setSelectedIds(new Set())} disabled={bulkBusy}>
                  Clear
                </Button>
                {isArchivedView ? (
                  <Button onClick={() => void runBulk("restore")} disabled={bulkBusy}>
                    {bulkBusy ? "Restoring..." : `Restore ${selectedIds.size}`}
                  </Button>
                ) : (
                  <Button
                    onClick={() => void runBulk("archive")}
                    disabled={bulkBusy}
                    className="ui-archive-button"
                  >
                    {bulkBusy ? "Archiving..." : `Archive ${selectedIds.size}`}
                  </Button>
                )}
              </div>
            </div>
          ) : null}

          <div style={{ overflow: "auto", maxHeight: "calc(100vh - 255px)" }}>
            <Table
              columns={columns}
              rows={tableRows}
              loading={loading}
              emptyText={isArchivedView ? "No archived students." : "No students found."}
            />
          </div>

          {/* Outside the scroll box above, so paging away from a long page does
              not require scrolling back down to find the control. Hidden only
              when there is nothing at all — with rows on screen the range
              summary is worth having even below one full page, because "1-14 of
              14" is how you tell a filter worked from a filter that broke. */}
          {!loading && pagedRows.total > 0 ? (
            <div style={{ padding: "0 11px 11px" }}>
              <Pagination
                page={pagedRows.page}
                pageSize={pagedRows.pageSize}
                total={pagedRows.total}
                onPageChange={pagedRows.setPage}
                onPageSizeChange={pagedRows.setPageSize}
                itemLabel={isArchivedView ? "archived students" : "students"}
                compact
              />
            </div>
          ) : null}
        </div>
      )}

      <ImportDialog
        open={importOpen && canImport}
        onClose={() => setImportOpen(false)}
        title="Import Students"
        description={
          isDepartmentScoped
            ? `New students are created in ${sectionLabel}. Each row must name a course from this department; a student number that already exists is skipped, never overwritten.`
            : "New students are created from the course named on each row, which is also what puts them on a department and a campus. Choosing a campus below rejects any row whose course belongs to another one. A student number that already exists is skipped, never overwritten."
        }
        templateFileName="student-import-template.csv"
        columns={studentImportColumns}
        fields={importFields}
        values={importValues}
        onFieldChange={(key, value) => setImportTerm((prev) => ({ ...prev, [key]: value }))}
        onSubmit={handleImport}
        progress={importProgress}
        preview={importPreview}
        rowNotice={(count) =>
          count > STUDENT_IMPORT_BATCH_SIZE
            ? `Sent in ${Math.ceil(count / STUDENT_IMPORT_BATCH_SIZE)} batches of up to ${STUDENT_IMPORT_BATCH_SIZE.toLocaleString()}. Keep this window open until it finishes.`
            : ""
        }
        submitLabel="Import students"
        summarize={(r) => [
          { label: "Rows read", value: r.summary?.rows_read ?? 0 },
          { label: "Imported", value: r.summary?.inserted ?? 0, tone: "good" },
          ...(r.summary?.skipped ? [{ label: "Skipped", value: r.summary.skipped, tone: "warn" }] : []),
          ...(r.summary?.failed ? [{ label: "Failed to save", value: r.summary.failed, tone: "bad" }] : []),
        ]}
        detail={(r) => [
          // First, because it changes where every listed student ended up.
          { label: "About the new logins", items: r.accountsNote ? [r.accountsNote] : [] },
          { label: "Rows skipped during validation", items: r.details?.row_errors || [] },
          { label: "Rows the server rejected", items: r.details?.failed_rows || [] },
        ]}
      />

      <Modal
        open={Boolean(newAccount)}
        title="Student login created"
        onClose={() => setNewAccount(null)}
        width={391}
      >
        <div style={{ display: "grid", gap: 11 }}>
          <div style={{ color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.5 }}>
            {newAccount?.emailSent
              ? "A student account was created and the sign-in details were emailed to them. The password is shown here once as a backup — it is stored hashed and cannot be shown again."
              : "A student account was created for this email. Copy the temporary password now — it is stored hashed and cannot be shown again."}
          </div>

          {newAccount?.emailSent ? (
            <div style={{ background: "var(--brand-50)", border: "1px solid var(--brand-200)", color: "var(--brand-800)", padding: "6px 8px", borderRadius: 6, fontSize: 11.5 }}>
              Email sent to {newAccount.email}
            </div>
          ) : newAccount?.emailSkipped ? (
            /* Switched off on purpose, so this states a fact rather than
               reporting a fault the admin would go looking for. */
            <div style={{ background: "var(--surface-page)", border: "1px solid var(--border-strong)", color: "var(--text-secondary)", padding: "6px 8px", borderRadius: 6, fontSize: 11.5 }}>
              Email sending is switched off in Settings — give them these details yourself.
            </div>
          ) : (
            <div style={{ background: "var(--warning-100)", border: "1px solid var(--warning-200)", color: "var(--warning-800)", padding: "6px 8px", borderRadius: 6, fontSize: 11.5 }}>
              Could not email the student — give them these details yourself.
              {newAccount?.emailError ? (
                <div style={{ marginTop: 3, opacity: 0.85 }}>{newAccount.emailError}</div>
              ) : null}
            </div>
          )}

          <div style={{ border: "1px solid var(--border-base)", borderRadius: 8, overflow: "hidden" }}>
            <div style={{ padding: "8px 9px", borderBottom: "1px solid var(--surface-muted)" }}>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Email</div>
              <div style={{ fontSize: 12.5, color: "var(--text-primary)", overflowWrap: "anywhere" }}>{newAccount?.email}</div>
            </div>
            <div style={{ padding: "8px 9px", background: "var(--surface-page)" }}>
              <div style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Temporary password</div>
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  letterSpacing: 1,
                  color: "var(--text-primary)",
                  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
                }}
              >
                {newAccount?.password}
              </div>
            </div>
          </div>

          {newAccount?.mustChange ? (
            <div style={{ background: "var(--brand-50)", border: "1px solid var(--brand-200)", color: "var(--brand-800)", padding: "6px 8px", borderRadius: 6, fontSize: 11.5 }}>
              The student must set a new password the first time they sign in.
            </div>
          ) : null}

          <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                if (navigator?.clipboard?.writeText) {
                  void navigator.clipboard.writeText(newAccount?.password || "");
                }
              }}
            >
              Copy password
            </Button>
            <Button type="button" onClick={() => setNewAccount(null)}>Done</Button>
          </div>
        </div>
      </Modal>

      <Modal
        open={Boolean(detailStudent)}
        title="Student Record"
        onClose={() => setDetailStudent(null)}
        width={760}
      >
        <div style={{ display: "grid", gap: 11 }}>
          <StudentDetail
            student={detailStudent}
            courseById={courseById}
            courseNameById={courseNameById}
            schoolYearNameById={schoolYearNameById}
          />
          {/* Fetched rather than read off the row: student.php returns the
              student table, and a term-by-term record lives in four others. */}
          <StudentTermHistory studentId={detailStudent?.student_id} />
        </div>
      </Modal>

      <Modal open={openModal} title={form.id ? "Edit Student" : "Add Student"} onClose={() => setOpenModal(false)} width={646} error={error}>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void saveStudent();
          }}
          style={{ gap: 9, gridTemplateColumns: "repeat(auto-fit, minmax(min(187px, 100%), 1fr))" }}
        >
          <div style={scopeBannerStyle}>
            <div>
              <span style={scopeLabelStyle}>Department</span>
              <span style={scopeValueStyle}>{formDepartmentLabel}</span>
            </div>
            <div>
              <span style={scopeLabelStyle}>Campus</span>
              <span style={scopeValueStyle}>{formCampusLabel}</span>
            </div>
          </div>

          <FormField label="Student Number" htmlFor="dean_student_number" required>
            <input id="dean_student_number" value={form.student_number} onChange={(event) => setForm((prev) => ({ ...prev, student_number: event.target.value }))} style={fieldStyle} name="dean_student_number" />
          </FormField>

          <FormField label={STUDENT_TYPE_LABEL} htmlFor="dean_student_type">
            <select id="dean_student_type" value={form.student_type} onChange={(event) => setForm((prev) => ({ ...prev, student_type: event.target.value }))} style={fieldStyle} name="dean_student_type">
              {STUDENT_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </FormField>

          {/*
            * The four name fields type in capitals.
            *
            * The server has stored them that way for a while - the RETENTION &
            * MIGRATION sheet writes every student in capitals, so
            * normalize_student_name() uppercases on the way in - but the form
            * did not, so typing "Juan" and saving produced "JUAN" on the list
            * behind it. Uppercasing the value here rather than only styling it
            * means what the field shows is what the record will hold.
            */}
          <FormField label="First Name" htmlFor="dean_first_name" required>
            <input id="dean_first_name" value={form.first_name} onChange={(event) => setForm((prev) => ({ ...prev, first_name: upperName(event.target.value) }))} style={fieldStyle} name="dean_first_name" />
          </FormField>

          <FormField label="Last Name" htmlFor="dean_last_name" required>
            <input id="dean_last_name" value={form.last_name} onChange={(event) => setForm((prev) => ({ ...prev, last_name: upperName(event.target.value) }))} style={fieldStyle} name="dean_last_name" />
          </FormField>

          <FormField label="Middle Name" htmlFor="dean_middle_name">
            <input id="dean_middle_name" value={form.middle_name} onChange={(event) => setForm((prev) => ({ ...prev, middle_name: upperName(event.target.value) }))} style={fieldStyle} name="dean_middle_name" />
          </FormField>

          <FormField label="Extension On Name" htmlFor="dean_extension_name">
            <input id="dean_extension_name" value={form.extension_name} onChange={(event) => setForm((prev) => ({ ...prev, extension_name: upperName(event.target.value) }))} style={fieldStyle} name="dean_extension_name" placeholder="JR, SR, III" maxLength={20} />
          </FormField>

          <FormField label="Email" htmlFor="dean_email">
            <input id="dean_email" type="email" value={form.email_address} onChange={(event) => setForm((prev) => ({ ...prev, email_address: event.target.value }))} style={fieldStyle} name="dean_email" />
          </FormField>

          <FormField label="Mobile Number" htmlFor="dean_mobile">
            <input id="dean_mobile" value={form.mobile_number} onChange={(event) => setForm((prev) => ({ ...prev, mobile_number: event.target.value }))} style={fieldStyle} name="dean_mobile" />
          </FormField>

          <FormField label="Gender" htmlFor="dean_gender">
            <select id="dean_gender" value={form.gender} onChange={(event) => setForm((prev) => ({ ...prev, gender: event.target.value }))} style={fieldStyle} name="dean_gender">
              <option value="">Select gender</option>
              {optionsWithCurrent(genderChoices, form.gender).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </FormField>

          <FormField label="Modality" htmlFor="dean_modality">
            <select id="dean_modality" value={form.modality || getDropdownDefault("modalities") || ""} onChange={(event) => setForm((prev) => ({ ...prev, modality: event.target.value }))} style={fieldStyle} name="dean_modality">
              {optionsWithCurrent(modalityChoices, form.modality).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </FormField>

          {/*
            * Campus narrows the Course list, it is not saved on its own — a
            * student's campus is whatever campus its course belongs to. Shown
            * only when more than one campus is in reach, matching the table's
            * own Campus filter; with a single campus the Course list is already
            * unambiguous and the banner above names it.
            */}
          {campusOptions.length > 1 && (
            <FormField label="Campus" htmlFor="dean_campus_id">
              <select
                id="dean_campus_id"
                value={formCampusId}
                onChange={(event) => {
                  const nextCampus = event.target.value;
                  setFormCampusId(nextCampus);
                  // Drop a course that does not sit on the newly chosen campus,
                  // so the Course dropdown never shows a selection it no longer
                  // offers.
                  setForm((prev) => {
                    if (!prev.course_id || !nextCampus) return prev;
                    const chosen = courseById[String(prev.course_id)];
                    if (chosen && String(chosen.campus_id ?? "") !== nextCampus) {
                      return { ...prev, course_id: "" };
                    }
                    return prev;
                  });
                }}
                style={fieldStyle}
                name="dean_campus_id"
              >
                <option value="">All campuses</option>
                {campusOptions.map((campus) => (
                  <option key={campus.campus_id} value={campus.campus_id}>{campus.label}</option>
                ))}
              </select>
            </FormField>
          )}

          <FormField label="Course" htmlFor="dean_course_id" required>
            <select id="dean_course_id" value={String(form.course_id || "")} onChange={(event) => setForm((prev) => ({ ...prev, course_id: event.target.value }))} style={fieldStyle} name="dean_course_id">
              <option value="">Select course</option>
              {formCourseOptions.map((course) => (
                <option key={course.course_id} value={course.course_id}>
                  {course.course_name || course.course_code || `Course ${course.course_id}`}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label={`Year Level (1-${selectedCourseYearDuration})`} htmlFor="dean_year_level">
            <input
              id="dean_year_level"
              type="number"
              min="1"
              // Tracks the chosen course: 5 for Architecture, 4 for the rest.
              max={selectedCourseYearDuration}
              value={form.year_level}
              onChange={(event) => setForm((prev) => ({ ...prev, year_level: event.target.value }))}
              style={fieldStyle}
              name="dean_year_level"
              aria-describedby="dean_year_level_hint"
            />
            <span id="dean_year_level_hint" style={{ display: "block", marginTop: 3, fontSize: 10.5, color: "var(--text-faint)" }}>
              {form.course_id
                ? `${selectedCourseCode} is a ${selectedCourseYearDuration}-year programme.`
                : "Select a course to set the year level range."}
            </span>
          </FormField>

          <FormField label="Section" htmlFor="dean_section">
            <input
              id="dean_section"
              value={form.section}
              // Upper-cased and stripped of characters a section cannot hold, so
              // "coc-fab-bsit2-03" typed in a hurry is the same section as the
              // one already on file rather than a second one.
              onChange={(event) => setForm((prev) => ({ ...prev, section: sanitizeSectionInput(event.target.value) }))}
              style={fieldStyle}
              name="dean_section"
              placeholder={suggestedSection || "COC-FAB-BSIT2-03"}
              aria-describedby="dean_section_hint"
            />
            <span id="dean_section_hint" style={{ display: "block", marginTop: 3, fontSize: 10.5, color: "var(--text-faint)" }}>
              {suggestedSection
                ? `Sections for this course and year look like ${suggestedSection}. Change the last two digits.`
                : "Campus, department, course, year level, then the section number - e.g. COC-FAB-BSIT2-03."}
            </span>
          </FormField>

          <FormField label="School Year" htmlFor="dean_schoolyear_id">
            <select id="dean_schoolyear_id" value={String(form.schoolyear_id || "")} onChange={(event) => setForm((prev) => ({ ...prev, schoolyear_id: event.target.value }))} style={fieldStyle} name="dean_schoolyear_id">
              <option value="">Select school year</option>
              {schoolYears.map((schoolYear) => (
                <option key={schoolYear.school_year_id} value={schoolYear.school_year_id}>
                  {schoolYear.schoolyear_name || `School Year ${schoolYear.school_year_id}`}
                </option>
              ))}
            </select>
          </FormField>

          <FormField label="Final Scholarship Grant" htmlFor="dean_final_scholarship_grant">
            <select id="dean_final_scholarship_grant" value={form.final_scholarship_grant} onChange={(event) => setForm((prev) => ({ ...prev, final_scholarship_grant: event.target.value }))} style={fieldStyle} name="dean_final_scholarship_grant">
              {/* Blank first and selectable: not recorded is the honest answer
                  for every student until the registrar enters their grant. */}
              <option value="">Not recorded</option>
              {optionsWithCurrent(grantChoices, form.final_scholarship_grant).map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </select>
          </FormField>

          {/*
            No alert here — <Modal error={error}> above renders it.

            This used to hold a second copy, on the reasoning that a banner at
            the top of a three-section scrolling form is off-screen at the
            moment it matters. That was true of the old PAGE-level banner, but
            Modal pins its alert between the fixed header and the scrolling
            body, so it stays on screen at every scroll position — and it is
            already role="alert" + aria-live, so nothing is lost by dropping
            this one. Two copies of one sentence in a single dialog read as two
            separate problems.
          */}
          <div style={{ gridColumn: "1 / -1" }}>
            <FormActions>
              <Button variant="secondary" onClick={() => setOpenModal(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={saving}>
                {saving ? "Saving..." : "Save"}
              </Button>
            </FormActions>
          </div>
        </Form>
      </Modal>
    </section>
  );
}
