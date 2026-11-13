import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { notifyError, notifyInfo, notifySuccess } from "../../shared/lib/notify";
import { canModuleAction } from "../../shared/lib/roleAccess";
import { getBackendUrl } from "../../shared/lib/url";
import { AlertMessage, Button } from "../../shared/components/ui";
import {
  answerFormatOfQuestion,
  answerInputMode,
  isComposedAnswerFormat,
  isSingleLineAnswerFormat,
  answerFormatRule,
  effectiveAnswerMaxLength,
  sanitizeAnswerInput,
  validateAnswerValue,
} from "./answerFormats";
import AddressPicker from "./AddressPicker";
import { normalizeOptionRows, optionTextsOf, visibleQuestions } from "./surveyBranching";
import { clearDraft, readDraft, SURVEY_STATUS, surveyStatus, writeDraft } from "./surveyDrafts";

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function surveyIdOf(s) {
  return toInt(s?.survey_id || s?.id);
}

function surveyTitleOf(s) {
  return s?.survey_title || s?.title || s?.name || `Survey ${surveyIdOf(s) || ""}`.trim();
}

function questionIdOf(q) {
  return toInt(q?.question_id || q?.id);
}

function questionTypeOf(q) {
  return String(q?.question_type || q?.type || "text").trim().toLowerCase();
}

function isQuestionRequired(q) {
  if (q?.is_required === true) return true;
  if (q?.is_required === false) return false;
  const numeric = Number(q?.is_required);
  if (Number.isFinite(numeric)) return numeric === 1;
  const text = String(q?.is_required || "").trim().toLowerCase();
  return text === "yes" || text === "true" || text === "required";
}

function statusIdOfSurvey(s) {
  return toInt(s?.status || s?.status_id);
}

function isSurveyActive(s) {
  const statusName = String(s?.status_name || "").trim().toLowerCase();
  if (statusName) return statusName === "active";

  const statusId = statusIdOfSurvey(s);
  if (statusId > 0) return statusId === 1;

  return true;
}

/**
 * Order questions the way the survey was authored.
 *
 * An unset `sort_order` sorts last, matching both the list endpoint
 * (`ORDER BY (sort_order IS NULL) ASC, sort_order ASC, question_id ASC`) and
 * the admin list in SurveyQuestionsPage. All three have to agree, or the order
 * an author arranges is not the order a student is asked in.
 *
 * The null check is explicit because `Number(null)` is `0`, and `0` is finite -
 * so treating the value as a plain number silently turns "no position set" into
 * "first position", which put unordered questions at the top of the form for
 * students while the author saw them at the bottom.
 */
function sortValueOf(row) {
  const raw = row?.sort_order;
  if (raw === null || raw === undefined || raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

function sortQuestions(rows) {
  const clone = Array.isArray(rows) ? [...rows] : [];
  clone.sort((a, b) => {
    const orderA = sortValueOf(a);
    const orderB = sortValueOf(b);
    if (orderA !== null && orderB !== null && orderA !== orderB) return orderA - orderB;
    if (orderA !== null && orderB === null) return -1;
    if (orderA === null && orderB !== null) return 1;
    return questionIdOf(a) - questionIdOf(b);
  });
  return clone;
}

function answerToText(raw, qType) {
  if (qType.includes("checkbox")) {
    if (Array.isArray(raw)) {
      return raw
        .map((v) => String(v || "").trim())
        .filter(Boolean)
        .filter((v, idx, arr) => arr.indexOf(v) === idx)
        .join(", ");
    }
    return String(raw || "").trim();
  }
  return String(raw || "").trim();
}

function hasAnswer(raw, qType) {
  return answerToText(raw, qType) !== "";
}

/** The question label, for a message that has to name which one is wrong. */
function questionLabelOf(q) {
  const text = String(q?.question_text || q?.text || "").trim();
  return text !== "" ? text : `Question ${questionIdOf(q)}`;
}

function formatSubmittedAt(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString();
}

function defaultOptionsForType(qType) {
  if (qType.includes("radio") || qType.includes("checkbox")) return ["Yes", "No"];
  return [];
}

const STUDENT_SURVEY_REQUEST_TIMEOUT_MS = 20000;

async function fetchJsonWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), STUDENT_SURVEY_REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    const data = await res.json().catch(() => null);
    return { res, data };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error("Request timed out");
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function rowsFromPayload(payload, keys = ["data", "rows"]) {
  for (const key of keys) {
    if (Array.isArray(payload?.[key])) return payload[key];
  }
  return Array.isArray(payload) ? payload : [];
}

/* ------------------------------------------------------------------ status */

const STATUS_META = {
  [SURVEY_STATUS.notStarted]: { label: "Not started", tone: { color: "var(--text-secondary)", background: "var(--surface-page)", border: "var(--border-strong)" } },
  [SURVEY_STATUS.inProgress]: { label: "In progress", tone: { color: "var(--warning-800)", background: "var(--warning-100)", border: "var(--warning-200)" } },
  [SURVEY_STATUS.completed]: { label: "Completed", tone: { color: "var(--brand-800)", background: "var(--brand-100)", border: "var(--brand-200)" } },
};

/* ------------------------------------------------------------------- icons */

function IconClipboard() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z" />
      <path d="M16 5h2a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2" />
      <path d="M9 11h6M9 15h4" />
    </svg>
  );
}

function IconCheck({ size = 26 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

function StatusPill({ status }) {
  const meta = STATUS_META[status] || STATUS_META.not_started;
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        padding: "3px 9px",
        borderRadius: 999,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
        color: meta.tone.color,
        background: meta.tone.background,
        border: `1px solid ${meta.tone.border}`,
        whiteSpace: "nowrap",
      }}
    >
      {status === SURVEY_STATUS.completed ? <IconCheck size={11} /> : null}
      {meta.label}
    </span>
  );
}

/* --------------------------------------------------------------- the page */

