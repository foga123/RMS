import { useCallback, useEffect, useRef } from "react";

/**
 * Makes a loader ignore its own stale answers.
 *
 * A page whose loader re-runs on a filter change starts a second request before
 * the first has come back, and nothing decides which reply wins. The one that
 * lands last does. Switch the periodical from P1 to P2 while P1 is still in
 * flight and a slow P1 response overwrites the P2 rows that already arrived:
 * the dropdown says P2, the table is P1, and pressing Refresh appears to fix a
 * bug that was never in the data. It is intermittent by nature — it needs two
 * requests overlapping — which is exactly why it gets reported as "the filter
 * doesn't work sometimes" rather than as a race.
 *
 * Call the returned function at the top of the loader. It stamps this attempt
 * as the current one and hands back a predicate: ask it before every setState
 * and drop the result when it says no.
 *
 *   const beginRequest = useLatestRequest();
 *
 *   const load = useCallback(async () => {
 *     const isCurrent = beginRequest();
 *     setLoading(true);
 *     try {
 *       const data = await fetchSomething();
 *       if (!isCurrent()) return;
 *       setRows(data);
 *     } catch (error) {
 *       if (!isCurrent()) return;
 *       setError(error.message);
 *     } finally {
 *       if (isCurrent()) setLoading(false);
 *     }
 *   }, [beginRequest, ...deps]);
 *
 * A sequence number rather than an AbortController on purpose. Aborting would
 * also cancel the HTTP request, which sounds better and is worse here: several
 * of these loaders are also called by a Refresh button and by useLiveRefresh,
 * and a background poll firing mid-render would abort the user's own request.
 * This only discards the answer, so every request still completes and warms the
 * cache — it just cannot write over a newer one.
 *
 * The predicate also returns false after unmount, so a reply arriving for a page
 * the user has already left is dropped instead of setting state on nothing.
 */
export default function useLatestRequest() {
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    // Re-arm on mount: React 18's StrictMode double-invokes effects in
    // development, so a hook that only ever set this to false in cleanup would
    // treat every loader on the page as unmounted from the second render on.
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  return useCallback(() => {
    const token = sequence.current + 1;
    sequence.current = token;
    return () => mounted.current && sequence.current === token;
  }, []);
}
