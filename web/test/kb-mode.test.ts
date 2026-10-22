// Which keyboard handling runs (`lib/kb-mode.ts`): native unless asked
// otherwise, and once asked, kept in this browser until asked again.
import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_KB_MODE, resolveKbMode, switchKbMode } from "../src/lib/kb-mode.js";

function store() {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
}

test("native by default", () => {
  assert.equal(DEFAULT_KB_MODE, "native");
  assert.equal(resolveKbMode("", store()), "native");
  assert.equal(resolveKbMode("?vvdebug=1", store()), "native");
  assert.equal(resolveKbMode("", null), "native");
});

test("?kb= picks a mode and it stays picked until asked again", () => {
  const s = store();
  assert.equal(resolveKbMode("?kb=legacy", s), "legacy");
  // The router's own navigations drop the query: the pick holds.
  assert.equal(resolveKbMode("", s), "legacy");
  assert.equal(resolveKbMode("?section=plugins", s), "legacy");
  assert.equal(resolveKbMode("?kb=native", s), "native");
  assert.equal(resolveKbMode("", s), "native");
  // Anything else forgets the pick: back to the default.
  resolveKbMode("?kb=legacy", s);
  assert.equal(resolveKbMode("?kb=default", s), DEFAULT_KB_MODE);
  assert.equal(s.items.size, 0);
  assert.equal(resolveKbMode("", s), DEFAULT_KB_MODE);
});

test("a stored value that is not a mode is ignored", () => {
  const s = store();
  s.items.set("rh.kb", "fancy");
  assert.equal(resolveKbMode("", s), DEFAULT_KB_MODE);
});

test("the readout's button reloads into the other mode through the address, so it switches with storage blocked too", () => {
  const g = globalThis as unknown as { location: unknown; window: unknown };
  const saved = { location: g.location, window: g.window };
  const replaced: string[] = [];
  g.location = {
    href: "https://droppen.app/sessions?vvdebug=1",
    search: "?vvdebug=1",
    replace: (to: string) => void replaced.push(to),
  };
  g.window = {
    get localStorage(): Storage {
      throw new Error("blocked");
    },
  };
  try {
    switchKbMode();
    assert.equal(replaced.length, 1);
    const url = new URL(replaced[0]!);
    assert.equal(url.pathname, "/sessions");
    assert.equal(url.searchParams.get("vvdebug"), "1");
    // The default was running; the reload asks for the other, storage or not.
    assert.equal(url.searchParams.get("kb"), "legacy");
    assert.equal(resolveKbMode(url.search, null), "legacy");
  } finally {
    g.location = saved.location;
    g.window = saved.window;
  }
});

test("blocked storage: the query still picks for this page", () => {
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
  assert.equal(resolveKbMode("?kb=legacy", blocked), "legacy");
  assert.equal(resolveKbMode("", blocked), DEFAULT_KB_MODE);
});
