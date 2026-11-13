import React, { Suspense, lazy } from "react";
import { SidebarGroup, SidebarItem, SidebarSection } from "../../shared/layout/Sidebar";
import { AlertMessage, Skeleton } from "../../shared/components/ui";
import { DashboardPanel, OverviewHeader } from "../../shared/layout/dashboard";
import { canModuleAction, getModuleAccessMeta } from "../../shared/lib/roleAccess";
import { getRoleSlug } from "../../shared/lib/roles";
import { getEffectiveDashboardModules } from "./moduleAccess";
import { MODULE_COMPONENTS } from "../../app/moduleComponents";
import { MODULE_GROUPS } from "../../app/moduleRegistry";
/*
 * Named here rather than taken from MODULE_COMPONENTS because they are not
 * rendered as plain permission-module pages: student management is wrapped to
 * inject department scoping, reports is wrapped to filter the report list by
 * permission, and the student survey is a different component from the survey
 * management page.
 *
 * Lazy for the same reason the module map is. These four are among the largest
 * screens in the app, and being imported here — a file every dashboard loads to
 * draw its sidebar — put all four in the first script the browser parsed, for
 * every account, whether or not it could open any of them.
 *
 * surveyTabs is a static import on purpose: it is a small pure module of view
 * names, and the sidebar calls isSurveyWorkspaceView() while deciding what to
 * draw, long before any survey page is opened.
 */
import { SURVEY_WORKSPACE_VIEWS, isSurveyWorkspaceView } from "../../features/surveys/surveyTabs";

const StudentManage = lazy(() => import("../../features/students/StudentsPage"));
const ReportsPage = lazy(() => import("../../features/reports/ReportsPage"));
const SurveyWorkspace = lazy(() => import("../../features/surveys/SurveyWorkspace"));
const StudentSurvey = lazy(() => import("../../features/surveys/StudentSurveyPage"));

const REPORT_LABELS = {
  students: "Student Report",
  attendance: "Attendance Report",
  finance: "Finance Report",
  retention: "Retention Case Report",
  users: "User Report",
  audit: "Audit Trail Report",
  notifications: "Notification Report",
  archived: "Archived Records Report",
  grades: "Grade Report",
  survey: "Survey Report",
  contacts: "Contact Workflow Report",
  contact_log: "Contact Log Report",
  faculty_periodical: "Faculty Periodical Report",
};

const REPORT_ACCESS_MODULES = {
  students: ["student_manage"],
  attendance: ["attendance_management"],
  // Gated on the finance module itself, the same way attendance is gated on
  // attendance_management — balances are not something every report reader
  // should see just because they can open Reports.
  finance: ["finance_management"],
  retention: ["retention_cases"],
  users: ["users"],
  audit: ["settings"],
  notifications: ["reports"],
  archived: ["users", "student_manage", "roles", "departments", "courses", "grades", "remarks", "statuses", "enrollment_status"],
  grades: ["grades"],
  survey: ["survey", "survey_questions", "survey_responses", "survey_submissions"],
  contacts: ["student_contacts", "home_visits"],
  /*
   * Every call and visit logged on the account's students, filterable by date
   * and exportable - the Contact Workspace's own Contact log tab, offered under
   * Reports as well. Not home_visits: student_contact_log.php answers only to
   * student_contacts, and only with `analyze` (REPORT_REQUIRED_ACTIONS below).
   */
  contact_log: ["student_contacts"],
  faculty_periodical: ["reports"],
  /*
   * Attendance or grades is enough to open it; finance is NOT listed.
   *
   * The report reads all three, but term_comparison.php withholds the balance
   * columns from a caller without finance_management -- so requiring finance
   * here would lock SSG out of a comparison they should see, while listing it
   * as an alternative would let the menu imply access the server then refuses.
   * The module list decides who may open the screen; the server decides what is
   * on it.
   */
  comparison: ["attendance_management", "grades"],
  // Same gate as the comparison, and for the same reason: term_logbook.php
  // withholds the balance columns from a caller without finance_management,
  // so finance is deliberately not listed as a way in.
  logbook: ["attendance_management", "grades"],
};

/**
 * An action the source module must also carry, for the reports whose endpoint
 * asks for more than `view`. The Contact log tab in the Contact Workspace makes
 * the same check, so the two doors onto student_contact_log.php open together.
 */
