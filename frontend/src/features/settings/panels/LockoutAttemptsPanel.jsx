import React, { useMemo } from "react";
import { formatDateTime } from "../../../shared/lib/dateTime";
import { AlertMessage, Button, SectionHeader } from "../../../shared/components/ui";
import { DashboardPanel } from "../../../shared/layout/dashboard";
import Table from "../../../shared/components/Table";

function formatRemainingTime(remainingMs) {
  if (!remainingMs || remainingMs <= 0) return "-";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${seconds}s`;
}

export default function LockoutAttemptsPanel({ entries, message, onRefresh, onReset, onResetAll, loading = false }) {
  const rows = useMemo(() => {
    return entries.map((entry) => ({
      id: entry.email,
      email: entry.email,
      attempts: entry.attempts,
      threshold: entry.threshold,
      status: entry.locked ? "Blocked" : "Tracking",
      remaining: entry.locked ? formatRemainingTime(entry.remainingMs) : "-",
      lockedUntil: entry.locked ? formatDateTime(entry.lockedUntil) : "-",
      lastFailedAt: formatDateTime(entry.lastFailedAt),
      _email: entry.email,
    }));
  }, [entries]);

  // Every column but the address is a count, a state or a stamp, and none of
  // them reads correctly split across two lines. Email is the one long value,
  // so it is the one left free to wrap.
  const columns = [
    { key: "email", label: "Email" },
    { key: "attempts", label: "Attempts", nowrap: true },
    { key: "threshold", label: "Lockout Threshold", nowrap: true },
    { key: "status", label: "Status", nowrap: true },
    { key: "remaining", label: "Time Remaining", nowrap: true },
    { key: "lockedUntil", label: "Blocked Until", nowrap: true },
    { key: "lastFailedAt", label: "Last Failed At", nowrap: true },
    {
      key: "actions",
      label: "Action",
      nowrap: true,
      render: (row) => (
        <Button size="sm" variant="secondary" onClick={() => onReset(row._email)}>
          Reset Attempts
        </Button>
      ),
    },
  ];

  return (
    <DashboardPanel>
      <SectionHeader
        title="Failed Login Attempts"
        actions={(
          <div style={{ display: "flex", gap: 6 }}>
            <Button variant="secondary" onClick={onRefresh}>Refresh</Button>
            <Button variant="danger" onClick={onResetAll} disabled={rows.length === 0}>Reset All</Button>
          </div>
        )}
      />
      <div style={{ padding: 9, display: "grid", gap: 9 }}>
        <AlertMessage
          tone="warning"
          message="Failed login attempts are currently tracked in this browser storage. Resetting here clears the attempts recorded on this device."
        />
        {message ? <div style={{ color: "var(--brand-800)", fontSize: 11.5 }}>{message}</div> : null}
        <Table columns={columns} rows={rows} loading={loading} emptyText="No failed login attempts are currently tracked." />
      </div>
    </DashboardPanel>
  );
}
