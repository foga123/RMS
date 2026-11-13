import React from "react";

/**
 * One labelled meter: colour dot, name, count, and a proportion bar.
 *
 * Lifted out of RetentionOverview when the faculty overview needed the same
 * thing. It is the shape an overview states a breakdown in — a count you can
 * read and a bar you can compare without reading — and two copies of it would
 * be two things to keep in step for no gain.
 *
 * Deliberately dumb. It takes a value and a total and draws them; it does not
 * know what a priority is, or a contact state, or which colour means urgent.
 * Every caller supplies its own accent, because the palettes differ by screen
 * on purpose and centralising them here would be the opposite of this split.
 *
 * @param {string} accent   the bar and dot colour
 * @param {string} label    what is being counted
 * @param {string} [hint]   a quiet qualifier after the label
 * @param {number} value    this slice
 * @param {number} total    the whole, for the proportion; 0 draws an empty bar
 */
export default function MeterRow({ accent, label, hint, value, total }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : 0;
  return (
    <div style={{ display: "grid", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span aria-hidden="true" style={{ width: 10, height: 10, borderRadius: 3, background: accent, flex: "0 0 auto" }} />
        <span style={{ color: "var(--text-primary)", fontSize: 12.5, fontWeight: 600 }}>{label}</span>
        {hint ? <span style={{ color: "var(--text-faint)", fontSize: 10.5 }}>{hint}</span> : null}
        <span style={{ marginLeft: "auto", color: "var(--text-primary)", fontSize: 12.5, fontWeight: 700 }}>{value}</span>
      </div>
      <div style={{ height: 7, borderRadius: 999, background: "var(--surface-page)", border: "1px solid var(--border-base)", overflow: "hidden" }}>
        <div style={{ width: `${pct}%`, height: "100%", background: accent, borderRadius: 999, transition: "width 240ms ease" }} />
      </div>
    </div>
  );
}
