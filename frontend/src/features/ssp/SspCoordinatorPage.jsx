import React, { useCallback, useEffect, useMemo, useState } from "react";
import AssignmentsWorkspace, { hasCoach } from "./AssignmentsWorkspace";
import FollowUpTeamOverview from "./FollowUpTeamOverview";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import { DashboardShell, OverviewHeader } from "../../shared/layout/dashboard";
import { getReportLabel, GrantedModuleSidebarSections, GrantedModuleView, ReportsSidebarGroup } from "../../pages/dashboards/SharedGrantedModules";
import {
  getDashboardModule,
  getEffectiveDashboardModules,
  getExtraDashboardModules,
  resolveAccessibleDashboardView,
} from "../../pages/dashboards/moduleAccess";
import { hasRole, readAuthUser, replacePath } from "../../shared/lib/auth";
import { getBackendUrl } from "../../shared/lib/url";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";
import AlertMessage from "../../shared/components/ui/AlertMessage";

const DEFAULT_VIEWS = ["overview", "assignments"];



export default function SspCoordinatorWorkspace() {
  const [user, setUser] = useState(null);
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportView, setReportView] = useState(() => getInitialDashboardIntentValue("report", "retention"));
  // The assignment table lives in AssignmentsWorkspace and the team numbers in
  // FollowUpTeamOverview; both load their own data. What stays here is the
  // board count behind the header's "Assign N without a coach" shortcut.
  const [error, setError] = useState("");
  const [students, setStudents] = useState([]);
  useDashboardIntent({
    onView: setActiveView,
    onReport: setReportView,
    activeView,
    activeReport: activeView === "reports" ? reportView : "",
    persist: true,
  });

  useEffect(() => {
    const parsed = readAuthUser();
    if (!hasRole(parsed, { id: 5, name: "ssp coordinator" })) {
      replacePath("/");
      return;
    }
    setUser(parsed);
  }, []);

  const loadBoard = useCallback(async () => {
    setError("");
    try {
      const res = await fetch(getBackendUrl("ssp_assignment.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to load SSP coordinator workspace");

      setStudents(Array.isArray(data?.students) ? data.students : []);
    } catch (loadError) {
      setStudents([]);
      setError(loadError?.message || "Failed to load SSP coordinator workspace");
    }
  }, []);

  useEffect(() => {
    if (!user) return;
    void loadBoard();
  }, [loadBoard, user, activeView]);

  useEffect(() => {
    if (!user) return undefined;

    const handleFocus = () => {
      void loadBoard();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadBoard();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [loadBoard, user]);

  const accessibleModules = useMemo(() => getEffectiveDashboardModules(user, "ssp-coordinator"), [user]);
  const overviewModule = useMemo(() => getDashboardModule(accessibleModules, "overview"), [accessibleModules]);
  const assignmentsModule = useMemo(() => getDashboardModule(accessibleModules, "assignments"), [accessibleModules]);
  const extraModules = useMemo(() => getExtraDashboardModules(accessibleModules, DEFAULT_VIEWS), [accessibleModules]);
  const reportsModule = useMemo(() => getDashboardModule(extraModules, "reports"), [extraModules]);
  const nonReportExtraModules = useMemo(() => extraModules.filter((module) => module.view !== "reports"), [extraModules]);
  const grantedModule = useMemo(() => getDashboardModule(nonReportExtraModules, activeView), [activeView, nonReportExtraModules]);
  // Passed straight through: AssignmentsWorkspace derives its own can-assign /
  // can-unassign flags, so this page no longer duplicates that logic.
  const assignmentPermissions = assignmentsModule?.permissions || [];
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
    if (activeView === "assignments" && assignmentsModule) {
      segments.push({ label: assignmentsModule.label || "Assignments", current: true });
      return segments;
    }
    if (grantedModule?.label) {
      segments.push({ label: grantedModule.label, current: true });
    }
    return segments;
  }, [activeView, assignmentsModule, grantedModule?.label, overviewModule, reportView, reportsModule]);

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

  // Hoisted out of summaryCards: the welcome shortcut needs the same number, and
  // recomputing the filter in the JSX would let the two drift apart.
  //
  // Students without a coach - the server's `coach`, which is the unit's coach
  // and never the coordinator, who may also be on the student but is not it.
  const unassignedStudentCount = useMemo(
    () => students.filter((student) => !hasCoach(student)).length,
    [students]
  );


  const sidebar = (
    <Sidebar>
      <SidebarList>
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


  if (!user) return null;

  return (
    <DashboardShell title="COC SSP Coordinator Dashboard" user={user} sidebar={sidebar} onUserUpdate={setUser} breadcrumbSegments={breadcrumbSegments}>
      {activeView === "overview" && overviewModule ? (
        <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
          {/* One greeting: see the note on SspCallerPage. Subtitle and shortcut
              move onto the header rather than being dropped. */}
          <OverviewHeader
            roleLabel="SSP Coordinator"
            user={user}
            subtitle="Review your Non-STAR students who still need enrollment updates and route them to your coaches."
            action={
              unassignedStudentCount > 0
                ? { label: `Assign ${unassignedStudentCount} without a coach (P1-P2)`, onClick: () => setActiveView("assignments") }
                : null
            }
          />
          <AlertMessage message={error} tone="error" />

          <FollowUpTeamOverview onOpenAssignments={assignmentsModule ? () => setActiveView("assignments") : undefined} />
        </section>
      ) : null}

      {activeView === "assignments" && assignmentsModule ? (
        <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
          <OverviewHeader title="Student Assignments" />
          <AssignmentsWorkspace permissions={assignmentPermissions} />
        </section>
      ) : null}

      {activeView === "reports" && reportsModule ? (
        <GrantedModuleView module={reportsModule} user={user} moduleProps={{ defaultReport: reportView, onReportChange: setReportView }} />
      ) : null}
      {grantedModule ? <GrantedModuleView module={grantedModule} user={user} modules={accessibleModules} /> : null}
    </DashboardShell>
  );
}
