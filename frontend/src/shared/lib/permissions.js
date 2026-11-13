import { normalizeRoleSlug } from "./roles";
import { MODULE_REGISTRY, MODULE_GROUPS, MODULE_KEY_ALIASES } from "../../app/moduleRegistry";
import { getGroupAccent } from "../theme/tokens";

const ACTION_META = {
  view: { label: "View", helper: "Open the module and read available records." },
  create: { label: "Add", helper: "Add new records in this module." },
  edit: { label: "Edit", helper: "Update existing records in this module." },
  delete: { label: "Delete", helper: "Remove records in this module." },
  archive: { label: "Archive", helper: "Move records into archive without permanently deleting them." },
  restore: { label: "Restore", helper: "Restore archived records back into active use." },
  manage: { label: "Full Access", helper: "Grant full control for this module." },
  import: { label: "Import", helper: "Import bulk records into this module." },
  export: { label: "Export", helper: "Export records from this module." },
  answer: { label: "Answer", helper: "Submit answers or complete the workflow." },
  analyze: { label: "Analyze", helper: "Open analytics, summaries, or reports." },
  assign: { label: "Assign", helper: "Assign work, owners, or interventions." },
  intervene: { label: "Intervene", helper: "Record what was done about a case, without approving it." },
};

/*
 * The actions the Role-Based Access matrix may offer as checkboxes.
 *
 * This is NOT "every action that exists" — it is every action the RBAC schema
 * can actually store, and the two are not the same list. `intervene` is the
 * case in point: it is a real action, the backend grants it to faculty through
 * api_default_role_permission_presets() and api_can() enforces it, but there is
 * no rbac_action row for it, so api_rbac_action_keys_for_app_action() resolves
 * it to nothing.
 *
 * api_store_role_permissions_map() refuses a save whose non-storable action set
 * differs from the one on record, so listing `intervene` here would draw a
 * checkbox whose every toggle throws InvalidArgumentException and fails the
 * whole save. It stays out until the catalogue has a row for it.
 *
 * `manage` is absent for a different reason: it is a shorthand that expands to
 * the module's whole action list, not something to tick on its own.
 */
export const ACCESS_MANAGEMENT_PERMISSION_ACTIONS = [
  "view",
  "create",
  "edit",
  "delete",
  "archive",
  "restore",
  "export",
  "import",
  "answer",
  "analyze",
  "assign",
];

function normalizePermissionModuleKey(value) {
  const token = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]+/g, "");

  if (!token) return "";
  return MODULE_KEY_ALIASES[token] || token;
}

/**
 * The permission matrix catalogue, derived from the module registry so the two
 * cannot disagree. Shape is unchanged for existing consumers: `view` mirrors
 * `key` because the dashboard router keys its routes off `view`.
 */
export const FIXED_PERMISSION_MODULES = MODULE_REGISTRY.map((module) => ({
  key: module.key,
  view: module.key,
  label: module.label,
  groupKey: module.group,
  groupLabel: MODULE_GROUPS[module.group]?.label || module.group,
  groupColor: getGroupAccent(module.group),
  description: module.description || "",
  actions: [...module.actions],
}));

const MODULE_BY_KEY = new Map(FIXED_PERMISSION_MODULES.map((module) => [module.key, module]));

function allActionsFor(moduleKey) {
  return (MODULE_BY_KEY.get(moduleKey)?.actions || []).filter((action) => action !== "manage");
}

