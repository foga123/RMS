import { lazy } from "react";
import { normalizeRoleSlug } from "../../shared/lib/roles";

/**
 * role slug -> the dashboard that role lands on, loaded on demand.
 *
 * An account has exactly one role and therefore reaches exactly one of these,
 * so a static map put twelve dashboards in the first script every user parsed
 * to render the one they were entitled to. Lazy here means a Finance user
 * downloads FinanceDashboard and none of the other eleven.
 *
 * RoleDashboardRouter carries the <Suspense>, and its fallback is the same
 * DashboardSkeleton already shown while the session is being restored — so a
 * cold load paints one placeholder through both waits rather than flashing
 * between two.
 */
export const ROLE_DASHBOARD_COMPONENTS = {
  admin: lazy(() => import("./AdminDashboard")),
  ssg: lazy(() => import("./SecretaryDashboard")),
  student: lazy(() => import("./StudentDashboard")),
  finance: lazy(() => import("./FinanceDashboard")),
  dean: lazy(() => import("./DeanDashboard")),
  // Same component, not a copy of it. A Program Head does the dean's work on the
  // dean's department, so a second file would only be a second place to fix.
  // Webpack resolves both keys to the one chunk.
  "program-head": lazy(() => import("./DeanDashboard")),
  "dept-caller": lazy(() => import("./DeptCallerDashboard")),
  /*
   * Faculty land on the generic dashboard, which lists the modules the account
   * actually holds. There is no FacultyDashboard file because there would be
   * nothing in it: the workspace itself is the Contact Workspace page, and a
   * wrapper component that only forwards a slug is a file to keep in step for
   * no behaviour of its own.
   */
  faculty: lazy(() => import("./GenericRoleDashboard")),
  "ssp-coordinator": lazy(() => import("./SspCoordinatorDashboard")),
  "ssp-caller": lazy(() => import("./SspCallerDashboard")),
  "ksh-tl": lazy(() => import("./KshTlDashboard")),
  csdl: lazy(() => import("./CsdlDashboard")),
  "ksh-coach": lazy(() => import("./KshCoachDashboard")),
};

/**
 * The fallback is its own lazy() rather than a reference to the `faculty` entry,
 * so an unknown slug loads the generic dashboard's chunk by the same path
 * webpack already knows about instead of pulling it into this module.
 */
const GenericRoleDashboard = lazy(() => import("./GenericRoleDashboard"));

export function resolveRoleDashboard(roleSlug) {
  const normalized = normalizeRoleSlug(roleSlug);
  return ROLE_DASHBOARD_COMPONENTS[normalized] || GenericRoleDashboard;
}
