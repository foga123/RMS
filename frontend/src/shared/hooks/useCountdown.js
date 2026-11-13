import { useEffect, useState } from "react";

/**
 * A countdown that reads the clock instead of counting ticks.
 *
 * The obvious version holds a number and does `n - 1` every second. It drifts:
 * setInterval is throttled to roughly once a minute in a background tab, so a
 * hidden tab under-counts by however long it was hidden. For a verification
 * code that means the resend button unlocks late, or worse, a code that died
 * minutes ago still reads as live and the user is told their correct code is
 * wrong.
 *
 * Storing the *deadline* and re-deriving the remainder from Date.now() on each
 * tick cannot drift — a throttled tab simply corrects itself on the next tick,
 * and the numbers agree with the server, which is also working from a deadline.
 */

/** Whole seconds left until `deadline` (ISO string or epoch ms), never negative. */
export function secondsUntil(deadline, now = Date.now()) {
  if (deadline === null || deadline === undefined || deadline === "") return 0;

  const target = typeof deadline === "number" ? deadline : Date.parse(deadline);
  if (!Number.isFinite(target)) return 0;

  return Math.max(0, Math.ceil((target - now) / 1000));
}

/** `45s` under a minute, `9:41` above it — the shape people read on a timer. */
export function formatCountdown(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  if (total < 60) return `${total}s`;

  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Turn a duration into a deadline. Endpoints that answer with "600 seconds"
 * rather than a timestamp still get drift-free counting this way.
 */
export function deadlineFromSeconds(seconds, now = Date.now()) {
  const value = Number(seconds);
  return Number.isFinite(value) && value > 0 ? now + value * 1000 : null;
}

export default function useCountdown(deadline) {
  const [remaining, setRemaining] = useState(() => secondsUntil(deadline));

  useEffect(() => {
    setRemaining(secondsUntil(deadline));
    if (secondsUntil(deadline) <= 0) return undefined;

    const tick = () => {
      const next = secondsUntil(deadline);
      setRemaining(next);
      if (next <= 0) window.clearInterval(intervalId);
    };

    const intervalId = window.setInterval(tick, 1000);

    // A tab that comes back from the background is corrected immediately
    // rather than up to a second later.
    const catchUp = () => setRemaining(secondsUntil(deadline));
    window.addEventListener("focus", catchUp);
    document.addEventListener("visibilitychange", catchUp);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", catchUp);
      document.removeEventListener("visibilitychange", catchUp);
    };
  }, [deadline]);

  return remaining;
}
