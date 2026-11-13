import React, { useCallback, useDeferredValue, useEffect, useMemo, useState } from "react";
import { AlertMessage, Badge, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import Modal from "../../../shared/components/Modal/Modal";
import {
  buildRoleAccessEntry,
  buildRolePermissionMatrix,
  compareRoleAccessEntries,
  getFallbackRoleAccessEntries,
  getModuleAccessMeta,
} from "../../../shared/lib/roleAccess";
import {
  ACCESS_MANAGEMENT_PERMISSION_ACTIONS,
  getDefaultRolePermissionMap,
  getAccessManagementPermissionActions,
  getPermissionActionMeta,
  normalizePermissionMap,
  sanitizeAccessManagementPermissionMap,
} from "../../../shared/lib/permissions";
import { readAuthUser, restoreAuthUser } from "../../../shared/lib/auth";
import useLatestRequest from "../../../shared/hooks/useLatestRequest";
import { getBackendUrl } from "../../../shared/lib/url";
import UserCustomAccessModal from "../../users/components/UserCustomAccessModal";
import { ActionToggle, matchesQuery } from "../../../shared/components/access/PermissionMatrixControls";

const searchInputStyle = {
  width: "100%",
  padding: "8px 9px",
  borderRadius: 8,
  border: "1px solid var(--border-base)",
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  fontSize: 12.5,
  outline: "none",
  boxSizing: "border-box",
};

const sectionTitleStyle = { color: "var(--text-primary)", fontSize: 14, fontWeight: 700 };
const subtleTextStyle = { color: "var(--text-muted)", fontSize: 11.5, lineHeight: 1.5 };
const tableHeaderStyle = {
  padding: "9px 8px",
  textAlign: "left",
  fontSize: 10.5,
  fontWeight: 700,
  color: "var(--text-secondary)",
  background: "var(--surface-page)",
  borderBottom: "1px solid var(--border-base)",
  whiteSpace: "nowrap",
};
const tableCellStyle = {
  padding: "9px 8px",
  borderBottom: "1px solid var(--border-base)",
  verticalAlign: "top",
};
const MATRIX_PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

function getRoleInitials(roleName) {
  const parts = String(roleName || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);

  if (parts.length === 0) return "R";
  return parts.slice(0, 2).map((part) => part[0]).join("").toUpperCase();
}

function sortPermissionMap(permissionMap) {
  const normalized = normalizePermissionMap(permissionMap);
  return Object.keys(normalized)
    .sort()
    .reduce((acc, key) => {
      acc[key] = [...normalized[key]].sort();
      return acc;
    }, {});
}

function serializePermissionMap(permissionMap) {
  return JSON.stringify(sortPermissionMap(permissionMap));
}

function buildPaginationItems(page, totalPages) {
  if (totalPages <= 1) {
    return [{ type: "page", value: 1 }];
  }

  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => ({
      type: "page",
      value: index + 1,
    }));
  }

  const left = Math.max(2, Math.min(page - 1, totalPages - 4));
  const right = Math.min(totalPages - 1, Math.max(page + 1, 4));
  const items = [{ type: "page", value: 1 }];

  if (left > 2) {
    items.push({ type: "ellipsis", key: "start" });
  }

  for (let value = left; value <= right; value += 1) {
    items.push({ type: "page", value });
  }

  if (right < totalPages - 1) {
    items.push({ type: "ellipsis", key: "end" });
  }

  items.push({ type: "page", value: totalPages });
  return items;
}

function AccessBadge({ access }) {
  return <Badge palette={getModuleAccessMeta(access)} />;
}

function StatCard({ label, value, helper }) {
  return (
    <DashboardPanel style={{ padding: 11, display: "grid", gap: 5 }}>
      <span style={{ fontSize: 10.5, color: "var(--text-muted)", fontWeight: 600 }}>{label}</span>
      <strong style={{ fontSize: 24.5, color: "var(--text-primary)", lineHeight: 1.1 }}>{value}</strong>
      <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>{helper}</span>
    </DashboardPanel>
  );
}

function UserChip({ user, selected = false, onSelect }) {
  const statusTone = String(user?.status_type || user?.status_name || "")
    .trim()
    .toLowerCase();
  const active = statusTone === "active" || Number(user?.status) === 1;
  const hasCustomAccess = Boolean(user?.custom_permissions_configured);

  return (
    <button
      type="button"
      onClick={onSelect}
      style={{
        appearance: "none",
        width: "100%",
        border: "1px solid var(--border-base)",
        borderRadius: 9,
        padding: "8px 9px",
        display: "grid",
        gap: 6,
        background: selected ? "var(--brand-50)" : "var(--surface-base)",
        borderColor: selected ? "var(--brand-700)" : "var(--border-base)",
        textAlign: "left",
        cursor: "pointer",
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "center" }}>
        <strong style={{ color: "var(--text-primary)", fontSize: 11.5 }}>{user?.name || user?.email || "User"}</strong>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <Badge tone={hasCustomAccess ? "warning" : "neutral"}>
            {hasCustomAccess ? "User Custom" : "Role Default"}
          </Badge>
          <Badge tone={active ? "success" : "warning"}>
            {active ? "Active" : (user?.status_name || "Assigned")}
          </Badge>
        </div>
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{user?.email || "-"}</span>
      <span style={{ color: "var(--text-secondary)", fontSize: 10.5 }}>
        {[user?.department_name, user?.campus_name].filter(Boolean).join(" | ") || "No department / campus"}
      </span>
    </button>
  );
}

function buildNextActionSet(module, currentActions, action, enabled) {
  const allowedActions = getAccessManagementPermissionActions(module);
  if (!allowedActions.includes(action)) {
    return allowedActions.filter((entry) => currentActions.includes(entry));
  }

  if (!enabled) {
    return allowedActions.filter((entry) => currentActions.includes(entry) && entry !== action);
  }

  const next = allowedActions.filter((entry) => currentActions.includes(entry));
  if (allowedActions.includes("view") && action !== "view" && !next.includes("view")) {
    next.unshift("view");
  }
  if (!next.includes(action)) {
    next.push(action);
  }
  return next;
}

function buildFullAccessActionSet(module) {
  return getAccessManagementPermissionActions(module);
}

