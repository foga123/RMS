import React from "react";

// Placeholder blocks shown while data loads. The shimmer itself lives in
// global.css as .ui-skeleton so the animation is defined once rather than
// re-declared inline on every element.

export function Skeleton({ width = "100%", height = 10, radius = 5, style = {} }) {
  return (
    <span
      className="ui-skeleton"
      aria-hidden="true"
      style={{
        display: "block",
        width,
        height,
        borderRadius: radius,
        ...style,
      }}
    />
  );
}

// A stack of lines standing in for a paragraph or a wrapped cell value. The last
// line is shortened so the block reads as text rather than a solid slab.
export function SkeletonText({ lines = 3, width = "100%", lastLineWidth = "60%", gap = 6 }) {
  return (
    <span style={{ display: "flex", flexDirection: "column", gap }}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton
          key={index}
          width={index === lines - 1 && lines > 1 ? lastLineWidth : width}
        />
      ))}
    </span>
  );
}

// Varying the cell widths keeps a loading table from looking like graph paper.
// Deterministic per (row, column) so the widths do not jitter between renders.
const CELL_WIDTHS = ["82%", "58%", "70%", "45%", "90%", "64%"];

function cellWidth(rowIndex, columnIndex) {
  return CELL_WIDTHS[(rowIndex * 3 + columnIndex * 2) % CELL_WIDTHS.length];
}

/**
 * Skeleton rows sized to a real table. Renders <tr>/<td> only, so it must be
 * placed inside a <tbody> where the actual rows would go.
 *
 * `columns` accepts either a column count or the same column array the table
 * renders, which keeps call sites from having to hand-count.
 */
export function SkeletonTableRows({ columns = 4, rows = 5, cellPadding = "9px 11px" }) {
  const columnCount = Array.isArray(columns) ? Math.max(columns.length, 1) : Math.max(columns, 1);

  return (
    <>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <tr key={rowIndex}>
          {Array.from({ length: columnCount }, (_, columnIndex) => (
            <td
              key={columnIndex}
              style={{
                padding: cellPadding,
                borderBottom: "1px solid var(--surface-muted)",
                verticalAlign: "middle",
              }}
            >
              <Skeleton width={cellWidth(rowIndex, columnIndex)} />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

export default Skeleton;
