// The offline copy at rest (`lib/hub/mirror.ts`, `lib/hub/machine-status.ts`):
// every record a machine's mirror or status reader writes is sealed under a
// device-local, non-extractable AES-GCM key kept in the key store — nothing
// the machine sent (titles, transcripts, its name, which sessions were opened,
// the signed heads) is on the device in the clear. A record of the old
// plaintext schema is deleted, one that does not open (tampered, moved,
// another key) is treated as absent and deleted, and forgetting the key takes
// every copy with it.
import assert from "node:assert/strict";
import test from "node:test";
import { HubCopySource } from "../src/lib/hub/copy-source.js";
import { FMT_FEED_V1, FMT_INDEX_V1, FMT_STATUS_V1, hex, indexStream, type KeyStore, MemoryKeyStore, statusStream, streamId, utf8 } from "../src/lib/e2e/index.js";
import { MachineStatusReader } from "../src/lib/hub/machine-status.js";
import {
  forgetMirrorKey,
  isStoredCopy,
  MachineMirror,
  metaKey,
  MIRROR_KEY_NAME,
  mirrorSeal,
  type MirrorSeal,
  streamRecordKey,
} from "../src/lib/hub/mirror.js";
import { type FeedCopy, type StatusState, StreamClient } from "../src/lib/hub/streams.js";
import { FakeKv, FakeStreamLink, makeMachine, type Machine, putCopy, readCopy, readOpened, StreamWriter, until } from "./stream-fixtures.js";

/** Whether `needle` appears anywhere in `value`: in a byte string, or (as UTF-8, or hex) in a string. */
function containsBytes(value: unknown, needle: Uint8Array, seen = new Set<unknown>()): boolean {
  const hay = (b: Uint8Array) => {
    outer: for (let i = 0; i + needle.length <= b.length; i++) {
      for (let j = 0; j < needle.length; j++) if (b[i + j] !== needle[j]) continue outer;
      return true;
    }
    return false;
  };
  if (value === null || value === undefined) return false;
  if (value instanceof Uint8Array) return hay(value);
  if (typeof value === "string") return hay(utf8(value)) || value.toLowerCase().includes(hex(needle));
  if (typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  return Object.values(value as Record<string, unknown>).some((v) => containsBytes(v, needle, seen));
}

/** Everything the device holds, as one value. */
const atRest = (kv: FakeKv) => [...kv.data.entries()];

const row = (id: string, title: string, updatedAt = "2026-10-14T00:00:00.000Z") => ({ source: "claude", id, title, updatedAt, cwd: "/Users/someone/secret-project" });

const SECRET_TITLE = "fix the payroll export for ACME";
const SECRET_TEXT = "the database password is hunter2-correct-horse";
const SECRET_NAME = "adas-studio-mac";
const SECRET_ID = "0b6c0a5e-secret-session-id";

async function writers(machine: Machine) {
  const index = await StreamWriter.open(machine, await indexStream(machine.mk), FMT_INDEX_V1);
  const status = await StreamWriter.open(machine, await statusStream(machine.mk), FMT_STATUS_V1);
  const session = await StreamWriter.open(machine, await streamId(machine.mk, "claude", SECRET_ID), FMT_FEED_V1);
  await index.append({ upserts: [row(SECRET_ID, SECRET_TITLE)], removed: [], asOf: 1 });
  await status.append({ asOf: 1, settings: { hostname: SECRET_NAME }, accounts: null, quota: null, cli: null, displayName: SECRET_NAME, mkEpoch: 0 });
  await session.append({ fromIndex: 0, items: [{ kind: "user", text: SECRET_TEXT }], endIndex: 1, fp: "f1", prefixFp: "p0" });
  return { index, status, session };
}

function world(machine: Machine, kv: FakeKv, seal: MirrorSeal, account = "a-1") {
  const link = new FakeStreamLink();
  const client = new StreamClient({ link, machineSignKey: machine.signPublic, epochs: machine.epochs, fetchPage: async () => new Uint8Array(), retryDelay: () => 0 });
  const mirror = new MachineMirror({ account, machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client }), transact: kv.transact, seal, saveDelayMs: { small: 1, session: 1 }, sessionWaitMs: 500 });
  return { link, client, mirror };
}

