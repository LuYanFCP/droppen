/*
 * Joining the account with a passkey (`docs/passkeys.md` §4.2, §4.6): what
 * the passkey's PRF output becomes.
 *
 * A passkey slot (`passkeySlotSet` on the chain) names a passkey by
 * `SHA-256(credential id)` and carries a random `salt_nonce`. Asking that
 * passkey's PRF for `"rh/v1 passkey-unlock\0" ‖ salt_nonce` gives 32 bytes
 * nobody but the passkey's holder can compute; from them, for this account
 * and this slot only:
 *
 *   seed = HKDF-SHA256(salt "rh/v1 passkey", ikm prf,
 *                      info "signing key\0" ‖ str16 account ‖ str16 slot)
 *   PAK  = Ed25519(seed)
 *
 * `PAK` is what the slot registered: it proves (its signature over the
 * account's root `AK`, the slot, the credential and the salt) that whoever
 * put the slot on the chain held the passkey, and it signs exactly one kind
 * of entry for a new device — a *pending* `addDevice3` with no flags. The
 * device waits there until a full device of the account approves it — by
 * pairing with it (`lib/hub/pairing.ts`: its QR code or 8-digit code, so the
 * approval is bound to the keys on the screen the person holds) — or
 * removes it (§4.6).
 *
 * Nothing here is kept: the PRF output and the seed are zeroed as soon as
 * `PAK` is a non-extractable key, and `PAK` lives for one operation. The
 * X25519 twin of §4.2 (for the passkey packages of §4.3, sealed `MK`s) is
 * not made: packages are not built yet, so a slot here only lets a device
 * ask to join (`selfActivate: false`).
 */
import { type Bytes, concat, utf8, Writer } from "./bytes";
import { importEd25519Private, publicFromSecret, sha256 } from "./keys";

/** What the passkey's PRF is asked for, before the slot's salt (§4.2). */
export const PRF_LABEL = utf8("rh/v1 passkey-unlock\0");
const HKDF_SALT = utf8("rh/v1 passkey");

/** The PRF input for a slot's `saltNonce`: `"rh/v1 passkey-unlock\0" ‖ saltNonce` (the browser hashes it once more, WebAuthn's own step). */
export function prfInput(saltNonce: Uint8Array): Bytes {
  if (saltNonce.length !== 32) throw new Error("a passkey slot's salt is 32 bytes");
  return concat(PRF_LABEL, saltNonce);
}

/** `PAK` for `account`'s slot `slot` from the passkey's PRF output: the private half (non-extractable) and the public key. */
export interface PasskeyAuthority {
  signing: CryptoKey;
  pak: Bytes;
}

/** Derive `PAK` (§4.2). `prf` is zeroed here: the caller keeps no copy of it. */
export async function passkeyAuthority(prf: Uint8Array, account: string, slot: string): Promise<PasskeyAuthority> {
  if (prf.length !== 32) throw new Error("a PRF output is 32 bytes");
  const info = new Writer().raw(utf8("signing key\0")).str16(account).str16(slot).finish();
  const copy = new Uint8Array(prf);
  prf.fill(0);
  let ikm: CryptoKey;
  try {
    ikm = await crypto.subtle.importKey("raw", copy, "HKDF", false, ["deriveBits"]);
  } finally {
    copy.fill(0);
  }
  const seed = new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info }, ikm, 256));
  try {
    return { signing: await importEd25519Private(seed), pak: await publicFromSecret("Ed25519", seed) };
  } finally {
    seed.fill(0);
  }
}

/** `SHA-256(credential id)`: how a passkey slot names its passkey. */
export function credentialHash(credentialId: Uint8Array): Promise<Bytes> {
  return sha256(credentialId);
}

const SLOT_CHARS = "abcdefghijklmnopqrstuvwxyz0123456789";

/** A new slot id: `"p-"` and 12 random characters (ids are never reused: the chain refuses one it named before). */
export function newSlotId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  let id = "p-";
  // Rejection sampling: 252 is the largest multiple of 36 below 256.
  while (id.length < 14) {
    for (const b of random(16)) {
      if (b < 252 && id.length < 14) id += SLOT_CHARS[b % 36];
    }
  }
  return id;
}
