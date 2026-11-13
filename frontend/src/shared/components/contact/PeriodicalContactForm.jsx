import React, { useMemo } from "react";
import Button from "../ui/Button";
import { contactDetailMissing, findReason } from "../../lib/reasonDetail";

/**
 * The form for recording one periodical contact: how, what came of it, and why.
 *
 * Two screens ask this question now — the Faculty Workspace, where a teacher
 * acts on their own department's board, and the PDO prioritisation list, where
 * a Dean acts on the same students from the retention side. The same student
 * can be worked from either, so the form is one component and the write behind
 * it is one function (faculty_record_periodical_contact in the backend lib).
 * Two forms would have drifted the first time an outcome was added.
 *
 * What is NOT decided here, on purpose:
 *
 *   which outcomes exist, and which of them must give a reason — the server
 *   sends `needs_reason` on each option;
 *   which reasons need free text — the server sends `needs_detail` on each;
 *   whether the reader may record at all — the caller renders this or does not.
 *
 * A second copy of any of those in the browser is a rule that can disagree with
 * the one that actually gates the write.
 *
 * The draft is the caller's state. This component only reports edits back,
 * because the caller is the one that has to clear it after a successful save
 * and to send it to whichever endpoint it belongs to.
 */

const controlStyle = {
  padding: "6px 8px",
  border: "1px solid var(--border-strong)",
  borderRadius: 6,
  background: "#fff",
  fontSize: 12.5,
};

export const DEFAULT_CONTACT_METHOD = "f2f";

/** An empty contact, in the shape both screens post. */
export function createContactDraft() {
  return {
    contact_method: DEFAULT_CONTACT_METHOD,
    outcome: "",
    reason_id: "",
    other_reason_label: "",
    note: "",
  };
}

/**
 * Whether the draft is complete enough to send.
 *
 * Exported because the caller owns the submit button's disabled state on the
 * screens that place it themselves, and because a form that decides this
 * privately cannot be asked.
 */
export function contactDraftIncomplete(draft, settings) {
  const outcome = (settings?.outcomes || []).find((option) => option.key === draft?.outcome) || null;
  if (!draft?.outcome) return true;

  /*
   * An outcome that must explain itself needs the REASON picked, not only the
   * free text under it.
   *
   * contactDetailMissing() covers the free-text box alone, so until now
   * choosing "Stopping" and leaving the reason blank left Record enabled and
   * the save came back 400 — "a student who is not continuing needs a reason".
   * That is precisely the trip that module's own comment set out to save, and
   * the dropdown is visible on screen, so disabling here reads as a missing
   * answer rather than as a broken button.
   */
  if (outcome?.needs_reason && !draft.reason_id) return true;

  return contactDetailMissing(
    {
      outcomeNeedsReason: Boolean(outcome?.needs_reason),
      reasonId: draft.reason_id,
      detail: draft.other_reason_label,
    },
    settings?.reasons,
  );
}

