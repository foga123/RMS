import React, { useCallback, useEffect, useMemo, useState } from "react";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import {
  default as Form,
  FormActions,
  FormField,
  InputControl,
  TextareaControl,
} from "../../shared/components/Form";
import { ManagementPage, ManagementPagination, ManagementTableCard, ManagementToolbar } from "../../shared/components/management";
import Modal from "../../shared/components/Modal";
import { Button, Icon } from "../../shared/components/ui";
import { confirmAction } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";

const emptyForm = {
  campus_id: "",
  campus_name: "",
  campus_code: "",
  address: "",
};

export default function CampusManagementPage({ permissions = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [search, setSearch] = useState("");
  const [form, setForm] = useState(emptyForm);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const canCreate = permissions ? canModuleAction(permissions, "create") : true;
  const canEdit = permissions ? canModuleAction(permissions, "edit") : true;
  const canDelete = permissions ? canModuleAction(permissions, "delete") : true;
  const isViewOnly = permissions && !canCreate && !canEdit && !canDelete;

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

      const res = await fetch(getBackendUrl(`campus.php?${params.toString()}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load campuses");

      if (!isCurrent()) return;

      setRows(Array.isArray(data.data) ? data.data : []);
      setTotal(Number(data?.pagination?.total || 0));
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setTotal(0);
      setError(e.message || "Failed to load campuses");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, limit, page, search]);

  useLiveRefresh(["campuses"], load);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreateModal = useCallback(() => {
    if (!canCreate) {
      setError("You only have view access for campuses.");
      setSuccess("");
      return;
    }
    setForm(emptyForm);
    setIsModalOpen(true);
  }, [canCreate]);

  const openEditModal = useCallback((row) => {
    if (!canEdit) {
      setError("You do not have permission to edit campuses.");
      setSuccess("");
      return;
    }
    setForm({
      campus_id: row?.campus_id ?? "",
      campus_name: row?.campus_name || "",
      campus_code: row?.campus_code || "",
      address: row?.address || "",
    });
    setIsModalOpen(true);
  }, [canEdit]);

  const saveCampus = useCallback(async () => {
    const isEdit = Boolean(form.campus_id);
    if (isEdit && !canEdit) {
      setError("You do not have permission to edit campuses.");
      setSuccess("");
      return;
    }
    if (!isEdit && !canCreate) {
      setError("You do not have permission to create campuses.");
      setSuccess("");
      return;
    }

    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const payload = {
        campus_name: String(form.campus_name || "").trim(),
        campus_code: String(form.campus_code || "").trim() || null,
        address: String(form.address || "").trim() || null,
      };

      if (!payload.campus_name) throw new Error("Campus name is required");

      const res = await fetch(getBackendUrl(`campus.php${isEdit ? `?id=${encodeURIComponent(form.campus_id)}` : ""}`), {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save campus");

      setSuccess(isEdit ? "Campus updated." : "Campus created.");
      setForm(emptyForm);
      setIsModalOpen(false);
      await load();
    } catch (e) {
      setError(e.message || "Failed to save campus");
    } finally {
      setSaving(false);
    }
  }, [canCreate, canEdit, form, load]);

  const removeCampus = useCallback(
    async (campusId) => {
      if (!canDelete) {
        setError("You do not have permission to delete campuses.");
        setSuccess("");
        return;
      }

      const confirmed = await confirmAction({
        title: "Remove campus?",
        text: "Remove this campus?",
        confirmButtonText: "Remove",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`campus.php?id=${encodeURIComponent(campusId)}`), {
          method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to delete campus");

        setSuccess("Campus deleted.");
        await load();
      } catch (e) {
        setError(e.message || "Failed to delete campus");
      }
    },
    [canDelete, load]
  );

  const tableRows = useMemo(
    () =>
      rows.map((row, index) => ({
        ...row,
        display_no: (page - 1) * limit + index + 1,
        display_code: row?.campus_code || "-",
        display_address: row?.address || "-",
      })),
    [limit, page, rows]
  );

  const columns = useMemo(
    () => [
      { key: "display_no", label: "No." },
      { key: "campus_name", label: "Name" },
      { key: "display_code", label: "Code" },
      { key: "display_address", label: "Address" },
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
            {canDelete ? (
              <Button size="sm" variant="danger" onClick={() => void removeCampus(row?.campus_id)}>
                <Icon name="delete" size={12} />
                <span>Delete</span>
              </Button>
            ) : null}
            {!canEdit && !canDelete ? (
              <span style={{ color: "var(--text-muted)", fontSize: 11.5, fontWeight: 600 }}>View only</span>
            ) : null}
          </div>
        ),
      },
    ],
    [canDelete, canEdit, openEditModal, removeCampus]
  );

  return (
    <ManagementPage
      title="Campuses"
      error={error}
      success={success}
      warning={isViewOnly ? "This module is currently view-only for your role." : ""}
    >
      <ManagementTableCard
        title="All Campuses"
        actions={(
          <ManagementToolbar
            search={search}
            onSearchChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            searchPlaceholder="Search campus..."
            actionLabel={canCreate ? "Add Campus" : ""}
            onAction={canCreate ? openCreateModal : undefined}
          />
        )}
        columns={columns}
        rows={tableRows}
        loading={loading}
        emptyText="No campuses found."
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
            itemLabel="campuses"
          />
        )}
      />

      <Modal open={isModalOpen} title={form.campus_id ? "Edit Campus" : "Add Campus"} onClose={() => setIsModalOpen(false)} width={442} error={error}>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void saveCampus();
          }}
          style={{ gap: 11 }}
        >
          <FormField label="Campus Name" htmlFor="campus_name" required>
            <InputControl
              id="campus_name"
              value={form.campus_name}
              onChange={(event) => setForm((current) => ({ ...current, campus_name: event.target.value }))}
              name="campus_manage_name"
            />
          </FormField>

          <FormField label="Campus Code" htmlFor="campus_code">
            <InputControl
              id="campus_code"
              value={form.campus_code}
              onChange={(event) => setForm((current) => ({ ...current, campus_code: event.target.value }))}
              name="campus_manage_code"
            />
          </FormField>

          <FormField label="Address" htmlFor="campus_address">
            <TextareaControl
              id="campus_address"
              rows={3}
              value={form.address}
              onChange={(event) => setForm((current) => ({ ...current, address: event.target.value }))}
              name="campus_manage_address"
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
