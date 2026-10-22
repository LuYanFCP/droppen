// Streams named per key epoch (relay-and-plans §5, `streams/2`): the index and
// status are looked for under the newest epoch first, then older ones (a
// machine off since a rotation has not moved them), and followed on to a newer
// name the moment it has something; a session's stream is named under its
// index entry's `se` (none: the first epoch), and followed under its new name
// once the entry moves.
import assert from "node:assert/strict";
import test from "node:test";
import { HubCopySource } from "../src/lib/hub/copy-source.js";
import { FMT_FEED_V1, FMT_INDEX_V1, FMT_STATUS_V1, hex, indexStream, namingKey, sessionNamingKey, statusStream, streamId, STREAMS_FEATURE } from "../src/lib/e2e/index.js";
import { CLIENT_INFO } from "../src/lib/hub/machine.js";
import { MachineStatusReader } from "../src/lib/hub/machine-status.js";
import { MachineMirror, namesOf, streamRecordKey } from "../src/lib/hub/mirror.js";
import { type IndexState, indexFold, NewestStream, StreamClient } from "../src/lib/hub/streams.js";
import { FakeKv, FakeStreamLink, flush, makeMachine, type Machine, rotate, StreamWriter, until } from "./stream-fixtures.js";

const row = (id: string, extra: Record<string, unknown> = {}) => ({ source: "claude", id, title: `t ${id}`, updatedAt: "2026-10-16T00:00:00.000Z", cwd: "/w", ...extra });

function client(machine: Machine, link: FakeStreamLink) {
  return new StreamClient({ link, machineSignKey: machine.signPublic, epochs: machine.epochs, fetchPage: async () => new Uint8Array(), retryDelay: () => 0 });
}

const subsFor = (link: FakeStreamLink, stream: Uint8Array) => link.subs().filter((s) => hex(s.stream) === hex(stream));

/** The hub says `stream` is not there (yet). */
async function absent(link: FakeStreamLink, stream: Uint8Array) {
  await until(() => subsFor(link, stream).length > 0);
  const sub = subsFor(link, stream).at(-1)!;
  link.control({ t: "stream_synced", ch: sub.ch, stream: hex(stream), next_seq: 0, exists: false });
}

/** The hub's catch-up for `writer` on its latest `sub`, from where that sub stands. */
async function present(link: FakeStreamLink, writer: StreamWriter, timeMs?: number) {
  await until(() => subsFor(link, writer.stream).length > 0);
  const sub = subsFor(link, writer.stream).at(-1)!;
  const records = writer.records.slice(sub.fromSeq);
  if (records.length) link.deliver({ type: "recs", ch: sub.ch, stream: writer.stream, records });
  link.deliver({ type: "head", ch: sub.ch, head: await writer.head(timeMs) });
  link.control({ t: "stream_synced", ch: sub.ch, stream: hex(writer.stream), next_seq: writer.seq, exists: true });
}

test("the page says it reads streams named per key epoch, and a session's name follows its entry's se", async () => {
  assert.ok(CLIENT_INFO.split(" ").includes(STREAMS_FEATURE));
  assert.equal(STREAMS_FEATURE, "streams/2");
  const machine = await makeMachine();
  const mk1 = await rotate(machine, 1);
  assert.equal(namingKey(machine.epochs), machine.mk, "the first epoch");
  assert.equal(sessionNamingKey(machine.epochs, undefined), machine.mk, "an entry without se: the first epoch");
  assert.equal(sessionNamingKey(machine.epochs, 1), mk1);
  assert.equal(sessionNamingKey(machine.epochs, 7), null, "an epoch this device does not hold");
  assert.equal(sessionNamingKey(machine.epochs, "1"), null);
  // The old key does not name what the new one does.
  assert.notEqual(hex(await streamId(machine.mk, "claude", "s")), hex(await streamId(mk1, "claude", "s")));
  assert.notEqual(hex(await indexStream(machine.mk)), hex(await indexStream(mk1)));
  const named = await namesOf(machine.epochs);
  assert.deepEqual(
    named.index.map((n) => n.epoch),
    [1, 0],
    "newest first",
  );
});

