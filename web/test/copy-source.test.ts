// Where a machine's offline copy comes from (`lib/hub/copy-source.ts`): the
// copy asks by name — the index, the status, a session — and the hub source
// derives the streams from the machine's keys, says where a copy stands as the
// head the machine signed (so one read back is trusted only while that
// signature checks), and follows the account's keys: a machine whose first
// key lands after the page opened it starts its copy then, with no reload.
import assert from "node:assert/strict";
import test from "node:test";
import { FMT_INDEX_V1, generateDeviceKeys, hex, indexStream, type MachineKey, statusStream, streamId } from "../src/lib/e2e/index.js";
import { HubCopySource, KEY_RETRY_MS } from "../src/lib/hub/copy-source.js";
import { MachineMirror } from "../src/lib/hub/mirror.js";
import { StreamClient } from "../src/lib/hub/streams.js";
import { FakeKv, FakeStreamLink, flush, makeMachine, StreamWriter, until } from "./stream-fixtures.js";

const row = (id: string, updatedAt: string) => ({ source: "claude", id, title: `t ${id}`, updatedAt, cwd: "/w" });

/** An account that holds no key for the machine until `grant()`, and says so when it changes. */
function account(signKey: Uint8Array, epochs: Map<number, MachineKey>) {
  let held = false;
  const listeners = new Set<() => void>();
  return {
    machine: (id: string) => (held && id === "m-1" ? { signKey } : undefined),
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    keys: async () => (held ? epochs : new Map<number, MachineKey>()),
    grant() {
      held = true;
      for (const fn of [...listeners]) fn();
    },
  };
}

test("a source names the copies by what they are: index and status per key epoch, newest first; a session under its entry's epoch", async () => {
  const machine = await makeMachine();
  const link = new FakeStreamLink();
  const client = new StreamClient({ link, machineSignKey: machine.signPublic, epochs: machine.epochs, fetchPage: async () => new Uint8Array() });
  const source = HubCopySource.over({ mk: machine.mk, client });
  await source.ready();
  assert.equal(source.keyed, true);
  assert.deepEqual(await source.places({ kind: "index" }), [hex(await indexStream(machine.mk))]);
  assert.deepEqual(await source.places({ kind: "status" }), [hex(await statusStream(machine.mk))]);
  assert.deepEqual(await source.places({ kind: "session", source: "claude", id: "a" }), [hex(await streamId(machine.mk, "claude", "a"))]);
  assert.deepEqual(await source.places({ kind: "session", source: "claude", id: "a", se: 7 }), [], "an epoch this device holds no key for: nothing to be had");

  // A mark is the machine's signed head: one the machine signed resumes, any other does not.
  const writer = await StreamWriter.open(machine, await indexStream(machine.mk), FMT_INDEX_V1);
  await writer.append({ upserts: [row("a", "2026-10-15T00:00:00.000Z")], removed: [], asOf: 1 });
  const place = hex(writer.stream);
  const signed = hex(await writer.head(42_000));
  const mark = await source.resume(place, signed);
  assert.equal(mark?.seq, 1);
  assert.equal(mark?.timeMs, 42_000);
  const stranger = await generateDeviceKeys();
  const other = HubCopySource.over({ mk: machine.mk, client: new StreamClient({ link, machineSignKey: stranger.signPublic, epochs: machine.epochs, fetchPage: async () => new Uint8Array() }) });
  assert.equal(await other.resume(place, signed), null, "a head another key signed is not this machine's");
  assert.equal(await source.resume(place, "not hex"), null);

  // No keys: nothing to name, nothing to follow.
  const none = HubCopySource.over(null);
  assert.equal(none.keyed, false);
  assert.deepEqual(await none.places({ kind: "index" }), []);
  assert.equal(none.follow({ kind: "index" }, [], { at: 0, from: null }, { onState: () => undefined }), null);
  client.close();
});

