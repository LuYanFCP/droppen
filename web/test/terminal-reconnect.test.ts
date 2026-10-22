import assert from "node:assert/strict";
import test from "node:test";
import {
  isTerminalGoneFrame,
  reconnectDelay,
  RECONNECT_BASE_MS,
  RECONNECT_MAX_MS,
} from "../src/features/terminals/reconnect.js";

test("the re-attach delay backs off exponentially and stops at the ceiling", () => {
  const noJitter = () => 1;
  assert.equal(reconnectDelay(0, noJitter), RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(1, noJitter), 2 * RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(3, noJitter), 8 * RECONNECT_BASE_MS);
  assert.equal(reconnectDelay(4, noJitter), RECONNECT_MAX_MS);
  assert.equal(reconnectDelay(40, noJitter), RECONNECT_MAX_MS);
});

test("jitter only ever shortens the wait, and never below half of it", () => {
  for (const attempt of [0, 1, 2, 5, 10]) {
    const full = reconnectDelay(attempt, () => 1);
    assert.equal(reconnectDelay(attempt, () => 0), Math.round(full / 2));
    for (const roll of [0, 0.13, 0.5, 0.87, 0.999]) {
      const delay = reconnectDelay(attempt, () => roll);
      assert.ok(delay >= full / 2 && delay <= full, `attempt ${attempt}, roll ${roll}: ${delay}`);
    }
  }
});

test("a negative attempt is treated as the first retry", () => {
  assert.equal(reconnectDelay(-3, () => 1), RECONNECT_BASE_MS);
});

test("only the server's not-found note ends the retry loop", () => {
  assert.ok(isTerminalGoneFrame("\r\n[terminal not found]\r\n"));
  assert.ok(isTerminalGoneFrame("[terminal not found]"));
  assert.ok(!isTerminalGoneFrame("\r\n[process exited]\r\n"));
  assert.ok(!isTerminalGoneFrame("$ echo '[terminal not found]'\r\n[terminal not found]\r\n$ "));
  assert.ok(!isTerminalGoneFrame(""));
});
