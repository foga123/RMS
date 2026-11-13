const ROLE_ID_SLUGS = {
  1: "admin",
  2: "ssg",
  3: "dean",
  4: "dept-caller",
  5: "ssp-coordinator",
  6: "ssp-caller",
  7: "ksh-tl",
  8: "csdl",
  9: "ssg",
  10: "finance",
  // 11 was "registrar" -- role deleted 2026-07-26. Left unmapped on purpose so a
  // future role reusing id 11 cannot inherit registrar access.
  12: "ksh-coach",
  13: "student",
  // The dean's assistant: same modules, same department pinning. The pinning
  // itself is enforced server-side (API_DEPARTMENT_PINNED_ROLES in
  // middleware/auth.php) — this map only decides which dashboard renders.
  14: "program-head",
  // The intervention workspace for one department. Which students appear in it
  // is decided server-side — student_contact_visibility_clause() plus
  // API_DEPARTMENT_PINNED_ROLES — so this map only picks the dashboard.
  15: "faculty",
};

const ROLE_SLUG_ALIASES = {
  administrator: "admin",
  "system-admin": "admin",
  secretary: "ssg",
  "student-supreme-government": "ssg",
  "student-government": "ssg",
  deptcaller: "dept-caller",
  "department-caller": "dept-caller",
  departmentcaller: "dept-caller",
};

export function normalizeRoleName(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

export function slugifyRole(value) {
  const normalized = normalizeRoleName(value);
  if (!normalized) return "";
  return normalized
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function normalizeRoleSlug(value) {
  const slug = slugifyRole(value);
  if (!slug) return "";
  return ROLE_SLUG_ALIASES[slug] || slug;
}

export function getRoleSlug(user) {
  if (!user) return "";
  const roleId = Number(user.role_id);
  if (ROLE_ID_SLUGS[roleId]) return ROLE_ID_SLUGS[roleId];
  const slugFromName = normalizeRoleSlug(user.role_name);
  if (slugFromName) return slugFromName;
  if (Number.isFinite(roleId) && roleId > 0) return `role-${roleId}`;
  return "role";
}

export function getDashboardPathForUser(user) {
  const slug = getRoleSlug(user);
  return slug ? `/dashboard/${slug}` : "/dashboard";
}

export function getRoleLabel(user, roleSlug) {
  const name = String(user?.role_name || "").trim();
  if (name) return name;
  const slug = normalizeRoleSlug(roleSlug);
  if (!slug) return "Role";
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