test("a machine whose first key lands after the page opened it starts its copy then, without a reload", async () => {
  const machine = await makeMachine();
  const acct = account(machine.signPublic, machine.epochs);
  const link = new FakeStreamLink();
  const source = HubCopySource.following({
    account: acct,
    machine: "m-1",
    keys: acct.keys,
    client: { link, fetchPage: async () => new Uint8Array(), retryDelay: () => 0 },
  });
  const mirror = new MachineMirror({ account: "a-1", machine: "m-1", source, transact: new FakeKv().transact, saveDelayMs: { small: 1, session: 1 } });
  await mirror.start();
  assert.equal(mirror.loaded, true, "loaded: there is nothing to show yet, and the page draws that at once");
  assert.equal(mirror.hasCopy, false);
  await flush(5);
  assert.equal(link.subs().length, 0, "nothing is followed without a key");

  const writer = await StreamWriter.open(machine, await indexStream(machine.mk), FMT_INDEX_V1);
  await writer.append({ upserts: [row("a", "2026-10-15T00:00:00.000Z")], removed: [], asOf: 1 });
  acct.grant();
  const place = hex(writer.stream);
  await until(() => link.subs().some((s) => hex(s.stream) === place));
  const sub = link.subs().find((s) => hex(s.stream) === place)!;
  link.deliver({ type: "recs", ch: sub.ch, stream: writer.stream, records: writer.records });
  link.deliver({ type: "head", ch: sub.ch, head: await writer.head() });
  link.control({ t: "stream_synced", ch: sub.ch, stream: place, next_seq: writer.seq, exists: true });
  await until(() => mirror.rows()?.length === 1);
  assert.equal(mirror.rows()![0]!.id, "a");

  mirror.close();
  source.close();
  const before = link.subs().length;
  acct.grant();
  await flush(5);
  assert.equal(link.subs().length, before, "a closed source follows nothing more");
});

/** Let the promises run (with `setTimeout` mocked, `flush` would wait for ever). */
const turns = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

test("a machine the account has but no key of yet (its key put in the keyring just after its chain entry): looked for again a few times, until the key is there", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const machine = await makeMachine();
  let keyed = false;
  let refreshed = 0;
  const listeners = new Set<() => void>();
  // The chain names the machine already; its key arrives in the keyring a moment later.
  const acct = {
    machine: (id: string) => (id === "m-1" ? { signKey: machine.signPublic } : undefined),
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    keys: async () => (keyed ? machine.epochs : new Map<number, MachineKey>()),
  };
  const link = new FakeStreamLink();
  const source = HubCopySource.following({
    account: acct,
    machine: "m-1",
    keys: acct.keys,
    client: { link, fetchPage: async () => new Uint8Array(), retryDelay: () => 0 },
    // The keyring read again; the account tells its listeners.
    refresh: async () => {
      refreshed++;
      for (const fn of [...listeners]) fn();
    },
  });
  await source.ready();
  assert.equal(source.keyed, false);
  t.mock.timers.tick(KEY_RETRY_MS[0]!);
  await turns();
  assert.equal(refreshed, 1, "looked for once more");
  assert.equal(source.keyed, false);
  keyed = true;
  t.mock.timers.tick(KEY_RETRY_MS[1]!);
  await turns();
  assert.equal(refreshed, 2);
  assert.equal(source.keyed, true, "the key is there: the copy can start");
  // Nothing more is looked for once it has its key.
  t.mock.timers.tick(KEY_RETRY_MS[2]! + KEY_RETRY_MS[3]!);
  await turns();
  assert.equal(refreshed, 2);
  source.close();
});

test("a machine whose key never comes is looked for again only a bounded number of times", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const machine = await makeMachine();
  let refreshed = 0;
  const listeners = new Set<() => void>();
  const acct = {
    machine: (id: string) => (id === "m-1" ? { signKey: machine.signPublic } : undefined),
    onChange(fn: () => void) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    keys: async () => new Map<number, MachineKey>(),
  };
  const source = HubCopySource.following({
    account: acct,
    machine: "m-1",
    keys: acct.keys,
    client: { link: new FakeStreamLink(), fetchPage: async () => new Uint8Array(), retryDelay: () => 0 },
    refresh: async () => {
      refreshed++;
      for (const fn of [...listeners]) fn();
    },
  });
  await source.ready();
  for (const ms of [...KEY_RETRY_MS, 60_000, 60_000]) {
    t.mock.timers.tick(ms);
    await turns();
  }
  assert.equal(refreshed, KEY_RETRY_MS.length);
  source.close();
});
