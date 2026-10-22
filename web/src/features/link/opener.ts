/*
 * The local page's half of signing in to Droppen (local-aggregator §3.3):
 * open the droppen.app popup in the click itself (a popup blocker only lets
 * through windows opened synchronously by a click), open an attempt at the
 * local server, answer the popup's `ready` with the attempt's request, and
 * hand the enrollment code it sends back to the local server. The code never
 * goes anywhere else, and nothing secret goes in a URL.
 *
 * Or, where there can be no popup — the Droppen desktop app's window, which
 * hands a new window to the system browser, or a browser that blocked it —
 * the browser hand-off (§4.9, `openInBrowser`, `continueInBrowser`): the
 * attempt's droppen.app address (`handoffUrl`, everything in its fragment)
 * opens in a tab of the browser, droppen.app answers through
 * `<this page>/link/return` straight to the local server, and this page
 * follows the attempt by asking the server (`status`) how it stands.
 */

import {
  LINK_FEATURES,
  LINK_PATH,
  LINK_VERSION,
  LINK_WINDOW,
  type LinkAggregator,
  type LinkMachine,
  type LinkMessage,
  parseLinkMessage,
} from "./handoff";

/** What `POST /api/cloud/link` answers. */
export interface Attempt {
  attempt: string;
  nonce: string;
  hubWeb: string;
  expiresMs: number;
  machine: LinkMachine & { fingerprint: string };
  aggregator?: LinkAggregator | null;
  /** The droppen.app address that answers the attempt through the browser (§4.9); `null` from a server before it. */
  handoffUrl?: string | null;
}

/** What the browser hand-off follows of `GET /api/cloud`. */
export interface HandoffStatus {
  /** `none`, `enrolling`, `linked`, … */
  state: string;
  /** The attempt in flight. */
  attempt?: { id: string } | null;
  /** How the last browser hand-off ended. */
  handoff?: { attempt: string; outcome: string; machine?: string | null; message?: string | null; error?: string | null } | null;
  account?: { id: string; email?: string | null } | null;
  machine?: { id?: string | null } | null;
}

export type OpenerState =
  /** Nothing in flight. */
  | { kind: "idle" }
  /** The popup is opening and the attempt being made. */
  | { kind: "starting" }
  /** The browser blocked the popup: a link opens it from a click. */
  | { kind: "blocked"; attempt: Attempt }
  /** The person continues in the popup. */
  | { kind: "waiting"; attempt: Attempt }
  /** The code came back; the local server enrolls. */
  | { kind: "finishing"; attempt: Attempt }
  /** The hub took the enrollment; a device of the account completes it. `browser`: the answer came through the browser. */
  | { kind: "enrolling"; attempt: Attempt; machine: string; browser?: boolean }
  /** The popup said it is done (or, through the browser, the server is in the account). */
  | { kind: "done"; email: string; machine: string }
  /** The browser hand-off: the person continues in a browser tab at droppen.app. */
  | { kind: "browser"; attempt: Attempt }
  /** The popup was closed before it sent a code. */
  | { kind: "closed"; attempt: Attempt }
  /** The attempt ran out (15 minutes) before a code came — e.g. while a recovered browser waits for approval. */
  | { kind: "expired" }
  /** `code`: the local server's or the hand-off's machine-readable reason, when it gave one (`hub_unreachable`, `refused`, …). */
  | { kind: "error"; message: string; attempt?: Attempt; code?: string };

/** The machine-readable code an error from the local API carries (`link-flow.ts`'s `failure`), if any. */
export function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && code ? code : undefined;
}

/** An error state, with the attempt and the code only when there are. */
function failed(message: string, attempt?: Attempt, code?: string | null): OpenerState {
  return { kind: "error", message, ...(attempt ? { attempt } : {}), ...(code ? { code } : {}) };
}

/** The few window operations the opener needs (a test passes a fake). */
export interface OpenerWindow {
  open(url: string, name: string, features: string): Window | null;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
}

export interface OpenerOptions {
  /** `POST /api/cloud/link`. */
  start: (body: { hub?: string; aggregate: boolean }) => Promise<Attempt>;
  /** `POST /api/cloud/link/finish`: the machine id the hub assigned. */
  finish: (body: { attempt: string; nonce: string; code: string; email?: string }) => Promise<{ machine: string; account: string }>;
  /** `POST /api/cloud/link/cancel`. */
  cancel: (attempt: string) => Promise<void>;
  /** `GET /api/cloud`, for following a browser hand-off. */
  status?: () => Promise<HandoffStatus>;
  onState: (state: OpenerState) => void;
  win?: OpenerWindow;
  /** How often to look whether the popup was closed, or the attempt ran out (ms). */
  pollMs?: number;
  /** The clock (tests). */
  now?: () => number;
}

export class LinkOpener {
  private state: OpenerState = { kind: "idle" };
  private popup: Window | null = null;
  private attempt: Attempt | null = null;
  private hubWeb = "";
  private aggregate = true;
  private readyBeforeAttempt = false;
  /** Following a browser hand-off (no popup). */
  private viaBrowser = false;
  private polling = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly win: OpenerWindow;
  private readonly listener = (event: MessageEvent) => this.onMessage(event);

