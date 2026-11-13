import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import Form, { FormActions, FormField, InputControl, TextareaControl } from "../../shared/components/Form/Form";
import { ManagementPage, ManagementPagination, ManagementTableCard, ManagementToolbar } from "../../shared/components/management/ManagementPage";
import Modal from "../../shared/components/Modal/Modal";
import Button from "../../shared/components/ui/Button";
import Icon from "../../shared/components/ui/Icon";
import { confirmAction } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";

const emptyForm = {
  role_id: "",
  role_name: "",
  description: "",
};

export default function RoleManagementView({ permissions = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("active");
  const [form, setForm] = useState({ ...emptyForm });
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const canCreate = permissions ? canModuleAction(permissions, "create") : true;
  const canEdit = permissions ? canModuleAction(permissions, "edit") : true;
  const canArchive = permissions ? canModuleAction(permissions, "archive") : true;
  const canRestore = permissions ? canModuleAction(permissions, "restore") : true;

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");

    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (search.trim()) params.set("search", search.trim());
      if (viewMode === "archived") params.set("archived", "1");

      const res = await fetch(getBackendUrl(`roles.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load roles");

      if (!isCurrent()) return;

      setRows(Array.isArray(data.data) ? data.data : []);
      setTotal(Number(data?.pagination?.total || 0));
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setTotal(0);
      setError(e.message || "Failed to load roles");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, limit, page, search, viewMode]);

  useLiveRefresh(["roles"], load);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreateModal = useCallback(() => {
    if (!canCreate) {
      setError("You do not have permission to create roles.");
      return;
    }

    setForm({ ...emptyForm });
    setIsModalOpen(true);
  }, [canCreate]);

  const openEditModal = useCallback((row) => {
    if (!canEdit) {
      setError("You do not have permission to edit roles.");
      return;
    }

    setForm({
      role_id: row?.role_id ?? "",
      role_name: row?.role_name || "",
      description: row?.description || "",
    });
    setIsModalOpen(true);
  }, [canEdit]);

  const saveRole = useCallback(async () => {
    setSaving(true);
    setError("");
    setSuccess("");

    try {
      const isEdit = Boolean(form.role_id);
      if (isEdit && !canEdit) throw new Error("You do not have permission to edit roles.");
      if (!isEdit && !canCreate) throw new Error("You do not have permission to create roles.");

      const payload = {
        role_name: String(form.role_name || "").trim(),
        description: String(form.description || "").trim() || null,
      };

      if (!payload.role_name) throw new Error("Role name is required");

      const res = await fetch(getBackendUrl(`roles.php${isEdit ? `?id=${encodeURIComponent(form.role_id)}` : ""}`), {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save role");

      setSuccess(isEdit ? "Role updated." : "Role created.");
      setForm({ ...emptyForm });
      setIsModalOpen(false);
      await load();
    } catch (e) {
      setError(e.message || "Failed to save role");
    } finally {
      setSaving(false);
    }
  }, [canCreate, canEdit, form, load]);

  const removeRole = useCallback(
    async (roleId) => {
      if (!canArchive) {
        setError("You do not have permission to archive roles.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Archive role?",
        text: "Archive this role?",
        confirmButtonText: "Archive",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");

      try {
        const res = await fetch(getBackendUrl(`roles.php?id=${encodeURIComponent(roleId)}&permission_action=archive`), {
          method: "DELETE",
          credentials: "include",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to archive role");

        setSuccess("Role archived.");
        if (rows.length === 1 && page > 1) {
          setPage((value) => Math.max(1, value - 1));
        } else {
          await load();
        }
      } catch (e) {
        setError(e.message || "Failed to archive role");
      }
    },
    [canArchive, load, page, rows.length]
  );

  const restoreRole = useCallback(
    async (roleId) => {
      if (!canRestore) {
        setError("You do not have permission to restore roles.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Restore role?",
        text: "Restore this archived role?",
        confirmButtonText: "Restore",
        confirmButtonColor: "var(--brand-600)",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`roles.php?id=${encodeURIComponent(roleId)}&permission_action=restore`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ archived: false }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to restore role");

        setSuccess("Role restored.");
        if (rows.length === 1 && page > 1) {
          setPage((value) => Math.max(1, value - 1));
        } else {
          await load();
        }
      } catch (e) {
        setError(e.message || "Failed to restore role");
      }
    },
    [canRestore, load, page, rows.length]
  );

  const tableRows = useMemo(
    () =>
      rows.map((row, index) => ({
        ...row,
        id: row?.role_id ?? index,
        display_no: (page - 1) * limit + index + 1,
        display_description: row?.description || "-",
        display_archived_at: row?.archived_at ? new Date(row.archived_at).toLocaleString() : "-",
      })),
    [limit, page, rows]
  );

  const columns = useMemo(() => {
    const baseColumns = [
      { key: "display_no", label: "No." },
      { key: "role_name", label: "Role" },
      { key: "display_description", label: "Description" },
    ];

    if (viewMode === "archived") {
      return [
        ...baseColumns,
        { key: "display_archived_at", label: "Archived On" },
        {
          key: "action",
          label: "Action",
          render: (row) => (
            canRestore ? (
              <Button
                size="sm"
                onClick={() => void restoreRole(row?.role_id)}
                style={{ background: "var(--brand-600)", borderColor: "var(--brand-600)", color: "var(--surface-base)" }}
              >
                <Icon name="archiveRestore" size={12} />
                <span>Restore</span>
              </Button>
            ) : (
              <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>No access</span>
            )
          ),
        },
      ];
    }

    return [
      ...baseColumns,
      {
        key: "action",
        label: "Action",
        render: (row) => (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {canEdit ? (
              <Button
                size="sm"
                onClick={() => openEditModal(row)}
                style={{ background: "var(--info-500)", borderColor: "var(--info-500)", color: "var(--surface-base)" }}
              >
                <Icon name="edit" size={12} />
                <span>Edit</span>
              </Button>
            ) : null}
            {canArchive ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => void removeRole(row?.role_id)}
                className="ui-archive-button"
              >
                <Icon name="archive" size={12} />
                <span>Archive</span>
              </Button>
            ) : null}
            {!canEdit && !canArchive ? (
              <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>No access</span>
            ) : null}
          </div>
        ),
      },
    ];
  }, [canArchive, canEdit, canRestore, openEditModal, removeRole, restoreRole, viewMode]);

  return (
    <ManagementPage title="Roles" error={error} success={success}>
      <ManagementTableCard
        title={viewMode === "archived" ? "Archived Roles" : "All Roles"}
        actions={(
          <ManagementToolbar
            search={search}
            onSearchChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            searchPlaceholder="Search role..."
            actionLabel={viewMode === "active" && canCreate ? "Add Role" : undefined}
            onAction={canCreate ? openCreateModal : undefined}
          >
            <ArchiveViewToggle
              view={viewMode}
              onChange={(nextView) => {
                setPage(1);
                setViewMode(nextView);
              }}
            />
          </ManagementToolbar>
        )}
        columns={columns}
        rows={tableRows}
        loading={loading}
        emptyText={viewMode === "archived" ? "No archived roles found." : "No roles found."}
        footer={(
          <ManagementPagination
            page={page}
            limit={limit}
            total={total}
            onPageChange={setPage}
            onLimitChange={(size) => {
              setLimit(size);
              setPage(1);
            }}
            itemLabel="roles"
          />
        )}
      />

      <Modal open={isModalOpen} title={form.role_id ? "Edit Role" : "Add Role"} onClose={() => setIsModalOpen(false)} width={442} error={error}>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void saveRole();
          }}
          style={{ gap: 11 }}
        >
          <FormField label="Role Name" htmlFor="role_name" required>
            <InputControl
              id="role_name"
              value={form.role_name}
              onChange={(event) => setForm((current) => ({ ...current, role_name: event.target.value }))}
              name="role_manage_name"
            />
          </FormField>

          <FormField label="Description" htmlFor="role_description">
            <TextareaControl
              id="role_description"
              rows={3}
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
              name="role_manage_description"
            />
          </FormField>

          <FormActions>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </FormActions>
        </Form>
      </Modal>
    </ManagementPage>
  );
}
