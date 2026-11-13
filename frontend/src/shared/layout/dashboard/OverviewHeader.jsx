import React from "react";
import { color, font } from "../../theme/tokens";
import Button from "../../components/ui/Button";

/**
 * The landing header for every role dashboard.
 *
 * It used to render the word "Overview" over "You are logged in as Dean." — a
 * generic heading and a subtitle restating what the account menu already
 * shows. Nothing said whose data was on screen, which department or campus it
 * covered, or how current it was, so the same page appeared for every role and
 * told none of them anything.
 *
 * It now greets the person and states the scope the numbers below are drawn
 * from. Scope is the part that actually matters: a dean's totals cover one
 * department, and until this said so the reader had to assume it.
 *
 * Callers passing only `title` or `roleLabel` keep their previous output, so
 * this stays safe for the places that render it as a plain section heading.
 */

function greeting(date) {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function firstNameOf(user) {
  const first = String(user?.first_name || "").trim();
  if (first) return first;
  const full = String(user?.full_name || user?.name || "").trim();
  if (full) return full.split(/\s+/)[0];
  const email = String(user?.email || user?.email_address || "").trim();
  return email ? email.split("@")[0] : "";
}

const chipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "3px 8px",
  borderRadius: 999,
  border: `1px solid ${color.border.base}`,
  background: color.surface.subtle,
  color: color.text.secondary,
  fontSize: 10.5,
  fontWeight: 600,
  whiteSpace: "nowrap",
};

/**
 * The term this screen is working in: one object, not three chips.
 *
 * Two grounds inside one pill. The periodical sits on solid brand and is the
 * only inverse-on-accent thing in the header, because it is the part that moves
 * during a semester and the part a faculty account is gated on - P1 and P2 are
 * theirs to act in, P3 is not. The semester and year are the context it sits
 * in, so they stay on the tint and read as quiet.
 *
 * As three equal grey chips this was invisible: same weight, same colour and
 * same shape as the role chip next to it, so the one fact people kept asking
 * for looked like metadata. The pill is deliberately the only accent element in
 * the header, so nothing competes with it.
 *
 * Renders nothing at all when the calendar had nothing to say. A badge with an
 * empty middle is worse than no badge: it says the screen tried and failed,
 * on a screen where that is not the reader's problem to solve.
 */
function TermBadge({ term }) {
  const period = String(term?.period || "");
  const label = String(term?.label || "");
  if (!period && !label) return null;

  return (
    <span
      title="The term this workspace is working in"
      style={{
        display: "inline-flex",
        alignItems: "stretch",
        borderRadius: 999,
        border: `1px solid ${color.border.brand}`,
        background: color.surface.brand,
        // The two grounds meet at a hard edge, so the pill has to clip them.
        overflow: "hidden",
        /*
         * Sized to be read, not to fit in. This is the only element in the
         * header a person comes looking for, and at chip size it read as one
         * more label in a row of labels. It now sits between the body copy and
         * the page title, which is the weight of a thing you are meant to
         * notice once and then stop thinking about.
         */
        fontSize: 14,
        fontWeight: 700,
        lineHeight: 1,
        whiteSpace: "nowrap",
        // Digits in P1/P2/P3 and in a school year should not shift width
        // between terms, which is what makes a header look unstable.
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {period ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "9px 13px",
            background: color.text.brand,
            color: color.text.inverse,
            // The loud half is a size ahead of the quiet half, so the hierarchy
            // survives the pill getting bigger rather than flattening into two
            // equally shouty halves. 16 against the 14 on the wrapper: one step
            // on the scale, which is what "a size ahead" now means literally.
            fontSize: 16,
            letterSpacing: 0.6,
          }}
        >
          {period}
        </span>
      ) : null}
      {label ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: period ? "9px 14px" : "9px 16px",
            color: color.text.brand,
            fontWeight: 600,
          }}
        >
          {label}
        </span>
      ) : null}
      {/* A closed semester refuses what these workspaces record, so the pill
          says so on the part people already read. The sentence is under the
          header - see OverviewHeader. */}
      {term?.closed ? (
        <span
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "9px 12px",
            background: "var(--warning-100, #fef3c7)",
            color: "var(--warning-800, #92400e)",
            fontSize: 12.5,
            letterSpacing: 0.3,
          }}
        >
          Closed
        </span>
      ) : null}
    </span>
  );
}

export default function OverviewHeader({
  title,
  subtitle,
  roleLabel,
  user = null,
  scope = [],
  // From currentTermBadge(). Separate from `scope` on purpose: Department and
  // Campus say WHOSE data this is, and the term says WHEN. Folding the second
  // into the first is what made it disappear.
  term = null,
  accent = color.text.brand,
  /*
   * One optional shortcut into the work this dashboard is about, as
   * `{ label, onClick }`.
   *
   * It lives here because three dashboards used to stack a WelcomeCard on top
   * of this header: two greetings, one above the other, saying the same thing
   * in two different type sizes and costing about 220px before any content.
   * The card carried the shortcut button, so folding the greeting in without
   * somewhere for that button to go would have dropped a real action.
   */
  action = null,
  style,
}) {
  const now = new Date();
  const name = firstNameOf(user);

  // A named greeting only when there is a name to use — "Good afternoon," with
  // nothing after it reads worse than the plain title.
  const heading = title || (name ? `${greeting(now)}, ${name}` : "Overview");

  const description =
    subtitle ?? (roleLabel && !name ? <>You are logged in as <strong>{roleLabel}</strong>.</> : null);

  // Role first, then whatever scope the caller supplied. Empty values are
  // dropped so a dean with no campus recorded does not get a blank chip.
  const chips = [
    roleLabel ? { key: "__role", label: roleLabel, strong: true } : null,
    ...(Array.isArray(scope) ? scope : [])
      .filter((item) => item && item.value)
      .map((item) => ({ key: item.label, label: `${item.label}: ${item.value}` })),
  ].filter(Boolean);

  return (
    <div style={{ display: "grid", gap: 8, ...style }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", justifyContent: "space-between", gap: 8 }}>
        <h2 style={{ margin: 0, color: accent, fontSize: font.size["2xl"], fontWeight: font.weight.semibold, lineHeight: 1.2 }}>
          {heading}
        </h2>
        {/* Beside today's date, not down among the chips. Both answer "when",
            and the reader looking for one is already looking here. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <TermBadge term={term} />
          <span style={{ color: "var(--text-faint)", fontSize: 10.5, whiteSpace: "nowrap" }}>
            {now.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}
          </span>
          {action && action.label ? (
            <Button variant="secondary" onClick={action.onClick}>
              {action.label}
            </Button>
          ) : null}
        </div>
      </div>

      {description ? (
        <p style={{ color: "var(--text-secondary)", margin: 0, fontSize: 14 }}>
          {description}
        </p>
      ) : null}

      {/* Why saves are being refused, before anyone tries one. */}
      {term?.closed ? (
        <p
          role="status"
          style={{
            margin: 0,
            padding: "6px 9px",
            fontSize: 12.5,
            lineHeight: 1.45,
            color: "var(--warning-800, #92400e)",
            background: "var(--warning-50, #fffbeb)",
            border: "1px solid var(--warning-200, #fde68a)",
            borderRadius: 6,
          }}
        >
          {term.closedNote || "This semester is closed, so anything recorded against it will be refused."}
        </p>
      ) : null}

      {chips.length > 0 ? (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
          {chips.map((chip) => (
            <span
              key={chip.key}
              style={
                chip.strong
                  ? { ...chipStyle, borderColor: color.brand.border, background: color.brand.subtle, color: accent }
                  : chipStyle
              }
            >
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
