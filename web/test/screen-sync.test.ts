// How a browser keeps its copy of a screen honest with the server's when the
// same screen is open on another device. The provider in `screens.tsx` only
// does the I/O; every decision it makes is one of these pure functions, so the
// cross-device behaviour is tested here rather than through a browser.
import assert from "node:assert/strict";
import test from "node:test";
import { createGlobalFeedStore } from "../src/app/global-feed.js";
import type { PaneNode } from "../src/app/pane-tree.js";
import {
  adoptConflict,
  adoptTree,
  applyLocalEdit,
  classifySave,
  dropScreen,
  EMPTY_COPY,
  freshSync,
  hasPendingEdit,
  isRetrying,
  isUnsaved,
  metadataLanded,
  needsRefetch,
  reconcileScreens,
  reduceSync,
  resolveConflict,
  retryDelay,
  saveError,
  screensFeedEvent,
  seedScreen,
  withSync,
  type ScreensFeedEvent,
  type ScreensWorkingCopy,
  type SentLayout,
} from "../src/app/screen-sync.js";
import { LOCAL } from "../src/lib/machines/key.js";

const leaf = (id: string, terminal: string): PaneNode => ({ type: "leaf", id, content: { kind: "terminal", id: terminal } });
const split = (a: PaneNode, b: PaneNode): PaneNode => ({ type: "split", id: "s", direction: "row", ratio: 0.5, children: [a, b] });

/** The server rebuilds every node, so its keys arrive in its own order. */
const serverShaped = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(serverShaped);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().reverse().map((key) => [key, serverShaped(record[key])]));
  }
  return value;
};

const opened = (layout: PaneNode, revision = 1): ScreensWorkingCopy =>
  reconcileScreens(EMPTY_COPY, [{ id: "w", revision, layout }]);

/** One local edit to screen `w`: a pane now shows terminal `terminal`. */
const editLocally = (copy: ScreensWorkingCopy, terminal: string): ScreensWorkingCopy =>
  applyLocalEdit(copy, "w", (state) => ({ ...state, root: leaf("a", terminal) })).copy;

/** What a save of screen `w` would carry right now. */
const sending = (copy: ScreensWorkingCopy): SentLayout => ({ seq: copy.syncs.w.editSeq, layout: copy.trees.w.root });

test("a newer server copy replaces a screen with nothing waiting to save", () => {
  const copy = opened(split(leaf("a", "t1"), leaf("b", "t2")));
  const focused = applyLocalEdit(copy, "w", (s) => ({ ...s, focusedId: "b" }));
  assert.equal(focused.edited, false, "moving focus is not an edit to save");
  assert.equal(hasPendingEdit(focused.copy.syncs.w), false);

  const next = reconcileScreens(focused.copy, [{ id: "w", revision: 2, layout: split(leaf("a", "t1"), leaf("b", "t9")) }]);
  assert.deepEqual(next.trees.w.root, split(leaf("a", "t1"), leaf("b", "t9")), "the other device's layout is adopted");
  assert.equal(next.trees.w.focusedId, "b", "focus stays on a pane that survived");
  assert.equal(next.syncs.w.revision, 2);

  // The same revision again — a poll, or the echo of our own save — changes nothing.
  assert.equal(reconcileScreens(next, [{ id: "w", revision: 2, layout: leaf("x", "zzz") }]), next);
  // An older one never rolls the screen back.
  assert.equal(reconcileScreens(next, [{ id: "w", revision: 1, layout: leaf("x", "zzz") }]), next);
});

test("an adopted tree that did not change keeps its identity, so no pane re-renders", () => {
  const copy = opened(split(leaf("a", "t1"), leaf("b", "t2")));
  const tree = copy.trees.w;
  assert.equal(adoptTree(tree, serverShaped(split(leaf("a", "t1"), leaf("b", "t2")))), tree);
  const moved = adoptTree(tree, leaf("c", "t3"));
  assert.equal(moved.focusedId, "c", "focus falls back to the first pane when its own is gone");
});

