import React from "react";

const toneStyles = {
  error: { background: "var(--danger-100)", borderColor: "var(--danger-200)", color: "var(--danger-800)" },
  success: { background: "var(--brand-100)", borderColor: "var(--brand-200)", color: "var(--brand-800)" },
  info: { background: "var(--brand-50)", borderColor: "var(--brand-200)", color: "var(--brand-700)" },
  warning: { background: "var(--warning-50)", borderColor: "var(--warning-200)", color: "var(--warning-800)" },
};

/**
 * `role` defaults from the tone rather than being left off.
 *
 * These boxes carried no ARIA at all, so a refused save was announced to a
 * screen reader exactly as loudly as it was shown to somebody looking at the
 * wrong corner of the page: not at all. An error is assertive, because the
 * action the reader just took did not happen; anything else is polite, so a
 * success does not interrupt what they are typing next.
 */
export default function AlertMessage({ message, tone = "info", style, role }) {
  if (!message) return null;
  const palette = toneStyles[tone] || toneStyles.info;
  const resolvedRole = role || (tone === "error" ? "alert" : "status");

  return (
    <div
      role={resolvedRole}
      aria-live={resolvedRole === "alert" ? "assertive" : "polite"}
      style={{
        background: palette.background,
        border: `1px solid ${palette.borderColor}`,
        color: palette.color,
        borderRadius: 6,
        padding: "8px 9px",
        marginBottom: 9,
        ...style,
      }}
    >
      {message}
    </div>
  );
}
