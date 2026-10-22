/*
 * How the page reaches its server, as one seam that can be swapped.
 *
 * Today the page talks to the server that served it: typed calls are `fetch`es
 * to the same origin, and the feed hub, a session's own feed socket and a
 * terminal each open a `WebSocket` there. The cloud plan
 * (`docs/cross-machine-architecture.md` §5) puts a hub between the browser and
 * the machine, and carries all of that over one end-to-end encrypted channel
 * instead — `rpc` pipes for `/api/*`, a `mux` pipe for `/api/events?v=2`, and
 * `term` pipes for terminals — which the agent bridges to its own loopback
 * listener so no handler on the server changes. If the client side is to
 * change as little, everything above the transport has to already be talking
 * to something it does not construct itself; this is that something.
 *
 * Deliberately the exact shapes the call sites already used, so moving them
 * onto it changed nothing but where the function comes from:
 *
 * - `fetch(Request)` is what openapi-fetch's `fetch` option takes, so the auth
 *   middleware, the 401 handling and every typed call run unchanged on top of
 *   any transport.
 * - `socketUrl` + `openSocket` is the pair `FeedHub` and the session feed pool
 *   were already handed as dependencies. Two steps rather than one async
 *   `openSocket(path)` because the first is where an attempt can fail before a
 *   socket exists (a ticket that could not be minted), and both reconnect loops
 *   already back off on that rejection differently from a socket that closes.
 */

/**
 * The parts of a browser `WebSocket` the page's socket users touch.
 *
 * `HubSocket` (feed hub) and `FeedSocket` (a session's own feed) are slices of
 * this, so a socket a transport hands back fits either of them as it is.
 */
export interface SocketLike {
  readonly readyState: number;
  binaryType: string;
  send(data: string): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: unknown) => void) | null;
}

/**
 * Which lane of the channel a request rides when the transport has lanes
 * (`tunnel.ts`): `rpc` for the app's calls, `blob` for file bytes — host
 * files, pictures, uploads — which the channel drains after everything else
 * so a download never holds up a keystroke or a feed frame. A transport with
 * one lane (the direct one) ignores it.
 */
export type FetchClass = "rpc" | "blob";

export interface FetchOptions {
  class?: FetchClass;
}

export interface Transport {
  /**
   * One HTTP request to the server's `/api/*`, answered as `fetch` would: a
   * rejection is a request that never got an answer, and any status at all is
   * a `Response`.
   */
  fetch(request: Request, options?: FetchOptions): Promise<Response>;
  /**
   * The machine is reached only through {@link fetch}: a URL on the page's own
   * origin — an `<img src>`, an `<a href>` — does not reach it (cloud mode,
   * where the page's origin is the hub). File bytes are then fetched with
   * `class: "blob"` and drawn or saved from `blob:` URLs
   * (`lib/transport/blob.ts`). Absent on the direct transport.
   */
  readonly tunneled?: boolean;
  /**
   * Hear when where this transport reaches changes under it (cloud mode: the
   * machine and its offline copy) — what failed on one side may work on the
   * other. Absent on a transport that never changes.
   */
  onChange?(fn: () => void): () => void;
  /**
   * Hear when a new connection to the machine is up (cloud mode: a new
   * end-to-end channel, after the last one was lost with its hub or relay
   * connection). Requests that were in flight on the old one failed without
   * an answer; this is the moment to ask what became of them. Absent on a
   * transport with no connection of its own (the direct one).
   */
  onReconnect?(fn: () => void): () => void;
  /**
   * The address to open the websocket route `path` at — `/api/events?v=2`, a
   * session feed or a terminal.
   *
   * Per attempt, never cached: the direct transport mints a one-shot ticket
   * into it where a login is required. Rejects when the attempt cannot be made
   * at all, which callers treat like a refused connection. Opaque to callers,
   * and only good for the transport that minted it.
   */
  socketUrl(path: string): Promise<string>;
  /**
   * A socket for an address from {@link socketUrl}. It opens asynchronously,
   * like a `WebSocket`: `onopen` once the server has accepted it, or straight
   * to `onclose` when it never will.
   */
  openSocket(url: string): SocketLike;
}
