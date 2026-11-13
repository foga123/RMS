import React, { useEffect, useState } from "react";
import AlertMessage from "../../shared/components/ui/AlertMessage";
import ActionMenu from "../../shared/components/ui/ActionMenu";
import { SkeletonTableRows } from "../../shared/components/ui/Skeleton";
import { ManagementPagination } from "../../shared/components/management";
import { confirmAction } from "../../shared/lib/notify";
import { hasModulePermission } from "../../shared/lib/roleAccess";
import useLatestRequest from "../../shared/hooks/useLatestRequest";
import useLiveRefresh from "../../shared/hooks/useLiveRefresh";
import { getBackendUrl } from "../../shared/lib/url";
import {
  ANSWER_FORMATS,
  answerMaxLength,
  editorTypeOf,
  normalizeAnswerFormat,
  questionTypeOptions,
  selectableAnswerFormatKeys,
  storedTypeFor,
} from "./answerFormats";
import { describeBranching } from "./surveyBranching";
import { prepareOptionPayload } from "./surveyOptions";
import SurveyFolderShelf, { SurveyFolderHeader } from "./SurveyFolderShelf";
import { surveyTextCounter, surveyTextLimit } from "./textLimits";
import SectionHeader from "../../shared/components/ui/SectionHeader";

/**
 * "247 / 300", shown only in the last fifth of the allowance.
 *
 * The same restraint StudentSurveyPage uses on answers: a counter that is
 * always visible is a warning about text that is fine, and gets tuned out
 * before it ever means anything.
 */
function TextCounter({ field, value }) {
  const counter = surveyTextCounter(field, value);
  if (!counter) return null;
  return (
    <div
      style={{
        marginTop: 3,
        textAlign: "right",
        fontSize: 10.5,
        color: counter.over ? "var(--danger-800)" : "var(--text-muted)",
      }}
    >
      {counter.length} / {counter.limit}
    </div>
  );
}


const OPTION_TYPES = new Set(["radio", "checkbox"]);
let optionDraftSeq = 0;

function isOptionType(value) {
  return OPTION_TYPES.has(String(value || "").trim().toLowerCase());
}

function createOptionDraft(optionText = "") {
  optionDraftSeq += 1;
  return {
    option_id: "",
    option_text: String(optionText),
    enrollment_status_id: "",
    _draft_key: `new_${optionDraftSeq}`,
  };
}

function normalizeOptionRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => ({
    option_id: Number(r?.option_id || 0) || "",
    option_text: String(r?.option_text ?? ""),
    // "" is the no-mapping state, so the <select> stays a controlled component.
    enrollment_status_id: Number(r?.enrollment_status_id || 0) || "",
    _draft_key: `opt_${r?.option_id || Math.random().toString(36).slice(2)}`,
  }));
}

