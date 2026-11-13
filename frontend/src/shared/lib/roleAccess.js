import { getRoleLabel, normalizeRoleSlug } from "./roles";
import {
  getDefaultRolePermissionMap,
  getFixedModuleGroups,
  getFixedModules,
  getModuleAccessLevel,
  getModulePermissionActions,
  isPermissionMapEmpty,
  normalizePermissionMap,
} from "./permissions";

/**
 * Access levels read as an escalation ladder, not six arbitrary colours:
 * grey (none) -> pale green -> green (read/use, safe) -> pale amber -> amber
 * (write, take care) -> red (full control).
 *
 * These used to be six unrelated hues (slate, blue, green, amber, violet, red).
 * Collapsing decoration onto the brand green would have made view / use /
 * limited_edit near-identical, so the safe levels are separated by intensity
 * and the write levels shift to the warning family instead.
 */
export const MODULE_ACCESS_LEVELS = {
  none: {
    label: "No Access",
    helper: "This role cannot open or use this module.",
    background: "#f8fafc",
    color: "#64748b",
    borderColor: "#cbd5e1",
  },
  view: {
    label: "View Only",
    helper: "This role can open the module and review available data.",
    background: "#ecfdf5",
    color: "#047857",
    borderColor: "#a7f3d0",
  },
  use: {
    label: "View and Use",
    helper: "This role can use the module workflow without broad record editing rights.",
    background: "#d1fae5",
    color: "#065f46",
    borderColor: "#6ee7b7",
  },
  limited_edit: {
    label: "Limited Edit",
    helper: "This role can update parts of the workflow without full control.",
    background: "#fffbeb",
    color: "#b45309",
    borderColor: "#fde68a",
  },
  edit: {
    label: "Can Edit",
    helper: "This role can create and update records inside the module.",
    background: "#fef3c7",
    color: "#92400e",
    borderColor: "#fcd34d",
  },
  manage: {
    label: "Full Management",
    helper: "This role can fully manage records and settings for this module.",
    background: "#fee2e2",
    color: "#991b1b",
    borderColor: "#fecaca",
  },
};

const ROLE_PROFILE_DEFINITIONS = {
  admin: {
    title: "Admin",
    accessType: "custom",
    note: "Administrative users can access management, survey, analytics, and system settings modules.",
  },
  ssg: {
    title: "SSG",
    accessType: "shared",
    note: "SSG and Secretary roles share the same survey management dashboard.",
  },
  student: {
    title: "Student",
    accessType: "custom",
    note: "Students can open their overview and answer survey modules.",
  },
  finance: {
    title: "Finance",
    accessType: "custom",
    note: "Finance users can review the finance dashboard and manage finance records.",
  },
  dean: {
    title: "Dean",
    accessType: "custom",
    note: "Dean access is focused on overview data and department student management.",
  },
  "program-head": {
    title: "Program Head",
    accessType: "shared",
    note: "Program Heads assist their Dean and hold the same modules, pinned to the same department.",
  },
  "ssp-coordinator": {
    title: "SSP Coordinator",
    accessType: "custom",
    note: "SSP Coordinators assign follow-up work and manage the enrollment queue.",
  },
  "ssp-caller": {
    title: "SSP Caller",
    accessType: "custom",
    note: "SSP Callers review assigned tasks and use the shared contact workspace for their assigned students.",
  },
  "dept-caller": {
    title: "Department Caller",
    accessType: "custom",
    note: "Department Callers record student contact attempts and monitor cases that may escalate for home visits.",
  },
  faculty: {
    title: "Faculty",
    accessType: "custom",
    note: "Faculty work the intervention workspace for their own department, and see only the students in it.",
  },
  csdl: {
    title: "CSDL",
    accessType: "custom",
    note: "Role 8 users manage the home visit workspace for students escalated from the contact workflow.",
  },
};

const FALLBACK_ROLE_SLUGS = [
  "admin",
  "ssg",
  "student",
  "finance",
  "dean",
  "program-head",
  "dept-caller",
  "ssp-coordinator",
  "ssp-caller",
  "ksh-tl",
  "csdl",
  "ksh-coach",
  "faculty",
];

