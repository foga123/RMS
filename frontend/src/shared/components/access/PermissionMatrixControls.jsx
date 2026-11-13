import React from "react";

/**
 * The pieces the two permission matrices share: the role matrix in Settings ->
 * Role Access, and the per-user override in Users -> Custom Access.
 *
 * Each screen used to carry its own identical copy of all three. They are the
 * same control on the same kind of grid, so a change to how a checkbox cell
 * looks or how the module search matches has to land on both at once.
 */

function normalizeQuery(value) {
  return String(value || "").trim().toLowerCase();
}

/** Does any of these fields contain the search text? An empty search matches everything. */
export function matchesQuery(values, query) {
  const normalizedQuery = normalizeQuery(query);
  if (!normalizedQuery) return true;
  return values.some((value) => String(value || "").toLowerCase().includes(normalizedQuery));
}

/** One action's checkbox in a matrix cell, centred and labelled for screen readers. */
export function ActionToggle({ checked, disabled, label, onChange }) {
  return (
    <label
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: "100%",
        minHeight: 29,
        cursor: disabled ? "not-allowed" : "pointer",
      }}
      aria-label={label}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={onChange}
        style={{
          width: 14,
          height: 14,
          accentColor: "var(--brand-700)",
          cursor: disabled ? "not-allowed" : "pointer",
        }}
      />
    </label>
  );
}
