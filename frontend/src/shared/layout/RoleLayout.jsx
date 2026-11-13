import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import Header from "./Header";
import Footer from "./Footer";
import { Breadcrumb } from "../components/ui";
import { SidebarCollapseProvider } from "./Sidebar";
import { readSidebarCollapsed, sidebarColumnWidth, writeSidebarCollapsed } from "./sidebarPreference";
import useMediaQuery from "../hooks/useMediaQuery";
import MobileNavDrawer from "./MobileNavDrawer";

const LAYOUT_PRESETS = {
  role: {
    title: "COC Dashboard",
  },
  admin: {
    title: "COC Admin Dashboard",
    fillViewport: true,
    // No mainClassName: <main> already sets its own overflow. This used to say
    // "overflow-x-hidden overflow-y-auto", which resolvedMainClassName then
    // stripped back out again with a string replace — config that existed only
    // to be deleted, and which would have re-clipped the overflow above.
  },
  dean: {
    title: "COC Dean Dashboard",
  },
};

/*
 * Inline SVG rather than the Icon component, so the layout shell does not take
 * a dependency on the icon registry just to draw its own furniture.
 * `aria-hidden` on both: the button's text already names the control.
 */
function MenuGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
      <path d="M3 6h18M3 12h18M3 18h18" />
    </svg>
  );
}

function ChevronGlyph({ open }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ flexShrink: 0, transition: "transform 160ms ease", transform: open ? "rotate(180deg)" : "none" }}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

