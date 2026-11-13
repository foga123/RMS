import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import { DashboardShell, OverviewHeader, OverviewStatCards } from "../../shared/layout/dashboard";
import { OverviewCharts, ScopedRetentionMatrix } from "../../shared/components/charts";
import { getReportLabel, GrantedModuleSidebarSections, GrantedModuleView, ReportsSidebarGroup } from "../../pages/dashboards/SharedGrantedModules";
import {
  getDashboardModule,
  getEffectiveDashboardModules,
  getExtraDashboardModules,
  resolveAccessibleDashboardView,
} from "../../pages/dashboards/moduleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { hasRole, readAuthUser, replacePath } from "../../shared/lib/auth";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";
import { getRoleLabel } from "../../shared/lib/roles";

const SURVEY_MODULE_VIEWS = new Set(["survey", "survey_questions", "survey_responses", "survey_submissions"]);
const DEFAULT_VIEWS = ["overview", "survey", "survey_questions", "survey_responses", "survey_submissions"];

/**
 * The four survey totals, for whichever term the matrix below is showing.
 *
 * One request to survey-summary.php, which was four paginated requests to
 * survey.php / survey_question.php / survey_response.php / survey_submission.php
 * read only for their `pagination.total`. Those four had no way to take a term
 * or to skip an inactive survey, so the cards reported lifetime totals beside a
 * grid scoped to one semester and the two never agreed.
 */
