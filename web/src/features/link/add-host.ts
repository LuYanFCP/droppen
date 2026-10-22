/*
 * What droppen.app/link does once the person consents (docs/local-aggregator.md
 * §4.3 steps 5–7, S1-4), apart from the page: issue the code and hand it to
 * the computer's page, wait for its proof under exactly the keys it showed,
 * add it — `[addDevice3{host, admin}, keyEpochs]` on a v3 chain, v2's
 * `[addMachine, keyEpochs]` before — hand it its own content key, and then
 * the content keys of the other devices that accept its control, once its
 * device role signed in at the hub (S1-4: the local install controls the
 * others with its one identity; it asks for anything still missing itself).
 *
 * Every local install runs AI, so it is never a full device (review D1: its
 * key sits in a file every program of its user can read, §3.3, and its agent
 * neither vouches for the chain nor signs). The consent page offers no
 * choice; `admin: true` is refused here before any code is used.
 */
import type { EnrollCode } from "@/lib/e2e";
import { type CloudAccount, HOST_KEYS_WAIT, hostAdminRefused } from "@/lib/hub/account";
import type { MachineKeyCourier } from "@/lib/hub/deliver";

export type AddStep = "code" | "proof" | "key" | "hostKeys";

/** What adding needs besides the account. */
export interface AddHostOptions {
  /** The keys the computer's page showed: a proof under any others is refused. */
  keys: { signKey: Uint8Array; dhKey: Uint8Array };
  /** Whether it is added as a full device: always `false` (refused for a host: D1). */
  admin: boolean;
  /** The hub takes chain v3 entries now (`/v1/me`'s `chain_v3.writable`). */
  writable: boolean;
  /** How its own content key reaches it. */
  courier: MachineKeyCourier;
  /**
   * The code, to the computer's page only: postMessage to `cb`, or — the
   * browser hand-off — sealed to its attempt, through a tab at `cb`.
   */
  sendCode: (code: EnrollCode) => void | Promise<void>;
  onStep?: (step: AddStep) => void;
  signal?: AbortSignal;
  pollMs?: number;
  /** How long to wait for its device role before leaving the other keys to its own request. */
  hostKeysWait?: { forMs: number; everyMs: number };
}

/** What was added. */
export interface Added {
  machine: string;
  /** The other devices' content keys sealed to it; `null`: its device role did not sign in in time (it asks itself). */
  hostKeys: number | null;
}

/** Add the computer that asked (see the module docs). */
export async function addHost(account: CloudAccount, opts: AddHostOptions): Promise<Added> {
  // Every local install runs AI (review D1): refused before a code is issued.
  if (opts.admin) throw hostAdminRefused();
  opts.onStep?.("code");
  const code = await account.startEnrollment();
  await opts.sendCode(code);
  opts.onStep?.("proof");
  const machine = await account.completeEnrollment(code, opts.signal, opts.pollMs ?? 500, opts.keys, { writable: opts.writable, admin: opts.admin });
  opts.onStep?.("key");
  await account.handOverMachineKey(machine.id, opts.courier);
  opts.onStep?.("hostKeys");
  let hostKeys: number | null = null;
  try {
    hostKeys = await account.handHostKeys(machine.id, opts.hostKeysWait ?? HOST_KEYS_WAIT, opts.signal);
  } catch (error) {
    // Added and keyed: the rest it asks for itself (purpose 4).
    console.warn(`link: could not hand ${machine.id} the other devices' keys (it asks for them itself):`, error);
  }
  return { machine: machine.id, hostKeys };
}
