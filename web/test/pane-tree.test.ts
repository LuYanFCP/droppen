import assert from "node:assert/strict";
import test from "node:test";
import {
  countLeaves, firstLeafId, hasLeaf, MAX_LEAVES, MIN_RATIO, paneTreeApi, reducePaneTree,
  removeLeaf, splitLeaf, updateLeafContent, updateRatio,
  type PaneAction, type PaneNode, type PaneTreeState,
} from "../src/app/pane-tree.js";

const initial = (): PaneTreeState => ({ root: { type: "leaf", id: "main", content: { kind: "main" } }, focusedId: "main" });
const split: PaneAction = { type: "split", direction: "row", leafId: "second", splitId: "split-1" };

test("file panes preserve independent locations through JSON round trips", () => {
  const state = reducePaneTree(initial(), split);
  const left = { kind: "files" as const, path: "/home/me/source", file: "/home/me/source/a.ts" };
  let next = reducePaneTree(state, { type: "content", id: "main", content: left });
  next = reducePaneTree(next, { type: "content", id: "second", content: { kind: "files", path: "/home/me/screenshots" } });
  assert.equal(next.root.type, "split");
  if (next.root.type !== "split") return;
  assert.deepEqual(next.root.children[0], { type: "leaf", id: "main", content: left });
  assert.deepEqual(JSON.parse(JSON.stringify(next)), next);
});

test("route panes protect the main leaf before and after splitting", () => {
  for (const state of [initial(), reducePaneTree(initial(), split)]) {
    assert.equal(reducePaneTree(state, { type: "close", id: "main" }, "main"), state);
  }
});

test("a screen clears its final pane without deleting its identity", () => {
  const state = reducePaneTree(initial(), { type: "close", id: "main" });
  assert.deepEqual(state, { root: { type: "leaf", id: "main", content: { kind: "picker" } }, focusedId: "main" });
  assert.equal(reducePaneTree(state, { type: "close", id: "main" }), state);
});

test("closing the focused pane focuses the remaining first leaf", () => {
  const state = reducePaneTree(initial(), split);
  assert.deepEqual(reducePaneTree(state, { type: "close", id: "second" }), initial());
  assert.equal(reducePaneTree(state, { type: "close", id: "main" }).focusedId, "second");
});

test("unknown or redundant focus/close commands do not change state", () => {
  const state = initial();
  for (const action of [{ type: "focus", id: "gone" }, { type: "focus", id: "main" }, { type: "close", id: "gone" }] as PaneAction[]) {
    assert.equal(reducePaneTree(state, action), state);
  }
});

test("the pane limit applies to repeated split commands in both layouts", () => {
  for (const policy of [undefined, "main"]) {
    let state = initial();
    for (let i = 0; i < MAX_LEAVES - 1; i++) {
      state = reducePaneTree(state, { ...split, leafId: `leaf-${i}`, splitId: `split-${i}` }, policy);
    }
    assert.equal(countLeaves(state.root), MAX_LEAVES);
    assert.equal(reducePaneTree(state, split, policy), state);
  }
});

test("content and resize share one reducer while respecting ratio limits", () => {
  let state = reducePaneTree(initial(), split);
  state = reducePaneTree(state, { type: "content", id: "second", content: { kind: "terminal", id: "terminal-1" } });
  for (const [ratio, expected] of [[-1, MIN_RATIO], [2, 1 - MIN_RATIO], [0.3, 0.3]]) {
    state = reducePaneTree(state, { type: "resize", id: "split-1", ratio: ratio! });
    assert.equal(state.root.type === "split" && state.root.ratio, expected);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(state)), state, "persisted layout remains plain JSON");
});

test("replaying the same action is deterministic and does not mutate its input", () => {
  const state = initial();
  const before = structuredClone(state);
  assert.deepEqual(reducePaneTree(state, split), reducePaneTree(state, split));
  assert.deepEqual(state, before);
});

test("pane API dispatches against current state, not a captured render", () => {
  let state = initial();
  const api = paneTreeApi(state, action => { state = reducePaneTree(state, action, "main"); });
  api.splitFocused("row");
  api.splitFocused("column");
  assert.equal(countLeaves(state.root), 3);
  api.closePane("main");
  assert.equal(countLeaves(state.root), 3);
});

// Characterization oracle: the two providers' previous operations, before the
// reducer existed. New IDs are supplied so randomized traces are reproducible.
function previous(state: PaneTreeState, action: PaneAction, protectedId?: string): PaneTreeState {
  switch (action.type) {
    case "focus": return state.focusedId === action.id ? state : { ...state, focusedId: action.id };
    case "split": return countLeaves(state.root) >= MAX_LEAVES ? state : {
      root: splitLeaf(state.root, state.focusedId, action.direction, action.leafId, action.splitId), focusedId: action.leafId,
    };
    case "close": {
      if (action.id === protectedId) return state;
      if (!protectedId && state.root.type === "leaf") {
        if (state.root.id !== action.id || state.root.content.kind === "picker") return state;
        return { root: { ...state.root, content: { kind: "picker" } }, focusedId: state.root.id };
      }
      const root = removeLeaf(state.root, action.id);
      return { root, focusedId: hasLeaf(root, state.focusedId) ? state.focusedId : firstLeafId(root) };
    }
    case "content": return { ...state, root: updateLeafContent(state.root, action.id, action.content) };
    case "resize": return { ...state, root: updateRatio(state.root, action.id, action.ratio) };
  }
}

for (const policy of [undefined, "main"]) test(`2,000 valid operations match the previous ${policy ? "route" : "screen"} behavior`, () => {
  let actual = initial(), expected = initial(), seed = 314159;
  const random = (n: number) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let i = 0; i < 2000; i++) {
    const leaves: string[] = [], splits: string[] = [];
    const collect = (node: PaneNode): void => {
      if (node.type === "leaf") leaves.push(node.id);
      else { splits.push(node.id); node.children.forEach(collect); }
    };
    collect(actual.root);
    const id = leaves[random(leaves.length)]!;
    const actions: PaneAction[] = [
      { ...split, direction: random(2) ? "row" : "column", leafId: `leaf-${i}`, splitId: `split-${i}` },
      { type: "focus", id }, { type: "close", id },
      { type: "content", id, content: { kind: "session", source: "codex", id: `session-${i}` } },
      { type: "resize", id: splits[0] ?? "absent", ratio: random(120) / 100 },
    ];
    const action = actions[random(actions.length)]!;
    actual = reducePaneTree(actual, action, policy);
    expected = previous(expected, action, policy);
    assert.deepEqual(actual, expected, `step ${i}: ${JSON.stringify(action)}`);
  }
});
