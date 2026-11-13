import { useMemo, useState } from "react";

/**
 * Client-side paging for a list that is already fully loaded.
 *
 * The reports fetch their whole dataset and aggregate it in the browser — the
 * stat tiles and the bands need every row to be right — so the table is the
 * only part that wants paging, and it wants it over an array that is already
 * in hand rather than over a second server query.
 *
 * The page is clamped on read instead of reset in an effect. A search that
 * shortens the list from nine pages to two happens while you are on page nine,
 * and an effect that notices afterwards renders one empty table first; there is
 * no page nine to be on, so this never reports being there.
 *
 * `page` is returned already clamped, so callers pass it straight to
 * <Pagination> without repeating the arithmetic.
 */
export default function usePagedRows(rows, initialPageSize = 20) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);

  // Memoised so the fallback is one array rather than a fresh `[]` per render,
  // which would make the slice below recompute every time it was asked.
  const all = useMemo(() => (Array.isArray(rows) ? rows : []), [rows]);
  const total = all.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(1, page), pageCount);

  const visible = useMemo(() => all.slice((current - 1) * pageSize, current * pageSize), [all, current, pageSize]);

  return {
    rows: visible,
    page: current,
    pageSize,
    total,
    setPage,
    // Changing the size moves you back to the top rather than leaving you on a
    // page number that now points somewhere else in the list.
    setPageSize: (size) => {
      setPageSize(Math.max(1, Number(size) || initialPageSize));
      setPage(1);
    },
  };
}
