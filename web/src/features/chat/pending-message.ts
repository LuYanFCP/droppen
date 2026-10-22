import type { MachineKey } from "@/lib/machines/key";
import { readMachineItem, removeMachineItem, writeMachineItem } from "@/lib/machines/storage";

/** What a chat's first message is held under on its machine (`rh.chat.pending.<id>` locally). */
const pendingName = (id: string) => `chat.pending.${id}`;

/** Transfer the first API-chat message across navigation without sending it twice. */
export function stashPendingMessage(machine: MachineKey, id: string, text: string): void {
  try {
    writeMachineItem(sessionStorage, machine, pendingName(id), text);
  } catch {
    // Storage unavailable: the user can type it again.
  }
}

export function takePendingMessage(machine: MachineKey, id: string): string | null {
  try {
    const text = readMachineItem(sessionStorage, machine, pendingName(id));
    removeMachineItem(sessionStorage, machine, pendingName(id));
    return text;
  } catch {
    return null;
  }
}
