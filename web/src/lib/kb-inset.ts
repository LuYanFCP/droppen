/**
 * The soft keyboard, on a page whose shell is pinned to the viewport.
 *
 * This is the `legacy` keyboard handling, run only with `?kb=legacy`
 * (`lib/kb-mode.ts`). The default, `native`, leaves the keyboard to WebKit
 * (`lib/kb-native.ts`, which explains why measuring it went wrong on iOS 27).
 * `isEditable`, `fixedBoxHeight` and the arithmetic below are still used by the
 * readout (`lib/vv-debug.ts`) in both modes.
 *
 * The shell is `body { position: fixed; inset: 0 }` (index.css): it fills the
 * layout viewport and the document itself never scrolls. Android's keyboard
 * shrinks the layout viewport (the viewport meta's
 * `interactive-widget=resizes-content`), so there the shell, and the composer
 * at its foot, follow the keyboard up with no help from here.
 *
 * iOS WebKit (Safari, and every other iOS browser) never resizes the box a
 * fixed element fills for the keyboard. Only the visual viewport shrinks; the
 * keyboard is drawn over the bottom of a shell that is still full height, and
 * the bottom of that shell is the composer. Nothing in the page ever lifted it:
 * what used to was WebKit panning the visual viewport to reveal the focused
 * field. That pan is WebKit's to give, not the page's to rely on — the root
 * here has nothing to scroll — and current iOS does not give it reliably: in
 * Safari and Chrome alike the keyboard can come up over the composer with the
 * page staying put.
 *
 * So while the keyboard is up the shell is sized to the visual viewport, the
 * part of the page above the keyboard: `html.kb-open` with `--app-top` and
 * `--app-height` (index.css), read from `visualViewport` once a frame while its
 * resize and scroll events come in (and again whenever WebKit might have skipped
 * one: see the end of `startKbWatch`). The shell's foot is then the top of the
 * keyboard whether or not WebKit panned as well — a pan is followed rather than
 * fought (`offsetTop` is the shell's top), because resetting the scroll while
 * the keyboard rises is taken by iOS as a "scroll to dismiss" gesture (see
 * below). The home-indicator padding (`.pb-safe`) is dead space behind the
 * keyboard, so `kb-open` drops it too.
 *
 * What the keyboard is measured against is the height of the fixed box itself
 * (`fixedBoxHeight`, a probe with the shell's own `position: fixed; inset: 0`),
 * never `window.innerHeight`. iOS 26 WebKit can let `innerHeight` follow the
 * visual viewport down for a keyboard — in a Home Screen app for as long as it
 * is up, in a Safari tab for a few frames mid-raise — while the fixed box stays
 * full height. Measured against `innerHeight` the keyboard was there on the
 * first resize and gone a moment later: the shell rose above it, dropped back
 * to full height, and the composer went under the keyboard again (and the
 * "leftover pan" reset below then scrolled the page with the keyboard up).
 *
 * It is also measured against the visual viewport as it is with no field
 * focused (`restHeight`, the tallest seen at this width), where that is the
 * shorter: in a Safari tab the fixed box can reach under the browser's own bars,
 * and that difference is not a keyboard.
 *
 * Desktop and Android never get here: their visual viewport is the box a fixed
 * element fills (Android's keyboard shrinks both), so nothing is written and the
 * shell is exactly the CSS default. Pinch-zoom shrinks the visual viewport too
 * (iOS honours pinch even with maximum-scale=1), so a scale above 1 is read as
 * zoom, never as a keyboard. The 120px threshold sits below any real soft
 * keyboard and above the jitter from the browser's own bars.
 *
 * No field, no keyboard: iOS shows one only for a focused field, so with none
 * focused the shell is the CSS default whatever the viewport says. That is not
 * a nicety. Once the keyboard is dismissed, iOS (seen in iOS 27 Chrome) can
 * leave `visualViewport`, `innerHeight` and `scrollY` at their keyboard-up
 * values, with no event after — the pinned root never scrolls to make it read
 * again — and a shell sized from them stays a keyboard short over an empty
 * strip. So once focus has left every field for `RELEASE_MS`, the shell is
 * released and the page scrolled back to the top without waiting for the
 * viewport to agree, and read again (`release` in `startKbWatch`).
 *
 * WebKit reports the keyboard's final numbers only once its animation is over,
 * and the reveal pan after that, sometimes with no event at the end. So a field
 * gaining or losing focus is read again a few times over the next second
 * (`SETTLE_MS`); every read that finds nothing changed writes nothing.
 *
 * Leftover focus scroll: when WebKit did pan to reveal the field, the offset is
 * not always restored when the keyboard goes away — the fixed shell is then a
 * band short of the bottom of the screen. The reset may ONLY happen once the
 * keyboard is going: partway through the raise animation the keyboard does not
 * count as open yet while the offset is already non-zero, and a scrollTo there
 * is taken by iOS as a "scroll to dismiss" gesture, so the keyboard flickers up
 * and is immediately killed. Hence the release, or the open -> closed edge, the
 * delay and the re-check — and never while a field has focus, whose keyboard
 * may be on its way up.
 *
 * `lib/vv-debug.ts` shows all of these numbers live on the phone (`?vvdebug=1`).
 */

