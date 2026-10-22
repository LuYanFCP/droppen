// Joining the account with a passkey (docs/passkeys.md §4.2, §4.6;
// `lib/e2e/passkey-unlock.ts`, `CloudAccount.enablePasskeyJoin`,
// `joinWithPasskey`, `pairDevice`), against the fake hub.
//
// What these pin: `PAK` is HKDF-SHA256 over the passkey's PRF output, for one
// account and one slot (an independent derivation with node:crypto agrees);
// a full device registers a slot that grants nothing and lets no device
// activate itself; a new browser joins only with the slot's own passkey and
// PRF — anything else is refused before the account is pinned or anything
// posted — and then waits, pending; a full device approves it only by the
// ordinary pairing (its QR code, its 8-digit code), and only when the keys
// that pairing checked are the ones the join named — never by its id (a hub
// that hands a browser a waiting device's id is a fork on that browser), and
// never once a newer join replaced it; the approval makes it a full device in
// the same batch, and the pairing's delivery gives it the user keys; a slot
// turned off lets no device join.
import assert from "node:assert/strict";
import { createPrivateKey, createPublicKey, hkdfSync } from "node:crypto";
import test from "node:test";
import { credentialHash, generateDeviceKeys, hex, newSlotId, offerText, PairingError, passkeyAuthority, PRF_LABEL, prfInput, sha256, utf8 } from "../src/lib/e2e/index.js";
import { AccountError, type CloudAccount } from "../src/lib/hub/account.js";
import { type Candidate, candidateFromOffer, PairingResponder, runCodeInitiator } from "../src/lib/hub/pairing.js";
import { FakeKeysHub, RecordingKeyStore } from "./fake-keys-hub.js";

const kindIs = (kind: AccountError["kind"]) => (e: unknown) => e instanceof AccountError && e.kind === kind;

/** A passkey as the tests play it: a credential id, and a PRF that is a keyed hash of its input. */
function softPasskey() {
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const credentialId = crypto.getRandomValues(new Uint8Array(16));
  return { credentialId, prf: async (input: Uint8Array) => sha256(secret, input) };
}

/** `str16` as the chain writes it: a u16 length, then UTF-8. */
function str16(text: string): Buffer {
  const b = Buffer.from(text, "utf8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

test("PAK: HKDF-SHA256 over the PRF output, salt \"rh/v1 passkey\", for this account and this slot only — an independent derivation agrees", async () => {
  const prf = crypto.getRandomValues(new Uint8Array(32));
  const seed = Buffer.from(hkdfSync("sha256", prf, Buffer.from("rh/v1 passkey"), Buffer.concat([Buffer.from("signing key\0"), str16("a-1"), str16("p-abcdefghijkl")]), 32));
  const pkcs8 = Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]);
  const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" })).export({ format: "der", type: "spki" });
  const want = hex(new Uint8Array(spki.subarray(spki.length - 32)));
  const ours = await passkeyAuthority(new Uint8Array(prf), "a-1", "p-abcdefghijkl");
  assert.equal(hex(ours.pak), want);
  // Another slot, another account: another key.
  assert.notEqual(hex((await passkeyAuthority(new Uint8Array(prf), "a-1", "p-abcdefghijkm")).pak), want);
  assert.notEqual(hex((await passkeyAuthority(new Uint8Array(prf), "a-2", "p-abcdefghijkl")).pak), want);
  // The PRF output is not kept: zeroed in place.
  const given = new Uint8Array(prf);
  await passkeyAuthority(given, "a-1", "p-abcdefghijkl");
  assert.ok(given.every((b) => b === 0));
  assert.equal(ours.signing.extractable, false);
});

test("the PRF input is the label and the slot's salt; slot ids are p- and 12 characters", () => {
  const salt = new Uint8Array(32).fill(7);
  const input = prfInput(salt);
  assert.deepEqual(input.slice(0, PRF_LABEL.length), utf8("rh/v1 passkey-unlock\0"));
  assert.deepEqual(input.slice(PRF_LABEL.length), salt);
  assert.throws(() => prfInput(new Uint8Array(16)));
  for (let i = 0; i < 50; i++) assert.match(newSlotId(), /^p-[a-z0-9]{12}$/);
});

/** A v3 account (a, its first full device), a passkey, and the slot for it that a registered. */
async function withSlot() {
  const hub = new FakeKeysHub();
  const a = await hub.device("tok");
  await a.createGenesis(true);
  const pk = softPasskey();
  const plan = a.passkeyJoinPlan();
  await a.enablePasskeyJoin(pk.credentialId, plan, await pk.prf(plan.prfInput));
  return { hub, a, pk, plan };
}

/** A new browser, signed in, not in the chain. */
async function newBrowser(hub: FakeKeysHub): Promise<CloudAccount> {
  const b = await hub.device("tok", new RecordingKeyStore());
  assert.equal(b.standing, "absent");
  return b;
}

