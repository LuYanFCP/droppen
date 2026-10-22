// The device copy's rules, and the guarantees around logging out.
//
// The copy holds transcript text, so it must be the signed-in user's and
// nobody else's: a record written for another user is never shown, a logout
// seals the store so that saves already scheduled cannot put anything back,
// and the page's socket is told to stop before the login page replaces it.
import assert from "node:assert/strict";
import test from "node:test";
import {
  COPY_SCHEMA,
  feedCopyKey,
  nextFeedIndex,
  orphanFeedKeys,
  readCopy,
} from "../src/features/sessions/feed-copy.js";
import { cacheClear, cacheSealed, cacheTransact, cacheUnseal } from "../src/lib/local-cache.js";
import { clearToken, onSignedOut } from "../src/lib/auth.js";
import { LOCAL } from "../src/lib/machines/key.js";
import { machineCacheKey } from "../src/lib/machines/storage.js";

test("a copy is read only in this format and only for its owner", () => {
  assert.deepEqual(readCopy({ v: COPY_SCHEMA, owner: "ada", value: [1] }, "ada"), { value: [1] });
  assert.deepEqual(readCopy({ v: COPY_SCHEMA, owner: "bob", value: [1] }, "ada"), { foreign: true });
  assert.deepEqual(readCopy({ v: COPY_SCHEMA, owner: null, value: [1] }, null), { value: [1] }, "an open server");
  assert.deepEqual(readCopy({ v: COPY_SCHEMA + 1, owner: "ada", value: [1] }, "ada"), { stale: true });
  assert.deepEqual(readCopy([1, 2], "ada"), { stale: true }, "a record from before records had a format");
  assert.deepEqual(readCopy(undefined, "ada"), { stale: true });
});

test("the index keeps the newest few, and every other window copy is an orphan", () => {
  const { kept, evicted } = nextFeedIndex(["b", "c", "d", "e", "f"], "a", 5);
  assert.deepEqual(kept, ["a", "b", "c", "d", "e"]);
  assert.deepEqual(evicted, ["f"]);
  assert.deepEqual(nextFeedIndex(["b", "a", "c"], "a").kept, ["a", "b", "c"], "a save moves it to the front");
  assert.deepEqual(nextFeedIndex("garbage", "a").kept, ["a"]);
  // Another tab's saves, keys from before the index existed: all swept.
  const keys = [feedCopyKey("a"), feedCopyKey("b"), feedCopyKey("zombie"), "feeds", "sessions"];
  assert.deepEqual(orphanFeedKeys(keys, ["a", "b"], LOCAL), [feedCopyKey("zombie")]);
});

test("each machine sweeps its own window copies: the local machine's keys are the ones from before", () => {
  const other = (name: string) => machineCacheKey("m-other", name);
  // Today's store, with another machine's copies next to the local one's.
  const keys = ["feed:claude/a", "feed:claude/zombie", "feeds", "sessions", other("feed:claude/a"), other("feed:claude/z"), other("feeds"), other("sessions")];
  assert.equal(machineCacheKey(LOCAL, feedCopyKey("claude/a")), "feed:claude/a", "the local machine keeps its keys");
  assert.equal(other(feedCopyKey("claude/a")), "m/m-other/feed:claude/a");
  assert.deepEqual(orphanFeedKeys(keys, ["claude/a"], LOCAL), ["feed:claude/zombie"], "the local sweep leaves the other machine alone");
  assert.deepEqual(orphanFeedKeys(keys, ["claude/a"], "m-other"), [other("feed:claude/z")], "and the other machine's leaves the local one alone");
});

test("a cleared store refuses every later write until a new login", async () => {
  cacheUnseal();
  assert.equal(cacheSealed(), false);
  const cleared = cacheClear();
  assert.equal(cacheSealed(), true, "sealed at once, before the clear has even landed");
  let ran = false;
  const write = await cacheTransact("readwrite", () => {
    ran = true;
  });
  assert.equal(write, undefined);
  assert.equal(ran, false, "a save scheduled before the logout cannot put anything back");
  await cleared;
  cacheUnseal();
});

test("losing the token seals the store and tells whoever is still running", () => {
  cacheUnseal();
  let told = 0;
  const stop = onSignedOut(() => told++);
  clearToken();
  stop();
  assert.equal(told, 1);
  assert.equal(cacheSealed(), true);
  clearToken();
  assert.equal(told, 1, "an unsubscribed listener hears nothing more");
  cacheUnseal();
});
