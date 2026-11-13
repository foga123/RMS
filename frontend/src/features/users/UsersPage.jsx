import React, { useCallback, useEffect, useId, useMemo, useState } from "react";
import { formatDateTime } from "../../shared/lib/dateTime";
import { SkeletonTableRows } from "../../shared/components/ui/Skeleton";
import { AnimatePresence, motion } from "framer-motion";
import { ActionMenu, AlertMessage, Button, Icon } from "../../shared/components/ui";
import { ManagementPagination } from "../../shared/components/management";
import { InputControl, SelectControl } from "../../shared/components/Form/Form";
import { confirmAction, notifyError, notifySuccess } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { readAuthUser } from "../../shared/lib/auth";
import { recordPasswordChange } from "../../shared/lib/securityPolicy";
import { validatePassword } from "../../shared/lib/passwordValidation";
import PasswordRequirements from "../auth/components/PasswordRequirements";
import { getBackendUrl } from "../../shared/lib/url";
import {
  STUDENT_TYPES,
  STUDENT_TYPE_LABEL,
  STUDENT_TYPE_NON_STAR,
} from "../../shared/lib/studentType";
import useDropdownOptions, { getDropdownDefault, optionsWithCurrent } from "../../shared/lib/dropdownOptions";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";

const inputStyle = { width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 };
const labelStyle = { display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 };
// Locked fields read as data, not as a control the user failed to operate.
const disabledInputStyle = { background: "var(--surface-page)", color: "var(--text-secondary)", cursor: "not-allowed" };
const hintStyle = { display: "block", fontSize: 10.5, color: "var(--text-faint)", marginTop: 3 };

function trimToNull(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text === "" ? null : text;
}

/**
 * How to refer to an account out loud.
 *
 * Used by the row action buttons, whose labels a screen reader announces in
 * place of the icon. They named the account by `user_id`, which identifies the
 * row to the database and nobody to a listener — "Edit user 137" is not a thing
 * anyone can act on. Falls back to the email, then to a generic label, because
 * an account with neither is still a button that has to say something.
 */
function userLabel(user) {
  const name = [user?.first_name, user?.last_name]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .join(" ");
  return name || trimToNull(user?.email) || "this user";
}

function defaultStudent() {
  return {
    student_id: "",
    student_number: "",
    student_type: STUDENT_TYPE_NON_STAR,
    middle_name: "",
    gender: "",
    email_address: "",
    // Blank until picked; the select shows the list's default and the server
    // applies it.
    modality: "",
    mobile_number: "",
    mother_number: "",
    father_number: "",
    home_address: "",
    facebook_name: "",
    course_id: "",
    schoolyear_id: "1",
    year_level: "",
    section: "",
    // Not recorded. This defaulted to "Others", a value retired on 2026-08-21
    // that student.php refuses - so every student saved from this screen
    // failed unless someone changed it, and the screen offered nothing valid
    // to change it to.
    final_scholarship_grant: "",
  };
}

function defaultForm(scope = null) {
  return {
    first_name: "",
    last_name: "",
    email: "",
    role_id: "",
    role_name: "",
    // Seeded from the creator's own department when they are scoped to one, so
    // the locked select below has a value to show.
    department_id: scope?.departmentId ?? "",
    campus_id: scope?.campusId ?? "",
    status: 1,
    password: "",
    student: defaultStudent(),
  };
}

const isStudentRole = (roleName) => String(roleName || "").toLowerCase().includes("student");
// Exact match, unlike isStudentRole's substring test: this gates account
// creation, so a role merely containing the word (an "Admin Assistant", say)
// must not be swept up by it.
const isAdminRole = (roleName) => String(roleName || "").trim().toLowerCase() === "admin";
const nullableNumber = (v) => (String(v ?? "").trim() === "" ? null : Number(v));
const normalizeAccountStatus = (statusValue, statusName, statusType) => {
  const normalized = Number(statusValue);
  const normalizedName = String(statusName || "").trim().toLowerCase();
  const text = String(statusType || "").trim().toLowerCase();
  if (normalized === 1 || normalizedName === "active" || text === "active") return 1;
  if (normalized === 2 || normalized === 0 || normalizedName === "inactive" || normalizedName === "archived") {
    return 2;
  }
  if (normalized > 1) return 2;
  return 1;
};

function getUserDisplayName(user) {
  return [user?.first_name, user?.last_name]
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join(" ")
    || String(user?.email || "").trim()
    || `User ${user?.user_id ?? ""}`.trim();
}

/**
 * Is this row the administrator account?
 *
 * user.php refuses to archive, deactivate, delete or demote it -- see
 * user_guard_admin() there, which is the authority. This is the same rule in the
 * browser, and it exists only so the screen does not OFFER an action the server
 * will refuse: a "Set as Inactive" link that returns 409 teaches an admin that
 * the page is broken rather than that the account is protected.
 *
 * Matched on role_id first with the role name as a fallback, mirroring the
 * server exactly. Guessing differently here would be worse than not checking:
 * the buttons would disagree with what actually happens.
 */
function isProtectedAdminRow(user) {
  if (!user) return false;
  if (Number(user.role_id) === 1) return true;
  return String(user.role_name || "").trim().toLowerCase() === "admin";
}

function createRequestError(message, { code = "request_failed", status = 0, details = "" } = {}) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
}

function prefixErrorMessage(label, detail, fallbackMessage) {
  const normalizedLabel = String(label || "").trim();
  const normalizedDetail = String(detail || "").trim();
  const normalizedFallback = String(fallbackMessage || "").trim();

  if (!normalizedLabel) {
    return normalizedDetail || normalizedFallback;
  }

  if (!normalizedDetail) {
    return normalizedFallback ? `${normalizedLabel}. ${normalizedFallback}` : normalizedLabel;
  }

  if (normalizedDetail.toLowerCase().startsWith(normalizedLabel.toLowerCase())) {
    return normalizedDetail;
  }

  return `${normalizedLabel}. ${normalizedDetail}`;
}

function describeUpdateError(error, fallbackMessage = "Failed to update user status.", defaultTitle = "Update failed") {
  const code = String(error?.code || "").trim().toLowerCase();
  const detail = String(error?.message || "").trim();

  if (code === "server_unavailable") {
    return {
      title: "Server unavailable",
      message: prefixErrorMessage("Server unavailable", detail, "Check the backend API route and PHP server."),
    };
  }

  if (code === "invalid_request") {
    return {
      title: "Invalid request",
      message: prefixErrorMessage("Invalid request", detail, fallbackMessage),
    };
  }

  return {
    title: defaultTitle,
    message: prefixErrorMessage(defaultTitle, detail, fallbackMessage),
  };
}

function getUserStatusLabel(user) {
  return normalizeAccountStatus(user?.status, user?.status_name, user?.status_type) === 1
    ? "Active"
    : "Archived";
}

function buildArchivedUserRow(nextUser, previousUser = null) {
  const base = { ...(previousUser || {}), ...(nextUser || {}) };
  return {
    ...base,
    status: Number(base?.status) > 0 ? Number(base.status) : 2,
    status_name: String(base?.status_name || "").trim() || "Archived",
    status_type: String(base?.status_type || "").trim() || "account",
    archived: true,
  };
}

function buildActiveUserRow(nextUser, previousUser = null) {
  const base = { ...(previousUser || {}), ...(nextUser || {}) };
  return {
    ...base,
    status: 1,
    status_name: String(base?.status_name || "").trim() || "Active",
    status_type: String(base?.status_type || "").trim() || "account",
    archived: false,
  };
}

