import React from "react";
import { font } from "../../theme/tokens";

/*
 * The controls on the right come in as `actions` or as children - five screens
 * carried their own copy of this header that took them as children, and
 * accepting both is what let those copies go without rewriting each call.
 */
export default function SectionHeader({ title, subtitle, actions, children, sticky = false, style }) {
  const trailing = actions ?? children;
  const heading = (
    /* Explicitly the section step, rather than whatever <strong> inherits.
       Left implicit it landed on the body size in bold, so a card heading
       and the text inside the card differed only by weight. */
    <strong style={{ color: "var(--text-primary)", fontSize: font.size.lg, fontWeight: font.weight.semibold }}>
      {title}
    </strong>
  );
  return (
    <div
      style={{
        position: sticky ? "sticky" : "static",
        top: sticky ? 0 : undefined,
        zIndex: sticky ? 3 : undefined,
        background: "var(--surface-base)",
        padding: 9,
        borderBottom: "1px solid var(--border-base)",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 9,
        ...style,
      }}
    >
      {/* Fifteen headings were written with a subtitle this component never
          drew. Without one the heading renders exactly as it always has. */}
      {subtitle ? (
        <div style={{ minWidth: 0 }}>
          {heading}
          <p style={{ margin: "3px 0 0", color: "var(--text-muted)", fontSize: font.size.base, lineHeight: 1.45 }}>{subtitle}</p>
        </div>
      ) : (
        heading
      )}
      {trailing ? <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>{trailing}</div> : null}
    </div>
  );
}
