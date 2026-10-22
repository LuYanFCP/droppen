/*
 * Asking the server what became of this tab's `unknown` sends
 * (`GET …/receipts?ids=`), without ever getting stuck asking.
 *
 * A check is one request. It used to have no deadline, and a check whose
 * answer was lost (a channel that died under it, a hub connection gone dead
 * without a word) stayed "in flight" for as long as the page lived, so every
 * later trigger — coming back online or into view, the fifteen-second
 * re-check, the user's own "check" — found one in flight and did nothing.
 *
 * So each check gives up after `CHECK_TIMEOUT_MS`, whether or not the request
 * honours its abort signal, and while anything is still unknown the next one
 * follows on its own after a backoff (1 s doubling to 30 s): a failure or a
 * timeout, or an answer that settled nothing yet (the first attempt may still
 * be arriving). A new connection to the machine (`reconnected`) asks at once
 * and starts the backoff over, abandoning a check still waiting on the old
 * one — that is the moment a send lost with its channel can be settled.
 *
 * What the answers mean is `send-receipts.ts`' (`resolveUnknowns`); nothing
 * here sends a message again.
 */
import type { ReceiptLookup } from "./send-receipts";

/** How long one check may wait for its answer. */
export const CHECK_TIMEOUT_MS = 10_000;
/** The wait before asking again while anything is unknown, doubling… */
export const CHECK_RETRY_FIRST_MS = 1_000;
/** …up to this. */
export const CHECK_RETRY_MAX_MS = 30_000;

export interface ReceiptCheckTiming {
  timeoutMs: number;
  retryFirstMs: number;
  retryMaxMs: number;
}

export interface ReceiptCheckDeps {
  /** The ids still unknown, oldest first, read at each check. */
  ids(): string[];
  /** Ask about `ids`. Resolves with the answer (`null`: the server said nothing usable); rejects when no answer came. */
  ask(ids: string[], signal: AbortSignal): Promise<ReceiptLookup | null>;
  apply(lookup: ReceiptLookup): void;
  onChecking?(checking: boolean): void;
  timing?: Partial<ReceiptCheckTiming>;
}

class TimedOut extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
    this.name = "TimeoutError";
  }
}

export class ReceiptChecker {
  private readonly timing: ReceiptCheckTiming;
  private inFlight: AbortController | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private backoff: number;

  constructor(private readonly deps: ReceiptCheckDeps) {
    this.timing = { timeoutMs: CHECK_TIMEOUT_MS, retryFirstMs: CHECK_RETRY_FIRST_MS, retryMaxMs: CHECK_RETRY_MAX_MS, ...deps.timing };
    this.backoff = this.timing.retryFirstMs;
  }

  /** Whether a check is waiting for its answer. */
  get checking(): boolean {
    return this.inFlight !== null;
  }

  /** Ask now, unless a check is already waiting or nothing is unknown. A retry waiting its turn is replaced by this. */
  check(): void {
    if (this.inFlight) return;
    const ids = this.deps.ids();
    this.cancelRetry();
    if (ids.length === 0) {
      this.backoff = this.timing.retryFirstMs;
      return;
    }
    const controller = new AbortController();
    this.inFlight = controller;
    this.deps.onChecking?.(true);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new TimedOut(this.timing.timeoutMs);
        controller.abort(error);
        reject(error);
      }, this.timing.timeoutMs);
    });
    const asked = Promise.resolve().then(() => this.deps.ask(ids, controller.signal));
    void Promise.race([asked, deadline])
      .then(
        (lookup) => {
          if (this.inFlight !== controller) return;
          if (lookup) this.deps.apply(lookup);
        },
        () => undefined,
      )
      .finally(() => {
        if (timer !== null) clearTimeout(timer);
        // Abandoned (`reconnected`, `stop`): whoever abandoned it decides what comes next.
        if (this.inFlight !== controller) return;
        this.inFlight = null;
        this.deps.onChecking?.(false);
        this.next();
      });
  }

  /** A new connection to the machine: ask at once, from the start of the backoff, rather than wait on a check sent over the old one. */
  reconnected(): void {
    this.abandon();
    this.backoff = this.timing.retryFirstMs;
    this.check();
  }

  /** Stop asking (the screen went away); a later `check` starts again. */
  stop(): void {
    this.abandon();
    this.cancelRetry();
  }

  /** After a check: while anything is still unknown, ask again after the backoff, which doubles. */
  private next(): void {
    if (this.deps.ids().length === 0) {
      this.backoff = this.timing.retryFirstMs;
      return;
    }
    const wait = this.backoff;
    this.backoff = Math.min(this.backoff * 2, this.timing.retryMaxMs);
    this.cancelRetry();
    this.retry = setTimeout(() => {
      this.retry = null;
      this.check();
    }, wait);
  }

  private abandon(): void {
    const controller = this.inFlight;
    if (!controller) return;
    this.inFlight = null;
    controller.abort(new DOMException("abandoned", "AbortError"));
    this.deps.onChecking?.(false);
  }

  private cancelRetry(): void {
    if (this.retry !== null) clearTimeout(this.retry);
    this.retry = null;
  }
}