test("a server copy does not overwrite a waiting edit; a 409 with another device's tree adopts it and raises the notice", () => {
  const copy = editLocally(opened(leaf("a", "t1")), "mine");
  assert.equal(hasPendingEdit(copy.syncs.w), true);

  // The push arrives while the edit is still waiting: the local tree stays.
  const pushed = reconcileScreens(copy, [{ id: "w", revision: 2, layout: leaf("a", "theirs") }]);
  assert.deepEqual(pushed.trees.w.root, leaf("a", "mine"));
  assert.equal(pushed.syncs.w.revision, 1, "the save still names the revision the edit was made on");

  // That save is refused with a tree this browser never sent: the server's
  // screen replaces the edit, and says so.
  const resolved = resolveConflict(pushed, { id: "w", revision: 2, layout: leaf("a", "theirs") }, sending(pushed));
  assert.equal(resolved.resolution, "adopted");
  assert.equal(resolved.notice, true);
  assert.deepEqual(resolved.copy.trees.w.root, leaf("a", "theirs"));
  assert.equal(resolved.copy.syncs.w.revision, 2);
  assert.equal(hasPendingEdit(resolved.copy.syncs.w), false, "the local edit is dropped, not merged");
  assert.equal(isUnsaved(resolved.copy.syncs.w), false);

  // A conflict with nothing of ours waiting (a rename's) adopts quietly.
  assert.equal(adoptConflict(opened(leaf("a", "t1")), { id: "w", revision: 5, layout: leaf("a", "t5") }).notice, false);
});

test("a 409 against our own save whose answer was lost keeps the later edits and shows nothing", () => {
  // The phone saves `mine` at revision 1; it lands as revision 2, and the
  // answer is lost with the network. The user goes on editing meanwhile.
  let copy = editLocally(opened(leaf("a", "t1")), "mine");
  const lost = sending(copy);
  copy = withSync(copy, "w", { type: "failed", sent: lost });
  copy = editLocally(copy, "mine, later");
  assert.equal(isRetrying(copy.syncs.w), true);

  // The retry still names revision 1 and carries the later tree; the server
  // refuses it with the tree the lost save put there.
  const retry = sending(copy);
  const resolved = resolveConflict(copy, { id: "w", revision: 2, layout: serverShaped(leaf("a", "mine")) }, retry);
  assert.equal(resolved.resolution, "landed");
  assert.equal(resolved.notice, false, "the only device is not told another one changed it");
  assert.equal(resolved.copy.trees.w, copy.trees.w, "the later edit is kept, not replaced");
  const sync = resolved.copy.syncs.w;
  assert.equal(sync.revision, 2, "the next save names the revision the lost one made");
  assert.equal(sync.savedSeq, lost.seq);
  assert.equal(hasPendingEdit(sync), true, "the later edit still goes, on the right base");
  assert.equal(isUnsaved(sync), false, "the lost save was found; nothing is failing");
  assert.deepEqual(sync.unanswered, [], "a save the server took is no longer in doubt");

  // The refused save itself is recognised too: a lost answer with no later edit.
  const alone = editLocally(opened(leaf("a", "t1")), "mine");
  const itself = resolveConflict(alone, { id: "w", revision: 2, layout: leaf("a", "mine") }, sending(alone));
  assert.equal(itself.resolution, "landed");
  assert.equal(hasPendingEdit(itself.copy.syncs.w), false);

  // So is a keepalive save sent as the page was hidden.
  const hidden = withSync(alone, "w", { type: "unanswered", sent: sending(alone) });
  const later = editLocally(hidden, "after the page came back");
  assert.equal(resolveConflict(later, { id: "w", revision: 2, layout: leaf("a", "mine") }, sending(later)).resolution, "landed");

  // But a server tree that is none of ours still wins, with the notice.
  const theirs = resolveConflict(copy, { id: "w", revision: 3, layout: leaf("a", "theirs") }, retry);
  assert.equal(theirs.resolution, "adopted");
  assert.equal(theirs.notice, true);
  assert.deepEqual(theirs.copy.trees.w.root, leaf("a", "theirs"));
  assert.equal(hasPendingEdit(theirs.copy.syncs.w), false);
});

