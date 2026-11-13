import React, { useMemo } from "react";
import {
  ACCESS_MANAGEMENT_PERMISSION_ACTIONS,
  getAccessManagementPermissionActions,
  getPermissionActionMeta,
  normalizePermissionMap,
  sanitizeAccessManagementPermissionMap,
} from "../../../shared/lib/permissions";
import { buildRolePermissionMatrix, getModuleAccessMeta } from "../../../shared/lib/roleAccess";
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

function summarizePermissionMap(permissionMap) {
  const normalized = normalizePermissionMap(permissionMap);
  const moduleCount = Object.keys(normalized).length;
  const actionCount = Object.values(normalized).reduce(
    (total, actions) => total + actions.filter((action) => action !== "manage").length,
    0
  );

  return { moduleCount, actionCount };
}

function normalizeComparableActions(actions = []) {
  return Array.from(
    new Set(
      (actions || [])
        .map((value) => String(value || "").trim().toLowerCase())
        .filter((value) => value && value !== "manage")
    )
  );
}

function areActionListsEqual(left = [], right = []) {
  const leftNormalized = normalizeComparableActions(left).sort();
  const rightNormalized = normalizeComparableActions(right).sort();

  if (leftNormalized.length !== rightNormalized.length) {
    return false;
  }

  return leftNormalized.every((value, index) => value === rightNormalized[index]);
}

function diffActionLists(baseActions = [], effectiveActions = []) {
  const normalizedBase = normalizeComparableActions(baseActions);
  const normalizedEffective = normalizeComparableActions(effectiveActions);

  return {
    extra: normalizedEffective.filter((action) => !normalizedBase.includes(action)),
    restricted: normalizedBase.filter((action) => !normalizedEffective.includes(action)),
  };
}

function AccessBadge({ access }) {
  const palette = getModuleAccessMeta(access);
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 7px",
        borderRadius: 999,
        border: `1px solid ${palette.borderColor}`,
        background: palette.background,
        color: palette.color,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}
    >
      {palette.label}
    </span>
  );
}

function ActionChip({ label, tone = "default" }) {
  const palette = tone === "muted"
    ? { background: "var(--surface-page)", color: "var(--text-muted)", borderColor: "var(--border-base)" }
    : tone === "danger"
      ? { background: "#fff1f2", color: "#be123c", borderColor: "#fecdd3" }
      : { background: "var(--brand-50)", color: "var(--brand-800)", borderColor: "var(--brand-200)" };

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 6px",
        borderRadius: 999,
        border: `1px solid ${palette.borderColor}`,
        background: palette.background,
        color: palette.color,
        fontSize: 10.5,
        fontWeight: 700,
      }}
    >
      {label}
    </span>
  );
}

function SourceBadge({ custom }) {
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        padding: "4px 7px",
        borderRadius: 999,
        border: `1px solid ${custom ? "#fde68a" : "#cbd5e1"}`,
        background: custom ? "#fffbeb" : "#f8fafc",
        color: custom ? "#92400e" : "#475569",
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
      }}
    >
      {custom ? "User Custom" : "Role Default"}
    </span>
  );
}

function SummaryCard({ label, value, helper }) {
  return (
    <div
      style={{
        border: "1px solid var(--border-base)",
        borderRadius: 9,
        background: "var(--surface-base)",
        padding: 11,
        display: "grid",
        gap: 5,
      }}
    >
      <span style={{ color: "var(--text-muted)", fontSize: 10.5, fontWeight: 600 }}>{label}</span>
      <strong style={{ color: "var(--text-primary)", fontSize: 19.5, lineHeight: 1.1 }}>{value}</strong>
      <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{helper}</span>
    </div>
  );
}

function renderActionSummary(actions = []) {
  if (!actions.length) {
    return <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>No access</span>;
  }

  return (
    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
      {actions.map((action) => (
        <ActionChip key={action} label={getPermissionActionMeta(action).label} />
      ))}
    </div>
  );
}

