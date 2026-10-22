// What the agent does to a stream, played in-process for the tests: seal
// records and chain them, sign heads, cut snapshot pages and sign manifests —
// the same calls `scripts/e2e-vectors.ts` makes, so the reader under test is
// fed exactly what the Rust writer produces. And a hub link that the test
// drives by hand.
import {
  type Bytes,
  bytes,
  encodeManifest,
  encodePage,
  encodeSignedHead,
  type Frame,
  generateDeviceKeys,
  hex,
  importMachineKey,
  type MachineKey,
  pageHash,
  recordLink,
  type SealedRecord,
  sealPage,
  sealRecord,
  signManifest,
  signStreamHead,
  streamKey,
  utf8,
} from "../src/lib/e2e/index.js";
import type { LinkState } from "../src/lib/hub/link.js";
import {
  copyAt,
  defaultMirrorSeal,
  type KvStore,
  type MirrorRecord,
  type MirrorSeal,
  metaKey,
  openCopy,
  sealCopy,
  type StreamKind,
  type Transact,
} from "../src/lib/hub/mirror.js";
import type { StreamLink } from "../src/lib/hub/streams.js";

export const flush = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

/** Wait until `done()` holds (polling), or fail after `ms` — a guard against hanging, not a claim about how fast (WebCrypto takes as long as a loaded machine makes it). */
export async function until(done: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out waiting");
    await flush(1);
  }
}

/** A machine: its key `MK` (raw and imported) and its Ed25519 signing pair. */
export interface Machine {
  mkRaw: Bytes;
  mk: MachineKey;
  epochs: Map<number, MachineKey>;
  sign: CryptoKey;
  signPublic: Bytes;
}

/** A second key epoch for `machine` (a rotation): its `MK`, added to `machine.epochs`. */
export async function rotate(machine: Machine, epoch: number): Promise<MachineKey> {
  const mk = await importMachineKey(crypto.getRandomValues(bytes(32)));
  machine.epochs.set(epoch, mk);
  return mk;
}

export async function makeMachine(): Promise<Machine> {
  const mkRaw = crypto.getRandomValues(bytes(32));
  const mk = await importMachineKey(mkRaw);
  const keys = await generateDeviceKeys();
  return { mkRaw, mk, epochs: new Map([[0, mk]]), sign: keys.sign.privateKey, signPublic: keys.signPublic };
}

/** One stream as its single writer sees it. */
export class StreamWriter {
  seq = 0;
  link: Bytes = bytes(32);
  readonly records: SealedRecord[] = [];
  private constructor(
    readonly machine: Machine,
    readonly stream: Bytes,
    readonly key: CryptoKey,
    readonly fmt: number,
    readonly epoch = 0,
  ) {}

  static async open(machine: Machine, stream: Bytes, fmt: number): Promise<StreamWriter> {
    return new StreamWriter(machine, stream, await streamKey(machine.mk, stream), fmt);
  }

  /** A writer sealing under key epoch `epoch` (its `MK` from `machine.epochs`). */
  static async openAt(machine: Machine, stream: Bytes, fmt: number, epoch: number): Promise<StreamWriter> {
    const mk = machine.epochs.get(epoch);
    if (!mk) throw new Error(`no key for epoch ${epoch}`);
    return new StreamWriter(machine, stream, await streamKey(mk, stream), fmt, epoch);
  }

  async append(body: unknown): Promise<SealedRecord> {
    const sealed = await sealRecord(this.key, this.stream, this.seq, this.epoch, this.fmt, this.link, utf8(JSON.stringify(body)));
    this.link = await recordLink(this.stream, this.link, sealed);
    this.seq += 1;
    this.records.push(sealed);
    return sealed;
  }

  /** The encoded signed head at the writer's position (or a given one). */
  async head(timeMs = Date.now(), at: { nextSeq: number; link: Bytes } = { nextSeq: this.seq, link: this.link }, signer: CryptoKey = this.machine.sign): Promise<Bytes> {
    return encodeSignedHead(await signStreamHead({ stream: this.stream, nextSeq: at.nextSeq, epoch: this.epoch, link: at.link, timeMs }, signer));
  }

