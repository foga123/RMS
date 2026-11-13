/**
 * Design tokens — the single source of truth for the portal's look.
 *
 * The theme is white surfaces on a near-white page, with one green scale
 * (PHINMA COC green) carrying every accent. Before this file the codebase had
 * three unrelated greens (#065f46, #059669, #047857) plus cyan, teal, amber and
 * blue accents; everything now resolves to `brand` so the palette reads as one
 * deliberate choice rather than an accumulation.
 *
 * Tokens are exported twice on purpose:
 *   - `color`, `radius`, ... for the inline `style={{}}` blocks the components
 *     already use, so adoption needs no rewrite of a component's structure.
 *   - CSS custom properties (see global.css) for stylesheets and Tailwind
 *     arbitrary values.
 * Both are generated from the same `palette` below, so they cannot drift.
 */

/** Raw scales. Prefer the semantic `color` aliases below in components. */
export const palette = {
  // PHINMA COC green. Matches tailwind.config.js `primary`.
  brand: {
    50: "#ecfdf5",
    100: "#d1fae5",
    200: "#a7f3d0",
    300: "#6ee7b7",
    400: "#34d399",
    500: "#10b981",
    600: "#059669",
    700: "#047857",
    800: "#065f46",
    900: "#064e3b",
    950: "#022c22",
  },
  // Neutrals carry structure: page, cards, borders, body copy.
  neutral: {
    0: "#ffffff",
    50: "#f8fafc",
    100: "#f1f5f9",
    200: "#e2e8f0",
    300: "#cbd5e1",
    400: "#94a3b8",
    500: "#64748b",
    600: "#475569",
    700: "#334155",
    800: "#1e293b",
    900: "#0f172a",
  },
  // Status colours stay conventional — red must read as danger even in a green
  // theme — but are muted so they sit beside the brand without shouting.
  danger: { 50: "#fef2f2", 100: "#fee2e2", 200: "#fecaca", 500: "#ef4444", 600: "#dc2626", 700: "#b91c1c", 800: "#991b1b" },
  warning: { 50: "#fffbeb", 100: "#fef3c7", 200: "#fde68a", 500: "#f59e0b", 600: "#d97706", 700: "#b45309", 800: "#92400e" },
  info: { 50: "#f0f9ff", 100: "#e0f2fe", 200: "#bae6fd", 500: "#0ea5e9", 600: "#0284c7", 700: "#0369a1", 800: "#075985" },
};

/** Semantic aliases — what components should reach for. */
export const color = {
  surface: {
    page: palette.neutral[50],
    base: palette.neutral[0],
    subtle: palette.neutral[50],
    muted: palette.neutral[100],
    brand: palette.brand[50],
    brandMuted: palette.brand[100],
    inverse: palette.brand[800],
  },
  border: {
    subtle: palette.neutral[200],
    base: palette.neutral[200],
    strong: palette.neutral[300],
    brand: palette.brand[200],
    focus: palette.brand[500],
  },
  text: {
    primary: palette.neutral[900],
    secondary: palette.neutral[600],
    muted: palette.neutral[500],
    faint: palette.neutral[400],
    inverse: palette.neutral[0],
    brand: palette.brand[800],
    brandStrong: palette.brand[900],
  },
  brand: {
    subtle: palette.brand[50],
    muted: palette.brand[100],
    border: palette.brand[200],
    base: palette.brand[600],
    hover: palette.brand[700],
    active: palette.brand[800],
    strong: palette.brand[800],
    contrast: palette.neutral[0],
  },
  status: {
    successBg: palette.brand[50],
    successBorder: palette.brand[200],
    successText: palette.brand[800],
    dangerBg: palette.danger[100],
    dangerBorder: palette.danger[200],
    dangerText: palette.danger[800],
    warningBg: palette.warning[100],
    warningBorder: palette.warning[200],
    warningText: palette.warning[800],
    infoBg: palette.info[100],
    infoBorder: palette.info[200],
    infoText: palette.info[800],
  },
};

/**
 * Sizing runs about 12-20% tighter than it first shipped. At 100% browser zoom
 * the portal read as an oversized mock-up: 20px card padding, 16px corners and
 * a 13px body size that inherited 16px wherever a token was missing. The scale
 * below is the same ladder, stepped down — type ~12% smaller with a 10.5px
 * floor, spacing and corners ~20% — so a screen fits more without any layout
 * being re-thought.
 */
/**
 * Status tones, resolved once.
 *
 * Cards, chips and meters all told the same story a different way — StatCard
 * hardcoded `#047857`/`#b91c1c`/`#0f172a`, OverviewHeader hardcoded a green
 * chip, and each new surface guessed again. They now share this one table, so
 * "success" is the same green everywhere and the palette can move in one edit.
 *
 * `text` is for a value or label; `bg`/`border` are the soft fill of a chip or
 * pill; `accent` is a solid rail or dot that marks the tone without a fill.
 */
