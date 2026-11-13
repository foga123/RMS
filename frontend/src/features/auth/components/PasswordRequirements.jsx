import React from "react";
import { getPasswordChecks } from "../../../shared/lib/passwordValidation";

/**
 * Live checklist of password requirements. Each rule turns green as the typed
 * password satisfies it. Uses inline styles so it renders consistently inside
 * both the Tailwind auth screens and the admin management forms.
 */
export default function PasswordRequirements({ value, style, showWhenEmpty = true }) {
  const checks = getPasswordChecks(value);
  const hasValue = String(value ?? "").length > 0;

  if (!hasValue && !showWhenEmpty) {
    return null;
  }

  return (
    <ul
      aria-label="Password requirements"
      style={{
        listStyle: "none",
        margin: 0,
        padding: 0,
        display: "grid",
        gap: 3,
        ...style,
      }}
    >
      {checks.map((check) => (
        <li
          key={check.id}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 5,
            fontSize: 11,
            lineHeight: 1.35,
            color: check.passed ? "#059669" : "#94a3b8",
          }}
        >
          <span aria-hidden="true" style={{ fontWeight: 700, width: 12, textAlign: "center" }}>
            {check.passed ? "✓" : "○"}
          </span>
          <span>{check.label}</span>
        </li>
      ))}
    </ul>
  );
}