function toIntOrNull(value) {
  if (value === "" || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeSortOrderForForm(value) {
  const n = toIntOrNull(value);
  if (n == null) return "";
  return String(Math.trunc(n));
}

function parseSortOrderForPayload(value) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  if (!/^\d+$/.test(raw)) return NaN;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : NaN;
}

function sortQuestionRows(rows) {
  const list = Array.isArray(rows) ? [...rows] : [];
  list.sort((a, b) => {
    const aSort = toIntOrNull(a?.sort_order);
    const bSort = toIntOrNull(b?.sort_order);
    if (aSort != null && bSort != null && aSort !== bSort) return aSort - bSort;
    if (aSort != null && bSort == null) return -1;
    if (aSort == null && bSort != null) return 1;
    return Number(a?.question_id || 0) - Number(b?.question_id || 0);
  });
  return list;
}

function createDefaultForm() {
  return {
    question_id: "",
    survey_id: "",
    question_text: "",
    question_type: "text", // text | radio | checkbox | rating
    // What a typed answer has to look like. "any" is the default and what every
    // text question accepted before this existed.
    answer_format: "any",
    // How many characters a text answer may hold. Blank means "use the format's
    // own default"; a number caps it tighter than that. Held as a string so the
    // field can be empty, and only sent for text questions.
    answer_max_length: "",
    is_required: 0,
    sort_order: "",
    status: 1,
    options: [],
    // Option ids that reveal this question. Empty means always shown, which is
    // how every question behaved before branching existed.
    show_when_option_ids: [],
  };
}

/**
 * Survey questions, one survey at a time.
 *
 * `initialSurvey` is how the workspace hands off from Surveys: creating a
 * survey and then having to find it again in a list is the seam this closes.
 */
export default function SurveyQuestionManage({
  permissions = [],
  initialSurvey = null,
  onOpenSubmissions = null,
  /*
   * Whether this account may rename the survey whose folder is open.
   *
   * A separate flag rather than something derived from `permissions`, because
   * the survey's title belongs to the `survey` module and everything else on
   * this screen belongs to `survey_questions`. They are granted separately -
   * Secretary is deliberately given one and not the other - so reading the
   * question editor's permission here would rename surveys for an account that
   * was never given surveys. The workspace passes the same rule the Surveys tab
   * applies to its own Edit button, and survey.php enforces it regardless.
   */
  canEditSurvey = false,
}) {
  const beginRequest = useLatestRequest();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(20);
  const [total, setTotal] = useState(0);

  const [search, setSearch] = useState("");

  /*
   * ---- the shelf --------------------------------------------------------
   *
   * Same shape as Survey Submissions: which survey, then what is in it. A
   * question only means anything inside the form it belongs to, so a page of
   * questions from four different surveys was never a list anybody wanted.
   *
   * `openSurvey` is the mode switch, and it is also the survey filter - there
   * is no separate dropdown for it any more, and no way to be looking at this
   * table without one open.
   */
  const [folders, setFolders] = useState([]);
  const [foldersLoading, setFoldersLoading] = useState(true);
  const [folderSearch, setFolderSearch] = useState("");
  const [openSurvey, setOpenSurvey] = useState(initialSurvey);

  const [form, setForm] = useState(() => createDefaultForm());
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [surveys, setSurveys] = useState([]);
  const [enrollmentStatuses, setEnrollmentStatuses] = useState([]);
  const [optionsLoading, setOptionsLoading] = useState(false);
  // The choice questions in this survey whose answers can gate the one being
  // edited, each with its options. Loaded per survey, not per page, because the
  // list filter may be showing a different survey entirely.
  const [branchSources, setBranchSources] = useState([]);
  const [branchLoading, setBranchLoading] = useState(false);
  const [supports, setSupports] = useState({
    sort_order: true,
    is_required: true,
    status: true,
    answer_format: true,
  });
  const canCreate = hasModulePermission(permissions, "create");
  const canEdit = hasModulePermission(permissions, "edit");
  const canDelete = hasModulePermission(permissions, "delete");
  const showActionColumn = canEdit || canDelete;
  const columnCount = showActionColumn ? 6 : 5;

  /**
   * The shelf.
   *
   * Counted by the endpoint, not here: the question list is paged, so a count
   * taken from the current page would be a count of the page. A survey with 11
   * questions showing "8" because the other three were on page two is the bug
   * this avoids.
   */
  async function loadFolders() {
    setFoldersLoading(true);
    setError("");
    try {
      const res = await fetch(getBackendUrl("survey_question.php?group_by=survey"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load surveys");
      setFolders(Array.isArray(data.data) ? data.data : []);
    } catch (e) {
      setFolders([]);
      setError(e.message || "Failed to load surveys");
    } finally {
      setFoldersLoading(false);
    }
  }

  /**
   * Rename the open survey without leaving its questions.
   *
   * A partial PUT: survey.php applies only the fields present in the body, so
   * this touches the title and leaves the semester, date and status alone. The
   * three local copies of the name are corrected in place rather than by
   * reloading - the shelf behind this folder, the dropdown in the question
   * dialog, and the header itself all show it.
   */
  async function renameOpenSurvey(nextTitle) {
    const surveyId = Number(openSurvey?.survey_id || 0);
    if (!surveyId) return;
    setError("");

    const res = await fetch(getBackendUrl(`survey.php?id=${surveyId}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ survey_title: nextTitle }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = data?.message || "Failed to rename survey";
      setError(message);
      // Rethrown so the header keeps the field open on what was typed.
      throw new Error(message);
    }

    const saved = String(data?.data?.survey_title ?? nextTitle);
    setOpenSurvey((current) => (current ? { ...current, survey_title: saved } : current));
    setFolders((current) =>
      current.map((folder) =>
        Number(folder.survey_id) === surveyId ? { ...folder, survey_title: saved } : folder
      )
    );
    setSurveys((current) =>
      current.map((survey) =>
        Number(survey.survey_id) === surveyId ? { ...survey, survey_title: saved } : survey
      )
    );
  }

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
      // The open folder is the survey filter.
      if (openSurvey?.survey_id) params.set("survey_id", String(openSurvey.survey_id));

      const res = await fetch(getBackendUrl(`survey_question.php?${params.toString()}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to load survey questions");

      if (!isCurrent()) return;

      const rows = Array.isArray(data.data) ? data.data : [];
      setRows(sortQuestionRows(rows));
      setTotal(Number(data?.pagination?.total || 0));
      if (data && typeof data.supports === "object") {
        setSupports({
          sort_order: data.supports.sort_order !== false,
          is_required: data.supports.is_required !== false,
          status: data.supports.status !== false,
          answer_format: data.supports.answer_format !== false,
        });
      }
    } catch (e) {
      if (!isCurrent()) return;
      setError(e.message || "Failed to load survey questions");
    } finally {
      if (isCurrent()) setLoading(false);
    }
  }

  async function loadSurveys() {
    try {
      const res = await fetch(getBackendUrl("survey.php?limit=1000"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      setSurveys(arr);
    } catch (_) {
      // ignore
    }
  }

  /**
   * Enrollment statuses, for the per-option mapping.
   *
   * Filtered to `status_type=enrollment` because `status` is a shared lookup
   * that also holds account, finance, attendance and semester rows — offering
   * "3k Above" as an enrolment outcome would be nonsense, and the API rejects
   * it anyway.
   */
  async function loadEnrollmentStatuses() {
    try {
      const res = await fetch(getBackendUrl("status.php?status_type=enrollment&limit=200"), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      const data = await res.json();
      const arr = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
      setEnrollmentStatuses(arr.filter((row) => !row?.archived_at));
    } catch (_) {
      // Non-fatal: the dropdown falls back to "no mapping" only.
    }
  }

  function closeModal() {
    setIsModalOpen(false);
    setOptionsLoading(false);
    setForm(createDefaultForm());
  }

  async function loadQuestionOptions(questionId) {
    const params = new URLSearchParams();
    params.set("question_id", String(questionId));
    params.set("limit", "500");

    const res = await fetch(getBackendUrl(`survey_question_option.php?${params.toString()}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || "Failed to load question options");
    return Array.isArray(data?.data) ? data.data : [];
  }

  async function openCreateModal() {
    setError("");
    setOptionsLoading(false);
    // Pre-set to the folder that is open. Asking which survey, inside that
    // survey's own screen, is a question the page can already answer.
    setForm({ ...createDefaultForm(), survey_id: openSurvey?.survey_id ?? "" });
    setIsModalOpen(true);
  }

  async function openEditModal(row) {
    setError("");
    const questionType = String(row?.question_type || "text").trim().toLowerCase();
    const nextForm = {
      ...createDefaultForm(),
      ...row,
      question_type: questionType,
      answer_format: questionType === "text" ? normalizeAnswerFormat(row?.answer_format) : "any",
      // Back to a form-friendly string: a stored positive number shows in the
      // box, anything else (null, 0, non-text) shows as blank = "use default".
      answer_max_length:
        questionType === "text" && Number(row?.answer_max_length) > 0
          ? String(Number(row?.answer_max_length))
          : "",
      sort_order: normalizeSortOrderForForm(row?.sort_order),
      options: [],
    };
    setForm(nextForm);
    setIsModalOpen(true);

    if (!isOptionType(questionType)) {
      setOptionsLoading(false);
      return;
    }

    setOptionsLoading(true);
    try {
      const options = await loadQuestionOptions(row.question_id);
      const normalized = normalizeOptionRows(options);
      setForm((f) => {
        if (Number(f.question_id || 0) !== Number(row.question_id || 0)) return f;
        return { ...f, options: normalized.length ? normalized : [createOptionDraft(""), createOptionDraft("")] };
      });
    } catch (e) {
      setError(e.message || "Failed to load question options");
      setForm((f) => {
        if (Number(f.question_id || 0) !== Number(row.question_id || 0)) return f;
        return { ...f, options: [createOptionDraft(""), createOptionDraft("")] };
      });
    } finally {
      setOptionsLoading(false);
    }
  }

  function addOptionDraft() {
    setForm((f) => ({ ...f, options: [...(Array.isArray(f.options) ? f.options : []), createOptionDraft("")] }));
  }

  function updateOptionDraft(draftKey, optionText) {
    setForm((f) => ({
      ...f,
      options: (Array.isArray(f.options) ? f.options : []).map((opt) =>
        opt._draft_key === draftKey ? { ...opt, option_text: optionText } : opt
      ),
    }));
  }

  function updateOptionStatus(draftKey, statusId) {
    setForm((f) => ({
      ...f,
      options: (Array.isArray(f.options) ? f.options : []).map((opt) =>
        opt._draft_key === draftKey ? { ...opt, enrollment_status_id: statusId } : opt
      ),
    }));
  }

  function removeOptionDraft(draftKey) {
    setForm((f) => ({
      ...f,
      options: (Array.isArray(f.options) ? f.options : []).filter((opt) => opt._draft_key !== draftKey),
    }));
  }

  /*
   * The question's whole list of choices, saved in one request.
   *
   * It used to be one request per choice - update, add, then delete. Now that
   * choices are unique, that order broke ordinary edits (swapping "Yes" and
   * "No" collided on the first update; removing "Yes" and adding it back
   * collided on the add) and a failure halfway left half a list saved. The
   * server applies the list in one transaction; see survey_options_replace()
   * in survey_question_option.php.
   */
  async function syncQuestionOptions(questionId, optionRows) {
    const res = await fetch(getBackendUrl(`survey_question_option.php?question_id=${encodeURIComponent(questionId)}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ options: prepareOptionPayload(optionRows) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || "Failed to save the answer choices");
  }

  useEffect(() => {
    if (openSurvey) load();
    else loadFolders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, limit, search, openSurvey]);

  useLiveRefresh(["survey_questions"], () => {
    if (openSurvey) load();
    else loadFolders();
  });

  /** Open one survey's questions, from a clean slate rather than the last search. */
  function openFolder(folder) {
    setOpenSurvey(folder);
    setPage(1);
    setSearch("");
    setError("");
  }

  /**
   * Back to the shelf. The effect recounts it on the way out, because adding or
   * removing a question has just changed the number written on the folder.
   */
  function closeFolder() {
    setOpenSurvey(null);
    setPage(1);
    setError("");
  }

  useEffect(() => {
    loadSurveys();
    loadEnrollmentStatuses();
  }, []);

  /**
   * Load the answers that could gate this question.
   *
   * Only radio and checkbox questions have options to branch on, and a question
   * cannot be gated by its own answer — it would have to be visible to be
   * answered. Both are filtered out here; the endpoint enforces the same rules,
   * so a stale form cannot save a condition the server would consider invalid.
   */
  useEffect(() => {
    const surveyId = Number(form.survey_id || 0);
    if (!isModalOpen || !surveyId) {
      setBranchSources([]);
      return undefined;
    }

    let cancelled = false;
    setBranchLoading(true);

    (async () => {
      try {
        const res = await fetch(getBackendUrl(`survey_question.php?survey_id=${surveyId}&limit=200`), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.message || "Failed to load questions");

        const candidates = (json?.data || []).filter(
          (q) => isOptionType(String(q?.question_type || "").toLowerCase())
            && Number(q?.question_id) !== Number(form.question_id || 0)
        );

        const withOptions = await Promise.all(
          candidates.map(async (q) => ({
            question_id: Number(q.question_id),
            question_text: q.question_text || "(untitled)",
            sort_order: q.sort_order,
            options: await loadQuestionOptions(q.question_id).catch(() => []),
          }))
        );

        if (!cancelled) setBranchSources(withOptions.filter((q) => q.options.length > 0));
      } catch {
        if (!cancelled) setBranchSources([]);
      } finally {
        if (!cancelled) setBranchLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isModalOpen, form.survey_id, form.question_id]);

  function toggleBranchOption(optionId) {
    setForm((f) => {
      const current = Array.isArray(f.show_when_option_ids) ? f.show_when_option_ids.map(Number) : [];
      const id = Number(optionId);
      return {
        ...f,
        show_when_option_ids: current.includes(id)
          ? current.filter((x) => x !== id)
          : [...current, id],
      };
    });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      const isEdit = !!form.question_id;
      if (isEdit && !canEdit) throw new Error("You do not have permission to edit survey questions.");
      if (!isEdit && !canCreate) throw new Error("You do not have permission to create survey questions.");
      const url = getBackendUrl("survey_question.php" + (isEdit ? `?id=${form.question_id}` : ""));
      const questionText = String(form.question_text || "").trim();
      const questionType = String(form.question_type || "").trim().toLowerCase();
      const surveyId = form.survey_id !== "" && form.survey_id != null ? Number(form.survey_id) : 0;
      if (!surveyId) throw new Error("Survey is required");
      if (!questionText) throw new Error("Question text is required");
      if (!["text", "radio", "checkbox", "rating"].includes(questionType)) {
        throw new Error("Question type must be text, radio, checkbox, or rating");
      }
      const normalizedOptions = prepareOptionPayload(form.options);
      if (isOptionType(questionType) && normalizedOptions.length === 0) {
        throw new Error("At least one option is required for radio/checkbox questions");
      }

      const payload = { ...form };
      delete payload.options;
      payload.survey_id = surveyId;
      payload.question_text = questionText;
      payload.question_type = questionType;
      if (supports.answer_format) {
        payload.answer_format = questionType === "text" ? normalizeAnswerFormat(payload.answer_format) : "any";
      } else {
        delete payload.answer_format;
      }
      if (supports.answer_max_length) {
        const rawLimit = String(payload.answer_max_length ?? "").trim();
        if (questionType !== "text" || rawLimit === "") {
          // Only a text answer carries a limit, and a blank box means "use the
          // format default" - null tells the server to clear any stored one.
          payload.answer_max_length = null;
        } else {
          const parsedLimit = Number(rawLimit);
          if (!Number.isInteger(parsedLimit) || parsedLimit < 1) {
            throw new Error("Character limit must be a whole number of 1 or more.");
          }
          const ceiling = answerMaxLength(normalizeAnswerFormat(payload.answer_format));
          if (parsedLimit > ceiling) {
            throw new Error(`Character limit for this answer type can be at most ${ceiling}.`);
          }
          payload.answer_max_length = parsedLimit;
        }
      } else {
        delete payload.answer_max_length;
      }
      if (supports.is_required) {
        if (payload.is_required !== "" && payload.is_required != null) payload.is_required = Number(payload.is_required);
      } else {
        delete payload.is_required;
      }
      if (supports.sort_order) {
        const parsedSortOrder = parseSortOrderForPayload(payload.sort_order);
        if (Number.isNaN(parsedSortOrder)) {
          throw new Error("Sort order must be a non-negative whole number");
        }
        payload.sort_order = parsedSortOrder;
      } else {
        delete payload.sort_order;
      }
      if (!isEdit && supports.status) {
        if (payload.status !== "" && payload.status != null) payload.status = Number(payload.status);
      } else {
        delete payload.status;
      }

      const res = await fetch(url, {
        method: isEdit ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to save survey question");

      const savedQuestionId = Number(data?.data?.question_id || form.question_id || 0);
      if (!savedQuestionId) throw new Error("Question saved but question_id is missing");

      if (isOptionType(questionType)) {
        await syncQuestionOptions(savedQuestionId, normalizedOptions);
      } else if (isEdit) {
        await syncQuestionOptions(savedQuestionId, []);
      }

      closeModal();
      await load();
    } catch (e) {
      setError(e.message || "Failed to save survey question");
    } finally {
      setSaving(false);
    }
  }

  async function remove(id) {
    if (!canDelete) {
      setError("You do not have permission to delete survey questions.");
      return;
    }
    const confirmed = await confirmAction({
      title: "Remove question?",
      text: "Remove this question?",
      confirmButtonText: "Remove",
    });
    if (!confirmed) return;
    setError("");
    try {
      const res = await fetch(getBackendUrl(`survey_question.php?id=${id}`), {
        method: "DELETE",
        credentials: "include",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || "Failed to delete question");
      await load();
    } catch (e) {
      setError(e.message || "Failed to delete question");
    }
  }

  return (
    <section>
      <h2 style={{ margin: 0, marginBottom: 9, color: "var(--brand-800)" }}>Survey Question Management</h2>
      {/* One error on screen at a time. While the dialog is open it shows the
          failure itself, and this box sits behind the overlay saying the same
          sentence to nobody — so it stands down rather than duplicating it. */}
      <AlertMessage message={isModalOpen ? "" : error} tone="error" />

      {!openSurvey ? (
        /* ---------------------------------------------------------- the shelf
           Surveys as folders. The number on a folder is what it asks, not who
           answered it - that is the Submissions shelf, and the two are kept
           deliberately parallel so the same gesture means the same thing. */
        <SurveyFolderShelf
          hint={
            foldersLoading
              ? "Loading surveys..."
              : "Open a folder to see and edit the questions it asks."
          }
          folders={folders}
          loading={foldersLoading}
          search={folderSearch}
          onSearchChange={setFolderSearch}
          onOpen={openFolder}
          primary={(folder) => ({ value: folder.question_count, noun: "question" })}
          caption={(folder) => {
            const answered = Number(folder.submission_count || 0);
            if (Number(folder.question_count || 0) === 0) return "Empty — add the first question";
            return answered > 0
              ? `${answered} student${answered === 1 ? " has" : "s have"} answered`
              : "Not answered yet";
          }}
        />
      ) : (
        /* ------------------------------------------------------ inside a folder
           One survey's questions, in the order the student meets them. */
        <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 9, overflow: "hidden" }}>
          <SurveyFolderHeader
            survey={openSurvey}
            onBack={closeFolder}
            onRename={canEditSurvey ? renameOpenSurvey : null}
            subtitle={
              loading
                ? "Loading..."
                : `${total} question${total === 1 ? "" : "s"}${
                    Number(openSurvey.submission_count || 0) > 0
                      ? ` · ${openSurvey.submission_count} student${Number(openSurvey.submission_count) === 1 ? " has" : "s have"} already answered`
                      : ""
                  }`
            }
          />

          {/* The warning that matters on this screen: editing a question that
              has already been answered changes what the stored answers were
              answers to. It is allowed - some of these are typos - but it
              should not be a surprise. */}
          {Number(openSurvey.submission_count || 0) > 0 ? (
            <div style={{ margin: "9px 9px 0", padding: "6px 9px", borderRadius: 6, background: "var(--warning-100, var(--surface-page))", color: "var(--warning-800, var(--text-secondary))", fontSize: 11 }}>
              This survey already has answers. Editing or removing a question here does not change what students already submitted.
            </div>
          ) : null}

          <SectionHeader sticky style={{ flexWrap: "wrap" }} title="Questions">
            <input
              value={search}
              onChange={(e) => {
                setPage(1);
                setSearch(e.target.value);
              }}
              placeholder="Search question..."
              aria-label="Search questions in this survey"
              style={{ padding: "5px 6px", border: "1px solid var(--border-base)", borderRadius: 5, minWidth: 204 }}
              name="survey_question_manage_input_192"
            />

            {/* Rows-per-page lives with the pager under the table, not here. */}
            {onOpenSubmissions && Number(openSurvey.submission_count || 0) > 0 ? (
              <button
                onClick={() => onOpenSubmissions(openSurvey)}
                style={{ background: "transparent", color: "var(--brand-800)", border: "1px solid var(--border-base)", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}
              >
                View answers
              </button>
            ) : null}

            {canCreate ? (
              <button
                onClick={openCreateModal}
                style={{ background: "var(--brand-600)", color: "#fff", border: "none", padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}
              >
                + Add Question
              </button>
            ) : null}
          </SectionHeader>

          <div style={{ overflow: "auto", maxHeight: "calc(100vh - 262px)" }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr style={{ background: "var(--surface-page)", color: "var(--text-secondary)", textAlign: "left" }}>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>No.</th>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Question</th>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Type</th>
                  <th style={{ position: "sticky", top: 0, background: "var(--surface-page)", zIndex: 2, padding: 9, borderBottom: "1px solid var(--border-base)" }}>Required</th>
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
                    <td colSpan={columnCount} style={{ padding: 14, textAlign: "center", color: "var(--text-muted)" }}>
                      {search.trim()
                        ? "No question in this survey matches that search."
                        : "This survey has no questions yet."}
                    </td>
                  </tr>
                ) : (
                  rows.map((r, idx) => (
                    <tr key={r.question_id}>
                      {/* Numbered within the survey, so the figure matches the
                          question's place in the form the student sees. */}
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", fontVariantNumeric: "tabular-nums" }}>
                        {(page - 1) * limit + idx + 1}
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{r.question_text ?? r.question ?? ""}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>
                        {r.question_type ?? ""}
                        {/* The format is part of what the question asks for, so
                            it belongs next to the type rather than only inside
                            the edit dialog. */}
                        {String(r.question_type || "").toLowerCase() === "text"
                          && normalizeAnswerFormat(r.answer_format) !== "any" ? (
                          <span style={{ marginLeft: 5, fontSize: 10.5, color: "var(--text-muted)" }}>
                            · {ANSWER_FORMATS[normalizeAnswerFormat(r.answer_format)].label}
                          </span>
                        ) : null}
                        {/* The custom cap, when the author set one - the format
                            label alone would not show that "any" was narrowed. */}
                        {String(r.question_type || "").toLowerCase() === "text"
                          && Number(r.answer_max_length) > 0 ? (
                          <span style={{ marginLeft: 5, fontSize: 10.5, color: "var(--text-muted)" }}>
                            · max {Number(r.answer_max_length)}
                          </span>
                        ) : null}
                      </td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{Number(r.is_required) === 1 ? "Yes" : "No"}</td>
                      <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)" }}>{String(r.status ?? "")}</td>
                      {showActionColumn ? (
                        <td style={{ padding: 9, borderBottom: "1px solid var(--border-base)", whiteSpace: "nowrap" }}>
                          {/* One kebab, matching every other management table. */}
                          <ActionMenu
                            label="Actions for this question"
                            items={[
                              ...(canEdit
                                ? [{ key: "edit", label: "Edit", icon: "edit", onSelect: () => openEditModal(r) }]
                                : []),
                              ...(canDelete
                                ? [{ key: "remove", label: "Remove", icon: "delete", tone: "danger", onSelect: () => remove(r.question_id) }]
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
              itemLabel="questions"
            />
          </div>
        </div>
      )}


      {isModalOpen && (canCreate || canEdit) && (
        <div
          role="dialog"
          aria-modal="true"
          style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000, padding: 12 }}
          onClick={closeModal}
        >
          <div
            style={{ background: "#fff", borderRadius: 9, width: "100%", maxWidth: 612, maxHeight: "85vh", overflow: "auto", border: "1px solid var(--border-base)", boxShadow: "0 12px 24px rgba(2,6,23,0.12)", display: "flex", flexDirection: "column" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: 12, borderBottom: "1px solid var(--border-base)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <strong style={{ color: "var(--text-primary)" }}>{form.question_id ? "Edit Question" : "Add Question"}</strong>
              <button onClick={closeModal} style={{ background: "transparent", border: 0, fontSize: 16, cursor: "pointer", color: "var(--text-secondary)" }} aria-label="Close">
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
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Survey</label>
                <select
                  value={String(form.survey_id)}
                  onChange={(e) => setForm((f) => ({ ...f, survey_id: e.target.value === "" ? "" : Number(e.target.value) }))}
                  style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                 name="survey_question_manage_select_346">
                  <option value="">Select a survey</option>
                  {surveys.map((s) => (
                    <option key={s.survey_id} value={s.survey_id}>
                      {s.survey_title || `Survey #${s.survey_id}`}
                      {s.semester_name ? ` - ${s.semester_name}` : ""}
                      {s.date ? ` (${s.date})` : ""}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Question</label>
                <textarea
                  value={form.question_text}
                  onChange={(e) => setForm((f) => ({ ...f, question_text: e.target.value }))}
                  maxLength={surveyTextLimit("question_text")}
                  style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5, minHeight: 77 }}
                  placeholder="Enter question"
                 name="survey_question_manage_textarea_362"/>
                <TextCounter field="question_text" value={form.question_text} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: supports.is_required ? "1fr 1fr" : "1fr", gap: 8 }}>
                <div>
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Type</label>
                  <select
                    /* One flat list. Address is stored as a text question with an
                       address format, but an author looking to ask for an address
                       looks HERE - not inside the Text type's "Accepted answer"
                       dropdown, which is where it used to be and where nobody
                       found it. storedTypeFor() does the translation. */
                    value={editorTypeOf(form.question_type, form.answer_format)}
                    onChange={(e) => {
                      const picked = String(e.target.value || "").trim().toLowerCase();
                      const stored = storedTypeFor(picked);
                      setForm((f) => {
                        if (isOptionType(stored.question_type)) {
                          const existing = Array.isArray(f.options) ? f.options : [];
                          return {
                            ...f,
                            ...stored,
                            options: existing.length ? existing : [createOptionDraft(""), createOptionDraft("")],
                          };
                        }
                        return { ...f, ...stored, options: [] };
                      });
                    }}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                   name="survey_question_manage_select_373">
                    {questionTypeOptions().map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                  {/* What the chosen type actually does. The list used to name
                      HTML controls -- "Radio", "Checkbox" -- and an author had
                      to know the jargon to pick right. */}
                  {(() => {
                    const picked = questionTypeOptions().find(
                      (o) => o.value === editorTypeOf(form.question_type, form.answer_format)
                    );
                    return picked?.hint ? (
                      <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 3 }}>
                        {picked.hint}
                      </div>
                    ) : null;
                  })()}
                </div>

                {supports.is_required && (
                  <div>
                    <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Required</label>
                    <select
                      value={String(form.is_required)}
                      onChange={(e) => setForm((f) => ({ ...f, is_required: Number(e.target.value) }))}
                      style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                     name="survey_question_manage_select_387">
                      <option value="1">Yes</option>
                      <option value="0">No</option>
                    </select>
                  </div>
                )}
              </div>

              {/* ---- answer format --------------------------------------------
                  Only for a plain text question: every other type answers itself
                  from the option list below, and a composed type (Address) IS its
                  own format — offering the dropdown there would let the author
                  set the same thing in two controls and watch them disagree. */}
              {editorTypeOf(form.question_type, form.answer_format) === "text" && supports.answer_format && (
                <div>
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>
                    Accepted answer
                  </label>
                  <select
                    value={normalizeAnswerFormat(form.answer_format)}
                    onChange={(e) => setForm((f) => ({ ...f, answer_format: normalizeAnswerFormat(e.target.value) }))}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                    name="survey_question_manage_select_answer_format"
                  >
                    {selectableAnswerFormatKeys().map((key) => (
                      <option key={key} value={key}>
                        {ANSWER_FORMATS[key].label}
                      </option>
                    ))}
                  </select>
                  <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                    {ANSWER_FORMATS[normalizeAnswerFormat(form.answer_format)].hint
                      || "Anything is accepted. Pick a stricter format for a name or a contact number."}
                  </div>
                </div>
              )}

              {/* ---- character limit ------------------------------------------
                  How many characters this text answer may hold. Blank keeps the
                  format's own default; a number caps it tighter — e.g. 25 for a
                  student number. Only a text answer has a length to cap, so this
                  follows the same "text only" gate as the format above. */}
              {editorTypeOf(form.question_type, form.answer_format) === "text" && supports.answer_max_length && (
                <div>
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>
                    Character limit (optional)
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={answerMaxLength(normalizeAnswerFormat(form.answer_format))}
                    step={1}
                    value={form.answer_max_length ?? ""}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, answer_max_length: e.target.value.replace(/[^\d]/g, "") }))
                    }
                    placeholder={`Default ${answerMaxLength(normalizeAnswerFormat(form.answer_format))}`}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                    name="survey_question_manage_input_answer_max_length"
                  />
                  <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                    Leave blank for the default of {answerMaxLength(normalizeAnswerFormat(form.answer_format))}{" "}
                    characters. Set a smaller number to cap this answer tighter — e.g. 25.
                  </div>
                </div>
              )}

              {isOptionType(form.question_type) && (
                <div style={{ border: "1px solid var(--border-base)", borderRadius: 6, padding: 9, display: "grid", gap: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 6, flexWrap: "wrap" }}>
                    <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)" }}>Question Options</label>
                    <button
                      type="button"
                      onClick={addOptionDraft}
                      disabled={optionsLoading}
                      style={{ background: "var(--info-500)", color: "#fff", border: "none", padding: "5px 8px", borderRadius: 5, cursor: optionsLoading ? "not-allowed" : "pointer" }}
                    >
                      + Add Option
                    </button>
                  </div>

                  {optionsLoading ? (
                    <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>Loading options...</div>
                  ) : (Array.isArray(form.options) ? form.options : []).length === 0 ? (
                    <div style={{ color: "var(--text-muted)", fontSize: 11.5 }}>No options yet. Add at least one option.</div>
                  ) : (
                    (Array.isArray(form.options) ? form.options : []).map((opt, idx) => (
                      <div key={opt._draft_key || `opt_${idx}`} style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 153px) auto", gap: 6, alignItems: "center" }}>
                        <input
                          value={opt.option_text}
                          onChange={(e) => updateOptionDraft(opt._draft_key, e.target.value)}
                          maxLength={surveyTextLimit("option_text")}
                          style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                          placeholder={`Option ${idx + 1}`}
                         name={`survey_question_manage_input_option_${idx}`}/>
                        <select
                          value={String(opt.enrollment_status_id ?? "")}
                          onChange={(e) => updateOptionStatus(opt._draft_key, e.target.value === "" ? "" : Number(e.target.value))}
                          title="Enrollment status set automatically when a student picks this answer"
                          style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5, background: "#fff", fontSize: 11.5 }}
                          name={`survey_question_manage_select_option_status_${idx}`}
                        >
                          <option value="">No status change</option>
                          {enrollmentStatuses.map((s) => (
                            <option key={s.status_id} value={String(s.status_id)}>
                              {s.status_name}
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => removeOptionDraft(opt._draft_key)}
                          disabled={optionsLoading}
                          style={{ background: "var(--danger-500)", color: "#fff", border: "none", padding: "6px 8px", borderRadius: 5, cursor: optionsLoading ? "not-allowed" : "pointer" }}
                        >
                          Remove
                        </button>
                      </div>
                    ))
                  )}

                  <div style={{ fontSize: 10.5, color: "var(--text-muted)", lineHeight: 1.45 }}>
                    Picking a status here sets the student's enrollment standing automatically
                    when they choose that answer — e.g. <strong>Yes → Will Continue</strong>,{" "}
                    <strong>No → Will not continue - Stop</strong>. Leave it on "No status change" for
                    answers that carry no meaning. The newest submission wins, but a Dean's
                    Approved/Pending decision is never reset.
                  </div>
                </div>
              )}

              {/* ---- branching ------------------------------------------------
                  Nothing ticked means the question is always asked, which is the
                  default and what every question did before this existed. Tick
                  one or more answers and it is asked only when the student gives
                  one of them.

                  LAST on purpose. Type, then the options that type needs, then
                  when to ask it: the first two say what the question IS, and
                  this one is a condition placed on the finished question. It sat
                  above the options before, which put "when to show it" in front
                  of "what it asks". */}
              <div style={{ border: "1px solid var(--border-base)", borderRadius: 6, padding: 9, display: "grid", gap: 8 }}>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--text-secondary)" }}>
                    Only ask this question sometimes
                  </label>
                  <div style={{ fontSize: 10.5, color: "var(--text-faint)", marginTop: 2 }}>
                    Tick the answers that should bring it up. Leave everything unticked to always ask it.
                  </div>
                  {/* The rule as a sentence. The pills say what is ticked; only
                      this says what it MEANS, which is the part worth checking
                      before saving. Same function the student-side uses to
                      decide, so the two cannot describe different rules. */}
                  <div
                    style={{
                      marginTop: 6, padding: "5px 8px", borderRadius: 5, fontSize: 11.5,
                      background: "var(--surface-muted, #f8fafc)",
                      color: "var(--text-secondary)",
                      border: "1px solid var(--border-base)",
                    }}
                  >
                    {describeBranching(form.show_when_option_ids, branchSources)}
                  </div>
                </div>

                {branchLoading ? (
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>Loading answers…</div>
                ) : branchSources.length === 0 ? (
                  <div style={{ fontSize: 11.5, color: "var(--text-muted)" }}>
                    {form.survey_id
                      ? "This survey has no multiple-choice question to branch on yet. Add one with options first."
                      : "Pick a survey first."}
                  </div>
                ) : (
                  branchSources.map((source) => (
                    <div key={source.question_id} style={{ display: "grid", gap: 4 }}>
                      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>
                        {source.question_text}
                      </div>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {source.options.map((opt) => {
                          const id = Number(opt.option_id);
                          const checked = (form.show_when_option_ids || []).map(Number).includes(id);
                          return (
                            <label
                              key={id}
                              style={{
                                display: "inline-flex", alignItems: "center", gap: 5,
                                fontSize: 11.5, padding: "4px 8px", borderRadius: 999, cursor: "pointer",
                                border: `1px solid ${checked ? "var(--brand-800)" : "var(--border-base)"}`,
                                background: checked ? "var(--brand-100)" : "var(--surface-base)",
                                color: checked ? "var(--brand-800)" : "var(--text-secondary)",
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleBranchOption(id)}
                                name={`branch_option_${id}`}
                              />
                              {opt.option_text}
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  ))
                )}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: !form.question_id && supports.status ? "1fr 1fr" : "1fr", gap: 8 }}>
                <div>
                  <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Sort Order</label>
                  <input
                    type="number"
                    min="0"
                    step="1"
                    inputMode="numeric"
                    value={form.sort_order}
                    onChange={(e) => setForm((f) => ({ ...f, sort_order: e.target.value }))}
                    style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                    placeholder="e.g. 1"
                    disabled={!supports.sort_order}
                   name="survey_question_manage_input_401"/>
                  {!supports.sort_order && (
                    <div style={{ marginTop: 3, fontSize: 10.5, color: "var(--warning-700)" }}>
                      Sort order is not supported by current `survey_question` table.
                    </div>
                  )}
                </div>

                {!form.question_id && supports.status && (
                  <div>
                    <label style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>Status</label>
                    <select
                      value={String(form.status)}
                      onChange={(e) => setForm((f) => ({ ...f, status: Number(e.target.value) }))}
                      style={{ width: "100%", padding: "6px 8px", border: "1px solid var(--border-base)", borderRadius: 5 }}
                     name="survey_question_manage_select_411">
                      <option value="1">Active</option>
                      <option value="0">Inactive</option>
                    </select>
                  </div>
                )}
              </div>
            </div>

            <div style={{ padding: 12, borderTop: "1px solid var(--border-base)", display: "flex", justifyContent: "flex-end", gap: 6 }}>
              <button onClick={closeModal} style={{ background: "var(--border-base)", color: "var(--text-primary)", border: 0, padding: "6px 9px", borderRadius: 6, cursor: "pointer" }}>
                Cancel
              </button>
              <button onClick={save} disabled={saving || optionsLoading} style={{ background: "var(--brand-600)", color: "#fff", border: 0, padding: "6px 9px", borderRadius: 6, cursor: saving || optionsLoading ? "not-allowed" : "pointer" }}>
                {saving ? "Saving..." : "Save"}
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
