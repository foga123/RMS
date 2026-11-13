import React, { useEffect, useMemo, useRef, useState } from "react";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import { SkeletonTableRows, SkeletonText } from "../../shared/components/ui/Skeleton";
import { ManagementPagination } from "../../shared/components/management";
import { hasModulePermission } from "../../shared/lib/roleAccess";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import SectionHeader from "../../shared/components/ui/SectionHeader";


const defaultForm = {
  response_id: "",
  survey_id: "",
  question_id: "",
  student_id: "",
  answer: "",
  date: "",
};

/**
 * Every page of a list endpoint.
 *
 * They all cap at 200 rows a page, and the student list is past 500, so a
 * single request would silently offer a dropdown missing two thirds of the
 * school — the kind of gap nobody notices until the one student they wanted is
 * the one that is not there.
 */
async function fetchAllRows(endpoint, params = {}) {
  const all = [];
  const pageSize = 200;
  const maxPages = 25;

  for (let currentPage = 1; currentPage <= maxPages; currentPage += 1) {
    const query = new URLSearchParams({ ...params, page: String(currentPage), limit: String(pageSize) });
    const res = await fetch(getBackendUrl(`${endpoint}?${query.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.message || `Failed to load ${endpoint}`);

    const list = Array.isArray(data.data) ? data.data : [];
    all.push(...list);
    if (list.length < pageSize) break;
  }

  return all;
}

/** "ALABA FRANCIS OLIVER - 02-2324-10233", so either half finds the row. */
function studentLabel(student) {
  const name = `${student?.first_name || ""} ${student?.last_name || ""}`.trim();
  const number = String(student?.student_number || "").trim();
  if (name && number) return `${name} - ${number}`;
  return name || number || `Student #${student?.student_id}`;
}

const modalFieldStyle = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid var(--border-base)",
  borderRadius: 5,
  background: "var(--surface-base)",
  color: "var(--text-primary)",
};

export default function SurveyResponseManage({ permissions = [] }) {
  // Raw API rows
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);

  // Filters: use Student Number (not internal student_id)
  const [surveyIdFilter, setSurveyIdFilter] = useState("");
  const [studentNumberFilter, setStudentNumberFilter] = useState("");

  // Apply button behavior
  const [appliedFilters, setAppliedFilters] = useState({ survey_id: "", student_number: "" });

  // For display (no internal IDs):
  const [surveyTitleResolved, setSurveyTitleResolved] = useState("");

  // Click student number -> open floating modal card
  const [studentModal, setStudentModal] = useState({ open: false, studentNumber: "", surveyTitle: "", rows: [], loading: false, error: "" });

  const [form, setForm] = useState(defaultForm);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [nextPlanOnly, setNextPlanOnly] = useState(false);
  const [nextPlanAnswer, setNextPlanAnswer] = useState('');
  const canCreate = hasModulePermission(permissions, "create");
  const canEdit = hasModulePermission(permissions, "edit");

  /*
   * The choices behind the Add / Edit Response form.
   *
   * Every field here used to be a text box asking for a primary key - "Survey
   * ID", "Question ID", "Student ID", placeholder "e.g. 1". That asks whoever
   * fills it in to already know the internal id of three different tables, and
   * a mistyped one either fails a foreign key check or, worse, files the answer
   * against the wrong student and looks like it worked.
   *
   * Loaded when the modal first opens rather than with the page: the student
   * list is three requests, and most visits to this screen never open the form.
   */
  const [choices, setChoices] = useState({ surveys: [], students: [], loaded: false, loading: false, error: "" });
  const [questionChoices, setQuestionChoices] = useState([]);
  const [optionChoices, setOptionChoices] = useState([]);

  /*
   * Fired once per mount, tracked on a ref rather than on the state it sets.
   *
   * The first version of this listed `choices.loading` in its dependencies and
   * also set it. That is a loop with a sting in it: setting loading re-ran the
   * effect, re-running it fired the previous run's cleanup, and the cleanup set
   * the cancelled flag that the still-in-flight fetch checked before storing
   * its results. Every dropdown came back empty, with no error and no failed
   * request to point at - the data arrived and was dropped on the doorstep.
   *
   * A ref does not participate in rendering, so the guard cannot re-trigger the
   * effect it guards.
   */
  const choicesRequested = useRef(false);
  const isMounted = useRef(true);
  useEffect(() => () => { isMounted.current = false; }, []);

  useEffect(() => {
    if (!isModalOpen || choicesRequested.current) return;
    choicesRequested.current = true;

    setChoices((prev) => ({ ...prev, loading: true, error: "" }));

    /*
     * Settled independently, not Promise.all'd.
     *
     * These are two different endpoints behind two different permissions. With
     * all(), a role that may manage responses but may not list students lost
     * the survey dropdown too - one refusal emptied both. Each list now stands
     * or falls on its own, and the error line names only what actually failed.
     */
    Promise.allSettled([fetchAllRows("survey.php"), fetchAllRows("student.php")]).then(
      ([surveyResult, studentResult]) => {
        if (!isMounted.current) return;

        const failures = [];
        if (surveyResult.status === "rejected") failures.push("surveys");
        if (studentResult.status === "rejected") failures.push("students");

        // Retryable: reopening the dialog tries again rather than showing the
        // same stale failure for the rest of the session.
        if (failures.length > 0) choicesRequested.current = false;

        setChoices({
          surveys: surveyResult.status === "fulfilled" ? surveyResult.value : [],
          students: studentResult.status === "fulfilled" ? studentResult.value : [],
          loaded: failures.length === 0,
          loading: false,
          error: failures.length > 0 ? `Could not load ${failures.join(" or ")}.` : "",
        });
      }
    );
  }, [isModalOpen]);

  // Questions belong to a survey, so the second dropdown is filled from the
  // first rather than listing every question in the database.
  useEffect(() => {
    const surveyId = String(form.survey_id || "").trim();
    if (!isModalOpen || !surveyId) {
      setQuestionChoices([]);
      return undefined;
    }

    let cancelled = false;
    fetchAllRows("survey_question.php", { survey_id: surveyId })
      .then((list) => {
        if (!cancelled) setQuestionChoices(list);
      })
      .catch(() => {
        if (!cancelled) setQuestionChoices([]);
      });

    return () => {
      cancelled = true;
    };
  }, [isModalOpen, form.survey_id]);

  const selectedQuestion = useMemo(
    () => questionChoices.find((q) => String(q.question_id) === String(form.question_id)) || null,
    [questionChoices, form.question_id]
  );

  /*
   * A question whose answers come from a fixed list gets a dropdown of that
   * list, for the same reason the ids did: the author already wrote the allowed
   * answers down, so typing one by hand can only introduce a spelling that will
   * not group with the others in the report.
   */
  const answerChoiceKind = (() => {
    const type = String(selectedQuestion?.question_type || "");
    if (type === "radio" || type === "checkbox") return "options";
    if (type === "rating") return "rating";
    return "text";
  })();

  useEffect(() => {
    const questionId = String(form.question_id || "").trim();
    if (!questionId || answerChoiceKind !== "options") {
      setOptionChoices([]);
      return undefined;
    }

    let cancelled = false;
    fetchAllRows("survey_question_option.php", { question_id: questionId })
      .then((list) => {
        if (!cancelled) setOptionChoices(list);
      })
      .catch(() => {
        if (!cancelled) setOptionChoices([]);
      });

    return () => {
      cancelled = true;
    };
  }, [form.question_id, answerChoiceKind]);

  const ratingChoices = useMemo(() => {
    if (answerChoiceKind !== "rating") return [];
    const min = Number(selectedQuestion?.rating_min);
    const max = Number(selectedQuestion?.rating_max);
    if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) return [];
    return Array.from({ length: max - min + 1 }, (_unused, index) => String(min + index));
  }, [answerChoiceKind, selectedQuestion]);

  // Follows the same CRUD structure used by survey_manage.jsx.
  // Expects: frontend/backend/api/survey_response.php
  //   GET    survey_response.php?page=&limit=&survey_id=&student_id=
  // (student_id is resolved from a provided student_number by calling student.php?search=...)
  //   POST   survey_response.php
  //   PUT    survey_response.php?id=...
  //   DELETE survey_response.php?id=...

  async function resolveSurveyTitleById(surveyId) {
    const id = String(surveyId || "").trim();
    if (!id) return "";
    const res = await fetch(getBackendUrl(`survey.php?id=${encodeURIComponent(id)}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to resolve survey title");
    return String(data?.data?.survey_title || "").trim();
  }

  async function resolveStudentIdByStudentNumber(studentNumber) {
    const q = String(studentNumber || "").trim();
    if (!q) return "";

    const params = new URLSearchParams();
    // student.php supports searching student_number
    params.set("page", "1");
    params.set("limit", "10");
    params.set("search", q);

    const res = await fetch(getBackendUrl(`student.php?${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to resolve student number");

    const list = Array.isArray(data.data) ? data.data : [];
    const exact = list.find((s) => String(s.student_number || "").trim() === q);
    const picked = exact || list[0];
    return picked?.student_id ? String(picked.student_id) : "";
  }

  async function fetchAllSurveyResponses(filters = {}) {
    const all = [];
    const pageSize = 200; // API hard-cap
    let currentPage = 1;
    let total = Number.POSITIVE_INFINITY;

    while (all.length < total) {
      const params = new URLSearchParams();
      params.set("page", String(currentPage));
      params.set("limit", String(pageSize));

      Object.entries(filters).forEach(([k, v]) => {
        const value = String(v ?? "").trim();
        if (value !== "") params.set(k, value);
      });

      const res = await fetch(getBackendUrl(`survey_response.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load survey responses");

      const list = Array.isArray(data.data) ? data.data : [];
      all.push(...list);

      const reportedTotal = Number(data?.pagination?.total);
      if (Number.isFinite(reportedTotal) && reportedTotal >= 0) {
        total = reportedTotal;
      } else {
        total = all.length;
      }

      if (list.length < pageSize) break;
      currentPage += 1;
    }

    return all;
  }

  function uniqueIds(rowsList, pickId, shouldInclude = () => true) {
    return rowsList
      .filter((row) => shouldInclude(row))
      .map((row) => pickId(row))
      .filter((id) => id != null && id !== "")
      .map((id) => String(id))
      .filter((id, idx, arr) => arr.indexOf(id) === idx);
  }

  async function fetchQuestionTextMap(questionIds) {
    const map = new Map();
    if (questionIds.length === 0) return map;

    await Promise.all(
      questionIds.map(async (id) => {
        try {
          const qr = await fetch(getBackendUrl(`survey_question.php?id=${encodeURIComponent(id)}`), {
            headers: { Accept: "application/json" },
            credentials: "include",
          });
          const qd = await qr.json();
          if (qr.ok && qd?.data) {
            map.set(String(id), String(qd.data.question_text || "").trim());
          }
        } catch {
          // ignore
        }
      })
    );

    return map;
  }

  async function fetchStudentNumberMap(studentIds) {
    const map = new Map();
    if (studentIds.length === 0) return map;

    await Promise.all(
      studentIds.map(async (id) => {
        try {
          const sr = await fetch(getBackendUrl(`student.php?id=${encodeURIComponent(id)}`), {
            headers: { Accept: "application/json" },
            credentials: "include",
          });
          const sd = await sr.json();
          if (sr.ok && sd?.data) {
            map.set(String(id), String(sd.data.student_number || "").trim());
          }
        } catch {
          // ignore
        }
      })
    );

    return map;
  }

  async function fetchSurveyTitleMap(surveyIds) {
    const map = new Map();
    if (surveyIds.length === 0) return map;

    await Promise.all(
      surveyIds.map(async (id) => {
        try {
          const title = await resolveSurveyTitleById(id);
          map.set(String(id), String(title || "").trim());
        } catch {
          // ignore
        }
      })
    );

    return map;
  }

  async function load() {
    setLoading(true);
    setError("");
    try {
      // Resolve filters for display
      let resolvedStudentId = "";
      if (appliedFilters.student_number) {
        resolvedStudentId = await resolveStudentIdByStudentNumber(appliedFilters.student_number);
        if (!resolvedStudentId) throw new Error("Student number not found");
      }

      if (appliedFilters.survey_id) {
        try {
          const title = await resolveSurveyTitleById(appliedFilters.survey_id);
          setSurveyTitleResolved(title);
        } catch {
          setSurveyTitleResolved("");
        }
      } else {
        setSurveyTitleResolved("");
      }

      const raw = await fetchAllSurveyResponses({
        survey_id: appliedFilters.survey_id,
        student_id: resolvedStudentId,
      });

      const questionIds = uniqueIds(raw, (r) => r.question_id);
      const qMap = await fetchQuestionTextMap(questionIds);

      // Resolve student numbers for display only when API rows do not already include them.
      const needsStudentLookup = raw.some((r) => {
        const hasStudentNumber = String(r.student_number || "").trim() !== "";
        const hasStudentId = r.student_id != null && r.student_id !== "";
        return !hasStudentNumber && hasStudentId;
      });
      const studentIds = needsStudentLookup
        ? uniqueIds(
            raw,
            (r) => r.student_id,
            (r) => String(r.student_number || "").trim() === ""
          )
        : [];
      const studentMap = await fetchStudentNumberMap(studentIds);

      // Resolve survey titles for display only when API rows do not already include them.
      const needsSurveyLookup = raw.some((r) => {
        const hasSurveyTitle = String(r.survey_title || "").trim() !== "";
        const hasSurveyId = r.survey_id != null && r.survey_id !== "";
        return !hasSurveyTitle && hasSurveyId;
      });
      const surveyIds = needsSurveyLookup
        ? uniqueIds(
            raw,
            (r) => r.survey_id,
            (r) => String(r.survey_title || "").trim() === ""
          )
        : [];
      const surveyMap = await fetchSurveyTitleMap(surveyIds);

      const hydrated = raw.map((r) => {
        const qId = String(r.question_id ?? "");
        const qText = qMap.has(qId) ? qMap.get(qId) : undefined;
        const sn = String(r.student_number || "").trim() || studentMap.get(String(r.student_id ?? "")) || "";
        const st = String(r.survey_title || "").trim() || surveyMap.get(String(r.survey_id ?? "")) || "";
        return {
          ...r,
          question_text: qText ?? r.question_text ?? "",
          survey_title: st,
          student_number: sn,
        };
      });

      setRows(hydrated);
    } catch (e) {
      setError(e.message || "Failed to load survey responses");
      setRows([]);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // load only after filters are applied
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedFilters]);

  useLiveRefresh(["survey_answers", "survey_submissions"], load);

  async function save() {
    setSaving(true);
    setError("");
    try {
      const isEdit = !!form.response_id;
      if (isEdit && !canEdit) throw new Error("You do not have permission to edit survey responses.");
      if (!isEdit && !canCreate) throw new Error("You do not have permission to create survey responses.");
      const url = getBackendUrl("survey_response.php" + (isEdit ? `?id=${form.response_id}` : ""));

      const payload = { ...form };
      if (payload.survey_id !== "" && payload.survey_id != null) payload.survey_id = Number(payload.survey_id);
      if (payload.question_id !== "" && payload.question_id != null) payload.question_id = Number(payload.question_id);
      if (payload.student_id !== "" && payload.student_id != null) payload.student_id = Number(payload.student_id);

      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save response");

      setIsModalOpen(false);
      setForm(defaultForm);
      // reset to first page after saving
      setPage(1);
      await load();
    } catch (e) {
      setError(e.message || "Failed to save response");
    } finally {
      setSaving(false);
    }
  }

  async function openStudentResponses(studentRow) {
    const sn = String(studentRow?.student_number || "").trim();
    let sid = String(studentRow?.student_id || "").trim();

    setStudentModal({
      open: true,
      studentNumber: sn || "-",
      surveyTitle: "All Surveys",
      rows: [],
      loading: true,
      error: "",
    });

    try {
      if (!sid && sn) sid = await resolveStudentIdByStudentNumber(sn);
      if (!sid) throw new Error("Student number not found");

      // Intentionally no survey filter here so popup always shows all surveys for the student.
      const raw2 = await fetchAllSurveyResponses({
        student_id: sid,
      });

      const missingQuestionIds = uniqueIds(
        raw2,
        (x) => x.question_id,
        (x) => String(x.question_text || "").trim() === ""
      );
      const qMap2 = await fetchQuestionTextMap(missingQuestionIds);

      const missingSurveyIds = uniqueIds(
        raw2,
        (x) => x.survey_id,
        (x) => String(x.survey_title || "").trim() === ""
      );
      const surveyMap2 = await fetchSurveyTitleMap(missingSurveyIds);

      const hydrated2 = raw2
        .map((x) => ({
          ...x,
          question_text: String(x.question_text || "").trim() || qMap2.get(String(x.question_id || "")) || "",
          survey_title:
            String(x.survey_title || "").trim() ||
            surveyMap2.get(String(x.survey_id || "")) ||
            (x.survey_id ? `Survey #${x.survey_id}` : ""),
        }))
        .sort((a, b) => {
          const da = String(a.date || "");
          const db = String(b.date || "");
          if (da !== db) return da < db ? 1 : -1;
          return String(a.survey_title || "").localeCompare(String(b.survey_title || ""));
        });

      setStudentModal((m) => ({ ...m, rows: hydrated2, loading: false, error: "" }));
    } catch (e) {
      setStudentModal((m) => ({ ...m, rows: [], loading: false, error: e.message || "Failed to load" }));
    }
  }

  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
        if (!nextPlanOnly) return true;
        const qt = String(r.question_text || "").toLowerCase();
        const hit = /(next\s*sem|next\s*semester|will\s*enroll|plan\s*to\s*enroll|enroll\s*next)/i.test(qt);
        if (!hit) return false;
        if (!nextPlanAnswer) return true;
        return String(r.answer || "").toLowerCase() === nextPlanAnswer.toLowerCase();
      });
  }, [rows, nextPlanOnly, nextPlanAnswer]);

  const visibleRows = useMemo(() => {
    const offset = (page - 1) * limit;
    return filteredRows.slice(offset, offset + limit);
  }, [filteredRows, page, limit]);

  useEffect(() => {
    const maxPage = Math.max(1, Math.ceil(filteredRows.length / limit) || 1);
    if (page > maxPage) setPage(maxPage);
  }, [filteredRows.length, limit, page]);

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Survey Response Management</h2>
      {/* One error on screen at a time. While the dialog is open it shows the
          failure itself, and this box sits behind the overlay saying the same
          sentence to nobody — so it stands down rather than duplicating it. */}
      <AlertMessage message={isModalOpen || studentModal.open ? "" : error} tone="error" />

      <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
        <SectionHeader sticky title="Survey Responses">
          <input
            value={surveyIdFilter}
            onChange={(e) => setSurveyIdFilter(e.target.value)}
            placeholder="Survey ID"
            style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, width: 102 }}
           name="survey_response_manage_input_518"/>

          <input
            value={studentNumberFilter}
            onChange={(e) => setStudentNumberFilter(e.target.value)}
            placeholder="Student Number"
            style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, width: 153 }}
           name="survey_response_manage_input_525"/>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: '#475569', fontSize: 11.5 }}>
            <input type="checkbox" checked={nextPlanOnly} onChange={(e)=> setNextPlanOnly(e.target.checked)}  name="survey_response_manage_input_533"/>
            Only "Next Semester Plan" question
          </label>
          <select value={nextPlanAnswer} onChange={(e)=> setNextPlanAnswer(e.target.value)} style={{ padding: '5px 6px', border: '1px solid #e2e8f0', borderRadius: 5 }} name="survey_response_manage_select_536">
            <option value=''>Any Answer</option>
            <option value='Yes'>Yes</option>
            <option value='No'>No</option>
          </select>

          <button
            onClick={() => {
              // Reset numbering & pagination when applying filters
              setPage(1);
              setAppliedFilters({ survey_id: String(surveyIdFilter || "").trim(), student_number: String(studentNumberFilter || "").trim() });
            }}
            style={{ background: "var(--info-500)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}
          >
            Apply
          </button>

          {/* Rows-per-page lives with the pager under the table, not here. */}
          {canCreate ? (
            <button
              onClick={() => {
                setForm(defaultForm);
                setIsModalOpen(true);
              }}
              style={{ background: "var(--brand-600)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}
            >
              + Add Response
            </button>
          ) : null}
        </SectionHeader>

        <div style={{ overflow: "auto", maxHeight: "calc(100vh - 221px)" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)", width: 51 }}>No.</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)", width: 136 }}>Student Number</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 187 }}>Survey</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 221 }}>Question</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 187 }}>Answer</th>
                <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)", width: 111 }}>Date</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <SkeletonTableRows columns={6} />
              ) : visibleRows.length === 0 ? (
                <tr>
                  <td colSpan={6} style={{ padding: 12, textAlign: "center", color: "var(--text-muted)" }}>
                    No responses found.
                  </td>
                </tr>
              ) : (
                visibleRows.map((r, idx) => (
                    <tr key={r.response_id ?? r.answer_id ?? `${r.submission_id}-${r.question_id}-${idx}`}>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", color: "var(--text-primary)", fontWeight: 600 }}>{(page - 1) * limit + idx + 1}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                        <button
                          onClick={() => openStudentResponses(r)}
                          style={{ background: "transparent", border: 0, padding: 0, margin: 0, cursor: "pointer", color: "var(--brand-600)", fontWeight: 600, textDecoration: "underline" }}
                          title="View all surveys for this student"
                        >
                          {r.student_number || "-"}
                        </button>
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "normal" }}>
                        {r.survey_title || (r.survey_id ? `Survey #${r.survey_id}` : "-")}
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "normal" }}>
                        {r.question_text || (r.question_id ? `Question #${r.question_id}` : "-")}
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "normal" }}>
                        {r.answer ?? "-"}
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.date || "-"}</td>
                    </tr>
                  ))
              )}
            </tbody>
          </table>
        </div>

        <div style={{ padding: 9, borderTop: "1px solid var(--border-base)", display: "grid", gap: 6 }}>
          {/* Which filters produced these rows. The range itself is the pager's
              job now, so this says only what the pager cannot. */}
          <div style={{ color: "var(--text-muted)", fontSize: 11.5, display: "flex", gap: 11, flexWrap: "wrap" }}>
            <span>
              Student: <strong style={{ color: "var(--text-primary)" }}>{appliedFilters.student_number || ""}</strong>
            </span>
            <span>
              Survey: <strong style={{ color: "var(--text-primary)" }}>{surveyTitleResolved || (appliedFilters.survey_id ? `Survey #${appliedFilters.survey_id}` : "")}</strong>
            </span>
          </div>
          <ManagementPagination
            page={page}
            limit={limit}
            total={filteredRows.length}
            onPageChange={setPage}
            onLimitChange={(size) => {
              setLimit(size);
              setPage(1);
            }}
            itemLabel="answers"
          />
        </div>
      </div>

      {studentModal.open && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1200, padding: 12 }}
          onClick={() => setStudentModal((m) => ({ ...m, open: false }))}
        >
          <div
            style={{ background: "#fff", borderRadius: 11, width: "calc(100vw - 20px)", height: "calc(100vh - 20px)", overflow: "auto", border: "1px solid var(--border-base)", boxShadow: "0 20px 40px rgba(2,6,23,0.18)", display: "flex", flexDirection: "column", maxWidth: "none", maxHeight: "none" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div style={{ display: "grid" }}>
                <strong style={{ color: "var(--text-primary)" }}>Student Responses</strong>
                <span style={{ color: "var(--text-muted)", fontSize: 11.5 }}>
                  Student Number: <strong style={{ color: "var(--text-primary)" }}>{studentModal.studentNumber || "-"}</strong>
                  {studentModal.surveyTitle ? (
                    <>
                      {" "} | Survey Scope: <strong style={{ color: "var(--text-primary)" }}>{studentModal.surveyTitle}</strong>
                    </>
                  ) : null}
                </span>
              </div>
              <button
                onClick={() => setStudentModal((m) => ({ ...m, open: false }))}
                style={{ background: "transparent", border: 0, fontSize: 16, cursor: "pointer", color: "var(--text-secondary)" }}
                aria-label="Close"
              >
                x
              </button>
            </div>

            <div style={{ padding: 12 }}>
              {studentModal.error && (
                <div style={{ background: "var(--danger-100)", color: "var(--danger-800)", padding: 8, borderRadius: 8, marginBottom: 9 }}>
                  {studentModal.error}
                </div>
              )}

              {studentModal.loading ? (
                <div style={{ padding: 9 }}><SkeletonText lines={4} /></div>
              ) : studentModal.rows.length === 0 ? (
                <div style={{ padding: 9, color: "var(--text-muted)" }}>No responses found.</div>
              ) : (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                      <th style={{ padding: 9, borderBottom: "1px solid var(--border-base)", width: 51 }}>#</th>
                      <th style={{ padding: 9, borderBottom: "1px solid var(--border-base)", minWidth: 187 }}>Survey Title</th>
                      <th style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>Question</th>
                      <th style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>Answer</th>
                      <th style={{ padding: 9, borderBottom: "1px solid var(--border-base)", width: 119 }}>Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {studentModal.rows.map((r, idx) => (
                      <tr key={`${r.response_id ?? idx}-${r.question_id ?? idx}`}>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", fontWeight: 700, color: "var(--text-primary)" }}>{idx + 1}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "normal" }}>{r.survey_title || (r.survey_id ? `Survey #${r.survey_id}` : "-")}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "normal" }}>{r.question_text || "(No question text)"}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "normal" }}>{r.answer ?? ""}</td>
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.date || "-"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {isModalOpen && (canCreate || canEdit) && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }}
          onClick={() => setIsModalOpen(false)}
        >
          <div
            style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 646, maxHeight: "85vh", overflow: "auto", border: "1px solid var(--border-base)", boxShadow: "0 12px 24px rgba(2,6,23,0.12)", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--text-primary)" }}>{form.response_id ? "Edit Response" : "Add Response"}</strong>
              <button onClick={() => setIsModalOpen(false)} style={{ background: "transparent", border: 0, fontSize: 16, cursor: "pointer", color: "var(--text-secondary)" }} aria-label="Close">
                x
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
              {choices.loading ? (
                <div style={{ fontSize: 11, color: "var(--text-muted)" }}>Loading surveys and students...</div>
              ) : null}
              {choices.error ? (
                <div style={{ fontSize: 11, color: "var(--danger-800)" }}>{choices.error}</div>
              ) : null}

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 8 }}>
                <div>
                  <label htmlFor="survey_response_survey" style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Survey</label>
                  <select
                    id="survey_response_survey"
                    name="survey_response_survey"
                    value={form.survey_id}
                    // Changing the survey clears the question: a question belongs
                    // to one survey, so keeping the old id would file the answer
                    // under a question this survey does not contain.
                    onChange={(e) => setForm((f) => ({ ...f, survey_id: e.target.value, question_id: "", answer: "" }))}
                    style={modalFieldStyle}
                  >
                    <option value="">Select a survey</option>
                    {choices.surveys.map((survey) => (
                      <option key={survey.survey_id} value={survey.survey_id}>
                        {survey.survey_title || `Survey #${survey.survey_id}`}
                        {survey.semester_name ? ` - ${survey.semester_name}` : ""}
                        {survey.date ? ` (${survey.date})` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="survey_response_question" style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Question</label>
                  <select
                    id="survey_response_question"
                    name="survey_response_question"
                    value={form.question_id}
                    onChange={(e) => setForm((f) => ({ ...f, question_id: e.target.value, answer: "" }))}
                    disabled={!form.survey_id}
                    title={form.survey_id ? undefined : "Choose a survey first"}
                    style={{ ...modalFieldStyle, cursor: form.survey_id ? "pointer" : "not-allowed" }}
                  >
                    <option value="">
                      {form.survey_id ? "Select a question" : "Choose a survey first"}
                    </option>
                    {questionChoices.map((question) => (
                      <option key={question.question_id} value={question.question_id}>
                        {question.question_text || `Question #${question.question_id}`}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))", gap: 8 }}>
                <div>
                  <label htmlFor="survey_response_student" style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Student</label>
                  <select
                    id="survey_response_student"
                    name="survey_response_student"
                    value={form.student_id}
                    onChange={(e) => setForm((f) => ({ ...f, student_id: e.target.value }))}
                    style={modalFieldStyle}
                  >
                    <option value="">Select a student</option>
                    {choices.students.map((student) => (
                      <option key={student.student_id} value={student.student_id}>
                        {studentLabel(student)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label htmlFor="survey_response_date" style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Date</label>
                  <input
                    id="survey_response_date"
                    name="survey_response_date"
                    type="date"
                    value={form.date || ""}
                    onChange={(e) => setForm((f) => ({ ...f, date: e.target.value }))}
                    style={modalFieldStyle}
                  />
                </div>
              </div>

              <div>
                <label htmlFor="survey_response_answer" style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>
                  Answer
                  {selectedQuestion ? (
                    <span style={{ color: "var(--text-muted)", fontWeight: 400 }}> ({selectedQuestion.question_type})</span>
                  ) : null}
                </label>

                {answerChoiceKind === "options" ? (
                  <select
                    id="survey_response_answer"
                    name="survey_response_answer"
                    value={form.answer}
                    onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
                    style={modalFieldStyle}
                  >
                    <option value="">Select an answer</option>
                    {optionChoices.map((option) => (
                      // The option's text, not its id: survey_answer stores the
                      // label for rows written by this app, and survey-summary
                      // groups on that label.
                      <option key={option.option_id} value={option.option_text}>
                        {option.option_text}
                      </option>
                    ))}
                  </select>
                ) : answerChoiceKind === "rating" ? (
                  <select
                    id="survey_response_answer"
                    name="survey_response_answer"
                    value={form.answer}
                    onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
                    style={modalFieldStyle}
                  >
                    <option value="">Select a rating</option>
                    {ratingChoices.map((rating) => (
                      <option key={rating} value={rating}>
                        {rating}
                      </option>
                    ))}
                  </select>
                ) : (
                  <textarea
                    id="survey_response_answer"
                    name="survey_response_answer"
                    value={form.answer}
                    onChange={(e) => setForm((f) => ({ ...f, answer: e.target.value }))}
                    style={{ ...modalFieldStyle, minHeight: 77 }}
                    placeholder={selectedQuestion ? "Enter answer" : "Choose a question first"}
                  />
                )}
              </div>
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
