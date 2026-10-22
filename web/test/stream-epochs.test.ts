// A machine's key rotated while the page is open (`StreamClient.addEpochs`):
// its streams keep their names (from the first epoch), the machine seals new
// records under the new epoch, and the page reads them as soon as it holds
// the new key — taken into a live reader in place, and a stream that stopped
// for want of it started again at once rather than after its backoff.
import assert from "node:assert/strict";
import test from "node:test";
import {
  bytes,
  type Bytes,
  encodeSignedHead,
  FMT_INDEX_V1,
  importMachineKey,
  indexStream,
  recordLink,
  type SealedRecord,
  sealRecord,
  signStreamHead,
  streamKey,
  utf8,
} from "../src/lib/e2e/index.js";
import { indexFold, type IndexState, StreamClient } from "../src/lib/hub/streams.js";
import { FakeStreamLink, flush, makeMachine, until } from "./stream-fixtures.js";

const row = (id: string) => ({ source: "claude", id, title: id, updatedAt: "2026-10-15T00:00:00.000Z" });

/** A writer that can switch epochs mid-stream, as the agent does after a rotation. */
async function rotatingWriter() {
  const machine = await makeMachine();
  const mk1 = await importMachineKey(crypto.getRandomValues(bytes(32)));
  const stream = await indexStream(machine.mk);
  const keys = new Map([
    [0, await streamKey(machine.mk, stream)],
    [1, await streamKey(mk1, stream)],
  ]);
  let seq = 0;
  let link: Bytes = bytes(32);
  let epoch = 0;
  const records: SealedRecord[] = [];
  return {
    machine,
    mk1,
    stream,
    records,
    rotate: () => void (epoch = 1),
    async append(body: unknown) {
      const sealed = await sealRecord(keys.get(epoch)!, stream, seq, epoch, FMT_INDEX_V1, link, utf8(JSON.stringify(body)));
      link = await recordLink(stream, link, sealed);
      seq += 1;
      records.push(sealed);
    },
    async head(timeMs: number) {
      return encodeSignedHead(await signStreamHead({ stream, nextSeq: seq, epoch, link, timeMs }, machine.sign));
    },
  };
}

function follow(link: FakeStreamLink, w: Awaited<ReturnType<typeof rotatingWriter>>, retryMs: number, onMissingKey?: () => void) {
  const states: IndexState[] = [];
  const errors: unknown[] = [];
  const client = new StreamClient({
    link,
    machineSignKey: w.machine.signPublic,
    epochs: w.machine.epochs,
    fetchPage: async () => {
      throw new Error("no pages here");
    },
    retryDelay: (attempt) => (attempt === 0 ? 0 : retryMs),
    onMissingKey,
  });
  client.subscribe(w.stream, indexFold, { onState: (s) => states.push(s), onError: (e) => errors.push(e) });
  return { client, states, errors };
}

test("a new epoch added before its records arrive is used in place", async () => {
  const link = new FakeStreamLink();
  const w = await rotatingWriter();
  await w.append({ upserts: [row("a")], removed: [] });
  const { client, states, errors } = follow(link, w, 60_000);
  await until(() => link.subs().length === 1);
  const ch = link.lastSub().ch;
  link.deliver({ type: "recs", ch, stream: w.stream, records: [w.records[0]!] });
  link.deliver({ type: "head", ch, head: await w.head(1) });
  await until(() => states.length === 1);

  assert.equal(await client.addEpochs(new Map([[0, w.machine.mk], [1, w.mk1]])), 1, "only epoch 1 is new");
  assert.equal(await client.addEpochs(new Map([[1, w.mk1]])), 0);
  w.rotate();
  await w.append({ upserts: [row("b")], removed: [] });
  link.deliver({ type: "recs", ch, stream: w.stream, records: [w.records[1]!] });
  link.deliver({ type: "head", ch, head: await w.head(2) });
  await until(() => states.length === 2);
  assert.deepEqual(Object.keys(states[1]!.rows).sort(), ["claude/a", "claude/b"]);
  assert.equal(errors.length, 0);
  assert.equal(link.subs().length, 1, "no restart needed");
});

test("a stream stalled on a record it had no key for starts again as soon as the key arrives", async () => {
  const link = new FakeStreamLink();
  const w = await rotatingWriter();
  await w.append({ upserts: [row("a")], removed: [] });
  w.rotate();
  await w.append({ upserts: [row("b")], removed: [] });
  // The first restart is immediate, the next would wait a minute.
  const { client, states, errors } = follow(link, w, 60_000);
  for (let round = 1; round <= 2; round++) {
    await until(() => link.subs().length === round);
    link.deliver({ type: "recs", ch: link.lastSub().ch, stream: w.stream, records: w.records });
    await until(() => errors.length === round);
  }
  await flush(20);
  assert.equal(link.subs().length, 2, "backing off: no third subscription yet");
  assert.equal(states.length, 0);

  await client.addEpochs(new Map([[1, w.mk1]]));
  await until(() => link.subs().length === 3);
  assert.equal(link.lastSub().fromSeq, 0);
  link.deliver({ type: "recs", ch: link.lastSub().ch, stream: w.stream, records: w.records });
  link.deliver({ type: "head", ch: link.lastSub().ch, head: await w.head(3) });
  await until(() => states.length === 1);
  assert.deepEqual(Object.keys(states[0]!.rows).sort(), ["claude/a", "claude/b"]);
  client.close();
});

test("a record under an epoch not held makes the client look for keys (at most every 10 s), and it reads once they come", async () => {
  const link = new FakeStreamLink();
  const w = await rotatingWriter();
  await w.append({ upserts: [row("a")], removed: [] });
  w.rotate();
  await w.append({ upserts: [row("b")], removed: [] });
  let asked = 0;
  let release: () => void = () => undefined;
  const refreshed = new Promise<void>((resolve) => (release = resolve));
  // The page's answer: refresh the keyring, then hand the new epoch over (here, once asked twice).
  const holder: { client?: StreamClient } = {};
  const { client, states } = follow(link, w, 60_000, () => {
    asked++;
    release();
  });
  holder.client = client;
  for (let round = 1; round <= 2; round++) {
    await until(() => link.subs().length === round);
    link.deliver({ type: "recs", ch: link.lastSub().ch, stream: w.stream, records: w.records });
    await refreshed;
  }
  await flush(20);
  assert.equal(asked, 1, "two stalls, one request for keys within ten seconds");
  await holder.client.addEpochs(new Map([[1, w.mk1]]));
  await until(() => link.subs().length === 3);
  link.deliver({ type: "recs", ch: link.lastSub().ch, stream: w.stream, records: w.records });
  link.deliver({ type: "head", ch: link.lastSub().ch, head: await w.head(4) });
  await until(() => states.length === 1);
  assert.deepEqual(Object.keys(states[0]!.rows).sort(), ["claude/a", "claude/b"]);
  client.close();
});
