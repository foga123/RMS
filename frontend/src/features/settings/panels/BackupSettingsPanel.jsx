import React, { useCallback, useEffect, useMemo, useState } from "react";
import * as dateTime from "../../../shared/lib/dateTime";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import { AlertMessage, Button, Icon, SectionHeader } from "../../../shared/components/ui";
import { confirmAction, notifyError, notifySuccess } from "../../../shared/lib/notify";
import { canModuleAction } from "../../../shared/lib/roleAccess";
import { getBackendUrl } from "../../../shared/lib/url";

const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const defaultConfig = {
  config_id: 0,
  is_enabled: true,
  schedule_type: "daily",
  backup_hour: 2,
  backup_minute: 0,
  weekly_day: 1,
  monthly_day: 1,
  custom_at: "",
  storage_path: "",
  summary: "Daily at 02:00",
  next_run_at: null,
  server_time: null,
  timezone: "UTC",
};
const defaultStats = {
  successful_backups: 0,
  failed_backups: 0,
  successful_restores: 0,
  failed_restores: 0,
  last_success_at: null,
};
const fieldStyle = {
  width: "100%",
  padding: "8px 9px",
  borderRadius: 8,
  border: "1px solid var(--border-base)",
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  fontSize: 12.5,
  boxSizing: "border-box",
};
const labelStyle = { display: "grid", gap: 5 };
const headerTextStyle = { color: "var(--text-primary)", fontSize: 16 };
const captionStyle = { color: "var(--text-muted)", fontSize: 11.5 };
const tableHeaderStyle = {
  padding: "9px 11px",
  textAlign: "left",
  fontSize: 10.5,
  fontWeight: 700,
  color: "var(--text-secondary)",
  background: "var(--surface-page)",
  borderBottom: "1px solid var(--border-base)",
  whiteSpace: "nowrap",
};
const tableCellStyle = {
  padding: "9px 11px",
  borderBottom: "1px solid var(--border-base)",
  verticalAlign: "top",
  fontSize: 11.5,
};

function toInputDateTime(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text.replace(" ", "T").slice(0, 16);
}

function normalizeConfig(config) {
  return {
    ...defaultConfig,
    ...(config || {}),
    is_enabled: Boolean(config?.is_enabled),
    backup_hour: Number(config?.backup_hour ?? defaultConfig.backup_hour),
    backup_minute: Number(config?.backup_minute ?? defaultConfig.backup_minute),
    weekly_day: Number(config?.weekly_day ?? defaultConfig.weekly_day),
    monthly_day: Number(config?.monthly_day ?? defaultConfig.monthly_day),
    custom_at: toInputDateTime(config?.custom_at),
    storage_path: String(config?.storage_path || ""),
  };
}

function normalizeStats(stats) {
  return { ...defaultStats, ...(stats || {}) };
}

function formatTime(hour, minute) {
  return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

/**
 * "Not available", not "-": a backup that has never run is a state worth naming,
 * and a dash in that row reads as a rendering fault. Only the empty word is this
 * panel's own — the parsing and the format come from shared/lib/dateTime.
 */
const formatDateTime = (value) => dateTime.formatDateTime(value, { fallback: "Not available" });

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "--";
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const sized = bytes / 1024 ** index;
  return `${sized >= 10 ? sized.toFixed(0) : sized.toFixed(1)} ${units[index]}`;
}

function buildSummary(config, stats) {
  if (!config?.is_enabled) return "Scheduled backups disabled";
  if (stats?.last_success_at) return `${config.summary} | Last success ${formatDateTime(stats.last_success_at)}`;
  return config?.summary || "Backup schedule configured";
}

function getStatusTone(status) {
  const value = String(status || "").toLowerCase();
  if (value === "success") return { bg: "var(--brand-100)", border: "var(--brand-200)", color: "var(--brand-800)", label: "Success" };
  if (value === "failed") return { bg: "var(--danger-100)", border: "var(--danger-200)", color: "var(--danger-800)", label: "Failed" };
  if (value === "running") return { bg: "var(--brand-50)", border: "var(--brand-200)", color: "var(--brand-700)", label: "Running" };
  return { bg: "var(--surface-page)", border: "var(--border-strong)", color: "var(--text-secondary)", label: value || "Unknown" };
}

