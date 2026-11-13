import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import {
  default as Form,
  FormActions,
  FormField,
  InputControl,
  SelectControl,
} from "../../shared/components/Form";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import { ManagementPage, ManagementPagination, ManagementTableCard, ManagementToolbar } from "../../shared/components/management";
import Modal from "../../shared/components/Modal";
import { Button } from "../../shared/components/ui";
import { confirmAction } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";

const emptyForm = {
  department_id: "",
  department_name: "",
  department_code: "",
  campus_id: "",
};

export default function DepartmentManagementPage({ permissions = null }) {
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
  const [form, setForm] = useState(emptyForm);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [campuses, setCampuses] = useState([]);
  const [campusLoading, setCampusLoading] = useState(false);
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canCreate = hasPermissionContext ? canModuleAction(permissions, "create") : true;
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;
  const canArchive = hasPermissionContext ? canModuleAction(permissions, "archive") : true;
  const canRestore = hasPermissionContext ? canModuleAction(permissions, "restore") : true;

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

      const res = await fetch(getBackendUrl(`department.php?${params.toString()}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load departments");

      if (!isCurrent()) return;

      setRows(Array.isArray(data.data) ? data.data : []);
      setTotal(Number(data?.pagination?.total || 0));
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setTotal(0);
      setError(e.message || "Failed to load departments");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, limit, page, search, viewMode]);

  useLiveRefresh(["departments", "campuses"], load);

  const loadCampuses = useCallback(async () => {
    setCampusLoading(true);
    try {
      const res = await fetch(getBackendUrl("campus.php"));
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load campuses");
      setCampuses(Array.isArray(data.data) ? data.data : []);
    } catch (e) {
      setCampuses([]);
      setError(e.message || "Failed to load campuses");
    } finally {
      setCampusLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadCampuses();
  }, [loadCampuses]);

  const campusNameById = useMemo(() => {
    const map = {};
    campuses.forEach((campus) => {
      if (campus?.campus_id != null) {
        map[String(campus.campus_id)] = campus.campus_name || `Campus ${campus.campus_id}`;
      }
    });
    return map;
  }, [campuses]);

  const openCreateModal = useCallback(() => {
    if (!canCreate) {
      setError("No permission for this action.");
      return;
    }
    setForm(emptyForm);
    setIsModalOpen(true);
  }, [canCreate]);

  const openEditModal = useCallback((row) => {
    if (!canEdit) {
      setError("No permission for this action.");
      return;
    }
    setForm({
      department_id: row?.department_id ?? "",
      department_name: row?.department_name || "",
      department_code: row?.department_code || "",
      campus_id: row?.campus_id != null ? String(row.campus_id) : "",
    });
    setIsModalOpen(true);
  }, [canEdit]);

  const saveDepartment = useCallback(async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const isEdit = Boolean(form.department_id);
      if (isEdit && !canEdit) throw new Error("No permission for this action.");
      if (!isEdit && !canCreate) throw new Error("No permission for this action.");
      const payload = {
        department_name: String(form.department_name || "").trim(),
        department_code: String(form.department_code || "").trim(),
        campus_id: form.campus_id ? Number(form.campus_id) : undefined,
      };

      if (!payload.department_name) throw new Error("Department name is required");
      if (!payload.department_code) throw new Error("Department code is required");

      const res = await fetch(getBackendUrl(`department.php${isEdit ? `?id=${encodeURIComponent(form.department_id)}` : ""}`), {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save department");

      setSuccess(isEdit ? "Department updated." : "Department created.");
      setForm(emptyForm);
      setIsModalOpen(false);
      await load();
    } catch (e) {
      setError(e.message || "Failed to save department");
    } finally {
      setSaving(false);
    }
  }, [canCreate, canEdit, form, load]);

  const removeDepartment = useCallback(
    async (departmentId) => {
      if (!canArchive) {
        setError("No permission for this action.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Archive department?",
        text: "Archive this department?",
        confirmButtonText: "Archive",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`department.php?id=${encodeURIComponent(departmentId)}&permission_action=archive`), {
          method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to archive department");

        setSuccess("Department archived.");
        if (rows.length === 1 && page > 1) {
          setPage((value) => Math.max(1, value - 1));
        } else {
          await load();
        }
      } catch (e) {
        setError(e.message || "Failed to archive department");
      }
    },
    [canArchive, load, page, rows.length]
  );

  const restoreDepartment = useCallback(
    async (departmentId) => {
      if (!canRestore) {
        setError("No permission for this action.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Restore department?",
        text: "Restore this archived department?",
        confirmButtonText: "Restore",
        confirmButtonColor: "var(--brand-600)",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`department.php?id=${encodeURIComponent(departmentId)}&permission_action=restore`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: false }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to restore department");

        setSuccess("Department restored.");
        if (rows.length === 1 && page > 1) {
          setPage((value) => Math.max(1, value - 1));
        } else {
          await load();
        }
      } catch (e) {
        setError(e.message || "Failed to restore department");
      }
    },
    [canRestore, load, page, rows.length]
  );

  const tableRows = useMemo(
    () =>
      rows.map((row, index) => ({
        ...row,
        id: row?.department_id ?? index,
        display_no: (page - 1) * limit + index + 1,
        display_code: row?.department_code || "-",
        display_campus: row?.campus_name || campusNameById[String(row?.campus_id)] || "-",
        display_archived_at: row?.archived_at ? new Date(row.archived_at).toLocaleString() : "-",
      })),
    [campusNameById, limit, page, rows]
  );

  const columns = useMemo(
    () => {
      const baseColumns = [
        { key: "display_no", label: "No." },
        { key: "department_name", label: "Department" },
        { key: "display_code", label: "Code" },
        { key: "display_campus", label: "Campus" },
      ];

      if (viewMode === "archived") {
        if (!canRestore) {
          return [...baseColumns, { key: "display_archived_at", label: "Archived On" }];
        }

        return [
          ...baseColumns,
          { key: "display_archived_at", label: "Archived On" },
          {
            key: "action",
            label: "Action",
            render: (row) => (
              <Button
                size="sm"
                onClick={() => void restoreDepartment(row?.department_id)}
                style={{ background: "var(--brand-600)", borderColor: "var(--brand-600)", color: "var(--surface-base)" }}
              >
                Restore
              </Button>
            ),
          },
        ];
      }

      if (!canEdit && !canArchive) {
        return baseColumns;
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
                  Edit
                </Button>
              ) : null}
              {canArchive ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => void removeDepartment(row?.department_id)}
                  className="ui-archive-button"
                >
                  Archive
                </Button>
              ) : null}
            </div>
          ),
        },
      ];
    },
    [canArchive, canEdit, canRestore, openEditModal, removeDepartment, restoreDepartment, viewMode]
  );

  return (
    <ManagementPage title="Departments" error={error} success={success}>
      <ManagementTableCard
        title={viewMode === "archived" ? "Archived Departments" : "All Departments"}
        actions={(
          <ManagementToolbar
            search={search}
            onSearchChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            searchPlaceholder="Search department..."
            actionLabel={viewMode === "active" && canCreate ? "Add Department" : undefined}
            onAction={viewMode === "active" && canCreate ? openCreateModal : undefined}
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
        emptyText={viewMode === "archived" ? "No archived departments found." : "No departments found."}
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
            itemLabel="departments"
          />
        )}
      />

      <Modal open={isModalOpen} title={form.department_id ? "Edit Department" : "Add Department"} onClose={() => setIsModalOpen(false)} width={442} error={error}>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void saveDepartment();
          }}
          style={{ gap: 11 }}
        >
          <FormField label="Department Name" htmlFor="department_name" required>
            <InputControl
              id="department_name"
              value={form.department_name}
              onChange={(event) => setForm((current) => ({ ...current, department_name: event.target.value }))}
              name="department_manage_name"
            />
          </FormField>

          <FormField label="Department Code" htmlFor="department_code" required>
            <InputControl
              id="department_code"
              value={form.department_code}
              onChange={(event) => setForm((current) => ({ ...current, department_code: event.target.value }))}
              name="department_manage_code"
            />
          </FormField>

          <FormField label="Campus" htmlFor="department_campus">
            <SelectControl
              id="department_campus"
              value={form.campus_id}
              onChange={(event) => setForm((current) => ({ ...current, campus_id: event.target.value }))}
              disabled={campusLoading}
              name="department_manage_campus"
            >
              <option value="">{campusLoading ? "Loading..." : "Select campus..."}</option>
              {campuses.map((campus) => (
                <option key={campus.campus_id} value={campus.campus_id}>
                  {campus.campus_name}
                </option>
              ))}
            </SelectControl>
          </FormField>

          <FormActions>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
             <Button type="submit" disabled={saving || (!form.department_id && !canCreate) || (Boolean(form.department_id) && !canEdit)}>
               {saving ? "Saving..." : "Save"}
             </Button>
          </FormActions>
        </Form>
      </Modal>
    </ManagementPage>
  );
}
