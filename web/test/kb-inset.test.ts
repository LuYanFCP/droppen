// The phone keyboard and the app shell (`lib/kb-inset.ts`): on iOS, where the
// keyboard only shrinks the visual viewport, the shell is sized to what is on
// screen above it, so the composer at its foot is never under the keyboard;
// on desktop and Android nothing is written and the shell is the CSS default.
//
// A fake `visualViewport` stands in for the browser: the numbers are an
// iPhone's (a 844px layout viewport, a 336px keyboard), and the events are
// fired by hand in the order WebKit fires them. The watch reads once a frame;
// the fake page runs that frame straight after each event, unless a test holds
// frames back to see several events land in one.
import assert from "node:assert/strict";
import test from "node:test";
import {
  KEYBOARD_MIN_PX,
  keyboardFrame,
  keyboardInset,
  type KbEnv,
  lastKbReading,
  onKeyboardResize,
  revealInFrame,
  startKbWatch,
} from "../src/lib/kb-inset.js";

const SCREEN = 844;
const KEYBOARD = 336;

/** Listeners by event type, fired by hand; `after` runs once they all have (the frame that follows). */
class FakeTarget {
  private listeners = new Map<string, Set<() => void>>();
  after: () => void = () => {};
  addEventListener(type: string, fn: () => void) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(fn);
  }
  removeEventListener(type: string, fn: () => void) {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string) {
    for (const fn of this.listeners.get(type) ?? []) fn();
    this.after();
  }
  listening(): number {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

class FakeViewport extends FakeTarget {
  height = SCREEN;
  width = 390;
  offsetTop = 0;
  scale = 1;
}

interface BoxInit {
  parent?: FakeBox | null;
  overflowY?: string;
  scrollHeight?: number;
  clientHeight?: number;
  tagName?: string;
  inXterm?: boolean;
}

/**
 * A laid-out box. `place` is where layout put it in the layout viewport before
 * any scrolling — fixed numbers, or a function of the page (the shell's foot);
 * its client rect then moves up by every ancestor's `scrollTop`, as a real one does.
 */
class FakeBox {
  scrollTop = 0;
  parentElement: FakeBox | null;
  overflowY: string;
  scrollHeight: number;
  clientHeight: number;
  tagName: string;
  private inXterm: boolean;
  constructor(
    private place: () => [number, number],
    init: BoxInit = {},
  ) {
    this.parentElement = init.parent ?? null;
    this.overflowY = init.overflowY ?? "visible";
    this.scrollHeight = init.scrollHeight ?? 0;
    this.clientHeight = init.clientHeight ?? 0;
    this.tagName = init.tagName ?? "DIV";
    this.inXterm = init.inXterm ?? false;
  }
  getBoundingClientRect() {
    let shift = 0;
    for (let p = this.parentElement; p !== null; p = p.parentElement) shift += p.scrollTop;
    const [top, bottom] = this.place();
    return { top: top - shift, bottom: bottom - shift };
  }
  closest(sel: string) {
    return sel === ".xterm" && this.inXterm ? this : null;
  }
}

const at = (top: number, bottom: number) => (): [number, number] => [top, bottom];
const styles = { getComputedStyle: (el: FakeBox) => ({ overflowY: el.overflowY }) } as unknown as Window;

function fakePage() {
  const vv = new FakeViewport();
  const winEvents = new FakeTarget();
  const doc = new FakeTarget();
  const classes = new Set<string>();
  const vars = new Map<string, string>();
  const timers = new Map<number, () => void>();
  const frames = new Map<number, () => void>();
  let nextId = 1;
  const scrolls: [number, number][] = [];
  let focused: FakeBox | null = null;
  let holdFrames = false;
  /** The box `position: fixed; inset: 0` fills (the probe in the browser). */
  const fixed = { height: SCREEN };
  const runFrames = () => {
    while (frames.size > 0) {
      const pending = [...frames.values()];
      frames.clear();
      for (const fn of pending) fn();
    }
  };
  for (const target of [vv, winEvents, doc]) target.after = () => holdFrames || runFrames();
  const win = {
    // What iOS 26 lets follow the keyboard: nothing here may read it.
    innerHeight: SCREEN,
    scrollY: 0,
    scrollTo: (x: number, y: number) => void scrolls.push([x, y]),
    setTimeout: (fn: () => void) => {
      const id = nextId++;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id: number) => void timers.delete(id),
    requestAnimationFrame: (fn: () => void) => {
      const id = nextId++;
      frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (id: number) => void frames.delete(id),
    getComputedStyle: (el: FakeBox) => ({ overflowY: el.overflowY }),
    addEventListener: (type: string, fn: () => void) => winEvents.addEventListener(type, fn),
    removeEventListener: (type: string, fn: () => void) => winEvents.removeEventListener(type, fn),
  };
  const root = {
    classList: { toggle: (name: string, on: boolean) => void (on ? classes.add(name) : classes.delete(name)) },
    style: {
      setProperty: (k: string, v: string) => void vars.set(k, v),
      removeProperty: (k: string) => void vars.delete(k),
    },
  };
  const env = { vv, win, doc, root, focused: () => focused, fixedHeight: () => fixed.height } as unknown as KbEnv;
  /** The field a keyboard comes up for when a test has not focused one of its own. */
  const field = new FakeBox(at(100, 140), { tagName: "INPUT" });
  return {
    vv,
    win,
    winEvents,
    doc,
    classes,
    vars,
    scrolls,
    env,
    fixed,
    focus: (el: FakeBox | null) => void (focused = el),
    /** Run the pending timers, as their delays passing would, and the frames they ask for. */
    flushTimers: () => {
      runFrames();
      while (timers.size > 0) {
        const pending = [...timers.values()];
        timers.clear();
        for (const fn of pending) fn();
        runFrames();
      }
    },
    pendingTimers: () => timers.size,
    /** Hold frames back (several events in one frame) until `runFrames`. */
    holdFrames: (on: boolean) => void (holdFrames = on),
    runFrames,
    pendingFrames: () => frames.size,
    /**
     * The bottom of the shell in the layout viewport: `body { inset: 0 }`, or
     * `top`/`height` from the variables under `html.kb-open` (index.css).
     */
    shellFoot: () =>
      classes.has("kb-open") ? parseFloat(vars.get("--app-top") ?? "0") + parseFloat(vars.get("--app-height") ?? `${fixed.height}`) : fixed.height,
    /**
     * The keyboard has finished coming up for the focused field (a plain input
     * when the test focused none), panned down by `pan` or not at all.
     */
    keyboardUp: (pan = 0) => {
      focused ??= field;
      vv.height = SCREEN - KEYBOARD;
      vv.offsetTop = pan;
      vv.fire("resize");
    },
    /** The field let go and the keyboard gone, the visual viewport saying so. */
    keyboardDown: () => {
      focused = null;
      vv.height = SCREEN;
      vv.offsetTop = 0;
      vv.fire("resize");
    },
  };
}

/** A reading with a field focused and no resting height yet, as most of these are. */
const typing = (r: { fixedHeight: number; height: number; offsetTop: number; scale: number }) => ({ ...r, restHeight: null, editing: true });

test("the frame: the visual viewport while a keyboard covers the page, nothing otherwise", () => {
  // Desktop, and a phone without a keyboard: the visual viewport is the layout viewport.
  assert.equal(keyboardFrame(typing({ fixedHeight: SCREEN, height: SCREEN, offsetTop: 0, scale: 1 })), null);
  // iOS, the keyboard up and the page not moved (the bug): the shell ends at the keyboard.
  assert.deepEqual(keyboardFrame(typing({ fixedHeight: SCREEN, height: 508, offsetTop: 0, scale: 1 })), { top: 0, height: 508 });
  // iOS, the keyboard up and WebKit panned to the field: the shell follows the pan.
  assert.deepEqual(keyboardFrame(typing({ fixedHeight: SCREEN, height: 508, offsetTop: 336, scale: 1 })), { top: 336, height: 508 });
  // Android with interactive-widget=resizes-content: the layout viewport shrank with it.
  assert.equal(keyboardFrame(typing({ fixedHeight: 508, height: 508, offsetTop: 0, scale: 1 })), null);
  // Pinch-zoom shrinks the visual viewport too, and is not a keyboard.
  assert.equal(keyboardFrame(typing({ fixedHeight: SCREEN, height: SCREEN / 2, offsetTop: 100, scale: 2 })), null);
  // The browser's own bars, or a visual viewport left a little short after the
  // keyboard went away, are not a keyboard either.
  assert.equal(keyboardFrame(typing({ fixedHeight: SCREEN, height: SCREEN - 24, offsetTop: 0, scale: 1 })), null);
  assert.equal(keyboardFrame(typing({ fixedHeight: SCREEN, height: SCREEN - KEYBOARD_MIN_PX, offsetTop: 0, scale: 1 })), null);
  // No field focused, no keyboard, whatever the viewport says (iOS leaves it
  // at the keyboard's numbers after a dismiss).
  assert.equal(keyboardFrame({ fixedHeight: SCREEN, restHeight: SCREEN, height: 508, offsetTop: 277, scale: 1, editing: false }), null);
  // A Safari tab whose fixed box reaches 140px under the browser's bars: at
  // rest, and with a field focused but no keyboard, that is no keyboard; the
  // keyboard is what the visual viewport is short of its resting height.
  const bar = { fixedHeight: SCREEN, restHeight: SCREEN - 140, offsetTop: 0, scale: 1, editing: true };
  assert.equal(keyboardFrame({ ...bar, height: SCREEN - 140 }), null);
  assert.deepEqual(keyboardFrame({ ...bar, height: SCREEN - KEYBOARD }), { top: 0, height: SCREEN - KEYBOARD });
  // A resting height taller than the fixed box (the box ends above a floating
  // bar) leaves the fixed box the measure.
  assert.deepEqual(keyboardFrame({ ...bar, fixedHeight: SCREEN - 60, restHeight: SCREEN, height: SCREEN - KEYBOARD }), {
    top: 0,
    height: SCREEN - KEYBOARD,
  });
});

test("the inset: how much of the fixed box is below what is on screen", () => {
  // No keyboard, and the keyboard with WebKit's full reveal pan: nothing below.
  assert.equal(keyboardInset({ fixedHeight: SCREEN, height: SCREEN, offsetTop: 0, scale: 1 }), 0);
  assert.equal(keyboardInset({ fixedHeight: SCREEN, height: SCREEN - KEYBOARD, offsetTop: KEYBOARD, scale: 1 }), 0);
  // The keyboard with no pan, and partway through one: what the keyboard covers.
  assert.equal(keyboardInset({ fixedHeight: SCREEN, height: SCREEN - KEYBOARD, offsetTop: 0, scale: 1 }), KEYBOARD);
  assert.equal(keyboardInset({ fixedHeight: SCREEN, height: SCREEN - KEYBOARD, offsetTop: 100, scale: 1 }), KEYBOARD - 100);
  // A visual viewport reaching past the fixed box (iOS 26's floating Safari
  // bar ends the fixed box above it) is no inset.
  assert.equal(keyboardInset({ fixedHeight: SCREEN - 60, height: SCREEN, offsetTop: 0, scale: 1 }), 0);
  // While the keyboard is up, the shell ends exactly where the inset begins.
  for (const offsetTop of [0, 100, KEYBOARD]) {
    const r = typing({ fixedHeight: SCREEN, height: SCREEN - KEYBOARD, offsetTop, scale: 1 });
    const frame = keyboardFrame(r)!;
    assert.equal(frame.top + frame.height + keyboardInset(r), SCREEN, `pan ${offsetTop}`);
  }
});

test("without a keyboard nothing is written: desktop keeps the CSS shell", () => {
  const page = fakePage();
  startKbWatch(page.env);
  page.vv.fire("resize");
  page.vv.fire("scroll");
  page.winEvents.fire("resize");
  page.winEvents.fire("pageshow");
  page.doc.fire("visibilitychange");
  page.doc.fire("focusin");
  page.doc.fire("focusout");
  page.flushTimers();
  assert.equal(page.classes.size, 0);
  assert.equal(page.vars.size, 0);
  assert.deepEqual(page.scrolls, []);
});

test("a browser without visualViewport is left alone", () => {
  const stop = startKbWatch(null);
  stop();
});

test("the keyboard coming up sizes the shell to the part of the page above it", () => {
  const page = fakePage();
  startKbWatch(page.env);
  page.keyboardUp();
  assert.ok(page.classes.has("kb-open"));
  assert.equal(page.vars.get("--app-top"), "0px");
  assert.equal(page.vars.get("--app-height"), `${SCREEN - KEYBOARD}px`);
  // Going away again hands the shell back to the CSS default.
  page.keyboardDown();
  assert.ok(!page.classes.has("kb-open"));
  assert.equal(page.vars.size, 0);
});

test("the focused composer at the shell's foot ends up on screen, above the keyboard", () => {
  for (const pan of [0, KEYBOARD]) {
    const page = fakePage();
    const shell = new FakeBox(() => [0, page.shellFoot()], { overflowY: "hidden" });
    // The last row of the shell: wherever its foot is, 10px of padding below it.
    const composer = new FakeBox(() => [page.shellFoot() - 90, page.shellFoot() - 10], { parent: shell, tagName: "TEXTAREA" });
    page.focus(composer);
    startKbWatch(page.env);
    // Before: the foot of the full-height shell, which the keyboard will cover.
    assert.equal(composer.getBoundingClientRect().bottom, SCREEN - 10);
    // pan 0 is the reported bug (WebKit leaves the page where it is); pan
    // KEYBOARD is WebKit revealing the field itself, which must still hold.
    page.keyboardUp(pan);
    const r = composer.getBoundingClientRect();
    const onScreenTop = page.vv.offsetTop;
    const keyboardTop = page.vv.offsetTop + page.vv.height;
    assert.ok(r.top >= onScreenTop && r.bottom <= keyboardTop, `pan ${pan}: composer ${r.top}–${r.bottom} not within ${onScreenTop}–${keyboardTop}`);
    assert.equal(keyboardTop - r.bottom, 10, `pan ${pan}: it sits right on the keyboard`);
    assert.equal(shell.scrollTop, 0);
  }
});

/**
 * The session composer as laid out: the shell's last row, 10px of padding
 * below it, focused. Its client rect is wherever the shell's foot is.
 */
function focusedComposer(page: ReturnType<typeof fakePage>): FakeBox {
  const shell = new FakeBox(() => [0, page.shellFoot()], { overflowY: "hidden" });
  const composer = new FakeBox(() => [page.shellFoot() - 90, page.shellFoot() - 10], { parent: shell, tagName: "TEXTAREA" });
  page.focus(composer);
  return composer;
}

/** The composer is on screen: below the visual viewport's top, above the keyboard. */
function assertOnScreen(page: ReturnType<typeof fakePage>, composer: FakeBox, when: string) {
  const r = composer.getBoundingClientRect();
  const top = page.vv.offsetTop;
  const keyboardTop = page.vv.offsetTop + page.vv.height;
  assert.ok(r.top >= top && r.bottom <= keyboardTop, `${when}: composer ${r.top}–${r.bottom} not within ${top}–${keyboardTop}`);
}

test("rise then fall, iOS 26 Home Screen app: innerHeight follows the keyboard down, the fixed box does not", () => {
  const page = fakePage();
  const composer = focusedComposer(page);
  startKbWatch(page.env);
  page.doc.fire("focusin");
  // The visual viewport reports the keyboard first: the composer rises.
  page.vv.height = SCREEN - KEYBOARD;
  page.vv.fire("resize");
  assertOnScreen(page, composer, "risen");
  // Then innerHeight follows it down, while the box the fixed shell fills
  // stays full height. Read against innerHeight, this was the fall: no
  // keyboard any more, the shell back to full height, the composer under it.
  page.win.innerHeight = SCREEN - KEYBOARD;
  page.winEvents.fire("resize");
  page.vv.fire("resize");
  assertOnScreen(page, composer, "innerHeight caught up");
  assert.equal(
    keyboardFrame({ fixedHeight: page.win.innerHeight, height: page.vv.height, offsetTop: page.vv.offsetTop, scale: 1 }),
    null,
    "the old baseline reads this as no keyboard",
  );
  // WebKit's reveal pan, late, and the readings after the animation.
  page.vv.offsetTop = 120;
  page.win.scrollY = 120;
  page.vv.fire("scroll");
  assertOnScreen(page, composer, "panned");
  page.flushTimers();
  assertOnScreen(page, composer, "settled");
  assert.ok(page.classes.has("kb-open"));
  // And nothing reset the pan under the keyboard (the old fall's second half).
  assert.deepEqual(page.scrolls, []);
});

test("rise then fall, iOS 26 Safari tab: innerHeight dips to the visual viewport for a few frames mid-raise", () => {
  const page = fakePage();
  const composer = focusedComposer(page);
  startKbWatch(page.env);
  page.doc.fire("focusin");
  // The keyboard animating up, one resize a step; partway, innerHeight dips
  // to the visual viewport with a window resize, and comes back with none.
  for (const [height, inner] of [
    [700, SCREEN],
    [600, 600],
    [SCREEN - KEYBOARD, SCREEN - KEYBOARD],
  ] as const) {
    page.vv.height = height;
    page.win.innerHeight = inner;
    page.vv.fire("resize");
    page.winEvents.fire("resize");
    assertOnScreen(page, composer, `vv ${height} inner ${inner}`);
  }
  page.win.innerHeight = SCREEN;
  page.flushTimers();
  assertOnScreen(page, composer, "settled");
  assert.equal(page.vars.get("--app-height"), `${SCREEN - KEYBOARD}px`);
  assert.deepEqual(page.scrolls, []);
});

test("WebKit's reveal pan and its undoing: the shell follows both, the composer never under the keyboard", () => {
  const page = fakePage();
  const composer = focusedComposer(page);
  startKbWatch(page.env);
  page.doc.fire("focusin");
  page.keyboardUp();
  assertOnScreen(page, composer, "up, not panned");
  // WebKit pans down to the field in steps, then (the rise-and-fall it can
  // also do) back up to the top.
  for (const pan of [80, 200, KEYBOARD, 200, 0]) {
    page.vv.offsetTop = pan;
    page.win.scrollY = pan;
    page.vv.fire("scroll");
    assertOnScreen(page, composer, `pan ${pan}`);
    assert.equal(page.vars.get("--app-top"), `${pan}px`);
  }
  page.flushTimers();
  assertOnScreen(page, composer, "settled");
  assert.deepEqual(page.scrolls, []);
});

test("the keyboard's final size is read once it settles, with no event to say so", () => {
  const page = fakePage();
  const composer = focusedComposer(page);
  startKbWatch(page.env);
  page.doc.fire("focusin");
  page.vv.height = 700;
  page.vv.fire("resize");
  assert.equal(page.vars.get("--app-height"), "700px");
  // The rest of the animation reports nothing; the reads after focus catch it.
  page.vv.height = SCREEN - KEYBOARD;
  page.vv.offsetTop = 40;
  assert.equal(page.vars.get("--app-height"), "700px");
  page.flushTimers();
  assert.equal(page.vars.get("--app-height"), `${SCREEN - KEYBOARD}px`);
  assert.equal(page.vars.get("--app-top"), "40px");
  assertOnScreen(page, composer, "settled");
});

test("events within one frame are read once, with the numbers from its end", () => {
  const page = fakePage();
  focusedComposer(page);
  startKbWatch(page.env);
  let resizes = 0;
  const off = onKeyboardResize(() => void resizes++);
  try {
    page.holdFrames(true);
    page.vv.height = 700;
    page.vv.fire("resize");
    page.vv.height = SCREEN - KEYBOARD;
    page.vv.fire("resize");
    page.vv.offsetTop = 40;
    page.vv.fire("scroll");
    page.winEvents.fire("resize");
    assert.equal(page.vars.size, 0, "nothing before the frame");
    assert.equal(page.pendingFrames(), 1);
    page.runFrames();
    assert.equal(resizes, 1);
    assert.equal(page.vars.get("--app-height"), `${SCREEN - KEYBOARD}px`);
    assert.equal(page.vars.get("--app-top"), "40px");
  } finally {
    off();
  }
});

test("a leftover pan is never reset while a field has focus, and is once focus leaves it", () => {
  const page = fakePage();
  focusedComposer(page);
  startKbWatch(page.env);
  page.keyboardUp(KEYBOARD);
  // The keyboard reads as gone with the field still focused — a hardware
  // keyboard, or the next one on its way up: a scroll now could dismiss it.
  page.vv.height = SCREEN;
  page.vv.offsetTop = 0;
  page.win.scrollY = 40;
  page.vv.fire("resize");
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"));
  assert.deepEqual(page.scrolls, []);
  // Focus moves to another field: still not.
  focusedComposer(page);
  page.doc.fire("focusin");
  page.flushTimers();
  assert.deepEqual(page.scrolls, []);
  // Focus leaves the fields with no keyboard up: the pan left behind goes.
  page.focus(null);
  page.doc.fire("focusout");
  page.flushTimers();
  assert.deepEqual(page.scrolls, [[0, 0]]);
  // Once.
  page.doc.fire("focusin");
  page.flushTimers();
  assert.equal(page.scrolls.length, 1);
});

/**
 * The owner's phone (iOS 27 Chrome, a browser tab), from the readout's log:
 * a 711px fixed box, the keyboard raised to a 434px visual viewport, and the
 * pan WebKit made to the composer — offsetTop, innerHeight and scrollY.
 */
const IOS27 = { height: 711, width: 414, keyboard: 434 };
const IOS27_PAN: readonly (readonly [number, number, number])[] = [
  [3, 708, 3],
  [36, 675, 36],
  [96, 615, 96],
  [167.7, 543, 168],
  [231.3, 480, 231],
  [270.3, 441, 270],
  [270.3, 434, 277],
  [277, 434, 277],
];

/** The owner's phone with the composer focused, the keyboard up and the page panned, as logged. */
function ios27KeyboardUp() {
  const page = fakePage();
  page.fixed.height = IOS27.height;
  page.vv.height = IOS27.height;
  page.vv.width = IOS27.width;
  page.win.innerHeight = IOS27.height;
  startKbWatch(page.env);
  const composer = focusedComposer(page);
  page.doc.fire("focusin");
  page.vv.height = IOS27.keyboard;
  page.vv.fire("resize");
  assertOnScreen(page, composer, "risen");
  for (const [top, inner, y] of IOS27_PAN) {
    page.vv.offsetTop = top;
    page.win.innerHeight = inner;
    page.win.scrollY = y;
    page.winEvents.fire("scroll");
    page.vv.fire("scroll");
    assertOnScreen(page, composer, `pan ${top}`);
  }
  assert.ok(page.classes.has("kb-open"));
  return page;
}

/** Focus leaves the composer and nothing else changes: iOS 27 keeps the keyboard's numbers, with no event. */
function dismissStale(page: ReturnType<typeof fakePage>) {
  page.focus(null);
  page.doc.fire("focusout");
}

test("dismissed, iOS 27 Chrome tab: the viewport keeps the keyboard's numbers, and the shell is released anyway", () => {
  const page = ios27KeyboardUp();
  dismissStale(page);
  assert.ok(page.classes.has("kb-open"), "not at once: focus may only be moving to the next field");
  page.flushTimers();
  // Released whatever the viewport says: the CSS shell, full height, and the
  // pan the keyboard left scrolled back.
  assert.ok(!page.classes.has("kb-open"));
  assert.equal(page.vars.size, 0);
  assert.equal(page.shellFoot(), IOS27.height);
  assert.deepEqual(page.scrolls, [[0, 0]]);
  // Still the keyboard's numbers, read again and again: still released.
  assert.equal(page.vv.height, IOS27.keyboard);
  page.vv.fire("resize");
  page.winEvents.fire("resize");
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"));
  // iOS reads the viewport again once the page has moved: nothing to do.
  page.vv.height = IOS27.height;
  page.vv.offsetTop = 0;
  page.win.innerHeight = IOS27.height;
  page.win.scrollY = 0;
  page.vv.fire("scroll");
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"));
  assert.deepEqual(page.scrolls, [[0, 0]], "scrolled back once");
});

test("tapped again right after the dismiss, before iOS reads the viewport again: the shell rises for the new keyboard", () => {
  const page = ios27KeyboardUp();
  dismissStale(page);
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"));
  // The resting height is the one from before the keyboard: the numbers it
  // left behind, read with no field focused, did not lower it.
  assert.equal(lastKbReading()?.restHeight, IOS27.height);
  // The composer tapped again; iOS reports the page back at the top, then the
  // keyboard and its pan, as the first time.
  const composer = focusedComposer(page);
  page.doc.fire("focusin");
  page.vv.offsetTop = 0;
  page.win.scrollY = 0;
  page.vv.fire("scroll");
  assert.ok(page.classes.has("kb-open"));
  assertOnScreen(page, composer, "tapped again");
  for (const [top, inner, y] of IOS27_PAN) {
    page.vv.offsetTop = top;
    page.win.innerHeight = inner;
    page.win.scrollY = y;
    page.vv.fire("scroll");
    assertOnScreen(page, composer, `pan ${top}`);
  }
  page.flushTimers();
  assert.ok(page.classes.has("kb-open"));
  assertOnScreen(page, composer, "settled");
  assert.deepEqual(page.scrolls, [[0, 0]], "the second keyboard is never scrolled");
});

test("focus leaving a field and coming straight back is not a dismissal", () => {
  const page = ios27KeyboardUp();
  // A script blurs and refocuses the composer (or focus goes to the next field).
  page.focus(null);
  page.doc.fire("focusout");
  const composer = focusedComposer(page);
  page.doc.fire("focusin");
  page.flushTimers();
  assert.ok(page.classes.has("kb-open"));
  assertOnScreen(page, composer, "refocused");
  assert.deepEqual(page.scrolls, []);
});

test("a Safari tab whose fixed box reaches under the browser's bar is never kb-open without a keyboard", () => {
  const page = fakePage();
  // At rest the visual viewport is 140px short of the fixed box: the bar's,
  // over the 120px a keyboard is told by.
  const rest = SCREEN - 140;
  page.vv.height = rest;
  startKbWatch(page.env);
  page.vv.fire("resize");
  page.vv.fire("scroll");
  page.winEvents.fire("resize");
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"), "no field focused");
  // A field focused with no keyboard (a hardware one, or focus from a script).
  const composer = focusedComposer(page);
  page.doc.fire("focusin");
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"), "a field focused, no keyboard");
  assert.equal(page.vars.size, 0);
  // The keyboard: the shell above it.
  page.vv.height = SCREEN - KEYBOARD;
  page.vv.fire("resize");
  assert.ok(page.classes.has("kb-open"));
  assertOnScreen(page, composer, "keyboard up");
  // Dismissed: back to the CSS shell.
  page.focus(null);
  page.doc.fire("focusout");
  page.vv.height = rest;
  page.vv.fire("resize");
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"));
  assert.equal(page.vars.size, 0);
});

test("the resting height: the tallest seen with no field focused, started over at a new width", () => {
  const page = fakePage();
  startKbWatch(page.env);
  assert.equal(lastKbReading()?.restHeight, SCREEN);
  // A keyboard left behind after the field let go reads shorter: not taken.
  page.keyboardUp();
  page.focus(null);
  page.doc.fire("focusout");
  page.flushTimers();
  assert.equal(lastKbReading()?.restHeight, SCREEN);
  // Rotated: the landscape viewport is its own.
  page.vv.width = SCREEN;
  page.vv.height = 390;
  page.fixed.height = 390;
  page.winEvents.fire("resize");
  assert.equal(lastKbReading()?.restHeight, 390);
});

test("a pan by WebKit is followed, not fought", () => {
  const page = fakePage();
  startKbWatch(page.env);
  page.keyboardUp(KEYBOARD);
  assert.equal(page.vars.get("--app-top"), `${KEYBOARD}px`);
  // The user drags the page under the keyboard: the shell stays on screen.
  page.vv.offsetTop = 120;
  page.vv.fire("scroll");
  assert.equal(page.vars.get("--app-top"), "120px");
  assert.equal(page.vars.get("--app-height"), `${SCREEN - KEYBOARD}px`);
  // And nothing scrolls the document while the keyboard is up.
  page.flushTimers();
  assert.deepEqual(page.scrolls, []);
});

test("a leftover pan is reset only after the keyboard has gone, and only if it is still gone", () => {
  const page = fakePage();
  startKbWatch(page.env);
  // Partway through the raise: panned, but not yet tall enough to count. A
  // scrollTo here would dismiss the keyboard, so nothing may be scheduled.
  page.vv.height = SCREEN - 80;
  page.vv.offsetTop = 60;
  page.vv.fire("scroll");
  assert.equal(page.pendingTimers(), 0);
  page.keyboardUp(KEYBOARD);
  // Dismissed, with WebKit leaving the pan behind.
  page.focus(null);
  page.vv.height = SCREEN;
  page.vv.offsetTop = 0;
  page.win.scrollY = 40;
  page.vv.fire("resize");
  assert.deepEqual(page.scrolls, [], "not at once: iOS is still animating");
  page.flushTimers();
  assert.deepEqual(page.scrolls, [[0, 0]]);

  // Dismissed and refocused before the delay ran out: the new keyboard is left alone.
  page.scrolls.length = 0;
  page.keyboardUp();
  page.vv.height = SCREEN;
  page.vv.fire("resize");
  page.keyboardUp();
  page.flushTimers();
  assert.deepEqual(page.scrolls, []);
});

test("a keyboard that went away without a last visualViewport resize is still noticed", () => {
  // Each of these is a moment WebKit can have skipped the resize: the keyboard
  // dismissed in the background (pageshow, visibilitychange), the layout
  // viewport catching up after a rotation (window resize), the field let go
  // (focusout, read again once the keyboard has had time to go).
  for (const [target, type] of [
    ["win", "resize"],
    ["win", "pageshow"],
    ["doc", "visibilitychange"],
    ["doc", "focusout"],
  ] as const) {
    const page = fakePage();
    startKbWatch(page.env);
    page.keyboardUp();
    assert.ok(page.classes.has("kb-open"));
    // The keyboard is gone, but the visual viewport says so without an event.
    page.vv.height = SCREEN;
    page.vv.offsetTop = 0;
    (target === "win" ? page.winEvents : page.doc).fire(type);
    page.flushTimers();
    assert.ok(!page.classes.has("kb-open"), `${type}: the shell is full height again`);
    assert.equal(page.vars.size, 0, `${type}`);
  }
});

test("a field let go is read again once the keyboard has had time to go", () => {
  const page = fakePage();
  startKbWatch(page.env);
  page.keyboardUp();
  // Focus leaves the field while the keyboard is still on its way down: the
  // reading then still has it.
  page.doc.fire("focusout");
  assert.ok(page.classes.has("kb-open"));
  // It finishes going without a resize event; the delayed read catches it.
  page.vv.height = SCREEN;
  page.flushTimers();
  assert.ok(!page.classes.has("kb-open"));
  assert.equal(page.vars.size, 0);
});

test("a rotation whose layout viewport catches up late is re-read on window resize", () => {
  const page = fakePage();
  startKbWatch(page.env);
  page.keyboardUp();
  // Rotated to landscape with the keyboard still up: the visual viewport
  // reports first, against a stale portrait fixed box.
  page.vv.height = 390 - 200;
  page.vv.fire("resize");
  assert.equal(page.vars.get("--app-height"), "190px");
  // The fixed box catches up later, with only a window resize to say so; the
  // keyboard (200px) still covers the page.
  page.fixed.height = 390;
  page.winEvents.fire("resize");
  assert.equal(page.vars.get("--app-height"), "190px");
  // Keyboard dismissed in landscape, the last vv resize skipped.
  page.vv.height = 390;
  page.winEvents.fire("resize");
  assert.equal(page.vars.size, 0);
});

test("what is laid out against the shell measures before the resize and settles after it", () => {
  const page = fakePage();
  startKbWatch(page.env);
  const seen: string[] = [];
  const off = onKeyboardResize(() => {
    seen.push(`before:${page.vars.get("--app-height") ?? "full"}`);
    return () => seen.push(`after:${page.vars.get("--app-height") ?? "full"}`);
  });
  try {
    page.keyboardUp();
    assert.deepEqual(seen, ["before:full", `after:${SCREEN - KEYBOARD}px`]);
    // A pan moves the shell without resizing it: nothing to hold.
    page.vv.offsetTop = 50;
    page.vv.fire("scroll");
    assert.equal(seen.length, 2);
    page.keyboardDown();
    assert.deepEqual(seen.slice(2), [`before:${SCREEN - KEYBOARD}px`, "after:full"]);
  } finally {
    off();
  }
  page.keyboardUp();
  assert.equal(seen.length, 4, "unsubscribed");
});

test("a focused field low in a scrolling pane is brought back above the keyboard, past a clipped box in between", () => {
  const frame = { top: 0, height: SCREEN - KEYBOARD };
  const pane = new FakeBox(at(40, SCREEN - KEYBOARD), { overflowY: "auto", scrollHeight: 2000, clientHeight: SCREEN - KEYBOARD - 40 });
  // Between the field and the pane: an `overflow: hidden` box with more
  // content than room — a scroll container `scrollIntoView` would slide, and
  // which must never move (its content would be cut off with no way back).
  const clip = new FakeBox(at(400, 800), { parent: pane, overflowY: "hidden", scrollHeight: 900, clientHeight: 400 });
  const field = new FakeBox(at(600, 640), { parent: clip, tagName: "INPUT" });
  revealInFrame(field as unknown as Element, frame, styles);
  assert.equal(clip.scrollTop, 0);
  // The pane moves instead: the field's bottom 8px clear of the shell's new foot.
  assert.equal(pane.scrollTop, 640 - (SCREEN - KEYBOARD) + 8);
  assert.equal(field.getBoundingClientRect().bottom, SCREEN - KEYBOARD - 8);
  // Already inside: no move.
  revealInFrame(field as unknown as Element, frame, styles);
  assert.equal(pane.scrollTop, 640 - (SCREEN - KEYBOARD) + 8);
});

test("a field above the visible part is brought down, and a pane with nothing to scroll is passed over", () => {
  // WebKit panned: the shell starts 300px down the layout viewport.
  const frame = { top: 300, height: SCREEN - KEYBOARD };
  const outer = new FakeBox(at(0, SCREEN), { overflowY: "auto", scrollHeight: 3000, clientHeight: SCREEN });
  outer.scrollTop = 500;
  // Scrolls on paper, but has nothing to scroll: the move goes past it to `outer`.
  const flat = new FakeBox(at(-500, -100), { parent: outer, overflowY: "auto", scrollHeight: 400, clientHeight: 400 });
  const field = new FakeBox(at(600, 640), { parent: flat, tagName: "TEXTAREA" });
  // On screen at 100–140: above the frame's top.
  assert.equal(field.getBoundingClientRect().top, 100);
  revealInFrame(field as unknown as Element, frame, styles);
  assert.equal(flat.scrollTop, 0);
  assert.equal(outer.scrollTop, 500 - (300 - 100 + 8));
});

test("the terminal's helper textarea is the terminal's business", () => {
  const page = fakePage();
  const pane = new FakeBox(at(0, SCREEN), { overflowY: "auto", scrollHeight: 4000, clientHeight: SCREEN });
  const helper = new FakeBox(at(800, 820), { parent: pane, tagName: "TEXTAREA", inXterm: true });
  page.focus(helper);
  startKbWatch(page.env);
  page.keyboardUp();
  assert.equal(pane.scrollTop, 0);
});

test("stopping removes every listener, timer and frame", () => {
  const page = fakePage();
  const stop = startKbWatch(page.env);
  assert.equal(page.vv.listening(), 2);
  assert.equal(page.winEvents.listening(), 2);
  assert.equal(page.doc.listening(), 3);
  page.keyboardUp();
  page.doc.fire("focusout");
  page.keyboardDown();
  page.holdFrames(true);
  page.vv.fire("resize");
  assert.ok(page.pendingTimers() > 0);
  assert.ok(page.pendingFrames() > 0);
  stop();
  assert.equal(page.vv.listening() + page.winEvents.listening() + page.doc.listening(), 0);
  assert.equal(page.pendingTimers(), 0);
  assert.equal(page.pendingFrames(), 0);
});
