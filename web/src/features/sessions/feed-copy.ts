/*
 * The rules for the copy of the session list and windows kept on the device
 * (`feed-persist.ts`), apart from the storage so that they can be tested.
 *
 * Every record says which build of this format wrote it and whose it is. A
 * record from another format is ignored; one written for another user means the
 * device changed hands without a logout, and everything is thrown away.
 */

import type { MachineKey } from "@/lib/machines/key";
import { machineCacheKey } from "@/lib/machines/storage";

/** Bumped whenever what a record holds changes shape. */
export const COPY_SCHEMA = 1;
/** How many sessions' windows are kept. */
export const KEPT_FEEDS = 5;
const FEED_PREFIX = "feed:";

/**
 * The name of a session's window (`key` is its `source/id`) within its
 * machine's part of the store; the store key is `machineCacheKey(machine,
 * feedCopyKey(key))` — the name itself on the local machine.
 */
export const feedCopyKey = (key: string) => `${FEED_PREFIX}${key}`;

/** A stored copy: the format, the owner, and the value. */
export interface CopyRecord<T> {
  v: number;
  owner: string | null;
  value: T;
}

/** The value of `record` if it is in this format and `owner`'s; why not, otherwise. */
export function readCopy<T>(
  record: unknown,
  owner: string | null,
): { value: T } | { stale: true } | { foreign: true } {
  if (!record || typeof record !== "object") return { stale: true };
  const { v, owner: by, value } = record as Partial<CopyRecord<T>>;
  if (v !== COPY_SCHEMA || value === undefined) return { stale: true };
  if ((by ?? null) !== owner) return { foreign: true };
  return { value };
}

/**
 * The index after saving `key`: most recently saved first, at most `keep` long,
 * and the keys that fell off it.
 */
export function nextFeedIndex(
  index: unknown,
  key: string,
  keep: number = KEPT_FEEDS,
): { kept: string[]; evicted: string[] } {
  const list = Array.isArray(index) ? index.filter((k): k is string => typeof k === "string") : [];
  const next = [key, ...list.filter((other) => other !== key)];
  return { kept: next.slice(0, keep), evicted: next.slice(keep) };
}

/**
 * Of every key in the store, `machine`'s window copies its index does not
 * name. Another machine's copies are not this index's to sweep.
 */
export function orphanFeedKeys(keys: readonly unknown[], kept: readonly string[], machine: MachineKey): string[] {
  const prefix = machineCacheKey(machine, FEED_PREFIX);
  const named = new Set(kept.map((key) => machineCacheKey(machine, feedCopyKey(key))));
  return keys.filter((k): k is string => typeof k === "string" && k.startsWith(prefix) && !named.has(k));
}