  constructor(private readonly opts: OpenerOptions) {
    this.win = opts.win ?? window;
    this.win.addEventListener("message", this.listener);
  }

  get current(): OpenerState {
    return this.state;
  }

  private set(state: OpenerState): void {
    this.state = state;
    this.opts.onState(state);
  }

  /**
   * Start: call from the click handler itself. The popup is opened first,
   * synchronously, at `<hubWeb>/link?v=1` (no data in the URL); the attempt
   * is made meanwhile.
   */
  open(hubWeb: string, opts: { hub?: string; aggregate?: boolean } = {}): void {
    this.dispose(false);
    this.hubWeb = hubWeb;
    this.aggregate = opts.aggregate ?? true;
    this.popup = this.openWindow();
    this.set({ kind: "starting" });
    void this.opts
      .start({ hub: opts.hub, aggregate: this.aggregate })
      .then((attempt) => {
        if (this.state.kind !== "starting") return;
        if (attempt.hubWeb !== this.hubWeb) {
          // The server resolved another hub than the page assumed: the popup
          // must be that hub's, so open it there (still within this flow).
          this.hubWeb = attempt.hubWeb;
          this.popup?.close();
          this.popup = this.openWindow();
        }
        this.attempt = attempt;
        this.watchClosed();
        if (!this.popup) return this.set({ kind: "blocked", attempt });
        this.set({ kind: "waiting", attempt });
        if (this.readyBeforeAttempt) this.sendRequest();
      })
      .catch((error: unknown) => {
        this.popup?.close();
        this.popup = null;
        this.set(failed(error instanceof Error ? error.message : String(error), undefined, errorCode(error)));
      });
  }

  /**
   * The browser hand-off from the start (the desktop app's window): the
   * attempt is made, then its droppen.app address opens in a browser tab —
   * `window.open` after the attempt is answered, which the app's window
   * hands to the system browser; {@link reopen} opens it again from a click.
   */
  openInBrowser(opts: { hub?: string; aggregate?: boolean } = {}): void {
    this.dispose(false);
    this.aggregate = opts.aggregate ?? true;
    this.set({ kind: "starting" });
    void this.opts
      .start({ hub: opts.hub, aggregate: this.aggregate })
      .then((attempt) => {
        if (this.state.kind !== "starting") return;
        if (!attempt.handoffUrl) throw new Error("this device's server cannot take an answer through the browser; update Droppen");
        this.attempt = attempt;
        this.hubWeb = attempt.hubWeb;
        this.toBrowser(attempt);
      })
      .catch((error: unknown) => {
        this.set(failed(error instanceof Error ? error.message : String(error), undefined, errorCode(error)));
      });
  }

  /** From a blocked or closed popup to the browser hand-off, with the same attempt: call from a click. */
  continueInBrowser(): void {
    const attempt = this.attempt;
    if (!attempt?.handoffUrl) return;
    this.popup?.close();
    this.popup = null;
    this.toBrowser(attempt);
  }

  /** The attempt's droppen.app address, to open or copy (the browser hand-off). */
  get handoffUrl(): string | null {
    return this.attempt?.handoffUrl ?? null;
  }

  private toBrowser(attempt: Attempt): void {
    this.viaBrowser = true;
    this.openBrowserTab(attempt);
    this.set({ kind: "browser", attempt });
    this.watchClosed();
  }

  private openBrowserTab(attempt: Attempt): void {
    // `noopener`: droppen.app answers through the address, never through this window.
    if (attempt.handoffUrl) this.win.open(attempt.handoffUrl, "_blank", "noopener");
  }

  /** The popup again (blocked, or closed) — or the browser tab again: call from a click. */
  reopen(): void {
    if (!this.attempt) return;
    if (this.viaBrowser) return this.openBrowserTab(this.attempt);
    if (this.popup && !this.popup.closed) {
      this.popup.focus();
      return;
    }
    this.popup = this.openWindow();
    if (!this.popup) return this.set({ kind: "blocked", attempt: this.attempt });
    this.set({ kind: "waiting", attempt: this.attempt });
    this.watchClosed();
  }

  /** Give up: the attempt is cancelled at the local server and the popup closed. */
  cancel(): void {
    const attempt = this.attempt;
    if (attempt && this.popup && !this.popup.closed) this.post({ t: "rh-link/cancel", v: 1, nonce: attempt.nonce });
    this.dispose(true);
    if (attempt && this.state.kind !== "enrolling") void this.opts.cancel(attempt.attempt).catch(() => {});
    this.set({ kind: "idle" });
  }

  /** Stop listening (the page goes away). */
  close(): void {
    this.dispose(false);
    this.win.removeEventListener("message", this.listener);
  }

