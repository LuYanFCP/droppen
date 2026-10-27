import assert from "node:assert/strict";
import test from "node:test";
import type { components } from "../src/api/schema.js";
import { agentPath } from "../src/features/sessions/subagent-view.js";

type Child = components["schemas"]["SessionChild"];

const child = (id: string, children: Child[] = []): Child => ({
  id, kind: "agent", name: id, role: null, status: "done", updatedAt: "2024-05-01T10:00:00.000Z", unread: false, children,
});

test("an agent's page finds the agents above it, outermost first", () => {
  const tree = [child("a1", [child("a2", [child("a3")])]), child("b1")];
  assert.deepEqual(agentPath(tree, "a3")?.map((c) => c.id), ["a1", "a2", "a3"]);
  assert.deepEqual(agentPath(tree, "b1")?.map((c) => c.id), ["b1"]);
  assert.equal(agentPath(tree, "zz"), null);
});
