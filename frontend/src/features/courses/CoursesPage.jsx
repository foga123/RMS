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
  course_id: "",
  course_name: "",
  course_code: "",
  department_id: "",
};

export default function CourseManagementPage({ permissions = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [departments, setDepartments] = useState([]);
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
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canCreate = hasPermissionContext ? canModuleAction(permissions, "create") : true;
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;
  const canArchive = hasPermissionContext ? canModuleAction(permissions, "archive") : true;
  const canRestore = hasPermissionContext ? canModuleAction(permissions, "restore") : true;

  const departmentNameById = useMemo(() => {
    const map = {};
    departments.forEach((department) => {
      if (department?.department_id != null) {
        map[String(department.department_id)] = department.department_name || `Department ${department.department_id}`;
      }
    });
    return map;
  }, [departments]);

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

      const res = await fetch(getBackendUrl(`course.php?${params.toString()}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load courses");

      if (!isCurrent()) return;

      setRows(Array.isArray(data.data) ? data.data : []);
      setTotal(Number(data?.pagination?.total || 0));
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setTotal(0);
      setError(e.message || "Failed to load courses");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, limit, page, search, viewMode]);

  useLiveRefresh(["courses", "departments"], load);

  const loadDepartments = useCallback(async () => {
    try {
      const res = await fetch(getBackendUrl("department.php?limit=9999"));
      const data = await res.json();
      setDepartments(res.ok && Array.isArray(data.data) ? data.data : []);
    } catch {
      setDepartments([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadDepartments();
  }, [loadDepartments]);

  const openCreateModal = useCallback(() => {
    if (!canCreate) {
      setError("No permission for this action.");
      return;
    }
    setForm({
      ...emptyForm,
      department_id: departments[0]?.department_id ? String(departments[0].department_id) : "",
    });
    setIsModalOpen(true);
  }, [canCreate, departments]);

  const openEditModal = useCallback((row) => {
    if (!canEdit) {
      setError("No permission for this action.");
      return;
    }
    setForm({
      course_id: row?.course_id ?? "",
      course_name: row?.course_name || "",
      course_code: row?.course_code || "",
      department_id: row?.department_id != null ? String(row.department_id) : "",
    });
    setIsModalOpen(true);
  }, [canEdit]);

  const saveCourse = useCallback(async () => {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const isEdit = Boolean(form.course_id);
      if (isEdit && !canEdit) throw new Error("No permission for this action.");
      if (!isEdit && !canCreate) throw new Error("No permission for this action.");
      const payload = {
        course_name: String(form.course_name || "").trim(),
        course_code: String(form.course_code || "").trim(),
        department_id: form.department_id ? Number(form.department_id) : null,
      };

      if (!payload.course_name) throw new Error("Course name is required");
      if (!payload.course_code) throw new Error("Course code is required");

      const res = await fetch(getBackendUrl(`course.php${isEdit ? `?id=${encodeURIComponent(form.course_id)}` : ""}`), {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save course");

      setSuccess(isEdit ? "Course updated." : "Course created.");
      setForm(emptyForm);
      setIsModalOpen(false);
      await load();
    } catch (e) {
      setError(e.message || "Failed to save course");
    } finally {
      setSaving(false);
    }
  }, [canCreate, canEdit, form, load]);

  const removeCourse = useCallback(
    async (courseId) => {
      if (!canArchive) {
        setError("No permission for this action.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Archive course?",
        text: "Archive this course?",
        confirmButtonText: "Archive",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`course.php?id=${encodeURIComponent(courseId)}&permission_action=archive`), {
          method: "DELETE",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to archive course");

        setSuccess("Course archived.");
        if (rows.length === 1 && page > 1) {
          setPage((value) => Math.max(1, value - 1));
        } else {
          await load();
        }
      } catch (e) {
        setError(e.message || "Failed to archive course");
      }
    },
    [canArchive, load, page, rows.length]
  );

  const restoreCourse = useCallback(
    async (courseId) => {
      if (!canRestore) {
        setError("No permission for this action.");
        return;
      }

      const confirmed = await confirmAction({
        title: "Restore course?",
        text: "Restore this archived course?",
        confirmButtonText: "Restore",
        confirmButtonColor: "var(--brand-600)",
      });
      if (!confirmed) return;

      setError("");
      setSuccess("");
      try {
        const res = await fetch(getBackendUrl(`course.php?id=${encodeURIComponent(courseId)}&permission_action=restore`), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ archived: false }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to restore course");

        setSuccess("Course restored.");
        if (rows.length === 1 && page > 1) {
          setPage((value) => Math.max(1, value - 1));
        } else {
          await load();
        }
      } catch (e) {
        setError(e.message || "Failed to restore course");
      }
    },
    [canRestore, load, page, rows.length]
  );

  const tableRows = useMemo(
    () =>
      rows.map((row, index) => ({
        ...row,
        id: row?.course_id ?? index,
        display_no: (page - 1) * limit + index + 1,
        display_code: row?.course_code || "-",
        display_department: row?.department_name || departmentNameById[String(row?.department_id)] || "-",
        display_archived_at: row?.archived_at ? new Date(row.archived_at).toLocaleString() : "-",
      })),
    [departmentNameById, limit, page, rows]
  );

  const columns = useMemo(
    () => {
      const baseColumns = [
        { key: "display_no", label: "No." },
        { key: "course_name", label: "Course" },
        { key: "display_code", label: "Course Code" },
        { key: "display_department", label: "Department" },
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
                onClick={() => void restoreCourse(row?.course_id)}
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
                  onClick={() => void removeCourse(row?.course_id)}
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
    [canArchive, canEdit, canRestore, openEditModal, removeCourse, restoreCourse, viewMode]
  );

  return (
    <ManagementPage title="Courses" error={error} success={success}>
      <ManagementTableCard
        title={viewMode === "archived" ? "Archived Courses" : "All Courses"}
        actions={(
          <ManagementToolbar
            search={search}
            onSearchChange={(event) => {
              setPage(1);
              setSearch(event.target.value);
            }}
            searchPlaceholder="Search course..."
            actionLabel={viewMode === "active" && canCreate ? "Add Course" : undefined}
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
        emptyText={viewMode === "archived" ? "No archived courses found." : "No courses found."}
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
            itemLabel="courses"
          />
        )}
      />

      <Modal open={isModalOpen} title={form.course_id ? "Edit Course" : "Add Course"} onClose={() => setIsModalOpen(false)} width={442} error={error}>
        <Form
          onSubmit={(event) => {
            event.preventDefault();
            void saveCourse();
          }}
          style={{ gap: 11 }}
        >
          <FormField label="Course Name" htmlFor="course_name" required>
            <InputControl
              id="course_name"
              value={form.course_name}
              onChange={(event) => setForm((current) => ({ ...current, course_name: event.target.value }))}
              name="course_manage_name"
            />
          </FormField>

          <FormField label="Course Code" htmlFor="course_code" required>
            <InputControl
              id="course_code"
              value={form.course_code}
              onChange={(event) => setForm((current) => ({ ...current, course_code: event.target.value }))}
              name="course_manage_code"
            />
          </FormField>

          <FormField label="Department" htmlFor="course_department">
            <SelectControl
              id="course_department"
              value={form.department_id}
              onChange={(event) => setForm((current) => ({ ...current, department_id: event.target.value }))}
              name="course_manage_department"
            >
              <option value="">Select department</option>
              {departments.map((department) => (
                <option key={department.department_id} value={department.department_id}>
                  {department.department_name}
                </option>
              ))}
            </SelectControl>
          </FormField>

          <FormActions>
            <Button variant="secondary" onClick={() => setIsModalOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || (!form.course_id && !canCreate) || (Boolean(form.course_id) && !canEdit)}>
              {saving ? "Saving..." : "Save"}
            </Button>
          </FormActions>
        </Form>
      </Modal>
    </ManagementPage>
  );
}
