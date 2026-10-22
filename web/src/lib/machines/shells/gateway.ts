/*
 * The local app's gateway shell in the registry (`docs/local-aggregator.md`
 * §6.2, `GatewayShell`, S1-7).
 *
 * The local app as it always was — {@link LOCAL}, the page's own server,
 * reached directly, and the home — and, beside it, the account's other
 * devices as the local install's gateway shows them: each a machine of its
 * own (its device id), read from its copy. The shell itself is built from the
 * gateway and copy modules (`features/gateway/gateway-shell.ts`); this is its
 * registry half.
 */
import type { Transport } from "@/lib/transport/types";
import { LOCAL, type MachineKey } from "../key";
import { closeMachine, isOpen, type MachineDriver, openMachine, setShell, shellKind } from "../registry";
import type { MachineRuntime } from "../runtime";

/** The local app shows other devices too: `local` stays the home. */
export function enterGatewayShell(): void {
  if (shellKind() === "local") setShell("gateway", LOCAL);
}

/** Open another device beside `local`, reached through `transport`. */
export function openGatewayMachine(machine: MachineKey, transport: Transport, driver: MachineDriver): MachineRuntime {
  if (machine === LOCAL) throw new Error(`"${LOCAL}" is the page's own server`);
  enterGatewayShell();
  return openMachine(machine, transport, driver);
}

/** Close another device (it left the gateway's list, or the page may no longer see it). */
export function closeGatewayMachine(machine: MachineKey): void {
  if (machine !== LOCAL && isOpen(machine)) closeMachine(machine);
}

/** Back to the local app alone: `local`, as it always was. */
export function leaveGatewayShell(): void {
  if (shellKind() === "gateway") setShell("local", LOCAL);
}
