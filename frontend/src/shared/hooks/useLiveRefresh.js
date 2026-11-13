import { useCallback, useEffect, useRef } from "react";
import { getBackendUrl } from "../lib/url";

/**
 * Keeps a page fresh by polling `changes.php` for a version token per topic and
 * calling `onChange` only when a token actually moves.
 *
 * The probe answer is a few dozen bytes, so this can run far more often than a
 * full refetch could. A hidden tab is skipped entirely and caught up the moment
 * it becomes visible again, so a backgrounded tab costs nothing.
 */

const DEFAULT_INTERVAL_MS = 15000;

export default function useLiveRefresh(topics, onChange, options = {}) {
  const { intervalMs = DEFAULT_INTERVAL_MS, enabled = true } = options;

  const topicKey = Array.isArray(topics) ? topics.filter(Boolean).join(",") : String(topics || "");

  // Held in a ref so a new inline callback each render does not restart polling.
  const onChangeRef = useRef(onChange);
  const tokensRef = useRef(null);
  const inFlightRef = useRef(false);
  // Topics already reported as unknown, so the development warning below fires
  // once per topic instead of every fifteen seconds.
  const warnedTopicsRef = useRef(new Set());

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const probe = useCallback(async () => {
    if (!topicKey || inFlightRef.current) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;

    inFlightRef.current = true;
    try {
      const res = await fetch(getBackendUrl(`changes.php?topics=${encodeURIComponent(topicKey)}`), {
        headers: { Accept: "application/json" },
        credentials: "include",
      });

      // 401/403 means this page should not be probing at all; stay silent.
      if (!res.ok) return;

      const json = await res.json();

      /*
       * A topic the server does not recognise is a wiring mistake, and it fails
       * in the worst possible way: the probe answers 200, the token set simply
       * has no key for it, the comparison below never sees a change, and the
       * page polls forever without ever refreshing. The Team Monitor board did
       * exactly that for as long as it existed, asking for `ssp_assignment`
       * against a map holding `ssp_assignments`.
       *
       * Said once per topic rather than on every tick, and only in development —
       * this is a message for whoever wired the page up, not for the user
       * sitting in front of it in production.
       */
      if (process.env.NODE_ENV === "development") {
        const unknown = Array.isArray(json?.unknown_topics) ? json.unknown_topics : [];
        unknown.forEach((topic) => {
          if (warnedTopicsRef.current.has(topic)) return;
          warnedTopicsRef.current.add(topic);
          console.warn(
            `useLiveRefresh: "${topic}" is not a topic in changes_topic_map() ` +
            `(backend/api/changes.php). This page will never live-refresh on it.`
          );
        });
      }

      const next = json?.tokens || {};
      const previous = tokensRef.current;
      tokensRef.current = next;

      // The first answer only establishes the baseline.
      if (previous === null) return;

      const changed = Object.keys(next).some((topic) => next[topic] !== previous[topic]);
      if (changed) onChangeRef.current?.();
    } catch (_) {
      // A dropped probe just means we try again on the next tick.
    } finally {
      inFlightRef.current = false;
    }
  }, [topicKey]);

  useEffect(() => {
    if (!enabled || !topicKey) return undefined;

    void probe();
    const intervalId = window.setInterval(probe, intervalMs);

    const catchUp = () => {
      if (document.visibilityState === "visible") void probe();
    };
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", catchUp);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [enabled, topicKey, intervalMs, probe]);
}
