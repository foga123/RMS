import React, { useMemo, useState } from "react";
import RetentionCasesPage from "./RetentionCasesPage";
import PdoPriorityPage from "./PdoPriorityPage";
import FacultyWorkspacePage from "../faculty-workspace/FacultyWorkspacePage";
import TeamMonitorPage from "../team-monitor/TeamMonitorPage";
// Deep import rather than the shared/components/ui barrel: that re-exports
// Breadcrumb, which imports react-router-dom, which jest cannot resolve — so
// reaching one component through it makes this shell untestable for a reason
// that has nothing to do with it. Same as TeamMonitorPage and SurveyFolderShelf.
import Tabs from "../../shared/components/ui/Tabs";
import { canModuleAction } from "../../shared/lib/roleAccess";

/**
 * The retention module's views, behind one set of tabs.
 *
 * The PDO Prioritization List joins the case workspace here rather than as a
 * module of its own for two reasons: it reads the same students under the same
 * permission (pdo_priority.php is gated on retention_cases), and a brand-new
 * RBAC module key would start life with no permission rows at all, locking
 * every role out of a screen they are meant to have.
 *
 * This shell is navigation only. It grants nothing: every page fetches its own
 * data and the backend decides what each account may see.
 *
 * ---------------------------------------------------------------------------
 * WHY THE FACULTY WORKSPACE IS IN HERE
 *
 * It was a module of its own, and it was the ONLY module faculty held that
 * nobody else did — the one role split in the whole permission map. Both
 * screens classify with pdo_priority_lib.php, both are department-scoped, and
 * since the PDO board learned to log a contact both record the same attempt
 * through the same writer. Two sidebar entries for one body of work is how two
 * screens start disagreeing about it.
 *
 * So it is a tab, not a page: one module in every rail, the same PDO engine
 * behind all of it, and nothing lost — the periodical drill-down and the
 * contact history this screen has and the board does not are still exactly
 * where they were.
 *
 * The tab appears for an account holding `faculty_workspace`, which is what the
 * endpoint behind it checks. That grant is deliberately kept when the module
 * leaves the sidebar, the same way the four survey modules stay granted while
 * presenting as one entry: the rail is navigation, and withdrawing the grant
 * would turn a tidier rail into a 403.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PRIORITIZATION LIST LEADS
 *
 * The module is called Potential Drop Out, and the question people open it with
 * is "who is at risk right now". The case board answered a narrower one: which
 * students somebody has already opened a case for. On a term where no
 * evaluation had been run that board is empty, so the module opened on nothing
 * and the only way to see a single at-risk student was to press Run Evaluation
 * — which WRITES, inserting and updating retention_case rows.
 *
 * That put a database write between the reader and a list they only wanted to
 * look at, and it meant anyone who could open the screen was the one who
 * triggered it.
 *
 * The prioritization list needs no such thing: pdo_priority.php computes the
 * 48-square classification on the fly and writes nothing, so it can lead. The
 * case board is still one click away and Run Evaluation still lives there,
 * unchanged — creating cases stays a decision somebody makes on purpose.
 *
 * A faculty account opens on My Students instead, and only because that is the
 * screen they were opening before this merge. It is a landing tab, not a
 * different module: everything else here is the same for them as for a dean.
 * ---------------------------------------------------------------------------
 */

const PDO_VIEW = { key: "pdo", label: "Potential Drop Outs" };
const FACULTY_VIEW = {
  key: "mine",
  label: "My Students",
  hint: "Your department, periodical by periodical, with the contact history behind each student",
};
const MONITOR_VIEW = {
  key: "monitor",
  label: "Monitoring",
  hint: "Contact coverage by faculty or callers, including who contacted each student",
};

export default function RetentionWorkspace(props) {
  /*
   * Read from the granted set rather than from the role. `modules` is the whole
   * set this account holds — the survey workspace uses it for the same purpose
   * — so an account that is given faculty_workspace later gets the tab with no
   * change here, and one that loses it stops being offered a screen its own
   * endpoint would refuse.
   */
  const facultyModule = useMemo(
    () => (props.modules || []).find((module) => module.view === "faculty_workspace") || null,
    [props.modules]
  );
  const monitorModule = useMemo(
    () => (props.modules || []).find((module) => module.view === "team_monitor") || null,
    [props.modules]
  );
  const retentionModule = (props.modules || []).find((module) => module.view === "retention_cases")
    || (props.module?.view === "retention_cases" ? props.module : null);
  const canOpenEvaluations = canModuleAction(retentionModule?.permissions, "view");
  const canOpenFacultyView = canModuleAction(facultyModule?.permissions, "view");
  const canOpenMonitorView = canModuleAction(monitorModule?.permissions, "view");

  const views = useMemo(
    () => [
      ...(canOpenFacultyView ? [FACULTY_VIEW] : []),
      PDO_VIEW,
      ...(canOpenEvaluations ? [{ key: "evaluations", label: "Stored evaluations" }] : []),
      ...(canOpenMonitorView ? [MONITOR_VIEW] : []),
    ],
    [canOpenFacultyView, canOpenMonitorView, canOpenEvaluations]
  );

  const [view, setView] = useState(canOpenFacultyView ? "mine" : "pdo");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 11 }}>
      <Tabs tabs={views} value={view} onChange={setView} label="Retention views" />

      {/*
        Mounted one at a time rather than hidden with CSS: each view runs its own
        polling refresh, and keeping the idle ones alive would have all of them
        querying on a timer for a screen nobody is looking at.

        `mine` falls back to the board if the tab is not on offer, so a stale
        value can never render a screen this account may not open.
      */}
      {view === "mine" && canOpenFacultyView ? (
        <FacultyWorkspacePage {...props} module={facultyModule} />
      ) : view === "monitor" && canOpenMonitorView ? (
        <TeamMonitorPage {...props} module={monitorModule} />
      ) : view === "evaluations" && canOpenEvaluations ? (
        <div><p className="mb-3 text-xs text-slate-500">Stored snapshots reflect their evaluation date. Re-run an evaluation after source records change. Potential Drop Outs shows the live classification.</p><RetentionCasesPage {...props} module={retentionModule} /></div>
      ) : (
        <PdoPriorityPage {...props} />
      )}
    </div>
  );
}