test("a machine that has not moved: no index under the newest epoch, so the older one is read; the moment it moves, the newer name wins", async () => {
  const machine = await makeMachine();
  await rotate(machine, 1);
  const kv = new FakeKv();
  const link = new FakeStreamLink();
  const mirror = new MachineMirror({ account: "a-1", machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client: client(machine, link) }), transact: kv.transact, saveDelayMs: { small: 1, session: 1 }, sessionWaitMs: 500 });
  await mirror.start();
  const old = await StreamWriter.openAt(machine, await indexStream(machine.mk), FMT_INDEX_V1, 0);
  await old.append({ upserts: [row("a"), row("b", { se: 1 })], removed: [], asOf: 1 });
  const moved = await StreamWriter.openAt(machine, await indexStream(machine.epochs.get(1)!), FMT_INDEX_V1, 1);
  // The newest name is asked first; the hub has nothing there yet.
  await until(() => subsFor(link, moved.stream).length === 1);
  assert.equal(subsFor(link, old.stream).length, 0, "the newest epoch's index is tried first, the older not yet");
  await absent(link, moved.stream);
  await present(link, old, 111_000);
  await until(() => mirror.rows()?.length === 2);
  assert.equal(mirror.indexMissing, false);

  // Sessions: `b` is named under epoch 1, `a` (no se) under the first.
  const b = await StreamWriter.openAt(machine, await streamId(machine.epochs.get(1)!, "claude", "b"), FMT_FEED_V1, 1);
  await b.append({ fromIndex: 0, items: [{ kind: "user", text: "b under epoch 1" }], endIndex: 1 });
  const askedB = mirror.session("claude", "b");
  await present(link, b);
  assert.deepEqual((await askedB)?.state.items, [{ kind: "user", text: "b under epoch 1" }]);
  const a0 = await StreamWriter.openAt(machine, await streamId(machine.mk, "claude", "a"), FMT_FEED_V1, 0);
  await a0.append({ fromIndex: 0, items: [{ kind: "user", text: "a under epoch 0" }], endIndex: 1 });
  mirror.touch("claude", "a");
  const askedA = mirror.session("claude", "a");
  await present(link, a0);
  assert.deepEqual((await askedA)?.state.items, [{ kind: "user", text: "a under epoch 0" }]);

  // The machine moves (a rotation reached it): its index under epoch 1, `a` moved too.
  const a1 = await StreamWriter.openAt(machine, await streamId(machine.epochs.get(1)!, "claude", "a"), FMT_FEED_V1, 1);
  await a1.append({ fromIndex: 0, items: [{ kind: "user", text: "a under epoch 1" }], endIndex: 1 });
  await moved.append({ upserts: [row("a", { se: 1 }), row("b", { se: 1 }), row("c", { se: 1 })], removed: [], asOf: 2 });
  await present(link, moved, 222_000);
  await until(() => mirror.rows()?.length === 3);
  assert.equal(mirror.freshestMs, 222_000, "the new name's head");
  const unsubs = link.controls.filter((c) => c.t === "stream_unsub");
  assert.ok(unsubs.length >= 1, "the old index is let go");
  // `a` is followed under its new name now.
  await until(() => subsFor(link, a1.stream).length > 0);
  await present(link, a1);
  await until(() => mirror.sessionNow("claude", "a")?.state.items[0]?.text === "a under epoch 1");
  // And the copy saved for the index is the new name's.
  await until(() => kv.data.has(streamRecordKey("a-1", "m-1", hex(moved.stream))));
  mirror.close();

  // A later load starts from that copy, and the newer name it holds is still the newest.
  const again = new MachineMirror({ account: "a-1", machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client: client(machine, new FakeStreamLink()) }), transact: kv.transact });
  await again.start();
  assert.deepEqual(
    again.rows()?.map((r) => r.id).sort(),
    ["a", "b", "c"],
  );
  again.close();
});

