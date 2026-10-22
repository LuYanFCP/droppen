import * as React from "react";
import assert from "node:assert/strict";
import test from "node:test";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { renderToStaticMarkup } from "react-dom/server";
import {
  changeDelivery, createDeliveryStore, emptyDeliveryState, nextDeliveryId, reconcileDeliveries, visibleDeliveries,
  type DeliveryFrame, type DeliveryState,
} from "../src/features/sessions/delivery-preview.js";
import { DeliveryPreviews } from "../src/features/sessions/delivery-preview-view.js";

void i18next.use(initReactI18next).init({ lng: "en", resources: { en: { translation: {} } } });

const user = (text: string) => ({ role: "user" as const, kind: "text" as const, text });
test("display receipt IDs are distinct without requiring secure-context browser APIs", () => {
  const ids = Array.from({ length: 100 }, () => nextDeliveryId());
  assert.equal(new Set(ids).size, 100);
  assert.ok(ids.every((id) => id.startsWith("local:")));
});
const queued = (id: string, text: string, steered = false) => ({ id, text, steered });
const frame = (over: Partial<DeliveryFrame> = {}): DeliveryFrame => ({ items: [], startIndex: 10, totalItems: 10, queue: [], ...over });
function start(state: DeliveryState, id: string, text: string): DeliveryState {
  return changeDelivery(state, { type: "start", entry: { id, text, sending: true, after: state.total } });
}

test("direct sends remain readable through HTTP acceptance and disappear only on their transcript echo", () => {
  let state = start(emptyDeliveryState(10), "local", "hello");
  assert.equal(visibleDeliveries(state, [])[0]?.sending, true);
  state = changeDelivery(state, { type: "accepted", id: "local" });
  state = reconcileDeliveries(state, frame());
  assert.equal(visibleDeliveries(state, [])[0]?.text, "hello");
  assert.equal(visibleDeliveries(state, [])[0]?.sending, false);
  state = reconcileDeliveries(state, frame({ items: [user("hello")], totalItems: 11 }));
  assert.deepEqual(visibleDeliveries(state, []), []);
});

test("a steered queue message remains visible when acknowledgement beats the transcript", () => {
  const queue = [queued("q", "correction", true)];
  let state = reconcileDeliveries(emptyDeliveryState(10), frame({ queue }));
  assert.deepEqual(visibleDeliveries(state, queue), [], "the queue already shows it");
  state = reconcileDeliveries(state, frame());
  assert.equal(visibleDeliveries(state, [])[0]?.text, "correction");
  // Arbitrary activity is not proof that this user message has appeared.
  state = reconcileDeliveries(state, frame({ items: [{ ...user("correction"), role: "assistant" }], totalItems: 11 }));
  assert.equal(visibleDeliveries(state, []).length, 1);
  state = reconcileDeliveries(state, frame({ items: [user("correction")], startIndex: 11, totalItems: 12 }));
  assert.deepEqual(visibleDeliveries(state, []), []);
});

test("an automatically drained queue hands off the full local message without a duplicate preview", () => {
  const text = "🦑".repeat(210);
  const queue = [queued("q", "🦑".repeat(200))];
  let state = start(emptyDeliveryState(10), "local", text);
  state = reconcileDeliveries(state, frame({ queue }));
  assert.equal(state.entries.length, 1);
  assert.deepEqual(visibleDeliveries(state, queue), []);
  state = reconcileDeliveries(state, frame());
  assert.equal(visibleDeliveries(state, [])[0]?.text, text);
  state = reconcileDeliveries(state, frame({ items: [user(text)], totalItems: 11 }));
  assert.equal(state.entries.length, 0);
});

test("old identical text and tool results cannot consume a new preview", () => {
  let state = start(emptyDeliveryState(10), "new", "same");
  state = reconcileDeliveries(state, frame({ startIndex: 8, items: [user("same"), user("earlier"), { ...user("same"), kind: "tool_result" }], totalItems: 11 }));
  assert.equal(visibleDeliveries(state, []).length, 1);
});

test("two identical sends need two distinct echoes even across separate frames", () => {
  let state = start(start(emptyDeliveryState(10), "one", "same"), "two", "same");
  state = reconcileDeliveries(state, frame({ items: [user("same")], totalItems: 11 }));
  assert.deepEqual(visibleDeliveries(state, []).map((entry) => entry.id), ["two"]);
  state = reconcileDeliveries(state, frame({ items: [user("same")], totalItems: 11 }));
  assert.equal(visibleDeliveries(state, []).length, 1, "replayed frame cannot consume the second send");
  state = reconcileDeliveries(state, frame({ items: [user("same"), user("same")], totalItems: 12 }));
  assert.equal(visibleDeliveries(state, []).length, 0);
});

