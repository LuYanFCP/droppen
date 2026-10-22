import type { MachineKey } from "@/lib/machines/key";
import { apiFor } from "@/lib/machines/registry";

/**
 * Web Push subscription for this browser (server-rs `push` module is the peer).
 *
 * Subscribing is the opt-in: whatever `pushManager.subscribe` hands back is
 * posted verbatim to the server, and notifications are raised by the push
 * handler in public/sw.js. Only production bundles register a worker at all
 * (lib/sw-register.ts), so under `vite dev` this reports itself unsupported.
 */
export type PushState = "unsupported" | "denied" | "off" | "on";

/**
 * `serviceWorker.ready` never settles when no worker was ever registered — a
 * dev bundle, or an insecure context where registration silently failed. Every
 * read races it so the settings row resolves instead of spinning forever.
 */
const READY_TIMEOUT_MS = 2000;

function supported(): boolean {
  return (
    "serviceWorker" in navigator && "PushManager" in window && "Notification" in window
  );
}

async function readyOrNull(): Promise<ServiceWorkerRegistration | null> {
  if (!supported()) return null;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => window.setTimeout(() => resolve(null), READY_TIMEOUT_MS)),
  ]);
}

export async function pushState(): Promise<PushState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "denied") return "denied";
  const reg = await readyOrNull();
  if (reg === null) return "unsupported";
  return (await reg.pushManager.getSubscription()) === null ? "off" : "on";
}

/** base64url text to the raw bytes `applicationServerKey` insists on. The
 *  buffer is allocated explicitly so the result is a plain-ArrayBuffer view,
 *  which is what BufferSource narrows to. */
function urlBase64ToUint8Array(value: string): Uint8Array<ArrayBuffer> {
  const padded = value + "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

/** Subscribe this browser to `machine`'s notifications. */
export async function enablePush(machine: MachineKey): Promise<void> {
  const api = apiFor(machine);
  const reg = await readyOrNull();
  if (reg === null) throw new Error("push unsupported here");

  // Must be called from the user gesture that reached this function; browsers
  // reject a permission prompt that is not tied to one.
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("notification permission not granted");

  // Minted server-side on the first call, then stable.
  const key = await api.GET("/api/push/vapid");
  if (!key.data) throw new Error("the server did not return a VAPID key");

  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(key.data.publicKey),
  });

  const json = sub.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("browser returned a malformed subscription");
  }
  const res = await api.POST("/api/push/subscriptions", {
    body: {
      endpoint: json.endpoint,
      keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
    },
  });
  if (res.error) throw new Error(res.error.error);
}

/** Stop `machine`'s notifications to this browser. */
export async function disablePush(machine: MachineKey): Promise<void> {
  const api = apiFor(machine);
  const reg = await readyOrNull();
  if (reg === null) return;
  const sub = await reg.pushManager.getSubscription();
  if (sub === null) return;
  // Drop the server's row first, while the endpoint is still in hand, but do
  // not let that failure strand the browser subscription: the send path prunes
  // rows the push service rejects, so an orphaned row heals itself.
  await api
    .DELETE("/api/push/subscriptions", { body: { endpoint: sub.endpoint } })
    .catch(() => undefined);
  await sub.unsubscribe();
}
