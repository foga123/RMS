import React from "react";
import { color, font, radius, shadow, tone as toneOf } from "../../theme/tokens";

/**
 * One headline number, on a white card lifted off the grey page.
 *
 * The card used to sit on `--surface-page`, the same grey as the page behind
 * it, so a row of them read as one flat band separated only by hairlines. It is
 * white now with a soft shadow, and carries a short coloured rail down its left
 * edge in the card's tone — enough to say "this one is good / this one needs
 * attention" at a glance without filling the whole tile with colour.
 *
 * Colours come from the shared `tone` table, not from hex literals, so success
 * is the same green here as on every chip and meter.
 *
 * A COLUMN, NOT A STACK OF BLOCKS
 *
 * The grid stretches every card in a row to the tallest one, so a card whose
 * caption ran to two lines set the height and the rest kept their captions
 * wherever their own content happened to end -- four cards, four different
 * baselines, and a ragged band of empty white along the bottom. Nothing was
 * wrong with any one card; the row was what read badly.
 *
 * Flex column with the footer pushed down by `marginTop: auto` puts every
 * caption and every meter on one line across the row, whatever is above it.
 */
const cardStyle = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  background: color.surface.base,
  borderWidth: 1,
  borderStyle: "solid",
  borderColor: color.border.base,
  borderRadius: radius.xl,
  boxShadow: shadow.card,
  padding: "clamp(0.875rem, 1vw, 1rem)",
  paddingLeft: "clamp(1rem, 1.1vw, 1.15rem)",
  minWidth: 0,
  overflow: "hidden",
};

/**
 * `meta` is one line under the number saying what it counts.
 *
 * A stat card is read as a fact about everything unless it says otherwise, so a
 * number that answers for one term or excludes something has to carry that with
 * it. Optional: a card counting the obvious thing does not need a caption.
 *
 * `loading` shows a shimmer where the number will be, instead of a bare "-",
 * so a card that is still fetching reads as busy rather than empty. `progress`
 * (0–100) draws a thin tone-coloured meter under the number — used for a rate
 * that is naturally a proportion, such as attendance.
 *
 * `onClick` turns the card into a real <button> — same shape, same colours, but
 * focusable, operable from the keyboard, and announced as pressed or not. A card
 * that filters the table under it is a control, and a <div> with a click handler
 * is a control that only a mouse can reach.
 *
 * `active` draws the selection ring, and it is BRAND-coloured on every card
 * regardless of tone. Which card you picked is a fact about the interface, not
 * about the number: ringing the Priority 1 card in its own red would say the
 * selection is itself alarming, and would leave a neutral card with a grey ring
 * nobody can see. `hint` is its tooltip — say what pressing it does.
 *
 * `filled` trades the rail for the whole tile in the tone's colour. Off by
 * default and meant for the uncommon case where the cards are not separate
 * facts but ONE scale read across — the faculty board's Priority 1 to 4, where
 * the bands are a severity ramp and the colour IS the reading. Used as an
 * ordinary emphasis it would undo what the rail is for: if every card shouts,
 * the row goes back to being a flat band with no card standing out.
 *
 * A `default`-toned filled card takes the muted surface rather than the tone
 * table's `bg`, which for `default` is the card's own white — filling it would
 * be indistinguishable from not filling it, and the quiet end of a ramp still
 * has to look like part of the ramp.
 */