export default function Survey({ user, permissions = null, forced = false, onForcedNeeded, onForcedDone }) {
  /*
   * One screen at a time: list -> intro -> answer -> review -> done.
   *
   * The whole flow used to live in a 612px dialog, which meant a ten-question
   * survey was one long scroll with no sense of position and no way back out
   * except an unlabelled x. A wizard belongs on the page, not in a box — and
   * moving it out also removes the dialog's missing Escape and focus handling
   * from the student's path entirely.
   */
  const [view, setView] = useState("list");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [surveys, setSurveys] = useState([]);
  const [submittedBySurvey, setSubmittedBySurvey] = useState({});
  // Whether the student's submissions have been loaded yet. The forced-survey
  // gate must wait for this: acting while it is still empty treats every survey
  // — completed ones included — as unanswered, which pops the gate over a survey
  // the student already finished, with no way out.
  const [submissionsReady, setSubmissionsReady] = useState(false);
  const [studentCtx, setStudentCtx] = useState({ student_id: null, student_number: "" });
  const [draftTick, setDraftTick] = useState(0);

  const [activeSurvey, setActiveSurvey] = useState(null);
  const [questions, setQuestions] = useState([]);
  const [optionsByQuestion, setOptionsByQuestion] = useState({});
  const [answers, setAnswers] = useState({});
  const [stepIndex, setStepIndex] = useState(0);
  const [questionsLoading, setQuestionsLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState("");
  const [doneAt, setDoneAt] = useState("");

  /*
   * The answers a student already sent, when they ask to see them. Loaded on
   * demand — most visits here are to answer something new, not reread an old one.
   */
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const [pastAnswers, setPastAnswers] = useState([]);

  // Moved to on every step change, so a keyboard or screen-reader user lands on
  // the new question instead of staying on a button that just re-rendered.
  const stepHeadingRef = useRef(null);

  // The forced survey is opened exactly once. Without this guard the auto-open
  // effect would fire again after a background refresh and yank a student who
  // had navigated within the survey back to its intro.
  const forcedOpenedRef = useRef(false);

  const hasPermissionContext = Array.isArray(permissions);
  const canAnswer = hasPermissionContext
    ? (
      canModuleAction(permissions, "answer")
      || canModuleAction(permissions, "create")
      || canModuleAction(permissions, "edit")
    )
    : true;

  const studentId = toInt(studentCtx?.student_id);

  const resolveStudentContext = useCallback(async () => {
    const studentIdFromUser = toInt(user?.student_id);
    const studentNumberFromUser = String(user?.student_number || "").trim();
    if (studentIdFromUser > 0) {
      return { student_id: studentIdFromUser, student_number: studentNumberFromUser };
    }

    const userId = toInt(user?.user_id || user?.id);
    if (userId <= 0) return { student_id: null, student_number: studentNumberFromUser };

    const { res, data } = await fetchJsonWithTimeout(getBackendUrl(`student.php?user_id=${encodeURIComponent(userId)}&limit=1`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) return { student_id: null, student_number: studentNumberFromUser };

    const row = Array.isArray(data?.data) ? data.data[0] : null;
    if (!row) return { student_id: null, student_number: studentNumberFromUser };

    return {
      student_id: toInt(row.student_id) || null,
      student_number: String(row.student_number || studentNumberFromUser || ""),
    };
  }, [user]);

  const loadSubmittedBySurvey = useCallback(async (id) => {
    const resolvedStudentId = toInt(id);
    if (resolvedStudentId <= 0) return {};

    const { res, data: submissionData } = await fetchJsonWithTimeout(getBackendUrl(`survey_submission.php?page=1&limit=1000&student_id=${encodeURIComponent(resolvedStudentId)}`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) return {};

    return rowsFromPayload(submissionData).reduce((acc, row) => {
      const sid = surveyIdOf(row);
      if (!sid) return acc;

      const prev = acc[sid];
      if (!prev) {
        acc[sid] = row;
        return acc;
      }

      const prevTs = new Date(String(prev?.submitted_at || prev?.date || "")).getTime();
      const nextTs = new Date(String(row?.submitted_at || row?.date || "")).getTime();
      if (!Number.isFinite(prevTs) || nextTs > prevTs) acc[sid] = row;
      return acc;
    }, {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        setLoading(true);
        setError("");
        setSubmittedBySurvey({});
        setSubmissionsReady(false);

        const studentContextPromise = resolveStudentContext().catch(() => ({
          student_id: null,
          student_number: String(user?.student_number || "").trim(),
        }));
        const { res: surveyRes, data: surveyData } = await fetchJsonWithTimeout(getBackendUrl("survey.php?page=1&limit=1000"), {
          headers: { Accept: "application/json" },
          credentials: "include",
        });
        if (!surveyRes.ok) throw new Error(`HTTP ${surveyRes.status}`);

        const loadedSurveys = rowsFromPayload(surveyData, ["data", "surveys"]);
        const activeSurveys = loadedSurveys.filter(isSurveyActive);

        if (!cancelled) {
          // First paint shows the active surveys; the answered-but-inactive ones
          // are added back below once we know which the student has submitted.
          setSurveys(activeSurveys);
          setLoading(false);
        }

        const ctx = await studentContextPromise;
        if (cancelled) return;

        setStudentCtx(ctx);
        const submittedMap = await loadSubmittedBySurvey(ctx?.student_id).catch(() => ({}));
        if (!cancelled) {
          setSubmittedBySurvey(submittedMap);
          setSubmissionsReady(true);
          /*
           * A survey the student already answered stays on their list even after
           * an admin sets it inactive, so they can still open it and read what
           * they submitted. Deactivating a survey closes it to NEW answers — it
           * does not erase the answers already given. Inactive surveys the
           * student never touched stay hidden: there is nothing to do with those.
           */
          setSurveys(loadedSurveys.filter((s) => isSurveyActive(s) || submittedMap[surveyIdOf(s)]));
        }
      } catch (e) {
        if (!cancelled) {
          // Inline only. The page already renders `error` where the survey list
          // would have been, which is where a student is looking; a popup on top
          // of it said the same thing twice and had to be dismissed before the
          // retry button underneath was reachable.
          setError(e?.message === "Request timed out"
            ? "The surveys took too long to load. Check your connection and try again."
            : "Surveys cannot be loaded right now. Try again in a moment.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [loadSubmittedBySurvey, resolveStudentContext, user?.student_number]);

  /**
   * Not started / In progress / Completed, for one survey.
   *
   * The rule itself lives in surveyDrafts.js and is tested there. This page
   * restated it inline until 2026-09-14 - the same three branches in the same
   * order, written against string literals rather than SURVEY_STATUS - which
   * is precisely what that module's header says it exists to prevent.
   */
  const statusOf = useCallback((survey) => {
    const sid = surveyIdOf(survey);
    return surveyStatus({ submitted: submittedBySurvey[sid], studentId, surveyId: sid });
    // draftTick re-reads localStorage after a save so a card can change status
    // without a page reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [submittedBySurvey, studentId, draftTick]);

  /* ------------------------------------------------------------ opening */

  const loadQuestionOptions = useCallback(async (questionId) => {
    const { res, data } = await fetchJsonWithTimeout(getBackendUrl(`survey_question_option.php?question_id=${encodeURIComponent(questionId)}&limit=500`), {
      headers: { Accept: "application/json" },
      credentials: "include",
    });
    if (!res.ok) return [];
    return normalizeOptionRows(data?.data);
  }, []);

  const openIntro = useCallback(async (s) => {
    const sid = surveyIdOf(s);
    if (!sid) {
      void notifyError("Invalid survey");
      return;
    }

    setActiveSurvey(s);
    setSubmitError("");
    setStepIndex(0);
    setQuestions([]);
    setOptionsByQuestion({});
    setPastAnswers([]);
    setReviewError("");

    const completed = Boolean(submittedBySurvey[sid]);
    setAnswers(completed ? {} : (readDraft(studentId, sid)?.answers || {}));
    setView("intro");

    // Completed surveys show the stored answers instead of the form, so the
    // question set is not needed for them.
    if (completed) {
      const submissionId = toInt(submittedBySurvey[sid]?.submission_id);
      if (submissionId <= 0) {
        setReviewError("This submission has no id on record, so its answers cannot be looked up.");
        return;
      }
      setReviewLoading(true);
      try {
        const { res, data } = await fetchJsonWithTimeout(
          getBackendUrl(`survey_response.php?page=1&limit=200&submission_id=${encodeURIComponent(submissionId)}`),
          { headers: { Accept: "application/json" }, credentials: "include" }
        );
        if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);
        setPastAnswers(rowsFromPayload(data));
      } catch (e) {
        setReviewError(
          e?.message === "Request timed out"
            ? "The request timed out. Please try again."
            : "Unable to load your answers right now."
        );
      } finally {
        setReviewLoading(false);
      }
      return;
    }

    setQuestionsLoading(true);
    try {
      const { res, data } = await fetchJsonWithTimeout(getBackendUrl(`survey_question.php?survey_id=${encodeURIComponent(sid)}&limit=500`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });
      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);

      const rows = sortQuestions(Array.isArray(data?.data) ? data.data : []);
      setQuestions(rows);

      const optionQuestionIds = rows
        .filter((q) => {
          const t = questionTypeOf(q);
          return t.includes("radio") || t.includes("checkbox");
        })
        .map(questionIdOf)
        .filter((id, idx, arr) => id > 0 && arr.indexOf(id) === idx);

      if (optionQuestionIds.length > 0) {
        const optionPairs = await Promise.all(
          optionQuestionIds.map(async (qid) => {
            const options = await loadQuestionOptions(qid).catch(() => []);
            return [qid, options];
          })
        );

        const nextOptionsByQuestion = {};
        optionPairs.forEach(([qid, list]) => {
          if (Array.isArray(list) && list.length > 0) {
            nextOptionsByQuestion[qid] = list;
          }
        });
        setOptionsByQuestion(nextOptionsByQuestion);
      }
    } catch (_) {
      setQuestions([]);
      void notifyError("Failed to load questions");
    } finally {
      setQuestionsLoading(false);
    }
  }, [loadQuestionOptions, studentId, submittedBySurvey]);

  /*
   * Forced mode: on login the student is dropped straight into the survey they
   * still owe, with no way back out to the list until it is submitted.
   *
   * The target is the most recently published active survey they have not
   * answered. It is chosen and opened once (forcedOpenedRef), and the parent is
   * told a survey is pending so it can raise the gate; if there is nothing
   * outstanding the parent is never called and the gate stays down.
   */
  useEffect(() => {
    if (!forced || forcedOpenedRef.current) return;
    // Not until submissions are in: firing early treats a completed survey as
    // unanswered and forces it with no exit — the bug this guard closes.
    if (loading || !studentId || !submissionsReady) return;

    const target = [...surveys]
      .filter((s) => !submittedBySurvey[surveyIdOf(s)])
      .sort((a, b) => surveyIdOf(b) - surveyIdOf(a))[0];
    if (!target) return;

    forcedOpenedRef.current = true;
    onForcedNeeded?.();
    void openIntro(target);
  }, [forced, loading, studentId, submissionsReady, surveys, submittedBySurvey, openIntro, onForcedNeeded]);

  const backToList = useCallback(() => {
    setView("list");
    setActiveSurvey(null);
    setQuestions([]);
    setOptionsByQuestion({});
    setAnswers({});
    setStepIndex(0);
    setSubmitError("");
    setPastAnswers([]);
    setReviewError("");
  }, []);

  /* ------------------------------------------------------------ answering */

  /**
   * The questions on screen right now, after branching.
   *
   * Recomputed from `answers`, so choosing "No, I will not enroll." reveals the
   * follow-ups immediately. The step count follows it: answering a branch can
   * genuinely make a survey longer, and saying "3 of 7" when it is about to
   * become 3 of 10 would be a worse lie than letting the total move.
   */
  const shownQuestions = useMemo(
    () => visibleQuestions(questions, optionsByQuestion, answers),
    [questions, optionsByQuestion, answers]
  );

  const totalSteps = shownQuestions.length;
  const safeStep = Math.min(stepIndex, Math.max(0, totalSteps - 1));
  const currentQuestion = shownQuestions[safeStep] || null;

  // A branch closing can leave the pointer past the end of the list.
  useEffect(() => {
    if (stepIndex > 0 && stepIndex > totalSteps - 1) {
      setStepIndex(Math.max(0, totalSteps - 1));
    }
  }, [stepIndex, totalSteps]);

  // Every answered change is written through, so closing the tab mid-survey
  // costs nothing.
  useEffect(() => {
    if (view !== "answer" && view !== "review") return;
    const sid = surveyIdOf(activeSurvey);
    if (!sid || !studentId) return;
    writeDraft(studentId, sid, answers);
    setDraftTick((tick) => tick + 1);
  }, [answers, activeSurvey, studentId, view]);

  useEffect(() => {
    if (view !== "answer") return;
    stepHeadingRef.current?.focus();
  }, [view, safeStep]);

  const setAnswerFor = useCallback((qid, value) => {
    setAnswers((prev) => ({ ...prev, [qid]: value }));
  }, []);

  const answeredCount = useMemo(
    () => shownQuestions.filter((q) => hasAnswer(answers[questionIdOf(q)], questionTypeOf(q))).length,
    [shownQuestions, answers]
  );

  /** What blocks Next on the question in view, if anything. */
  const currentProblem = useMemo(() => {
    if (!currentQuestion) return "";
    const qid = questionIdOf(currentQuestion);
    const qType = questionTypeOf(currentQuestion);
    const raw = answers[qid];

    if (isQuestionRequired(currentQuestion) && !hasAnswer(raw, qType)) {
      return "This question needs an answer before you can continue.";
    }
    const format = answerFormatOfQuestion(currentQuestion, qType);
    return validateAnswerValue(format, raw ?? "", currentQuestion?.answer_max_length) || "";
  }, [currentQuestion, answers]);

  const goNext = useCallback(() => {
    if (currentProblem) return;
    if (safeStep >= totalSteps - 1) {
      setView("review");
      return;
    }
    setStepIndex(safeStep + 1);
  }, [currentProblem, safeStep, totalSteps]);

  const goBack = useCallback(() => {
    if (safeStep <= 0) {
      setView("intro");
      return;
    }
    setStepIndex(safeStep - 1);
  }, [safeStep]);

  /**
   * Answers as the server wants them.
   *
   * shownQuestions, not questions: an answer typed under one branch and then
   * hidden by changing the decision must not be submitted. It stays in state in
   * case the student switches back, but it is not part of the submission.
   */
  const compiledAnswers = useCallback(() => {
    return shownQuestions
      .map((q) => {
        const qid = questionIdOf(q);
        const val = answerToText(answers[qid], questionTypeOf(q));
        if (!qid || val === "") return null;
        return { question_id: qid, answer: val };
      })
      .filter(Boolean);
  }, [shownQuestions, answers]);

  /** Everything still standing between the student and a valid submission. */
  const outstanding = useMemo(() => {
    return shownQuestions
      .map((q, index) => {
        const qid = questionIdOf(q);
        const qType = questionTypeOf(q);
        const raw = answers[qid];
        if (isQuestionRequired(q) && !hasAnswer(raw, qType)) {
          return { index, question: questionLabelOf(q), problem: "Not answered yet" };
        }
        const problem = validateAnswerValue(answerFormatOfQuestion(q, qType), raw ?? "", q?.answer_max_length);
        return problem ? { index, question: questionLabelOf(q), problem } : null;
      })
      .filter(Boolean);
  }, [shownQuestions, answers]);

  async function submitSurvey() {
    const sid = surveyIdOf(activeSurvey);

    if (!studentId || !sid) {
      setSubmitError("Student or survey is missing.");
      return;
    }
    if (!canAnswer) {
      void notifyInfo("View only", "This account cannot submit survey answers.");
      return;
    }
    if (submittedBySurvey[sid]) {
      setSubmitError("You have already answered this survey.");
      return;
    }
    if (outstanding.length > 0) {
      setSubmitError(`${outstanding[0].question} — ${outstanding[0].problem}`);
      return;
    }

    const answerRows = compiledAnswers();
    if (answerRows.length === 0) {
      setSubmitError("Please answer at least one question before submitting.");
      return;
    }

    setSubmitting(true);
    setSubmitError("");
    try {
      const submittedAt = new Date().toISOString();
      const { res, data } = await fetchJsonWithTimeout(getBackendUrl("survey_submission.php"), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "include",
        body: JSON.stringify({
          survey_id: sid,
          student_id: studentId,
          submitted_at: submittedAt,
          answers: answerRows,
        }),
      });

      /*
       * A 409 is not a failure to report as one. It means this survey was
       * already answered — most often the same submit arriving twice — so the
       * page settles on the same place a first submission would have reached.
       */
      if (res.status === 409) {
        const stamp = data?.data?.submitted_at || submittedAt;
        setSubmittedBySurvey((prev) => ({
          ...prev,
          [sid]: { ...(prev[sid] || {}), survey_id: sid, student_id: studentId, submission_id: toInt(data?.data?.submission_id) || undefined, submitted_at: stamp },
        }));
        clearDraft(studentId, sid);
        setDoneAt(stamp);
        setView("done");
        return;
      }

      if (!res.ok) throw new Error(data?.message || `HTTP ${res.status}`);

      const stamp = data?.data?.submitted_at || submittedAt;
      setSubmittedBySurvey((prev) => ({
        ...prev,
        [sid]: {
          ...(prev[sid] || {}),
          survey_id: sid,
          student_id: studentId,
          submission_id: Number(data?.data?.submission_id || 0) || undefined,
          submitted_at: stamp,
        },
      }));
      clearDraft(studentId, sid);
      setDraftTick((tick) => tick + 1);
      setDoneAt(stamp);
      setView("done");
      void notifySuccess("Survey submitted");
    } catch (e) {
      const message = e?.message === "Request timed out"
        ? "The request timed out. Your answers are still saved — please try again."
        : (e?.message || "Please try again.");
      setSubmitError(message);
      void notifyError("Submit failed", message);
    } finally {
      setSubmitting(false);
    }
  }

  const discardDraft = useCallback(() => {
    const sid = surveyIdOf(activeSurvey);
    if (!sid) return;
    clearDraft(studentId, sid);
    setAnswers({});
    setStepIndex(0);
    setDraftTick((tick) => tick + 1);
    void notifyInfo("Draft cleared", "Your saved answers for this survey were removed.");
  }, [activeSurvey, studentId]);

  /* -------------------------------------------------------------- render */

  const requiredCount = useMemo(
    () => questions.filter(isQuestionRequired).length,
    [questions]
  );

  const blocked = !canAnswer || !studentId;

  return (
    <section id="survey" style={{ display: "grid", gap: 14 }}>
      {view === "list" ? (
        forced ? (
          // Forced mode never shows the list — this is only the moment before the
          // required survey has been picked and opened.
          <div style={{ color: "var(--text-muted)", fontSize: 12.5, padding: "10px 0" }}>Loading your required survey…</div>
        ) : (
          <SurveyList
            surveys={surveys}
            loading={loading}
            error={error}
            canAnswer={canAnswer}
            studentId={studentId}
            statusOf={statusOf}
            submittedBySurvey={submittedBySurvey}
            onOpen={openIntro}
          />
        )
      ) : null}

      {view !== "list" && activeSurvey ? (
        <div style={{ display: "grid", gap: 12 }}>
          {/* No way back to the list while a survey is forced — the student
              answers it or logs out, nothing in between. */}
          {!forced ? (
          <button
            type="button"
            onClick={backToList}
            style={{
              justifySelf: "start",
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "4px 2px",
              background: "transparent",
              border: 0,
              color: "var(--text-secondary)",
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M15 18l-6-6 6-6" />
            </svg>
            All surveys
          </button>
          ) : null}

          {view === "intro" ? (
            <SurveyIntro
              survey={activeSurvey}
              status={statusOf(activeSurvey)}
              loading={questionsLoading}
              totalQuestions={questions.length}
              requiredCount={requiredCount}
              answeredCount={answeredCount}
              blocked={blocked}
              canAnswer={canAnswer}
              hasStudentRecord={Boolean(studentId)}
              submittedAt={submittedBySurvey[surveyIdOf(activeSurvey)]?.submitted_at || submittedBySurvey[surveyIdOf(activeSurvey)]?.date}
              pastAnswers={pastAnswers}
              reviewLoading={reviewLoading}
              reviewError={reviewError}
              onStart={() => {
                setStepIndex(0);
                setView("answer");
              }}
              onDiscardDraft={discardDraft}
            />
          ) : null}

          {view === "answer" && currentQuestion ? (
            <AnswerStep
              survey={activeSurvey}
              question={currentQuestion}
              stepNumber={safeStep + 1}
              totalSteps={totalSteps}
              answers={answers}
              optionsByQuestion={optionsByQuestion}
              problem={currentProblem}
              headingRef={stepHeadingRef}
              onChange={setAnswerFor}
              onBack={goBack}
              onNext={goNext}
            />
          ) : null}

          {view === "review" ? (
            <ReviewStep
              survey={activeSurvey}
              shownQuestions={shownQuestions}
              answers={answers}
              outstanding={outstanding}
              submitting={submitting}
              submitError={submitError}
              onEdit={(index) => {
                setStepIndex(index);
                setView("answer");
              }}
              onBack={() => {
                setStepIndex(Math.max(0, totalSteps - 1));
                setView("answer");
              }}
              onSubmit={submitSurvey}
            />
          ) : null}

          {view === "done" ? (
            <DoneStep
              survey={activeSurvey}
              submittedAt={doneAt}
              forced={forced}
              // Forced: the survey is answered, so the gate can come down and the
              // student reaches their dashboard. Otherwise: back to the list.
              onBackToList={forced ? () => onForcedDone?.() : backToList}
            />
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------ list */

function SurveyList({ surveys, loading, error, canAnswer, studentId, statusOf, submittedBySurvey, onOpen }) {
  const ordered = useMemo(() => {
    // What still needs doing comes first. A student opening this page is
    // looking for work, not for a record of finished work.
    const weight = { in_progress: 0, not_started: 1, completed: 2 };
    return [...surveys].sort((a, b) => weight[statusOf(a)] - weight[statusOf(b)]);
  }, [surveys, statusOf]);

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0, marginBottom: 4, color: "var(--brand-800)" }}>Surveys</h2>
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 12.5 }}>
          Open a survey to answer it. Your answers are saved as you go, so you can stop and come back.
        </p>
      </div>

      {!canAnswer ? (
        <AlertMessage tone="info" message="This account can open surveys to read them, but cannot submit answers." style={{ marginBottom: 0 }} />
      ) : null}

      {!loading && !error && !studentId ? (
        <AlertMessage
          tone="warning"
          message="We could not find a student record for this account, so surveys cannot be submitted. Please contact the admin office."
          style={{ marginBottom: 0 }}
        />
      ) : null}

      {error ? <AlertMessage tone="error" message={error} style={{ marginBottom: 0 }} /> : null}

      {loading ? (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 264px), 1fr))" }}>
          {[0, 1, 2].map((n) => (
            <div key={n} className="ui-skeleton" aria-hidden="true" style={{ height: 132, borderRadius: 12 }} />
          ))}
        </div>
      ) : null}

      {!loading && !error && ordered.length === 0 ? (
        <div
          style={{
            display: "grid",
            justifyItems: "center",
            gap: 6,
            padding: "40px 20px",
            textAlign: "center",
            background: "var(--surface-base)",
            border: "1px dashed var(--border-strong)",
            borderRadius: 12,
          }}
        >
          <div className="survey-card-icon" style={{ width: 44, height: 44 }}><IconClipboard /></div>
          <h3 style={{ margin: "6px 0 0", fontSize: 16, color: "var(--text-primary)" }}>No surveys right now</h3>
          <p style={{ margin: 0, maxWidth: 320, fontSize: 12.5, color: "var(--text-secondary)" }}>
            When your college publishes one, it will appear here. Nothing is waiting on you today.
          </p>
        </div>
      ) : null}

      {!loading && ordered.length > 0 ? (
        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(min(100%, 264px), 1fr))" }}>
          {ordered.map((s, idx) => {
            const sid = surveyIdOf(s);
            const status = statusOf(s);
            const stamp = formatSubmittedAt(submittedBySurvey[sid]?.submitted_at || submittedBySurvey[sid]?.date);
            const action = status === SURVEY_STATUS.completed ? "View answers" : status === SURVEY_STATUS.inProgress ? "Continue" : "Start";

            return (
              <button
                key={`${sid || "survey"}_${idx}`}
                type="button"
                className="survey-card"
                data-status={status}
                onClick={() => void onOpen(s)}
                disabled={!sid}
              >
                <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <span className="survey-card-icon">
                    {status === SURVEY_STATUS.completed ? <IconCheck size={19} /> : <IconClipboard />}
                  </span>
                  <span style={{ minWidth: 0, flex: 1 }}>
                    <span style={{ display: "block", fontSize: 14, fontWeight: 700, color: "var(--text-primary)", lineHeight: 1.3 }}>
                      {surveyTitleOf(s)}
                    </span>
                    {s.description ? (
                      <span
                        style={{
                          display: "-webkit-box",
                          WebkitLineClamp: 2,
                          WebkitBoxOrient: "vertical",
                          overflow: "hidden",
                          marginTop: 3,
                          fontSize: 12.5,
                          color: "var(--text-secondary)",
                          lineHeight: 1.45,
                        }}
                      >
                        {s.description}
                      </span>
                    ) : null}
                  </span>
                </div>

                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, flexWrap: "wrap", marginTop: "auto" }}>
                  <StatusPill status={status} />
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: "var(--brand-800)" }}>{action} →</span>
                </div>

                {status === SURVEY_STATUS.completed && stamp ? (
                  <span style={{ fontSize: 10.5, color: "var(--text-muted)" }}>Answered {stamp}</span>
                ) : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

/* ----------------------------------------------------------------- intro */

function SurveyIntro({
  survey, status, loading, totalQuestions, requiredCount, answeredCount,
  blocked, canAnswer, hasStudentRecord, submittedAt, pastAnswers, reviewLoading, reviewError,
  onStart, onDiscardDraft,
}) {
  const completed = status === SURVEY_STATUS.completed;
  const resuming = status === SURVEY_STATUS.inProgress;

  return (
    <div className="survey-step" style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 12, padding: 18, display: "grid", gap: 14 }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <span className="survey-card-icon" style={{ width: 44, height: 44 }}>
          {completed ? <IconCheck size={22} /> : <IconClipboard />}
        </span>
        <div style={{ minWidth: 0, flex: "1 1 240px" }}>
          <h2 style={{ margin: 0, fontSize: 19.5, color: "var(--text-primary)", lineHeight: 1.25 }}>{surveyTitleOf(survey)}</h2>
          <div style={{ marginTop: 6 }}><StatusPill status={status} /></div>
        </div>
      </div>

      {survey?.description ? (
        <p style={{ margin: 0, color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.6, maxWidth: "60ch" }}>
          {survey.description}
        </p>
      ) : null}

      {completed ? (
        <>
          <AlertMessage
            tone="success"
            message={submittedAt ? `You answered this survey on ${formatSubmittedAt(submittedAt)}. Your answers are below.` : "You have already answered this survey. Your answers are below."}
            style={{ marginBottom: 0 }}
          />
          {reviewLoading ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12.5 }}>Loading your answers…</div>
          ) : reviewError ? (
            <AlertMessage tone="error" message={reviewError} style={{ marginBottom: 0 }} />
          ) : pastAnswers.length === 0 ? (
            <div style={{ color: "var(--text-muted)", fontSize: 12.5 }}>
              This submission is on record, but no answers were stored with it.
            </div>
          ) : (
            <div style={{ display: "grid", gap: 8 }}>
              {pastAnswers.map((row, index) => (
                <div key={row.answer_id || row.response_id || index} className="survey-review-row">
                  <div style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                    {row.question_text || `Question ${row.question_id ?? index + 1}`}
                  </div>
                  <div style={{ fontWeight: 600, color: String(row.answer ?? "").trim() === "" ? "var(--text-faint)" : "var(--text-primary)" }}>
                    {String(row.answer ?? "").trim() === "" ? "No answer" : row.answer}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <>
          {/* What they are about to be asked, before they start. */}
          <dl style={{ margin: 0, display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 128px), 1fr))" }}>
            <div style={{ padding: "10px 12px", background: "var(--surface-page)", borderRadius: 10 }}>
              <dt style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" }}>Questions</dt>
              <dd style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
                {loading ? "—" : totalQuestions}
              </dd>
            </div>
            <div style={{ padding: "10px 12px", background: "var(--surface-page)", borderRadius: 10 }}>
              <dt style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--text-muted)" }}>Required</dt>
              <dd style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 700, color: "var(--text-primary)" }}>
                {loading ? "—" : requiredCount}
              </dd>
            </div>
            {resuming ? (
              <div style={{ padding: "10px 12px", background: "var(--warning-100)", borderRadius: 10 }}>
                <dt style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--warning-800)" }}>Answered</dt>
                <dd style={{ margin: "2px 0 0", fontSize: 16, fontWeight: 700, color: "var(--warning-800)" }}>{answeredCount}</dd>
              </div>
            ) : null}
          </dl>

          <ul style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 5, color: "var(--text-secondary)", fontSize: 12.5, lineHeight: 1.55 }}>
            <li>Please answer honestly and make sure each answer is correct.</li>
            <li>One question at a time — you can go back and change any answer.</li>
            <li>Your answers are saved on this device as you go.</li>
            <li>You will see everything for a final check before it is sent.</li>
            <li>A survey can only be answered once.</li>
          </ul>

          {!canAnswer ? (
            <AlertMessage tone="info" message="This account can read the survey but cannot submit answers." style={{ marginBottom: 0 }} />
          ) : !hasStudentRecord ? (
            <AlertMessage tone="warning" message="No student record is linked to this account, so answers cannot be submitted." style={{ marginBottom: 0 }} />
          ) : null}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <Button onClick={onStart} disabled={loading || blocked || totalQuestions === 0}>
              {loading ? "Loading…" : resuming ? "Continue where I left off" : "Start survey"}
            </Button>
            {resuming ? (
              <Button variant="secondary" onClick={onDiscardDraft}>Start over</Button>
            ) : null}
          </div>

          {!loading && totalQuestions === 0 ? (
            <p style={{ margin: 0, fontSize: 12.5, color: "var(--text-muted)" }}>
              This survey has no questions yet, so there is nothing to answer.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- answer */

function AnswerStep({
  survey, question, stepNumber, totalSteps, answers, optionsByQuestion,
  problem, headingRef, onChange, onBack, onNext,
}) {
  const qid = questionIdOf(question);
  const qType = questionTypeOf(question);
  const optionRows = optionsByQuestion[qid];
  const optionList = optionRows ? optionTextsOf(optionRows) : defaultOptionsForType(qType);
  const answerFormat = answerFormatOfQuestion(question, qType);
  const formatRule = answerFormatRule(answerFormat);
  // The author may cap this one question below its format's ceiling.
  const answerLimit = effectiveAnswerMaxLength(answerFormat, question?.answer_max_length);
  const required = isQuestionRequired(question);
  const value = answers[qid];
  const percent = totalSteps > 0 ? Math.round((stepNumber / totalSteps) * 100) : 0;

  const selectedCheckboxValues = Array.isArray(value)
    ? value
    : String(value || "").trim()
      ? [String(value).trim()]
      : [];

  // Shown once the student has engaged with the field, so a required question
  // does not open already scolding them for not having answered it.
  const [touched, setTouched] = useState(false);
  useEffect(() => { setTouched(false); }, [qid]);
  const visibleProblem = touched ? problem : "";

  return (
    <div style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 12, padding: 18, display: "grid", gap: 16 }}>
      <div style={{ display: "grid", gap: 7 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)" }}>
            {surveyTitleOf(survey)}
          </span>
          <span aria-live="polite" style={{ fontSize: 12.5, fontWeight: 600, color: "var(--brand-800)", whiteSpace: "nowrap" }}>
            Question {stepNumber} of {totalSteps}
          </span>
        </div>
        <div
          className="survey-progress-track"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
          aria-label={`Question ${stepNumber} of ${totalSteps}`}
        >
          <div className="survey-progress-fill" style={{ width: `${percent}%` }} />
        </div>
      </div>

      <div className="survey-step" key={qid} style={{ display: "grid", gap: 12 }}>
        <h3
          ref={headingRef}
          tabIndex={-1}
          style={{ margin: 0, fontSize: 16, lineHeight: 1.35, color: "var(--text-primary)", outline: "none" }}
        >
          {questionLabelOf(question)}
          {required ? <span style={{ color: "var(--danger-600)", marginLeft: 4 }} aria-hidden="true">*</span> : null}
          {required ? <span className="sr-only"> (required)</span> : null}
        </h3>
        {!required ? (
          <p style={{ margin: "-6px 0 0", fontSize: 12.5, color: "var(--text-muted)" }}>Optional — you can skip this one.</p>
        ) : null}

        <div onBlur={() => setTouched(true)}>
          {qType.includes("radio") ? (
            <div role="radiogroup" aria-label={questionLabelOf(question)} style={{ display: "grid", gap: 8 }}>
              {optionList.map((opt) => (
                <label key={opt} className="survey-choice" data-checked={(value || "") === opt}>
                  <input
                    type="radio"
                    name={`q_${qid}`}
                    value={opt}
                    checked={(value || "") === opt}
                    onChange={() => { onChange(qid, opt); setTouched(true); }}
                  />
                  <span style={{ fontSize: 14, color: "var(--text-primary)" }}>{opt}</span>
                </label>
              ))}
            </div>
          ) : qType.includes("checkbox") ? (
            <div style={{ display: "grid", gap: 8 }}>
              <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>Choose all that apply.</p>
              {optionList.map((opt) => {
                const checked = selectedCheckboxValues.includes(opt);
                return (
                  <label key={opt} className="survey-choice" data-checked={checked}>
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={(e) => {
                        const current = selectedCheckboxValues;
                        const next = e.target.checked ? [...current, opt] : current.filter((v) => v !== opt);
                        onChange(qid, next.filter((v, i, arr) => arr.indexOf(v) === i));
                        setTouched(true);
                      }}
                    />
                    <span style={{ fontSize: 14, color: "var(--text-primary)" }}>{opt}</span>
                  </label>
                );
              })}
            </div>
          ) : qType.includes("rating") ? (
            <div role="radiogroup" aria-label={questionLabelOf(question)} style={{ display: "grid", gap: 8 }}>
              {[
                ["1", "Poor"], ["2", "Fair"], ["3", "Good"], ["4", "Very good"], ["5", "Excellent"],
              ].map(([score, label]) => (
                <label key={score} className="survey-choice" data-checked={String(value || "") === score}>
                  <input
                    type="radio"
                    name={`q_${qid}`}
                    value={score}
                    checked={String(value || "") === score}
                    onChange={() => { onChange(qid, score); setTouched(true); }}
                  />
                  <span style={{ fontSize: 14, color: "var(--text-primary)" }}>
                    <strong style={{ marginRight: 6 }}>{score}</strong>{label}
                  </span>
                </label>
              ))}
            </div>
          ) : isComposedAnswerFormat(answerFormat) ? (
            /* An address is assembled, not typed. The picker hands back the
               same one-line string every other format produces, so nothing
               downstream has to know this question was answered differently. */
            <AddressPicker
              value={value || ""}
              maxLength={answerLimit}
              invalid={Boolean(visibleProblem)}
              onChange={(composed) => onChange(qid, composed)}
            />
          ) : isSingleLineAnswerFormat(answerFormat) ? (
            /* A constrained answer is one line by definition, so it gets a
               single-line box. Typing is filtered as it goes — a letters-only
               question simply will not take a digit. */
            <input
              type="text"
              value={value || ""}
              inputMode={answerInputMode(answerFormat)}
              maxLength={answerLimit || undefined}
              onChange={(e) => onChange(qid, sanitizeAnswerInput(answerFormat, e.target.value, question?.answer_max_length))}
              placeholder={answerFormat === "phone" ? "09362743710" : "Type your answer"}
              aria-invalid={visibleProblem ? "true" : undefined}
              aria-describedby={`hint_${qid}`}
              style={{
                width: "100%",
                padding: "11px 12px",
                fontSize: 14,
                borderRadius: 10,
                border: `1px solid ${visibleProblem ? "var(--danger-500)" : "var(--border-strong)"}`,
                background: "var(--surface-base)",
                boxSizing: "border-box",
              }}
              name={`survey_input_${qid}`}
            />
          ) : (
            <textarea
              value={value || ""}
              maxLength={answerLimit}
              onChange={(e) => onChange(qid, sanitizeAnswerInput(answerFormat, e.target.value, question?.answer_max_length))}
              placeholder="Type your answer"
              aria-describedby={`hint_${qid}`}
              style={{
                width: "100%",
                minHeight: 116,
                padding: "11px 12px",
                fontSize: 14,
                lineHeight: 1.55,
                borderRadius: 10,
                border: `1px solid ${visibleProblem ? "var(--danger-500)" : "var(--border-strong)"}`,
                background: "var(--surface-base)",
                boxSizing: "border-box",
                resize: "vertical",
              }}
              name={`survey_textarea_${qid}`}
            />
          )}
        </div>

        <div id={`hint_${qid}`} style={{ display: "flex", justifyContent: "space-between", gap: 10, minHeight: 16 }}>
          <span
            role={visibleProblem ? "alert" : undefined}
            style={{ fontSize: 11.5, color: visibleProblem ? "var(--danger-700)" : "var(--text-muted)" }}
          >
            {visibleProblem || (answerFormat !== "any" ? formatRule.hint : "")}
          </span>
          {/* Only once the limit is in sight. A counter under every box would be
              noise on answers that average sixteen characters.

              Shown for every format rather than only for "any": now that a
              question can be set to a short, medium or long answer, the limit is
              a deliberate choice by the author and the student running into one
              needs to see it coming. */}
          {String(value || "").length > answerLimit * 0.8 ? (
            <span style={{ fontSize: 11, color: "var(--text-muted)", whiteSpace: "nowrap" }}>
              {String(value || "").length} / {answerLimit}
            </span>
          ) : null}
        </div>
      </div>

      <p style={{ margin: 0, fontSize: 11, color: "var(--text-muted)", textAlign: "center" }}>
        Please make sure your answer is correct before you continue.
      </p>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" onClick={onBack}>Back</Button>
        <Button
          onClick={() => { setTouched(true); onNext(); }}
          disabled={Boolean(problem)}
          title={problem || undefined}
        >
          {stepNumber >= totalSteps ? "Review answers" : "Next"}
        </Button>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- review */

function ReviewStep({ survey, shownQuestions, answers, outstanding, submitting, submitError, onEdit, onBack, onSubmit }) {
  const outstandingByIndex = useMemo(
    () => new Map(outstanding.map((entry) => [entry.index, entry])),
    [outstanding]
  );

  return (
    <div className="survey-step" style={{ background: "var(--surface-base)", border: "1px solid var(--border-base)", borderRadius: 12, padding: 18, display: "grid", gap: 14 }}>
      <div>
        <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: "0.05em", textTransform: "uppercase", color: "var(--text-muted)" }}>
          {surveyTitleOf(survey)}
        </span>
        <h2 style={{ margin: "4px 0 0", fontSize: 19.5, color: "var(--text-primary)" }}>Check your answers</h2>
        <p style={{ margin: "5px 0 0", fontSize: 12.5, color: "var(--text-secondary)" }}>
          Nothing has been sent yet. Change anything you want, then submit.
        </p>
      </div>

      {outstanding.length > 0 ? (
        <AlertMessage
          tone="warning"
          message={`${outstanding.length} ${outstanding.length === 1 ? "answer needs" : "answers need"} attention before you can submit.`}
          style={{ marginBottom: 0 }}
        />
      ) : null}

      {submitError ? <AlertMessage tone="error" message={submitError} style={{ marginBottom: 0 }} /> : null}

      <div style={{ display: "grid", gap: 8 }}>
        {shownQuestions.map((q, index) => {
          const qid = questionIdOf(q);
          const text = answerToText(answers[qid], questionTypeOf(q));
          const issue = outstandingByIndex.get(index);

          return (
            <div
              key={`${qid}_${index}`}
              className="survey-review-row"
              style={issue ? { borderColor: "var(--warning-200)", background: "var(--warning-50, var(--warning-100))" } : undefined}
            >
              <div style={{ display: "flex", justifyContent: "space-between", gap: 10, alignItems: "baseline" }}>
                <span style={{ fontSize: 11.5, color: "var(--text-secondary)" }}>
                  {index + 1}. {questionLabelOf(q)}
                </span>
                <button
                  type="button"
                  onClick={() => onEdit(index)}
                  style={{ background: "transparent", border: 0, padding: 0, color: "var(--brand-800)", fontSize: 11.5, fontWeight: 600, cursor: "pointer", flexShrink: 0 }}
                >
                  Edit
                </button>
              </div>
              <div style={{ fontWeight: 600, fontSize: 14, color: text ? "var(--text-primary)" : "var(--text-faint)" }}>
                {text || (issue ? issue.problem : "Not answered")}
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <Button variant="secondary" onClick={onBack} disabled={submitting}>Back</Button>
        <Button onClick={onSubmit} disabled={submitting || outstanding.length > 0}>
          {submitting ? "Submitting…" : "Submit survey"}
        </Button>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ done */

function DoneStep({ survey, submittedAt, onBackToList, forced = false }) {
  return (
    <div
      className="survey-step"
      style={{
        background: "var(--surface-base)",
        border: "1px solid var(--border-base)",
        borderRadius: 12,
        padding: "34px 20px",
        display: "grid",
        justifyItems: "center",
        textAlign: "center",
        gap: 10,
      }}
    >
      <div className="survey-done-mark"><IconCheck size={28} /></div>
      <h2 style={{ margin: "6px 0 0", fontSize: 19.5, color: "var(--text-primary)" }}>Thank you — your answers are in</h2>
      <p style={{ margin: 0, maxWidth: "46ch", fontSize: 12.5, color: "var(--text-secondary)", lineHeight: 1.6 }}>
        {surveyTitleOf(survey)} was submitted{submittedAt ? ` on ${formatSubmittedAt(submittedAt)}` : ""}. Your college
        will use this to plan the support you get next term. There is nothing else you need to do.
      </p>
      <p style={{ margin: 0, fontSize: 11.5, color: "var(--text-muted)" }}>
        This survey is now closed to you — it can only be answered once.
      </p>
      <div style={{ marginTop: 6 }}>
        <Button onClick={onBackToList}>{forced ? "Continue to your dashboard" : "Back to surveys"}</Button>
      </div>
    </div>
  );
}
