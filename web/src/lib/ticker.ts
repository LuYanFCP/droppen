import { useEffect, useState } from "react";

/**
 * A clock for text that is relative to *now* rather than to the data.
 *
 * "3s ago" and "17m" are computed from `Date.now()`, so they are wrong the
 * moment they are painted and stay wrong until something unrelated re-renders
 * them. The sidebar's relative column was the visible form of this: it only
 * recomputed when the feed pushed, so a quiet instance showed a wall of `2m`
 * an hour after the fact.
 *
 * Returns the millisecond instant to measure against, which is also what makes
 * a component using it testable — pass the value down rather than calling
 * `Date.now()` inside the formatter.
 *
 * `active` exists so the one-second tick under a running turn stops the moment
 * the turn does, instead of re-rendering an idle transcript forever.
 */
export function useTicker(intervalMs: number, active = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    // Fires immediately as well as on the interval: a component that mounts
    // after a long idle would otherwise show a stale instant for a whole tick.
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, active]);
  return now;
}