  private dispose(closePopup: boolean): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (closePopup) this.popup?.close();
    this.popup = null;
    this.attempt = null;
    this.readyBeforeAttempt = false;
    this.viaBrowser = false;
  }

  private openWindow(): Window | null {
    return this.win.open(`${this.hubWeb}${LINK_PATH}?v=${LINK_VERSION}`, LINK_WINDOW, LINK_FEATURES);
  }

  private watchClosed(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      const attempt = this.attempt;
      if (this.viaBrowser) return void this.followBrowser();
      if (attempt && (this.state.kind === "waiting" || this.state.kind === "closed" || this.state.kind === "blocked") && (this.opts.now ?? Date.now)() >= attempt.expiresMs) {
        this.popup?.close();
        this.dispose(false);
        this.set({ kind: "expired" });
        return;
      }
      if (!this.popup?.closed || this.state.kind !== "waiting" || !attempt) return;
      this.set({ kind: "closed", attempt });
    }, this.opts.pollMs ?? 1000);
  }

  /**
   * The browser hand-off, followed at the server (no popup tells this page
   * anything): droppen.app's answer came back (`handoff` names this attempt)
   * — taken (`receiving`: the attempt is gone while the server enrolls), then
   * the hub took the enrollment, or it failed; then the device joins the
   * account (`linked`). The attempt gone with no answer, or past its expiry:
   * it ran out.
   */
  private async followBrowser(): Promise<void> {
    const attempt = this.attempt;
    if (!attempt || !this.opts.status || this.polling) return;
    this.polling = true;
    let status: HandoffStatus;
    try {
      status = await this.opts.status();
    } catch {
      // The server is restarting, say: ask again on the next tick.
      return;
    } finally {
      this.polling = false;
    }
    if (this.attempt !== attempt || !this.viaBrowser) return;
    const now = (this.opts.now ?? Date.now)();
    const answer = status.handoff?.attempt === attempt.attempt ? status.handoff : null;
    if (status.state === "linked" && (answer || this.state.kind === "enrolling")) {
      this.dispose(false);
      return this.set({ kind: "done", email: status.account?.email ?? "", machine: status.machine?.id ?? answer?.machine ?? "" });
    }
    const kind = this.state.kind;
    if (kind === "browser" || kind === "finishing") {
      // Taken, and enrolling: the attempt is gone already — that is not "ran out".
      if (answer?.outcome === "receiving") {
        if (kind === "browser") this.set({ kind: "finishing", attempt });
        return;
      }
      if (answer?.outcome === "handed_over") return this.set({ kind: "enrolling", attempt, machine: answer.machine ?? "", browser: true });
      if (answer) {
        this.dispose(false);
        return this.set(failed(answer.message || answer.error || "failed", attempt, answer.error));
      }
      if (kind === "browser" && (status.attempt?.id !== attempt.attempt || now >= attempt.expiresMs)) {
        this.dispose(false);
        return this.set({ kind: "expired" });
      }
      return;
    }
    // Enrolling: the enrollment code lives ten minutes; past the attempt's
    // own expiry and that, nobody is adding this device any more.
    if (kind === "enrolling" && status.state === "none") {
      this.dispose(false);
      this.set({ kind: "expired" });
    }
  }

  /** To the popup only, at the hub's origin only. */
  private post(message: LinkMessage): void {
    try {
      this.popup?.postMessage(message, this.hubWeb);
    } catch {
      // The popup navigated away from the hub: nothing to tell it.
    }
  }

  private sendRequest(): void {
    const attempt = this.attempt;
    if (!attempt) return;
    const aggregator = attempt.aggregator ?? null;
    this.post({
      t: "rh-link/request",
      v: 1,
      nonce: attempt.nonce,
      machine: { hostname: attempt.machine.hostname, signKey: attempt.machine.signKey, dhKey: attempt.machine.dhKey, enrolled: attempt.machine.enrolled ?? null },
      aggregator,
      aggregate: this.aggregate && aggregator !== null,
    });
  }

  private onMessage(event: MessageEvent): void {
    // Only the window this page opened, and only from the hub's own origin.
    if (!this.popup || event.source !== this.popup || event.origin !== this.hubWeb) return;
    const message = parseLinkMessage(event.data);
    if (!message) return;
    if (message.t === "rh-link/ready") {
      if (this.attempt) this.sendRequest();
      else this.readyBeforeAttempt = true;
      return;
    }
    const attempt = this.attempt;
    if (!attempt || !("nonce" in message) || message.nonce !== attempt.nonce) return;
    switch (message.t) {
      case "rh-link/code":
        if (this.state.kind !== "waiting" && this.state.kind !== "closed") return;
        this.set({ kind: "finishing", attempt });
        void this.opts
          .finish({ attempt: attempt.attempt, nonce: attempt.nonce, code: message.code, email: message.email })
          .then(({ machine }) => this.set({ kind: "enrolling", attempt, machine }))
          .catch((error: unknown) => {
            const text = error instanceof Error ? error.message : String(error);
            this.post({ t: "rh-link/error", v: 1, nonce: attempt.nonce, code: "finish_failed", message: text });
            this.set(failed(text, attempt, errorCode(error)));
          });
        return;
      case "rh-link/done":
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        this.set({ kind: "done", email: message.email, machine: message.machine });
        return;
      case "rh-link/cancel":
        this.cancel();
        return;
      case "rh-link/error":
        this.set({ kind: "error", message: message.message, attempt });
        return;
    }
  }
}
