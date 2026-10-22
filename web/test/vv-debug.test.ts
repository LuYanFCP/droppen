// The keyboard readout (`lib/vv-debug.ts`): off unless asked for, and once
// asked for, kept on in this browser until asked off; its lines say plainly
// whether the composer is under the keyboard.
import assert from "node:assert/strict";
import test from "node:test";
import { describe, logLine, type VvSnapshot, vvDebugWanted } from "../src/lib/vv-debug.js";

function store() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

test("the readout is off unless asked for, and stays on until asked off", () => {
  const s = store();
  assert.equal(vvDebugWanted("", s), false);
  assert.equal(vvDebugWanted("?section=plugins", s), false);
  assert.equal(vvDebugWanted("?vvdebug=1", s), true);
  // A later page without the query (the router's own navigations) keeps it.
  assert.equal(vvDebugWanted("", s), true);
  assert.equal(vvDebugWanted("?vvdebug=0", s), false);
  assert.equal(vvDebugWanted("", s), false);
  assert.equal(s.items.size, 0);
});

test("blocked storage still lets the query turn it on for the page", () => {
  const blocked = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };
  assert.equal(vvDebugWanted("?vvdebug=1", blocked), true);
  assert.equal(vvDebugWanted("", blocked), false);
  assert.equal(vvDebugWanted("?vvdebug=1", null), true);
});

const iphone: VvSnapshot = {
  innerHeight: 844,
  clientHeight: 844,
  fixedHeight: 844,
  vvHeight: 508,
  vvWidth: 390,
  offsetTop: 0,
  pageTop: 0,
  scale: 1,
  scrollY: 0,
  safeBottom: 34,
  active: "TEXTAREA[composer]",
  editing: true,
  restHeight: 844,
  kbOpen: true,
  appTop: "0px",
  appHeight: "508px",
  composerBottom: 498,
  bodyTop: 0,
  bodyBottom: 508,
};

test("the lines say whether the composer is under the keyboard", () => {
  const ok = describe(iphone);
  assert.match(ok.join("\n"), /kb OPEN applied top 0px h 508px {2}inset 336 {2}frame 0\+508 {2}rest 844/);
  assert.match(ok.join("\n"), /active TEXTAREA\[composer\] \(editing\)/);
  assert.match(ok.at(-1)!, /composer bottom 498 {2}visible bottom 508 {2}ok$/);
  // The fall: the shell back at full height with the keyboard still up.
  const fallen = describe({ ...iphone, innerHeight: 508, kbOpen: false, appTop: "", appHeight: "", composerBottom: 834, bodyBottom: 844 });
  assert.match(fallen.join("\n"), /inner 508 {2}client 844 {2}fixed 844/);
  assert.match(fallen.join("\n"), /kb closed applied top - h -/);
  assert.match(fallen.at(-1)!, /COVERED 326$/);
  // Panned, as WebKit measures client rects: from the visual viewport, its
  // pageTop being scrollY. The shell is at the pan; on screen, at the top.
  const panned = describe({ ...iphone, offsetTop: 336, pageTop: 336, scrollY: 336, appTop: "336px", composerBottom: 498, bodyTop: 0, bodyBottom: 508 });
  assert.match(panned.join("\n"), /inset 0 {2}frame 336\+508/);
  assert.match(panned.at(-1)!, /visible bottom 508 {2}ok$/);
  // The same, as Chrome measures them: from the layout viewport.
  const chrome = describe({ ...iphone, offsetTop: 336, pageTop: 336, scrollY: 0, appTop: "336px", composerBottom: 834, bodyTop: 336, bodyBottom: 844 });
  assert.match(chrome.at(-1)!, /visible bottom 844 {2}ok$/);
  // Stuck after a dismiss (iOS 27): no field focused, so no frame, whatever
  // the viewport still says.
  const stuck = describe({ ...iphone, editing: false, active: "body", offsetTop: 277, pageTop: 277, scrollY: 277, vvHeight: 434 });
  assert.match(stuck.join("\n"), /frame none/);
  assert.match(describe({ ...iphone, composerBottom: null }).at(-1)!, /^composer none/);
});

test("a log line carries the numbers that move with the keyboard", () => {
  assert.equal(logLine(312.4, "vv.resize", iphone), "+312 vv.resize h508 top0 in844 fx844 y0 kb1 c498");
});

test("native mode: nothing applied to read, only the inset and the root resets", () => {
  // WebKit's own pan to the composer (the iOS 26.5 Simulator's numbers): the
  // shell at its CSS default, panned so its foot is the top of the keyboard.
  const native: VvSnapshot = {
    ...iphone,
    mode: "native",
    resets: 2,
    innerHeight: 377,
    fixedHeight: 714,
    vvHeight: 377,
    offsetTop: 337,
    pageTop: 337,
    scrollY: 337,
    kbOpen: false,
    appTop: "",
    appHeight: "",
    composerBottom: 369,
    bodyTop: -337,
    bodyBottom: 377,
  };
  const lines = describe(native).join("\n");
  assert.match(lines, /kb native {2}inset 0 {2}root resets 2$/m);
  assert.doesNotMatch(lines, /applied|frame|kb-open/);
  assert.match(describe(native).at(-1)!, /composer bottom 369 {2}visible bottom 377 {2}ok$/);
  // kb-open has no business being on in native mode: say so.
  assert.match(describe({ ...native, kbOpen: true }).join("\n"), /kb-open ON \(\?\)/);
  assert.equal(logLine(10, "vv.scroll", native), "+10 vv.scroll h377 top337 in377 fx714 y337 kb0 c369 r2");
});
