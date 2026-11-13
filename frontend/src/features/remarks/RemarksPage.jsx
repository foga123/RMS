import React, { useEffect, useState } from "react";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import ActionMenu from "../../shared/components/ui/ActionMenu";
import { ManagementPagination } from "../../shared/components/management";
import { SkeletonTableRows } from "../../shared/components/ui/Skeleton";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import { confirmAction } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import GradeRemarkRules from "./GradeRemarkRules";
import AttendanceRemarkRules from "./AttendanceRemarkRules";

const defaultForm = {
  remark_id: "",
  remark_name: "",
  description: "",
  risk_level: "Low Risk",
  applies_to: "any",
  status: 1,
};

/**
 * Three tabs, because naming a remark and deciding who gets it is one job.
 *
 * The vocabulary tab was all this screen used to be: a list of words with a risk
 * level. Nothing on it said when anybody was actually given one -- that lived in
 * grades-import.php as a hardcoded ladder, and for attendance it did not exist
 * at all. So an administrator could invent "Conditional" here and then find no
 * way anywhere in the system to say what made a student conditional.
 *
 * The rules now sit next to the words they hand out. Settings owns which school
 * year is current and can create a policy version, but this is the one place
 * that edits the rules themselves.
 */
const TABS = [
  { key: "vocabulary", label: "Remarks", hint: "The words themselves" },
  { key: "grades", label: "Grade rules", hint: "When a grade row gets each remark" },
  { key: "attendance", label: "Attendance targets", hint: "The absence limit, and the remarks that read it" },
];

/**
 * Which engine may assign a remark.
 *
 * 'any' is the default and every remark that existed before this column did
 * still carries it, so nothing that worked before changed. Classifying one is
 * something a person does on purpose, not something a migration guessed.
 */
const APPLIES_TO = [
  { value: "any", label: "Either engine" },
  { value: "grades", label: "Grades only" },
  { value: "attendance", label: "Attendance only" },
];

const APPLIES_TO_LABEL = Object.fromEntries(APPLIES_TO.map((entry) => [entry.value, entry.label]));