export default function PeriodicalContactForm({
  /** { outcomes, reasons, channels } — all three from the server. */
  settings,
  draft,
  onChange,
  onSubmit,
  saving = false,
  /** The heading above the controls; pass null to render none. */
  heading,
  submitLabel = "Record contact",
  /** Prefix for the form control names, so two forms on one page stay distinct. */
  namePrefix = "contact",
}) {
  /*
   * Home Visit is not offered.
   *
   * It is a different piece of work with its own workspace, its own escalation
   * and its own record — logging one here would file a visit as a phone call
   * and leave the Home Visit board none the wiser. Filtered rather than removed
   * from the server's list, which the visit workspace still needs.
   */
  const channels = useMemo(() => {
    const offered = (settings?.channels || []).filter((channel) => channel.key !== "home_visit");
    return offered.length ? offered : [{ key: DEFAULT_CONTACT_METHOD, label: "F2F" }];
  }, [settings?.channels]);

  const selectedOutcome = useMemo(
    () => (settings?.outcomes || []).find((option) => option.key === draft.outcome) || null,
    [settings?.outcomes, draft.outcome],
  );

  const selectedReason = useMemo(
    () => findReason(settings?.reasons, draft.reason_id),
    [settings?.reasons, draft.reason_id],
  );

  const needsReasonDetail = Boolean(selectedOutcome?.needs_reason && selectedReason?.needs_detail);
  const incomplete = contactDraftIncomplete(draft, settings);

  const edit = (patch) => onChange((current) => ({ ...current, ...patch }));

  return (
    <div style={{ display: "grid", gap: 8 }}>
      {heading ? (
        <h4 style={{ margin: 0, color: "var(--text-primary)" }}>{heading}</h4>
      ) : null}

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 220px), 1fr))" }}>
        <select
          value={draft.contact_method}
          onChange={(event) => edit({ contact_method: event.target.value })}
          style={controlStyle}
          name={`${namePrefix}_method`}
          aria-label="How contacted"
        >
          {channels.map((channel) => (
            <option key={channel.key} value={channel.key}>{channel.label}</option>
          ))}
        </select>

        <select
          value={draft.outcome}
          onChange={(event) => edit({ outcome: event.target.value })}
          style={controlStyle}
          name={`${namePrefix}_outcome`}
          aria-label="Outcome"
        >
          <option value="">Select an outcome</option>
          {(settings?.outcomes || []).map((option) => (
            <option key={option.key} value={option.key}>{option.label}</option>
          ))}
        </select>

        {/* Only for outcomes the server says must explain themselves. */}
        {selectedOutcome?.needs_reason ? (
          <select
            value={draft.reason_id}
            /* The free text belongs to the reason, so changing the reason
               clears it. Otherwise switching from "Health - Others" to
               "Health - Pregnancy" leaves the typed words attached to a reason
               that never asked for them. */
            onChange={(event) => edit({ reason_id: event.target.value, other_reason_label: "" })}
            style={controlStyle}
            name={`${namePrefix}_reason`}
            aria-label="Reason"
          >
            <option value="">Select a reason</option>
            {(settings?.reasons || []).map((group) => (
              group.reasons ? (
                <optgroup key={group.category} label={group.category}>
                  {group.reasons.map((reason) => (
                    <option key={reason.reason_id} value={String(reason.reason_id)}>
                      {reason.reason_text}
                    </option>
                  ))}
                </optgroup>
              ) : (
                <option key={group.reason_id} value={String(group.reason_id)}>{group.reason_text}</option>
              )
            ))}
          </select>
        ) : null}
      </div>

      {/* The escape-hatch reasons ask which one. Server-flagged, so a reason
          the office adds next term brings its own box. */}
      {needsReasonDetail ? (
        <label style={{ display: "grid", gap: 4, fontSize: 11.5, color: "var(--text-secondary)" }}>
          <span>
            {selectedReason?.reason_text} — say which
            <span style={{ color: "var(--danger-700)" }}> *</span>
          </span>
          <input
            value={draft.other_reason_label}
            onChange={(event) => edit({ other_reason_label: event.target.value })}
            maxLength={160}
            placeholder="In a few words, e.g. mother lost her job in July"
            style={{ ...controlStyle, width: "100%", boxSizing: "border-box" }}
            name={`${namePrefix}_other_reason`}
          />
        </label>
      ) : null}

      <textarea
        value={draft.note}
        onChange={(event) => edit({ note: event.target.value })}
        rows={2}
        placeholder="What was said, and what happens next"
        style={{ ...controlStyle, width: "100%", boxSizing: "border-box" }}
        name={`${namePrefix}_note`}
      />

      <div>
        <Button onClick={() => void onSubmit()} disabled={saving || incomplete}>
          {saving ? "Recording..." : submitLabel}
        </Button>
      </div>
    </div>
  );
}
