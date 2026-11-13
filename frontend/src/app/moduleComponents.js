/**
 * module key -> page component, loaded on demand.
 *
 * Split from moduleRegistry.js on purpose: the registry is pure metadata that
 * utils/permissions.js imports, and pulling React pages into that import chain
 * would drag every page into any bundle that only wanted a module's label.
 *
 * The keys here must exist in MODULE_REGISTRY, or the module renders as
 * "module not available" at runtime. moduleComponents.test.js now actually
 * enforces that - this header claimed a test that did not exist for a long time.
 *
 * Every entry is React.lazy rather than a static import. These twenty-six pages
 * are the bulk of the application, and a static map meant all of them were in
 * the first script the browser parsed: a Finance user downloaded the survey
 * workspace, the migration matrix and every report before their own dashboard
 * could paint. Nobody holds more than a handful of these modules, and most
 * accounts open two or three in a session, so the rest was download nobody ever
 * had a use for.
 *
 * The paths must stay literal. Webpack decides where to cut the bundle by
 * reading these strings statically, so a computed path — `import("../features/"
 * + name)` — would either fail to split or pull the whole folder into one chunk.
 *
 * Anything rendering one of these must sit inside a <Suspense>. GrantedModuleView
 * in pages/dashboards/SharedGrantedModules.jsx is the only place that does, and
 * it carries the boundary.
 */

import { lazy } from "react";

export const MODULE_COMPONENTS = {
  assignments: lazy(() => import("../features/ssp/AssignmentsPage")),
  attendance_management: lazy(() => import("../features/attendance/AttendancePage")),
  campuses: lazy(() => import("../features/campuses/CampusesPage")),
  courses: lazy(() => import("../features/courses/CoursesPage")),
  departments: lazy(() => import("../features/departments/DepartmentsPage")),
  enrollment_status: lazy(() => import("../features/enrollment-status/EnrollmentStatusPage")),
  finance_management: lazy(() => import("../features/finance/FinancePage")),
  grades: lazy(() => import("../features/grades/GradesPage")),
  home_visits: lazy(() => import("../features/home-visits/HomeVisitsPage")),
  remarks: lazy(() => import("../features/remarks/RemarksPage")),
  reports: lazy(() => import("../features/reports/ReportsPage")),
  // The PDO Prioritization List, plus My Students for an account holding
  // faculty_workspace. The Retention Cases tab was removed on 2026-09-18 -- the
  // KEY stays because it is what every permission check compares against.
  retention_cases: lazy(() => import("../features/retention-cases/RetentionWorkspace")),
  roles: lazy(() => import("../features/roles/RolesPage")),
  academic_calendar: lazy(() => import("../features/academic-calendar/AcademicCalendarPage")),
  dropdown_lists: lazy(() => import("../features/dropdown-lists/DropdownListsPage")),
  settings: lazy(() => import("../features/settings/SettingsPage")),
  statuses: lazy(() => import("../features/statuses/StatusesPage")),
  faculty_workspace: lazy(() => import("../features/faculty-workspace/FacultyWorkspacePage")),
  student_contacts: lazy(() => import("../features/student-contacts/StudentContactsPage")),
  records_history: lazy(() => import("../features/records-history/RecordsHistoryPage")),
  student_migration: lazy(() => import("../features/student-migration/StudentMigrationPage")),
  team_monitor: lazy(() => import("../features/team-monitor/TeamMonitorPage")),
  // The four survey entries are not what renders for a signed-in user any more:
  // SharedGrantedModules intercepts every survey view and renders SurveyWorkspace,
  // which draws them as tabs and hands each one its own module permissions. They
  // stay mapped here because the map is the registry contract, and because the
  // workspace imports these same four pages.
  survey: lazy(() => import("../features/surveys/SurveysPage")),
  survey_questions: lazy(() => import("../features/surveys/SurveyQuestionsPage")),
  survey_responses: lazy(() => import("../features/surveys/SurveyResponsesPage")),
  survey_submissions: lazy(() => import("../features/surveys/SurveySubmissionsPage")),
  users: lazy(() => import("../features/users/UsersPage")),
};