function cloneGroups(groups = []) {
  return groups.map((group) => ({
    ...group,
    modules: Array.isArray(group.modules)
      ? group.modules.map((module) => ({ ...module, actions: [...(module.actions || [])] }))
      : [],
  }));
}

export function flattenModuleGroups(groups = []) {
  return groups.flatMap((group) =>
    (group.modules || []).map((module, index) => ({
      ...module,
      id: `${group.key}:${module.view}:${index}`,
      groupKey: group.key,
      groupLabel: group.label,
      groupColor: group.color,
    }))
  );
}

export function getModuleAccessMeta(access) {
  return MODULE_ACCESS_LEVELS[access] || MODULE_ACCESS_LEVELS.view;
}

export function getRoleAccessDefinition(roleLike) {
  const roleName = typeof roleLike === "string" ? roleLike : roleLike?.role_name;
  const explicitSlug = typeof roleLike === "object" && roleLike ? roleLike.role_slug : "";
  const slug = normalizeRoleSlug(explicitSlug || roleName);
  const profile = ROLE_PROFILE_DEFINITIONS[slug] || {
    title: getRoleLabel(typeof roleLike === "object" ? roleLike : null, slug),
    accessType: "generic",
    note: "This role currently uses the standard generic dashboard layout until permissions are configured.",
  };
  const groups = cloneGroups(getFixedModuleGroups());
  const modules = flattenModuleGroups(groups);

  return {
    slug: slug || "role",
    title: profile.title || getRoleLabel(typeof roleLike === "object" ? roleLike : null, slug),
    accessType: profile.accessType || "generic",
    note: profile.note || "",
    groups,
    modules,
    moduleCount: modules.length,
  };
}

function resolveEffectivePermissionMap(roleLike, explicitPermissions = {}, useRoleDefaults) {
  const normalizedExplicit = normalizePermissionMap(explicitPermissions);
  const shouldUseRoleDefaults = useRoleDefaults ?? !Boolean(roleLike?.permissions_configured);

  if (shouldUseRoleDefaults && isPermissionMapEmpty(normalizedExplicit)) {
    return getDefaultRolePermissionMap(roleLike);
  }

  return normalizedExplicit;
}

export function buildRoleAccessEntry(role) {
  const definition = getRoleAccessDefinition(role);
  const roleName = String(role?.role_name || "").trim() || definition.title;
  const description = String(role?.description || "").trim();
  const roleId = role?.role_id ?? null;
  const key = roleId != null && roleId !== ""
    ? `role-${roleId}`
    : `slug-${definition.slug}-${normalizeRoleSlug(roleName) || "role"}`;
  const presetPermissions = resolveEffectivePermissionMap(role, role?.module_permissions || role?.permissions || {}, undefined);
  const presetSummary = Object.entries(presetPermissions).map(([moduleKey, actions]) => ({
    module_key: moduleKey,
    actions: Array.isArray(actions) ? actions.filter((action) => action !== "manage") : [],
  }));
  const fallbackModuleCount = presetSummary.length;
  const fallbackActionCount = presetSummary.reduce((total, module) => total + module.actions.length, 0);
  const permissionsConfigured = Boolean(role?.permissions_configured);
  const moduleCount = permissionsConfigured
    ? Number(role?.enabled_module_count ?? fallbackModuleCount)
    : fallbackModuleCount;
  const enabledActionCount = permissionsConfigured
    ? Number(role?.enabled_action_count ?? fallbackActionCount)
    : fallbackActionCount;
  const userCount = Number(role?.user_count || 0);
  const assignedUsers = Array.isArray(role?.assigned_users)
    ? role.assigned_users
    : (Array.isArray(role?.assigned_users_preview) ? role.assigned_users_preview : []);
  const accessibleModules = Array.isArray(role?.accessible_modules) && role.accessible_modules.length > 0
    ? role.accessible_modules
    : presetSummary.map((module) => ({
        module_key: module.module_key,
        actions: [...module.actions],
        granted_actions: [...module.actions],
        action_count: module.actions.length,
      }));

  return {
    key,
    roleId,
    roleName,
    description,
    slug: definition.slug,
    dashboardTitle: definition.title,
    accessType: definition.accessType,
    note: definition.note,
    groups: definition.groups,
    modules: definition.modules,
    moduleCount,
    enabledActionCount,
    userCount,
    assignedUsers,
    customUserCount: Number(role?.custom_user_count || 0),
    permissionsConfigured,
    accessibleModules,
  };
}