export default function RemarksManagementPage({ permissions = null }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [saving, setSaving] = useState(false);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [form, setForm] = useState({ ...defaultForm });
  const [search, setSearch] = useState("");
  const [riskFilter, setRiskFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [activeTab, setActiveTab] = useState("vocabulary");

  // The load effect already re-runs on refreshKey, so the probe reuses it.
  useLiveRefresh(["remarks"], () => setRefreshKey((current) => current + 1));
  const [viewMode, setViewMode] = useState("active");
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canCreate = hasPermissionContext ? canModuleAction(permissions, "create") : true;
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;
  const canArchive = hasPermissionContext ? canModuleAction(permissions, "archive") : true;
  const canRestore = hasPermissionContext ? canModuleAction(permissions, "restore") : true;

  useEffect(() => {
    if (activeTab !== "vocabulary") return undefined;
    let active = true;

    async function load() {
      setLoading(true);
      setError("");
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("search", search.trim());
        if (riskFilter) params.set("risk_level", riskFilter);
        if (statusFilter) params.set("status", statusFilter);
        params.set("page", String(page));
        params.set("limit", String(limit));
        if (viewMode === "archived") params.set("archived", "1");

        const res = await fetch(getBackendUrl(`remarks.php?${params.toString()}`), {
          credentials: "include",
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.message || "Failed to load remarks");
        if (!active) return;
        setRows(Array.isArray(data.data) ? data.data : []);
        setTotal(typeof data?.pagination?.total === "number" ? data.pagination.total : 0);
      } catch (e) {
        if (!active) return;
        setRows([]);
        setTotal(0);
        setError(e.message || "Failed to load remarks");
      } finally {
        if (active) setLoading(false);
      }
    }

    void load();
    return () => {
      active = false;
    };
  }, [page, limit, search, riskFilter, statusFilter, refreshKey, viewMode, activeTab]);

  async function save() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      if (!String(form.remark_name || "").trim()) throw new Error("Remark name is required");
      if (!String(form.risk_level || "").trim()) throw new Error("Risk level is required");

      const isEdit = !!form.remark_id;
      if (isEdit && !canEdit) throw new Error("No permission for this action.");
      if (!isEdit && !canCreate) throw new Error("No permission for this action.");
      const endpoint = isEdit ? `remarks.php?id=${form.remark_id}` : "remarks.php";
      const payload = {
        remark_name: String(form.remark_name || "").trim(),
        description: String(form.description || "").trim() || null,
        risk_level: String(form.risk_level || "").trim(),
        applies_to: String(form.applies_to || "any"),
        status: Number(form.status) === 2 ? 2 : 1,
      };

      const res = await fetch(getBackendUrl(endpoint), {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save remark");

      setIsModalOpen(false);
      setForm({ ...defaultForm });
      setSuccess(isEdit ? "Remark updated" : "Remark created");
      setRefreshKey((current) => current + 1);
    } catch (e) {
      setError(e.message || "Failed to save remark");
    } finally {
      setSaving(false);
    }
  }

  async function remove(row) {
    if (!canArchive) {
      setError("No permission for this action.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Archive remark?",
      text: `Archive remark "${row.remark_name}"?`,
      confirmButtonText: "Archive",
    });
    if (!confirmed) return;
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl(`remarks.php?id=${row.remark_id}&permission_action=archive`), {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to archive remark");
      setSuccess("Remark archived");
      if (rows.length === 1 && page > 1) {
        setPage((current) => Math.max(1, current - 1));
      } else {
        setRefreshKey((current) => current + 1);
      }
    } catch (e) {
      setError(e.message || "Failed to archive remark");
    }
  }

  async function restore(row) {
    if (!canRestore) {
      setError("No permission for this action.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Restore remark?",
      text: `Restore archived remark "${row.remark_name}"?`,
      confirmButtonText: "Restore",
      confirmButtonColor: "var(--brand-600)",
    });
    if (!confirmed) return;
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl(`remarks.php?id=${row.remark_id}&permission_action=restore`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ archived: false }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || "Failed to restore remark");
      setSuccess("Remark restored");
      if (rows.length === 1 && page > 1) {
        setPage((current) => Math.max(1, current - 1));
      } else {
        setRefreshKey((current) => current + 1);
      }
    } catch (e) {
      setError(e.message || "Failed to restore remark");
    }
  }

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Remarks Management</h2>

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {TABS.map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveTab(tab.key)}
              title={tab.hint}
              style={{
                padding: "7px 13px",
                borderRadius: 8,
                cursor: "pointer",
                fontSize: 12.5,
                fontWeight: isActive ? 600 : 400,
                border: `1px solid ${isActive ? "var(--brand-600)" : "var(--border-base)"}`,
                background: isActive ? "var(--brand-600)" : "#fff",
                color: isActive ? "#fff" : "var(--text-secondary)",
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab !== "vocabulary" ? (
        <div style={{ background: "#fff", border: "1px solid var(--border-base)", borderRadius: 9, padding: 16 }}>
          {activeTab === "grades" ? <GradeRemarkRules canEdit={canEdit} /> : null}
          {activeTab === "attendance" ? <AttendanceRemarkRules canEdit={canEdit} /> : null}
        </div>
      ) : null}

      {activeTab !== "vocabulary" ? null : (
      <>
      {/* One error on screen, never two: while the dialog is open it owns the
          message, and this banner stands down. Same fix as UsersPage — see the
          longer note there. AlertMessage rather than a hand-rolled div, so the
          refusal carries role="alert" and is announced, not just drawn. */}
      {!isModalOpen && <AlertMessage message={error} tone="error" />}
      <AlertMessage message={success} tone="success" />

      {isModalOpen ? (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }} onClick={() => setIsModalOpen(false)}>
          <div style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 527, border: "1px solid var(--border-base)", overflow: "hidden" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong>{form.remark_id ? "Edit Remark" : "Add Remark"}</strong>
              <button onClick={() => setIsModalOpen(false)} style={{ background: "transparent", border: "none", fontSize: 16, cursor: "pointer", color: "var(--text-secondary)" }} aria-label="Close">x</button>
            </div>
            {/* Inside the dialog, because this is where the action was taken. The
                page-level box below is painted UNDER this overlay, so a save the
                server refuses used to look like nothing happening at all. */}
            {error ? (
              <div style={{ flexShrink: 0, padding: "9px 12px 0" }}>
                <AlertMessage message={error} tone="error" style={{ marginBottom: 0 }} />
              </div>
            ) : null}
            <div style={{ padding: 12, display: "grid", gap: 8 }}>
              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Remark Name</label>
                <input value={form.remark_name} onChange={(e) => setForm((current) => ({ ...current, remark_name: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="remarks_mange_input_1" />
              </div>
              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Risk Level</label>
                <select value={form.risk_level} onChange={(e) => setForm((current) => ({ ...current, risk_level: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="remarks_mange_select_1">
                  <option value="Low Risk">Low Risk</option>
                  <option value="Medium Risk">Medium Risk</option>
                  <option value="High Risk">High Risk</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Used by</label>
                <select value={form.applies_to} onChange={(e) => setForm((current) => ({ ...current, applies_to: e.target.value }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="remarks_mange_select_applies">
                  {APPLIES_TO.map((entry) => (
                    <option key={entry.value} value={entry.value}>{entry.label}</option>
                  ))}
                </select>
                <p style={{ fontSize: 10.5, color: "var(--text-muted)", margin: "4px 0 0" }}>
                  Which rule editor offers this remark. &quot;Either&quot; keeps it in both lists.
                </p>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Status</label>
                <select value={String(form.status)} onChange={(e) => setForm((current) => ({ ...current, status: Number(e.target.value) }))} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="remarks_mange_select_2">
                  <option value="1">Active</option>
                  <option value="2">Inactive</option>
                </select>
              </div>
              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Description</label>
                <textarea value={form.description} onChange={(e) => setForm((current) => ({ ...current, description: e.target.value }))} rows={4} style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5, boxSizing: "border-box" }} name="remarks_mange_textarea_1" />
              </div>
            </div>
            <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button onClick={() => setIsModalOpen(false)} style={{ background: "var(--border-base)", color: "var(--text-primary)", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}>Cancel</button>
              <button onClick={save} disabled={saving || (!form.remark_id && !canCreate) || (Boolean(form.remark_id) && !canEdit)} style={{ background: "var(--brand-600)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer" }}>{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      ) : null}

      <div style={{ background: "#fff", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <div style={{ position: "sticky", top: 0, zIndex: 3, background: "#fff", padding: 9, borderBottom: "1px solid var(--border-base)", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 9 }}>
          <strong>{viewMode === "archived" ? "Archived Remarks" : "Remarks"}</strong>
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <input value={search} onChange={(e) => { setPage(1); setSearch(e.target.value); }} placeholder="Search..." style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, minWidth: 170 }} name="remarks_mange_input_2" />
            <select value={riskFilter} onChange={(e) => { setPage(1); setRiskFilter(e.target.value); }} style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="remarks_mange_select_3">
              <option value="">All Risk Levels</option>
              <option value="Low Risk">Low Risk</option>
              <option value="Medium Risk">Medium Risk</option>
              <option value="High Risk">High Risk</option>
            </select>
            <select value={statusFilter} onChange={(e) => { setPage(1); setStatusFilter(e.target.value); }} style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="remarks_mange_select_4">
              <option value="">All Status</option>
              <option value="1">Active</option>
              <option value="2">Inactive</option>
            </select>
            <select value={String(limit)} onChange={(e) => { setPage(1); setLimit(Number(e.target.value)); }} style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="remarks_mange_select_5">
              <option value="10">10</option>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="100">100</option>
            </select>
            <ArchiveViewToggle
              view={viewMode}
              onChange={(nextView) => {
                setPage(1);
                setViewMode(nextView);
              }}
            />
            {viewMode === "active" && canCreate ? (
              <button onClick={() => { setForm({ ...defaultForm }); setIsModalOpen(true); }} style={{ background: "var(--brand-600)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}>+ Add Remark</button>
            ) : null}
          </div>
        </div>

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 221px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>No.</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Remark Name</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Description</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Risk Level</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Used By</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Status</th>
                {viewMode === "archived" ? <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Archived On</th> : null}
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Action</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows columns={viewMode === "archived" ? 8 : 7} />
              ) : rows.length === 0 ? (
                <tr><td colSpan={viewMode === "archived" ? 8 : 7} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>{viewMode === "archived" ? "No archived remarks found" : "No remarks found"}</td></tr>
              ) : (
                rows.map((row, idx) => (
                  <tr key={row.remark_id}>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{(page - 1) * limit + idx + 1}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.remark_name}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.description || "-"}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.risk_level}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: "var(--text-secondary)" }}>{APPLIES_TO_LABEL[row.applies_to] || "Either engine"}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: Number(row.status) === 1 ? "#059669" : "#dc2626" }}>{Number(row.status) === 1 ? "Active" : "Inactive"}</td>
                    {viewMode === "archived" ? (
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.archived_at ? new Date(row.archived_at).toLocaleString() : "-"}</td>
                    ) : null}
                    {/* One kebab, the same control every other management table
                        uses. ActionMenu renders nothing when the list is empty,
                        so a reader with neither right gets a blank cell rather
                        than a button that opens an empty menu. */}
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                      <ActionMenu
                        label={`Actions for ${row.remark_name || "this remark"}`}
                        items={
                          viewMode === "archived"
                            ? canRestore
                              ? [{ key: "restore", label: "Restore", icon: "archiveRestore", tone: "brand", onSelect: () => void restore(row) }]
                              : []
                            : [
                                ...(canEdit
                                  ? [{
                                      key: "edit",
                                      label: "Edit",
                                      icon: "edit",
                                      onSelect: () => {
                                        setForm({
                                          remark_id: row.remark_id,
                                          remark_name: row.remark_name || "",
                                          description: row.description || "",
                                          risk_level: row.risk_level || "Low Risk",
                                          applies_to: row.applies_to || "any",
                                          status: Number(row.status) === 2 ? 2 : 1,
                                        });
                                        setIsModalOpen(true);
                                      },
                                    }]
                                  : []),
                                ...(canArchive
                                  ? [{ key: "archive", label: "Archive", icon: "archive", tone: "danger", onSelect: () => void remove(row) }]
                                  : []),
                              ]
                        }
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ padding: 9, borderTop: "1px solid var(--border-base)" }}>
          <ManagementPagination
            page={page}
            limit={limit}
            total={total}
            onPageChange={setPage}
            onLimitChange={(size) => {
              setLimit(size);
              setPage(1);
            }}
            itemLabel="remarks"
          />
        </div>
      </div>
      </>
      )}
    </section>
  );
}
