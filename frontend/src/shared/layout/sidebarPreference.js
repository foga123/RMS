/**
 * How wide the sidebar column is, and whether the reader has collapsed it.
 *
 * Its own module because two components need the answer and neither owns it:
 * RoleLayout renders the real shell, and DashboardSkeleton draws a stand-in of
 * that shell while the session is restoring. The skeleton exists so the real
 * dashboard paints into the same geometry instead of jumping — which it only
 * does if both agree on the width, so the number lives in one place.
 *
 * Remembered across navigations and reloads: collapsing is a preference about
 * how someone wants to work, not a property of the page they happen to be on.
 * Per browser rather than per account, because it is a screen-size decision and
 * the same person on a laptop and a monitor wants different answers.
 */

export const SIDEBAR_COLLAPSED_KEY = "coc-sidebar-collapsed";

/** The icon rail: a 20px icon centred in a 44px hit target, plus the gutters. */
export const SIDEBAR_RAIL_WIDTH = 68;

/*
 * 260px at the top end, not 296px.
 *
 * The longest label in the rail — "Attendance Management" — sets the real
 * floor, and it fits in 260px at the sidebar's own type size with the icon and
 * gutters. The extra 36px was buying nothing but empty space to the right of
 * the text, and on a 1920 screen it was 36px the tables could have used for
 * another column. 240px stays as the lower bound so nothing wraps on a laptop.
 *
 * Still a clamp rather than a flat 260: between 1000px and ~1080px the viewport
 * is narrow enough that a fixed rail crowds the content beside it.
 */
export const SIDEBAR_FULL_WIDTH = "clamp(240px, 22vw, 260px)";

/** False whenever storage is unavailable — private mode is not a render error. */
export function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "1";
  } catch {
    return false;
  }
}

export function writeSidebarCollapsed(collapsed) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // Ignore: the rail still collapses for this session, it just will not stick.
  }
}

/** The width of the sidebar column for a given state, ready for a style prop. */
export function sidebarColumnWidth(collapsed) {
  return collapsed ? SIDEBAR_RAIL_WIDTH : SIDEBAR_FULL_WIDTH;
}