export default function RoleLayout({
  layout = "role",
  title,
  user,
  initials,
  menuRef,
  menuOpen,
  onToggleMenu,
  notificationCount,
  onNotifications,
  notificationOpen,
  notifications,
  notificationsLoading,
  notificationsError,
  notificationsUnreadCount,
  notificationsHasMore,
  notificationsLoadingMore,
  notificationsMarkingAll,
  notificationsClearingRead,
  onNotificationView,
  onNotificationMarkRead,
  onNotificationMarkAllRead,
  onNotificationClearRead,
  onNotificationLoadMore,
  onProfile,
  onLogout,
  sidebar,
  children,
  mainClassName = "",
  footerText,
  breadcrumbSegments,
  /*
   * Anything else goes straight to Header.
   *
   * Every prop below was previously named three times — in Header, again here,
   * and again in DashboardShell — and this component silently dropped whatever
   * it had not been taught about. That is how `onSettings` went missing: it was
   * passed correctly at both ends and lost in the middle, with no error, no
   * warning, and a menu item that simply never rendered.
   *
   * With the rest collected, a new Header prop only has to be declared where it
   * is used. The list above stays because those props are read here too.
   */
  ...headerProps
}) {
  const location = useLocation();
  const mainRef = useRef(null);

  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarCollapsed);

  // Narrow-viewport nav disclosure. Not persisted, and not shared with the
  // desktop rail's preference: "I collapsed the rail on my monitor" is a
  // different statement from "the menu is open on my phone right now".
  const [mobileNavOpen, setMobileNavOpen] = useState(false);

  // Stable identity: MobileNavDrawer keys its keydown/scroll-lock effect on
  // this, and a fresh closure every render would tear the listeners down and
  // rebuild them on each parent render.
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), []);

  /*
   * The split-screen band: a desktop window that is merely narrow.
   *
   * Half of a 1920 monitor is ~960px, which is under Tailwind's `lg` (1024px) —
   * so snapping the phone layout at `lg` turned a docked browser window into a
   * stacked mobile shell, sidebar and all, on a machine with a mouse and a
   * full-size screen. Dragging a window is not the same statement as picking up
   * a phone.
   *
   * So the desktop shell now reaches down to 768px, and between 768 and 1179 it
   * shows the icon rail instead of the full one. That band keeps the desktop
   * arrangement — persistent rail beside scrolling content — while giving the
   * content back the ~200px the labels were using. Below 768 is a real tablet
   * or phone, and the stacked layout is right there.
   */
  const isSplitScreenWidth = useMediaQuery("(min-width: 768px) and (max-width: 1179px)");

  /*
   * In that band the rail defaults to compact, but the toggle still works —
   * held here rather than written through applySidebarCollapsed, so opening the
   * rail in a docked window does not rewrite the preference for the monitor.
   * `null` means "no opinion yet, follow the default".
   */
  const [splitScreenRailOpen, setSplitScreenRailOpen] = useState(null);
  const effectiveCollapsed = isSplitScreenWidth ? splitScreenRailOpen !== true : sidebarCollapsed;

  // One writer, so the stored value cannot drift from the rendered one. Takes
  // the same value-or-updater shape as a setState, because the toggle needs the
  // updater form and the expand needs the plain one.
  const applySidebarCollapsed = useCallback((valueOrUpdater) => {
    setSidebarCollapsed((current) => {
      const next = typeof valueOrUpdater === "function" ? valueOrUpdater(current) : valueOrUpdater;
      writeSidebarCollapsed(next);
      return next;
    });
  }, []);

  /*
   * Two providers, deliberately. The desktop rail collapses; the mobile block
   * below the header is already capped at 38vh and gains nothing from an icon
   * rail, so it is handed a value that says "never collapsed, no toggle" and
   * renders exactly as it always has.
   */
  const desktopSidebarCollapse = useMemo(
    () => ({
      collapsed: effectiveCollapsed,
      onToggle: () =>
        isSplitScreenWidth
          ? setSplitScreenRailOpen((open) => open !== true)
          : applySidebarCollapsed((current) => !current),
      onExpand: () => (isSplitScreenWidth ? setSplitScreenRailOpen(true) : applySidebarCollapsed(false)),
    }),
    [applySidebarCollapsed, effectiveCollapsed, isSplitScreenWidth]
  );

  const mobileSidebarCollapse = useMemo(() => ({ collapsed: false, onToggle: null, onExpand: null }), []);

  const lastScrollSaveRef = useRef(0);
  const preset = LAYOUT_PRESETS[layout] || LAYOUT_PRESETS.role;
  const resolvedTitle = title ?? preset.title;
  const resolvedMainClassName = `${preset.mainClassName || ""} ${mainClassName}`.trim();
  const resolvedFooterText = footerText ?? preset.footerText;
  const scrollStorageKey = useMemo(
    () => `coc-dashboard-scroll:${location.pathname}${location.search || ""}`,
    [location.pathname, location.search]
  );

  const saveMainScroll = useCallback(() => {
    const node = mainRef.current;
    if (!node || !scrollStorageKey) return;

    try {
      window.sessionStorage.setItem(scrollStorageKey, String(Math.max(0, Math.round(node.scrollTop))));
    } catch {
      // Ignore storage failures so dashboard scrolling keeps working normally.
    }
  }, [scrollStorageKey]);

  const handleMainScroll = useCallback(() => {
    const now = Date.now();
    if (now - lastScrollSaveRef.current < 120) return;
    lastScrollSaveRef.current = now;
    saveMainScroll();
  }, [saveMainScroll]);

  useEffect(() => {
    if (!("scrollRestoration" in window.history)) return undefined;
    const previousScrollRestoration = window.history.scrollRestoration;
    window.history.scrollRestoration = "manual";
    return () => {
      window.history.scrollRestoration = previousScrollRestoration;
    };
  }, []);

  useEffect(() => {
    const node = mainRef.current;
    if (!node || !scrollStorageKey) return undefined;

    let savedScrollTop = 0;
    try {
      savedScrollTop = Number(window.sessionStorage.getItem(scrollStorageKey) || 0);
    } catch {
      savedScrollTop = 0;
    }

    if (!Number.isFinite(savedScrollTop) || savedScrollTop <= 0) {
      node.scrollTop = 0;
      return undefined;
    }

    let cancelled = false;
    const restore = () => {
      if (cancelled || !mainRef.current) return;
      mainRef.current.scrollTop = savedScrollTop;
    };

    restore();
    const frameId = window.requestAnimationFrame(restore);
    const timeoutIds = [60, 160, 320, 640].map((delay) => window.setTimeout(restore, delay));

    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frameId);
      timeoutIds.forEach((timeoutId) => window.clearTimeout(timeoutId));
      saveMainScroll();
    };
  }, [saveMainScroll, scrollStorageKey]);

  useEffect(() => {
    window.addEventListener("beforeunload", saveMainScroll);
    window.addEventListener("pagehide", saveMainScroll);
    return () => {
      window.removeEventListener("beforeunload", saveMainScroll);
      window.removeEventListener("pagehide", saveMainScroll);
      saveMainScroll();
    };
  }, [saveMainScroll]);

  return (
    <div className="portal-theme-bg flex h-screen min-h-screen w-full overflow-hidden text-slate-800 md:h-dvh md:min-h-dvh">
      {/* Width is inline rather than a Tailwind class because it is state, and
          the class would have to exist for every value it might take. The
          element is `hidden` below lg, so the width never applies there. */}
      <div
        /*
         * `sidebar-column` carries the width transition so it can be matched to
         * the children in one stylesheet and turned off together under
         * prefers-reduced-motion. It was an inline `width 180ms ease`, which the
         * media query could not reach — the panel kept sliding for readers who
         * had asked the interface to hold still.
         *
         * 200ms on the same curve as the labels, so the column and the text it
         * contains finish together instead of the text landing first.
         */
        className="sidebar-column hidden h-full min-h-0 md:sticky md:top-0 md:flex md:shrink-0"
        style={{ width: sidebarColumnWidth(effectiveCollapsed) }}
      >
        <div
          className="h-full w-full min-h-0 overflow-hidden"
          style={{ scrollbarGutter: "stable", overscrollBehavior: "contain" }}
        >
          <SidebarCollapseProvider value={desktopSidebarCollapse}>{sidebar}</SidebarCollapseProvider>
        </div>
      </div>

      <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <Header
          // Spread first so the explicit props below still win.
          {...headerProps}
          title={resolvedTitle}
          menuRef={menuRef}
          menuOpen={menuOpen}
          onToggleMenu={onToggleMenu}
          initials={initials}
          email={user?.email}
          passwordExpiration={user?.password_expiration}
          notificationCount={notificationCount}
          onNotifications={onNotifications}
          notificationOpen={notificationOpen}
          notifications={notifications}
          notificationsLoading={notificationsLoading}
          notificationsError={notificationsError}
          notificationsUnreadCount={notificationsUnreadCount}
          notificationsHasMore={notificationsHasMore}
          notificationsLoadingMore={notificationsLoadingMore}
          notificationsMarkingAll={notificationsMarkingAll}
          notificationsClearingRead={notificationsClearingRead}
          onNotificationView={onNotificationView}
          onNotificationMarkRead={onNotificationMarkRead}
          onNotificationMarkAllRead={onNotificationMarkAllRead}
          onNotificationClearRead={onNotificationClearRead}
          onNotificationLoadMore={onNotificationLoadMore}
          onProfile={onProfile}
          onLogout={onLogout}
        />

        {/*
          Below lg the nav is a disclosure, not a permanent block.

          It used to render expanded at all times, capped at min(38vh, 360px).
          On a 768x800 tablet that is ~300px of navigation above the fold, so
          with the header and breadcrumb the actual page began past the halfway
          mark and every visit started with a scroll. The desktop rail has a
          collapsed state for exactly this reason; the narrow layout had none.

          Closed by default, because the reader arrived at a page and wants the
          page. The trigger names the destination so the nav is still one tap
          away, and `aria-expanded` / `aria-controls` make that relationship
          real for a screen reader rather than visual-only.
        */}
        {/*
          The trigger stays in the flow; the navigation itself does not.

          Closed, this costs one 40px bar. Open, MobileNavDrawer floats the nav
          over the page as a fixed layer, so the content underneath keeps its
          scroll position and dismissing the menu does not reflow the page. The
          earlier inline panel pushed everything down by up to 460px each time
          it opened.
        */}
        <div className="shrink-0 px-4 pb-3 sm:px-6 md:hidden">
          <button
            type="button"
            onClick={() => setMobileNavOpen(true)}
            aria-expanded={mobileNavOpen}
            aria-haspopup="dialog"
            aria-controls="mobile-nav-panel"
            className="flex w-full items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-2.5 text-left text-sm font-semibold text-slate-700 shadow-sm"
          >
            <span className="flex min-w-0 items-center gap-2">
              <MenuGlyph />
              <span id="mobile-nav-label" className="truncate">Menu</span>
            </span>
            <ChevronGlyph open={mobileNavOpen} />
          </button>
        </div>

        <MobileNavDrawer
          open={mobileNavOpen}
          onClose={closeMobileNav}
          labelledBy="mobile-nav-label"
        >
          <div id="mobile-nav-panel">
            <SidebarCollapseProvider value={mobileSidebarCollapse}>{sidebar}</SidebarCollapseProvider>
          </div>
        </MobileNavDrawer>

        <main
          ref={mainRef}
          onScroll={handleMainScroll}
          /*
           * No `overflow-x-hidden` here, deliberately.
           *
           * It used to be, and it was hiding a real bug rather than fixing one:
           * a `repeat(auto-fit, minmax(384px, 1fr))` track cannot shrink below
           * 384px, so on a 400px-wide phone the retention matrix ran ~36px past
           * its container and those columns were simply clipped away —
           * unreachable, with no scrollbar to say so. The minmax minimums are
           * now guarded with min(…, 100%), so the overflow is gone at the
           * source.
           *
           * With overflow-y auto and overflow-x omitted, CSS computes
           * overflow-x to `auto` too. That is the honest default: if something
           * does overflow in future it stays reachable and shows a scrollbar,
           * instead of being silently cut off.
           */
          className={`flex-1 h-full min-h-0 w-full overflow-y-auto bg-transparent px-4 pb-4 pt-2 sm:px-6 sm:pb-6 sm:pt-3 xl:px-8 ${resolvedMainClassName}`}
          style={{ scrollbarGutter: "stable both-edges", overscrollBehavior: "contain", scrollBehavior: "smooth" }}
        >
          <div className="mx-auto flex min-h-full w-full flex-col">
            <Breadcrumb trailingPath={breadcrumbSegments} />
            <div className="flex-1 min-h-0 min-w-0">
              {children}
            </div>
            <div className="pt-6">
              <Footer text={resolvedFooterText} className="rounded-2xl border border-slate-200/80" />
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
