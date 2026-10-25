// The page's "come back" events: in view, shown, focused, online — and on
// another network. A phone that moves between Wi-Fi and cellular never goes
// offline, so `online` does not fire; `navigator.connection`'s change does,
// and the sockets the phone had are gone all the same.
import assert from "node:assert/strict";
import test from "node:test";
import { onPageResume } from "../src/lib/page-resume.js";

class FakeConnection {
  private listeners = new Map<string, Set<() => void>>();
  addEventListener(type: string, fn: () => void): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(fn);
  }
  removeEventListener(type: string, fn: () => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  fire(type: string): void {
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn();
  }
}

test("a network change counts as the page coming back, and stops when let go", () => {
  const connection = new FakeConnection();
  const navigator = globalThis.navigator as unknown as object | undefined;
  assert.ok(navigator, "Node has a navigator to hang the connection on");
  Object.defineProperty(navigator, "connection", { value: connection, configurable: true });
  try {
    let heard = 0;
    const off = onPageResume(() => heard++);
    connection.fire("change");
    assert.equal(heard, 1, "a network change wakes the page");
    off();
    connection.fire("change");
    assert.equal(heard, 1, "the listener is gone after the stop");
  } finally {
    delete (navigator as { connection?: unknown }).connection;
  }
});
