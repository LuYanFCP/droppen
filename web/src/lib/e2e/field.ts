/*
 * Arithmetic modulo p = 2^255 - 19 on `BigInt`, for the two curve maps
 * WebCrypto has no call for: Elligator 2 (the pairing PAKE's generator,
 * `pake.ts`) and Edwards → Montgomery (the recovery key's X25519 twin).
 * Not constant-time; both are applied to public or one-time values (see the
 * Rust `pake` module docs).
 */
export const P = (1n << 255n) - 19n;
const A = 486662n;

export function mod(x: bigint): bigint {
  const r = x % P;
  return r < 0n ? r + P : r;
}

export function pow(base: bigint, exp: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exp;
  while (e > 0n) {
    if (e & 1n) result = (result * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return result;
}

export function inv0(x: bigint): bigint {
  return pow(x, P - 2n);
}

export function isSquare(x: bigint): boolean {
  const v = mod(x);
  return v === 0n || pow(v, (P - 1n) >> 1n) === 1n;
}

export function decodeLe(bytes: Uint8Array): bigint {
  let x = 0n;
  for (let i = bytes.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(bytes[i]!);
  return x;
}

export function encodeLe(x: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = mod(x);
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/** RFC 9380 §6.7.1 `map_to_curve_elligator2` on curve25519 (J = 486662, K = 1, Z = 2): the u-coordinate. */
export function elligator2(u: Uint8Array): Uint8Array {
  const masked = Uint8Array.from(u);
  masked[31] = masked[31]! & 0x7f;
  const uu = mod(decodeLe(masked));
  const tv1 = mod(2n * uu * uu);
  let x1 = mod(-A * inv0(mod(1n + tv1)));
  if (x1 === 0n) x1 = mod(-A);
  const gx = (x: bigint) => mod(x * x * x + A * x * x + x);
  const x = isSquare(gx(x1)) ? x1 : mod(-x1 - A);
  return encodeLe(x);
}

/** An Ed25519 public key's point on the Montgomery u-line: `u = (1 + y) / (1 - y)`. */
export function edwardsToMontgomery(key: Uint8Array): Uint8Array {
  const y = decodeLe(Uint8Array.from(key, (b, i) => (i === 31 ? b & 0x7f : b)));
  return encodeLe(mod((1n + y) * inv0(mod(1n - y))));
}