export const statusTone = {
  default: { text: color.text.primary, bg: color.surface.base, border: color.border.base, accent: color.border.strong },
  brand:   { text: color.text.brand, bg: color.brand.subtle, border: color.brand.border, accent: color.brand.base },
  success: { text: color.status.successText, bg: color.status.successBg, border: color.status.successBorder, accent: palette.brand[500] },
  danger:  { text: color.status.dangerText, bg: color.status.dangerBg, border: color.status.dangerBorder, accent: palette.danger[500] },
  warning: { text: color.status.warningText, bg: color.status.warningBg, border: color.status.warningBorder, accent: palette.warning[500] },
  info:    { text: color.status.infoText, bg: color.status.infoBg, border: color.status.infoBorder, accent: palette.info[500] },
};

/** The tone table for `name`, falling back to the neutral default. */
export function tone(name) {
  return statusTone[name] || statusTone.default;
}

export const radius = {
  xs: 5,
  sm: 6,
  md: 8,
  lg: 9,
  xl: 12,
  "2xl": 16,
  pill: 9999,
};

export const shadow = {
  none: "none",
  sm: "0 1px 2px rgba(15, 23, 42, 0.05)",
  card: "0 10px 30px -22px rgba(15, 23, 42, 0.35)",
  panel: "0 18px 40px -28px rgba(15, 23, 42, 0.35)",
  modal: "0 32px 90px -36px rgba(15, 23, 42, 0.45)",
  brand: "0 12px 28px -18px rgba(5, 150, 105, 0.55)",
};

export const font = {
  body: "'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif",
  heading: "'Outfit', 'Inter', system-ui, sans-serif",
  mono: "ui-monospace, SFMono-Regular, Menlo, monospace",
  /**
   * Two naming schemes sit here on purpose. The t-shirt scale is what new code
   * should reach for; the semantic aliases beneath it are the names the call
   * sites were already written against. Those names were never actually
   * defined, so every one of them resolved to `undefined`, React dropped the
   * declaration, and the text silently fell back to the inherited 16px — which
   * is a large part of why card titles, hints and captions all rendered
   * oversized. They are defined here rather than rewritten at the call sites so
   * the fix lands in one place.
   *
   * Two of the components named in the original note (EmptyState, CaptchaField)
   * were deleted on 2026-08-23 as unreachable; the aliases stay because the
   * surviving call sites still use them.
   */
  size: {
    xs: 10.5,
    sm: 11,
    base: 11.5,
    md: 12.5,
    lg: 14,
    xl: 16,
    "2xl": 19.5,
    "3xl": 24.5,

    caption: 10.5,
    small: 11,
    body: 11.5,
    bodyLg: 12.5,
    h3: 14,
    h2: 16,
    h1: 19.5,
  },
  weight: { regular: 400, medium: 500, semibold: 600, bold: 700, extrabold: 800 },
};

/**
 * Module group accents. Every group used to pick its own hue (cyan #059669,
 * teal #059669, amber #d97706, blue #059669); they now step through the single
 * green scale so grouping still reads without introducing a second palette.
 */
export const groupAccent = {
  workspace: palette.brand[500],
  management: palette.brand[600],
  survey_master: palette.brand[700],
  operations: palette.brand[500],
  analytics: palette.brand[800],
  system: palette.neutral[500],
};

export function getGroupAccent(groupKey) {
  return groupAccent[groupKey] || palette.brand[600];
}

/**
 * Motion.
 *
 * Three components — Card, PasswordField and Pagination — imported `anim` from
 * this file before it was defined here. Webpack reports a missing named export
 * as a warning rather than an error, so it only surfaced when a production
 * build ran with warnings treated as errors; at runtime the import is
 * `undefined` and `${anim.base}` throws the moment the component renders.
 *
 * Only Pagination still imports it: PasswordField was deleted on 2026-08-23 as
 * unreachable, and Card stopped using it when its unused subcomponents went the
 * same day. Pagination is now used by seven pages.
 *
 * Durations are short on purpose: these animate hover and focus feedback, where
 * anything past ~200ms reads as lag rather than as polish.
 */
export const anim = {
  fast: "120ms",
  base: "180ms",
  slow: "260ms",
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
};

/**
 * Keyboard focus ring, as a box-shadow so it follows border-radius instead of
 * boxing a rounded control. Two rings: a surface-coloured gap, then the brand
 * colour, so it stays visible against both light and tinted backgrounds.
 */
export const focusRing = `0 0 0 2px ${palette.neutral[0] ?? "#ffffff"}, 0 0 0 4px ${palette.brand[600]}`;
