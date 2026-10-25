/*
 * The page coming back: in view again (`visibilitychange`), shown from the
 * back-forward cache (`pageshow`), focused again (`focus`), online again
 * (`online`), or on another network (`navigator.connection`'s `change`: a
 * phone moving between Wi-Fi and cellular stays "online" while every socket
 * it had is half-open). A phone holds a page's timers while it sleeps or the
 * page is in the background, and may drop its sockets meanwhile: what waits
 * on a timer — a reconnect, a retry at the end of a backoff — is better done
 * now. The first few often come together (a phone unlocked): told once a
 * second at most. `online` and a network change are always told: the network
 * may come back just after the event.
 */

type Target = { addEventListener?: (type: string, fn: () => void) => void; removeEventListener?: (type: string, fn: () => void) => void };
type Connection = Target;

const COALESCE_MS = 1000;

export function onPageResume(fn: () => void): () => void {
  const win = globalThis as Target;
  const doc = (globalThis as { document?: Target & { visibilityState?: string } }).document;
  const connection = (globalThis as { navigator?: { connection?: Connection } }).navigator?.connection;
  let last = Number.NEGATIVE_INFINITY;
  const back = () => {
    const now = Date.now();
    if (now - last < COALESCE_MS) return;
    last = now;
    fn();
  };
  const visible = () => {
    if (doc?.visibilityState !== "hidden") back();
  };
  const online = () => {
    last = Date.now();
    fn();
  };
  win.addEventListener?.("pageshow", back);
  win.addEventListener?.("focus", back);
  win.addEventListener?.("online", online);
  doc?.addEventListener?.("visibilitychange", visible);
  // A Wi-Fi ↔ cellular change fires no `online`: the phone never left the
  // network, but the sockets it had are gone. Treat it like coming back.
  connection?.addEventListener?.("change", back);
  return () => {
    win.removeEventListener?.("pageshow", back);
    win.removeEventListener?.("focus", back);
    win.removeEventListener?.("online", online);
    doc?.removeEventListener?.("visibilitychange", visible);
    connection?.removeEventListener?.("change", back);
  };
}
