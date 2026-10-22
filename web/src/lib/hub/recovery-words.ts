/*
 * The recovery key as a person handles it: twelve words (BIP-39's encoding of
 * the 16 random bytes `RK`, `lib/e2e/mnemonic.ts`), shown once, checked by
 * asking for a few of them back before the page moves on; and typed in again
 * to recover, with what is wrong said word by word.
 *
 * M1 showed the same 16 bytes as base32 in groups of four; such a key is still
 * accepted where words are.
 */
import { type Bytes, entropyFromMnemonic, fromBase32, isMnemonicWord, MnemonicError, mnemonicFromEntropy, normalizeWords } from "@/lib/e2e";

/** How many words a new recovery key has (16 bytes). */
export const RECOVERY_WORDS = 12;
/** How many of them the user types back before continuing. */
export const CHALLENGE_WORDS = 3;

const LEGACY = /^[a-z2-7]{4}(-[a-z2-7]{1,4}){5,}$/i;

/** A fresh `RK` and its words. The caller zeroes `secret` once it has derived what it needs. */
export async function newRecoverySecret(): Promise<{ secret: Bytes; words: string[] }> {
  const secret = crypto.getRandomValues(new Uint8Array(16));
  return { secret, words: await mnemonicFromEntropy(secret) };
}

/** Whether `text` looks like M1's base32 recovery key (`ABCD-EFGH-…`). */
export function isLegacyRecoveryKey(text: string): boolean {
  return LEGACY.test(text.trim());
}

export type PhraseCheck =
  | { kind: "empty" }
  /** Fewer words than a key has, all of them recovery words so far. */
  | { kind: "incomplete"; count: number }
  | { kind: "unknownWord"; word: string; index: number }
  | { kind: "wordCount"; count: number }
  /** Every word is a recovery word, but together they do not check out: one is wrong or out of place. */
  | { kind: "checksum" }
  | { kind: "ok"; legacy: boolean };

/** What is wrong with `text` as a recovery key so far, for the form to say as it is typed. */
export async function checkPhrase(text: string): Promise<PhraseCheck> {
  if (!text.trim()) return { kind: "empty" };
  if (isLegacyRecoveryKey(text)) {
    const bytes = fromBase32(text.trim().replace(/-/g, ""));
    if (bytes && bytes.length === 16) {
      bytes.fill(0);
      return { kind: "ok", legacy: true };
    }
    return { kind: "checksum" };
  }
  const words = normalizeWords(text);
  const index = words.findIndex((w) => !isMnemonicWord(w));
  // The word being typed (no space after it yet) is not judged until it is complete.
  const typing = !/\s$/.test(text) && index === words.length - 1;
  if (index >= 0 && !typing) return { kind: "unknownWord", word: words[index]!, index };
  if (index >= 0 || words.length < RECOVERY_WORDS) return { kind: "incomplete", count: index >= 0 ? words.length - 1 : words.length };
  try {
    const entropy = await entropyFromMnemonic(text);
    entropy.fill(0);
    return { kind: "ok", legacy: false };
  } catch (error) {
    if (error instanceof MnemonicError && error.kind === "wordCount") return { kind: "wordCount", count: words.length };
    if (error instanceof MnemonicError && error.kind === "unknownWord") return { kind: "unknownWord", word: error.word ?? "", index: words.indexOf(error.word ?? "") };
    return { kind: "checksum" };
  }
}

/** `RK` from what the user typed: twelve (or more) words, or M1's base32. Throws `MnemonicError`. */
export async function recoverySecret(text: string): Promise<Bytes> {
  if (isLegacyRecoveryKey(text)) {
    const bytes = fromBase32(text.trim().replace(/-/g, ""));
    if (bytes && bytes.length >= 16) return bytes;
    throw new MnemonicError("checksum", "this recovery key does not check out");
  }
  return entropyFromMnemonic(text);
}

/** `picks` distinct word positions (0-based, ascending) out of `count`, to ask back. */
export function pickChallenge(count = RECOVERY_WORDS, picks = CHALLENGE_WORDS, random: () => number = Math.random): number[] {
  const all = Array.from({ length: count }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [all[i], all[j]] = [all[j]!, all[i]!];
  }
  return all.slice(0, Math.min(picks, count)).sort((a, b) => a - b);
}

/** Per asked position: whether the answer is that word (case and spacing aside). */
export function challengeAnswers(words: string[], positions: number[], answers: string[]): boolean[] {
  return positions.map((p, i) => (answers[i] ?? "").trim().toLowerCase() === words[p]);
}

export function challengePassed(words: string[], positions: number[], answers: string[]): boolean {
  return positions.length > 0 && challengeAnswers(words, positions, answers).every(Boolean);
}