export function StatCard({
  label,
  value,
  tone = "default",
  meta = "",
  loading = false,
  progress = null,
  onClick = null,
  active = false,
  hint = "",
  filled = false,
}) {
  const t = toneOf(tone);
  const fill = filled
    ? {
        background: tone === "default" ? color.surface.muted : t.bg,
        borderColor: t.border,
      }
    : null;
  const hasProgress = progress !== null && progress !== undefined && Number.isFinite(Number(progress));
  const pct = hasProgress ? Math.max(0, Math.min(100, Number(progress))) : 0;

  const interactive = typeof onClick === "function";
  const Tag = interactive ? "button" : "div";

  return (
    <Tag
      {...(interactive
        ? {
            type: "button",
            onClick,
            "aria-pressed": active,
            title: hint || undefined,
            /*
             * The same hover and focus ring Card.jsx uses for a card that
             * opens something -- lift, brand border, visible focus outline.
             * A clickable stat card looked exactly like a static one, so the
             * only way to find out a card filtered the table under it was to
             * click one and watch. Reused rather than written again: two
             * different hovers for one gesture would read as two kinds of
             * card, and :hover cannot be expressed in a style object.
             */
            className: "ui-card--interactive",
          }
        : {})}
      style={{
        ...cardStyle,
        // Before `active`, so a selected filled card still gets its ring.
        ...fill,
        // A <button> brings its own font, centring and border box; the card has
        // to look identical whether or not it happens to be pressable.
        ...(interactive
          ? { width: "100%", textAlign: "left", font: "inherit", cursor: "pointer" }
          : null),
        ...(active
          ? {
              borderColor: color.brand.base,
              boxShadow: `${shadow.card}, inset 0 0 0 1px ${color.brand.base}`,
            }
          : null),
      }}
    >
      {/* The tone rail. Neutral cards get a quiet grey edge so every card still
          shares the same shape; a good or bad card gets its colour. A filled
          card has already said this in the tile, and drawing the rail on top of
          its own colour only muddies the left edge. */}
      {filled ? null : (
        <span
          aria-hidden="true"
          style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: t.accent, borderTopLeftRadius: radius.xl, borderBottomLeftRadius: radius.xl }}
        />
      )}

      {/* The label is what the number answers, so it reads as a question in
          secondary ink rather than as a caption in muted grey. It was the
          same weight and nearly the same colour as the `meta` line three
          rows below it, which made the two swap roles at a glance. */}
      <div
        style={{
          color: color.text.secondary,
          fontSize: font.size.sm,
          fontWeight: 600,
          lineHeight: 1.3,
          overflowWrap: "anywhere",
        }}
      >
        {label}
      </div>

      {loading ? (
        <div className="ui-skeleton" style={{ height: "1.6rem", width: "60%", borderRadius: radius.sm, margin: "0.15rem 0" }} aria-hidden="true" />
      ) : (
        <div
          style={{
            fontSize: font.size["3xl"],
            fontWeight: 700,
            color: t.text,
            lineHeight: 1.15,
            marginTop: "0.1rem",
            overflowWrap: "anywhere",
            /* Digits of one width, so 1,027 and 2,776 line up down a column
               of cards and a refresh does not shuffle the number sideways. */
            fontVariantNumeric: "tabular-nums",
          }}
        >
          {value ?? "-"}
        </div>
      )}

      {/* Everything below the number, pushed to the foot of the card. See
          cardStyle: this is what puts the row on one baseline. */}
      <div style={{ marginTop: "auto" }}>
        {hasProgress && !loading ? (
          <div
            style={{ height: 5, borderRadius: radius.pill, background: color.surface.muted, overflow: "hidden", margin: "0.5rem 0 0.35rem" }}
            role="presentation"
          >
            <div style={{ height: "100%", width: `${pct}%`, background: t.accent, borderRadius: radius.pill, transition: "width 320ms cubic-bezier(0.4, 0, 0.2, 1)" }} />
          </div>
        ) : null}

        {meta ? (
          <div
            style={{
              color: color.text.muted,
              fontSize: font.size.xs,
              lineHeight: 1.4,
              marginTop: hasProgress ? 0 : "0.4rem",
              overflowWrap: "anywhere",
            }}
          >
            {meta}
          </div>
        ) : null}
      </div>
    </Tag>
  );
}

export function StatCardGrid({ children, minWidth = 180 }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(auto-fit, minmax(min(100%, ${minWidth}px), 1fr))`,
        gap: "clamp(0.75rem, 1vw, 1rem)",
        width: "100%",
      }}
    >
      {children}
    </div>
  );
}
