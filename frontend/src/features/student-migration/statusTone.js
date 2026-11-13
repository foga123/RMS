/** Shared status colouring so the dashboard strip and the full page never disagree. */
import { enrollmentStatusKind } from "../../shared/lib/enrollmentStatusKind";

export const NO_STATUS = "none";

export const STATUS_TONES = {
  good: { bg: "var(--brand-100)", fg: "var(--brand-800)", br: "var(--brand-200)" },
  info: { bg: "var(--surface-page)", fg: "var(--text-primary)", br: "var(--border-strong)" },
  warn: { bg: "var(--warning-50)", fg: "var(--warning-800)", br: "var(--warning-200)" },
  bad: { bg: "var(--danger-100)", fg: "var(--danger-800)", br: "var(--danger-200)" },
  neutral: { bg: "var(--surface-page)", fg: "var(--text-primary)", br: "var(--border-base)" },
};

/**
 * Matched on the status name rather than its id, so a status added in Status
 * Management still colours sensibly. What a name MEANS is decided once, in
 * enrollmentStatusKind(); this only picks the colour for it.
 */
export function statusToneFor(statusName, statusId) {
  if (statusId === NO_STATUS) return "warn";

  const kind = enrollmentStatusKind(statusName);
  if (kind === "not_continuing" || kind === "moving") return "bad";
  if (kind === "graduating" || String(statusName || "").trim().toLowerCase() === "enrolled") return "good";
  if (kind === "continuing") return "info";
  return "neutral";
}

/**
 * Statuses that need a written reason to be worth anything.
 *
 * A bare "To Stop" tells a retention officer that a student is leaving but not
 * what could have kept them — "personal problem", "financial", "transferring
 * home". "Others" is included because the label says nothing by itself.
 */
export function statusNeedsRemark(statusName) {
  const name = String(statusName || "").toLowerCase();
  if (name.includes("other")) return true;
  return statusToneFor(statusName) === "bad";
}
