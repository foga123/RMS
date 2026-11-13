import React, { useEffect, useMemo, useState } from "react";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import ActionMenu from "../../shared/components/ui/ActionMenu";
import { SkeletonTableRows } from "../../shared/components/ui/Skeleton";
import { ManagementPagination } from "../../shared/components/management";
import { hasModulePermission } from "../../shared/lib/roleAccess";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import { localDateIso } from "../../shared/lib/localDate";
import { surveyTextCounter, surveyTextLimit } from "./textLimits";
import SectionHeader from "../../shared/components/ui/SectionHeader";


const defaultForm = {
  survey_id: "",
  semester_id: "",
  // "" is a whole-semester survey, which is what all five existing surveys are.
  period: "",
  status: "",
  // Filled with today by the Add Survey button, not here: this object is
  // module-level, so a date evaluated at import would be the day the tab was
  // opened rather than the day the survey is made. Left blank for edit, where
  // the row's own date is spread over the top.
  date: "",
  survey_title: "",
  // Blank means "start empty". Only ever sent when creating: an existing survey
  // already has its questions, and copying more onto it would append a second
  // set rather than replace anything.
  copy_from_survey_id: "",
};

/**
 * Which retention period a survey belongs to, for the list column.
 *
 * Spelled "Period 2" rather than "P2". This module's own screens are safe
 * either way, but a survey's period is read alongside the retention case it
 * feeds, and that screen already spends "P1" on an urgency band.
 */
function surveyPeriodLabel(period) {
  const value = Number(period);
  return [1, 2, 3].includes(value) ? `Period ${value}` : "Whole semester";
}

/**
 * `onAddQuestions` / `onViewSubmissions` are the workspace's handoffs. Null when
 * the account cannot reach that tab, which is what keeps the button from
 * offering a door that is locked.
 */
