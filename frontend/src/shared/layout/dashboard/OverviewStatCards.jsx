import React from "react";
// Straight at the file rather than through the shared/components/ui barrel.
// The barrel re-exports Breadcrumb, which imports react-router-dom, which jest
// cannot resolve — so importing these two through it makes every component
// that renders stat cards untestable for a reason unrelated to stat cards.
import { StatCard, StatCardGrid } from "../../components/ui/StatCard";

export default function OverviewStatCards({ items = [], minWidth = 200 }) {
  return (
    <StatCardGrid minWidth={minWidth}>
      {items.map((item) => (
        <StatCard
          key={item.label}
          label={item.label}
          value={item.value}
          tone={item.tone}
          meta={item.meta}
          loading={item.loading}
          progress={item.progress}
          onClick={item.onClick}
          active={item.active}
          hint={item.hint}
          filled={item.filled}
        />
      ))}
    </StatCardGrid>
  );
}