const REPORT_REQUIRED_ACTIONS = {
  contact_log: "analyze",
  faculty_periodical: "analyze",
};

const ROLE_REPORT_CONFIG = {
  admin: {
    allowedReports: ["students", "attendance", "finance", "retention", "users", "audit", "notifications", "archived", "grades", "survey", "contacts", "comparison", "logbook"],
    title: "Admin Reports",
    description: "Switch between student, attendance, finance, retention, user, audit, notification, archived, grade, survey, and contact reports from one screen.",
  },
  ssg: {
    allowedReports: ["students", "attendance", "retention", "grades", "survey", "notifications", "archived", "comparison", "logbook"],
    title: "SSG Reports",
    description: "Switch between student, attendance, retention, grade, survey, and available activity reports for the SSG workspace.",
  },
  dean: {
    // Finance is listed but still gated on the finance module above, so a dean
    // without it sees nothing new. Balances are a retention signal, and the
    // dean is who acts on the students carrying them.
    allowedReports: ["students", "attendance", "finance", "retention", "archived", "notifications", "comparison", "logbook"],
    title: "Dean Reports",
    description: "Review student totals, attendance, balances, course breakdowns, and retention case analytics for the dean workspace.",
  },
  student: {
    allowedReports: ["survey", "notifications"],
    title: "Student Reports",
    description: "Review only the report views explicitly granted to this student account.",
  },
  "ssp-coordinator": {
    allowedReports: ["users", "survey", "retention", "contacts", "contact_log", "notifications", "archived"],
    title: "SSP Coordinator Reports",
    description: "Review the contact workflow, the log of every contact action on your Non-STAR students (filter by date and export), and notification activity.",
  },
  // The coordinator's opposite number on the STAR side, so the same reports.
  // It had no entry before and fell through to `default`, which left it
  // Notifications alone.
  "ksh-tl": {
    allowedReports: ["users", "survey", "retention", "contacts", "contact_log", "notifications", "archived"],
    title: "KSH TL Reports",
    description: "Review the contact workflow, the log of every contact action on your STAR students (filter by date and export), and notification activity.",
  },
  "dept-caller": {
    allowedReports: ["contacts", "notifications"],
    title: "Department Caller Reports",
    description: "Review contact completion, escalations, and follow-up workload scoped to your department.",
  },
  faculty: {
    allowedReports: ["contacts", "notifications"],
    title: "Faculty Reports",
    description: "Review contact completion, escalations, and follow-up workload for the students in your department.",
  },
  csdl: {
    allowedReports: ["contacts", "notifications"],
    title: "Home Visit Reports",
    description: "Review escalated cases, home visit scheduling, and completion logs for Role 8 follow-up work.",
  },
  "ssp-caller": {
    allowedReports: ["retention", "contacts", "notifications"],
    title: "SSP Caller Reports",
    description: "Review retention case analytics limited to your assigned SSP caller workload.",
  },
  default: {
    allowedReports: ["users", "survey", "notifications"],
    title: "Reports",
    description: "Switch between admin user metrics and survey result totals from one report screen.",
  },
};

function normalizeReportKey(value) {
  return String(value || "").trim().toLowerCase();
}

