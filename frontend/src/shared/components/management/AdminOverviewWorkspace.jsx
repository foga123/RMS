import React from "react";
import { motion } from "framer-motion";
import { DashboardPanel } from "../../layout/dashboard";
import { StatCard, StatCardGrid, WelcomeCard } from "../ui";

function ActionStatCard({ item, index }) {
  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.35, delay: 0.05 + index * 0.07 }}>
      <button
        type="button"
        onClick={item.onClick}
        style={{ width: "100%", border: "none", background: "transparent", padding: 0, margin: 0, cursor: "pointer", textAlign: "left" }}
        aria-label={item.ariaLabel || `View ${item.label}`}
      >
        <StatCard label={item.label} value={item.value} tone={item.tone} />
      </button>
    </motion.div>
  );
}

export default function AdminOverviewWorkspace({
  firstName,
  overviewCards,
  flatModuleList,
  activeView,
  activeModuleIndex,
  selectedModule,
  moduleGroupSummary,
  onSelectModule,
}) {
  const totalSidebarModules = flatModuleList.length;
  const moduleProgressPercent = totalSidebarModules
    ? Math.round((((activeModuleIndex >= 0 ? activeModuleIndex : 0) + 1) / totalSidebarModules) * 100)
    : 0;
  const progressRadius = 42;
  const progressCircumference = 2 * Math.PI * progressRadius;
  const progressDashOffset = progressCircumference * (1 - moduleProgressPercent / 100);

  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.4 }}>
        <WelcomeCard firstName={firstName} />
      </motion.div>

      <div style={{ display: "grid", gap: 5 }}>
        <h2 style={{ margin: 0, color: "var(--brand-800)" }}>Dashboard</h2>
        <p style={{ color: "var(--text-secondary)", margin: 0 }}>
          You are logged in as <strong>Admin</strong>.
        </p>
      </div>

      <StatCardGrid minWidth={220}>
        {overviewCards.map((item, index) => (
          <ActionStatCard key={item.label} item={item} index={index} />
        ))}
      </StatCardGrid>

      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, delay: 0.22 }}
        style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 238px), 1fr))" }}
      >
        <DashboardPanel style={{ display: "grid", gap: 11 }}>
          <div>
            <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Sidebar Module Summary</h3>
            <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
              Overview of all admin modules currently available in the sidebar.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 187px), 1fr))", gap: 11, alignItems: "center" }}>
            <div style={{ position: "relative", width: 80, height: 80 }}>
              <svg width="80" height="80" viewBox="0 0 94 94" style={{ transform: "rotate(-90deg)" }} aria-hidden="true">
                <circle cx="47" cy="47" r={progressRadius} fill="none" stroke="#e2e8f0" strokeWidth="8" />
                <motion.circle
                  cx="47"
                  cy="47"
                  r={progressRadius}
                  fill="none"
                  stroke="#059669"
                  strokeWidth="8"
                  strokeLinecap="round"
                  strokeDasharray={progressCircumference}
                  initial={{ strokeDashoffset: progressCircumference }}
                  animate={{ strokeDashoffset: progressDashOffset }}
                  transition={{ duration: 0.8, ease: "easeOut" }}
                />
              </svg>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontWeight: 700,
                  color: "var(--text-primary)",
                }}
              >
                {moduleProgressPercent}%
              </div>
            </div>

            <div style={{ display: "grid", gap: 4 }}>
              <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>Current Module</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.2 }}>{selectedModule?.label}</div>
              <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                Position {(activeModuleIndex >= 0 ? activeModuleIndex : 0) + 1} of {totalSidebarModules}
              </div>
            </div>
          </div>

          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {flatModuleList.map((module, index) => (
              <motion.button
                key={module.view}
                type="button"
                onClick={() => onSelectModule(module.view)}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ duration: 0.3, delay: 0.03 * index }}
                style={{
                  borderRadius: 999,
                  border: module.view === activeView ? "1px solid #059669" : "1px solid #cbd5e1",
                  background: module.view === activeView ? "#ecfdf5" : "#ffffff",
                  color: module.view === activeView ? "#047857" : "#334155",
                  fontSize: 10.5,
                  padding: "5px 8px",
                  cursor: "pointer",
                }}
              >
                {module.label}
              </motion.button>
            ))}
          </div>
        </DashboardPanel>

        <DashboardPanel style={{ display: "grid", gap: 11 }}>
          <div>
            <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Module Distribution</h3>
            <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
              Animated chart showing how modules are split across each sidebar section.
            </p>
          </div>

          <div style={{ display: "grid", gap: 9 }}>
            {moduleGroupSummary.map((group, index) => (
              <div key={group.key} style={{ display: "grid", gap: 4 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", color: "var(--text-primary)", fontSize: 11.5 }}>
                  <span>{group.label}</span>
                  <strong>{group.count}</strong>
                </div>
                <div style={{ background: "var(--border-base)", borderRadius: 999, overflow: "hidden", height: 9 }}>
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${group.percentage}%` }}
                    transition={{ duration: 0.65, delay: 0.08 * (index + 1), ease: "easeOut" }}
                    style={{ height: "100%", borderRadius: 999, background: group.color }}
                  />
                </div>
                <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>{group.percentage}% of all sidebar modules</div>
              </div>
            ))}
          </div>
        </DashboardPanel>
      </motion.div>
    </section>
  );
}
