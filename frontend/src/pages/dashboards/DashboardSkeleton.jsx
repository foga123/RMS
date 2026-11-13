import React from "react";
import { Skeleton } from "../../shared/components/ui";
import { readSidebarCollapsed, sidebarColumnWidth } from "../../shared/layout/sidebarPreference";

// Stand-in for a role dashboard while the session is being restored.
// Mirrors the RoleLayout shell (sticky sidebar column + header + content) so the
// real dashboard paints into the same geometry instead of replacing a blank page.
export default function DashboardSkeleton() {
  // Read once at mount, not held in state: this component is replaced the
  // moment the session resolves, and the reader cannot toggle anything while
  // it is on screen.
  const collapsed = readSidebarCollapsed();

  return (
    <div
      className="portal-theme-bg flex h-screen min-h-screen w-full overflow-hidden text-slate-800 md:h-dvh md:min-h-dvh"
      role="status"
      aria-busy="true"
      aria-label="Loading your dashboard"
    >
      {/* sidebar column - same width as RoleLayout, collapsed state included,
          so the real shell paints into this geometry instead of snapping to it */}
      <div
        className="hidden h-full min-h-0 lg:sticky lg:top-0 lg:flex lg:shrink-0"
        style={{ width: sidebarColumnWidth(collapsed) }}
      >
        <div className={`h-full w-full border-r border-slate-200 bg-white/70 ${collapsed ? "p-2" : "p-4"}`}>
          <div className={`mb-6 flex items-center gap-3 ${collapsed ? "justify-center" : ""}`}>
            <Skeleton width={32} height={32} radius={8} />
            {collapsed ? null : (
              <div style={{ flex: 1 }}>
                <Skeleton width="70%" height={10} />
                <div style={{ height: 5 }} />
                <Skeleton width="45%" height={8} />
              </div>
            )}
          </div>

          {Array.from({ length: 7 }, (_, index) => (
            <div
              key={index}
              className={`mb-2 flex items-center gap-3 rounded-lg py-2 ${collapsed ? "justify-center px-0" : "px-2"}`}
            >
              <Skeleton width={15} height={15} radius={4} />
              {collapsed ? null : (
                <Skeleton width={`${["70%", "55%", "64%", "48%", "72%", "58%", "62%"][index]}`} height={9} />
              )}
            </div>
          ))}
        </div>
      </div>

      {/* main column */}
      <div className="flex h-full min-h-0 w-full flex-1 flex-col overflow-hidden">
        {/* header bar */}
        <div className="flex items-center justify-between gap-4 border-b border-slate-200 bg-white/70 px-4 py-3 sm:px-6">
          <Skeleton width={162} height={14} />
          <div className="flex items-center gap-3">
            <Skeleton width={22} height={22} radius={10} />
            <Skeleton width={22} height={22} radius={10} />
            <Skeleton width={29} height={29} radius={13} />
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
          <div style={{ maxWidth: 1088, margin: "0 auto" }}>
            {/* page heading */}
            <Skeleton width={204} height={19} />
            <div style={{ height: 7 }} />
            <Skeleton width={323} height={10} />

            {/* stat card row */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 170px), 1fr))",
                gap: "clamp(0.75rem, 1vw, 1rem)",
                marginTop: 17,
              }}
            >
              {Array.from({ length: 4 }, (_, index) => (
                <div
                  key={index}
                  style={{
                    background: "var(--surface-page)",
                    border: "1px solid var(--border-base)",
                    borderRadius: 12,
                    padding: "clamp(0.875rem, 1vw, 1rem)",
                  }}
                >
                  <Skeleton width="58%" height={9} />
                  <div style={{ height: 10 }} />
                  <Skeleton width="42%" height={20} radius={6} />
                </div>
              ))}
            </div>

            {/* content panel */}
            <div
              style={{
                marginTop: 17,
                background: "var(--surface-base)",
                border: "1px solid var(--border-base)",
                borderRadius: 9,
                padding: 12,
              }}
            >
              <Skeleton width={145} height={12} />
              <div style={{ height: 14 }} />
              {Array.from({ length: 5 }, (_, index) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    gap: 12,
                    alignItems: "center",
                    padding: "9px 0",
                    borderBottom: index === 4 ? "none" : "1px solid #f1f5f9",
                  }}
                >
                  <Skeleton width="26%" height={9} />
                  <Skeleton width="18%" height={9} />
                  <Skeleton width="22%" height={9} />
                  <Skeleton width="14%" height={9} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