/** The `sub` frame the link last sent for `writer`'s stream. */
const subFor = (link: FakeStreamLink, writer: StreamWriter) => link.subs().filter((s) => hex(s.stream) === hex(writer.stream)).at(-1);

async function catchUpStream(link: FakeStreamLink, writer: StreamWriter, timeMs = 50_000) {
  await until(() => subFor(link, writer) !== undefined);
  const sub = subFor(link, writer)!;
  const records = writer.records.slice(sub.fromSeq);
  if (records.length) link.deliver({ type: "recs", ch: sub.ch, stream: writer.stream, records });
  link.deliver({ type: "head", ch: sub.ch, head: await writer.head(timeMs) });
  link.control({ t: "stream_synced", ch: sub.ch, stream: hex(writer.stream), next_seq: writer.seq, exists: true });
}

/** A device with a full copy of one machine on it: index, status, one opened session. */
async function filled(machine: Machine, kv: FakeKv, seal: MirrorSeal) {
  const w = await writers(machine);
  const { mirror, link, client } = world(machine, kv, seal);
  await mirror.start();
  await catchUpStream(link, w.index);
  await catchUpStream(link, w.status);
  mirror.touch("claude", SECRET_ID);
  await catchUpStream(link, w.session);
  const keys = [w.index, w.status, w.session].map((x) => streamRecordKey("a-1", "m-1", hex(x.stream)));
  await until(() => keys.every((k) => kv.data.has(k)) && kv.data.has(metaKey("a-1", "m-1")));
  await mirror.flush();
  mirror.close();
  client.close();
  return { w, keys };
}

test("nothing the machine sent is on the device in the clear, and the key is a non-extractable CryptoKey in the key store", async () => {
  const machine = await makeMachine();
  const kv = new FakeKv();
  const store = new MemoryKeyStore();
  const { w, keys } = await filled(machine, kv, mirrorSeal(store));

  for (const key of keys) assert.ok(isStoredCopy(kv.data.get(key)), `${key} is sealed`);
  const all = atRest(kv);
  for (const secret of [SECRET_TITLE, SECRET_TEXT, SECRET_NAME, SECRET_ID, "secret-project", "hunter2"]) {
    assert.equal(containsBytes(all, utf8(secret)), false, `"${secret}" is not at rest`);
  }
  // Nor the signed heads (the hub sees them, but the copy keeps them sealed anyway).
  for (const writer of [w.index, w.status, w.session]) {
    const head = await writer.head(50_000);
    assert.equal(containsBytes(all, head.subarray(head.length - 64)), false, "no signed head in the clear");
  }

  const key = (await store.get(MIRROR_KEY_NAME)) as CryptoKey;
  assert.equal(key.type, "secret");
  assert.equal(key.extractable, false, "the page can use it but never read it out");
  assert.equal((key.algorithm as AesKeyAlgorithm).name, "AES-GCM");
  assert.equal((key.algorithm as AesKeyAlgorithm).length, 256);
});