  /** A manifest at the writer's position whose pages hold `bodies`, and the pages by hash. */
  async manifest(bodies: unknown[], timeMs = Date.now(), signer: CryptoKey = this.machine.sign): Promise<{ manifest: Bytes; pages: Map<string, Bytes>; upto: number }> {
    const pages = new Map<string, Bytes>();
    const hashes: Bytes[] = [];
    for (const body of bodies) {
      const wire = encodePage(await sealPage(this.key, this.stream, this.epoch, this.fmt, utf8(JSON.stringify(body))));
      const hash = await pageHash(wire);
      hashes.push(hash);
      pages.set(hex(hash), wire);
    }
    const head = await signStreamHead({ stream: this.stream, nextSeq: this.seq, epoch: this.epoch, link: this.link, timeMs }, signer);
    return { manifest: encodeManifest(await signManifest(head, hashes, signer)), pages, upto: this.seq };
  }
}

/** A hub link the test drives: frames it was sent, and frames it delivers. */
export class FakeStreamLink implements StreamLink {
  state: LinkState = "open";
  readonly sent: Frame[] = [];
  readonly controls: Record<string, unknown>[] = [];
  private nextCh = 1;
  readonly routes = new Map<number, (frame: Frame) => void>();
  private readonly stateListeners = new Set<(s: LinkState) => void>();
  private readonly controlListeners = new Set<(m: Record<string, unknown>) => void>();

  onState(fn: (s: LinkState) => void): () => void {
    this.stateListeners.add(fn);
    return () => this.stateListeners.delete(fn);
  }
  onControl(fn: (m: Record<string, unknown>) => void): () => void {
    this.controlListeners.add(fn);
    return () => this.controlListeners.delete(fn);
  }
  reserve(route: (frame: Frame) => void): number {
    const ch = this.nextCh++;
    this.routes.set(ch, route);
    return ch;
  }
  release(ch: number): void {
    this.routes.delete(ch);
  }
  send(frame: Frame): boolean {
    if (this.state !== "open") return false;
    this.sent.push(frame);
    return true;
  }
  sendControl(message: Record<string, unknown>): boolean {
    if (this.state !== "open") return false;
    this.controls.push(message);
    return true;
  }

  /** The `sub` frames sent, in order. */
  subs(): Extract<Frame, { type: "sub" }>[] {
    return this.sent.filter((f): f is Extract<Frame, { type: "sub" }> => f.type === "sub");
  }
  lastSub(): Extract<Frame, { type: "sub" }> {
    const s = this.subs().at(-1);
    if (!s) throw new Error("nothing subscribed");
    return s;
  }
  deliver(frame: Frame): void {
    this.routes.get((frame as { ch: number }).ch)?.(frame);
  }
  control(message: Record<string, unknown>): void {
    for (const fn of [...this.controlListeners]) fn(message);
  }
  /** The connection drops: every route hears a close, as `HubLink` does it. */
  drop(): void {
    this.state = "closed";
    const routes = [...this.routes.entries()];
    this.routes.clear();
    for (const [ch, route] of routes) route({ type: "close", ch, code: 4410, reason: "lost" });
    for (const fn of [...this.stateListeners]) fn("closed");
  }
  reopen(): void {
    this.state = "open";
    for (const fn of [...this.stateListeners]) fn("open");
  }
}

/** Play the hub's catch-up for `writer` on the latest `sub`: records from its `fromSeq`, a head, `stream_synced`. */
export async function catchUp(link: FakeStreamLink, writer: StreamWriter, opts: { manifest?: { manifest: Bytes; upto: number }; timeMs?: number } = {}): Promise<number> {
  const sub = link.lastSub();
  let from = sub.fromSeq;
  if (opts.manifest && from < opts.manifest.upto) {
    link.deliver({ type: "checkpoint", ch: sub.ch, stream: writer.stream, uptoSeq: opts.manifest.upto, manifest: opts.manifest.manifest });
    from = opts.manifest.upto;
  }
  const records = writer.records.slice(from);
  if (records.length) link.deliver({ type: "recs", ch: sub.ch, stream: writer.stream, records });
  link.deliver({ type: "head", ch: sub.ch, head: await writer.head(opts.timeMs) });
  link.control({ t: "stream_synced", ch: sub.ch, stream: hex(writer.stream), next_seq: writer.seq, exists: true });
  return sub.ch;
}