test("a 409 for a rename elsewhere rebases the waiting edit rather than dropping it", () => {
  const copy = editLocally(opened(leaf("a", "t1")), "mine");
  // Another device renamed the screen: revision 2, same layout.
  const resolved = resolveConflict(copy, { id: "w", revision: 2, layout: serverShaped(leaf("a", "t1")), title: "x" }, sending(copy));
  assert.equal(resolved.resolution, "rebased");
  assert.equal(resolved.notice, false);
  assert.equal(resolved.copy.syncs.w.revision, 2);
  assert.equal(hasPendingEdit(resolved.copy.syncs.w), true, "the edit is saved next, on top of the rename");
  assert.equal(resolved.copy.trees.w, copy.trees.w);
});

test("a refused rename that the server already shows is not sent again", () => {
  const screen = { id: "w", revision: 3, layout: leaf("a", "t1"), title: "work", emoji: "🐙" };
  assert.equal(metadataLanded(screen, { title: "  work " }), true, "the server trims, and the rename landed");
  assert.equal(metadataLanded(screen, { emoji: "🐙" }), true);
  assert.equal(metadataLanded(screen, { title: "play" }), false, "another name: send it again on the new base");
  assert.equal(metadataLanded(screen, { emoji: "" }), false);
  assert.equal(metadataLanded({ ...screen, emoji: undefined }, { emoji: " " }), true, "a blank icon is stored as none");
});

test("a failed save is retried with backoff and marks the screen unsaved until one lands", () => {
  assert.equal(classifySave(undefined), "retry", "no answer at all");
  assert.equal(classifySave(408), "retry", "a timeout");
  assert.equal(classifySave(502), "retry");
  assert.equal(classifySave(503), "retry");
  assert.equal(classifySave(200), "saved");
  assert.equal(classifySave(409), "conflict");
  assert.equal(classifySave(404), "gone");
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7, 12].map(retryDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);

  let copy = editLocally(opened(leaf("a", "t1")), "mine");
  const sentSeq = copy.syncs.w.editSeq;
  copy = withSync(copy, "w", { type: "failed" });
  copy = withSync(copy, "w", { type: "failed" });
  assert.equal(copy.syncs.w.failures, 2);
  assert.equal(isUnsaved(copy.syncs.w), true, "the tab says the change has not reached the server");
  assert.equal(isRetrying(copy.syncs.w), true);
  assert.equal(saveError(copy.syncs.w), null, "retrying is not an error to show");

  // The user carries on editing while it is out; the retry that lands covers
  // only what it sent, and the later edit is still waiting.
  copy = editLocally(copy, "mine, later");
  copy = withSync(copy, "w", { type: "saved", revision: 2, seq: sentSeq, layout: leaf("a", "mine") });
  assert.equal(copy.syncs.w.revision, 2);
  assert.equal(copy.syncs.w.failures, 0);
  assert.equal(isUnsaved(copy.syncs.w), false, "the marker clears on a successful save");
  assert.equal(hasPendingEdit(copy.syncs.w), true, "the newer edit goes next, based on revision 2");

  copy = withSync(copy, "w", { type: "saved", revision: 3, seq: copy.syncs.w.editSeq, layout: leaf("a", "mine, later") });
  assert.equal(hasPendingEdit(copy.syncs.w), false);
});

test("any other 4xx stops retrying and marks the screen unsaved with the reason", () => {
  for (const status of [400, 401, 403, 413, 422]) assert.equal(classifySave(status), "rejected", String(status));

  let copy = editLocally(opened(leaf("a", "t1")), "mine");
  copy = withSync(copy, "w", { type: "failed" });
  copy = withSync(copy, "w", { type: "rejected", error: "baseRevision is required" });
  const sync = copy.syncs.w;
  assert.equal(isRetrying(sync), false, "no thirty-second loop for ever");
  assert.equal(isUnsaved(sync), true, "but the tab still says it is not saved");
  assert.equal(saveError(sync), "baseRevision is required");

  // The next edit tries again, and a save that lands clears the mark.
  copy = editLocally(copy, "mine, again");
  assert.equal(saveError(copy.syncs.w), "baseRevision is required", "until something lands, it is still not saved");
  copy = withSync(copy, "w", { type: "saved", revision: 2, seq: copy.syncs.w.editSeq, layout: leaf("a", "mine, again") });
  assert.equal(isUnsaved(copy.syncs.w), false);
  assert.equal(saveError(copy.syncs.w), null);
});