test("a copy read back opens: the next load draws the list, the name and the opened session from the device", async () => {
  const machine = await makeMachine();
  const kv = new FakeKv();
  const seal = mirrorSeal(new MemoryKeyStore());
  const { w } = await filled(machine, kv, seal);

  const again = world(machine, kv, seal);
  await again.mirror.start();
  assert.equal(again.mirror.rows()?.[0]?.title, SECRET_TITLE);
  assert.equal(again.mirror.status?.state?.displayName, SECRET_NAME);
  assert.equal(again.mirror.status?.state?.mkEpoch, 0);
  const copy = await again.mirror.session("claude", SECRET_ID, 0);
  assert.deepEqual(copy?.state.items, [{ kind: "user", text: SECRET_TEXT }]);
  assert.deepEqual((await readOpened(kv, "a-1", "m-1", seal)).map((o) => o.id), [SECRET_ID]);
  await until(() => subFor(again.link, w.index) !== undefined);
  assert.equal(subFor(again.link, w.index)!.fromSeq, 1, "followed from the saved position");
  again.mirror.close();

  // The status reader of the machine list reads the very same record.
  const link = new FakeStreamLink();
  const client = new StreamClient({ link, machineSignKey: machine.signPublic, epochs: machine.epochs, fetchPage: async () => new Uint8Array(), retryDelay: () => 0 });
  const reader = new MachineStatusReader({ account: "a-1", machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client }), transact: kv.transact, seal });
  await reader.start();
  assert.equal(reader.state?.displayName, SECRET_NAME);
  reader.close();
  client.close();
});

test("plaintext copies from before the seal are deleted, not shown, and not left behind", async () => {
  const machine = await makeMachine();
  const kv = new FakeKv();
  const w = await writers(machine);
  const head = hex(await w.index.head(5_000));
  const legacy = (kind: string, state: unknown) => ({ v: 1, owner: "a-1", machine: "m-1", kind, head, state, freshestMs: 5_000, savedAt: 1 });
  const indexKey = streamRecordKey("a-1", "m-1", hex(w.index.stream));
  const statusKey = streamRecordKey("a-1", "m-1", hex(w.status.stream));
  const sessionKey = streamRecordKey("a-1", "m-1", hex(w.session.stream));
  const otherMachine = streamRecordKey("a-1", "m-2", "cd".repeat(32));
  kv.data.set(indexKey, legacy("index", { rows: { [`claude/${SECRET_ID}`]: row(SECRET_ID, SECRET_TITLE) }, asOf: 1 }));
  kv.data.set(statusKey, legacy("status", { displayName: SECRET_NAME }));
  kv.data.set(sessionKey, legacy("session", { started: true, startIndex: 0, endIndex: 1, items: [{ kind: "user", text: SECRET_TEXT }] }));
  kv.data.set(otherMachine, legacy("session", { items: [{ kind: "user", text: SECRET_TEXT }] }));
  kv.data.set(metaKey("a-1", "m-1"), { v: 1, owner: "a-1", machine: "m-1", opened: [{ source: "claude", id: SECRET_ID, hex: hex(w.session.stream) }] });
  // The current schema's number on a record of the old (plaintext) shape is no better.
  kv.data.set(streamRecordKey("a-1", "m-3", "ef".repeat(32)), { ...legacy("index", { rows: {} }), v: 2 });
  kv.data.set("feed:claude/x", { v: 1, note: "not the mirror's" });

  const { mirror } = world(machine, kv, mirrorSeal(new MemoryKeyStore()));
  await mirror.start();
  assert.equal(mirror.hasCopy, false, "not shown");
  assert.equal(mirror.status?.state ?? null, null);
  assert.equal(await mirror.session("claude", SECRET_ID, 0), null);
  await until(() => [...kv.data.keys()].every((k) => k === "feed:claude/x"));
  assert.equal(containsBytes(atRest(kv), utf8(SECRET_TEXT)), false);
  mirror.close();

  // The machine list's status reader drops one too (it may be the only reader that ever looks).
  const kv2 = new FakeKv();
  kv2.data.set(statusKey, legacy("status", { displayName: SECRET_NAME }));
  const link = new FakeStreamLink();
  const client = new StreamClient({ link, machineSignKey: machine.signPublic, epochs: machine.epochs, fetchPage: async () => new Uint8Array(), retryDelay: () => 0 });
  const reader = new MachineStatusReader({ account: "a-1", machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client }), transact: kv2.transact, seal: mirrorSeal(new MemoryKeyStore()) });
  await reader.start();
  assert.equal(reader.state, null);
  await until(() => !kv2.data.has(statusKey));
  reader.close();
  client.close();
});