export const DEFAULT_ROLE_PERMISSION_PRESETS = {
  admin: {
    overview: ["view"],
    student_migration: ["view", "analyze"],
    finance_management: ["view", "create", "edit", "delete", "export"],
    users: ["manage"],
    student_manage: ["view", "create", "edit", "delete", "archive", "restore", "import", "export"],
    attendance_management: ["view", "export", "analyze", "import"],
    departments: ["manage"],
    roles: ["manage"],
    courses: ["manage"],
    grades: ["view", "create", "edit", "delete", "archive", "restore", "export"],
    remarks: ["manage"],
    statuses: ["manage"],
    campuses: ["manage"],
    enrollment_status: ["manage"],
    survey: ["view", "create", "edit", "delete", "answer"],
    survey_questions: ["manage"],
    survey_responses: ["view", "create", "edit", "delete", "analyze"],
    survey_submissions: ["view", "create", "delete", "analyze"],
    reports: ["view", "analyze"],
    retention_cases: ["view", "create", "edit", "delete", "assign", "analyze"],
    home_visits: ["view", "edit", "assign", "analyze"],
    dropdown_lists: ["view", "create", "edit", "archive", "restore"],
    settings: ["view", "edit", "manage"],
  },
  ssg: {
    overview: ["view"],
    student_manage: ["view", "create", "edit", "import", "export"],
    grades: ["view", "create", "edit", "archive", "restore", "export"],
    survey: ["view", "create", "edit", "delete"],
    survey_questions: ["manage"],
    survey_responses: ["view", "create", "edit", "analyze"],
    survey_submissions: ["view", "delete", "analyze"],
    reports: ["view", "analyze"],
    retention_cases: ["view", "edit", "assign", "analyze"],
  },
  secretary: {
    overview: ["view"],
    student_manage: ["view", "export"],
    grades: ["view", "export"],
    survey: ["view", "edit"],
    survey_questions: ["view"],
    survey_responses: ["view", "analyze"],
    survey_submissions: ["view", "analyze"],
    reports: ["view", "analyze"],
    retention_cases: ["view"],
  },
  student: {
    overview: ["view"],
    survey: ["view", "answer"],
    survey_questions: ["view"],
    survey_submissions: ["view", "create"],
  },
  finance: {
    dashboard: ["view"],
    finance_management: ["view", "edit", "export"],
    reports: ["view", "analyze"],
  },
  dean: {
    overview: ["view"],
    student_manage: ["view", "create", "edit", "delete", "import", "export"],
    retention_cases: ["view", "edit", "assign", "analyze"],
    reports: ["view", "analyze"],
  },
  // Mirrors the backend's 'program-head' entry in api_get_default_role_permissions_map().
  // Spelled out rather than aliased for the same reason it is there: narrowing
  // one role later must not silently narrow the other.
  "program-head": {
    overview: ["view"],
    student_manage: ["view", "create", "edit", "delete", "import", "export"],
    retention_cases: ["view", "edit", "assign", "analyze"],
    reports: ["view", "analyze"],
  },
  "ssp-coordinator": {
    overview: ["view"],
    assignments: ["view", "create", "edit", "delete", "assign"],
    // Mirrors the backend preset in auth.php. team_monitor.php decides which
    // team the board shows from the acting role, so the same grant means the
    // SSP Callers here and the KASAMA workers under "ksh-tl" below.
    team_monitor: ["view", "analyze"],
    student_contacts: ["view", "create", "edit", "analyze"],
    // No retention_cases or student_migration since 2026-09-30; see the
    // backend preset for why.
    reports: ["view", "analyze"],
  },
  "ssp-caller": {
    overview: ["view"],
    assignments: ["view"],
    student_contacts: ["view", "create", "edit", "analyze"],
    retention_cases: ["view", "edit"],
    enrollment_status: ["view", "edit"],
    student_migration: ["view", "analyze"],
    reports: ["view", "analyze"],
  },
  "dept-caller": {
    overview: ["view"],
    student_contacts: ["view", "create", "edit", "analyze"],
    reports: ["view", "analyze"],
  },
  /*
   * Mirrors the backend's 'faculty' entry in api_default_role_permission_presets().
   * The department scope is not expressed here — it is a WHERE clause on the
   * server, not a permission.
   *
   * No `student_contacts` since 2026-09-04. That is the CALLER's workspace, and
   * the callers work a different clock: they ring students at the end of a
   * semester about whether they are coming back, while faculty work P1 and P2
   * inside the term. faculty_workspace replaced it, per periodical.
   *
   * No `retention_cases` either: that board is labelled Intervention in the
   * sidebar, and faculty now use Faculty Workspace as the single queue for
   * seeing risk signals and recording contacts.
   *
   * Keeping this in step with the server matters more than it looks: this map
   * pre-fills the Access Management grid for a role with no saved rows, so a
   * stale entry here shows an admin a default that is not the real one — and the
   * moment they press Save it becomes real, as saved rows beat presets.
   */
  faculty: {
    overview: ["view"],
    reports: ["view", "analyze"],
    faculty_workspace: ["view", "create", "analyze"],
  },
  /*
   * The Kasama Hub pair mirrors the SSP pair, matching the backend presets:
   * 'star' => [12, 7] against 'nonstar' => [6, 5], supervisor second in both.
   *
   * Note what these two used to carry — `workspace`, which is not a module in the
   * catalog and therefore granted nothing. The whole Star side of the follow-up
   * workflow had a queue it could not open.
   */
  "ksh-tl": {
    overview: ["view"],
    assignments: ["view", "create", "edit", "delete", "assign"],
    team_monitor: ["view", "analyze"],
    student_contacts: ["view", "create", "edit", "analyze"],
    // No retention_cases or student_migration since 2026-10-01, the same as
    // "ssp-coordinator".
    enrollment_status: ["view", "edit"],
    reports: ["view", "analyze"],
  },
  csdl: {
    overview: ["view"],
    home_visits: ["view", "edit", "assign", "analyze"],
    reports: ["view", "analyze"],
  },
  // KSH Coach mirrors the SSP Caller; see the note on "ksh-tl" above.
  "ksh-coach": {
    overview: ["view"],
    assignments: ["view"],
    student_contacts: ["view", "create", "edit", "analyze"],
    retention_cases: ["view", "edit"],
    enrollment_status: ["view", "edit"],
    student_migration: ["view", "analyze"],
    reports: ["view", "analyze"],
  },
};

