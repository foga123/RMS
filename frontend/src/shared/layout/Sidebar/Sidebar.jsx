import React, { createContext, useContext, useId } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { getAssetUrl } from "../../lib/url";

/**
 * Whether the rail is showing icons only, and how to change that.
 *
 * A context rather than a prop, because the two halves of the decision live in
 * different places: RoleLayout owns the width of the column, and the pieces
 * that have to drop their labels are nested inside a `sidebar` element that
 * eight dashboards build for themselves. Threading a flag through all of them
 * would mean eight files changed to add one button, and one of them forgotten.
 *
 * `onToggle` doubles as "is collapsing even offered here": the mobile copy of
 * the sidebar renders inside a 38vh block below the header, where an icon rail
 * would save nothing, so it is given no toggle and never collapses.
 */
const SidebarCollapseContext = createContext({ collapsed: false, onToggle: null, onExpand: null });

export function SidebarCollapseProvider({ value, children }) {
  return <SidebarCollapseContext.Provider value={value}>{children}</SidebarCollapseContext.Provider>;
}

export function useSidebarCollapse() {
  return useContext(SidebarCollapseContext);
}

const FOCUS_RING =
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-600 focus-visible:ring-offset-1";

/** Chevrons pointing the way the rail will move, not a hamburger. */
function CollapseToggle({ collapsed, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={!collapsed}
      aria-label={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
      title={collapsed ? "Expand the sidebar" : "Collapse the sidebar"}
      /*
       * h-7/w-7 sizes the box, but the min-* pair in px is what keeps it
       * clickable. Those Tailwind sizes are 1.75rem, and the desktop root font
       * now scales with the viewport (13px at 1280 up to 14px at 1920) — so
       * between 1024 and 1440 this button rendered 23x23, under the 24px WCAG
       * 2.2 AA minimum. px floors do not follow the root, so the target holds
       * its size while the rest of the rail gets denser.
       */
      className={`flex h-7 w-7 min-h-[26px] min-w-[26px] shrink-0 items-center justify-center rounded-lg border border-slate-200/80 text-slate-400 transition-colors hover:bg-slate-100 hover:text-slate-700 ${FOCUS_RING}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ transform: collapsed ? "rotate(180deg)" : "none" }}
      >
        <polyline points="15 18 9 12 15 6" />
      </svg>
    </button>
  );
}

/**
 * Sidebar shell: a brand block over a scrolling nav.
 *
 * The brand is two lines on a bare surface. It used to be a rounded, bordered,
 * shadowed card nested inside the already-surfaced aside, wrapping a 56px
 * gradient logo tile and three lines of text — around 110px of chrome at the top
 * of a 240-296px rail, and on mobile the whole sidebar is capped at 38vh, so
 * that header was eating a third of the space the navigation had to live in.
 *
 * Collapsed it becomes a 68px icon rail rather than disappearing. Hiding the
 * navigation outright would buy the same width and cost every one-click move
 * between modules; the rail keeps every destination reachable and still hands
 * roughly 200px back to the page.
 */
export default function Sidebar({
  children,
  width = 280,
  className = "",
  logoSrc = getAssetUrl("assets/coc.png"),
  brandLabel = "RMS PHINMA-COC",
  brandName = "Campus Portal",
  navLabel = "Main navigation",
}) {
  const { collapsed, onToggle } = useSidebarCollapse();

  return (
    <aside
      /*
       * `sidebar-rail` is what the collapse animation keys off: the children
       * fold themselves via CSS rather than being unmounted, so the whole
       * gesture is one movement instead of a pop followed by a slide.
       *
       * `transition-all` was replaced by naming the properties. All meant the
       * browser watched every animatable property on a panel that also carries
       * a shadow, a border and a background, and animating a shadow on a column
       * that resizes is work for no visible gain.
       */
      className={`portal-theme-panel z-10 box-border flex h-full w-full min-w-0 shrink-0 flex-col overflow-hidden border-b border-slate-200/80 shadow-sm transition-colors lg:border-b-0 lg:border-r ${collapsed ? "sidebar-rail" : ""} ${className}`}
      style={{
        width: "100%",
        minWidth: 0,
        maxWidth: "100%",
        flexBasis: typeof width === "number" ? `${width}px` : width,
      }}
    >
      <div className="flex h-full min-h-0 flex-col">
        {/*
          * Stacks on the rail, and has to: a 40px logo beside a 28px toggle is
          * 68px of content, and the rail's inner box is 52px. The wordmark
          * between them folds away on the shared curve, so what is left is one
          * small reflow rather than the whole header rearranging.
          */}
        <div
          className={`sidebar-nav-button flex shrink-0 items-center border-b border-slate-200/80 ${
            collapsed ? "flex-col gap-2 px-2 py-3" : "gap-3 px-4 py-4"
          }`}
        >
          <img src={logoSrc} alt="" className="h-10 w-10 shrink-0 object-contain" />

          {/*
            * Kept mounted so it can fold. aria-hidden while collapsed: it is
            * decoration once the words are gone, and the sidebar is already
            * named by its <nav>.
            */}
          <div className="sidebar-brand-text min-w-0" aria-hidden={collapsed ? "true" : undefined}>
            <p className="truncate font-heading text-base font-bold leading-tight tracking-tight text-slate-900">
              {brandLabel}
            </p>
            <p className="mt-0.5 truncate text-[10.5px] leading-tight text-slate-500">
              {brandName}
            </p>
          </div>

          {/* Only where collapsing is on offer — see the context comment. */}
          {onToggle ? (
            <div className={collapsed ? "" : "ml-auto"}>
              <CollapseToggle collapsed={collapsed} onToggle={onToggle} />
            </div>
          ) : null}
        </div>

        <nav
          aria-label={navLabel}
          // `sidebar-scroll` gives this a thin scrollbar. On Windows the classic
          // 17px scrollbar takes real width, and in the ~68px collapsed rail it
          // landed on top of the 20px icons once there were enough modules to
          // scroll. A thin bar plus the stable gutter below keeps it clear of
          // them and keeps the icons centred whether or not it is showing.
          className={`sidebar-scroll min-h-0 flex-1 overflow-y-auto pb-4 pt-3 sm:pb-5 ${collapsed ? "px-2" : "px-3 sm:px-3.5"}`}
          style={{ scrollbarGutter: "stable", overscrollBehavior: "contain" }}
        >
          {children}
        </nav>
      </div>
    </aside>
  );
}

export function SidebarList({ children }) {
  return <ul className="m-0 list-none space-y-1 p-0">{children}</ul>;
}

/**
 * A titled band of nav items — "Management", "Analytics", and so on.
 *
 * The items go in a nested <ul> rather than straight under the heading, for two
 * reasons. The children are <li>, so they need a list parent to be valid at
 * all; and `aria-labelledby` on that list is what makes a screen reader announce
 * "Management, list, 6 items" instead of reading six unrelated links. A heading
 * that is only a styled <span> is decoration — sighted users get the grouping
 * and nobody else does.
 *
 * The label is a section title, not a control: unlike SidebarGroup it never
 * collapses. Collapsing hides the very items the title exists to make findable.
 *
 * On the icon rail the heading goes to sr-only rather than away, so the list it
 * labels keeps its name for a screen reader, and a hairline stands in for it on
 * screen — the grouping survives even where the words do not fit.
 */
export function SidebarSection({ label, children }) {
  const headingId = useId();
  const { collapsed } = useSidebarCollapse();

  return (
    <li className="mt-4 first:mt-0">
      {/*
        * Folds rather than flipping to sr-only, so the items below it glide up
        * instead of jumping. It stays in the document either way — the list
        * points at it with aria-labelledby, so it must not be removed.
        */}
      <h2
        id={headingId}
        className="sidebar-section-heading px-3 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em] text-slate-400"
      >
        {label}
      </h2>
      {collapsed ? <span aria-hidden="true" className="mx-auto mb-2 block h-px w-6 bg-slate-200" /> : null}
      <ul aria-labelledby={headingId} className="m-0 list-none space-y-1 p-0">
        {children}
      </ul>
    </li>
  );
}

/**
 * Icon colour is owned here, not by callers.
 *
 * Every call site passes its own `style={{ color: active ? "#065f46" : ... }}`
 * on the svg — 14 of them across 8 dashboards — which beat this component's own
 * icon wrapper and made it dead code. `[&_svg]:!text-current` wins over that
 * inline colour, so the active state resolves in one place. Those inline colours
 * are now redundant and can be deleted from the dashboards.
 */
const ICON_WRAP = "flex w-5 shrink-0 items-center justify-center transition-colors [&_svg]:!text-current";

export function SidebarItem({ active, onClick, icon, label }) {
  const { collapsed } = useSidebarCollapse();

  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        // Announces the active view to assistive tech; background colour alone
        // said nothing.
        aria-current={active ? "page" : undefined}
        // On the rail the icon is the only thing left, so the name has to come
        // from somewhere: the tooltip for a mouse, aria-label for everyone else.
        title={collapsed ? label : undefined}
        aria-label={collapsed ? label : undefined}
        /*
          * No `justify-center` and no `gap` on the rail. Both would snap: the
          * icon would be re-centred the instant the class flipped, ahead of the
          * width it is centring inside. The lead padding is transitioned
          * instead — 12px expanded, 16px on the rail, which is where the centre
          * of a 52px inner box puts a 20px icon — and the label folds its own
          * margin away, so the icon travels rather than teleports.
          */
        className={`sidebar-nav-button group relative flex w-full items-center rounded-lg text-left text-[12px] ${FOCUS_RING} ${
          collapsed ? "py-2.5 pl-4 pr-0" : "py-2.5 pl-3 pr-2.5"
        } ${
          active
            ? "bg-primary-50 font-semibold text-primary-900"
            : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        }`}
      >
        {/* A left rail rather than another shadow: in a scanned list the eye
            catches an edge marker far faster than a fill. */}
        {active ? (
          <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary-700" aria-hidden="true" />
        ) : null}
        <span
          className={`${ICON_WRAP} ${active ? "text-primary-700" : "text-slate-400 group-hover:text-slate-600"}`}
          aria-hidden="true"
        >
          {icon || null}
        </span>
        {/*
          * Kept mounted so it can fold away. aria-hidden while collapsed
          * because the button already carries aria-label there — without this
          * the name would be announced twice.
          */}
        <span className="sidebar-label leading-tight" aria-hidden={collapsed ? "true" : undefined}>
          {label}
        </span>
      </button>
    </li>
  );
}

/**
 * `active` means the current view lives inside this group. It matters when the
 * group is collapsed: without it the sidebar shows nothing selected while the
 * user is looking at one of its pages, because the only active marker was on a
 * child that is currently hidden. The left rail is therefore drawn only while
 * collapsed — once open, the child carries its own marker and two rails on
 * screen just compete.
 *
 * On the icon rail the children are not drawn at all, and the button reopens
 * the sidebar instead of expanding in place. A nested list of unlabelled icons
 * indented under another unlabelled icon is unreadable, and a hover flyout is a
 * second navigation surface with its own focus trap to get wrong. Widening the
 * rail shows the group already open, which is the thing that was wanted.
 */
export function SidebarGroup({ label, icon, expanded, onToggle, active = false, children }) {
  const { collapsed, onExpand } = useSidebarCollapse();

  const handleClick = () => {
    if (collapsed) {
      onExpand?.();
      if (!expanded) onToggle?.();
      return;
    }
    onToggle?.();
  };

  return (
    <li className="mt-1">
      <button
        type="button"
        onClick={handleClick}
        aria-expanded={collapsed ? false : expanded}
        title={collapsed ? label : undefined}
        aria-label={collapsed ? label : undefined}
        /* Same reasoning as SidebarItem: the lead padding is transitioned so
           the icon travels to the rail's centre rather than being snapped there
           by a flipped justify class. */
        className={`sidebar-nav-button group relative flex w-full items-center rounded-lg text-left text-[12px] ${FOCUS_RING} ${
          collapsed ? "py-2.5 pl-4 pr-0" : "justify-between gap-2 py-2.5 pl-3 pr-2.5"
        } ${
          active
            ? "font-semibold text-primary-900"
            : expanded && !collapsed
              ? "font-medium text-slate-900"
              : "font-medium text-slate-600 hover:bg-slate-100 hover:text-slate-900"
        } ${active && (collapsed || !expanded) ? "bg-primary-50" : ""}`}
      >
        {active && (collapsed || !expanded) ? (
          <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary-700" aria-hidden="true" />
        ) : null}
        <span className="flex min-w-0 items-center">
          <span
            className={`${ICON_WRAP} ${active ? "text-primary-700" : "text-slate-400 group-hover:text-slate-600"}`}
            aria-hidden="true"
          >
            {icon || null}
          </span>
          {/*
            * Kept mounted so it can fold away. aria-hidden while collapsed
            * because the button already carries aria-label there — without this
            * the name would be announced twice.
            */}
          <span className="sidebar-label leading-tight" aria-hidden={collapsed ? "true" : undefined}>
            {label}
          </span>
        </span>
        {collapsed ? null : (
          <motion.svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 text-slate-400 transition-colors group-hover:text-slate-600"
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
          >
            <polyline points="6 9 12 15 18 9"></polyline>
          </motion.svg>
        )}
      </button>

      <AnimatePresence initial={false}>
        {expanded && !collapsed ? (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            {/* The children are <li>, so they need a <ul> parent. Previously the
                animated element was itself a <ul> holding two <div>s, which put
                the <li>s inside a <div> inside a <ul> — invalid, and it drops
                list semantics for screen readers.

                The thread line is a real left border on that <ul>, offset to sit
                under the parent icon, rather than an absolutely positioned rule
                that had to be kept in sync with the padding by hand. */}
            <ul className="m-0 list-none space-y-1 border-l border-slate-200 py-1 pl-2.5" style={{ marginLeft: 17 }}>
              {children}
            </ul>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </li>
  );
}
