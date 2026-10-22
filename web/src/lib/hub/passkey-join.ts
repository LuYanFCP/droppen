/*
 * A new device joining the account with a passkey (docs/passkeys.md §4.6),
 * the browser's half around `CloudAccount.joinWithPasskey`: which passkey,
 * which slot, and its PRF.
 *
 * The chain names a slot's passkey only by `SHA-256(credential id)`, so this
 * browser must learn which passkey the person holds before it can ask that
 * passkey's PRF with that slot's salt:
 *
 * 1. the passkey it just signed in with (`rememberPasskeySignIn`, kept for
 *    this tab only): straight to the PRF — one more gesture;
 * 2. else, with one slot on the chain, the PRF with that slot's salt, from
 *    whichever passkey the person picks (checked after: the wrong one is
 *    refused);
 * 3. else, a first `get()` asking only which passkey, then the PRF — two
 *    gestures.
 */
import { credentialHash, hex, prfInput, type SlotRecord } from "@/lib/e2e";
import { AccountError, type CloudAccount } from "./account";
import { fromBase64Url, type PasskeyDeps, passkeyPrf } from "./passkey";

/** Where the passkey this tab signed in with is kept: the tab only (sessionStorage), never the device. */
const SIGN_IN_KEY = "rh.hub.passkey-sign-in";

/** The passkey a sign-in used, as this tab keeps it. */
export interface PasskeySignIn {
  account: string;
  /** base64url. */
  credentialId: string;
  /** The relying party it was used for (`null`: the page's own domain). */
  rpId: string | null;
}

type TabStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function tabStorage(): TabStorage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Keep which passkey this tab signed in to `account` with (for joining with it next). */
export function rememberPasskeySignIn(signIn: PasskeySignIn, storage: TabStorage | null = tabStorage()): void {
  try {
    storage?.setItem(SIGN_IN_KEY, JSON.stringify(signIn));
  } catch {
    // only the next step's extra gesture
  }
}

/** The passkey this tab signed in to `account` with, if it kept one. */
export function passkeySignIn(account: string, storage: TabStorage | null = tabStorage()): PasskeySignIn | null {
  try {
    const raw = storage?.getItem(SIGN_IN_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<PasskeySignIn>;
    if (v.account !== account || typeof v.credentialId !== "string" || !v.credentialId) return null;
    return { account, credentialId: v.credentialId, rpId: typeof v.rpId === "string" && v.rpId ? v.rpId : null };
  } catch {
    return null;
  }
}

/** Forget it (signed out, or joined). */
export function forgetPasskeySignIn(storage: TabStorage | null = tabStorage()): void {
  try {
    storage?.removeItem(SIGN_IN_KEY);
  } catch {
    // nothing kept
  }
}

async function slotOf(slots: SlotRecord[], credentialId: string): Promise<SlotRecord | null> {
  const hash = hex(await credentialHash(fromBase64Url(credentialId)));
  return slots.find((s) => hex(s.slot.credHash) === hash) ?? null;
}

const noSlot = () =>
  new AccountError("noPasskeySlot", "new devices cannot join with this passkey: on a device already in the account, let them in account settings, or pair this device instead");

/**
 * Join `account` (this browser not in its chain) with a passkey: find the
 * slot (above), ask the passkey's PRF with its salt, and hand both to
 * `joinWithPasskey`, which checks them against the chain before trusting
 * anything. The device is then pending.
 */
export async function joinAccountWithPasskey(account: CloudAccount, deps: PasskeyDeps, opts: { signIn: PasskeySignIn | null; signal?: AbortSignal }): Promise<void> {
  const slots = account.passkeySlots();
  if (!slots.length) throw noSlot();
  const rpId = opts.signIn?.rpId ?? undefined;
  let credentialId: string | undefined;
  let slot: SlotRecord | null = null;
  if (opts.signIn) {
    slot = await slotOf(slots, opts.signIn.credentialId);
    if (slot) credentialId = opts.signIn.credentialId;
  }
  if (!slot && slots.length === 1) slot = slots[0] ?? null;
  if (!slot) {
    // Which passkey the person holds, first: the slots' salts differ.
    const picked = await passkeyPrf(deps, { rpId, signal: opts.signal });
    slot = await slotOf(slots, picked.credentialId);
    if (!slot) throw noSlot();
    credentialId = picked.credentialId;
  }
  const answer = await passkeyPrf(deps, { rpId, credentialId, prfInput: prfInput(slot.slot.saltNonce), signal: opts.signal });
  const prf = answer.prf;
  if (!prf) {
    throw new AccountError("noPrf", "this passkey cannot let this device join in this browser (some browsers and password managers do not support it): pair it from another device instead");
  }
  if ((await slotOf([slot], answer.credentialId)) === null) {
    prf.fill(0);
    throw noSlot();
  }
  await account.joinWithPasskey(slot.slot.slot, fromBase64Url(answer.credentialId), prf);
  forgetPasskeySignIn();
}
