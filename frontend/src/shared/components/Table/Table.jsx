import React from "react";
import { SkeletonTableRows } from "../ui/Skeleton";
import { font } from "../../theme/tokens";

/*
 * Header and cell type come from the token scale rather than a local clamp.
 *
 * The clamps that used to sit here resolved to 11.2px and 12.9px — neither is a
 * step on the scale, and both sat within a pixel of one that is, so tables read
 * as very slightly off from every other surface without looking obviously
 * wrong. The root font-size clamp in global.css already does the viewport
 * scaling these were reaching for.
 */
const headCell = {
  textAlign: "left",
  fontSize: font.size.sm,
  color: "var(--text-secondary)",
  fontWeight: font.weight.semibold,
  padding: "9px 11px",
  borderBottom: "1px solid var(--border-base)",
  whiteSpace: "nowrap",
};

/*
 * `break-word`, not `anywhere`.
 *
 * The two look identical on prose and behave completely differently in a table.
 * `anywhere` also counts toward intrinsic sizing: it tells the layout that a
 * column's min-content width is one character, so auto layout is free to starve
 * any column down to its header and let the value wrap. `break-word` rescues a
 * genuinely unbreakable string (a long email, a URL) from overflowing without
 * lying to the layout about how much room the column needs.
 */
const bodyCell = {
  padding: "9px 11px",
  borderBottom: "1px solid var(--surface-muted)",
  color: "var(--text-primary)",
  fontSize: font.size.md,
  verticalAlign: "top",
  overflowWrap: "break-word",
};

/*
 * A cell that must stay on one line.
 *
 * Every identifier this portal shows is hyphen-delimited — student number
 * 02-2526-000001, section COC-FAB-AB-ENG1-01, school year 2025-2026, course
 * AB-ENG, and a formatted timestamp. CSS breaks a line after a hyphen by
 * default, so under any width pressure these split mid-identifier: "02-2526-"
 * on one line and "000001" on the next, which reads as two different numbers.
 *
 * Columns opt in with `nowrap: true`. Holding the whole value makes the column
 * ask for its real width, and the wrapper below scrolls if the sum no longer
 * fits — a horizontal scrollbar is the honest answer to a table too wide for
 * the screen, where a broken student number is not.
 */
const nowrapCell = { ...bodyCell, whiteSpace: "nowrap" };

export default function Table({
  columns = [],
  rows = [],
  emptyText = "No data found.",
  loading = false,
  skeletonRows = 5,
}) {
  /*
   * A floor that grows with the column count, rather than two fixed steps.
   *
   * 56rem was the floor for six columns and for sixteen alike, so a wide table
   * got the same budget as a narrow one and crammed everything into it. ~7rem a
   * column is about what the content here actually measures. It is only a
   * floor: auto layout still sizes each column to its content, so a table of
   * short columns does not stretch to fill it.
   */
  const minTableWidth = columns.length >= 4 ? `max(100%, ${Math.min(columns.length * 7, 120)}rem)` : "100%";

  return (
    <div
      style={{
        overflowX: "auto",
        overflowY: "hidden",
        maxWidth: "100%",
        border: "1px solid var(--border-base)",
        borderRadius: 9,
        background: "var(--surface-base)",
        scrollbarGutter: "stable",
      }}
    >
      <table style={{ width: "100%", minWidth: minTableWidth, borderCollapse: "collapse", tableLayout: "auto" }}>
        <thead>
          <tr style={{ background: "var(--surface-page)" }}>
            {columns.map((column) => (
              <th key={column.key} style={headCell}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && <SkeletonTableRows columns={columns} rows={skeletonRows} />}
          {!loading && rows.length === 0 && (
            <tr>
              <td colSpan={Math.max(columns.length, 1)} style={{ padding: 12, color: "var(--text-muted)", fontSize: font.size.md }}>
                {emptyText}
              </td>
            </tr>
          )}
          {!loading && rows.map((row, rowIndex) => (
            <tr key={row.id ?? rowIndex}>
              {columns.map((column) => (
                <td key={column.key} style={column.nowrap ? nowrapCell : bodyCell}>
                  {typeof column.render === "function" ? column.render(row) : row[column.key]}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
