import React from "react";

/**
 * Base look, sizes and variants live in global.css (`.ui-btn*`).
 *
 * They used to be inline style objects here, which meant no hover, no :active
 * and no :focus-visible anywhere in the app — a pseudo-class cannot be
 * expressed inline. The `style` prop is still spread last so the call sites
 * that recolour a button inline keep overriding the variant.
 */
/**
 * Written out as whole literals rather than built with `ui-btn--${variant}`.
 * Tailwind scans source text to decide what to keep, so an interpolated class
 * name is never seen and every variant rule gets purged from the bundle —
 * leaving the buttons with base styles and no colour at all.
 */
const VARIANT_CLASS = {
  primary: "ui-btn--primary",
  secondary: "ui-btn--secondary",
  danger: "ui-btn--danger",
  ghost: "ui-btn--ghost",
  link: "ui-btn--link",
};

const SIZE_CLASS = {
  sm: "ui-btn--sm",
  md: "ui-btn--md",
  lg: "ui-btn--lg",
};

export default function Button({
  children,
  type = "button",
  variant = "primary",
  size = "md",
  className = "",
  style,
  disabled = false,
  ...rest
}) {
  const variantClass = VARIANT_CLASS[variant] || VARIANT_CLASS.primary;
  const sizeClass = SIZE_CLASS[size] || SIZE_CLASS.md;

  return (
    <button
      type={type}
      disabled={disabled}
      className={`ui-btn ${variantClass} ${sizeClass} ${className}`.trim()}
      style={style}
      {...rest}
    >
      {children}
    </button>
  );
}
