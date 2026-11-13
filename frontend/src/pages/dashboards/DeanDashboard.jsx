import React, { useEffect, useMemo, useState } from "react";
import StudentManage from "../../features/students/StudentsPage";
import StudentMigrationSummary from "../../features/student-migration/StudentMigrationSummary";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import { DashboardShell, OverviewHeader, OverviewStatCards } from "../../shared/layout/dashboard";
import { OverviewCharts, ScopedRetentionMatrix } from "../../shared/components/charts";
import { getReportLabel, GrantedModuleSidebarSections, GrantedModuleView, ReportsSidebarGroup } from "./SharedGrantedModules";
import {
  getDashboardModule,
  getEffectiveDashboardModules,
  getExtraDashboardModules,
  resolveAccessibleDashboardView,
} from "./moduleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { readAuthUser, replacePath } from "../../shared/lib/auth";
import { getRoleSlug } from "../../shared/lib/roles";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";
import { canModuleAction } from "../../shared/lib/roleAccess";

const DEFAULT_VIEWS = ["overview", "student_manage"];

/**
 * Both roles that this dashboard serves.
 *
 * A Program Head is the dean's assistant: same modules, same department, so the
 * same screen rather than a second copy of it. The gate below is a slug check
 * instead of the previous hasRole({ id: 3 }) because that hardcoded id would
 * bounce a Program Head straight back to "/" — the server would have authorised
 * every request they then failed to make.
 *
 * This is a convenience gate, not the security boundary. Department pinning is
 * enforced server-side by api_user_is_department_pinned(); nothing here is
 * trusted to keep one department out of another's data.
 */
const DASHBOARD_ROLE_SLUGS = ["dean", "program-head"];

