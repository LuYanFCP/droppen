import { useSyncExternalStore } from "react";
import { cn } from "@/lib/cn";
import { usePrefersReducedMotion } from "@/lib/reduced-motion";

/**
 * The "this is still going" mark, drawn without a CSS animation.
 *
 * Every long-lived liveness cue in this UI used to be `animate-pulse` or a
 * spinning `Loader2`, and those are the most expensive thing on the screen by a
 * wide margin. A running CSS animation makes Chromium schedule a frame every
 * vsync for as long as it runs, whether or not the pixels change — so two open
 * session panes with a handful of status dots held the compositor at the
 * display's full refresh rate forever. Measured on the real site at 165 Hz,
 * with no mouse, no scroll and no rAF: 165 frames a second, and an A/B against
 * `getAnimations().forEach(a => a.pause())` moved total CPU from 40% of a core
 * to 11%. Worse, the gradient dot and the SVG spinners never made it onto the
 * compositor, so ~19% of that was style and paint on the *main* thread, which
 * is the thread the transcript needs.
 *
 * `steps()` does not help (the frame is scheduled regardless of how often the
 * value visibly changes) and `will-change` only moves the cost to the
 * compositor, which the same A/B shows is still ~13% of a core. The only fix is
 * to stop having a running animation at all, so this draws the same two-state
 * blink from React state at 1 Hz: ~1 frame a second instead of ~165, and
 * `document.getAnimations()` stays empty while a session works.
 *
 * One shared clock rather than a timer per dot, for two reasons. A screen with
 * a sidebar, an active-work bar and a transcript can hold a dozen of these, and
 * a dozen independent intervals would be a dozen staggered repaints a second
 * instead of one; and drifting phases would look like a fault rather than a
 * heartbeat. The interval only exists while something is subscribed, so a page
 * with nothing running has no timer either.
 */
const HEARTBEAT_MS = 1000;

const listeners = new Set<() => void>();
let beat = 0;
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(onChange: () => void): () => void {
  listeners.add(onChange);
  if (timer === null) {
    timer = setInterval(() => {
      beat += 1;
      for (const listener of listeners) listener();
    }, HEARTBEAT_MS);
  }
  return () => {
    listeners.delete(onChange);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    // `beat` deliberately survives: a dot that unmounts and comes back a moment
    // later rejoins the phase its neighbours are already in.
  };
}

const getSnapshot = () => beat;
/** A subscription that never fires, for a caller that wants no clock. */
const still = () => () => {};
// `renderToStaticMarkup` (the tests, and any future prerender) has no clock and
// must not try to read one; without this third argument React throws there.
const getServerSnapshot = () => 0;

/**
 * The shared 1 Hz beat, as a counter. Even/odd is the blink; the number is
 * there so a caller that wants more than two phases can have them.
 *
 * `enabled: false` holds the beat at 0 without joining the clock — for a
 * reader who asked for reduced motion, or a caller with nothing live to show —
 * so a page where nothing may move runs no timer at all.
 */
export function useHeartbeat(enabled = true): number {
  const beatNow = useSyncExternalStore(enabled ? subscribe : still, getSnapshot, getServerSnapshot);
  return enabled ? beatNow : 0;
}

/**
 * A small round dot that blinks once a second while it is on screen.
 *
 * Colour comes from `bg-current` by default, so a dot inside a coloured line
 * (the green working banner, the amber reconnect notice) is already the right
 * colour; pass `bg-ok` / `bg-accent` / anything else through `className` to
 * override it, and `size-*` likewise.
 */
export function LiveDot({ className, title }: { className?: string; title?: string }) {
  // Under reduced motion the dot holds still, lit: the colour still says "live".
  const beatNow = useHeartbeat(!usePrefersReducedMotion());
  return (
    <span
      title={title}
      // A stable handle for the tests, which render to a string and would
      // otherwise have to assert on Tailwind colour classes to prove the
      // "still running" affordance survived losing its animation.
      data-live=""
      // A status dot: round on purpose (V1) and a state signal wherever it sits (V4).
      data-shape="dot"
      data-signal="live"
      // No `transition-opacity`: a transition is an animation too, and one that
      // restarts every second is exactly the always-running animation this
      // component exists to remove.
      className={cn(
        "size-1.5 shrink-0 rounded-full bg-current",
        beatNow % 2 === 0 ? "opacity-100" : "opacity-40",
        className,
      )}
    />
  );
}