async function fetchSurveyTotals(scope) {
  const params = new URLSearchParams();
  if (scope?.departmentId) params.set("department_id", String(scope.departmentId));
  if (scope?.schoolYearId) params.set("school_year_id", String(scope.schoolYearId));
  if (scope?.semesterId) params.set("semester_id", String(scope.semesterId));
  // Only the totals are wanted here; the answer drill-down is a whole screen of
  // its own, and the smallest page keeps this cheap.
  params.set("page_size", "10");

  try {
    const res = await fetch(getBackendUrl(`survey-summary.php?${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) return null;
    const data = json?.data || {};
    return {
      surveys: Number(data.total_surveys) || 0,
      questions: Number(data.total_questions) || 0,
      responses: Number(data.total_responses) || 0,
      submissions: Number(data.total_submissions) || 0,
      scope: data.totals_scope || {},
    };
  } catch {
    return null;
  }
}

export default function SsgDashboard() {
  const [user, setUser] = useState(null);
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportView, setReportView] = useState(() => getInitialDashboardIntentValue("report", "students"));
  const [summary, setSummary] = useState({
    surveys: null,
    questions: null,
    responses: null,
    submissions: null,
    scope: {},
  });
  /*
   * The matrix owns the term choosers, so the cards read them from it rather
   * than growing a second row of dropdowns that could disagree.
   */
  const [matrixScope, setMatrixScope] = useState({
    campusId: null,
    departmentId: null,
    schoolYearId: null,
    semesterId: null,
  });
  useDashboardIntent({
    onView: setActiveView,
    onReport: setReportView,
    activeView,
    activeReport: activeView === "reports" ? reportView : "",
    persist: true,
  });

  useEffect(() => {
    const parsed = readAuthUser();
    const isSsg = hasRole(parsed, { id: 2, name: "ssg" });
    const isSecretary = hasRole(parsed, { id: 9, name: "secretary" });
    if (!isSsg && !isSecretary) {
      replacePath("/");
      return;
    }
    setUser(parsed);
  }, []);

  useEffect(() => {
    if (activeView === "reports") {
      setReportsOpen(true);
    }
  }, [activeView]);

  useEffect(() => {
    let cancelled = false;

    async function loadSummary() {
      if (!user) return;
      const totals = await fetchSurveyTotals(matrixScope);
      if (!cancelled && totals) setSummary(totals);
    }

    loadSummary();
    return () => {
      cancelled = true;
    };
  }, [user, matrixScope]);

  const accessibleModules = useMemo(() => getEffectiveDashboardModules(user, "ssg"), [user]);
  const overviewModule = useMemo(() => getDashboardModule(accessibleModules, "overview"), [accessibleModules]);
  /*
   * One survey module, not four.
   *
   * The rail collapsed the four survey entries into a single workspace entry,
   * but this dashboard kept mounting the four pages itself, one per activeView.
   * The result was that SSG and Secretary lost three of the four screens: the
   * rail no longer offered Questions, Submissions or Answers, and nothing here
   * rendered the tab bar that was supposed to replace those entries. Every
   * other dashboard reaches the survey screens through GrantedModuleView, which
   * resolves them to the workspace; this one is now the same.
   *
   * The module is looked up by activeView rather than pinned to "survey" so a
   * restored view - useDashboardIntent persists it across reloads - opens on
   * the tab it names instead of dropping back to the first one.
   */
  const activeSurveyModule = useMemo(
    () => (SURVEY_MODULE_VIEWS.has(activeView) ? getDashboardModule(accessibleModules, activeView) : null),
    [accessibleModules, activeView]
  );
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

    if (activeView === "reports") {
      segments.push({
        label: reportsModule?.label || "Reports",
        onClick: () => {
          setActiveView("reports");
          setReportsOpen(true);
        },
      });
      segments.push({ label: getReportLabel(reportView), current: true });
      return segments;
    }

    if (SURVEY_MODULE_VIEWS.has(activeView)) {
      /*
       * The trail stops at the workspace. Its tabs move between the four
       * screens without changing activeView, so a leaf naming one of them
       * would be wrong the moment a tab is clicked - and the tab bar already
       * says which screen you are on. Matches the admin dashboard.
       */
      segments.push({ label: "Survey Master", current: true });
      return segments;
    }

    if (grantedModule?.label) {
      segments.push({ label: grantedModule.label, current: true });
    }

    return segments;
  }, [activeView, grantedModule?.label, overviewModule, reportView, reportsModule]);

  useEffect(() => {
    const nextView = resolveAccessibleDashboardView(activeView, accessibleModules, DEFAULT_VIEWS);
    if (nextView && nextView !== activeView) {
      setActiveView(nextView);
    }
  }, [activeView, accessibleModules]);

  if (!user) return null;

  const dashboardRoleLabel = getRoleLabel(user, "ssg");
  const moduleTransition = {
    initial: { opacity: 0, y: 10 },
    animate: { opacity: 1, y: 0 },
    exit: { opacity: 0, y: -8 },
    transition: { duration: 0.25, ease: "easeOut" },
  };

  const sidebar = (
    <Sidebar>
      <SidebarList>
        {/* The four survey modules were a hand-built "Survey Master" collapsible
            here. They are one workspace now, so the section holds a single
            entry that opens it — the four screens are its tabs. The section
            title still reads "Survey Master", which is what that entry is. */}
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

  /*
   * What the four numbers were counted under, said on the cards.
   *
   * A stat tile is read as a fact about everything unless it says otherwise, so
   * a number that has just dropped because a semester was picked - or because
   * an inactive survey stopped counting - has to explain itself where it is
   * read, not in a tooltip.
   */
  const totalsScope = summary.scope || {};
  const excluded = Number(totalsScope.inactive_surveys_excluded) || 0;
  const termMeta = totalsScope.semester_id ? "This semester" : "All semesters";
  const activeMeta = excluded > 0
    ? `${termMeta} · ${excluded} inactive survey${excluded === 1 ? "" : "s"} not counted`
    : `${termMeta} · active surveys`;

  const overviewCards = [
    { label: "Total Surveys", value: summary.surveys, meta: activeMeta },
    { label: "Total Questions", value: summary.questions, meta: activeMeta },
    {
      label: "Total Responses",
      value: summary.responses,
      tone: "success",
      meta: totalsScope.school_year_id ? `${termMeta} · this school year` : termMeta,
    },
    {
      label: "Total Submissions",
      value: summary.submissions,
      meta: totalsScope.school_year_id ? `${termMeta} · this school year` : termMeta,
    },
  ];

  return (
    <DashboardShell
      title={`COC ${dashboardRoleLabel} Dashboard`}
      user={user}
      sidebar={sidebar}
      onUserUpdate={setUser}
      breadcrumbSegments={breadcrumbSegments}
    >
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={activeView}
          initial={moduleTransition.initial}
          animate={moduleTransition.animate}
          exit={moduleTransition.exit}
          transition={moduleTransition.transition}
        >
          {activeView === "overview" && overviewModule ? (
            <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
              {/* One greeting, not two. This used to render a WelcomeCard
                  ("Welcome, Test") directly above OverviewHeader ("Good
                  evening, Test") — the same salutation twice, in two type
                  sizes. The card's subtitle was the only thing it said that the
                  header did not, so it moves across as the subtitle.

                  No shortcut here: the only number the card had was the
                  lifetime submissions total, which is not actionable and is
                  already shown in the stat cards directly below. */}
              <OverviewHeader
                roleLabel={dashboardRoleLabel}
                user={user}
                subtitle="Manage surveys, questions, and submitted student responses."
              />
              <OverviewStatCards items={overviewCards} minWidth={220} />

              {/* Matrix first, matching the Dean and Admin overviews. SSG reads
                  every department, so both choosers render here as they do for
                  admin — the endpoints decide that, not this call. */}
              <ScopedRetentionMatrix onScopeChange={setMatrixScope} />
              <OverviewCharts title="Institution at a glance" />
            </section>
          ) : null}

          {/* Surveys, Questions, Submissions and Answers, as tabs. `modules`
              is the whole granted set because that is what decides which of
              the four tabs this account is allowed to see. */}
          {activeSurveyModule ? (
            <GrantedModuleView module={activeSurveyModule} user={user} modules={accessibleModules} />
          ) : null}
          {activeView === "reports" && reportsModule ? (
            <GrantedModuleView module={reportsModule} user={user} moduleProps={{ defaultReport: reportView, onReportChange: setReportView }} />
          ) : null}
          {grantedModule ? <GrantedModuleView module={grantedModule} user={user} modules={accessibleModules} /> : null}
        </motion.div>
      </AnimatePresence>
    </DashboardShell>
  );
}
