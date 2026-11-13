import React from "react";

/**
 * One pill, used everywhere.
 *
 * The same span — 5px/9px padding, 999 radius, 11px uppercase 700 with 0.04em
 * tracking — was written out three times across the role-access screens
 * (StatusBadge, AccessTypeBadge, ModuleAccessBadge) and reinvented in a dozen
 * feature files. Worse, the shared-looking one took its colours as three raw
 * hex props, so every call site hand-picked `color`, `background` and
 * `borderColor` and the token scale was bypassed entirely.
 *
 * `tone` is the intended API. `palette` exists because the module-access and
 * permission-action helpers already return {label, color, background,
 * borderColor} objects; rewriting those is a separate job, and forcing them
 * through a tone they do not have would lose meaning.
 */
const TONES = {
  neutral: {
    color: "var(--text-secondary)",
    background: "var(--surface-page)",
    borderColor: "var(--border-strong)",
  },
  brand: {
    color: "var(--brand-800)",
    background: "var(--brand-100)",
    borderColor: "var(--brand-200)",
  },
  success: {
    color: "var(--brand-700)",
    background: "var(--brand-100)",
    borderColor: "var(--brand-200)",
  },
  warning: {
    color: "var(--warning-800)",
    background: "var(--warning-100)",
    borderColor: "var(--warning-200)",
  },
  danger: {
    color: "var(--danger-800)",
    background: "var(--danger-100)",
    borderColor: "var(--danger-200)",
  },
  info: {
    color: "var(--info-800)",
    background: "var(--info-100)",
    borderColor: "var(--info-200)",
  },
};

export default function Badge({ tone = "neutral", palette, children, label, style }) {
  const resolved = palette || TONES[tone] || TONES.neutral;

  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        padding: "4px 7px",
        borderRadius: 999,
        border: `1px solid ${resolved.borderColor}`,
        background: resolved.background,
        color: resolved.color,
        fontSize: 10.5,
        fontWeight: 700,
        letterSpacing: "0.04em",
        textTransform: "uppercase",
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children ?? label ?? resolved.label}
    </span>
  );
}
