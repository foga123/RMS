import React from "react";
import { color, radius, shadow } from "../../theme/tokens";

/**
 * The card is the only container in the system: white surface, hairline border,
 * soft shadow, on the light grey page. Everything that groups content uses it,
 * so a page never invents its own box.
 *
 * `padding` is a preset rather than a number so spacing stays on the 4/8/12/16/
 * 24/32 scale instead of drifting to whatever each page felt like.
 */
const PADDING = { none: 0, sm: 12, md: 16, lg: 19, xl: 25 };

export default function Card({
  children,
  padding = "md",
  interactive = false,
  accent = false,
  as: Tag = "div",
  className = "",
  style,
  ...rest
}) {
  return (
    <Tag
      className={`${interactive ? "ui-card--interactive" : ""} ${className}`.trim()}
      style={{
        position: "relative",
        background: color.surface.base,
        border: `1px solid ${color.border.base}`,
        borderRadius: radius.xl,
        boxShadow: shadow.card,
        padding: PADDING[padding] ?? PADDING.md,
        // A 3px green rail marks a card that matters. A full green fill would
        // put a large block of colour on every screen; green stays an accent.
        ...(accent
          ? { borderTop: `3px solid ${color.brand.base}`, borderTopLeftRadius: radius.xl, borderTopRightRadius: radius.xl }
          : null),
        ...style,
      }}
      {...rest}
    >
      {children}
    </Tag>
  );
}
