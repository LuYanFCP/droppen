import { wsUrl } from "@/lib/ws-url";
import type { SocketLike, Transport } from "./types";

/**
 * Today's transport: the page talks straight to the server that served it.
 *
 * Exactly what the call sites did inline before there was a seam — the same
 * URLs, the same ticket minted per attempt by `wsUrl`, the same `WebSocket`.
 * Each global is looked up when it is called rather than when this module
 * loads, which in a browser is the same thing, and lets a test stand fakes in
 * for `fetch` and `WebSocket` without a network.
 */
export const directTransport: Transport = {
  fetch: (request) => globalThis.fetch(request),
  socketUrl: wsUrl,
  // The browser socket has every member `SocketLike` names; only its handler
  // signatures are narrower than the ones callers assign.
  openSocket: (url) => new WebSocket(url) as unknown as SocketLike,
};
