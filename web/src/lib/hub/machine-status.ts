/*
 * One machine's status stream, and nothing else: what the machine list needs
 * to show each machine by its name (`statusFold`'s `displayName`, sealed under
 * the machine's key — the hub only ever knows the id).
 *
 * The full offline copy (`mirror.ts`) follows a machine's index, status and
 * sessions; the list has every machine of the account on it and wants only
 * this. It is kept exactly as the mirror keeps the status — the same
 * IndexedDB record under the same key, the decrypted state and the signed
 * head it stands at written together — so the list draws names at once from
 * the device, either side reads what the other saved, and the head is
 * checked against the machine's signature before anything read back is
 * trusted. Sealed at rest under the same device-local key as the mirror's
 * copies (`MirrorSeal`); a plaintext record from before that, or one that
 * does not open, is deleted.
 *
 * Read through a `CopySource` as the mirror reads it (`copy-source.ts`):
 * named as the mirror finds it (relay-and-plans §5), under the newest key
 * epoch held, then older ones, and on to a newer name the moment it has
 * something.
 */
import type { CopyFollow, CopyMark, CopySource } from "./copy-source";
import { copyAt, defaultMirrorSeal, deviceTransact, dropCopy, type MirrorRecord, type MirrorSeal, openCopy, sealCopy, sweepCopies, type Transact } from "./mirror";
import type { StatusState } from "./streams";

export interface StatusReaderOptions {
  account: string;
  machine: string;
  /** Where the status comes from (the hub's streams, opened with the machine's keys); `null`, or a source with no keys, when this device holds none. */
  source: CopySource | null;
  transact?: Transact;
  /** How the copy is sealed at rest; default `defaultMirrorSeal()` (pass `mirrorSeal(store)` with the page's key store). */
  seal?: MirrorSeal;
  now?: () => number;
  /** How far a save trails the state it saves. */
  saveDelayMs?: number;
}

export class MachineStatusReader {
  /** The status as last signed for; `null` until there is one. */
  state: StatusState | null = null;
  /** Whether the device copy has been read. */
  loaded = false;
  private at: CopyMark | null = null;
  private freshestMs: number | null = null;
  /** Where the copy is kept (the source's name for it: the hub's stream id, hex). */
  private place: string | null = null;
  private sub: CopyFollow | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private readonly listeners = new Set<() => void>();
  private readonly transact: Transact;
  private readonly seal: MirrorSeal;
  /** The save in flight: the next waits for it (sealing is asynchronous). */
  private saving: Promise<void> = Promise.resolve();

  constructor(private readonly opts: StatusReaderOptions) {
    this.transact = opts.transact ?? deviceTransact;
    this.seal = opts.seal ?? defaultMirrorSeal();
  }

  get machine(): string {
    return this.opts.machine;
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch {
        // one listener failing must not starve the others
      }
    }
  }

  /** Read the device copy (shown at once), then follow the stream under the newest name it has. */
  async start(): Promise<void> {
    const source = this.opts.source;
    try {
      if (!source) return;
      await source.ready();
      if (this.closed || !source.keyed) return;
      const places = await source.places({ kind: "status" });
      if (this.closed || !places.length) return;
      const { account, machine } = this.opts;
      const records = await this.transact<unknown[]>(
        "readonly",
        (store, done) => {
          const got: unknown[] = [];
          let left = places.length;
          places.forEach((place, i) => {
            const req = store.get(copyAt(account, machine, place).key);
            req.onsuccess = () => {
              got[i] = req.result;
              if (--left === 0) done(got);
            };
          });
        },
        3000,
      );
      // The newest name with a copy here that still checks out.
      let at = 0;
      let saved: { at: CopyMark; state: StatusState } | null = null;
      for (let i = 0; i < places.length && !saved; i++) {
        if (records?.[i] === undefined) continue;
        saved = await this.savedOf(source, records[i], places[i]!);
        if (saved) at = i;
      }
      if (this.closed) return;
      this.place = places[at]!;
      if (saved) {
        this.state = saved.state;
        this.at = saved.at;
        this.freshestMs = saved.at.timeMs;
      }
      this.loaded = true;
      this.emit();
      this.sub = source.follow<StatusState>(
        { kind: "status" },
        places,
        { at, from: saved },
        {
          onMoved: (place) => {
            this.place = place;
          },
          onState: (change) => {
            this.state = change.state;
            this.at = change.at;
            this.freshestMs = change.freshestMs;
            this.scheduleSave();
            this.emit();
          },
        },
      );
      // Plaintext from before the copies were sealed, and other accounts' copies, are not kept.
      void sweepCopies(this.transact, account);
    } finally {
      if (!this.loaded) {
        this.loaded = true;
        if (!this.closed) this.emit();
      }
    }
  }

  /** A stored record as a starting point, if it opens, is ours and its mark still holds (one that does not open is deleted). */
  private async savedOf(source: CopySource, record: unknown, place: string): Promise<{ at: CopyMark; state: StatusState } | null> {
    const at = copyAt(this.opts.account, this.opts.machine, place);
    const opened = await openCopy<StatusState>(this.seal, record, at, "status");
    if (!("record" in opened)) {
      if (opened.drop) void dropCopy(this.transact, at.key, record);
      return null;
    }
    const mark = await source.resume(place, opened.record.head);
    return mark ? { at: mark, state: opened.record.state } : null;
  }

  private scheduleSave(): void {
    if (this.closed || this.saveTimer !== undefined) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      void this.save();
    }, this.opts.saveDelayMs ?? 1000);
  }

  /** Save now if a save is pending (the page is going away). */
  flush(): Promise<void> {
    if (this.saveTimer === undefined) return Promise.resolve();
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    return this.save();
  }

  /** The state and the signed head it stands at, together and sealed, as the mirror writes the status. */
  private save(): Promise<void> {
    if (!this.state || !this.at || !this.place) return Promise.resolve();
    const { account, machine } = this.opts;
    const record: MirrorRecord<StatusState> = {
      kind: "status",
      head: this.at.mark,
      state: this.state,
      freshestMs: this.freshestMs,
      savedAt: (this.opts.now ?? Date.now)(),
    };
    const at = copyAt(account, machine, this.place);
    const next = this.saving.then(async () => {
      let stored;
      try {
        stored = await sealCopy(this.seal, at, record);
      } catch (error) {
        console.warn("machine status: the copy could not be sealed, so it was not saved:", error);
        return;
      }
      await this.transact<void>("readwrite", (store) => {
        store.put(stored, at.key);
      }, 2000);
    });
    this.saving = next.catch(() => undefined);
    return next;
  }

  /** Stop following (a save still pending is dropped; {@link flush} first to keep it). */
  close(): void {
    this.closed = true;
    clearTimeout(this.saveTimer);
    this.saveTimer = undefined;
    this.sub?.close();
    this.sub = null;
    this.listeners.clear();
  }
}
