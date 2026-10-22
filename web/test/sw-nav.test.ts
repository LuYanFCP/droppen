import assert from "node:assert/strict";
import test from "node:test";
import { internalNavPath } from "../src/lib/sw-nav.js";

test("internalNavPath accepts a same-origin path from a nav message", () => {
  assert.equal(internalNavPath({ type: "nav", url: "/sessions/claude/abc" }), "/sessions/claude/abc");
  assert.equal(internalNavPath({ type: "nav", url: "/" }), "/");
});

test("internalNavPath rejects anything that would leave the origin", () => {
  // An absolute URL to another origin, a scheme-relative host, and a dangerous
  // scheme — none of these is an internal path.
  assert.equal(internalNavPath({ type: "nav", url: "https://evil.example/steal" }), null);
  assert.equal(internalNavPath({ type: "nav", url: "//evil.example/steal" }), null);
  assert.equal(internalNavPath({ type: "nav", url: "javascript:alert(1)" }), null);
});

test("internalNavPath rejects the wrong message shape", () => {
  assert.equal(internalNavPath({ type: "other", url: "/ok" }), null);
  assert.equal(internalNavPath({ type: "nav", url: 42 }), null);
  assert.equal(internalNavPath({ type: "nav" }), null);
  assert.equal(internalNavPath(null), null);
  assert.equal(internalNavPath("nope"), null);
});