export default function DeanDashboard() {
  const [user, setUser] = useState(null);
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportView, setReportView] = useState(() => getInitialDashboardIntentValue("report", "students"));
  const [departmentId, setDepartmentId] = useState(null);
  const [departmentName, setDepartmentName] = useState("");
  const [totalStudents, setTotalStudents] = useState(null);
  // Carried from the Overview tile into the module so the list opens already
  // filtered to the status that was clicked.
  const [migrationStatus, setMigrationStatus] = useState("");
  useDashboardIntent({
    onView: setActiveView,
    onReport: setReportView,
    activeView,
    activeReport: activeView === "reports" ? reportView : "",
    persist: true,
  });

  useEffect(() => {
    const parsed = readAuthUser();
    if (!DASHBOARD_ROLE_SLUGS.includes(getRoleSlug(parsed))) {
      replacePath("/");
      return;
    }
    setUser(parsed);
  }, []);

  useEffect(() => {
    const deptId = user?.department_id ? Number(user.department_id) : null;
    setDepartmentId(Number.isFinite(deptId) && deptId > 0 ? deptId : null);
    setDepartmentName(user?.department_name || "");
  }, [user]);

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      try {
        if (!departmentId) {
          setTotalStudents(null);
          return;
        }
        const params = new URLSearchParams();
        params.set("limit", "1");
        params.set("department_id", String(departmentId));
        const res = await fetch(getBackendUrl(`student.php?${params.toString()}`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json?.message || "Failed to load student summary");
        const total = json?.pagination?.total;
        if (!cancelled) {
          setTotalStudents(typeof total === "number" ? total : null);
        }
      } catch {
        if (!cancelled) {
          setTotalStudents(null);
        }
      }
    }

    loadSummary();
    return () => {
      cancelled = true;
    };
  }, [departmentId]);

  // The caller's own slug, not a literal "dean" — otherwise a Program Head with
  // no saved permission rows would fall back to the dean's defaults instead of
  // their own, and an admin narrowing one role would not affect this screen.
  const accessibleModules = useMemo(() => getEffectiveDashboardModules(user, getRoleSlug(user)), [user]);
  const overviewModule = useMemo(() => getDashboardModule(accessibleModules, "overview"), [accessibleModules]);
  const studentManageModule = useMemo(() => getDashboardModule(accessibleModules, "student_manage"), [accessibleModules]);
  // The matrix reads retention data, so it needs retention_cases:view. Deans do
  // not automatically hold it — the role can carry the module row with every
  // action set to 0 — and without this check the widget fired a request that
  // came back 403 and made the whole Overview look broken.
  const retentionModule = useMemo(() => getDashboardModule(accessibleModules, "retention_cases"), [accessibleModules]);
  const canViewRetention = useMemo(() => canModuleAction(retentionModule?.permissions, "view"), [retentionModule]);
  const extraModules = useMemo(() => getExtraDashboardModules(accessibleModules, DEFAULT_VIEWS), [accessibleModules]);
  const reportsModule = useMemo(() => getDashboardModule(extraModules, "reports"), [extraModules]);
  const nonReportExtraModules = useMemo(() => extraModules.filter((module) => module.view !== "reports"), [extraModules]);
  const grantedModule = useMemo(() => getDashboardModule(nonReportExtraModules, activeView), [activeView, nonReportExtraModules]);
  const breadcrumbSegments = useMemo(() => {
    if (activeView === "overview") return [];

    const segments = [];
    if (overviewModule) {
      segments.push({
        label: overviewModule.label || "Overview",
        onClick: () => setActiveView("overview"),
      });
    }
    if (activeView === "reports" && reportsModule) {
      segments.push({
        label: reportsModule.label || "Reports",
        onClick: () => {
          setActiveView("reports");
          setReportsOpen(true);
        },
      });
      segments.push({ label: getReportLabel(reportView), current: true });
      return segments;
    }
    if (activeView === "student_manage" && studentManageModule) {
      segments.push({ label: studentManageModule.label || "Student Management", current: true });
      return segments;
    }
    if (grantedModule?.label) {
      segments.push({ label: grantedModule.label, current: true });
    }
    return segments;
  }, [activeView, grantedModule?.label, overviewModule, reportView, reportsModule, studentManageModule]);

  useEffect(() => {
    if (activeView === "reports") {
      setReportsOpen(true);
    }
  }, [activeView]);

  useEffect(() => {
    const nextView = resolveAccessibleDashboardView(activeView, accessibleModules, DEFAULT_VIEWS);
    if (nextView && nextView !== activeView) {
      setActiveView(nextView);
    }
  }, [activeView, accessibleModules]);

  if (!user) return null;

  const overviewCards = [
    { label: "Department", value: departmentName || "Not Assigned" },
    { label: "Total Students (My Department)", value: totalStudents },
  ];

  const sidebar = (
    <Sidebar>
      <SidebarList>
        {/* Every entry, including Overview and Student Management, now comes
            from the module registry under its group title — they were pinned
            here by hand purely to control their order, which the registry
            already decides. */}
        <GrantedModuleSidebarSections
          modules={accessibleModules}
          activeView={activeView}
          onSelect={setActiveView}
          slots={{
            reports: reportsModule ? (
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
              />
            ) : null,
          }}
        />
      </SidebarList>
    </Sidebar>
  );

  return (
    <DashboardShell
      title="COC Dean Dashboard"
      user={user}
      sidebar={sidebar}
      onUserUpdate={setUser}
      breadcrumbSegments={breadcrumbSegments}
    >
      {activeView === "overview" && overviewModule ? (
        <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
          <OverviewHeader
            roleLabel="Dean"
            user={user}
            scope={[
              { label: "Department", value: departmentName },
              { label: "Campus", value: user?.campus_name },
            ]}
          />
          <OverviewStatCards items={overviewCards} minWidth={240} />

          {/* Matrix first: it is the one panel that says who needs attention
              now, so it leads. The charts below are context for it.

              Same wrapper Admin and SSG use, so a dean gets the school-year and
              semester filters as well. No department chooser appears — the
              endpoint reports can_choose_department false for a dean and pins
              them to their own department regardless of what is asked for. */}
          {canViewRetention ? <ScopedRetentionMatrix /> : null}

          {/* Same three charts the Admin and SSG overviews get. No department
              chooser appears here: overview_analytics.php pins a dean to their
              own department, so there is nothing to choose. */}
          <OverviewCharts title="Department at a glance" />

          {/* Hides itself when the module is not granted, so it is safe to render
              unconditionally — see StudentMigrationSummary. */}
          <StudentMigrationSummary
            onOpen={(statusId) => {
              setMigrationStatus(statusId || "");
              setActiveView("student_migration");
            }}
          />
        </section>
      ) : null}

      {activeView === "student_manage" && studentManageModule ? (
        <StudentManage
          departmentId={departmentId}
          departmentName={departmentName}
          campusName={user?.campus_name || ""}
          permissions={studentManageModule.permissions}
        />
      ) : null}
      {activeView === "reports" && reportsModule ? (
        <GrantedModuleView
          module={reportsModule}
          user={user}
          moduleProps={{ defaultReport: reportView, onReportChange: setReportView }}
        />
      ) : null}
      {grantedModule ? (
        <GrantedModuleView
          module={grantedModule}
          user={user}
          modules={accessibleModules}
          moduleProps={grantedModule.view === "student_migration" ? { initialStatus: migrationStatus } : {}}
        />
      ) : null}
    </DashboardShell>
  );
}
