// The sentence under the session's queue after an action. "Delivered — it runs
// next" is about one message, and stops being news the moment that message
// leaves the queue; a refusal is about the action and stays until the next one.
import assert from "node:assert/strict";
import test from "node:test";
import { noticeInForce, type QueueNotice } from "../src/features/sessions/server-queue.js";

const delivered: QueueNotice = { tone: "info", text: "delivered — it runs next", qid: "q-2" };
const refused: QueueNotice = { tone: "danger", text: "that message has already started" };

test("a delivered notice stays while its message is still queued", () => {
  assert.equal(noticeInForce(delivered, [{ id: "q-1" }, { id: "q-2" }]), delivered);
});

test("a delivered notice goes once its message has left the queue", () => {
  assert.equal(noticeInForce(delivered, [{ id: "q-3" }]), null);
  assert.equal(noticeInForce(delivered, []), null, "an empty queue does not keep the panel up for it");
});

test("a refusal is about the action, not a message, and stays", () => {
  assert.equal(noticeInForce(refused, []), refused);
  assert.equal(noticeInForce(null, [{ id: "q-1" }]), null);
});