/** A soft keyboard covers at least this much of the layout viewport. */
export const KEYBOARD_MIN_PX = 120;
/** A visual viewport scaled past this is pinch-zoomed, whatever else it says. */
const ZOOM_SCALE = 1.05;
/** Room left between a revealed field and the edge it was brought inside. */
const REVEAL_MARGIN_PX = 8;
/**
 * When, after a field gains or loses focus, the keyboard is read again: iOS
 * animates it in about 250–350ms and reports its final size, and the pan that
 * follows, only after that.
 */
const SETTLE_MS = [100, 300, 600, 1000] as const;
/** How long after the keyboard went a leftover pan is reset (iOS animates it out in about 250ms). */
const RESTORE_MS = 250;
/**
 * How long focus stays off every field before the shell is released whatever
 * the viewport says: long enough for focus moving from one field to the next,
 * or put back by a script, not to count.
 */
const RELEASE_MS = 100;

/** The numbers the shell is sized from. */
export interface ViewportReading {
  /**
   * The height of the box `position: fixed; inset: 0` fills (`fixedBoxHeight`):
   * the shell's own height without `kb-open`. Not `innerHeight`, which iOS 26
   * shrinks with the keyboard while this box stays full height.
   */
  fixedHeight: number;
  /**
   * The tallest `visualViewport.height` seen at this width with no field
   * focused (so no keyboard), or `null` before there is one.
   */
  restHeight: number | null;
  /** `visualViewport.height`: what is on screen above the keyboard. */
  height: number;
  /** `visualViewport.offsetTop`: how far that is panned down the layout viewport. */
  offsetTop: number;
  scale: number;
  /** Whether a field that brings up the keyboard has focus. */
  editing: boolean;
}

/** Where the shell goes while the keyboard is up, in layout-viewport px. */
export interface ShellFrame {
  top: number;
  height: number;
}

/**
 * The shell's box for this reading: the visual viewport while a field has focus
 * and a soft keyboard covers the fixed box, `null` (the CSS default, the whole
 * fixed box) otherwise. The keyboard is what the visual viewport is short of the
 * fixed box, or of its own height at rest where that is shorter.
 */
export function keyboardFrame(r: ViewportReading): ShellFrame | null {
  if (!r.editing || r.scale > ZOOM_SCALE) return null;
  const full = r.restHeight === null ? r.fixedHeight : Math.min(r.fixedHeight, r.restHeight);
  if (full - r.height <= KEYBOARD_MIN_PX) return null;
  return { top: Math.max(0, r.offsetTop), height: r.height };
}

/**
 * How much of the bottom of the fixed box is out of sight below the visual
 * viewport — under the keyboard, for the shell at its CSS default. The shell
 * in `keyboardFrame` ends exactly where this begins.
 */
