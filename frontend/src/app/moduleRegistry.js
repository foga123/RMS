/**
 * The module registry — one entry per permission module.
 *
 * Adding a module used to mean editing ten places across three files (six maps
 * in backend/api/middleware/auth.php, three in utils/permissions.js, one in
 * SharedGrantedModules.jsx). Miss one and the module fails silently: it never
 * appears in the matrix, or it appears but cannot be opened.
 *
 * Everything the frontend needs about a module now lives in one row here.
 * `utils/permissions.js` derives its catalogue and alias map from this file,
 * and `app/moduleComponents.js` maps the same keys to pages. This file holds
 * metadata only — no React imports — so it stays safe to pull into utils
 * without dragging every page into the bundle.
 *
 * `key` must match the backend's module key in auth.php exactly. Aliases exist
 * because older payloads and some endpoints use singular or *_management
 * spellings; they normalise to `key` on the way in.
 */

export const MODULE_GROUPS = {
  workspace: { key: "workspace", label: "Workspace" },
  management: { key: "management", label: "Management" },
  survey_master: { key: "survey_master", label: "Survey Master" },
  operations: { key: "operations", label: "Operations" },
  analytics: { key: "analytics", label: "Analytics" },
  system: { key: "system", label: "System" },
};

/** Order here is the order shown in the role permission matrix. */
export const MODULE_REGISTRY = [
  {
    key: "overview",
    label: "Overview",
    group: "workspace",
    description: "Open the landing page of the role's dashboard.",
    // `dashboard` and `workspace` used to be separate modules for the same
    // idea — the page a role lands on. Which one a role actually needed
    // depended on which dashboard component it happened to render: Finance
    // read `dashboard`, the generic role dashboard read `workspace`, and
    // everything else read `overview`. Granting "Overview" to a Finance user
    // therefore did nothing, silently.
    //
    // They are aliases now, so permissions saved under the old keys still
    // resolve here instead of being dropped.
    aliases: ["dashboard", "workspace"],
    actions: ["view"],
  },
  {
    key: "users",
    label: "User Management",
    group: "management",
    description: "Manage user accounts and profile records.",
    aliases: ["user", "user_management"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "import", "export", "manage"],
  },
  {
    key: "student_manage",
    label: "Student Management",
    group: "management",
    description: "Manage student records and bulk data operations.",
    aliases: ["student_management"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "import", "export"],
  },
  {
    key: "attendance_management",
    label: "Attendance Management",
    group: "management",
    description: "Review backend-calculated student attendance summaries, and upload them.",
    aliases: ["attendance", "attendance_summary"],
    // `import` is the only write attendance has - the figures arrive as a
    // sheet and are never typed in - so there is no create or edit here.
    // Until it existed the uploader had no grantable permission and was
    // hard-wired to admin, while the button was offered to anyone holding
    // export. Mirrors api_permission_module_action_map() in middleware/auth.php.
    actions: ["view", "export", "analyze", "import"],
  },
  {
    key: "departments",
    label: "Department Management",
    group: "management",
    description: "Maintain department records.",
    aliases: ["department", "department_management"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "manage"],
  },
  {
    key: "roles",
    label: "Role Management",
    group: "management",
    description: "Create and maintain role records.",
    aliases: ["role", "role_management"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "manage"],
  },
  {
    key: "courses",
    label: "Course Management",
    group: "management",
    description: "Manage courses and their department links.",
    aliases: ["course", "course_management"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "manage"],
  },
  {
    key: "grades",
    label: "Grades Management",
    group: "management",
    description: "Create and maintain grade records.",
    actions: ["view", "create", "edit", "delete", "archive", "restore", "export"],
  },
  {
    key: "remarks",
    label: "Remarks Management",
    group: "management",
    description: "Create and maintain remarks.",
    aliases: ["remark", "remarks_management"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "manage"],
  },
  {
    key: "statuses",
    label: "Status Management",
    group: "management",
    description: "Manage system status master data.",
    aliases: ["status", "status_management"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "manage"],
  },
  {
    key: "campuses",
    label: "Campus Management",
    group: "management",
    description: "Create and maintain campus records.",
    aliases: ["campus", "campus_management"],
    actions: ["view", "create", "edit", "delete", "manage"],
  },
  {
    key: "enrollment_status",
    label: "Enrollment Status",
    group: "management",
    description: "Manage enrollment status records.",
    aliases: ["enrollmentstatus"],
    actions: ["view", "create", "edit", "delete", "archive", "restore", "manage"],
  },
  {
    key: "survey",
    label: "Surveys",
    group: "survey_master",
    description: "Create surveys or answer them based on role permissions.",
    actions: ["view", "create", "edit", "delete", "answer"],
  },
  {
    key: "survey_questions",
    label: "Survey Questions",
    group: "survey_master",
    description: "Manage survey questions and options.",
    aliases: ["survey_question"],
    actions: ["view", "create", "edit", "delete", "manage"],
  },
  {
    key: "survey_responses",
    label: "Survey Responses",
    group: "survey_master",
    description: "Review or maintain saved survey answers.",
    aliases: ["survey_response"],
    actions: ["view", "create", "edit", "delete", "analyze"],
  },
  {
    key: "survey_submissions",
    label: "Survey Submissions",
    group: "survey_master",
    description: "Review submission records or create new submissions.",
    aliases: ["survey_submission"],
    actions: ["view", "create", "delete", "analyze"],
  },
  {
    key: "finance_management",
    label: "Finance Management",
    group: "operations",
    description: "Manage finance balances and records.",
    aliases: ["finance"],
    actions: ["view", "create", "edit", "delete", "export"],
  },
  {
    key: "assignments",
    label: "Assignments",
    group: "operations",
    description: "Assign students or tasks to SSP users.",
    aliases: ["assignment"],
    actions: ["view", "create", "edit", "delete", "assign"],
  },
  {
    key: "faculty_workspace",
    /*
     * Still a module, no longer a sidebar entry.
     *
     * It presents as the "My Students" tab of Intervention, because both
     * screens classify the same students with the same engine and both record
     * the same contact through the same writer — see RetentionWorkspace. The
     * KEY and the grant stay: faculty_workspace.php checks them, and the tab
     * appears from them. Same arrangement as the four survey modules, which are
     * one rail entry and four permissions.
     */
    label: "Faculty Workspace",
    group: "operations",
    description: "One student list carrying this periodical's grades, attendance and balance, with the contact log for acting on them.",
    aliases: ["faculty_hub"],
    /*
     * `create` is the whole write surface: recording that a conversation
     * happened. No edit and no delete - a contact is a log of something that
     * occurred at a moment, and a log somebody can rewrite is not a log.
     */
    actions: ["view", "create", "analyze"],
  },
  {
    key: "student_contacts",
    label: "Contact Workspace",
    group: "operations",
    description: "Track contact attempts, follow-up status, and escalation readiness for assigned students.",
    aliases: ["student_contact"],
    actions: ["view", "create", "edit", "analyze"],
  },
  {
    key: "team_monitor",
    /*
     * Presented as the Monitoring tab of Intervention whenever that module is
     * also granted. The key and grant stay because team_monitor.php checks
     * them; an account holding only this module still gets its standalone rail
     * entry. A Dean and Program Head see the legacy standalone label as
     * "Faculty Monitoring" through moduleAccess.js.
     */
    label: "Team Monitoring",
    group: "operations",
    description: "See how much contact work each caller or faculty member has done, and which students have been reached.",
    aliases: ["team_monitoring"],
    // Read-only, like student_migration. The board reports what a team has
    // done; the calls themselves are still written in the Contact Workspace,
    // which is the one place that authorises them.
    actions: ["view", "analyze"],
  },
  {
    key: "home_visits",
    label: "Home Visit Workspace",
    group: "operations",
    description: "Manage escalated home visit follow-up records.",
    aliases: ["home_visit"],
    actions: ["view", "edit", "assign", "analyze"],
  },
  {
    key: "reports",
    label: "Reports",
    group: "analytics",
    description: "View analytics, summaries, and report pages.",
    aliases: ["report"],
    actions: ["view", "analyze"],
  },
  {
    key: "retention_cases",
    /*
     * Labelled "Intervention"; the KEY stays `retention_cases`.
     *
     * Renamed from "Potential Drop Out" on 2026-09-23. The College talks
     * about intervening, not about labelling students as likely to leave,
     * and the rail is the word everyone reads first.
     *
     * The key is not a display string — it is stored in role_module_access,
     * user_module_action_permission and the rbac_module catalogue, and it is
     * what every permission check compares against. Renaming it would silently
     * revoke this module from every role that has been granted it, which is a
     * data migration, not a rename. The label is the part people read.
     */
    label: "Intervention",
    group: "analytics",
    description: "Students at risk of dropping out, by grades, attendance and finance.",
    aliases: ["retention_case", "retention_cases", "retention", "pdo", "potential_drop_out"],
    /*
     * `intervene` is declared here because the backend recognizes it and this
     * list decides whether any saved grant survives the trip to the client.
     *
     * uniqueActionList() in shared/lib/permissions.js filters every incoming
     * action against this array, so an action the backend hands out but the
     * registry does not name is dropped in silence. A saved grant could reach
     * api_can() on the server and still become ["view"] in the browser before
     * any component saw it. The result would be a save that returned 200 and
     * wrote nothing, because saveCase() assembles its payload by permission and
     * would simply omit the intervention fields.
     *
     * Not the same as `edit`, and the split is the point: `edit` is signing off
     * that a case was correctly flagged, `intervene` is recording what you did
     * about it. See require_case_access() in backend/api/retention_case.php.
     *
     * Deliberately NOT added to ACCESS_MANAGEMENT_PERMISSION_ACTIONS: the RBAC
     * catalogue has no rbac_action row for it, so it cannot be stored per role.
     * Offering it as a checkbox would produce a save that throws. See the note
     * on that constant in utils/permissions.js.
     */
    actions: ["view", "create", "edit", "delete", "assign", "analyze", "intervene"],
  },
  {
    key: "student_migration",
    label: "Student Migration",
    group: "analytics",
    description: "Track where a department's students stand across enrollment statuses.",
    aliases: ["migration", "student_migrations"],
    actions: ["view", "analyze"],
  },
  {
    // Read-only, and more strictly so than the modules around it: everything it
    // shows already happened. Editing a grade stays with `grades`, a balance
    // with `finance_management`, and the audit trail is not editable anywhere.
    key: "records_history",
    label: "Records & History",
    group: "analytics",
    description: "Open a finished term, follow one student across terms, and read the activity log.",
    aliases: ["records", "history", "logbook", "records_and_history"],
    actions: ["view", "analyze"],
  },
  {
    /*
     * Grouped with `management`, not with `system`.
     *
     * It sets one thing — which term it is now — and three working modules read
     * it on every page load. That makes it part of running the term rather than
     * part of configuring the installation, and it is opened at the start of
     * every periodical rather than once at setup.
     *
     * `analyze` is deliberately absent: there is nothing here to analyse. The
     * three actions are read it, change the dates, pin the term.
     */
    key: "academic_calendar",
    label: "Academic Calendar",
    group: "management",
    description: "Set the school year, semester and periodical the portal treats as now. Grades, Attendance and Finance default to it.",
    aliases: ["calendar", "academic-calendar", "term_calendar", "current_term"],
    actions: ["view", "edit"],
  },
  {
    /*
     * The lists forms offer that the office maintains: contact reasons,
     * recovery plans, channels, scholarship grants, genders, modalities. Each
     * is described once on the server (backend lib/dropdown_lists.php); this
     * screen and every form read them from there.
     *
     * No `delete`: an entry is archived, because records already hold it.
     * `archive`/`restore` are apart from `edit` so rewording an entry and
     * taking it off every form can be granted separately.
     */
    key: "dropdown_lists",
    label: "Dropdown Management",
    group: "management",
    description: "Edit the lists the forms offer: contact reasons, recovery plans, channels, scholarship grants, genders and modalities.",
    aliases: ["dropdown_list", "dropdown_management", "dropdowns"],
    actions: ["view", "create", "edit", "archive", "restore"],
  },
  {
    key: "settings",
    label: "Settings",
    group: "system",
    description: "Update security, backup, log, and system configuration settings.",
    aliases: ["setting"],
    actions: ["view", "edit", "manage"],
  },
];

/**
 * Every spelling that resolves to a canonical key, including each key itself.
 * Built from the registry so an alias can never be declared without its module.
 */
export const MODULE_KEY_ALIASES = MODULE_REGISTRY.reduce((acc, module) => {
  acc[module.key] = module.key;
  (module.aliases || []).forEach((alias) => {
    acc[alias] = module.key;
  });
  return acc;
}, {});
