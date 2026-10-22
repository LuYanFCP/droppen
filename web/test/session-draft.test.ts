import assert from "node:assert/strict";
import test from "node:test";
import {
  clearSessionDraft,
  markSessionDraftPending,
  readSessionDraft,
  readSessionDraftSnapshot,
  restoreSessionDraftAfterFailure,
  sessionDraftKey,
  subscribeSessionDraft,
  writeSessionDraft,
  type DraftStorage,
} from "../src/features/sessions/session-draft.js";
import { LOCAL } from "../src/lib/machines/key.js";

class MemoryStorage implements DraftStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

test("drafts are isolated by session and empty drafts remove their key", () => {
  const storage = new MemoryStorage();
  const first = sessionDraftKey({ machine: LOCAL, source: "codex", id: "one" });
  const second = sessionDraftKey({ machine: LOCAL, source: "codex", id: "two" });

  writeSessionDraft(storage, first, "first draft");
  writeSessionDraft(storage, second, "second draft");

  assert.equal(readSessionDraft(storage, first), "first draft");
  assert.equal(readSessionDraft(storage, second), "second draft");

  writeSessionDraft(storage, first, "");
  assert.equal(readSessionDraft(storage, first), "");
  assert.equal(storage.values.has(first), false);
});

test("unavailable storage falls back without throwing", () => {
  const unavailable: DraftStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
  };

  assert.equal(readSessionDraft(unavailable, "draft"), "");
  assert.doesNotThrow(() => writeSessionDraft(unavailable, "draft", "text"));
  assert.doesNotThrow(() => writeSessionDraft(unavailable, "draft", ""));
});

test("a completed send only clears the exact submitted draft revision", () => {
  const storage = new MemoryStorage();
  const key = sessionDraftKey({ machine: LOCAL, source: "codex", id: "race" });
  const submitted = writeSessionDraft(storage, key, "same text");
  const newer = writeSessionDraft(storage, key, "same text");

  assert.notEqual(submitted.revision, newer.revision);
  assert.equal(clearSessionDraft(storage, key, submitted.revision!), false);
  assert.equal(readSessionDraft(storage, key), "same text");
  assert.equal(clearSessionDraft(storage, key, newer.revision!), true);
  assert.equal(readSessionDraft(storage, key), "");
});

test("a pending send stays stored but is marked hidden until success", () => {
  const storage = new MemoryStorage();
  const key = sessionDraftKey({ machine: LOCAL, source: "claude", id: "pending-success" });
  const states: Array<{ text: string; pending: boolean }> = [];
  const unsubscribe = subscribeSessionDraft(key, ({ text, pending }) => {
    states.push({ text, pending });
  });
  const submitted = writeSessionDraft(storage, key, "pending");
  const request = { text: submitted.text, revision: submitted.revision! };

  markSessionDraftPending(key, request);
  assert.deepEqual(readSessionDraftSnapshot(storage, key), {
    text: "pending",
    revision: request.revision,
    pending: true,
  });
  assert.equal(clearSessionDraft(storage, key, request.revision), true);
  unsubscribe();
  assert.deepEqual(states, [
    { text: "pending", pending: false },
    { text: "pending", pending: true },
    { text: "", pending: false },
  ]);
});

test("a failed send restores its draft when no newer edit exists", () => {
  const storage = new MemoryStorage();
  const key = sessionDraftKey({ machine: LOCAL, source: "codex", id: "pending-failure" });
  const submitted = writeSessionDraft(storage, key, "retry me");
  const request = { text: submitted.text, revision: submitted.revision! };

  markSessionDraftPending(key, request);
  assert.equal(restoreSessionDraftAfterFailure(storage, key, request), true);
  assert.deepEqual(readSessionDraftSnapshot(storage, key), {
    text: "retry me",
    revision: request.revision,
    pending: false,
  });
});

test("a failed older send never overwrites a newer draft", () => {
  const storage = new MemoryStorage();
  const key = sessionDraftKey({ machine: LOCAL, source: "codex", id: "newer-edit" });
  const submitted = writeSessionDraft(storage, key, "old");
  const request = { text: submitted.text, revision: submitted.revision! };

  markSessionDraftPending(key, request);
  const newer = writeSessionDraft(storage, key, "new");
  assert.equal(restoreSessionDraftAfterFailure(storage, key, request), false);
  assert.deepEqual(readSessionDraftSnapshot(storage, key), newer);
});