function renderOverrideSummary(extraActions = [], restrictedActions = []) {
  if (!extraActions.length && !restrictedActions.length) {
    return <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>No user-specific change</span>;
  }

  return (
    <div style={{ display: "grid", gap: 6 }}>
      {extraActions.length > 0 ? (
        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "var(--brand-700)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Extra
          </span>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {extraActions.map((action) => (
              <ActionChip key={`extra-${action}`} label={getPermissionActionMeta(action).label} />
            ))}
          </div>
        </div>
      ) : null}

      {restrictedActions.length > 0 ? (
        <div style={{ display: "grid", gap: 3 }}>
          <span style={{ color: "#be123c", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em" }}>
            Restricted
          </span>
          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
            {restrictedActions.map((action) => (
              <ActionChip key={`restricted-${action}`} label={getPermissionActionMeta(action).label} tone="danger" />
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildFullAccessActionSet(module) {
  return getAccessManagementPermissionActions(module);
}

function hasFullAccess(module, actions = []) {
  const fullAccessActions = buildFullAccessActionSet(module);
  return fullAccessActions.length > 0 && fullAccessActions.every((action) => actions.includes(action));
}

export default function UserCustomAccessModal({
  user,
  role,
  rolePermissionMap = {},
  draftPermissionMap = {},
  loading = false,
  saving = false,
  error = "",
  success = "",
  search = "",
  onSearchChange,
  onReload,
  onClose,
  onSave,
  onResetDraft,
  onUseRoleDefault,
  onToggleAction,
  onClearModule,
  onEnableModule,
  onToggleFullAccess,
  hasUnsavedChanges = false,
  hasSavedUserPermissions = false,
  permissionSource = "default",
}) {
  const roleMatrix = useMemo(
    () => buildRolePermissionMatrix(
      role || user || {},
      sanitizeAccessManagementPermissionMap(rolePermissionMap),
      { includeInactive: true, useRoleDefaults: false }
    ),
    [role, rolePermissionMap, user]
  );
  const effectiveMatrix = useMemo(
    () => buildRolePermissionMatrix(
      role || user || {},
      sanitizeAccessManagementPermissionMap(draftPermissionMap),
      { includeInactive: true, useRoleDefaults: false }
    ),
    [draftPermissionMap, role, user]
  );

  const roleMatrixByView = useMemo(
    () => roleMatrix.reduce((acc, module) => ({ ...acc, [module.view]: module }), {}),
    [roleMatrix]
  );

  const filteredModules = useMemo(
    () =>
      effectiveMatrix.filter((module) =>
        matchesQuery([module.label, module.groupLabel, module.description, module.view], search)
      ),
    [effectiveMatrix, search]
  );

  const visibleMatrixActions = useMemo(() => {
    return ACCESS_MANAGEMENT_PERMISSION_ACTIONS.filter((action) =>
      effectiveMatrix.some((module) => module.actions.includes(action))
        || roleMatrix.some((module) => module.actions.includes(action))
    );
  }, [effectiveMatrix, roleMatrix]);

  const roleSummary = useMemo(() => summarizePermissionMap(rolePermissionMap), [rolePermissionMap]);
  const effectiveSummary = useMemo(() => summarizePermissionMap(draftPermissionMap), [draftPermissionMap]);
  const overrideSummary = useMemo(() => {
    return effectiveMatrix.reduce((summary, module) => {
      const roleActions = roleMatrixByView[module.view]?.permissions || [];
      const diff = diffActionLists(roleActions, module.permissions);

      if (diff.extra.length > 0) {
        summary.extraModules += 1;
        summary.extraActions += diff.extra.length;
      }
      if (diff.restricted.length > 0) {
        summary.restrictedModules += 1;
        summary.restrictedActions += diff.restricted.length;
      }

      return summary;
    }, {
      extraModules: 0,
      extraActions: 0,
      restrictedModules: 0,
      restrictedActions: 0,
    });
  }, [effectiveMatrix, roleMatrixByView]);
  const sourceLabel = hasSavedUserPermissions
    ? "User custom override"
    : permissionSource === "role"
      ? "Saved role access"
      : "Role preset access";

  return (
    <div style={{ padding: 12, display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 9, alignItems: "flex-start", flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 3 }}>
          <strong style={{ color: "var(--text-primary)", fontSize: 16 }}>
            Custom Sidebar Access{user?.name ? `: ${user.name}` : ""}
          </strong>
          <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
            Review inherited sidebar access, then override module actions for this user when needed.
          </span>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <SourceBadge custom={hasSavedUserPermissions} />
          <button
            type="button"
            onClick={onReload}
            disabled={loading}
            style={{
              background: "var(--border-base)",
              color: "var(--text-primary)",
              border: "none",
              padding: "6px 9px",
              borderRadius: 6,
              cursor: loading ? "not-allowed" : "pointer",
              opacity: loading ? 0.7 : 1,
            }}
          >
            {loading ? "Loading..." : "Reload"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: 9, gridTemplateColumns: "repeat(auto-fit, minmax(min(153px, 100%), 1fr))" }}>
        <SummaryCard
          label="Role Default Access"
          value={`${roleSummary.moduleCount}/${roleSummary.actionCount}`}
          helper="Modules / actions inherited from the assigned role."
        />
        <SummaryCard
          label="User Extra Access"
          value={`${overrideSummary.extraModules}/${overrideSummary.extraActions}`}
          helper="Modules / actions granted on top of the role default."
        />
        <SummaryCard
          label="User Restricted Access"
          value={`${overrideSummary.restrictedModules}/${overrideSummary.restrictedActions}`}
          helper="Modules / actions removed from the role default for this user."
        />
        <SummaryCard
          label="Effective Access"
          value={`${effectiveSummary.moduleCount}/${effectiveSummary.actionCount}`}
          helper={`Modules / actions currently granted. Source: ${sourceLabel}.`}
        />
      </div>

      <div
        style={{
          border: "1px solid var(--border-base)",
          borderRadius: 9,
          background: "var(--surface-page)",
          padding: 9,
          display: "grid",
          gap: 5,
        }}
      >
        <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>Access Context</strong>
        <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
          Role Default Access: {role?.role_name || user?.role_name || "No role assigned"}.
        </span>
        <span style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
          User Extra Access: {overrideSummary.extraActions > 0 ? `${overrideSummary.extraActions} action${overrideSummary.extraActions === 1 ? "" : "s"} granted beyond the role.` : "No added actions beyond the role default."}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
          User Restricted Access: {overrideSummary.restrictedActions > 0 ? `${overrideSummary.restrictedActions} role-default action${overrideSummary.restrictedActions === 1 ? "" : "s"} removed for this user.` : "No role-default actions are restricted for this user."}
        </span>
        <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
          Custom Sidebar Access: {hasSavedUserPermissions ? "Overrides the role for this account." : "No override saved. Effective access matches the role default."}
        </span>
      </div>

      {error ? (
        <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 6 }}>
          {error}
        </div>
      ) : null}
      {success ? (
        <div style={{ background: "var(--brand-100)", color: "var(--brand-800)", padding: 8, borderRadius: 6 }}>
          {success}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 9, alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}>
        <input
          type="search"
          value={search}
          onChange={onSearchChange}
          placeholder="Search modules..."
          style={{ ...searchInputStyle, flex: "1 1 280px", minWidth: "min(100%, 238px)" }}
        />
        <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
          {filteredModules.length} module{filteredModules.length === 1 ? "" : "s"} shown
        </span>
      </div>

      <div style={{ overflowX: "auto", border: "1px solid var(--border-base)", borderRadius: 11, background: "var(--surface-base)" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 1088 }}>
          <thead>
            <tr>
              <th style={tableHeaderStyle}>Module</th>
              <th style={tableHeaderStyle}>Role Default Access</th>
              <th style={tableHeaderStyle}>Access Source</th>
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
            {loading ? (
              <tr>
                <td colSpan={visibleMatrixActions.length + 5} style={{ ...tableCellStyle, textAlign: "center", color: "var(--text-muted)" }}>
                  Loading custom sidebar access...
                </td>
              </tr>
            ) : null}

            {!loading && filteredModules.length === 0 ? (
              <tr>
                <td colSpan={visibleMatrixActions.length + 5} style={{ ...tableCellStyle, textAlign: "center", color: "var(--text-muted)" }}>
                  No modules matched your search.
                </td>
              </tr>
            ) : null}

            {!loading && filteredModules.map((module) => {
              const roleModule = roleMatrixByView[module.view];
              const roleActions = roleModule?.permissions || [];
              const roleAccess = roleModule?.access || "none";
              const usesRoleDefault = areActionListsEqual(module.permissions, roleActions);
              const diff = diffActionLists(roleActions, module.permissions);
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
                    <div style={{ display: "grid", gap: 6 }}>
                      <AccessBadge access={roleAccess} />
                      {renderActionSummary(roleActions)}
                    </div>
                  </td>

                  <td style={tableCellStyle}>
                    <div style={{ display: "grid", gap: 6 }}>
                      <SourceBadge custom={!usesRoleDefault} />
                      <AccessBadge access={module.access} />
                      {renderOverrideSummary(diff.extra, diff.restricted)}
                    </div>
                  </td>

                  <td style={{ ...tableCellStyle, textAlign: "center" }}>
                    {fullAccessActions.length > 0 ? (
                      <ActionToggle
                        checked={fullAccessChecked}
                        disabled={saving}
                        label={`${module.label} Full Access`}
                        onChange={() => {
                          if (typeof onToggleFullAccess === "function") {
                            onToggleFullAccess(module, !fullAccessChecked);
                          }
                        }}
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
                          disabled={saving}
                          label={`${module.label} ${getPermissionActionMeta(action).label}`}
                          onChange={() => onToggleAction(module, action, !checked)}
                        />
                      </td>
                    );
                  })}

                  <td style={{ ...tableCellStyle, textAlign: "center" }}>
                    <div style={{ display: "inline-flex", gap: 6, flexWrap: "wrap", justifyContent: "center" }}>
                      {!usesRoleDefault ? (
                        <button
                          type="button"
                          onClick={() => onUseRoleDefault(module)}
                          disabled={saving}
                          style={{
                            background: "var(--border-base)",
                            color: "var(--text-primary)",
                            border: "none",
                            padding: "6px 8px",
                            borderRadius: 6,
                            cursor: saving ? "not-allowed" : "pointer",
                            minWidth: 82,
                            opacity: saving ? 0.7 : 1,
                          }}
                        >
                          Use Default
                        </button>
                      ) : module.enabled ? (
                        <button
                          type="button"
                          onClick={() => onClearModule(module)}
                          disabled={saving}
                          style={{
                            background: "var(--border-base)",
                            color: "var(--text-primary)",
                            border: "none",
                            padding: "6px 8px",
                            borderRadius: 6,
                            cursor: saving ? "not-allowed" : "pointer",
                            minWidth: 68,
                            opacity: saving ? 0.7 : 1,
                          }}
                        >
                          Clear
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onEnableModule(module)}
                          disabled={saving}
                          style={{
                            background: "var(--brand-700)",
                            color: "var(--surface-base)",
                            border: "none",
                            padding: "6px 8px",
                            borderRadius: 6,
                            cursor: saving ? "not-allowed" : "pointer",
                            minWidth: 68,
                            opacity: saving ? 0.7 : 1,
                          }}
                        >
                          Enable
                        </button>
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
        <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
          {hasUnsavedChanges ? "You have unsaved custom access changes." : "No unsaved custom access changes."}
        </span>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={onResetDraft}
            disabled={!hasUnsavedChanges || saving || loading}
            style={{
              background: "var(--border-base)",
              color: "var(--text-primary)",
              border: "none",
              padding: "6px 9px",
              borderRadius: 6,
              cursor: !hasUnsavedChanges || saving || loading ? "not-allowed" : "pointer",
              opacity: !hasUnsavedChanges || saving || loading ? 0.65 : 1,
            }}
          >
            Reset Draft
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              background: "var(--border-base)",
              color: "var(--text-primary)",
              border: "none",
              padding: "6px 9px",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Close
          </button>
          <button
            type="button"
            onClick={onSave}
            disabled={saving || loading}
            style={{
              background: "var(--brand-600)",
              color: "var(--surface-base)",
              border: "none",
              padding: "6px 9px",
              borderRadius: 6,
              cursor: saving || loading ? "not-allowed" : "pointer",
              opacity: saving || loading ? 0.75 : 1,
            }}
          >
            {saving ? "Saving..." : "Save Access"}
          </button>
        </div>
      </div>
    </div>
  );
}