export function getReportLabel(reportType) {
  const normalized = normalizeReportKey(reportType);
  if (!normalized) {
    return "Report";
  }
  if (REPORT_LABELS[normalized]) {
    return REPORT_LABELS[normalized];
  }
  return normalized
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function getReportsConfig(roleSlug, overrides = {}) {
  const normalizedRoleSlug = String(roleSlug || "").trim().toLowerCase();
  const baseConfig = ROLE_REPORT_CONFIG[normalizedRoleSlug] || ROLE_REPORT_CONFIG.default;
  const rawAllowedReports = Array.isArray(overrides.allowedReports) && overrides.allowedReports.length > 0
    ? overrides.allowedReports
    : baseConfig.allowedReports;

  return {
    allowedReports: Array.from(new Set([
      ...(rawAllowedReports || []).map(normalizeReportKey).filter(Boolean),
      ...(["admin", "ssg", "dean", "program-head", "faculty", "dept-caller", "ssp-coordinator", "ssp-caller", "ksh-tl", "ksh-coach"].includes(normalizedRoleSlug) ? ["faculty_periodical"] : []),
    ])),
    title: overrides.title || baseConfig.title,
    description: overrides.description || baseConfig.description,
  };
}

function resolveReportAccess(user, roleSlug, allowedReports) {
  const modules = user ? getEffectiveDashboardModules(user, roleSlug) : [];
  const moduleByView = new Map(modules.map((module) => [module.view, module]));

  const reports = (allowedReports || []).filter((reportType) => {
    const requiredModules = REPORT_ACCESS_MODULES[reportType] || [];
    if (requiredModules.length === 0) return true;
    const requiredAction = REPORT_REQUIRED_ACTIONS[reportType];
    return requiredModules.some((moduleView) => {
      const module = moduleByView.get(moduleView);
      return Boolean(module) && (!requiredAction || canModuleAction(module.permissions, requiredAction));
    });
  });

  const permissionsByReport = reports.reduce((acc, reportType) => {
    const requiredModules = REPORT_ACCESS_MODULES[reportType] || [];
    const sourceModule = requiredModules.map((moduleView) => moduleByView.get(moduleView)).find(Boolean);
    acc[reportType] = sourceModule?.permissions || [];
    return acc;
  }, {});

  return { reports, permissionsByReport };
}

/**
 * Roles that manage students across the whole institution rather than one
 * department.
 *
 * Admin belongs here because every account carries a `department` — the admin
 * seed sits in department 1 — so without an exemption the role that provisions
 * for every college silently sees only one college's courses. A student's
 * department comes from its course, so that scoping is what makes a department
 * reachable at all.
 *
 * Registrar was in this set until that role was deleted on 2026-07-26.
 */
const INSTITUTION_WIDE_STUDENT_ROLES = new Set(["admin", "ssg"]);

function SharedStudentManagementModule({ user, permissions }) {
  const departmentId = Number(user?.department_id);
  const roleSlug = getRoleSlug(user);
  const isDepartmentScoped =
    Number.isFinite(departmentId)
    && departmentId > 0
    && !INSTITUTION_WIDE_STUDENT_ROLES.has(roleSlug);

  return (
    <StudentManage
      departmentId={isDepartmentScoped ? departmentId : null}
      departmentName={isDepartmentScoped ? (user?.department_name || "") : "All Departments"}
      campusName={isDepartmentScoped ? (user?.campus_name || "") : ""}
      permissions={permissions}
      requireDepartment={isDepartmentScoped}
      archiveMode={roleSlug === "ssg"}
    />
  );
}

function SharedReportsModule({
  user,
  allowedReports: allowedReportsProp,
  defaultReport,
  title: titleProp,
  description: descriptionProp,
  onReportChange,
}) {
  const roleSlug = getRoleSlug(user);
  const { allowedReports, title, description } = getReportsConfig(roleSlug, {
    allowedReports: allowedReportsProp,
    title: titleProp,
    description: descriptionProp,
  });
  const { reports: permittedReports, permissionsByReport } = resolveReportAccess(user, roleSlug, allowedReports);
  const normalizedDefaultReport = normalizeReportKey(defaultReport);
  const resolvedDefaultReport = permittedReports.includes(normalizedDefaultReport)
    ? normalizedDefaultReport
    : permittedReports[0] || "";

  return (
    <ReportsPage
      allowedReports={permittedReports}
      defaultReport={resolvedDefaultReport}
      title={title}
      description={description}
      onReportChange={onReportChange}
      reportPermissions={permissionsByReport}
    />
  );
}

/*
 * The four survey modules are one workspace with tabs, not four rail entries.
 *
 * Only the navigation is merged. Each tab still belongs to its own permission
 * module, still renders only when this account holds `view` on it, and still
 * talks to an endpoint that checks that module server-side. surveyTabs.js owns
 * the list and the order; surveyTabs.test.js is what holds the merge to
 * navigation only.
 */
function SharedSurveyModule({ module, user, modules }) {
  const roleSlug = getRoleSlug(user);
  const surveyModules = (modules || []).filter((module) => isSurveyWorkspaceView(module.view));

  /*
   * A student answers surveys; they do not administer them. StudentDashboard
   * already routes them straight to the answering flow, and this fork is what
   * keeps that true for any other dashboard that resolves modules generically -
   * the student preset holds survey_questions:view and survey_submissions:view
   * only so the answering flow can call those endpoints, and those grants must
   * never be read as "show them the management tabs".
   */
  if (roleSlug === "student") {
    const surveyModule = surveyModules.find((module) => module.view === "survey");
    return <StudentSurvey user={user} permissions={surveyModule?.permissions || []} />;
  }

  // `module.view` is the entry that was clicked, which is the tab to open on.
  return <SurveyWorkspace user={user} modules={surveyModules} initialView={module?.view} />;
}

function resolveSharedModuleComponent(moduleView) {
  if (moduleView === "student_manage") {
    return SharedStudentManagementModule;
  }

  if (isSurveyWorkspaceView(moduleView)) {
    return SharedSurveyModule;
  }

  if (moduleView === "reports") {
    return SharedReportsModule;
  }

  return MODULE_COMPONENTS[moduleView] || null;
}

/**
 * Icons for the report children.
 *
 * No inline `style={{ color }}` here, unlike ModuleIcon: the sidebar's icon
 * wrapper sets colour with `[&_svg]:!text-current`, which beats an inline
 * colour, so passing one would be dead code. `currentColor` lets the active and
 * hover states resolve in one place.
 *
 * 16px rather than ModuleIcon's 18px — these sit one level down and reading as
 * slightly lighter than their parent is the point.
 */
function ReportIcon({ reportType }) {
  const props = {
    width: 14,
    height: 14,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };

  switch (normalizeReportKey(reportType)) {
    case "students":
      return (
        <svg {...props}>
          <path d="M20 21a8 8 0 0 0-16 0" />
          <circle cx="12" cy="7" r="4" />
        </svg>
      );
    case "attendance":
      return (
        <svg {...props}>
          <rect x="3" y="4" width="18" height="18" rx="2" />
          <path d="M16 2v4M8 2v4M3 10h18" />
          <path d="m9 16 2 2 4-4" />
        </svg>
      );
    case "retention":
      return (
        <svg {...props}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="M12 8v4M12 16h.01" />
        </svg>
      );
    case "users":
      return (
        <svg {...props}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87" />
        </svg>
      );
    case "audit":
      return (
        <svg {...props}>
          <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          <rect x="8" y="2" width="8" height="4" rx="1" />
          <path d="M9 12h6M9 16h4" />
        </svg>
      );
    case "notifications":
      return (
        <svg {...props}>
          <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
      );
    case "archived":
      return (
        <svg {...props}>
          <rect x="2" y="3" width="20" height="5" rx="1" />
          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
          <path d="M10 12h4" />
        </svg>
      );
    case "grades":
      return (
        <svg {...props}>
          <path d="M4 19h16" />
          <rect x="6" y="11" width="3" height="6" rx="0.5" />
          <rect x="11" y="7" width="3" height="10" rx="0.5" />
          <rect x="16" y="13" width="3" height="4" rx="0.5" />
        </svg>
      );
    case "survey":
      return (
        <svg {...props}>
          <path d="M8 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-2" />
          <rect x="8" y="2" width="8" height="4" rx="1" />
          <path d="m9 13 2 2 4-4" />
        </svg>
      );
    case "contacts":
      return (
        <svg {...props}>
          <path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1.9.4 1.8.7 2.7a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.4-1.2a2 2 0 0 1 2.1-.5c.9.3 1.8.6 2.7.7a2 2 0 0 1 1.7 2z" />
        </svg>
      );
    case "contact_log":
      // A clock turning back: a log read by date.
      return (
        <svg {...props}>
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l4 2" />
        </svg>
      );
    default:
      // A plain document, so a report added later still gets a sensible glyph
      // instead of an empty gap.
      return (
        <svg {...props}>
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
          <path d="M9 13h6M9 17h4" />
        </svg>
      );
  }
}

/**
 * Reports as an expandable group, matching Survey Master.
 *
 * This used to render a single flat SidebarItem that jumped to whichever report
 * happened to be first, leaving the other nine reachable only through a select
 * inside the page — so the sidebar advertised one destination while the module
 * actually had up to ten. Every call site was already passing `expanded` and
 * `onToggle` and already calling setReportsOpen(true) on select; those props
 * were simply ignored. Nothing at the call sites had to change.
 *
 * Child labels drop the trailing "Report" — under a parent already named
 * Reports, "Student Report" reads as a stutter. Same treatment Survey Master
 * gives its children.
 */
export function ReportsSidebarGroup({
  user,
  roleSlug: roleSlugProp,
  activeView,
  reportView,
  expanded = false,
  onToggle,
  onSelectReport,
  allowedReports,
  label = "Reports",
}) {
  const resolvedRoleSlug = roleSlugProp || getRoleSlug(user);
  const { allowedReports: reportOptions } = getReportsConfig(resolvedRoleSlug, { allowedReports });
  const { reports: permittedReports } = resolveReportAccess(user, resolvedRoleSlug, reportOptions);
  const reportsActive = activeView === "reports";
  const selectedReport = permittedReports.includes(normalizeReportKey(reportView))
    ? normalizeReportKey(reportView)
    : permittedReports[0] || "";

  if (permittedReports.length === 0) return null;

  return (
    <SidebarGroup
      label={label}
      expanded={expanded}
      onToggle={onToggle}
      active={reportsActive}
      icon={<ModuleIcon active={reportsActive} moduleView="reports" />}
    >
      {permittedReports.map((reportType) => (
        <SidebarItem
          key={reportType}
          active={reportsActive && selectedReport === reportType}
          onClick={() => onSelectReport(reportType)}
          icon={<ReportIcon reportType={reportType} />}
          label={getReportLabel(reportType).replace(/\s*Report$/i, "")}
        />
      ))}
    </SidebarGroup>
  );
}

export function ModuleIcon({ active, moduleView }) {
  const color = active ? "#065f46" : "#94a3b8";

  // Overview and student management were drawn inline by each dashboard,
  // because those two were the entries a dashboard pinned to the top by hand.
  // They come through the shared renderer now, so their icons live here with
  // the rest — otherwise both fall through to the calendar default below.
  if (moduleView === "overview") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M3 12h7V3H3v9z"></path>
        <path d="M14 21h7v-9h-7v9z"></path>
        <path d="M14 3h7v5h-7V3z"></path>
        <path d="M3 17h7v4H3v-4z"></path>
      </svg>
    );
  }

  if (moduleView === "student_manage") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M17 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2"></path>
        <circle cx="9" cy="7" r="4"></circle>
        <path d="M23 21v-2a4 4 0 0 0-3-3.87"></path>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
      </svg>
    );
  }

  if (moduleView === "attendance_management") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M9 11l3 3L22 4"></path>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
      </svg>
    );
  }

  if (moduleView === "finance_management") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <line x1="12" y1="1" x2="12" y2="23"></line>
        <path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path>
      </svg>
    );
  }

  if (moduleView === "student_migration") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <polyline points="17 1 21 5 17 9"></polyline>
        <path d="M3 11V9a4 4 0 0 1 4-4h14"></path>
        <polyline points="7 23 3 19 7 15"></polyline>
        <path d="M21 13v2a4 4 0 0 1-4 4H3"></path>
      </svg>
    );
  }

  if (moduleView === "records_history") {
    // An archive box: a lid over stacked records. Deliberately not a clock or a
    // history arrow — both read as "undo", and nothing in this module changes
    // anything.
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <rect x="2" y="3" width="20" height="5" rx="1"></rect>
        <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path>
        <line x1="10" y1="12" x2="14" y2="12"></line>
      </svg>
    );
  }

  if (moduleView === "assignments") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M9 11H5a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7a2 2 0 0 0-2-2h-4"></path>
        <polyline points="9 7 12 4 15 7"></polyline>
        <line x1="12" y1="4" x2="12" y2="15"></line>
      </svg>
    );
  }

  if (moduleView === "enrollment_status") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
        <polyline points="14 2 14 8 20 8"></polyline>
        <polyline points="9 15 11 17 15 13"></polyline>
      </svg>
    );
  }

  if (moduleView === "users") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path>
        <circle cx="9" cy="7" r="4"></circle>
        <path d="M22 21v-2a4 4 0 0 0-3-3.87"></path>
        <path d="M16 3.13a4 4 0 0 1 0 7.75"></path>
      </svg>
    );
  }

  if (moduleView === "roles") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7l3-7z"></path>
      </svg>
    );
  }

  if (moduleView === "departments") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <rect x="3" y="3" width="7" height="7"></rect>
        <rect x="14" y="3" width="7" height="7"></rect>
        <rect x="14" y="14" width="7" height="7"></rect>
        <rect x="3" y="14" width="7" height="7"></rect>
      </svg>
    );
  }

  if (moduleView === "courses") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M4 19.5V6l8-3 8 3v13.5"></path>
        <path d="M12 3v16.5"></path>
        <path d="M4 6l8 3 8-3"></path>
      </svg>
    );
  }

  if (moduleView === "grades") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M4 19h16"></path>
        <path d="M7 16V8"></path>
        <path d="M12 16V5"></path>
        <path d="M17 16v-4"></path>
      </svg>
    );
  }

  if (moduleView === "survey") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M9 11l3 3L22 4"></path>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
      </svg>
    );
  }

  if (moduleView === "remarks" || moduleView === "statuses") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M4 6h16"></path>
        <path d="M4 12h16"></path>
        <path d="M4 18h10"></path>
      </svg>
    );
  }

  if (moduleView === "campuses") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M3 9l9-6 9 6-9 6-9-6z"></path>
        <path d="M21 10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10"></path>
        <path d="M7 22v-8h10v8"></path>
      </svg>
    );
  }

  if (moduleView === "retention_cases") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M9 11l3 3L22 4"></path>
        <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"></path>
      </svg>
    );
  }

  if (moduleView === "student_contacts") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72l.34 2.64a2 2 0 0 1-.57 1.7l-1.4 1.4a16 16 0 0 0 6 6l1.4-1.4a2 2 0 0 1 1.7-.57l2.64.34A2 2 0 0 1 22 16.92z"></path>
      </svg>
    );
  }

  if (moduleView === "home_visits") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M3 10.5L12 3l9 7.5"></path>
        <path d="M5 9.5V21h14V9.5"></path>
        <path d="M9 21v-6h6v6"></path>
      </svg>
    );
  }

  if (moduleView === "reports") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <path d="M3 3v18h18"></path>
        <path d="M7 14l4-4 3 3 5-6"></path>
      </svg>
    );
  }

  if (moduleView === "settings") {
    return (
      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09a1.65 1.65 0 0 0 1.51-1 1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c0 .64.25 1.25.69 1.71.44.45 1.07.7 1.71.7H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    );
  }

  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ color }}>
      <rect x="3" y="4" width="18" height="16" rx="2"></rect>
      <path d="M8 2v4"></path>
      <path d="M16 2v4"></path>
      <path d="M3 10h18"></path>
    </svg>
  );
}

