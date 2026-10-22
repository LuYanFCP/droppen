import { useSyncExternalStore } from "react";

/**
 * Whether the reader asked the system for less motion.
 *
 * The app's only motion is the 1 Hz liveness blink ([`LiveDot`] and the
 * working pane's glow), and under this setting both hold still in their
 * colour: the state stays readable, nothing moves.
 */
const QUERY = "(prefers-reduced-motion: reduce)";

function media(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
}

function subscribe(onChange: () => void): () => void {
  const mq = media();
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

const getSnapshot = () => media()?.matches ?? false;
// A prerender (and the tests) has no media queries: full motion is the default.
const getServerSnapshot = () => false;

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