function hasFullAccess(module, actions = []) {
  const fullAccessActions = buildFullAccessActionSet(module);
  return fullAccessActions.length > 0 && fullAccessActions.every((action) => actions.includes(action));
}

async function refreshCurrentAuthUserIfNeeded(predicate) {
  const currentUser = readAuthUser();
  if (!currentUser || typeof predicate !== "function" || !predicate(currentUser)) {
    return;
  }

  try {
    const refreshedUser = await restoreAuthUser({ force: true });
    if (refreshedUser && typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("auth-user-refreshed", { detail: { user: refreshedUser } }));
    }
  } catch {
    // The next session restore or notification poll will pick up the permission change.
  }
}

export default function RoleAccessPanel() {
  const beginRequest = useLatestRequest();
  const [roles, setRoles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeRoleKey, setActiveRoleKey] = useState("");
  const [roleDetails, setRoleDetails] = useState(null);
  const [storedPermissions, setStoredPermissions] = useState({});
  const [permissionsConfigured, setPermissionsConfigured] = useState(false);
  const [permissionDrafts, setPermissionDrafts] = useState({});
  const [permissionsLoading, setPermissionsLoading] = useState(false);
  const [permissionsSaving, setPermissionsSaving] = useState(false);
  const [permissionsError, setPermissionsError] = useState("");
  const [permissionsSuccess, setPermissionsSuccess] = useState("");
  const [roleSearch, setRoleSearch] = useState("");
  const [moduleSearch, setModuleSearch] = useState("");
  const [matrixPage, setMatrixPage] = useState(1);
  const [matrixPageSize, setMatrixPageSize] = useState(10);
  const [isMatrixModalOpen, setIsMatrixModalOpen] = useState(false);
  const [selectedCustomUserId, setSelectedCustomUserId] = useState("");
  const [isCustomAccessModalOpen, setIsCustomAccessModalOpen] = useState(false);
  const [selectedAccessUser, setSelectedAccessUser] = useState(null);
  const [accessRole, setAccessRole] = useState(null);
  const [roleAccessMap, setRoleAccessMap] = useState({});
  const [accessDrafts, setAccessDrafts] = useState({});
  const [accessBaseMap, setAccessBaseMap] = useState({});
  const [accessLoading, setAccessLoading] = useState(false);
  const [accessSaving, setAccessSaving] = useState(false);
  const [accessError, setAccessError] = useState("");
  const [accessSuccess, setAccessSuccess] = useState("");
  const [accessSearch, setAccessSearch] = useState("");
  const [accessHasSavedUserPermissions, setAccessHasSavedUserPermissions] = useState(false);
  const [accessHasSavedRolePermissions, setAccessHasSavedRolePermissions] = useState(false);
  const [accessPermissionSource, setAccessPermissionSource] = useState("default");
  const deferredModuleSearch = useDeferredValue(moduleSearch);

  const loadRoles = useCallback(async () => {
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      params.set("page", "1");
      params.set("limit", "500");

      const res = await fetch(getBackendUrl(`roles.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to load roles.");

      setRoles(Array.isArray(data?.data) ? data.data : []);
    } catch (loadError) {
      setRoles([]);
      setError(loadError?.message || "Failed to load roles.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadRoles();
  }, [loadRoles]);

  const roleEntries = useMemo(() => {
    if (roles.length > 0) {
      return roles.map((role) => buildRoleAccessEntry(role)).sort(compareRoleAccessEntries);
    }

    if (error) {
      return getFallbackRoleAccessEntries();
    }

    return [];
  }, [error, roles]);

  useEffect(() => {
    setActiveRoleKey((current) => {
      if (roleEntries.some((entry) => entry.key === current)) return current;
      return roleEntries[0]?.key || "";
    });
  }, [roleEntries]);

  const filteredRoles = useMemo(
    () =>
      roleEntries.filter((role) =>
        matchesQuery(
          [role.roleName, role.slug, role.description, role.note, role.userCount, role.moduleCount],
          roleSearch
        )
      ),
    [roleEntries, roleSearch]
  );

  const activeRole = roleEntries.find((entry) => entry.key === activeRoleKey) || roleEntries[0] || null;

  const loadRolePermissions = useCallback(async (roleId) => {
    if (!roleId) {
      setRoleDetails(null);
      setStoredPermissions({});
      setPermissionsConfigured(false);
      return;
    }

    // Clicking through the role list starts one of these per role, and the
    // answers can come back in any order. Without this, a slow response for the
    // role you just left overwrites the permissions of the one now selected.
    // See useLatestRequest.
    const isCurrent = beginRequest();
    setPermissionsLoading(true);
    setPermissionsError("");
    setPermissionsSuccess("");

    try {
      const res = await fetch(getBackendUrl(`role_permissions.php?role_id=${encodeURIComponent(roleId)}`), {
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to load role permissions.");

      if (!isCurrent()) return;

      setRoleDetails(data?.role || null);
      setStoredPermissions(normalizePermissionMap(data?.permissions || {}));
      setPermissionsConfigured(Boolean(data?.has_saved_permissions));
    } catch (loadError) {
      if (!isCurrent()) return;
      setRoleDetails(null);
      setStoredPermissions({});
      setPermissionsConfigured(false);
      setPermissionsError(loadError?.message || "Failed to load role permissions.");
    } finally {
      if (isCurrent()) setPermissionsLoading(false);
    }
  }, [beginRequest]);

  useEffect(() => {
    if (!activeRole?.roleId) {
      setRoleDetails(null);
      setStoredPermissions({});
      setPermissionsConfigured(false);
      setPermissionDrafts({});
      setPermissionsError("");
      setPermissionsSuccess("");
      return;
    }

    void loadRolePermissions(activeRole.roleId);
  }, [activeRole?.roleId, loadRolePermissions]);

  const basePermissionMap = useMemo(() => {
    if (!activeRole) return {};
    if (permissionsConfigured) return normalizePermissionMap(storedPermissions);
    return getDefaultRolePermissionMap(activeRole);
  }, [activeRole, permissionsConfigured, storedPermissions]);

  useEffect(() => {
    setPermissionDrafts(basePermissionMap);
  }, [activeRole?.key, basePermissionMap]);

  const permissionMatrix = useMemo(() => {
    if (!activeRole) return [];
    return buildRolePermissionMatrix(activeRole, sanitizeAccessManagementPermissionMap(permissionDrafts), {
      includeInactive: true,
      useRoleDefaults: false,
    });
  }, [activeRole, permissionDrafts]);

  const filteredModules = useMemo(
    () =>
      permissionMatrix.filter((module) =>
        matchesQuery([module.label, module.groupLabel, module.description, module.view], deferredModuleSearch)
      ),
    [deferredModuleSearch, permissionMatrix]
  );

  const totalMatrixPages = Math.max(1, Math.ceil(filteredModules.length / matrixPageSize));
  const paginatedModules = useMemo(() => {
    const start = (matrixPage - 1) * matrixPageSize;
    return filteredModules.slice(start, start + matrixPageSize);
  }, [filteredModules, matrixPage, matrixPageSize]);
  const matrixPaginationItems = useMemo(
    () => buildPaginationItems(matrixPage, totalMatrixPages),
    [matrixPage, totalMatrixPages]
  );
  const matrixRange = useMemo(() => {
    if (filteredModules.length === 0 || paginatedModules.length === 0) {
      return { start: 0, end: 0 };
    }

    const start = (matrixPage - 1) * matrixPageSize + 1;
    return {
      start,
      end: start + paginatedModules.length - 1,
    };
  }, [filteredModules.length, matrixPage, matrixPageSize, paginatedModules.length]);

  useEffect(() => {
    setMatrixPage((current) => Math.min(current, totalMatrixPages));
  }, [totalMatrixPages]);

  useEffect(() => {
    setMatrixPage(1);
  }, [activeRole?.key]);

  const enabledModules = useMemo(
    () => permissionMatrix.filter((module) => module.enabled),
    [permissionMatrix]
  );

  const enabledActionCount = useMemo(
    () =>
      enabledModules.reduce(
        (total, module) => total + (sanitizeAccessManagementPermissionMap({
          [module.view]: module.permissions,
        })[module.view]?.length || 0),
        0
      ),
    [enabledModules]
  );

  const visibleMatrixActions = useMemo(() => {
    return ACCESS_MANAGEMENT_PERMISSION_ACTIONS.filter((action) =>
      permissionMatrix.some((module) => module.actions.includes(action))
    );
  }, [permissionMatrix]);

  const selectedRoleUsers = useMemo(
    () => roleDetails?.assigned_users || activeRole?.assignedUsers || [],
    [activeRole?.assignedUsers, roleDetails?.assigned_users]
  );
  const selectedCustomUser = useMemo(
    () => selectedRoleUsers.find((user) => String(user?.user_id || "") === String(selectedCustomUserId || "")) || null,
    [selectedCustomUserId, selectedRoleUsers]
  );
  const customUserCount = useMemo(
    () => selectedRoleUsers.filter((user) => Boolean(user?.custom_permissions_configured)).length,
    [selectedRoleUsers]
  );
  const hasUnsavedChanges = useMemo(
    () => serializePermissionMap(permissionDrafts) !== serializePermissionMap(basePermissionMap),
    [basePermissionMap, permissionDrafts]
  );
  const accessHasUnsavedChanges = useMemo(
    () => serializePermissionMap(accessDrafts) !== serializePermissionMap(accessBaseMap),
    [accessBaseMap, accessDrafts]
  );
  const fullAccessModules = useMemo(
    () => permissionMatrix.filter((module) => buildFullAccessActionSet(module).length > 0),
    [permissionMatrix]
  );
  const allFullAccessChecked = useMemo(
    () => fullAccessModules.length > 0 && fullAccessModules.every((module) => hasFullAccess(module, module.permissions)),
    [fullAccessModules]
  );

  useEffect(() => {
    setSelectedCustomUserId((current) => {
      if (selectedRoleUsers.some((user) => String(user?.user_id || "") === String(current || ""))) {
        return current;
      }
      return String(selectedRoleUsers[0]?.user_id || "");
    });
  }, [selectedRoleUsers]);

  useEffect(() => {
    setIsMatrixModalOpen(false);
    setIsCustomAccessModalOpen(false);
    setSelectedAccessUser(null);
    setAccessRole(null);
    setRoleAccessMap({});
    setAccessDrafts({});
    setAccessBaseMap({});
    setAccessLoading(false);
    setAccessSaving(false);
    setAccessError("");
    setAccessSuccess("");
    setAccessSearch("");
    setAccessHasSavedUserPermissions(false);
    setAccessHasSavedRolePermissions(false);
    setAccessPermissionSource("default");
  }, [activeRole?.roleId]);

  const closeCustomAccessModal = useCallback(() => {
    setIsCustomAccessModalOpen(false);
    setSelectedAccessUser(null);
    setAccessRole(null);
    setRoleAccessMap({});
    setAccessDrafts({});
    setAccessBaseMap({});
    setAccessLoading(false);
    setAccessSaving(false);
    setAccessError("");
    setAccessSuccess("");
    setAccessSearch("");
    setAccessHasSavedUserPermissions(false);
    setAccessHasSavedRolePermissions(false);
    setAccessPermissionSource("default");
  }, []);

  const applyUserAccessPayload = useCallback((data, fallbackUser = null) => {
    const payloadUser = data?.user || fallbackUser || null;
    const rawRole = data?.role || roleDetails || activeRole || null;
    const resolvedRolePermissions = data?.has_saved_role_permissions
      ? normalizePermissionMap(data?.role_permissions || {})
      : getDefaultRolePermissionMap(rawRole || payloadUser || activeRole || {});
    const resolvedUserPermissions = normalizePermissionMap(data?.user_permissions || {});
    const baseMap = data?.has_saved_user_permissions
      ? resolvedUserPermissions
      : resolvedRolePermissions;
    const effectiveMap = data?.has_saved_user_permissions
      ? resolvedUserPermissions
      : resolvedRolePermissions;
    const normalizedRole = rawRole
      ? {
          ...rawRole,
          permissions_configured: Boolean(data?.has_saved_role_permissions),
          module_permissions: resolvedRolePermissions,
        }
      : null;

    setSelectedAccessUser(payloadUser);
    setAccessRole(normalizedRole);
    setRoleAccessMap(resolvedRolePermissions);
    setAccessBaseMap(baseMap);
    setAccessDrafts(effectiveMap);
    setAccessHasSavedUserPermissions(Boolean(data?.has_saved_user_permissions));
    setAccessHasSavedRolePermissions(Boolean(data?.has_saved_role_permissions));
    setAccessPermissionSource(data?.permission_source || "default");
  }, [activeRole, roleDetails]);

  const loadUserCustomAccess = useCallback(async (userId, fallbackUser = null) => {
    setAccessLoading(true);
    setAccessError("");
    setAccessSuccess("");

    try {
      const params = new URLSearchParams({ user_id: String(userId) });
      const res = await fetch(getBackendUrl(`user_permissions.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to load custom sidebar access.");
      applyUserAccessPayload(data, fallbackUser);
    } catch (loadError) {
      setAccessError(loadError?.message || "Failed to load custom sidebar access.");
    } finally {
      setAccessLoading(false);
    }
  }, [applyUserAccessPayload]);

  const openCustomAccess = useCallback(async (user) => {
    if (!user?.user_id) return;

    setSelectedCustomUserId(String(user.user_id));
    setSelectedAccessUser(user);
    setIsCustomAccessModalOpen(true);
    setAccessSearch("");
    await loadUserCustomAccess(user.user_id, user);
  }, [loadUserCustomAccess]);

  const updateAccessDraftModule = useCallback((moduleKey, nextActions) => {
    setAccessSuccess("");
    setAccessError("");
    setAccessDrafts((current) => {
      const normalized = normalizePermissionMap({
        ...current,
        [moduleKey]: nextActions,
      });

      if (!normalized[moduleKey]) {
        const clone = { ...normalized };
        delete clone[moduleKey];
        return clone;
      }

      return normalized;
    });
  }, []);

  const handleAccessToggleAction = useCallback((module, action, enabled) => {
    const nextActions = buildNextActionSet(module, accessDrafts[module.view] || [], action, enabled);
    updateAccessDraftModule(module.view, nextActions);
  }, [accessDrafts, updateAccessDraftModule]);

  const handleAccessUseRoleDefault = useCallback((module) => {
    const roleDefaultActions = roleAccessMap[module.view] || [];
    const allowedRoleDefaultActions = ACCESS_MANAGEMENT_PERMISSION_ACTIONS.filter(
      (action) => module.actions.includes(action) && roleDefaultActions.includes(action)
    );
    updateAccessDraftModule(module.view, allowedRoleDefaultActions);
  }, [roleAccessMap, updateAccessDraftModule]);

  const handleAccessClearModule = useCallback((module) => {
    updateAccessDraftModule(module.view, []);
  }, [updateAccessDraftModule]);

  const handleAccessEnableModule = useCallback((module) => {
    const roleDefaultActions = roleAccessMap[module.view] || [];
    const allowedRoleDefaultActions = ACCESS_MANAGEMENT_PERMISSION_ACTIONS.filter(
      (action) => module.actions.includes(action) && roleDefaultActions.includes(action)
    );
    if (roleDefaultActions.length > 0) {
      updateAccessDraftModule(module.view, allowedRoleDefaultActions.length > 0 ? allowedRoleDefaultActions : ["view"]);
      return;
    }

    const preferredActions = module.actions.includes("view") ? ["view"] : buildFullAccessActionSet(module).slice(0, 1);
    updateAccessDraftModule(module.view, preferredActions);
  }, [roleAccessMap, updateAccessDraftModule]);

  const resetAccessDraft = useCallback(() => {
    setAccessDrafts(accessBaseMap);
    setAccessSuccess("");
    setAccessError("");
  }, [accessBaseMap]);

  const saveCustomAccess = useCallback(async () => {
    if (!selectedAccessUser?.user_id) {
      return;
    }

    setAccessSaving(true);
    setAccessError("");
    setAccessSuccess("");

    try {
      const normalizedDraft = sanitizeAccessManagementPermissionMap(accessDrafts);
      const normalizedRoleAccess = sanitizeAccessManagementPermissionMap(roleAccessMap);
      const useRoleDefault = serializePermissionMap(normalizedDraft) === serializePermissionMap(normalizedRoleAccess);
      const res = await fetch(getBackendUrl("user_permissions.php"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          user_id: selectedAccessUser.user_id,
          permissions: useRoleDefault ? {} : normalizedDraft,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to update custom sidebar access.");

      applyUserAccessPayload(data, selectedAccessUser);
      setAccessSuccess(data?.message || (useRoleDefault
        ? "User custom permissions cleared."
        : "User custom permissions updated."));

      if (activeRole?.roleId) {
        await loadRolePermissions(activeRole.roleId);
      }

      await refreshCurrentAuthUserIfNeeded((currentUser) =>
        Number(currentUser?.user_id) === Number(selectedAccessUser.user_id)
      );
    } catch (saveError) {
      setAccessError(saveError?.message || "Failed to update custom sidebar access.");
    } finally {
      setAccessSaving(false);
    }
  }, [accessDrafts, activeRole?.roleId, applyUserAccessPayload, loadRolePermissions, roleAccessMap, selectedAccessUser]);

  const updateModuleActions = useCallback((moduleKey, nextActions) => {
    setPermissionsSuccess("");
    setPermissionsError("");
    setPermissionDrafts((current) => {
      const normalized = normalizePermissionMap({
        ...current,
        [moduleKey]: nextActions,
      });

      if (!normalized[moduleKey]) {
        const clone = { ...normalized };
        delete clone[moduleKey];
        return clone;
      }

      return normalized;
    });
  }, []);

  const handleToggleAction = useCallback((module, action, enabled) => {
    const nextActions = buildNextActionSet(module, permissionDrafts[module.view] || [], action, enabled);
    updateModuleActions(module.view, nextActions);
  }, [permissionDrafts, updateModuleActions]);

  const handleClearModule = useCallback((module) => {
    updateModuleActions(module.view, []);
  }, [updateModuleActions]);

  const handleEnableModule = useCallback((module) => {
    const preferredActions = module.actions.includes("view") ? ["view"] : buildFullAccessActionSet(module).slice(0, 1);
    updateModuleActions(module.view, preferredActions);
  }, [updateModuleActions]);

  const handleToggleFullAccess = useCallback((module, enabled) => {
    updateModuleActions(module.view, enabled ? buildFullAccessActionSet(module) : []);
  }, [updateModuleActions]);

  const handleAccessToggleFullAccess = useCallback((module, enabled) => {
    updateAccessDraftModule(module.view, enabled ? buildFullAccessActionSet(module) : []);
  }, [updateAccessDraftModule]);

  const handleToggleAllFullAccess = useCallback((enabled) => {
    setPermissionsSuccess("");
    setPermissionsError("");
    if (!enabled) {
      setPermissionDrafts({});
      return;
    }

    const nextPermissions = permissionMatrix.reduce((acc, module) => {
      const actions = buildFullAccessActionSet(module);
      if (actions.length > 0) {
        acc[module.view] = actions;
      }
      return acc;
    }, {});
    setPermissionDrafts(normalizePermissionMap(nextPermissions));
  }, [permissionMatrix]);

  const handleCancelChanges = () => {
    setPermissionDrafts(basePermissionMap);
    setPermissionsSuccess("");
    setPermissionsError("");
  };

  const savePermissions = async () => {
    if (!activeRole?.roleId) return;

    setPermissionsSaving(true);
    setPermissionsError("");
    setPermissionsSuccess("");

    try {
      const permissions = sanitizeAccessManagementPermissionMap(permissionDrafts);
      const res = await fetch(getBackendUrl("role_permissions.php"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          role_id: activeRole.roleId,
          permissions,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to save role permissions.");

      const nextPermissions = normalizePermissionMap(data?.permissions || {});
      const nextRoleDetails = data?.role || null;
      setStoredPermissions(nextPermissions);
      setPermissionDrafts(nextPermissions);
      setPermissionsConfigured(Boolean(data?.has_saved_permissions));
      setRoleDetails(nextRoleDetails);
      setPermissionsSuccess(data?.message || "Role permissions updated.");
      setRoles((current) =>
        current.map((role) =>
          Number(role?.role_id) === Number(activeRole.roleId)
            ? {
                ...role,
                ...(nextRoleDetails || {}),
                permissions_configured: Boolean(data?.has_saved_permissions),
                module_permissions: nextPermissions,
              }
            : role
        )
      );

      await refreshCurrentAuthUserIfNeeded((currentUser) =>
        Number(currentUser?.role_id) === Number(activeRole.roleId)
      );
    } catch (saveError) {
      setPermissionsError(saveError?.message || "Failed to save role permissions.");
    } finally {
      setPermissionsSaving(false);
    }
  };

  const roleSourceLabel = permissionsConfigured ? "Saved RBAC permissions" : "Built-in default access profile";

  return (
    <DashboardPanel>
      <SectionHeader
        title="Access Management"
        actions={(
          <Button variant="secondary" onClick={() => void loadRoles()} disabled={loading}>
            {loading ? "Refreshing..." : "Refresh Roles"}
          </Button>
        )}
      />

      <div style={{ padding: 12, display: "grid", gap: 12 }}>
        <AlertMessage
          tone="info"
          message="Review each role, inspect assigned users, and manage both role defaults and custom sidebar access from one place. Saved role permissions and user-specific overrides are still enforced on the backend even if someone enters a URL manually."
        />

        {error ? (
          <AlertMessage
            tone="warning"
            message={`${error} Showing the fixed access catalog instead.`}
          />
        ) : null}

        <div
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "minmax(238px, 289px) minmax(0, 1fr)",
            alignItems: "start",
          }}
        >
          <DashboardPanel variant="muted" style={{ padding: 14, display: "grid", gap: 11 }}>
            <div style={{ display: "grid", gap: 3 }}>
              <strong style={sectionTitleStyle}>Roles</strong>
              <span style={subtleTextStyle}>Search a role to inspect its assigned users and current module access.</span>
            </div>

            <input
              type="search"
              value={roleSearch}
              onChange={(event) => setRoleSearch(event.target.value)}
              placeholder="Search roles..."
              style={searchInputStyle}
            />

            {loading && roleEntries.length === 0 ? (
              <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                Loading roles...
              </DashboardPanel>
            ) : null}

            {!loading && filteredRoles.length === 0 ? (
              <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                No roles matched your search.
              </DashboardPanel>
            ) : null}

            {filteredRoles.length > 0 ? (
              <div style={{ display: "grid", gap: 8, maxHeight: 612, overflowY: "auto", paddingRight: 3 }}>
                {filteredRoles.map((role) => {
                  const selected = activeRole?.key === role.key;
                  const previewNames = role.assignedUsers.slice(0, 2).map((user) => user?.name).filter(Boolean);

                  return (
                    <button
                      key={role.key}
                      type="button"
                      onClick={() => setActiveRoleKey(role.key)}
                      style={{
                        appearance: "none",
                        width: "100%",
                        border: selected ? "1px solid var(--brand-700)" : "1px solid var(--border-base)",
                        background: selected ? "var(--brand-50)" : "var(--surface-base)",
                        borderRadius: 9,
                        padding: 9,
                        display: "grid",
                        gap: 6,
                        cursor: "pointer",
                        textAlign: "left",
                        transition: "background-color 120ms ease, border-color 120ms ease",
                      }}
                    >
                      <div style={{ display: "flex", gap: 9, alignItems: "flex-start" }}>
                        <span
                          style={{
                            width: 32,
                            height: 32,
                            borderRadius: 8,
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            background: selected ? "var(--brand-100)" : "var(--surface-muted)",
                            color: selected ? "var(--brand-800)" : "var(--text-secondary)",
                            fontSize: 11.5,
                            fontWeight: 700,
                            flexShrink: 0,
                          }}
                        >
                          {getRoleInitials(role.roleName)}
                        </span>

                        <div style={{ display: "grid", gap: 2, minWidth: 0, flex: 1 }}>
                          <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>{role.roleName}</strong>
                          <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                            {role.description || role.note || role.slug}
                          </span>
                        </div>
                      </div>

                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                        <Badge tone="success">{`${role.userCount} user${role.userCount === 1 ? "" : "s"}`}</Badge>
                        <Badge tone="success">{`${role.moduleCount} module${role.moduleCount === 1 ? "" : "s"}`}</Badge>
                        <Badge tone="warning">{`${role.enabledActionCount} action${role.enabledActionCount === 1 ? "" : "s"}`}</Badge>
                      </div>

                      <span style={{ color: "var(--text-secondary)", fontSize: 10.5 }}>
                        {previewNames.length > 0
                          ? `Assigned users: ${previewNames.join(", ")}${role.userCount > previewNames.length ? " ..." : ""}`
                          : "No users assigned yet."}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </DashboardPanel>

          <DashboardPanel style={{ padding: 14, display: "grid", gap: 12 }}>
            {activeRole ? (
              <>
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "flex-start", flexWrap: "wrap" }}>
                    <div style={{ display: "grid", gap: 3 }}>
                      <strong style={{ color: "var(--text-primary)", fontSize: 16 }}>
                        {roleDetails?.role_name || activeRole.roleName}
                      </strong>
                      <span style={subtleTextStyle}>
                        {roleDetails?.description || activeRole.description || activeRole.note}
                      </span>
                    </div>
                    {/* Neutral when unsaved. Both branches were "success"
                        before, so the badge said the same thing either way. */}
                    <Badge tone={permissionsConfigured ? "success" : "neutral"}>
                      {permissionsConfigured ? "Saved Access" : "Default Access"}
                    </Badge>
                  </div>

                  {/* Three counts, not five. "Permission Source" restated the
                      badge immediately above it, and "Custom User Overrides"
                      now sits in the section that actually acts on it. */}
                  <div
                    style={{
                      display: "grid",
                      gap: 9,
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(136px, 100%), 1fr))",
                    }}
                  >
                    <StatCard
                      label="Assigned Users"
                      value={roleDetails?.user_count ?? activeRole.userCount}
                      helper="Accounts inheriting this role."
                    />
                    <StatCard
                      label="Accessible Modules"
                      value={enabledModules.length}
                      helper="Modules with at least one active permission."
                    />
                    <StatCard
                      label="Granted Actions"
                      value={enabledActionCount}
                      helper={roleSourceLabel}
                    />
                  </div>

                  {/* Lifted out of the old "Role Details" card, whose other two
                      fields were the name and description already shown above. */}
                  <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                    {enabledModules.length > 0 ? (
                      <>
                        {enabledModules.slice(0, 12).map((module) => (
                          <Badge key={`detail-module-${module.view}`} tone="success">
                            {module.label}
                          </Badge>
                        ))}
                        {enabledModules.length > 12 ? (
                          <Badge tone="neutral">{`+${enabledModules.length - 12} more`}</Badge>
                        ) : null}
                      </>
                    ) : (
                      <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>No modules assigned.</span>
                    )}
                  </div>
                </div>

                {permissionsError ? <AlertMessage tone="error" message={permissionsError} /> : null}
                {permissionsSuccess ? <AlertMessage tone="success" message={permissionsSuccess} /> : null}

                <div style={{ display: "grid", gap: 12 }}>
                  {/* An action row, not a card. This was a bordered panel whose
                      heading and description were repeated verbatim inside the
                      modal it opens, over badges repeating the two counts shown
                      a few pixels above. All that was load-bearing was the
                      button and the unsaved-changes warning. */}
                  <div
                    style={{
                      borderTop: "1px solid var(--border-base)",
                      paddingTop: 12,
                      display: "flex",
                      gap: 9,
                      alignItems: "center",
                      justifyContent: "space-between",
                      flexWrap: "wrap",
                    }}
                  >
                    <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
                      <strong style={sectionTitleStyle}>Permission Matrix</strong>
                      <span style={subtleTextStyle}>
                        Toggle the actions this role inherits, module by module.
                      </span>
                    </div>
                    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                      {hasUnsavedChanges ? <Badge tone="warning">Unsaved changes</Badge> : null}
                      <Button
                        onClick={() => setIsMatrixModalOpen(true)}
                        disabled={!activeRole?.roleId || permissionsLoading}
                      >
                        {permissionsLoading ? "Loading…" : "Open matrix"}
                      </Button>
                    </div>
                  </div>

                  <Modal
                    open={isMatrixModalOpen}
                    title="Permission Matrix"
                    onClose={() => setIsMatrixModalOpen(false)}
                    width={1054}
                  >
                    <div>
                  <DashboardPanel variant="muted" style={{ padding: 12, display: "grid", gap: 11 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ display: "grid", gap: 3 }}>
                        <strong style={sectionTitleStyle}>Permission Matrix</strong>
                        <span style={subtleTextStyle}>
                          Filter modules and toggle the actions this role should inherit.
                        </span>
                      </div>
                      <Button
                        variant="secondary"
                        onClick={() => void loadRolePermissions(activeRole.roleId)}
                        disabled={permissionsLoading || !activeRole.roleId}
                      >
                        {permissionsLoading ? "Loading..." : "Reload"}
                      </Button>
                    </div>

                    <div style={{ display: "flex", gap: 9, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
                      <input
                        type="search"
                        value={moduleSearch}
                        onChange={(event) => {
                          setMatrixPage(1);
                          setModuleSearch(event.target.value);
                        }}
                        placeholder="Search modules..."
                        style={{ ...searchInputStyle, flex: "1 1 280px", minWidth: "min(100%, 238px)" }}
                      />

                      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                        <label
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 6,
                            padding: "8px 9px",
                            borderRadius: 8,
                            border: "1px solid var(--border-base)",
                            background: "var(--surface-base)",
                            color: "var(--text-primary)",
                            fontSize: 11.5,
                            fontWeight: 700,
                            cursor: permissionsSaving ? "not-allowed" : "pointer",
                          }}
                        >
                          <input
                            type="checkbox"
                            checked={allFullAccessChecked}
                            disabled={permissionsSaving || permissionsLoading}
                            onChange={() => handleToggleAllFullAccess(!allFullAccessChecked)}
                            style={{
                              width: 14,
                              height: 14,
                              accentColor: "var(--brand-700)",
                              cursor: permissionsSaving || permissionsLoading ? "not-allowed" : "pointer",
                            }}
                          />
                          <span>Check All</span>
                        </label>
                        <span style={{ color: "var(--text-muted)", fontSize: 11.5, fontWeight: 600 }}>Rows per page</span>
                        <select
                          value={matrixPageSize}
                          onChange={(event) => {
                            setMatrixPageSize(Number(event.target.value));
                            setMatrixPage(1);
                          }}
                          style={{
                            padding: "8px 9px",
                            borderRadius: 8,
                            border: "1px solid var(--border-base)",
                            background: "var(--surface-base)",
                            color: "var(--text-primary)",
                            fontSize: 11.5,
                            minWidth: 78,
                          }}
                        >
                          {MATRIX_PAGE_SIZE_OPTIONS.map((size) => (
                            <option key={size} value={size}>
                              {size}
                            </option>
                          ))}
                        </select>
                      </div>
                    </div>

                    <div style={{ overflowX: "auto", border: "1px solid var(--border-base)", borderRadius: 11, background: "var(--surface-base)" }}>
                      <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 986 }}>
                        <thead>
                          <tr>
                            <th style={tableHeaderStyle}>Module</th>
                            <th style={tableHeaderStyle}>Current Access</th>
                            <th style={{ ...tableHeaderStyle, textAlign: "center" }}>Full Access</th>
                            {visibleMatrixActions.map((action) => (
                              <th key={`header-${action}`} style={{ ...tableHeaderStyle, textAlign: "center" }}>
                                {getPermissionActionMeta(action).label}
                              </th>
                            ))}
                            <th style={{ ...tableHeaderStyle, textAlign: "center" }}>Quick</th>
                          </tr>
                        </thead>
                        <tbody>
                          {permissionsLoading ? (
                            <tr>
                              <td colSpan={visibleMatrixActions.length + 4} style={{ ...tableCellStyle, textAlign: "center", color: "var(--text-muted)" }}>
                                Loading permissions...
                              </td>
                            </tr>
                          ) : null}

                          {!permissionsLoading && filteredModules.length === 0 ? (
                            <tr>
                              <td colSpan={visibleMatrixActions.length + 4} style={{ ...tableCellStyle, textAlign: "center", color: "var(--text-muted)" }}>
                                No modules matched your search.
                              </td>
                            </tr>
                          ) : null}

                          {!permissionsLoading && paginatedModules.map((module) => {
                            const moduleAccessMeta = getModuleAccessMeta(module.access);
                            const fullAccessActions = buildFullAccessActionSet(module);
                            const fullAccessChecked = hasFullAccess(module, module.permissions);

                            return (
                              <tr key={module.id}>
                                <td style={tableCellStyle}>
                                  <div style={{ display: "grid", gap: 2 }}>
                                    <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>{module.label}</strong>
                                    <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                                      {module.groupLabel} | {module.description}
                                    </span>
                                  </div>
                                </td>

                                <td style={tableCellStyle}>
                                  <div style={{ display: "grid", gap: 5 }}>
                                    <AccessBadge access={module.access} />
                                    <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{moduleAccessMeta.helper}</span>
                                  </div>
                                </td>

                                <td style={{ ...tableCellStyle, textAlign: "center" }}>
                                  {fullAccessActions.length > 0 ? (
                                    <ActionToggle
                                      checked={fullAccessChecked}
                                      disabled={permissionsSaving}
                                      label={`${module.label} Full Access`}
                                      onChange={() => handleToggleFullAccess(module, !fullAccessChecked)}
                                    />
                                  ) : (
                                    <span style={{ color: "var(--border-strong)" }}>-</span>
                                  )}
                                </td>

                                {visibleMatrixActions.map((action) => {
                                  if (!module.actions.includes(action)) {
                                    return (
                                      <td key={`${module.id}-${action}`} style={{ ...tableCellStyle, textAlign: "center", color: "var(--border-strong)" }}>
                                        -
                                      </td>
                                    );
                                  }

                                  const checked = module.permissions.includes(action);
                                  return (
                                    <td key={`${module.id}-${action}`} style={{ ...tableCellStyle, textAlign: "center" }}>
                                      <ActionToggle
                                        checked={checked}
                                        disabled={permissionsSaving}
                                        label={`${module.label} ${getPermissionActionMeta(action).label}`}
                                        onChange={() => handleToggleAction(module, action, !checked)}
                                      />
                                    </td>
                                  );
                                })}

                                <td style={{ ...tableCellStyle, textAlign: "center" }}>
                                  <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                                    {module.enabled ? (
                                      <Button
                                        variant="secondary"
                                        onClick={() => handleClearModule(module)}
                                        disabled={permissionsSaving}
                                        style={{ minWidth: 68 }}
                                      >
                                        Clear
                                      </Button>
                                    ) : (
                                      <Button
                                        onClick={() => handleEnableModule(module)}
                                        disabled={permissionsSaving}
                                        style={{ minWidth: 68 }}
                                      >
                                        Enable
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
                      <div style={{ display: "grid", gap: 3 }}>
                        <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                          {filteredModules.length > 0
                            ? `Showing ${matrixRange.start}-${matrixRange.end} of ${filteredModules.length} filtered module${filteredModules.length === 1 ? "" : "s"}`
                            : "Showing 0 modules"}
                        </span>
                        <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                          Page <strong>{matrixPage}</strong> of <strong>{totalMatrixPages}</strong>
                          {filteredModules.length !== permissionMatrix.length
                            ? ` | Filtered from ${permissionMatrix.length} total`
                            : ""}
                        </span>
                      </div>

                      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setMatrixPage((current) => Math.max(1, current - 1))}
                          disabled={matrixPage <= 1}
                        >
                          Previous
                        </Button>

                        <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", justifyContent: "center" }}>
                          {matrixPaginationItems.map((item, index) => {
                            if (item.type === "ellipsis") {
                              return (
                                <span
                                  key={`${item.key}-${index}`}
                                  style={{ minWidth: 24, textAlign: "center", color: "var(--text-faint)", fontSize: 11.5, fontWeight: 700 }}
                                >
                                  ...
                                </span>
                              );
                            }

                            const isActivePage = item.value === matrixPage;
                            return (
                              <Button
                                key={`matrix-page-${item.value}`}
                                type="button"
                                size="sm"
                                variant={isActivePage ? "primary" : "secondary"}
                                onClick={() => setMatrixPage(item.value)}
                                aria-current={isActivePage ? "page" : undefined}
                                style={{ minWidth: 32 }}
                              >
                                {item.value}
                              </Button>
                            );
                          })}
                        </div>

                        <Button
                          variant="secondary"
                          size="sm"
                          onClick={() => setMatrixPage((current) => Math.min(totalMatrixPages, current + 1))}
                          disabled={matrixPage >= totalMatrixPages}
                        >
                          Next
                        </Button>
                      </div>
                    </div>
                  </DashboardPanel>

                      <div
                        style={{
                          position: "sticky",
                          bottom: 0,
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 9,
                          flexWrap: "wrap",
                          alignItems: "center",
                          marginTop: 11,
                          padding: "9px 0 2px",
                          borderTop: "1px solid var(--border-base)",
                          background: "var(--surface-base)",
                        }}
                      >
                        <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                          {hasUnsavedChanges ? "You have unsaved permission changes." : "No unsaved changes."}
                        </span>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          <Button
                            variant="secondary"
                            onClick={handleCancelChanges}
                            disabled={!hasUnsavedChanges || permissionsLoading || permissionsSaving}
                          >
                            Cancel
                          </Button>
                          <Button
                            onClick={() => void savePermissions()}
                            disabled={permissionsSaving || permissionsLoading || !activeRole.roleId}
                          >
                            {permissionsSaving ? "Saving..." : "Save Changes"}
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Modal>

                  <div
                    style={{
                      display: "grid",
                      gap: 12,
                      gridTemplateColumns: "repeat(auto-fit, minmax(min(272px, 100%), 1fr))",
                      alignItems: "start",
                    }}
                  >
                    <div style={{ display: "grid", gap: 9 }}>
                      <div style={{ display: "grid", gap: 3 }}>
                        <strong style={sectionTitleStyle}>Custom Sidebar Access</strong>
                        <span style={subtleTextStyle}>
                          {selectedRoleUsers.length > 0
                            ? `Select a user under ${roleDetails?.role_name || activeRole.roleName} to grant extra sidebar access or restrict role-default actions for that account only.`
                            : "No users are assigned to this role yet."}
                        </span>
                      </div>

                      {selectedRoleUsers.length > 0 ? (
                        <div style={{ display: "grid", gap: 9 }}>
                          <div style={{ display: "grid", gap: 8 }}>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <Badge tone="warning">
                                {`${customUserCount} custom override${customUserCount === 1 ? "" : "s"}`}
                              </Badge>
                              <Badge tone="neutral">
                                {`${selectedRoleUsers.length - customUserCount} role default${selectedRoleUsers.length - customUserCount === 1 ? "" : "s"}`}
                              </Badge>
                            </div>

                            {/* The user list below is the selector. A <select>
                                bound to the same state sat here too, so the
                                panel had two controls driving one value. */}
                            <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                              {selectedCustomUser
                                ? (selectedCustomUser.custom_permissions_configured
                                  ? `${selectedCustomUser.name || selectedCustomUser.email} has a saved override.`
                                  : `${selectedCustomUser.name || selectedCustomUser.email} inherits the role default.`)
                                : "Select a user below to review or override their access."}
                            </span>

                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <Button
                                onClick={() => {
                                  if (selectedCustomUser) {
                                    void openCustomAccess(selectedCustomUser);
                                  }
                                }}
                                disabled={!selectedCustomUser}
                              >
                                Customize Sidebar Access
                              </Button>
                              <Button
                                variant="secondary"
                                onClick={() => {
                                  if (selectedCustomUser?.user_id) {
                                    void loadUserCustomAccess(selectedCustomUser.user_id, selectedCustomUser);
                                  }
                                }}
                                disabled={!selectedCustomUser?.user_id}
                              >
                                Refresh Sidebar Access
                              </Button>
                            </div>
                          </div>

                          <div style={{ display: "grid", gap: 8, maxHeight: 272, overflowY: "auto" }}>
                            {selectedRoleUsers.map((user) => (
                              <UserChip
                                key={`role-user-${activeRole.roleId}-${user.user_id}`}
                                user={user}
                                selected={String(selectedCustomUserId || "") === String(user?.user_id || "")}
                                onSelect={() => setSelectedCustomUserId(String(user?.user_id || ""))}
                              />
                            ))}
                          </div>
                        </div>
                      ) : (
                        <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                          No assigned users.
                        </DashboardPanel>
                      )}
                    </div>
                  </div>
                </div>

                <div style={{ display: "flex", justifyContent: "space-between", gap: 9, flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                    {hasUnsavedChanges ? "You have unsaved permission changes." : "No unsaved changes."}
                  </span>

                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <Button
                      variant="secondary"
                      onClick={handleCancelChanges}
                      disabled={!hasUnsavedChanges || permissionsLoading || permissionsSaving}
                    >
                      Cancel
                    </Button>
                    <Button
                      onClick={() => void savePermissions()}
                      disabled={permissionsSaving || permissionsLoading || !activeRole.roleId}
                    >
                      {permissionsSaving ? "Saving..." : "Save Changes"}
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                No roles are currently available to display.
              </DashboardPanel>
            )}
          </DashboardPanel>
        </div>
      </div>

      <Modal open={isCustomAccessModalOpen} title="Custom Sidebar Access" onClose={closeCustomAccessModal} width={1122}>
        <div>
          <UserCustomAccessModal
            user={selectedAccessUser}
            role={accessRole}
            rolePermissionMap={roleAccessMap}
            draftPermissionMap={accessDrafts}
            loading={accessLoading}
            saving={accessSaving}
            error={accessError}
            success={accessSuccess}
            search={accessSearch}
            onSearchChange={(event) => setAccessSearch(event.target.value)}
            onReload={() => {
              if (selectedAccessUser?.user_id) {
                void loadUserCustomAccess(selectedAccessUser.user_id, selectedAccessUser);
              }
            }}
            onClose={closeCustomAccessModal}
            onSave={() => void saveCustomAccess()}
            onResetDraft={resetAccessDraft}
            onUseRoleDefault={handleAccessUseRoleDefault}
            onToggleAction={handleAccessToggleAction}
            onToggleFullAccess={handleAccessToggleFullAccess}
            onClearModule={handleAccessClearModule}
            onEnableModule={handleAccessEnableModule}
            hasUnsavedChanges={accessHasUnsavedChanges}
            hasSavedUserPermissions={accessHasSavedUserPermissions}
            hasSavedRolePermissions={accessHasSavedRolePermissions}
            permissionSource={accessPermissionSource}
          />
        </div>
      </Modal>
    </DashboardPanel>
  );
}
