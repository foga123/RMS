import React, { useEffect, useMemo, useState } from "react";
import Survey from "../../features/surveys/StudentSurveyPage";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import { DashboardShell, OverviewHeader, OverviewStatCards } from "../../shared/layout/dashboard";
import { GrantedModuleSidebarSections, GrantedModuleView } from "./SharedGrantedModules";
import {
  getDashboardModule,
  getEffectiveDashboardModules,
  getExtraDashboardModules,
  resolveAccessibleDashboardView,
} from "./moduleAccess";
import { getPermissionModule } from "../../shared/lib/permissions";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { confirmLogoutTo, hasRole, readAuthUser, replacePath } from "../../shared/lib/auth";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";
import { formatDate } from "../../shared/lib/dateTime";
import { getBackendUrl } from "../../shared/lib/url";
import { color, font, radius, tone as toneOf } from "../../shared/theme/tokens";

/**
 * A peso figure, or a dash.
 *
 * Null and 0 are different answers and both are real: no finance record at all
 * means nobody has told this student what they owe, while a recorded 0 means
 * they owe nothing. Printing them the same way would turn "we have not billed
 * you" into "you are paid up".
 */
function peso(amount) {
  if (amount === null || amount === undefined) return null;
  const value = Number(amount);
  if (!Number.isFinite(value)) return null;
  return `₱${value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function percent(rate) {
  if (rate === null || rate === undefined) return null;
  const value = Number(rate);
  if (!Number.isFinite(value)) return null;
  return `${Math.round(value * 100) / 100}%`;
}

/**
 * Present and absent side by side, each with its share of the classes held.
 *
 * This was two cards - Attendance Rate and Classes Missed - with the number of
 * classes actually attended only in the small print under the row. They are
 * the two halves of one fact, so they sit in one card as counts with their
 * percentages beside them, over one bar split between them.
 *
 * The bar is split rather than a single meter because a single meter takes
 * the card's tone: below 80% it drew the PRESENT share in red, which reads as
 * "this much absent". Here each half keeps its own colour, and the dot on each
 * label says which half is which. The card's rail still carries the 80% line.
 */
function AttendanceSplit({ attendance }) {
  const parts = [
    { key: "present", label: "Present", count: attendance.present, rate: attendance.rate, bar: toneOf("success").accent, ink: color.text.primary },
    { key: "absent", label: "Absent", count: attendance.absent, rate: attendance.absent_rate, bar: toneOf("danger").accent, ink: attendance.absent > 0 ? toneOf("danger").text : color.text.primary },
  ];

  return (
    <div style={{ marginTop: "0.3rem" }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.35rem 1.75rem" }}>
        {parts.map((part) => (
          <div key={part.key} style={{ minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "center", gap: "0.35rem", fontSize: font.size.xs, fontWeight: 600, color: color.text.muted, textTransform: "uppercase", letterSpacing: "0.04em" }}>
              <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: radius.pill, background: part.bar }} />
              {part.label}
            </div>
            <div style={{ display: "flex", alignItems: "baseline", gap: "0.35rem" }}>
              <span style={{ color: part.ink }}>{Number(part.count).toLocaleString()}</span>
              <span style={{ fontSize: font.size.md, fontWeight: 600, color: color.text.secondary }}>
                ({percent(part.rate) ?? "-"})
              </span>
            </div>
          </div>
        ))}
      </div>
      <div role="presentation" style={{ display: "flex", height: 5, borderRadius: radius.pill, overflow: "hidden", background: color.surface.muted, marginTop: "0.5rem" }}>
        {parts.map((part) => (
          <div key={part.key} style={{ width: `${Math.max(0, Math.min(100, Number(part.rate) || 0))}%`, background: part.bar }} />
        ))}
      </div>
    </div>
  );
}

const DEFAULT_VIEWS = ["overview", "survey"];
const HIDDEN_STUDENT_MODULES = new Set(["survey_questions", "survey_submissions"]);
const STUDENT_SURVEY_FALLBACK = {
  ...(getPermissionModule("survey") || {
    key: "survey",
    view: "survey",
    label: "Surveys",
    description: "Answer available student surveys.",
  }),
  permissions: ["view", "answer"],
  enabled: true,
  access: "use",
};

/*
 * The gate a student meets on login when they still owe a survey.
 *
 * It holds a forced Survey that quietly loads the student's surveys and, if one
 * is outstanding, raises this full-screen overlay over the whole dashboard —
 * there is no close button and no way back to the list, only answering it or
 * logging out. Submitting the survey lowers the gate. When nothing is
 * outstanding the Survey never calls onForcedNeeded and this stays invisible,
 * so a student who is caught up never sees it.
 */
function ForcedSurveyGate({ user, permissions }) {
  const [active, setActive] = useState(false);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Required survey"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        display: active ? "grid" : "none",
        gridTemplateRows: "auto 1fr",
        background: "var(--surface-page)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "12px 16px", borderBottom: "1px solid var(--border-base)", background: "var(--surface-base)" }}>
        <div style={{ minWidth: 0 }}>
          <strong style={{ color: "var(--brand-800)" }}>One quick survey first</strong>
          <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
            Please answer this to continue. Make sure your answers are correct.
          </div>
        </div>
        <button
          type="button"
          onClick={() => { void confirmLogoutTo("/"); }}
          style={{ border: "1px solid var(--border-strong)", background: "transparent", color: "var(--text-secondary)", borderRadius: 6, padding: "6px 12px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap" }}
        >
          Log out
        </button>
      </div>
      <div style={{ overflow: "auto", padding: 16 }}>
        <div style={{ maxWidth: 860, margin: "0 auto" }}>
          <Survey
            user={user}
            permissions={permissions}
            forced
            onForcedNeeded={() => setActive(true)}
            onForcedDone={() => setActive(false)}
          />
        </div>
      </div>
    </div>
  );
}

function withStudentSurveyAnswer(module) {
  const base = module || STUDENT_SURVEY_FALLBACK;
  const permissions = Array.isArray(base.permissions) ? base.permissions : [];

  return {
    ...base,
    permissions: Array.from(new Set(["view", ...permissions, "answer"])),
    enabled: true,
    access: base.access === "none" ? "use" : (base.access || "use"),
  };
}

export default function StudentDashboard({ user: routedUser = null } = {}) {
  const [user, setUser] = useState(routedUser || null);
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));

  /*
   * The student's own standing.
   *
   * The three cards here were `const coursesCount = null` and two more like it:
   * placeholders that rendered as empty boxes for every student, every visit.
   *
   * student_overview.php answers for the signed-in student and nobody else - it
   * takes no student parameter at all - so this needs no id and cannot be
   * pointed at a classmate. It is gated on `overview`, the module a student
   * already holds, rather than on finance_management or attendance_management,
   * which would have meant handing every student the whole college's finance
   * and attendance screens to show them one number about themselves.
   */
  const [selfData, setSelfData] = useState(null);
  const [selfLoading, setSelfLoading] = useState(true);
  useDashboardIntent({ onView: setActiveView, activeView, persist: true });

  useEffect(() => {
    const parsed = readAuthUser() || routedUser;
    if (!hasRole(parsed, { id: 13, name: "student" })) {
      replacePath("/");
      return;
    }
    setUser(parsed);
  }, [routedUser]);

  useEffect(() => {
    if (!user) return undefined;

    let cancelled = false;
    (async () => {
      setSelfLoading(true);
      try {
        const res = await fetch(getBackendUrl("student_overview.php"), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        // A 403 here means the account is not allowed its own overview, which
        // is a dash on every card rather than an error banner over a dashboard
        // that is otherwise working.
        const json = res.ok ? await res.json() : null;
        if (!cancelled) setSelfData(json);
      } catch {
        if (!cancelled) setSelfData(null);
      } finally {
        if (!cancelled) setSelfLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user]);

  const configuredModules = useMemo(() => getEffectiveDashboardModules(user, "student"), [user]);
  const accessibleModules = useMemo(
    () => {
      const visibleModules = configuredModules.filter((module) => !HIDDEN_STUDENT_MODULES.has(module.view));
      const existingSurveyModule = getDashboardModule(visibleModules, "survey");
      if (existingSurveyModule) {
        return visibleModules.map((module) => (
          module.view === "survey" ? withStudentSurveyAnswer(module) : module
        ));
      }

      return [...visibleModules, withStudentSurveyAnswer(STUDENT_SURVEY_FALLBACK)];
    },
    [configuredModules]
  );
  const overviewModule = useMemo(
    () => getDashboardModule(accessibleModules, "overview"),
    [accessibleModules]
  );
  const surveyModule = useMemo(
    () => getDashboardModule(accessibleModules, "survey"),
    [accessibleModules]
  );
  const extraModules = useMemo(() => getExtraDashboardModules(accessibleModules, DEFAULT_VIEWS), [accessibleModules]);
  const grantedModule = useMemo(() => getDashboardModule(extraModules, activeView), [activeView, extraModules]);
  const breadcrumbSegments = useMemo(() => {
    if (activeView === "overview") return [];

    const segments = [];
    if (overviewModule) {
      segments.push({
        label: overviewModule.label || "Overview",
        onClick: () => setActiveView("overview"),
      });
    }
    if (activeView === "survey" && surveyModule) {
      segments.push({ label: surveyModule.label || "Surveys", current: true });
      return segments;
    }
    if (grantedModule?.label) {
      segments.push({ label: grantedModule.label, current: true });
    }
    return segments;
  }, [activeView, grantedModule?.label, overviewModule, surveyModule]);

  useEffect(() => {
    const nextView = resolveAccessibleDashboardView(activeView, accessibleModules, DEFAULT_VIEWS);
    if (nextView && nextView !== activeView) {
      setActiveView(nextView);
    }
  }, [activeView, accessibleModules]);

  if (!user) return null;

  const finance = selfData?.finance || null;
  const attendance = selfData?.attendance || null;
  const selfStudent = selfData?.student || null;

  /*
   * Every value falls back to null, and StatCard already renders null as "-".
   * That is deliberate across the board: a student with no attendance record
   * should see a dash, not 0%, because those say different things about them.
   */
  const attendanceRate = attendance?.rate === null || attendance?.rate === undefined ? null : Number(attendance.rate);

  /*
   * What each figure is of, inside its own card. The date and the class count
   * used to be a line of small print under the whole row, where they read as a
   * footnote to the page rather than as part of the number. A balance with no
   * date is a number the reader cannot check.
   */
  const balanceAsOf = finance ? formatDate(finance.recorded_on) : "";
  const balanceMeta = finance
    ? [balanceAsOf ? `As of ${balanceAsOf}` : "Date not recorded", finance.term].filter(Boolean).join(" · ")
    : "No balance has been recorded for you yet.";
  const attendanceMeta = attendance
    ? `Out of ${attendance.total_classes.toLocaleString()} class${attendance.total_classes === 1 ? "" : "es"} held.`
    : "No attendance has been recorded for you yet.";

  const overviewCards = [
    {
      label: "Outstanding Balance",
      value: peso(finance?.balance),
      meta: balanceMeta,
      loading: selfLoading,
      // Owing nothing is worth showing as good news; owing something is not an
      // error, so it is flagged rather than alarmed.
      tone: finance && Number(finance.balance) > 0 ? "danger" : finance ? "success" : "default",
    },
    {
      label: "Attendance",
      value: attendance ? <AttendanceSplit attendance={attendance} /> : null,
      meta: attendanceMeta,
      loading: selfLoading,
      // No `progress`: AttendanceSplit draws its own two-colour bar.
      tone: attendanceRate === null ? "default" : attendanceRate >= 80 ? "success" : "danger",
    },
  ];

  /* What the figures above are about, so the page says whose data it is. */
  const overviewScope = [
    { label: "Student No.", value: selfStudent?.student_number || "" },
    { label: "Course", value: selfStudent?.course_code || "" },
  ];

  const sidebar = (
    <Sidebar>
      <SidebarList>
        {/*
          accessibleModules, not configuredModules.

          HIDDEN_STUDENT_MODULES exists precisely to keep Survey Questions and
          Survey Submissions out of a student's navigation, but it was only ever
          applied to accessibleModules — which drives routing and breadcrumbs —
          while the sidebar was handed the raw list. So the filter worked
          everywhere except the one place anybody could see.

          The grants themselves have to stay: answering a survey means reading
          survey_question.php and posting to survey_submission.php, so the
          student preset in middleware/auth.php holds survey_questions:view and
          survey_submissions:view+create. Those are API permissions, not an
          invitation to the management screens they also unlock. This is where
          that distinction gets drawn.
        */}
        <GrantedModuleSidebarSections
          modules={accessibleModules}
          activeView={activeView}
          onSelect={setActiveView}
        />
      </SidebarList>
    </Sidebar>
  );

  return (
    <>
      <DashboardShell
        title="COC Student Dashboard"
        user={user}
        sidebar={sidebar}
        onUserUpdate={setUser}
        breadcrumbSegments={breadcrumbSegments}
      >
        {activeView === "overview" && overviewModule ? (
          <section id="overview" className="ui-rise-in" style={{ marginBottom: 19, display: "grid", gap: 12 }}>
            <OverviewHeader roleLabel="Student" user={user} scope={overviewScope} />
            <OverviewStatCards items={overviewCards} minWidth={240} />
          </section>
        ) : null}

        {activeView === "survey" && surveyModule ? <Survey user={user} permissions={surveyModule.permissions} /> : null}
        {grantedModule ? <GrantedModuleView module={grantedModule} user={user} modules={accessibleModules} /> : null}
      </DashboardShell>

      {/* Sits above the dashboard and, if the student owes a survey, blocks it
          until answered. Renders nothing when they are caught up. */}
      <ForcedSurveyGate user={user} permissions={surveyModule?.permissions || ["view", "answer"]} />
    </>
  );
}