/** Section order — the same order the role permission matrix already presents. */
const SIDEBAR_GROUP_ORDER = Object.keys(MODULE_GROUPS);

/**
 * The whole nav, grouped under its registry section titles.
 *
 * Every module already carries the group it belongs to — `groupKey`/`groupLabel`
 * come from MODULE_GROUPS via roleAccess.js — so the titles are read from the
 * registry rather than declared again here. A module moving from Management to
 * Analytics is one edit in moduleRegistry.js and every role's sidebar follows.
 *
 * `slots` is for the entries a dashboard cannot express as a plain item —
 * Reports is a collapsible group with children. Passing a node renders it in
 * that module's place, keeping it inside the right section instead of stranded
 * at the bottom of the rail. Passing `null` drops the module, which is what
 * keeps a section from rendering a title over nothing when its only member
 * declines to render, as ReportsSidebarGroup does for a user with no permitted
 * reports.
 *
 * `labels` renames a single entry without restating the rest of it: Finance and
 * Admin call the landing page "Dashboard" where the registry says "Overview".
 */
export function GrantedModuleSidebarSections({ modules, activeView, onSelect, slots = {}, labels = {} }) {
  /*
   * The survey modules collapse to a single entry, because they are now a
   * single workspace with tabs. The entry selects whichever survey module this
   * account actually holds - an account granted only Survey Questions still
   * gets in, it just lands on the Questions tab.
   *
   * The other survey modules are dropped from the rail rather than from the
   * account: they are still granted, still enforced, and still what decides
   * which tabs appear once the workspace opens.
   */
  const surveyModules = (modules || []).filter((module) => isSurveyWorkspaceView(module.view));
  const surveyEntry = surveyModules[0] || null;
  /*
   * The faculty workspace is a tab of the retention module, not an entry of its
   * own — see RetentionWorkspace for why the two screens merged. Dropped from
   * the rail only when retention_cases is actually held: an account granted the
   * workspace and nothing else would otherwise lose its one screen to a tidier
   * sidebar, which is a lockout rather than a simplification.
   *
   * The GRANT is untouched either way. faculty_workspace.php still checks it,
   * and the tab appears from it — the same arrangement the four survey modules
   * have, where the rail shows one entry and the permissions stay four.
   */
  const hasRetentionModule = (modules || []).some((module) => module.view === "retention_cases");
  const visibleModules = (modules || []).filter(
    (module) =>
      (!isSurveyWorkspaceView(module.view) || module.view === surveyEntry?.view)
      && !(hasRetentionModule && ["faculty_workspace", "team_monitor"].includes(module.view))
  );

  const sections = SIDEBAR_GROUP_ORDER.map((groupKey) => ({
    groupKey,
    label: MODULE_GROUPS[groupKey]?.label || groupKey,
    modules: visibleModules.filter(
      (module) => module.groupKey === groupKey && slots[module.view] !== null
    ),
  })).filter((section) => section.modules.length > 0);

  return sections.map((section) => (
    <SidebarSection key={section.groupKey} label={section.label}>
      {section.modules.map((module) =>
        slots[module.view] !== undefined ? (
          <React.Fragment key={module.view}>{slots[module.view]}</React.Fragment>
        ) : (
          <SidebarItem
            key={module.view}
            active={
              module.view === surveyEntry?.view
                ? SURVEY_WORKSPACE_VIEWS.includes(activeView)
                : activeView === module.view
            }
            onClick={() => onSelect(module.view)}
            icon={<ModuleIcon active={activeView === module.view} moduleView={module.view} />}
            label={
              labels[module.view] ||
              // One entry standing for four modules cannot keep one module's
              // name; it takes the section's.
              (module.view === surveyEntry?.view && surveyModules.length > 1
                ? MODULE_GROUPS.survey_master?.label || "Surveys"
                : module.label)
            }
          />
        )
      )}
    </SidebarSection>
  ));
}

