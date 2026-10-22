/**
 * `#local-open=<token>`: how a page is opened signed in from the device itself.
 *
 * `remote-hand-server open` on the device, or the desktop app's "open in
 * browser", opens `http://127.0.0.1:<port>/#local-open=<token>` — a token good
 * once, for a minute, while the device has no account. A fragment never
 * reaches a server, but it does sit in the address bar, the history and
 * whatever a script reads from `location`, so it is taken off the address
 * before anything else on the page runs (`local-open-boot.ts`, the first
 * import of `main.tsx`) and kept here, in memory, until `lib/auth.ts` trades
 * it for a session. It is never written anywhere else.
 *
 * Nothing in this module imports anything, so the boot import runs before any
 * other module — the router's above all, which reads the address when it is
 * created.
 */

/** The fragment parameter the token comes in. */
export const LOCAL_OPEN_PARAM = "local-open";

/** What a token looks like: base64url, about 43 characters. Anything else is not sent. */
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{16,256}$/;

/**
 * The token in a URL fragment: `null` when the fragment has no `local-open=`,
 * `""` when it has one that is not a token.
 */
export function localOpenToken(hash: string): string | null {
  const body = hash.startsWith("#") ? hash.slice(1) : hash;
  for (const part of body.split("&")) {
    if (!part.startsWith(`${LOCAL_OPEN_PARAM}=`)) continue;
    const value = part.slice(LOCAL_OPEN_PARAM.length + 1);
    return TOKEN_SHAPE.test(value) ? value : "";
  }
  return null;
}

/** The token taken off the address and not yet traded. */
let captured: string | null = null;

/**
 * Take `#local-open=` off the address, at once, and keep the token.
 *
 * The whole fragment goes — the link carries nothing else — and the path and
 * query stay, by `history.replaceState`, so there is no navigation and no
 * history entry with the token in it. A malformed token is taken off just the
 * same and kept as `""`, which the trade refuses without a request.
 */
export function captureLocalOpen(
  loc: Pick<Location, "hash" | "pathname" | "search"> = location,
  hist: Pick<History, "replaceState" | "state"> = history,
): void {
  const token = localOpenToken(loc.hash);
  if (token === null) return;
  hist.replaceState(hist.state, "", loc.pathname + loc.search);
  captured = token;
}

/** The captured token, handed over once. */
export function takeLocalOpen(): string | null {
  const token = captured;
  captured = null;
  return token;
}