export function keyboardInset(r: Pick<ViewportReading, "fixedHeight" | "height" | "offsetTop">): number {
  return Math.max(0, r.fixedHeight - r.height - r.offsetTop);
}

/**
 * Something laid out against the shell's height that has to hold its place
 * when the keyboard changes it (the transcript, `session-detail.tsx`). Called
 * just before the shell is resized; what it returns runs once the new size is
 * in place.
 */
export type KeyboardResizeHook = () => (() => void) | void;

const resizeHooks = new Set<KeyboardResizeHook>();

/** Subscribe to the shell being resized for the keyboard; returns the unsubscribe. */
export function onKeyboardResize(hook: KeyboardResizeHook): () => void {
  resizeHooks.add(hook);
  return () => {
    resizeHooks.delete(hook);
  };
}

/** What the watch reads and writes; the browser's own in `startKbWatch()`, fakes in tests. */
export interface KbEnv {
  vv: Pick<VisualViewport, "height" | "width" | "offsetTop" | "scale" | "addEventListener" | "removeEventListener">;
  win: Pick<
    Window,
    | "scrollY"
    | "scrollTo"
    | "setTimeout"
    | "clearTimeout"
    | "requestAnimationFrame"
    | "cancelAnimationFrame"
    | "getComputedStyle"
    | "addEventListener"
    | "removeEventListener"
  >;
  doc: Pick<Document, "addEventListener" | "removeEventListener">;
  root: Pick<HTMLElement, "classList" | "style">;
  focused: () => Element | null;
  /** `ViewportReading.fixedHeight`, now. */
  fixedHeight: () => number;
}

/** The box measured by `fixedBoxHeight`; made on first use. */
let probe: HTMLElement | null = null;

/** The last reading the watch acted on (`lib/vv-debug.ts` shows its baseline). */
let lastReading: ViewportReading | null = null;

/** The last reading the watch acted on, or `null` before the first. */
export function lastKbReading(): ViewportReading | null {
  return lastReading;
}

/**
 * The height of the box `position: fixed; inset: 0` fills, which is the
 * shell's (index.css) until `kb-open` moves it: measured on a box of its own
 * with exactly those insets, so it is what WebKit lays the shell out in rather
 * than what `innerHeight` says. Where it cannot be measured (no layout yet),
 * the taller of the two viewport heights the page can ask for.
 */
export function fixedBoxHeight(): number {
  if (probe === null || !probe.isConnected) {
    probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.dataset.kbProbe = "";
    probe.style.cssText = "position:fixed;top:0;bottom:0;left:0;width:0;visibility:hidden;pointer-events:none";
    document.body.append(probe);
  }
  return probe.offsetHeight || Math.max(window.innerHeight, document.documentElement.clientHeight);
}

function browserEnv(): KbEnv | null {
  const vv = window.visualViewport;
  if (vv === null || vv === undefined) return null;
  return {
    vv,
    win: window,
    doc: document,
    root: document.documentElement,
    focused: () => document.activeElement,
    fixedHeight: fixedBoxHeight,
  };
}

/** A field that brings up the soft keyboard (or might: an `<input>` of any type). */
export function isEditable(el: Element): el is HTMLElement {
  const h = el as HTMLElement;
  return h.tagName === "TEXTAREA" || h.tagName === "INPUT" || h.tagName === "SELECT" || h.isContentEditable === true;
}

/** An editable field this module may scroll into view: all but xterm's. */
function isTextField(el: Element): el is HTMLElement {
  // xterm's helper textarea follows the terminal's cursor and the terminal
  // refits itself to the new height; moving its panes here would only fight it.
  if ((el as HTMLElement).closest?.(".xterm")) return false;
  return isEditable(el);
}

/**
 * Bring the focused field back inside the shell once it has shrunk: a field
 * that was low in a scrolling pane (a settings form) is now under the pane's
 * new bottom edge. Only the nearest pane that really scrolls is moved — never
 * an `overflow: hidden` box, which `scrollIntoView` would happily slide, and
 * never the document, which the keyboard must not see scroll. The composer is
 * the shell's foot and never needs it.
 */
