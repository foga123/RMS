import { useEffect, useState } from "react";

/**
 * Whether a CSS media query currently matches, kept in sync as the window moves.
 *
 * Exists because one layout decision cannot be made in CSS alone: the sidebar
 * rail's collapsed state is React state (the toggle writes it, the skeleton
 * reads it), so the breakpoint that forces it compact has to be readable from
 * JS as well. Everything else about the responsive layout stays in the
 * stylesheet, where it belongs.
 *
 * The initial value is read synchronously during the first render rather than
 * in an effect. Reading it in an effect renders once with the wrong answer and
 * then corrects, which for the sidebar means the rail paints wide and snaps
 * narrow on every load.
 *
 * Guarded for a missing `matchMedia` so a non-browser environment — jsdom
 * without the shim, or a server render — gets `false` instead of a crash.
 */
export default function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return undefined;

    const list = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);

    // Re-read on subscribe: the query may have changed between the render that
    // seeded state and this effect.
    setMatches(list.matches);

    // addEventListener is the current API; addListener is the deprecated one
    // Safari used until 14. Both are cheap to support and the fallback costs
    // nothing on browsers that never need it.
    if (typeof list.addEventListener === "function") {
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    }
    list.addListener(onChange);
    return () => list.removeListener(onChange);
  }, [query]);

  return matches;
}
