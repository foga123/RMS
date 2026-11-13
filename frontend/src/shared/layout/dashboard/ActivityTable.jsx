import React from "react";
import Table from "../../components/Table";
import DashboardPanel from "./DashboardPanel";

export default function ActivityTable({
  title = "Recent Activity",
  subtitle,
  columns = [],
  rows = [],
  emptyText = "No activity yet.",
  panelStyle,
}) {
  return (
    <DashboardPanel style={panelStyle}>
      <div style={{ display: "grid", gap: 9 }}>
        <div>
          <h3 style={{ margin: 0, color: "var(--text-primary)" }}>{title}</h3>
          {subtitle ? (
            <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        <Table columns={columns} rows={rows} emptyText={emptyText} />
      </div>
    </DashboardPanel>
  );
}
