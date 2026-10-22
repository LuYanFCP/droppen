import assert from "node:assert/strict";
import test from "node:test";
import { stashPendingMessage, takePendingMessage } from "../src/features/chat/pending-message.js";
import { LOCAL } from "../src/lib/machines/key.js";

test("an API chat first message is transferred once, scoped by chat id", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const rows = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    setItem: (key: string, value: string) => rows.set(key, value),
    getItem: (key: string) => rows.get(key) ?? null,
    removeItem: (key: string) => rows.delete(key),
  } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  stashPendingMessage(LOCAL, "a", "first");
  stashPendingMessage(LOCAL, "b", "second");
  assert.equal(takePendingMessage(LOCAL, "a"), "first");
  assert.equal(takePendingMessage(LOCAL, "a"), null);
  assert.equal(takePendingMessage(LOCAL, "b"), "second");
  assert.deepEqual([...rows.keys()], [], "nothing left behind");
  stashPendingMessage(LOCAL, "c", "third");
  assert.deepEqual([...rows.keys()], ["rh.chat.pending.c"], "the local machine's key is the one from before");
  assert.equal(takePendingMessage("m-other", "c"), null, "another machine's chat c is another chat");
  assert.equal(takePendingMessage(LOCAL, "c"), "third");
});

test("unavailable session storage does not crash navigation", (t) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => { throw new Error("blocked"); } });
  t.after(() => {
    if (original) Object.defineProperty(globalThis, "sessionStorage", original);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  });
  assert.doesNotThrow(() => stashPendingMessage(LOCAL, "a", "first"));
  assert.equal(takePendingMessage(LOCAL, "a"), null);
});
