import React from "react";
import { Icon } from "../ui";

export default function InactiveUsersQuickPanel({
  open,
  title,
  description,
  users,
  totalCount,
  loading,
  error,
  search,
  actionUserId,
  summaryLabel,
  emptyLabel,
  onClose,
  onSearchChange,
  onPrimaryAction,
  getPrimaryAction,
  onSecondaryAction,
  secondaryActionLabel = "Archive",
  onManage,
}) {
  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.58)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 12,
        zIndex: 1100,
      }}
      onClick={onClose}
    >
      <div
        style={{
          width: "min(935px, 100%)",
          maxHeight: "85vh",
          background: "var(--surface-base)",
          border: "1px solid var(--border-base)",
          borderRadius: 12,
          boxShadow: "0 20px 60px rgba(15, 23, 42, 0.22)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
        onClick={(event) => event.stopPropagation()}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 9,
            padding: 14,
            borderBottom: "1px solid var(--border-base)",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <h3 style={{ margin: 0, color: "var(--text-primary)" }}>{title || "Users"}</h3>
            <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
              {description || "Review user accounts and manage them without leaving the dashboard."}
            </p>
          </div>

          <button
            type="button"
            onClick={onClose}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--text-secondary)",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 31,
              height: 31,
              borderRadius: 8,
            }}
            aria-label="Close user panel"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 9,
            padding: 12,
            borderBottom: "1px solid var(--border-base)",
            background: "var(--surface-page)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--neutral-700)", fontSize: 11.5, fontWeight: 600 }}>
            <Icon name="users" size={14} />
            <span>{summaryLabel || `Showing ${users.length} of ${totalCount} users`}</span>
          </div>

          <input
            value={search}
            onChange={(event) => onSearchChange(event.target.value)}
            placeholder="Search name, email, role, department..."
            style={{
              width: "min(306px, 100%)",
              padding: "7px 9px",
              border: "1px solid var(--border-strong)",
              borderRadius: 8,
              background: "var(--surface-base)",
            }}
            name="admin_users_search"
          />
        </div>

        {error ? (
          <div style={{ margin: 12, padding: 9, borderRadius: 8, background: "var(--danger-100)", color: "var(--danger-800)", border: "1px solid var(--danger-200)" }}>
            {error}
          </div>
        ) : null}

        <div style={{ overflow: "auto", padding: 0 }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-base)", color: "var(--text-secondary)", textAlign: "left" }}>
                <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-base)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>User</th>
                <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-base)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Role</th>
                <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-base)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Department</th>
                <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-base)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Campus</th>
                <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-base)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} style={{ padding: 14, textAlign: "center", color: "var(--text-muted)" }}>
                    Loading users...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ padding: 14, textAlign: "center", color: "var(--text-muted)" }}>
                    {emptyLabel || "No users found."}
                  </td>
                </tr>
              ) : (
                users.map((user) => {
                  const primaryAction = typeof getPrimaryAction === "function" ? getPrimaryAction(user) : null;

                  return (
                    <tr key={user.user_id}>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 187 }}>
                        <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                          {String(user.first_name || "").trim()} {String(user.last_name || "").trim()}
                        </div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>{user.email || "No email"}</div>
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: "var(--neutral-700)" }}>{user.role_name || "-"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: "var(--neutral-700)" }}>{user.department_name || "-"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: "var(--neutral-700)" }}>{user.campus_name || "-"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 230 }}>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {primaryAction ? (
                            <button
                              type="button"
                              onClick={() => onPrimaryAction(user)}
                              disabled={actionUserId === user.user_id}
                              style={{
                                background: primaryAction.background || "#059669",
                                color: "var(--surface-base)",
                                border: "none",
                                borderRadius: 6,
                                padding: "6px 9px",
                                cursor: actionUserId === user.user_id ? "not-allowed" : "pointer",
                                opacity: actionUserId === user.user_id ? 0.65 : 1,
                              }}
                            >
                              {primaryAction.label}
                            </button>
                          ) : null}
                          {typeof onSecondaryAction === "function" ? (
                            <button
                              type="button"
                              onClick={() => onSecondaryAction(user)}
                              disabled={actionUserId === user.user_id}
                              className="ui-archive-button"
                              style={{
                                borderRadius: 6,
                                padding: "6px 9px",
                                cursor: actionUserId === user.user_id ? "not-allowed" : "pointer",
                                opacity: actionUserId === user.user_id ? 0.65 : 1,
                              }}
                            >
                              {secondaryActionLabel}
                            </button>
                          ) : null}
                          <button
                            type="button"
                            onClick={() => onManage(user)}
                            style={{
                              background: "var(--border-base)",
                              color: "var(--text-primary)",
                              border: "none",
                              borderRadius: 6,
                              padding: "6px 9px",
                              cursor: "pointer",
                            }}
                          >
                            Manage
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