export function revealInFrame(el: Element, frame: ShellFrame, win: Pick<Window, "getComputedStyle">): void {
  const r = el.getBoundingClientRect();
  const frameBottom = frame.top + frame.height;
  if (r.top >= frame.top && r.bottom <= frameBottom) return;
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const overflowY = win.getComputedStyle(p).overflowY;
    if ((overflowY !== "auto" && overflowY !== "scroll") || p.scrollHeight <= p.clientHeight) continue;
    const box = p.getBoundingClientRect();
    const top = Math.max(box.top, frame.top);
    const bottom = Math.min(box.bottom, frameBottom);
    // Down far enough to show its bottom, but never past its top: a field
    // taller than the room left shows where the typing starts.
    if (r.bottom > bottom) p.scrollTop += Math.max(0, Math.min(r.bottom - bottom + REVEAL_MARGIN_PX, r.top - top));
    else if (r.top < top) p.scrollTop -= top - r.top + REVEAL_MARGIN_PX;
    return;
  }
}

/** Start following the keyboard; returns the stop (tests; the app never stops). */
export function startKbWatch(env: KbEnv | null = browserEnv()): () => void {
  if (env === null) return () => {};
  const { vv, win, doc, root, focused } = env;

  let rest: { width: number; height: number } | null = null;
  const editing = () => {
    const field = focused();
    return field !== null && isEditable(field);
  };
  const read = (): ViewportReading => ({
    fixedHeight: env.fixedHeight(),
    restHeight: rest !== null && rest.width === vv.width ? rest.height : null,
    height: vv.height,
    offsetTop: vv.offsetTop,
    scale: vv.scale,
    editing: editing(),
  });
  let current: ShellFrame | null = null;
  let restoreTimer: number | undefined;
  let restoreWaiting = false;
  let releaseTimer: number | undefined;
  let frameRequest: number | undefined;
  let settleTimers: number[] = [];

  const write = (frame: ShellFrame | null) => {
    root.classList.toggle("kb-open", frame !== null);
    if (frame === null) {
      root.style.removeProperty("--app-top");
      root.style.removeProperty("--app-height");
    } else {
      root.style.setProperty("--app-top", `${frame.top}px`);
      root.style.setProperty("--app-height", `${frame.height}px`);
    }
  };

  const set = (frame: ShellFrame | null) => {
    const resized = (frame?.height ?? null) !== (current?.height ?? null);
    const moved = (frame?.top ?? null) !== (current?.top ?? null);
    if (resized) {
      // Each hook measures before the shell moves and settles after it, so
      // what it holds still is measured against the old height.
      const settle = [...resizeHooks].map((hook) => hook());
      write(frame);
      for (const done of settle) done?.();
      const field = focused();
      if (frame !== null && field !== null && isTextField(field)) revealInFrame(field, frame, win);
    } else if (moved) {
      write(frame);
    }
    current = frame;
  };

  const apply = () => {
    const reading = read();
    lastReading = reading;
    // The visual viewport at rest: with no field focused there is no keyboard
    // in it, though one may still be on its way down (or reported as still up),
    // which is why only the tallest counts. A new width (rotation) starts over.
    if (!reading.editing && reading.scale <= ZOOM_SCALE) {
      rest = rest !== null && rest.width === vv.width ? { width: vv.width, height: Math.max(rest.height, vv.height) } : { width: vv.width, height: vv.height };
      reading.restHeight = rest.height;
    }
    const frame = keyboardFrame(reading);
    if (frame === null && current !== null && !reading.editing && keyboardFrame({ ...reading, editing: true }) !== null) {
      // Focus has left every field and the viewport still has the keyboard in
      // it: going, or left behind by iOS. The shell holds until `release`.
      if (releaseTimer === undefined) releaseTimer = win.setTimeout(release, RELEASE_MS);
      return;
    }
    if (releaseTimer !== undefined && reading.editing) {
      win.clearTimeout(releaseTimer);
      releaseTimer = undefined;
    }
    const wasOpen = current !== null;
    set(frame);
    if (wasOpen && frame === null) restoreLater();
  };

  // Focus has stayed off every field: the keyboard is gone whatever the
  // viewport still says. Back to the CSS shell, the page back to the top (the
  // pan the keyboard left: nothing else in the page scrolls the root, and iOS
  // may not read the viewport again until it moves), and read again.
  const release = () => {
    releaseTimer = undefined;
    if (current === null || editing()) return;
    set(null);
    restoreWaiting = false;
    if (restoreTimer !== undefined) win.clearTimeout(restoreTimer);
    restoreTimer = undefined;
    win.scrollTo(0, 0);
    reread();
  };

  // Let iOS finish its own dismiss animation, then confirm the keyboard is
  // really still down before touching the scroll position (if the user
  // re-focused in the meantime, leave the new keyboard alone). A field that
  // still has focus may have its keyboard on its way up, so the reset waits
  // for focus to leave it.
  const restoreLater = () => {
    if (restoreTimer !== undefined) win.clearTimeout(restoreTimer);
    restoreTimer = win.setTimeout(() => {
      restoreTimer = undefined;
      const field = focused();
      restoreWaiting = field !== null && isEditable(field);
      if (restoreWaiting) return;
      if (keyboardFrame(read()) === null && vv.scale <= ZOOM_SCALE && (win.scrollY !== 0 || vv.offsetTop > 0)) {
        win.scrollTo(0, 0);
      }
    }, RESTORE_MS);
  };

  // One reading a frame, however many events came in during it: WebKit fires
  // resize and scroll back to back while the keyboard moves, and the last
  // numbers before the paint are the ones that count.
  const schedule = () => {
    if (frameRequest !== undefined) return;
    frameRequest = win.requestAnimationFrame(() => {
      frameRequest = undefined;
      apply();
    });
  };

  // The visual viewport's own events are the signal, but not a promise: a
  // keyboard dismissed while the page was in the background, or a layout
  // viewport that catches up only after a rotation, can leave the last
  // reading the one with the keyboard in it — and the shell a keyboard short,
  // over an empty strip. So the reading is taken again whenever any of those
  // could have happened. Every one is a no-op where nothing changed (desktop).
  // A field gaining or losing focus is read now and over the next second, as
  // the keyboard and WebKit's pan settle (moving focus to another field keeps
  // the keyboard up, and reads the same).
  const reread = () => {
    schedule();
    for (const timer of settleTimers) win.clearTimeout(timer);
    settleTimers = SETTLE_MS.map((ms) => win.setTimeout(schedule, ms));
  };
  const onFocusChange = () => {
    reread();
    if (restoreWaiting && current === null) restoreLater();
  };
  vv.addEventListener("resize", schedule);
  vv.addEventListener("scroll", schedule);
  win.addEventListener("resize", schedule);
  win.addEventListener("pageshow", schedule);
  doc.addEventListener("visibilitychange", schedule);
  doc.addEventListener("focusin", onFocusChange);
  doc.addEventListener("focusout", onFocusChange);
  apply();
  return () => {
    vv.removeEventListener("resize", schedule);
    vv.removeEventListener("scroll", schedule);
    win.removeEventListener("resize", schedule);
    win.removeEventListener("pageshow", schedule);
    doc.removeEventListener("visibilitychange", schedule);
    doc.removeEventListener("focusin", onFocusChange);
    doc.removeEventListener("focusout", onFocusChange);
    if (restoreTimer !== undefined) win.clearTimeout(restoreTimer);
    if (releaseTimer !== undefined) win.clearTimeout(releaseTimer);
    if (frameRequest !== undefined) win.cancelAnimationFrame(frameRequest);
    for (const timer of settleTimers) win.clearTimeout(timer);
  };
}