test("a tampered copy, one moved to another stream's key, or one under another key is treated as absent and deleted", async () => {
  const machine = await makeMachine();
  const seal = mirrorSeal(new MemoryKeyStore());
  const base = new FakeKv();
  const { w, keys } = await filled(machine, base, seal);
  const [indexKey, statusKey, sessionKey] = keys as [string, string, string];

  const fresh = () => {
    const kv = new FakeKv();
    kv.data = structuredClone(base.data);
    return kv;
  };
  const loads = async (kv: FakeKv, s: MirrorSeal = seal) => {
    const { mirror } = world(machine, kv, s);
    await mirror.start();
    return mirror;
  };

  // One flipped bit in the ciphertext.
  {
    const kv = fresh();
    const stored = kv.data.get(indexKey) as { ct: Uint8Array };
    stored.ct[stored.ct.length - 1]! ^= 1;
    const mirror = await loads(kv);
    assert.equal(mirror.hasCopy, false, "a tampered index is not shown");
    assert.equal(mirror.status?.state?.displayName, SECRET_NAME, "the rest of the copy still is");
    await until(() => !kv.data.has(indexKey));
    mirror.close();
  }
  // The status record put where the index belongs (the AAD names the store key).
  {
    const kv = fresh();
    kv.data.set(indexKey, kv.data.get(statusKey));
    const mirror = await loads(kv);
    assert.equal(mirror.hasCopy, false);
    await until(() => !kv.data.has(indexKey));
    mirror.close();
  }
  // Another account's sealed record put under this account's key.
  {
    const kv = fresh();
    const moved = await putCopy(kv, "a-2", "m-1", hex(w.index.stream), { kind: "index", head: "", state: { rows: {} }, freshestMs: 0, savedAt: 0 }, seal);
    kv.data.set(indexKey, { ...(kv.data.get(moved) as object), owner: "a-1" });
    kv.data.delete(moved);
    const mirror = await loads(kv);
    assert.equal(mirror.hasCopy, false, "bound to its account: relabelling it does not help");
    await until(() => !kv.data.has(indexKey));
    mirror.close();
  }
  // A session copy that does not open is not handed out, and goes.
  {
    const kv = fresh();
    (kv.data.get(sessionKey) as { iv: Uint8Array }).iv[0]! ^= 0xff;
    const mirror = await loads(kv);
    assert.equal(await mirror.session("claude", SECRET_ID, 0), null);
    await until(() => !kv.data.has(sessionKey));
    assert.equal(await readCopy<FeedCopy>(kv, "a-1", "m-1", hex(w.session.stream), "session", seal), null);
    mirror.close();
  }
  // Every record under a key this device no longer has (another browser profile's, a forgotten key).
  {
    const kv = fresh();
    const mirror = await loads(kv, mirrorSeal(new MemoryKeyStore()));
    assert.equal(mirror.hasCopy, false);
    assert.equal(mirror.status?.state ?? null, null);
    await until(() => !kv.data.has(indexKey) && !kv.data.has(statusKey));
    mirror.close();
  }
});

test("forgetting the mirror key takes every copy with it; the next save makes a new key", async () => {
  const machine = await makeMachine();
  const kv = new FakeKv();
  const store = new MemoryKeyStore();
  const seal = mirrorSeal(store);
  const { keys } = await filled(machine, kv, seal);
  const first = await store.get(MIRROR_KEY_NAME);
  assert.ok(first);

  await forgetMirrorKey(store);
  assert.equal(await store.get(MIRROR_KEY_NAME), undefined, "gone from the key store");
  for (const key of keys) assert.equal(await readCopy(kv, "a-1", "m-1", key.split("/").at(-1)!, key === keys[1] ? "status" : key === keys[0] ? "index" : "session", seal), null, "opens for nobody");

  const { mirror } = world(machine, kv, seal);
  await mirror.start();
  assert.equal(mirror.hasCopy, false);
  mirror.close();
  const second = await store.get(MIRROR_KEY_NAME);
  assert.ok(second && second !== first, "a new key");
});

