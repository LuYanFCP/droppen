// Whether anyone is at the page: the half of "being read" the seen report
// cannot get from `document.visibilityState`, because a window left showing on
// a locked machine stays visible. See `src/lib/presence.ts`.
import assert from "node:assert/strict";
import test from "node:test";
import { createPresence, IDLE_MS, type PresenceClock, type PresenceSignals } from "../src/lib/presence.js";

/** A page and a clock the test drives by hand. */
function fakePage(start: { visible?: boolean; focused?: boolean } = {}) {
  const page = { visible: start.visible ?? true, focused: start.focused ?? false };
  let now = 1_000_000;
  let timers: { at: number; fn: () => void }[] = [];
  let armed = 0;
  const signals: PresenceSignals = { visible: () => page.visible, focused: () => page.focused };
  const clock: PresenceClock = {
    now: () => now,
    setTimeout(fn, ms) {
      armed += 1;
      const timer = { at: now + ms, fn };
      timers.push(timer);
      return timer;
    },
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = timers.filter((t) => t.at <= until).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((t) => t !== due);
      now = due.at;
      due.fn();
    }
    now = until;
  };
  return { page, clock, signals, advance, armed: () => armed };
}

function watch(presence: { subscribe: (fn: () => void) => () => void; snapshot: () => boolean }) {
  const seen: boolean[] = [];
  presence.subscribe(() => seen.push(presence.snapshot()));
  return seen;
}

test("opening a visible page counts as somebody being there", () => {
  const { signals, clock } = fakePage({ visible: true, focused: false });
  const presence = createPresence(signals, clock);
  assert.equal(presence.present(), true);
  assert.equal(presence.snapshot(), true);
});

test("a hidden page has nobody at it, focused or not", () => {
  const { signals, clock } = fakePage({ visible: false, focused: true });
  const presence = createPresence(signals, clock);
  assert.equal(presence.present(), false);
  assert.equal(presence.snapshot(), false);
});

test("a visible window nobody touches stops being attended once the idle window runs out", () => {
  // The locked Mac with the display on: visible, never focused, no input.
  const { signals, clock, advance } = fakePage({ visible: true, focused: false });
  const presence = createPresence(signals, clock);
  const flips = watch(presence);
  advance(IDLE_MS - 1);
  assert.equal(presence.present(), true);
  advance(1);
  assert.equal(presence.present(), false);
  assert.deepEqual(flips, [false], "subscribers hear it go, exactly once");
  advance(IDLE_MS * 10);
  assert.deepEqual(flips, [false], "and nothing more while nobody comes back");
});

test("a focused window stays attended however long nobody types", () => {
  const { page, signals, clock, advance } = fakePage({ visible: true, focused: true });
  const presence = createPresence(signals, clock);
  advance(IDLE_MS * 5);
  assert.equal(presence.present(), true);
  // Losing the focus after a long quiet spell is losing the reader at once.
  page.focused = false;
  presence.recheck();
  assert.equal(presence.present(), false);
  assert.equal(presence.snapshot(), false);
});

test("activity after the idle window brings the reader back, and says so", () => {
  const { signals, clock, advance } = fakePage({ visible: true, focused: false });
  const presence = createPresence(signals, clock);
  const flips = watch(presence);
  advance(IDLE_MS + 1);
  presence.active();
  assert.equal(presence.present(), true);
  assert.deepEqual(flips, [false, true]);
  // And the idle window starts over from that activity.
  advance(IDLE_MS - 1);
  assert.equal(presence.present(), true);
  advance(1);
  assert.equal(presence.present(), false);
  assert.deepEqual(flips, [false, true, false]);
});

test("activity inside the idle window extends it without re-arming a timer per event", () => {
  const { signals, clock, advance, armed } = fakePage({ visible: true, focused: false });
  const presence = createPresence(signals, clock);
  const flips = watch(presence);
  const before = armed();
  // A pointer moving over the page for most of an idle window.
  for (let i = 0; i < 1000; i++) {
    advance(IDLE_MS / 2000);
    presence.active();
  }
  assert.equal(armed(), before, "a thousand pointer moves arm nothing new");
  assert.deepEqual(flips, [], "still attended throughout");
  // The original timer fires early, sees the later activity and re-arms once.
  advance(IDLE_MS);
  assert.equal(presence.present(), false);
  assert.deepEqual(flips, [false]);
});

test("the page being hidden and shown again is leaving and coming back", () => {
  const { page, signals, clock, advance } = fakePage({ visible: true, focused: false });
  const presence = createPresence(signals, clock);
  const flips = watch(presence);
  page.visible = false;
  presence.recheck();
  advance(IDLE_MS * 3);
  page.visible = true;
  // `browserPresence` reports a page shown as activity.
  presence.active();
  assert.deepEqual(flips, [false, true]);
  assert.equal(presence.present(), true);
});

test("the live answer does not wait for a throttled timer", () => {
  // A background page's timers can run late; the check made before a report
  // goes is worked out from the clock, not from the last announcement.
  const { signals } = fakePage({ visible: true, focused: false });
  let now = 0;
  const lateClock: PresenceClock = { now: () => now, setTimeout: () => undefined };
  const presence = createPresence(signals, lateClock);
  now = IDLE_MS + 1;
  assert.equal(presence.present(), false, "worked out afresh");
  assert.equal(presence.snapshot(), true, "the announced value waits for its timer");
});
