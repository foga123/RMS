import React, { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { AdminOverviewWorkspace, InactiveUsersQuickPanel } from "../../shared/components/management";
import { OverviewCharts, ScopedRetentionMatrix } from "../../shared/components/charts";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import { DashboardPanel, DashboardShell } from "../../shared/layout/dashboard";
import { getReportLabel, GrantedModuleSidebarSections, GrantedModuleView, ReportsSidebarGroup } from "./SharedGrantedModules";
import { getEffectiveDashboardModules, resolveAccessibleDashboardView } from "./moduleAccess";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { confirmAction, notifyError, notifyInfo, notifySuccess } from "../../shared/lib/notify";
import { getBackendUrl } from "../../shared/lib/url";
import { getUserFirstName, hasRole, readAuthUser, replacePath } from "../../shared/lib/auth";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";
const USER_PANEL_PRESETS = {
  total: {
    title: "All Users",
    description: "Review user accounts and update them directly from the admin dashboard.",
    emptyLabel: "No users found.",
    nounSingular: "user",
    nounPlural: "users",
  },
  active: {
    title: "Active Users",
    description: "Review active accounts and quickly move them to Archived Users.",
    emptyLabel: "No active users found.",
    nounSingular: "active user",
    nounPlural: "active users",
  },
  archived: {
    title: "Archived Users",
    description: "Review archived accounts and restore them when needed.",
    emptyLabel: "No archived users found.",
    nounSingular: "archived user",
    nounPlural: "archived users",
  },
};

const normalizeAccountStatus = (statusValue, statusName, statusType) => {
  const normalized = Number(statusValue);
  const normalizedName = String(statusName || "").trim().toLowerCase();
  const text = String(statusType || "").trim().toLowerCase();
  if (normalized === 1 || normalizedName === "active" || text === "active") return 1;
  if (normalized === 2 || normalized === 0 || normalizedName === "inactive" || normalizedName === "archived") return 2;
  if (normalized > 1) return 2;
  return 1;
};

export default function AdminDashboard({ user: userProp }) {
  const [user, setUser] = useState(userProp ?? null);
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));
  const [reportsOpen, setReportsOpen] = useState(false);
  const [totalUsers, setTotalUsers] = useState(null);
  const [activeUsers, setActiveUsers] = useState(null);
  const [pendingUsers, setPendingUsers] = useState(null);
  const [reportView, setReportView] = useState(() => getInitialDashboardIntentValue("report", "users"));
  const [inactiveUsersOpen, setInactiveUsersOpen] = useState(false);
  const [userPanelMode, setUserPanelMode] = useState("archived");
  const [inactiveUsers, setInactiveUsers] = useState([]);
  const [inactiveUsersLoading, setInactiveUsersLoading] = useState(false);
  const [inactiveUsersError, setInactiveUsersError] = useState("");
  const [inactiveUsersSearch, setInactiveUsersSearch] = useState("");
  const [inactiveUserActionId, setInactiveUserActionId] = useState(null);
  const schedulerNoticeRef = useRef("");
  const dashboardIntent = useDashboardIntent({
    onView: setActiveView,
    onReport: setReportView,
    activeView,
    activeReport: activeView === "reports" ? reportView : "",
    persist: true,
  });

  useEffect(() => {
    if (activeView === "reports") {
      setReportsOpen(true);
    }
  }, [activeView]);

  useEffect(() => {
    const parsed = userProp ?? readAuthUser();
    if (!hasRole(parsed, { id: 1, name: "admin" })) {
      replacePath("/");
      return;
    }
    setUser(parsed);
  }, [userProp]);

  async function fetchDashboardSummary() {
    const res = await fetch(getBackendUrl("user-summary.php"), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(json?.message || "Failed to load summary");
    return json?.data || {};
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        if (!user) return;
        const payload = await fetchDashboardSummary();
        if (!cancelled) {
          setTotalUsers(typeof payload.total === "number" ? payload.total : null);
          setActiveUsers(typeof payload.active === "number" ? payload.active : null);
          setPendingUsers(typeof payload.archived === "number" ? payload.archived : null);
        }
      } catch {
        if (!cancelled) {
          setTotalUsers(null);
          setActiveUsers(null);
          setPendingUsers(null);
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const accessibleModules = useMemo(
    () => (user ? getEffectiveDashboardModules(user, "admin") : []),
    [user]
  );

  useEffect(() => {
    if (!user || !accessibleModules.some((module) => module.view === "settings")) {
      schedulerNoticeRef.current = "";
      return undefined;
    }

    let cancelled = false;

    async function runBackupHeartbeat() {
      try {
        const response = await fetch(getBackendUrl("backup.php?mode=heartbeat"), {
          credentials: "include",
          headers: { Accept: "application/json" },
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || cancelled) return;

        const scheduler = payload?.scheduler || {};
        const status = String(scheduler.status || "").toLowerCase();
        if (status !== "success" && status !== "failed") return;

        const token = `${status}:${scheduler.history_id || scheduler.next_run_at || scheduler.message || ""}`;
        if (schedulerNoticeRef.current === token) return;
        schedulerNoticeRef.current = token;

        if (status === "success") {
          void notifySuccess("Scheduled backup completed", scheduler.message || "Scheduled backup completed successfully.");
          return;
        }

        void notifyError("Scheduled backup failed", scheduler.message || "Scheduled backup failed.");
      } catch {
        // Ignore heartbeat transport errors to avoid noisy polling alerts.
      }
    }

    void runBackupHeartbeat();
    const intervalId = window.setInterval(() => {
      void runBackupHeartbeat();
    }, 60000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [accessibleModules, user]);

  useEffect(() => {
    const nextView = resolveAccessibleDashboardView(activeView, accessibleModules, ["overview"]);
    if (nextView && nextView !== activeView) {
      setActiveView(nextView);
    }
  }, [activeView, accessibleModules]);

  const filteredInactiveUsers = useMemo(() => {
    const query = inactiveUsersSearch.trim().toLowerCase();
    if (!query) return inactiveUsers;

    return inactiveUsers.filter((row) =>
      [
        row?.first_name,
        row?.last_name,
        row?.email,
        row?.role_name,
        row?.department_name,
        row?.campus_name,
      ].some((value) => String(value || "").toLowerCase().includes(query))
    );
  }, [inactiveUsers, inactiveUsersSearch]);

  async function loadDashboardSummary() {
    if (!user) return;
    const payload = await fetchDashboardSummary();
    setTotalUsers(typeof payload.total === "number" ? payload.total : null);
    setActiveUsers(typeof payload.active === "number" ? payload.active : null);
    setPendingUsers(typeof payload.archived === "number" ? payload.archived : null);
  }

  async function fetchAllUsers(query = {}) {
    const rows = [];
    const limit = 100;
    let page = 1;
    let total = Number.POSITIVE_INFINITY;

    while (rows.length < total) {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));

      Object.entries(query).forEach(([key, value]) => {
        if (value == null || value === "") return;
        params.set(key, String(value));
      });

      const res = await fetch(getBackendUrl(`user.php?${params.toString()}`), {
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || "Failed to load users");

      const pageRows = Array.isArray(data?.data) ? data.data : [];
      rows.push(...pageRows);

      const nextTotal = Number(data?.pagination?.total);
      total = Number.isFinite(nextTotal) ? nextTotal : rows.length;
      if (pageRows.length < limit) break;

      page += 1;
    }

    return rows;
  }

  function getPanelQuery(mode) {
    if (mode === "active") return { status: 1 };
    if (mode === "archived") return { archived: 1 };
    return {};
  }

  async function loadPanelUsers(mode = userPanelMode) {
    setInactiveUsersLoading(true);
    setInactiveUsersError("");
    try {
      const rows = await fetchAllUsers(getPanelQuery(mode));
      setInactiveUsers(rows);
    } catch (error) {
      setInactiveUsersError(error?.message || "Failed to load users");
      setInactiveUsers([]);
    } finally {
      setInactiveUsersLoading(false);
    }
  }

  async function openUsersPanel(mode) {
    setUserPanelMode(mode);
    setInactiveUsersOpen(true);
    setInactiveUsersSearch("");
    await loadPanelUsers(mode);
  }

  function getUserDisplayName(targetUser) {
    const fullName = `${String(targetUser?.first_name || "").trim()} ${String(targetUser?.last_name || "").trim()}`.trim();
    return fullName || String(targetUser?.email || "").trim() || "this user";
  }

  async function updateUserStatus(targetUser, nextStatus, options) {
    const confirmed = await confirmAction(options.confirm);
    if (!confirmed) return;

    setInactiveUserActionId(targetUser.user_id);
    setInactiveUsersError("");

    try {
      const res = await fetch(getBackendUrl(`user.php?id=${targetUser.user_id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ status: nextStatus }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || options.errorMessage);

      await Promise.all([loadDashboardSummary(), loadPanelUsers(userPanelMode)]);
      void notifySuccess(options.successTitle, options.successText);
    } catch (error) {
      setInactiveUsersError(error?.message || options.errorMessage);
    } finally {
      setInactiveUserActionId(null);
    }
  }

  async function restoreUser(targetUser) {
    const name = getUserDisplayName(targetUser);
    await updateUserStatus(targetUser, 1, {
      confirm: {
        title: "Restore user?",
        text: `Restore ${name} to active users?`,
        confirmButtonText: "Restore",
      },
      successTitle: "User restored",
      successText: `${name} is active again.`,
      errorMessage: "Failed to restore user",
    });
  }

  async function deactivateUser(targetUser) {
    const name = getUserDisplayName(targetUser);
    await updateUserStatus(targetUser, 2, {
      confirm: {
        title: "Set user inactive?",
        text: `Set ${name} to inactive and move the account to Archived Users?`,
        confirmButtonText: "Set Inactive",
      },
      successTitle: "User archived",
      successText: `${name} moved to Archived Users.`,
      errorMessage: "Failed to update user status",
    });
  }

  function manageUser(targetUser) {
    setInactiveUsersOpen(false);
    const nextView = accessibleModules.some((module) => module.view === "users")
      ? "users"
      : resolveAccessibleDashboardView("", accessibleModules, ["overview"]);
    if (nextView) {
      setActiveView(nextView);
    }
    void notifyInfo("User Management", `Continue managing ${getUserDisplayName(targetUser)} in User Management.`);
  }

  const userPanelConfig = USER_PANEL_PRESETS[userPanelMode] || USER_PANEL_PRESETS.archived;
  const userPanelSummaryLabel = `Showing ${filteredInactiveUsers.length} of ${inactiveUsers.length} ${
    inactiveUsers.length === 1 ? userPanelConfig.nounSingular : userPanelConfig.nounPlural
  }`;
  const firstName = getUserFirstName(user);
  const flatModuleList = accessibleModules.map((module) => ({
    ...module,
    label: module.view === "overview" ? "Dashboard" : module.label,
    color: module.groupColor,
  }));
  const totalSidebarModules = flatModuleList.length;
  const activeModuleIndex = flatModuleList.findIndex((module) => module.view === activeView);
  const selectedModule = flatModuleList[activeModuleIndex] || flatModuleList[0] || { label: "No modules enabled" };
  const selectedModuleLabel = selectedModule?.label || "";
  const moduleGroupSummary = flatModuleList
    .reduce((groups, module) => {
      const existing = groups.find((group) => group.key === module.groupKey);
      if (existing) {
        existing.count += 1;
        return groups;
      }

      groups.push({
        key: module.groupKey,
        label: module.groupLabel,
        color: module.groupColor,
        count: 1,
      });
      return groups;
    }, [])
    .map((group) => ({
      ...group,
      percentage: totalSidebarModules ? Math.round((group.count / totalSidebarModules) * 100) : 0,
    }));
  const activeModule = accessibleModules.find((module) => module.view === activeView) || null;
  const overviewEnabled = accessibleModules.some((module) => module.view === "overview");
  const sidebarModules = accessibleModules.filter((module) => module.view !== "overview");

  /*
   * Settings is reached from the account menu in the header, not from the rail.
   * It is the one module that configures the portal rather than working on
   * student data, and it belongs beside Profile and Logout for the same reason
   * those are not sidebar items either.
   *
   * It is still an ordinary permissioned module: this only reads what
   * accessibleModules already decided, so an admin without the settings
   * permission gets no entry in either place.
   */
  const settingsModule = sidebarModules.find((module) => module.view === "settings") || null;

  const surveySidebarModules = sidebarModules.filter((module) => module.groupKey === "survey_master");
  const reportModule = sidebarModules.find((module) => module.view === "reports") || null;
  const noModulesEnabled = accessibleModules.length === 0;
  const surveyRootView = surveySidebarModules[0]?.view || "";
  const breadcrumbSegments = useMemo(() => {
    if (activeView === "overview") return [];
    const segments = [];
    if (overviewEnabled) {
      segments.push({
        label: "Dashboard",
        onClick: () => setActiveView("overview"),
      });
    }
    if (activeView === "reports") {
      segments.push({
        label: reportModule?.label || "Reports",
        onClick: () => {
          setActiveView("reports");
          setReportsOpen(true);
        },
      });
      segments.push({ label: getReportLabel(reportView), current: true });
      return segments;
    }
    if (activeView.startsWith("survey") && surveyRootView) {
      /*
       * The survey modules are one workspace now, and it moves between them
       * with its own tab bar rather than by changing activeView. A leaf naming
       * one of the four would go stale the moment a tab is clicked, so the
       * trail stops here and the tab bar says which screen you are on.
       */
      segments.push({ label: "Survey Master", current: true });
      return segments;
    }
    if (selectedModuleLabel) {
      segments.push({ label: selectedModuleLabel, current: true });
    }
    return segments;
  }, [activeView, overviewEnabled, reportModule?.label, reportView, selectedModuleLabel, surveyRootView]);
  const openModuleSummary = () => {
    if (totalSidebarModules === 0) {
      void notifyInfo("Sidebar Modules", "No admin modules are enabled for this role.");
      return;
    }
    const summaryText = moduleGroupSummary.map((group) => `${group.label}: ${group.count}`).join("\n");
    void notifyInfo("Sidebar Modules", `Total: ${totalSidebarModules}\n${summaryText}`);
  };
  if (!user) return null;

  const getPrimaryAction = (targetUser) => {
    const isActive = normalizeAccountStatus(targetUser?.status, targetUser?.status_name, targetUser?.status_type) === 1;
    if (userPanelMode === "archived" || !isActive) {
      return { label: "Restore", background: "var(--brand-600)" };
    }
    return { label: "Set Inactive", background: "var(--danger-600)" };
  };
  const handlePrimaryAction = async (targetUser) => {
    const isActive = normalizeAccountStatus(targetUser?.status, targetUser?.status_name, targetUser?.status_type) === 1;
    if (userPanelMode === "archived" || !isActive) {
      await restoreUser(targetUser);
      return;
    }
    await deactivateUser(targetUser);
  };
  const moduleTransition = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
    transition: { duration: 0.25, ease: "easeOut" },
  };
  const overviewCards = [
    {
      label: "Total Users",
      value: totalUsers,
      onClick: () => void openUsersPanel("total"),
      ariaLabel: "View all users",
    },
    {
      label: "Active Users",
      value: activeUsers,
      tone: "success",
      onClick: () => void openUsersPanel("active"),
      ariaLabel: "View active users",
    },
    {
      label: "Archived Users",
      value: pendingUsers,
      onClick: () => void openUsersPanel("archived"),
      ariaLabel: "View archived user quick actions",
    },
    {
      label: "Sidebar Modules",
      value: totalSidebarModules,
      onClick: openModuleSummary,
      ariaLabel: "View sidebar module summary",
    },
  ];
  const reportModuleProps = {
    defaultReport: reportView,
    onReportChange: setReportView,
  };

  const sidebar = (
    <Sidebar>
      <SidebarList>
        {/* The survey modules used to be collapsed into a hand-built "Survey
            Master" group. That is one of the registry's own groups, so they now
            sit under its section title with everything else — the label is the
            same, and admin's 20-plus entries stay scannable without a control
            that hides four of them. */}
        <GrantedModuleSidebarSections
          modules={accessibleModules}
          activeView={activeView}
          onSelect={setActiveView}
          labels={{ overview: "Dashboard" }}
          slots={{
            // Settings is reached from the account menu, not the rail — see the
            // note on settingsModule above. A null slot is what keeps it out
            // now that the rail is fed the full module list.
            settings: null,
            reports: reportModule ? (
              <ReportsSidebarGroup
                user={user}
                activeView={activeView}
                reportView={reportView}
                expanded={reportsOpen}
                onToggle={() => setReportsOpen((value) => !value)}
                onSelectReport={(nextReport) => {
                  setActiveView("reports");
                  setReportView(nextReport);
                  setReportsOpen(true);
                }}
                label={reportModule.label}
              />
            ) : null,
          }}
        />
      </SidebarList>
    </Sidebar>
  );

  return (
    <DashboardShell
      layout="admin"
      title="COC Admin Dashboard"
      user={user}
      sidebar={sidebar}
      onUserUpdate={setUser}
      onSettings={settingsModule ? () => setActiveView(settingsModule.view) : null}
      settingsLabel={settingsModule?.label}
      breadcrumbSegments={breadcrumbSegments}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeView}
          initial={moduleTransition.initial}
          animate={moduleTransition.animate}
          exit={moduleTransition.exit}
          transition={moduleTransition.transition}
          style={activeView === "reports" ? { height: "100%", minHeight: 0 } : undefined}
        >
          {noModulesEnabled ? (
            <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
              No admin modules are enabled for this role. Update the role checklist in role permissions to restore access.
            </DashboardPanel>
          ) : null}

          {activeView === "overview" && overviewEnabled ? (
            <>
              <AdminOverviewWorkspace
                firstName={firstName}
                overviewCards={overviewCards}
                flatModuleList={flatModuleList}
                activeView={activeView}
                activeModuleIndex={activeModuleIndex}
                selectedModule={selectedModule}
                moduleGroupSummary={moduleGroupSummary}
                onSelectModule={setActiveView}
              />
              {/* Same components the Dean sees, in the same order: the matrix
                  leads because it names who needs attention now, and the charts
                  below are context for it. The endpoints report
                  can_choose_department for admin, so both filters render. */}
              <div style={{ marginTop: 19, display: "grid", gap: 19 }}>
                <ScopedRetentionMatrix />
                <OverviewCharts title="Institution at a glance" />
              </div>
            </>
          ) : null}

          {activeModule && activeView !== "overview" ? (
            <GrantedModuleView
              module={activeModule}
              user={user}
              modules={accessibleModules}
              moduleProps={activeView === "reports"
                ? reportModuleProps
                : activeView === "settings"
                ? { defaultSection: dashboardIntent.section }
                : {}}
            />
          ) : null}
        </motion.div>
      </AnimatePresence>
      <InactiveUsersQuickPanel
        open={inactiveUsersOpen}
        title={userPanelConfig.title}
        description={userPanelConfig.description}
        users={filteredInactiveUsers}
        totalCount={inactiveUsers.length}
        loading={inactiveUsersLoading}
        error={inactiveUsersError}
        search={inactiveUsersSearch}
        actionUserId={inactiveUserActionId}
        summaryLabel={userPanelSummaryLabel}
        emptyLabel={userPanelConfig.emptyLabel}
        onClose={() => setInactiveUsersOpen(false)}
        onSearchChange={setInactiveUsersSearch}
        onPrimaryAction={(targetUser) => {
          void handlePrimaryAction(targetUser);
        }}
        getPrimaryAction={getPrimaryAction}
        onManage={manageUser}
      />
    </DashboardShell>
  );
}
