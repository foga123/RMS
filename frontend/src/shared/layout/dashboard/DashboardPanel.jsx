import React from "react";

const VARIANTS = {
  default: {
    background: "var(--surface-base)",
    border: "1px solid var(--border-base)",
    color: "var(--text-primary)",
  },
  muted: {
    background: "var(--surface-page)",
    border: "1px solid var(--border-base)",
    color: "var(--neutral-700)",
  },
  dashed: {
    background: "var(--surface-page)",
    border: "1px dashed var(--border-strong)",
    color: "var(--text-muted)",
  },
};

export default function DashboardPanel({ children, variant = "default", style }) {
  const palette = VARIANTS[variant] || VARIANTS.default;
  return (
    <div
      style={{
        borderRadius: 12,
        padding: "clamp(0.875rem, 1vw, 1rem)",
        maxWidth: "100%",
        minWidth: 0,
        ...palette,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
