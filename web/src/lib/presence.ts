/**
 * Whether anyone is at this page right now.
 *
 * `document.visibilityState` alone cannot say. A window left open on a
 * machine whose screen is locked with the display still on stays `visible` —
 * Chrome on macOS keeps reporting it that way behind the lock screen — and so
 * does a window on a second monitor nobody is facing. A session view in such a
 * window used to mark every answer read the second it landed, on behalf of a
 * reader who was not there: the unread count, the pane frame and the push
 * notification for that session all went quiet on every other device.
 *
 * So a page counts as attended only while it is visible *and* someone is
 * evidently at it: its window has the focus, or they did something in it — a
 * key, a pointer, a wheel, a touch, the window focused or the page shown —
 * within the last {@link IDLE_MS}. Opening the page counts as doing something.
 * Scrolling deliberately does not: a pinned transcript scrolls itself on every
 * answer, and that is the one thing an empty room does.
 *
 * The rule is pure over its inputs (`createPresence`), so it is tested with a
 * fake clock; `browserPresence` wires it to the real window once.
 */

/** How long a page with no focus stays attended after the last sign of a reader. */
export const IDLE_MS = 5 * 60_000;

/** What presence reads from the page. */
export interface PresenceSignals {
  visible(): boolean;
  focused(): boolean;
}

/** Time, and a way to be woken when the idle window runs out. */
export interface PresenceClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
}

export interface Presence {
  /**
   * Whether someone is at the page, worked out afresh. For the checks made just
   * before reporting, which must not trust a timer that a background tab may
   * have throttled.
   */
  present(): boolean;
  /**
   * The value as last announced to subscribers — what `useSyncExternalStore`
   * reads, so a render and the notification that caused it always agree.
   */
  snapshot(): boolean;
  /** Someone did something in the page, or came to it. */
  active(): void;
  /** Visibility or focus changed in a way that is not a sign of anyone (a blur, a hide). */
  recheck(): void;
  /** Called whenever {@link Presence.snapshot} flips. */
  subscribe(listener: () => void): () => void;
}

export function createPresence(signals: PresenceSignals, clock: PresenceClock, idleMs: number = IDLE_MS): Presence {
  // Opening the page is the first sign of a reader.
  let lastActive = clock.now();
  const compute = () => signals.visible() && (signals.focused() || clock.now() - lastActive < idleMs);
  let current = compute();
  let timer: unknown = undefined;
  const listeners = new Set<() => void>();

  const update = () => {
    const next = compute();
    arm();
    if (next === current) return;
    current = next;
    for (const listener of [...listeners]) listener();
  };

  // One timer for the idle window, armed only while it is the idle window that
  // keeps the page attended. It is not moved on every pointer move: when it
  // fires early because there was activity since, it re-arms for what is left.
  const arm = () => {
    if (timer !== undefined) return;
    if (!signals.visible() || signals.focused()) return;
    const left = lastActive + idleMs - clock.now();
    if (left <= 0) return;
    timer = clock.setTimeout(() => {
      timer = undefined;
      update();
    }, left);
  };
  arm();

  return {
    present: compute,
    snapshot: () => current,
    active() {
      lastActive = clock.now();
      // The common case — a pointer moving over a page already attended — is
      // one assignment: nothing flips, and the armed timer re-arms itself.
      if (current && timer !== undefined) return;
      update();
    },
    recheck: update,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** What a page with no document reads: nobody, ever. */
const NOBODY: Presence = {
  present: () => false,
  snapshot: () => false,
  active: () => {},
  recheck: () => {},
  subscribe: () => () => {},
};

let shared: Presence | null = null;

/**
 * The page's presence, wired to its window on first use and kept for the life
 * of the page: one set of listeners however many views ask.
 */
export function browserPresence(): Presence {
  if (typeof window === "undefined" || typeof document === "undefined") return NOBODY;
  if (shared) return shared;
  const presence = createPresence(
    {
      visible: () => document.visibilityState === "visible",
      focused: () => document.hasFocus(),
    },
    {
      now: () => Date.now(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    },
  );
  const active = () => presence.active();
  const options: AddEventListenerOptions = { capture: true, passive: true };
  for (const type of ["pointerdown", "pointermove", "keydown", "wheel", "touchstart"]) {
    window.addEventListener(type, active, options);
  }
  window.addEventListener("focus", active);
  window.addEventListener("blur", () => presence.recheck());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") presence.active();
    else presence.recheck();
  });
  shared = presence;
  return presence;
}
