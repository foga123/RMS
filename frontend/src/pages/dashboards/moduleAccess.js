import { buildAccessibleRoleModules } from "../../shared/lib/roleAccess";
import { isPermissionMapEmpty, normalizePermissionMap } from "../../shared/lib/permissions";
import { getRoleSlug, normalizeRoleSlug } from "../../shared/lib/roles";

/**
 * Modules a role holds but should not be offered on its dashboard.
 *
 * Empty, and worth keeping empty. Faculty were listed here on 2026-09-10 for
 * two stated reasons -- "they act on cases through the workspace" and "the
 * board offered them a screen they cannot write to" -- and the 2026-09-12 merge
 * retired both. The workspace is a TAB of retention_cases now, so hiding the
 * module hides the tab with it, and the board takes a contact from anyone
 * holding edit OR intervene, which is exactly the grant faculty were given.
 *
 * Left standing it did the opposite of what it was for: faculty kept a separate
 * Faculty Workspace rail entry and never reached the merged module at all,
 * which is the two-screens-for-one-job the merge set out to end. The sidebar
 * collapse in SharedGrantedModules depends on retention_cases being PRESENT to
 * fold the workspace away, so this map silently defeated that too.
 *
 * The mechanism stays because per-role hiding is a reasonable thing to need.
 * Before adding a role here, check that nothing has since been folded INTO the
 * module being hidden.
 */
export const HIDDEN_DASHBOARD_MODULES_BY_ROLE = {};

/**
 * What a module is called for a particular role.
 *
 * The registry holds one name per module and that is right for almost all of
 * them — a module called two things is a module nobody can be told to open.
 * `team_monitor` is the exception, because the two audiences supervise
 * different people: an SSP Coordinator or KSH TL monitors THEIR TEAM of
 * callers, while a Dean or Program Head monitors THEIR FACULTY, who are not a
 * team of theirs in any sense the rest of the system uses the word.
 *
 * Renaming it in the registry would fix the dean's rail and break the
 * coordinator's, so the name is chosen per role here — beside the hidden-module
 * map, which is the same kind of per-role shaping, and applied to the module
 * objects themselves rather than to the sidebar. The page heading, the
 * breadcrumb and the loading placeholder all read `module.label`, so one entry
 * renames the module everywhere a role meets it, and the heading matches the
 * rail item that opened it from the first paint — a title computed later, from
 * the response, would say "Team Monitoring" until the fetch landed.
 *
 * Keyed by role SLUG. Both academic roles are listed rather than derived: they
 * share a dashboard because a Program Head does the dean's work, and if that
 * ever stops being true this is one of the places that has to notice.
 */
const MODULE_LABELS_BY_ROLE = {
  dean: { team_monitor: "Faculty Monitoring" },
  "program-head": { team_monitor: "Faculty Monitoring" },
};

function hasSavedPermissionConfig(user) {
  return Boolean(
    user?.permissions_configured ||
    user?.role_permissions_configured ||
    user?.user_permissions_configured
  );
}

function getSessionPermissionMap(user) {
  const permissionsConfigured = hasSavedPermissionConfig(user);
  const permissions = normalizePermissionMap(user?.permissions || {});
  if (!isPermissionMapEmpty(permissions)) {
    return permissions;
  }

  const modulePermissions = normalizePermissionMap(user?.module_permissions || {});
  if (!isPermissionMapEmpty(modulePermissions)) {
    return modulePermissions;
  }

  if (permissionsConfigured) {
    return {};
  }

  const rolePermissions = normalizePermissionMap(user?.role_permissions || {});
  if (!isPermissionMapEmpty(rolePermissions)) {
    return rolePermissions;
  }

  return {};
}

export function getEffectiveDashboardModules(user, roleSlug = "") {
  if (!user) return [];

  const resolvedRoleSlug = normalizeRoleSlug(roleSlug) || getRoleSlug(user);
  const roleContext = resolvedRoleSlug
    ? { ...user, role_slug: resolvedRoleSlug }
    : user;
  const isAdmin = Number(user?.role_id) === 1 || resolvedRoleSlug === "admin";

  const hideForRole = (modules) => {
    const hidden = HIDDEN_DASHBOARD_MODULES_BY_ROLE[resolvedRoleSlug];
    return hidden ? modules.filter((module) => !hidden.has(module.view)) : modules;
  };

  const shapeForRole = (modules) => {
    const labels = MODULE_LABELS_BY_ROLE[resolvedRoleSlug];
    const visible = hideForRole(modules);
    if (!labels) return visible;

    return visible.map((module) =>
      labels[module.view] ? { ...module, label: labels[module.view] } : module
    );
  };

  if (isAdmin) {
    const sessionPermissions = getSessionPermissionMap(user);
    const permissionsConfigured = hasSavedPermissionConfig(user);

    return shapeForRole(buildAccessibleRoleModules(
      { ...roleContext, role_id: 1, role_name: "Admin", role_slug: "admin", permissions_configured: permissionsConfigured },
      permissionsConfigured ? sessionPermissions : {},
      { useRoleDefaults: !permissionsConfigured }
    ));
  }

  const permissionsConfigured = hasSavedPermissionConfig(user);

  return shapeForRole(buildAccessibleRoleModules(
    roleContext,
    getSessionPermissionMap(user),
    { useRoleDefaults: !permissionsConfigured }
  ));
}

export function getDashboardModule(modules, view) {
  return (modules || []).find((module) => module.view === view) || null;
}

export function getExtraDashboardModules(modules, defaultViews = []) {
  const defaultViewSet = new Set(defaultViews);
  return (modules || []).filter((module) => !defaultViewSet.has(module.view));
}

export function resolveAccessibleDashboardView(activeView, modules, preferredViews = []) {
  const enabledViews = new Set((modules || []).map((module) => module.view));

  if (activeView && enabledViews.has(activeView)) {
    return activeView;
  }

  for (const view of preferredViews) {
    if (enabledViews.has(view)) {
      return view;
    }
  }

  return modules?.[0]?.view || activeView || "";
}