/** An object store in memory with IndexedDB's transaction shape: staged, then committed whole. */
export class FakeKv {
  data = new Map<string, unknown>();
  txs: { mode: string; puts: string[]; deletes: string[] }[] = [];
  /** Every `getAllKeys` asked, by its prefix (`null`: the whole store). */
  keyReads: (string | null)[] = [];

  transact: Transact = <T,>(mode: "readonly" | "readwrite", act: (store: KvStore, done: (value: T) => void) => void) =>
    new Promise<T | undefined>((resolve) => {
      const staged = new Map(this.data);
      const tx = { mode, puts: [] as string[], deletes: [] as string[] };
      this.txs.push(tx);
      let pending = 0;
      let settled = false;
      let result: T | undefined;
      const finish = () => {
        if (settled || pending > 0) return;
        settled = true;
        if (mode === "readwrite") this.data = staged;
        resolve(result);
      };
      const request = <V,>(read: () => V) => {
        const r: { result: V; onsuccess: (() => void) | null } = { result: undefined as V, onsuccess: null };
        pending++;
        queueMicrotask(() => {
          r.result = read();
          pending--;
          r.onsuccess?.();
          queueMicrotask(finish);
        });
        return r;
      };
      const store: KvStore = {
        get: (key) => request(() => structuredClone(staged.get(key))),
        put: (value, key) => {
          if (mode !== "readwrite") throw new Error("read-only transaction");
          tx.puts.push(key);
          staged.set(key, structuredClone(value));
        },
        delete: (key) => {
          tx.deletes.push(key);
          staged.delete(key);
        },
        getAllKeys: (prefix?: string) => {
          this.keyReads.push(prefix ?? null);
          return request(() => [...staged.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)));
        },
      };
      act(store, (value) => {
        result = value;
      });
      queueMicrotask(finish);
    });
}

/** A copy as the device holds it, opened (`null`: none, or one that does not open). */
export async function readCopy<S>(kv: FakeKv, account: string, machine: string, streamHex: string, kind: StreamKind, seal: MirrorSeal = defaultMirrorSeal()): Promise<MirrorRecord<S> | null> {
  const at = copyAt(account, machine, streamHex);
  const opened = await openCopy<S>(seal, kv.data.get(at.key), at, kind);
  return "record" in opened ? opened.record : null;
}

/** Put a copy on the device, sealed as the mirror seals it. */
export async function putCopy(kv: FakeKv, account: string, machine: string, streamHex: string, record: MirrorRecord<unknown>, seal: MirrorSeal = defaultMirrorSeal()): Promise<string> {
  const at = copyAt(account, machine, streamHex);
  kv.data.set(at.key, await sealCopy(seal, at, record));
  return at.key;
}

/** The sessions on a machine's opened list as the device holds it, opened, in order. */
export async function readOpened(kv: FakeKv, account: string, machine: string, seal: MirrorSeal = defaultMirrorSeal()): Promise<{ source: string; id: string; hex: string }[]> {
  const meta = kv.data.get(metaKey(account, machine)) as { opened?: { hex: string; iv: Uint8Array; ct: Uint8Array }[] } | undefined;
  const out: { source: string; id: string; hex: string }[] = [];
  for (const entry of meta?.opened ?? []) {
    const opened = await seal.open({ account, machine, key: `${metaKey(account, machine)}#${entry.hex}` }, entry);
    const v = opened?.value as { source: string; id: string } | undefined;
    if (v) out.push({ source: v.source, id: v.id, hex: entry.hex });
  }
  return out;
}
