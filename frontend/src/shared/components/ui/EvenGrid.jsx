import React from "react";

/**
 * A grid of four that never breaks into three-and-one.
 *
 * `repeat(auto-fit, minmax(min(320px, 100%), 1fr))` fits as many columns as it can, which
 * for four cards means three across and a lone fourth below it with a
 * card-and-a-half of dead space beside it. It is the widest the layout ever
 * looks broken, and it is exactly the width a laptop or a zoomed browser lands
 * on.
 *
 * The fix is to stop asking for four columns. The children are grouped into
 * pairs, the outer grid lays out pairs, and each pair lays out its two children
 * the same way. A pair can only be whole or stacked, so the column count can
 * only be 4, 2 or 1 — three is not a thing the layout can produce:
 *
 *     >= 2*min+gap wide   ->  2 pairs of 2   ->  4 across
 *     >= min*2+gap        ->  1 pair of 2    ->  2 across, 2 rows
 *     narrower            ->  1 pair of 1    ->  1 across, 4 rows
 *
 * Pure CSS and measured against the container, not the viewport, so it responds
 * to browser zoom and to the sidebar collapsing without a media query or a
 * resize listener to keep in step.
 *
 * An odd number of children leaves the last one alone in its pair, where it
 * stretches to the pair's width rather than sitting beside a gap. That is the
 * honest result for an odd count, and this exists for even ones.
 */
export default function EvenGrid({ children, minItem = 320, gap = 12, style }) {
  const items = React.Children.toArray(children);

  const pairs = [];
  for (let index = 0; index < items.length; index += 2) {
    pairs.push(items.slice(index, index + 2));
  }

  const pairMin = minItem * 2 + gap;
  // min(100%, ...) so a track never demands more than the container has — the
  // floor is what would otherwise overflow on a narrow screen.
  const track = (size) => `repeat(auto-fit, minmax(min(100%, ${size}px), 1fr))`;

  return (
    <div style={{ display: "grid", gap, gridTemplateColumns: track(pairMin), ...style }}>
      {pairs.map((pair, index) => (
        <div
          // Positional by nature: the pairs are slices of a fixed list, so the
          // index is their identity rather than a stand-in for one.
          key={`pair-${index}`}
          style={{ display: "grid", gap, gridTemplateColumns: track(minItem), minWidth: 0, alignItems: "stretch" }}
        >
          {pair}
        </div>
      ))}
    </div>
  );
}