function ReadOnlyField({ label, value }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-base)",
        borderRadius: 8,
        background: "var(--surface-page)",
        padding: 9,
        display: "grid",
        gap: 5,
        minHeight: 70,
      }}
    >
      <span style={{ color: "var(--text-muted)", fontSize: 10.5, fontWeight: 600 }}>{label}</span>
      <strong style={{ color: "var(--text-primary)", fontSize: 12.5, lineHeight: 1.4, wordBreak: "break-word" }}>
        {String(value ?? "").trim() || "-"}
      </strong>
    </div>
  );
}

async function requestJson(path, options = {}, fallbackMessage = "Request failed") {
  let response;
  try {
    response = await fetch(getBackendUrl(path), {
      credentials: "include",
      ...options,
    });
  } catch (error) {
    throw createRequestError(
      "Server unavailable. Check the backend API route and PHP server.",
      { code: "server_unavailable", details: fallbackMessage }
    );
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  const rawText = await response.text();
  let isJson = contentType.includes("application/json");
  let data = {};

  if (rawText) {
    try {
      data = JSON.parse(rawText);
      isJson = true;
    } catch {
      data = {};
    }
  }

  if (!response.ok) {
    const serverMessage = (isJson && typeof data?.message === "string" && data.message.trim())
      ? data.message.trim()
      : "";

    if (response.status >= 500) {
      throw createRequestError(
        serverMessage || "Server unavailable. The backend user service did not respond correctly.",
        { code: "server_unavailable", status: response.status, details: fallbackMessage }
      );
    }

    if ([400, 405, 415, 422].includes(response.status)) {
      throw createRequestError(
        serverMessage || fallbackMessage,
        { code: "invalid_request", status: response.status, details: fallbackMessage }
      );
    }

    throw createRequestError(
      serverMessage || fallbackMessage,
      { code: "request_failed", status: response.status, details: fallbackMessage }
    );
  }

  return isJson ? data : {};
}

function LabeledInput({ label, type = "text", value, onChange, id, ...rest }) {
  const autoId = useId();
  const fieldId = id || rest.name || `user_management_input_${autoId}`;
  return (
    <div>
      <label style={labelStyle} htmlFor={fieldId}>{label}</label>
      <input
        id={fieldId}
        type={type}
        value={value}
        onChange={onChange}
        style={{ ...inputStyle, ...(rest.disabled ? disabledInputStyle : null) }}
        {...rest}
      />
    </div>
  );
}

function LabeledSelect({ label, value, onChange, children, id, hint, ...rest }) {
  const autoId = useId();
  const fieldId = id || rest.name || `user_management_select_${autoId}`;
  const hintId = hint ? `${fieldId}_hint` : undefined;
  return (
    <div>
      <label style={labelStyle} htmlFor={fieldId}>{label}</label>
      <select
        id={fieldId}
        value={value}
        onChange={onChange}
        style={{ ...inputStyle, ...(rest.disabled ? disabledInputStyle : null) }}
        aria-describedby={hintId}
        {...rest}
      >
        {children}
      </select>
      {hint ? <span id={hintId} style={hintStyle}>{hint}</span> : null}
    </div>
  );
}

export default function UserManagement({ permissions = null }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isViewModalOpen, setIsViewModalOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  /*
   * Judged on the STORED account, not on the form.
   *
   * Reading form.role_id would unlock the moment somebody changed the dropdown
   * — which is exactly the edit the guard exists to refuse. What matters is what
   * the account is right now, and that is selectedUser.
   */
  const editingProtectedAdmin = isProtectedAdminRow(selectedUser);
  const [viewUser, setViewUser] = useState(null);
  const [viewLoading, setViewLoading] = useState(false);
  const [viewError, setViewError] = useState("");
  /**
   * Department scoping for the Add/Edit form.
   *
   * Admins provision across the whole institution, so they keep the full list.
   * Everyone else creates accounts only inside their own department — the
   * select is locked to it rather than filtered, so the constraint is visible
   * instead of looking like missing data.
   *
   * A user with no department on their record (older accounts) falls back to
   * the full list; locking them to nothing would leave them unable to add
   * anyone at all.
   */
  const currentUser = readAuthUser();
  const departmentScope = useMemo(() => {
    const departmentId = Number(currentUser?.department_id || 0);
    if (isAdminRole(currentUser?.role_name) || departmentId <= 0) return null;
    return { departmentId, campusId: Number(currentUser?.campus_id || 0) || "" };
  }, [currentUser?.department_id, currentUser?.campus_id, currentUser?.role_name]);

  const [form, setForm] = useState(() => defaultForm(departmentScope));
  // Gender, grant and modality choices - the office's lists, from the server.
  // This screen kept its own copies until 2026-09-25, and they had gone stale.
  const dropdownLists = useDropdownOptions();
  const [roles, setRoles] = useState([]);
  const [departments, setDepartments] = useState([]);
  const [campuses, setCampuses] = useState([]);
  const [courses, setCourses] = useState([]);
  const [schoolYears, setSchoolYears] = useState([]);
  const [studentLoading, setStudentLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [campusFilter, setCampusFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);

  // The load effect below already re-runs on refreshKey, so the live probe just
  // bumps it rather than reaching into the effect.
  useLiveRefresh(["users", "roles", "departments"], () => setRefreshKey((n) => n + 1));
  const [isArchiveModalOpen, setIsArchiveModalOpen] = useState(false);
  const [archivedRows, setArchivedRows] = useState([]);
  const [archivedLoading, setArchivedLoading] = useState(false);
  const [archivedError, setArchivedError] = useState("");
  const [archivedSearch, setArchivedSearch] = useState("");
  const [statusUpdatingId, setStatusUpdatingId] = useState(null);
  const hasPermissionContext = Array.isArray(permissions);
  const canCreate = hasPermissionContext ? canModuleAction(permissions, "create") : true;
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;
  const canArchive = hasPermissionContext ? canModuleAction(permissions, "archive") : true;
  const canRestore = hasPermissionContext ? canModuleAction(permissions, "restore") : true;

  const pickedRole = useMemo(
    () => roles.find((r) => Number(r.role_id) === Number(form.role_id)),
    [roles, form.role_id]
  );
  /**
   * Admin is not offered when creating or editing an account — admins are
   * provisioned outside this screen.
   *
   * The one exception is an existing Admin being edited: drop their role from
   * the list and the select falls back to "Select role", so saving an unrelated
   * field (a department fix, say) would silently strip their access.
   */
  const assignableRoles = useMemo(
    () =>
      roles.filter(
        (role) => !isAdminRole(role?.role_name) || Number(role?.role_id) === Number(form.role_id)
      ),
    [roles, form.role_id]
  );
  const departmentMap = useMemo(() => {
    const map = {};
    departments.forEach((department) => {
      if (department?.department_id != null) {
        map[String(department.department_id)] = department;
      }
    });
    return map;
  }, [departments]);
  /**
   * Scoped users get exactly their own department. The record being edited is
   * kept in the list regardless, so opening a user who sits outside your scope
   * does not blank the select and wipe their department on save.
   */
  const selectableDepartments = useMemo(() => {
    const scoped = departmentScope
      ? departments.filter(
        (d) =>
          Number(d.department_id) === departmentScope.departmentId ||
          Number(d.department_id) === Number(form.department_id)
      )
      : departments;

    /*
     * Narrowed by the chosen campus.
     *
     * A department belongs to exactly one campus, so picking the campus first is
     * what makes the department list short enough to read — and it is the order
     * people actually think in. The department already on the record is always
     * kept, so opening a user whose department sits on another campus does not
     * blank the select and wipe it on save.
     */
    const campusId = Number(form.campus_id || 0);
    if (!campusId) return scoped;
    return scoped.filter(
      (d) =>
        Number(d.campus_id) === campusId ||
        Number(d.department_id) === Number(form.department_id)
    );
  }, [departments, departmentScope, form.campus_id, form.department_id]);

  const roleIsStudent = isStudentRole(pickedRole?.role_name || form.role_name);
  const filteredCourses = useMemo(() => {
    const deptId = Number(form.department_id || 0);
    if (!deptId) return [];
    return courses.filter((c) => Number(c.department_id) === deptId);
  }, [courses, form.department_id]);
  const filteredArchivedRows = useMemo(() => {
    const q = archivedSearch.trim().toLowerCase();
    if (!q) return archivedRows;
    return archivedRows.filter((u) => {
      const haystack = [
        u.user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.role_name,
        u.department_name,
        u.campus_name,
      ]
        .map((v) => String(v || "").toLowerCase())
        .join(" ");
      return haystack.includes(q);
    });
  }, [archivedRows, archivedSearch]);

  function moveUserToArchivedLocally(nextUser, previousUser = null) {
    const archivedUser = buildArchivedUserRow(nextUser, previousUser);
    const targetId = Number(archivedUser?.user_id || previousUser?.user_id || 0);
    const rowExists = rows.some((row) => Number(row?.user_id) === targetId);

    if (rowExists) {
      setRows((prev) => prev.filter((row) => Number(row?.user_id) !== targetId));
      setTotal((prev) => Math.max(0, Number(prev || 0) - 1));
    }

    setArchivedRows((prev) => {
      const next = prev.filter((row) => Number(row?.user_id) !== targetId);
      next.push(archivedUser);
      next.sort((left, right) => Number(left?.user_id || 0) - Number(right?.user_id || 0));
      return next;
    });

    setViewUser((prev) => (Number(prev?.user_id) === targetId ? archivedUser : prev));

    return archivedUser;
  }

  function updateUserRowLocally(nextUser, previousUser = null) {
    const activeUser = buildActiveUserRow(nextUser, previousUser);
    const targetId = Number(activeUser?.user_id || previousUser?.user_id || 0);

    setRows((prev) =>
      prev.map((row) => (
        Number(row?.user_id) === targetId
          ? { ...row, ...activeUser }
          : row
      ))
    );
    setArchivedRows((prev) => prev.filter((row) => Number(row?.user_id) !== targetId));
    setViewUser((prev) => (Number(prev?.user_id) === targetId ? activeUser : prev));

    return activeUser;
  }

  useEffect(() => {
    let active = true;
    async function load() {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("search", search.trim());
        if (roleFilter) params.set("role_id", roleFilter);
        if (departmentFilter) params.set("department_id", departmentFilter);
        if (campusFilter) params.set("campus_id", campusFilter);
        if (statusFilter) params.set("status", statusFilter);
        params.set("page", String(page));
        params.set("limit", String(limit));

        const [usersData, rolesData, depData, campusData, courseData, schoolYearData] = await Promise.all([
          requestJson(`user.php?${params.toString()}`, {}, "Failed to load users"),
          requestJson("roles.php?limit=1000", {}, "Failed to load roles"),
          requestJson("department.php?limit=1000", {}, "Failed to load departments"),
          requestJson("campus.php?limit=1000", {}, "Failed to load campuses"),
          requestJson("course.php?limit=1000", {}, "Failed to load courses"),
          requestJson("school_year.php?limit=1000", {}, "Failed to load school years"),
        ]);

        if (active) {
          setRows(Array.isArray(usersData.data) ? usersData.data : []);
          setRoles(Array.isArray(rolesData.data) ? rolesData.data : []);
          setDepartments(Array.isArray(depData.data) ? depData.data : []);
          setCampuses(Array.isArray(campusData.data) ? campusData.data : []);
          setCourses(Array.isArray(courseData.data) ? courseData.data : []);
          setSchoolYears(Array.isArray(schoolYearData.data) ? schoolYearData.data : []);
          setTotal(typeof usersData?.pagination?.total === "number" ? usersData.pagination.total : 0);
        }
      } catch (e) {
        if (active) setError(e.message || "Failed to load users");
      } finally {
        if (active) setLoading(false);
      }
    }
    load();
    return () => {
      active = false;
    };
  }, [page, limit, search, roleFilter, departmentFilter, campusFilter, statusFilter, refreshKey]);

  async function loadArchivedUsers() {
    setArchivedLoading(true);
    setArchivedError("");
    try {
      const params = new URLSearchParams();
      params.set("archived", "1");
      params.set("page", "1");
      params.set("limit", "500");
      const data = await requestJson(`user.php?${params.toString()}`, {}, "Failed to load archived users");
      setArchivedRows(Array.isArray(data.data) ? data.data : []);
    } catch (e) {
      setArchivedError(e.message || "Failed to load archived users");
    } finally {
      setArchivedLoading(false);
    }
  }

  async function openArchivePanel() {
    setIsArchiveModalOpen(true);
    await loadArchivedUsers();
  }

  async function findStudentByUserId(userId) {
    const params = new URLSearchParams({ page: "1", limit: "1", user_id: String(userId) });
    const data = await requestJson(`student.php?${params.toString()}`, {}, "Failed to load student details");
    const list = Array.isArray(data.data) ? data.data : [];
    return list[0] || null;
  }

  function studentPayload(userId) {
    const s = form.student;
    return {
      student_number: String(s.student_number || "").trim() || null,
      student_type: String(s.student_type || STUDENT_TYPE_NON_STAR).trim() || STUDENT_TYPE_NON_STAR,
      first_name: String(form.first_name || "").trim(),
      last_name: String(form.last_name || "").trim(),
      middle_name: String(s.middle_name || "").trim() || null,
      gender: String(s.gender || "").trim() || null,
      email_address: String(form.email || "").trim() || null,
      // Blank is sent as blank: the server fills in the list's default.
      modality: String(s.modality || "").trim() || null,
      mobile_number: String(s.mobile_number || "").trim() || null,
      mother_number: String(s.mother_number || "").trim() || null,
      father_number: String(s.father_number || "").trim() || null,
      home_address: String(s.home_address || "").trim() || null,
      facebook_name: String(s.facebook_name || "").trim() || null,
      course_id: nullableNumber(s.course_id),
      user_id: Number(userId),
      schoolyear_id: nullableNumber(s.schoolyear_id),
      year_level: nullableNumber(s.year_level),
      section: String(s.section || "").trim() || null,
      final_scholarship_grant: String(s.final_scholarship_grant || "").trim() || null,
    };
  }

  /*
   * Put the cursor on the field that is wrong.
   *
   * A required field left blank used to surface as a sentence at the top of a
   * dialog that scrolls — "Valid email is required", from the server, after a
   * round trip — with nothing indicating which box it meant. On the student
   * form, which is three sections long, the offending field was frequently off
   * screen. Focusing it scrolls it into view and puts the caret in it, so the
   * next keystroke fixes the thing the message is about.
   *
   * Looked up by id at call time rather than held as a ref: these fields are
   * inside a conditional subtree that only exists while the dialog is open, and
   * several of them only render for a student.
   */
  const focusField = useCallback((fieldId) => {
    if (!fieldId) return;
    // After the error banner renders, so the scroll lands in the right place.
    window.requestAnimationFrame(() => {
      const el = document.getElementById(fieldId);
      if (!el) return;
      try {
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch {
        el.scrollIntoView();
      }
      el.focus({ preventScroll: true });
    });
  }, []);

  /** setError, plus the caret on the field the message is about. */
  const failField = useCallback((message, fieldId) => {
    setError(message);
    focusField(fieldId);
    return undefined;
  }, [focusField]);

  /** "" when valid, otherwise { message, field } naming the input to focus. */
  function validateStudent() {
    const s = form.student;
    if (!String(s.student_number || "").trim()) {
      return { message: "Enter the student number, like 02-2324-10233.", field: "user_management_input_6102" };
    }
    if (!String(s.course_id || "").trim()) {
      return { message: "Choose the student's course.", field: "user_management_select_6108" };
    }
    if (
      String(form.department_id || "").trim() &&
      !courses.some(
        (c) =>
          Number(c.course_id) === Number(s.course_id) &&
          Number(c.department_id) === Number(form.department_id)
      )
    ) {
      return {
        message: "That course belongs to a different department. Pick a course from the department chosen above.",
        field: "user_management_select_6108",
      };
    }
    if (!String(s.year_level || "").trim()) {
      return { message: "Choose the student's year level.", field: "user_management_input_6109" };
    }
    return "";
  }

  async function createUserRecord(payload) {
    const data = await requestJson("user.php", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, "Failed to create user");
    return data?.data || null;
  }

  async function updateUserRecord(userId, payload) {
    const data = await requestJson(`user.php?id=${userId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, "Failed to update user");
    return data?.data || null;
  }

  async function deleteUserRecord(userId) {
    await requestJson(`user.php?id=${userId}`, {
      method: "DELETE",
    }, "Failed to delete user");
  }

  async function saveStudentRecord(payload, existingStudentId = null) {
    const method = existingStudentId ? "PUT" : "POST";
    const endpoint = existingStudentId ? `student.php?id=${existingStudentId}` : "student.php";
    const data = await requestJson(endpoint, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, "Failed to save student details");
    return data?.data || null;
  }

  async function upsertStudent(userId) {
    const payload = studentPayload(userId);
    const existing = form.student.student_id
      ? { student_id: form.student.student_id }
      : await findStudentByUserId(userId);
    return saveStudentRecord(payload, existing?.student_id || null);
  }

  async function openEdit(u) {
    if (!canEdit) {
      // Returns before setIsModalOpen(true), so there is no modal to hold a
      // banner — the refusal has to be the popup or it is nothing at all.
      notifyError("Not allowed", "Your account cannot edit users. Ask an administrator to make this change.");
      return;
    }

    const roleMatch = roles.find(
      (r) => String(r.role_name || "").toLowerCase() === String(u.role_name || "").toLowerCase()
    );
    setSelectedUser(u);
    setForm({
      ...defaultForm(),
      first_name: u.first_name ?? "",
      last_name: u.last_name ?? "",
      email: u.email ?? "",
      role_id: u.role_id ?? (roleMatch ? roleMatch.role_id : ""),
      role_name: u.role_name ?? "",
      department_id: u.department_id ?? "",
      campus_id: u.campus_id ?? "",
      status: normalizeAccountStatus(u.status, u.status_name, u.status_type),
    });
    setIsModalOpen(true);

    if (isStudentRole(u.role_name)) {
      setStudentLoading(true);
      try {
        const sr = await findStudentByUserId(u.user_id);
        if (sr) {
          setForm((f) => ({
            ...f,
            student: {
              student_id: sr.student_id ?? "",
              student_number: sr.student_number ?? "",
              student_type: sr.student_type || STUDENT_TYPE_NON_STAR,
              middle_name: sr.middle_name ?? "",
              gender: sr.gender ?? "",
              email_address: sr.email_address ?? (u.email ?? ""),
              modality: sr.modality || "",
              mobile_number: sr.mobile_number ?? "",
              mother_number: sr.mother_number ?? "",
              father_number: sr.father_number ?? "",
              home_address: sr.home_address ?? "",
              facebook_name: sr.facebook_name ?? "",
              course_id: sr.course_id ?? "",
              schoolyear_id: sr.schoolyear_id ?? "1",
              year_level: sr.year_level ?? "",
              section: sr.section ?? "",
              final_scholarship_grant: sr.final_scholarship_grant || "",
            },
          }));
        }
      } catch (e) {
        setError(e.message || "Failed to load student details");
      } finally {
        setStudentLoading(false);
      }
    }
  }

  function closeViewModal() {
    setIsViewModalOpen(false);
    setViewLoading(false);
    setViewError("");
    setViewUser(null);
  }

  async function openView(u) {
    setViewUser(u || null);
    setViewError("");
    setViewLoading(true);
    setIsViewModalOpen(true);

    try {
      const data = await requestJson(`user.php?id=${u.user_id}`, {}, "Failed to load user details");
      setViewUser(data?.data || u || null);
    } catch (e) {
      // Same rule as the save path: the view modal is open and renders
      // `viewError` inside itself, so a popup saying the same thing would be
      // the second copy of one problem.
      setViewError(e.message || "This user's details could not be loaded.");
    } finally {
      setViewLoading(false);
    }
  }

  async function restoreUser(u) {
    if (!canRestore) {
      setArchivedError("You do not have permission to restore users.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Restore user?",
      text: `Restore archived user ${getUserDisplayName(u)}?`,
      confirmButtonText: "Restore",
    });
    if (!confirmed) return;
    setArchivedError("");
    try {
      await requestJson(`user.php?id=${u.user_id}&permission_action=restore`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      }, "Failed to restore user");
      await loadArchivedUsers();
      setRefreshKey((k) => k + 1);
      const message = `${getUserDisplayName(u)} restored to Active.`;
      setSuccess(message);
      notifySuccess("User restored", message);
    } catch (e) {
      const message = e.message || "Failed to restore user";
      setArchivedError(message);
      notifyError("Unable to restore user", message);
    }
  }

  async function toggleUserStatus(u) {
    if (!canEdit) {
      // notifyError, not setError, for the same reason as the catch below: no
      // modal is open here, so a banner would be written to a state nothing is
      // rendering and the click would look like it did nothing at all.
      notifyError("Not allowed", "Your account cannot change a user's status. Ask an administrator to do this.");
      return;
    }

    const currentStatus = normalizeAccountStatus(u?.status, u?.status_name, u?.status_type);
    const nextStatus = currentStatus === 1 ? 2 : 1;
    const displayName = [u?.first_name, u?.last_name].map((value) => String(value || "").trim()).filter(Boolean).join(" ")
      || String(u?.email || "").trim()
      || `User ${u?.user_id}`;

    if (nextStatus === 2) {
      const confirmed = await confirmAction({
        title: "Set user inactive?",
        text: `${displayName} will be moved to Archived Users.`,
        confirmButtonText: "Set Inactive",
      });
      if (!confirmed) return;
    }

    setError("");
    setSuccess("");
    setStatusUpdatingId(u.user_id);
    try {
      const updatedUser = await updateUserRecord(u.user_id, { status: nextStatus });

      if (nextStatus === 2) {
        moveUserToArchivedLocally(updatedUser, u);
        const message = `${displayName} moved to Archived Users.`;
        setSuccess(message);
        notifySuccess("User archived", message);
      } else {
        updateUserRowLocally(updatedUser, u);
        const message = `${displayName} is now active.`;
        setSuccess(message);
        notifySuccess("User activated", message);
      }
    } catch (e) {
      /*
       * The popup, and no banner — the mirror of the rule in save().
       *
       * This runs from a row in the list, with no modal open. The only place
       * that renders `error` is inside the edit modal, so the setError() that
       * used to sit here wrote to state nothing was displaying: the popup was
       * already doing all the work, and the banner would appear later, out of
       * nowhere, the next time somebody opened the modal for an unrelated edit.
       */
      const failure = describeUpdateError(e, "This user's status could not be changed.");
      notifyError(failure.title, failure.message);
    } finally {
      setStatusUpdatingId(null);
    }
  }

  async function save() {
    if (selectedUser?.user_id && !canEdit) return setError("Your account cannot edit users. Ask an administrator to make this change.");
    if (!selectedUser?.user_id && !canCreate) return setError("Your account cannot add users. Ask an administrator to create this account.");
    // The select never offers Admin for a new account, so a value reaching here
    // came from somewhere other than the dropdown. Checked on create only —
    // editing an existing Admin has to be able to save their role back.
    if (!selectedUser?.user_id && isAdminRole(pickedRole?.role_name || form.role_name)) {
      return setError("Admin accounts cannot be created here. An existing administrator has to grant that role.");
    }
    /*
     * Required to create a user, not to edit one.
     *
     * This was unconditional, and nine accounts have no department at all — SSG,
     * Secretary, CSDL, SSP Coordinator, SSP Caller, KASAMA, KSH TL, Student and
     * Admin are not departmental roles. Opening any of them here and pressing
     * Save stopped on "Department is required" no matter what had been changed,
     * so an admin could not rename them, change their status, or reset their
     * password. The reset was the one that mattered: there is no other screen
     * that does it.
     *
     * user.php only requires department_id on POST; on PUT it leaves the column
     * alone when the field is absent, which is exactly what an edit that never
     * touched it should do. This now says the same thing.
     */
    if (!selectedUser?.user_id && !form.department_id) {
      return failField("Choose a department for this account.", "user_management_select_6006");
    }

    /*
     * The three fields user.php refuses without, checked here so the message
     * arrives beside the empty box instead of coming back from the server as a
     * banner over a form that has scrolled. Email was not checked at all: the
     * only sign it was missing was "Valid email is required" after a round trip.
     */
    if (!String(form.first_name || "").trim()) {
      return failField("Enter the person's first name.", "user_management_input_6004");
    }
    if (!String(form.last_name || "").trim()) {
      return failField("Enter the person's last name.", "user_management_input_6005");
    }
    const emailValue = String(form.email || "").trim();
    if (!emailValue) {
      return failField("Enter an email address - it is what this person signs in with.", "user_management_input_6002");
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue)) {
      return failField("That email address does not look right. Check for a missing @ or a typo in the domain.", "user_management_input_6002");
    }
    if (!form.role_id) {
      return failField("Choose a role - it decides which screens this account can open.", "user_management_select_6003");
    }

    if (roleIsStudent) {
      const err = validateStudent();
      if (err) return failField(err.message, err.field);
    }
    const passwordValue = String(form.password || "");
    if (passwordValue.trim()) {
      const strength = validatePassword(passwordValue);
      if (!strength.valid) {
        return failField(strength.error, "user_management_input_6008");
      }
    }

    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const isExistingUser = Boolean(selectedUser?.user_id);
      const isArchivingUser = isExistingUser && Number(form.status) === 2;
      const payload = {
        first_name: form.first_name,
        last_name: form.last_name,
        email: form.email,
        role_id: form.role_id || null,
        department_id: form.department_id || null,
        /*
         * The chosen campus, or null to let the department decide.
         *
         * This was hardcoded null so normalize_user_campus_id() would always
         * derive the campus from the department. That works for departmental
         * roles and gives the other nine — SSG, CSDL, SSP Caller and the rest,
         * who have no department — no campus at all, with no way to set one.
         *
         * Sending it is safe: the backend still refuses a campus that
         * contradicts the department, and an empty value still derives.
         */
        campus_id: form.campus_id || null,
        status: selectedUser?.user_id ? (Number(form.status) === 2 ? 2 : 1) : 1,
      };
      if (String(form.password || "").trim()) payload.password = form.password;

      let savedUser = null;
      if (selectedUser?.user_id) {
        savedUser = await updateUserRecord(selectedUser.user_id, payload);
        if (roleIsStudent) await upsertStudent(selectedUser.user_id);
      } else {
        const data = await createUserRecord(payload);
        const newUserId = Number(data?.user_id);
        if (roleIsStudent && newUserId > 0) {
          try {
            await upsertStudent(newUserId);
          } catch (studentErr) {
            try {
              await deleteUserRecord(newUserId);
            } catch (_) {
              // cleanup best effort
            }
            throw studentErr;
          }
        }
      }

      if (passwordValue.trim()) {
        recordPasswordChange(form.email);
      }

      setIsModalOpen(false);

      if (isArchivingUser) {
        moveUserToArchivedLocally(savedUser, selectedUser);
      } else {
        setRefreshKey((k) => k + 1);
      }

      const successMessage = selectedUser?.user_id && Number(form.status) === 2
        ? "User moved to Archived Users."
        : selectedUser?.user_id
          ? "User updated."
          : "User created.";
      setSuccess(successMessage);
      notifySuccess(isArchivingUser ? "User archived" : "User saved", successMessage);
    } catch (e) {
      const failure = describeUpdateError(
        e,
        "This user could not be saved.",
        selectedUser?.user_id ? "Update failed" : "Save failed"
      );
      /*
       * The banner, and no popup.
       *
       * A failed save leaves the modal open — nothing closed it — and the modal
       * already renders `error` at the top of the form. notifyError() here put
       * the identical sentence in a SweetAlert on top of that, so one mistake
       * was announced twice and the reader had to dismiss the popup before they
       * could see the field it was complaining about.
       *
       * The banner is the one worth keeping: it sits beside the form, it does
       * not steal focus from the input the caret was just moved to, and it stays
       * readable while the value is corrected. Failures raised from the list have
       * no open modal to hold a banner and still use notifyError.
       */
      setError(failure.message);
    } finally {
      setSaving(false);
    }
  }

  const hasActiveFilters =
    Boolean(String(search).trim()) ||
    Boolean(String(roleFilter).trim()) ||
    Boolean(String(departmentFilter).trim()) ||
    Boolean(String(campusFilter).trim()) ||
    Boolean(String(statusFilter).trim()) ||
    Number(limit) !== 20;

  function resetFilters() {
    setPage(1);
    setSearch("");
    setRoleFilter("");
    setDepartmentFilter("");
    setCampusFilter("");
    setStatusFilter("");
    setLimit(20);
  }

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>User Management</h2>
      {/*
        One error on screen, never two.

        `error` is a single piece of state with two possible homes: this banner,
        and the copy inside the dialog further down. While the dialog is open it
        owns the message, because that is where the reader is looking and where
        the field they have to fix lives — so this banner stands down. With no
        dialog open there is nothing else to show a list-level failure, so it
        takes over again.

        Rendering both was the bug: a refused save painted the same sentence
        inside the dialog and again on the page behind it, visible through the
        overlay, reading as two separate problems.

        AlertMessage rather than a hand-rolled div, which is also why this
        survived the earlier sweep — a grep for AlertMessage never saw it. The
        component carries role="alert" and aria-live, so the refusal is
        announced instead of only drawn.
      */}
      {!isModalOpen && <AlertMessage message={error} tone="error" />}
      <AlertMessage message={success} tone="success" />


      <AnimatePresence>
        {isModalOpen ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            style={{ position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }}
            onClick={() => setIsModalOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 833, maxHeight: "90vh", overflow: "auto", border: "1px solid var(--border-base)" }}
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--text-primary)" }}>{selectedUser?.user_id ? "Edit User" : "Add User"}</strong>
              <Button variant="ghost" size="sm" onClick={() => setIsModalOpen(false)} aria-label="Close"><Icon name="close" size={15} /></Button>
            </div>
            {/* Inside the dialog, because this is where the action was taken. The
                page-level box below is painted UNDER this overlay, so a save the
                server refuses used to look like nothing happening at all. */}
            {error ? (
              <div style={{ flexShrink: 0, padding: "9px 12px 0" }}>
                <AlertMessage message={error} tone="error" style={{ marginBottom: 0 }} />
              </div>
            ) : null}

            <div style={{ padding: 12, display: "grid", gap: 9 }}>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 153px), 1fr))", gap: 8 }}>
                <LabeledInput
                  label="Email"
                  value={form.email}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      email: e.target.value,
                      student: { ...f.student, email_address: e.target.value },
                    }))
                  }
                  name="user_management_input_6002"
                />
                <LabeledSelect
                  label="Role"
                  value={String(form.role_id || "")}
                  onChange={(e) => { const rid = e.target.value ? Number(e.target.value) : ""; const r = roles.find((x) => Number(x.role_id) === Number(rid)); setForm((f) => ({ ...f, role_id: rid, role_name: r?.role_name || "" })); }}
                  name="user_management_select_6003"
                  disabled={editingProtectedAdmin}
                  hint={editingProtectedAdmin ? "The administrator cannot be moved to another role — it would empty the Admin role and lock Access Management." : undefined}
                >
                  <option value="">Select role</option>
                  {assignableRoles.map((r) => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}
                </LabeledSelect>
                <LabeledInput label="First Name" value={form.first_name} onChange={(e) => setForm((f) => ({ ...f, first_name: e.target.value }))} name="user_management_input_6004" />
                <LabeledInput label="Last Name" value={form.last_name} onChange={(e) => setForm((f) => ({ ...f, last_name: e.target.value }))} name="user_management_input_6005" />
                <LabeledSelect
                  label="Department"
                  value={String(form.department_id || "")}
                  onChange={(e) => {
                    const nextDepartmentId = e.target.value ? Number(e.target.value) : "";
                    setForm((f) => {
                      const nextDepartment = departmentMap[String(nextDepartmentId)] || null;
                      const keepCourse = courses.some(
                        (c) =>
                          Number(c.course_id) === Number(f.student.course_id) &&
                          Number(c.department_id) === Number(nextDepartmentId)
                      );
                      return {
                        ...f,
                        department_id: nextDepartmentId,
                        campus_id: nextDepartment?.campus_id ?? "",
                        student: keepCourse ? f.student : { ...f.student, course_id: "" },
                      };
                    });
                  }}
                  name="user_management_select_6006"
                  disabled={Boolean(departmentScope)}
                  hint={departmentScope ? "Scoped to your department." : undefined}
                >
                  <option value="">Select department</option>
                  {selectableDepartments.map((d) => <option key={d.department_id} value={d.department_id}>{d.department_name}</option>)}
                </LabeledSelect>
                {/* Campus is chosen, and it narrows the department list above.
                    The two can still never disagree: picking a department snaps
                    this to that department's campus, and changing the campus
                    clears a department that belongs to a different one. user.php
                    rejects a mismatched pair regardless. */}
                <LabeledSelect
                  label="Campus"
                  value={String(form.campus_id || "")}
                  onChange={(e) => {
                    const nextCampusId = e.target.value ? Number(e.target.value) : "";
                    setForm((f) => {
                      const currentDepartment = departmentMap[String(f.department_id || "")] || null;
                      const departmentFits =
                        !nextCampusId ||
                        !currentDepartment ||
                        Number(currentDepartment.campus_id) === Number(nextCampusId);
                      return {
                        ...f,
                        campus_id: nextCampusId,
                        department_id: departmentFits ? f.department_id : "",
                        student: departmentFits ? f.student : { ...f.student, course_id: "" },
                      };
                    });
                  }}
                  name="user_management_select_60065"
                  hint={departmentScope ? "Set by your department." : undefined}
                  disabled={Boolean(departmentScope)}
                >
                  <option value="">Select campus</option>
                  {campuses.map((c) => (
                    <option key={c.campus_id} value={c.campus_id}>{c.campus_name}</option>
                  ))}
                </LabeledSelect>
                {selectedUser?.user_id ? (
                  <LabeledSelect
                    label="Status"
                    value={String(Number(form.status) === 2 ? 2 : 1)}
                    onChange={(e) => setForm((f) => ({ ...f, status: Number(e.target.value) === 2 ? 2 : 1 }))}
                    name="user_management_select_6007"
                    disabled={editingProtectedAdmin}
                    hint={editingProtectedAdmin ? "The administrator account is always active. An inactive account cannot sign in." : undefined}
                  >
                    <option value="1">Active</option>
                    <option value="2">Inactive</option>
                  </LabeledSelect>
                ) : <div />}
                {/* New accounts take the server-generated temporary password,
                    the same path Student Management's importer uses. The field
                    stays on edit, where it is the admin's password-reset tool. */}
                {selectedUser?.user_id ? (
                  <div>
                    <LabeledInput label="New Password (optional)" type="password" value={form.password} onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))} name="user_management_input_6008" />
                    <PasswordRequirements value={form.password} showWhenEmpty={false} style={{ marginTop: 5 }} />
                  </div>
                ) : <div />}
              </div>

              {selectedUser?.user_id ? (
                <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                  Setting a user to Inactive moves the account to Archived Users.
                </span>
              ) : (
                <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                  A temporary password is generated for this account. The user signs in
                  by requesting a reset with "Forgot Password" on the login page.
                </span>
              )}

              {roleIsStudent && (
                <div style={{ border: "1px solid var(--border-base)", borderRadius: 8, padding: 9 }}>
                  <div style={{ marginBottom: 6, display: "flex", justifyContent: "space-between" }}>
                    <strong>Student Details</strong>
                    {studentLoading ? <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Loading...</span> : null}
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 153px), 1fr))", gap: 8 }}>
                    {selectedUser?.user_id ? <LabeledInput label="Student ID" value={form.student.student_id || ""} disabled name="user_management_input_6101" /> : null}
                    <LabeledInput label="Student Number" value={form.student.student_number} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, student_number: e.target.value } }))} name="user_management_input_6102" />
                    <LabeledSelect label={STUDENT_TYPE_LABEL} value={form.student.student_type} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, student_type: e.target.value } }))} name="user_management_select_61025">
                      {STUDENT_TYPES.map((type) => (
                        <option key={type} value={type}>{type}</option>
                      ))}
                    </LabeledSelect>
                    <LabeledInput label="Middle Name" value={form.student.middle_name} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, middle_name: e.target.value } }))} name="user_management_input_6103" />
                    <LabeledSelect label="Gender" value={form.student.gender} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, gender: e.target.value } }))} name="user_management_select_6104">
                      <option value="">Select gender</option>
                      {optionsWithCurrent(dropdownLists.genders, form.student.gender).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </LabeledSelect>
                    <LabeledSelect label="Modality" value={form.student.modality || getDropdownDefault("modalities") || ""} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, modality: e.target.value } }))} name="user_management_select_6106">
                      {optionsWithCurrent(dropdownLists.modalities, form.student.modality).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </LabeledSelect>
                    <LabeledInput label="Mobile Number" value={form.student.mobile_number} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, mobile_number: e.target.value } }))} name="user_management_input_6107" />
                    <LabeledSelect label="Course" value={String(form.student.course_id || "")} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, course_id: e.target.value } }))} name="user_management_select_6108">
                      <option value="">{form.department_id ? "Select course" : "Select department first"}</option>
                      {filteredCourses.map((c) => <option key={c.course_id} value={c.course_id}>{c.course_code ? `${c.course_code} - ${c.course_name}` : c.course_name}</option>)}
                    </LabeledSelect>
                    <LabeledInput label="Year Level" type="number" value={form.student.year_level} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, year_level: e.target.value } }))} name="user_management_input_6109" />
                    <LabeledSelect label="School Year" value={String(form.student.schoolyear_id || "")} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, schoolyear_id: e.target.value } }))} name="user_management_select_6110">
                      <option value="">Select school year</option>
                      {schoolYears.map((sy) => <option key={sy.school_year_id} value={sy.school_year_id}>{sy.schoolyear_name || `School Year ${sy.school_year_id}`}</option>)}
                    </LabeledSelect>
                    <LabeledInput label="Section" value={form.student.section} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, section: e.target.value } }))} name="user_management_input_6112" />
                    <LabeledSelect label="Final Scholarship Grant" value={form.student.final_scholarship_grant} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, final_scholarship_grant: e.target.value } }))} name="user_management_select_6114">
                      <option value="">Not recorded</option>
                      {optionsWithCurrent(dropdownLists.scholarship_grants, form.student.final_scholarship_grant).map((option) => (
                        <option key={option.value} value={option.value}>{option.label}</option>
                      ))}
                    </LabeledSelect>
                    <LabeledInput label="Mother's Number" value={form.student.mother_number} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, mother_number: e.target.value } }))} name="user_management_input_6115" />
                    <LabeledInput label="Father's Number" value={form.student.father_number} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, father_number: e.target.value } }))} name="user_management_input_6116" />
                    <LabeledInput label="Facebook Name" value={form.student.facebook_name} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, facebook_name: e.target.value } }))} name="user_management_input_6117" />
                    <div style={{ gridColumn: "1 / span 3" }}>
                      <label style={labelStyle} htmlFor="user_management_textarea_6118">Home Address</label>
                      <textarea id="user_management_textarea_6118" value={form.student.home_address} onChange={(e) => setForm((f) => ({ ...f, student: { ...f.student, home_address: e.target.value } }))} rows={3} style={{ ...inputStyle, boxSizing: "border-box" }} name="user_management_textarea_6118" />
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <Button onClick={save} disabled={saving || (!selectedUser?.user_id && !canCreate) || (selectedUser?.user_id && !canEdit)}>{saving ? "Saving..." : "Save"}</Button>
              <Button variant="secondary" onClick={() => setIsModalOpen(false)}>Close</Button>
            </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {isViewModalOpen ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            style={{ position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }}
            onClick={closeViewModal}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 765, maxHeight: "90vh", overflow: "auto", border: "1px solid var(--border-base)" }}
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
              <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div style={{ display: "grid", gap: 3 }}>
                  <strong style={{ color: "var(--text-primary)" }}>View User</strong>
                  <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                    {viewLoading ? "Refreshing user details..." : "Read-only account details"}
                  </span>
                </div>
                <Button variant="ghost" size="sm" onClick={closeViewModal} aria-label="Close user details">
                  <Icon name="close" size={15} />
                </Button>
              </div>

              <div style={{ padding: 12, display: "grid", gap: 9 }}>
                {viewError ? (
                  <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 6 }}>
                    {viewError}
                  </div>
                ) : null}

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                  <div style={{ display: "grid", gap: 3 }}>
                    <strong style={{ color: "var(--text-primary)", fontSize: 16 }}>{getUserDisplayName(viewUser)}</strong>
                    <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>{viewUser?.email || "-"}</span>
                  </div>
                  <span style={{ background: normalizeAccountStatus(viewUser?.status, viewUser?.status_name, viewUser?.status_type) === 1 ? "#d1fae5" : "#fee2e2", color: normalizeAccountStatus(viewUser?.status, viewUser?.status_name, viewUser?.status_type) === 1 ? "#065f46" : "#991b1b", borderRadius: 999, padding: "5px 8px", fontSize: 10.5, fontWeight: 700 }}>
                    {getUserStatusLabel(viewUser)}
                  </span>
                </div>

                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 153px), 1fr))", gap: 8 }}>
                  <ReadOnlyField label="Full Name" value={getUserDisplayName(viewUser)} />
                  <ReadOnlyField label="Username" value={viewUser?.username || viewUser?.email} />
                  <ReadOnlyField label="Email" value={viewUser?.email} />
                  <ReadOnlyField label="Phone Number" value={viewUser?.phone_number || viewUser?.mobile_number} />
                  <ReadOnlyField label="Role" value={viewUser?.role_name} />
                  <ReadOnlyField label="Status" value={getUserStatusLabel(viewUser)} />
                  <ReadOnlyField label="Department" value={viewUser?.department_name} />
                  <ReadOnlyField label="Date Created" value={formatDateTime(viewUser?.created_at)} />
                  <ReadOnlyField label="Last Updated" value={formatDateTime(viewUser?.updated_at)} />
                </div>
              </div>

              <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
                <Button variant="secondary" onClick={closeViewModal}>
                  Close
                </Button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {isArchiveModalOpen ? (
          <motion.div
            role="dialog"
            aria-modal="true"
            style={{ position: "fixed", inset: 0, background: "rgba(15, 23, 42, 0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }}
            onClick={() => setIsArchiveModalOpen(false)}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
          >
            <motion.div
              style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 833, maxHeight: "90vh", overflow: "auto", border: "1px solid var(--border-base)" }}
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, scale: 0.97 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
            >
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--text-primary)" }}>Archived Users</strong>
              <Button variant="ghost" size="sm" onClick={() => setIsArchiveModalOpen(false)} aria-label="Close archive list"><Icon name="close" size={15} /></Button>
            </div>

            <div style={{ padding: 12, display: "grid", gap: 9 }}>
              {archivedError ? (
                <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 6 }}>
                  {archivedError}
                </div>
              ) : null}

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6 }}>
                <InputControl
                  type="text"
                  placeholder="Search archived users..."
                  value={archivedSearch}
                  onChange={(e) => setArchivedSearch(e.target.value)}
                  style={{ minWidth: 221, maxWidth: 357, width: "100%" }}
                  name="user_management_input_6207"
                />
                <Button variant="secondary" onClick={loadArchivedUsers}>
                  <Icon name="archive" size={14} />
                  <span>Refresh</span>
                </Button>
              </div>

              <div style={{ overflow: "auto", maxHeight: "calc(90vh - 196px)" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                      <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>First Name</th>
                      <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Last Name</th>
                      <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Email</th>
                      <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Role</th>
                      <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Department</th>
                      <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {archivedLoading ? (
                      <tr><td colSpan={6} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>Loading archived users...</td></tr>
                    ) : filteredArchivedRows.length === 0 ? (
                      <tr><td colSpan={6} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>No archived users found</td></tr>
                    ) : filteredArchivedRows.map((u) => (
                      <tr key={u.user_id}>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.first_name || "-"}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.last_name || "-"}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.email || "-"}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.role_name || "-"}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.department_name || "-"}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                          <Button
                            size="sm"
                            onClick={() => restoreUser(u)}
                            disabled={!canRestore}
                            title={canRestore ? "Restore user" : "No permission to restore users"}
                            aria-label={`Restore ${userLabel(u)}`}
                          >
                            <Icon name="archiveRestore" size={13} />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <Button variant="secondary" onClick={() => setIsArchiveModalOpen(false)}>Close</Button>
            </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <div style={{ background: "#fff", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 3, background: "#fff", padding: 9, borderBottom: "1px solid var(--border-base)", display: "grid", gap: 8 }}>
          <strong style={{ color: "var(--text-primary)" }}>All Users</strong>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
            <InputControl
              type="text"
              placeholder="Search name or email..."
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              style={{ flex: "1 1 320px", minWidth: 187, maxWidth: "100%" }}
              name="user_management_input_6201"
            />
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
              <Button
                variant="secondary"
                className="ui-archive-button"
                onClick={openArchivePanel}
                disabled={!canArchive && !canRestore}
                title="Archived users"
                aria-label="Open archived users"
              >
                <Icon name="archive" size={14} />
                <span>Archived Users</span>
              </Button>
              <Button
                onClick={() => { if (!canCreate) { notifyError("Not allowed", "Your account cannot add users. Ask an administrator to create this account."); return; } setSelectedUser({}); setForm(defaultForm(departmentScope)); setStudentLoading(false); setIsModalOpen(true); }}
                disabled={!canCreate}
              >
                <Icon name="plus" size={14} />
                <span>Add User</span>
              </Button>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", flex: "1 1 560px" }}>
              <SelectControl value={String(roleFilter)} onChange={(e) => { setPage(1); setRoleFilter(e.target.value); }} style={{ minWidth: 136, flex: "1 1 160px", fontSize: 11.5, padding: "5px 6px" }} name="user_management_select_6202"><option value="">All roles</option>{roles.map((r) => <option key={r.role_id} value={r.role_id}>{r.role_name}</option>)}</SelectControl>
              <SelectControl value={String(departmentFilter)} onChange={(e) => { setPage(1); setDepartmentFilter(e.target.value); }} style={{ minWidth: 145, flex: "1 1 170px", fontSize: 11.5, padding: "5px 6px" }} name="user_management_select_6203"><option value="">All departments</option>{departments.map((d) => <option key={d.department_id} value={d.department_id}>{d.department_name}</option>)}</SelectControl>
              <SelectControl value={String(campusFilter)} onChange={(e) => { setPage(1); setCampusFilter(e.target.value); }} style={{ minWidth: 136, flex: "1 1 160px", fontSize: 11.5, padding: "5px 6px" }} name="user_management_select_6204"><option value="">All campuses</option>{campuses.map((c) => <option key={c.campus_id} value={c.campus_id}>{c.campus_name}</option>)}</SelectControl>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", flexWrap: "wrap" }}>
              {/* Rows-per-page lives with the pager under the table, not here. */}
              <Button variant="secondary" onClick={resetFilters} disabled={!hasActiveFilters}>
                Reset Filters
              </Button>
            </div>
          </div>
        </div>

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 221px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>No.</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>First Name</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Last Name</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Email</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Role</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Department</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Campus</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Status</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? <SkeletonTableRows columns={9} /> : rows.length === 0 ? <tr><td colSpan={9} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>No users found</td></tr> : rows.map((u, idx) => {
                const isActive = normalizeAccountStatus(u?.status, u?.status_name, u?.status_type) === 1;
                const isUpdatingStatus = Number(statusUpdatingId) === Number(u.user_id);
                const isProtectedAdmin = isProtectedAdminRow(u);
                return (
                  <tr key={u.user_id}>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{(page - 1) * limit + idx + 1}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.first_name}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.last_name}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.email}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.role_name || "-"}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.department_name || "-"}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{u.campus_name || "-"}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                      {isProtectedAdmin ? (
                        /* Plain text, not a disabled button. A greyed-out
                           control reads as "you lack permission" and invites
                           somebody to go hunting for the permission that would
                           enable it; there isn't one, so the status simply is
                           not a control here. */
                        <span
                          style={{ color: "var(--brand-600)", fontWeight: 600, display: "inline-flex", alignItems: "center", gap: 5 }}
                          title="The administrator account cannot be set inactive — it is the only account that can reach Access Management and Settings."
                        >
                          Active
                          <Icon name="lock" size={11} />
                        </span>
                      ) : (
                      <button
                        type="button"
                        onClick={() => toggleUserStatus(u)}
                        disabled={isUpdatingStatus || !canEdit}
                        style={{
                          background: "transparent",
                          border: "none",
                          padding: 0,
                          margin: 0,
                          color: isActive ? "var(--brand-600)" : "var(--danger-600)",
                          fontWeight: 600,
                          textDecoration: "underline",
                          textUnderlineOffset: 2,
                          cursor: isUpdatingStatus || !canEdit ? "not-allowed" : "pointer",
                          opacity: canEdit ? 1 : 0.65,
                        }}
                        title={canEdit ? (isUpdatingStatus ? "Updating status..." : (isActive ? "Set as Inactive and move to Archived Users" : "Set as Active")) : "No permission to update user status"}
                        aria-label={`Set ${userLabel(u)} as ${isActive ? "Inactive and move to Archived Users" : "Active"}`}
                      >
                        {isUpdatingStatus ? "Updating..." : isActive ? "Active" : "Inactive"}
                      </button>
                      )}
                    </td>
                    {/*
                      One kebab, the same as every other management table.

                      This was two icon buttons side by side in a <td> that had
                      been given `display: flex` — which takes the cell out of
                      the table's layout algorithm, so the column stopped
                      sizing with its header and the row lost its shared
                      baseline. The menu needs no such trick, and it also has
                      somewhere to put Archive and Restore, which previously
                      had no home in this column at all: archived users were
                      reachable only through a separate dialog.
                    */}
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                      <ActionMenu
                        label={`Actions for ${userLabel(u)}`}
                        items={[
                          { key: "view", label: "View user", icon: "eye", onSelect: () => openView(u) },
                          ...(canEdit
                            ? [{ key: "edit", label: "Edit user", icon: "edit", onSelect: () => openEdit(u) }]
                            : []),
                          /*
                           * Archiving is the same server call as setting the
                           * status to Inactive, which is why it reads as
                           * "Archive" here and moves the row to Archived Users.
                           *
                           * Never offered on the administrator. user.php's
                           * user_guard_admin() refuses to archive, re-role or
                           * delete that account — it is the only one that can
                           * reach Access Management and Settings, so taking it
                           * out of service would lock the system with no way
                           * back in. The server is the real guard; omitting the
                           * item here just stops the menu offering a click that
                           * can only ever come back as an error. The Edit
                           * dialog already takes the same line, disabling the
                           * status and role fields with a note saying why.
                           */
                          ...(canArchive && isActive && !isProtectedAdminRow(u)
                            ? [{
                                key: "archive",
                                label: "Archive user",
                                icon: "archive",
                                tone: "danger",
                                onSelect: () => void toggleUserStatus(u),
                              }]
                            : []),
                          ...(canEdit && !isActive && !isProtectedAdminRow(u)
                            ? [{
                                key: "activate",
                                label: "Set as Active",
                                icon: "archiveRestore",
                                tone: "brand",
                                onSelect: () => void toggleUserStatus(u),
                              }]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ padding: 9, borderTop: "1px solid var(--border-base)" }}>
          <ManagementPagination
            page={page}
            limit={limit}
            total={total}
            onPageChange={setPage}
            onLimitChange={(size) => {
              setLimit(size);
              setPage(1);
            }}
            itemLabel="users"
          />
        </div>
      </div>
    </section>
  );
}