test("a full device lets new devices join with a passkey: a slot that names it, grants nothing and lets none activate itself", async () => {
  const { a, pk, plan } = await withSlot();
  const slots = a.passkeySlots();
  assert.equal(slots.length, 1);
  const s = slots[0]!.slot;
  assert.equal(s.slot, plan.slot);
  assert.equal(hex(s.credHash), hex(await credentialHash(pk.credentialId)));
  assert.equal(s.grants, 0);
  assert.equal(s.selfActivate, false, "only an approval lets a device in");
  assert.equal(a.passkeySlotFor(hex(s.credHash))?.slot.slot, plan.slot);
  // The same passkey again: nothing new.
  const again = a.passkeyJoinPlan();
  await a.enablePasskeyJoin(pk.credentialId, again, await pk.prf(again.prfInput));
  assert.equal(a.passkeySlots().length, 1);
  // A passkey that gives no PRF here: refused in words, nothing written.
  const other = softPasskey();
  await assert.rejects(a.enablePasskeyJoin(other.credentialId, a.passkeyJoinPlan(), null), kindIs("noPrf"));
  assert.equal(a.passkeySlots().length, 1);
});

test("a new browser joins only with the slot's passkey and its PRF: anything else is refused before it pins the account or posts", async () => {
  const { hub, pk, plan } = await withSlot();
  const b = await newBrowser(hub);
  const posts = hub.chainPosts;
  // The right passkey, the wrong PRF (another salt, or another authenticator's): its PAK is not the slot's.
  await assert.rejects(b.joinWithPasskey(plan.slot, pk.credentialId, await pk.prf(prfInput(new Uint8Array(32)))), kindIs("wrongPasskey"));
  // Another passkey: the slot does not name it.
  const other = softPasskey();
  await assert.rejects(b.joinWithPasskey(plan.slot, other.credentialId, await other.prf(plan.prfInput)), kindIs("noPasskeySlot"));
  // A slot that does not exist.
  await assert.rejects(b.joinWithPasskey("p-nosuchslot00", pk.credentialId, await pk.prf(plan.prfInput)), kindIs("noPasskeySlot"));
  assert.equal(hub.chainPosts, posts, "nothing posted");
  assert.equal(b.pinned, false, "nothing trusted");
  assert.equal(b.standing, "absent");
});

/** `b`'s side of a pairing: the responder its waiting screen runs (its own keys). */
function responder(b: CloudAccount): PairingResponder {
  return new PairingResponder({
    api: b.api,
    token: b.session.token,
    account: b.account,
    device: b.deviceId,
    signPublic: b.keys.signPublic,
    noise: b.noiseKeys,
    chain: async () => (await b.sync(), b.chain),
    storeUserKeys: (keys) => b.storeUserKeys(keys),
    pollMs: 1,
  });
}

/** `b` waits after joining with the slot's passkey, and `a` has seen it. */
async function waiting() {
  const { hub, a, pk, plan } = await withSlot();
  const b = await newBrowser(hub);
  await b.joinWithPasskey(plan.slot, pk.credentialId, await pk.prf(plan.prfInput));
  await a.sync();
  return { hub, a, b, pk, plan };
}

/** Run the responder until it is paired (or gives up). */
async function settle(r: PairingResponder): Promise<void> {
  for (let i = 0; i < 20 && r.state.kind !== "paired" && r.state.kind !== "failed"; i++) await r.tick();
}

test("joined with a passkey, a browser waits; a full device approves it by its QR code — then it is a full device with the user keys", async () => {
  const { a, b, plan } = await waiting();
  assert.equal(b.standing, "pending");
  assert.equal(b.pinned, true, "it checked the slot's proof over this chain's root: it trusts the account now");
  assert.equal(b.isAdmin, false);
  const join = b.chain!.entryAt(b.chain!.seq)!.draft;
  assert.deepEqual(join.signer, { type: "passkey", slot: plan.slot });
  assert.ok(join.action.type === "addDevice3" && !join.action.device.flags.admin && !join.action.device.flags.host, "a passkey adds a plain device");
  assert.deepEqual(
    a.chain!.pendingPasskeyJoins().map((p) => p.id),
    [b.deviceId],
  );
  // Never by its id alone.
  await assert.rejects(a.approveDevice(b.deviceId), kindIs("notPending"));

  const r = responder(b);
  try {
    const c = await candidateFromOffer(await r.startOffer(), a.chain!);
    await a.pairDevice(c, { admin: true });
    const tail = a.chain!.allEntries().slice(-2).map((e) => e.draft.action.type);
    assert.deepEqual(tail, ["approveDevice", "setAdmin"], "approved and made a full device in one batch");
    await settle(r);
    assert.equal(r.state.kind, "paired", JSON.stringify(r.state));
  } finally {
    r.stop();
  }
  await b.sync();
  assert.equal(b.standing, "active");
  assert.equal(b.isAdmin, true);
  assert.equal(await b.lacksKeys(), false, "it took the user keys the pairing delivered");
  assert.ok((await b.vault.epochs()).length > 0);
});

