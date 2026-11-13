/**
 * Which survey tabs an account gets, and in what order.
 *
 * Pulled out of the workspace component because this is the rule that decides
 * what somebody can see. A rule kept inside a component can only be tested by
 * rendering four pages' worth of imports, which in practice means it does not
 * get tested at all.
 *
 * The order is the workflow, not the registry's alphabetical order: name the
 * survey, write its questions, read who answered, then maintain the answers.
 * Someone doing this for the first time can follow the tabs left to right.
 *
 * Filtering here is presentation. It stops the portal offering a door that will
 * not open; it is not what keeps the door shut. Every screen behind these tabs
 * calls its own endpoint, and each endpoint checks its own module server-side.
 */

export const SURVEY_TAB_ORDER = [
  { view: "survey", label: "Surveys", hint: "Create and name the survey" },
  { view: "survey_questions", label: "Questions", hint: "Write what it asks" },
  { view: "survey_submissions", label: "Submissions", hint: "See who answered" },
  { view: "survey_responses", label: "Answers", hint: "Maintain saved answers" },
];

export const SURVEY_WORKSPACE_VIEWS = SURVEY_TAB_ORDER.map((tab) => tab.view);

export function isSurveyWorkspaceView(view) {
  return SURVEY_WORKSPACE_VIEWS.includes(view);
}

/**
 * The granted survey modules as tabs.
 *
 * A module the account does not hold is absent, not disabled — a greyed-out tab
 * would tell every Secretary exactly which permissions they are missing, which
 * is noise for them and a map for anybody else reading over their shoulder.
 */
export function surveyWorkspaceTabs(modules) {
  const byView = new Map();
  (modules || []).forEach((module) => {
    if (module?.view && isSurveyWorkspaceView(module.view) && !byView.has(module.view)) {
      byView.set(module.view, module);
    }
  });

  return SURVEY_TAB_ORDER.filter((tab) => byView.has(tab.view)).map((tab) => ({
    ...tab,
    module: byView.get(tab.view),
    permissions: byView.get(tab.view).permissions || [],
  }));
}