test("a rename of ours moves the revision without dropping a waiting layout edit", () => {
  const copy = editLocally(opened(leaf("a", "t1")), "mine");
  const renamed = withSync(copy, "w", { type: "rebased", revision: 2, layout: leaf("a", "t1") });
  assert.equal(renamed.syncs.w.revision, 2, "the layout save is now based on the renamed revision");
  assert.equal(hasPendingEdit(renamed.syncs.w), true);
  assert.deepEqual(renamed.trees.w.root, leaf("a", "mine"));
  // A server copy is still not adopted over that edit.
  assert.equal(reduceSync(renamed.syncs.w, { type: "adopt", revision: 3, layout: leaf("a", "x") }), renamed.syncs.w);
});

test("the list follows screens:list and screens:changed, and ignores the echo of our own writes", () => {
  const revisions: Record<string, number> = { w: 3 };
  const revisionOf = (id: string) => revisions[id];
  const list = (listRevision: number): ScreensFeedEvent => ({ type: "screens:list", listRevision });
  assert.equal(needsRefetch(list(5), 4, revisionOf), true, "another device created, deleted or reordered");
  assert.equal(needsRefetch(list(4), 4, revisionOf), false, "already seen");
  assert.equal(needsRefetch(list(1), undefined, revisionOf), true, "no list yet");

  const changed = (id: string, revision: number, deleted?: boolean): ScreensFeedEvent =>
    ({ type: "screens:changed", id, revision, ...(deleted ? { deleted } : {}) });
  assert.equal(needsRefetch(changed("w", 4), 4, revisionOf), true, "another device saved this screen");
  assert.equal(needsRefetch(changed("w", 3), 4, revisionOf), false, "our own save, already answered");
  assert.equal(needsRefetch(changed("new", 1), 4, revisionOf), true, "a screen not held yet");
  assert.equal(needsRefetch(changed("w", 4, true), 4, revisionOf), true, "a held screen was deleted");
  assert.equal(needsRefetch(changed("gone", 9, true), 4, revisionOf), false, "nothing to drop");
  assert.equal(needsRefetch({ type: "screens:resync" }, 4, revisionOf), true);

  // The refetched list seeds what is new and drops what went.
  const before = seedScreen(opened(leaf("a", "t1")), { id: "old", revision: 1, layout: leaf("o", "t") });
  const after = reconcileScreens(before, [
    { id: "w", revision: 1, layout: leaf("a", "t1") },
    { id: "made-elsewhere", revision: 1, layout: leaf("m", "t") },
  ]);
  assert.deepEqual(Object.keys(after.trees).sort(), ["made-elsewhere", "w"]);
  assert.equal(after.trees.w, before.trees.w, "an untouched screen keeps its tree");
  assert.equal(dropScreen(after, "nope"), after);
});

test("feed frames become screens events, and the store hands them to listeners", () => {
  assert.deepEqual(screensFeedEvent({ type: "screens:changed", id: "w", revision: 2 }), { type: "screens:changed", id: "w", revision: 2 });
  assert.deepEqual(
    screensFeedEvent({ type: "screens:changed", id: "w", revision: 3, deleted: true }),
    { type: "screens:changed", id: "w", revision: 3, deleted: true },
  );
  assert.deepEqual(screensFeedEvent({ type: "screens:list", listRevision: 7 }), { type: "screens:list", listRevision: 7 });
  assert.equal(screensFeedEvent({ type: "screens:changed", id: 7 }), null);
  assert.equal(screensFeedEvent({ type: "sessions:delta" }), null);

  const store = createGlobalFeedStore(LOCAL);
  const seen: ScreensFeedEvent[] = [];
  const stop = store.onScreens((event) => seen.push(event));
  let renders = 0;
  store.subscribe(() => renders++);
  store.emitScreens({ type: "screens:list", listRevision: 2 });
  stop();
  store.emitScreens({ type: "screens:list", listRevision: 3 });
  assert.deepEqual(seen, [{ type: "screens:list", listRevision: 2 }]);
  assert.equal(renders, 0, "screens news does not re-render feed subscribers");
});

test("a fresh screen starts with nothing to save", () => {
  const sync = freshSync(4);
  assert.equal(hasPendingEdit(sync), false);
  assert.equal(isUnsaved(sync), false);
  assert.equal(isUnsaved(undefined), false);
});