test("…or by its 8-digit code: the PAKE run's keys are the join's", async () => {
  const { a, b } = await waiting();
  const r = responder(b);
  try {
    const code = await r.startCode();
    const pairing = (await a.api.pairings(a.session.token)).find((p) => p.device === b.deviceId)!;
    const running = runCodeInitiator({ api: a.api, token: a.session.token, account: a.account, pollMs: 1 }, pairing, code);
    let c: Candidate | null = null;
    void running.then((x) => (c = x));
    for (let i = 0; i < 50 && !c; i++) {
      await r.tick();
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    assert.ok(c, "the run finished");
    await a.pairDevice(c!, { admin: true });
    await settle(r);
    assert.equal(r.state.kind, "paired", JSON.stringify(r.state));
  } finally {
    r.stop();
  }
  await b.sync();
  assert.equal(b.standing, "active");
  assert.equal(b.isAdmin, true);
});

test("a pairing whose keys are not the ones the join named approves nothing", async () => {
  const { a, b } = await waiting();
  const other = await generateDeviceKeys();
  const offer = offerText({ account: a.account, device: b.deviceId, signKey: other.signPublic, dhKey: other.dhPublic, secret: new Uint8Array(32).fill(3) });
  await assert.rejects(candidateFromOffer(offer, a.chain!), (e: unknown) => e instanceof PairingError && e.kind === "badOffer");
  // A code run's answer under that id with other keys (the screen someone else holds):
  const candidate: Candidate = { device: b.deviceId, signKey: other.signPublic, dhKey: other.dhPublic, secret: new Uint8Array(32).fill(4), fingerprint: "" };
  const before = a.chain!.seq;
  await assert.rejects(a.pairDevice(candidate, { admin: true }), kindIs("joinMismatch"));
  await a.sync();
  assert.equal(a.chain!.seq, before, "nothing signed");
  assert.equal(a.chain!.deviceRecord(b.deviceId)?.status.type, "pending");
});

test("a newer join with the same passkey replaces the waiting one while its approval is open: nothing is approved, and it says so", async () => {
  const { hub, a, b, pk, plan } = await waiting();
  const r = responder(b);
  try {
    const c = await candidateFromOffer(await r.startOffer(), a.chain!);
    // Someone else joins with the same passkey meanwhile: one waiting join per slot, so b's goes.
    const thief = await newBrowser(hub);
    await thief.joinWithPasskey(plan.slot, pk.credentialId, await pk.prf(plan.prfInput));
    // a has not looked since: it signs on the hub's newer head, sees, and stops.
    await assert.rejects(a.pairDevice(c, { admin: true }), kindIs("joinReplaced"));
    await a.sync();
    assert.ok(!a.chain!.allEntries().some((e) => e.draft.action.type === "approveDevice"), "nothing approved");
    assert.equal(a.chain!.deviceRecord(b.deviceId)?.status.type, "removed");
    assert.deepEqual(
      a.chain!.pendingPasskeyJoins().map((p) => p.id),
      [thief.deviceId],
    );
  } finally {
    r.stop();
  }
});

test("a hub that hands a new browser the id of a device waiting after a passkey join: a fork on that browser, never \"pending\"", async () => {
  const { hub, a, pk, plan } = await withSlot();
  const thief = await newBrowser(hub);
  await thief.joinWithPasskey(plan.slot, pk.credentialId, await pk.prf(plan.prfInput));
  await a.sync();
  // The real person's new browser signs in; the hub gives it the waiting device's id.
  hub.nextDeviceId = thief.deviceId;
  await assert.rejects(hub.device("tok", new RecordingKeyStore()), kindIs("fork"));
  void pk;
});

test("a slot turned off lets no device join; turned on again, a new slot", async () => {
  const { hub, a, pk, plan } = await withSlot();
  await a.disablePasskeyJoin(plan.slot);
  assert.equal(a.passkeySlots().length, 0);
  assert.equal(a.chain!.allEntries().at(-1)!.draft.action.type, "passkeySlotRemove");
  const b = await newBrowser(hub);
  await assert.rejects(b.joinWithPasskey(plan.slot, pk.credentialId, await pk.prf(plan.prfInput)), kindIs("noPasskeySlot"));
  // Turned on again: a new slot (ids are never reused), and the join works.
  const again = a.passkeyJoinPlan();
  assert.notEqual(again.slot, plan.slot);
  await a.enablePasskeyJoin(pk.credentialId, again, await pk.prf(again.prfInput));
  await b.joinWithPasskey(again.slot, pk.credentialId, await pk.prf(again.prfInput));
  assert.equal(b.standing, "pending");
});
