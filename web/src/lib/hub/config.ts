/*
 * Cloud mode: whether this page was served by a remote-hand hub.
 *
 * The hub writes `<meta name="rh-hub" content="<its origin>">` into the shell
 * it serves (docs/hub-api/http.md); a remote-hand server's shell has no such
 * tag, so a page it serves never takes any of the cloud paths and behaves
 * exactly as it always has.
 */

/** The hub's origin (`wss://…`) when the page runs in cloud mode, else `null`. */
export function hubOrigin(doc: Pick<Document, "querySelector"> | undefined = globalThis.document): string | null {
  const content = doc?.querySelector('meta[name="rh-hub"]')?.getAttribute("content");
  return content && /^wss?:\/\/[^/]+$/.test(content) ? content : null;
}

export function isCloud(): boolean {
  return hubOrigin() !== null;
}