async function readJsonResponse(response, fallback) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.message || payload?.error || fallback);
  return payload;
}

function StatCard({ label, value, detail }) {
  return (
    <div style={{ borderRadius: 11, border: "1px solid var(--border-base)", background: "var(--surface-base)", padding: 12, display: "grid", gap: 5 }}>
      <span style={{ color: "var(--text-muted)", fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</span>
      <strong style={{ color: "var(--text-primary)", fontSize: 16 }}>{value}</strong>
      <span style={captionStyle}>{detail}</span>
    </div>
  );
}

export default function BackupSettingsPanel({ onSummaryChange, permissions = null }) {
  const [config, setConfig] = useState(defaultConfig);
  const [history, setHistory] = useState([]);
  const [stats, setStats] = useState(defaultStats);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [restoringId, setRestoringId] = useState(null);
  const [downloadingId, setDownloadingId] = useState(null);
  const [feedback, setFeedback] = useState({ tone: "info", message: "" });
  const hasPermissionContext = Array.isArray(permissions) && permissions.length > 0;
  const canView = hasPermissionContext ? canModuleAction(permissions, "view") : true;
  const canEdit = hasPermissionContext
    ? (canModuleAction(permissions, "edit") || canModuleAction(permissions, "manage"))
    : true;

  const applyPayload = useCallback((data) => {
    const nextConfig = normalizeConfig(data?.config);
    const nextStats = normalizeStats(data?.stats);
    setConfig(nextConfig);
    setHistory(Array.isArray(data?.history) ? data.history : []);
    setStats(nextStats);
    if (typeof onSummaryChange === "function") onSummaryChange(buildSummary(nextConfig, nextStats));
  }, [onSummaryChange]);

  const loadBackupData = useCallback(async ({ silent = false } = {}) => {
    if (!canView) {
      setLoading(false);
      setRefreshing(false);
      setFeedback({ tone: "error", message: "You do not have permission to view backup settings." });
      return;
    }

    if (silent) setRefreshing(true);
    else setLoading(true);

    try {
      const response = await fetch(getBackendUrl("backup.php"), {
        credentials: "include",
        headers: { Accept: "application/json" },
      });
      const payload = await readJsonResponse(response, "Failed to load backup settings.");
      applyPayload(payload?.data || {});
      const schedulerStatus = String(payload?.scheduler?.status || "").toLowerCase();
      if (schedulerStatus === "success" || schedulerStatus === "failed") {
        setFeedback({
          tone: schedulerStatus === "success" ? "success" : "warning",
          message: payload?.scheduler?.message || "",
        });
      }
    } catch (error) {
      const message = error?.message || "Failed to load backup settings.";
      setFeedback({ tone: "error", message });
      if (typeof onSummaryChange === "function") onSummaryChange("Backup settings unavailable");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [applyPayload, canView, onSummaryChange]);

  useEffect(() => {
    void loadBackupData();
  }, [loadBackupData]);

  const sortedHistory = useMemo(
    () => [...history].sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || ""))),
    [history]
  );

  const busy = loading || saving || running || restoringId != null;

  const saveSchedule = async () => {
    if (!canEdit) {
      setFeedback({ tone: "warning", message: "No permission for this action." });
      return;
    }

    setSaving(true);
    setFeedback({ tone: "info", message: "" });
    try {
      const response = await fetch(getBackendUrl("backup.php"), {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          is_enabled: config.is_enabled,
          schedule_type: config.schedule_type,
          backup_hour: config.backup_hour,
          backup_minute: config.backup_minute,
          weekly_day: config.weekly_day,
          monthly_day: config.monthly_day,
          custom_at: config.custom_at || null,
          storage_path: config.storage_path,
        }),
      });
      const payload = await readJsonResponse(response, "Failed to save backup schedule.");
      const nextConfig = normalizeConfig(payload?.data?.config);
      setConfig(nextConfig);
      setFeedback({ tone: "success", message: payload?.message || "Backup schedule saved successfully." });
      void notifySuccess("Backup schedule saved", payload?.message || "Backup schedule updated successfully.");
      await loadBackupData({ silent: true });
    } catch (error) {
      const message = error?.message || "Failed to save backup schedule.";
      setFeedback({ tone: "error", message });
      void notifyError("Backup schedule failed", message);
    } finally {
      setSaving(false);
    }
  };

  const handleBackupNow = async () => {
    if (!canEdit) {
      setFeedback({ tone: "warning", message: "No permission for this action." });
      return;
    }

    setRunning(true);
    setFeedback({ tone: "info", message: "" });
    try {
      const response = await fetch(getBackendUrl("backup.php"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "backup_now" }),
      });
      const payload = await readJsonResponse(response, "Backup failed.");
      const fileName = String(payload?.data?.file_name || "backup.sql");
      const fileSize = formatBytes(payload?.data?.file_size);
      const message = `${payload?.message || "Backup completed successfully."} ${fileName} (${fileSize}).`;
      setFeedback({ tone: "success", message });
      void notifySuccess("Backup completed", message);
      await loadBackupData({ silent: true });
    } catch (error) {
      const message = error?.message || "Backup failed.";
      setFeedback({ tone: "error", message });
      void notifyError("Backup failed", message);
    } finally {
      setRunning(false);
    }
  };

  const handleRestore = async (entry) => {
    if (!canEdit) {
      setFeedback({ tone: "warning", message: "No permission for this action." });
      return;
    }

    const confirmed = await confirmAction({
      title: "Restore database?",
      text: `Restore from ${entry.file_name || "the selected backup"}? This overwrites current database data.`,
      confirmButtonText: "Restore",
      confirmButtonColor: "var(--danger-700)",
    });
    if (!confirmed) return;

    setRestoringId(entry.history_id);
    setFeedback({ tone: "info", message: "" });
    try {
      const response = await fetch(getBackendUrl("backup.php"), {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ action: "restore", history_id: entry.history_id }),
      });
      const payload = await readJsonResponse(response, "Restore failed.");
      const message = payload?.message || "Restore completed successfully.";
      setFeedback({ tone: "success", message });
      void notifySuccess("Restore completed", message);
      await loadBackupData({ silent: true });
    } catch (error) {
      const message = error?.message || "Restore failed.";
      setFeedback({ tone: "error", message });
      void notifyError("Restore failed", message);
    } finally {
      setRestoringId(null);
    }
  };

  const handleDownload = async (entry) => {
    setDownloadingId(entry.history_id);
    try {
      const response = await fetch(getBackendUrl(`backup.php?download_id=${encodeURIComponent(entry.history_id)}`), {
        credentials: "include",
      });
      if (!response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          const payload = await response.json().catch(() => ({}));
          throw new Error(payload?.message || "Failed to download backup.");
        }
        throw new Error("Failed to download backup.");
      }
      const blob = await response.blob();
      const link = document.createElement("a");
      const url = window.URL.createObjectURL(blob);
      link.href = url;
      link.download = entry.file_name || `backup_${entry.history_id}.sql`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      const message = error?.message || "Failed to download backup.";
      setFeedback({ tone: "error", message });
      void notifyError("Download failed", message);
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <DashboardPanel>
      <SectionHeader
        title="Backup Data"
        actions={(
          <>
            <Button variant="secondary" onClick={() => void loadBackupData({ silent: true })} disabled={loading || refreshing}>
              {refreshing ? "Refreshing..." : "Refresh"}
            </Button>
            {canEdit ? (
              <Button onClick={handleBackupNow} disabled={busy}>
                {running ? "Running Backup..." : "Backup Now"}
              </Button>
            ) : null}
          </>
        )}
      />

      <div style={{ padding: 12, display: "grid", gap: 12 }}>
        <AlertMessage
          tone="info"
          message="Schedule automatic backups, run secure on-demand backups, and restore from verified snapshots. The system blocks overlapping backup and restore jobs to protect data integrity."
        />
        {!canEdit ? <AlertMessage tone="info" message="No permission for this action. Backup schedule changes and restore operations are hidden for this account." /> : null}
        {feedback.message ? <AlertMessage tone={feedback.tone} message={feedback.message} /> : null}

        <div style={{ display: "grid", gap: 9, gridTemplateColumns: "repeat(auto-fit, minmax(min(153px, 100%), 1fr))" }}>
          <StatCard
            label="Schedule"
            value={config.is_enabled ? config.summary : "Disabled"}
            detail={`Next run: ${config.next_run_at ? formatDateTime(config.next_run_at) : "Not scheduled"}`}
          />
          <StatCard
            label="Backups"
            value={stats.successful_backups}
            detail={`Failed: ${stats.failed_backups}`}
          />
          <StatCard
            label="Restores"
            value={stats.successful_restores}
            detail={`Failed: ${stats.failed_restores}`}
          />
          <StatCard
            label="Last Success"
            value={stats.last_success_at ? formatDateTime(stats.last_success_at) : "No backup yet"}
            detail={`Server time: ${config.server_time ? formatDateTime(config.server_time) : "Not available"}`}
          />
        </div>

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(255px, 100%), 1fr))", alignItems: "start" }}>
          <DashboardPanel variant="muted" style={{ padding: 14, display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 3 }}>
              <strong style={headerTextStyle}>Backup Schedule</strong>
              <span style={captionStyle}>Choose the backup frequency, run time, and storage location.</span>
            </div>

            {loading ? (
              <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>Loading backup configuration...</DashboardPanel>
            ) : (
              <>
                <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5, color: "var(--text-primary)", fontWeight: 600 }}>
                   <input type="checkbox" checked={config.is_enabled} onChange={(event) => setConfig((current) => ({ ...current, is_enabled: event.target.checked }))} disabled={!canEdit || busy} />
                   Enable scheduled backups
                 </label>

                <div style={{ display: "grid", gap: 9, gridTemplateColumns: "repeat(auto-fit, minmax(min(187px, 100%), 1fr))" }}>
                  <label style={labelStyle}>
                    <span style={{ color: "var(--text-primary)", fontSize: 11.5, fontWeight: 600 }}>Schedule Type</span>
                     <select value={config.schedule_type} onChange={(event) => setConfig((current) => ({ ...current, schedule_type: event.target.value }))} style={fieldStyle} disabled={!canEdit || busy}>
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                      <option value="custom">Custom date/time</option>
                    </select>
                  </label>

                  {config.schedule_type !== "custom" ? (
                    <label style={labelStyle}>
                      <span style={{ color: "var(--text-primary)", fontSize: 11.5, fontWeight: 600 }}>Backup Time</span>
                      <input
                        type="time"
                        value={formatTime(config.backup_hour, config.backup_minute)}
                        onChange={(event) => {
                          const [hourText = "00", minuteText = "00"] = String(event.target.value || "").split(":");
                          setConfig((current) => ({
                            ...current,
                            backup_hour: Math.max(0, Math.min(23, Number(hourText) || 0)),
                            backup_minute: Math.max(0, Math.min(59, Number(minuteText) || 0)),
                          }));
                        }}
                        style={fieldStyle}
                         disabled={!canEdit || busy}
                      />
                    </label>
                  ) : null}

                  {config.schedule_type === "weekly" ? (
                    <label style={labelStyle}>
                      <span style={{ color: "var(--text-primary)", fontSize: 11.5, fontWeight: 600 }}>Weekly Run Day</span>
                       <select value={config.weekly_day} onChange={(event) => setConfig((current) => ({ ...current, weekly_day: Number(event.target.value) }))} style={fieldStyle} disabled={!canEdit || busy}>
                        {days.map((day, index) => <option key={day} value={index}>{day}</option>)}
                      </select>
                    </label>
                  ) : null}

                  {config.schedule_type === "monthly" ? (
                    <label style={labelStyle}>
                      <span style={{ color: "var(--text-primary)", fontSize: 11.5, fontWeight: 600 }}>Monthly Run Day</span>
                       <select value={config.monthly_day} onChange={(event) => setConfig((current) => ({ ...current, monthly_day: Number(event.target.value) }))} style={fieldStyle} disabled={!canEdit || busy}>
                        {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => <option key={day} value={day}>{`Day ${day}`}</option>)}
                      </select>
                    </label>
                  ) : null}

                  {config.schedule_type === "custom" ? (
                    <label style={labelStyle}>
                      <span style={{ color: "var(--text-primary)", fontSize: 11.5, fontWeight: 600 }}>Custom Date/Time</span>
                       <input type="datetime-local" value={config.custom_at} onChange={(event) => setConfig((current) => ({ ...current, custom_at: event.target.value }))} style={fieldStyle} disabled={!canEdit || busy} />
                    </label>
                  ) : null}
                </div>

                <label style={labelStyle}>
                  <span style={{ color: "var(--text-primary)", fontSize: 11.5, fontWeight: 600 }}>Backup Storage Path</span>
                  <input
                    type="text"
                    value={config.storage_path}
                    onChange={(event) => setConfig((current) => ({ ...current, storage_path: event.target.value }))}
                    placeholder="storage/backups or D:\\Backups\\Capstone"
                    style={fieldStyle}
                    disabled={!canEdit || busy}
                  />
                  <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                    Relative paths are stored under the backend storage directory. Absolute server paths are also supported.
                  </span>
                </label>

                <DashboardPanel style={{ padding: 12, display: "grid", gap: 6, border: "1px solid var(--border-base)", background: "var(--surface-base)" }}>
                  <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>Current Backup Profile</strong>
                  <span style={captionStyle}>Summary: {config.summary}</span>
                  <span style={captionStyle}>Next scheduled run: {config.next_run_at ? formatDateTime(config.next_run_at) : "Not scheduled"}</span>
                  <span style={captionStyle}>Server timezone: {config.timezone || "UTC"}</span>
                  <span style={captionStyle}>Server storage: {config.storage_path || "Default secure storage"}</span>
                </DashboardPanel>

                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
                  <Button variant="secondary" onClick={() => void loadBackupData({ silent: true })} disabled={busy}>Reload</Button>
                  {canEdit ? <Button onClick={saveSchedule} disabled={busy}>{saving ? "Saving..." : "Save Schedule"}</Button> : null}
                </div>
              </>
            )}
          </DashboardPanel>

          <DashboardPanel variant="muted" style={{ padding: 14, display: "grid", gap: 12 }}>
            <div style={{ display: "grid", gap: 3 }}>
              <strong style={headerTextStyle}>Backup Safety</strong>
              <span style={captionStyle}>Only one backup or restore can run at a time, and each schedule slot is stored once.</span>
            </div>

            {[
              ["Conflict Protection", "Backup and restore operations use a server lock to prevent overlapping jobs."],
              ["Server Storage", "Backups are stored on the server and tracked in the history log until you download or restore them."],
              ["Restore Tracking", "Every restore attempt is logged separately so recovery activity stays auditable."],
            ].map(([title, text]) => (
              <DashboardPanel key={title} style={{ padding: 11, display: "grid", gap: 5, border: "1px solid var(--border-base)" }}>
                <strong style={{ color: "var(--text-primary)", fontSize: 12.5 }}>{title}</strong>
                <span style={captionStyle}>{text}</span>
              </DashboardPanel>
            ))}
          </DashboardPanel>
        </div>

        <DashboardPanel variant="muted" style={{ padding: 14, display: "grid", gap: 12 }}>
          <div style={{ display: "grid", gap: 3 }}>
            <strong style={headerTextStyle}>Backup History</strong>
            <span style={captionStyle}>Review backup and restore activity, download stored backups, and restore from a previous successful snapshot.</span>
          </div>

          {loading ? <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>Loading backup history...</DashboardPanel> : null}
          {!loading && sortedHistory.length === 0 ? <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>No backup activity has been recorded yet.</DashboardPanel> : null}

          {!loading && sortedHistory.length > 0 ? (
            <div style={{ border: "1px solid var(--border-base)", borderRadius: 11, overflow: "hidden", background: "var(--surface-base)" }}>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", minWidth: 833, borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <th style={tableHeaderStyle}>Date/Time</th>
                      <th style={tableHeaderStyle}>Action</th>
                      <th style={tableHeaderStyle}>Trigger</th>
                      <th style={tableHeaderStyle}>Status</th>
                      <th style={tableHeaderStyle}>File Name</th>
                      <th style={tableHeaderStyle}>Size</th>
                      <th style={tableHeaderStyle}>Details</th>
                      <th style={{ ...tableHeaderStyle, textAlign: "center", width: 179 }}>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedHistory.map((entry) => {
                      const tone = getStatusTone(entry.status);
                      const restoring = restoringId === entry.history_id;
                      const downloading = downloadingId === entry.history_id;
                      return (
                        <tr key={entry.history_id}>
                          <td style={tableCellStyle}>
                            <div style={{ display: "grid", gap: 3 }}>
                              <strong style={{ color: "var(--text-primary)", fontSize: 11.5 }}>{formatDateTime(entry.completed_at || entry.created_at)}</strong>
                              <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Created {formatDateTime(entry.created_at)}</span>
                            </div>
                          </td>
                          <td style={{ ...tableCellStyle, color: "var(--text-primary)", fontWeight: 600 }}>{entry.event_type === "restore" ? "Restore" : "Backup"}</td>
                          <td style={{ ...tableCellStyle, color: "var(--text-secondary)" }}>{entry.trigger_type === "scheduled" ? "Scheduled" : "Manual"}</td>
                          <td style={tableCellStyle}>
                            <span style={{ display: "inline-flex", alignItems: "center", borderRadius: 999, padding: "4px 8px", fontSize: 10.5, fontWeight: 700, background: tone.bg, border: `1px solid ${tone.border}`, color: tone.color }}>
                              {tone.label}
                            </span>
                          </td>
                          <td style={tableCellStyle}>
                            <div style={{ display: "grid", gap: 3 }}>
                              <strong style={{ color: "var(--text-primary)", fontSize: 11.5 }}>{entry.file_name || "Not available"}</strong>
                              <span style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{entry.is_available ? "Stored on server" : "File unavailable"}</span>
                            </div>
                          </td>
                          <td style={{ ...tableCellStyle, color: "var(--text-primary)" }}>{formatBytes(entry.file_size)}</td>
                          <td style={{ ...tableCellStyle, color: "var(--text-secondary)", lineHeight: 1.5 }}>{entry.message || "No details recorded."}</td>
                          <td style={{ ...tableCellStyle, textAlign: "center" }}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "center", flexWrap: "wrap" }}>
                              <Button variant="secondary" size="sm" onClick={() => void handleDownload(entry)} disabled={!entry.can_download || restoring || downloading} style={{ minWidth: 78 }}>
                                <Icon name="download" size={13} />
                                {downloading ? "Downloading..." : "Download"}
                              </Button>
                              {canEdit ? (
                                <Button
                                  variant="secondary"
                                  size="sm"
                                  onClick={() => void handleRestore(entry)}
                                  disabled={!entry.can_restore || restoring || downloading || running}
                                  style={{ minWidth: 75, borderColor: "#fcd34d", background: "var(--warning-50)", color: "var(--warning-800)" }}
                                >
                                  <Icon name="archiveRestore" size={13} />
                                  {restoring ? "Restoring..." : "Restore"}
                                </Button>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
        </DashboardPanel>
      </div>
    </DashboardPanel>
  );
}
