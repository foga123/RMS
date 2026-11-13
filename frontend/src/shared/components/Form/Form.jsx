import React from "react";
import { font } from "../../theme/tokens";

/*
 * Controls sit at the body step of the scale. The clamp this replaces topped
 * out at 13.3px — between the 12.5px body step and the 14px one above it — so
 * an input was very slightly larger than the text around it on every form.
 */
const controlStyle = {
  width: "100%",
  padding: "8px 9px",
  fontSize: font.size.md,
  border: "1px solid var(--border-base)",
  borderRadius: 8,
  boxSizing: "border-box",
  background: "var(--surface-base)",
  color: "var(--text-primary)",
  minWidth: 0,
};

export default function Form({ children, onSubmit, style }) {
  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: 9, ...style }}>
      {children}
    </form>
  );
}

export function FormField({ label, htmlFor, required = false, children }) {
  return (
    <div>
      <label htmlFor={htmlFor} style={{ display: "block", fontSize: 10.5, color: "var(--text-muted)", marginBottom: 3 }}>
        {label}
        {required && <span style={{ color: "var(--danger-500)" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

export function FormActions({ children }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", gap: 6, flexWrap: "wrap" }}>
      {children}
    </div>
  );
}

export function InputControl({ style, ...props }) {
  return <input style={{ ...controlStyle, ...style }} {...props} />;
}

export function SelectControl({ children, style, ...props }) {
  return (
    <select style={{ ...controlStyle, ...style }} {...props}>
      {children}
    </select>
  );
}

export function TextareaControl({ style, ...props }) {
  return <textarea style={{ ...controlStyle, resize: "vertical", ...style }} {...props} />;
}
