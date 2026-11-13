import React from "react";
import { InputControl } from "../Form/Form";
import Table from "../Table/Table";
import AlertMessage from "../ui/AlertMessage";
import Button from "../ui/Button";
import Icon from "../ui/Icon";
import Pagination from "../ui/Pagination";
import SectionHeader from "../ui/SectionHeader";
import { font } from "../../theme/tokens";

const shellStyle = {
  background: "var(--surface-base)",
  border: "1px solid var(--border-base)",
  borderRadius: 9,
  overflow: "hidden",
};

export function ManagementPage({ title, subtitle, error, success, warning, children }) {
  return (
    <section>
      {/*
        * The page title, at the same step as the dashboard headings.
        *
        * It set no font-size at all, and Tailwind's Preflight resets headings
        * to `font-size: inherit` — so this rendered at the inherited body size
        * in regular weight. On seven screens the page title was the same size
        * as the paragraph under it and smaller than the card heading below it,
        * which is why those pages read as having no title at all.
        */}
      <h2
        style={{
          margin: 0,
          marginBottom: 6,
          color: "var(--brand-800)",
          fontSize: font.size["2xl"],
          fontWeight: font.weight.semibold,
          lineHeight: 1.2,
        }}
      >
        {title}
      </h2>
      {subtitle ? (
        <p style={{ marginTop: 0, marginBottom: 9, color: "var(--text-secondary)", fontSize: 12.5 }}>{subtitle}</p>
      ) : null}

      <AlertMessage tone="error" message={error} />
      <AlertMessage tone="success" message={success} />
      <AlertMessage tone="warning" message={warning} />

      {children}
    </section>
  );
}

/**
 * Search and the page's actions. Rows-per-page deliberately does NOT live here —
 * it sits with the pager under the table, where every other screen keeps it.
 */
export function ManagementToolbar({
  search,
  onSearchChange,
  searchPlaceholder = "Search...",
  actionLabel,
  onAction,
  actionIcon = "plus",
  children,
}) {
  return (
    <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
      <InputControl
        value={search}
        onChange={onSearchChange}
        placeholder={searchPlaceholder}
        style={{ minWidth: 204, flex: "1 1 240px" }}
      />
      {actionLabel ? (
        <Button onClick={onAction}>
          <Icon name={actionIcon} size={14} />
          <span>{actionLabel}</span>
        </Button>
      ) : null}
      {children}
    </div>
  );
}

export function ManagementTableCard({
  title,
  actions,
  columns,
  rows,
  loading = false,
  emptyText = "No records found.",
  maxHeight = "calc(100vh - 260px)",
  footer,
  /*
   * A strip between the header and the table: the active-filter chips,
   * a scope note, a bulk-action bar. Anything that describes what the
   * rows below have been narrowed to.
   *
   * Outside the scrolling area on purpose. It is the caption for the
   * table, so it has to stay put while the table moves under it.
   */
  banner,
}) {
  return (
    <div style={shellStyle}>
      <SectionHeader title={title} sticky actions={actions} />
      {banner || null}
      <div style={{ overflow: "auto", maxHeight }}>
        <Table columns={columns} rows={rows} loading={loading} emptyText={emptyText} />
      </div>
      {footer ? (
        <div style={{ padding: 9, borderTop: "1px solid var(--border-base)", background: "var(--surface-base)" }}>{footer}</div>
      ) : null}
    </div>
  );
}

/**
 * The same pagination control every other list uses.
 *
 * This used to be a second, smaller implementation: "Showing 1-20 of 137" beside
 * a Prev / Page 2 / Next stepper, with the rows-per-page selector living up in
 * ManagementToolbar. The rest of the portal renders <Pagination>, which has
 * numbered pages and keeps its rows-per-page selector next to the pager. So the
 * two families of screens disagreed on what pagination looked like AND on where
 * the page-size control lived — above the table on one, below it on the other.
 *
 * It now renders <Pagination>, so there is one control, one place, one look.
 * `limit` is this component's long-standing name for the page size and is kept
 * so the call sites read the same as the queries behind them.
 *
 * onPrev/onNext are still accepted for any caller that has not moved to
 * onPageChange; they can only step one page, which is all they ever could.
 */
export function ManagementPagination({
  page,
  limit,
  total,
  onPageChange,
  onLimitChange,
  onPrev,
  onNext,
  itemLabel = "records",
}) {
  const goToPage = (next) => {
    if (typeof onPageChange === "function") {
      onPageChange(next);
      return;
    }
    if (next > page) onNext?.();
    else if (next < page) onPrev?.();
  };

  return (
    <Pagination
      page={page}
      pageSize={limit}
      total={total}
      onPageChange={goToPage}
      onPageSizeChange={onLimitChange}
      itemLabel={itemLabel}
      compact
    />
  );
}
