import React, { useEffect, useMemo, useState } from "react";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import {
  ActivityTable,
  DashboardShell,
  OverviewHeader,
} from "../../shared/layout/dashboard";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { readAuthUser } from "../../shared/lib/auth";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";
import { useCurrentTermBadge } from "../../shared/lib/currentTerm";
import { getRoleLabel } from "../../shared/lib/roles";
import { getReportLabel, GrantedModuleSidebarSections, GrantedModuleView, getReportsConfig, ReportsSidebarGroup } from "./SharedGrantedModules";
import RetentionOverview from "../../features/student-contacts/RetentionOverview";
import FacultyOverview from "../../features/faculty-workspace/FacultyOverview";
import FollowUpTeamOverview from "../../features/ssp/FollowUpTeamOverview";
import HomeVisitOverview from "../../features/home-visits/HomeVisitOverview";
import {
  getDashboardModule,
  getEffectiveDashboardModules,
  getExtraDashboardModules,
  resolveAccessibleDashboardView,
} from "./moduleAccess";

const DEFAULT_VIEWS = ["overview", "reports"];

export default function GenericRoleDashboard({ user: userProp, roleSlug }) {
  /*
   * Which term the work on this screen belongs to.
   *
   * Faculty, department callers and SSP callers all land here, and none of
   * their screens said which period, semester or school year the calls they
   * were logging belonged to. The queues are live and unfiltered by term, so
   * they look identical in August and in March.
   *
   * It is not a filter and must not become one.
   */
  const termBadge = useCurrentTermBadge();
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportView, setReportView] = useState(() => getInitialDashboardIntentValue("report", getReportsConfig(roleSlug).allowedReports[0] || "survey"));
  const [user, setUser] = useState(userProp ?? readAuthUser());
  useDashboardIntent({
    onView: setActiveView,
    onReport: setReportView,
    activeView,
    activeReport: activeView === "reports" ? reportView : "",
    persist: true,
  });
  const roleLabel = getRoleLabel(user, roleSlug);
  const reportOptions = useMemo(() => getReportsConfig(roleSlug).allowedReports, [roleSlug]);
  const accessibleModules = useMemo(() => getEffectiveDashboardModules(user, roleSlug), [roleSlug, user]);
  const overviewModule = useMemo(() => getDashboardModule(accessibleModules, "overview"), [accessibleModules]);
  const reportsModule = useMemo(() => getDashboardModule(accessibleModules, "reports"), [accessibleModules]);
  /*
   * Roles that own a Contact Workspace (KASAMA coach, KASAMA TL, department
   * callers) get a live retention snapshot in place of the empty activity
   * table. Roles without one keep the plain overview.
   *
   * Faculty dropped out of this on 2026-09-04 along with the module, and the
   * gate is what makes that safe rather than broken: the snapshot fetches
   * student_contact_workflow.php, which now refuses them. Rendering it on the
   * strength of the role name instead of the module would have put a 403 on
   * their landing page.
   */
  const contactModule = useMemo(() => getDashboardModule(accessibleModules, "student_contacts"), [accessibleModules]);
  /*
   * Faculty get their own snapshot, for the same reason and under the same
   * rule: gate on the MODULE, never on the role name.
   *
   * faculty_workspace.php refuses an account without `faculty_workspace.view`,
   * so reading the grant is what keeps this from putting a 403 on somebody's
   * landing page — and it means an account GIVEN the workspace later gets the
   * snapshot with no change here.
   *
   * Second in line behind the contact snapshot, which is deliberate rather than
   * arbitrary: an account holding both is a caller who also teaches, and the
   * calling queue is the work they are measured on. In practice the two grants
   * do not overlap.
   */
  const facultyModule = useMemo(() => getDashboardModule(accessibleModules, "faculty_workspace"), [accessibleModules]);
  /*
   * A team supervisor's numbers - their students and their coaches. The KSH TL
   * is the one supervisor that lands here; the SSP Coordinator has its own page
   * rendering the same component.
   *
   * Gated on the module like the two above. The server then answers null for an
   * account holding `assignments` without supervising a team, and the component
   * renders nothing for it.
   */
  const assignmentsModule = useMemo(() => getDashboardModule(accessibleModules, "assignments"), [accessibleModules]);
  /*
   * CSDL's snapshot: the home-visit queue (2026-10-07). Until then CSDL landed
   * on the empty activity table below. Gated on the module like the others -
   * home_visit_queue.php answers the module's holders - and last in line,
   * because an account holding a calling queue as well is a caller first.
   */
  const homeVisitsModule = useMemo(() => getDashboardModule(accessibleModules, "home_visits"), [accessibleModules]);
  const extraModules = useMemo(() => getExtraDashboardModules(accessibleModules, DEFAULT_VIEWS), [accessibleModules]);
  const grantedModule = useMemo(() => getDashboardModule(extraModules, activeView), [activeView, extraModules]);

  useEffect(() => {
    setUser(userProp ?? readAuthUser());
  }, [userProp]);

  useEffect(() => {
    if (activeView === "reports") {
      setReportsOpen(true);
    }
  }, [activeView]);

  useEffect(() => {
    if (!reportOptions.includes(reportView)) {
      setReportView(reportOptions[0] || "survey");
    }
  }, [reportOptions, reportView]);

  useEffect(() => {
    const nextView = resolveAccessibleDashboardView(activeView, accessibleModules, DEFAULT_VIEWS);
    if (nextView && nextView !== activeView) {
      setActiveView(nextView);
    }
  }, [activeView, accessibleModules]);

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

    if (grantedModule?.label) {
      segments.push({ label: grantedModule.label, current: true });
    }

    return segments;
  }, [activeView, grantedModule?.label, overviewModule, reportView, reportsModule]);

  if (!user) return null;

  const sidebar = (
    <Sidebar>
      <SidebarList>
        <GrantedModuleSidebarSections
          modules={accessibleModules}
          activeView={activeView}
          onSelect={setActiveView}
          slots={{
            reports: reportsModule ? (
              // `user` is what the group reads the permissions from. Without
              // it every report resolved to "not permitted" and the group drew
              // nothing, so these roles had no Reports entry at all.
              <ReportsSidebarGroup
                user={user}
                roleSlug={roleSlug}
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

  const activityColumns = [
    { key: "type", label: "Type", nowrap: true },
    { key: "detail", label: "Detail" },
    { key: "date", label: "Date", nowrap: true },
  ];

  return (
    <DashboardShell
      title={`COC ${roleLabel} Dashboard`}
      user={user}
      sidebar={sidebar}
      onUserUpdate={setUser}
      breadcrumbSegments={breadcrumbSegments}
    >
      {activeView === "overview" && overviewModule ? (
        <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
          <OverviewHeader roleLabel={roleLabel} user={user} term={termBadge} />

          {assignmentsModule ? (
            <FollowUpTeamOverview onOpenAssignments={() => setActiveView("assignments")} />
          ) : null}

          {contactModule ? (
            <RetentionOverview
              onOpenWorkspace={() => setActiveView("student_contacts")}
              scopeNote={
                roleSlug === "ksh-coach" || roleSlug === "ksh-tl"
                  ? "Only your STAR (KASAMA) students are shown here."
                  : roleSlug === "faculty" || roleSlug === "dept-caller"
                    ? "Only students in your department are shown here."
                    : "Only your assigned students are shown here."
              }
            />
          ) : facultyModule ? (
            <FacultyOverview onOpenWorkspace={() => setActiveView("retention_cases")} />
          ) : homeVisitsModule ? (
            <HomeVisitOverview onOpenWorkspace={() => setActiveView("home_visits")} />
          ) : (
            <ActivityTable
              subtitle={`This section will show the latest updates for ${roleLabel}.`}
              columns={activityColumns}
              rows={[]}
              emptyText="No activity yet."
            />
          )}
        </section>
      ) : null}

      {activeView === "reports" && reportsModule ? (
        <GrantedModuleView
          module={reportsModule}
          user={user}
          moduleProps={{ defaultReport: reportView, onReportChange: setReportView }}
        />
      ) : null}

      {grantedModule ? <GrantedModuleView module={grantedModule} user={user} modules={accessibleModules} /> : null}
    </DashboardShell>
  );
}