export default function SurveyManage({ permissions = [], onAddQuestions = null, onViewSubmissions = null }) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);

  const [search, setSearch] = useState("");
  const [semesters, setSemesters] = useState([]);
  const [surveyStatuses, setSurveyStatuses] = useState([]);

  const [form, setForm] = useState(defaultForm);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const canCreate = hasModulePermission(permissions, "create");
  const canEdit = hasModulePermission(permissions, "edit");
  // The column now also carries the two handoffs, so a reader who cannot edit
  // can still walk through to a survey's questions or its answers.
  const showActionColumn = canEdit || Boolean(onAddQuestions) || Boolean(onViewSubmissions);
  const columnCount = showActionColumn ? 7 : 6;

  // NOTE: This UI assumes a backend endpoint exists at frontend/backend/api/survey.php
  // with methods:
  //   GET    survey.php?page=&limit=&search=
  //   POST   survey.php
  //   PUT    survey.php?id=...
  async function load() {
    // Stale answers are dropped rather than rendered: this runs again on every
    // filter change and from useLiveRefresh, so a slower earlier request must
    // not land last. See useLatestRequest.
    const isCurrent = beginRequest();
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams();
      params.set("page", String(page));
      params.set("limit", String(limit));
      if (search && search.trim() !== "") params.set("search", search.trim());

      const res = await fetch(getBackendUrl(`survey.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load surveys");

      if (!isCurrent()) return;

      setRows(Array.isArray(data.data) ? data.data : []);
      setTotal(Number(data?.pagination?.total || 0));
    } catch (e) {
      if (!isCurrent()) return;
      setError(e.message || "Failed to load surveys");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  async function loadLookups() {
    try {
      const [semesterRes, statusRes] = await Promise.all([
        fetch(getBackendUrl("semester.php?limit=200"), { credentials: "include" }),
        fetch(getBackendUrl("status.php?limit=500"), { credentials: "include" }),
      ]);

      const semesterData = await semesterRes.json();
      const statusData = await statusRes.json();

      if (!semesterRes.ok) throw new Error(semesterData.message || "Failed to load semesters");
      if (!statusRes.ok) throw new Error(statusData.message || "Failed to load statuses");

      const semesterRows = Array.isArray(semesterData.data) ? semesterData.data : [];
      const allStatuses = Array.isArray(statusData.data) ? statusData.data : [];
      const accountStatuses = allStatuses.filter((s) => String(s.status_type || "").toLowerCase() === "account");

      setSemesters(semesterRows);
      setSurveyStatuses(accountStatuses);
    } catch (e) {
      setError(e.message || "Failed to load form options");
    }
  }

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, limit, search]);

  useLiveRefresh(["surveys"], load);

  useEffect(() => {
    loadLookups();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const defaultSemesterId = useMemo(() => {
    return semesters.length > 0 ? String(semesters[0].semester_id) : "";
  }, [semesters]);

  const defaultStatusId = useMemo(() => {
    if (!surveyStatuses.length) return "";
    const active = surveyStatuses.find((s) => String(s.status_name || "").toLowerCase() === "active");
    return String(active ? active.status_id : surveyStatuses[0].status_id);
  }, [surveyStatuses]);

  const semesterNameById = useMemo(() => {
    const map = {};
    semesters.forEach((s) => {
      map[Number(s.semester_id)] = s.semester_name;
    });
    return map;
  }, [semesters]);

  const statusNameById = useMemo(() => {
    const map = {};
    surveyStatuses.forEach((s) => {
      map[Number(s.status_id)] = s.status_name;
    });
    return map;
  }, [surveyStatuses]);

  /**
   * A new survey is always Active, so the picker is not shown when adding one -
   * it was a required field with exactly one sensible answer, already filled in.
   * The status is still sent; it is just resolved rather than asked for.
   *
   * It stays on the edit form, where the choice is real: that is where a survey
   * gets deactivated or archived once it has run.
   *
   * The `!defaultStatusId` arm is a fallback, not a normal path. If the status
   * list fails to load there is no "Active" row to resolve, and hiding the
   * control would leave a required field that cannot be filled and a save that
   * cannot succeed. In that case the picker comes back.
   */
  const showStatusField = Boolean(form.survey_id) || !defaultStatusId;

  // Only appears in the last fifth of the allowance — see textLimits.js.
  const titleCounter = surveyTextCounter("survey_title", form.survey_title);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const isEdit = !!form.survey_id;
      if (isEdit && !canEdit) throw new Error("You do not have permission to edit surveys.");
      if (!isEdit && !canCreate) throw new Error("You do not have permission to create surveys.");
      const url = getBackendUrl("survey.php" + (isEdit ? `?id=${form.survey_id}` : ""));

      const payload = {
        survey_title: form.survey_title,
        semester_id: form.semester_id,
        // Sent as null rather than "" so the endpoint reads it as "no
        // periodical" instead of trying to parse an empty string as one.
        period: form.period === "" || form.period == null ? null : Number(form.period),
        date: form.date,
        // Re-resolved here rather than trusted from the form: on a new survey
        // the field is hidden, and if the status list happened to arrive after
        // the dialog opened, form.status would still be blank.
        status: isEdit ? form.status : form.status || defaultStatusId,
      };
      if (!payload.semester_id) throw new Error("Please select a semester");
      if (!payload.status) throw new Error("Please select a status");
      if (payload.semester_id !== "" && payload.semester_id != null) payload.semester_id = Number(payload.semester_id);
      if (payload.status !== "" && payload.status != null) payload.status = Number(payload.status);

      // Creating only. The server copies the questions, their options and their
      // branching conditions in the same transaction as the insert.
      if (!isEdit && form.copy_from_survey_id) {
        payload.copy_from_survey_id = Number(form.copy_from_survey_id);
      }

      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save survey");

      setIsModalOpen(false);
      setForm(defaultForm);
      await load();

      /*
       * Straight on to the questions for a survey that was just created.
       *
       * A new survey with no questions is not usable by anybody, so this is
       * always the next step - and before this, taking it meant leaving the
       * page, finding Survey Questions in the rail, and picking the survey you
       * had made thirty seconds ago out of a dropdown. Only on create: an edit
       * is usually a title or a date, and moving the page then would be rude.
       */
      if (!isEdit && onAddQuestions && data?.data?.survey_id) {
        onAddQuestions(data.data);
      }
    } catch (e) {
      setError(e.message || "Failed to save survey");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Survey Title Management</h2>
      {/* One error on screen at a time. While the dialog is open it shows the
          failure itself, and this box sits behind the overlay saying the same
          sentence to nobody — so it stands down rather than duplicating it. */}
      <AlertMessage message={isModalOpen ? "" : error} tone="error" />

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <SectionHeader sticky title="All Surveys">
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <input
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              placeholder="Search by title..."
              style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, minWidth: 204 }}
             name="survey_manage_input_237"/>

            {/* Rows-per-page lives with the pager under the table, not here. */}
            {canCreate ? (
              <button
                onClick={() => {
                  setForm({ ...defaultForm, semester_id: defaultSemesterId, status: defaultStatusId, date: localDateIso() });
                  setIsModalOpen(true);
                }}
                style={{ background: "var(--brand-600)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}
              >
                + Add Survey
              </button>
            ) : null}
          </div>
        </SectionHeader>

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 221px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>No.</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Title</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Semester</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Period</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Date</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Status</th>
                {showActionColumn ? (
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Action</th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows columns={columnCount} />
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={columnCount} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                    No surveys found
                  </td>
                </tr>
              ) : (
                rows.map((r, idx) => (
                  <tr key={r.survey_id}>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{(page - 1) * limit + idx + 1}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.survey_title || ""}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.semester_name || semesterNameById[Number(r.semester_id)] || (r.semester_id ?? "")}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: r.period ? "var(--text-primary)" : "var(--text-muted)" }}>
                      {surveyPeriodLabel(r.period)}
                    </td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.date ?? ""}</td>
                    <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.status_name || statusNameById[Number(r.status)] || (r.status ?? "")}</td>
                    {showActionColumn ? (
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                        {/* One kebab, matching every other management table. This
                            row carried three buttons — the widest Action column in
                            the app — and Questions/Answers are navigation rather
                            than row edits, so they read better as named menu
                            entries than as two more outline buttons. */}
                        <ActionMenu
                          label={`Actions for ${r.survey_name || r.title || "this survey"}`}
                          items={[
                            ...(onAddQuestions
                              ? [{ key: "questions", label: "Questions", icon: "columns", onSelect: () => onAddQuestions(r) }]
                              : []),
                            ...(onViewSubmissions
                              ? [{ key: "answers", label: "Answers", icon: "eye", onSelect: () => onViewSubmissions(r) }]
                              : []),
                            ...(canEdit
                              ? [{
                                  key: "edit",
                                  label: "Edit",
                                  icon: "edit",
                                  onSelect: () => {
                                    setForm({
                                      ...defaultForm,
                                      ...r,
                                      semester_id: r.semester_id != null ? String(r.semester_id) : "",
                                      period: r.period != null ? String(r.period) : "",
                                      status: r.status != null ? String(r.status) : defaultStatusId,
                                    });
                                    setIsModalOpen(true);
                                  },
                                }]
                              : []),
                          ]}
                        />
                      </td>
                    ) : null}
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ padding: 9, borderTop: "1px solid var(--border-base)" }}>
          <ManagementPagination
            page={page}
            limit={limit}
            total={total}
            onPageChange={setPage}
            onLimitChange={(size) => {
              setLimit(size);
              setPage(1);
            }}
            itemLabel="surveys"
          />
        </div>
      </div>

      {isModalOpen && (canCreate || canEdit) && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }}
          onClick={() => setIsModalOpen(false)}
        >
          <div
            style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 612, maxHeight: "85vh", overflow: "auto", border: "1px solid var(--border-base)", boxShadow: "0 12px 24px rgba(2,6,23,0.12)", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--text-primary)" }}>{form.survey_id ? "Edit Survey" : "Add Survey"}</strong>
              <button onClick={() => setIsModalOpen(false)} style={{ background: "transparent", border: 0, fontSize: 16, cursor: "pointer", color: "var(--text-secondary)" }} aria-label="Close">
                ×
              </button>
            </div>
            {/* Inside the dialog, because this is where the action was taken. The
                page-level box below is painted UNDER this overlay, so a save the
                server refuses used to look like nothing happening at all. */}
            {error ? (
              <div style={{ flexShrink: 0, padding: "9px 12px 0" }}>
                <AlertMessage message={error} tone="error" style={{ marginBottom: 0 }} />
              </div>
            ) : null}

            <div style={{ padding: 12, display: "grid", gap: 9 }}>
              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Survey Title</label>
                <input
                  value={form.survey_title}
                  onChange={(e) => setForm((f) => ({ ...f, survey_title: e.target.value }))}
                  maxLength={surveyTextLimit("survey_title")}
                  style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                  placeholder="Enter survey title"
                 name="survey_manage_input_381"/>
                {titleCounter ? (
                  <div style={{ marginTop: 3, textAlign: "right", fontSize: 10.5, color: titleCounter.over ? "var(--danger-800)" : "var(--text-muted)" }}>
                    {titleCounter.length} / {titleCounter.limit}
                  </div>
                ) : null}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 8 }}>
                <div>
                  {/*
                    * A survey belongs to one retention period, and that is how
                    * the evaluation finds it: a P2 run reads the P2 survey and
                    * falls back to a whole-semester one only if there is none.
                    *
                    * To run the same questions at all three periods, make the
                    * survey once and use "Copy questions from" below - cloning
                    * is what keeps the three from drifting apart as they get
                    * retyped.
                    */}
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Retention Period</label>
                  <select
                    value={String(form.period ?? "")}
                    onChange={(e) => setForm((f) => ({ ...f, period: e.target.value }))}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                    name="survey_manage_period"
                  >
                    <option value="">Whole semester (no period)</option>
                    <option value="1">Period 1</option>
                    <option value="2">Period 2</option>
                    <option value="3">Period 3</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Semester</label>
                  <select
                    value={String(form.semester_id || "")}
                    onChange={(e) => setForm((f) => ({ ...f, semester_id: e.target.value }))}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                   name="survey_manage_select_392">
                    <option value="">Select semester</option>
                    {semesters.map((s) => (
                      <option key={s.semester_id} value={s.semester_id}>
                        {s.semester_name}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Date</label>
                  {/* Required, because the server refuses a blank one: the
                      survey lists sort on this column and print it. Filled in
                      with today's date when the dialog opens, so this only
                      fires if somebody deliberately clears it. */}
                  <input
                    type="date"
                    required
                    value={form.date || ""}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                   name="survey_manage_input_408"/>
                </div>
              </div>

              {/* Copying is offered on creation only. A survey that already
                  exists has its questions; copying onto it would append a second
                  set rather than replace the first, which is never what anyone
                  means by "copy". */}
              {!form.survey_id ? (
                <div>
                  <label htmlFor="survey_copy_from" style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>
                    Start from an existing survey
                  </label>
                  <select
                    id="survey_copy_from"
                    name="survey_copy_from"
                    value={String(form.copy_from_survey_id || "")}
                    onChange={(e) => setForm((f) => ({ ...f, copy_from_survey_id: e.target.value }))}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5, background: "var(--surface-base)", color: "var(--text-primary)" }}
                  >
                    <option value="">Start with no questions</option>
                    {rows.map((survey) => (
                      <option key={survey.survey_id} value={survey.survey_id}>
                        {survey.survey_title || `Survey #${survey.survey_id}`}
                        {survey.semester_name ? ` - ${survey.semester_name}` : ""}
                        {survey.date ? ` (${survey.date})` : ""}
                      </option>
                    ))}
                  </select>
                  <div style={{ fontSize: 10.5, color: "var(--text-muted)", marginTop: 3 }}>
                    Copies that survey's questions, choices and branching rules into this new one. The copy is
                    independent — editing it will not change the survey it came from.
                  </div>
                </div>
              ) : null}

              {showStatusField ? (
                <div>
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Status</label>
                  <select
                    value={String(form.status || "")}
                    onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                   name="survey_manage_select_419">
                    <option value="">Select status</option>
                    {surveyStatuses.length > 0 ? (
                      surveyStatuses.map((s) => (
                        <option key={s.status_id} value={s.status_id}>
                          {s.status_name}
                        </option>
                      ))
                    ) : (
                      <>
                        <option value="1">Active</option>
                        <option value="2">Inactive</option>
                      </>
                    )}
                  </select>
                </div>
              ) : null}
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button onClick={() => setIsModalOpen(false)} style={{ background: "var(--border-base)", color: "var(--text-primary)", border: 0, padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving} style={{ background: "var(--brand-600)", color: "#fff", border: 0, padding: "6px 9px", borderRadius: 6, cursor: saving ? "not-allowed" : "pointer" }}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