function normalizeActionToken(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "");
}

function uniqueActionList(actions = [], allowedActions = []) {
  const allowed = new Set(allowedActions);
  const seen = new Set();
  const list = [];

  actions.forEach((action) => {
    const normalized = normalizeActionToken(action);
    if (!normalized || !allowed.has(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    list.push(normalized);
  });

  return list;
}

export function getPermissionActionMeta(action) {
  return ACTION_META[normalizeActionToken(action)] || {
    label: String(action || "Action"),
    helper: "Control access for this action.",
  };
}

export function getPermissionModule(moduleKey) {
  return MODULE_BY_KEY.get(normalizePermissionModuleKey(moduleKey)) || null;
}

export function getFixedModules() {
  return FIXED_PERMISSION_MODULES.map((module) => ({
    ...module,
    actions: [...module.actions],
  }));
}

export function getFixedModuleGroups() {
  const groups = new Map();

  FIXED_PERMISSION_MODULES.forEach((module) => {
    if (!groups.has(module.groupKey)) {
      groups.set(module.groupKey, {
        key: module.groupKey,
        label: module.groupLabel,
        color: module.groupColor,
        modules: [],
      });
    }

    groups.get(module.groupKey).modules.push({
      view: module.view,
      label: module.label,
      description: module.description,
      actions: [...module.actions],
    });
  });

  return Array.from(groups.values()).map((group) => ({
    ...group,
    modules: group.modules.map((module) => ({ ...module, actions: [...module.actions] })),
  }));
}

export function normalizePermissionMap(input = {}) {
  if (Array.isArray(input)) {
    return input.reduce((acc, row) => {
      const moduleKey = normalizePermissionModuleKey(row?.module_key || row?.moduleKey || row?.view);
      const module = getPermissionModule(moduleKey);
      if (!module) return acc;

      const nextActions = Array.isArray(row?.granted_actions)
        ? [...row.granted_actions]
        : (Array.isArray(row?.actions) ? [...row.actions] : []);

      if (row?.can_manage) nextActions.push("manage");
      if (row?.can_view) nextActions.push("view");
      if (row?.can_create) nextActions.push("create");
      if (row?.can_edit) nextActions.push("edit");
      if (row?.can_delete) nextActions.push("delete");
      if (row?.can_archive) nextActions.push("archive");
      if (row?.can_restore) nextActions.push("restore");
      if (row?.can_import) nextActions.push("import");
      if (row?.can_export) nextActions.push("export");
      if (row?.can_answer) nextActions.push("answer");
      if (row?.can_analyze) nextActions.push("analyze");
      if (row?.can_assign) nextActions.push("assign");

      const normalized = uniqueActionList(nextActions, module.actions);
      if (normalized.includes("manage")) {
        acc[module.key] = uniqueActionList(["manage", ...allActionsFor(module.key)], module.actions);
      } else if (normalized.length > 0) {
        acc[module.key] = normalized;
      }

      return acc;
    }, {});
  }

  if (!input || typeof input !== "object") {
    return {};
  }

  return Object.entries(input).reduce((acc, [moduleKey, actions]) => {
    const normalizedModuleKey = normalizePermissionModuleKey(moduleKey);
    const module = getPermissionModule(normalizedModuleKey);
    if (!module) return acc;

    const normalized = uniqueActionList(Array.isArray(actions) ? actions : [], module.actions);
    if (normalized.includes("manage")) {
      acc[module.key] = uniqueActionList(["manage", ...allActionsFor(module.key)], module.actions);
    } else if (normalized.length > 0) {
      acc[module.key] = normalized;
    }

    return acc;
  }, {});
}

export function isPermissionMapEmpty(permissionMap) {
  return Object.keys(normalizePermissionMap(permissionMap)).length === 0;
}

export function getDefaultRolePermissionMap(roleLike) {
  // Secretary (role 9) mirrors SSG's access — both normalise to the "ssg" slug,
  // so the shared preset now covers both. Mirrors the backend in
  // api_get_default_role_permissions_map(); the difference between the two roles
  // is the notification on Secretary edits, not what they may do. The reduced
  // "secretary" preset is kept for reference but no longer applied.
  const presetKey = typeof roleLike === "string" ? roleLike : roleLike?.role_slug || roleLike?.role_name;
  const slug = normalizeRoleSlug(presetKey);
  return normalizePermissionMap(DEFAULT_ROLE_PERMISSION_PRESETS[slug] || {});
}

export function getModulePermissionActions(permissionMap, moduleKey) {
  const normalized = normalizePermissionMap(permissionMap);
  return [...(normalized[normalizePermissionModuleKey(moduleKey)] || [])];
}

export function getAccessManagementPermissionActions(moduleOrKey) {
  const module = typeof moduleOrKey === "object" && moduleOrKey
    ? moduleOrKey
    : getPermissionModule(moduleOrKey);
  const moduleActions = Array.isArray(module?.actions) ? module.actions : [];
  return ACCESS_MANAGEMENT_PERMISSION_ACTIONS.filter((action) => moduleActions.includes(action));
}

export function sanitizeAccessManagementPermissionMap(permissionMap = {}) {
  const normalized = normalizePermissionMap(permissionMap);

  return Object.entries(normalized).reduce((acc, [moduleKey, actions]) => {
    const allowedActions = getAccessManagementPermissionActions(moduleKey);
    const cleanActions = ACCESS_MANAGEMENT_PERMISSION_ACTIONS.filter(
      (action) => allowedActions.includes(action) && actions.includes(action)
    );

    if (cleanActions.length > 0) {
      acc[moduleKey] = cleanActions;
    }

    return acc;
  }, {});
}

export function getModuleAccessLevel(actions = []) {
  const normalized = uniqueActionList(actions, [...Object.keys(ACTION_META)]);
  const actionSet = new Set(normalized);

  if (actionSet.has("manage")) return "manage";
  if (actionSet.has("create") && actionSet.has("edit") && actionSet.has("delete")) return "manage";
  if (actionSet.has("create") && actionSet.has("edit")) return "edit";
  if (actionSet.has("edit")) return "limited_edit";
  if (normalized.some((action) => action !== "view")) return "use";
  if (actionSet.has("view")) return "view";
  return "none";
}
