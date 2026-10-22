/**
 * How the three websocket routes get authenticated.
 *
 * A `WebSocket` constructor takes a URL and nothing else — no headers — so a
 * server that requires a login is handed a one-shot `ws` ticket in the query
 * string instead. Redeeming a ticket destroys it, so this is per attempt: every
 * reconnect mints its own.
 *
 * With authentication switched off none of this touches the network; `wsUrl`
 * is then the same string concatenation the call sites used to do inline.
 */
import { authRequired, fetchTicket, holdsPageLogin, verifyStillAuthorized } from "@/lib/auth";
import type { MachineKey } from "@/lib/machines/key";

/** `ws://` or `wss://` for this page's origin. */
function wsOrigin(): string {
  return `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
}

/** Add a ticket to a URL that may or may not already carry a query string. */
export function withTicket(url: string, ticket: string | null): string {
  if (!ticket) return url;
  return `${url}${url.includes("?") ? "&" : "?"}ticket=${encodeURIComponent(ticket)}`;
}

/**
 * The URL to open `path` with — `/api/events`, a session feed or a terminal.
 *
 * Rejects when no ticket could be minted, which callers should treat like a
 * refused connection: back off and come round again. A 401 while minting is
 * already handled a layer down, by the api client, which sends the browser to
 * the login page.
 */
export async function wsUrl(path: string): Promise<string> {
  const url = `${wsOrigin()}${path}`;
  if (!authRequired()) return url;
  return withTicket(url, await fetchTicket("ws"));
}

/** How many attempts in a row may fail before we ask whether we are still logged in. */
export const WS_AUTH_CHECK_AFTER = 3;

/**
 * Whether this failure streak is one of the ones that triggers the check.
 *
 * Every `WS_AUTH_CHECK_AFTER`th, not just the first: an outage long enough to
 * outlive the token has to be noticed too, not only one that starts that way.
 */
export function shouldVerifyAuth(streak: number, required: boolean): boolean {
  return required && streak > 0 && streak % WS_AUTH_CHECK_AFTER === 0;
}

/**
 * Called from a reconnect loop with the number of attempts since the last
 * successful open, and the machine the socket is to (absent: the page's own).
 *
 * A handshake the server refuses for want of a ticket closes with no status a
 * script can read, so a reconnect loop cannot tell it from an unreachable
 * server and would back off against it forever. Every few failures this asks
 * `/api/auth/status` — which answers without a token — and sends the browser to
 * the login page when the answer is that nobody is logged in. Only for the
 * machine the page's login is with: another one failing says nothing about it.
 */
export function noteWsFailure(streak: number, machine?: MachineKey): void {
  if (machine !== undefined && !holdsPageLogin(machine)) return;
  if (!shouldVerifyAuth(streak, authRequired())) return;
  void verifyStillAuthorized();
}
