// Asking the server what became of `unknown` sends (`features/sessions/
// receipt-check.ts`), without ever getting stuck asking.
//
// What these pin: a check whose answer never comes is given up after its
// timeout — even when the request ignores its abort signal — and asked again
// after a backoff, so a lost answer cannot block every later re-check; while
// anything is unknown the asking goes on, ever less often, and stops once
// nothing is; a new connection asks at once, abandoning a check still waiting
// on the old one, and starts the backoff over; and only one check is ever
// waiting at a time.
import assert from "node:assert/strict";
import test from "node:test";
import { ReceiptChecker } from "../src/features/sessions/receipt-check.js";
import type { ReceiptLookup } from "../src/features/sessions/send-receipts.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: () => boolean, label: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(2);
  }
}

const never = () => new Promise<ReceiptLookup | null>(() => undefined);
const adopted = (id: string): ReceiptLookup => ({ receipts: [{ clientMessageId: id, status: "queued" }], unknown: [] }) as unknown as ReceiptLookup;

/** A checker over an outbox holding `ids`, asking with `ask`; what it did. */
function harness(ask: (call: number, signal: AbortSignal) => Promise<ReceiptLookup | null>, timing = { timeoutMs: 60, retryFirstMs: 40, retryMaxMs: 160 }) {
  const state = {
    ids: ["m-1"],
    calls: [] as number[],
    signals: [] as AbortSignal[],
    applied: [] as ReceiptLookup[],
    checking: [] as boolean[],
  };
  const checker = new ReceiptChecker({
    ids: () => state.ids,
    ask: (_ids, signal) => {
      state.calls.push(performance.now());
      state.signals.push(signal);
      return ask(state.calls.length, signal);
    },
    apply: (lookup) => {
      state.applied.push(lookup);
      state.ids = [];
    },
    onChecking: (on) => state.checking.push(on),
    timing,
  });
  return { checker, state };
}

test("a check whose answer never comes is given up after its timeout and asked again, so nothing stays in flight", async (t) => {
  // The first answer is lost (and the request does not even honour its abort); the second comes.
  const { checker, state } = harness((call) => (call === 1 ? never() : Promise.resolve(adopted("m-1"))));
  t.after(() => checker.stop());
  checker.check();
  assert.equal(checker.checking, true);
  // A trigger while it waits does not send a second request.
  checker.check();
  await sleep(5);
  assert.equal(state.calls.length, 1);
  await until(() => !checker.checking, "the first check given up", 1_000);
  assert.ok(state.signals[0]!.aborted, "and its request told to stop");
  await until(() => state.applied.length === 1, "asked again, and answered");
  assert.equal(state.calls.length, 2);
  assert.ok(state.calls[1]! - state.calls[0]! >= 60 + 40 - 10, "after the timeout and the first backoff");
  assert.deepEqual(state.checking, [true, false, true, false]);
  await sleep(200);
  assert.equal(state.calls.length, 2, "nothing left unknown: no more asking");
});

test("while anything is unknown it keeps asking, ever less often, and stops once nothing is", async (t) => {
  const { checker, state } = harness(() => Promise.reject(new TypeError("tunnel: the pipe closed before the answer ended (4410)")));
  t.after(() => checker.stop());
  checker.check();
  await until(() => state.calls.length === 5, "five tries");
  const gaps = state.calls.slice(1).map((at, i) => at - state.calls[i]!);
  // 40, 80, 160, then 160 (the cap).
  assert.ok(gaps[0]! >= 35 && gaps[0]! < 75, `first wait ${gaps[0]}`);
  assert.ok(gaps[1]! >= 75 && gaps[1]! < 150, `doubled ${gaps[1]}`);
  assert.ok(gaps[2]! >= 155 && gaps[3]! >= 155 && gaps[3]! < 260, `capped ${gaps[2]}, ${gaps[3]}`);
  state.ids = [];
  await sleep(400);
  assert.equal(state.calls.length <= 6, true, "it stops once nothing is unknown");
  const settled = state.calls.length;
  await sleep(300);
  assert.equal(state.calls.length, settled);
});

test("a new connection asks at once, abandoning a check still waiting on the old one, and starts the backoff over", async (t) => {
  const { checker, state } = harness(
    (call, signal) =>
      call === 1
        ? new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)))
        : Promise.resolve(adopted("m-1")),
    { timeoutMs: 10_000, retryFirstMs: 5_000, retryMaxMs: 10_000 },
  );
  t.after(() => checker.stop());
  checker.check();
  await sleep(20);
  assert.equal(state.calls.length, 1, "waiting on the old channel");
  const at = performance.now();
  checker.reconnected();
  assert.ok(state.signals[0]!.aborted, "the old check is abandoned");
  await until(() => state.applied.length === 1, "settled on the new connection");
  assert.ok(performance.now() - at < 500, "at once, not after a timeout or a backoff");
  assert.equal(checker.checking, false);
});

test("a request that throws before it is even sent does not wedge the checker", async (t) => {
  let calls = 0;
  const checker = new ReceiptChecker({
    ids: () => ["m-1"],
    ask: () => {
      calls++;
      throw new Error("no transport yet");
    },
    apply: () => undefined,
    timing: { timeoutMs: 50, retryFirstMs: 20, retryMaxMs: 40 },
  });
  t.after(() => checker.stop());
  checker.check();
  await until(() => calls >= 3, "asked again and again");
  checker.stop();
  const stopped = calls;
  await sleep(100);
  assert.equal(calls, stopped, "and stop stops it");
});

test("an answer to a check abandoned for a new connection is never applied, even when it comes after all", async (t) => {
  let late: (lookup: ReceiptLookup) => void = () => undefined;
  const stale = { receipts: [], unknown: ["m-1"] } as unknown as ReceiptLookup;
  const { checker, state } = harness(
    // The first answer is held up on the old channel, and does not honour the abort;
    // the second, on the new connection, says the server has the message.
    (call) => (call === 1 ? new Promise((resolve) => (late = resolve)) : Promise.resolve(adopted("m-1"))),
    { timeoutMs: 10_000, retryFirstMs: 5_000, retryMaxMs: 10_000 },
  );
  t.after(() => checker.stop());
  checker.check();
  await until(() => state.calls.length === 1, "the first check");
  checker.reconnected();
  await until(() => state.applied.length === 1, "the answer on the new connection");
  late(stale);
  await sleep(20);
  assert.deepEqual(state.applied, [adopted("m-1")], "the old channel's late answer (an older view) is dropped");
});