export function compareRoleAccessEntries(a, b) {
  return String(a?.roleName || "").localeCompare(String(b?.roleName || ""), undefined, { sensitivity: "base" });
}

export function getFallbackRoleAccessEntries() {
  return FALLBACK_ROLE_SLUGS.map((slug) =>
    buildRoleAccessEntry({
      role_slug: slug,
      role_name: getRoleLabel(null, slug),
    })
  ).sort(compareRoleAccessEntries);
}

export function buildRolePermissionMatrix(roleLike, explicitPermissions = {}, { includeInactive = true, useRoleDefaults } = {}) {
  const effectivePermissions = resolveEffectivePermissionMap(roleLike, explicitPermissions, useRoleDefaults);
  const moduleCatalog = getFixedModules();

  return moduleCatalog
    .map((catalogModule) => {
      const actions = getModulePermissionActions(effectivePermissions, catalogModule.key);
      const enabled = actions.length > 0;
      const access = getModuleAccessLevel(actions);

      return {
        ...catalogModule,
        id: `${catalogModule.groupKey}:${catalogModule.view}`,
        isDefault: enabled && useRoleDefaults !== false && isPermissionMapEmpty(explicitPermissions),
        isOverride: !isPermissionMapEmpty(explicitPermissions),
        permissions: actions,
        enabled,
        access,
      };
    })
    .filter((module) => includeInactive || module.enabled);
}

export function buildAccessibleRoleModules(roleLike, explicitPermissions = {}, { useRoleDefaults } = {}) {
  return buildRolePermissionMatrix(roleLike, explicitPermissions, {
    includeInactive: true,
    useRoleDefaults,
  }).filter((module) => module.permissions.includes("view"));
}

function normalizeActionList(permissionState = []) {
  if (Array.isArray(permissionState)) {
    return permissionState.map((action) => String(action || "").trim().toLowerCase());
  }

  if (permissionState && typeof permissionState === "object") {
    const looksLegacy =
      "can_view" in permissionState ||
      "can_create" in permissionState ||
      "can_edit" in permissionState ||
      "can_delete" in permissionState ||
      "can_manage" in permissionState;

    if (looksLegacy) {
      const actions = [];
      if (permissionState.can_manage) actions.push("manage");
      if (permissionState.can_view) actions.push("view");
      if (permissionState.can_create) actions.push("create");
      if (permissionState.can_edit) actions.push("edit");
      if (permissionState.can_delete) actions.push("delete");
      if (permissionState.can_archive) actions.push("archive");
      if (permissionState.can_restore) actions.push("restore");
      if (permissionState.can_import) actions.push("import");
      if (permissionState.can_export) actions.push("export");
      if (permissionState.can_answer) actions.push("answer");
      if (permissionState.can_analyze) actions.push("analyze");
      if (permissionState.can_assign) actions.push("assign");
      return actions;
    }
  }

  return [];
}

export function canModuleAction(permissionState = [], action) {
  const normalizedAction = String(action || "view").trim().toLowerCase();
  const actions = normalizeActionList(permissionState);

  if (actions.includes("manage")) return true;
  if (normalizedAction === "view") {
    return actions.includes("view");
  }

  return actions.includes(normalizedAction);
}

/**
 * canModuleAction, except that an empty permission list opens everything.
 *
 * Six pages had each written this same four-line wrapper locally — Attendance,
 * Grades, and the four Survey screens — which is five more copies than the
 * behaviour deserves.
 *
 * The empty-list case is the point of it. A page reached outside the granted-
 * modules shell is handed no `permissions` prop at all: a role dashboard that
 * renders it directly, or a test that mounts it bare. Treating "no list" as "no
 * rights" would blank those screens, so an absent list means the caller is not
 * scoping by module and the endpoint stays the real guard. An empty list is not
 * the same as a list that granted nothing — that one is still a refusal, and
 * still arrives here as a non-empty array.
 */
export function hasModulePermission(permissions, action) {
  if (!Array.isArray(permissions) || permissions.length === 0) {
    return true;
  }
  return canModuleAction(permissions, action);
}