test("a transcript arriving before the old queue state never resurrects an acknowledged message", () => {
  const queue = [queued("q", "hello")];
  let state = reconcileDeliveries(emptyDeliveryState(10), frame({ queue }));
  const echo = frame({ queue, items: [user("hello")], totalItems: 11 });
  state = reconcileDeliveries(state, echo);
  state = reconcileDeliveries(state, echo);
  assert.deepEqual(visibleDeliveries(state, []), []);
  state = reconcileDeliveries(state, { ...echo, queue: [] });
  assert.equal(state.entries.length, 0);
});

test("removal clears the receipt, including a stale queue frame racing the delete response", () => {
  const queue = [queued("q", "withdraw me")];
  let state = reconcileDeliveries(emptyDeliveryState(10), frame({ queue }));
  state = changeDelivery(state, { type: "drop", queueId: "q" });
  state = reconcileDeliveries(state, frame({ queue }));
  state = reconcileDeliveries(state, frame());
  assert.deepEqual(visibleDeliveries(state, []), []);
});

test("failed requests clear local previews while an observed server queue remains authoritative", () => {
  let state = start(emptyDeliveryState(10), "one", "failed");
  state = changeDelivery(state, { type: "failed", id: "one" });
  assert.equal(state.entries.length, 0);
  state = start(state, "two", "accepted despite lost response");
  const queue = [queued("q", "accepted despite lost response")];
  state = reconcileDeliveries(state, frame({ queue }));
  state = changeDelivery(state, { type: "failed", id: "two" });
  assert.equal(state.entries.length, 1);
  assert.deepEqual(visibleDeliveries(state, queue), []);
});

test("queue previews match truncated Unicode text, not a different short prompt", () => {
  let state = reconcileDeliveries(emptyDeliveryState(10), frame({ queue: [queued("q", "🦑".repeat(200))] }));
  state = reconcileDeliveries(state, frame({ items: [user("🦑".repeat(205))], totalItems: 11 }));
  assert.equal(state.entries.length, 0);
  state = reconcileDeliveries(emptyDeliveryState(10), frame({ queue: [queued("short", "yes")] }));
  state = reconcileDeliveries(state, frame({ items: [user("yes please")], totalItems: 11 }));
  assert.equal(visibleDeliveries(state, []).length, 1);
});

test("preview text is escaped, wraps, and never offers a second send action", () => {
  const html = renderToStaticMarkup(<DeliveryPreviews messages={[{
    id: "one", text: "<script>unsafe</script>\nsecond line", after: 0, sending: false, attachments: 2,
  }]} />);
  assert.match(html, /&lt;script&gt;unsafe&lt;\/script&gt;/);
  assert.match(html, /whitespace-pre-wrap/);
  assert.match(html, /sent — waiting for transcript/);
  assert.match(html, /📎2/);
  assert.doesNotMatch(html, /<button/);
  assert.equal(renderToStaticMarkup(<DeliveryPreviews messages={[]} />), "");
});

test("a pending receipt survives view unmounts, is shared between panes, and is isolated from other sessions", () => {
  const store = createDeliveryStore(10);
  let changes = 0;
  const unsubscribe = store.subscribe(() => changes++);
  store.change({ type: "start", entry: { id: "a", text: "pending", after: 10, sending: true } });
  unsubscribe();
  assert.equal(store.idle(), false, "unmount must not discard a pending receipt");
  const remount = store.subscribe(() => changes++);
  assert.equal(visibleDeliveries(store.getSnapshot(), [])[0]?.text, "pending");
  assert.equal(createDeliveryStore(10).getSnapshot().entries.length, 0, "another session sees nothing");
  store.reconcile(frame({ items: [user("pending")], totalItems: 11 }));
  assert.equal(visibleDeliveries(store.getSnapshot(), []).length, 0);
  const before = changes;
  store.reconcile(frame({ items: [user("pending")], totalItems: 11 }));
  assert.equal(changes, before, "unchanged state does not notify other panes");
  remount();
  assert.equal(store.idle(), true);
});