/**
 * What stands in while a module's chunk is on the wire.
 *
 * Deliberately shaped like the screens it replaces — a heading, then rows —
 * rather than a spinner: the module paints into this geometry instead of
 * snapping into place, and a reader can already see which module they opened
 * while it arrives. Same reasoning as DashboardSkeleton, one level in.
 *
 * The heading is the real label, not a placeholder bar, because it is the one
 * thing already known for certain at this point.
 */
function ModuleLoading({ label }) {
  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }} role="status" aria-busy="true">
      <OverviewHeader title={label} />
      <DashboardPanel variant="muted" style={{ display: "grid", gap: 9 }}>
        <Skeleton width="38%" height={13} />
        <Skeleton width="68%" height={11} />
        <Skeleton width="54%" height={11} />
      </DashboardPanel>
      <span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
        Loading {label}
      </span>
    </section>
  );
}

export function GrantedModuleView({ module, user, modules = [], moduleProps = {} }) {
  if (!module) return null;

  const SharedModule = resolveSharedModuleComponent(module.view);
  if (SharedModule) {
    /*
     * Every module page is loaded on demand, so this is the one boundary that
     * catches all of them. It is keyed on the module so switching modules shows
     * the placeholder again rather than holding the previous screen on-page
     * while the next chunk downloads — on a slow connection that reads as a
     * click that did nothing.
     *
     * `modules` is the whole granted set, which the survey workspace needs to
     * know which of its tabs this account is allowed to see.
     */
    return (
      <Suspense key={module.view} fallback={<ModuleLoading label={module.label} />}>
        <SharedModule module={module} user={user} permissions={module.permissions} modules={modules} {...moduleProps} />
      </Suspense>
    );
  }

  const accessMeta = getModuleAccessMeta(module.access);
  return (
    <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
      <OverviewHeader title={module.label} />
      <AlertMessage
        tone="info"
        message={`${module.label} is enabled for this role. The dashboard entry is ready, but the shared workspace for this module is not wired yet.`}
      />
      <DashboardPanel variant="muted" style={{ display: "grid", gap: 8 }}>
        <strong style={{ color: "var(--text-primary)" }}>{accessMeta.label}</strong>
        <span style={{ color: "var(--text-secondary)", fontSize: 12.5 }}>{accessMeta.helper}</span>
        <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
          Allowed functions: {module.actions.join(", ") || "View module"}
        </span>
      </DashboardPanel>
    </section>
  );
}
