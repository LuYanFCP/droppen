import { homeMachine, openMachine, transportFor } from "@/lib/machines/registry";
import type { Transport } from "./types";

export type { FetchClass, FetchOptions, SocketLike, Transport } from "./types";
export { directTransport } from "./direct";

/**
 * The home machine's transport, as it is now.
 *
 * A transport used to be one module-level slot for the whole page, because the
 * page had exactly one machine to reach. It now belongs to a machine
 * (`lib/machines/registry.ts`): every request and socket goes through the
 * transport of the machine it is for, read at the moment of each request and
 * each connection attempt, never captured.
 *
 * @deprecated `useMachineRuntime().transport` in a component,
 * `transportFor(machine)` elsewhere. Kept as an alias of the home machine's;
 * `scripts/check-machine-keys.mjs` refuses new uses of it in `web/src`.
 */
export function transport(): Transport {
  return transportFor(homeMachine());
}

/**
 * Route everything on the home machine through `next` from here on.
 *
 * Meant to be called while the page boots, before anything has connected: a
 * socket already open stays on the transport that opened it until it next
 * reconnects, and an address {@link Transport.socketUrl} minted is only good
 * for the transport that minted it.
 *
 * @deprecated A shell opens its machines with `openMachine`
 * (`lib/machines/registry.ts`). Kept for tests that stand a fake in for the
 * home machine's transport.
 */
export function setTransport(next: Transport): void {
  openMachine(homeMachine(), next);
}