test("a copy saved under an older name is shown at once, and a newer name is followed beside it", async () => {
  const machine = await makeMachine();
  const mk1 = await rotate(machine, 1);
  const link = new FakeStreamLink();
  const c = client(machine, link);
  const old = await StreamWriter.openAt(machine, await indexStream(machine.mk), FMT_INDEX_V1, 0);
  await old.append({ upserts: [row("a")], removed: [], asOf: 1 });
  const newer = await StreamWriter.openAt(machine, await indexStream(mk1), FMT_INDEX_V1, 1);
  const named = (await namesOf(machine.epochs)).index;
  const switched: number[] = [];
  const shown: IndexState[] = [];
  let synced: boolean | null = null;
  const follow = new NewestStream<IndexState>(
    c,
    indexFold,
    named,
    {
      onSwitch: (to) => switched.push(to.epoch),
      onState: (_at, state) => shown.push(state),
      onSynced: (exists) => (synced = exists),
    },
    { at: 1, saved: null },
  );
  assert.equal(follow.current?.epoch, 0);
  await until(() => subsFor(link, newer.stream).length === 1);
  await present(link, old);
  await absent(link, newer.stream);
  await until(() => synced === true && shown.length === 1);
  assert.deepEqual(switched, []);
  await newer.append({ upserts: [row("a", { se: 1 }), row("n", { se: 1 })], removed: [], asOf: 2 });
  const sub = subsFor(link, newer.stream).at(-1)!;
  link.deliver({ type: "recs", ch: sub.ch, stream: newer.stream, records: newer.records });
  link.deliver({ type: "head", ch: sub.ch, head: await newer.head() });
  await until(() => switched.length === 1);
  assert.deepEqual(switched, [1]);
  assert.equal(follow.current?.epoch, 1);
  assert.deepEqual(Object.keys(shown.at(-1)!.rows).sort(), ["claude/a", "claude/n"]);
  // More epochs held later: their names are followed too.
  const index2 = await indexStream(await rotate(machine, 2));
  follow.setCandidates((await namesOf(machine.epochs)).index);
  await until(() => subsFor(link, index2).length > 0);
  assert.equal(follow.current?.epoch, 1, "still shown until the new name has something");
  follow.close();
  await flush(1);
});

test("nothing under any epoch: the copy is missing once every name has said so", async () => {
  const machine = await makeMachine();
  await rotate(machine, 1);
  const link = new FakeStreamLink();
  const mirror = new MachineMirror({ account: "a-1", machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client: client(machine, link) }), transact: new FakeKv().transact });
  await mirror.start();
  const named = (await namesOf(machine.epochs)).index;
  await absent(link, named[0]!.stream);
  await absent(link, named[1]!.stream);
  await until(() => mirror.indexMissing);
  mirror.close();
});

test("the status reader finds the status the way the mirror finds the index", async () => {
  const machine = await makeMachine();
  const mk1 = await rotate(machine, 1);
  const link = new FakeStreamLink();
  const reader = new MachineStatusReader({ account: "a-1", machine: "m-1", source: HubCopySource.over({ mk: machine.mk, client: client(machine, link) }), transact: new FakeKv().transact, saveDelayMs: 1 });
  await reader.start();
  const old = await StreamWriter.openAt(machine, await statusStream(machine.mk), FMT_STATUS_V1, 0);
  await old.append({ asOf: 1, displayName: "old name", settings: null, accounts: null, quota: null, cli: null });
  await absent(link, await statusStream(mk1));
  await present(link, old);
  await until(() => reader.state?.displayName === "old name");
  const moved = await StreamWriter.openAt(machine, await statusStream(mk1), FMT_STATUS_V1, 1);
  await moved.append({ asOf: 2, displayName: "moved", settings: null, accounts: null, quota: null, cli: null });
  await present(link, moved);
  await until(() => reader.state?.displayName === "moved");
  reader.close();
});
