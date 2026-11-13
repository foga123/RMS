import React, { useCallback, useEffect, useMemo, useState } from "react";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import ActionMenu from "../../shared/components/ui/ActionMenu";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import { SkeletonTableRows } from "../../shared/components/ui/Skeleton";
import ArchiveViewToggle from "../../shared/components/management/ArchiveViewToggle";
import { confirmAction } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import { statusGuardReason, isFinanceBand, formatBandRange } from "../../shared/lib/statusGuards";
import { addElsewhereHint, addableTypes, groupStatusesByType } from "../../shared/lib/statusTypes";
import SectionHeader from "../../shared/components/ui/SectionHeader";


const emptyForm = { status_id: "", status_name: "", status_type: "" };

export default function StatusManage({ permissions = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  // Which types exist and what reads them. Served with the list rather than
  // duplicated here — see shared/lib/statusTypes.js.
  const [types, setTypes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [search, setSearch] = useState("");
  const [viewMode, setViewMode] = useState("active");
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canCreate = hasPermissionContext ? canModuleAction(permissions, "create") : true;
  const canEdit = hasPermissionContext ? canModuleAction(permissions, "edit") : true;
  const canArchive = hasPermissionContext ? canModuleAction(permissions, "archive") : true;
  const canRestore = hasPermissionContext ? canModuleAction(permissions, "restore") : true;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((row) =>
      String(row.status_name || "").toLowerCase().includes(q) ||
      String(row.status_type || "").toLowerCase().includes(q) ||
      String(row.status_id || "").toLowerCase().includes(q)
    );
  }, [rows, search]);

  /*
   * Empty groups are kept on the active view so a module with no statuses yet
   * still shows its heading and its Add button — that is precisely where
   * somebody goes looking. While searching they are dropped: a screen of empty
   * headings is not a search result.
   */
  // No., Name, Balance range, [Archived On], Action — the group headings span
  // all of them.
  const columnCount = viewMode === "archived" ? 5 : 4;

  const grouped = useMemo(
    () => groupStatusesByType(filtered, types, { keepEmpty: viewMode === "active" && !search.trim() }),
    [filtered, types, viewMode, search]
  );

  const selectedType = useMemo(
    () => (Array.isArray(types) ? types : []).find((t) => t.key === String(form.status_type || "").trim().toLowerCase()) || null,
    [types, form.status_type]
  );

  /*
   * Normally the types you may create. The exception is editing a row whose
   * type is not one of them — a balance band — where the select would otherwise
   * be blank and the first change would move the band out of the finance
   * ladder, leaving a range of balances belonging to no band. It shows that one
   * type and is disabled, so the name stays editable and the type does not.
   */
  const typeOptions = useMemo(() => {
    const addable = addableTypes(types);
    const current = String(form.status_type || "").trim().toLowerCase();
    if (!current || addable.some((t) => t.key === current)) return addable;
    return selectedType ? [selectedType] : addable;
  }, [types, form.status_type, selectedType]);

  const typeLocked = !!form.status_id && !!selectedType && (selectedType.can_add ?? true) === false;

  const load = useCallback(async () => {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change, so a slower earlier request must not land last. See
    // useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      if (viewMode === "archived") params.set("archived", "1");
      const query = params.toString();
      const res = await fetch(getBackendUrl(`status.php${query ? `?${query}` : ""}`));
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to load statuses");
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      if (!isCurrent()) return;
      setRows(arr);
      // An older backend does not send this. Grouping then falls back to one
      // heading per type found in the rows, which is still better than none.
      if (Array.isArray(data?.types)) setTypes(data.types);
    } catch (e) {
      if (!isCurrent()) return;
      setRows([]);
      setError(e.message || "Failed to load statuses");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }, [beginRequest, viewMode]);

  useLiveRefresh(["statuses"], load);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setSaving(true);
    setError("");
    setSuccess("");
    try {
      const isEdit = !!form.status_id;
      if (isEdit && !canEdit) throw new Error("No permission for this action.");
      if (!isEdit && !canCreate) throw new Error("No permission for this action.");
      const payload = {
        status_name: String(form.status_name || "").trim(),
        status_type: String(form.status_type || "").trim(),
      };
      if (!payload.status_name) throw new Error("Status name is required");
      if (!payload.status_type) throw new Error("Status type is required");

      const url = getBackendUrl(`status.php${isEdit ? `?id=${form.status_id}` : ""}`);
      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to save status");
      setIsModalOpen(false);
      setForm(emptyForm);
      setSuccess(isEdit ? "Status updated" : "Status created");
      await load();
    } catch (e) {
      setError(e.message || "Failed to save status");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!canArchive) {
      setError("No permission for this action.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Archive status?",
      text: "Archive this status?",
      confirmButtonText: "Archive",
    });
    if (!confirmed) return;
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl(`status.php?id=${id}&permission_action=archive`), { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to archive status");
      setSuccess("Status archived");
      await load();
    } catch (e) {
      setError(e.message || "Failed to archive status");
    }
  }

  async function restore(id) {
    if (!canRestore) {
      setError("No permission for this action.");
      return;
    }

    const confirmed = await confirmAction({
      title: "Restore status?",
      text: "Restore this archived status?",
      confirmButtonText: "Restore",
      confirmButtonColor: "var(--brand-600)",
    });
    if (!confirmed) return;
    setError("");
    setSuccess("");
    try {
      const res = await fetch(getBackendUrl(`status.php?id=${id}&permission_action=restore`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: false }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to restore status");
      setSuccess("Status restored");
      await load();
    } catch (e) {
      setError(e.message || "Failed to restore status");
    }
  }

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Status Management</h2>
      {/* One error on screen at a time. While the dialog is open it shows the
          failure itself, and this box sits behind the overlay saying the same
          sentence to nobody — so it stands down rather than duplicating it. */}
      <AlertMessage message={isModalOpen ? "" : error} tone="error" />
      <AlertMessage message={success} tone="success" />

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <SectionHeader sticky title={viewMode === "archived" ? "Archived Statuses" : "All Statuses"}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search..." style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5 }} name="status_manage_input_131" />
            <ArchiveViewToggle view={viewMode} onChange={setViewMode} />
            {viewMode === "active" && canCreate ? (
              <button onClick={() => { setForm(emptyForm); setIsModalOpen(true); }} style={{ background: "var(--brand-600)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}>+ Add Status</button>
            ) : null}
          </div>
        </SectionHeader>

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 221px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>No.</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Name</th>
                {/* No "Type" column: it repeated the group heading on every row. */}
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Balance range</th>
                {viewMode === "archived" ? <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Archived On</th> : null}
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Action</th>
              </tr>
            </thead>
            {loading ? (
              <tbody><SkeletonTableRows columns={columnCount} /></tbody>
            ) : filtered.length === 0 ? (
              <tbody>
                <tr><td colSpan={columnCount} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>{viewMode === "archived" ? "No archived statuses found" : "No statuses found"}</td></tr>
              </tbody>
            ) : (
              grouped.map((group) => (
                /* One <tbody> per module. The heading says what reads these
                   statuses, so "where do I add the one I need?" is answerable
                   by looking rather than by trying. */
                <tbody key={group.key || "__untyped"}>
                  <tr>
                    <td colSpan={columnCount} style={{ padding: "10px 9px", background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", borderTop: "1px solid var(--border-base)" }}>
                      <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 9, flexWrap: "wrap" }}>
                        <div>
                          <strong style={{ color: group.unknown ? "var(--text-secondary)" : "var(--brand-800)" }}>{group.label}</strong>
                          <span style={{ marginLeft: 7, fontSize: 11, color: "var(--text-muted)" }}>
                            {group.key ? group.key : "no type"} · {group.items.length}
                          </span>
                          {group.used_by ? (
                            <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2, maxWidth: 620, lineHeight: 1.45 }}>{group.used_by}</div>
                          ) : null}
                        </div>
                        {viewMode === "active" ? (
                          canCreate && (group.can_add ?? true) !== false ? (
                            <button
                              onClick={() => { setForm({ ...emptyForm, status_type: group.key }); setIsModalOpen(true); }}
                              style={{ background: "transparent", color: "var(--brand-700)", border: "1px solid var(--border-base)", padding: "4px 9px", borderRadius: 6, cursor: "pointer", fontSize: 12, whiteSpace: "nowrap" }}
                            >
                              + Add {group.label}
                            </button>
                          ) : addElsewhereHint(group) ? (
                            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>{addElsewhereHint(group)}</span>
                          ) : null
                        ) : null}
                      </div>
                    </td>
                  </tr>
                  {group.items.length === 0 ? (
                    <tr>
                      <td colSpan={columnCount} style={{ padding: "9px 9px 9px 18px", color: "var(--text-muted)", fontSize: 12, borderBottom: "1px solid var(--border-base)" }}>
                        No statuses yet.
                      </td>
                    </tr>
                  ) : null}
                  {group.items.map((row, idx) => {
                  // A locked row is one the backend finds by name. It is shown
                  // with the reason rather than hidden, because "why can I not
                  // edit this?" is the next question and the table can answer it.
                  const lockedReason = statusGuardReason(row);
                  return (
                  <tr key={row.status_id}>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{idx + 1}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                      {row.status_name}
                      {lockedReason ? (
                        <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 2, maxWidth: 340 }}>
                          Fixed name — {lockedReason}
                        </div>
                      ) : null}
                    </td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                      {isFinanceBand(row) ? formatBandRange(row.range_min, row.range_max) || "—" : ""}
                    </td>
                    {viewMode === "archived" ? (
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{row.archived_at ? new Date(row.archived_at).toLocaleString() : "-"}</td>
                    ) : null}
                    {/* One kebab, matching every other management table. */}
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                      <ActionMenu
                        label={`Actions for ${row.status_name || "this status"}`}
                        items={
                          viewMode === "archived"
                            ? canRestore
                              ? [{ key: "restore", label: "Restore", icon: "archiveRestore", tone: "brand", onSelect: () => void restore(row.status_id) }]
                              : []
                            : [
                                // A guarded status offers neither action: the
                                // server refuses both, and a control that always
                                // fails reads as a bug rather than as a rule.
                                ...(canEdit && !lockedReason
                                  ? [{
                                      key: "edit",
                                      label: "Edit",
                                      icon: "edit",
                                      onSelect: () => {
                                        setForm({
                                          status_id: row.status_id,
                                          status_name: row.status_name || "",
                                          status_type: row.status_type || "",
                                        });
                                        setIsModalOpen(true);
                                      },
                                    }]
                                  : []),
                                ...(canArchive && !lockedReason
                                  ? [{ key: "archive", label: "Archive", icon: "archive", tone: "danger", onSelect: () => void remove(row.status_id) }]
                                  : []),
                              ]
                        }
                      />
                    </td>
                  </tr>
                  );
                  })}
                </tbody>
              ))
            )}
          </table>
        </div>
      </div>

      {isModalOpen ? (
        <div role="dialog" aria-modal="true" style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }} onClick={() => setIsModalOpen(false)}>
          <div style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 442, maxHeight: "80vh", overflow: "auto", border: "1px solid var(--border-base)", boxShadow: "0 12px 24px rgba(2,6,23,0.12)", display: "flex", flexDirection: "column" }} onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--text-primary)" }}>{form.status_id ? "Edit Status" : "Add Status"}</strong>
              <button onClick={() => setIsModalOpen(false)} style={{ background: "transparent", border: 0, fontSize: 16, cursor: "pointer", color: "var(--text-secondary)" }} aria-label="Close">x</button>
            </div>
            {/* Inside the dialog, because this is where the action was taken. The
                page-level box below is painted UNDER this overlay, so a save the
                server refuses used to look like nothing happening at all. */}
            {error ? (
              <div style={{ flexShrink: 0, padding: "9px 12px 0" }}>
                <AlertMessage message={error} tone="error" style={{ marginBottom: 0 }} />
              </div>
            ) : null}
            <div style={{ padding: 12, display: "grid", gap: 11 }}>
              <div style={{ display: "grid", gap: 5 }}>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Status Name</label>
                <input value={form.status_name} onChange={(e) => setForm((current) => ({ ...current, status_name: e.target.value }))} style={{ width: "100%", padding: "6px 8px", fontSize: 12.5, border: "1px solid var(--border-base)", borderRadius: 5, boxSizing: "border-box" }} name="status_manage_input_179" />
              </div>
              <div style={{ display: "grid", gap: 5 }}>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Status Type</label>
                {/* Chosen, not typed. This was a text box whose own placeholder
                    suggested "schoolyear" — a type nothing reads, which saved
                    without complaint and produced a status that never appeared
                    in the dropdown the person was trying to fill. */}
                <select
                  value={form.status_type}
                  onChange={(e) => setForm((current) => ({ ...current, status_type: e.target.value }))}
                  disabled={typeLocked}
                  style={{ width: "100%", padding: "6px 8px", fontSize: 12.5, border: "1px solid var(--border-base)", borderRadius: 5, boxSizing: "border-box", background: typeLocked ? "var(--surface-page)" : "#fff" }}
                  name="status_manage_input_183"
                >
                  {typeLocked ? null : <option value="">Select a type...</option>}
                  {typeOptions.map((t) => (
                    <option key={t.key} value={t.key}>{t.label}</option>
                  ))}
                </select>
                {selectedType?.used_by ? (
                  <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.45 }}>{selectedType.used_by}</p>
                ) : null}
              </div>
              {/* Finance is the one type whose rows are not independent: a band's
                  range is shared with the band next to it. Said here rather than
                  left to the server's refusal, which arrives after the typing. */}
              {isFinanceBand(form) ? (
                <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)", lineHeight: 1.5 }}>
                  {form.status_id
                    ? "Renaming a balance band is fine — the range decides where a balance goes, not the name. To change the range, or to add a band, use Settings → Balance Bands, where both sides of a boundary move together."
                    : "Balance bands are added in Settings → Balance Bands. A new band takes its range from the one it splits, so the two have to be saved together."}
                </p>
              ) : null}
            </div>
            <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button onClick={() => setIsModalOpen(false)} style={{ background: "var(--border-base)", color: "var(--text-primary)", border: 0, padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}>Cancel</button>
               <button onClick={save} disabled={saving || (!form.status_id && !canCreate) || (Boolean(form.status_id) && !canEdit)} style={{ background: "var(--brand-600)", color: "#fff", border: 0, padding: "6px 9px", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer" }}>{saving ? "Saving..." : "Save"}</button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
