import React, { useMemo, useState } from "react";
import SurveyManage from "./SurveysPage";
import SurveyQuestionManage from "./SurveyQuestionsPage";
import SurveyResponseManage from "./SurveyResponsesPage";
import SurveyManageSubmission from "./SurveySubmissionsPage";
import { surveyWorkspaceTabs } from "./surveyTabs";
import { canModuleAction } from "../../shared/lib/roleAccess";

/*
 * The same predicate the survey screens apply to their own buttons: an empty
 * list means the page was mounted without permission information, which these
 * screens read as "not restricted here" and leave to the server. Kept identical
 * so a control does not appear on one tab and vanish on another for one account.
 */
function hasSurveyPermission(permissions, action) {
  if (!Array.isArray(permissions) || permissions.length === 0) return true;
  return canModuleAction(permissions, action);
}

/**
 * The four survey screens behind one entry in the rail.
 *
 * Building a survey is one job done in a fixed order — name it, ask the
 * questions, read what came back — and it was split across four sidebar items
 * that gave no hint of that order and no way to move between them. Creating a
 * survey left you on the Surveys list; adding its questions meant finding the
 * rail, clicking Survey Questions, and picking the survey you had just made out
 * of a dropdown.
 *
 * This is a *navigation* merge only. The four permission modules underneath are
 * untouched: `survey`, `survey_questions`, `survey_responses` and
 * `survey_submissions` are still granted, revoked and enforced separately, and
 * a tab appears here only if this account holds `view` on that module. Merging
 * them into one permission would have quietly handed Secretary the question
 * editor it is deliberately given read-only, so the tabs are filtered instead.
 *
 * Hiding a tab is not the control. Every screen behind these tabs calls its own
 * endpoint, and each of those endpoints checks its own module server-side.
 *
 * `focusSurvey` is the shared thread: it is how "add questions to the survey I
 * just made" and "read the answers to the survey I am editing" become one click
 * instead of a tab change plus a search.
 */

export default function SurveyWorkspace({ user, modules = [], initialView = "" }) {
  /** The granted survey modules, in workflow order. See surveyTabs.js. */
  const tabs = useMemo(() => surveyWorkspaceTabs(modules), [modules]);

  /*
   * `initialView` is which of the four the workspace was opened *as* - the rail
   * entry carries one of the four module views, and a reload restores whichever
   * was persisted. Honouring it means a restored session lands where it left
   * off rather than on the first tab. Only the opening tab: after mount the tab
   * bar owns this, so a later prop change deliberately does not move it.
   */
  const [activeTab, setActiveTab] = useState(
    () => (tabs.some((tab) => tab.view === initialView) ? initialView : tabs[0]?.view || "")
  );
  /**
   * The survey a tab was opened *about*, handed to the next screen so it can
   * open that folder rather than its shelf. Cleared when a tab is chosen from
   * the bar, because that is someone browsing, not following a thread.
   */
  const [focusSurvey, setFocusSurvey] = useState(null);

  // A permission can be revoked mid-session; fall back rather than blank out.
  const current = tabs.find((tab) => tab.view === activeTab) || tabs[0] || null;

  if (!current) return null;

  function goTo(view, survey = null) {
    if (!tabs.some((tab) => tab.view === view)) return;
    setFocusSurvey(survey);
    setActiveTab(view);
  }

  const permissionsFor = (view) => tabs.find((tab) => tab.view === view)?.permissions || [];
  const canReach = (view) => tabs.some((tab) => tab.view === view);

  /*
   * May this account rename a survey?
   *
   * Deliberately the `survey` module's rule, not `survey_questions`, and only
   * when that tab is actually granted - so it is exactly the accounts that
   * could rename it from the Surveys tab, and nobody else. Hiding the control
   * is not what enforces this: survey.php gates PUT on the same module.
   */
  const canEditSurvey = canReach("survey") && hasSurveyPermission(permissionsFor("survey"), "edit");

  return (
    <section>
      {tabs.length > 1 ? (
        <div
          role="tablist"
          aria-label="Survey workspace"
          style={{ display: "flex", gap: 4, flexWrap: "wrap", marginBottom: 12, borderBottom: "1px solid var(--border-base)", paddingBottom: 0 }}
        >
          {tabs.map((tab) => {
            const active = tab.view === current.view;
            return (
              <button
                key={tab.view}
                type="button"
                role="tab"
                aria-selected={active}
                title={tab.hint}
                onClick={() => {
                  setFocusSurvey(null);
                  setActiveTab(tab.view);
                }}
                className="survey-tab"
                data-active={active ? "true" : undefined}
              >
                {tab.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {current.view === "survey" ? (
        <SurveyManage
          user={user}
          permissions={permissionsFor("survey")}
          /* Straight from "Survey created" to the empty question folder for it,
             which is where whoever just created it was always going next. */
          onAddQuestions={canReach("survey_questions") ? (survey) => goTo("survey_questions", survey) : null}
          onViewSubmissions={canReach("survey_submissions") ? (survey) => goTo("survey_submissions", survey) : null}
        />
      ) : null}

      {current.view === "survey_questions" ? (
        <SurveyQuestionManage
          permissions={permissionsFor("survey_questions")}
          initialSurvey={focusSurvey}
          canEditSurvey={canEditSurvey}
          onOpenSubmissions={canReach("survey_submissions") ? (survey) => goTo("survey_submissions", survey) : null}
        />
      ) : null}

      {current.view === "survey_submissions" ? (
        <SurveyManageSubmission
          permissions={permissionsFor("survey_submissions")}
          initialSurvey={focusSurvey}
        />
      ) : null}

      {current.view === "survey_responses" ? (
        <SurveyResponseManage permissions={permissionsFor("survey_responses")} />
      ) : null}
    </section>
  );
}
