import React, { useCallback, useEffect, useMemo, useState } from "react";
import { formatDateTime as formatTimestamp } from "../../shared/lib/dateTime";
import Sidebar, { SidebarList } from "../../shared/layout/Sidebar";
import { AlertMessage } from "../../shared/components/ui";
import { DashboardPanel, DashboardShell, OverviewHeader } from "../../shared/layout/dashboard";
import RetentionOverview from "../student-contacts/RetentionOverview";
import { getReportLabel, GrantedModuleSidebarSections, GrantedModuleView, ReportsSidebarGroup } from "../../pages/dashboards/SharedGrantedModules";
import {
  getDashboardModule,
  getEffectiveDashboardModules,
  getExtraDashboardModules,
  resolveAccessibleDashboardView,
} from "../../pages/dashboards/moduleAccess";
import { useCurrentTermBadge } from "../../shared/lib/currentTerm";
import { hasRole, readAuthUser, replacePath } from "../../shared/lib/auth";
import { getBackendUrl } from "../../shared/lib/url";
import useDashboardIntent from "../../shared/hooks/useDashboardIntent";
import { getInitialDashboardIntentValue } from "../../shared/lib/dashboardIntent";
import { yearLevelLabel } from "../../shared/lib/yearLevel";
import { formatStudentName } from "../../shared/lib/studentName";
import { formatEnrollmentLabel } from "./enrollmentLabel";

const buttonStyle = {
  border: "none",
  borderRadius: 6,
  padding: "6px 9px",
  cursor: "pointer",
  fontSize: 11.5,
  fontWeight: 600,
};

const DEFAULT_VIEWS = ["overview", "assignments"];


function cleanContactValue(value) {
  return value === null || value === undefined ? "" : String(value).trim();
}

function assignmentContactLines(assignment) {
  const lines = [];
  const mobile = cleanContactValue(assignment?.mobile_number);
  const email = cleanContactValue(assignment?.email_address);
  const facebook = cleanContactValue(assignment?.facebook_name);
  const mother = cleanContactValue(assignment?.mother_number);
  const father = cleanContactValue(assignment?.father_number);

  if (mobile) lines.push(`Call: ${mobile}`);
  if (email) lines.push(`Email: ${email}`);
  if (facebook) lines.push(`Facebook: ${facebook}`);

  const parentNumbers = [
    mother ? `Mother ${mother}` : "",
    father ? `Father ${father}` : "",
  ].filter(Boolean).join(" / ");
  if (parentNumbers) lines.push(`Parent: ${parentNumbers}`);

  return lines.length ? lines : ["No contact details"];
}

function AssignmentContactDetails({ assignment, fontSize = 11.5 }) {
  return (
    <div style={{ color: "var(--text-muted)", fontSize, display: "grid", gap: 1, marginTop: 2 }}>
      {assignmentContactLines(assignment).map((line) => (
        <div key={line}>{line}</div>
      ))}
    </div>
  );
}