test("the key is made once per store however many seals ask at once, and nothing is written when there is no key", async () => {
  class CountingStore extends MemoryKeyStore {
    puts = 0;
    override async put(name: string, value: unknown) {
      if (name === MIRROR_KEY_NAME) this.puts++;
      await new Promise((resolve) => setTimeout(resolve, 2));
      return super.put(name, value);
    }
  }
  const store = new CountingStore();
  const at = { account: "a-1", machine: "m-1", key: streamRecordKey("a-1", "m-1", "ab") };
  // Two seals over the same store (or two stores over one database) at once.
  const sealed = await Promise.all([mirrorSeal(store).seal(at, { n: 1 }), mirrorSeal(store).seal(at, { n: 2 }), mirrorSeal(store).seal(at, { n: 3 })]);
  assert.equal(store.puts, 1, "one key");
  for (const [i, s] of sealed.entries()) assert.deepEqual((await mirrorSeal(store).open(at, s))?.value, { n: i + 1 });

  // A key store that cannot be read: the copy is not saved at all — never in the clear.
  const broken: KeyStore = {
    get: async () => {
      throw new Error("no key store");
    },
    put: async () => {
      throw new Error("no key store");
    },
    delete: async () => undefined,
  };
  const machine = await makeMachine();
  const kv = new FakeKv();
  const w = await writers(machine);
  const { mirror, link } = world(machine, kv, mirrorSeal(broken));
  await mirror.start();
  await catchUpStream(link, w.index);
  await catchUpStream(link, w.status);
  await until(() => mirror.hasCopy);
  await new Promise((resolve) => setTimeout(resolve, 20));
  await mirror.flush();
  assert.equal([...kv.data.keys()].filter((k) => k.startsWith("stream/")).length, 0, "nothing written");
  assert.equal(containsBytes(atRest(kv), utf8(SECRET_TITLE)), false);
  mirror.close();
});

test("a status reader's copy is sealed, carries the key epoch, and a different seal cannot read it", async () => {
  const machine = await makeMachine();
  const kv = new FakeKv();
  const seal = mirrorSeal(new MemoryKeyStore());
  const writer = await StreamWriter.open(machine, await statusStream(machine.mk), FMT_STATUS_V1);
  await writer.append({ asOf: 1, settings: { hostname: SECRET_NAME }, displayName: SECRET_NAME, mkEpoch: 3 });
  const link = new FakeStreamLink();
  const client = new StreamClient({ link, machineSignKey: machine.signPublic, epochs: machine.epochs, fetchPage: async () => new Uint8Array(), retryDelay: () => 0 });
  const reader = new MachineStatusReader({ account: "a-1", machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client }), transact: kv.transact, seal, saveDelayMs: 1 });
  await reader.start();
  await until(() => link.subs().length > 0);
  await catchUpStream(link, writer);
  await until(() => reader.state?.mkEpoch === 3);
  const key = streamRecordKey("a-1", "m-1", hex(writer.stream));
  await until(() => kv.data.has(key));
  assert.ok(isStoredCopy(kv.data.get(key)));
  assert.equal(containsBytes(atRest(kv), utf8(SECRET_NAME)), false);
  assert.equal((await readCopy<StatusState>(kv, "a-1", "m-1", hex(writer.stream), "status", seal))?.state.mkEpoch, 3);
  assert.equal(await readCopy<StatusState>(kv, "a-1", "m-1", hex(writer.stream), "status", mirrorSeal(new MemoryKeyStore())), null);
  reader.close();
  client.close();
});
