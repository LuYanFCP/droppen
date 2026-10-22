/*
 * Can this browser do end-to-end encryption natively?
 *
 * Everything in the suite is WebCrypto, but X25519 and Ed25519 arrived late
 * (MDN browser-compat-data, October 2026):
 *
 * |               | X25519 | Ed25519 |
 * |---------------|--------|---------|
 * | Chrome / Edge | 133    | 137     |
 * | Firefox       | 130    | 129     |
 * | Safari (macOS and iOS) | 17 | 17 |
 *
 * so current versions of all three have both, and an older browser has to be
 * told so rather than silently falling back to something weaker. Raw deflate
 * (`DecompressionStream("deflate-raw")`, Chrome 103 / Firefox 113 / Safari
 * 16.4) and IndexedDB are checked alongside, since records and key storage need
 * them. The check *exercises* each primitive — a browser that knows an
 * algorithm's name but not how to make a non-extractable key with it fails
 * here, not halfway through a handshake.
 */

export const MINIMUM_BROWSERS = { chrome: 137, edge: 137, firefox: 130, safari: 17 } as const;

export interface E2eSupport {
  ok: boolean;
  missing: string[];
}

export async function checkE2eSupport(env: { crypto?: Crypto; indexedDB?: IDBFactory; requireIndexedDb?: boolean } = {}): Promise<E2eSupport> {
  const c = env.crypto ?? globalThis.crypto;
  const missing: string[] = [];
  const subtle = c?.subtle;
  if (!subtle) return { ok: false, missing: ["WebCrypto (crypto.subtle; needs a secure context)"] };
  const attempt = async (name: string, work: () => Promise<unknown>) => {
    try {
      await work();
    } catch {
      missing.push(name);
    }
  };
  await attempt("X25519", async () => {
    const a = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    const b = (await subtle.generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
    await subtle.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256);
  });
  await attempt("Ed25519", async () => {
    const k = (await subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"])) as CryptoKeyPair;
    const msg = new Uint8Array(4);
    const sig = await subtle.sign({ name: "Ed25519" }, k.privateKey, msg);
    if (!(await subtle.verify({ name: "Ed25519" }, k.publicKey, sig, msg))) throw new Error("verify");
  });
  await attempt("AES-GCM", async () => {
    const k = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
    await subtle.encrypt({ name: "AES-GCM", iv: new Uint8Array(12) }, k, new Uint8Array(1));
  });
  await attempt("HKDF", async () => {
    const k = await subtle.importKey("raw", new Uint8Array(32), "HKDF", false, ["deriveKey"]);
    await subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: new Uint8Array(0) }, k, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  });
  await attempt("HMAC-SHA-256", async () => {
    const k = await subtle.importKey("raw", new Uint8Array(32), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    await subtle.sign("HMAC", k, new Uint8Array(0));
  });
  await attempt("deflate-raw streams", async () => {
    new DecompressionStream("deflate-raw");
    new CompressionStream("deflate-raw");
  });
  if (env.requireIndexedDb !== false && !(env.indexedDB ?? globalThis.indexedDB)) missing.push("IndexedDB");
  return { ok: missing.length === 0, missing };
}