export default function SspCallerWorkspace() {
  // Which term the calls being logged belong to. See useCurrentTermBadge().
  const termBadge = useCurrentTermBadge();
  const [user, setUser] = useState(null);
  const [activeView, setActiveView] = useState(() => getInitialDashboardIntentValue("view", "overview"));
  const [reportsOpen, setReportsOpen] = useState(false);
  const [reportView, setReportView] = useState(() => getInitialDashboardIntentValue("report", "retention"));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [assignments, setAssignments] = useState([]);
  const [search, setSearch] = useState("");
  useDashboardIntent({
    onView: setActiveView,
    onReport: setReportView,
    activeView,
    activeReport: activeView === "reports" ? reportView : "",
    persist: true,
  });

  useEffect(() => {
    const parsed = readAuthUser();
    if (!hasRole(parsed, { id: 6, name: "ssp caller" })) {
      replacePath("/");
      return;
    }
    setUser(parsed);
  }, []);

  const loadAssignments = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("ssp_assignment.php"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.message || "Failed to load assigned SSP tasks");
      setAssignments(Array.isArray(data?.assignments) ? data.assignments : []);
    } catch (loadError) {
      setAssignments([]);
      setError(loadError?.message || "Failed to load assigned SSP tasks");
    } finally {
      setLoading(false);
    }
  }, []);

  const accessibleModules = useMemo(() => getEffectiveDashboardModules(user, "ssp-caller"), [user]);
  const overviewModule = useMemo(() => getDashboardModule(accessibleModules, "overview"), [accessibleModules]);
  const assignmentsModule = useMemo(() => getDashboardModule(accessibleModules, "assignments"), [accessibleModules]);
  const contactModule = useMemo(() => getDashboardModule(accessibleModules, "student_contacts"), [accessibleModules]);
  const extraModules = useMemo(() => getExtraDashboardModules(accessibleModules, DEFAULT_VIEWS), [accessibleModules]);
  const reportsModule = useMemo(() => getDashboardModule(extraModules, "reports"), [extraModules]);
  const nonReportExtraModules = useMemo(() => extraModules.filter((module) => module.view !== "reports"), [extraModules]);
  const grantedModule = useMemo(() => getDashboardModule(nonReportExtraModules, activeView), [activeView, nonReportExtraModules]);

  /*
   * ssp_assignment.php answers to the `assignments` module, and the SSP Caller
   * preset leaves that module out on purpose - a caller works the Contact
   * Workspace, and the board belongs to the coordinator (see 'ssp-caller' in
   * api_default_role_permission_presets()). Asked anyway, it refused on every
   * load, focus and tab switch, and the overview told a caller with students
   * "No tasks assigned yet". Only an account granted the module asks.
   */
  const canReadAssignments = Boolean(assignmentsModule);

  useEffect(() => {
    if (!user || !canReadAssignments) return;
    void loadAssignments();
  }, [canReadAssignments, loadAssignments, user]);

  useEffect(() => {
    if (!user || !canReadAssignments) return undefined;

    const handleFocus = () => {
      void loadAssignments();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void loadAssignments();
      }
    };

    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [canReadAssignments, loadAssignments, user]);
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
      segments.push({ label: assignmentsModule.label || "Assigned Tasks", current: true });
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

  const filteredAssignments = useMemo(() => {
    const query = search.trim().toLowerCase();
    if (!query) return assignments;

    return assignments.filter((assignment) => {
      const haystack = [
        assignment?.student_number,
        assignment?.first_name,
        assignment?.last_name,
        assignment?.course_name,
        assignment?.department_name,
        assignment?.email_address,
        assignment?.mobile_number,
        assignment?.facebook_name,
        assignment?.mother_number,
        assignment?.father_number,
        assignment?.decision,
        assignment?.enrollment_status_name,
        assignment?.assigned_by_name,
        assignment?.assignment_notes,
      ]
        .map((value) => String(value || "").toLowerCase())
        .join(" ");

      return haystack.includes(query);
    });
  }, [assignments, search]);

  const sidebar = (
    <Sidebar>
      <SidebarList>
        <GrantedModuleSidebarSections
          modules={accessibleModules}
          activeView={activeView}
          onSelect={setActiveView}
          labels={{ assignments: "Assigned Tasks" }}
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
    <DashboardShell title="COC SSP Caller Dashboard" user={user} sidebar={sidebar} onUserUpdate={setUser} breadcrumbSegments={breadcrumbSegments}>
      {activeView === "overview" && overviewModule ? (
        <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
          {/* One greeting: the WelcomeCard that sat here repeated the header's
              salutation. Its subtitle and its shortcut both move onto the
              header, so nothing it did is lost. */}
          <OverviewHeader
            roleLabel="SSP Caller"
            user={user}
            term={termBadge}
            subtitle="Review enrollment follow-up tasks assigned by the SSP Coordinator."
            action={
              assignments.length > 0
                ? {
                    label: `View ${assignments.length} assigned task${assignments.length === 1 ? "" : "s"}`,
                    onClick: () => setActiveView("assignments"),
                  }
                : null
            }
          />
          {canReadAssignments ? (
            <AlertMessage message="Only tasks assigned to your SSP user account are shown here." tone="info" />
          ) : null}

          <RetentionOverview
            onOpenWorkspace={() => setActiveView("student_contacts")}
            scopeNote="Only your assigned Non-STAR students are shown here."
          />

          {/* Without the module there is nothing to list, and an empty panel
              would read as "nobody is assigned to you". */}
          {canReadAssignments ? (
            <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1.1fr) minmax(0, 0.9fr)", gap: 12 }}>
              <DashboardPanel>
                <div style={{ display: "grid", gap: 9 }}>
                  <div>
                    <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Recent Assigned Students</h3>
                    <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
                      These are the latest students assigned to you for enrollment follow-up.
                    </p>
                  </div>

                  {loading ? (
                    <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                      Loading assigned tasks...
                    </DashboardPanel>
                  ) : assignments.length === 0 ? (
                    <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                      No tasks assigned yet.
                    </DashboardPanel>
                  ) : (
                    assignments.slice(0, 6).map((assignment) => (
                      <div key={assignment.assignment_id || assignment.student_id} style={{ display: "grid", gap: 3, padding: "8px 9px", borderRadius: 8, border: "1px solid var(--border-base)", background: "var(--surface-base)" }}>
                        <div style={{ display: "flex", justifyContent: "space-between", gap: 9 }}>
                          <strong style={{ color: "var(--text-primary)" }}>
                            {assignment.student_number || `ID:${assignment.student_id}`} | {formatStudentName(assignment)}
                          </strong>
                          <span style={{ color: "var(--brand-800)", fontSize: 10.5, fontWeight: 700 }}>Assigned</span>
                        </div>
                        <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                          {assignment.course_name || "No course"}{assignment.year_level ? ` | ${yearLevelLabel(assignment.year_level)}` : ""}{assignment.section ? ` | Section ${assignment.section}` : ""}
                        </div>
                        <AssignmentContactDetails assignment={assignment} />
                        <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>{formatEnrollmentLabel(assignment)}</div>
                        <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                          {assignment.assigned_by_name ? `Assigned by ${assignment.assigned_by_name}` : "Assigned by SSP Coordinator"}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </DashboardPanel>

              <DashboardPanel>
                <div style={{ display: "grid", gap: 9 }}>
                  <div>
                    <h3 style={{ margin: 0, color: "var(--text-primary)" }}>Assignment Notes</h3>
                    <p style={{ margin: "3px 0 0", color: "var(--text-secondary)", fontSize: 11.5 }}>
                      Notes added by the coordinator are shown here when available.
                    </p>
                  </div>

                  {loading ? (
                    <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                      Loading notes...
                    </DashboardPanel>
                  ) : assignments.length === 0 ? (
                    <DashboardPanel variant="dashed" style={{ fontSize: 11.5 }}>
                      No assignment notes yet.
                    </DashboardPanel>
                  ) : (
                    assignments.slice(0, 6).map((assignment) => (
                      <div key={`note-${assignment.assignment_id || assignment.student_id}`} style={{ padding: "8px 9px", borderRadius: 8, border: "1px solid var(--border-base)", background: "var(--surface-page)" }}>
                        <div style={{ color: "var(--text-primary)", fontWeight: 600, marginBottom: 3 }}>
                          {formatStudentName(assignment)}
                        </div>
                        <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                          {assignment.assignment_notes || "No coordinator notes for this task."}
                        </div>
                        <div style={{ color: "var(--text-muted)", fontSize: 10.5, marginTop: 5 }}>
                          Updated {formatTimestamp(assignment.assignment_updated_at)}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </DashboardPanel>
            </div>
          ) : null}
        </section>
      ) : null}

      {activeView === "assignments" && assignmentsModule ? (
        <section style={{ marginBottom: 19, display: "grid", gap: 12 }}>
          <OverviewHeader title="Assigned SSP Tasks" />
          <AlertMessage message={error} tone="error" />

          <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
            <div style={{ padding: 9, borderBottom: "1px solid var(--border-base)", display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center", justifyContent: "space-between" }}>
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search student, course, decision..."
                style={{ padding: "6px 8px", border: "1px solid var(--border-strong)", borderRadius: 6, minWidth: 204 }}
                name="ssp_caller_assignment_search"
              />

              <button
                type="button"
                onClick={() => void loadAssignments()}
                disabled={loading}
                style={{ ...buttonStyle, background: "var(--brand-700)", color: "#fff", opacity: loading ? 0.75 : 1 }}
              >
                {loading ? "Refreshing..." : "Refresh"}
              </button>
            </div>

            <div style={{ overflow: "auto", maxHeight: "calc(100vh - 230px)" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                    <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>No.</th>
                    <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Student</th>
                    <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Program</th>
                    <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Enrollment Update</th>
                    <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Assigned By</th>
                    <th style={{ padding: 9, position: "sticky", top: 0, background: "var(--surface-page)", borderBottom: "1px solid var(--border-base)", zIndex: 1 }}>Notes / Contact</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={6} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                        Loading assigned tasks...
                      </td>
                    </tr>
                  ) : filteredAssignments.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                        No assigned tasks found.
                      </td>
                    </tr>
                  ) : (
                    filteredAssignments.map((assignment, index) => (
                      <tr key={assignment.assignment_id || assignment.student_id}>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: "var(--text-muted)" }}>{index + 1}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 204 }}>
                          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                            {assignment.student_number || `ID:${assignment.student_id}`}
                          </div>
                          <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>{formatStudentName(assignment)}</div>
                          <AssignmentContactDetails assignment={assignment} fontSize={10.5} />
                        </td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 153 }}>
                          <div style={{ color: "var(--text-primary)" }}>{assignment.course_name || "No course"}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                            {assignment.department_name || "No department"}{assignment.year_level ? ` | ${yearLevelLabel(assignment.year_level)}` : ""}{assignment.section ? ` | Section ${assignment.section}` : ""}
                          </div>
                        </td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 187 }}>
                          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>{formatEnrollmentLabel(assignment)}</div>
                          <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>{assignment.reason || assignment.response || "Latest record needs follow-up."}</div>
                        </td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 153 }}>
                          <div style={{ color: "var(--text-primary)", fontWeight: 600 }}>
                            {assignment.assigned_by_name || "SSP Coordinator"}
                          </div>
                          <div style={{ color: "var(--text-muted)", fontSize: 10.5 }}>
                            Updated {formatTimestamp(assignment.assignment_updated_at)}
                          </div>
                        </td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 187 }}>
                          <div style={{ color: "var(--text-secondary)", fontSize: 11.5 }}>
                            {assignment.assignment_notes || "No coordinator notes."}
                          </div>
                          {contactModule ? (
                            <button
                              type="button"
                              onClick={() => setActiveView("student_contacts")}
                              style={{ ...buttonStyle, marginTop: 6, background: "var(--brand-600)", color: "#fff" }}
                            >
                              Log Call / Email
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      ) : null}

      {activeView === "reports" && reportsModule ? (
        <GrantedModuleView module={reportsModule} user={user} moduleProps={{ defaultReport: reportView, onReportChange: setReportView }} />
      ) : null}
      {grantedModule ? <GrantedModuleView module={grantedModule} user={user} modules={accessibleModules} /> : null}
    </DashboardShell>
  );
}
